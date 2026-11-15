"""Vexcel imagery + 3D proxy (PRD S-3). The API key stays server-side (x-api-key header).

GET /vexcel/ortho/{parcel_id}.jpg   orthophoto around a parcel (resized, disk-cached)
GET /vexcel/ortho/{parcel_id}/meta  capture dates, GSD, collection, camera (from the image's XMP)
GET /vexcel/3d/root?lat=&lon=       which 3D-cities collection covers a point -> proxied tileset URL
GET /vexcel/3d/{tileset|tile}?...   OGC 3D Tiles proxy; JSON root links are rewritten to this proxy
GET /vexcel/captures/{parcel_id}    every ortho capture over the point (collection, layer, dates, GSD), newest first;
                                    /ortho/{id}.jpg?collection=&layer= then serves that capture (before / after)
GET /vexcel/oblique/{parcel_id}/list which oblique directions exist (north/east/south/west) in the newest collection
GET /vexcel/oblique/{parcel_id}.jpg?dir=   one oblique (angled) photo of the site, Vexcel product oblique-<dir>
GET /vexcel/neighbours/{parcel_id}  nearby structures (Vexcel footprints) with measured heights: DSM minus DTM sampled
                                    inside each footprint; positions in metres east/north of the site centre

The ortho's ground footprint is exact: its XMP carries `pixel-bbox` in zoom-`max-zoom` Web Mercator pixels, which
ortho_frame() turns into metres east/north of the requested point (checked on cached images: centred on the point to
within a pixel, 2 x buffer wide).

Everything fetched is cached under data/cache/vexcel so the demo works offline after one warm-up.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import re
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

from app import config
from app.db import session

router = APIRouter(prefix="/vexcel", tags=["vexcel"])

BASE = "https://api.vexcelgroup.com/v2"
CACHE = config.CACHE_DIR / "vexcel"
LABEL_SOURCE = "Vexcel Imaging US, Inc. via Vexcel API v2"


def _headers() -> dict[str, str]:
    if not config.VEXCEL_API_KEY:
        raise HTTPException(503, "VEXCEL_API_KEY is not configured")
    return {"x-api-key": config.VEXCEL_API_KEY}


def _cache_path(kind: str, key: str, ext: str) -> Path:
    h = hashlib.sha1(key.encode()).hexdigest()[:20]
    p = CACHE / kind / f"{h}{ext}"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _upstream(url: str, params: dict[str, Any] | None = None, timeout: float = 60) -> httpx.Response:
    try:
        r = httpx.get(url, params=params, headers=_headers(), timeout=timeout)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Vexcel unreachable: {type(e).__name__}") from e
    if r.status_code != 200:
        msg = r.text[:200] if "json" in r.headers.get("content-type", "") else ""
        raise HTTPException(502 if r.status_code >= 500 else r.status_code, f"Vexcel HTTP {r.status_code} {msg}")
    return r


def parse_xmp(jpeg: bytes) -> dict[str, str]:
    head = jpeg[:60000].decode("latin1", errors="ignore")
    return {k: v for k, v in re.findall(r"<Vexcel:([\w-]+)>([^<]*)<", head) if k != "geometry"}


def _parcel_point(parcel_id: str) -> tuple[float, float]:
    if parcel_id.startswith("pt:"):  # user-chosen location: pt:<lat>,<lon>
        try:
            la, lo = (float(v) for v in parcel_id[3:].split(","))
        except ValueError as e:
            raise HTTPException(422, "bad point id") from e
        if not (-90 <= la <= 90 and -180 <= lo <= 180):
            raise HTTPException(422, "bad point id")
        return la, lo
    with session() as c:
        row = c.execute("SELECT lat, lon FROM parcels WHERE parcel_id = ?", (parcel_id,)).fetchone()
    if not row or row["lat"] is None:
        raise HTTPException(404, f"Unknown parcel {parcel_id}")
    return row["lat"], row["lon"]


def _ortho(parcel_id: str, buffer_m: int, collection: str | None = None,
           layer: str | None = None) -> tuple[bytes, dict[str, str]]:
    """The ortho around a site (newest capture, or one named collection) and its metadata."""
    lat, lon = _parcel_point(parcel_id)
    key = f"{parcel_id}:{buffer_m}" + (f":{collection}:{layer or ''}" if collection else "")
    raw_path = _cache_path("ortho", key, ".jpg")
    meta_path = raw_path.with_suffix(".json")
    if raw_path.exists() and meta_path.exists():
        return raw_path.read_bytes(), json.loads(meta_path.read_text())
    params = {"wkt": f"POINT({lon} {lat})", "srid": "4326", "buffer-meter": str(buffer_m)}
    if collection:
        params.update({"collection": collection, "layer": layer or "urban"})
    r = _upstream(f"{BASE}/ortho/extract", params, timeout=90)
    meta = parse_xmp(r.content)
    meta.update({"center_lat": lat, "center_lon": lon, "buffer_m": buffer_m, "source": LABEL_SOURCE,
                 "label": "Sourced"})
    # Store a web-sized copy (originals are ~4,500 px / 5 MB at 7 cm GSD).
    try:
        from PIL import Image

        im = Image.open(io.BytesIO(r.content))
        im.thumbnail((1600, 1600))
        buf = io.BytesIO()
        im.convert("RGB").save(buf, "JPEG", quality=85)
        data = buf.getvalue()
    except Exception:  # Pillow missing or decode issue: serve the original
        data = r.content
    raw_path.write_bytes(data)
    meta_path.write_text(json.dumps(meta))
    return data, meta


_SLUG = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")
_LAYERS = ("urban", "urban-r", "urban-g", "wide-area", "graysky")


def _check_collection(collection: str | None, layer: str | None) -> None:
    if collection and not _SLUG.match(collection):
        raise HTTPException(422, "bad collection")
    if layer and layer not in _LAYERS:
        raise HTTPException(422, "bad layer")


@router.get("/ortho/{parcel_id}.jpg")
def ortho_image(parcel_id: str, buffer_m: int = 200, collection: str | None = None, layer: str | None = None) -> Response:
    buffer_m = max(50, min(buffer_m, 600))
    _check_collection(collection, layer)
    data, meta = _ortho(parcel_id, buffer_m, collection, layer)
    return Response(data, media_type="image/jpeg", headers={
        "Cache-Control": "public, max-age=86400",
        "X-Vexcel-Collection": meta.get("collection", ""),
        "X-Vexcel-Capture": meta.get("last-capture-date", ""),
    })


@router.get("/ortho/{parcel_id}/meta")
def ortho_meta(parcel_id: str, buffer_m: int = 200, collection: str | None = None,
               layer: str | None = None) -> dict[str, Any]:
    buffer_m = max(50, min(buffer_m, 600))
    _check_collection(collection, layer)
    data, meta = _ortho(parcel_id, buffer_m, collection, layer)
    return {**meta, "frame": ortho_frame(meta, _image_size(data))}


# ---------------------------------------------------------------- the ortho's ground footprint

EARTH_M_PER_PX0 = 156543.03392804097  # Web Mercator metres per pixel at zoom 0 on the equator
R_EARTH = 6378137.0


def _image_size(data: bytes) -> tuple[int, int] | None:
    try:
        from PIL import Image
        return Image.open(io.BytesIO(data)).size
    except Exception:  # noqa: BLE001
        return None


def ortho_frame(meta: dict[str, Any], size: tuple[int, int] | None) -> dict[str, Any]:
    """Where the served ortho image sits on the ground, in metres east and north of the requested point.

    Exact when the XMP has `pixel-bbox` (global Web Mercator pixels at `max-zoom`): west/east/south/north edges and
    metres per pixel of the served (resized) image. Otherwise a square 2 x buffer wide centred on the point, flagged
    exact=False."""
    lat = float(meta.get("center_lat") or 0)
    lon = float(meta.get("center_lon") or 0)
    buf = float(meta.get("buffer_m") or 200)
    fallback = {"west": -buf, "east": buf, "south": -buf, "north": buf, "exact": False,
                "m_per_px": (2 * buf / size[0]) if size else None, "width_px": size[0] if size else None,
                "height_px": size[1] if size else None,
                "method": "Assumed: a square 2 x buffer wide centred on the point (no usable pixel-bbox in the image metadata)."}
    try:
        bx, by, bw, bh = (float(v) for v in str(meta["pixel-bbox"]).split(","))
        z = int(meta.get("max-zoom") or meta.get("min-zoom") or 21)
    except (KeyError, ValueError):
        return fallback
    world = 256.0 * 2 ** z
    la = math.radians(lat)
    cx = (lon + 180.0) / 360.0 * world
    cy = (1 - math.log(math.tan(la) + 1 / math.cos(la)) / math.pi) / 2 * world
    mpp = EARTH_M_PER_PX0 * math.cos(la) / 2 ** z  # ground metres per global pixel at this latitude
    west, east = (bx - cx) * mpp, (bx + bw - cx) * mpp
    north, south = -(by - cy) * mpp, -(by + bh - cy) * mpp
    if abs((east - west) - 2 * buf) > 0.25 * 2 * buf:  # not the footprint we asked for: do not trust it
        return fallback
    w_px, h_px = size if size else (int(bw), int(bh))
    return {"west": round(west, 2), "east": round(east, 2), "south": round(south, 2), "north": round(north, 2),
            "exact": True, "m_per_px": round((east - west) / w_px, 4), "width_px": w_px, "height_px": h_px,
            "method": f"From the image's pixel-bbox (zoom-{z} Web Mercator pixels), scaled to the served image."}


def local_m(lat: float, lon: float, lat0: float, lon0: float) -> tuple[float, float]:
    """Metres east and north of (lat0, lon0), on the same Web Mercator scale as ortho_frame()."""
    k = math.cos(math.radians(lat0))
    e = R_EARTH * math.radians(lon - lon0) * k
    n = R_EARTH * (math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
                   - math.log(math.tan(math.pi / 4 + math.radians(lat0) / 2))) * k
    return e, n


def lonlat_of(e: float, n: float, lat0: float, lon0: float) -> tuple[float, float]:
    """Inverse of local_m: (lon, lat) of a point e metres east and n metres north of (lat0, lon0)."""
    k = R_EARTH * math.cos(math.radians(lat0))
    mlat = math.log(math.tan(math.pi / 4 + math.radians(lat0) / 2)) + n / k
    return lon0 + math.degrees(e / k), math.degrees(2 * math.atan(math.exp(mlat)) - math.pi / 2)


# ---------------------------------------------------------------- capture history (before / after)

@router.get("/captures/{parcel_id}")
def captures(parcel_id: str) -> dict[str, Any]:
    """Every ortho capture Vexcel holds over the site, newest first (what the account returns, nothing assumed)."""
    lat, lon = _parcel_point(parcel_id)
    body = _cached_json("captures", f"{BASE}/ortho/collections",
                        {"wkt": f"POINT({lon:.6f} {lat:.6f})", "srid": "4326", "layer": "urban,urban-r",
                         "include": "layer,collection,first-capture-date,last-capture-date,min-gsd"})
    seen, out = set(), []
    for f in body.get("features", []):
        p = f.get("properties") or {}
        c = p.get("collection")
        if not c or c in seen:
            continue
        seen.add(c)
        out.append({"collection": c, "layer": p.get("layer"), "first_capture": p.get("first-capture-date"),
                    "last_capture": p.get("last-capture-date"),
                    "gsd_cm": round(float(p["min-gsd"]) * 100, 1) if p.get("min-gsd") else None})
    out.sort(key=lambda x: x.get("last_capture") or "", reverse=True)
    return {"captures": out, "count": len(out), "source": LABEL_SOURCE, "label": "Sourced"}


# ---------------------------------------------------------------- oblique views

DIRECTIONS = ("north", "east", "south", "west")


@router.get("/oblique/{parcel_id}/list")
def oblique_list(parcel_id: str) -> dict[str, Any]:
    """Oblique directions available over the site, from the newest collection that has any."""
    lat, lon = _parcel_point(parcel_id)
    body = _cached_json("oblique", f"{BASE}/oriented/collections",
                        {"wkt": f"POINT({lon:.6f} {lat:.6f})", "srid": "4326", "layer": "urban",
                         "product-type": "oblique", "include": "product-type,collection,last-capture-date"})
    rows = [(f.get("properties") or {}) for f in body.get("features", [])]
    rows = [r for r in rows if str(r.get("product-type", "")).startswith("oblique-")]
    if not rows:
        return {"directions": [], "collection": None, "source": LABEL_SOURCE, "label": "Unknown"}
    newest = max(rows, key=lambda r: r.get("last-capture-date") or "")
    col = newest.get("collection")
    dirs = sorted({r["product-type"].removeprefix("oblique-") for r in rows if r.get("collection") == col},
                  key=lambda d: DIRECTIONS.index(d) if d in DIRECTIONS else 9)
    return {"directions": dirs, "collection": col, "captured": newest.get("last-capture-date"),
            "collections": sorted({r.get("collection") for r in rows if r.get("collection")}),
            "source": LABEL_SOURCE, "label": "Sourced"}


@router.get("/oblique/{parcel_id}.jpg")
def oblique_image(parcel_id: str, dir: str = "north", buffer_m: int = 150) -> Response:  # noqa: A002
    """One oblique (angled) photo of the site: Vexcel product `oblique-<dir>` from the newest collection that has it."""
    if dir not in DIRECTIONS:
        raise HTTPException(422, "dir must be north, east, south or west")
    buffer_m = max(40, min(buffer_m, 400))
    lat, lon = _parcel_point(parcel_id)
    listing = oblique_list(parcel_id)
    if dir not in listing["directions"]:
        raise HTTPException(404, f"No oblique-{dir} image over this site")
    path = _cache_path("oblique", f"{parcel_id}:{dir}:{buffer_m}:{listing['collection']}", ".jpg")
    if path.exists():
        data = path.read_bytes()
    else:
        r = _upstream(f"{BASE}/oriented/extract",
                      {"wkt": f"POINT({lon:.6f} {lat:.6f})", "srid": "4326", "layer": "urban",
                       "buffer-meter": str(buffer_m), "product-type": f"oblique-{dir}",
                       "collection": listing["collection"], "rotation": "natural", "image-format": "jpeg"}, timeout=90)
        data = r.content
        try:
            from PIL import Image
            im = Image.open(io.BytesIO(data))
            im.thumbnail((1600, 1600))
            buf = io.BytesIO()
            im.convert("RGB").save(buf, "JPEG", quality=85)
            data = buf.getvalue()
        except Exception:  # noqa: BLE001
            pass
        path.write_bytes(data)
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400",
                                                             "X-Vexcel-Collection": listing["collection"] or ""})


# ---------------------------------------------------------------- neighbour heights (DSM - DTM)

def _ring(wkt: str) -> list[tuple[float, float]]:
    """The outer ring of a WKT POLYGON / MULTIPOLYGON as (lon, lat) pairs."""
    m = re.search(r"\(\(+([^()]+)\)", wkt or "")
    if not m:
        return []
    pts = []
    for pair in m.group(1).split(","):
        xy = pair.split()
        if len(xy) >= 2:
            pts.append((float(xy[0]), float(xy[1])))
    return pts


def _inside(x: float, y: float, poly: list[tuple[float, float]]) -> bool:
    hit = False
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
            hit = not hit
    return hit


def _samples(poly: list[tuple[float, float]], n: int = 5) -> list[tuple[float, float]]:
    """Up to n points spread inside a footprint (local metres), 1.5 m in from its edges where the DSM meets the ground."""
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    grid = (0.5, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6)
    pts = [(x0 + fx * (x1 - x0), y0 + fy * (y1 - y0)) for fy in grid for fx in grid]
    pts = [(x, y) for x, y in pts
           if _inside(x, y, poly) and all(_inside(x + dx, y + dy, poly) for dx, dy in ((1.5, 0), (-1.5, 0), (0, 1.5), (0, -1.5)))]
    if len(pts) > n:
        step = len(pts) / n
        pts = [pts[int(i * step)] for i in range(n)]
    return pts


_Z = re.compile(r"(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)")


def _elevations(kind: str, pts_lonlat: list[tuple[float, float]]) -> list[float | None]:
    """Vexcel DSM or DTM heights (m) for many points, one call per 150 points (MULTIPOINT in, MULTIPOINT Z out)."""
    out: list[float | None] = []
    for i in range(0, len(pts_lonlat), 150):
        chunk = pts_lonlat[i:i + 150]
        wkt = "MULTIPOINT(" + ",".join(f"({lo:.7f} {la:.7f})" for lo, la in chunk) + ")"
        body = _upstream(f"{BASE}/{kind}/elevation",
                         {"wkt": wkt, "srid": "4326", "layer": "urban" if kind == "dsm" else "urban,wide-area"}).json()
        zs: list[float | None] = [float(m.group(3)) for m in _Z.finditer(body.get("wkt", ""))]
        out += (zs + [None] * len(chunk))[:len(chunk)]
    return out


def _median(v: list[float | None]) -> float | None:
    s = sorted(x for x in v if x is not None)
    if not s:
        return None
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def neighbour_heights(parcel_id: str, radius_m: int = 200) -> dict[str, Any]:
    """Structures within radius_m of the site centre with Vexcel-measured heights (cached on disk)."""
    radius_m = max(50, min(radius_m, 400))
    lat0, lon0 = _parcel_point(parcel_id)
    cache = _cache_path("neighbours", f"{parcel_id}:{radius_m}", ".json")
    if cache.exists():
        return json.loads(cache.read_text())
    body = _upstream(f"{BASE}/structure/extract", {"wkt": f"POINT({lon0:.6f} {lat0:.6f})", "srid": "4326",
                                                    "buffer-meter": str(radius_m), "total-records": "120"}, timeout=90).json()
    structures: list[dict[str, Any]] = []
    sample_ll: list[tuple[float, float]] = []
    owners: list[int] = []
    for f in body.get("features", []):
        p = f.get("properties") or {}
        ring = _ring(p.get("footprint.wkt", ""))
        if len(ring) < 3:
            continue
        local = [local_m(la, lo, lat0, lon0) for lo, la in ring]
        cx = sum(x for x, _ in local) / len(local)
        cy = sum(y for _, y in local) / len(local)
        pts = _samples(local) or [(cx, cy)]  # a sliver too thin to sample away from its edges: its vertex centroid
        k = len(structures)
        for x, y in pts:
            sample_ll.append(lonlat_of(x, y, lat0, lon0))
            owners.append(k)
        structures.append({"id": f"V{k + 1}", "footprint": [[round(x, 1), round(y, 1)] for x, y in local],
                           "centre": [round(cx, 1), round(cy, 1)], "area_m2": round(float(p.get("footprint.area") or 0)),
                           "building_type": p.get("building-type.class"),
                           "roof": p.get("roof-characteristics.material.class"),
                           "roof_shape": p.get("roof-characteristics.shape.value"),
                           "captured": p.get("metadata.ortho-date-estimate"), "collection": p.get("metadata.collection"),
                           "samples": len(pts), "height_m": None, "ground_m": None, "storeys_est": None})
    measured = 0
    if sample_ll:
        dsm, dtm = _elevations("dsm", sample_ll), _elevations("dtm", sample_ll)
        for k, s in enumerate(structures):
            top = _median([dsm[i] for i, o in enumerate(owners) if o == k])
            ground = _median([dtm[i] for i, o in enumerate(owners) if o == k])
            if top is None or ground is None:
                continue
            h = round(max(0.0, top - ground), 1)
            s.update(height_m=h, ground_m=round(ground, 1), storeys_est=max(1, round(h / 4.0)) if h >= 2.5 else None)
            measured += 1
    structures.sort(key=lambda s: math.hypot(*s["centre"]))
    out = {"structures": structures, "count": len(structures), "measured": measured, "radius_m": radius_m,
           "method": "Footprints from Vexcel structure/extract. Height = median Vexcel DSM (surface) minus median DTM "
                     "(bare earth) at up to 5 points inside each footprint, 1.5 m in from its edges. Storeys assume 4 m each.",
           "frame": "Metres east (x) and north (y) of the site centre.", "source": LABEL_SOURCE, "label": "Measured"}
    cache.write_text(json.dumps(out))
    return out


@router.get("/neighbours/{parcel_id}")
def neighbours(parcel_id: str, radius_m: int = 200) -> dict[str, Any]:
    return neighbour_heights(parcel_id, radius_m)


# ---------------------------------------------------------------- 3D Tiles

def _region_contains(region: list[float], lat: float, lon: float) -> bool:
    w, s, e, n = region[:4]
    la, lo = math.radians(lat), math.radians(lon)
    return w <= lo <= e and s <= la <= n


def _cached_json(kind: str, url: str, params: dict[str, Any]) -> dict[str, Any]:
    key = url + "?" + "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    p = _cache_path(kind, key, ".json")
    if p.exists():
        return json.loads(p.read_text())
    body = _upstream(url, params).json()
    p.write_text(json.dumps(body))
    return body


def _region_intersects_box(region: list[float], lat: float, lon: float, radius_m: float) -> bool:
    w, s_, e, n = region[:4]
    dlat = math.radians(radius_m / 111_320.0)
    dlon = math.radians(radius_m / (111_320.0 * max(0.2, math.cos(math.radians(lat)))))
    la, lo = math.radians(lat), math.radians(lon)
    return not (e < lo - dlon or w > lo + dlon or n < la - dlat or s_ > la + dlat)


def _collection_for(lat: float, lon: float) -> tuple[str, dict[str, Any]] | None:
    top = _cached_json("3d", f"{BASE}/3d/tileset", {})
    for child in top.get("root", {}).get("children", []):
        region = (child.get("boundingVolume") or {}).get("region")
        uri = (child.get("content") or {}).get("uri", "")
        m = re.search(r"collection=([^&]+)", uri)
        if region and m and _region_contains(region, lat, lon):
            return m.group(1), child
    return None


def _site_tileset(collection: str, lat: float, lon: float, radius_m: float) -> dict[str, Any]:
    """The collection tileset pruned to the zoom-13 cells within radius_m of the site (the full one has ~120)."""
    full = _cached_json("3d", f"{BASE}/3d/tileset", {"collection": collection, "layer": "3d-cities"})
    root = full.get("root", {})
    kept = []
    for ch in root.get("children", []):
        region = (ch.get("boundingVolume") or {}).get("region")
        if region and _region_intersects_box(region, lat, lon, radius_m):
            c = dict(ch)
            uri = (c.get("content") or {}).get("uri", "")
            c["content"] = {"uri": uri.replace("./tileset?", "./tileset.json?").replace("./tile?", "./tile.glb?")}
            kept.append(c)
    if not kept:
        raise HTTPException(404, "No Vexcel 3D cells within the requested radius")
    regions = [c["boundingVolume"]["region"] for c in kept]
    union = [min(r[0] for r in regions), min(r[1] for r in regions), max(r[2] for r in regions),
             max(r[3] for r in regions), min(r[4] for r in regions), max(r[5] for r in regions)]
    return {
        "asset": full.get("asset", {"version": "1.1"}),
        "geometricError": root.get("geometricError", 96),
        "root": {"boundingVolume": {"region": union}, "geometricError": root.get("geometricError", 96),
                 "refine": root.get("refine", "REPLACE"), "children": kept},
        "extras": {"source": LABEL_SOURCE, "pruned_from": len(root.get("children", [])), "kept": len(kept),
                   "radius_m": radius_m},
    }


@router.get("/3d/root")
def tileset_root(lat: float, lon: float, request: Request, radius_m: float = 1500) -> dict[str, Any]:
    """3D coverage at a point -> URL of a site-pruned tileset served by this proxy."""
    found = _collection_for(lat, lon)
    if not found:
        raise HTTPException(404, "No Vexcel 3D coverage at this point")
    collection, _ = found
    ts = _site_tileset(collection, lat, lon, radius_m)
    base = str(request.base_url).rstrip("/")
    return {"tileset_url": f"{base}/vexcel/3d/site.json?collection={collection}&lat={lat:.6f}&lon={lon:.6f}&radius_m={radius_m:g}",
            "collection": collection, "cells": ts["extras"]["kept"], "cells_total": ts["extras"]["pruned_from"],
            "source": LABEL_SOURCE, "label": "Sourced"}


@router.get("/3d/site.json")
def site_tileset(collection: str, lat: float, lon: float, radius_m: float = 1500) -> Response:
    if not re.match(r"^[a-z0-9_-]+$", collection):
        raise HTTPException(422, "bad collection")
    body = json.dumps(_site_tileset(collection, lat, lon, max(200.0, min(radius_m, 8000.0))))
    return Response(body, media_type="application/json",
                    headers={"Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*"})


_ENDPOINTS = {"tileset": "tileset", "tileset.json": "tileset", "tile": "tile", "tile.glb": "tile"}


def _rewrite_tileset(data: bytes, own_base: str) -> bytes:
    """Point every link at this proxy, with file extensions the 3D Tiles renderer can classify."""
    text = data.decode("utf-8")
    text = text.replace(f"{BASE}/3d/tileset?", "./tileset.json?").replace(f"{BASE}/3d/tile?", "./tile.glb?")
    text = text.replace(f"{BASE}/3d/", own_base)
    text = text.replace('"./tileset?', '"./tileset.json?').replace('"./tile?', '"./tile.glb?')
    return text.encode("utf-8")


@router.get("/3d/{endpoint}", name="tiles_proxy")
def tiles_proxy(endpoint: str, request: Request) -> Response:
    upstream = _ENDPOINTS.get(endpoint)
    if upstream is None:
        raise HTTPException(404, "Unknown 3D endpoint")
    params = dict(request.query_params)
    key = upstream + "?" + "&".join(f"{k}={v}" for k, v in sorted(params.items()))
    path = _cache_path("3d", key, ".json" if upstream == "tileset" else ".glb")
    if path.exists():
        data = path.read_bytes()
    else:
        data = _upstream(f"{BASE}/3d/{upstream}", params).content
        path.write_bytes(data)
    if upstream == "tileset":
        data = _rewrite_tileset(data, f"{str(request.base_url).rstrip('/')}/vexcel/3d/")
    media = "application/json" if upstream == "tileset" else "model/gltf-binary"
    return Response(data, media_type=media, headers={"Cache-Control": "public, max-age=86400",
                                                     "Access-Control-Allow-Origin": "*"})

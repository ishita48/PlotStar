"""Gemini vision on real imagery: obstacles on the Vexcel aerial, hazards in a Tello frame.

find_obstacles(site_ref, site_w, site_d)
    1. Fetch the Vexcel ortho around the site (the same image and buffer the Studio's plan uses).
    2. ortho_frame() gives the image's exact ground footprint (metres east/north of the site point, from pixel-bbox).
    3. Crop the site rectangle (+ a margin), assumed centred on the site point and north-up, the same assumption the
       plan and 3D model make when they lay the aerial under the drawing. The true parcel boundary is not in the data.
    4. Gemini (structured JSON) boxes existing buildings, structures, trees, water, parking, paving and roads as
       box_2d = [ymin, xmin, ymax, xmax] normalised to 0..1000 on the crop.
    5. Boxes -> metres in the site frame: origin at the site rectangle's south-west corner, x east, y north; each
       obstacle's (x, y) is its own south-west corner. Clipped to the rectangle; boxes entirely outside are dropped.

describe_frame(image)  a drone frame -> a short description and hazards (people, water, wires, vehicles, debris) with
                       boxes normalised 0..1 for an overlay.

Only pixels and geometry go to Gemini: no property names, addresses, ids or coordinates.
"""
from __future__ import annotations

import hashlib
import io
import json
from typing import Any

from app import config
from app.sponsors.gemini import client as G

SOURCE = "Gemini on Vexcel ortho"
KINDS = ["building", "structure", "trees", "water", "parking", "paving", "road"]
CACHE = config.CACHE_DIR / "gemini"
MAX_OBSTACLES = 60  # the layout engine's limit

OBSTACLE_SCHEMA = {
    "type": "object",
    "properties": {
        "scene": {"type": "string", "description": "One sentence: what this land is today."},
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": KINDS},
                    "label": {"type": "string", "description": "Two to five words, e.g. 'warehouse, flat roof'"},
                    "box_2d": {"type": "array", "items": {"type": "integer"}, "description": "[ymin, xmin, ymax, xmax], 0-1000"},
                    "confidence": {"type": "number", "description": "0 to 1"},
                },
                "required": ["kind", "label", "box_2d", "confidence"],
            },
        },
    },
    "required": ["scene", "items"],
}

OBSTACLE_PROMPT = """This is a north-up orthophoto (an aerial photo taken straight down; north is up), {w:.0f} m wide and \
{h:.0f} m tall, {gsd:.2f} m per pixel. A developer wants to know what already occupies this land before placing a new building.

Box every existing feature that would block or constrain construction:
- building: any roofed building (one box per building; a large building with several roof levels is one box)
- structure: smaller fixed structures such as tanks, towers, canopies, sheds, pylons
- trees: individual large trees or tree clusters (one box per cluster)
- water: ponds, pools, detention basins, channels, ditches with water
- parking: parking lots (one box per lot)
- paving: other paved yards, slabs, hardstanding
- road: roads and driveways crossing or bordering the land

Ignore vehicles, shadows, lawn, bare soil and markings. Boxes may overlap. At most 40 items, largest first.
Return box_2d as [ymin, xmin, ymax, xmax] in 0-1000 relative to this image, and a confidence from 0 to 1."""


def _ortho_for(site_ref: str, buffer_m: int) -> tuple[bytes, dict[str, Any], dict[str, Any]]:
    from app.sponsors.vexcel import routes as vx
    data, meta = vx._ortho(site_ref, buffer_m)
    frame = vx.ortho_frame(meta, vx._image_size(data))
    return data, meta, frame


def plan_buffer(site_w: float, site_d: float) -> int:
    """The ortho buffer the Studio's 2D plan and 3D model use for this site size (so the image is the same one)."""
    return int(min(600, round(max(site_w, site_d) / 2 + 90)))


def box_to_local(box: list[int], crop: tuple[int, int, int, int], frame: dict[str, Any]) -> tuple[float, float, float, float]:
    """A Gemini box (0..1000 on the crop) -> (west, south, east, north) metres from the site point."""
    ymin, xmin, ymax, xmax = (max(0, min(1000, int(v))) for v in box[:4])
    if xmax < xmin:
        xmin, xmax = xmax, xmin
    if ymax < ymin:
        ymin, ymax = ymax, ymin
    u0, v0, u1, v1 = crop
    cw, ch = u1 - u0, v1 - v0
    mpp = frame["m_per_px"]
    px0, px1 = u0 + xmin / 1000 * cw, u0 + xmax / 1000 * cw
    py0, py1 = v0 + ymin / 1000 * ch, v0 + ymax / 1000 * ch  # image rows grow southwards
    west = frame["west"] + px0 * mpp
    east = frame["west"] + px1 * mpp
    north = frame["north"] - py0 * mpp
    south = frame["north"] - py1 * mpp
    return west, south, east, north


def to_site(west: float, south: float, east: float, north: float, site_w: float, site_d: float) -> dict[str, float] | None:
    """Local metres (from the site centre) -> the site frame (SW origin, y north), clipped to the rectangle."""
    x0, x1 = max(0.0, west + site_w / 2), min(site_w, east + site_w / 2)
    y0, y1 = max(0.0, south + site_d / 2), min(site_d, north + site_d / 2)
    if x1 - x0 < 1 or y1 - y0 < 1:
        return None
    return {"x": round(x0, 1), "y": round(y0, 1), "w": round(x1 - x0, 1), "d": round(y1 - y0, 1)}


def find_obstacles(site_ref: str, site_w: float, site_d: float, *, refresh: bool = False) -> dict[str, Any]:
    from PIL import Image

    site_w, site_d = float(site_w), float(site_d)
    buffer_m = plan_buffer(site_w, site_d)
    data, meta, frame = _ortho_for(site_ref, buffer_m)
    key = hashlib.sha1(f"{site_ref}:{site_w:.0f}:{site_d:.0f}:{G.VISION_MODEL}:{meta.get('collection')}".encode()).hexdigest()[:20]
    cache = CACHE / "obstacles" / f"{key}.json"
    if cache.exists() and not refresh:
        return {**advise(json.loads(cache.read_text())), "cached": True}
    if not frame.get("m_per_px"):
        raise G.GeminiError("The Vexcel image size is unknown, so boxes cannot be measured")

    # the site rectangle plus a margin, in served-image pixels (rows grow southwards)
    margin = max(10.0, 0.06 * max(site_w, site_d))
    mpp = frame["m_per_px"]
    im = Image.open(io.BytesIO(data)).convert("RGB")
    u0 = max(0, int((-site_w / 2 - margin - frame["west"]) / mpp))
    u1 = min(im.width, int((site_w / 2 + margin - frame["west"]) / mpp + 0.999))
    v0 = max(0, int((frame["north"] - (site_d / 2 + margin)) / mpp))
    v1 = min(im.height, int((frame["north"] + site_d / 2 + margin) / mpp + 0.999))
    crop = (u0, v0, u1, v1)
    buf = io.BytesIO()
    im.crop(crop).save(buf, "JPEG", quality=90)
    crop_w_m, crop_h_m = (u1 - u0) * mpp, (v1 - v0) * mpp

    prompt = OBSTACLE_PROMPT.format(w=crop_w_m, h=crop_h_m, gsd=mpp)
    raw, info = G.generate_json([G.inline(buf.getvalue(), "image/jpeg"), G.text(prompt)], OBSTACLE_SCHEMA)
    items = raw.get("items") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        raise G.GeminiError("Gemini's answer had no items list")

    obstacles, outside = [], 0
    for it in items:
        box = it.get("box_2d") if isinstance(it, dict) else None
        if not (isinstance(box, list) and len(box) >= 4):
            continue
        west, south, east, north = box_to_local(box, crop, frame)
        clipped = to_site(west, south, east, north, site_w, site_d)
        if clipped is None:
            outside += 1
            continue
        kind = it.get("kind") if it.get("kind") in KINDS else "structure"
        full_area = (east - west) * (north - south)
        obstacles.append({
            "id": f"G{len(obstacles) + 1}", **clipped, "kind": kind,
            "label": str(it.get("label") or kind)[:60],
            "confidence": round(max(0.0, min(1.0, float(it.get("confidence") or 0))), 2),
            "source": SOURCE,
            # the unclipped box, metres from the site centre: lets the Studio re-fit it if the rectangle changes
            "local": {"west": round(west, 1), "south": round(south, 1), "east": round(east, 1), "north": round(north, 1)},
            "clipped": clipped["w"] * clipped["d"] < full_area * 0.98,
        })
        if len(obstacles) >= MAX_OBSTACLES:
            break

    out = {
        "obstacles": obstacles, "outside_site": outside, "scene": str(raw.get("scene") or "")[:300],
        "site": {"w": site_w, "d": site_d},
        "image": {"buffer_m": buffer_m, "collection": meta.get("collection"), "captured": meta.get("last-capture-date"),
                  # the served image's ground extent in the site frame (SW origin, y north)
                  "x0": round(frame["west"] + site_w / 2, 2), "x1": round(frame["east"] + site_w / 2, 2),
                  "y0": round(frame["south"] + site_d / 2, 2), "y1": round(frame["north"] + site_d / 2, 2)},
        "scanned": {"x0": round(frame["west"] + u0 * mpp + site_w / 2, 1), "x1": round(frame["west"] + u1 * mpp + site_w / 2, 1),
                    "y0": round(frame["north"] - v1 * mpp + site_d / 2, 1), "y1": round(frame["north"] - v0 * mpp + site_d / 2, 1)},
        "mapping": {
            "image_footprint": "exact" if frame.get("exact") else "assumed",
            "m_per_px": mpp, "method": frame.get("method"),
            "site_rectangle": "Assumed: the site rectangle is centred on the site point and aligned north-up. The true parcel "
                              "boundary is not in the data, so a box near the edge may belong to a neighbour.",
            "frame": "Metres from the site's south-west corner, x east, y north; (x, y) is each obstacle's south-west corner.",
        },
        "model": info["model"], "ms": info["ms"], "tokens": {k: info.get(k) for k in ("input_tokens", "output_tokens", "thinking_tokens")},
        "source": SOURCE, "label": "AI-detected",
    }
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(out))
    return {**advise(out), "cached": False}


def advise(result: dict[str, Any]) -> dict[str, Any]:
    """A keep / discard suggestion per box. A box is axis-aligned, so a diagonal road's box covers far more than the
    road, and a box over most of the site would block every layout: those start discarded, with the reason."""
    area = float(result["site"]["w"]) * float(result["site"]["d"])
    for o in result.get("obstacles", []):
        share = o["w"] * o["d"] / area if area else 0
        why = None
        if o["kind"] == "road":
            why = "Roads are drawn as boxes; a box around a diagonal or edge road covers much more than the road."
        elif share > 0.35:
            why = f"Covers {share:.0%} of the site; check it is really one feature."
        elif o["confidence"] < 0.5:
            why = "Low confidence."
        o["suggest_keep"], o["advice"] = why is None, why
        o["site_share"] = round(share, 3)
    return result


# ------------------------------------------------------------------------------------------------- drone frames

HAZARDS = ["person", "water", "wires", "vehicle", "debris", "tree", "structure", "other"]
FRAME_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "description": "Two sentences: what the camera sees."},
        "ground": {"type": "string", "description": "The ground surface in a few words (paving, grass, gravel, water...)"},
        "visibility": {"type": "string", "enum": ["good", "fair", "poor"]},
        "hazards": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": HAZARDS},
                    "label": {"type": "string"},
                    "severity": {"type": "string", "enum": ["low", "medium", "high"]},
                    "why": {"type": "string", "description": "Why it matters for a drone survey or for building here"},
                    "box_2d": {"type": "array", "items": {"type": "integer"}},
                },
                "required": ["kind", "label", "severity", "why", "box_2d"],
            },
        },
    },
    "required": ["summary", "ground", "visibility", "hazards"],
}
FRAME_PROMPT = """This is one frame from a small survey drone's camera, flown over a candidate building site.
Describe what it shows in two sentences. Then list hazards for the flight or for construction, only ones you can see:
people, water, overhead wires or poles, vehicles, debris, plus trees or structures close to the drone's path.
Severity high = a risk to people or the drone now. If you see none, return an empty hazards list; do not guess.
Give each hazard's box_2d as [ymin, xmin, ymax, xmax] in 0-1000 relative to the image."""


def describe_frame(image: bytes) -> dict[str, Any]:
    from PIL import Image

    try:
        im = Image.open(io.BytesIO(image)).convert("RGB")
    except Exception as e:  # noqa: BLE001
        raise G.GeminiError("That file is not an image") from e
    im.thumbnail((1280, 1280))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=88)
    key = hashlib.sha1(buf.getvalue()).hexdigest()[:20]
    cache = CACHE / "frames" / f"{key}.json"
    if cache.exists():
        return {**json.loads(cache.read_text()), "cached": True}
    raw, info = G.generate_json([G.inline(buf.getvalue(), "image/jpeg"), G.text(FRAME_PROMPT)], FRAME_SCHEMA)
    hazards = []
    for h in raw.get("hazards") or []:
        b = h.get("box_2d") or []
        box = None
        if isinstance(b, list) and len(b) >= 4:
            ymin, xmin, ymax, xmax = (max(0, min(1000, int(v))) / 1000 for v in b[:4])
            box = {"x": min(xmin, xmax), "y": min(ymin, ymax), "w": abs(xmax - xmin), "h": abs(ymax - ymin)}
        hazards.append({"kind": h.get("kind") if h.get("kind") in HAZARDS else "other", "label": str(h.get("label") or "")[:60],
                        "severity": h.get("severity") if h.get("severity") in ("low", "medium", "high") else "low",
                        "why": str(h.get("why") or "")[:200], "box": box})
    out = {"summary": str(raw.get("summary") or ""), "ground": str(raw.get("ground") or ""),
           "visibility": raw.get("visibility") or "fair", "hazards": hazards, "image_px": list(im.size),
           "model": info["model"], "ms": info["ms"], "source": "Gemini on the drone frame", "label": "AI-detected"}
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(out))
    return {**out, "cached": False}

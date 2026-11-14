"""External public datasets used by screening, cached with source and retrieval time (PRD section 9).

- FEMA National Flood Hazard Layer (NFHL): flood zone at a point.
- OpenStreetMap via Overpass: power substations in a market bounding box.

Every fetch is stored in `evidence_cache` so the demo runs offline after one warm-up, and so the audit
trail can show exactly what was retrieved and when. Failures are recorded as Unknown, never guessed.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import httpx

from .db import session

USER_AGENT = "PlotStar-hackathon/0.1"
FEMA_URL = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query"
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

MARKET_BBOX = {  # south, west, north, east
    "Houston": (29.45, -95.95, 30.15, -94.95),
    "Los Angeles": (33.65, -118.75, 34.35, -117.85),
}

DDL = """
CREATE TABLE IF NOT EXISTS evidence_cache (
    key           TEXT PRIMARY KEY,
    source        TEXT NOT NULL,
    url           TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    retrieved_at  TEXT NOT NULL
)
"""


def init() -> None:
    with session() as c:
        c.execute(DDL)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _cached(key: str) -> dict[str, Any] | None:
    with session() as c:
        row = c.execute("SELECT * FROM evidence_cache WHERE key = ?", (key,)).fetchone()
    if not row:
        return None
    return {"payload": json.loads(row["payload_json"]), "source": row["source"], "url": row["url"],
            "retrieved_at": row["retrieved_at"]}


def _store(key: str, source: str, url: str, payload: Any) -> dict[str, Any]:
    now = _now()
    with session() as c:
        c.execute("INSERT OR REPLACE INTO evidence_cache VALUES (?,?,?,?,?)",
                  (key, source, url, json.dumps(payload), now))
    return {"payload": payload, "source": source, "url": url, "retrieved_at": now}


def fema_flood_zone(lat: float, lon: float, *, offline: bool = False) -> dict[str, Any] | None:
    """FEMA NFHL flood zone at a point. Returns cached evidence, or None if unavailable."""
    key = f"fema:{lat:.6f},{lon:.6f}"
    hit = _cached(key)
    if hit or offline:
        return hit
    params = {
        "geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects", "outFields": "FLD_ZONE,ZONE_SUBTY,SFHA_TF,DFIRM_ID",
        "returnGeometry": "false", "f": "json",
    }
    try:
        r = httpx.get(FEMA_URL, params=params, timeout=30, headers={"User-Agent": USER_AGENT})
        r.raise_for_status()
        body = r.json()
    except (httpx.HTTPError, ValueError):
        return None
    if "error" in body:
        return None
    feats = [f["attributes"] for f in body.get("features", [])]
    return _store(key, "FEMA National Flood Hazard Layer (NFHL)", FEMA_URL, {"zones": feats})


AQUEDUCT_URL = ("https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/"
                "aqueduct_water_risk/FeatureServer/1/query")  # Aqueduct 4.0 Baseline Annual (Esri Living Atlas)


def aqueduct_water_stress(lat: float, lon: float, *, offline: bool = False) -> dict[str, Any] | None:
    """WRI Aqueduct 4.0 baseline annual water stress (bws) for the sub-basin containing the point."""
    key = f"aqueduct:{lat:.5f},{lon:.5f}"
    hit = _cached(key)
    if hit or offline:
        return hit
    params = {
        "geometry": f"{lon},{lat}", "geometryType": "esriGeometryPoint", "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects", "returnGeometry": "false", "f": "json",
        "outFields": "string_id,pfaf_id,name_1,bws_raw,bws_score,bws_cat,bws_label",
    }
    try:
        r = httpx.get(AQUEDUCT_URL, params=params, timeout=30, headers={"User-Agent": USER_AGENT})
        r.raise_for_status()
        body = r.json()
    except (httpx.HTTPError, ValueError):
        return None
    if "error" in body or not body.get("features"):
        return None
    return _store(key, "WRI Aqueduct 4.0 Baseline Annual (CC BY 4.0) via Esri Living Atlas", AQUEDUCT_URL,
                  body["features"][0]["attributes"])


def osm_substations(market: str, *, offline: bool = False) -> dict[str, Any] | None:
    """All OSM power=substation nodes/ways in the market bbox (one query, cached)."""
    if market not in MARKET_BBOX:
        return None
    key = f"osm-substations:{market}"
    hit = _cached(key)
    if hit or offline:
        return hit
    s, w, n, e = MARKET_BBOX[market]
    q = (f'[out:json][timeout:90];(node["power"="substation"]({s},{w},{n},{e});'
         f'way["power"="substation"]({s},{w},{n},{e}););out center tags;')
    try:
        r = httpx.post(OVERPASS_URL, data={"data": q}, timeout=120,
                       headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        r.raise_for_status()
        body = r.json()
    except (httpx.HTTPError, ValueError):
        return None
    subs = []
    for el in body.get("elements", []):
        lat = el.get("lat", (el.get("center") or {}).get("lat"))
        lon = el.get("lon", (el.get("center") or {}).get("lon"))
        if lat is None or lon is None:
            continue
        tags = el.get("tags", {})
        volts = [int(v) for v in str(tags.get("voltage", "")).split(";") if v.strip().isdigit()]
        subs.append({"osm_id": f"{el['type']}/{el['id']}", "lat": lat, "lon": lon, "name": tags.get("name"),
                     "operator": tags.get("operator"), "max_kv": max(volts) / 1000 if volts else None})
    payload = {"osm_base": body.get("osm3s", {}).get("timestamp_osm_base"), "substations": subs}
    return _store(key, "OpenStreetMap contributors via Overpass API (ODbL)", OVERPASS_URL, payload)

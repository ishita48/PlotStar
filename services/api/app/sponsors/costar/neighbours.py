"""CoStar neighbours of a site, shaped for the Explore 3D context ("comps in 3D").

Every CoStar kit property within a radius of the site, with what a 3D block needs: where it is (metres east and north
of the site centre), how big and tall it is, and the two colour channels the viewer toggles between:

  rent          area-weighted low end of the asking rent on the property's available lease spaces, $/sf/year
                (tenancy.listing_spaces; asking, not achieved; the kit's own normalisation rule)
  availability  marketed lease space / rentable building area. The kit says "available is not vacant"
                (models/commercial-listing-summary.md), so this is labelled availability, a vacancy proxy, never vacancy.

Height: CoStar storeys above grade x 4.5 m (team assumption, a commercial storey) when the kit records storeys; else a
labelled default. Footprint: building area / storeys as a square, capped; land shows as a flat pad sized from the lot.
Nothing is invented: a value the kit does not hold is null and the reason travels with it.

This output is for GeoStar's own UI. It is never placed in a model prompt or a trace.
"""
from __future__ import annotations

import math
from typing import Any

from app.db import connect
from app.engine.screening import haversine_m
from app.sponsors.costar import tenancy

STOREY_M = 4.5            # team assumption: one commercial storey
DEFAULT_H = 8.0           # shown when the kit has no storeys; labelled
LAND_H = 0.6
SQM_PER_SQFT = 0.09290304
SQM_PER_ACRE = 4046.8564224
MAX_SIDE_M = 140.0
SOURCE = "CoStar Data Extract (data/commercial-property.jsonl; data/commercial-listing-summary.jsonl for rents and availability)"


def _offset(lat0: float, lon0: float, lat: float, lon: float) -> tuple[float, float]:
    """Metres east and north of (lat0, lon0), local equirectangular (exact enough within a few km)."""
    east = (lon - lon0) * math.cos(math.radians(lat0)) * 111_320.0
    north = (lat - lat0) * 110_540.0
    return round(east, 1), round(north, 1)


def _shape(p: dict[str, Any], rba: float | None) -> dict[str, Any]:
    stories, bsf = p.get("stories"), p.get("building_sf") or rba
    land = p.get("property_type") == "Land" or not bsf
    if land:
        acres = p.get("lot_acres")
        side = min(MAX_SIDE_M, math.sqrt(acres * SQM_PER_ACRE)) if acres else 30.0
        return dict(height_m=LAND_H, height_basis="Land or no building recorded: drawn as a flat pad",
                    footprint_m=round(side, 1), footprint_basis=("Square-equivalent of the CoStar lot size, capped"
                                                                 if acres else "No lot size in the kit: default 30 m pad"),
                    height_label="Default")
    if stories and stories > 0:
        h, basis, lab = stories * STOREY_M, f"{stories} storeys (CoStar) x {STOREY_M:g} m (team assumption)", "Estimated"
    else:
        h, basis, lab = DEFAULT_H, f"Storeys not in the kit: default {DEFAULT_H:g} m", "Default"
    floor_m2 = bsf * SQM_PER_SQFT / max(1, stories or 1)
    return dict(height_m=round(h, 1), height_basis=basis, height_label=lab, footprint_m=round(min(MAX_SIDE_M, math.sqrt(floor_m2)), 1),
                footprint_basis="Building area / storeys (CoStar) drawn as a square" + (", capped" if math.sqrt(floor_m2) > MAX_SIDE_M else ""))


def neighbours(lat: float, lon: float, radius_m: float = 800.0, limit: int = 80,
               exclude: str | None = None) -> dict[str, Any]:
    """CoStar properties within `radius_m` of the point, nearest first, with 3D shape and rent / availability."""
    tenancy.ensure()
    dlat = radius_m / 110_540.0
    dlon = radius_m / (111_320.0 * max(0.2, math.cos(math.radians(lat))))
    c = connect()
    try:
        rows = [dict(r) for r in c.execute(
            "SELECT * FROM parcels WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?",
            (lat - dlat, lat + dlat, lon - dlon, lon + dlon))]
        rows = [r for r in rows if r["parcel_id"] != exclude]
        for r in rows:
            r["_d"] = haversine_m(lat, lon, r["lat"], r["lon"])
        rows = sorted((r for r in rows if r["_d"] <= radius_m), key=lambda r: r["_d"])[:limit]
        ids = [r["costar_property_id"] for r in rows]
        marks = ",".join("?" * len(ids)) or "NULL"
        extra = {e["property_id"]: dict(e) for e in c.execute(f"SELECT * FROM property_extra WHERE property_id IN ({marks})", ids)}
        spaces: dict[int, list[dict]] = {}
        for s in c.execute(f"SELECT * FROM listing_spaces WHERE kind = 'lease' AND property_id IN ({marks})", ids):
            spaces.setdefault(s["property_id"], []).append(dict(s))
        current = {r[0]: r[1] for r in c.execute(
            f"SELECT property_id, COUNT(*) FROM occupancies WHERE is_current = 1 AND property_id IN ({marks}) GROUP BY property_id", ids)}
    finally:
        c.close()

    out = []
    for p in rows:
        pid = p["costar_property_id"]
        ex = extra.get(pid) or {}
        rba = ex.get("rba_sf") or p.get("building_sf")
        avail = [s for s in spaces.get(pid, []) if not s["lease_pending"]]
        sf = sum(s["sf_max"] or 0 for s in avail)
        rated = [s for s in avail if s["rate_per_sf_year_low"] and s["sf_max"]]
        w = sum(s["sf_max"] for s in rated)
        rent = round(sum(s["rate_per_sf_year_low"] * s["sf_max"] for s in rated) / w, 2) if w else None
        share = round(min(1.0, sf / rba), 3) if rba and avail else (0.0 if rba and p.get("availability") == "Not listed" else None)
        east, north = _offset(lat, lon, p["lat"], p["lon"])
        out.append(dict(
            parcel_id=p["parcel_id"], costar_property_id=pid, name=p.get("name"), address=p.get("address"), city=p.get("city"),
            property_type=p.get("property_type"), property_subtype=p.get("property_subtype"),
            building_class=p.get("building_class"), year_built=p.get("year_built"), stories=p.get("stories"),
            building_sf=p.get("building_sf"), rba_sf=ex.get("rba_sf"), lot_acres=p.get("lot_acres"),
            availability=p.get("availability"),
            rent_per_sf_year=rent,
            rent_basis=(f"Area-weighted low asking rate on {len(rated)} of {len(avail)} available lease spaces, $/sf/year. Asking, not achieved."
                        if rent else "No asking rent recorded on an available lease space."),
            available_sf=round(sf) if sf else 0, available_share=share,
            available_basis=("Marketed lease space / rentable building area. Available is not vacant (CoStar kit rule)."
                             if share is not None else "Unknown: no building area or listing record."),
            current_tenancies=current.get(pid, 0),
            distance_m=round(p["_d"]), east_m=east, north_m=north, **_shape(p, rba),
            source_row=p["source_row"], listing_rows=sorted({s["source_row"] for s in spaces.get(pid, [])})[:12]))
    rents = [x["rent_per_sf_year"] for x in out if x["rent_per_sf_year"] is not None]
    shares = [x["available_share"] for x in out if x["available_share"] is not None]
    return dict(
        center=dict(lat=lat, lon=lon), radius_m=radius_m, count=len(out), properties=out,
        ranges=dict(rent=[min(rents), max(rents)] if rents else None, available_share=[min(shares), max(shares)] if shares else None),
        counts=dict(with_rent=len(rents), with_availability=len(shares)),
        method=dict(position="metres east / north of the site centre from CoStar coordinates (local equirectangular)",
                    height=f"CoStar storeys x {STOREY_M:g} m (team assumption), else a labelled {DEFAULT_H:g} m default",
                    rent="area-weighted low asking rate of available lease spaces, $/sf/year (asking, not achieved)",
                    availability="marketed lease sf / rentable building area; available is not vacant"),
        note=("The CoStar kit is a sample (CoStar's Matterport capture list), so these are the kit properties near the site, "
              "not every building."),
        source=SOURCE, label="Sourced (CoStar) / Estimated (heights, footprints)")


def for_parcel(parcel_id: str, radius_m: float = 800.0, limit: int = 80) -> dict[str, Any] | None:
    c = connect()
    try:
        r = c.execute("SELECT lat, lon FROM parcels WHERE parcel_id = ?", (parcel_id,)).fetchone()
    finally:
        c.close()
    if not r or r["lat"] is None:
        return None
    return neighbours(r["lat"], r["lon"], radius_m, limit, exclude=parcel_id) | {"subject": parcel_id}

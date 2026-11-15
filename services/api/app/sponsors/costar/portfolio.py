"""Portfolio screening: every CoStar candidate parcel in every market the kit covers, through GeoStar's hard gates.

Uses the same engines as the single-site screen (app/engine/screening.py hard gates, app/engine/siting.py pillars), so a
row here and the Studio's site screen always agree. Hard gates are pass/fail and never blended: a site that fails one
ranks below every site that does not, whatever its score. Pillar scores (people, planet, money) rank within the market
(money's affordability is a rank of $/acre inside one market's shortlist).

Public data (FEMA, WRI, OpenStreetMap) comes from GeoStar's evidence cache by default (`online=False`): a value not yet
cached shows as Needs review with the reason, rather than blocking the page on hundreds of network calls.

Cost: a full screen is a few million distance checks (every parcel against every home and sensitive place), a few
seconds of CPU. So it runs once for the whole pool and is cached for an hour; a minimum-lot filter is applied to the
cached rows, and concurrent requests wait for the one computation instead of each starting their own.
"""
from __future__ import annotations

import threading
import time
from typing import Any

from app.engine.screening import Thresholds
from app.engine.siting import METHOD, assemble, candidate_pool
from app.sponsors.costar.loader import MARKETS

HARD = ("Residential proximity", "Sensitive places", "Land in use", "Flood exposure", "Water stress")
STATUS_ORDER = {"Pass": 0, "Needs review": 1, "Fail": 2}
TTL_S = 3600
_cache: dict[tuple, tuple[float, dict[str, Any]]] = {}
_sites: dict[str, dict[str, Any]] = {}  # parcel id -> the assembled Site record of the latest screen (the Studio's site shape)
_lock = threading.Lock()
_compute = threading.Lock()  # single flight: one screen at a time, the rest wait and read the cache


def _reasons(site: dict[str, Any]) -> list[dict[str, str]]:
    """Why the row has its status: every gate that is not a pass, in order of severity, then the passes in brief."""
    gates = site["screen"]["gates"]
    bad = sorted((g for g in gates if g["status"] != "Pass"), key=lambda g: (g["status"] != "Fail", g["gate"] not in HARD))
    out = [dict(gate=g["gate"], status=g["status"], reason=g["reason"], hard=g["gate"] in HARD) for g in bad]
    passed = [g["gate"] for g in gates if g["status"] == "Pass"]
    if passed:
        out.append(dict(gate="Passed", status="Pass", reason="Passes " + ", ".join(passed) + ".", hard=False))
    return out


def _row(s: dict[str, Any], market: str) -> dict[str, Any]:
    gates = {g["gate"]: g for g in s["screen"]["gates"]}
    sub = (s["screen"].get("power") or {}).get("nearest_substation") or {}
    return dict(
        parcel_id=s["id"], costar_property_id=s.get("costarPropertyId"), name=s["name"], area=s["area"], market=market,
        lat=s["lat"], lon=s["lng"], property_type=s.get("propertyType"), property_subtype=s.get("propertySubtype"),
        lot_acres=s.get("lotAcres"), building_sf=s.get("buildingSf"), supportable_mw=s.get("supportableMw"),
        availability=s.get("availability"), land_cost=s.get("landCost") or None, land_cost_label=s["labels"]["landCost"],
        land_cost_basis=s.get("landCostBasis"), status=s["screen"]["status"],
        hard_fails=[g for g in HARD if gates.get(g, {}).get("status") == "Fail"],
        gates={k: dict(status=g["status"], value=g["value"], unit=g["unit"]) for k, g in gates.items()},
        substation_km=sub.get("distance_km"), pillars=s["pillars"], reasons=_reasons(s),
        evidence_gaps=s["screen"].get("evidence_gaps") or [], provenance=s["provenance"])


def screen_portfolio(min_acres: float = 0.0, online: bool = False, refresh: bool = False,
                     t: Thresholds | None = None) -> dict[str, Any]:
    t = t or Thresholds()
    full = _screen_all(online, refresh, t)
    if min_acres <= 0:
        return full
    rows = [dict(r) for r in full["rows"] if (r["lot_acres"] or 0) >= min_acres]
    for i, r in enumerate(rows, start=1):
        r["rank"] = i
    return full | dict(rows=rows, count=len(rows), counts={k: sum(r["status"] == k for r in rows) for k in STATUS_ORDER},
                       min_acres=min_acres)


def _screen_all(online: bool, refresh: bool, t: Thresholds) -> dict[str, Any]:
    key = (online, tuple(sorted(t.__dict__.items())))

    def cached() -> dict[str, Any] | None:
        with _lock:
            hit = _cache.get(key)
        return hit[1] | {"cached": True} if hit and time.time() - hit[0] < TTL_S else None

    if not refresh and (hit := cached()):
        return hit
    with _compute:
        if not refresh and (hit := cached()):  # another request finished the same screen while this one waited
            return hit
        return _compute_all(key, online, t)


def _compute_all(key: tuple, online: bool, t: Thresholds) -> dict[str, Any]:
    t0 = time.time()
    rows: list[dict[str, Any]] = []
    per_market = {}
    for market in MARKETS.values():
        parcels = candidate_pool(market, 0)
        sites = assemble(market, parcels, t, offline=not online)
        mrows = [_row(s, market) for s in sites]
        with _lock:
            _sites.update({s["id"]: s for s in sites})
        for i, r in enumerate(sorted(mrows, key=lambda r: (STATUS_ORDER[r["status"]], -r["pillars"]["overall"])), start=1):
            r["market_rank"] = i
        rows += mrows
        per_market[market] = {k: sum(r["status"] == k for r in mrows) for k in STATUS_ORDER} | {"parcels": len(mrows)}
    rows.sort(key=lambda r: (STATUS_ORDER[r["status"]], -r["pillars"]["overall"]))
    for i, r in enumerate(rows, start=1):
        r["rank"] = i
    out = dict(
        count=len(rows), rows=rows, markets=per_market,
        counts={k: sum(r["status"] == k for r in rows) for k in STATUS_ORDER},
        thresholds=t.__dict__, method=METHOD | {
            "ranking": "hard-gate status first (Pass, Needs review, Fail), then overall = mean(people, planet, money); "
                       "money's affordability is ranked within each market"},
        public_data="live (FEMA, WRI, OpenStreetMap) with cache" if online else "GeoStar evidence cache (FEMA, WRI, OpenStreetMap)",
        sources=["CoStar Data Extract (data/commercial-property.jsonl, listings, sale comps)", "FEMA NFHL", "WRI Aqueduct 4.0",
                 "OpenStreetMap (substations, schools, worship, hospitals)"],
        seconds=round(time.time() - t0, 2), cached=False)
    with _lock:
        _cache[key] = (time.time(), out)
    return out


def site(parcel_id: str) -> dict[str, Any] | None:
    """The Studio's Site record for a parcel, exactly as the latest portfolio screen assembled it (same gates and pillars
    as its ranked row). Screens the portfolio first if it has not run in this process."""
    with _lock:
        hit = _sites.get(parcel_id)
    if hit is None:
        screen_portfolio()
        with _lock:
            hit = _sites.get(parcel_id)
    return hit

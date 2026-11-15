"""CoStar in the Explore 3D view and across the portfolio.

GET /costar/neighbours/{parcel_id}   CoStar kit properties around a CoStar site, for 3D blocks (rent / availability)
GET /costar/neighbours?lat=&lon=     the same around any point (a dropped pin)
GET /costar/portfolio                every CoStar candidate parcel in Houston and Los Angeles through the hard gates
GET /costar/portfolio/site/{id}      one ranked parcel as the Studio's Site record (to pick it as the project site)
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query

from app.db import db_ready
from app.engine.screening import Thresholds
from app.sponsors.costar import neighbours as nb
from app.sponsors.costar import portfolio as pf
from app.sponsors.costar import tenancy

router = APIRouter(tags=["costar"])


def _ready() -> None:
    if not db_ready():
        raise HTTPException(503, "CoStar parcel store is empty. Run: python -m app.sponsors.costar.loader")


@router.get("/costar/neighbours/{parcel_id}")
def neighbours_of(parcel_id: str, radius_m: float = Query(800, ge=100, le=3000), limit: int = Query(80, ge=1, le=200)) -> dict[str, Any]:
    _ready()
    try:
        out = nb.for_parcel(parcel_id, radius_m, limit)
    except tenancy.StoreUnavailable as e:
        raise HTTPException(503, f"CoStar loader: {e}") from e
    if out is None:
        raise HTTPException(404, f"Unknown parcel {parcel_id}")
    return out


@router.get("/costar/neighbours")
def neighbours_at(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
                  radius_m: float = Query(800, ge=100, le=3000), limit: int = Query(80, ge=1, le=200)) -> dict[str, Any]:
    _ready()
    try:
        return nb.neighbours(lat, lon, radius_m, limit)
    except tenancy.StoreUnavailable as e:
        raise HTTPException(503, f"CoStar loader: {e}") from e


@router.get("/costar/portfolio")
def portfolio(min_acres: float = Query(0, ge=0, le=2000), online: bool = False, refresh: bool = False,
              market: Literal["Houston", "Los Angeles"] | None = None,
              min_home_distance_m: float = Query(300, ge=0, le=5000), min_sensitive_distance_m: float = Query(200, ge=0, le=5000),
              max_water_stress_cat: int = Query(2, ge=0, le=4)) -> dict[str, Any]:
    _ready()
    t = Thresholds(min_home_distance_m=min_home_distance_m, min_sensitive_distance_m=min_sensitive_distance_m,
                   max_water_stress_cat=max_water_stress_cat)
    out = pf.screen_portfolio(min_acres, online, refresh, t)
    if market:
        rows = [r for r in out["rows"] if r["market"] == market]
        out = out | {"rows": rows, "count": len(rows), "counts": {k: sum(r["status"] == k for r in rows) for k in pf.STATUS_ORDER}}
    return out


@router.get("/costar/portfolio/site/{parcel_id}")
def portfolio_site(parcel_id: str) -> dict[str, Any]:
    _ready()
    s = pf.site(parcel_id)
    if s is None:
        raise HTTPException(404, f"{parcel_id} is not a CoStar candidate parcel")
    return s

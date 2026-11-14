"""MongoDB Atlas endpoints: status, setup/seed (admin), Atlas Search, Vector Search, geo, analytics, audit, live stream."""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from sse_starlette.sse import EventSourceResponse

from .. import atlas

router = APIRouter(prefix="/atlas", tags=["atlas"])


def _need(v: Any) -> Any:
    if v is None:
        raise HTTPException(503, atlas.store._state["reason"] or "MongoDB Atlas is not reachable.")
    return v


@router.get("/status")
def status() -> dict[str, Any]:
    return atlas.status()


@router.post("/setup")
def setup() -> dict[str, Any]:
    """Create/upgrade collections, validators, indexes and search indexes. Idempotent."""
    return _need(atlas.setup())


@router.post("/seed")
def seed(sites: bool = True, grid: bool = True, evidence: bool = True, projects: bool = True) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if sites:
        out["sites"] = _need(atlas.seed_sites())
    if grid:
        out["grid_days"] = _need(atlas.seed_grid_days())
    if evidence:
        out["evidence"] = _need(atlas.seed_evidence())
    if projects:
        out["projects_embedded"] = _need(atlas.embed_projects())
    return out


@router.get("/search")
def search(q: str = Query("", max_length=200), market: str | None = None, status_: str | None = Query(None, alias="status"),
           limit: int = Query(10, ge=1, le=50)) -> dict[str, Any]:
    try:
        return _need(atlas.search_sites(q, market, status_, limit))
    except Exception as e:  # the search index may still be building
        raise HTTPException(503, f"Atlas Search not ready: {type(e).__name__}: {str(e)[:160]}") from e


@router.get("/similar")
def similar(q: str = Query(..., min_length=2, max_length=300), market: str | None = None, limit: int = Query(5, ge=1, le=20),
            passing_only: bool = False) -> dict[str, Any]:
    try:
        return _need(atlas.similar_sites(q, market, limit, passing_only))
    except Exception as e:
        raise HTTPException(503, f"Vector Search not ready: {type(e).__name__}: {str(e)[:160]}") from e


@router.get("/projects/{project_id}/similar")
def project_similar(project_id: str, limit: int = Query(4, ge=1, le=10)) -> dict[str, Any]:
    try:
        return _need(atlas.similar_projects(project_id, limit))
    except Exception as e:
        raise HTTPException(503, f"Vector Search not ready: {type(e).__name__}: {str(e)[:160]}") from e


@router.get("/near")
def near(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180), km: float = Query(10, gt=0, le=500),
         limit: int = Query(10, ge=1, le=50), status_: str | None = Query(None, alias="status")) -> dict[str, Any]:
    return {"sites": _need(atlas.near_sites(lat, lon, km, limit, status_))}


@router.get("/analytics")
def analytics() -> dict[str, Any]:
    return _need(atlas.analytics())


@router.get("/decisions")
def decisions(limit: int = Query(20, ge=1, le=200)) -> dict[str, Any]:
    return {"decisions": _need(atlas.recent_decisions(limit))}


@router.get("/stream")
async def stream(request: Request) -> EventSourceResponse:
    """Live change-stream feed (SSE): inserts/updates/deletes on projects, decisions and sites as they happen."""
    import asyncio

    async def gen():
        loop = asyncio.get_running_loop()
        it = atlas.events()
        while True:
            if await request.is_disconnected():
                break
            ev = await loop.run_in_executor(None, next, it, None)
            if ev is None:
                break
            yield {"event": ev["type"], "data": json.dumps(ev, default=str)}
    return EventSourceResponse(gen())

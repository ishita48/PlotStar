"""CoStar intelligence tools over HTTP, the tool-call audit timeline, the deal room and Deal-to-Design.

GET  /intel/tools                 the tool catalogue (same tools as the MCP server)
POST /intel/tools/{tool}          call a tool: JSON body = its arguments; returns the standard envelope
GET  /mcp/audit                   recent tool calls from every surface (MCP, copilot, API, deal agent)
GET  /deal-room                   saved comp selections, scenarios and analyses (?parcel_id=&project_id=)
POST /deal-room                   save a comp selection or scenario (body: {kind, parcel_id, project_id, payload, confirm})
POST /deal/run                    Deal-to-Design: criteria → ranked, sourced shortlist + memo + timeline
"""
from __future__ import annotations

import inspect
from typing import Any, Literal

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel, Field

from .. import deal_agent, deal_room
from ..costar import tools as T

router = APIRouter(tags=["intel"])


@router.get("/intel/tools")
def catalogue() -> dict[str, Any]:
    out = []
    for name, fn in T.TOOLS.items():
        sig = inspect.signature(fn)
        out.append({"name": name, "read_only": name in T.READ_ONLY, "doc": (fn.__doc__ or "").strip().split("\n")[0],
                    "params": {p: (None if v.default is inspect._empty else v.default) for p, v in sig.parameters.items()
                               if v.kind not in (v.VAR_KEYWORD, v.VAR_POSITIONAL)}})
    return {"tools": out, "mcp": {"server": "plotstar-costar", "stdio": "python services/api/run_mcp.py",
                                  "http": "python -m app.mcp_server --http --port 8020 (bearer PLOTSTAR_MCP_TOKEN)"}}


@router.post("/intel/tools/{tool}")
def call(tool: str, args: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:
    if tool not in T.TOOLS:
        raise HTTPException(404, f"Unknown tool {tool}")
    if len(str(args)) > 8000:
        raise HTTPException(413, "Arguments too large")
    return T.run(tool, via="api", **args)


@router.get("/mcp/audit")
def audit(limit: int = 100, tool: str | None = None) -> dict[str, Any]:
    return deal_room.audit_log(max(1, min(500, limit)), tool)


@router.get("/deal-room")
def deal_room_get(parcel_id: str | None = None, project_id: str | None = None) -> dict[str, Any]:
    return {**deal_room.deal(project_id, parcel_id), "store": deal_room.status()}


class SaveIn(BaseModel):
    kind: Literal["comp_selection", "scenario"]
    parcel_id: str | None = Field(None, max_length=60)
    project_id: str | None = Field(None, max_length=60)
    payload: dict[str, Any] = Field(default_factory=dict)
    confirm: bool = False


@router.post("/deal-room")
def deal_room_save(q: SaveIn) -> dict[str, Any]:
    r = T.run("save_to_deal_room", via="api", kind=q.kind, parcel_id=q.parcel_id, project_id=q.project_id, payload=q.payload,
              confirm=q.confirm)
    if not r["ok"]:
        raise HTTPException(422, r["error"])
    return r


class DealIn(BaseModel):
    market: Literal["Houston", "Los Angeles"] = "Houston"
    mw_it: float = Field(20, gt=0.5, le=500)
    rack_kw: float = Field(20, ge=3, le=200)
    budget: float | None = Field(None, gt=0, le=1e10)
    min_acres: float | None = Field(None, ge=0, le=10000)
    property_types: list[str] = Field(default_factory=list, max_length=6)
    heavy_power: bool | None = None
    available_only: bool = False
    dc_candidates_only: bool = True
    candidates: int = Field(5, ge=1, le=8)
    max_comp_age_years: float | None = Field(None, ge=1, le=25)


@router.post("/deal/run")
def deal_run(q: DealIn) -> dict[str, Any]:
    return deal_agent.run(q.model_dump())

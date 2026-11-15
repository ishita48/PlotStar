"""Gemini endpoints: vision on Vexcel aerials and drone frames, zoning documents, concept renders.

GET    /gemini/status               key set, and which vision / image models this key can call (from the models list)
POST   /gemini/obstacles            {site_id, site_w, site_d, refresh?} -> obstacles in the site frame (Gemini on Vexcel ortho)
POST   /gemini/frame                multipart `file` (a drone frame) -> description + hazards with boxes
POST   /gemini/docs                 multipart `file` (PDF) -> overview; the PDF stays in API memory only
POST   /gemini/docs/{doc_id}/ask    {question} -> answer with page citations
DELETE /gemini/docs/{doc_id}        forget the PDF
POST   /gemini/render               {concept, brief, view?, setting?} -> AI street-view image (labelled, not a photo)

Gemini errors come back as HTTP 502 with a readable `detail`; nothing is substituted for a failed call.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.sponsors.gemini import client as G
from app.sponsors.gemini import documents, render, vision

router = APIRouter(prefix="/gemini", tags=["gemini"])


def _need_key() -> None:
    if not G.available():
        raise HTTPException(503, "GEMINI_API_KEY is not configured")


@router.get("/status")
def status() -> dict[str, Any]:
    names = {m["name"] for m in G.models() if "generateContent" in m["methods"]}
    return {"configured": G.available(), "vision_model": G.VISION_MODEL, "vision_available": G.VISION_MODEL in names,
            "image_model": G.IMAGE_MODEL, "image_listed": G.IMAGE_MODEL in names,
            "image_available": G.IMAGE_MODEL in names and render.blocked() is None,
            "image_blocked": (render.blocked() or {}).get("reason"), "agent_model": G.AGENT_MODEL,
            "image_models": sorted(n for n in names if "image" in n or "banana" in n)}


class ObstacleReq(BaseModel):
    site_id: str = Field(..., description="Parcel id or pt:<lat>,<lon> (the Studio's aerial id)")
    site_w: float = Field(..., gt=20, le=1200)
    site_d: float = Field(..., gt=20, le=1200)
    refresh: bool = False


@router.post("/obstacles")
def obstacles(req: ObstacleReq) -> dict[str, Any]:
    _need_key()
    try:
        return vision.find_obstacles(req.site_id, req.site_w, req.site_d, refresh=req.refresh)
    except G.GeminiError as e:
        raise HTTPException(502, str(e)) from e


@router.post("/frame")
async def frame(file: UploadFile = File(...)) -> dict[str, Any]:
    _need_key()
    data = await file.read()
    if not data or len(data) > 12 * 1024 * 1024:
        raise HTTPException(422, "Send one image under 12 MB")
    try:
        return vision.describe_frame(data)
    except G.GeminiError as e:
        raise HTTPException(502, str(e)) from e


@router.post("/docs")
async def upload_doc(file: UploadFile = File(...)) -> dict[str, Any]:
    _need_key()
    data = await file.read()
    try:
        return documents.add(file.filename or "document.pdf", data)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    except G.GeminiError as e:
        raise HTTPException(502, str(e)) from e


class AskReq(BaseModel):
    question: str = Field(..., min_length=2, max_length=600)


@router.post("/docs/{doc_id}/ask")
def ask_doc(doc_id: str, req: AskReq) -> dict[str, Any]:
    _need_key()
    try:
        return documents.ask(doc_id, req.question)
    except KeyError as e:
        raise HTTPException(404, str(e.args[0])) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    except G.GeminiError as e:
        raise HTTPException(502, str(e)) from e


@router.delete("/docs/{doc_id}")
def delete_doc(doc_id: str) -> dict[str, Any]:
    return {"deleted": documents.remove(doc_id)}


class RenderReq(BaseModel):
    concept: dict[str, Any]
    brief: dict[str, Any] = Field(default_factory=dict)
    view: str = "south"
    setting: str = Field("", max_length=40, description="A market or region word, e.g. Houston; never an address")


@router.post("/render")
def render_concept(req: RenderReq) -> dict[str, Any]:
    _need_key()
    if not (req.concept.get("building") or {}).get("w"):
        raise HTTPException(422, "concept.building is required")
    try:
        return render.render(req.concept, req.brief, req.view, req.setting)
    except G.GeminiError as e:
        raise HTTPException(502, str(e)) from e

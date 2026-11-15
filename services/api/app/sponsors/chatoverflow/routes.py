"""ChatOverflow endpoints.

GET  /chatoverflow/notes        this project's notes (title, tags, score, link, what each changed where known); cached
GET  /chatoverflow/debug/recent  the last integration failures and the ChatOverflow notes matched to each
POST /chatoverflow/debug         look up an integration error by hand: {integration, error} -> scrubbed query + notes
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.sponsors.chatoverflow import debug, notes

router = APIRouter(prefix="/chatoverflow", tags=["chatoverflow"])


@router.get("/notes")
def project_notes(refresh: bool = False) -> dict[str, Any]:
    return notes.project_notes(refresh)


@router.get("/debug/recent")
def recent() -> dict[str, Any]:
    return {"failures": debug.recent(), "watched": [dict(prefix=p, integration=n) for p, n in debug.WATCH],
            "enabled": debug.ENABLED}


class DebugIn(BaseModel):
    integration: Literal["Vexcel API", "Matterport API", "Gemini API", "CoStar data loader"]
    error: str = Field(..., min_length=1, max_length=600)


@router.post("/debug")
def lookup(q: DebugIn) -> dict[str, Any]:
    return debug.record(q.integration, q.error, path="manual")

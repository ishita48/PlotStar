"""HAVEN dispatch endpoints: a real phone call to the facility's emergency contact.

Two voice providers, same endpoints and response shapes:
- Cartesia (preferred when CARTESIA_API_KEY is set): a free Cartesia US number, no carrier account needed.
- ElevenLabs Agents: needs a Twilio or SIP number connected to ElevenLabs.

GET  /haven/dispatch/status          can a live call be placed now (and what is missing if not)
POST /haven/dispatch/call            ring the emergency contact with the incident details
GET  /haven/dispatch/call/{call_id}  call status and transcript
"""
from __future__ import annotations

import re
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.sponsors.cartesia import dispatch as cartesia
from app.sponsors.elevenlabs import dispatch as eleven
from app.sponsors.elevenlabs.guide import GuideError

router = APIRouter(tags=["haven-dispatch"])
ERRORS = (GuideError, cartesia.CartesiaError)


class IncidentIn(BaseModel):
    incident_id: str = Field("", max_length=40)
    incident: str = Field(..., min_length=1, max_length=120)
    zone: str = Field("", max_length=120)
    severity: Literal["warning", "critical", "unknown"] = "unknown"
    detail: str = Field("", max_length=400)
    actions: str = Field("", max_length=400)
    facility: str = Field("", max_length=120)
    city: str = Field("", max_length=80)


def _provider() -> Any:
    cartesia._refresh_env()
    return cartesia if cartesia.key() else eleven


@router.get("/haven/dispatch/status")
def status() -> dict[str, Any]:
    return _provider().status()


@router.post("/haven/dispatch/call")
def call(body: IncidentIn) -> dict[str, Any]:
    try:
        return _provider().place_call(body.model_dump())
    except ERRORS as e:
        raise HTTPException(503, str(e)) from e


@router.get("/haven/dispatch/call/{call_id}")
def call_status(call_id: str) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,80}", call_id):
        raise HTTPException(404, "Unknown call id")
    # Cartesia call ids start with "ac_"; anything else is an ElevenLabs conversation.
    try:
        return cartesia.conversation(call_id) if call_id.startswith("ac_") else eleven.conversation(call_id)
    except ERRORS as e:
        raise HTTPException(503, str(e)) from e

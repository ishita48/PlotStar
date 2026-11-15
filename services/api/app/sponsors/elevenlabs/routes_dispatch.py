"""HAVEN dispatch endpoints: a real phone call to the facility's emergency contact.

Two voice providers, same endpoints and response shapes:
- Cartesia (preferred when CARTESIA_API_KEY is set): a free Cartesia US number, no carrier account needed.
- ElevenLabs Agents: needs a Twilio or SIP number connected to ElevenLabs.

GET  /haven/dispatch/status          can a live call be placed now (and what is missing if not)
POST /haven/dispatch/call            ring the emergency contact with the incident details
GET  /haven/dispatch/call/{call_id}  call status and transcript
"""
from __future__ import annotations

import hmac
import os
import re
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Request
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


LOCAL = re.compile(r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$")


def _dispatch_token() -> str:
    from dotenv import dotenv_values
    from app import config
    return (os.getenv("DISPATCH_TOKEN") or dotenv_values(config.REPO_ROOT / ".env").get("DISPATCH_TOKEN") or "").strip()


def _local_only(request: Request) -> None:
    """Real phone calls: from the operator's own machine, or from the GeoStar site's server, which proves itself
    with the shared DISPATCH_TOKEN (and only calls when the facility has an active fire or leak incident).
    A browser or anyone else reaching this API through the public tunnel is refused."""
    want = _dispatch_token()
    given = request.headers.get("x-dispatch-token") or ""
    if want and given and hmac.compare_digest(given.encode(), want.encode()):
        return
    origin = request.headers.get("origin") or ""
    tunnelled = any(h in request.headers for h in ("cf-connecting-ip", "cf-ray", "x-forwarded-for"))
    if tunnelled or (origin and not LOCAL.match(origin)):
        raise HTTPException(403, "Live emergency calls can only be placed from the GeoStar app on this computer.")


@router.post("/haven/dispatch/call")
def call(body: IncidentIn, request: Request) -> dict[str, Any]:
    _local_only(request)
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

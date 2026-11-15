"""HAVEN dispatch over Cartesia: a real phone call to the facility's emergency contact, from a free Cartesia number.

Cartesia gives every account a free US number that can call any US destination, with no Twilio account or caller
verification. A managed Cartesia agent ("Geo Emergency Call") speaks the alert with the same prompt as the
ElevenLabs path (app.sponsors.elevenlabs.dispatch), filled per call through dynamic variables.

Needs CARTESIA_API_KEY and HAVEN_EMERGENCY_CONTACT in .env. CARTESIA_PHONE_NUMBER_ID picks the number to call from;
otherwise the first number on the account is used. The agent is created on first use and kept in sync by config hash.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from typing import Any

import httpx

from app import config
from app.sponsors.elevenlabs.dispatch import FIRST_MESSAGE, PLACEHOLDERS, PROMPT, VOICEMAIL, contact, masked

API = "https://api.cartesia.ai"
VERSION = "2026-08-14"
STATE_FILE = config.CACHE_DIR / "cartesia_dispatch_agent.json"
MODEL = os.getenv("CARTESIA_DISPATCH_MODEL", "claude-haiku-4.5")
VOICE_ID = os.getenv("CARTESIA_DISPATCH_VOICE", "692846ad-1a6b-49b8-bfc5-86421fd41a19")
COOLDOWN_S = 60
_lock = threading.Lock()
_last_call = 0.0


class CartesiaError(RuntimeError):
    pass


def _refresh_env() -> None:
    from dotenv import dotenv_values
    vals = dotenv_values(config.REPO_ROOT / ".env")
    for k in ("CARTESIA_API_KEY", "CARTESIA_PHONE_NUMBER_ID", "HAVEN_EMERGENCY_CONTACT"):
        if vals.get(k) is not None:
            os.environ[k] = vals[k] or ""


def key() -> str:
    return os.getenv("CARTESIA_API_KEY", "").strip()


def _call(method: str, path: str, **kw: Any) -> Any:
    try:
        r = httpx.request(method, f"{API}{path}", timeout=30, **kw,
                          headers={"X-API-Key": key(), "Cartesia-Version": VERSION})
    except httpx.HTTPError as e:
        raise CartesiaError(f"Cartesia unreachable ({type(e).__name__})") from e
    if r.status_code >= 400:
        try:
            d = r.json()
            detail = d.get("message") or d.get("error") or d.get("detail") or ""
        except ValueError:
            detail = r.text[:200]
        raise CartesiaError(f"Cartesia returned HTTP {r.status_code}{': ' + str(detail)[:300] if detail else ''}")
    return r.json() if r.content else {}


# Cartesia variables must start with a letter or underscore; ours do.
def agent_config() -> dict[str, Any]:
    return {
        "name": "Geo Emergency Call",
        "description": "Calls the facility's emergency contact with a HAVEN incident alert. Never calls 911.",
        "config": {
            "instructions": PROMPT,
            "initial_message": FIRST_MESSAGE,
            "model": {"id": MODEL, "temperature": 0.2},
            "language": {"primary": "en"},
            "audio": {"output": {"voice_id": VOICE_ID}},
            # "off": no filler speech before a tool runs, which is what made the agent narrate
            # ("let me leave a message") on voicemail. Voicemail gets a fixed message, then hangs up.
            "system_tools": {
                "end_call": {"pre_tool_speech": "off"},
                "voicemail_detection": {"pre_tool_speech": "off", "message": VOICEMAIL},
            },
            "dynamic_variable_placeholders": PLACEHOLDERS,
        },
    }


def _hash(cfg: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest()[:16]


def ensure_agent() -> str:
    cfg = agent_config()
    h = _hash(cfg)
    with _lock:
        try:
            st = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            st = {}
        agent_id = os.getenv("CARTESIA_DISPATCH_AGENT_ID") or st.get("agent_id")
        if agent_id and st.get("hash") == h and st.get("agent_id") == agent_id:
            return agent_id
        if agent_id:
            try:
                _call("PATCH", f"/v1/agents/{agent_id}", json=cfg)
            except CartesiaError as e:
                if "404" not in str(e):
                    raise
                agent_id = None
        if not agent_id:
            agent_id = _call("POST", "/v1/agents", json=cfg)["id"]
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps({"agent_id": agent_id, "hash": h}), encoding="utf-8")
        return agent_id


def _phone_number() -> dict[str, Any] | None:
    d = _call("GET", "/agents/phone-numbers")
    numbers = d.get("data", []) if isinstance(d, dict) else d
    want = os.getenv("CARTESIA_PHONE_NUMBER_ID")
    for n in numbers:
        if not want or n.get("id") == want:
            return n
    return None


def status() -> dict[str, Any]:
    _refresh_env()
    out: dict[str, Any] = {"live": False, "contact": masked(contact()), "provider": "Cartesia"}
    if not key():
        return out | {"reason": "CARTESIA_API_KEY is not set"}
    if not contact():
        return out | {"reason": "HAVEN_EMERGENCY_CONTACT is not set (E.164, e.g. +15551234567)"}
    try:
        num = _phone_number()
    except CartesiaError as e:
        return out | {"reason": str(e)}
    if not num:
        return out | {"reason": "The Cartesia account has no phone number (Agents > Phone numbers > Get a number)"}
    return out | {"live": True, "from": masked(num.get("number")), "telephony": "cartesia"}


def place_call(incident: dict[str, Any]) -> dict[str, Any]:
    global _last_call
    _refresh_env()
    to = contact()
    if not key() or not to:
        raise CartesiaError(status().get("reason") or "Live calling is not configured")
    if not to.startswith("+1"):
        raise CartesiaError("Cartesia numbers can only call US numbers")
    wait = COOLDOWN_S - (time.time() - _last_call)
    if wait > 0:
        raise CartesiaError(f"A call was placed a moment ago. Try again in {int(wait) + 1} s.")
    num = _phone_number()
    if not num:
        raise CartesiaError("The Cartesia account has no phone number")
    agent_id = ensure_agent()
    incident = dict(incident)
    # Facility names are CoStar addresses: they stay out of third-party LLMs unless COPILOT_LLM_COSTAR=1.
    if os.getenv("COPILOT_LLM_COSTAR") != "1":
        incident["facility"] = ""
    variables = {k: str(incident.get(k) or v)[:400] for k, v in PLACEHOLDERS.items()}
    d = _call("POST", "/agents/calls", json={
        "from_number_id": num["id"],
        "agent_id": agent_id,
        "ringing_timeout_seconds": 45,
        "max_call_duration_minutes": 3,
        "outbound_calls": [{"to_number": to, "dynamic_variables": variables}],
    })
    first = (d.get("calls") or [{}])[0]
    if not first.get("agent_call_id"):
        err = first.get("error") or {}
        raise CartesiaError((err.get("message") if isinstance(err, dict) else str(err)) or "Cartesia did not place the call")
    _last_call = time.time()
    return {"conversation_id": first["agent_call_id"], "to": masked(to), "message": "Calling",
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


# Cartesia call status -> the status words the UI already understands (ElevenLabs' vocabulary).
_STATUS = {"created": "initiated", "started": "in-progress", "completed": "done", "failed": "failed"}


def conversation(call_id: str) -> dict[str, Any]:
    d = _call("GET", f"/agents/calls/{call_id}")
    turns = [{"speaker": "Geo" if t.get("role") == "assistant" else "Contact", "text": t.get("text") or ""}
             for t in d.get("transcript") or [] if t.get("role") in ("assistant", "user") and t.get("text")
             and not t.get("ignored")]
    return {"status": _STATUS.get(d.get("status"), d.get("status")), "transcript": turns,
            "end_reason": d.get("end_reason"), "error": d.get("error_message")}

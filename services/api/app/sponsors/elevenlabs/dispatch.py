"""HAVEN dispatch: a real outbound phone call, placed by an ElevenLabs voice agent, to the facility's emergency contact.

When the Command Center has a fire or leak incident, the operator can ring the designated emergency contact. An
ElevenLabs Agents voice ("HAVEN") calls that number, reads out the incident and answers questions about it, using only
the details sent with the call. It never dials 911 or any short emergency code: the contact number comes from
HAVEN_EMERGENCY_CONTACT in .env (E.164, e.g. +15551234567) and is never committed.

Needs, besides ELEVENLABS_API_KEY:
- a phone number connected to ElevenLabs (Twilio or SIP trunk). ELEVENLABS_PHONE_NUMBER_ID picks one; otherwise the
  first number on the account is used. With none, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER in
  .env are imported into ElevenLabs automatically on first use.
- HAVEN_EMERGENCY_CONTACT, the number to ring.
Without them, status() says what is missing and the UI keeps the scripted simulation.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from typing import Any

from app import config
from app.sponsors.elevenlabs.guide import GuideError, _call, key

STATE_FILE = config.CACHE_DIR / "eleven_dispatch_agent.json"
_lock = threading.Lock()
_last_call = 0.0
COOLDOWN_S = 60  # one real call a minute, so a double click never rings someone twice

VOICE_ID = os.getenv("HAVEN_DISPATCH_VOICE", "EXAVITQu4vr4xnSDxMaL")  # calm, clear, professional
LLM = os.getenv("HAVEN_DISPATCH_LLM", "claude-haiku-5-5")
TTS_MODEL = os.getenv("HAVEN_DISPATCH_TTS", "eleven_flash_v2")

PLACEHOLDERS = {
    "facility": "the facility",
    "city": "",
    "incident": "a building incident",
    "zone": "the building",
    "severity": "unknown",
    "detail": "",
    "actions": "",
    "incident_id": "",
}

PROMPT = """You are HAVEN, the automated building-safety voice of GeoStar. You are on a phone call with the
designated emergency contact for {{facility}} in {{city}}.

Incident {{incident_id}}: {{incident}} in {{zone}}. Severity: {{severity}}.
What the sensors show: {{detail}}
Recommended actions: {{actions}}

How you speak:
- Calm, clear, short sentences. This is a phone call: no lists, no markdown.
- Use only the incident details above. If asked something you do not know, say you do not have that information.
- Be honest: the readings come from GeoStar's monitoring simulation, and you have not contacted 911, the fire department
  or any responders. If anyone may be in danger, tell the person to call 911 themselves now.
- Ask them to confirm they received the alert. Once they confirm, or if they ask you to stop, thank them and say goodbye."""

FIRST_MESSAGE = ("This is HAVEN, the automated safety alert for {{facility}}. "
                 "We have a {{severity}} {{incident}} in {{zone}}. Can you confirm you received this alert?")


def agent_config() -> dict[str, Any]:
    return {
        "name": "HAVEN Dispatch",
        "conversation_config": {
            "agent": {
                "first_message": FIRST_MESSAGE,
                "language": "en",
                "prompt": {"prompt": PROMPT, "llm": LLM, "temperature": 0.2},
                "dynamic_variables": {"dynamic_variable_placeholders": PLACEHOLDERS},
            },
            "tts": {"voice_id": VOICE_ID, "model_id": TTS_MODEL},
            "conversation": {"max_duration_seconds": 180},
        },
    }


def _hash(cfg: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest()[:16]


def _load() -> dict[str, Any]:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def ensure_agent() -> str:
    """The dispatch agent id, created on first use and updated in place when its config changes."""
    cfg = agent_config()
    h = _hash(cfg)
    with _lock:
        st = _load()
        agent_id = os.getenv("HAVEN_DISPATCH_AGENT_ID") or st.get("agent_id")
        if agent_id and st.get("hash") == h and st.get("agent_id") == agent_id:
            return agent_id
        if agent_id:
            try:
                _call("PATCH", f"/convai/agents/{agent_id}", json=cfg)
            except GuideError as e:
                if "404" not in str(e):
                    raise
                agent_id = None
        if not agent_id:
            agent_id = _call("POST", "/convai/agents/create", json=cfg)["agent_id"]
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps({"agent_id": agent_id, "hash": h}), encoding="utf-8")
        return agent_id


# E.164 only (+ country code, 8-15 digits). Short codes such as 911, 112 or 999 can never match.
E164 = re.compile(r"^\+[1-9]\d{7,14}$")


def contact() -> str | None:
    n = re.sub(r"[\s().-]", "", os.getenv("HAVEN_EMERGENCY_CONTACT", ""))
    return n if E164.match(n) else None


def masked(n: str | None) -> str | None:
    return f"•••• {n[-4:]}" if n else None


def _twilio() -> dict[str, str] | None:
    """Twilio credentials from .env, when all three are present."""
    sid, token = os.getenv("TWILIO_ACCOUNT_SID", "").strip(), os.getenv("TWILIO_AUTH_TOKEN", "").strip()
    number = re.sub(r"[\s().-]", "", os.getenv("TWILIO_PHONE_NUMBER", ""))
    return {"sid": sid, "token": token, "number": number} if sid and token and E164.match(number) else None


def _import_twilio(tw: dict[str, str]) -> dict[str, Any]:
    """Connect the Twilio number to ElevenLabs Agents (once); ElevenLabs then dials out through it."""
    body = {"provider": "twilio", "phone_number": tw["number"], "label": "HAVEN dispatch", "sid": tw["sid"],
            "token": tw["token"]}
    try:
        d = _call("POST", "/convai/phone-numbers", json=body)
    except GuideError as e:
        if "404" not in str(e) and "405" not in str(e):
            raise
        d = _call("POST", "/convai/phone-numbers/create", json=body)  # older path
    return {"phone_number_id": d["phone_number_id"], "phone_number": tw["number"], "provider": "twilio"}


def _phone_number() -> dict[str, Any] | None:
    numbers = _call("GET", "/convai/phone-numbers")
    numbers = numbers if isinstance(numbers, list) else numbers.get("phone_numbers", [])
    want = os.getenv("ELEVENLABS_PHONE_NUMBER_ID")
    for n in numbers:
        if not want or n.get("phone_number_id") == want:
            return n
    tw = _twilio()
    if tw and not want:
        with _lock:
            return _import_twilio(tw)
    return None


_DIAL_KEYS = ("HAVEN_EMERGENCY_CONTACT", "ELEVENLABS_PHONE_NUMBER_ID", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN",
              "TWILIO_PHONE_NUMBER")


def _refresh_env() -> None:
    """Re-read the dialling settings from .env, so pasting Twilio details works without restarting the API."""
    from dotenv import dotenv_values
    vals = dotenv_values(config.REPO_ROOT / ".env")
    for k in _DIAL_KEYS:
        if vals.get(k) is not None:
            os.environ[k] = vals[k] or ""


def status() -> dict[str, Any]:
    """Whether a live call can be placed, and if not, the one thing missing. One cheap read call."""
    _refresh_env()
    out: dict[str, Any] = {"live": False, "contact": masked(contact()), "provider": "ElevenLabs Agents"}
    if not key():
        return out | {"reason": "ELEVENLABS_API_KEY is not set"}
    if not contact():
        return out | {"reason": "HAVEN_EMERGENCY_CONTACT is not set (E.164, e.g. +15551234567)"}
    try:
        num = _phone_number()
    except GuideError as e:
        if "not found in your Twilio account" in str(e):
            tw = _twilio() or {"number": "the number"}
            return out | {"reason": f"Twilio does not own {tw['number']} yet: buy it under Phone Numbers > Buy a number"}
        return out | {"reason": str(e)}
    if not num:
        return out | {"reason": "No phone number is connected yet (add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER to .env)"}
    return out | {"live": True, "from": masked(num.get("phone_number")), "telephony": num.get("provider")}


def place_call(incident: dict[str, Any]) -> dict[str, Any]:
    """Ring the emergency contact with the incident details. Raises GuideError with a plain reason when it cannot."""
    global _last_call
    _refresh_env()
    to = contact()
    if not key() or not to:
        raise GuideError(status().get("reason") or "Live calling is not configured")
    wait = COOLDOWN_S - (time.time() - _last_call)
    if wait > 0:
        raise GuideError(f"A call was placed a moment ago. Try again in {int(wait) + 1} s.")
    num = _phone_number()
    if not num:
        raise GuideError("No phone number is connected to ElevenLabs yet")
    agent_id = ensure_agent()
    incident = dict(incident)
    # Deployed facilities are named after CoStar properties (street addresses). CoStar descriptive fields stay out of
    # third-party LLMs unless COPILOT_LLM_COSTAR=1, so by default the agent just says "the facility".
    if os.getenv("COPILOT_LLM_COSTAR") != "1":
        incident["facility"] = ""
    variables = {k: str(incident.get(k) or v)[:400] for k, v in PLACEHOLDERS.items()}
    route = "/convai/sip-trunk/outbound-call" if num.get("provider") == "sip_trunk" else "/convai/twilio/outbound-call"
    d = _call("POST", route, json={
        "agent_id": agent_id,
        "agent_phone_number_id": num["phone_number_id"],
        "to_number": to,
        "conversation_initiation_client_data": {"dynamic_variables": variables},
    })
    if d.get("success") is False:
        raise GuideError(d.get("message") or "ElevenLabs did not place the call")
    _last_call = time.time()
    return {"conversation_id": d.get("conversation_id"), "to": masked(to), "message": d.get("message"),
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def conversation(conversation_id: str) -> dict[str, Any]:
    """Live status and transcript of a placed call."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,80}", conversation_id):
        raise GuideError("Unknown conversation id")
    d = _call("GET", f"/convai/conversations/{conversation_id}")
    turns = [{"speaker": "HAVEN" if t.get("role") == "agent" else "Contact", "text": t.get("message") or ""}
             for t in d.get("transcript") or [] if t.get("message")]
    return {"status": d.get("status"), "transcript": turns,
            "duration_s": (d.get("metadata") or {}).get("call_duration_secs")}

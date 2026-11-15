"""Design editor: propose new site objects from a sentence ("add a 2 MW battery yard next to the substation").

POST /design/propose   {text, concept}  ->  {objects: [...], reason, source, notes}

The model only places and sizes rectangles. Everything it returns is re-checked here before the browser sees it:
types come from a fixed list, every rectangle is kept inside the site and the setback, sizes are clamped to sane
ranges, overlaps with existing plant are cleared where a nearby free spot exists, and any figure the sentence gives
(MWh, MW, kWp, m3, gallons, parking spaces) sets the size from the layout engine's own assumptions rather than the
model's guess. The objects come back as proposals with their source; the layout engine checks and costs them only
after the user accepts.

Gemini (structured JSON output) writes the proposal; Claude (Anthropic Messages API, structured output) is the
fallback. Only geometry and object types are sent. No CoStar names, addresses, prices or coordinates reach either
model unless COPILOT_LLM_COSTAR=1, and the concept summary this route accepts has no field for them anyway.

Coordinates are the layout engine's: metres, x east, y north, origin at the site's south-west corner, and each
rectangle's (x, y) is its south-west corner.
"""
from __future__ import annotations

import json
import math
import os
import re
from typing import Any, Literal

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app import config
from app.engine import assumptions as A
from app.engine import layout_engine as _engine  # noqa: F401  registers the studio assumptions (bess_mwh_per_m2 ...)
from app.sponsors.gemini import client as gemini

router = APIRouter(tags=["design"])

ObjType = Literal["yard_bess", "yard_solar", "yard_water", "yard_parking", "yard_wall", "yard_trees", "yard_guard",
                  "yard_fence", "yard_cooling", "sensor", "custom"]

# label, code prefix, default (w, d), min side, max side, typical height (m)
TYPES: dict[str, tuple[str, str, tuple[float, float], float, float, float]] = {
    "yard_bess": ("Battery storage", "BESS", (26, 12), 3, 200, 3.0),
    "yard_solar": ("Solar canopy", "PV", (36, 24), 4, 400, 4.5),
    "yard_water": ("Water tank", "TANK", (14, 14), 3, 60, 8.0),
    "yard_parking": ("Parking", "PARK", (42, 17), 5, 300, 0.1),
    "yard_wall": ("Noise wall", "WALL", (1, 40), 0.3, 600, 6.0),
    "yard_trees": ("Tree buffer", "TREES", (48, 12), 2, 800, 7.0),
    "yard_guard": ("Gatehouse", "GATE", (6, 5), 2, 30, 3.5),
    "yard_fence": ("Fence", "FENCE", (0.3, 40), 0.1, 1200, 2.4),
    "yard_cooling": ("Extra heat rejection", "COOL", (30, 14), 3, 200, 4.0),
    "sensor": ("HAVEN sensor", "SENS", (1, 1), 0.3, 3, 2.0),
    "custom": ("Custom object", "OBJ", (10, 10), 0.5, 400, 3.0),
}
LINEAR = {"yard_wall", "yard_trees", "yard_fence"}
PARKING_M2_PER_SPACE = 25.0   # 2.6 x 5 m stall plus its share of the drive aisle; a GeoStar estimate, said so in the notes
BESS_DEFAULT_HOURS = 2.0      # only used when a power figure (MW) is given without a duration; said so in the notes
MAX_OBJECTS = 6


class _Geo(BaseModel):
    model_config = ConfigDict(extra="ignore")
    x: float = Field(..., ge=-5000, le=10000)
    y: float = Field(..., ge=-5000, le=10000)
    w: float = Field(..., gt=0, le=5000)
    d: float = Field(..., gt=0, le=5000)


class YardIn(_Geo):
    code: str = Field(..., max_length=40)
    type: str = Field(..., max_length=40)
    name: str | None = Field(None, max_length=80)


class CheckIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = Field(..., max_length=120)
    ok: bool
    detail: str = Field("", max_length=400)


class ConceptIn(BaseModel):
    """Geometry summary of the concept being edited. Unknown fields (anything CoStar-derived) are dropped."""
    model_config = ConfigDict(extra="ignore")
    site_w: float = Field(..., ge=20, le=5000)
    site_d: float = Field(..., ge=20, le=5000)
    setback: float = Field(8, ge=0, le=200)
    building: _Geo
    yard: list[YardIn] = Field(default_factory=list, max_length=120)
    checks: list[CheckIn] = Field(default_factory=list, max_length=30)
    selected: str | None = Field(None, max_length=40)


class ProposeIn(BaseModel):
    text: str = Field(..., min_length=2, max_length=600)
    concept: ConceptIn


def _schema() -> dict[str, Any]:
    obj = {"type": "object", "additionalProperties": False,
           "required": ["type", "x", "y", "w", "d", "name", "h"],
           "properties": {
               "type": {"type": "string", "enum": list(TYPES)},
               "x": {"type": "number", "description": "West edge, metres east of the site's west boundary"},
               "y": {"type": "number", "description": "South edge, metres north of the site's south boundary"},
               "w": {"type": "number", "description": "Size east-west in metres"},
               "d": {"type": "number", "description": "Size north-south in metres"},
               "name": {"type": "string", "description": "Short name; required for custom, otherwise may be empty"},
               "h": {"type": "number", "description": "Height in metres; required for custom, otherwise 0"},
           }}
    return {"type": "object", "additionalProperties": False, "required": ["reason", "objects"],
            "properties": {"reason": {"type": "string", "description": "One sentence: what was placed where and why"},
                           "objects": {"type": "array", "items": obj}}}


def _prompt(q: ProposeIn) -> str:
    c = q.concept
    geo = {
        "site": {"width_m": c.site_w, "depth_m": c.site_d, "setback_m": c.setback},
        "building": {"x": c.building.x, "y": c.building.y, "w": c.building.w, "d": c.building.d},
        "yard": [{"code": y.code, "type": y.type, "x": round(y.x, 1), "y": round(y.y, 1), "w": round(y.w, 1), "d": round(y.d, 1)}
                 for y in c.yard],
        "failing_checks": [{"name": k.name, "detail": k.detail} for k in c.checks if not k.ok],
    }
    if c.selected:
        geo["selected"] = c.selected
    kinds = "\n".join(f"- {k}: {v[0]}, typical {v[2][0]:g} x {v[2][1]:g} m" for k, v in TYPES.items())
    return (
        "You place outdoor objects on a data center site plan. Coordinates are metres: x points EAST, y points NORTH, "
        "the origin is the site's SOUTH-WEST corner. Every rectangle is (x, y, w, d) where (x, y) is its SOUTH-WEST corner, "
        "w its east-west size and d its north-south size. North boundary is y = depth, south is y = 0, west x = 0, "
        "east x = width.\n"
        "Rules: keep every object inside the site and at least the setback from every boundary; do not overlap the "
        "building or any yard item unless the request asks for it; put 'next to X' objects 3 to 6 m from X; for "
        "objects 'along a boundary', run them the full usable length of that boundary just inside the setback. "
        "A wall or fence is thin (0.3 to 1 m) and long; a tree buffer is 8 to 15 m deep. Use 'custom' only when no "
        "other type fits, and then give it a short name and a height. For other types, name may be empty and h 0. "
        f"Return at most {MAX_OBJECTS} objects and one plain sentence as the reason. Do not state costs or capacities.\n"
        f"Object types:\n{kinds}\n\n"
        f"Current plan (JSON):\n{json.dumps(geo)}\n\n"
        f"Request: {q.text.strip()}"
    )


# ---------------------------------------------------------------- model calls


def _design_model() -> str:
    return os.getenv("GEMINI_DESIGN_MODEL") or "gemini-3.5-flash"


def _call_gemini(prompt: str) -> tuple[dict[str, Any], str]:
    """Gemini structured output (the shared client sends responseJsonSchema). Tries the design model, then GEMINI_MODEL."""
    if not config.GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY not set")
    last: Exception | None = None
    for model in dict.fromkeys([_design_model(), config.GEMINI_MODEL]):
        try:
            raw, _meta = gemini.generate_json([gemini.text(prompt)], _schema(), model=model, timeout=45)
            if not isinstance(raw, dict):
                raise ValueError("not a JSON object")
            return raw, model
        except Exception as e:  # noqa: BLE001  try the next model, then Claude
            last = e
    raise RuntimeError(f"Gemini failed ({type(last).__name__}: {str(last)[:60]})")


def _call_claude(prompt: str) -> tuple[dict[str, Any], str]:
    if not config.ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    model = os.getenv("ANTHROPIC_MODEL") or "claude-opus-5-5"
    r = httpx.post("https://api.anthropic.com/v1/messages", timeout=90, headers={
        "x-api-key": config.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json",
        "anthropic-beta": "server-side-fallback-2026-07-01"},
        json={"model": model, "max_tokens": 8000, "fallbacks": "default",
              "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": _schema()}},
              "messages": [{"role": "user", "content": prompt}]})
    r.raise_for_status()
    body = r.json()
    if body.get("stop_reason") == "refusal":
        raise RuntimeError("Claude declined the request")
    text = "".join(b.get("text", "") for b in body.get("content", []) if b.get("type") == "text")
    return json.loads(text), body.get("model") or model


def _ask(prompt: str) -> tuple[dict[str, Any], str, list[str]]:
    """The model's raw proposal, a source label, and notes on what was tried."""
    notes: list[str] = []
    try:
        raw, model = _call_gemini(prompt)
        return raw, f"Proposed by Gemini ({model})", notes
    except Exception as e:  # noqa: BLE001
        notes.append(f"Gemini was unavailable ({str(e)[:80]}); Claude wrote this proposal instead.")
    try:
        raw, model = _call_claude(prompt)
        return raw, f"Proposed by Claude ({model})", notes
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"No AI model could write a proposal. {notes[0] if notes else ''} "
                                 f"Claude: {type(e).__name__}.") from e


# ---------------------------------------------------------------- sizing and validation

_NUM = r"(\d+(?:[.,]\d+)?)"


def _f(s: str) -> float:
    return float(s.replace(",", ""))


def _figures(text: str) -> dict[str, float]:
    """Figures the sentence states, in base units. Only what is literally written is read."""
    t = text.lower()
    out: dict[str, float] = {}
    if m := re.search(_NUM + r"\s*(mwh|kwh)\b", t):
        out["mwh"] = _f(m.group(1)) / (1000.0 if m.group(2) == "kwh" else 1.0)
    if m := re.search(_NUM + r"\s*(mw|kw)(?:p)?\b(?!h)", t):
        out["mw"] = _f(m.group(1)) / (1000.0 if m.group(2) == "kw" else 1.0)
    if m := re.search(_NUM + r"\s*[- ]?(?:hours?|hrs?|h)\b", t):
        out["hours"] = _f(m.group(1))
    if m := re.search(_NUM + r"\s*(m3|m³|cubic met(?:re|er)s?|litres?|liters?|l\b|gallons?|gal\b)", t):
        unit = m.group(2)
        out["m3"] = _f(m.group(1)) * (0.001 if unit.startswith(("lit", "l")) and not unit.startswith("m")
                                     else 0.003785411784 if unit.startswith("gal") else 1.0)
    if m := re.search(_NUM + r"\s*(?:parking\s+)?(?:spaces|stalls|cars|bays)\b", t):
        out["spaces"] = _f(m.group(1))
    return out


def _target_area(typ: str, figs: dict[str, float], text: str, v) -> tuple[float | None, str | None]:
    """Area the stated figure implies under the engine's assumptions, with a plain note on how it was derived."""
    if typ == "yard_bess":
        if "mwh" in figs:
            mwh = figs["mwh"]
            return mwh / v("bess_mwh_per_m2"), (f"Sized for {mwh:g} MWh at the engine's {v('bess_mwh_per_m2'):g} MWh per m² "
                                                "(containerised, with access aisles).")
        if "mw" in figs:
            hours = figs.get("hours", BESS_DEFAULT_HOURS)
            mwh = figs["mw"] * hours
            how = (f"{hours:g} h stated" if "hours" in figs else
                   f"no duration was given, so {BESS_DEFAULT_HOURS:g} hours is assumed (an estimate; say e.g. '8 MWh' to set it)")
            return mwh / v("bess_mwh_per_m2"), (f"Sized for {figs['mw']:g} MW x {hours:g} h = {mwh:g} MWh ({how}) at the "
                                                f"engine's {v('bess_mwh_per_m2'):g} MWh per m².")
    if typ == "yard_solar" and "mw" in figs and re.search(r"solar|pv|canopy|panel", text, re.I):
        kwp = figs["mw"] * 1000.0
        return kwp / v("roof_solar_kw_per_m2"), f"Sized for {kwp:,.0f} kWp at the engine's {v('roof_solar_kw_per_m2'):g} kWp per m²."
    if typ == "yard_water" and "m3" in figs:
        h = TYPES["yard_water"][5]
        return figs["m3"] / h, f"Sized for {figs['m3']:,.0f} m³ as a {h:g} m tall tank (an estimate of tank height)."
    if typ == "yard_parking" and "spaces" in figs:
        n = figs["spaces"]
        return n * PARKING_M2_PER_SPACE, (f"Sized for {n:g} spaces at {PARKING_M2_PER_SPACE:g} m² each including aisles "
                                          "(a GeoStar estimate).")
    return None, None


def _overlap(a: dict, b: dict, gap: float = 0.0) -> bool:
    return (min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]) > -gap + 0.05
            and min(a["y"] + a["d"], b["y"] + b["d"]) - max(a["y"], b["y"]) > -gap + 0.05)


def _fit(o: dict, c: ConceptIn) -> list[str]:
    """Keep the rectangle inside the setback; shrink it if it cannot fit. Returns notes on what changed."""
    notes = []
    uw, ud = c.site_w - 2 * c.setback, c.site_d - 2 * c.setback
    if o["w"] > uw or o["d"] > ud:
        o["w"], o["d"] = min(o["w"], uw), min(o["d"], ud)
        notes.append("Shortened to fit inside the setback.")
    x = min(max(o["x"], c.setback), c.site_w - c.setback - o["w"])
    y = min(max(o["y"], c.setback), c.site_d - c.setback - o["d"])
    if abs(x - o["x"]) > 0.5 or abs(y - o["y"]) > 0.5:
        notes.append(f"Moved {math.hypot(x - o['x'], y - o['y']):.0f} m to stay inside the {c.setback:g} m setback.")
    o["x"], o["y"] = x, y
    return notes


def _clear(o: dict, c: ConceptIn, others: list[dict]) -> list[str]:
    """If the rectangle overlaps existing plant, move it to the nearest free spot inside the setback (2 m search grid)."""
    hits = [b for b in others if _overlap(o, b)]
    if not hits:
        return []
    best = None
    for r in range(2, 122, 2):
        for k in range(max(8, r * 2)):
            a = 2 * math.pi * k / max(8, r * 2)
            x, y = o["x"] + r * math.cos(a), o["y"] + r * math.sin(a)
            if x < c.setback or y < c.setback or x + o["w"] > c.site_w - c.setback or y + o["d"] > c.site_d - c.setback:
                continue
            cand = {**o, "x": x, "y": y}
            if not any(_overlap(cand, b, 1.0) for b in others):
                best = (x, y)
                break
        if best:
            break
    names = ", ".join(sorted({b["code"] for b in hits})[:3])
    if not best:
        return [f"Overlaps {names}; no free spot nearby, so the layout checks will flag it."]
    moved = math.dist(best, (o["x"], o["y"]))
    o["x"], o["y"] = best
    return [f"Moved {moved:.0f} m to clear {names}."]


def _code(typ: str, taken: set[str]) -> str:
    prefix = f"AI-{TYPES[typ][1]}"
    n = 1
    while f"{prefix}-{n}" in taken:
        n += 1
    taken.add(f"{prefix}-{n}")
    return f"{prefix}-{n}"


def clean(raw: dict[str, Any], q: ProposeIn, source: str) -> dict[str, Any]:
    """Validate and size the model's proposal. Pure function, so it is tested without any model call."""
    c = q.concept
    v = lambda k: A.value(k)  # noqa: E731
    figs = _figures(q.text)
    items = raw.get("objects") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        raise HTTPException(502, "The proposal came back in the wrong shape.")
    others = [{"code": "Building", "x": c.building.x, "y": c.building.y, "w": c.building.w, "d": c.building.d}] + \
             [{"code": y.code, "x": y.x, "y": y.y, "w": y.w, "d": y.d} for y in c.yard]
    taken = {y.code for y in c.yard}
    out, dropped = [], 0
    for it in items[:MAX_OBJECTS]:
        try:
            typ = str(it["type"])
            x, y, w, d = (float(it[k]) for k in ("x", "y", "w", "d"))
        except (KeyError, TypeError, ValueError):
            dropped += 1
            continue
        if typ not in TYPES or not all(map(math.isfinite, (x, y, w, d))):
            dropped += 1
            continue
        label, _, (dw, dd), lo, hi, h0 = TYPES[typ]
        notes: list[str] = []
        estimate: str | None = None
        w, d = (w if w > 0 else dw), (d if d > 0 else dd)
        if typ == "sensor":
            w, d = min(max(w, lo), hi), min(max(d, lo), hi)
        area, how = _target_area(typ, figs, q.text, v)
        if area:
            share = area / max(1, sum(1 for i in items if isinstance(i, dict) and i.get("type") == typ))
            k = math.sqrt(share / (w * d))
            w, d = w * k, d * k
            estimate = how
        else:
            estimate = "Size and position proposed by the model; check them against the real equipment."
        w, d = (min(max(w, lo), hi), min(max(d, lo), hi))
        o = {"type": typ, "x": x, "y": y, "w": w, "d": d}
        notes += _fit(o, c)
        if typ not in LINEAR:
            notes += _clear(o, c, others + out)
        name = str(it.get("name") or "").strip()[:60] or label
        obj: dict[str, Any] = {"code": _code(typ, taken), "type": typ, "name": name,
                               "x": round(o["x"], 1), "y": round(o["y"], 1), "w": round(o["w"], 1), "d": round(o["d"], 1),
                               "source": source, "estimate": estimate, "notes": notes}
        hval = it.get("h")
        if typ == "custom":
            obj["h"] = round(min(max(float(hval), 0.2), 80.0), 1) if isinstance(hval, (int, float)) and hval > 0 else h0
            if not (isinstance(hval, (int, float)) and hval > 0):
                notes.append(f"No height given; {h0:g} m assumed.")
        out.append(obj)
        others.append({"code": obj["code"], **{k: obj[k] for k in ("x", "y", "w", "d")}})
    if not out:
        raise HTTPException(422, "The request did not turn into any object that can be placed. Try naming the object, "
                                 "for example 'battery storage', 'tree buffer' or 'noise wall'.")
    reason = str(raw.get("reason") or "").strip()[:300] or "Placed as requested."
    return {"objects": out, "reason": reason, "source": source, "dropped": dropped,
            "label": "Proposal", "figures": figs}


@router.post("/design/propose")
def propose(q: ProposeIn) -> dict[str, Any]:
    if not (config.GEMINI_API_KEY or config.ANTHROPIC_API_KEY):
        raise HTTPException(503, "AI proposals need GEMINI_API_KEY or ANTHROPIC_API_KEY on the GeoStar API.")
    raw, source, notes = _ask(_prompt(q))
    res = clean(raw, q, source)
    res["notes"] = notes
    res["sent"] = "Only the site rectangle, setback, building and yard rectangles with their types and codes, and the "\
                  "failing checks were sent to the model." + (
                      "" if os.getenv("COPILOT_LLM_COSTAR") != "1" else " COPILOT_LLM_COSTAR=1 is set, but this route has no CoStar fields to send.")
    return res

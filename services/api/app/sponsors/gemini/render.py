"""AI street-view render of a concept with a Gemini image model, prompted from the concept's real geometry.

The prompt is built only from the layout engine's numbers (building size, storeys, yard items and where they sit
relative to the building, cooling); no site name, address or coordinates. The result is labelled "AI render, not a
photo" everywhere it is shown. If the key has no image model, render() raises and the Studio says so.
"""
from __future__ import annotations

import base64
import hashlib
import json
import time
from collections import Counter
from typing import Any

from app import config
from app.sponsors.gemini import client as G

CACHE = config.CACHE_DIR / "gemini" / "renders"
BLOCKED = CACHE / "image_blocked.json"
YARD_WORDS = {
    "yard_sub": "an electrical substation with transformers behind a fence",
    "yard_gen": "diesel backup generator enclosures",
    "yard_cool": "rooftop-height dry coolers / chillers on a slab",
    "yard_water": "water storage tanks",
    "yard_bess": "battery storage containers",
    "yard_solar": "a solar canopy",
    "yard_parking": "a staff car park",
    "yard_wall": "an acoustic noise wall",
    "yard_trees": "a planted tree buffer",
    "yard_guard": "a small guard house at the gate",
}
COOLING = {"liquid": "direct liquid cooling", "air": "air cooling", "hybrid": "hybrid air and liquid cooling"}


def _side(dx: float, dy: float) -> str:
    if abs(dx) < 1 and abs(dy) < 1:
        return "beside"
    if abs(dx) > abs(dy):
        return "east of" if dx > 0 else "west of"
    return "north of" if dy > 0 else "south of"


def geometry(concept: dict[str, Any], brief: dict[str, Any]) -> dict[str, Any]:
    """The facts the prompt uses, all from the engine's concept."""
    b = concept.get("building") or {}
    bx, by = float(b.get("x", 0)) + float(b.get("w", 0)) / 2, float(b.get("y", 0)) + float(b.get("d", 0)) / 2
    groups: dict[str, dict[str, Any]] = {}
    for r in concept.get("yard") or []:
        t = r.get("type")
        if t not in YARD_WORDS:
            continue
        g = groups.setdefault(t, {"n": 0, "sides": Counter(), "w": 0.0, "d": 0.0, "h": 0.0})
        g["n"] += 1
        g["w"], g["d"], g["h"] = max(g["w"], float(r.get("w", 0))), max(g["d"], float(r.get("d", 0))), max(g["h"], float(r.get("h") or 0))
        g["sides"][_side(float(r.get("x", 0)) + float(r.get("w", 0)) / 2 - bx, float(r.get("y", 0)) + float(r.get("d", 0)) / 2 - by)] += 1
    eq = Counter(e.get("type") for e in concept.get("equipment") or [])
    return {
        "w": round(float(b.get("w", 0))), "d": round(float(b.get("d", 0))), "h": round(float(b.get("h", 0)), 1),
        "storeys": int(b.get("storeys") or 1), "floor_h": round(float(b.get("floor_h") or 0), 1),
        "mw": brief.get("mw_it"), "cooling": COOLING.get(str(brief.get("cooling")), str(brief.get("cooling") or "")),
        "yard": [{"type": t, "n": g["n"], "where": g["sides"].most_common(1)[0][0], "w": round(g["w"]), "d": round(g["d"]),
                  "h": round(g["h"], 1)} for t, g in groups.items()],
        "equipment": dict(eq),
        "site_w": brief.get("site_w"), "site_d": brief.get("site_d"),
    }


def prompt_for(g: dict[str, Any], view: str = "south", setting: str = "") -> str:
    yard = "; ".join(f"{YARD_WORDS[y['type']]} ({y['n']} item{'s' if y['n'] > 1 else ''}, each about {y['w']} x {y['d']} m) "
                     f"{y['where']} the building" for y in g["yard"]) or "a paved service yard"
    return (
        f"Photorealistic eye-level street-view photograph, taken by a person standing on the public road on the {view} side "
        f"of a new data center campus, about 120 m from the building, overcast daylight, 35 mm lens.\n"
        f"The building: one plain rectangular {g['storeys']}-storey data hall, {g['w']} m long and {g['d']} m deep, "
        f"{g['h']} m tall to the parapet ({g['floor_h']} m per storey), flat roof, insulated metal panel facade in light grey "
        f"with a few narrow vertical windows only at the office end, loading doors on one side. Its long side faces the camera "
        f"if it is longer east-west.\n"
        f"Around it, at true scale relative to the building: {yard}.\n"
        f"Site: flat, about {g['site_w']} x {g['site_d']} m, security fence with a gate, short grass, a few trees, "
        f"{(setting + ' ') if setting else ''}light-industrial surroundings. No people close up, no logos, no text, no signs with words, no watermark."
    )


def blocked() -> dict[str, Any] | None:
    """The last 'no quota for the image model on this key' answer, if it is under a day old and for the same model."""
    try:
        b = json.loads(BLOCKED.read_text())
    except (OSError, ValueError):
        return None
    return b if b.get("model") == G.IMAGE_MODEL and time.time() - float(b.get("at", 0)) < 86400 else None


def render(concept: dict[str, Any], brief: dict[str, Any], view: str = "south", setting: str = "") -> dict[str, Any]:
    if view not in ("north", "south", "east", "west"):
        view = "south"
    g = geometry(concept, brief)
    prompt = prompt_for(g, view, setting)
    key = hashlib.sha1(f"{G.IMAGE_MODEL}:{prompt}".encode()).hexdigest()[:20]
    img_path, meta_path = CACHE / f"{key}.png", CACHE / f"{key}.json"
    if img_path.exists() and meta_path.exists():
        meta = json.loads(meta_path.read_text())
        data = img_path.read_bytes()
        cached = True
    else:
        if blocked():
            raise G.GeminiError(blocked()["reason"], quota_zero=True)
        try:
            data, mime, note, info = G.generate_image(prompt)
        except G.GeminiError as e:
            if e.quota_zero:  # remember for a day, so the Studio can say so up front instead of failing per click
                CACHE.mkdir(parents=True, exist_ok=True)
                BLOCKED.write_text(json.dumps({"model": G.IMAGE_MODEL, "reason": str(e), "at": time.time()}))
            raise
        meta = {"mime": mime, "note": note[:300], "model": info["model"], "ms": info["ms"]}
        CACHE.mkdir(parents=True, exist_ok=True)
        img_path.write_bytes(data)
        meta_path.write_text(json.dumps(meta))
        cached = False
    return {"image": f"data:{meta['mime']};base64,{base64.b64encode(data).decode('ascii')}", "prompt": prompt, "geometry": g,
            "view": view, "model": meta["model"], "cached": cached, "label": "AI render, not a photo",
            "note": "Generated by Gemini from the concept's dimensions. Massing and proportions follow the prompt; details "
                    "(facade, surroundings, equipment look) are invented by the model."}

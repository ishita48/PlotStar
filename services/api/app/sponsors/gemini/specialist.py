"""The Imagery Analyst: a Deep Agents subagent backed by Gemini (LangChain's Google GenAI integration).

It answers "what is physically on and around this site?" from Vexcel imagery: Gemini's obstacle boxes on the aerial,
Vexcel-measured neighbour heights (DSM minus DTM) and the capture history. Registered in
app/sponsors/langchain/deep_agents/agents.py like the other specialists, so the orchestrator can delegate to it with
`task` and it appears in the live execution graph (its model node shows provider google_genai).

Tool views carry geometry in metres in the site frame (origin at the site's south-west corner, x east, y north) and
image metadata only: no property names, addresses, ids or coordinates reach the model.
"""
from __future__ import annotations

import math
from collections import Counter
from typing import Any

from langchain_core.tools import BaseTool

from app import config
from app.sponsors.gemini import client as G

NAME = "imagery-analyst"
TITLE = "Imagery Analyst (Gemini)"
ROLE = "What is on and around the site? Gemini reads the Vexcel aerial; Vexcel measures neighbour heights."


def _site_ref(run: Any) -> tuple[str | None, float, float]:
    site = run.context.get("site") or {}
    brief = run.context.get("brief") or {}
    sid = site.get("id")
    if not (isinstance(sid, str) and (sid.startswith("costar:") or sid.startswith("pt:"))):
        sid = f"pt:{site['lat']:.6f},{site['lon']:.6f}" if isinstance(site.get("lat"), (int, float)) and isinstance(site.get("lon"), (int, float)) else None
    return sid, float(brief.get("site_w") or 320), float(brief.get("site_d") or 240)


def aerial_obstacles() -> str:
    """Ask Gemini to read the Vexcel aerial photo of the selected site and box what already occupies the site rectangle:
    buildings, structures, trees, water, parking, paving and roads. Returns counts by kind, each obstacle in metres in
    the site frame (origin south-west corner, x east, y north), Gemini's confidence, and how the image maps to the site."""
    from app.sponsors.gemini import vision
    from app.sponsors.langchain.deep_agents.tools import _fail, _reply, _run
    run = _run()
    sid, w, d = _site_ref(run)
    if not sid:
        return _fail("No site is selected")
    try:
        r = vision.find_obstacles(sid, w, d)
    except Exception as e:  # noqa: BLE001
        return _fail(f"Gemini on the Vexcel aerial failed: {e}")
    obs = r["obstacles"]
    kinds = Counter(o["kind"] for o in obs)
    kept = [o for o in obs if o.get("suggest_keep")]
    view = {
        "scene": r.get("scene"), "site_rectangle_m": [w, d], "obstacles_found": len(obs), "by_kind": dict(kinds),
        "suggested_keep": len(kept),
        "box_area_m2_by_kind": {k: round(sum(o["w"] * o["d"] for o in obs if o["kind"] == k)) for k in kinds},
        "obstacles": [{k: o[k] for k in ("id", "kind", "label", "x", "y", "w", "d", "confidence")} | {"advice": o.get("advice")}
                      for o in sorted(obs, key=lambda o: -o["w"] * o["d"])[:15]],
        "image_capture": r["image"].get("captured"), "image_footprint": r["mapping"]["image_footprint"],
        "mapping_caveat": r["mapping"]["site_rectangle"], "model": r.get("model"),
        "note": "Boxes are axis-aligned and AI-detected; box areas overlap, so their sum is not the obstructed area.",
    }
    return _reply("aerial_obstacles", r, view, provider="gemini", label="AI-detected", sources=[r["source"], "Vexcel ortho"],
                  headline=f"Gemini found {len(obs)} features on the site rectangle ({', '.join(f'{n} {k}' for k, n in kinds.most_common(4))}).")


def neighbour_heights() -> str:
    """Measured heights of the existing structures on and around the selected site, from Vexcel: building footprints
    plus surface (DSM) minus bare-earth (DTM) elevation inside each footprint. Returns the tallest neighbours with their
    distance and direction from the site centre, and the structures standing inside the site rectangle."""
    from app.sponsors.langchain.deep_agents.tools import _fail, _reply, _run
    from app.sponsors.vexcel import routes as vx
    run = _run()
    sid, w, d = _site_ref(run)
    if not sid:
        return _fail("No site is selected")
    try:
        r = vx.neighbour_heights(sid, 200)
    except Exception as e:  # noqa: BLE001
        return _fail(f"Vexcel structures / elevation failed: {getattr(e, 'detail', e)}")

    def where(s: dict[str, Any]) -> dict[str, Any]:
        x, y = s["centre"]
        ang = (math.degrees(math.atan2(x, y)) + 360) % 360
        return {"id": s["id"], "height_m": s["height_m"], "storeys_est": s["storeys_est"], "footprint_m2": s["area_m2"],
                "type": s["building_type"], "distance_m": round(math.hypot(x, y)),
                "direction": ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][int((ang + 22.5) // 45) % 8]}

    inside = [s for s in r["structures"] if abs(s["centre"][0]) <= w / 2 and abs(s["centre"][1]) <= d / 2]
    heights = sorted(s["height_m"] for s in r["structures"] if s["height_m"] is not None)
    view = {
        "structures": r["count"], "measured": r["measured"], "radius_m": r["radius_m"],
        "median_height_m": heights[len(heights) // 2] if heights else None,
        "tallest": [where(s) for s in sorted((s for s in r["structures"] if s["height_m"] is not None), key=lambda s: -s["height_m"])[:5]],
        "inside_site_rectangle": {"count": len(inside), "max_height_m": max((s["height_m"] or 0 for s in inside), default=None),
                                  "items": [where(s) for s in inside[:8]]},
        "method": r["method"],
    }
    return _reply("neighbour_heights", r, view, provider="vexcel", label="Measured", sources=[r["source"]],
                  headline=f"Vexcel measured {r['measured']} of {r['count']} structures within {r['radius_m']} m.")


def imagery_history() -> str:
    """Which Vexcel imagery exists over the selected site: every ortho capture date (for before/after comparisons) and
    the oblique (angled) view directions available."""
    from app.sponsors.langchain.deep_agents.tools import _fail, _reply, _run
    from app.sponsors.vexcel import routes as vx
    run = _run()
    sid, _, _ = _site_ref(run)
    if not sid:
        return _fail("No site is selected")
    try:
        caps, obl = vx.captures(sid), vx.oblique_list(sid)
    except Exception as e:  # noqa: BLE001
        return _fail(f"Vexcel catalogue failed: {getattr(e, 'detail', e)}")
    view = {"captures": [{"date": (c["last_capture"] or "")[:10], "layer": c["layer"], "gsd_cm": c["gsd_cm"]} for c in caps["captures"]],
            "oblique_directions": obl["directions"], "oblique_captured": (obl.get("captured") or "")[:10]}
    return _reply("imagery_history", {"captures": caps, "oblique": obl}, view, provider="vexcel", label="Sourced",
                  sources=[caps["source"]], headline=f"{caps['count']} ortho captures; obliques from {', '.join(obl['directions']) or 'no'} side(s).")


_TOOLS: dict[str, BaseTool] = {}


def tools() -> dict[str, BaseTool]:
    """The analyst's tools, in the same StructuredTool shape (and graph metadata) as GeoStar's other agent tools."""
    if not _TOOLS:
        from app.sponsors.langchain.deep_agents.tools import _tool
        _TOOLS.update({
            "aerial_obstacles": _tool(aerial_obstacles, "aerial_obstacles", "Gemini · Obstacles on the Vexcel aerial", provider="gemini"),
            "neighbour_heights": _tool(neighbour_heights, "neighbour_heights", "Vexcel · Neighbour heights (DSM - DTM)", provider="vexcel"),
            "imagery_history": _tool(imagery_history, "imagery_history", "Vexcel · Capture history and obliques", provider="vexcel"),
        })
    return _TOOLS


def make_model() -> Any:
    from langchain_google_genai import ChatGoogleGenerativeAI
    return ChatGoogleGenerativeAI(model=G.AGENT_MODEL, google_api_key=config.GEMINI_API_KEY, max_retries=2, timeout=120,
                                  name=f"Model / {TITLE}", tags=["model", f"agent:{NAME}"],
                                  metadata={"agent_name": NAME, "agent_role": ROLE, "model_provider": "google",
                                            "model_name": G.AGENT_MODEL})


SPEC: dict[str, Any] = dict(
    name=NAME, title=TITLE, role=ROLE, model_name=G.AGENT_MODEL, make_model=make_model,
    description="Reads Vexcel imagery of the site with Gemini vision: existing buildings, trees, water, parking and roads "
                "on the site rectangle (boxed and measured in metres), measured neighbour heights, and which capture "
                "dates and oblique views exist. Use for 'what is on the site', existing obstructions, demolition or "
                "clearing, and the height of the surroundings.",
    tools=list(("aerial_obstacles", "neighbour_heights", "imagery_history")),
    prompt="You are GeoStar's Imagery Analyst, running on Google Gemini. Goal: describe what physically occupies and "
           "surrounds the site, from Vexcel imagery. Call aerial_obstacles (Gemini's boxes on the aerial) and "
           "neighbour_heights (Vexcel-measured heights); add imagery_history when dates or change over time matter. "
           "Report what would have to be cleared or avoided, how much of the site looks free, the tallest neighbours "
           "and their direction, and the caveats: boxes are AI-detected and axis-aligned, and the site rectangle is "
           "assumed centred on the site point because the true parcel boundary is not in the data.",
)

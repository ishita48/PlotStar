"""The Design Editor specialist: a Deep Agents subagent that changes the layout through the Studio's edit contract.

    edits[concept_id] = {building: {dx, dy}, rotate, yard: {CODE: {x, y}}, added: [{code, type, x, y, w, d, name?, h?, source?}],
                         removed: [CODE]}

Coordinates are the layout engine's: metres, origin at the site rectangle's south-west corner, x east, y north; an
item's (x, y) is its south-west corner. The concept id always comes from the engine's own generate result (never
hard-coded), and every engine run pins that concept with keep=[id] so it stays in the result.

Tools:
  layout_objects       the active concept's site, building and yard objects with codes and positions
  preview_layout_edit  what a change would do: the engine re-runs with it and the before/after is measured
  apply_layout_edit    the same change, for real. Human in the loop: Deep Agents `interrupt_on` pauses the run before
                       the tool executes; a person approves or rejects it in the Studio. On approval the merged edit is
                       recorded on the run and streamed (`design_edit` event); the Studio applies it to its edits and
                       regenerates. Nothing changes without that approval.

Every number the agent reports comes from layout_engine.generate. The agent sees GeoStar geometry only, no CoStar fields.
"""
from __future__ import annotations

import copy
from typing import Any, Literal

from langchain_core.tools import BaseTool, StructuredTool
from pydantic import BaseModel, Field

from app.engine import layout_engine
from app.sponsors.langchain import copilot
from app.sponsors.langchain.deep_agents.runtime import CURRENT, Run, dumps

PlaceType = Literal["yard_bess", "yard_solar", "yard_water", "yard_parking", "yard_wall", "yard_trees", "yard_guard",
                    "yard_fence", "yard_cooling", "sensor", "custom"]
DEFAULTS: dict[str, tuple[str, float, float]] = {  # prefix, w, d (metres); the Studio's own add defaults where it has them
    "yard_bess": ("BESS", 26, 12), "yard_solar": ("PV", 36, 24), "yard_water": ("TANK", 14, 14),
    "yard_parking": ("PARK", 42, 17), "yard_wall": ("WALL", 1, 40), "yard_trees": ("TREES", 48, 12),
    "yard_guard": ("GATE", 6, 5), "yard_fence": ("FENCE", 40, 1), "yard_cooling": ("COOL", 20, 10),
    "sensor": ("SENS", 1, 1), "custom": ("OBJ", 10, 10),
}
NO_EDIT: dict[str, Any] = {"building": {"dx": 0.0, "dy": 0.0}, "rotate": False, "yard": {}, "added": [], "removed": []}


class Move(BaseModel):
    code: str = Field(..., max_length=24, description="Code of an existing yard item, e.g. SUB-01, GEN, CY-01, or an added item")
    x: float = Field(..., ge=-3000, le=8000, description="New south-west corner, metres east of the site's west edge")
    y: float = Field(..., ge=-3000, le=8000, description="New south-west corner, metres north of the site's south edge")


class Add(BaseModel):
    type: PlaceType
    x: float = Field(..., ge=-3000, le=8000, description="South-west corner, metres east of the site's west edge")
    y: float = Field(..., ge=-3000, le=8000, description="South-west corner, metres north of the site's south edge")
    w: float | None = Field(None, ge=1, le=800, description="East-west size in metres (default per type)")
    d: float | None = Field(None, ge=1, le=800, description="North-south size in metres (default per type)")
    name: str | None = Field(None, max_length=60, description="Required for type custom")
    h: float | None = Field(None, ge=0.1, le=60, description="Height in metres; required for type custom")


class LayoutChange(BaseModel):
    """One change to the active concept's layout, in the layout engine's coordinates (metres, origin at the site's
    south-west corner, x east, y north)."""
    reason: str = Field(..., max_length=300, description="Why, in one sentence, with the numbers from preview_layout_edit")
    building_east_m: float = Field(0, ge=-500, le=500, description="Move the building this many metres east (negative: west)")
    building_north_m: float = Field(0, ge=-500, le=500, description="Move the building this many metres north (negative: south)")
    rotate: bool | None = Field(None, description="Set the building's rotation (true: rotated 90 degrees)")
    move: list[Move] = Field(default_factory=list, max_length=8)
    add: list[Add] = Field(default_factory=list, max_length=6)
    remove: list[str] = Field(default_factory=list, max_length=8, description="Codes to remove")


def _run() -> Run:
    r = CURRENT.get()
    if r is None:
        raise RuntimeError("Design tools run inside an agent run")
    return r


def _concept_id(run: Run) -> str:
    return run.ctx.concept()["id"]  # from the engine's own generate result


def current_edits(run: Run) -> dict[str, Any]:
    """The Studio's edits plus every edit approved earlier in this run."""
    eds = copy.deepcopy(run.context.get("edits") or {})
    for d in run.design_edits:
        eds[d["concept_id"]] = copy.deepcopy(d["edit"])
    return eds


def _engine(run: Run, edits: dict[str, Any], cid: str) -> dict[str, Any]:
    r = run.context
    return layout_engine.generate(dict(r["brief"]), r.get("site") or {}, run.ctx.grid(), r.get("priorities") or {},
                                  r.get("assumptions") or {}, edits, keep=[cid])


def _concept(result: dict[str, Any], cid: str) -> dict[str, Any] | None:
    return next((c for c in result["concepts"] if c["id"] == cid), None)


def merge(edit: dict[str, Any] | None, ch: LayoutChange, concept: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Apply one LayoutChange to a concept's edit. Returns the new edit and the codes it adds."""
    e = copy.deepcopy({**NO_EDIT, **(edit or {})})
    e.setdefault("removed", [])
    b = e["building"]
    b["dx"], b["dy"] = round(float(b.get("dx", 0)) + ch.building_east_m, 2), round(float(b.get("dy", 0)) + ch.building_north_m, 2)
    if ch.rotate is not None and bool(ch.rotate) != bool(e.get("rotate")):
        e["rotate"], b["dx"], b["dy"] = bool(ch.rotate), 0.0, 0.0  # the Studio resets the offset when it rotates
    added_codes = {a["code"] for a in e["added"]}
    for m in ch.move:
        if m.code in added_codes:
            e["added"] = [dict(a, x=m.x, y=m.y) if a["code"] == m.code else a for a in e["added"]]
        else:
            e["yard"][m.code] = {"x": m.x, "y": m.y}
    taken = {i["code"] for i in concept.get("yard", [])} | added_codes
    new = []
    for a in ch.add:
        prefix, w0, d0 = DEFAULTS[a.type]
        n = 1
        while f"AI-{prefix}-{n}" in taken:
            n += 1
        code = f"AI-{prefix}-{n}"
        taken.add(code)
        item = dict(code=code, type=a.type, x=round(a.x, 1), y=round(a.y, 1), w=a.w or w0, d=a.d or d0,
                    source="Design Editor agent (approved)")
        if a.name:
            item["name"] = a.name
        if a.h is not None:
            item["h"] = a.h
        if a.type == "custom":
            item.setdefault("name", "Custom object")
            item.setdefault("h", 3.0)
        e["added"].append(item)
        new.append(code)
    for code in ch.remove:
        if code in added_codes:
            e["added"] = [a for a in e["added"] if a["code"] != code]
        elif code not in e["removed"]:
            e["removed"].append(code)
    return e, new


def _verify(ch: LayoutChange, after: dict[str, Any], new: list[str], before: dict[str, Any]) -> list[dict[str, Any]]:
    """Did the engine take each change? Measured on its output, so an unsupported change is reported, not assumed."""
    items = {i["code"]: i for i in after.get("yard", [])}
    out = []
    for code in new:
        out.append(dict(change=f"add {code}", applied=code in items))
    for code in ch.remove:
        out.append(dict(change=f"remove {code}", applied=code not in items))
    for m in ch.move:
        it = items.get(m.code)
        out.append(dict(change=f"move {m.code}", applied=bool(it) and abs(it["x"] - m.x) < 0.6 and abs(it["y"] - m.y) < 0.6))
    if ch.building_east_m or ch.building_north_m:
        bx, by = after["building"]["x"] - before["building"]["x"], after["building"]["y"] - before["building"]["y"]
        out.append(dict(change="move building", applied=abs(bx - ch.building_east_m) < 0.6 and abs(by - ch.building_north_m) < 0.6))
    if ch.rotate is not None:
        out.append(dict(change="rotate building", applied=bool(after.get("rotated")) == bool(ch.rotate)))
    return out


def _evaluate(ch: LayoutChange) -> dict[str, Any]:
    run = _run()
    cid = _concept_id(run)
    edits = current_edits(run)
    before_res = _engine(run, edits, cid) if run.design_edits else run.ctx.base
    before = _concept(before_res, cid)
    if before is None:
        return dict(ok=False, headline=f"The active concept {cid} is not in the engine result.")
    edit, new = merge(edits.get(cid), ch, before)
    after_res = _engine(run, {**edits, cid: edit}, cid)
    after = _concept(after_res, cid)
    if after is None:
        return dict(ok=False, headline="The engine dropped the edited concept; nothing was changed.")
    cons = copilot.consequences(before_res, after_res, cid)
    applied = _verify(ch, after, new, before)
    failed = [k["name"] for k in after["checks"] if not k["ok"]]
    top = [r for r in cons["changed"] if r["metric"] in ("Cost to build", "Ten-year cost", "Noise at boundary", "Building footprint",
                                                        "Site coverage", "Rank", "Power route", "Water use")][:6]
    head = "; ".join(f"{r['metric']} {r['before_text']} → {r['after_text']}" for r in top) or "No measured quantity changed."
    flips = "; ".join(f"{k['name']} now {'passes' if k['after'] else 'fails'}" for k in cons["check_flips"])
    return dict(ok=True, concept_id=cid, concept=after["name"], edit=edit, added=new, applied=applied, failed_checks=failed,
                feasible=after["feasible"], consequences=cons,
                headline=f"{after['name']}: {head}." + (f" {flips}." if flips else "")
                + ("" if all(a["applied"] for a in applied) else " The engine did not take every change: "
                   + ", ".join(a["change"] for a in applied if not a["applied"]) + "."))


def _view(o: dict[str, Any]) -> dict[str, Any]:
    cons = o["consequences"]
    return {"concept_id": o["concept_id"], "concept": o["concept"], "still_feasible": o["feasible"], "failed_checks": o["failed_checks"],
            "engine_applied": o["applied"], "added_codes": o["added"],
            "changed": [f"{x['metric']}: {x['before_text']} → {x['after_text']}" for x in cons["changed"]][:12],
            "checks_that_changed": [f"{k['name']}: {'pass' if k['after'] else 'fail'}" for k in cons["check_flips"]]}


# ----------------------------------------------------------------------------------------------------- the tools

def layout_objects() -> str:
    """The active concept's layout in the engine's coordinates (metres, origin at the site's south-west corner, x east,
    y north; each item's x, y is its south-west corner): the site rectangle and setback, the building, every yard item
    (code, type, position, size), the edit already applied, failed checks, and the object types you can add with
    their default sizes."""
    from app.sponsors.langchain.deep_agents.tools import _reply
    run = _run()
    cid = _concept_id(run)
    eds = current_edits(run)
    res = _engine(run, eds, cid) if run.design_edits else run.ctx.base
    c = _concept(res, cid) or run.ctx.concept()
    br = res["brief"]
    rnd = lambda d: {k: (round(v, 1) if isinstance(v, float) else v) for k, v in d.items()}  # noqa: E731
    view = {"concept_id": cid, "concept": c["name"],
            "site": {"w_m": br["site_w"], "d_m": br["site_d"], "setback_m": br["setback_m"],
                     "frame": "origin south-west corner, x east, y north, metres"},
            "building": rnd({k: c["building"][k] for k in ("x", "y", "w", "d", "storeys")}) | {"rotated": c.get("rotated")},
            "yard": [rnd({k: i.get(k) for k in ("code", "type", "name", "x", "y", "w", "d")}) | ({"added": True} if i.get("added") else {})
                     for i in c["yard"]],
            "current_edit": eds.get(cid) or None, "removed": c.get("removed") or [],
            "failed_checks": [k["name"] for k in c["checks"] if not k["ok"]],
            "can_add": {t: {"w": w, "d": d} for t, (_, w, d) in DEFAULTS.items()}}
    return _reply("layout_objects", {"concept": c, "edits": eds}, view, label="Estimated (layout engine)",
                  sources=["GeoStar layout engine"], headline=f"{c['name']}: building {c['building']['w']:.0f} x {c['building']['d']:.0f} m, "
                                                             f"{len(c['yard'])} yard items.")


def preview_layout_edit(**args: Any) -> str:
    """Preview one layout change without applying it: the engine re-runs with the change and reports what it does to
    cost, noise, coverage, checks and rank, and whether the engine took every part of the change."""
    from app.sponsors.langchain.deep_agents.tools import _fail, _reply
    ch = LayoutChange(**args)
    o = _evaluate(ch)
    if not o["ok"]:
        return _fail(o["headline"])
    return _reply("preview_layout_edit", o, _view(o) | {"note": "Preview only. Use apply_layout_edit to propose it to the user."},
                  label="Estimated (layout engine re-run)", sources=["GeoStar layout engine"], headline=o["headline"])


def apply_layout_edit(**args: Any) -> str:
    """Apply one layout change to the Studio. A person must approve it first (the run pauses for approval). Call it
    only after preview_layout_edit, with the same change and a one-sentence reason quoting the previewed numbers."""
    from app.sponsors.langchain.deep_agents.tools import _fail, _reply
    run = _run()
    ch = LayoutChange(**args)
    o = _evaluate(ch)
    if not o["ok"]:
        return _fail(o["headline"])
    rec = dict(concept_id=o["concept_id"], concept=o["concept"], edit=o["edit"], reason=ch.reason, added=o["added"],
               applied=o["applied"], failed_checks=o["failed_checks"], feasible=o["feasible"],
               changed=o["consequences"]["changed"][:12], check_flips=o["consequences"]["check_flips"], headline=o["headline"])
    with run.lock:
        run.design_edits.append(rec)
    run.emit("design_edit", design_edit=rec)
    return _reply("apply_layout_edit", o, _view(o) | {"status": "Approved by the user and applied to the Studio."},
                  label="Estimated (layout engine re-run)", sources=["GeoStar layout engine"], headline="Applied: " + o["headline"])


def describe(tool_call: dict[str, Any], state: Any = None, runtime: Any = None) -> str:
    """What the person is asked to approve, in words (shown on the approval card)."""
    try:
        ch = LayoutChange(**(tool_call.get("args") or {}))
    except Exception:  # noqa: BLE001
        return "Apply a layout change to the active concept."
    parts = []
    if ch.building_east_m or ch.building_north_m:
        parts.append(f"move the building {ch.building_east_m:+g} m east, {ch.building_north_m:+g} m north")
    if ch.rotate is not None:
        parts.append("rotate the building" if ch.rotate else "undo the building rotation")
    parts += [f"move {m.code} to ({m.x:g}, {m.y:g}) m" for m in ch.move]
    parts += [f"add {a.name or layout_engine.ADDED.get(a.type, (a.type.replace('yard_', ''),))[0].lower()} at ({a.x:g}, {a.y:g}) m" for a in ch.add]
    parts += [f"remove {c}" for c in ch.remove]
    return ("Design Editor wants to " + "; ".join(parts or ["change the layout"]) + f". Reason: {ch.reason} "
            "(positions from the site's south-west corner, x east, y north).")


def tools() -> dict[str, BaseTool]:
    meta = lambda d: {"tool_provider": "geostar", "display_name": d, "kind": "engine"}  # noqa: E731
    return {
        "layout_objects": StructuredTool.from_function(func=layout_objects, name="layout_objects", description=layout_objects.__doc__,
                                                       tags=["tool", "geostar", "design"], metadata=meta("GeoStar · Layout Objects")),
        "preview_layout_edit": StructuredTool.from_function(func=preview_layout_edit, name="preview_layout_edit",
                                                            description=preview_layout_edit.__doc__, args_schema=LayoutChange,
                                                            tags=["tool", "geostar", "design"], metadata=meta("GeoStar · Preview Layout Edit")),
        "apply_layout_edit": StructuredTool.from_function(func=apply_layout_edit, name="apply_layout_edit",
                                                          description=apply_layout_edit.__doc__, args_schema=LayoutChange,
                                                          tags=["tool", "geostar", "design", "action"],
                                                          metadata={**meta("Action / Apply Layout Edit (needs approval)"), "kind": "action"}),
    }


SPEC: dict[str, Any] = dict(
    name="design-editor", title="Design Editor",
    role="Changes the layout itself: moves, adds, removes and rotates objects. Every change needs a person's approval.",
    description="Edits the active concept's layout through the Studio edit contract: move the building or a yard item, "
                "rotate the building, add plant (battery, solar canopy, water tank, parking, noise wall, trees, gatehouse, "
                "fence, extra heat rejection, sensors, custom objects) or remove items. Previews each change with the layout "
                "engine, then applies it only after a person approves.",
    tools=["layout_objects", "preview_layout_edit", "apply_layout_edit"],
    prompt="You are GeoStar's Design Editor agent. Goal: make the layout change the user asked for, safely. Steps: call "
           "layout_objects to see the site, building and yard objects (metres, origin at the site's SOUTH-WEST corner, x east, "
           "y north; an item's x, y is its south-west corner). Choose positions inside the site and its setback that do not "
           "overlap other objects. Call preview_layout_edit with the change; if a check fails or the engine did not take the "
           "change, adjust and preview again (at most twice). Then call apply_layout_edit with the same change and a reason "
           "quoting the previewed numbers; a person approves or rejects it. If it is rejected, report that nothing changed. "
           "Report what changed, with the numbers from the tools.",
    interrupt_on={"apply_layout_edit": {"allowed_decisions": ["approve", "reject"], "description": describe}},
)

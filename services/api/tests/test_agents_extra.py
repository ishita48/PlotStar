"""CoStar citations, the Design Editor (with its human-in-the-loop interrupt) and the visible debate.

Offline: fake chat models replay scripted messages and the debate's model call is replaced, so the graph wiring,
callbacks, interrupts, engine runs and checks are the real code."""
from __future__ import annotations

import threading
import time

import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

from app.sponsors.langchain import copilot
from app.sponsors.langchain.deep_agents import agents, citations, debate, design_agent, runtime
from app.sponsors.langchain.deep_agents.runtime import CURRENT, ORCHESTRATOR, Run

GRID = {"price": [30 + (i % 12) * 3 for i in range(24)], "carbon": [350 + (i % 6) * 20 for i in range(24)]}
SITE = {"id": "costar:1", "gates": [{"gate": "Residential proximity", "status": "Pass", "value": 400},
                                    {"gate": "Grid proximity", "status": "Pass", "value": 1.5}]}
BRIEF = dict(mw_it=20, rack_kw=20, redundancy="N+1", cooling="liquid", site_w=320, site_d=240, setback_m=8,
             expansion_pct=10, flexible_share=0, storeys=1)


class FakeModel(GenericFakeChatModel):
    def bind_tools(self, tools, **kw):
        return self


def _run(kind: str = "conversation") -> Run:
    req = dict(brief=dict(BRIEF), site=dict(SITE), priorities={}, assumptions={}, edits={}, concept_id=None, market="Houston")
    run = Run(kind, "test", req)
    run.ctx = copilot.Ctx(req, lambda: GRID)
    return run


# ------------------------------------------------------------------------------------------------ citations

def test_citations_tie_costar_figures_to_record_and_field():
    ev = {
        "E1": dict(tool="get_property_intelligence", provider="costar-mcp", label="Sourced", sources=["row 9"], data={
            "parcel_id": "costar:42", "sections": {"building": {"ok": True, "data": {"facts": [
                {"key": "lot_acres", "label": "Lot (acres)", "value": 50.0, "tag": "Sourced"},
                {"key": "building_sf", "label": "Building area (sf)", "value": 1230097.0, "tag": "Sourced"},
                {"key": "stories", "label": "Stories", "value": 1, "tag": "Sourced"}]}}}}),
        "E2": dict(tool="screen_site", provider="geostar", data={"value": 50.0}),
    }
    out = citations.cite(ev, "The lot is 50 acres with a 1.23 million sf building on 1 storey (E1). Score 77.")
    figs = {(c["record_id"], c["field"]) for c in out if c["kind"] == "figure"}
    assert ("costar:42", "lot_acres") in figs and ("costar:42", "building_sf") in figs
    assert all(c["record_id"] == "costar:42" for c in out)           # the GeoStar tool's 50 is not a CoStar citation
    assert not any(c["field"] == "stories" for c in out)              # small counts are not matched by chance
    assert any(c["kind"] == "evidence" and c["evidence_id"] == "E1" for c in out)
    assert next(c for c in out if c["field"] == "lot_acres")["audit"] is True


def test_citations_skip_record_ids_and_geostar_thresholds():
    ev = {"E1": dict(tool="evaluate_conversion", provider="costar-mcp", data={
        "parcel_id": "costar:629861", "costar_property_id": 629861, "building_sf": 12640.0, "min_building_sf_dc": 20000,
        "coverage": 11.2, "rent_per_sf_year": 14.5})}
    out = citations.cite(ev, "costar:629861 has a 12,640 sf building (needs 20,000 sf, coverage 11.2%) asking $14.50 per sf.")
    assert {(c["figure"], c["field"]) for c in out if c["kind"] == "figure"} == {("12,640", "building_sf"), ("14.50", "rent_per_sf_year")}


def test_citations_are_empty_without_costar_evidence():
    assert citations.cite({"E1": dict(tool="grid_conditions", provider="geostar", data={"x": 5})}, "5 MW") == []


# ------------------------------------------------------------------------------------------------ design editor

def test_merge_follows_the_edit_contract():
    concept = {"yard": [{"code": "SUB-01"}, {"code": "GEN"}]}
    ch = design_agent.LayoutChange(reason="r", building_east_m=5, move=[design_agent.Move(code="SUB-01", x=10, y=20)],
                                   add=[design_agent.Add(type="yard_bess", x=30, y=40), design_agent.Add(type="custom", x=1, y=2, name="Shed", h=3)],
                                   remove=["GEN"])
    e, new = design_agent.merge(None, ch, concept)
    assert e["building"] == {"dx": 5.0, "dy": 0.0}
    assert e["yard"] == {"SUB-01": {"x": 10, "y": 20}} and e["removed"] == ["GEN"]
    assert new == ["AI-BESS-1", "AI-OBJ-1"]
    bess = e["added"][0]
    assert (bess["type"], bess["w"], bess["d"], bess["source"]) == ("yard_bess", 26, 12, "Design Editor agent (approved)")
    assert e["added"][1]["name"] == "Shed" and e["added"][1]["h"] == 3
    e2, _ = design_agent.merge(e, design_agent.LayoutChange(reason="r", remove=["AI-BESS-1"]), concept)
    assert [a["code"] for a in e2["added"]] == ["AI-OBJ-1"] and e2["removed"] == ["GEN"]


def test_preview_runs_the_engine_on_the_active_concept_without_applying():
    run = _run()
    tok = CURRENT.set(run)
    try:
        cid = run.ctx.concept()["id"]
        c = run.ctx.concept()
        b = c["building"]
        o = design_agent._evaluate(design_agent.LayoutChange(
            reason="test", add=[design_agent.Add(type="yard_water", x=12, y=12, w=10, d=10)]))
    finally:
        CURRENT.reset(tok)
    assert o["ok"] and o["concept_id"] == cid
    assert o["added"] == ["AI-TANK-1"]
    assert {"change": "add AI-TANK-1", "applied": True} in o["applied"]
    assert any(r["metric"] == "Cost to build" for r in o["consequences"]["changed"]), "an added tank is costed"
    assert run.design_edits == [] and b["w"] > 0


def test_design_edit_waits_for_approval_then_streams_the_edit(monkeypatch):
    """The real subagent spec (interrupt_on) inside a Deep Agents graph, driven by agents._execute."""
    from deepagents import create_deep_agent
    from langgraph.checkpoint.memory import InMemorySaver
    run = _run()
    args = {"reason": "Add water storage in the free south-west corner.", "add": [{"type": "yard_water", "x": 12, "y": 12, "w": 10, "d": 10}]}
    orch = FakeModel(messages=iter([
        AIMessage("", tool_calls=[{"name": "task", "id": "t1", "args": {"description": "add a tank", "subagent_type": "design-editor"}}]),
        AIMessage("The tank was added after your approval."),
    ]))
    sub = FakeModel(messages=iter([
        AIMessage("", tool_calls=[{"name": "apply_layout_edit", "id": "s1", "args": args}]),
        AIMessage("Applied."),
    ]))
    runtime.AGENT_INFO.setdefault(ORCHESTRATOR, {"title": "PlotStar Orchestrator"})
    T = design_agent.tools()
    spec = dict(name="design-editor", description="d", system_prompt="x", tools=[T["apply_layout_edit"]], model=sub,
                interrupt_on=design_agent.SPEC["interrupt_on"])
    g = create_deep_agent(model=orch, tools=[], subagents=[spec], checkpointer=InMemorySaver(), name=ORCHESTRATOR)
    monkeypatch.setattr(agents, "graph", lambda: g)
    monkeypatch.setattr(agents, "verify", lambda r: {"grounded": True})
    th = threading.Thread(target=agents._execute, args=(run, "add a tank", "t-design", "PlotStar / Test", "Explore"))
    th.start()
    for _ in range(200):
        if run.status == "awaiting_approval":
            break
        time.sleep(0.05)
    assert run.status == "awaiting_approval"
    assert run.design_edits == [], "nothing applies before approval"
    act = run.approval["actions"][0]
    assert act["name"] == "apply_layout_edit" and "add water storage at (12, 12) m" in act["description"]
    run.decide(True)
    th.join(30)
    assert run.status == "done", run.error
    rec = run.design_edits[0]
    assert rec["concept_id"] == run.ctx.concept()["id"]
    assert rec["edit"]["added"][0]["code"] == "AI-TANK-1"
    assert any(e["type"] == "design_edit" for e in run.events)
    boxes = [n for n in run.nodes.values() if n["kind"] == "agent" and n["name"] == "design-editor"]
    assert len(boxes) == 1 and boxes[0]["status"] == "done", "a resumed delegation keeps its one box in the live graph"


def test_rejected_design_edit_changes_nothing(monkeypatch):
    from deepagents import create_deep_agent
    from langgraph.checkpoint.memory import InMemorySaver
    run = _run()
    orch = FakeModel(messages=iter([
        AIMessage("", tool_calls=[{"name": "task", "id": "t1", "args": {"description": "remove", "subagent_type": "design-editor"}}]),
        AIMessage("Nothing changed."),
    ]))
    sub = FakeModel(messages=iter([
        AIMessage("", tool_calls=[{"name": "apply_layout_edit", "id": "s1", "args": {"reason": "r", "remove": ["CY-01"]}}]),
        AIMessage("Rejected; nothing changed."),
    ]))
    spec = dict(name="design-editor", description="d", system_prompt="x", tools=[design_agent.tools()["apply_layout_edit"]], model=sub,
                interrupt_on=design_agent.SPEC["interrupt_on"])
    g = create_deep_agent(model=orch, tools=[], subagents=[spec], checkpointer=InMemorySaver(), name=ORCHESTRATOR)
    monkeypatch.setattr(agents, "graph", lambda: g)
    monkeypatch.setattr(agents, "verify", lambda r: {"grounded": True})
    th = threading.Thread(target=agents._execute, args=(run, "remove", "t-design-2", "PlotStar / Test", "Explore"))
    th.start()
    for _ in range(200):
        if run.status == "awaiting_approval":
            break
        time.sleep(0.05)
    run.decide(False, "No.")
    th.join(30)
    assert run.status == "done" and run.design_edits == []


def test_design_editor_is_registered_with_its_interrupt():
    spec = next(s for s in agents.SPECIALISTS if s["name"] == "design-editor")
    assert "apply_layout_edit" in spec["interrupt_on"]
    assert runtime.AGENT_INFO["design-editor"]["title"] == "Design Editor"
    assert "design-editor" in agents.ORCH_PROMPT


# ------------------------------------------------------------------------------------------------ debate

def test_fact_sheet_is_engine_numbers_with_owners():
    run = _run("debate")
    facts = debate.fact_sheet(run.ctx.base, GRID)
    assert {f["owner"] for f in facts} >= {"finance", "community", "grid"}
    assert [f["id"] for f in facts] == [f"F{i + 1}" for i in range(len(facts))]
    npv = next(f for f in facts if f["metric"] == "npv_p50")
    c = next(c for c in run.ctx.base["concepts"] if c["id"] == npv["concept_id"])
    assert npv["value"] == c["money"]["npv_p50"]
    assert not any(f["metric"] == "land_cost" for f in facts)


def test_check_claim_flags_numbers_not_in_the_cited_facts():
    facts = {"F1": dict(id="F1", text="61.1 dBA at the boundary", value=61.1)}
    assert debate.check_claim("It gives 61.1 dBA (F1).", ["F1"], facts)["grounded"]
    assert debate.check_claim("61.1 dBA [F1]; C12 and C17 said the same.", ["F1"], facts)["grounded"], "claim ids are not figures"
    bad = debate.check_claim("It gives 55.0 dBA.", ["F1"], facts)
    assert not bad["grounded"] and bad["unverified_numbers"] == ["55.0"]
    assert not debate.check_claim("Quiet.", ["F9"], facts)["grounded"]


def _drive(run: Run) -> None:
    run.ctx  # noqa: B018
    debate.execute(run, "Which concept?")


def test_rule_based_debate_runs_two_rounds_and_draws_the_graph(monkeypatch):
    monkeypatch.setattr(debate.config, "ANTHROPIC_API_KEY", "")
    run = _run("debate")
    _drive(run)
    assert run.status == "done", run.error
    d = run.debate
    assert d["mode"] == "rule-based" and len(d["rounds"]) == 2
    assert all(len(r["turns"]) == 3 for r in d["rounds"])
    assert all(c["grounded"] for r in d["rounds"] for t in r["turns"] for c in t["claims"])
    assert d["summary"]["recommendation"] in {c["id"] for c in d["concepts"]}
    agents_drawn = [n for n in run.nodes.values() if n["kind"] == "agent" and n["name"] != ORCHESTRATOR]
    assert len(agents_drawn) == 6, [n["name"] for n in run.nodes.values()]   # three specialists x two rounds
    assert run.answer.startswith("**Recommendation:")


def test_model_debate_checks_each_claim(monkeypatch):
    monkeypatch.setattr(debate.config, "ANTHROPIC_API_KEY", "set")
    run = _run("debate")
    calls: list[str] = []

    def fake_ask(slug, model, system, user, schema):
        calls.append(slug)
        facts = debate.fact_sheet(run.ctx.base, GRID)
        f = next(x for x in facts if x["metric"] == "noise_at_boundary_dba")
        if schema is debate.Summary:
            return debate.Summary(recommendation=f["concept_id"], summary=f"Build it: {f['text']} [{f['id']}].", facts=[f["id"]])
        return debate.Turn(position=f["concept_id"], claims=[
            debate.Claim(text=f"{f['text']} [{f['id']}].", facts=[f["id"]]),
            debate.Claim(text="It saves 999,999 dollars.", facts=[f["id"]])])

    monkeypatch.setattr(debate, "ask", fake_ask)
    _drive(run)
    assert run.status == "done", run.error
    assert len(calls) == 7 and calls[-1] == ORCHESTRATOR
    claims = [c for r in run.debate["rounds"] for t in r["turns"] for c in t["claims"]]
    assert sum(c["grounded"] for c in claims) == 6 and sum(not c["grounded"] for c in claims) == 6
    assert run.debate["summary"]["grounded"]


@pytest.fixture(autouse=True)
def _reset_debate_graph():
    debate._GRAPH.clear()
    yield

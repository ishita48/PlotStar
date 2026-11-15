"""A visible debate: the finance, community and grid specialists argue which concept to build, in rounds, and the
orchestrator sums up. Every claim must cite facts from a fact sheet computed by GeoStar's engines; each claim's numbers
are checked against the facts it cites, and the check is shown next to the claim.

    fact sheet (deterministic)  layout_engine.generate for the three concepts (money, people, planet, resources) plus
                                the site's gate values and the ERCOT grid day. Ids F1, F2, ... Each fact names its owner.
    round 1  opening            each specialist backs one concept with 1-3 claims, citing fact ids
    round 2  rebuttal           each specialist answers the others' round-1 claims (concede or rebut), citing fact ids
    summary                     the orchestrator weighs the claims and recommends a concept, citing fact ids

Built as a LangGraph StateGraph (parallel fan-out per round, a join, a conditional loop back) and run with the same
Recorder as the Deep Agents runs, so the live graph shows one box per specialist per round and every model call.
LangSmith traces it like any other run. Seven small model calls in all (Haiku for the specialists, the orchestrator
model for the summary). Without ANTHROPIC_API_KEY it runs rule-based (each specialist backs the concept best on its own
metric, with template claims), labelled as such.

The fact sheet holds GeoStar-computed figures only; no CoStar names, addresses, prices or rents (land price is left out
unless COPILOT_LLM_COSTAR=1).
"""
from __future__ import annotations

import operator
import os
import re
import threading
from typing import Annotated, Any, Literal, TypedDict

from pydantic import BaseModel, Field, field_validator

from app import config
from app.sponsors.langchain.deep_agents.runtime import AGENT_INFO, CURRENT, LLM_COSTAR, ORCHESTRATOR, Recorder, Run, register

SPEAKERS = {
    "financial-feasibility": dict(lens="finance", ask="Which concept makes the best investment? Weigh NPV, cost to build, ten-year cost, payback and months to power."),
    "community-sustainability": dict(lens="community", ask="Which concept is best for the neighbours and the environment? Weigh noise at the boundary and at homes, generator distance, carbon and water."),
    "resource-infrastructure": dict(lens="grid", ask="Which concept is easiest to power and cool? Weigh facility load, power and cooling route length, substation distance, energy use and battery storage."),
}
ROUNDS = 2
SUB_MODEL = os.getenv("PLOTSTAR_SUBAGENT_MODEL", "claude-haiku-5-5")
ORCH_MODEL = os.getenv("PLOTSTAR_AGENT_MODEL", "claude-sonnet-5-5")
_NUM = re.compile(r"-?\d[\d,]*(?:\.\d+)?")


# ------------------------------------------------------------------------------------------------ the fact sheet

def _usd(v: float) -> str:
    return f"${v / 1e6:,.1f}M" if abs(v) >= 1e6 else f"${v:,.0f}"


def fact_sheet(base: dict[str, Any], grid: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Facts F1.. from one engine result. Pure: the same input gives the same ids."""
    facts: list[dict[str, Any]] = []

    def add(owner: str, concept: dict | None, metric: str, value: Any, unit: str, text: str, label: str = "Estimated") -> None:
        if value is None:
            return
        facts.append(dict(id=f"F{len(facts) + 1}", owner=owner, concept_id=concept["id"] if concept else None,
                          concept=concept["name"] if concept else "Site", metric=metric, value=value, unit=unit, text=text, label=label))

    for c in sorted(base["concepts"], key=lambda c: c["rank"]):
        m, p, pl, r, mt = c["money"], c["people"], c["planet"], c["resources"], c["metrics"]
        add("finance", c, "npv_p50", m.get("npv_p50", m.get("npv")), "USD", f"NPV P50 {_usd(m.get('npv_p50', m.get('npv')))}", "Simulated")
        add("finance", c, "capex", m["capex"], "USD", f"cost to build {_usd(m['capex'])}")
        add("finance", c, "ten_year", m.get("ten_year"), "USD", f"ten-year cost {_usd(m.get('ten_year') or 0)}")
        add("finance", c, "payback_years", m.get("payback_years"), "years", f"payback {m.get('payback_years')} years")
        add("finance", c, "months_to_power", m.get("months_to_power"), "months", f"{m.get('months_to_power')} months to power")
        add("community", c, "noise_at_boundary_dba", p.get("noise_at_boundary_dba"), "dBA", f"{p.get('noise_at_boundary_dba')} dBA at the boundary")
        add("community", c, "noise_at_home_dba", p.get("noise_at_home_dba"), "dBA", f"{p.get('noise_at_home_dba')} dBA at the nearest home")
        add("community", c, "generator_to_boundary_m", p.get("generator_to_boundary_m"), "m", f"generators {p.get('generator_to_boundary_m')} m from the boundary")
        add("community", c, "co2_t_per_year", pl.get("co2_t_per_year"), "t CO2/yr", f"{pl.get('co2_t_per_year'):,} t CO2 a year")
        add("community", c, "water_m3_per_year", r.get("water_m3_per_year"), "m3/yr", f"{r.get('water_m3_per_year'):,} m3 water a year")
        add("grid", c, "power_route_m", mt.get("power_route_m"), "m", f"{mt.get('power_route_m'):,} m of power route")
        add("grid", c, "cooling_route_m", mt.get("cooling_route_m"), "m", f"{mt.get('cooling_route_m'):,} m of cooling route")
        add("grid", c, "energy_mwh_per_year", r.get("energy_mwh_per_year"), "MWh/yr", f"{r.get('energy_mwh_per_year'):,} MWh a year")
        add("grid", c, "spare_positions", r.get("spare_positions"), "racks", f"{r.get('spare_positions')} spare rack positions")
        add("all", c, "rank", c["rank"], "", f"rank {c['rank']} on the user's priorities ({c.get('score')} points)")
        failed = [k["name"] for k in c["checks"] if not k["ok"]]
        add("all", c, "failed_checks", len(failed), "checks", f"{len(failed)} failed checks" + (f" ({', '.join(failed)})" if failed else ""))
    br, site = base["brief"], base.get("site") or {}
    add("grid", None, "facility_mw", br.get("facility_mw"), "MW", f"{br.get('facility_mw')} MW facility load (all concepts)")
    add("grid", None, "substation_km", site.get("substation_km"), "km", f"nearest >= 138 kV substation {site.get('substation_km')} km away", "Sourced")
    add("community", None, "home_distance_m", site.get("home_distance_m"), "m", f"nearest home {site.get('home_distance_m')} m from the site", "Sourced")
    if LLM_COSTAR and site.get("land_cost"):
        add("finance", None, "land_cost", site["land_cost"], "USD", f"land {_usd(site['land_cost'])} ({site.get('land_label')})", site.get("land_label") or "Sourced")
    p = (grid or {}).get("price") or []
    if p:
        add("grid", None, "price_mean", round(sum(p) / len(p), 1), "USD/MWh", f"ERCOT mean ${sum(p) / len(p):.1f}/MWh", "Sourced")
    return facts


def _values(f: dict[str, Any]) -> set[float]:
    out = {float(n.replace(",", "")) for n in _NUM.findall(f["text"])}
    if isinstance(f["value"], (int, float)):
        v = float(f["value"])
        out |= {v, v / 1e6, v / 1e3, round(v / 1e6, 1)}
    return out


def check_claim(text: str, fact_ids: list[str], facts: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """A claim is grounded when it cites at least one known fact and every number in it matches a cited fact."""
    known = [i for i in fact_ids if i in facts]
    pool = set().union(*(_values(facts[i]) for i in known)) if known else set()
    stray = []
    for n in _NUM.findall(re.sub(r"\b[FC]\d+\b", "", text)):  # fact ids and claim ids are references, not figures
        x = float(n.replace(",", ""))
        if abs(x) <= 10 and x.is_integer():
            continue
        if not any(abs(abs(x) - abs(y)) <= max(0.051, 0.006 * abs(y)) for y in pool):
            stray.append(n)
    return dict(grounded=bool(known) and not stray, unknown_facts=[i for i in fact_ids if i not in facts], unverified_numbers=stray[:6])


# ------------------------------------------------------------------------------------------------ structured turns

class Claim(BaseModel):
    text: str = Field(..., description="One sentence. Quote figures exactly as the fact sheet writes them.")
    facts: list[str] = Field(default_factory=list, description="Fact ids the claim rests on, e.g. ['F3', 'F12']")
    stance: Literal["support", "rebut", "concede"] = "support"
    responds_to: str | None = Field(None, description="In round 2: the id of the claim you answer, e.g. C2")

    @field_validator("facts", mode="before")
    @classmethod
    def _ids(cls, v: Any) -> list[str]:
        if isinstance(v, str):
            v = re.findall(r"F\d+", v)
        return [str(x).strip() for x in (v or [])][:6]


class Turn(BaseModel):
    position: str = Field(..., description="The concept id you back")
    claims: list[Claim] = Field(default_factory=list, description="One to three claims")

    @field_validator("claims", mode="after")
    @classmethod
    def _three(cls, v: list[Claim]) -> list[Claim]:
        return v[:3]  # tolerant at the boundary: a fourth claim is dropped, not a validation error


class Summary(BaseModel):
    recommendation: str = Field(..., description="The concept id recommended")
    summary: str = Field("", description="Three or four sentences weighing the arguments; cite fact ids in brackets")
    agreements: list[str] = Field(default_factory=list)
    open_disagreements: list[str] = Field(default_factory=list)
    facts: list[str] = Field(default_factory=list)


def _model(slug: str, model: str) -> Any:
    from langchain_anthropic import ChatAnthropic
    info = AGENT_INFO.get(slug, {})
    return ChatAnthropic(model=model, max_tokens=1600 if slug == ORCHESTRATOR else 900, timeout=60, max_retries=2, name=f"Model / {info.get('title', slug)}",
                         tags=["model", f"agent:{slug}", "debate"],
                         metadata={"agent_name": slug, "model_provider": "anthropic", "model_name": model})


def ask(slug: str, model: str, system: str, user: str, schema: type[BaseModel]) -> BaseModel:
    """One structured model call. Replaced in tests."""
    return _model(slug, model).with_structured_output(schema).invoke([("system", system), ("human", user)])


def _sheet_text(facts: list[dict[str, Any]], lens: str | None = None) -> str:
    rows = [f"{f['id']} [{f['concept_id'] or 'site'} · {f['owner']}] {f['concept']}: {f['text']} ({f['label']})"
            for f in facts if lens is None or f["owner"] in (lens, "all") or f["concept_id"] is None]
    return "\n".join(rows)


# ------------------------------------------------------------------------------------------------ rule-based turns

_BEST = {"finance": ("npv_p50", max), "community": ("noise_at_boundary_dba", min), "grid": ("power_route_m", min)}


def rule_turn(lens: str, facts: list[dict[str, Any]], rnd: int, others: list[dict[str, Any]]) -> Turn:
    metric, pick = _BEST[lens]
    cands = [f for f in facts if f["metric"] == metric and f["concept_id"]]
    best = pick(cands, key=lambda f: f["value"])
    claims = [Claim(text=f"{best['concept']} is strongest on {metric.replace('_', ' ')}: {best['text']}.", facts=[best["id"]])]
    for f in cands:
        if f is not best:
            claims.append(Claim(text=f"{f['concept']} gives {f['text']}.", facts=[f["id"]], stance="rebut" if rnd > 1 else "support"))
            break
    if rnd > 1 and others:
        o = next((c for t in others for c in t["claims"] if t["position"] != best["concept_id"]), None)
        if o:
            claims.append(Claim(text=f"On {lens}, {best['concept']} still leads: {best['text']}.", facts=[best["id"]],
                                stance="rebut", responds_to=o["id"]))
    return Turn(position=best["concept_id"], claims=claims[:3])


def rule_summary(debate: dict[str, Any]) -> Summary:
    votes: dict[str, int] = {}
    for t in debate["rounds"][-1]["turns"]:
        votes[t["position"]] = votes.get(t["position"], 0) + 1
    rank1 = next(f for f in debate["facts"] if f["metric"] == "rank" and f["value"] == 1)
    top = max(votes.items(), key=lambda kv: (kv[1], kv[0] == rank1["concept_id"]))[0]
    return Summary(recommendation=top, summary=f"{votes[top]} of 3 specialists back {top} after two rounds. "
                   f"On the user's priorities, {rank1['concept']} has {rank1['text']} [{rank1['id']}].", facts=[rank1["id"]])


# ------------------------------------------------------------------------------------------------ the graph

class State(TypedDict, total=False):
    round: int
    turns: Annotated[list[dict[str, Any]], operator.add]
    summary: dict[str, Any] | None


def _publish(run: Run) -> None:
    run.emit("debate", debate=run.debate)


def _speaker(slug: str):
    lens = SPEAKERS[slug]["lens"]

    def node(state: State) -> dict[str, Any]:
        run = CURRENT.get()
        assert run is not None
        d = run.debate
        rnd = state.get("round", 1)
        facts = {f["id"]: f for f in d["facts"]}
        prev = [t for t in state.get("turns", []) if t["round"] == rnd - 1 and t["agent"] != slug]
        if d["mode"] == "rule-based":
            turn = rule_turn(lens, d["facts"], rnd, prev)
        else:
            system = (f"You are GeoStar's {AGENT_INFO.get(slug, {}).get('title', slug)} specialist in a design debate. "
                      f"{SPEAKERS[slug]['ask']} Use ONLY the fact sheet: every claim cites fact ids (F1, F2, ...) and quotes "
                      "their figures exactly; never compute or invent a number. Back one concept id. One to three claims, "
                      "each one sentence.")
            user = (f"Question: {d['question']}\nConcepts: " + ", ".join(f"{c['id']} ({c['name']})" for c in d["concepts"])
                    + f"\n\nFact sheet:\n{_sheet_text(d['facts'])}\n\nRound {rnd} of {ROUNDS}: "
                    + ("give your opening position." if rnd == 1 else
                       "answer the other specialists' claims below: rebut or concede each one you address, set responds_to "
                       "to its claim id, and you may change your position.\n"
                       + "\n".join(f"{c['id']} ({t['title']}, backs {t['position']}): {c['text']} [{', '.join(c['facts'])}]"
                                   for t in prev for c in t["claims"])))
            turn = ask(slug, SUB_MODEL, system, user, Turn)
        ids = {c["id"] for c in d["concepts"]}
        position = turn.position if turn.position in ids else next(
            (facts[i]["concept_id"] for c in turn.claims for i in c.facts if i in facts and facts[i]["concept_id"]), d["concepts"][0]["id"])
        with run.lock:
            n0 = sum(len(t["claims"]) for r in d["rounds"] for t in r["turns"])
            claims = [dict(id=f"C{n0 + k + 1}", text=c.text, facts=c.facts, stance=c.stance, responds_to=c.responds_to,
                           **check_claim(c.text, c.facts, facts)) for k, c in enumerate(turn.claims)]
            t = dict(round=rnd, agent=slug, title=AGENT_INFO.get(slug, {}).get("title", slug), lens=lens, position=position,
                     position_name=next(c["name"] for c in d["concepts"] if c["id"] == position), claims=claims)
            while len(d["rounds"]) < rnd:
                d["rounds"].append(dict(round=len(d["rounds"]) + 1, turns=[]))
            d["rounds"][rnd - 1]["turns"].append(t)
            node_ = next((n for n in reversed(list(run.nodes.values())) if n["kind"] == "agent" and n["name"] == slug), None)
            if node_ is not None:
                node_["objective"] = f"Debate round {rnd}: {'opening' if rnd == 1 else 'rebuttal'} ({lens})"
        _publish(run)
        return {"turns": [t]}

    return node


def _moderator(state: State) -> dict[str, Any]:
    run = CURRENT.get()
    assert run is not None
    d = run.debate
    rnd = state.get("round", 1)
    if rnd < ROUNDS:
        return {"round": rnd + 1}
    facts = {f["id"]: f for f in d["facts"]}
    if d["mode"] == "rule-based":
        s = rule_summary(d)
    else:
        claims = "\n".join(f"{c['id']} round {t['round']} {t['title']} backs {t['position']} ({c['stance']}"
                           + (f" to {c['responds_to']}" if c.get("responds_to") else "") + f"): {c['text']} [{', '.join(c['facts'])}]"
                           + ("" if c["grounded"] else " (UNVERIFIED)") for r in d["rounds"] for t in r["turns"] for c in t["claims"])
        s = ask(ORCHESTRATOR, ORCH_MODEL,
                "You are the PlotStar orchestrator. Weigh the specialists' debate and recommend one concept id. Use only "
                "figures from the fact sheet, quoted exactly, with fact ids in brackets. Discount claims marked UNVERIFIED.",
                f"Question: {d['question']}\n\nFact sheet:\n{_sheet_text(d['facts'])}\n\nClaims:\n{claims}\n\n"
                "Fill every field: recommendation, summary (3-4 sentences), agreements, open_disagreements, facts.", Summary)
        if not s.summary.strip():  # the model left the prose out: say so, and fall back to the vote count
            fb = rule_summary(d)
            s = s.model_copy(update={"summary": fb.summary + " (The orchestrator's summary came back empty; this is the vote count.)",
                                     "facts": s.facts or fb.facts})
        s = s.model_copy(update={"agreements": s.agreements[:3], "open_disagreements": s.open_disagreements[:3]})
    ids = {c["id"] for c in d["concepts"]}
    rec = s.recommendation if s.recommendation in ids else next(
        (t["position"] for t in d["rounds"][-1]["turns"]), d["concepts"][0]["id"])
    cited = sorted(set(s.facts) | set(re.findall(r"\bF\d+\b", s.summary)), key=lambda x: int(x[1:]))
    summary = dict(recommendation=rec, recommendation_name=next(c["name"] for c in d["concepts"] if c["id"] == rec),
                   text=s.summary, agreements=s.agreements, open_disagreements=s.open_disagreements, facts=cited,
                   **check_claim(s.summary, cited, facts))
    with run.lock:
        d["summary"] = summary
    _publish(run)
    return {"summary": summary}


def _next(state: State) -> str | list[str]:
    from langgraph.graph import END
    return END if state.get("summary") else list(SPEAKERS)


_GRAPH: dict[str, Any] = {}
_LOCK = threading.Lock()


def graph() -> Any:
    with _LOCK:
        if "g" not in _GRAPH:
            from langgraph.graph import END, START, StateGraph
            g = StateGraph(State)
            for slug in SPEAKERS:
                g.add_node(slug, _speaker(slug))
                g.add_edge(START, slug)
            g.add_node("moderator", _moderator)
            g.add_edge(list(SPEAKERS), "moderator")
            g.add_conditional_edges("moderator", _next, [*SPEAKERS, END])
            _GRAPH["g"] = g.compile(name=ORCHESTRATOR)
        return _GRAPH["g"]


def start(req: dict[str, Any], question: str | None = None) -> Run:
    from app.sponsors.langchain.deep_agents.agents import _ctx
    q = question or "Which of the three concepts should we build on this site?"
    run = register(Run("debate", q[:120], req))
    run.ctx = _ctx(req)
    threading.Thread(target=execute, args=(run, q), name=f"debate-{run.id}", daemon=True).start()
    return run


def execute(run: Run, question: str) -> None:
    token = CURRENT.set(run)
    try:
        base = run.ctx.base
        facts = fact_sheet(base, run.ctx.grid())
        mode = "model" if config.ANTHROPIC_API_KEY else "rule-based"
        run.debate = dict(question=question, mode=mode, rounds=[], summary=None, facts=facts,
                          concepts=[dict(id=c["id"], name=c["name"], rank=c["rank"]) for c in sorted(base["concepts"], key=lambda c: c["rank"])],
                          note=("Specialists are Claude models arguing from the fact sheet." if mode == "model" else
                                "Rule-based (no ANTHROPIC_API_KEY): each specialist backs the concept best on its own metric."))
        run.emit("started", kind=run.kind, title=run.title, message=question)
        _publish(run)
        cfg = {"callbacks": [Recorder(run, "PlotStar / Debate")], "run_name": "PlotStar / Debate", "recursion_limit": 30,
               "tags": ["plotstar", "debate", "langgraph"], "metadata": {"run_kind": "debate", "scenario_id": run.id}}
        graph().invoke({"round": 1, "turns": [], "summary": None}, cfg)
        s = run.debate["summary"] or {}
        run.answer = f"**Recommendation: {s.get('recommendation_name')}.** {s.get('text', '')}"
        run.verification = dict(grounded=bool(s.get("grounded")), numbers_checked=len(_NUM.findall(s.get("text", ""))),
                                unverified_numbers=s.get("unverified_numbers", []), cited=s.get("facts", []), unknown_citations=[],
                                note=("Every figure in the summary matches a cited fact." if s.get("grounded") else
                                      "Some figures in the summary do not match the facts it cites."))
        run.emit("answer", answer=run.answer, verification=run.verification, proposal=None, citations=[])
        run.set_status("done")
    except Exception as e:  # noqa: BLE001
        run.error = f"{type(e).__name__}: {e}"
        run.emit("error", error=run.error)
        run.set_status("error")
    finally:
        CURRENT.reset(token)

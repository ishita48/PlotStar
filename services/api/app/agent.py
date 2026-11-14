"""The agent that explains each decision (PRD A-1, LangChain deep bet).

Rule: the optimizer decides, the model explains. The agent may only cite numbers returned by its tools.
With ANTHROPIC_API_KEY (or AWS credentials + BEDROCK_MODEL_ID) set, a LangChain Deep Agent runs with the
tools below. Without credentials, `explain()` returns a deterministic explanation built from the same tool
outputs, labeled model="deterministic", so the screen is never blank and nothing is invented.
"""
from __future__ import annotations

import json
import os
from typing import Any

from . import config
from . import grid as G
from . import optimizer as O
from .db import session

SYSTEM = (
    "You are PlotStar's explainer for data-center siting. The optimizer has already decided; your job is to explain "
    "the decision in plain language for a non-expert in under 180 words. Use ONLY numbers returned by your tools, "
    "quote them with their labels (Sourced / Estimated / Simulated), and say what is a scenario assumption. "
    "Never invent prices, capacities or savings. If a question needs a number you do not have, say so."
)


# ----------------------------------------------------------------------------- tools (plain functions)

def tool_get_run(run_id: str) -> dict[str, Any]:
    """Optimizer run: PlotStar pick vs cost-first pick, deltas, rejected sites, grid-day labels."""
    loaded = O.load_run(run_id)
    if not loaded:
        return {"error": "unknown run_id"}
    req, res = loaded
    slim = lambda c: None if not c else {k: c[k] for k in (  # noqa: E731
        "site_id", "site_name", "cooling", "f", "d", "firm_capacity_share", "firm_capacity_basis", "land",
        "energy_cost_year", "co2_est_t_year", "peak_mw", "cost", "stress_hours")}
    return {"request": {k: req.get(k) for k in ("mw_it", "flexible_share", "price_multiplier", "carbon_price_per_t", "market")},
            "optimized": slim(res["optimized"]), "baseline": slim(res["baseline"]), "delta": res["delta"],
            "rejected": res["rejected"][:8], "labels": res["labels"], "notes": res["feasibility_notes"],
            "grid": {k: res["grid"].get(k) for k in ("price_label", "carbon_label", "price_date", "carbon_date", "hub")}}


def tool_site_checks(parcel_id: str) -> dict[str, Any]:
    """Hard-gate results and power signals for one CoStar parcel (from the last search that screened it)."""
    with session() as c:
        row = c.execute("SELECT name, address, lot_acres, availability, asking_price_low, last_sale_price, "
                        "last_sale_status FROM parcels WHERE parcel_id = ?", (parcel_id,)).fetchone()
    return dict(row) if row else {"error": "unknown parcel"}


def tool_grid_day() -> dict[str, Any]:
    """The cached ERCOT day: hourly prices (Sourced) and carbon proxy (Estimated), with min/max hours."""
    gd = G.grid_day(offline=True)
    p, cb = gd["price"], gd["carbon"]
    return {"hub": gd["hub"], "price_label": gd["price_label"], "price_date": gd["price_date"],
            "cheapest_hour": int(min(range(24), key=lambda h: p[h])), "dearest_hour": int(max(range(24), key=lambda h: p[h])),
            "price_min": min(p), "price_max": max(p), "carbon_label": gd["carbon_label"],
            "cleanest_hour": int(min(range(24), key=lambda h: cb[h])), "dirtiest_hour": int(max(range(24), key=lambda h: cb[h])),
            "carbon_min": min(cb), "carbon_max": max(cb)}


TOOLS = {"get_run": tool_get_run, "site_checks": tool_site_checks, "grid_day": tool_grid_day}


# ----------------------------------------------------------------------------- deterministic explainer

def _h(h: int) -> str:
    return "12 am" if h == 0 else "12 pm" if h == 12 else f"{h} am" if h < 12 else f"{h - 12} pm"


def deterministic(run_id: str, question: str | None) -> dict[str, Any]:
    trace = []
    run = tool_get_run(run_id)
    trace.append({"tool": "get_run", "args": {"run_id": run_id}, "ok": "error" not in run})
    if "error" in run:
        return {"answer": "I don't have that run. Search again and ask about the new result.", "trace": trace, "model": "deterministic"}
    gd = tool_grid_day()
    trace.append({"tool": "grid_day", "args": {}, "ok": True})
    o, b, d, r = run["optimized"], run["baseline"], run["delta"], run["request"]
    if not o:
        return {"answer": "No site can run this project with the current limits. Loosen a must-have or lower the MW and search again.",
                "trace": trace, "model": "deterministic"}
    parts = [f"PlotStar picks {o['site_name']} for {r['mw_it']:g} MW: {o['cooling']} cooled, "
             + (f"easing off {o['d']:.0%} of load for about {o['f'] * 8760:.0f} hours a year when the grid is stressed. "
                if o["f"] > 0 else "full power all year. ")]
    parts.append(f"Heavy jobs move into the cleanest, cheapest hours: on the ERCOT {gd['price_date']} day ({gd['price_label']}) "
                 f"power is cheapest around {_h(gd['cheapest_hour'])} (${gd['price_min']:.0f}/MWh) and cleanest around "
                 f"{_h(gd['cleanest_hour'])} ({gd['carbon_min']:.0f} kg/MWh, {gd['carbon_label']}), "
                 f"against {gd['carbon_max']:.0f} kg/MWh at the dirtiest hour.")
    if b and d:
        if d["same_site"]:
            parts.append(f"The cost-first method picks the same site, so the difference is how it runs: about "
                         f"{d['co2_est_t_year']:,.0f} t less CO₂ a year and ${abs(d['cost']):,.0f} "
                         f"{'less' if d['cost'] >= 0 else 'more'} over ten years (Estimated).")
        else:
            parts.append(f"Cost-first would pick {b['site_name']} with a flat schedule. PlotStar's plan saves about "
                         f"{d['co2_est_t_year']:,.0f} t CO₂ a year and ${abs(d['cost']):,.0f} over ten years (Estimated)"
                         + (f"; it needs flexibility because that site's firm power is a scenario at {o['firm_capacity_share']:.0%} of the request (Simulated)." if o["f"] > 0 else "."))
    if run["rejected"]:
        names = {}
        for x in run["rejected"]:
            names.setdefault(x["name"], x["gate"])
        top = list(names.items())[:3]
        parts.append("Sites rejected by a hard gate, whatever their price: " + "; ".join(f"{n} ({g.lower()})" for n, g in top) + ".")
    parts.append("Firm grid capacity and interconnection cost are scenarios until a utility confirms them.")
    if question:
        parts.append(f"(You asked: \"{question[:120]}\". Without a model key I can only explain the run above.)")
    return {"answer": " ".join(parts), "trace": trace, "model": "deterministic"}


# ----------------------------------------------------------------------------- LangChain deep agent

def _llm():
    if config.ANTHROPIC_API_KEY:
        from langchain_anthropic import ChatAnthropic
        return ChatAnthropic(model=os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-5"), api_key=config.ANTHROPIC_API_KEY,
                             max_tokens=600, temperature=0), "anthropic"
    if config.BEDROCK_MODEL_ID and (os.getenv("AWS_ACCESS_KEY_ID") or os.getenv("AWS_PROFILE")):
        from langchain_aws import ChatBedrockConverse
        return ChatBedrockConverse(model=config.BEDROCK_MODEL_ID, region_name=config.AWS_REGION, temperature=0), "bedrock"
    return None, None


def explain(run_id: str, question: str | None = None) -> dict[str, Any]:
    llm, kind = _llm()
    if llm is None:
        return deterministic(run_id, question)
    try:
        from deepagents import create_deep_agent
        from langchain_core.tools import tool

        @tool
        def get_run(rid: str) -> str:
            """Optimizer run by run_id: PlotStar pick vs cost-first pick, deltas, rejected sites, labels."""
            return json.dumps(tool_get_run(rid))

        @tool
        def site_checks(parcel_id: str) -> str:
            """CoStar record for a parcel id such as costar:12345."""
            return json.dumps(tool_site_checks(parcel_id))

        @tool
        def grid_day() -> str:
            """The cached ERCOT day: price and carbon extremes with their labels."""
            return json.dumps(tool_grid_day())

        agent = create_deep_agent(tools=[get_run, site_checks, grid_day], system_prompt=SYSTEM, model=llm)
        q = question or "Explain this decision to a non-expert."
        out = agent.invoke({"messages": [{"role": "user", "content": f"run_id={run_id}. {q}"}]})
        msgs = out.get("messages", [])
        trace = [{"tool": getattr(m, "name", None), "ok": True} for m in msgs if m.__class__.__name__ == "ToolMessage"]
        answer = next((m.content for m in reversed(msgs) if m.__class__.__name__ == "AIMessage" and m.content), "")
        if isinstance(answer, list):
            answer = " ".join(x.get("text", "") for x in answer if isinstance(x, dict))
        if not answer:
            raise RuntimeError("empty answer")
        return {"answer": answer, "trace": trace, "model": kind}
    except Exception as e:  # any model/tooling failure -> honest fallback, never a blank
        det = deterministic(run_id, question)
        det["model_error"] = f"{type(e).__name__}: {str(e)[:160]}"
        return det

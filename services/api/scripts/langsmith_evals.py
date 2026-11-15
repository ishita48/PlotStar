"""LangSmith evaluation: does a GeoStar agent report the hard-gate outcome the screening engine computes?

Dataset: a small set of CoStar site picks. The expected outcome of each (overall status, failed gates, gates needing
review) is computed by GeoStar's screening engine (app/engine/screening.py through the agents' own `screen_site` tool),
never written by hand. Examples are keyed by an opaque case id (site-01, ...); CoStar ids, names, addresses and
coordinates stay on this machine (the case -> parcel map is never uploaded) unless COPILOT_LLM_COSTAR=1.

Target (default "gate-agent"): a LangChain agent on the specialists' model (claude-haiku-5-5) with the `screen_site`
tool and a structured GateVerdict output: one or two small model calls per case.
Target "engine": the deterministic engine itself (a baseline that must score 1.0; no model calls).

Evaluators (deterministic, no LLM judge):
  status_match     the agent's overall status equals the engine's
  failed_gates_f1  F1 of the failed hard gates the agent names against the engine's
  cites_evidence   the agent cites the evidence id its tool returned

LangSmith: with a key that can write datasets, the examples go to dataset `geostar-gate-outcomes` and
`langsmith.evaluate` runs the experiment there. A tracing-only key (HTTP 403 on /datasets) still traces every target run
to the project, and the scores are computed locally and written to data/cache/langsmith_evals.json.

Run:  services/api/.venv/Scripts/python services/api/scripts/langsmith_evals.py [--cases 4] [--target gate-agent|engine]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Literal

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pydantic import BaseModel, Field  # noqa: E402

from app import config  # noqa: E402  (loads .env)
from app.engine.siting import candidate_pool  # noqa: E402
from app.sponsors.langchain.deep_agents import runtime  # noqa: E402
from app.sponsors.langchain.deep_agents.runtime import CURRENT, Run  # noqa: E402

DATASET = "geostar-gate-outcomes"
HARD = ("Residential proximity", "Sensitive places", "Land in use", "Flood exposure", "Water stress")
OUT = config.CACHE_DIR / "langsmith_evals.json"
MODEL = "claude-haiku-5-5"


class GateVerdict(BaseModel):
    status: Literal["Pass", "Fail", "Needs review"] = Field(..., description="Overall hard-gate status")
    failed_gates: list[str] = Field(default_factory=list, description="Names of the gates with status Fail")
    review_gates: list[str] = Field(default_factory=list, description="Names of the gates with status Needs review")
    evidence: list[str] = Field(default_factory=list, description="Evidence ids your tool returned, e.g. E1")


def _site_run(pid: str) -> Run:
    with __import__("app.db", fromlist=["session"]).session() as c:
        p = dict(c.execute("SELECT parcel_id, lat, lon, market FROM parcels WHERE parcel_id = ?", (pid,)).fetchone())
    return Run("evaluation", "gate check", {"site": {"id": pid, "lat": p["lat"], "lon": p["lon"]}, "market": p["market"]})


def expected(pid: str) -> dict[str, Any]:
    """The engine's answer, through the same tool the agent calls (so both see the same public-data lookups)."""
    from app.sponsors.langchain.deep_agents.tools import screen_site
    run = _site_run(pid)
    tok = CURRENT.set(run)
    try:
        json.loads(screen_site())
    finally:
        CURRENT.reset(tok)
    d = run.latest("screen_site")["data"]
    return dict(status=d["status"], failed_gates=sorted(g["gate"] for g in d["gates"] if g["status"] == "Fail" and g["gate"] in HARD),
                review_gates=sorted(g["gate"] for g in d["gates"] if g["status"] == "Needs review"))


def pick_cases(n: int) -> list[tuple[str, dict[str, Any]]]:
    """A balanced handful: passes, fails and reviews, in a fixed order (largest lots first)."""
    want = {"Pass": (n + 2) // 3, "Fail": (n + 1) // 3, "Needs review": n // 3}
    got: list[tuple[str, dict[str, Any]]] = []
    for market in ("Houston", "Los Angeles"):
        for p in candidate_pool(market, 5):
            if len(got) >= n:
                break
            e = expected(p["parcel_id"])
            if want.get(e["status"], 0) > 0:
                want[e["status"]] -= 1
                got.append((p["parcel_id"], e))
    return got


def gate_agent(pid: str) -> dict[str, Any]:
    from langchain.agents import create_agent
    from langchain_anthropic import ChatAnthropic

    from app.sponsors.langchain.deep_agents.tools import geostar_tools
    run = _site_run(pid)
    agent = create_agent(
        ChatAnthropic(model=MODEL, max_tokens=700, timeout=60, max_retries=2),
        tools=[geostar_tools()["screen_site"]], response_format=GateVerdict, name="gate-agent",
        system_prompt="You check a data-center site against GeoStar's hard gates. Call screen_site once, then report the "
                      "overall status, every gate whose status is Fail, every gate that Needs review, and the evidence id. "
                      "Use the gate names exactly as the tool gives them. Never guess.")
    tok = CURRENT.set(run)
    try:
        out = agent.invoke({"messages": [("human", "Screen the selected site against the hard gates.")]},
                           {"run_name": "GeoStar eval / gate-agent", "tags": ["plotstar", "evaluation"]})
    finally:
        CURRENT.reset(tok)
    v = out.get("structured_response")
    v = v.model_dump() if hasattr(v, "model_dump") else dict(v or {})
    return v | {"_evidence_ids": sorted(run.evidence)}


def engine_target(pid: str) -> dict[str, Any]:
    e = expected(pid)
    return e | {"evidence": ["E1"], "_evidence_ids": ["E1"]}


# ------------------------------------------------------------------------------------------------ evaluators

def status_match(out: dict[str, Any], ref: dict[str, Any]) -> float:
    return float(out.get("status") == ref["status"])


def failed_gates_f1(out: dict[str, Any], ref: dict[str, Any]) -> float:
    got = {g for g in out.get("failed_gates") or [] if g in HARD}
    want = set(ref["failed_gates"])
    if not got and not want:
        return 1.0
    tp = len(got & want)
    p = tp / len(got) if got else 0.0
    r = tp / len(want) if want else 0.0
    return round(2 * p * r / (p + r), 3) if p + r else 0.0


def cites_evidence(out: dict[str, Any], ref: dict[str, Any]) -> float:
    return float(bool(set(out.get("evidence") or []) & set(out.get("_evidence_ids") or [])))


EVALUATORS = (status_match, failed_gates_f1, cites_evidence)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", type=int, default=4)
    ap.add_argument("--target", choices=("gate-agent", "engine"), default="gate-agent")
    a = ap.parse_args()
    if a.target == "gate-agent" and not config.ANTHROPIC_API_KEY:
        print("ANTHROPIC_API_KEY is not set; run with --target engine for the deterministic baseline.")
        return 2
    cases = pick_cases(a.cases)
    names = {pid: f"site-{i + 1:02d}" for i, (pid, _) in enumerate(cases)}
    by_case = {names[pid]: pid for pid, _ in cases}  # local only
    target_fn = gate_agent if a.target == "gate-agent" else engine_target
    examples = [dict(inputs={"case": names[pid]}, outputs=ref) for pid, ref in cases]
    print(f"{len(cases)} cases: " + ", ".join(f"{names[p]} {r['status']}" for p, r in cases))

    from langsmith import Client, traceable
    mode, experiment, url, rows = "local", None, None, []

    @traceable(run_type="chain", name=f"GeoStar eval / {a.target}", tags=["plotstar", "evaluation"])
    def target(inputs: dict[str, Any]) -> dict[str, Any]:
        return target_fn(by_case[inputs["case"]])

    try:
        client = Client()
        ds = client.read_dataset(dataset_name=DATASET) if client.has_dataset(dataset_name=DATASET) else \
            client.create_dataset(DATASET, description="GeoStar site picks with hard-gate outcomes computed by the screening engine.")
        old = {json.dumps(e.inputs, sort_keys=True) for e in client.list_examples(dataset_id=ds.id)}
        new = [e for e in examples if json.dumps(e["inputs"], sort_keys=True) not in old]
        if new:
            client.create_examples(dataset_id=ds.id, examples=new)
        from langsmith import evaluate

        def wrap(fn):
            def ev(run, example):  # langsmith evaluator signature
                return {"key": fn.__name__, "score": fn(run.outputs or {}, example.outputs or {})}
            return ev

        res = evaluate(target, data=DATASET, evaluators=[wrap(f) for f in EVALUATORS], experiment_prefix=f"geostar-{a.target}",
                       max_concurrency=2, client=client)
        mode, experiment, url = "langsmith", getattr(res, "experiment_name", None), getattr(res, "url", None)
        for r in res:
            ex, run = r["example"], r["run"]
            sc = {e.key: e.score for e in r["evaluation_results"]["results"]}
            rows.append(dict(case=ex.inputs["case"], expected=ex.outputs, got={k: v for k, v in (run.outputs or {}).items() if not k.startswith("_")}, scores=sc))
    except Exception as e:  # noqa: BLE001  tracing-only key: 403 on /datasets
        reason = f"{type(e).__name__}: {str(e)[:160]}"
        print(f"LangSmith datasets unavailable ({reason}); scoring locally, target runs still traced.")
        for (pid, ref), ex in zip(cases, examples):
            t0 = time.time()
            try:
                out = target(ex["inputs"])
            except Exception as err:  # noqa: BLE001
                out = {"status": None, "error": f"{type(err).__name__}: {str(err)[:200]}"}
            rows.append(dict(case=ex["inputs"]["case"], expected=ref, got={k: v for k, v in out.items() if not k.startswith("_")},
                             scores={f.__name__: f(out, ref) for f in EVALUATORS}, seconds=round(time.time() - t0, 1)))
        mode = f"local (LangSmith datasets: {reason.split(':')[0]})"
    summary = {f.__name__: round(sum(r["scores"].get(f.__name__, 0) for r in rows) / max(1, len(rows)), 3) for f in EVALUATORS}
    result = dict(at=time.strftime("%Y-%m-%dT%H:%M:%S"), target=a.target, model=MODEL if a.target == "gate-agent" else None,
                  cases=len(rows), mode=mode, experiment=experiment, url=url, project=runtime.os.getenv("LANGSMITH_PROJECT"),
                  summary=summary, rows=rows)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({k: result[k] for k in ("target", "model", "cases", "mode", "experiment", "summary")}, indent=2))
    for r in rows:
        print(f"  {r['case']}: expected {r['expected']['status']:<12} got {str(r['got'].get('status')):<12} {r['scores']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

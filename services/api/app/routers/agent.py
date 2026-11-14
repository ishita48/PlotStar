"""POST /agent/explain -> plain-language explanation of an optimizer run, with the tool trace."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import agent

router = APIRouter(tags=["agent"])


class ExplainIn(BaseModel):
    run_id: str
    question: str | None = Field(None, max_length=500)


@router.post("/agent/explain")
def explain(q: ExplainIn) -> dict[str, Any]:
    return agent.explain(q.run_id, q.question)


@router.get("/eval/run")
def eval_run(agent_samples: int = 0) -> dict[str, Any]:
    """Optimizer-vs-baseline checks over a scenario grid; optional explanation groundedness (calls the explainer)."""
    from .. import evals

    return evals.run(max(0, min(agent_samples, 5)))


@router.get("/agent/status")
def status() -> dict[str, Any]:
    llm, kind = agent._llm()
    return {"model": kind or "deterministic", "note": "Set ANTHROPIC_API_KEY, or AWS credentials + BEDROCK_MODEL_ID, "
            "to run the LangChain deep agent; otherwise explanations are built deterministically from tool outputs."}

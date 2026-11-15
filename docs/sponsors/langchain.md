# GeoStar Deep Agents

One orchestrator, its specialist subagents, one conversation. Built on the LangChain **Deep Agents SDK**
(`create_deep_agent`, deepagents 0.7.38) on the LangGraph runtime, traced in LangSmith (project `plotstar`).
Code: `services/api/app/sponsors/langchain/deep_agents/`, API: `services/api/app/sponsors/langchain/routes_agents.py`, UI: `src/components/sponsors/langchain/`.

**Rule:** models decide what to investigate and explain it; deterministic code produces every number and the score.

## Agents

| Agent | Model | Tools |
|---|---|---|
| PlotStar Orchestrator | claude-sonnet-5-5 | `write_todos` (plan), `task` (delegate), `compute_site_score`, `dispatch_safety_alert` (needs a person's approval) |
| Property Intelligence | claude-haiku-5-5 | 11 CoStar tools over MCP (property, data gaps, comps, occupancy, submarket, neighbours, conversion, Matterport, search) |
| Financial Feasibility | claude-haiku-5-5 | `development_economics`, CoStar `underwrite_acquisition` / comps / memo (MCP), `grid_conditions`, `what_if` |
| Resource & Infrastructure | claude-haiku-5-5 | `screen_site`, `resource_demand`, `grid_conditions`, CoStar `evaluate_conversion` (MCP), `what_if` |
| Community & Sustainability | claude-haiku-5-5 | CoStar `analyze_residential_impact` (MCP), `screen_site`, `community_impact`, `grid_conditions` |
| Design & Simulation | claude-haiku-5-5 | `generate_layouts`, `compare_concepts`, `inspect_object`, `what_if` |
| Safety & Operations | claude-haiku-5-5 | `facility_protection_state`, `safety_playbook` |
| Design Editor | claude-haiku-5-5 | `layout_objects`, `preview_layout_edit`, `apply_layout_edit` (needs a person's approval) |

Models are set by `PLOTSTAR_AGENT_MODEL` / `PLOTSTAR_SUBAGENT_MODEL`. Each subagent returns structured `Findings`
(objective, evidence ids, tools, calculations, assumptions, findings, confidence, risks, next steps) and is capped at
`PLOTSTAR_SUBAGENT_CALL_LIMIT` model calls (default 10).

## Two entry points, one graph

- **Site evaluation** (`POST /agents/site-evaluation`): plan → Property Intelligence → Financial, Resource and
  Community **in parallel** (several `task` calls in one message) → `compute_site_score` → re-delegate once on a
  conflict or closable gap → answer.
- **Conversation** (`POST /agents/chat`): the Studio's one "Ask GeoStar" agent. Each turn carries the live state
  (stage, site, brief, active concept, selected object, last score, deployed facility). The orchestrator delegates only
  to the specialists the question needs. What-ifs come back as a preview the user applies.

## Design Editor: layout changes with a person's approval

`deep_agents/design_agent.py`. A specialist that changes the drawing itself through the Studio's edit contract
(`edits[concept_id] = {building: {dx, dy}, rotate, yard, added, removed}`; metres, origin at the site's south-west
corner, x east, y north). It reads the layout (`layout_objects`), previews a change by re-running
`layout_engine.generate` with it and `keep=[concept id]` (`preview_layout_edit`), then calls `apply_layout_edit`.
That tool is under Deep Agents **`interrupt_on`** on the subagent: the run pauses, the approval card in Agent
Intelligence says in words what will change and why, and only an approval lets the tool run. It then streams a
`design_edit` event with the full edit, and the Studio applies it through its own commit path, so the engine measures
it like a hand edit. A rejection changes nothing. The tool reports per change whether the engine took it. The concept id
always comes from the engine's result. The paused and resumed delegation is one box in the live graph.

## Debate

`deep_agents/debate.py`, `POST /agents/debate`, the "Debate the concepts" button on the compare step. Financial
Feasibility, Community & Sustainability and Resource & Infrastructure argue which concept to build in two rounds
(opening, then rebuttal of each other's claims), and the orchestrator sums up. It is a LangGraph `StateGraph` (parallel
fan-out, join, loop back) recorded by the same `Recorder`, so the live graph shows a box per specialist per round and
every model call; the Debate tab shows the claims. Every claim must cite facts from a fact sheet computed by the engines
(F1, F2, ...: NPV, cost, noise, carbon, water, route lengths, rank, failed checks per concept, plus site and grid
values). Each claim's numbers are checked against the facts it cites and the result is shown beside it; unverified
claims are marked and discounted in the summary. Seven small model calls. Without `ANTHROPIC_API_KEY` it runs
rule-based and says so.

## Citations

`deep_agents/citations.py` runs after `verify()`: each CoStar figure in the answer is matched to a CoStar evidence leaf
and cited as record id (`costar:<PropertyId>`) + field + value + source row; each cited CoStar evidence id gets a record
citation. It reads the full local evidence, so it is deliberately not traced. The run snapshot and the `answer` event
carry `citations`; Agent Intelligence shows them as chips that open the CoStar dossier.

## The score

`app/sponsors/langchain/deep_agents/scoring.py`: four pillars (Property 20 %, Money 30 %, Power and resources 25 %, People and planet 25 %),
eleven criteria, each linear between documented anchors, read from the evidence the specialists' tools recorded. A
criterion with no evidence is a gap (its weight is shared out; coverage drops). Hard gates override the score. A
specialist whose conclusion disagrees with its own evidence is reported as a conflict. The full rule is served at
`GET /agents/architecture` and shown on `/studio/agent`.

## Seeing it

- **Agent Intelligence** panel (Studio top bar pill, "Analyze with agents" on a site, "How the agents worked it out"
  under any answer, and `/studio/agent`): live graph, timeline, and evidence and decisions. Every node is a LangChain
  callback the runtime fired (`app/sponsors/langchain/deep_agents/runtime.py` `Recorder`), so its id is the LangSmith run id.
- **LangSmith**: the root run is `PlotStar / Site Evaluation` or `PlotStar / Conversation`; subagents are chain runs
  named by their slug (`ls_agent_type=subagent`, `lc_agent_name`); models are `llm` runs named `Model / <agent>` with
  `agent_name`, `agent_role`, `model_name` metadata; tools are `tool` runs tagged `mcp`/`costar` or `geostar`;
  `Computation / Weighted Site Score` and `Verify / Evidence and numbers` are separate runs.

## CoStar over MCP and privacy

CoStar tools are called through GeoStar's own MCP server (`app/sponsors/costar/mcp_server.py`) with `mcp.Client` in-process (the
real MCP protocol over memory streams), one session per API process. `save_to_deal_room` (the only write tool) is not
given to agents. Full tool output is kept as evidence in GeoStar and shown in the UI; the model and the LangSmith trace
see a view without CoStar names, addresses, prices, rents and coordinates unless `COPILOT_LLM_COSTAR=1`.

## Verification

After every run, `verify()` checks that each number in the answer matches a tool result (allowing rounding and $M/k
scaling) and that every cited evidence id exists. It flags; it never rewrites.

## LangSmith evaluations

`services/api/scripts/langsmith_evals.py`. Question: does an agent report the hard-gate outcome the screening engine
computes? The dataset is a handful of CoStar site picks keyed by opaque case ids (`site-01`, ...); the expected status,
failed gates and review gates come from `app/engine/screening.py` through the agents' own `screen_site` tool, never
written by hand, and no CoStar id leaves the machine. The target is a LangChain agent on the specialists' model with
`screen_site` and a structured verdict; `--target engine` is the deterministic baseline. Evaluators are deterministic:
`status_match`, `failed_gates_f1`, `cites_evidence`.

With a key that can write datasets the script creates dataset `geostar-gate-outcomes` and runs `langsmith.evaluate`.
This project's key is tracing-only (HTTP 403 on `/datasets`), so the run below scored locally while every target run
was traced to the `plotstar` project; results are in `data/cache/langsmith_evals.json`.

| Run (2026-11-15) | Cases | status_match | failed_gates_f1 | cites_evidence |
|---|---|---|---|---|
| `gate-agent` (claude-haiku-5-5) | 4 (2 Pass, 1 Fail, 1 Needs review) | 1.00 | 1.00 | 1.00 |
| `engine` baseline | 4 | 1.00 | 1.00 | 1.00 |

Four cases is a smoke test, not a benchmark. Run more with `--cases N`.

## Tests

`services/api/tests/test_agents_extra.py`: citations (record and field per figure, no record ids or GeoStar thresholds
cited), the edit contract merge, a preview on the active concept, the Design Editor's approval pause and resume through
`agents._execute` with the real `interrupt_on` spec (approve and reject), the debate's fact sheet, claim checking, and
both debate modes drawing six specialist boxes.


`services/api/tests/test_deep_agents.py`: delegation and attribution from real callbacks (fake models), parallel
delegations, structured findings capture, score reproducibility, gaps, gates, conflicts, CoStar redaction,
verification, the findings boundary, and the 15 MCP tools.

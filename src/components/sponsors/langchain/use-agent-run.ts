'use client';
// One agent run, live: starts it (site evaluation or a conversation turn), follows its server-sent events and keeps the
// graph, plan, findings, evidence, score and answer. Every node comes from a real runtime callback on the server.
import { useCallback, useEffect, useRef, useState } from 'react';
import { dataFetch, PUBLIC_DATA_API } from '@/lib/plotstar-api';

export type NodeKind = 'agent' | 'model' | 'tool' | 'mcp' | 'compute' | 'verify' | 'plan';
export type NodeStatus = 'running' | 'done' | 'error';
export interface AgentNode {
  id: string; parent: string | null; kind: NodeKind; name: string; label: string; agent: string | null; status: NodeStatus;
  start: number; end: number | null; ms: number | null; lc_run_id: string; error: string | null; input: string | null;
  output: string | null; evidence: string[]; role?: string; model?: string | { provider: string; name: string } | null;
  provider?: string; args?: Record<string, unknown>; tokens?: { input?: number; output?: number } | null; objective?: string | null;
  delegation_id?: string | null; run_name?: string; tool_calls?: string[];
}
export interface Evidence {
  id: string; tool: string; provider: string; label: string | null; sources: string[]; source_count: number; view: unknown;
  redacted: boolean; agent: string | null; node: string | null; at: number; data?: unknown;
}
export interface Finding {
  agent: string; node: string; objective: string; summary: string; status: 'favourable' | 'mixed' | 'unfavourable' | 'insufficient evidence';
  evidence: { id: string; tool: string; what: string }[]; tools_invoked: string[]; calculations: string[]; assumptions: string[];
  findings: string[]; confidence: 'high' | 'medium' | 'low'; confidence_reason: string; risks: string[]; next_steps: string[];
}
export interface Criterion { key: string; label: string; rule: string; value: unknown; score: number | null; evidence: string | null; agent: string | null; reading: string; costar: boolean }
export interface Pillar { key: string; label: string; weight: number; effective_weight: number; agent: string; score: number | null; coverage: number; criteria: Criterion[] }
export interface Score {
  score: number | null; verdict: string; verdict_reason: string; coverage: number; confidence: string; pillars: Pillar[];
  gates: { gate: string; status: string; value: unknown; unit: string | null; evidence: string }[];
  gaps: { criterion: string; pillar: string; agent: string; reason: string }[];
  conflicts: { pillar: string; agent: string; agent_status: string; pillar_score: number; note: string }[];
}
export interface Verification { grounded: boolean; numbers_checked: number; unverified_numbers: number[]; cited: string[]; unknown_citations: string[]; note: string }
export interface Proposal { patch: Record<string, unknown>; concept_id: string; consequences: unknown }
export interface Approval { actions: { name: string; args: Record<string, unknown>; description?: string }[]; decision: string | null }
export type RunStatus = 'idle' | 'starting' | 'running' | 'awaiting_approval' | 'done' | 'error';
/** A CoStar figure in the answer tied to its record and field (deep_agents/citations.py). */
export interface Citation {
  kind: 'figure' | 'evidence'; figure: string | null; evidence_id: string; tool: string; record_id: string; field: string;
  label: string; value: number | null; tag: string; source: string | null; audit: boolean;
}
/** A layout change a person approved; the Studio applies `edit` to edits[concept_id] (deep_agents/design_agent.py). */
export interface DesignEdit {
  concept_id: string; concept: string; edit: Record<string, unknown>; reason: string; added: string[];
  applied: { change: string; applied: boolean }[]; failed_checks: string[]; feasible: boolean; headline: string;
  changed: { metric: string; before_text: string; after_text: string }[]; check_flips: { name: string; after: boolean; detail: string }[];
}
export interface DebateClaim { id: string; text: string; facts: string[]; stance: 'support' | 'rebut' | 'concede'; responds_to: string | null; grounded: boolean; unknown_facts: string[]; unverified_numbers: string[] }
export interface DebateTurn { round: number; agent: string; title: string; lens: string; position: string; position_name: string; claims: DebateClaim[] }
export interface DebateFact { id: string; owner: string; concept_id: string | null; concept: string; metric: string; value: number; unit: string; text: string; label: string }
export interface Debate {
  question: string; mode: 'model' | 'rule-based'; note: string; facts: DebateFact[]; concepts: { id: string; name: string; rank: number }[];
  rounds: { round: number; turns: DebateTurn[] }[];
  summary: { recommendation: string; recommendation_name: string; text: string; agreements: string[]; open_disagreements: string[]; facts: string[]; grounded: boolean; unverified_numbers: string[] } | null;
}

export interface RunState {
  runId: string | null; kind: 'site-evaluation' | 'conversation' | 'debate' | null; title: string; status: RunStatus;
  nodes: Record<string, AgentNode>; order: string[]; plan: { content: string; status: string }[];
  findings: Record<string, Finding>; evidence: Record<string, Evidence>; score: Score | null; answer: string | null;
  verification: Verification | null; proposal: Proposal | null; approval: Approval | null; error: string | null;
  traceId: string | null; startedAt: number | null; message: string | null;
  citations: Citation[]; designEdits: DesignEdit[]; debate: Debate | null;
}

const EMPTY: RunState = {
  runId: null, kind: null, title: '', status: 'idle', nodes: {}, order: [], plan: [], findings: {}, evidence: {}, score: null,
  answer: null, verification: null, proposal: null, approval: null, error: null, traceId: null, startedAt: null, message: null,
  citations: [], designEdits: [], debate: null,
};

type Ev = { type: string; t: number; [k: string]: unknown };

function reduce(s: RunState, e: Ev): RunState {
  switch (e.type) {
    case 'started': return { ...s, message: (e.message as string) ?? null };
    case 'node': {
      const n = e.node as AgentNode;
      const known = n.id in s.nodes;
      return { ...s, nodes: { ...s.nodes, [n.id]: n }, order: known ? s.order : [...s.order, n.id],
        traceId: s.traceId ?? (n.parent === null ? n.lc_run_id : null) };
    }
    case 'plan': return { ...s, plan: e.plan as RunState['plan'] };
    case 'finding': return { ...s, findings: { ...s.findings, [e.agent as string]: e.finding as Finding } };
    case 'evidence': { const v = e.evidence as Evidence; return { ...s, evidence: { ...s.evidence, [v.id]: v } }; }
    case 'score': return { ...s, score: e.score as Score };
    case 'proposal': return { ...s, proposal: e.proposal as Proposal };
    case 'answer': return { ...s, answer: e.answer as string, verification: e.verification as Verification, proposal: (e.proposal as Proposal) ?? s.proposal,
      citations: (e.citations as Citation[]) ?? [] };
    case 'design_edit': return { ...s, designEdits: [...s.designEdits, e.design_edit as DesignEdit] };
    case 'debate': return { ...s, debate: e.debate as Debate };
    case 'status': {
      const st = e.status as RunStatus;
      return { ...s, status: st, approval: st === 'awaiting_approval' ? { actions: e.actions as Approval['actions'], decision: null } : s.approval };
    }
    case 'error': return { ...s, error: e.error as string };
    case 'end': return { ...s, status: (e.status as RunStatus) ?? s.status };
    default: return s;
  }
}

export function useAgentRun() {
  const [state, setState] = useState<RunState>(EMPTY);
  const es = useRef<EventSource | null>(null);

  const follow = useCallback((runId: string, kind: RunState['kind'], title: string) => {
    es.current?.close();
    setState({ ...EMPTY, runId, kind, title, status: 'running', startedAt: Date.now() });
    const src = new EventSource(`${PUBLIC_DATA_API}/agents/runs/${runId}/stream`);
    es.current = src;
    src.onmessage = (m) => {
      const e = JSON.parse(m.data) as Ev;
      setState((s) => (s.runId === runId ? reduce(s, e) : s));
      if (e.type === 'end') src.close();
    };
    src.onerror = () => { /* EventSource reconnects with Last-Event-ID; the server resumes from there */ };
  }, []);

  const start = useCallback(async (path: '/agents/site-evaluation' | '/agents/chat' | '/agents/debate', body: unknown, title: string) => {
    setState({ ...EMPTY, status: 'starting', title });
    try {
      const r = await dataFetch(`${PUBLIC_DATA_API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(typeof d?.detail === 'string' ? d.detail : `Request failed (${r.status})`);
      follow(d.run_id, path === '/agents/chat' ? 'conversation' : path === '/agents/debate' ? 'debate' : 'site-evaluation', title);
      return d.run_id as string;
    } catch (e) {
      setState((s) => ({ ...s, status: 'error', error: (e as Error).message }));
      return null;
    }
  }, [follow]);

  const decide = useCallback(async (approve: boolean) => {
    if (!state.runId) return;
    await dataFetch(`${PUBLIC_DATA_API}/agents/runs/${state.runId}/approval`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve }) });
  }, [state.runId]);

  useEffect(() => () => es.current?.close(), []);
  return { state, start, follow, decide };
}

export const evidenceUrl = (runId: string, eid: string) => `${PUBLIC_DATA_API}/agents/runs/${runId}/evidence/${eid}`;
export const isActive = (s: RunState) => s.status === 'running' || s.status === 'starting' || s.status === 'awaiting_approval';
export const activeAgents = (s: RunState) =>
  Object.values(s.nodes).filter((n) => n.kind === 'agent' && n.status === 'running' && n.parent !== null).length;

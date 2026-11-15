"use client";

/**
 * A compact, live timeline of one Deep Agents run inside Hey Geo's chat: the orchestrator, each specialist with its
 * status and duration, the tool calls under it (collapsed, with their key numbers), the human-approval step when the
 * run pauses, and the answer's citations. The full live graph is one click away (Agent Intelligence).
 * Data: the Studio's shared useAgentRun() state (SSE from /agents/runs/{id}/stream) or a polled snapshot of
 * GET /agents/runs/{id}, which have the same node shape.
 */

import { Check, CircleAlert, GitBranch, Hourglass, Loader2, ShieldCheck } from "lucide-react";
import type { AgentNode, Approval, Citation, Verification } from "@/components/sponsors/langchain/use-agent-run";

export type RunView = {
  status: string;
  nodes: AgentNode[];
  approval: Approval | null;
  citations: Citation[];
  verification: Verification | null;
  error: string | null;
};

const dur = (n: AgentNode, now: number) => {
  const ms = n.ms ?? (n.status === "running" ? now - n.start * (n.start < 1e12 ? 1000 : 1) : null);
  return ms == null || !Number.isFinite(ms) || ms < 0 ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
};

function Status({ s }: { s: string }) {
  if (s === "running" || s === "starting") return <Loader2 size={11} className="hg-spin" aria-label="running" />;
  if (s === "done") return <Check size={11} aria-label="done" />;
  if (s === "error") return <CircleAlert size={11} aria-label="failed" />;
  return <Hourglass size={11} aria-label={s} />;
}

/** The first numbers in a tool's output: what it found, in a few words. */
function keyNumbers(out: string | null): string {
  if (!out) return "";
  const t = out.replace(/\s+/g, " ");
  const bits = t.match(/[A-Za-z_ ]{2,24}[:=]\s*-?\$?\d[\d,.]*\s?[%A-Za-z/²]*/g);
  return (bits ? bits.slice(0, 3).join(" · ") : t).slice(0, 140);
}

export function RunTimeline({ run, onDecide, onOpenGraph }: { run: RunView; onDecide?: (approve: boolean) => void; onOpenGraph?: () => void }) {
  const now = Date.now();
  const byId = new Map(run.nodes.map((n) => [n.id, n]));
  const root = run.nodes.find((n) => n.parent === null && n.kind === "agent") ?? run.nodes.find((n) => n.parent === null);
  const agents = run.nodes.filter((n) => n.kind === "agent" && n.parent !== null);
  /** The specialist (or the orchestrator) a tool call belongs to. */
  const ownerOf = (n: AgentNode): string | null => {
    for (let p = n.parent ? byId.get(n.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) if (p.kind === "agent") return p.id;
    return null;
  };
  const tools = (ownerId: string) => run.nodes.filter((n) => (n.kind === "tool" || n.kind === "mcp" || n.kind === "compute") && ownerOf(n) === ownerId);
  const status = run.status === "awaiting_approval" ? "awaiting approval" : run.status;

  return (
    <div className="hg-run" aria-label="Agent run">
      <div className="hg-run-head">
        <span>
          <Status s={run.status} /> Deep Agents · {status}
        </span>
        {onOpenGraph && (
          <button type="button" onClick={onOpenGraph}>
            <GitBranch size={11} /> Open graph
          </button>
        )}
      </div>
      {root && (
        <div className="hg-run-row hg-run-root" data-status={root.status}>
          <Status s={root.status} />
          <b>{root.label || "Orchestrator"}</b>
          <span>{dur(root, now)}</span>
        </div>
      )}
      {agents.map((a) => {
        const ts = tools(a.id);
        return (
          <details key={a.id} className="hg-run-agent" data-status={a.status}>
            <summary>
              <Status s={a.status} />
              <b>{a.label || a.name}</b>
              <span>
                {ts.length ? `${ts.length} tool${ts.length === 1 ? "" : "s"} · ` : ""}
                {dur(a, now)}
              </span>
            </summary>
            {a.objective && <p className="hg-run-obj">{a.objective.slice(0, 160)}</p>}
            {ts.map((t) => (
              <div key={t.id} className="hg-run-tool" data-status={t.status}>
                <Status s={t.status} />
                <code>{t.name}</code>
                <span>{keyNumbers(t.output) || dur(t, now)}</span>
              </div>
            ))}
            {a.error && <p className="hg-run-err">{a.error.slice(0, 200)}</p>}
          </details>
        );
      })}
      {run.status === "awaiting_approval" && run.approval && !run.approval.decision && (
        <div className="hg-run-approval">
          <div>
            <ShieldCheck size={12} /> The agents want to:
          </div>
          <ul>
            {run.approval.actions.map((x, i) => (
              <li key={i}>{x.description || x.name}</li>
            ))}
          </ul>
          {onDecide && (
            <div className="hg-card-row">
              <button type="button" className="hg-btn" onClick={() => onDecide(true)}>
                Approve
              </button>
              <button type="button" className="hg-btn hg-btn-quiet" onClick={() => onDecide(false)}>
                Reject
              </button>
            </div>
          )}
        </div>
      )}
      {run.error && <p className="hg-run-err">{run.error.slice(0, 240)}</p>}
      {(run.citations.length > 0 || run.verification) && (
        <div className="hg-run-cite">
          {run.verification && (
            <span>
              {run.verification.grounded ? "Grounded" : "Check figures"} · {run.verification.numbers_checked} numbers checked
            </span>
          )}
          {run.citations.slice(0, 6).map((c, i) => (
            <span key={i} title={`${c.tool} · ${c.record_id} · ${c.field}${c.source ? ` · ${c.source}` : ""}`}>
              [{i + 1}] {c.label}
              {c.figure ? `: ${c.figure}` : ""} <em>{c.tag}</em>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

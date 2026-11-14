"use client";

import type { ReactNode } from "react";
import type { ApiError, Label } from "@/lib/api";

const LABEL_VAR: Record<Label, string> = {
  Measured: "var(--lbl-measured)",
  Sourced: "var(--lbl-sourced)",
  Estimated: "var(--lbl-estimated)",
  Simulated: "var(--lbl-simulated)",
  "Utility-confirmed": "var(--lbl-utility)",
  Unknown: "var(--lbl-unknown)",
};

export const LABEL_MEANING: Record<Label, string> = {
  Measured: "Read from our own sensors: watts, runtime, completion, response time.",
  Sourced: "Taken from a named external dataset with a timestamp: CoStar, ERCOT, WRI.",
  Estimated: "Derived by a documented method: distance to homes, CO2, modeled cost.",
  Simulated: "Scenario or replay: miniature grid, hypothetical power envelope, scaled-to-100 MW figures.",
  "Utility-confirmed": "From a utility study. Expected to be empty during the hackathon.",
  Unknown: "Not in the data. Never filled with a guess.",
};

export function LabelChip({ label, className = "" }: { label: Label; className?: string }) {
  const c = LABEL_VAR[label];
  return (
    <span
      title={LABEL_MEANING[label]}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${className}`}
      style={{ color: c, borderColor: `color-mix(in srgb, ${c} 45%, transparent)` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
      {label}
    </span>
  );
}

export function Panel({
  title,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-line bg-panel ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-text">{title}</h2>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Metric({
  label,
  value,
  tag,
  hint,
  onAudit,
}: {
  label: string;
  value: ReactNode;
  tag: Label;
  hint?: string;
  onAudit?: () => void;
}) {
  const Inner = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs text-muted">{label}</span>
        <LabelChip label={tag} />
      </div>
      <div className="tabular mt-2 text-2xl font-semibold text-text">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </>
  );
  return onAudit ? (
    <button
      onClick={onAudit}
      className="rounded-xl border border-line bg-panel p-4 text-left transition hover:border-accent/60"
      title="Show evidence"
    >
      {Inner}
    </button>
  ) : (
    <div className="rounded-xl border border-line bg-panel p-4">{Inner}</div>
  );
}

export function PhaseBadge({ phase }: { phase: number }) {
  return (
    <span className="rounded-md border border-line bg-panel-2 px-2 py-0.5 text-[11px] font-medium text-muted">
      Phase {phase}
    </span>
  );
}

export function EmptyState({
  title,
  phase,
  children,
  needs,
}: {
  title: string;
  phase: number;
  children: ReactNode;
  needs?: string[];
}) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-panel/50 p-6">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold text-text">{title}</h3>
        <PhaseBadge phase={phase} />
      </div>
      <div className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{children}</div>
      {needs && needs.length > 0 && (
        <div className="mt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">Needs before it can show results</div>
          <ul className="mt-2 grid gap-1 text-sm text-text/80 sm:grid-cols-2">
            {needs.map((n) => (
              <li key={n} className="flex gap-2">
                <span className="text-accent">○</span>
                {n}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ErrorBox({ error }: { error: ApiError }) {
  return (
    <div className="rounded-xl border border-bad/40 bg-bad/10 p-4 text-sm text-bad">
      <div className="font-semibold">API error{error.status ? ` (${error.status})` : ""}</div>
      <div className="mt-1 text-bad/90">{error.message}</div>
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-panel-2 ${className}`} />;
}

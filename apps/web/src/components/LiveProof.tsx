"use client";

import type { DataSummary } from "@/lib/api";
import { num } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import { LabelChip, PhaseBadge } from "./ui";

// Proof strip: the first tile is live from the API; the others say honestly that they are not built yet.
export function LiveProof() {
  const { data, error } = useApi<DataSummary>("/data/summary");
  const houston = data?.by_market?.find((m) => m.market === "Houston");

  return (
    <div className="mt-4 grid gap-4 md:grid-cols-3">
      <div className="rounded-2xl border border-line bg-panel p-6">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted">Real CoStar parcels</span>
          {houston ? <LabelChip label="Sourced" /> : <PhaseBadge phase={1} />}
        </div>
        <div className="tabular mt-3 text-4xl font-semibold">
          {houston ? num(houston.candidates) : error ? "N/A" : "…"}
        </div>
        <p className="mt-2 text-sm text-muted">
          {houston
            ? `Houston industrial, flex and land properties from the CoStar Data Extract, each traceable to its source record.`
            : error
              ? "API offline. Start services/api to see live counts."
              : "Loading from the API…"}
        </p>
      </div>
      <div className="rounded-2xl border border-line bg-panel p-6">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted">Optimizer vs cost-first</span>
          <PhaseBadge phase={4} />
        </div>
        <div className="mt-3 text-4xl font-semibold text-muted">Not yet run</div>
        <p className="mt-2 text-sm text-muted">
          Side-by-side with the cheapest feasible site on the same gates. The result comes from the model, not a headline.
        </p>
      </div>
      <div className="rounded-2xl border border-line bg-panel p-6">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted">Measured hardware response</span>
          <PhaseBadge phase={6} />
        </div>
        <div className="mt-3 text-4xl font-semibold text-muted">Not yet measured</div>
        <p className="mt-2 text-sm text-muted">
          Press the grid-emergency button, watch measured watts fall, and see the deferred job still finish.
        </p>
      </div>
    </div>
  );
}

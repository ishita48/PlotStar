import { PageHeader } from "@/components/PageHeader";
import { EmptyState, Panel } from "@/components/ui";

const CONTROLS = [
  ["Cooling", "Air, water, hybrid (water excluded where the water gate fails)"],
  ["Flexible share", "Share of load that can be deferred"],
  ["Curtailment frequency f", "Share of the 8,760 annual hours curtailed: 0, 0.25%, 0.5%, 1%"],
  ["Curtailment depth d", "Percent of load shed during those hours"],
  ["Price multiplier", "Scales cached ERCOT hourly prices"],
  ["Water limit", "Hard cap for water-cooled configurations"],
  ["Construction delay", "Months; feeds cost of delay"],
];

export default function OptimizePage() {
  return (
    <>
      <PageHeader
        title="Optimization Studio"
        subtitle="Change a constraint and the optimizer re-runs: site, cooling, flexibility and hourly schedule chosen together, compared with the cost-first baseline."
      />
      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <Panel title="Scenario controls">
          <ul className="space-y-3">
            {CONTROLS.map(([k, v]) => (
              <li key={k} className="rounded-lg border border-line bg-panel-2 p-3 opacity-60">
                <div className="text-sm font-medium">{k}</div>
                <div className="text-xs text-muted">{v}</div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">Controls unlock when the optimizer endpoint exists (Phase 4).</p>
        </Panel>
        <div className="space-y-6">
          <Panel title="Baseline vs optimized">
            <EmptyState
              title="No run_id yet"
              phase={4}
              needs={[
                "Parcels passing all hard gates",
                "Firm capacity H(s) per site (scenario, labeled Simulated)",
                "Cached ERCOT hourly prices and fuel mix",
                "Assumptions sheet complete",
              ]}
            >
              Enumerate site × cooling × flexibility (about 36 combinations), drop any that fail a gate, solve the 24-hour
              scheduling LP for each survivor, and rank by lifecycle cost. The baseline is the cheapest feasible parcel with no
              flexibility, default cooling and a flat load. Re-runs must finish in under 10 seconds.
            </EmptyState>
          </Panel>
          <Panel title="24-hour schedule">
            <EmptyState title="No schedule" phase={4}>
              Hourly power per flexible job against price and carbon. Moving work to another hour does not reduce energy by
              itself; it changes cost, carbon and peak.
            </EmptyState>
          </Panel>
        </div>
      </div>
    </>
  );
}

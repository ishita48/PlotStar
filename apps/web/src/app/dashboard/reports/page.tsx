import { PageHeader } from "@/components/PageHeader";
import { EmptyState, Panel } from "@/components/ui";

const REPORTS = [
  ["Investor memo", 7, "Recommendation, financials, risks, alternatives, assumptions and sources. P0-lite."],
  ["Community impact sheet", 7, "Water, noise, proximity to homes and diesel backup against defined limits. No unproven bill claims."],
  ["Regulator sheet", 7, "Large-load flexibility commitments and evidence gaps requiring utility confirmation. P1."],
  ["Grid Passport", 7, "Timestamped record of requested curtailment, measured response, duration, recovery and deadline compliance. P1."],
] as const;

export default function ReportsPage() {
  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Exports drafted by the agent from tool results only. Each report lists its assumptions, sources and limits."
      />
      <div className="grid gap-6 md:grid-cols-2">
        {REPORTS.map(([title, phase, body]) => (
          <Panel key={title} title={title}>
            <EmptyState title="Not generated" phase={phase}>
              {body}
            </EmptyState>
          </Panel>
        ))}
        <Panel title="Evidence trail" className="md:col-span-2">
          <p className="text-sm text-muted">
            Live now for parcel attributes: click any value in Site Explorer to see its source file, line, JSON path, method and
            load time. Optimizer and financial figures join the same audit chain in Phases 3 and 4.
          </p>
        </Panel>
      </div>
    </>
  );
}

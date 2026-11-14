import { PageHeader } from "@/components/PageHeader";
import { EmptyState, Panel } from "@/components/ui";

export default function LiveGridPage() {
  return (
    <>
      <PageHeader
        title="Live Grid"
        subtitle="Real machines run the same fixed-work benchmark under baseline and PlotStar schedules. An ESP32 miniature grid replays a real ERCOT day."
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Baseline machine · watts">
          <EmptyState title="No telemetry stream" phase={6} needs={["Workload controller running", "Power reading (chip-level or wall-plug, disclosed)"]}>
            Flat baseline schedule. During a grid emergency it keeps drawing power; the diesel indicator lights up.
          </EmptyState>
        </Panel>
        <Panel title="PlotStar machine · watts">
          <EmptyState title="No telemetry stream" phase={6} needs={["Pause/resume on emergency", "Job completion record"]}>
            Follows the optimizer&apos;s schedule. On an emergency it defers noncritical work; measured watts should fall and the
            deferred job must still finish before its deadline.
          </EmptyState>
        </Panel>
        <Panel title="Grid replay and emergency" className="lg:col-span-2">
          <EmptyState
            title="ESP32 not connected"
            phase={6}
            needs={["ESP32 serial or MQTT bridge", "POST /hardware/emergency", "GET /telemetry/stream (SSE)", "Cached ERCOT day"]}
          >
            Wind, solar and gas output from a real ERCOT day compressed to 60 seconds, the 24-hour clock, and the physical
            emergency button. Press must reach the controller in under 2 seconds. The miniature grid is Simulated; machine watts
            are Measured.
          </EmptyState>
        </Panel>
      </div>
    </>
  );
}

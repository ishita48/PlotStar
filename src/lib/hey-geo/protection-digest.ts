/**
 * Hey Geo — the HAVEN protection state as Claude needs it (server side).
 * Everything here is GeoStar's HAVEN simulation (src/lib/haven/engine.ts):
 * the same derived values the Protect and Command Center screens show.
 */

import { evacuationPlans } from "@/lib/haven/config";
import {
  activeIncidents,
  buildingHealth,
  effectivePlan,
  facilitySystems,
  operationsHealth,
  responsePlan,
  routeAvailability,
  severity,
  type ProtectionState,
} from "@/lib/haven/engine";

const MAX_BYTES = 300_000;

/** The page's snapshot, if it looks like one. It only shapes this person's own answer. */
export function protectionFrom(raw: unknown): ProtectionState | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<ProtectionState>;
  if (typeof p.revision !== "number" || !p.facility || typeof p.facility !== "object" || !Array.isArray(p.incidents) || !p.config || !p.readings || !Array.isArray(p.timeline)) return null;
  return JSON.stringify(raw).length <= MAX_BYTES ? (raw as ProtectionState) : null;
}

const clip = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : s);

export function protectionDigest(state: ProtectionState | null, opts: { hideName: boolean }): string {
  if (!state) return "(no HAVEN facility on screen)";
  try {
    const plan = responsePlan(state);
    const available = routeAvailability(state);
    const digest = {
      data: "SIMULATION (HAVEN protection sample model; not live sensors, not a surveyed building)",
      facility: { name: opts.hideName ? "[property name]" : state.facility.name, city: state.facility.city, type: state.facility.type },
      revision: state.revision,
      setup: { model_accepted: state.modelAccepted, protections_configured: state.configured, sensor_placed: state.placed, placement: state.placement ?? null, deployed: state.deployed, deployed_at: state.deployedAt ?? null, recovering: state.recovering },
      protections: state.config,
      readings: { electricity_kw: state.readings.electricity, water_l_per_min: state.readings.waterUsage, leak_sensor: state.readings.leak, fire_sensor: state.readings.fire },
      health: buildingHealth(state),
      severity: severity(state),
      operations: operationsHealth(state),
      incidents: activeIncidents(state).map((i) => ({ id: i.id, kind: i.kind, name: i.name, zone: i.zone, severity: i.severity, status: i.status, message: clip(i.message, 240), recommendation: clip(i.recommendation, 240), at: i.createdAt })),
      response_plan: plan && { id: plan.id, status: plan.status, approved_at: plan.approvedAt ?? null, title: plan.title, steps: plan.steps, instruction: plan.instruction, route: plan.route, life_safety: plan.lifeSafety, rationale: clip(plan.rationale, 500) },
      routes: Object.values(evacuationPlans).map((r) => ({ id: r.id, name: r.name, description: r.description, step_free: r.stepFree, clear: available[r.id] })),
      chosen_route: state.plan,
      effective_route: effectivePlan(state),
      systems: facilitySystems(state).map((s) => ({ id: s.id, name: s.name, zone: s.zone, monitored: s.monitored, status: s.status, detail: s.detail })),
      team: state.team ?? null,
      emergency_call: state.call ? { status: state.call.status, mode: state.call.mode, started_at: state.call.startedAt, report: clip(state.call.report, 300) } : null,
      timeline: state.timeline.slice(0, 8).map((a) => `${a.at} ${a.agent}: ${clip(a.message, 160)}`),
    };
    return JSON.stringify(digest).slice(0, 12_000);
  } catch {
    return "(the facility's protection state could not be read)";
  }
}

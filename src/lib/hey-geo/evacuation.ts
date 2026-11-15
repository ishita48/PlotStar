/**
 * Hey Geo — evacuation plans, drawn from GeoStar's HAVEN protection state, never generated.
 * ─────────────────────────────────────────────────────────────────────────────────────
 * The model only asks for a plan ("evacuation": {}). This module turns the
 * facility's protection state (src/lib/haven/engine.ts) plus the twin's own
 * Level 4 layout (components/dashboard-2/haven/building-layout.ts) into
 * whiteboard sketch shapes, so every drawn room, stairwell, closure or route
 * exists in the data the Protect and Command Center screens use:
 *  - routes are HAVEN's configured East and North exits (config.ts), drawn
 *    on Level 4, excluded when an active hazard touches them;
 *  - the effective route is amber until the response plan is approved,
 *    green after; with no clear route the plan says to hold and wait.
 * Everything is the HAVEN simulation on a representative sample model.
 */

import { BUILDING_LAYOUT, type Point2 } from "@/components/dashboard-2/haven/building-layout";
import { demoScenarios, evacuationPlans, monitoringPoints, type PlanId } from "@/lib/haven/config";
import {
  activeIncidents,
  effectivePlan,
  facilitySystems,
  responsePlan,
  routeAvailability,
  type ProtectionState,
} from "@/lib/haven/engine";
import type { Diagram, Shape } from "./diagram-schema";

export type EvacAudience = "me" | "staff" | "building";
export type EvacRequest = { floor?: number | null; audience?: EvacAudience | null };
export type EvacPlan = { diagram: Diagram; caption: string; lines: string[]; floor: number };

const C = {
  ink: "#101411",
  wall: "#5d6b61",
  room: "#9aa79d",
  corridor: "#b9cdb0",
  you: "#2F6F9F",
  open: "#1F4A36",
  proposed: "#B7791F",
  closed: "#B3261E",
  refuge: "#6FA24E",
  muted: "#6b776e",
};

type Status = "approved" | "proposed" | "hold" | "normal" | "usage";

const STATUS_TEXT: Record<Status, string> = {
  approved: "Route approved by the operator; guidance is shared.",
  proposed: "Proposed route: the response plan is waiting for operator approval. Follow staff instructions until it is approved.",
  hold: "No configured route is clear. Hold in the nearest unaffected space and wait for on-site assistance.",
  normal: "No active incident. Both configured routes are shown with their live (simulated) status.",
  usage: "Usage alert only. No route is excluded by a usage threshold; normal operations continue.",
};

// Level 4 plan: x ∈ [-6, 6], z ∈ [-3.2, 3.2] (≈ 2 m per unit) onto the 400 × 300 board.
const S = 30;
const hx = (x: number) => 20 + (x + 6) * S;
const hy = (z: number) => 52 + (z + 3.2) * S;
const rect = (cx: number, cz: number, w: number, d: number, style: Partial<Extract<Shape, { shape: "rect" }>> = {}): Shape => ({
  shape: "rect",
  x: hx(cx - w / 2),
  y: hy(cz - d / 2),
  w: w * S,
  h: d * S,
  ...style,
});
const flat = (points: Point2[]) => points.flatMap(([x, z]) => [hx(x), hy(z)]);
const ent = (id: string) => BUILDING_LAYOUT.entities.find((e) => e.id === id);

/** The Level 4 legs of HAVEN's configured routes (x, z of the points on Level 4). */
function legOf(id: PlanId): Point2[] {
  const route = evacuationPlans[id];
  const y4 = route.points[0][1];
  return route.points.filter((p) => Math.abs(p[1] - y4) < 0.01).map((p) => [p[0], p[2]] as Point2);
}
const STAIR: Record<PlanId, string> = { east: "east stairwell", north: "west stairwell" };

export function buildEvacuationPlan(state: ProtectionState, request: EvacRequest = {}): EvacPlan {
  const floor = 4; // HAVEN's configured monitoring and routes cover Level 4 of the sample twin
  const incidents = activeIncidents(state);
  const kinds = new Set(incidents.map((i) => i.kind));
  const lifeSafety = kinds.has("fire") || kinds.has("leak");
  const available = routeAvailability(state);
  const route = lifeSafety ? effectivePlan(state) : null;
  const plan = responsePlan(state);
  const status: Status = !incidents.length ? "normal" : !lifeSafety ? "usage" : !route ? "hold" : plan?.status === "approved" ? "approved" : "proposed";
  const systems = facilitySystems(state);
  const e1Closed = systems.some((s) => s.id === "E1" && s.status === "unavailable");
  const r3Affected = systems.some((s) => s.id === "R3" && s.status === "affected");
  const personal = request.audience === "me";

  const shapes: Shape[] = [];
  const headline = incidents.length ? `${plan?.title ?? incidents[0].name} · Level ${floor}` : `Evacuation plan · Level ${floor}`;
  shapes.push({ shape: "text", x: 200, y: 20, text: headline.slice(0, 60), size: 15, color: C.ink });
  shapes.push({ shape: "text", x: 200, y: 38, text: `HAVEN simulation · revision ${state.revision} · sample model`, size: 10, color: C.muted });

  // Walls, corridor, rooms, cores (the twin's own Level 4 geometry).
  shapes.push(rect(0, 0, 12, 6.4, { color: C.wall, width: 2.5 }));
  const corridor = ent(`corridor-${floor}`);
  if (corridor) shapes.push(rect(corridor.position[0], corridor.position[2], corridor.size[0], corridor.size[2], { color: C.corridor, fill: C.corridor, width: 1.5 }));
  for (const e of BUILDING_LAYOUT.entities.filter((x) => x.floor === floor && x.kind === "room")) {
    const start = Math.abs(e.position[0] - -0.65) < 0.01 && e.position[2] > 0;
    shapes.push(
      rect(e.position[0], e.position[2], e.size[0], e.size[2], {
        color: start ? C.you : C.room,
        width: start ? 3 : 1.5,
        fill: start ? C.you : undefined,
        label: start ? (personal ? "Ops room · YOU" : "Ops room · start") : e.label.replace("Room ", ""),
      })
    );
  }
  for (const id of [`stairs-west-${floor}`, `stairs-east-${floor}`]) {
    const s = ent(id);
    if (s) shapes.push(rect(s.position[0], s.position[2], s.size[0], s.size[2], { color: C.wall, width: 2, dashed: true, label: id.includes("west") ? "W stairs" : "E stairs" }));
  }
  const service = ent(`service-${floor}`);
  if (service) shapes.push(rect(service.position[0], service.position[2], service.size[0], service.size[2], { color: r3Affected ? C.closed : C.room, width: 1.5, label: r3Affected ? "R-3 · affected" : "Service" }));
  const e1 = ent("elevator-e1");
  if (e1) {
    shapes.push(rect(e1.position[0], e1.position[2], e1.size[0], e1.size[2], { color: e1Closed ? C.closed : C.wall, width: 2.5, fill: e1Closed ? C.closed : undefined, label: e1Closed ? "E1 isolated" : "E1" }));
    if (e1Closed) {
      const [x, z] = [e1.position[0], e1.position[2]];
      shapes.push({ shape: "line", points: [hx(x - 0.6), hy(z - 0.75), hx(x + 0.6), hy(z + 0.75)], color: C.closed, width: 3 });
      shapes.push({ shape: "line", points: [hx(x + 0.6), hy(z - 0.75), hx(x - 0.6), hy(z + 0.75)], color: C.closed, width: 3 });
    }
  }
  const refuge = ent("west-refuge");
  if (refuge) shapes.push(rect(refuge.position[0], refuge.position[2], refuge.size[0], refuge.size[2], { color: C.refuge, width: 1.5, dashed: true, label: "Refuge" }));

  // Hazard zones: the corridor zone each active simulated hazard names.
  for (const kind of ["fire", "leak"] as const) {
    if (!kinds.has(kind)) continue;
    const zone = BUILDING_LAYOUT.zones.find((z) => z.label.toLowerCase().startsWith(demoScenarios[kind].zone.split(" ")[0].toLowerCase()));
    if (zone) shapes.push(rect(zone.center[0], zone.center[1], zone.size[0], zone.size[1], { color: C.closed, fill: C.closed, width: 2, dashed: true, label: `${kind === "fire" ? "Fire" : "Leak"} · ${zone.label}` }));
  }

  // Sensors of the protections that are switched on.
  for (const p of monitoringPoints) {
    if (!state.config[p.protection]?.enabled) continue;
    shapes.push({ shape: "circle", cx: hx(p.position[0]), cy: hy(p.position[2]), r: 3, color: C.muted, fill: C.muted, width: 1 });
  }

  // Excluded routes: a dashed red leg ending in a cross.
  for (const id of Object.keys(evacuationPlans) as PlanId[]) {
    if (available[id]) continue;
    const leg = legOf(id);
    shapes.push({ shape: "polyline", points: flat(leg), color: C.closed, width: 3, dashed: true });
    const [ex, ez] = leg[leg.length - 1];
    shapes.push({ shape: "line", points: [hx(ex) - 6, hy(ez) - 6, hx(ex) + 6, hy(ez) + 6], color: C.closed, width: 3 });
    shapes.push({ shape: "line", points: [hx(ex) + 6, hy(ez) - 6, hx(ex) - 6, hy(ez) + 6], color: C.closed, width: 3 });
  }
  // With no incident, both clear routes are shown thin.
  if (!lifeSafety) {
    for (const id of Object.keys(evacuationPlans) as PlanId[]) {
      if (!available[id]) continue;
      const leg = legOf(id);
      const a = leg[leg.length - 2];
      const b = leg[leg.length - 1];
      shapes.push({ shape: "polyline", points: flat(leg.slice(0, -1)), color: C.refuge, width: 2.5 });
      shapes.push({ shape: "arrow", points: [hx(a[0]), hy(a[1]), hx(b[0]), hy(b[1])], color: C.refuge, width: 2.5, label: evacuationPlans[id].name });
    }
  }

  // The route, drawn last so the pen finishes on it.
  const lines: string[] = [STATUS_TEXT[status]];
  if (route) {
    const leg = legOf(route);
    const color = status === "approved" ? C.open : C.proposed;
    shapes.push({ shape: "polyline", points: flat(leg.slice(0, -1)), color, width: 5 });
    const a = leg[leg.length - 2];
    const b = leg[leg.length - 1];
    shapes.push({ shape: "arrow", points: [hx(a[0]), hy(a[1]), hx(b[0]), hy(b[1])], color, width: 5 });
    const r = evacuationPlans[route];
    shapes.push({ shape: "text", x: Math.min(330, Math.max(70, hx(b[0]))), y: Math.min(262, Math.max(60, hy(b[1]) + (b[1] > 0 ? 22 : -14))), text: `Down to the ${r.name}`, size: 11, color });
    const turn = leg[2] && leg[2][0] < leg[1][0] ? "turn left (west)" : "turn right (east)";
    lines.push(`${personal ? "Your" : "The"} route: out of the operations room → ${turn} along the Level 4 corridor → ${STAIR[route]} → down to the ground-floor ${r.name}.`);
  } else if (status === "hold") {
    const start = ent("room-412");
    if (start) shapes.push(rect(start.position[0], start.position[2], start.size[0] + 0.2, start.size[2] + 0.2, { color: C.closed, width: 3.5 }));
  }
  if (plan?.lifeSafety && plan.instruction) lines.push(`Instruction in the plan: ${plan.instruction}`);
  if (e1Closed) lines.push("Do not use Elevator E1: it is isolated.");
  const excluded = (Object.keys(evacuationPlans) as PlanId[]).filter((id) => !available[id]);
  if (excluded.length) lines.push(`Excluded: ${excluded.map((id) => `${evacuationPlans[id].name} (touches the hazard zone)`).join("; ")}.`);
  lines.push("Both configured routes use stairs; they are not step-free.");

  shapes.push({ shape: "text", x: 200, y: 282, text: STATUS_TEXT[status].split(".")[0].slice(0, 60), size: 11, color: status === "hold" ? C.closed : status === "proposed" ? C.proposed : C.open });
  return {
    diagram: { kind: "sketch", title: `Evacuation plan · Level ${floor}`, shapes: shapes.slice(0, 60) },
    caption: "Drawn from GeoStar's HAVEN protection state (simulation) and the twin's Level 4 layout. Not AI-generated. Representative sample model, not a surveyed plan; about 2 m per grid unit.",
    lines,
    floor,
  };
}

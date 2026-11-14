import { z } from 'zod';
import { sensorDefaults, incidentDetails } from '../monitoring-rules';
import {
  databotPlacements,
  demoScenarios,
  evacuationPlans,
  MODEL_ID,
  placementIds,
  type PlacementId,
  type PlanId,
} from './config';

export const protectionSchema = z.object({
  electricity: z.object({ enabled: z.boolean(), limit: z.number().finite().min(1).max(100000) }),
  waterUsage: z.object({ enabled: z.boolean(), limit: z.number().finite().min(1).max(100000) }),
  leak: z.object({ enabled: z.boolean() }),
  fire: z.object({ enabled: z.boolean() }),
});
export type Protections = z.infer<typeof protectionSchema>;
export type ProtectionKind = keyof Protections;
export const defaultProtections: Protections = {
  electricity: { enabled: true, limit: 500 },
  waterUsage: { enabled: true, limit: 50 },
  leak: { enabled: true },
  fire: { enabled: true },
};
export interface Facility {
  id: string;
  name: string;
  city: string;
  type: string;
}
export interface DemoIncident {
  id: string;
  kind: ProtectionKind;
  name: string;
  zone: string;
  severity: 'warning' | 'critical';
  status: 'active' | 'acknowledged' | 'resolved';
  message: string;
  recommendation: string;
  source: 'simulation';
  createdAt: string;
}
export interface Activity {
  id: string;
  agent: string;
  message: string;
  at: string;
}
export interface Readings {
  electricity: number;
  waterUsage: number;
  leak: number;
  fire: number;
}
export interface ProtectionState {
  revision: number;
  facility: Facility;
  modelId: string;
  modelAccepted: boolean;
  config: Protections;
  configured: boolean;
  placed: boolean;
  plan: PlanId;
  /** Where the DataBot sensor unit sits. Absent for workspaces saved before placements existed. */
  placement?: PlacementId;
  deployed: boolean;
  recovering: boolean;
  mode: 'simulation';
  readings: Readings;
  /** Normal readings this facility returns to on reset. Defaults to the HAVEN sample values. */
  baseline?: Readings;
  /** When monitoring was last deployed. Kept while protections are being edited. */
  deployedAt?: string;
  incidents: DemoIncident[];
  timeline: Activity[];
  sequence: number;
}
export const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('accept-model') }),
  z.object({ action: z.literal('configure'), config: protectionSchema }),
  z.object({
    action: z.literal('place'),
    plan: z.enum(['east', 'north']),
    placement: z.enum(placementIds).optional(),
  }),
  z.object({ action: z.literal('deploy') }),
  z.object({ action: z.literal('reconfigure') }),
  z.object({ action: z.literal('trigger'), kind: z.enum(['leak', 'fire', 'usage']) }),
  z.object({ action: z.literal('acknowledge'), incidentId: z.string().max(100) }),
  z.object({ action: z.literal('reset') }),
  z.object({ action: z.literal('finish-recovery') }),
]);
export type ProtectionAction = z.infer<typeof actionSchema>;
export function initialProtectionState(facility: Facility): ProtectionState {
  return {
    revision: 0,
    facility,
    modelId: MODEL_ID,
    modelAccepted: false,
    config: structuredClone(defaultProtections),
    configured: false,
    placed: false,
    plan: 'east',
    deployed: false,
    recovering: false,
    mode: 'simulation',
    readings: {
      electricity: 260,
      waterUsage: 18,
      leak: sensorDefaults.water.value,
      fire: sensorDefaults.fire.value,
    },
    incidents: [],
    timeline: [],
    sequence: 0,
  };
}
export const activeIncidents = (state: ProtectionState) =>
  state.incidents.filter((incident) => incident.status !== 'resolved');
export function buildingHealth(
  state: ProtectionState,
): 'Healthy' | 'Warning' | 'Critical incident' | 'Recovering' {
  const active = activeIncidents(state);
  return active.some((i) => i.severity === 'critical')
    ? 'Critical incident'
    : active.length
      ? 'Warning'
      : state.recovering
        ? 'Recovering'
        : 'Healthy';
}
// HAVEN's route-exclusion rule: a path touching any excluded location is unavailable.
// Availability applies to this explicit simulation topology only, never real-world safety.
export function routeAvailability(state: ProtectionState) {
  const blocked = activeIncidents(state).flatMap((i) =>
    i.kind === 'leak' || i.kind === 'fire' ? [...demoScenarios[i.kind].blockedLocations] : [],
  );
  return Object.fromEntries(
    Object.entries(evacuationPlans).map(([id, route]) => [
      id,
      !route.locationIds.some((location) => blocked.includes(location as (typeof blocked)[number])),
    ]),
  ) as Record<PlanId, boolean>;
}
export function effectivePlan(state: ProtectionState): PlanId | null {
  const availability = routeAvailability(state);
  return availability[state.plan]
    ? state.plan
    : availability.north
      ? 'north'
      : availability.east
        ? 'east'
        : null;
}
function activity(state: ProtectionState, agent: string, message: string, at: string) {
  state.timeline.unshift({ id: `event-${++state.sequence}`, agent, message, at });
  state.timeline = state.timeline.slice(0, 80);
}
function evaluate(state: ProtectionState, now: string) {
  const checks = [
    {
      kind: 'electricity' as const,
      value: state.readings.electricity,
      threshold: state.config.electricity.limit,
      type: 'electrical',
      name: 'Electricity limit exceeded',
      zone: 'Electrical service bay',
    },
    {
      kind: 'waterUsage' as const,
      value: state.readings.waterUsage,
      threshold: state.config.waterUsage.limit,
      type: 'water',
      name: 'Water usage limit exceeded',
      zone: 'R-3 utility bay',
    },
    {
      kind: 'leak' as const,
      value: state.readings.leak,
      threshold: sensorDefaults.water.threshold,
      type: 'water',
      name: 'Water leak detected',
      zone: demoScenarios.leak.zone,
    },
    {
      kind: 'fire' as const,
      value: state.readings.fire,
      threshold: sensorDefaults.fire.threshold,
      type: 'fire',
      name: 'Fire hazard detected',
      zone: demoScenarios.fire.zone,
    },
  ];
  for (const check of checks) {
    if (
      !state.config[check.kind].enabled ||
      check.value < check.threshold ||
      activeIncidents(state).some((i) => i.kind === check.kind)
    )
      continue;
    const response = incidentDetails(check.type, check.zone, check.value, 'simulation');
    const incident: DemoIncident = {
      id: `incident-${++state.sequence}`,
      kind: check.kind,
      name: check.name,
      zone: check.zone,
      severity: check.kind === 'fire' ? 'critical' : 'warning',
      status: 'active',
      message:
        check.kind === 'waterUsage'
          ? `Simulated water flow ${check.value} L/min exceeds the configured ${check.threshold} L/min limit.`
          : response.message,
      recommendation:
        check.kind === 'waterUsage'
          ? 'Maintenance: inspect the flow meter and unexpected consumption before adjusting the limit.'
          : response.recommendation,
      source: 'simulation',
      createdAt: now,
    };
    state.incidents.unshift(incident);
    state.incidents = state.incidents.slice(0, 40);
    activity(
      state,
      'Building Monitor',
      `${check.name} · ${check.value} ≥ ${check.threshold}. Simulated reading.`,
      now,
    );
    const plan = effectivePlan(state);
    activity(
      state,
      'Guardian',
      check.kind === 'leak' || check.kind === 'fire'
        ? `East route excluded by the scenario. ${plan ? `${evacuationPlans[plan].name} is scenario-clear; stairs are not step-free.` : 'No configured route is available. Request on-site assistance.'}`
        : 'Usage threshold crossed; no evacuation route is excluded by this rule.',
      now,
    );
    activity(state, 'Maintenance', incident.recommendation, now);
    if (check.kind === 'fire' || check.kind === 'leak')
      activity(
        state,
        'Security',
        'Demo East Exit blocked; North Exit available in the configured scenario. Coordinate on-site checks. No doors or alarms are controlled.',
        now,
      );
  }
}
export function transitionProtection(
  previous: ProtectionState,
  input: ProtectionAction,
  now = new Date().toISOString(),
): ProtectionState {
  const action = actionSchema.parse(input);
  const state = structuredClone(previous);
  switch (action.action) {
    case 'accept-model':
      state.modelAccepted = true;
      activity(state, 'Design', 'Representative HAVEN model selected for this facility.', now);
      break;
    case 'configure': {
      if (!state.modelAccepted) throw new Error('Choose a model before configuring protections.');
      if (state.deployed) throw new Error('Return to configuration before changing protections.');
      if (!Object.values(action.config).some((p) => p.enabled))
        throw new Error('Enable at least one protection.');
      state.config = action.config;
      state.configured = true;
      state.placed = false;
      evaluate(state, now);
      activity(state, 'Configuration', 'Protection thresholds saved for this facility.', now);
      break;
    }
    case 'place':
      if (state.deployed) throw new Error('Return to configuration before changing the route.');
      if (!state.configured) throw new Error('Configure protections first.');
      if (!routeAvailability(state)[action.plan])
        throw new Error('This route is blocked in the active scenario.');
      state.plan = action.plan;
      if (action.placement) state.placement = action.placement;
      state.placed = true;
      activity(
        state,
        'Guardian',
        `${evacuationPlans[state.plan].name} selected from the predefined demo routes.`,
        now,
      );
      if (action.placement)
        activity(
          state,
          'Configuration',
          `DataBot placed in the ${databotPlacements[action.placement].name}, Level 4.`,
          now,
        );
      break;
    case 'deploy':
      if (!state.modelAccepted || !state.configured || !state.placed)
        throw new Error('Select a model, configure protections and confirm a route first.');
      state.deployed = true;
      state.deployedAt = now;
      evaluate(state, now);
      activity(
        state,
        'Building Monitor',
        'Simulation monitoring deployed. No hardware or external agents are connected.',
        now,
      );
      break;
    case 'reconfigure':
      state.deployed = false;
      activity(
        state,
        'Configuration',
        'Returned to protection setup. Incident records retained.',
        now,
      );
      break;
    case 'trigger':
      if (!state.configured)
        throw new Error('Configure protections before simulating an incident.');
      if (action.kind !== 'usage' && !state.config[action.kind].enabled)
        throw new Error('Enable this protection before triggering its demo.');
      if (action.kind === 'usage') {
        if (!state.config.electricity.enabled && !state.config.waterUsage.enabled)
          throw new Error('Enable usage monitoring first.');
        state.readings.electricity = 620;
        state.readings.waterUsage = 75;
      } else state.readings[action.kind] = demoScenarios[action.kind].value;
      state.recovering = false;
      evaluate(state, now);
      break;
    case 'acknowledge': {
      const incident = state.incidents.find(
        (i) => i.id === action.incidentId && i.status !== 'resolved',
      );
      if (!incident) throw new Error('Active incident not found.');
      incident.status = 'acknowledged';
      activity(
        state,
        'Operator',
        `${incident.name} acknowledged. Hazard and route exclusions remain active.`,
        now,
      );
      break;
    }
    case 'reset':
      state.readings = { ...(state.baseline || initialProtectionState(state.facility).readings) };
      for (const incident of activeIncidents(state)) incident.status = 'resolved';
      state.recovering = true;
      evaluate(state, now);
      activity(
        state,
        'Recovery',
        'Simulation readings reset. Review the restored scenario before completing recovery.',
        now,
      );
      break;
    case 'finish-recovery':
      if (!state.recovering || activeIncidents(state).length)
        throw new Error('Resolve active threshold conditions before completing recovery.');
      state.recovering = false;
      activity(
        state,
        'Recovery',
        'Demo recovery checked. Simulated building state returned to healthy.',
        now,
      );
      break;
  }
  state.revision++;
  return state;
}

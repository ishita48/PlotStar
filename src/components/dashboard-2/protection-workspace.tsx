'use client';
import { useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bell,
  Box,
  Check,
  CheckCircle2,
  ChevronRight,
  Droplets,
  Flame,
  Leaf,
  Radio,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Waves,
  Zap,
} from 'lucide-react';
import {
  evacuationPlans,
  monitoringPoints,
  MODEL_NAME,
  MODEL_NOTE,
  type PlanId,
} from '@/lib/haven/config';
import {
  activeIncidents,
  buildingHealth,
  effectivePlan,
  routeAvailability,
  type ProtectionAction,
  type ProtectionState,
  type Protections,
} from '@/lib/haven/engine';
import { PrimaryCard, StepNavigation } from './shell';
import { FacilityTwin } from './facility-twin';

type Act = (action: ProtectionAction) => Promise<ProtectionState | null>;
const definitions = [
  {
    id: 'electricity',
    name: 'Electricity usage limit',
    detail: 'Track the facility’s demand against a configured limit.',
    icon: Zap,
    unit: 'kW',
    input: 'Electricity threshold',
  },
  {
    id: 'waterUsage',
    name: 'Water usage limit',
    detail: 'Keep an eye on unexpected water consumption.',
    icon: Waves,
    unit: 'L/min',
    input: 'Water usage threshold',
  },
  {
    id: 'leak',
    name: 'Water leak detection',
    detail: 'Moisture sensors at the riser and east corridor.',
    icon: Droplets,
  },
  {
    id: 'fire',
    name: 'Fire hazard detection',
    detail: 'Smoke / heat monitoring in both operations corridors.',
    icon: Flame,
  },
] as const;
export function DesignModule({
  state,
  busy,
  act,
  onProtect,
}: {
  state: ProtectionState;
  busy: boolean;
  act: Act;
  onProtect: () => void;
}) {
  return (
    <>
      <PrimaryCard className="hv-design">
        <div className="d2-card-top">
          <span className="d2-kicker">
            <span /> GIVE YOUR VISION A SHAPE
          </span>
          <span className="hv-mode">
            <Box size={12} /> SAMPLE MODEL
          </span>
        </div>
        <h1>A clearer view of{'\n'}what comes next.</h1>
        <p className="d2-lede">
          {state.facility.name} · {state.facility.city}
          <br />A representative HAVEN model, ready to explore and protect.
        </p>
        <div className="hv-model-title">
          <div>
            <b>{MODEL_NAME}</b>
            <span>Reused HAVEN geometry · six levels · orbit, zoom and inspect</span>
          </div>
          <span className="d2-sample-tag">Representative geometry</span>
        </div>
        <FacilityTwin state={state} />
        <div className="hv-design-details">
          <div>
            <span>FACILITY</span>
            <b>{state.facility.name}</b>
          </div>
          <div>
            <span>MODEL</span>
            <b>Six-level cutaway</b>
          </div>
          <div>
            <span>MONITORING PLAN</span>
            <b>Level 4 operations</b>
          </div>
        </div>
        <p className="hv-note">
          This sample is not a generated design for the selected parcel. The same model and facility
          identity carry into Protect. Configured routes use stairs and are not step-free.
        </p>
        <div className="d2-form-footer">
          <span>
            <Leaf size={15} />{' '}
            {state.modelAccepted ? 'Model selection saved' : 'One facility. One connected twin.'}
          </span>
          <button
            className="d2-button"
            disabled={busy}
            onClick={async () => {
              if (state.modelAccepted || (await act({ action: 'accept-model' }))) onProtect();
            }}
          >
            {busy
              ? 'Saving model…'
              : state.modelAccepted
                ? 'Continue to Protect'
                : 'Use this model'}
            <ArrowRight size={16} />
          </button>
        </div>
      </PrimaryCard>
    </>
  );
}
function SimulationControls({
  state,
  act,
  busy,
}: {
  state: ProtectionState;
  act: Act;
  busy: boolean;
}) {
  return (
    <div className="hv-demo-controls" aria-label="Demo incident controls">
      <span>
        <Radio size={13} /> SIMULATION CONTROLS
      </span>
      <div>
        <button
          disabled={busy || !state.config.leak.enabled}
          onClick={() => void act({ action: 'trigger', kind: 'leak' })}
        >
          <Droplets size={15} /> Trigger Water Leak
        </button>
        <button
          className="hv-fire-trigger"
          disabled={busy || !state.config.fire.enabled}
          onClick={() => void act({ action: 'trigger', kind: 'fire' })}
        >
          <Flame size={15} /> Trigger Fire
        </button>
        <button
          disabled={busy || (!state.config.electricity.enabled && !state.config.waterUsage.enabled)}
          onClick={() => void act({ action: 'trigger', kind: 'usage' })}
        >
          <Zap size={15} /> Usage spike
        </button>
        <button disabled={busy} onClick={() => void act({ action: 'reset' })}>
          <RotateCcw size={14} /> Reset Simulation
        </button>
      </div>
    </div>
  );
}
function RouteSummary({ state }: { state: ProtectionState }) {
  const available = routeAvailability(state),
    plan = effectivePlan(state);
  return (
    <div className="hv-route-summary">
      <div>
        <ShieldCheck size={17} />
        <span>
          <b>
            {plan
              ? `${evacuationPlans[plan].name} · scenario-clear`
              : 'No available configured route'}
          </b>
          <small>
            {plan
              ? evacuationPlans[plan].description
              : 'Request on-site assistance. No route can be recommended by this scenario.'}
          </small>
        </span>
      </div>
      <div className="hv-exit-chips">
        {Object.entries(evacuationPlans).map(([id, exit]) => (
          <span key={id} className={available[id as PlanId] ? 'is-clear' : 'is-blocked'}>
            {available[id as PlanId] ? <Check size={11} /> : <Flame size={11} />}
            {exit.name} · {available[id as PlanId] ? 'available in demo' : 'blocked in demo'}
          </span>
        ))}
      </div>
      <p>
        Predefined simulation routes only · stairs are not step-free · no real-world safety
        verification
      </p>
    </div>
  );
}
function IncidentSummary({
  state,
  act,
  busy,
}: {
  state: ProtectionState;
  act: Act;
  busy: boolean;
}) {
  const incidents = activeIncidents(state);
  return (
    <div className="hv-incidents">
      <div className="hv-section-heading">
        <h2>Active incidents</h2>
        <span>{incidents.length}</span>
      </div>
      {incidents.length ? (
        incidents.map((incident) => (
          <article className={`hv-incident ${incident.severity}`} key={incident.id}>
            <div>
              <span>
                {incident.kind === 'fire' ? (
                  <Flame size={16} />
                ) : incident.kind === 'leak' ? (
                  <Droplets size={16} />
                ) : (
                  <Activity size={16} />
                )}
              </span>
              <div>
                <h3>{incident.name}</h3>
                <small>{incident.zone} · Simulated</small>
              </div>
            </div>
            <p>{incident.message}</p>
            <p className="hv-response">{incident.recommendation}</p>
            <footer>
              <span>
                {incident.status === 'acknowledged'
                  ? 'Acknowledged · hazard remains active'
                  : 'Awaiting acknowledgement'}
              </span>
              {incident.status === 'active' && (
                <button
                  disabled={busy}
                  onClick={() => void act({ action: 'acknowledge', incidentId: incident.id })}
                >
                  Acknowledge <Check size={12} />
                </button>
              )}
            </footer>
          </article>
        ))
      ) : (
        <div className="hv-empty-state">
          <CheckCircle2 size={24} />
          <b>No active incidents</b>
          <p>All enabled simulated readings are within their configured limits.</p>
        </div>
      )}
    </div>
  );
}
function Timeline({ state }: { state: ProtectionState }) {
  return (
    <PrimaryCard className="hv-timeline">
      <div className="hv-section-heading">
        <div>
          <span className="d2-overline">HAVEN RESPONSE RULES</span>
          <h2>Every signal. A clear next step.</h2>
        </div>
        <span className="d2-sample-tag">Deterministic simulation</span>
      </div>
      <div className="hv-agent-strip">
        {['Building Monitor', 'Guardian', 'Maintenance', 'Security', 'Recovery'].map((role) => (
          <span key={role}>
            <i className={state.timeline.some((e) => e.agent === role) ? 'has-activity' : ''} />
            {role}
          </span>
        ))}
      </div>
      <ol>
        {state.timeline.slice(0, 12).map((event) => (
          <li key={event.id}>
            <span className="hv-timeline-dot" />
            <div>
              <b>{event.agent}</b>
              <p>{event.message}</p>
            </div>
            <time dateTime={event.at}>
              {new Date(event.at).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </time>
          </li>
        ))}
      </ol>
      <p className="hv-note">
        Shared threshold and response rules run locally in AFTERLIGHT’s backend. External HAVEN
        uAgents, hardware, physical alarms and equipment controls are not connected.
      </p>
    </PrimaryCard>
  );
}
export function ProtectModule({
  state,
  busy,
  act,
  onDesign,
}: {
  state: ProtectionState;
  busy: boolean;
  act: Act;
  onDesign: () => void;
}) {
  const [step, setStep] = useState(state.placed ? 2 : state.configured ? 1 : 0);
  const [draft, setDraft] = useState<Protections>(state.config);
  const [plan, setPlan] = useState<PlanId>(state.plan);
  const available = routeAvailability(state);
  const choice = available[plan] ? plan : effectivePlan(state) || 'north';
  const health = buildingHealth(state);
  const healthClass = health === 'Critical incident' ? 'critical' : health.toLowerCase();
  const enabled = monitoringPoints.filter((p) => state.config[p.protection].enabled);
  if (!state.modelAccepted)
    return (
      <PrimaryCard className="hv-prerequisite">
        <Box size={42} />
        <h1>Start with your twin.</h1>
        <p>
          Choose the representative facility model in Design, then configure its protection plan.
        </p>
        <button className="d2-button" onClick={onDesign}>
          Open Design <ArrowRight size={15} />
        </button>
      </PrimaryCard>
    );
  if (state.deployed)
    return (
      <>
        <div className="hv-command-bar">
          <div>
            <ShieldCheck size={19} />
            <span>
              HAVEN COMMAND CENTER<small>{state.facility.name}</small>
            </span>
          </div>
          <span className="hv-mode">
            <Radio size={12} /> SIMULATION MODE
          </span>
        </div>
        <div className="hv-live-heading">
          <div>
            <span className="d2-overline">CONNECTED TO YOUR VISION</span>
            <h1>Care, in every corner.</h1>
            <p>
              {state.facility.city} · {MODEL_NAME}
            </p>
          </div>
          <button
            className="d2-back"
            disabled={busy}
            onClick={async () => {
              const next = await act({ action: 'reconfigure' });
              if (next) {
                setDraft(next.config);
                setStep(0);
              }
            }}
          >
            <Settings2 size={15} /> Edit protections
          </button>
        </div>
        <div
          className={`hv-health-banner ${healthClass}`}
          role={health === 'Critical incident' || health === 'Warning' ? 'alert' : 'status'}
        >
          <span>
            {health === 'Critical incident' ? (
              <Flame size={22} />
            ) : health === 'Warning' ? (
              <Bell size={22} />
            ) : health === 'Recovering' ? (
              <RotateCcw size={22} />
            ) : (
              <ShieldCheck size={22} />
            )}
          </span>
          <div>
            <b>{health}</b>
            <p>
              {health === 'Healthy'
                ? 'The enabled demo sensors report normal conditions.'
                : health === 'Recovering'
                  ? 'Simulated readings have reset. Complete the recovery review to return to healthy.'
                  : 'HAVEN detected a simulated incident. Review affected areas and the configured response below.'}
            </p>
          </div>
          {state.recovering && !activeIncidents(state).length && (
            <button disabled={busy} onClick={() => void act({ action: 'finish-recovery' })}>
              Complete recovery <Check size={14} />
            </button>
          )}
        </div>
        <div className="hv-metrics">
          <Metric
            icon={Zap}
            name="Electricity"
            value={state.config.electricity.enabled ? `${state.readings.electricity} kW` : 'Off'}
            detail={`Limit ${state.config.electricity.limit} kW`}
            warning={
              state.config.electricity.enabled &&
              state.readings.electricity >= state.config.electricity.limit
            }
          />
          <Metric
            icon={Waves}
            name="Water usage"
            value={state.config.waterUsage.enabled ? `${state.readings.waterUsage} L/min` : 'Off'}
            detail={`Limit ${state.config.waterUsage.limit} L/min`}
            warning={
              state.config.waterUsage.enabled &&
              state.readings.waterUsage >= state.config.waterUsage.limit
            }
          />
          <Metric
            icon={Droplets}
            name="Leak detection"
            value={
              state.config.leak.enabled
                ? activeIncidents(state).some((i) => i.kind === 'leak')
                  ? 'Leak detected'
                  : 'Clear'
                : 'Off'
            }
            detail="2 configured moisture points"
            warning={activeIncidents(state).some((i) => i.kind === 'leak')}
          />
          <Metric
            icon={Flame}
            name="Fire hazards"
            value={
              state.config.fire.enabled
                ? activeIncidents(state).some((i) => i.kind === 'fire')
                  ? 'Alarm active'
                  : 'Clear'
                : 'Off'
            }
            detail="2 configured smoke / heat points"
            warning={activeIncidents(state).some((i) => i.kind === 'fire')}
          />
        </div>
        <div className="hv-command-grid">
          <PrimaryCard className="hv-live-model">
            <div className="hv-section-heading">
              <div>
                <span className="d2-overline">THE FACILITY, AT A GLANCE</span>
                <h2>Operational digital twin</h2>
              </div>
              <span className="d2-sample-tag">Sample model</span>
            </div>
            <FacilityTwin state={state} operational initialFloor={null} />
            <RouteSummary state={state} />
          </PrimaryCard>
          <PrimaryCard className="hv-response-panel">
            <IncidentSummary state={state} act={act} busy={busy} />
          </PrimaryCard>
        </div>
        <SimulationControls state={state} act={act} busy={busy} />
        <Timeline state={state} />
      </>
    );
  return (
    <>
      <StepNavigation
        step={step}
        completed={[state.configured, state.placed, state.deployed]}
        onSelect={setStep}
        busy={busy}
        names={['Select', 'Place', 'Deploy']}
        label="Protect"
      />
      {step === 0 && (
        <PrimaryCard className="hv-select">
          <div className="d2-card-top">
            <span className="d2-kicker">
              <span /> PROTECTION, ON YOUR TERMS
            </span>
            <span className="d2-card-index">01 — 03</span>
          </div>
          <h1>A little foresight.{'\n'}A lot more confidence.</h1>
          <p className="d2-lede">
            Choose what to watch over at {state.facility.name}.<br />
            Start with the essentials. Make the limits yours.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act({ action: 'configure', config: draft })) setStep(1);
            }}
          >
            <div className="hv-protection-grid">
              {definitions.map((item) => {
                const Icon = item.icon,
                  config = draft[item.id];
                return (
                  <section
                    className={`hv-protection-card ${config.enabled ? 'is-enabled' : ''}`}
                    key={item.id}
                  >
                    <div>
                      <span className="hv-protection-icon">
                        <Icon size={24} strokeWidth={1.5} />
                      </span>
                      <label className="hv-switch">
                        <input
                          type="checkbox"
                          role="switch"
                          aria-label={`${item.name} monitoring`}
                          checked={config.enabled}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              [item.id]: { ...config, enabled: e.target.checked },
                            })
                          }
                        />
                        <span />
                      </label>
                    </div>
                    <h2>{item.name}</h2>
                    <p>{item.detail}</p>
                    {item.id === 'electricity' || item.id === 'waterUsage' ? (
                      <label className="hv-limit">
                        <span>Alert above</span>
                        <div>
                          <input
                            type="number"
                            min="1"
                            max="100000"
                            required
                            disabled={!config.enabled || busy}
                            aria-label={item.input}
                            value={draft[item.id].limit}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                [item.id]: { ...draft[item.id], limit: Number(e.target.value) },
                              })
                            }
                          />
                          <span>{item.unit}</span>
                        </div>
                      </label>
                    ) : (
                      <span className="hv-detection-note">
                        <CheckCircle2 size={13} />
                        {config.enabled ? 'Detection enabled' : 'Detection paused'}
                      </span>
                    )}
                  </section>
                );
              })}
            </div>
            <div className="hv-mode-note">
              <Radio size={17} />
              <div>
                <b>Start in simulation mode</b>
                <p>
                  Readings and incidents are deterministic demos. No physical device is connected.
                </p>
              </div>
              <span>SIMULATION</span>
            </div>
            <div className="d2-form-footer">
              <button type="button" className="d2-back" onClick={onDesign}>
                <ArrowLeft size={15} /> Back to Design
              </button>
              <button
                type="submit"
                className="d2-button"
                disabled={busy || !Object.values(draft).some((c) => c.enabled)}
              >
                {busy ? 'Saving…' : 'Save & continue'}
                <ArrowRight size={16} />
              </button>
            </div>
          </form>
        </PrimaryCard>
      )}
      {step === 1 && (
        <>
          <PrimaryCard className="hv-place">
            <div className="d2-card-top">
              <span className="d2-kicker">
                <span /> KNOW THE WAY FORWARD
              </span>
              <span className="d2-card-index">02 — 03</span>
            </div>
            <h1>Every point.{'\n'}A purpose.</h1>
            <p className="d2-lede">
              Inspect the monitoring points and choose a predefined demo evacuation plan.
            </p>
            <div className="hv-model-title">
              <div>
                <b>{state.facility.name}</b>
                <span>{MODEL_NOTE}</span>
              </div>
              <span className="d2-sample-tag">{enabled.length} monitoring points</span>
            </div>
            <FacilityTwin state={state} operational />
            <div className="hv-plan-grid">
              {Object.entries(evacuationPlans).map(([id, route]) => (
                <label
                  className={`hv-plan-card ${choice === id ? 'is-selected' : ''} ${!available[id as PlanId] ? 'is-blocked' : ''}`}
                  key={id}
                >
                  <input
                    type="radio"
                    name="evacuation-plan"
                    aria-label={route.name}
                    value={id}
                    checked={choice === id}
                    disabled={!available[id as PlanId] || busy}
                    onChange={() => setPlan(id as PlanId)}
                  />
                  <span className="hv-plan-icon">
                    <ArrowRight size={19} />
                  </span>
                  <span>
                    <b>{route.name}</b>
                    <small>{route.description}</small>
                    <em>
                      {available[id as PlanId]
                        ? 'Scenario-clear · stairs, not step-free'
                        : 'Blocked in this simulation'}
                    </em>
                  </span>
                  <span className="d2-radio-mark">{choice === id && <Check size={11} />}</span>
                </label>
              ))}
            </div>
            <RouteSummary state={state} />
            {activeIncidents(state).length > 0 && (
              <div className="hv-inline-alert" role="alert">
                <Bell size={17} />
                <span>
                  {activeIncidents(state)
                    .map((i) => i.name)
                    .join(' · ')}
                  . East route excluded; the predefined North route remains clear in this scenario.
                </span>
              </div>
            )}
            <SimulationControls state={state} act={act} busy={busy} />
            <div className="d2-form-footer">
              <button
                className="d2-back"
                onClick={() => {
                  setDraft(state.config);
                  setStep(0);
                }}
              >
                <ArrowLeft size={15} /> Back to Select
              </button>
              <button
                className="d2-button"
                disabled={busy || !available[choice]}
                onClick={async () => {
                  if (await act({ action: 'place', plan: choice })) setStep(2);
                }}
              >
                Review deployment
                <ArrowRight size={16} />
              </button>
            </div>
          </PrimaryCard>
        </>
      )}
      {step === 2 && (
        <PrimaryCard className="hv-deploy">
          <div className="d2-card-top">
            <span className="d2-kicker">
              <span /> A THOUGHTFUL FINAL CHECK
            </span>
            <span className="d2-card-index">03 — 03</span>
          </div>
          <h1>Ready to{'\n'}watch over it.</h1>
          <p className="d2-lede">
            Review the protection plan for your facility, then open its command center.
          </p>
          <div className="hv-deploy-facility">
            <span>
              <ShieldCheck size={32} strokeWidth={1.4} />
            </span>
            <div>
              <h2>{state.facility.name}</h2>
              <p>
                {state.facility.city} · {MODEL_NAME}
              </p>
            </div>
            <span className="d2-sample-tag">Sample model</span>
          </div>
          <dl className="hv-deploy-list">
            <div>
              <dt>Enabled protections</dt>
              <dd>
                {definitions
                  .filter((d) => state.config[d.id].enabled)
                  .map((d) => d.name)
                  .join(' · ')}
              </dd>
            </div>
            <div>
              <dt>Usage limits</dt>
              <dd>
                Electricity:{' '}
                {state.config.electricity.enabled ? `${state.config.electricity.limit} kW` : 'off'}
                <br />
                Water:{' '}
                {state.config.waterUsage.enabled ? `${state.config.waterUsage.limit} L/min` : 'off'}
              </dd>
            </div>
            <div>
              <dt>Sensor coverage</dt>
              <dd>
                {enabled.length} configured points · Level 4 only
                <br />
                <small>Other levels are not instrumented in this demo.</small>
              </dd>
            </div>
            <div>
              <dt>Evacuation plan</dt>
              <dd>
                {evacuationPlans[state.plan].name}
                <small>Predefined demo route · stairs, not step-free</small>
              </dd>
            </div>
            <div>
              <dt>Monitoring mode</dt>
              <dd>
                <span className="hv-mode">
                  <Radio size={12} /> SIMULATION
                </span>
                <small>No real hardware or external agents connected.</small>
              </dd>
            </div>
          </dl>
          {activeIncidents(state).length > 0 && (
            <div className="hv-inline-alert">
              <Bell size={17} />
              The current demo incident will carry into the command center.
            </div>
          )}
          <div className="d2-form-footer">
            <button className="d2-back" onClick={() => setStep(1)}>
              <ArrowLeft size={15} /> Back to Place
            </button>
            <button
              className="d2-button"
              disabled={busy}
              onClick={() => void act({ action: 'deploy' })}
            >
              {busy ? 'Deploying simulation…' : 'Confirm Deploy'}
              <ShieldCheck size={16} />
            </button>
          </div>
        </PrimaryCard>
      )}
    </>
  );
}
function Metric({
  icon: Icon,
  name,
  value,
  detail,
  warning,
}: {
  icon: typeof Zap;
  name: string;
  value: string;
  detail: string;
  warning: boolean;
}) {
  return (
    <div className={`hv-metric ${warning ? 'is-warning' : ''}`}>
      <span>
        <Icon size={16} />
        {name}
        <small>SIMULATED</small>
      </span>
      <b>{value}</b>
      <p>{detail}</p>
    </div>
  );
}

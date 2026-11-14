'use client';
// "How should it run here?" One site's best plan from the joint optimizer: the 24-hour schedule against the
// real grid day, and cost / CO2 / grid-peak against the cost-first pick. What-ifs re-run the optimizer.
import { useEffect, useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { Flame, Gauge, Wallet } from 'lucide-react';
import { PUBLIC_DATA_API } from '@/lib/plotstar-api';
import { LabelTag } from '../site-evidence';
import type { Combo, OptimizeResult } from './optimize-types';
import { fmtMoney, fmtNum } from './types';

const COOL: Record<string, string> = { air: 'air cooled', hybrid: 'hybrid cooled', water: 'water cooled' };

export function bestPlanFor(run: OptimizeResult | null, siteId: string): Combo | null {
  if (!run) return null;
  const mine = run.combinations.filter((c) => c.site_id === siteId);
  return mine.length ? mine.reduce((a, b) => (a.cost <= b.cost ? a : b)) : null;
}

function DayChart({ run, plan }: { run: OptimizeResult; plan: Combo }) {
  const price = run.grid.price,
    carbon = run.grid.carbon,
    sched = plan.schedule;
  const pMax = Math.max(...price),
    cMin = Math.min(...carbon),
    cMax = Math.max(...carbon),
    sMax = Math.max(...sched, 1);
  const W = 24 * 14,
    H = 120;
  const stress = new Set(plan.stress_hours);
  return (
    <svg viewBox={`0 0 ${W} ${H + 34}`} className="rp-chart" role="img" aria-label="24-hour schedule against grid price and carbon">
      {price.map((p, h) => {
        const t = cMax > cMin ? (carbon[h] - cMin) / (cMax - cMin) : 0.5; // 0 = cleanest, 1 = dirtiest
        const fill = `hsl(${110 - 90 * t} 45% ${78 - 20 * t}%)`;
        const ph = (p / pMax) * 44;
        const sh = (sched[h] / sMax) * 60;
        return (
          <g key={h} transform={`translate(${h * 14},0)`}>
            <rect x={1} y={46 - ph} width={12} height={ph} fill={fill} rx={1.5} />
            <rect x={1} y={H - sh} width={12} height={sh} fill={stress.has(h) ? '#c4553d' : '#264d39'} rx={1.5} opacity={0.9} />
            {h % 6 === 0 && (
              <text x={7} y={H + 14} textAnchor="middle" fontSize="8" fill="#7a8478">
                {h === 0 ? '12am' : h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h - 12}pm`}
              </text>
            )}
          </g>
        );
      })}
      <text x={0} y={56} fontSize="7.5" fill="#7a8478">
        grid: bar height = price, color = carbon (green clean, brown dirty)
      </text>
      <text x={0} y={H + 28} fontSize="7.5" fill="#7a8478">
        PlotStar schedule: MW drawn each hour (red = grid-stress hours it eases off)
      </text>
    </svg>
  );
}

function Num({ icon: Icon, label, value, delta, better }: { icon: typeof Wallet; label: string; value: string; delta?: string; better?: boolean | null }) {
  return (
    <div className="rp-num">
      <Icon size={14} />
      <small>{label}</small>
      <b>{value}</b>
      {delta && <span className={better == null ? '' : better ? 'rp-good' : 'rp-bad'}>{delta}</span>}
    </div>
  );
}

export function RunPanel({
  run,
  siteId,
  mw,
  onWhatIf,
  busy,
}: {
  run: OptimizeResult | null;
  siteId: string;
  mw: number;
  onWhatIf: (changes: Record<string, number>) => void;
  busy: boolean;
}) {
  const [priceX, setPriceX] = useState(1);
  const [carbonP, setCarbonP] = useState(50);
  useEffect(() => {
    setPriceX(run?.request?.price_multiplier ?? 1);
    setCarbonP(run?.request?.carbon_price_per_t ?? 50);
  }, [run?.run_id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!run) return <p className="xp-fine">Working out how it would run here…</p>;
  const plan = bestPlanFor(run, siteId);
  const base = run.baseline;
  const reasons = Array.from(new Set(run.infeasible.filter((x) => x.site_id === siteId).map((x) => x.reason)));

  return (
    <section className="xp-block">
      <div className="xp-block-head">
        <h3>How it should run here</h3>
        <LabelTag label="Estimated" />
      </div>

      {!plan ? (
        <div className="xp-warn">
          <b>{mw} MW can&apos;t run here.</b> {reasons.slice(0, 2).join(' ')}
        </div>
      ) : (
        <>
          <p className="rp-lede">
            Best plan: <b>{COOL[plan.cooling]}</b>
            {plan.f > 0 ? (
              <>
                , eases off <b>{Math.round(plan.d * 100)}%</b> of load for about <b>{Math.round(plan.f * 8760)} h/yr</b> when the grid is stressed
              </>
            ) : (
              <>, full power all year</>
            )}
            . Heavy jobs move into the cleanest, cheapest hours.
          </p>
          <DayChart run={run} plan={plan} />
          <div className="rp-nums">
            <Num
              icon={Wallet}
              label="Electricity / yr"
              value={fmtMoney(plan.energy_cost_year)}
              delta={base ? `${plan.energy_cost_year <= base.energy_cost_year ? '−' : '+'}${fmtMoney(Math.abs(base.energy_cost_year - plan.energy_cost_year))} vs cost-first` : undefined}
              better={base ? plan.energy_cost_year <= base.energy_cost_year : null}
            />
            <Num
              icon={Flame}
              label="CO₂ / yr"
              value={`${fmtNum(plan.co2_est_t_year / 1000, 1)}K t`}
              delta={base ? `${plan.co2_est_t_year <= base.co2_est_t_year ? '−' : '+'}${fmtNum(Math.abs(base.co2_est_t_year - plan.co2_est_t_year))} t` : undefined}
              better={base ? plan.co2_est_t_year <= base.co2_est_t_year : null}
            />
            <Num
              icon={Gauge}
              label="MW at grid peak"
              value={`${fmtNum(plan.peak_mw, 1)}`}
              delta={base ? `${plan.peak_mw <= base.peak_mw ? '−' : '+'}${fmtNum(Math.abs(base.peak_mw - plan.peak_mw), 1)} MW` : undefined}
              better={base ? plan.peak_mw <= base.peak_mw : null}
            />
          </div>
          <p className="xp-fine">
            Same work either way: moving jobs changes cost, carbon and peak, not energy.{' '}
            {run.optimized && run.optimized.site_id === siteId
              ? 'This is PlotStar’s pick for the whole search.'
              : run.optimized
                ? `PlotStar’s pick for the whole search is ${run.optimized.site_name}.`
                : ''}{' '}
            Cost-first pick: {base ? base.site_name : 'none feasible'}. Grid day: ERCOT {run.grid.price_date} prices ({run.grid.price_label}), carbon from the fuel mix ({run.grid.carbon_label}).
          </p>
        </>
      )}

      <div className="rp-whatif">
        <span className="xp-label">What if</span>
        <label className="xp-field">
          <span>
            Electricity price <b>×{priceX.toFixed(1)}</b>
          </span>
          <input type="range" min={0.7} max={2} step={0.1} value={priceX} onChange={(e) => setPriceX(+e.target.value)} onMouseUp={() => onWhatIf({ price_multiplier: priceX })} onTouchEnd={() => onWhatIf({ price_multiplier: priceX })} />
        </label>
        <label className="xp-field">
          <span>
            Carbon price <b>${carbonP}/t</b>
          </span>
          <input type="range" min={0} max={200} step={10} value={carbonP} onChange={(e) => setCarbonP(+e.target.value)} onMouseUp={() => onWhatIf({ carbon_price_per_t: carbonP })} onTouchEnd={() => onWhatIf({ carbon_price_per_t: carbonP })} />
        </label>
        {busy && <small className="xp-muted">re-optimizing…</small>}
      </div>
    </section>
  );
}

export function PickSummary({ run }: { run: OptimizeResult }) {
  const o = run.optimized,
    b = run.baseline,
    d = run.delta;
  const [why, setWhy] = useState<{ answer: string; model: string } | null>(null);
  const [asking, setAsking] = useState(false);
  useEffect(() => setWhy(null), [run.run_id]);
  async function askWhy() {
    setAsking(true);
    try {
      const r = await fetch(`${PUBLIC_DATA_API}/agent/explain`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run_id: run.run_id }) });
      setWhy(await r.json());
    } catch {
      setWhy({ answer: 'Could not reach the explainer.', model: 'none' });
    } finally {
      setAsking(false);
    }
  }
  if (!o) return <div className="xp-toast">No site can run this project with the current limits.</div>;
  return (
    <>
    <div className="pick-bar">
      <div>
        <small>PlotStar pick</small>
        <b>{o.site_name}</b>
        <span>
          {COOL[o.cooling]}
          {o.f > 0 ? ` · eases off ${Math.round(o.d * 100)}% in stress hours` : ''}
        </span>
      </div>
      <div>
        <small>Cost-first pick</small>
        <b>{b ? b.site_name : 'none'}</b>
        <span>{b ? `${COOL[b.cooling]} · flat schedule` : 'no site has full firm power'}</span>
      </div>
      {d && (
        <div className="pick-delta">
          <small>PlotStar vs cost-first</small>
          <b>
            {d.co2_est_t_year >= 0 ? '−' : '+'}
            {fmtNum(Math.abs(d.co2_est_t_year))} t CO₂/yr
          </b>
          <span>
            {d.cost >= 0 ? '−' : '+'}
            {fmtMoney(Math.abs(d.cost))} over 10 yrs · {d.peak_mw >= 0 ? '−' : '+'}
            {fmtNum(Math.abs(d.peak_mw), 1)} MW at grid peak
          </span>
        </div>
      )}
      <small className="pick-note">{run.elapsed_s}s · {run.combinations.length} plans checked · {run.rejected.length} sites failed a hard gate</small>
      <button className="pick-why" onClick={() => (why ? setWhy(null) : void askWhy())} disabled={asking}>
        <MessageCircleQuestion size={14} /> {asking ? 'Thinking…' : why ? 'Hide' : 'Why this pick?'}
      </button>
    </div>
    {why && (
      <div className="pick-why-box">
        <p>{why.answer}</p>
        <small>{why.model === 'deterministic' ? 'Explained from the optimizer’s own outputs (no model key set). ' : `Explained by the LangChain agent (${why.model}) using only tool results. `}Every number above comes from the run.</small>
      </div>
    )}
    </>
  );
}

'use client';
// "Prove it." Live watts from the two machines (or a labeled simulation), the ERCOT day replayed in 60 s,
// the grid-emergency button, and the Grid Passport. Energy and CO2 for the run are integrated client-side
// from the stream: Wh = sum(W x dt); CO2 = Wh x grid kg/MWh at the replayed hour.
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, RotateCcw, Zap } from 'lucide-react';
import { PUBLIC_DATA_API } from '@/lib/plotstar-api';
import { LabelTag } from '../site-evidence';
import type { DataLabel } from '@/lib/types';
import { fmtNum } from './types';

type Machine = { watts: number | null; progress: number | null; state: string | null; source: string; meter: string | null };
interface Tick {
  t: number;
  grid: { hour: number; price: number; carbon: number; mix?: Record<string, number> };
  machines: Record<'baseline' | 'plotstar', Machine>;
  emergency: { active: boolean; remaining_s: number | null; requested_reduction: number; source: string };
  passport_live: Record<string, unknown> | null;
  labels: Record<'baseline' | 'plotstar', DataLabel>;
  telemetry_configured: boolean;
}
interface Passport {
  created_at: string;
  duration_s: number;
  response_time_s: number | null;
  pre_watts: Record<string, number>;
  watts_during: Record<string, number>;
  reduction_measured: Record<string, number | null>;
  job_state: Record<string, string>;
  source: Record<string, string>;
  trigger: string;
}

const KEEP = 90;

function Spark({ data, color, max }: { data: number[]; color: string; max: number }) {
  const W = 300,
    H = 70;
  const pts = data.map((v, i) => `${(i / (KEEP - 1)) * W},${H - (v / max) * (H - 6) - 3}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-spark" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  );
}

export function Meters({ priceDate }: { priceDate?: string | null }) {
  const [tick, setTick] = useState<Tick | null>(null);
  const [hist, setHist] = useState<{ baseline: number[]; plotstar: number[] }>({ baseline: [], plotstar: [] });
  const [passport, setPassport] = useState<Passport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const acc = useRef({ baseline: { wh: 0, g: 0 }, plotstar: { wh: 0, g: 0 }, last: 0 });
  const [, force] = useState(0);

  useEffect(() => {
    const es = new EventSource(`${PUBLIC_DATA_API}/telemetry/stream`);
    es.addEventListener('tick', (ev) => {
      const d: Tick = JSON.parse((ev as MessageEvent).data);
      setTick(d);
      setErr(null);
      setHist((h) => ({
        baseline: [...h.baseline, d.machines.baseline.watts ?? 0].slice(-KEEP),
        plotstar: [...h.plotstar, d.machines.plotstar.watts ?? 0].slice(-KEEP),
      }));
      const a = acc.current;
      const dt = a.last ? Math.min(5, d.t - a.last) : 0;
      a.last = d.t;
      (['baseline', 'plotstar'] as const).forEach((m) => {
        const w = d.machines[m].watts ?? 0;
        a[m].wh += (w * dt) / 3600;
        a[m].g += ((w * dt) / 3600) * d.grid.carbon; // Wh x g/kWh / 1000 ... carbon is kg/MWh = g/kWh
      });
      force((n) => n + 1);
    });
    es.onerror = () => setErr(`No stream from ${PUBLIC_DATA_API}`);
    return () => es.close();
  }, []);

  useEffect(() => {
    if (tick && !tick.emergency.active && tick.passport_live == null) {
      fetch(`${PUBLIC_DATA_API}/passport/latest`)
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => p && setPassport(p))
        .catch(() => {});
    }
  }, [tick?.emergency.active]); // eslint-disable-line react-hooks/exhaustive-deps

  async function emergency() {
    await fetch(`${PUBLIC_DATA_API}/hardware/emergency`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration_s: 20, reduction: 0.5, source: 'software' }),
    });
  }
  async function reset() {
    await fetch(`${PUBLIC_DATA_API}/hardware/reset`, { method: 'POST' });
    acc.current = { baseline: { wh: 0, g: 0 }, plotstar: { wh: 0, g: 0 }, last: 0 };
    setHist({ baseline: [], plotstar: [] });
    setPassport(null);
  }

  if (err) return <div className="mt-wrap"><div className="xp-toast xp-toast-bad">{err}</div></div>;
  if (!tick) return <div className="mt-wrap"><div className="real-3d-status">Connecting to the meters…</div></div>;

  const maxW = Math.max(50, ...hist.baseline, ...hist.plotstar);
  const a = acc.current;
  const mix = tick.grid.mix ?? {};
  const clean = (mix['Wind'] ?? 0) + (mix['Solar'] ?? 0) + (mix['Nuclear'] ?? 0) + (mix['Hydro'] ?? 0);
  const hourLabel = (h: number) => {
    const hh = Math.floor(h) % 24;
    return hh === 0 ? '12 am' : hh === 12 ? '12 pm' : hh < 12 ? `${hh} am` : `${hh - 12} pm`;
  };

  return (
    <div className="mt-wrap">
      <div className="mt-grid">
        <div className="mt-card mt-gridday">
          <div className="mt-card-head">
            <b>The grid right now</b>
            <small>ERCOT {priceDate ?? ''} replayed in 60 s</small>
          </div>
          <div className="mt-clock">{hourLabel(tick.grid.hour)}</div>
          <div className="mt-kv">
            <span>Price</span>
            <b>${tick.grid.price.toFixed(0)}/MWh</b>
          </div>
          <div className="mt-kv">
            <span>Carbon</span>
            <b>{tick.grid.carbon.toFixed(0)} kg/MWh</b>
          </div>
          <div className="mt-mix">
            <i style={{ width: `${clean * 100}%`, background: '#5f8f45' }} title="wind + solar + nuclear + hydro" />
            <i style={{ width: `${(mix['Natural Gas'] ?? 0) * 100}%`, background: '#b8a26a' }} title="gas" />
            <i style={{ width: `${(mix['Coal and Lignite'] ?? 0) * 100}%`, background: '#6b5e4e' }} title="coal" />
          </div>
          <small className="xp-muted">
            {Math.round(clean * 100)}% clean · {Math.round((mix['Natural Gas'] ?? 0) * 100)}% gas · {Math.round((mix['Coal and Lignite'] ?? 0) * 100)}% coal
          </small>
        </div>

        {(['baseline', 'plotstar'] as const).map((m) => {
          const x = tick.machines[m];
          return (
            <div key={m} className={`mt-card mt-machine ${m}`}>
              <div className="mt-card-head">
                <b>{m === 'baseline' ? 'Cost-first machine' : 'PlotStar machine'}</b>
                <LabelTag label={tick.labels[m]} />
              </div>
              <div className="mt-watts">
                {x.watts == null ? '—' : x.watts.toFixed(0)} <small>W</small>
                <span className={`mt-state ${x.state}`}>{x.state}</span>
              </div>
              <Spark data={hist[m]} color={m === 'baseline' ? '#8a8f88' : '#264d39'} max={maxW} />
              <div className="mt-progress">
                <i style={{ width: `${(x.progress ?? 0) * 100}%` }} />
              </div>
              <small className="xp-muted">
                job {Math.round((x.progress ?? 0) * 100)}% · {fmtNum(a[m].wh, 1)} Wh · {fmtNum(a[m].g, 0)} g CO₂ so far
                {x.meter && x.meter !== 'none' ? ` · meter: ${x.meter}` : ''}
              </small>
            </div>
          );
        })}
      </div>

      <div className="mt-actions">
        <button className="mt-emergency" onClick={() => void emergency()} disabled={tick.emergency.active}>
          <AlertTriangle size={18} />
          {tick.emergency.active ? `Grid emergency · ${tick.emergency.remaining_s ?? 0}s left` : 'Grid emergency'}
        </button>
        <button className="xp-ghost" onClick={() => void reset()}>
          <RotateCcw size={14} /> Reset
        </button>
        <span className="mt-diff">
          <Zap size={14} /> PlotStar so far: {fmtNum(a.baseline.g - a.plotstar.g, 0)} g CO₂ and {fmtNum(a.baseline.wh - a.plotstar.wh, 1)} Wh less than cost-first
        </span>
      </div>

      {passport && (
        <div className="mt-passport">
          <b>Grid Passport · last event</b>
          <span>Asked to ease off {Math.round(((passport as unknown as { requested_reduction_share?: number }).requested_reduction_share ?? 0.5) * 100)}% of flexible load</span>
          <span>PlotStar responded in <b>{passport.response_time_s ?? '—'} s</b>, cut <b>{Math.round((passport.reduction_measured.plotstar ?? 0) * 100)}%</b> ({passport.pre_watts.plotstar} → {passport.watts_during.plotstar} W) for {passport.duration_s} s</span>
          <span>Cost-first machine: {Math.round((passport.reduction_measured.baseline ?? 0) * 100)}% change</span>
          <span>Jobs: PlotStar {passport.job_state.plotstar}, cost-first {passport.job_state.baseline} · readings: {passport.source.plotstar}</span>
        </div>
      )}

      <p className="xp-fine">
        {tick.telemetry_configured
          ? 'Real machines post watts to the API; when none has reported in 10 s the stream shows a labeled simulation.'
          : 'No TELEMETRY_API_KEY set, so this is the labeled simulation. Set the key and run services/controller/run.py on each machine to see real watts.'}{' '}
        CO₂ = measured Wh × the grid’s carbon at the replayed hour (Estimated). Scaling to a 100 MW site is modeled, not measured.
      </p>
    </div>
  );
}

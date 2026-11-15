'use client';
// Analyze > Compare: the concepts side by side on space and capacity, on their power / cooling / data distribution
// geometry (drawn from the engine's routes, with lengths and segment counts), and on their trade-offs.
import { useState } from 'react';
import { CircleAlert, CircleCheck } from 'lucide-react';
import type { Concept, StudioResult } from '../types';
import { ROUTE_COLOR, money, num, pct } from '../types';
import { Plan2D, type Layers } from '../plan2d';

type Sys = 'power' | 'cooling' | 'data';
const SYS: { k: Sys; label: string; from: string }[] = [
  { k: 'power', label: 'Power', from: 'substation → switchgear → hall' },
  { k: 'cooling', label: 'Cooling', from: 'heat rejection yard → mechanical room → hall' },
  { k: 'data', label: 'Data', from: 'meet-me room → hall' },
];
const LEN: Record<Sys, (c: Concept) => number> = { power: (c) => c.metrics.power_route_m, cooling: (c) => c.metrics.cooling_route_m, data: (c) => c.metrics.data_route_m };
const segs = (c: Concept, k: Sys) => c.routes[k].reduce((s, line) => s + Math.max(0, line.length - 1), 0);

function Table({ cs, rows }: { cs: Concept[]; rows: [string, (c: Concept) => number, (n: number) => string, boolean | null][] }) {
  return (
    <table className="st-table st-cmp cs-table">
      <thead><tr><th />{cs.map((c) => <th key={c.id}>{c.name}</th>)}</tr></thead>
      <tbody>{rows.map(([label, get, fmt, lower]) => {
        const v = cs.map(get), best = lower == null ? null : lower ? Math.min(...v) : Math.max(...v), tie = v.every((x) => x === v[0]);
        return <tr key={label}><td>{label}</td>{v.map((x, i) => <td key={i} className={`n ${best != null && !tie && x === best ? 'best' : ''}`}>{fmt(x)}</td>)}</tr>;
      })}</tbody>
    </table>
  );
}

export function CompareSystems({ r }: { r: StudioResult }) {
  const [tab, setTab] = useState<'space' | 'systems' | 'trade'>('systems');
  const [sys, setSys] = useState<Sys>('power');
  const cs = [...r.concepts].sort((a, b) => a.rank - b.rank);
  const base: Layers = { racks: false, labels: false, power: sys === 'power', cooling: sys === 'cooling', data: sys === 'data', yard: true, site: false, tags: false, aerial: false, roof: 0, level: null, explode: 0, context: false, walls: false };
  return (
    <section className="st-card cs">
      <div className="cs-head">
        <h3>Compare the concepts</h3>
        <div className="st-seg">
          {([['space', 'Space and capacity'], ['systems', 'Systems'], ['trade', 'Trade-offs']] as const).map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
      </div>
      {tab === 'space' && (
        <Table cs={cs} rows={[
          ['Building footprint', (c) => c.metrics.footprint_m2, (n) => `${num(n)} m²`, true],
          ['Gross floor area', (c) => c.metrics.gross_floor_m2, (n) => `${num(n)} m²`, null],
          ['Storeys', (c) => c.metrics.storeys, (n) => num(n), null],
          ['Data hall area', (c) => c.metrics.hall_area_m2, (n) => `${num(n)} m²`, null],
          ['Circulation share', (c) => c.metrics.corridor_share, (n) => pct(n, 1), true],
          ['Racks placed', (c) => c.metrics.placed_racks, (n) => num(n), false],
          ['Rack positions', (c) => c.metrics.rack_positions, (n) => num(n), false],
          ['Spare positions', (c) => c.metrics.spare_positions, (n) => num(n), false],
          ['Expansion bay positions', (c) => c.metrics.expansion_bay_positions, (n) => num(n), false],
          ['Outdoor plant area', (c) => c.metrics.yard_area_m2, (n) => `${num(n)} m²`, true],
          ['Site coverage', (c) => c.metrics.site_coverage, (n) => pct(n), true],
          ['Site left open', (c) => c.resources.open_land_share, (n) => pct(n), false],
        ]} />
      )}
      {tab === 'systems' && (
        <>
          <div className="cs-sys">
            <div className="st-seg">{SYS.map((s) => <button key={s.k} className={sys === s.k ? 'on' : ''} onClick={() => setSys(s.k)}><i style={{ background: ROUTE_COLOR[s.k] }} />{s.label}</button>)}</div>
            <span className="st-muted st-small">Routes as the engine draws them: {SYS.find((s) => s.k === sys)!.from}, one run per hall, orthogonal.</span>
          </div>
          <div className="cs-grid">
            {cs.map((c) => (
              <figure key={c.id} className="cs-fig">
                <div className="cs-plan"><Plan2D concept={c} siteW={r.brief.site_w} siteD={r.brief.site_d} setback={r.brief.setback_m} layers={base} mini /></div>
                <figcaption>
                  <b>{c.name}</b>
                  <span><em style={{ color: ROUTE_COLOR[sys] }}>{num(LEN[sys](c))} m</em> of {sys} route · {c.routes[sys].length} runs · {segs(c, sys)} segments</span>
                </figcaption>
              </figure>
            ))}
          </div>
          <Table cs={cs} rows={[
            ['Power route length', (c) => c.metrics.power_route_m, (n) => `${num(n)} m`, true],
            ['Cooling route length', (c) => c.metrics.cooling_route_m, (n) => `${num(n)} m`, true],
            ['Data route length', (c) => c.metrics.data_route_m, (n) => `${num(n)} m`, true],
            ['Power segments', (c) => segs(c, 'power'), (n) => num(n), true],
            ['Cooling segments', (c) => segs(c, 'cooling'), (n) => num(n), true],
            ['Distribution cost', (c) => c.money.distribution, money, true],
            ['Facility load', (c) => c.resources.facility_mw, (n) => `${num(n, 1)} MW`, null],
            ['Generators', (c) => c.metrics.generators, (n) => num(n), null],
          ]} />
        </>
      )}
      {tab === 'trade' && (
        <div className="cs-trade">
          {cs.map((c) => {
            const bad = c.checks.filter((k) => !k.ok);
            return (
              <article key={c.id}>
                <h4>{c.name}</h4>
                {c.why && <p className="st-small"><b>Why it was picked.</b> {c.why}</p>}
                <p className="st-small"><b>Advantage.</b> {c.advantage}</p>
                <p className="st-small"><b>Trade-off.</b> {c.tradeoff}</p>
                <p className={`st-small cs-checks ${bad.length ? 'bad' : 'ok'}`}>{bad.length ? <CircleAlert size={13} /> : <CircleCheck size={13} />} {bad.length ? `${bad.length} check${bad.length > 1 ? 's' : ''} failing: ${bad.map((k) => k.name).join(', ')}` : `All ${c.checks.length} checks pass`}</p>
                <p className="st-small st-muted">{money(c.money.capex)} to build · NPV {money(c.money.npv)} · {c.people.noise_at_boundary_dba != null ? `${c.people.noise_at_boundary_dba} dBA at the boundary` : 'no generator yard'}{(c.money.uncosted ?? []).length ? ` · not costed: ${c.money.uncosted!.join(', ')}` : ''}</p>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

'use client';
// GeoStar landing. Editorial layout: numbered sections, monospace labels, a real Vexcel aerial, a live 3D model and
// numbers that come from the layout engine and from MongoDB Atlas. Nothing here is a mock: when the API is down the
// live panels say so instead of showing placeholders.
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ArrowRight, ArrowUpRight, Check } from 'lucide-react';
import { Brand } from '@/components/brand';
import { PUBLIC_DATA_API } from '@/lib/plotstar-api';
import { Plan2D, type Layers } from '@/components/studio/plan2d';
import type { StudioResult } from '@/components/studio/types';
import type { PreviewProjectType } from '@/components/dashboard-2/sample-data';

const ConceptModel = dynamic(() => import('@/components/dashboard-2/concepts/concept-model'), { ssr: false, loading: () => <div className="lp-3d-wait">Loading model…</div> });

/** A Houston parcel from the CoStar kit with Vexcel coverage; its name and address stay on this machine. */
const PARCEL = 'costar:9220364';
const LAT = 29.9287658, LON = -95.3390666; // parcel centroid from the local CoStar kit
const AERIAL = `${PUBLIC_DATA_API}/vexcel/ortho/${PARCEL}.jpg?buffer_m=500`;
const BRIEF = { name: 'Houston 20 MW', mw_it: 20, rack_kw: 20, redundancy: 'N+1', cooling: 'liquid', halls: null, site_w: 320, site_d: 240, setback_m: 8, expansion_pct: 10, flexible_share: 0.3, storeys: 1, rent_kw_month: null };
const LAYERS: Layers = { racks: true, labels: false, power: true, cooling: true, data: false, yard: true, site: true, tags: false, aerial: true, roof: 1, level: null, explode: 0, context: false };

const STEPS = [
  ['Define', 'Say what you want to build. Capacity, cooling, redundancy, how much room to grow.'],
  ['Generate', 'The layout engine lays the same brief out three ways on the real parcel.'],
  ['Explore', 'Walk it in 2D on the Vexcel aerial, turn it in 3D, move things and watch every number re-check.'],
  ['Analyze', 'Money, people, planet and resources for each option, with a label on every figure.'],
  ['Compare', 'Side by side. If two are too close to call, it says so.'],
  ['Decide', 'Pick one and write down why. The decision is stored, with its reasons.'],
  ['Deliver', 'DXF for the engineers, a decision report for everyone else.'],
] as const;

// CoStar News, Lou Hirsh, 5 Oct 2026: "Data center growth expected to hold steady in face of project protests".
const STATS_SRC = 'https://www.costar.com/article/1532454970/goldman-reports-data-center-capacity-growth-holds-firm-despite-rising-project-resistance';
const STATS = [
  ['64 GW', 'US data center capacity Goldman Sachs expects by the end of 2026'],
  ['1,500+', 'data center projects in planning nationwide (Pew Research Center)'],
  ['~400', 'US cities and towns considering moratoriums on new data centers'],
  ['14', 'states considering the same'],
] as const;

const MODELS: { id: PreviewProjectType; label: string }[] = [
  { id: 'data-center', label: 'Data center' }, { id: 'wind', label: 'Wind farm' }, { id: 'solar', label: 'Solar farm' },
  { id: 'park', label: 'Park' }, { id: 'commercial', label: 'Commercial' },
];

type Decision = { project_id: string; event: string; at: string; preferred: string | null; mw_it: number; summary?: { concept?: string; capex?: number; npv?: number; months_to_power?: number } };

const pc = (v: number) => Math.round(v <= 1 ? v * 100 : v);
const m$ = (n: number) => `$${(n / 1e6).toFixed(0)} M`;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function Home() {
  const [result, setResult] = useState<StudioResult | null>(null);
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [apiDown, setApiDown] = useState(false);
  const [model, setModel] = useState<PreviewProjectType>('data-center');
  const [withGeo, setWithGeo] = useState(true);

  useEffect(() => {
    const ctl = new AbortController();
    const post = (path: string, body: unknown) => fetch(`${PUBLIC_DATA_API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal, body: JSON.stringify(body) })
      .then((r) => r.ok ? r.json() : Promise.reject(r.status));
    // Screen the parcel against the public record (homes, schools, flood, water, power), then lay it out.
    post('/sites/evaluate', { lat: LAT, lon: LON, acres: 20, market: 'Houston', thresholds: { min_home_distance_m: 300 }, name: 'Landing parcel' })
      .then((s) => post('/studio/generate', { brief: BRIEF, site: { id: PARCEL, lat: LAT, lon: LON, gates: s?.screen?.gates ?? [] }, priorities: {}, edits: {} }))
      .then(setResult).catch(() => setApiDown(true));
    fetch(`${PUBLIC_DATA_API}/atlas/decisions`, { signal: ctl.signal })
      .then((r) => r.ok ? r.json() : Promise.reject(r.status)).then((d) => setDecisions((d.decisions ?? []).slice(0, 5))).catch(() => setDecisions([]));
    return () => ctl.abort();
  }, []);

  const best = useMemo(() => result?.concepts.find((c) => c.rank === 1) ?? result?.concepts[0] ?? null, [result]);

  return (
    <main className="lp">
      <nav className="lp-nav">
        <Brand />
        <span className="lp-nav-tag">Site intelligence for AI infrastructure</span>
        <div className="lp-nav-links">
          <a href="#how">How it works</a><a href="#models">Models</a><a href="#numbers">Numbers</a>
          <Link href="/studio/data">Data</Link><Link href="/studio/agent">Agent</Link>
        </div>
        <Link href="/studio" className="lp-btn lp-btn-dark">Open the studio <ArrowRight size={15} /></Link>
      </nav>

      {/* Hero: a real Vexcel aerial of a Houston parcel under a light wash */}
      <header className="lp-hero">
        <img className="lp-hero-img" src={AERIAL} alt="" aria-hidden="true" />
        <div className="lp-hero-wash" />
        <div className="lp-hero-copy">
          <h1>Site intelligence for<br /><em>AI infrastructure.</em></h1>
          <p>GeoStar turns a real parcel, a capacity brief and the public record of the place into three measured layouts, so a data center team can decide where to build and how, before detailed design begins.</p>
          <div className="lp-actions">
            <Link href="/studio" className="lp-btn lp-btn-primary">Start a project <ArrowRight size={16} /></Link>
            <a href="#how" className="lp-btn lp-btn-ghost">See how it works</a>
          </div>
          <small>Built for data center developers, EPCs and the people who live next door.</small>
        </div>
        <span className="lp-hero-credit">Aerial: Vexcel Imaging · Houston, TX</span>
      </header>

      {/* 01 The problem */}
      <section className="lp-sec" id="problem">
        <Eyebrow n="01" label="The problem" />
        <h2>A data center site is not<br />a collection of independent checks.</h2>
        <ol className="lp-chain" aria-label="Each factor affects the next">
          {['Power', 'Water', 'Homes', 'Grid carbon', 'Cost'].map((w) => <li key={w}>{w}</li>)}
        </ol>
        <div className="lp-two">
          <div className="lp-lines"><p>Power affects cooling.</p><p>Cooling affects water.</p><p>Water affects the neighbours.</p><p><b>The neighbours decide if it gets built.</b></p></div>
          <div>
            <p className="lp-muted">Today these are checked in different tools, by different people, at different times. The cheapest site wins on a spreadsheet and loses at the planning meeting.</p>
            <blockquote>A site only wins if it wins on money, people and planet. Nothing is averaged away.</blockquote>
          </div>
        </div>
      </section>

      {/* 02 Numbers from a verifiable source */}
      <section className="lp-sec lp-sec-tint" id="numbers">
        <Eyebrow n="02" label="Why it matters now" />
        <div className="lp-stats">
          {STATS.map(([v, d]) => <div key={v} className="lp-stat"><b>{v}</b><span>{d}</span></div>)}
        </div>
        <p className="lp-source">Source: <a href={STATS_SRC} target="_blank" rel="noreferrer">CoStar News, “Data center growth expected to hold steady in face of project protests”, 5 Oct 2026 <ArrowUpRight size={12} /></a>. Figures as reported by CoStar from Goldman Sachs and the Pew Research Center.</p>
      </section>

      {/* 03 Design decisions compound: the engine's best layout drawn on the Vexcel aerial */}
      <section className="lp-sec lp-sec-dark" id="compound">
        <Eyebrow n="03" label="One shared model" light />
        <h2>Design decisions compound.</h2>
        <div className="lp-plan">
          {best && result ? (
            <Plan2D concept={best} siteW={result.brief.site_w} siteD={result.brief.site_d} setback={result.brief.setback_m} layers={LAYERS} aerialId={PARCEL} />
          ) : <div className="lp-plan-wait">{apiDown ? 'Layout engine offline. Start the API to see the live plan.' : 'Laying out three concepts…'}</div>}
          <span className="lp-plan-tag a">ZONE_A · DATA HALLS</span>
          <span className="lp-plan-tag b">SETBACK {BRIEF.setback_m.toFixed(1)} M</span>
          {result?.site.substation_km != null && <span className="lp-plan-tag c">SUBSTATION {result.site.substation_km.toFixed(1)} KM</span>}
        </div>
        <dl className="lp-meta">
          <div><dt>[ Project_001 ]</dt><dd>Early design</dd></div>
          <div><dt>Capacity</dt><dd>{BRIEF.mw_it} MW IT</dd></div>
          <div><dt>Site</dt><dd>Houston, Texas</dd></div>
          <div><dt>Redundancy</dt><dd>{BRIEF.redundancy}</dd></div>
          <div><dt>Concept</dt><dd>{best?.name ?? '—'}</dd></div>
          <div><dt>Status</dt><dd>Option study</dd></div>
        </dl>
      </section>

      {/* 04 How we build: seven cards */}
      <section className="lp-sec" id="how">
        <Eyebrow n="04" label="How we build" />
        <h2>Seven steps. One model of the place.</h2>
        <div className="lp-steps">
          {STEPS.map(([t, d], i) => (
            <article key={t} className="lp-card" style={{ '--i': i } as CSSProperties}>
              <span className="lp-card-n">0{i + 1}</span>
              <StepArt i={i} />
              <h3>{t}</h3><p>{d}</p>
            </article>
          ))}
          <Link href="/studio" className="lp-card lp-card-cta"><span>Try it on a real parcel</span><ArrowUpRight size={22} /></Link>
        </div>
      </section>

      {/* 05 Live model and three dashboard snippets */}
      <section className="lp-sec lp-sec-tint" id="models">
        <Eyebrow n="05" label="Models and numbers" />
        <h2>See it before it exists.</h2>
        <div className="lp-live">
          <div className="lp-3d">
            <div className="lp-3d-canvas"><ConceptModel type={model} /></div>
            <div className="lp-3d-bar">
              <div className="lp-pills" role="tablist">
                {MODELS.map((m) => <button key={m.id} role="tab" aria-selected={model === m.id} className={model === m.id ? 'on' : ''} onClick={() => setModel(m.id)}>{m.label}</button>)}
              </div>
              <span>Drag to turn · Concept models, not surveyed replicas</span>
            </div>
          </div>

          <div className="lp-snips">
            <div className="lp-snip">
              <header><span>Compare</span><small>{result ? `${result.finance.label} · ${result.finance.analysis_years}-yr NPV` : 'Layout engine'}</small></header>
              {result ? (
                <table>
                  <thead><tr><th>Concept</th><th>Capex</th><th>NPV P50</th><th>Noise at edge</th></tr></thead>
                  <tbody>{result.concepts.map((c) => (
                    <tr key={c.id} className={c.rank === 1 ? 'lead' : ''}>
                      <td>{c.rank === 1 && <Check size={12} />}{c.name}</td><td>{m$(c.money.capex)}</td><td>{m$(c.money.npv_p50)}</td><td>{c.people.noise_at_boundary_dba.toFixed(0)} dBA</td>
                    </tr>))}</tbody>
                </table>
              ) : <p className="lp-snip-empty">{apiDown ? 'API offline' : 'Computing…'}</p>}
              {result?.ranking.close && <footer>{result.ranking.note}</footer>}
            </div>

            <div className="lp-snip">
              <header><span>Scores</span><small>{best?.name ?? 'Best concept'}</small></header>
              {best ? (['money', 'people', 'planet', 'resources'] as const).map((f) => (
                <div key={f} className="lp-bar"><span>{f}</span><i><b style={{ width: `${pc(best.scores[f])}%` }} /></i><em>{pc(best.scores[f])}</em></div>
              )) : <p className="lp-snip-empty">{apiDown ? 'API offline' : 'Computing…'}</p>}
            </div>

            <div className="lp-snip">
              <header><span>Decisions</span><small>MongoDB Atlas · live</small></header>
              {decisions === null ? <p className="lp-snip-empty">Loading…</p> : decisions.length === 0 ? <p className="lp-snip-empty">No decisions stored yet.</p> : (
                <ul className="lp-feed">{decisions.map((d, i) => (
                  <li key={i}><i className={d.event.endsWith('decided') ? 'ok' : ''} /><span>{d.event.replace('project.', '')} · {d.summary?.concept ?? '—'} · {d.mw_it} MW{d.summary?.capex ? ` · ${m$(d.summary.capex)}` : ''}</span><time>{when(d.at)}</time></li>
                ))}</ul>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* 06 Today vs with GeoStar */}
      <section className="lp-sec" id="today">
        <Eyebrow n="06" label="Why GeoStar" />
        <div className="lp-toggle" role="tablist">
          <button role="tab" aria-selected={!withGeo} className={!withGeo ? 'on' : ''} onClick={() => setWithGeo(false)}>Today</button>
          <button role="tab" aria-selected={withGeo} className={withGeo ? 'on' : ''} onClick={() => setWithGeo(true)}>With GeoStar</button>
        </div>
        <div className={`lp-compare ${withGeo ? 'is-geo' : ''}`}>
          <img src={AERIAL} alt="Vexcel aerial of the Houston parcel" />
          <div className="lp-compare-notes">
            {withGeo ? (
              <>
                <span className="lp-plan-tag">HOMES {result?.site.home_distance_m != null ? `${Math.round(result.site.home_distance_m)} M` : '—'}</span>
                <span className="lp-plan-tag">POWER {result?.site.substation_km != null ? `${result.site.substation_km.toFixed(1)} KM` : '—'}</span>
                {result?.site.gates.map((g) => <span key={g.gate} className={`lp-plan-tag ${g.status === 'Fail' ? 'bad' : ''}`}>{g.gate} · {g.status}</span>)}
              </>
            ) : <span className="lp-plan-tag muted">A PARCEL, A PRICE, A HUNCH</span>}
          </div>
          <p>{withGeo ? 'One shared model: parcel, homes, flood, water stress, power and grid carbon, evaluated together.' : 'Separate tools, separate assumptions, and the neighbours find out last.'}</p>
        </div>
      </section>

      {/* 07 Sources and more */}
      <section className="lp-sec lp-sec-tint" id="sources">
        <Eyebrow n="07" label="Every number has a source" />
        <ul className="lp-sources">
          {[['CoStar', 'Parcels, comps, tenancy'], ['Vexcel', 'Aerials and 3D meshes'], ['Matterport', 'Walk-throughs'], ['ERCOT', 'Prices and grid carbon'], ['FEMA', 'Flood zones'], ['WRI Aqueduct', 'Water stress'], ['OpenStreetMap', 'Homes and power lines'], ['MongoDB Atlas', 'Projects, decisions, telemetry']].map(([n, d]) => (
            <li key={n}><b>{n}</b><span>{d}</span></li>
          ))}
        </ul>
        <div className="lp-more">
          {[['/studio/agent', 'How the AI works', 'A live LangGraph pipeline with LangSmith traces.'], ['/studio/data', 'The data platform', 'Schema, search, vectors, geo and change streams in Atlas.'], ['/explore', 'Explore Houston', 'Real CoStar parcels on the map, gated by public data.'], ['/dashboard-2', 'Live operations', 'Protect and deploy what you built.']].map(([h, t, d]) => (
            <Link key={h} href={h} className="lp-card lp-card-link"><h3>{t}</h3><p>{d}</p><ArrowUpRight size={18} /></Link>
          ))}
        </div>
      </section>

      <section className="lp-cta">
        <h2>Decide where to build.<br /><em>Prove it.</em></h2>
        <Link href="/studio" className="lp-btn lp-btn-primary">Open the studio <ArrowRight size={16} /></Link>
      </section>
      <footer className="lp-footer">
        <Brand /><span>© {new Date().getFullYear()} GeoStar · Conceptual planning evidence, not engineering design.</span>
      </footer>
    </main>
  );
}

function Eyebrow({ n, label, light = false }: { n: string; label: string; light?: boolean }) {
  return <span className={`lp-eyebrow ${light ? 'light' : ''}`}><b>[{n}]</b><i />{label}</span>;
}

/** Tiny line drawings for the step cards. */
function StepArt({ i }: { i: number }) {
  const s = { stroke: 'currentColor', fill: 'none', strokeWidth: 1.2 } as const;
  return (
    <svg className="lp-card-art" viewBox="0 0 120 56" aria-hidden="true">
      {i === 0 && <><rect x="8" y="12" width="104" height="32" rx="4" {...s} /><path d="M20 28h40M20 36h24" {...s} /><rect x="76" y="22" width="24" height="12" rx="6" fill="currentColor" opacity=".25" /></>}
      {i === 1 && <>{[8, 46, 84].map((x, k) => <g key={k}><rect x={x} y="10" width="28" height="36" rx="2" {...s} /><rect x={x + 5} y={16 + k * 3} width="18" height={10 - k * 2} fill="currentColor" opacity=".25" /><rect x={x + 5} y={32} width="18" height="8" fill="currentColor" opacity=".25" /></g>)}</>}
      {i === 2 && <><path d="M10 40 L60 14 L110 40 L60 50 Z" {...s} /><path d="M38 34 L60 24 L82 34 L60 44 Z M38 34v-8 L60 16 L82 26v8 M60 44v-8" {...s} /></>}
      {i === 3 && <>{[['M', 0.78], ['P', 0.92], ['E', 0.84], ['R', 0.7]].map(([l, v], k) => <g key={l as string}><text x="8" y={14 + k * 11} fontSize="7" fill="currentColor" opacity=".6">{l}</text><rect x="20" y={8 + k * 11} width="92" height="5" rx="2.5" fill="currentColor" opacity=".12" /><rect x="20" y={8 + k * 11} width={92 * (v as number)} height="5" rx="2.5" fill="currentColor" opacity=".55" /></g>)}</>}
      {i === 4 && <>{[0, 1, 2].map((k) => <rect key={k} x={10 + k * 36} y={44 - [22, 34, 16][k]} width="26" height={[22, 34, 16][k]} rx="2" fill="currentColor" opacity={k === 1 ? '.55' : '.2'} />)}<path d="M8 46h104" {...s} /></>}
      {i === 5 && <><circle cx="60" cy="28" r="18" {...s} /><path d="M50 28l7 7 13-14" {...s} strokeWidth="2" /></>}
      {i === 6 && <><rect x="34" y="6" width="52" height="44" rx="3" {...s} /><path d="M44 18h32M44 26h32M44 34h18" {...s} /><path d="M78 36l8 8M86 36l-8 8" {...s} /></>}
    </svg>
  );
}

'use client';
// PlotStar Studio: brief -> three layouts -> explore -> analyze -> compare -> decide -> deliver.
// Geometry and every number come from POST /studio/generate; nothing is computed or invented in the browser.
import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import {
  ArrowLeft, ArrowRight, Box as BoxIcon, Check, CircleAlert, CircleCheck, Coins, Columns2, Download, Droplets, Leaf, Lock,
  MapPin, Sparkles, Square, Star, Users,
} from 'lucide-react';
import { Brand } from '../brand';
import { PUBLIC_DATA_API } from '@/lib/plotstar-api';
import type { GateResult } from '@/lib/types';
import type { ExploreSite } from '../explore/types';
import { verdict } from '../explore/types';
import type { MapMode } from '../explore/explore-map';
import { Plan2D, type Layers } from './plan2d';
import type { Brief, Concept, Factor, Room, StudioResult } from './types';
import { COOLING_LABEL, ROUTE_COLOR, TYPE_STYLE, WHY, download, money, num, pct, toDxf } from './types';

const ExploreMap = dynamic(() => import('../explore/explore-map'), { ssr: false, loading: () => <div className="st-loading">Loading map…</div> });
const Model3D = dynamic(() => import('./model3d'), { ssr: false, loading: () => <div className="st-loading">Loading 3D model…</div> });

const STEPS = [
  { key: 'Define', hint: 'Brief and site' }, { key: 'Generate', hint: 'Create your options' }, { key: 'Explore', hint: 'Inspect the plans' },
  { key: 'Analyze', hint: 'Money, people, planet' }, { key: 'Compare', hint: 'Weigh the trade-offs' }, { key: 'Decide', hint: 'Record your choice' },
  { key: 'Deliver', hint: 'Export the concept' },
] as const;
const FACTORS: { key: Factor; label: string; icon: typeof Coins; ask: string }[] = [
  { key: 'money', label: 'Money', icon: Coins, ask: 'Lowest cost to build and run for ten years' },
  { key: 'people', label: 'People', icon: Users, ask: 'Standby generators kept far from the boundary' },
  { key: 'planet', label: 'Planet', icon: Leaf, ask: 'Less build carbon, more usable roof for solar' },
  { key: 'resources', label: 'Resources', icon: Droplets, ask: 'Less land used, more room for future racks' },
];
const GATE_FACTOR: Record<string, Factor> = {
  'Residential proximity': 'people', 'Flood exposure': 'planet', 'Water stress': 'resources', 'Grid proximity': 'resources',
};
const DEFAULT: Brief = { name: 'Houston 20 MW', market: 'Houston', mw: 20, rackKw: 20, redundancy: 'N+1', cooling: 'liquid', halls: null, siteW: 320, siteD: 240, setback: 8, expansion: 10, flex: 30 };
const SAVE_KEY = 'plotstar-studio-v1';
/** CoStar building names are often generic ("Bldg 2", "G"), so lead with the street address. */
const siteLabel = (s: ExploreSite) => (s.area && (s.source as string | undefined) !== 'user' ? s.area : s.name);
const isUser = (s: ExploreSite) => (s.source as string | undefined) === 'user';

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${PUBLIC_DATA_API}${path}`, body === undefined ? undefined
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    const d = await r.json().catch(() => null);
    throw new Error(typeof d?.detail === 'string' ? d.detail : `${path} failed (${r.status})`);
  }
  return r.json();
}

function Tag({ label }: { label: string }) {
  return <span className={`st-tag st-tag-${label.toLowerCase()}`}>{label}</span>;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="st-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function Stat({ label, value, sub, tag }: { label: string; value: string; sub?: string; tag?: string }) {
  return <div className="st-stat"><small>{label}{tag && <Tag label={tag} />}</small><b>{value}</b>{sub && <span>{sub}</span>}</div>;
}

export function Studio() {
  const [step, setStep] = useState(0);
  const [sub, setSub] = useState(0);
  const [brief, setBrief] = useState<Brief>(DEFAULT);
  const [sites, setSites] = useState<ExploreSite[]>([]);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [mode, setMode] = useState<MapMode>('browse');
  const [prio, setPrio] = useState<Record<Factor, number>>({ money: 2, people: 2, planet: 2, resources: 2 });
  const [result, setResult] = useState<StudioResult | null>(null);
  const [base, setBase] = useState<StudioResult | null>(null);
  const [activeId, setActiveId] = useState<string>('');
  const [view, setView] = useState<'2d' | '3d' | 'split'>('split');
  const [layers, setLayers] = useState<Layers>({ racks: true, labels: true, power: false, cooling: false, data: false, yard: true, site: false });
  const [sel, setSel] = useState<string | null>(null);
  const [preferred, setPreferred] = useState<string | null>(null);
  const [reasons, setReasons] = useState('');
  const [decidedAt, setDecidedAt] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ id: string; text: string; by: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Brief>(k: K, v: Brief[K]) => setBrief((b) => ({ ...b, [k]: v }));
  const site = sites.find((s) => s.id === siteId) ?? null;
  const racks = Math.ceil((brief.mw * 1000) / brief.rackKw);
  const halls = brief.halls ?? Math.min(12, Math.max(1, Math.round(brief.mw / 5)));
  const concept = result?.concepts.find((c) => c.id === activeId) ?? result?.concepts[0] ?? null;
  const chosen = result?.concepts.find((c) => c.id === preferred) ?? null;

  // CoStar candidates for the market, already screened by the hard gates
  useEffect(() => {
    let alive = true;
    api<{ sites: Omit<ExploreSite, 'letter'>[] }>('/search', { market: brief.market, thresholds: { min_home_distance_m: 300 }, assumptions: {}, filters: { min_acres: 5 }, limit: 150 })
      .then((d) => alive && setSites((own) => [...own.filter(isUser), ...d.sites.map((s, i) => ({ ...s, letter: String(i + 1) }) as ExploreSite)]))
      .catch(() => alive && setError(`Can't reach the PlotStar data service at ${PUBLIC_DATA_API}. Start it and reload.`));
    return () => { alive = false; };
  }, [brief.market]);

  const pickSite = useCallback(async (id: string, list?: ExploreSite[]) => {
    setSiteId(id);
    const s = (list ?? sites).find((x) => x.id === id);
    if (!s) return;
    try {
      const d = await api<{ site_w: number; site_d: number }>(`/studio/defaults?mw_it=${brief.mw}${s.lotAcres ? `&acres=${s.lotAcres}` : ''}`);
      setBrief((b) => ({ ...b, siteW: d.site_w, siteD: d.site_d }));
    } catch { /* keep the current dimensions */ }
  }, [sites, brief.mw]);

  async function onPin(lng: number, lat: number) {
    setMode('browse'); setBusy(true);
    try {
      const acres = Math.max(5, brief.mw);
      const d = await api<{ id: string; screen: ExploreSite['screen'] }>('/sites/evaluate', { lat, lon: lng, acres, market: brief.market, thresholds: { min_home_distance_m: 300 }, name: 'My location' });
      const s = { id: d.id, name: 'My location', area: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, lat, lng, lotAcres: acres, screen: d.screen, letter: '★', source: 'user' } as unknown as ExploreSite;
      const next = [s, ...sites.filter((x) => x.id !== s.id)];
      setSites(next); void pickSite(s.id, next);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const body = useCallback((b: Brief) => ({
    brief: { name: b.name, mw_it: b.mw, rack_kw: b.rackKw, redundancy: b.redundancy, cooling: b.cooling, halls: b.halls, site_w: b.siteW, site_d: b.siteD, setback_m: b.setback, expansion_pct: b.expansion, flexible_share: b.flex / 100 },
    site: site ? { id: site.id, name: site.name, lat: site.lat, lon: site.lng, gates: site.screen?.gates ?? [] } : {},
    priorities: prio,
  }), [site, prio]);

  const generate = useCallback(async (b: Brief, keepBase: boolean) => {
    setBusy(true); setError(null);
    try {
      const r = await api<StudioResult>('/studio/generate', body(b));
      setResult(r); setSummary(null);
      if (!keepBase) { setBase(r); setPreferred(null); setDecidedAt(null); setSel(null); }
      setActiveId((cur) => (keepBase && r.concepts.some((c) => c.id === cur) ? cur : r.concepts.find((c) => c.rank === 1)!.id));
      return r;
    } catch (e) { setError((e as Error).message); return null; } finally { setBusy(false); }
  }, [body]);

  async function summarize(id: string) {
    setSummary({ id, text: '', by: '' });
    try {
      const r = await api<{ text: string; written_by: string }>('/studio/explain', { ...body(brief), concept_id: id });
      setSummary({ id, text: r.text, by: r.written_by });
    } catch (e) { setSummary(null); setError((e as Error).message); }
  }

  // what-if controls on Analyze: change the brief, regenerate, keep the first run as the comparison
  function whatIf<K extends keyof Brief>(k: K, v: Brief[K]) {
    const b = { ...brief, [k]: v };
    setBrief(b); void generate(b, true);
  }

  function decide() {
    const at = new Date().toISOString();
    setDecidedAt(at);
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ brief, siteId, preferred, reasons, at })); } catch { /* storage unavailable */ }
    setStep(6);
  }

  const report = useMemo(() => result && chosen && ({
    project: brief.name, decided_at: decidedAt, preferred_concept: chosen.name, reasons,
    site: site ? { id: site.id, name: site.name, address: site.area, lat: site.lat, lon: site.lng, source: isUser(site) ? 'User-chosen location' : 'CoStar Data Extract', gates: site.screen?.gates } : null,
    brief: result.brief, priorities: prio, operating: result.operating,
    concepts: result.concepts.map(({ rooms: _r, yard: _y, equipment: _e, routes: _ro, ...rest }) => rest),
    chosen_geometry: { building: chosen.building, rooms: chosen.rooms.map(({ rows: _rows, ...r }) => r), yard: chosen.yard },
    assumptions: result.assumptions, note: result.note,
  }), [result, chosen, brief.name, decidedAt, reasons, site, prio]);

  const canNext = [!!site && sub === 2, true, !!result, !!result, !!result, !!preferred && reasons.trim().length > 0, false][step];
  const reach = (i: number) => i <= 1 || (!!result && (i < 6 || !!decidedAt));

  function next() {
    if (step === 0) setStep(1);
    else if (step === 1) void generate(brief, false).then((r) => r && setStep(2));
    else if (step === 5) decide();
    else setStep(step + 1);
  }
  const nextLabel = ['Continue to generate', busy ? 'Generating…' : 'Generate layouts', 'Analyze concept', 'Compare concepts', 'Review decision', 'Save decision', ''][step];

  return (
    <div className="st">
      <header className="st-top">
        <Brand />
        <div className="st-top-title"><b>Studio</b><span>{brief.name} · {brief.mw} MW IT{site ? ` · ${siteLabel(site)}` : ''}</span></div>
        <nav className="st-top-nav">
          <Link href="/explore">Live operations</Link>
          <Link href="/">Home</Link>
        </nav>
      </header>
      <div className="st-body">
        <aside className="st-rail">
          <small className="st-eyebrow">Your workflow</small>
          <p className="st-rail-step">Step {step + 1} of {STEPS.length}</p>
          <ol>
            {STEPS.map((s, i) => (
              <li key={s.key} className={i === step ? 'on' : i < step ? 'done' : reach(i) ? '' : 'locked'} onClick={() => reach(i) && setStep(i)}>
                <i>{i < step ? <Check size={13} /> : reach(i) ? i + 1 : <Lock size={11} />}</i>
                <div><b>{s.key}</b><span>{i < step ? 'Completed' : s.hint}</span></div>
              </li>
            ))}
          </ol>
          <div className="st-rail-foot">
            <b>{racks.toLocaleString()} racks · {halls} halls</b>
            <span>{brief.redundancy} · {COOLING_LABEL[brief.cooling]}</span>
          </div>
        </aside>

        <main className="st-main">
          {error && <div className="st-error"><CircleAlert size={14} /> {error}</div>}

          {step === 0 && (
            <section className="st-page">
              <small className="st-eyebrow">01 · Define</small>
              <h1>What are you building, and where?</h1>
              <div className="st-tabs">
                {['Requirements', 'Site', 'Review brief'].map((t, i) => (
                  <button key={t} className={sub === i ? 'on' : ''} onClick={() => (i < 2 || site) && setSub(i)} disabled={i === 2 && !site}><i>{i + 1}</i>{t}</button>
                ))}
              </div>

              {sub === 0 && (
                <div className="st-card st-form">
                  <Field label="Project name"><input value={brief.name} onChange={(e) => set('name', e.target.value)} maxLength={80} /></Field>
                  <Field label="Market" hint="CoStar data covers these two markets.">
                    <select value={brief.market} onChange={(e) => { set('market', e.target.value as Brief['market']); setSiteId(null); }}><option>Houston</option><option>Los Angeles</option></select>
                  </Field>
                  <Field label="Target IT capacity" hint="Power available to the computers.">
                    <div className="st-unit"><input type="number" min={1} max={500} value={brief.mw} onChange={(e) => set('mw', Math.max(1, Math.min(500, +e.target.value || 1)))} /><em>MW</em></div>
                  </Field>
                  <Field label="Rack density" hint={`${racks.toLocaleString()} racks at this density.`}>
                    <div className="st-unit"><input type="number" min={3} max={200} value={brief.rackKw} onChange={(e) => set('rackKw', Math.max(3, Math.min(200, +e.target.value || 3)))} /><em>kW / rack</em></div>
                  </Field>
                  <Field label="Redundancy target" hint="How much spare power equipment.">
                    <select value={brief.redundancy} onChange={(e) => set('redundancy', e.target.value as Brief['redundancy'])}><option>N</option><option>N+1</option><option>2N</option></select>
                  </Field>
                  <Field label="Cooling strategy" hint="Sets energy overhead and water use.">
                    <select value={brief.cooling} onChange={(e) => set('cooling', e.target.value as Brief['cooling'])}>
                      {Object.entries(COOLING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </Field>
                  <Field label="Data halls" hint="Leave on auto for about 5 MW per hall.">
                    <select value={brief.halls ?? ''} onChange={(e) => set('halls', e.target.value ? +e.target.value : null)}>
                      <option value="">Auto ({Math.min(12, Math.max(1, Math.round(brief.mw / 5)))})</option>
                      {[1, 2, 3, 4, 6, 8, 10, 12].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </Field>
                  <Field label={`Work that can wait: ${brief.flex}%`} hint="Share of computing that can move to cheaper, cleaner hours.">
                    <input type="range" min={0} max={60} step={5} value={brief.flex} onChange={(e) => set('flex', +e.target.value)} />
                  </Field>
                  <div className="st-form-foot"><button className="st-btn primary" onClick={() => setSub(1)}>Next: Site <ArrowRight size={14} /></button></div>
                </div>
              )}

              {sub === 1 && (
                <div className="st-site">
                  <div className="st-map">
                    <ExploreMap market={brief.market} sites={sites} selectedId={siteId} onSelect={(id) => void pickSite(id)} mode={mode} polygon={null}
                      onPolygon={() => {}} onPin={(lng, lat) => void onPin(lng, lat)} basemap="map" />
                    <div className="st-map-tools">
                      <button className={`st-btn ${mode === 'pin' ? 'on' : ''}`} onClick={() => setMode(mode === 'pin' ? 'browse' : 'pin')}><MapPin size={13} /> {mode === 'pin' ? 'Click the map…' : 'Use my own location'}</button>
                    </div>
                  </div>
                  <div className="st-card st-site-panel">
                    {!site ? (
                      <>
                        <h3>Choose a site</h3>
                        <p className="st-muted">Each numbered marker is a real property from the CoStar data extract, already checked against homes, flood zones, water stress and distance to high-voltage power. Or drop your own pin.</p>
                        <ul className="st-site-list">
                          {sites.filter((s) => s.screen?.status !== 'Fail').slice(0, 8).map((s) => (
                            <li key={s.id} onClick={() => void pickSite(s.id)}><i>{s.letter}</i><div><b>{siteLabel(s)}</b><span>{s.name} · {num(s.lotAcres, 1)} acres · {verdict(s).label}</span></div></li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <>
                        <div className="st-site-head"><div><h3>{siteLabel(site)}</h3><span className="st-muted">{isUser(site) ? 'Your location · no CoStar record' : `CoStar property · ${site.name} · ${num(site.lotAcres, 1)} acres`}</span></div>
                          <span className={`st-verdict ${verdict(site).tone}`}>{verdict(site).label}</span></div>
                        <div className="st-gates">
                          {(site.screen?.gates ?? []).map((g: GateResult) => (
                            <div key={g.gate} className={`st-gate ${g.status === 'Pass' ? 'ok' : g.status === 'Fail' ? 'bad' : 'check'}`}>
                              {g.status === 'Pass' ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
                              <div><b>{FACTORS.find((f) => f.key === GATE_FACTOR[g.gate])?.label ?? 'Site'} · {g.gate}</b><span>{g.reason}</span><small><Tag label={g.label} /> {g.source}</small></div>
                            </div>
                          ))}
                        </div>
                        <h4>Site rectangle</h4>
                        <div className="st-row">
                          <Field label="Width"><div className="st-unit"><input type="number" value={brief.siteW} onChange={(e) => set('siteW', Math.max(60, +e.target.value || 60))} /><em>m</em></div></Field>
                          <Field label="Depth"><div className="st-unit"><input type="number" value={brief.siteD} onChange={(e) => set('siteD', Math.max(60, +e.target.value || 60))} /><em>m</em></div></Field>
                        </div>
                        <div className="st-row">
                          <Field label="Setback"><div className="st-unit"><input type="number" value={brief.setback} onChange={(e) => set('setback', Math.max(0, Math.min(100, +e.target.value || 0)))} /><em>m</em></div></Field>
                          <Field label="Land kept open"><div className="st-unit"><input type="number" value={brief.expansion} onChange={(e) => set('expansion', Math.max(0, Math.min(80, +e.target.value || 0)))} /><em>%</em></div></Field>
                        </div>
                        <p className="st-muted st-small">{num(brief.siteW * brief.siteD)} m² ({num((brief.siteW * brief.siteD) / 4046.86, 1)} acres). Pre-filled from the lot size as a rectangle; the true parcel shape is not in the data. <Tag label="Estimated" /></p>
                        <div className="st-form-foot"><button className="st-btn" onClick={() => setSiteId(null)}>Change site</button><button className="st-btn primary" onClick={() => setSub(2)}>Next: Review brief <ArrowRight size={14} /></button></div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {sub === 2 && site && (
                <div className="st-grid2">
                  <div className="st-card"><h3>Project</h3>
                    <dl className="st-dl"><dt>Name</dt><dd>{brief.name}</dd><dt>Site</dt><dd>{siteLabel(site)}</dd><dt>Market</dt><dd>{brief.market}</dd><dt>Redundancy · cooling</dt><dd>{brief.redundancy} · {COOLING_LABEL[brief.cooling]}</dd></dl></div>
                  <div className="st-card"><h3>Capacity</h3>
                    <dl className="st-dl"><dt>IT target</dt><dd>{brief.mw} MW</dd><dt>Rack density</dt><dd>{brief.rackKw} kW / rack</dd><dt>Calculated racks</dt><dd>{racks.toLocaleString()}</dd><dt>Data halls</dt><dd>{halls}</dd></dl></div>
                  <div className="st-card"><h3>Site and constraints</h3>
                    <dl className="st-dl"><dt>Site rectangle</dt><dd>{brief.siteW} × {brief.siteD} m</dd><dt>Setback</dt><dd>{brief.setback} m</dd><dt>Land kept open</dt><dd>{brief.expansion}%</dd><dt>Hard gates</dt><dd>{site.screen?.status ?? 'Unknown'}</dd></dl></div>
                  <div className="st-card"><h3>Operation</h3>
                    <dl className="st-dl"><dt>Work that can wait</dt><dd>{brief.flex}%</dd><dt>Grid</dt><dd>{brief.market === 'Houston' ? 'ERCOT day-ahead prices' : 'ERCOT day shape (no local feed)'}</dd></dl>
                    <p className="st-muted st-small">Estimates do not establish feasibility. A utility study, survey and engineering review come later.</p></div>
                </div>
              )}
            </section>
          )}

          {step === 1 && (
            <section className="st-page st-narrow">
              <small className="st-eyebrow">02 · Generate</small>
              <h1>What matters most?</h1>
              <p className="st-lede">PlotStar lays the same brief out three different ways. Your priorities decide how the three are ranked. They never relax a hard limit.</p>
              <div className="st-card">
                <div className="st-brief-line"><Stat label="IT capacity" value={`${brief.mw} MW`} sub={`${racks.toLocaleString()} racks`} /><Stat label="Halls" value={`${halls}`} sub={`${brief.redundancy} · ${brief.cooling}`} /><Stat label="Site" value={`${brief.siteW} × ${brief.siteD} m`} sub={site ? siteLabel(site) : 'No site chosen'} /><Stat label="Land kept open" value={`${brief.expansion}%`} /></div>
              </div>
              <div className="st-card">
                <h3>Ranking priorities</h3>
                {FACTORS.map((f) => (
                  <div className="st-prio" key={f.key}>
                    <f.icon size={16} /><div><b>{f.label}</b><span>{f.ask}</span></div>
                    <input type="range" min={0} max={5} value={prio[f.key]} onChange={(e) => setPrio((p) => ({ ...p, [f.key]: +e.target.value }))} aria-label={`${f.label} priority`} />
                    <em>{prio[f.key]}</em>
                  </div>
                ))}
              </div>
            </section>
          )}

          {step === 2 && result && concept && (
            <section className="st-explore">
              <div className="st-toolbar">
                <div className="st-seg">
                  {result.concepts.map((c) => <button key={c.id} className={c.id === concept.id ? 'on' : ''} onClick={() => { setActiveId(c.id); setSel(null); }}>{c.rank === 1 && <Star size={12} />}{c.name}</button>)}
                </div>
                <div className="st-seg">
                  <button className={view === '2d' ? 'on' : ''} onClick={() => setView('2d')}><Square size={13} /> 2D plan</button>
                  <button className={view === '3d' ? 'on' : ''} onClick={() => setView('3d')}><BoxIcon size={13} /> 3D model</button>
                  <button className={view === 'split' ? 'on' : ''} onClick={() => setView('split')}><Columns2 size={13} /> Side by side</button>
                </div>
              </div>
              <div className="st-explore-body">
                <div className={`st-views ${view}`}>
                  {view !== '2d' && <div className="st-view"><Model3D concept={concept} siteW={result.brief.site_w} siteD={result.brief.site_d} layers={layers} selected={sel} onSelect={setSel} /></div>}
                  {view !== '3d' && <div className="st-view st-view-plan"><Plan2D concept={concept} siteW={result.brief.site_w} siteD={result.brief.site_d} setback={result.brief.setback_m} layers={layers} selected={sel} onSelect={setSel} /></div>}
                </div>
                <Inspector concept={concept} sel={sel} layers={layers} setLayers={setLayers} />
              </div>
            </section>
          )}

          {step === 3 && result && concept && (
            <section className="st-page">
              <small className="st-eyebrow">04 · Analyze</small>
              <div className="st-head-row"><h1>{concept.name}</h1>
                <div className="st-seg">{result.concepts.map((c) => <button key={c.id} className={c.id === concept.id ? 'on' : ''} onClick={() => setActiveId(c.id)}>{c.name}</button>)}</div></div>
              <p className="st-lede">{concept.strategy}</p>
              <div className="st-card st-whatif">
                <div><b>Change a decision</b><span>Every change re-runs the layout, cost, carbon and water together.</span></div>
                <Field label="Cooling"><select value={brief.cooling} onChange={(e) => whatIf('cooling', e.target.value as Brief['cooling'])} disabled={busy}>{Object.entries(COOLING_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="Redundancy"><select value={brief.redundancy} onChange={(e) => whatIf('redundancy', e.target.value as Brief['redundancy'])} disabled={busy}><option>N</option><option>N+1</option><option>2N</option></select></Field>
                <Field label={`Work that can wait: ${brief.flex}%`}><input type="range" min={0} max={60} step={10} value={brief.flex} onChange={(e) => whatIf('flex', +e.target.value)} disabled={busy} /></Field>
              </div>
              <div className="st-card st-summary">
                <div><b>In plain words</b>
                  {summary?.id === concept.id && summary.text ? <><p>{summary.text}</p><small>{summary.by}</small></> : <span>A short summary of this concept, written only from the numbers below.</span>}
                </div>
                <button className="st-btn" onClick={() => void summarize(concept.id)} disabled={summary?.id === concept.id && !summary.text}><Sparkles size={13} /> {summary?.id === concept.id && !summary.text ? 'Writing…' : 'Summarize'}</button>
              </div>
              <Analysis c={concept} r={result} base={base?.concepts.find((x) => x.id === concept.id) ?? null} />
            </section>
          )}

          {step === 4 && result && (
            <section className="st-page">
              <small className="st-eyebrow">05 · Compare</small>
              <h1>Three ways to build the same brief</h1>
              <p className="st-lede">Ranked by your priorities. Scores compare the three with each other; they are not grades. The choice is yours.</p>
              <div className="st-compare">
                {[...result.concepts].sort((a, b) => a.rank - b.rank).map((c) => (
                  <article key={c.id} className={`st-card st-concept ${preferred === c.id ? 'pref' : ''}`}>
                    <div className="st-concept-plan"><Plan2D concept={c} siteW={result.brief.site_w} siteD={result.brief.site_d} setback={result.brief.setback_m} mini /></div>
                    <div className="st-concept-head"><h3>{c.name}</h3><span className="st-rank">{c.feasible ? `Rank ${c.rank}` : 'Does not fit'}</span></div>
                    <p className="st-muted st-small">{c.strategy}</p>
                    <div className="st-scores">{FACTORS.map((f) => <div key={f.key}><span>{f.label}</span><i><b style={{ width: `${c.scores[f.key]}%` }} /></i><em>{c.scores[f.key].toFixed(0)}</em></div>)}</div>
                    <p className="st-small"><b>Advantage.</b> {c.advantage}</p>
                    <p className="st-small"><b>Trade-off.</b> {c.tradeoff}</p>
                    <div className="st-concept-foot">
                      <button className={`st-btn ${preferred === c.id ? 'primary' : ''}`} onClick={() => setPreferred(c.id)}><Star size={13} /> {preferred === c.id ? 'Preferred' : 'Select as preferred'}</button>
                      <button className="st-btn" onClick={() => { setActiveId(c.id); setStep(2); }}>Explore plan</button>
                    </div>
                  </article>
                ))}
              </div>
              <CompareTable r={result} />
            </section>
          )}

          {step === 5 && result && (
            <section className="st-page st-narrow">
              <small className="st-eyebrow">06 · Decide</small>
              <h1>Record your choice</h1>
              <p className="st-lede">PlotStar ranks; you decide. Write down why, so the decision can be reviewed later.</p>
              <div className="st-card">
                <h3>Preferred concept</h3>
                <div className="st-choices">
                  {result.concepts.map((c) => (
                    <label key={c.id} className={preferred === c.id ? 'on' : ''}>
                      <input type="radio" name="pref" checked={preferred === c.id} onChange={() => setPreferred(c.id)} />
                      <div><b>{c.name}</b><span>Rank {c.rank} · {money(c.money.ten_year)} over 10 years · {num(c.metrics.footprint_m2)} m²</span></div>
                    </label>
                  ))}
                </div>
              </div>
              {chosen && chosen.checks.some((k) => !k.ok) && (
                <div className="st-card st-warn"><h3>Open issues with this concept</h3>
                  <ul>{chosen.checks.filter((k) => !k.ok).map((k) => <li key={k.name}><b>{k.name}.</b> {k.detail}</li>)}</ul></div>
              )}
              <div className="st-card">
                <h3>Reasons</h3>
                <textarea value={reasons} onChange={(e) => setReasons(e.target.value)} rows={5} maxLength={1200} placeholder="Why this concept, and which trade-offs you accepted." />
              </div>
            </section>
          )}

          {step === 6 && result && chosen && report && (
            <section className="st-page st-narrow">
              <small className="st-eyebrow">07 · Deliver</small>
              <h1>{chosen.name}</h1>
              <p className="st-lede">{result.brief.halls} halls · {result.brief.racks.toLocaleString()} racks · {result.brief.mw_it} MW IT at {site ? siteLabel(site) : 'the chosen site'}.</p>
              <div className="st-card">
                <h3>Continue in CAD</h3>
                <p className="st-muted">A layered 2D drawing of the chosen concept: site, building, rooms, rack rows, generators and routes. Units are metres in local site coordinates.</p>
                <button className="st-btn primary" onClick={() => download(`${brief.name.replace(/\W+/g, '-').toLowerCase()}-${chosen.id}.dxf`, toDxf(chosen, result.brief.site_w, result.brief.site_d), 'application/dxf')}><Download size={14} /> Export DXF</button>
              </div>
              <div className="st-card">
                <h3>Decision evidence</h3>
                <p className="st-muted">The saved decision with the brief, site gates and their sources, every computed quantity, and every assumption with its basis. This is planning evidence, not certified engineering.</p>
                <button className="st-btn" onClick={() => download(`${brief.name.replace(/\W+/g, '-').toLowerCase()}-decision.json`, JSON.stringify(report, null, 2), 'application/json')}><Download size={14} /> Download decision report</button>
              </div>
              <div className="st-card">
                <h3>Prove it in operation</h3>
                <p className="st-muted">Run the operating plan against live grid prices and a grid emergency on the team's hardware.</p>
                <Link className="st-btn" href="/explore">Open live operations <ArrowRight size={14} /></Link>
              </div>
            </section>
          )}
        </main>
      </div>

      <footer className="st-foot">
        <button className="st-btn" onClick={() => (step === 0 && sub > 0 ? setSub(sub - 1) : setStep(Math.max(0, step - 1)))} disabled={step === 0 && sub === 0}><ArrowLeft size={14} /> Back</button>
        <span className="st-foot-note">{busy ? 'Working…' : step === 0 && !site ? 'Choose a site to continue.' : step === 0 && sub < 2 ? 'Review the brief to continue.' : step === 5 && !canNext ? 'Select a concept and give a reason.' : result?.note ?? ''}</span>
        {step < 6 && <button className="st-btn primary big" onClick={next} disabled={!canNext || busy}>{step === 1 && <Sparkles size={14} />}{nextLabel}{step !== 1 && <ArrowRight size={14} />}</button>}
      </footer>
    </div>
  );
}

function Inspector({ concept, sel, layers, setLayers }: { concept: Concept; sel: string | null; layers: Layers; setLayers: (l: Layers) => void }) {
  const r: Room | undefined = [...concept.rooms, ...concept.yard].find((x) => x.code === sel);
  const toggles: [keyof Layers, string, string?][] = [['racks', 'Rack rows'], ['labels', 'Room labels'], ['yard', 'Outdoor plant'], ['site', 'Whole site'], ['power', 'Power routes', ROUTE_COLOR.power], ['cooling', 'Cooling routes', ROUTE_COLOR.cooling], ['data', 'Data routes', ROUTE_COLOR.data]];
  const m = concept.metrics;
  return (
    <aside className="st-inspector">
      <h4>Layers</h4>
      <div className="st-layers">
        {toggles.map(([k, label, color]) => (
          <label key={k}><input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />{color && <i style={{ background: color }} />}{label}</label>
        ))}
      </div>
      <h4>{r ? 'Inspector' : 'This concept'}</h4>
      {r ? (
        <>
          <p className="st-insp-title"><i style={{ background: TYPE_STYLE[r.type].fill, borderColor: TYPE_STYLE[r.type].stroke }} /><b>{r.code}</b> {r.name}</p>
          <dl className="st-dl">
            <dt>Type</dt><dd>{TYPE_STYLE[r.type].label}</dd>
            <dt>Size</dt><dd>{r.w.toFixed(1)} × {r.d.toFixed(1)} m</dd>
            <dt>Area</dt><dd>{num(r.w * r.d)} m²</dd>
            {r.need_m2 != null && <><dt>Area required</dt><dd>{num(r.need_m2)} m²</dd></>}
            {r.racks != null && <><dt>Racks placed</dt><dd>{num(r.racks)}</dd><dt>Rack positions</dt><dd>{num(r.positions)}</dd><dt>IT load</dt><dd>{r.mw} MW</dd></>}
            {r.hall != null && <><dt>Serves</dt><dd>Data hall {r.hall}</dd></>}
          </dl>
          <p className="st-why"><b>Why is this here?</b> {WHY[r.type]}</p>
        </>
      ) : (
        <>
          <dl className="st-dl">
            <dt>Building</dt><dd>{concept.building.w.toFixed(0)} × {concept.building.d.toFixed(0)} m</dd>
            <dt>Footprint</dt><dd>{num(m.footprint_m2)} m²</dd>
            <dt>Racks placed</dt><dd>{num(m.placed_racks)}</dd>
            <dt>Spare positions</dt><dd>{num(m.spare_positions + m.expansion_bay_positions)}</dd>
            <dt>Power route</dt><dd>{num(m.power_route_m)} m</dd>
            <dt>Cooling route</dt><dd>{num(m.cooling_route_m)} m</dd>
            <dt>Generators</dt><dd>{m.generators}</dd>
          </dl>
          <p className="st-why">Click any room in the plan or the model to see its size and why it is there.</p>
        </>
      )}
      <h4>Checks</h4>
      <ul className="st-checks">{concept.checks.map((k) => <li key={k.name} className={k.ok ? 'ok' : 'bad'}>{k.ok ? <CircleCheck size={14} /> : <CircleAlert size={14} />}<div><b>{k.name}</b><span>{k.detail}</span></div></li>)}</ul>
    </aside>
  );
}

function Delta({ now, was, unit, lowerIsBetter = true, fmt }: { now: number; was: number | undefined; unit?: string; lowerIsBetter?: boolean; fmt: (n: number) => string }) {
  if (was == null || Math.abs(now - was) < Math.abs(was) * 0.0005) return null;
  const d = now - was;
  return <span className={`st-delta ${(d < 0) === lowerIsBetter ? 'good' : 'bad'}`}>{d > 0 ? '+' : '−'}{fmt(Math.abs(d))}{unit ?? ''} vs your first brief</span>;
}

function Analysis({ c, r, base }: { c: Concept; r: StudioResult; base: Concept | null }) {
  const gate = (name: string) => r.site.gates.find((g) => g.gate === name);
  const homes = gate('Residential proximity'), flood = gate('Flood exposure'), water = gate('Water stress');
  const cap = c.money.capex;
  const bars: [string, number][] = [['Equipment', c.money.equipment], ['Building shell', c.money.shell], ['Distribution', c.money.distribution], ['Grid connection', c.money.interconnect]];
  const flexSave = c.money.energy_per_year_flat - c.money.energy_per_year;
  return (
    <>
      <div className="st-factors">
        <div className="st-card st-factor">
          <h3><Coins size={16} /> Money <Tag label="Estimated" /></h3>
          <Stat label="Cost to build" value={money(cap)} />
          <Delta now={cap} was={base?.money.capex} fmt={money} />
          <div className="st-bars">{bars.map(([k, v]) => <div key={k}><span>{k}</span><i><b style={{ width: `${(v / cap) * 100}%` }} /></i><em>{money(v)}</em></div>)}</div>
          <Stat label="Energy per year" value={money(c.money.energy_per_year)} sub={flexSave > 0 ? `${money(flexSave)} less than running flat out` : `At ${r.operating.price_flat} $/MWh wholesale`} tag={r.operating.price_label} />
          <Stat label="Ten-year total" value={money(c.money.ten_year)} sub="Build, energy, staff, water" />
          <Delta now={c.money.ten_year} was={base?.money.ten_year} fmt={money} />
          <p className="st-small st-muted">Grid connection cost is a scenario, not a quote <Tag label="Simulated" /></p>
        </div>
        <div className="st-card st-factor">
          <h3><Users size={16} /> People</h3>
          <Stat label="Nearest home" value={c.people.home_distance_m != null ? `${num(c.people.home_distance_m)} m` : 'Unknown'} sub={homes?.status === 'Pass' ? 'Clear of the limit' : homes?.reason} tag={homes?.label ?? 'Unknown'} />
          <Stat label="Generator noise at that home" value={c.people.noise_at_home_dba != null ? `${c.people.noise_at_home_dba} dBA` : 'Unknown'} sub="During tests and outages only" tag={c.people.noise_at_home_dba != null ? 'Estimated' : 'Unknown'} />
          <Stat label="Noise at the site boundary" value={`${c.people.noise_at_boundary_dba} dBA`} sub={`Generators ${c.people.generator_to_boundary_m} m from the boundary`} tag="Estimated" />
          <Stat label="Local jobs" value="Unknown" sub="No sourced jobs figure is loaded" tag="Unknown" />
        </div>
        <div className="st-card st-factor">
          <h3><Leaf size={16} /> Planet</h3>
          <Stat label="Carbon from electricity per year" value={`${num(c.planet.co2_t_per_year)} t`} sub={c.planet.co2_t_per_year_flat > c.planet.co2_t_per_year ? `${num(c.planet.co2_t_per_year_flat - c.planet.co2_t_per_year)} t less than running flat out` : `Grid at ${r.operating.carbon_flat} kg/MWh`} tag={r.operating.carbon_label} />
          <Delta now={c.planet.co2_t_per_year} was={base?.planet.co2_t_per_year} unit=" t" fmt={(n) => num(n)} />
          <Stat label="Carbon to build the shell" value={`${num(c.planet.embodied_t)} t`} tag="Estimated" />
          <Stat label="Roof solar potential" value={`${num(c.planet.roof_solar_kwp)} kWp`} sub={`${pct(c.planet.roof_solar_share, 1)} of yearly electricity`} tag="Estimated" />
          <Stat label="Flood zone" value={flood?.status ?? 'Unknown'} sub={flood?.reason} tag={flood?.label ?? 'Unknown'} />
        </div>
        <div className="st-card st-factor">
          <h3><Droplets size={16} /> Resources</h3>
          <Stat label="Water per year" value={`${num(c.resources.water_m3_per_year)} m³`} sub={water ? `Local water stress: ${water.value ?? water.status}` : undefined} tag="Estimated" />
          <Delta now={c.resources.water_m3_per_year} was={base?.resources.water_m3_per_year} unit=" m³" fmt={(n) => num(n)} />
          <Stat label="Power drawn from the grid" value={`${c.resources.facility_mw} MW`} sub={r.site.substation_km != null ? `${r.site.substation_km} km to a high-voltage substation` : 'Substation distance unknown'} tag="Estimated" />
          <Stat label="Site left open" value={pct(c.resources.open_land_share)} sub={`${num(c.metrics.footprint_m2)} m² building`} tag="Estimated" />
          <Stat label="Room for future racks" value={num(c.resources.spare_positions)} sub="Rack positions, not powered capacity" tag="Estimated" />
        </div>
      </div>
      <div className="st-card">
        <h3>Checks</h3>
        <ul className="st-checks wide">{c.checks.map((k) => <li key={k.name} className={k.ok ? 'ok' : 'bad'}>{k.ok ? <CircleCheck size={14} /> : <CircleAlert size={14} />}<div><b>{k.name}</b><span>{k.detail}</span></div></li>)}</ul>
        <details className="st-details"><summary>Assumptions behind these numbers ({r.assumptions.length})</summary>
          <table className="st-table"><tbody>{r.assumptions.map((a) => <tr key={a.key}><td>{a.basis}</td><td className="n">{num(a.value, 2)} {a.unit}</td><td><Tag label={a.label} /></td></tr>)}</tbody></table>
          <p className="st-small st-muted">{r.operating.price_source}. {r.operating.carbon_source}. {r.operating.notes.join(' ')}</p>
        </details>
      </div>
    </>
  );
}

function CompareTable({ r }: { r: StudioResult }) {
  const cs = [...r.concepts].sort((a, b) => a.rank - b.rank);
  const rows: [string, (c: Concept) => number, (n: number) => string, boolean][] = [
    ['Cost to build', (c) => c.money.capex, money, true],
    ['Ten-year total', (c) => c.money.ten_year, money, true],
    ['Building footprint', (c) => c.metrics.footprint_m2, (n) => `${num(n)} m²`, true],
    ['Room for future racks', (c) => c.resources.spare_positions, (n) => num(n), false],
    ['Power route length', (c) => c.metrics.power_route_m, (n) => `${num(n)} m`, true],
    ['Cooling route length', (c) => c.metrics.cooling_route_m, (n) => `${num(n)} m`, true],
    ['Noise at the boundary', (c) => c.people.noise_at_boundary_dba, (n) => `${n} dBA`, true],
    ['Carbon to build the shell', (c) => c.planet.embodied_t, (n) => `${num(n)} t`, true],
    ['Roof solar potential', (c) => c.planet.roof_solar_kwp, (n) => `${num(n)} kWp`, false],
    ['Site left open', (c) => c.resources.open_land_share, (n) => pct(n), false],
  ];
  return (
    <div className="st-card">
      <h3>Side by side</h3>
      <table className="st-table st-cmp">
        <thead><tr><th />{cs.map((c) => <th key={c.id}>{c.name}</th>)}</tr></thead>
        <tbody>
          {rows.map(([label, get, fmt, lower]) => {
            const vals = cs.map(get);
            const best = lower ? Math.min(...vals) : Math.max(...vals);
            const tie = vals.every((v) => v === vals[0]);
            return <tr key={label}><td>{label}</td>{vals.map((v, i) => <td key={i} className={`n ${!tie && v === best ? 'best' : ''}`}>{fmt(v)}</td>)}</tr>;
          })}
        </tbody>
      </table>
      <p className="st-small st-muted">Best value in each row is highlighted. All figures are estimates from the stated assumptions.</p>
    </div>
  );
}

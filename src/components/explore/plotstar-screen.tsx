'use client';
// One screen. Where should it go (Money · People · Planet, pass/fail gates) and how should it run
// (schedule into clean, cheap hours; prove it on the meters).
import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Activity, Bell, Bookmark, Box, Eraser, Leaf, Map as MapIcon, MapPin, PenLine, Satellite, Search, SlidersHorizontal, Users, Wallet } from 'lucide-react';
import { Brand } from '../brand';
import { PUBLIC_DATA_API } from '@/lib/plotstar-api';
import type { MapMode } from './explore-map';
import type { OptimizeResult } from './optimize-types';
import { PickSummary } from './run-panel';
import { SitePanel } from './site-panel';
import type { ExploreSite } from './types';
import { fmtMoney, fmtNum, verdict } from './types';

const ExploreMap = dynamic(() => import('./explore-map'), { ssr: false, loading: () => <div className="xp-map xp-loading">Loading map…</div> });
const Site3D = dynamic(() => import('./site-3d'), { ssr: false, loading: () => <div className="xp-map xp-loading">Loading 3D…</div> });
const Meters = dynamic(() => import('./meters').then((m) => m.Meters), { ssr: false, loading: () => <div className="xp-map xp-loading">Connecting…</div> });

type Ring = [number, number][];
interface SearchResult {
  count: number;
  counts: { Pass: number; 'Needs review': number; Fail: number };
  in_polygon: number;
  sites: Omit<ExploreSite, 'letter'>[];
}
interface Saved { id: number; name: string; count: number; shared_with: string[]; alerts: boolean }
interface Alert { type: string; name: string; detail: string }
const letterFor = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${PUBLIC_DATA_API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path} failed (${r.status})`);
  return r.json();
}

export function PlotStarScreen() {
  // the brief
  const [market, setMarket] = useState<'Houston' | 'Los Angeles'>('Houston');
  const [mw, setMw] = useState(20);
  const [flex, setFlex] = useState(30);
  const [minAcres, setMinAcres] = useState(2);
  const [needRoom, setNeedRoom] = useState(false);
  const [noFlood, setNoFlood] = useState(false);
  const [heavyPower, setHeavyPower] = useState(false);
  const [waterCooling, setWaterCooling] = useState(false);
  const [hideBad, setHideBad] = useState(false);
  const [homesM, setHomesM] = useState(300);
  const [showLimits, setShowLimits] = useState(false);
  // the map
  const [mode, setMode] = useState<MapMode>('browse');
  const [basemap, setBasemap] = useState<'map' | 'satellite'>('map');
  const [stage, setStage] = useState<'map' | '3d' | 'meters'>('map');
  const [polygon, setPolygon] = useState<Ring | null>(null);
  // results
  const [result, setResult] = useState<SearchResult | null>(null);
  const [run, setRun] = useState<OptimizeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pinNote, setPinNote] = useState<string | null>(null);
  // saved searches
  const [saved, setSaved] = useState<Saved[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);

  const thresholds = useMemo(() => ({ min_home_distance_m: homesM }), [homesM]);
  const searchReq = useMemo(
    () => ({
      market,
      polygon,
      thresholds,
      filters: {
        min_acres: minAcres || null,
        min_supportable_mw: needRoom ? mw : null,
        exclude_flood_zone: noFlood,
        heavy_power_only: heavyPower,
        water_cooling_required: waterCooling,
        hide_failed: hideBad,
      },
      limit: 120,
    }),
    [market, polygon, thresholds, minAcres, needRoom, mw, noFlood, heavyPower, waterCooling, hideBad],
  );
  const optimizeReq = useMemo(
    () => ({ market, polygon, min_acres: minAcres, thresholds, mw_it: mw, flexible_share: flex / 100, carbon_price_per_t: 50, limit: 120, offline: true }),
    [market, polygon, minAcres, thresholds, mw, flex],
  );

  const findSites = useCallback(async () => {
    setLoading(true);
    setRunBusy(true);
    setError(null);
    try {
      const d = await post<SearchResult>('/search', searchReq);
      setResult(d);
      setSelectedId((cur) => (cur && d.sites.some((s) => s.id === cur) ? cur : null));
      setLoading(false);
      const r = await post<OptimizeResult>('/optimize', optimizeReq);
      setRun({ ...r, request: optimizeReq });
    } catch (e) {
      setError((e as Error).message.includes('fetch') ? `Can't reach the PlotStar data service at ${PUBLIC_DATA_API}.` : (e as Error).message);
    } finally {
      setLoading(false);
      setRunBusy(false);
    }
  }, [searchReq, optimizeReq]);

  const whatIf = useCallback(
    async (changes: Record<string, number>) => {
      if (!run) return;
      setRunBusy(true);
      try {
        const r = await post<OptimizeResult>('/scenarios/run', { run_id: run.run_id, changes });
        setRun({ ...r, request: { ...run.request, ...changes } });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setRunBusy(false);
      }
    },
    [run],
  );

  const loadSaved = useCallback(() => {
    fetch(`${PUBLIC_DATA_API}/searches`).then((r) => (r.ok ? r.json() : [])).then(setSaved).catch(() => {});
  }, []);

  useEffect(() => {
    void findSites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polygon, market]);
  useEffect(loadSaved, [loadSaved]);

  const sites: ExploreSite[] = useMemo(() => (result?.sites ?? []).map((s, i) => ({ ...s, letter: letterFor(i) }) as ExploreSite), [result]);
  const selected = sites.find((s) => s.id === selectedId) ?? null;

  async function checkSpot(lng: number, lat: number) {
    setMode('browse');
    setPinNote('Checking that spot…');
    try {
      const d = await post<{ screen: ExploreSite['screen'] }>('/sites/evaluate', { lat, lon: lng, market, thresholds });
      const v = verdict(d);
      setPinNote(`That spot: ${v.label}. ${v.reason}.`);
    } catch {
      setPinNote('Could not check that spot.');
    }
  }

  async function saveSearch(name: string, team: string, alertsOn: boolean) {
    await post('/searches', { name, request: searchReq, alerts: alertsOn, shared_with: team.split(',').map((x) => x.trim()).filter(Boolean) });
    setSaveOpen(false);
    loadSaved();
  }
  async function checkAlerts(id: number) {
    const r = await fetch(`${PUBLIC_DATA_API}/searches/${id}/alerts?update_snapshot=true`);
    const d = await r.json();
    setAlerts(d.alerts ?? []);
    loadSaved();
  }

  const c = result?.counts;
  return (
    <div className="xp">
      <header className="xp-top">
        <Brand />
        <div className="xp-pillars" aria-label="The three pillars">
          <span><Wallet size={14} /> Money</span>
          <span><Users size={14} /> People</span>
          <span><Leaf size={14} /> Planet</span>
          <small>a site only wins if it passes all three</small>
        </div>
        <div className="xp-top-actions">
          <button className="xp-ghost" onClick={() => setSaveOpen(true)}><Bookmark size={15} /> Save search</button>
        </div>
      </header>

      <div className="xp-body">
        {/* ---------- left: the brief ---------- */}
        <aside className="xp-left">
          <h1>Where should the data center go?</h1>
          <p className="xp-lede">Real CoStar properties, checked for homes, floods, water and power.</p>

          <label className="xp-field">
            <span>Where</span>
            <select value={market} onChange={(e) => (setPolygon(null), setMarket(e.target.value as typeof market))}>
              <option>Houston</option>
              <option>Los Angeles</option>
            </select>
          </label>
          <label className="xp-field">
            <span>How big <b>{mw} MW</b></span>
            <input type="range" min={5} max={100} step={5} value={mw} onChange={(e) => setMw(+e.target.value)} />
          </label>
          <label className="xp-field">
            <span>Work that can wait <b>{flex}%</b></span>
            <input type="range" min={0} max={60} step={5} value={flex} onChange={(e) => setFlex(+e.target.value)} />
            <small className="xp-muted">AI training and batch jobs that can move to cleaner, cheaper hours</small>
          </label>
          <label className="xp-field">
            <span>Smallest lot <b>{minAcres} acres</b></span>
            <input type="range" min={0} max={30} step={1} value={minAcres} onChange={(e) => setMinAcres(+e.target.value)} />
          </label>

          <div className="xp-musts">
            <span className="xp-label">Must have</span>
            {([
              [needRoom, setNeedRoom, `Room for ${mw} MW`],
              [noFlood, setNoFlood, 'Outside flood zones'],
              [heavyPower, setHeavyPower, 'Heavy power on site'],
              [waterCooling, setWaterCooling, 'Water cooling possible'],
              [hideBad, setHideBad, 'Hide unsuitable sites'],
            ] as [boolean, (b: boolean) => void, string][]).map(([v, set, label]) => (
              <label key={label} className="xp-check">
                <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} />
                {label}
              </label>
            ))}
          </div>

          <button className="xp-link" onClick={() => setShowLimits(!showLimits)}>
            <SlidersHorizontal size={13} /> {showLimits ? 'Hide' : 'Adjust'} community limits
          </button>
          {showLimits && (
            <label className="xp-field">
              <span>Keep away from homes <b>{homesM} m</b></span>
              <input type="range" min={100} max={1600} step={50} value={homesM} onChange={(e) => setHomesM(+e.target.value)} />
            </label>
          )}

          <button className="xp-primary" onClick={() => void findSites()} disabled={loading || runBusy}>
            <Search size={16} /> {loading ? 'Searching…' : runBusy ? 'Optimizing…' : 'Find sites'}
          </button>

          {saved.length > 0 && (
            <div className="xp-saved">
              <span className="xp-label">Saved searches</span>
              {saved.map((s) => (
                <div key={s.id} className="xp-saved-row">
                  <div>
                    <b>{s.name}</b>
                    <small>{s.count} sites{s.shared_with.length ? ` · shared with ${s.shared_with.join(', ')}` : ''}</small>
                  </div>
                  <button title="Check for changes" onClick={() => void checkAlerts(s.id)}><Bell size={14} /></button>
                </div>
              ))}
              {alerts && (
                <div className="xp-alerts">
                  {alerts.length === 0 ? <span>No changes since the last check.</span> : alerts.map((a, i) => <span key={i}><b>{a.name}</b> {a.detail}</span>)}
                </div>
              )}
            </div>
          )}
        </aside>

        {/* ---------- center: the map ---------- */}
        <main className="xp-center">
          <div className="xp-toolbar">
            <div className="xp-seg">
              <button className={mode === 'draw' ? 'on' : ''} onClick={() => (setStage('map'), setMode(mode === 'draw' ? 'browse' : 'draw'))}><PenLine size={14} /> Draw area</button>
              <button className={mode === 'pin' ? 'on' : ''} onClick={() => (setStage('map'), setMode(mode === 'pin' ? 'browse' : 'pin'))}><MapPin size={14} /> Check a spot</button>
              {polygon && <button onClick={() => setPolygon(null)}><Eraser size={14} /> Clear area</button>}
            </div>
            <div className="xp-seg">
              <button className={stage === 'map' && basemap === 'map' ? 'on' : ''} onClick={() => (setStage('map'), setBasemap('map'))}><MapIcon size={14} /> Map</button>
              <button className={stage === 'map' && basemap === 'satellite' ? 'on' : ''} onClick={() => (setStage('map'), setBasemap('satellite'))}><Satellite size={14} /> Satellite</button>
              <button className={stage === '3d' ? 'on' : ''} disabled={!selected} onClick={() => setStage('3d')}><Box size={14} /> 3D</button>
              <button className={stage === 'meters' ? 'on' : ''} onClick={() => setStage('meters')}><Activity size={14} /> Prove it</button>
            </div>
          </div>

          <div className="xp-stage">
            {stage === 'meters' ? (
              <Meters priceDate={run?.grid.price_date} />
            ) : stage === '3d' && selected?.parcelId ? (
              <Site3D key={selected.id} parcelId={selected.parcelId} lat={selected.lat} lng={selected.lng} mw={mw} />
            ) : (
              <ExploreMap market={market} sites={sites} selectedId={selectedId} onSelect={setSelectedId} mode={mode} polygon={polygon} onPolygon={(r) => (setPolygon(r), setMode('browse'))} onPin={(lng, lat) => void checkSpot(lng, lat)} basemap={basemap} />
            )}
            {pinNote && <div className="xp-toast" onClick={() => setPinNote(null)}>{pinNote}</div>}
            {error && <div className="xp-toast xp-toast-bad">{error}</div>}
          </div>

          {run && <PickSummary run={run} />}

          <div className="xp-strip">
            <div className="xp-strip-head">
              <b>{result ? `${result.count} sites` : 'Searching…'}</b>
              {c && (
                <span>
                  <i className="xp-good" /> {c.Pass} good fit <i className="xp-check" /> {c['Needs review']} check first <i className="xp-bad" /> {c.Fail} not suitable
                </span>
              )}
              {polygon && <span className="xp-muted">inside your area</span>}
            </div>
            <div className="xp-cards">
              {sites.map((s) => {
                const v = verdict(s);
                const isPick = run?.optimized?.site_id === s.id;
                return (
                  <button key={s.id} className={`xp-card ${s.id === selectedId ? 'on' : ''} ${isPick ? 'pick' : ''}`} onClick={() => (setSelectedId(s.id), stage === 'meters' && setStage('map'))}>
                    <div className={`xp-card-img xp-tile-${v.tone}`}>
                      <b>{s.letter}</b>
                      <small>{s.supportableMw != null ? `${fmtNum(s.supportableMw)} MW` : ''}</small>
                    </div>
                    <div className="xp-card-body">
                      <span className={`xp-chip xp-${v.tone}`}>{isPick ? 'PlotStar pick' : `${s.letter} · ${v.label}`}</span>
                      <b>{s.name}</b>
                      <small>{fmtNum(s.lotAcres, 1)} ac · {fmtMoney(s.landCost)}</small>
                    </div>
                    <span className="xp-card-score">{v.tone === 'bad' ? '—' : Math.round(s.pillars.overall)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </main>

        {/* ---------- right: the site ---------- */}
        <aside className="xp-right">
          {selected ? (
            <SitePanel site={selected} mw={mw} run={run} runBusy={runBusy} onWhatIf={whatIf} onOpen3d={() => setStage('3d')} onClose={() => setSelectedId(null)} />
          ) : (
            <div className="xp-empty">
              <MapPin size={22} />
              <b>Pick a site</b>
              <span>See why it does or doesn&apos;t work, how it would run there, and what it saves against the cost-first pick.</span>
              <ol>
                <li>Draw an area or search the whole city</li>
                <li>Open a site: Money · People · Planet and the checks</li>
                <li>See how it runs, then press <b>Prove it</b></li>
              </ol>
            </div>
          )}
        </aside>
      </div>

      {saveOpen && <SaveDialog onClose={() => setSaveOpen(false)} onSave={saveSearch} />}
    </div>
  );
}

function SaveDialog({ onClose, onSave }: { onClose: () => void; onSave: (name: string, team: string, alerts: boolean) => Promise<void> }) {
  const [name, setName] = useState('Houston data center search');
  const [team, setTeam] = useState('');
  const [alertsOn, setAlertsOn] = useState(true);
  return (
    <div className="xp-modal-bg" onClick={onClose}>
      <form className="xp-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); void onSave(name, team, alertsOn); }}>
        <h2>Save this search</h2>
        <label className="xp-field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>
        <label className="xp-field"><span>Share with teammates (names, comma separated)</span><input value={team} onChange={(e) => setTeam(e.target.value)} placeholder="Sudarshan, Sam" /></label>
        <label className="xp-check"><input type="checkbox" checked={alertsOn} onChange={(e) => setAlertsOn(e.target.checked)} />Tell me when a site, price or risk changes</label>
        <div className="xp-modal-actions">
          <button type="button" className="xp-ghost" onClick={onClose}>Cancel</button>
          <button className="xp-primary">Save</button>
        </div>
      </form>
    </div>
  );
}

'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  Bell,
  Bookmark,
  Box,
  Eraser,
  Map as MapIcon,
  MapPin,
  PenLine,
  Satellite,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import { Brand } from '../brand';
import { PUBLIC_DATA_API } from '@/lib/plotstar-api';
import type { MapMode } from './explore-map';
import { SitePanel } from './site-panel';
import type { ExploreSite } from './types';
import { fmtMoney, fmtNum, verdict } from './types';

const ExploreMap = dynamic(() => import('./explore-map'), {
  ssr: false,
  loading: () => <div className="xp-map xp-loading">Loading map…</div>,
});
const Site3D = dynamic(() => import('./site-3d'), {
  ssr: false,
  loading: () => <div className="xp-map xp-loading">Loading 3D…</div>,
});

type Ring = [number, number][];
interface SearchResult {
  count: number;
  counts: { Pass: number; 'Needs review': number; Fail: number };
  in_polygon: number;
  sites: Omit<ExploreSite, 'letter'>[];
}
interface Saved {
  id: number;
  name: string;
  count: number;
  shared_with: string[];
  alerts: boolean;
  checked_at: string;
}
interface Alert {
  type: string;
  name: string;
  detail: string;
}

const letterFor = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));

export function ExploreApp() {
  // brief
  const [market, setMarket] = useState<'Houston' | 'Los Angeles'>('Houston');
  const [mw, setMw] = useState(20);
  const [minAcres, setMinAcres] = useState(2);
  const [needRoom, setNeedRoom] = useState(false);
  const [noFlood, setNoFlood] = useState(false);
  const [heavyPower, setHeavyPower] = useState(false);
  const [waterCooling, setWaterCooling] = useState(false);
  const [hideBad, setHideBad] = useState(false);
  const [homesM, setHomesM] = useState(300);
  const [showLimits, setShowLimits] = useState(false);
  // map
  const [mode, setMode] = useState<MapMode>('browse');
  const [basemap, setBasemap] = useState<'map' | 'satellite'>('map');
  const [view, setView] = useState<'map' | '3d'>('map');
  const [polygon, setPolygon] = useState<Ring | null>(null);
  // results
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pinNote, setPinNote] = useState<string | null>(null);
  // saved searches
  const [saved, setSaved] = useState<Saved[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [alerts, setAlerts] = useState<{ id: number; items: Alert[] } | null>(null);

  const request = useMemo(
    () => ({
      market,
      polygon,
      thresholds: { min_home_distance_m: homesM },
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
    [market, polygon, homesM, minAcres, needRoom, mw, noFlood, heavyPower, waterCooling, hideBad],
  );

  const runSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${PUBLIC_DATA_API}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!r.ok) throw new Error(`Search failed (${r.status})`);
      const d: SearchResult = await r.json();
      setResult(d);
      setSelectedId((cur) => (cur && d.sites.some((s) => s.id === cur) ? cur : null));
    } catch (e) {
      setError(
        (e as Error).message.includes('fetch')
          ? `Can't reach the PlotStar data service at ${PUBLIC_DATA_API}.`
          : (e as Error).message,
      );
    } finally {
      setLoading(false);
    }
  }, [request]);

  const loadSaved = useCallback(() => {
    fetch(`${PUBLIC_DATA_API}/searches`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setSaved)
      .catch(() => {});
  }, []);

  // first load + re-run when the area changes
  useEffect(() => {
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polygon, market]);
  useEffect(loadSaved, [loadSaved]);

  const sites: ExploreSite[] = useMemo(
    () => (result?.sites ?? []).map((s, i) => ({ ...s, letter: letterFor(i) }) as ExploreSite),
    [result],
  );
  const selected = sites.find((s) => s.id === selectedId) ?? null;

  async function checkSpot(lng: number, lat: number) {
    setMode('browse');
    setPinNote('Checking that spot…');
    try {
      const r = await fetch(`${PUBLIC_DATA_API}/sites/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lat, lon: lng, market, thresholds: { min_home_distance_m: homesM } }),
      });
      const d = await r.json();
      const v = verdict(d);
      setPinNote(`That spot: ${v.label}. ${v.reason}.`);
    } catch {
      setPinNote('Could not check that spot.');
    }
  }

  async function saveSearch(name: string, team: string, alertsOn: boolean) {
    await fetch(`${PUBLIC_DATA_API}/searches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        request,
        alerts: alertsOn,
        shared_with: team
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      }),
    });
    setSaveOpen(false);
    loadSaved();
  }

  async function checkAlerts(id: number) {
    const r = await fetch(`${PUBLIC_DATA_API}/searches/${id}/alerts?update_snapshot=true`);
    const d = await r.json();
    setAlerts({ id, items: d.alerts ?? [] });
    loadSaved();
  }

  const c = result?.counts;
  return (
    <div className="xp">
      <header className="xp-top">
        <Brand />
        <nav className="xp-steps" aria-label="Steps">
          <span className="on">1 · Find</span>
          <span className={selected ? '' : 'off'} onClick={() => selected && setView('3d')}>
            2 · Design
          </span>
          <span className="off" title="Next: live grid + hardware">
            3 · Run
          </span>
          <span className="off" title="Next: feasibility report">
            4 · Report
          </span>
        </nav>
        <div className="xp-top-actions">
          <button className="xp-ghost" onClick={() => setSaveOpen(true)}>
            <Bookmark size={15} /> Save search
          </button>
        </div>
      </header>

      <div className="xp-body">
        {/* ---------- left: the brief ---------- */}
        <aside className="xp-left">
          <h1>Find a home for your data center</h1>
          <p className="xp-lede">Real properties from CoStar, checked against homes, floods, water and power.</p>

          <label className="xp-field">
            <span>Where</span>
            <select value={market} onChange={(e) => (setPolygon(null), setMarket(e.target.value as typeof market))}>
              <option>Houston</option>
              <option>Los Angeles</option>
            </select>
          </label>

          <label className="xp-field">
            <span>
              How big <b>{mw} MW</b>
            </span>
            <input type="range" min={5} max={100} step={5} value={mw} onChange={(e) => setMw(+e.target.value)} />
          </label>

          <label className="xp-field">
            <span>
              Smallest lot <b>{minAcres} acres</b>
            </span>
            <input type="range" min={0} max={30} step={1} value={minAcres} onChange={(e) => setMinAcres(+e.target.value)} />
          </label>

          <div className="xp-musts">
            <span className="xp-label">Must have</span>
            {[
              [needRoom, setNeedRoom, `Room for ${mw} MW`],
              [noFlood, setNoFlood, 'Outside flood zones'],
              [heavyPower, setHeavyPower, 'Heavy power on site'],
              [waterCooling, setWaterCooling, 'Water cooling possible'],
              [hideBad, setHideBad, 'Hide unsuitable sites'],
            ].map(([v, set, label]) => (
              <label key={label as string} className="xp-check">
                <input
                  type="checkbox"
                  checked={v as boolean}
                  onChange={(e) => (set as (b: boolean) => void)(e.target.checked)}
                />
                {label as string}
              </label>
            ))}
          </div>

          <button className="xp-link" onClick={() => setShowLimits(!showLimits)}>
            <SlidersHorizontal size={13} /> {showLimits ? 'Hide' : 'Adjust'} community limits
          </button>
          {showLimits && (
            <label className="xp-field">
              <span>
                Keep away from homes <b>{homesM} m</b>
              </span>
              <input type="range" min={100} max={1600} step={50} value={homesM} onChange={(e) => setHomesM(+e.target.value)} />
            </label>
          )}

          <button className="xp-primary" onClick={() => void runSearch()} disabled={loading}>
            <Search size={16} /> {loading ? 'Searching…' : 'Find sites'}
          </button>

          {saved.length > 0 && (
            <div className="xp-saved">
              <span className="xp-label">Saved searches</span>
              {saved.map((s) => (
                <div key={s.id} className="xp-saved-row">
                  <div>
                    <b>{s.name}</b>
                    <small>
                      {s.count} sites{s.shared_with.length ? ` · shared with ${s.shared_with.join(', ')}` : ''}
                    </small>
                  </div>
                  <button title="Check for changes" onClick={() => void checkAlerts(s.id)}>
                    <Bell size={14} />
                  </button>
                </div>
              ))}
              {alerts && (
                <div className="xp-alerts">
                  {alerts.items.length === 0 ? (
                    <span>No changes since the last check.</span>
                  ) : (
                    alerts.items.map((a, i) => (
                      <span key={i}>
                        <b>{a.name}</b> {a.detail}
                      </span>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
        </aside>

        {/* ---------- center: the map ---------- */}
        <main className="xp-center">
          <div className="xp-toolbar">
            <div className="xp-seg">
              <button className={mode === 'draw' ? 'on' : ''} onClick={() => setMode(mode === 'draw' ? 'browse' : 'draw')}>
                <PenLine size={14} /> Draw area
              </button>
              <button className={mode === 'pin' ? 'on' : ''} onClick={() => setMode(mode === 'pin' ? 'browse' : 'pin')}>
                <MapPin size={14} /> Check a spot
              </button>
              {polygon && (
                <button onClick={() => setPolygon(null)}>
                  <Eraser size={14} /> Clear area
                </button>
              )}
            </div>
            <div className="xp-seg">
              <button
                className={view === 'map' && basemap === 'map' ? 'on' : ''}
                onClick={() => (setView('map'), setBasemap('map'))}
              >
                <MapIcon size={14} /> Map
              </button>
              <button
                className={view === 'map' && basemap === 'satellite' ? 'on' : ''}
                onClick={() => (setView('map'), setBasemap('satellite'))}
              >
                <Satellite size={14} /> Satellite
              </button>
              <button className={view === '3d' ? 'on' : ''} disabled={!selected} onClick={() => setView('3d')}>
                <Box size={14} /> 3D
              </button>
            </div>
          </div>

          <div className="xp-stage">
            {view === '3d' && selected?.parcelId ? (
              <Site3D key={selected.id} parcelId={selected.parcelId} lat={selected.lat} lng={selected.lng} mw={mw} />
            ) : (
              <ExploreMap
                market={market}
                sites={sites}
                selectedId={selectedId}
                onSelect={(id) => setSelectedId(id)}
                mode={mode}
                polygon={polygon}
                onPolygon={(r) => (setPolygon(r), setMode('browse'))}
                onPin={(lng, lat) => void checkSpot(lng, lat)}
                basemap={basemap}
              />
            )}
            {pinNote && (
              <div className="xp-toast" onClick={() => setPinNote(null)}>
                {pinNote}
              </div>
            )}
            {error && <div className="xp-toast xp-toast-bad">{error}</div>}
          </div>

          <div className="xp-strip">
            <div className="xp-strip-head">
              <b>{result ? `${result.count} sites` : 'Searching…'}</b>
              {c && (
                <span>
                  <i className="xp-good" /> {c.Pass} good fit <i className="xp-check" /> {c['Needs review']} check first{' '}
                  <i className="xp-bad" /> {c.Fail} not suitable
                </span>
              )}
              {polygon && <span className="xp-muted">inside your area</span>}
            </div>
            <div className="xp-cards">
              {sites.map((s) => {
                const v = verdict(s);
                return (
                  <button
                    key={s.id}
                    className={`xp-card ${s.id === selectedId ? 'on' : ''}`}
                    onClick={() => (setSelectedId(s.id), setView('map'))}
                  >
                    <div className={`xp-card-img xp-tile-${v.tone}`}>
                      <b>{s.letter}</b>
                      <small>{s.supportableMw != null ? `${fmtNum(s.supportableMw)} MW` : ''}</small>
                    </div>
                    <div className="xp-card-body">
                      <span className={`xp-chip xp-${v.tone}`}>
                        {s.letter} · {v.label}
                      </span>
                      <b>{s.name}</b>
                      <small>
                        {fmtNum(s.lotAcres, 1)} ac · {fmtMoney(s.landCost)}
                      </small>
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
            <SitePanel site={selected} mw={mw} onOpen3d={() => setView('3d')} onClose={() => setSelectedId(null)} />
          ) : (
            <div className="xp-empty">
              <MapPin size={22} />
              <b>Pick a site</b>
              <span>Click a pin or a card to see why it does or doesn&apos;t work, and what building there would take.</span>
              <ol>
                <li>Draw an area or search the whole city</li>
                <li>Tick what your project must have</li>
                <li>Open a site, then see it in 3D</li>
              </ol>
            </div>
          )}
        </aside>
      </div>

      {saveOpen && <SaveDialog onClose={() => setSaveOpen(false)} onSave={saveSearch} />}
    </div>
  );
}

function SaveDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (name: string, team: string, alerts: boolean) => Promise<void>;
}) {
  const [name, setName] = useState('Houston data center search');
  const [team, setTeam] = useState('');
  const [alertsOn, setAlertsOn] = useState(true);
  return (
    <div className="xp-modal-bg" onClick={onClose}>
      <form
        className="xp-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(name, team, alertsOn);
        }}
      >
        <h2>Save this search</h2>
        <label className="xp-field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </label>
        <label className="xp-field">
          <span>Share with teammates (names, comma separated)</span>
          <input value={team} onChange={(e) => setTeam(e.target.value)} placeholder="Sudarshan, Sam" />
        </label>
        <label className="xp-check">
          <input type="checkbox" checked={alertsOn} onChange={(e) => setAlertsOn(e.target.checked)} />
          Tell me when a site, price or risk changes
        </label>
        <div className="xp-modal-actions">
          <button type="button" className="xp-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="xp-primary">Save</button>
        </div>
      </form>
    </div>
  );
}

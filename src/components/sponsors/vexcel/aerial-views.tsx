'use client';
// The site aerial in Define, with a toggle for what else Vexcel holds over the site (only what the account returns):
//   Top-down     the newest ortho (default)
//   Then · now   two ortho captures of the same footprint with a before/after slider (when there are two or more)
//   Oblique      Vexcel's angled photos, one per direction the newest collection has
//   Heights      neighbouring structures (Vexcel footprints) coloured by measured height: DSM minus DTM
import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { PUBLIC_DATA_API, vexcelOrthoUrl } from '@/lib/plotstar-api';
import s from './aerial-views.module.css';

type Mode = 'top' | 'change' | 'oblique' | 'heights';
type Capture = { collection: string; layer: string; first_capture: string | null; last_capture: string | null; gsd_cm: number | null };
type Structure = { id: string; footprint: [number, number][]; centre: [number, number]; area_m2: number; height_m: number | null; storeys_est: number | null; building_type: string | null };
type Frame = { west: number; east: number; south: number; north: number; exact: boolean };

const BUFFER = 220;
const enc = encodeURIComponent;
const api = <T,>(path: string) => fetch(`${PUBLIC_DATA_API}/vexcel${path}`).then(async (r) => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof d.detail === 'string' ? d.detail : `Vexcel request failed (${r.status})`);
  return d as T;
});
const captureUrl = (id: string, c: Capture) => `${vexcelOrthoUrl(id, BUFFER)}&collection=${enc(c.collection)}&layer=${enc(c.layer)}`;
const day = (t: string | null) => (t ?? '').slice(0, 10);

export function AerialViews({ aerialId, alt }: { aerialId: string; alt: string }) {
  const [mode, setMode] = useState<Mode>('top');
  return (
    <div className={s.wrap}>
      {mode === 'top' && /* eslint-disable-next-line @next/next/no-img-element */ <img src={vexcelOrthoUrl(aerialId, BUFFER)} alt={alt} />}
      {mode === 'change' && <ThenNow id={aerialId} />}
      {mode === 'oblique' && <Oblique id={aerialId} />}
      {mode === 'heights' && <Heights id={aerialId} />}
      <div className={s.seg} role="tablist" aria-label="Aerial view">
        {([['top', 'Top-down'], ['change', 'Then · now'], ['oblique', 'Oblique'], ['heights', 'Heights']] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={mode === k} className={mode === k ? s.on : ''} onClick={() => setMode(k)}>{l}</button>
        ))}
      </div>
    </div>
  );
}

function useLoad<T>(path: string) {
  const [state, setState] = useState<{ path: string; data?: T; error?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    api<T>(path).then((data) => alive && setState({ path, data }), (e: Error) => alive && setState({ path, error: e.message }));
    return () => { alive = false; };
  }, [path]);
  return state?.path === path ? state : null;
}

function Status({ error }: { error?: string }) {
  return <div className={s.status}>{error ? <span>{error}</span> : <LoaderCircle size={18} className={s.spin} />}</div>;
}

function ThenNow({ id }: { id: string }) {
  const st = useLoad<{ captures: Capture[] }>(`/captures/${enc(id)}`);
  const caps = st?.data?.captures ?? [];
  const [pick, setPick] = useState<{ before?: string; after?: string }>({});
  const [pos, setPos] = useState(50);
  if (!st?.data) return <Status error={st?.error} />;
  if (caps.length < 2) return <div className={s.status}><span>Vexcel has {caps.length ? 'only one capture' : 'no capture list'} over this site, so there is nothing to compare.</span></div>;
  const after = caps.find((c) => c.collection === pick.after) ?? caps[0];
  const before = caps.find((c) => c.collection === pick.before) ?? caps[caps.length - 1];
  const opt = (c: Capture) => <option key={c.collection} value={c.collection}>{day(c.last_capture)} · {c.layer}</option>;
  return (
    <>
      <div className={s.compare} style={{ ['--pos' as string]: `${pos}%` }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={captureUrl(id, before)} alt={`Vexcel aerial captured ${day(before.last_capture)}`} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className={s.after} src={captureUrl(id, after)} alt={`Vexcel aerial captured ${day(after.last_capture)}`} />
        <i className={s.handle} aria-hidden="true" />
        <input type="range" min={0} max={100} value={pos} onChange={(e) => setPos(+e.target.value)} aria-label="Before / after" />
      </div>
      <div className={s.bar}>
        <label>Before <select value={before.collection} onChange={(e) => setPick({ ...pick, before: e.target.value })}>{caps.map(opt)}</select></label>
        <label>After <select value={after.collection} onChange={(e) => setPick({ ...pick, after: e.target.value })}>{caps.map(opt)}</select></label>
        <span>{caps.length} captures · same footprint</span>
      </div>
    </>
  );
}

function Oblique({ id }: { id: string }) {
  const st = useLoad<{ directions: string[]; collection: string | null; captured?: string }>(`/oblique/${enc(id)}/list`);
  const [dir, setDir] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  if (!st?.data) return <Status error={st?.error} />;
  const dirs = st.data.directions;
  if (!dirs.length) return <div className={s.status}><span>Vexcel has no oblique images over this site.</span></div>;
  const d = dir && dirs.includes(dir) ? dir : dirs[0];
  const src = `${PUBLIC_DATA_API}/vexcel/oblique/${enc(id)}.jpg?dir=${d}&buffer_m=150`;
  return (
    <>
      <div className={s.view}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img key={src} src={src} alt={`Vexcel oblique-${d} image of the site`} onLoad={() => setLoaded(src)} />
        {loaded !== src && <Status />}
      </div>
      <div className={s.bar}>
        <span className={s.dirs}>{dirs.map((x) => <button key={x} type="button" className={x === d ? s.on : ''} onClick={() => setDir(x)}>{x}</button>)}</span>
        <span>Vexcel oblique-{d} · {day(st.data.captured ?? null)}</span>
      </div>
    </>
  );
}

const STOPS: [number, string][] = [[0, '#eef5e3'], [6, '#c9ec7a'], [12, '#6fa24e'], [25, '#1f4a36'], [50, '#101411']];
function heightColor(h: number | null) {
  if (h == null) return '#9aa39c';
  for (let i = 1; i < STOPS.length; i++) if (h <= STOPS[i][0]) return STOPS[i - (h - STOPS[i - 1][0] < STOPS[i][0] - h ? 1 : 0)][1];
  return STOPS[STOPS.length - 1][1];
}

function Heights({ id }: { id: string }) {
  const st = useLoad<{ structures: Structure[]; count: number; measured: number; method: string }>(`/neighbours/${enc(id)}?radius_m=200`);
  const meta = useLoad<{ frame?: Frame }>(`/ortho/${enc(id)}/meta?buffer_m=${BUFFER}`);
  if (!st?.data) return <Status error={st?.error} />;
  const f = meta?.data?.frame ?? { west: -BUFFER, east: BUFFER, south: -BUFFER, north: BUFFER, exact: false };
  const tall = st.data.structures.filter((x) => x.height_m != null).sort((a, b) => b.height_m! - a.height_m!);
  const R = 160; // shown extent, metres from the centre
  return (
    <>
      <div className={s.view}>
        <svg viewBox={`${-R} ${-R} ${2 * R} ${2 * R}`} preserveAspectRatio="xMidYMid slice" role="img" aria-label="Neighbouring structures coloured by measured height">
          <image href={vexcelOrthoUrl(id, BUFFER)} x={f.west} y={-f.north} width={f.east - f.west} height={f.north - f.south} preserveAspectRatio="none" opacity={0.55} />
          {st.data.structures.map((x) => (
            <polygon key={x.id} points={x.footprint.map(([e, n]) => `${e},${-n}`).join(' ')} fill={heightColor(x.height_m)} fillOpacity={0.85} stroke="#101411" strokeWidth={0.6}>
              <title>{`${x.id} · ${x.height_m != null ? `${x.height_m} m` : 'height unknown'}${x.storeys_est ? ` · about ${x.storeys_est} storeys` : ''}${x.building_type ? ` · ${x.building_type.replace(/_/g, ' ')}` : ''}`}</title>
            </polygon>
          ))}
          <circle r={3} fill="#f59e0b" stroke="#fff" strokeWidth={1} />
        </svg>
      </div>
      <div className={s.bar}>
        <span className={s.legend}>{STOPS.map(([h, c]) => <i key={h} style={{ background: c }} title={`${h} m`}>{h}</i>)}m</span>
        <span>{st.data.measured} of {st.data.count} measured · tallest {tall[0]?.height_m ?? '—'} m · <abbr title={st.data.method}>DSM − DTM</abbr></span>
      </div>
    </>
  );
}

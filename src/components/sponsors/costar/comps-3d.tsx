'use client';
// CoStar comps in 3D: the CoStar kit properties around the selected site, as simple blocks in the Explore 3D scene,
// coloured by asking rent or by availability (toggle), with a legend and a hover card.
// Mount inside the <Canvas> of src/components/studio/model3d.tsx; the site centre is the scene origin there
// (x east, -z north, metres), which is the frame GET /costar/neighbours returns (east_m, north_m).
// Heights: CoStar storeys x 4.5 m (team assumption) or a labelled default; land shows as a flat pad.
// "Availability" is marketed lease space / rentable area. The CoStar kit says available is not vacant, so it is never
// called vacancy here.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Line } from '@react-three/drei';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { PUBLIC_DATA_API } from '@/lib/plotstar-api';
import s from './comps-3d.module.css';

export interface Neighbour {
  parcel_id: string; costar_property_id: number; name: string | null; address: string | null; city: string | null;
  property_type: string | null; property_subtype: string | null; building_class: string | null; year_built: number | null;
  stories: number | null; building_sf: number | null; lot_acres: number | null; availability: string | null;
  rent_per_sf_year: number | null; rent_basis: string; available_sf: number; available_share: number | null; available_basis: string;
  current_tenancies: number; distance_m: number; east_m: number; north_m: number; height_m: number; height_basis: string;
  height_label: 'Estimated' | 'Default'; footprint_m: number; footprint_basis: string; source_row: number;
}
interface Resp {
  count: number; radius_m: number; properties: Neighbour[]; ranges: { rent: [number, number] | null; available_share: [number, number] | null };
  counts: { with_rent: number; with_availability: number }; note: string; source: string;
}
type Mode = 'rent' | 'availability';

const UNKNOWN = '#b9c0b7';
const RENT = ['#e5f3c9', '#c9ec7a', '#6fa24e', '#3a7a4c', '#1f4a36'];   // low -> high asking rent (GeoStar greens)
const AVAIL = ['#6fa24e', '#b9cf6a', '#e7c35a', '#d89234', '#b5651d'];  // fully let -> mostly marketed (green -> amber)
const pick = (scale: string[], t: number) => scale[Math.max(0, Math.min(scale.length - 1, Math.floor(t * scale.length)))];
const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

function colourOf(p: Neighbour, mode: Mode, r: Resp['ranges']): string {
  if (mode === 'rent') {
    if (p.rent_per_sf_year == null || !r.rent) return UNKNOWN;
    const [lo, hi] = r.rent;
    return pick(RENT, hi > lo ? (p.rent_per_sf_year - lo) / (hi - lo) : 0.5);
  }
  if (p.available_share == null) return UNKNOWN;
  return pick(AVAIL, p.available_share);
}

/** The data for the blocks. Exported so a 2D list or test can reuse it. */
export function useNeighbours(parcelId: string | null | undefined, lat: number, lon: number, radiusM: number) {
  const [d, setD] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const url = parcelId?.startsWith('costar:')
      ? `${PUBLIC_DATA_API}/costar/neighbours/${encodeURIComponent(parcelId)}?radius_m=${radiusM}`
      : `${PUBLIC_DATA_API}/costar/neighbours?lat=${lat}&lon=${lon}&radius_m=${radiusM}`;
    setErr(null);
    fetch(url).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(typeof j?.detail === 'string' ? j.detail : `HTTP ${r.status}`); return j as Resp; })
      .then((j) => alive && setD(j)).catch((e) => alive && setErr((e as Error).message));
    return () => { alive = false; };
  }, [parcelId, lat, lon, radiusM]);
  return { data: d, error: err };
}

/** A DOM panel over the canvas (top-left), rendered from inside the R3F tree. drei's <Html> loses its content under
 * React 19 StrictMode in dev, so this makes its own root inside an effect and unmounts it after the render. */
function Overlay({ children }: { children: ReactNode }) {
  const gl = useThree((st) => st.gl);
  const root = useRef<Root | null>(null);
  useEffect(() => {
    const parent = gl.domElement.parentElement?.parentElement ?? gl.domElement.parentElement;
    if (!parent) return;
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:12px;top:12px;z-index:6;pointer-events:none;';
    parent.appendChild(host);
    const r = createRoot(host);
    root.current = r;
    return () => { root.current = null; setTimeout(() => { r.unmount(); host.remove(); }, 0); };
  }, [gl]);
  useEffect(() => { root.current?.render(children); });
  return null;
}

export default function CostarComps3D({ parcelId, lat, lon, radiusM = 1500, defaultMode = 'rent' }: {
  /** 'costar:<id>' of the selected site (its own record is left out), or null for a dropped pin. */
  parcelId?: string | null; lat: number; lon: number; radiusM?: number; defaultMode?: Mode;
}) {
  const { data, error } = useNeighbours(parcelId, lat, lon, radiusM);
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const ring = useMemo(() => Array.from({ length: 97 }, (_, i) => {
    const a = (i / 96) * Math.PI * 2;
    return [Math.cos(a) * radiusM, 0.3, Math.sin(a) * radiusM] as [number, number, number];
  }), [radiusM]);
  const shown = pinned ?? hover;
  const p = data?.properties.find((x) => x.parcel_id === shown) ?? null;
  const counts = data ? (mode === 'rent' ? data.counts.with_rent : data.counts.with_availability) : 0;
  const range = data && (mode === 'rent' ? data.ranges.rent : data.ranges.available_share);

  const over = (id: string) => (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHover(id); document.body.style.cursor = 'pointer'; };
  const out = () => { setHover(null); document.body.style.cursor = ''; };

  return (
    <group name="costar-comps">
      <Line points={ring} color="#6fa24e" lineWidth={1} dashed dashSize={18} gapSize={12} transparent opacity={0.6} />
      {data?.properties.map((n) => {
        const c = colourOf(n, mode, data.ranges);
        const on = shown === n.parcel_id;
        return (
          <mesh key={n.parcel_id} position={[n.east_m, n.height_m / 2, -n.north_m]} onPointerOver={over(n.parcel_id)} onPointerOut={out}
            onClick={(e) => { e.stopPropagation(); setPinned(pinned === n.parcel_id ? null : n.parcel_id); }}>
            <boxGeometry args={[n.footprint_m, n.height_m, n.footprint_m]} />
            <meshStandardMaterial color={c} roughness={0.85} emissive={on ? '#c9ec7a' : '#000000'} emissiveIntensity={on ? 0.35 : 0}
              transparent opacity={n.height_label === 'Default' ? 0.72 : 0.94} />
          </mesh>
        );
      })}
      <Overlay>
        <div className={s.stack}>
        <div className={s.legend} style={{ pointerEvents: 'auto' }} onPointerDown={(e) => e.stopPropagation()}>
          <header><b>CoStar comps</b><span>{data ? `${data.count} kit properties within ${(radiusM / 1000).toFixed(1)} km` : error ? 'Unavailable' : 'Loading…'}</span></header>
          <div className={s.seg} role="radiogroup" aria-label="Colour the comps by">
            <button role="radio" aria-checked={mode === 'rent'} className={mode === 'rent' ? s.on : ''} onClick={() => setMode('rent')}>Asking rent</button>
            <button role="radio" aria-checked={mode === 'availability'} className={mode === 'availability' ? s.on : ''} onClick={() => setMode('availability')}>Availability</button>
          </div>
          {error ? <p className={s.err}>{error}</p> : (
            <>
              <div className={s.ramp}>
                {(mode === 'rent' ? RENT : AVAIL).map((c) => <i key={c} style={{ background: c }} />)}
              </div>
              <div className={s.ends}>
                <span>{range ? (mode === 'rent' ? usd(range[0]) : pct(range[0])) : '—'}</span>
                <span>{mode === 'rent' ? '$/sf/yr asking' : 'of building marketed'}</span>
                <span>{range ? (mode === 'rent' ? usd(range[1]) : pct(range[1])) : '—'}</span>
              </div>
              <p className={s.key}><i style={{ background: UNKNOWN }} /> Grey: {mode === 'rent' ? 'no asking rent in the kit' : 'unknown'} · {data ? `${counts} of ${data.count} have a value` : ''}</p>
              <p className={s.note}>{mode === 'rent' ? 'Asking, not achieved: area-weighted low end of available lease spaces.' : 'Available is marketed space, not vacancy (CoStar kit rule).'} Heights: storeys x 4.5 m; faded blocks use a default height. Hover or click a block.</p>
            </>
          )}
        </div>
          {p && (
          <div className={s.card} style={{ pointerEvents: 'auto' }}>
            <b>{p.name || p.address || p.parcel_id}</b>
            <span>{[p.address, p.city].filter(Boolean).join(', ')}</span>
            <dl>
              <dt>Type</dt><dd>{p.property_subtype?.replace(/_/g, ' ') || p.property_type || 'Unknown'}{p.building_class ? ` · class ${p.building_class}` : ''}</dd>
              <dt>Building</dt><dd>{p.building_sf ? `${Math.round(p.building_sf).toLocaleString()} sf` : 'Unknown'}{p.stories ? ` · ${p.stories} storeys` : ''}{p.year_built ? ` · ${p.year_built}` : ''}</dd>
              <dt>Asking rent</dt><dd>{p.rent_per_sf_year != null ? `${usd(p.rent_per_sf_year)} /sf/yr` : 'None recorded'}</dd>
              <dt>Available</dt><dd>{p.available_share != null ? `${pct(p.available_share)} of the building${p.available_sf ? ` (${p.available_sf.toLocaleString()} sf)` : ''}` : 'Unknown'}</dd>
              <dt>Distance</dt><dd>{p.distance_m.toLocaleString()} m from the site</dd>
              <dt>Height</dt><dd>{p.height_m} m <em>{p.height_label}</em></dd>
            </dl>
            <small>{p.height_basis}. {mode === 'rent' ? p.rent_basis : p.available_basis} CoStar {p.parcel_id}, row {p.source_row}.</small>
          </div>
          )}
        </div>
      </Overlay>
    </group>
  );
}

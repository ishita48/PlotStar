'use client';
// Explore's bottom toolbar: Layers, Dimensions, Views, Orientation, Fit, zoom, Model (concept switcher) and More.
// It floats at the bottom centre of the views and leaves the bottom-right corner free.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Box as BoxIcon, Check, ChevronDown, Compass, Download, Ellipsis, Layers as LayersIcon, Maximize, Minus, Plus, Ruler, Scan, Star } from 'lucide-react';
import type { Concept } from '../types';
import { ROUTE_COLOR } from '../types';
import type { Layers } from '../plan2d';
import type { ViewPreset } from '../model3d';
import { COLUMN_GRID_M, COOLING_UNIT } from './geometry';

type Menu = 'layers' | 'views' | 'model' | 'more' | null;

function Pop({ open, children, wide }: { open: boolean; children: ReactNode; wide?: boolean }) {
  if (!open) return null;
  return <div className={`xb-pop ${wide ? 'wide' : ''}`} role="menu">{children}</div>;
}
function Tick({ on, label, onChange, swatch, hint, disabled }: { on: boolean; label: string; onChange: (v: boolean) => void; swatch?: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`xb-tick ${disabled ? 'off' : ''}`} title={hint}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {swatch && <i style={{ background: swatch }} />}<span>{label}</span>{hint && <small>{hint}</small>}
    </label>
  );
}

export function ExploreBar({ layers, setLayers, cam, setCam, concepts, activeId, onPick, cooling, hasContext, onExportDxf, onExportGlb, canGlb, view3d, compassRef, hasSite = true }: {
  layers: Layers; setLayers: (l: Layers) => void; cam: ViewPreset; setCam: (v: ViewPreset) => void;
  concepts: Concept[]; activeId: string; onPick: (id: string) => void; cooling: string; hasContext: boolean;
  onExportDxf: () => void; onExportGlb: () => void; canGlb: boolean; view3d: boolean; compassRef: React.RefObject<HTMLSpanElement | null>; hasSite?: boolean;
}) {
  const [menu, setMenu] = useState<Menu>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setMenu(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', key); };
  }, [menu]);
  const L = layers;
  const set = (patch: Partial<Layers>) => setLayers({ ...L, ...patch });
  const toggle = (m: Menu) => setMenu(menu === m ? null : m);
  const go = (preset: ViewPreset['preset']) => { setCam({ preset, n: cam.n + 1 }); setMenu(null); };
  const active = concepts.find((c) => c.id === activeId) ?? concepts[0];
  const unit = COOLING_UNIT[cooling] ?? COOLING_UNIT.air;
  const viewName = { iso: 'Angle', top: 'Top', front: 'Front', section: 'Section', fit: 'Angle', zoomIn: 'Angle', zoomOut: 'Angle' }[cam.preset];

  return (
    <div className="xb" ref={ref} onPointerDown={(e) => e.stopPropagation()}>
      <div className="xb-group">
        <button className={menu === 'layers' ? 'on' : ''} onClick={() => toggle('layers')} aria-expanded={menu === 'layers'} title="Layers"><LayersIcon size={14} /> <span className="xb-lbl">Layers</span></button>
        <Pop open={menu === 'layers'} wide>
          <div className="xb-cols">
            <section><h5>Structure</h5>
              <Tick on={L.columns ?? true} label={`Column grid (${COLUMN_GRID_M} m)`} hint="GeoStar drawing assumption" onChange={(v) => set({ columns: v })} />
              <Tick on={L.slabs ?? true} label="Slabs" onChange={(v) => set({ slabs: v })} />
              <Tick on={L.walls ?? true} label="Walls and doors" onChange={(v) => set({ walls: v })} />
              <label className="xb-range"><span>Roof {Math.round(L.roof * 100)}%</span><input type="range" min={0} max={1} step={0.05} value={L.roof} onChange={(e) => set({ roof: +e.target.value })} /></label>
              <Tick on={!!L.isolate} label="Isolate structure" onChange={(v) => set({ isolate: v })} />
              {(active?.building.storeys ?? 1) > 1 && <label className="xb-range"><span>Pull storeys apart</span><input type="range" min={0} max={1} step={0.05} value={L.explode} disabled={L.level !== null} onChange={(e) => set({ explode: +e.target.value })} /></label>}
            </section>
            <section><h5>IT</h5>
              <Tick on={L.racks} label="Racks and aisles" hint="Blue: contained cold aisle, red: hot aisle" onChange={(v) => set({ racks: v })} />
              <Tick on={L.units ?? true} label={`Cooling units (${unit.name})`} hint={`One per ${unit.mw} MW of hall load, a GeoStar drawing assumption`} onChange={(v) => set({ units: v })} />
              <Tick on={L.equipment ?? true} label="Electrical and battery equipment" onChange={(v) => set({ equipment: v })} />
              <Tick on={L.yard} label="Outdoor plant" onChange={(v) => set({ yard: v })} />
              <h5>Routes</h5>
              <Tick on={L.power} label="Power" swatch={ROUTE_COLOR.power} onChange={(v) => set({ power: v })} />
              <Tick on={L.cooling} label="Cooling" swatch={ROUTE_COLOR.cooling} onChange={(v) => set({ cooling: v })} />
              <Tick on={L.data} label="Data" swatch={ROUTE_COLOR.data} onChange={(v) => set({ data: v })} />
            </section>
            <section><h5>Labels</h5>
              <Tick on={L.tags && (L.labelMode ?? 'major') === 'major'} label="Major spaces" onChange={(v) => set({ tags: v, labelMode: 'major' })} />
              <Tick on={L.tags && L.labelMode === 'all'} label="All rooms" onChange={(v) => set({ tags: true, labelMode: v ? 'all' : 'major' })} />
              <Tick on={!!L.equipIds} label="Equipment IDs" onChange={(v) => set({ equipIds: v })} />
              <Tick on={L.labels} label="Plan labels with areas" onChange={(v) => set({ labels: v })} />
              <h5>Context</h5>
              <Tick on={L.aerial} label="Vexcel aerial" onChange={(v) => set({ aerial: v })} />
              <Tick on={L.context} label="Vexcel 3D surroundings" disabled={!hasContext} hint={hasContext ? undefined : 'No Vexcel 3D mesh here'} onChange={(v) => set({ context: v })} />
              <Tick on={!!L.comps} label="CoStar neighbours" disabled={!hasSite} hint={view3d ? 'Properties within 900 m, in the 3D model' : 'Shown in the 3D model'} onChange={(v) => set({ comps: v })} />
              <Tick on={L.site} label="Whole site in plan" onChange={(v) => set({ site: v })} />
            </section>
          </div>
        </Pop>
      </div>
      <button className={L.dims ? 'on' : ''} onClick={() => set({ dims: !L.dims })} title="Building size, setback and envelope with measure lines"><Ruler size={14} /> <span className="xb-lbl">Dimensions</span></button>
      <div className="xb-group">
        <button className={menu === 'views' ? 'on' : ''} onClick={() => toggle('views')} disabled={!view3d} title={view3d ? 'Camera view' : 'Open the 3D model'}><Scan size={14} /> <span className="xb-lbl">{viewName}</span> <ChevronDown size={12} /></button>
        <Pop open={menu === 'views'}>
          {([['iso', 'Angle (isometric)'], ['top', 'Top'], ['front', 'Front, from the south'], ['section', 'Section through the building']] as const).map(([k, label]) => (
            <button key={k} className="xb-item" onClick={() => go(k)}>{cam.preset === k ? <Check size={13} /> : <span className="xb-sp" />}{label}</button>
          ))}
        </Pop>
      </div>
      <button className={L.compass ? 'on' : ''} onClick={() => set({ compass: !L.compass })} title="Show north" disabled={!view3d}>
        <Compass size={14} /> <span className="xb-north" ref={compassRef}>N</span>
      </button>
      <button onClick={() => go('fit')} title="Fit the concept in view" disabled={!view3d}><Maximize size={14} /></button>
      <span className="xb-zoom">
        <button onClick={() => go('zoomOut')} aria-label="Zoom out" disabled={!view3d}><Minus size={14} /></button>
        <button onClick={() => go('zoomIn')} aria-label="Zoom in" disabled={!view3d}><Plus size={14} /></button>
      </span>
      <div className="xb-group">
        <button className={`xb-model ${menu === 'model' ? 'on' : ''}`} onClick={() => toggle('model')} title={active?.why}><BoxIcon size={14} /> <span className="xb-name">{active?.name ?? 'Model'}</span> <ChevronDown size={12} /></button>
        <Pop open={menu === 'model'} wide>
          {concepts.map((c) => (
            <button key={c.id} className="xb-item xb-concept" onClick={() => { onPick(c.id); setMenu(null); }}>
              {c.id === activeId ? <Check size={13} /> : <span className="xb-sp" />}
              <span><b>{c.rank === 1 && <Star size={11} />} {c.name}</b>{c.edited && <em> · edited</em>}<small>{c.why ?? c.strategy}</small></span>
            </button>
          ))}
        </Pop>
      </div>
      <div className="xb-group">
        <button className={menu === 'more' ? 'on' : ''} onClick={() => toggle('more')} aria-label="More"><Ellipsis size={14} /></button>
        <Pop open={menu === 'more'}>
          <button className="xb-item" onClick={() => { onExportDxf(); setMenu(null); }}><Download size={13} /> Export DXF plan</button>
          <button className="xb-item" disabled={!canGlb} onClick={() => { onExportGlb(); setMenu(null); }}><Download size={13} /> Export GLB 3D model{canGlb ? '' : ' (open 3D first)'}</button>
          <button className="xb-item" onClick={() => go('iso')}><Scan size={13} /> Reset view</button>
        </Pop>
      </div>
    </div>
  );
}

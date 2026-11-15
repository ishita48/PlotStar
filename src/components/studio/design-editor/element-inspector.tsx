'use client';
// Right-hand inspector for Explore: tabs for Properties, Geometry, Program, Validation and Insights of the selected
// element (or the concept when nothing is selected). Every value comes from the engine's response; status says
// whether an element is as generated (derived), moved by the user (edited) or placed by the user (added).
import { useState } from 'react';
import { ChevronsLeft, ChevronsRight, CircleAlert, CircleCheck } from 'lucide-react';
import type { Concept, ConceptEdit, Room } from '../types';
import { TYPE_STYLE, WHY, money, num, pct } from '../types';
import type { Faults } from './faults';

const TABS = ['Properties', 'Geometry', 'Program', 'Validation', 'Insights'] as const;
type Tab = (typeof TABS)[number];

function Row({ k, v }: { k: string; v: React.ReactNode }) { return <><dt>{k}</dt><dd>{v}</dd></>; }

function statusOf(c: Concept, r: Room | null, e: ConceptEdit | undefined): 'derived' | 'edited' | 'added' {
  if (!r) return c.edited ? 'edited' : 'derived';
  if (r.added) return 'added';
  const inBuilding = c.rooms.some((x) => x.code === r.code);
  if (inBuilding) return e && (e.building.dx || e.building.dy || e.rotate) ? 'edited' : 'derived';
  return e?.yard[r.code] ? 'edited' : 'derived';
}

export function ElementInspector({ concept: c, sel, edit, faults, cooling }: {
  concept: Concept; sel: string | null; edit?: ConceptEdit; faults: Faults; cooling: string;
}) {
  const [tab, setTab] = useState<Tab>('Properties');
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 800);
  const r = [...c.rooms, ...c.yard].find((x) => x.code === sel) ?? null;
  const inBuilding = !!r && c.rooms.some((x) => x.code === r.code);
  const status = statusOf(c, r, edit);
  if (!open)
    return (
      <aside className="ei ei-closed">
        <button className="ei-toggle" onClick={() => setOpen(true)} title="Open the inspector" aria-label="Open the inspector"><ChevronsLeft size={15} /></button>
        {r && <span className="ei-vert">{r.code}</span>}
      </aside>
    );
  const touching = c.checks.filter((k) => {
    if (!r) return true;
    if (faults[r.code]) return !k.ok && (faults[r.code].some((f) => f.startsWith(k.name)) || /setback|overlap/i.test(k.name));
    if (k.codes?.includes(r.code) || k.detail.includes(r.code)) return true;
    if (r.type === 'data_hall') return /rack|envelope/i.test(k.name);
    if (r.type === 'yard_gen') return /generator|backup|noise/i.test(k.name);
    if (r.type === 'yard_sub') return /grid|power/i.test(k.name);
    if (r.type === 'yard_cool' || r.type === 'yard_cooling') return /heat|cool/i.test(k.name);
    if (!inBuilding) return /setback|overlap|coverage|obstacle/i.test(k.name);
    return /envelope/i.test(k.name);
  });
  const parent = !r ? 'Site' : inBuilding ? `Building${c.building.storeys > 1 ? `, level ${(r.level ?? 0) + 1}` : ''}` : 'Site, outdoor';
  const hallRacks = r?.type === 'data_hall';
  return (
    <aside className="ei">
      <div className="ei-head">
        <div>
          <small>{r ? TYPE_STYLE[r.type]?.label ?? r.type : 'Concept'}</small>
          <b>{r ? `${r.code} · ${r.name}` : c.name}</b>
        </div>
        <span className={`ei-status ${status}`}>{status}</span>
        <button className="ei-toggle" onClick={() => setOpen(false)} title="Collapse" aria-label="Collapse the inspector"><ChevronsRight size={15} /></button>
      </div>
      <div className="ei-tabs" role="tablist">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={t === tab} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      <div className="ei-body">
        {tab === 'Properties' && (
          <dl className="ei-dl">
            {r ? <>
              <Row k="Name" v={r.name} /><Row k="Code" v={<code>{r.code}</code>} /><Row k="Type" v={TYPE_STYLE[r.type]?.label ?? r.type} />
              <Row k="Parent" v={parent} />
              <Row k="Function" v={hallRacks ? 'IT white space' : r.type.startsWith('yard_') || r.type === 'sensor' || r.type === 'custom' ? 'Outdoor plant' : TYPE_STYLE[r.type]?.label} />
              {r.hall != null && <Row k="Serves" v={`Data hall ${r.hall}`} />}
              <Row k="Status" v={status === 'derived' ? 'Derived by the engine' : status === 'edited' ? 'Moved by you' : 'Placed by you'} />
              {r.source && <Row k="Source" v={`${r.source} (shown as given)`} />}
            </> : <>
              <Row k="Concept" v={c.name} /><Row k="Strategy" v={c.variant?.strategy ?? c.strategy} />
              {c.variant && <Row k="Plant side" v={c.variant.plant_side} />}
              <Row k="Rank" v={c.feasible ? c.rank : 'Does not fit'} /><Row k="Status" v={c.edited ? 'Edited by you' : 'As generated'} />
            </>}
          </dl>
        )}
        {tab === 'Geometry' && (
          <dl className="ei-dl">
            {(r ? [r] : [{ ...c.building, code: 'Building' } as unknown as Room]).map((g) => <div key="g" style={{ display: 'contents' }}>
              <Row k="East (x)" v={`${num(g.x, 1)} m`} /><Row k="North (y)" v={`${num(g.y, 1)} m`} />
              <Row k="Width (E-W)" v={`${num(g.w, 1)} m`} /><Row k="Depth (N-S)" v={`${num(g.d, 1)} m`} />
              <Row k="Area" v={`${num(g.w * g.d)} m²`} />
              {g.h != null && <Row k="Height" v={`${num(g.h, 1)} m`} />}
              {r && c.building.storeys > 1 && r.level != null && <Row k="Level" v={r.level + 1} />}
            </div>)}
            <dd className="ei-note">Metres from the site&apos;s south-west corner, x east, y north.</dd>
          </dl>
        )}
        {tab === 'Program' && (
          <dl className="ei-dl">
            {r ? <>
              {r.need_m2 != null && <><Row k="Area required" v={`${num(r.need_m2)} m²`} /><Row k="Area provided" v={<>{num(r.w * r.d)} m² <em className={r.w * r.d >= r.need_m2 ? 'ei-ok' : 'ei-bad'}>{r.w * r.d >= r.need_m2 ? 'meets it' : 'short'}</em></>} /></>}
              {r.need_m2 == null && <Row k="Area provided" v={`${num(r.w * r.d)} m²`} />}
              {r.racks != null && <><Row k="Racks placed" v={num(r.racks)} /><Row k="Rack positions" v={num(r.positions)} /></>}
              {r.mw != null && <Row k="IT load" v={`${r.mw} MW`} />}
              {hallRacks && <Row k="Cooling" v={cooling} />}
              {!r.need_m2 && r.racks == null && r.mw == null && <dd className="ei-note">No program target for this element; it is sized {r.added ? 'by you' : 'from the brief'}.</dd>}
            </> : <>
              <Row k="Racks placed" v={`${num(c.metrics.placed_racks)} of ${num(c.metrics.rack_positions)} positions`} />
              <Row k="Hall area" v={`${num(c.metrics.hall_area_m2)} m²`} /><Row k="Gross floor" v={`${num(c.metrics.gross_floor_m2)} m²`} />
              <Row k="Corridor share" v={pct(c.metrics.corridor_share)} /><Row k="Facility load" v={`${c.resources.facility_mw} MW`} />
              <Row k="Cost to build" v={money(c.money.capex)} />
            </>}
          </dl>
        )}
        {tab === 'Validation' && (
          touching.length ? (
            <ul className="ei-checks">
              {r && faults[r.code]?.map((f) => <li key={f} className="bad"><CircleAlert size={13} /><div><b>On this element</b><span>{f}</span></div></li>)}
              {touching.map((k) => <li key={k.name} className={k.ok ? 'ok' : 'bad'}>{k.ok ? <CircleCheck size={13} /> : <CircleAlert size={13} />}<div><b>{k.name}{k.required ? '' : ' (advisory)'}</b><span>{k.detail}</span></div></li>)}
            </ul>
          ) : <p className="ei-note">No engine check is about this element. Site-wide checks are listed with nothing selected.</p>
        )}
        {tab === 'Insights' && (
          <div className="ei-why">
            <b>Why is this {r ? 'element' : 'concept'} here?</b>
            <p>{r ? WHY[r.type] : c.why ?? c.strategy}</p>
            {!r && <><p><b>Advantage.</b> {c.advantage}</p><p><b>Trade-off.</b> {c.tradeoff}</p></>}
            {r?.type === 'data_hall' && <p>{num(r.racks)} racks in {num(r.positions)} positions at the brief&apos;s rack density.</p>}
          </div>
        )}
      </div>
    </aside>
  );
}

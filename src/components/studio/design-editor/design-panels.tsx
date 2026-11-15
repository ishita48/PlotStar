'use client';
// The design editor's on-screen pieces, kept small: one status line under the toolbar, one collapsible side panel
// (asset library + AI proposals; an icon rail by default) and a floating toolbar next to the selected object. Check failures are drawn on the objects themselves; the status line carries one summary.
import { useEffect, useRef, useState, type ComponentType } from 'react';
import {
  BatteryCharging, BrickWall, CarFront, CircleAlert, CircleCheck, Copy, DoorOpen, Droplets, Fan, Fence,
  LoaderCircle, PanelLeftClose, PanelLeftOpen, Radar, Redo2, RotateCcw, RotateCw, Ruler, Shapes, Sparkles, Sun, Trash2, Trees,
  Undo2, Wand2, X,
} from 'lucide-react';
import type { PlaceType } from '../types';
import { TYPE_STYLE, WHY, money, pct } from '../types';
import { ASSET, ASSETS } from './assets';
import { NO_EDIT } from './edit-actions';
import type { DesignUi } from './design-editor';

const ICON: Record<PlaceType, ComponentType<{ size?: number }>> = {
  yard_bess: BatteryCharging, yard_solar: Sun, yard_water: Droplets, yard_parking: CarFront, yard_wall: BrickWall, yard_trees: Trees,
  yard_guard: DoorOpen, yard_fence: Fence, yard_cooling: Fan, sensor: Radar, custom: Shapes,
};

/** One line under the Explore toolbar: verdict, live cost, history. */
export function DesignBar({ ui }: { ui: DesignUi }) {
  const { editor, concept: c } = ui;
  const origin = useRef<{ id: string; capex: number } | null>(null);
  if (c && !editor.stale && editor.status === 'idle' && (!origin.current || origin.current.id !== c.id || !editor.canUndo))
    origin.current = { id: c.id, capex: c.money.capex };
  if (!c) return null;
  const failing = c.checks.filter((k) => !k.ok);
  const checking = editor.status === 'checking' || editor.stale;
  const d = origin.current ? c.money.capex - origin.current.capex : 0;
  const removed = editor.edit.removed ?? [];
  const uncosted = c.money.uncosted ?? [];
  return (
    <div className="st-editbar de-bar">
      <span className="de-status" aria-live="polite">
        {checking ? <><LoaderCircle size={14} className="st-spin" /> Checking the change…</>
          : editor.status === 'error' ? <><CircleAlert size={14} className="de-bad" /> Not checked yet. <button className="de-link" onClick={editor.retry}>Try again</button></>
            : failing.length ? <><CircleAlert size={14} className="de-bad" /> <b>{failing.length} check{failing.length > 1 ? 's' : ''} failing</b>
              <span className="de-first">{Object.keys(ui.faults.byCode).length ? `${failing[0].name} (see the red objects)` : `${failing[0].name}: ${failing[0].detail}`}</span></>
              : <><CircleCheck size={14} className="de-ok" /> All {c.checks.length} checks pass</>}
        <span className={`de-money ${checking ? 'stale' : ''}`} title="Cost to build from the engine; the change since you started editing">
          {money(c.money.capex)}{Math.abs(d) >= 1000 && <em className={d < 0 ? 'de-ok' : 'de-bad'}>{d > 0 ? ' +' : ' −'}{money(Math.abs(d))}</em>}
          {' · '}coverage {pct(c.metrics.site_coverage)}{uncosted.length ? ` · not costed: ${uncosted.join(', ')}` : ''}
        </span>
      </span>
      {editor.notice && <span className="de-notice">{editor.notice} <button className="de-link" onClick={editor.clearNotice}>OK</button></span>}
      {removed.map((code) => <button key={code} className="de-chipbtn" onClick={() => ui.act.restore(code)} title="Deleted from the generated layout. Click to put it back.">{code} deleted · restore</button>)}
      <div className="st-seg">
        <button onClick={editor.undo} disabled={!editor.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size={13} /></button>
        <button onClick={editor.redo} disabled={!editor.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Redo2 size={13} /></button>
      </div>
      <button className="st-btn" onClick={ui.act.rotateBuilding} title="Turn the building 90°"><RotateCw size={13} /> Building</button>
      <button className="st-btn" onClick={ui.act.reset} disabled={editor.edit === NO_EDIT || (!editor.edit.added.length && !Object.keys(editor.edit.yard).length && !removed.length && !editor.edit.rotate && !editor.edit.building.dx && !editor.edit.building.dy)} title="Back to the generated layout (undoable)"><RotateCcw size={13} /> Reset</button>
    </div>
  );
}

/** One collapsible side panel: the asset library and the AI proposal box. Collapsed it is an icon rail. */
export function DesignSidePanel({ ui }: { ui: DesignUi }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const { proposal } = ui;
  useEffect(() => { if (proposal) setOpen(true); }, [proposal]);
  const ask = () => { if (text.trim().length > 1) void ui.propose(text); };
  return (
    <aside className={`de-side ${open ? 'open' : ''}`} aria-label="Add to the site">
      <button className="de-side-toggle" onClick={() => setOpen(!open)} title={open ? 'Collapse' : 'Show the asset library and AI proposals'} aria-expanded={open}>
        {open ? <><PanelLeftClose size={15} /><span>Add to the site</span></> : <PanelLeftOpen size={15} />}
      </button>
      <div className="de-assets">
        {ASSETS.map((a) => {
          const Icon = ICON[a.type];
          return (
            <button key={a.type} className={`de-asset ${ui.placing === a.type ? 'on' : ''}`} onPointerDown={(e) => ui.beginPlace(a.type, e.currentTarget)}
              title={`${a.label} (${a.w} × ${a.d} m, ${a.cost}). Click to place next to the building, or drag onto the 3D model or the plan.`}>
              <i style={{ color: TYPE_STYLE[a.type].stroke }}><Icon size={15} /></i>
              {open && <span><b>{a.label}</b><small>{a.w} × {a.d} m{a.cost === 'not costed' ? ' · not costed' : ''}</small></span>}
            </button>
          );
        })}
      </div>
      {open ? (
        <div className="de-ai">
          <small className="de-hint">{ui.placing ? 'Release over the model or the plan. Esc cancels.' : 'Click to place, or drag onto the view.'}</small>
          <form onSubmit={(e) => { e.preventDefault(); ask(); }}>
            <label htmlFor="de-ask"><Sparkles size={12} /> Propose with AI</label>
            <textarea id="de-ask" ref={box} value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={600}
              placeholder="e.g. tree buffer along the north boundary" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }} />
            <button className="st-btn primary" disabled={ui.asking || text.trim().length < 2}>{ui.asking ? <><LoaderCircle size={13} className="st-spin" /> Thinking…</> : <><Wand2 size={13} /> Propose</>}</button>
          </form>
          {ui.askError && <p className="de-err">{ui.askError}</p>}
          {proposal && (
            <div className="de-proposal">
              <p className="de-proposal-head"><span className="de-chip">Proposal</span> {proposal.source}</p>
              <p>{proposal.reason}</p>
              <ul>{proposal.objects.map((x) => (
                <li key={x.code}><b>{x.name || ASSET[x.type]?.label}</b> {x.w.toFixed(1)} × {x.d.toFixed(1)} m
                  {x.estimate && <small>{x.estimate}</small>}
                  {x.notes?.map((n) => <small key={n}>{n}</small>)}</li>
              ))}</ul>
              {proposal.notes?.map((n) => <small key={n} className="de-hint">{n}</small>)}
              <small className="de-hint">Not checked yet. Accept adds it; the engine then checks and costs it.</small>
              <div className="de-row"><button className="st-btn primary" onClick={ui.accept}><CircleCheck size={13} /> Accept</button><button className="st-btn" onClick={() => ui.setProposal(null)}><X size={13} /> Reject</button></div>
            </div>
          )}
        </div>
      ) : (
        <button className={`de-asset de-ai-icon ${proposal ? 'on' : ''}`} onClick={() => { setOpen(true); setTimeout(() => box.current?.focus(), 30); }} title="Propose an object with AI">
          <i><Sparkles size={15} /></i>
        </button>
      )}
    </aside>
  );
}

function Num({ label, value, onCommit, disabled, step = 1 }: { label: string; value: number; onCommit: (v: number) => void; disabled?: boolean; step?: number }) {
  return (
    <label>{label}
      <input type="number" step={step} key={`${label}${value}`} defaultValue={Math.round(value * 10) / 10} disabled={disabled}
        onBlur={(e) => { const v = +e.target.value; if (Number.isFinite(v) && Math.abs(v - value) > 0.05) onCommit(v); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />
    </label>
  );
}

/** Floating toolbar shown next to the selected object (in the 3D model, or on the plan when only the plan is open). */
export function SelectionToolbar({ ui }: { ui: DesignUi }) {
  const r = ui.selRoom;
  const [sizeOpen, setSizeOpen] = useState(false);
  useEffect(() => setSizeOpen(false), [r?.code]);
  if (!r) return null;
  const { act } = ui;
  const bad = ui.shownFaults[r.code];
  const uncosted = r.type === 'custom' || (ui.concept?.money.uncosted ?? []).includes(r.name);
  const cost = uncosted ? 'Not costed: measured for clashes, setbacks and coverage only.'
    : r.added ? 'Costed by the engine from a team assumption.' : 'Generated and costed by the engine; it can move but keeps its size.';
  return (
    <div className={`de-float ${bad ? 'bad' : ''}`} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div className="de-float-row">
        <span className="de-float-name" title={`${TYPE_STYLE[r.type]?.label ?? r.type}. ${cost} ${WHY[r.type] ?? ''}`}>
          {bad ? <CircleAlert size={12} className="de-bad" /> : null}<b>{r.code}</b>{r.source && <span className="de-chip" title={`${r.source}. Shown as given, not verified.`}>AI</span>}
        </span>
        <button onClick={() => act.rotate(r.code)} disabled={!r.added} title="Turn 90° (R)" aria-label="Turn 90 degrees"><RotateCw size={13} /></button>
        <button onClick={() => setSizeOpen(!sizeOpen)} className={sizeOpen ? 'on' : ''} title="Position and size" aria-label="Position and size"><Ruler size={13} /></button>
        <button onClick={() => act.duplicate(r.code)} disabled={!(r.type in ASSET)} title="Duplicate (Ctrl+D)" aria-label="Duplicate"><Copy size={13} /></button>
        <button onClick={() => act.remove(r.code)} className="de-del" title={r.added ? 'Delete (Del)' : 'Delete from the generated layout; the engine will fail the checks that need it'} aria-label="Delete"><Trash2 size={13} /></button>
      </div>
      {bad && <p className="de-float-why">{bad[0]}</p>}
      {sizeOpen && (
        <div className="de-geom">
          <Num label="East" value={r.x} onCommit={(v) => act.rect(r.code, { x: v })} />
          <Num label="North" value={r.y} onCommit={(v) => act.rect(r.code, { y: v })} />
          <Num label="Width" value={r.w} disabled={!r.added} step={0.5} onCommit={(v) => act.rect(r.code, { w: v })} />
          <Num label="Depth" value={r.d} disabled={!r.added} step={0.5} onCommit={(v) => act.rect(r.code, { d: v })} />
          {r.type === 'custom' && r.added && <>
            <label>Name<input key={`n${r.name}`} defaultValue={r.name} maxLength={60} onKeyDown={(e) => e.stopPropagation()}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== r.name) act.meta(r.code, { name: v }); }} /></label>
            <Num label="Height" value={r.h ?? 3} step={0.5} onCommit={(v) => act.meta(r.code, { h: Math.max(0.2, Math.min(80, v)) })} />
          </>}
          <small>metres · {cost}</small>
        </div>
      )}
    </div>
  );
}

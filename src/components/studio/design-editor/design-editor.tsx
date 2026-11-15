'use client';
// GeoStar design editor for the Explore step: asset library, place / move / resize / rotate / duplicate / delete on
// the real site, AI proposals shown as ghosts, live numbers after every edit, and DXF / GLB export. 3D and 2D share
// one selection and one edit history. The layout engine measures and checks every change; the editor only draws.
//
// Window events (for the Hey Geo assistant and anything else that wants to drive the editor):
//   in   geo:apply-edits  {conceptId?, edits: ConceptEdit (partial ok), mode?: 'merge' | 'replace'}  -> one undoable step
//   in   geo:propose      {conceptId?, objects: AddedItem[], reason?, source}                        -> ghosts, Accept / Reject
//   in   geo:select       {conceptId?, code}                                                          -> selects the object
//   out  geo:design-state {conceptId, edits, concept: summary, status, stale}   on every change (also window.__geoDesignState)
import './design-editor.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as THREE from 'three';
import { PUBLIC_DATA_API } from '@/lib/plotstar-api';
import type { AddedItem, Concept, ConceptEdit, PlaceType, Room } from '../types';
import type { Editor3D, EditRect } from '../model3d';
import type { Editor2D } from '../plan2d';
import { ASSET, freeSpot, newItem } from './assets';
import { NO_EDIT, addItem, codesOf, duplicate, moveBy, remove, restore, rotate90, setRect } from './edit-actions';
import { faultsOf } from './faults';
import type { DesignEditor } from './use-design-editor';
import { downloadDxf, downloadGlb } from './export';
import { ProposalBar, SelectionToolbar } from './design-panels';

export interface Proposal { objects: (AddedItem & { notes?: string[]; estimate?: string | null })[]; reason: string; source: string; notes?: string[]; conceptId: string }

/** Geometry-only summary of a concept: what the AI route and Hey Geo get. No site names, prices or coordinates. */
export function summarize(c: Concept, siteW: number, siteD: number, setback: number, selected: string | null) {
  return {
    site_w: siteW, site_d: siteD, setback,
    building: { x: c.building.x, y: c.building.y, w: c.building.w, d: c.building.d },
    yard: c.yard.map((y) => ({ code: y.code, type: y.type, name: y.name, x: y.x, y: y.y, w: y.w, d: y.d, added: !!y.added, source: y.source })),
    checks: c.checks.map((k) => ({ name: k.name, ok: k.ok, detail: k.detail })),
    selected: selected ?? undefined,
    metrics: { capex: c.money.capex, npv: c.money.npv, added_cost: c.money.added, uncosted: c.money.uncosted ?? [], site_coverage: c.metrics.site_coverage },
  };
}

const normEdit = (e: Partial<ConceptEdit> | undefined): ConceptEdit => ({
  building: { dx: Number(e?.building?.dx) || 0, dy: Number(e?.building?.dy) || 0 }, rotate: !!e?.rotate, yard: { ...(e?.yard ?? {}) },
  added: [...(e?.added ?? [])], removed: [...(e?.removed ?? [])],
});
function mergeEdit(a: ConceptEdit, b: Partial<ConceptEdit>): ConceptEdit {
  const byCode = new Map(a.added.map((x) => [x.code, x]));
  for (const x of b.added ?? []) byCode.set(x.code, { ...byCode.get(x.code), ...x });
  return {
    building: b.building ? { dx: Number(b.building.dx) || 0, dy: Number(b.building.dy) || 0 } : a.building,
    rotate: b.rotate ?? a.rotate, yard: { ...a.yard, ...(b.yard ?? {}) }, added: [...byCode.values()],
    removed: [...new Set([...(a.removed ?? []), ...(b.removed ?? [])])],
  };
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

export type DesignUi = ReturnType<typeof useDesignUi>;

export function useDesignUi({ editor, siteW, siteD, setback, selected, onSelect, onActivate, project, enabled, onOpen }: {
  editor: DesignEditor; siteW: number; siteD: number; setback: number; selected: string | null; onSelect: (code: string | null) => void;
  onActivate?: (conceptId: string) => void; project: string; enabled: boolean;
  /** open the editor (Explore, edit mode) so a proposal sent from outside can be seen and accepted */
  onOpen?: () => void;
}) {
  const c = editor.concept;
  const [placing, setPlacing] = useState<PlaceType | null>(null);
  const placed = useRef(false);
  const startEl = useRef<HTMLElement | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const scene = useRef<THREE.Scene | null>(null);
  /** the bottom toolbar's north arrow, turned by the 3D model every frame */
  const compassRef = useRef<HTMLSpanElement | null>(null);
  const [exporting, setExporting] = useState(false);

  const faults = useMemo(() => (c ? faultsOf(c, siteW, siteD, setback) : { byCode: {}, general: [] }), [c, siteW, siteD, setback]);
  const shownFaults = editor.stale ? {} : faults.byCode; // never paint a stale verdict
  const selRoom: Room | undefined = c ? [...c.yard].find((y) => y.code === selected) : undefined;

  const place = useCallback((type: PlaceType, at?: { x: number; y: number }) => {
    if (!c) return;
    const a = ASSET[type];
    const spot = at ?? freeSpot(c, a.w, a.d, siteW, siteD, setback);
    let code = '';
    editor.change((e, cc) => { const it = newItem(type, spot, codesOf(cc, e)); code = it.code; return addItem(e, it); });
    if (code) onSelect(code);
  }, [c, editor, siteW, siteD, setback, onSelect]);

  // click an asset: place it next to the building; drag it onto the 3D or 2D view: place it where it is dropped
  const beginPlace = (type: PlaceType, el: HTMLElement) => { placed.current = false; startEl.current = el; setPlacing(type); };
  useEffect(() => {
    if (!placing) return;
    const up = (ev: PointerEvent) => {
      const onButton = !!startEl.current && ev.target instanceof Node && startEl.current.contains(ev.target);
      if (!placed.current && onButton) place(placing);
      setPlacing(null);
    };
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setPlacing(null); };
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerup', up); window.removeEventListener('keydown', key); };
  }, [placing, place]);
  const onPlace = useCallback((x: number, y: number) => {
    if (!placing) return;
    placed.current = true;
    place(placing, { x, y });
  }, [placing, place]);

  const act = useMemo(() => ({
    move: (code: string, dx: number, dy: number) => editor.change((e, cc) => moveBy(e, cc, code, dx, dy)),
    rect: (code: string, r: Partial<EditRect>) => editor.change((e, cc) => setRect(e, cc, code, r)),
    rotate: (code: string) => editor.change((e, cc) => rotate90(e, cc, code)),
    remove: (code: string) => { editor.change((e, cc) => remove(e, cc, code)); onSelect(null); },
    restore: (code: string) => editor.change((e) => restore(e, code)),
    duplicate: (code: string) => {
      let made: string | null = null;
      editor.change((e, cc) => { const d = duplicate(e, cc, code, siteW, siteD, setback); made = d?.code ?? null; return d?.edit ?? null; });
      if (made) onSelect(made);
    },
    meta: (code: string, patch: { name?: string; h?: number }) => editor.change((e) => ({ ...e, added: e.added.map((a) => (a.code === code ? { ...a, ...patch } : a)) })),
    rotateBuilding: () => editor.change((e) => ({ ...e, rotate: !e.rotate, building: { dx: 0, dy: 0 } })),
    reset: () => editor.change(() => NO_EDIT),
  }), [editor, onSelect, siteW, siteD, setback]);

  async function propose(text: string) {
    if (!c || !text.trim()) return;
    setAsking(true); setAskError(null); setProposal(null);
    try {
      const r = await fetch(`${PUBLIC_DATA_API}/design/propose`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, concept: summarize(c, siteW, siteD, setback, selected) }) });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(typeof d?.detail === 'string' ? d.detail : `The proposal failed (${r.status})`);
      setProposal({ ...d, conceptId: c.id });
    } catch (e) { setAskError((e as Error).message); } finally { setAsking(false); }
  }
  const accept = useCallback(() => {
    if (!proposal || !c) return;
    let first = '';
    editor.change((e, cc) => {
      const taken = new Set(codesOf(cc, e));
      let next = e;
      for (const o of proposal.objects) {
        let code = o.code;
        if (taken.has(code)) { let n = 2; while (taken.has(`${o.code}-${n}`)) n++; code = `${o.code}-${n}`; }
        taken.add(code); first ||= code;
        next = addItem(next, { code, type: o.type, x: o.x, y: o.y, w: o.w, d: o.d, name: o.name, h: o.h, source: o.source ?? proposal.source });
      }
      return next;
    });
    setProposal(null);
    if (first) onSelect(first);
  }, [proposal, c, editor, onSelect]);

  // keyboard: undo / redo over the whole history, delete, turn, duplicate, escape
  useEffect(() => {
    if (!enabled) return;
    const key = (ev: KeyboardEvent) => {
      if (isTyping(ev.target)) return;
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); if (ev.shiftKey) editor.redo(); else editor.undo(); }
      else if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); editor.redo(); }
      else if (mod && ev.key.toLowerCase() === 'd' && selRoom) { ev.preventDefault(); act.duplicate(selRoom.code); }
      else if ((ev.key === 'Delete' || ev.key === 'Backspace') && selRoom) { ev.preventDefault(); act.remove(selRoom.code); }
      else if (ev.key.toLowerCase() === 'r' && !mod && selRoom?.added) act.rotate(selRoom.code);
      else if (ev.key === 'Escape') { setProposal(null); onSelect(null); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [enabled, editor, act, selRoom, onSelect]);

  // Hey Geo and other drivers
  const live = useRef({ editor, c, onSelect, onActivate, onOpen });
  live.current = { editor, c, onSelect, onActivate, onOpen };
  useEffect(() => {
    const target = (id?: string) => { const cur = live.current.c; if (!cur) return false; if (id && id !== cur.id) { live.current.onActivate?.(id); return false; } return true; };
    const apply = (ev: Event) => {
      const d = (ev as CustomEvent<{ conceptId?: string; edits?: Partial<ConceptEdit>; mode?: 'merge' | 'replace' }>).detail;
      if (!d?.edits || !target(d.conceptId)) return;
      live.current.editor.change((e) => (d.mode === 'replace' ? normEdit(d.edits) : mergeEdit(e, d.edits!)));
    };
    const prop = (ev: Event) => {
      const d = (ev as CustomEvent<Partial<Proposal>>).detail;
      const cur = live.current.c;
      if (!cur || !d?.objects?.length || (d.conceptId && d.conceptId !== cur.id)) return;
      setProposal({ objects: d.objects, reason: d.reason ?? '', source: d.source ?? 'Proposed by Geo', notes: d.notes, conceptId: cur.id });
      live.current.onOpen?.();
    };
    const select = (ev: Event) => {
      const d = (ev as CustomEvent<{ conceptId?: string; code?: string | null }>).detail;
      if (d && target(d.conceptId)) live.current.onSelect(d.code ?? null);
    };
    window.addEventListener('geo:apply-edits', apply);
    window.addEventListener('geo:propose', prop);
    window.addEventListener('geo:select', select);
    return () => { window.removeEventListener('geo:apply-edits', apply); window.removeEventListener('geo:propose', prop); window.removeEventListener('geo:select', select); };
  }, []);
  useEffect(() => {
    if (!c) return;
    const detail = { conceptId: c.id, edits: editor.edit, concept: summarize(c, siteW, siteD, setback, selected), status: editor.status, stale: editor.stale, editing: enabled };
    (window as unknown as { __geoDesignState?: unknown }).__geoDesignState = detail;
    window.dispatchEvent(new CustomEvent('geo:design-state', { detail }));
  }, [c, editor.edit, editor.status, editor.stale, siteW, siteD, setback, selected, enabled]);
  useEffect(() => () => { delete (window as unknown as { __geoDesignState?: unknown }).__geoDesignState; }, []);
  // a proposal belongs to the concept it was made for
  useEffect(() => { if (proposal && c && proposal.conceptId !== c.id) setProposal(null); }, [c, proposal]);

  const ghosts: Room[] = useMemo(() => (proposal?.objects ?? []).map((o) => ({
    code: o.code, name: o.name || ASSET[o.type]?.label || o.type, type: o.type, x: o.x, y: o.y, w: o.w, d: o.d, h: o.h ?? ASSET[o.type]?.h, added: true, source: o.source,
  })), [proposal]);
  const placingAsset = placing ? { w: ASSET[placing].w, d: ASSET[placing].d, label: ASSET[placing].label } : null;

  const onScene = useCallback((s: THREE.Scene) => { scene.current = s; }, []);
  /** props for the 3D model: failing objects and the export hook always, editing only in edit mode */
  const model3d = (edit: boolean): Editor3D => (!edit ? { onScene, bad: shownFaults } : {
    bad: shownFaults, ghosts, placing: placingAsset, onPlace, onScene, toolbar: selRoom ? <SelectionToolbar ui={ui} /> : null,
    ghostBar: proposal ? <ProposalBar ui={ui} /> : null,
    resizable: (code) => !!c?.yard.find((y) => y.code === code)?.added,
    onResize: (code, r) => act.rect(code, r), onRotate: (code) => act.rotate(code),
  });
  const plan2d = (edit: boolean, withToolbar: boolean): Editor2D => (!edit ? { bad: shownFaults } : {
    bad: shownFaults, ghosts, placing: placingAsset, onPlace, onMove: (code, dx, dy) => act.move(code, dx, dy), toolbar: withToolbar && selRoom ? <SelectionToolbar ui={ui} /> : null,
  });

  const exportDxf = () => { if (c) downloadDxf(c, siteW, siteD, setback, project); };
  const exportGlb = async () => {
    if (!c || !scene.current) return;
    setExporting(true);
    try { await downloadGlb(scene.current, c, project); } finally { setExporting(false); }
  };

  const ui = {
    editor, concept: c, faults, shownFaults, selRoom, placing, beginPlace, place, act, propose, asking, askError, proposal, setProposal, accept,
    model3d, plan2d, exportDxf, exportGlb, exporting, compassRef, hasScene: () => !!scene.current, siteW, siteD, setback,
  };
  return ui;
}


'use client';
// Edit history and re-checking for the design editor. Every change is pushed onto an undo stack and sent to
// POST /studio/generate (debounced, one request in flight); the engine's answer replaces the concept. Until it
// arrives the views show the moved geometry ("Checking…") and the checks are marked stale, so nothing is shown as
// valid that the engine has not measured. A change the engine rejects (422) is undone and the reason shown.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PUBLIC_DATA_API } from '@/lib/plotstar-api';
import type { Concept, ConceptEdit, Edits, Room, StudioResult } from '../types';
import { ASSET } from './assets';
import { NO_EDIT } from './edit-actions';

export type EditorStatus = 'idle' | 'checking' | 'error';
export interface DesignEditor {
  /** the active concept with any not-yet-checked edit drawn in */
  concept: Concept | null;
  /** true while the shown geometry is ahead of the engine's last answer */
  stale: boolean;
  status: EditorStatus;
  error: string | null;
  notice: string | null;
  clearNotice: () => void;
  commit: (next: Edits) => void;
  /** replace the active concept's edit (convenience over commit) */
  change: (f: (e: ConceptEdit, c: Concept) => ConceptEdit | null) => void;
  undo: () => void; redo: () => void; canUndo: boolean; canRedo: boolean;
  retry: () => void;
  edit: ConceptEdit;
}

class EngineError extends Error { constructor(msg: string, public status: number) { super(msg); } }

async function postGenerate(body: unknown): Promise<StudioResult> {
  const r = await fetch(`${PUBLIC_DATA_API}/studio/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000) });
  if (!r.ok) {
    const d = await r.json().catch(() => null);
    const det = d?.detail;
    const msg = typeof det === 'string' ? det
      : Array.isArray(det) ? det.slice(0, 2).map((x: { loc?: (string | number)[]; msg?: string }) => {
        const loc = (x.loc ?? []).filter((p) => typeof p === 'string' && !['body', 'edits'].includes(p)).join(' ');
        return `${loc ? `${loc}: ` : ''}${x.msg ?? 'invalid'}`;
      }).join('; ')
        : `The layout check failed (${r.status})`;
    throw new EngineError(msg, r.status);
  }
  return r.json();
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const same = (a?: { x: number; y: number }, b?: { x: number; y: number }) => !!a && !!b && a.x === b.x && a.y === b.y;

/** Draw a pending edit over the concept the engine last returned for the applied edit. Geometry only. */
// A rotated building, a restored item or an item moved back to its generated spot only appears once the engine answers.
export function preview(c: Concept, pend: ConceptEdit | undefined, appl: ConceptEdit | undefined): { concept: Concept; stale: boolean } {
  if (pend === appl) return { concept: c, stale: false };
  if (!pend) return { concept: c, stale: true }; // edits cleared: the generated layout comes back with the engine's answer
  const A = appl ?? NO_EDIT;
  const ddx = pend.building.dx - A.building.dx, ddy = pend.building.dy - A.building.dy;
  const sh = <T extends { x: number; y: number }>(r: T): T => ({ ...r, x: r2(r.x + ddx), y: r2(r.y + ddy) });
  const moved = ddx || ddy;
  const rooms = moved ? c.rooms.map((r) => ({ ...sh(r), rows: r.rows?.map(sh) })) : c.rooms;
  const building = moved ? sh(c.building) : c.building;
  const wasRemoved = new Set(A.removed ?? []), nowRemoved = new Set(pend.removed ?? []);
  const addedP = new Map(pend.added.map((a) => [a.code, a]));
  const yard: Room[] = [];
  let genShift: [number, number] | null = null;
  for (const y of c.yard) {
    if (nowRemoved.has(y.code) && !wasRemoved.has(y.code)) continue;
    if (y.added) {
      const a = addedP.get(y.code);
      if (!a) continue;
      yard.push({ ...y, x: a.x, y: a.y, w: a.w, d: a.d, name: a.name ?? y.name, h: a.h ?? y.h });
      continue;
    }
    const mv = pend.yard[y.code], av = A.yard[y.code];
    if (mv && !same(mv, av)) {
      if (y.code === 'GEN') genShift = [mv.x - y.x, mv.y - y.y];
      yard.push({ ...y, x: mv.x, y: mv.y });
    } else {
      yard.push(y);
    }
  }
  const have = new Set(c.yard.map((y) => y.code));
  for (const a of pend.added) if (!have.has(a.code))
    yard.push({ code: a.code, name: a.name ?? ASSET[a.type]?.label ?? a.type, type: a.type, x: a.x, y: a.y, w: a.w, d: a.d, h: a.h ?? ASSET[a.type]?.h, added: true, source: a.source });
  const genGone = nowRemoved.has('GEN') && !wasRemoved.has('GEN');
  const equipment = genGone ? [] : genShift ? c.equipment.map((e) => ({ ...e, x: e.x + genShift![0], y: e.y + genShift![1] })) : c.equipment;
  return { concept: { ...c, building, rooms, yard, equipment }, stale: true };
}

export function useDesignEditor({ concept, edits, setEdits, request, onResult }: {
  concept: Concept | null; edits: Edits; setEdits: (e: Edits) => void;
  /** the full /studio/generate body for a set of edits (brief, site, priorities) */
  request: (ed: Edits) => Record<string, unknown>;
  onResult: (r: StudioResult) => void;
}): DesignEditor {
  const cur = useRef(edits);
  const [applied, setApplied] = useState<Edits>(edits);
  const appliedRef = useRef(edits);
  // history lives in refs (updated outside React's updaters, so StrictMode cannot double a step); `hist` re-renders
  const past = useRef<Edits[]>([]);
  const future = useRef<Edits[]>([]);
  const [hist, setHist] = useState({ undo: 0, redo: 0 });
  const bump = () => setHist({ undo: past.current.length, redo: future.current.length });
  const [status, setStatus] = useState<EditorStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(false);
  const queued = useRef(false);
  const live = useRef({ request, onResult, setEdits, id: concept?.id ?? null });
  live.current = { request, onResult, setEdits, id: concept?.id ?? null };

  // a change from outside the editor (new layouts, an opened project): start a fresh history
  useEffect(() => {
    if (edits === cur.current) return;
    cur.current = edits; appliedRef.current = edits; setApplied(edits); past.current = []; future.current = []; bump(); setError(null);
  }, [edits]);

  const flush = useCallback(async () => {
    if (inflight.current) { queued.current = true; return; }
    const sent = cur.current;
    if (sent === appliedRef.current) { setStatus('idle'); return; }
    inflight.current = true; setStatus('checking');
    const id = live.current.id;
    try {
      const r = await postGenerate({ ...live.current.request(sent), keep: id ? [id] : [] });
      appliedRef.current = sent; setApplied(sent); setError(null);
      live.current.onResult(r);
      const c = r.concepts.find((x) => x.id === id);
      const lost = (sent[id ?? '']?.removed ?? []).filter((code) => c?.yard.some((y) => y.code === code && !y.added));
      if (lost.length) setNotice(`The engine did not apply the removal of ${lost.join(', ')}; it is still in the layout.`);
      setStatus('idle');
    } catch (e) {
      if (e instanceof EngineError && e.status === 422) {
        // rejected: back to the last layout the engine accepted, and drop the rejected step from the history
        const good = appliedRef.current;
        cur.current = good; live.current.setEdits(good);
        if (past.current[past.current.length - 1] === good) past.current = past.current.slice(0, -1);
        future.current = []; bump();
        setNotice(`Not applied: ${/type/i.test(e.message) ? `this engine does not accept that object type yet (${e.message})` : e.message}. The change was undone.`);
        setStatus('idle');
      } else {
        setError(`${e instanceof Error ? e.message : 'Network error'}. The last change is shown but not checked yet.`);
        setStatus('error');
      }
    } finally {
      inflight.current = false;
      if (queued.current) { queued.current = false; if (cur.current !== appliedRef.current) void flush(); }
    }
  }, []);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setStatus('checking');
    timer.current = setTimeout(() => { timer.current = null; void flush(); }, 260);
  }, [flush]);
  // No timer cleanup on unmount: Fast Refresh re-runs effects and would drop a pending check. Instead, any edit that
  // is ahead of the engine with nothing scheduled or in flight gets checked (also covers a remount mid-debounce).
  useEffect(() => {
    if (timer.current || inflight.current) return;
    if (edits !== appliedRef.current) { if (status !== 'error') schedule(); } // after an error the user retries
    else if (status === 'checking') setStatus('idle');
  }, [edits, applied, status, schedule]);

  const set = useCallback((next: Edits) => { cur.current = next; live.current.setEdits(next); schedule(); }, [schedule]);
  const commit = useCallback((next: Edits) => {
    if (next === cur.current) return;
    past.current = [...past.current.slice(-199), cur.current]; future.current = []; bump(); setNotice(null);
    set(next);
  }, [set]);
  const undo = useCallback(() => {
    const prev = past.current[past.current.length - 1];
    if (!prev) return;
    past.current = past.current.slice(0, -1); future.current = [cur.current, ...future.current]; bump(); setNotice(null);
    set(prev);
  }, [set]);
  const redo = useCallback(() => {
    const nxt = future.current[0];
    if (!nxt) return;
    future.current = future.current.slice(1); past.current = [...past.current, cur.current]; bump(); setNotice(null);
    set(nxt);
  }, [set]);

  const id = concept?.id ?? '';
  const edit = edits[id] ?? NO_EDIT;
  const change = useCallback((f: (e: ConceptEdit, c: Concept) => ConceptEdit | null) => {
    if (!concept) return;
    const base = cur.current[concept.id] ?? NO_EDIT;
    const next = f(base, view.current ?? concept);
    if (next && next !== base) commit({ ...cur.current, [concept.id]: next });
  }, [concept, commit]);

  const shown = useMemo(() => (concept ? preview(concept, edits[concept.id], applied[concept.id]) : null), [concept, edits, applied]);
  const view = useRef<Concept | null>(null);
  view.current = shown?.concept ?? null;

  return {
    concept: shown?.concept ?? null, stale: !!shown?.stale, status, error, notice, clearNotice: () => setNotice(null),
    commit, change, undo, redo, canUndo: hist.undo > 0, canRedo: hist.redo > 0, retry: () => void flush(), edit,
  };
}

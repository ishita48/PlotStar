// Pure edits on one concept's ConceptEdit. Each returns a new ConceptEdit; nothing here measures or checks anything,
// the layout engine does that when the edit is sent.
import type { AddedItem, Concept, ConceptEdit, Room } from '../types';
import { ASSET, freeSpot, newItem } from './assets';

export const NO_EDIT: ConceptEdit = { building: { dx: 0, dy: 0 }, rotate: false, yard: {}, added: [], removed: [] };
export type Rect = { x: number; y: number; w: number; d: number };
const r1 = (n: number) => Math.round(n * 10) / 10;

export function codesOf(c: Concept, e: ConceptEdit): string[] {
  return [...c.rooms.map((r) => r.code), ...c.yard.map((r) => r.code), ...e.added.map((a) => a.code), ...(e.removed ?? [])];
}

/** Move the building or one outdoor item by (dx, dy) metres from where it is shown now. */
export function moveBy(e: ConceptEdit, c: Concept, code: string, dx: number, dy: number): ConceptEdit {
  if (code === 'BUILDING') return { ...e, building: { dx: r1(e.building.dx + dx), dy: r1(e.building.dy + dy) } };
  const it = c.yard.find((y) => y.code === code);
  if (!it) return e;
  if (it.added) return { ...e, added: e.added.map((a) => (a.code === code ? { ...a, x: r1(a.x + dx), y: r1(a.y + dy) } : a)) };
  return { ...e, yard: { ...e.yard, [code]: { x: r1(it.x + dx), y: r1(it.y + dy) } } };
}

/** Set position and (for added items) size. Generated items keep their engine-sized footprint and only move. */
export function setRect(e: ConceptEdit, c: Concept, code: string, p: Partial<Rect>): ConceptEdit {
  const it = c.yard.find((y) => y.code === code);
  if (!it) return e;
  const clamp = (n: number, lo: number) => r1(Math.max(lo, Math.min(800, n)));
  if (it.added) {
    const min = it.type === 'sensor' || it.type === 'yard_fence' || it.type === 'yard_wall' ? 0.3 : 1;
    return { ...e, added: e.added.map((a) => (a.code === code ? {
      ...a, ...(p.x != null ? { x: r1(p.x) } : {}), ...(p.y != null ? { y: r1(p.y) } : {}),
      ...(p.w != null ? { w: clamp(p.w, min) } : {}), ...(p.d != null ? { d: clamp(p.d, min) } : {}),
    } : a)) };
  }
  return { ...e, yard: { ...e.yard, [code]: { x: r1(p.x ?? it.x), y: r1(p.y ?? it.y) } } };
}

/** Turn an added item 90 degrees about its centre (w and d swap). */
export function rotate90(e: ConceptEdit, c: Concept, code: string): ConceptEdit {
  const it = c.yard.find((y) => y.code === code);
  if (!it?.added) return e;
  const cx = it.x + it.w / 2, cy = it.y + it.d / 2;
  return setRect(e, c, code, { w: it.d, d: it.w, x: cx - it.d / 2, y: cy - it.w / 2 });
}

export function addItem(e: ConceptEdit, item: AddedItem): ConceptEdit {
  return { ...e, added: [...e.added, item] };
}

/** Copy an added item (or a generated item's type and size) to the nearest free spot next to it. */
export function duplicate(e: ConceptEdit, c: Concept, code: string, siteW: number, siteD: number, setback: number): { edit: ConceptEdit; code: string } | null {
  const it = c.yard.find((y) => y.code === code);
  if (!it || !(it.type in ASSET)) return null;
  const src = e.added.find((a) => a.code === code);
  const at = freeSpot(c, it.w, it.d, siteW, siteD, setback, { x: it.x + it.w * 1.5 + 4, y: it.y + it.d / 2 });
  const item = newItem(it.type as AddedItem['type'], at, codesOf(c, e), { w: it.w, d: it.d, name: src?.name, h: src?.h, source: src?.source });
  return { edit: addItem(e, item), code: item.code };
}

/** Delete: an added item is dropped; a generated yard item goes to `removed` so the engine fails what needed it. */
export function remove(e: ConceptEdit, c: Concept, code: string): ConceptEdit {
  const it = c.yard.find((y) => y.code === code);
  if (!it) return e;
  if (it.added) return { ...e, added: e.added.filter((a) => a.code !== code) };
  const { [code]: _moved, ...yard } = e.yard;
  return { ...e, yard, removed: [...new Set([...(e.removed ?? []), code])] };
}

export function restore(e: ConceptEdit, code: string): ConceptEdit {
  return { ...e, removed: (e.removed ?? []).filter((x) => x !== code) };
}

/** True for the building's rooms (they move with the building). */
export const isRoom = (c: Concept, code: string) => c.rooms.some((r: Room) => r.code === code);

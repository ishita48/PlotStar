// The design editor's asset library: what can be placed on the site, at what default size, and how the engine treats it.
// Sizes are starting points in metres (w east-west, d north-south); the engine measures whatever the user ends up with.
import type { AddedItem, Concept, PlaceType, Room } from '../types';

export interface Asset {
  type: PlaceType; label: string; prefix: string; w: number; d: number; h: number;
  /** how the engine prices it: 'costed' adds to the build cost from an assumption, 'not costed' is measured only */
  cost: 'costed' | 'not costed'; hint: string;
}

export const ASSETS: Asset[] = [
  { type: 'yard_bess', label: 'Battery', prefix: 'BESS', w: 26, d: 12, h: 3, cost: 'costed', hint: 'Energy estimated from its footprint' },
  { type: 'yard_solar', label: 'Solar canopy', prefix: 'PV', w: 36, d: 24, h: 4.5, cost: 'costed', hint: 'Output estimated from its area' },
  { type: 'yard_water', label: 'Water tank', prefix: 'TANK', w: 14, d: 14, h: 8, cost: 'costed', hint: 'Stored water for cooling' },
  { type: 'yard_parking', label: 'Parking', prefix: 'PARK', w: 42, d: 17, h: 0.1, cost: 'costed', hint: 'Counts as covered land' },
  { type: 'yard_wall', label: 'Noise wall', prefix: 'WALL', w: 1, d: 40, h: 6, cost: 'costed', hint: 'Cuts generator noise when within 20 m' },
  { type: 'yard_trees', label: 'Tree buffer', prefix: 'TREES', w: 48, d: 12, h: 7, cost: 'costed', hint: 'Stays open land' },
  { type: 'yard_guard', label: 'Gatehouse', prefix: 'GATE', w: 6, d: 5, h: 3.5, cost: 'costed', hint: 'Site entrance' },
  { type: 'yard_fence', label: 'Fence', prefix: 'FENCE', w: 0.3, d: 40, h: 2.4, cost: 'costed', hint: 'Security line' },
  { type: 'yard_cooling', label: 'Extra cooling', prefix: 'COOL', w: 30, d: 14, h: 4, cost: 'costed', hint: 'More heat rejection' },
  { type: 'sensor', label: 'HAVEN sensor', prefix: 'SENS', w: 1, d: 1, h: 2, cost: 'costed', hint: 'Monitoring point' },
  { type: 'custom', label: 'Custom', prefix: 'OBJ', w: 10, d: 10, h: 3, cost: 'not costed', hint: 'Measured, not costed' },
];
export const ASSET: Record<PlaceType, Asset> = Object.fromEntries(ASSETS.map((a) => [a.type, a])) as Record<PlaceType, Asset>;

export const isAdded = (r: Room) => !!r.added;

/** Next free code for a type, e.g. BESS-3. */
export function nextCode(prefix: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  let n = 1;
  while (set.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

interface R { x: number; y: number; w: number; d: number }
const hit = (a: R, b: R, gap = 0) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > -gap && Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y) > -gap;

/** A spot for a new object: the nearest free rectangle to `near` (or the building) inside the setback, on a 2 m grid.
 * Only a starting position; the engine re-checks it like any other placement. */
export function freeSpot(c: Concept, w: number, d: number, siteW: number, siteD: number, setback: number, near?: { x: number; y: number }): { x: number; y: number } {
  const blocks: R[] = [c.building, ...c.yard];
  const b = c.building;
  const cx = near?.x ?? b.x - w / 2 - 10, cy = near?.y ?? b.y + b.d / 2;
  const lo = setback + 1, hiX = siteW - setback - 1 - w, hiY = siteD - setback - 1 - d;
  const ok = (x: number, y: number) => x >= lo && y >= lo && x <= hiX && y <= hiY && !blocks.some((o) => hit({ x, y, w, d }, o, 3));
  for (let r = 0; r < Math.max(siteW, siteD); r += 2)
    for (let k = 0, n = Math.max(1, Math.round(r * 1.5)); k < n; k++) {
      const a = (2 * Math.PI * k) / n, x = Math.round(cx - w / 2 + r * Math.cos(a)), y = Math.round(cy - d / 2 + r * Math.sin(a));
      if (ok(x, y)) return { x, y };
    }
  return { x: Math.round(Math.max(lo, Math.min(hiX, cx - w / 2))), y: Math.round(Math.max(lo, Math.min(hiY, cy - d / 2))) };
}

export function newItem(type: PlaceType, at: { x: number; y: number }, taken: Iterable<string>, extra?: Partial<AddedItem>): AddedItem {
  const a = ASSET[type];
  const item: AddedItem = { code: nextCode(a.prefix, taken), type, x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10, w: a.w, d: a.d, ...extra };
  if (type === 'custom') { item.name = item.name || 'Custom object'; item.h = item.h || a.h; }
  return item;
}

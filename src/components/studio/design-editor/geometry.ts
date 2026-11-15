// Derived drawing geometry shared by the 3D model and the 2D plan: doors where a room meets a corridor, exits where a
// corridor meets the outer wall, the structural column grid, and in-hall cooling units. All of it is computed from the
// engine's rooms; the spacing and unit sizes below are GeoStar drawing assumptions and are labelled as such in the UI.
import type { Concept, Room } from '../types';

export const COLUMN_GRID_M = 9;          // structural bay used to draw the column grid (GeoStar assumption)
export const DOOR_M = 1.8;               // clear door width drawn on corridor walls
/** In-hall cooling unit drawn per data hall: a CDU for liquid cooling, otherwise a CRAH. Capacities are GeoStar
 * drawing assumptions, used only to decide how many boxes to draw. */
export const COOLING_UNIT: Record<string, { name: string; mw: number; len: number; dep: number; h: number }> = {
  liquid: { name: 'CDU', mw: 1.0, len: 1.2, dep: 2.0, h: 2.0 },
  air: { name: 'CRAH', mw: 0.2, len: 2.4, dep: 1.0, h: 2.1 },
  hybrid: { name: 'CRAH', mw: 0.25, len: 2.4, dep: 1.0, h: 2.1 },
  water: { name: 'CRAH', mw: 0.25, len: 2.4, dep: 1.0, h: 2.1 },
};

export interface Door { room: string; x: number; y: number; /** 'h' sits on an east-west wall, 'v' on a north-south wall */ o: 'h' | 'v'; level: number }
export interface Exit { x: number; y: number; o: 'h' | 'v'; side: 'n' | 's' | 'e' | 'w'; level: number }

const TOL = 0.7;
const span = (a0: number, a1: number, b0: number, b1: number) => [Math.max(a0, b0), Math.min(a1, b1)] as const;

/** One door per room-corridor pair that share a wall at least 2.5 m long, centred on the shared length. */
export function doorsOf(c: Concept): Door[] {
  const out: Door[] = [];
  const corridors = c.rooms.filter((r) => r.type === 'corridor');
  for (const r of c.rooms) {
    if (r.type === 'corridor') continue;
    for (const k of corridors) {
      if ((k.level ?? 0) !== (r.level ?? 0)) continue;
      const lvl = r.level ?? 0;
      for (const [ry, ky] of [[r.y + r.d, k.y], [r.y, k.y + k.d]] as const)
        if (Math.abs(ry - ky) < TOL) {
          const [a, b] = span(r.x, r.x + r.w, k.x, k.x + k.w);
          if (b - a > 2.5) out.push({ room: r.code, x: (a + b) / 2, y: ry, o: 'h', level: lvl });
        }
      for (const [rx, kx] of [[r.x + r.w, k.x], [r.x, k.x + k.w]] as const)
        if (Math.abs(rx - kx) < TOL) {
          const [a, b] = span(r.y, r.y + r.d, k.y, k.y + k.d);
          if (b - a > 2.5) out.push({ room: r.code, x: rx, y: (a + b) / 2, o: 'v', level: lvl });
        }
    }
  }
  return out;
}

/** Exits where a corridor reaches the building's outer wall (ground floor). */
export function exitsOf(c: Concept): Exit[] {
  const b = c.building, out: Exit[] = [];
  for (const k of c.rooms.filter((r) => r.type === 'corridor' && (r.level ?? 0) === 0)) {
    if (Math.abs(k.x - b.x) < TOL) out.push({ x: b.x, y: k.y + k.d / 2, o: 'v', side: 'w', level: 0 });
    if (Math.abs(k.x + k.w - b.x - b.w) < TOL) out.push({ x: b.x + b.w, y: k.y + k.d / 2, o: 'v', side: 'e', level: 0 });
    if (Math.abs(k.y - b.y) < TOL) out.push({ x: k.x + k.w / 2, y: b.y, o: 'h', side: 's', level: 0 });
    if (Math.abs(k.y + k.d - b.y - b.d) < TOL) out.push({ x: k.x + k.w / 2, y: b.y + b.d, o: 'h', side: 'n', level: 0 });
  }
  return out;
}

/** Column positions on an even grid close to COLUMN_GRID_M, including the perimeter. */
export function columnsOf(c: Concept): { x: number; y: number }[] {
  const b = c.building, nx = Math.max(1, Math.round(b.w / COLUMN_GRID_M)), ny = Math.max(1, Math.round(b.d / COLUMN_GRID_M));
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) out.push({ x: b.x + (b.w * i) / nx, y: b.y + (b.d * j) / ny });
  return out;
}
export const columnBay = (c: Concept) => {
  const b = c.building;
  return { x: b.w / Math.max(1, Math.round(b.w / COLUMN_GRID_M)), y: b.d / Math.max(1, Math.round(b.d / COLUMN_GRID_M)) };
};

/** Cooling units inside each data hall, along the wall that faces the hall's mechanical room. Count = hall MW over the
 * unit's capacity (rounded up), capped by what fits on that wall. */
export function coolingUnitsOf(c: Concept, cooling: string): { r: Room; x: number; y: number; w: number; d: number; h: number; label: string }[] {
  const u = COOLING_UNIT[cooling] ?? COOLING_UNIT.air;
  const out: { r: Room; x: number; y: number; w: number; d: number; h: number; label: string }[] = [];
  for (const hall of c.rooms.filter((r) => r.type === 'data_hall' && (r.mw ?? 0) > 0)) {
    const me = c.rooms.find((r) => r.hall === hall.hall && r.code.startsWith('ME') && (r.level ?? 0) === (hall.level ?? 0));
    const hx = hall.x + hall.w / 2, hy = hall.y + hall.d / 2;
    const dx = me ? me.x + me.w / 2 - hx : 0, dy = me ? me.y + me.d / 2 - hy : 1;
    const horiz = Math.abs(dy) * hall.w >= Math.abs(dx) * hall.d; // the ME room is north or south of the hall
    const wall = horiz ? hall.w : hall.d, m = 1.2;
    const want = Math.ceil((hall.mw ?? 0) / u.mw);
    const fit = Math.max(0, Math.floor((wall - 2 * m) / (u.len + 0.6)));
    const n = Math.min(want, fit);
    const step = n ? (wall - 2 * m) / n : 0;
    for (let i = 0; i < n; i++) {
      const a = m + step * (i + 0.5) - u.len / 2;
      if (horiz) out.push({ r: hall, x: hall.x + a, y: dy > 0 ? hall.y + hall.d - 0.35 - u.dep : hall.y + 0.35, w: u.len, d: u.dep, h: u.h, label: u.name });
      else out.push({ r: hall, x: dx > 0 ? hall.x + hall.w - 0.35 - u.dep : hall.x + 0.35, y: hall.y + a, w: u.dep, d: u.len, h: u.h, label: u.name });
    }
  }
  return out;
}

/** A tidy scale-bar length (metres) close to `target`. */
export function niceLength(target: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(1, target)));
  return [1, 2, 5, 10].map((k) => k * p).reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best), p);
}

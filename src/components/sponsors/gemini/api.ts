// Client for the Gemini endpoints of the GeoStar API (services/api/app/sponsors/gemini/routes.py) and the
// mapped-obstacle store the Studio sends to POST /studio/generate.
import { dataFetch, PUBLIC_DATA_API } from '@/lib/plotstar-api';

export type ObstacleKind = 'building' | 'structure' | 'trees' | 'water' | 'parking' | 'paving' | 'road';
export interface Obstacle {
  id: string; x: number; y: number; w: number; d: number; kind: ObstacleKind; label: string; confidence: number; source: string;
  /** The unclipped box in metres from the site centre (east = +x, north = +y). */
  local: { west: number; south: number; east: number; north: number };
  clipped: boolean; suggest_keep: boolean; advice: string | null; site_share: number;
}
export interface ObstacleScan {
  obstacles: Obstacle[]; outside_site: number; scene: string; site: { w: number; d: number };
  image: { buffer_m: number; collection?: string; captured?: string; x0: number; x1: number; y0: number; y1: number };
  scanned: { x0: number; x1: number; y0: number; y1: number };
  mapping: { image_footprint: 'exact' | 'assumed'; m_per_px: number; method: string; site_rectangle: string; frame: string };
  model: string; cached?: boolean; label: string;
}
export interface GeminiStatus {
  configured: boolean; vision_model: string; vision_available: boolean; image_model: string; image_available: boolean;
  image_listed?: boolean; image_blocked?: string | null;
}

export const KIND_COLOR: Record<ObstacleKind, string> = {
  building: '#c2412d', structure: '#a1408f', trees: '#3f8f3a', water: '#2878b5', parking: '#6a6f7a', paving: '#b7791f', road: '#4b5563',
};

export async function gemini<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await dataFetch(`${PUBLIC_DATA_API}/gemini${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : `Gemini request failed (${res.status})`);
  return data as T;
}
export const postJson = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

let statusPromise: Promise<GeminiStatus | null> | null = null;
export function geminiStatus(): Promise<GeminiStatus | null> {
  statusPromise ??= gemini<GeminiStatus>('/status').catch(() => { statusPromise = null; return null; });
  return statusPromise;
}

/** sessionStorage access that never throws (private windows, blocked storage). */
export function load<T>(key: string): T | null {
  try { const v = sessionStorage.getItem(key); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
}
export function save(key: string, v: unknown): void {
  try { if (v === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(v)); } catch { /* storage unavailable */ }
}

// ------------------------------------------------------------------------------------------- mapped obstacles

export interface ObstacleState { scan: ObstacleScan; keep: string[]; applied: string[] }
export const obstacleKey = (aerialId: string) => `gs-obstacles:${aerialId}`;

/** A box in metres from the site centre -> the engine's site frame (SW origin, y north), clipped to the rectangle. */
export function toSiteFrame(o: Obstacle, siteW: number, siteD: number) {
  const x0 = Math.max(0, o.local.west + siteW / 2), x1 = Math.min(siteW, o.local.east + siteW / 2);
  const y0 = Math.max(0, o.local.south + siteD / 2), y1 = Math.min(siteD, o.local.north + siteD / 2);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const r = (v: number) => Math.round(v * 10) / 10;
  return { x: r(x0), y: r(y0), w: r(x1 - x0), d: r(y1 - y0), kind: o.kind, label: o.label, confidence: o.confidence, source: o.source };
}

/** The obstacles the user applied for this site, in the engine's contract for the current rectangle (max 60). */
export function mappedObstacles(aerialId: string | null | undefined, siteW: number, siteD: number) {
  if (!aerialId) return [];
  const s = load<ObstacleState>(obstacleKey(aerialId));
  if (!s) return [];
  const on = new Set(s.applied);
  return s.scan.obstacles.filter((o) => on.has(o.id)).map((o) => toSiteFrame(o, siteW, siteD))
    .filter((o): o is NonNullable<typeof o> => o !== null).slice(0, 60);
}

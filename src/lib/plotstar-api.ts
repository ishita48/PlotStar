// Client for the GeoStar data API (services/api, FastAPI). Real CoStar parcels, screening, Vexcel, Matterport.
import type { Site } from './types';

/** Server-side base URL (Next route handlers). */
export const DATA_API = process.env.PLOTSTAR_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';
/** Browser-side base URL. */
export const PUBLIC_DATA_API = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8000';

// The data API is reached through a tunnel over venue Wi-Fi, which drops for a few seconds now and then.
// A network error, or the tunnel's own "origin unreachable" answers (502/503/504, Cloudflare 530), is retried with a
// short backoff before anyone sees an error. Only the data API's reads and pure computations go through this.
// Reads retry on any of those; writes only when the tunnel says the request never reached the service (530, network).
const RETRY_READ = new Set([502, 503, 504, 530]);
const RETRY_WRITE = new Set([530]);
const BACKOFF_MS = [600, 1500, 3500];
export async function dataFetch(input: string, init?: RequestInit): Promise<Response> {
  const read = !init?.method || init.method.toUpperCase() === 'GET';
  const retry = read ? RETRY_READ : RETRY_WRITE;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(input, init);
      if (!retry.has(r.status) || attempt >= BACKOFF_MS.length) return r;
    } catch (error) {
      if (attempt >= BACKOFF_MS.length || init?.signal?.aborted) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt]));
  }
}

export const MARKETS = ['Houston', 'Los Angeles'] as const;
export type Market = (typeof MARKETS)[number];

export function marketFor(location: string): Market | null {
  if (/houston|harris|texas|\btx\b/i.test(location)) return 'Houston';
  if (/los angeles|\bla\b|california|\bca\b/i.test(location)) return 'Los Angeles';
  return null;
}

/** Real candidate sites from the CoStar Data Extract, screened by hard gates. Throws if the API is down. */
export async function fetchRealSites(market: Market, minAcres = 5, limit = 8): Promise<Site[]> {
  const q = new URLSearchParams({ market, min_acres: String(minAcres), limit: String(limit) });
  let res: Response;
  try {
    res = await fetch(`${DATA_API}/sites/candidates?${q}`, { cache: 'no-store' });
  } catch {
    throw new Error(
      `GeoStar data API is not reachable at ${DATA_API}. Start services/api (uvicorn app.main:app --port 8000).`,
    );
  }
  if (!res.ok) throw new Error(`GeoStar data API error ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { sites: Site[] };
  return body.sites;
}

export const vexcelOrthoUrl = (parcelId: string, bufferM = 200) =>
  `${PUBLIC_DATA_API}/vexcel/ortho/${encodeURIComponent(parcelId)}.jpg?buffer_m=${bufferM}`;
export const vexcelMetaUrl = (parcelId: string, bufferM = 200) =>
  `${PUBLIC_DATA_API}/vexcel/ortho/${encodeURIComponent(parcelId)}/meta?buffer_m=${bufferM}`;
export const vexcel3dRootUrl = (lat: number, lon: number) =>
  `${PUBLIC_DATA_API}/vexcel/3d/root?lat=${lat}&lon=${lon}`;
export const siteDetailUrl = (parcelId: string) => `${PUBLIC_DATA_API}/sites/${encodeURIComponent(parcelId)}`;
export const auditUrl = (parcelId: string, field: string) =>
  `${PUBLIC_DATA_API}/audit/parcel/${encodeURIComponent(parcelId)}/${encodeURIComponent(field)}`;
export const matterportEmbedUrl = (modelId: string) =>
  `https://my.matterport.com/show/?m=${encodeURIComponent(modelId)}&play=1&qs=1`;

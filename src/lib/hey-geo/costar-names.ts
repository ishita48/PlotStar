/**
 * Hey Geo — the CoStar names and addresses to hide (server only).
 * Property names can't be told apart from other text by pattern, so the route
 * asks GeoStar's own data API (services/api, the same source the Studio map
 * uses) for the markets' CoStar records and redacts those exact strings.
 * Cached for ten minutes; if the API is down, the pattern rules in redact.ts
 * still apply and the route reports that the name list was unavailable.
 */

import { namesPattern } from "./redact";

const API = (process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
const MARKETS = ["Houston", "Los Angeles"];
const TTL_MS = 10 * 60 * 1000;

type Cache = { at: number; names: string[] };
const g = globalThis as { __heyGeoCostarNames?: Cache };

type SiteRecord = { name?: unknown; address?: unknown; city?: unknown; costar_property_id?: unknown; parcel_id?: unknown };

async function fetchMarket(market: string): Promise<string[]> {
  const res = await fetch(`${API}/sites?market=${encodeURIComponent(market)}`, { cache: "no-store", signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error(`sites ${res.status}`);
  const body = (await res.json()) as { sites?: SiteRecord[] };
  const out: string[] = [];
  for (const s of body.sites ?? []) {
    const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");
    const name = str(s.name);
    const address = str(s.address);
    const city = str(s.city);
    if (name) out.push(name);
    if (address) out.push(address, city ? `${address}, ${city}` : address);
    const id = str(s.costar_property_id);
    if (id.length >= 5) out.push(id);
  }
  return out;
}

/** Exact CoStar strings to redact, or null when GeoStar's data API could not be reached. */
export async function costarNames(): Promise<string[] | null> {
  const cached = g.__heyGeoCostarNames;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.names;
  try {
    const lists = await Promise.all(MARKETS.map(fetchMarket));
    const names = lists.flat();
    g.__heyGeoCostarNames = { at: Date.now(), names };
    return names;
  } catch {
    return cached?.names ?? null;
  }
}

/** The names regex for one turn: the CoStar records plus any extra names (the facility on screen). */
export async function costarNamesPattern(extra: string[] = []): Promise<{ re: RegExp | null; listed: boolean }> {
  const names = await costarNames();
  return { re: namesPattern([...(names ?? []), ...extra]), listed: !!names };
}

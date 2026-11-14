// Typed client for the PlotStar API (services/api). All data comes from the backend; nothing is mocked here.

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export type Label = "Measured" | "Sourced" | "Estimated" | "Simulated" | "Utility-confirmed" | "Unknown";

export interface SiteSummary {
  parcel_id: string;
  costar_property_id: number;
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number;
  lon: number;
  market: string | null;
  property_type: string | null;
  property_subtype: string | null;
  lot_acres: number | null;
  building_sf: number | null;
  has_heavy_power: 0 | 1 | null;
  amps_high: number | null;
  availability: string;
  asking_price_low: number | null;
  asking_price_high: number | null;
  last_sale_price: number | null;
  last_sale_status: string | null;
  last_sale_date: string | null;
  photo_url: string | null;
  matterport_count: number;
  dc_candidate: 0 | 1;
  source_file: string;
  source_row: number;
}

export interface SiteDetail {
  parcel: SiteSummary & Record<string, unknown>;
  labels: Record<string, Label>;
  matterport_model_ids: string[];
}

export interface AuditChain {
  parcel_id: string;
  field: string;
  value: unknown;
  label: Label;
  source: string;
  source_file: string;
  source_row: number | null;
  json_path: string;
  formula: string | null;
  loaded_at: string;
  extra: Record<string, unknown> | null;
}

export interface MarketSummary {
  market: string;
  properties: number;
  candidates: number;
  candidates_with_asking_price: number;
  candidates_with_sale_price: number;
  candidates_with_heavy_power: number;
  candidates_with_matterport: number;
}

export interface DataSummary {
  ready: boolean;
  kit_found: boolean;
  ingest_runs: { dataset: string; source_file: string; rows_read: number; loaded_at: string }[];
  by_market?: MarketSummary[];
  candidates_by_type?: { market: string; property_type: string; n: number }[];
}

export interface Assumption {
  value: number;
  source: string;
}

export interface Project {
  id: number;
  name: string;
  capacity_mw: number;
  region: string;
  max_land_cost: number | null;
  target_cod: string | null;
  flexible_share: number;
  assumptions: Record<string, Assumption | null>;
  assumptions_unset: string[];
  created_at: string;
}

export interface ProjectIn {
  name: string;
  capacity_mw: number;
  region: string;
  max_land_cost?: number | null;
  target_cod?: string | null;
  flexible_share: number;
}

export interface MatterportModel {
  id: string;
  name: string | null;
  created: string | null;
  visibility: string | null;
  address: { address: string } | null;
  image: { url: string } | null;
  retrieved_at: string;
  cached: boolean;
}

export interface IntegrationStatus {
  costar: { configured: boolean; loaded: boolean };
  matterport: { configured: boolean };
  vexcel: { configured: boolean; note: string };
  bedrock: { configured: boolean; note: string };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, `Cannot reach the PlotStar API at ${API_URL}. Is it running?`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const matterportEmbedUrl = (modelId: string) =>
  `https://my.matterport.com/show/?m=${encodeURIComponent(modelId)}&play=1&qs=1`;

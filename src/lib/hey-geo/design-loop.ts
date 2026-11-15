/**
 * Hey Geo — the layout design loop (browser only).
 * ─────────────────────────────────────────────────
 * "Make a better design": ask GeoStar's own engine, never the chat model, for the numbers.
 *  1. POST /studio/generate with the Studio's brief, site, priorities and edits (keep = the active concept) for the
 *     concept as it stands now;
 *  2. POST /design/propose for new objects (the design editor's proposal route: geometry only, no CoStar fields);
 *  3. POST /studio/generate again with those objects added to the concept's edits, and compare before and after
 *     (build cost, NPV, payback, noise, carbon, water, failing checks).
 * Nothing in the Studio changes until "implement the design" (on Allow), which hands the edits to the Studio:
 * a cancelable window event `geo:apply-edits` {conceptId, edits} first (for the design editor to handle), then the
 * Studio's own commit function when nobody handled the event.
 * Coordinates are the engine's: metres, origin at the site's south-west corner, y pointing north.
 */

import { PUBLIC_DATA_API } from "@/lib/plotstar-api";
import type { Rect } from "./geometry";
import type { RunState } from "@/components/sponsors/langchain/use-agent-run";

/** What the Studio lends Hey Geo (see studio.tsx). */
export type StudioLink = {
  /** The body the Studio sends to POST /studio/generate: brief, site, priorities, edits. */
  body: Record<string, unknown> | null;
  conceptId: string | null;
  stage: string;
  market: string;
  selected?: string | null;
  facilityId?: string | null;
  /** The Studio's own way to commit edits (it re-runs the engine and re-renders the 2D plan and 3D model). */
  applyEdits?(edits: Record<string, unknown>): void;
  /** The Studio's way to apply a what-if to the brief (the copilot's Apply). */
  applyPatch?(patch: Record<string, number | string>): void;
  /** The Studio's shared Deep Agents run (status pill, live graph, design edits), from useAgentRun(). */
  agent?: { state: RunState; start(path: "/agents/chat", body: unknown, title: string): Promise<string | null>; decide(approve: boolean): Promise<void> };
  /** Open the full live agent graph (Agent Intelligence). */
  openGraph?(): void;
  lastScore?: { verdict: string; score: number | null } | null;
};

type Rectish = { code?: string; type?: string; name?: string; x: number; y: number; w: number; d: number; added?: boolean };
type Check = { name: string; ok: boolean; detail?: string };
type ConceptLike = {
  id: string; name: string; building: Rectish; yard: Rectish[]; rooms: Rectish[]; checks: Check[];
  money: Record<string, number | null>; people: Record<string, number | null | boolean>; planet: Record<string, number>; resources: Record<string, number>;
};
type Result = { brief: { site_w: number; site_d: number; setback_m: number }; concepts: ConceptLike[] };
type EditShape = { building: { dx: number; dy: number }; rotate: boolean; yard: Record<string, { x: number; y: number }>; added: Rectish[]; removed: string[] };

export type Diff = { label: string; before: string; after: string; better: boolean | null };
export type DesignProposal = {
  conceptId: string;
  conceptName: string;
  goal: string;
  reason: string;
  source: string;
  objects: (Rectish & { code: string; type: string })[];
  edits: Record<string, EditShape>;
  diffs: Diff[];
  siteD: number;
  failingBefore: number;
  failingAfter: number;
};

const NO_EDIT: EditShape = { building: { dx: 0, dy: 0 }, rotate: false, yard: {}, added: [], removed: [] };

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`${PUBLIC_DATA_API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const d = await r.json().catch(() => null);
  if (!r.ok) {
    const det = d?.detail;
    throw new Error(typeof det === "string" ? det : Array.isArray(det) ? det.map((x: { msg?: string }) => x.msg).join("; ") : `GeoStar API ${path} failed (${r.status})`);
  }
  return d as T;
}

const usd = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? "unknown" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(n);
const num = (n: number | null | undefined, unit = "", d = 0) => (n == null || !Number.isFinite(n) ? "unknown" : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: d }).format(n)}${unit}`);

function diffs(a: ConceptLike, b: ConceptLike): Diff[] {
  const out: Diff[] = [];
  const add = (label: string, x: number | null | undefined, y: number | null | undefined, fmt: (n: number | null | undefined) => string, lowerIsBetter: boolean) => {
    if (x == null && y == null) return;
    const better = x == null || y == null || x === y ? null : lowerIsBetter ? y < x : y > x;
    out.push({ label, before: fmt(x), after: fmt(y), better });
  };
  const failing = (c: ConceptLike) => c.checks.filter((k) => !k.ok).length;
  add("Failing checks", failing(a), failing(b), (n) => num(n), true);
  add("Build cost (estimated)", a.money.capex as number, b.money.capex as number, usd, true);
  add("NPV (estimated)", a.money.npv as number, b.money.npv as number, usd, false);
  add("Payback", a.money.payback_years as number | null, b.money.payback_years as number | null, (n) => num(n, " yr", 1), true);
  add("Noise at boundary", a.people.noise_at_boundary_dba as number, b.people.noise_at_boundary_dba as number, (n) => num(n, " dBA", 1), true);
  add("Noise at nearest home", a.people.noise_at_home_dba as number | null, b.people.noise_at_home_dba as number | null, (n) => num(n, " dBA", 1), true);
  add("CO₂ per year", a.planet.co2_t_per_year, b.planet.co2_t_per_year, (n) => num(n, " t"), true);
  add("Water per year", a.resources.water_m3_per_year, b.resources.water_m3_per_year, (n) => num(n, " m³"), true);
  add("Battery storage", a.resources.bess_mwh, b.resources.bess_mwh, (n) => num(n, " MWh", 1), false);
  return out.filter((d) => d.before !== d.after || d.label === "Failing checks");
}

/** Work out a better design for the active concept. Changes nothing in the Studio. */
export async function proposeDesign(link: StudioLink, goal: string, signal?: AbortSignal): Promise<DesignProposal> {
  if (!link.body || !link.conceptId) throw new Error("Generate the layouts first (Define, then Discover), then open the concept in Explore.");
  const id = link.conceptId;
  const edits = { ...((link.body.edits as Record<string, EditShape>) ?? {}) };
  const before = await post<Result>("/studio/generate", { ...link.body, edits, keep: [id] }, signal);
  const a = before.concepts.find((c) => c.id === id);
  if (!a) throw new Error("The engine no longer returns this concept; regenerate the layouts and try again.");
  const failing = a.checks.filter((k) => !k.ok);
  const text = (goal.trim().length >= 6 ? goal.trim() : "Improve this layout") + (failing.length ? `. Fix these failing checks if objects can: ${failing.map((k) => k.name).join(", ")}.` : ". Reduce noise toward neighbours and add useful on-site storage or solar.");
  const concept = {
    site_w: before.brief.site_w,
    site_d: before.brief.site_d,
    setback: before.brief.setback_m,
    building: { x: a.building.x, y: a.building.y, w: a.building.w, d: a.building.d },
    yard: a.yard.map((y) => ({ code: y.code ?? "", type: y.type ?? "custom", x: y.x, y: y.y, w: y.w, d: y.d, name: y.name ?? null })),
    checks: a.checks.slice(0, 30).map((k) => ({ name: k.name.slice(0, 120), ok: k.ok, detail: (k.detail ?? "").slice(0, 400) })),
    selected: link.selected ?? null,
  };
  const prop = await post<{ objects: (Rectish & { code: string; type: string })[]; reason: string; source: string }>("/design/propose", { text: text.slice(0, 600), concept }, signal);
  const cur: EditShape = { ...NO_EDIT, ...(edits[id] ?? {}) };
  const taken = new Set([...a.yard.map((y) => y.code), ...cur.added.map((x) => x.code)]);
  const objects = prop.objects.filter((o) => !taken.has(o.code));
  const next: Record<string, EditShape> = {
    ...edits,
    [id]: { ...cur, added: [...cur.added, ...objects.map((o) => ({ code: o.code, type: o.type, x: o.x, y: o.y, w: o.w, d: o.d, name: o.name, h: (o as { h?: number }).h, source: "hey-geo" }))] },
  };
  const after = await post<Result>("/studio/generate", { ...link.body, edits: next, keep: [id] }, signal);
  const b = after.concepts.find((c) => c.id === id) ?? after.concepts[0];
  return {
    conceptId: id,
    conceptName: a.name,
    goal: text,
    reason: prop.reason,
    source: prop.source,
    objects,
    edits: next,
    diffs: diffs(a, b),
    siteD: before.brief.site_d,
    failingBefore: failing.length,
    failingAfter: b.checks.filter((k) => !k.ok).length,
  };
}

/** Hand the proposal's edits to the Studio. Returns how it was applied, or null when nothing on the page could. */
export function implementDesign(link: StudioLink | null, p: DesignProposal): "event" | "studio" | null {
  // The design editor (src/components/studio/design-editor) listens for geo:apply-edits {conceptId, edits: ConceptEdit,
  // mode} and makes it one undoable step; it publishes window.__geoDesignState while it is mounted.
  if (designEditorOn(p.conceptId)) {
    window.dispatchEvent(new CustomEvent("geo:apply-edits", { detail: { conceptId: p.conceptId, edits: p.edits[p.conceptId], mode: "replace" } }));
    return "event";
  }
  if (link?.applyEdits) {
    link.applyEdits(p.edits);
    return "studio";
  }
  return null;
}

/** Is the design editor mounted on this concept (it publishes window.__geoDesignState)? */
export function designEditorOn(conceptId: string): boolean {
  const st = (window as unknown as { __geoDesignState?: { conceptId?: string } }).__geoDesignState;
  return !!st && st.conceptId === conceptId && !!document.querySelector("svg.st-plan, canvas");
}

/** Show the proposal as ghosts with Accept / Reject in the design editor (geo:propose). False when it isn't mounted. */
export function showInEditor(p: DesignProposal): boolean {
  if (!designEditorOn(p.conceptId)) return false;
  window.dispatchEvent(new CustomEvent("geo:propose", { detail: { conceptId: p.conceptId, objects: p.objects, reason: p.reason, source: `Proposed by Geo (${p.source})` } }));
  return true;
}

/**
 * Where a rectangle in site metres sits on screen, using the 2D plan's own SVG transform (svg.st-plan draws
 * metres with y flipped: fy(y, d) = siteD - y - d). Null when the plan isn't on screen.
 */
export function planRect(o: { x: number; y: number; w: number; d: number }, siteD: number): Rect | null {
  const svg = Array.from(document.querySelectorAll<SVGSVGElement>("svg.st-plan")).find((s) => s.getBoundingClientRect().width > 40);
  const m = svg?.getScreenCTM();
  if (!svg || !m) return null;
  const at = (x: number, y: number) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
  const p1 = at(o.x, siteD - o.y - o.d);
  const p2 = at(o.x + o.w, siteD - o.y);
  return { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.max(2, Math.abs(p2.x - p1.x)), h: Math.max(2, Math.abs(p2.y - p1.y)) };
}

/** A short line Geo says about a proposal (the full table is in the panel). */
export function proposalSummary(p: DesignProposal): string {
  const what = p.objects.map((o) => o.name || o.code).slice(0, 3).join(", ");
  const checks = p.failingBefore !== p.failingAfter ? ` Failing checks go from ${p.failingBefore} to ${p.failingAfter}.` : "";
  return `I'd add ${p.objects.length === 1 ? "one object" : `${p.objects.length} objects`}: ${what}.${checks} The engine's before and after numbers are in the panel; say "implement the design" to apply it.`;
}

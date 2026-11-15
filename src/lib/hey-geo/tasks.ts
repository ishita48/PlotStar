/**
 * Hey Geo tasks — GeoStar work carried out by clicking the page's own buttons
 * (the same controls a person would use), found on screen by their labels.
 *
 * Nothing that changes anything runs without the person's OK: every write is
 * proposed first (Allow / Skip, or "yes" / "no" out loud), and approvals,
 * scenarios, resets and the emergency call ask twice. Opening a step runs at
 * once. Tracked in Hey Geo's task tray while they run.
 */

import type { GeoTask, StudioStep } from "./schema";

export type TaskStatus = "running" | "done" | "failed";
export type TrackedTask = { id: string; task: GeoTask; label: string; status: TaskStatus; detail?: string; startedAt: number };

const SCENARIO = { leak: "water leak", fire: "fire", usage: "usage spike" } as const;
const PAGE_LABEL = { deal_desk: "the Deal desk", data: "the Data page", how_ai_works: "How the AI works", live_operations: "Live operations", home: "the GeoStar home page", agent_graph: "Agent Intelligence" } as const;
const PAGE_CONTROL: Record<keyof typeof PAGE_LABEL, RegExp> = {
  deal_desk: /^Deal desk$/i,
  data: /^Data$/i,
  how_ai_works: /^How the AI works$/i,
  live_operations: /^Live operations$/i,
  home: /^Home$/i,
  agent_graph: /^Agent Intelligence$/i,
};

export function taskLabel(t: GeoTask): string {
  switch (t.type) {
    case "open_step":
      return `Opening ${t.step}`;
    case "open_command_center":
      return "Opening the Command Center";
    case "open_page":
      return `Opening ${PAGE_LABEL[t.page]}`;
    case "ask_agents":
      return "Asking GeoStar's agent team";
    case "what_if":
      return "Running a what-if";
    case "improve_design":
      return "Working out a better design with the layout engine";
    case "implement_design":
      return "Implementing the proposed design";
    case "trigger_scenario":
      return `Starting the simulated ${SCENARIO[t.scenario]}`;
    case "reset_simulation":
      return "Resetting the protection simulation";
    case "approve_plan":
      return "Approving the response plan";
    case "acknowledge_incident":
      return "Acknowledging the incident";
    case "team_update":
      return `Recording the next ${t.team} step`;
    case "complete_recovery":
      return "Completing recovery";
    case "emergency_call":
      return "Starting the Command Center call (simulated or the emergency contact, never 911)";
  }
}

/** Navigation only: runs at once, no confirmation, no tray entry. */
export const isInstant = (t: GeoTask) => t.type === "open_step" || t.type === "open_command_center" || t.type === "open_page";
/** Changes nothing in GeoStar (no confirmation), but may take a moment. */
export const isReadOnly = (t: GeoTask) => isInstant(t) || t.type === "ask_agents" || t.type === "what_if" || t.type === "improve_design";

/** Ask twice: these change what everyone is told, start a scenario, start over, or place a call. */
export const needsStrongConfirm = (t: GeoTask) =>
  t.type === "approve_plan" || t.type === "emergency_call" || t.type === "reset_simulation" || t.type === "trigger_scenario";

// ── Finding the page's own controls ──────────────────────────────────
const textOf = (el: Element) => ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim();
const ours = (el: Element) => !!el.closest("[data-geo-ui], [data-guide-ui]");

function visible(el: Element) {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
}

const isDisabled = (el: Element) => (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true" || el.classList.contains("locked");

/** The first visible button whose label matches. */
export function findControl(label: RegExp, selector = 'button, a[href], [role="button"], [role="tab"]'): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    if (ours(el) || !visible(el)) continue;
    const t = textOf(el) || el.getAttribute("aria-label") || "";
    // Studio tabs carry their number first ("1Compare"): match with and without it.
    if (label.test(t) || label.test(t.replace(/^\d+\s*/, ""))) return el;
  }
  return null;
}

/** What the page shows as an error right now (GeoStar surfaces failures as alerts). */
function pageErrors(): string[] {
  return Array.from(document.querySelectorAll('[role="alert"], .hv-save-error, .st-error'))
    .filter((el) => !ours(el) && visible(el))
    .map(textOf)
    .filter(Boolean);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the page gives the runner: a click that flies Geo's cursor there first. */
export type TaskStore = { click: (el: HTMLElement) => Promise<void> };

async function press(store: TaskStore, label: RegExp, missing: string): Promise<{ ok: boolean; detail?: string }> {
  const el = findControl(label);
  if (!el) return { ok: false, detail: missing };
  if (isDisabled(el)) return { ok: false, detail: `“${textOf(el).slice(0, 50)}” is disabled right now` };
  const before = new Set(pageErrors());
  await store.click(el);
  await sleep(900);
  const fresh = pageErrors().find((e) => !before.has(e));
  return fresh ? { ok: false, detail: fresh.slice(0, 200) } : { ok: true };
}

const PARENT: Partial<Record<StudioStep, StudioStep>> = {
  "What to build": "Define", Requirements: "Define", Site: "Define", "Review brief": "Define",
  Compare: "Analyze", Decide: "Analyze", Model: "Design", Protect: "Design", Deploy: "Design",
};
const exact = (s: string) => new RegExp(`^${s}$`, "i");
const PROTECT_FIRST = "I can't see that button on this screen. Open Design → Protect (or a facility's Command Center under Deploy) first.";

async function openStep(step: StudioStep, store: TaskStore): Promise<{ ok: boolean; detail?: string }> {
  const main = PARENT[step] ?? step;
  const rail = Array.from(document.querySelectorAll<HTMLElement>(".st-rail li")).find((li) => textOf(li.querySelector("b") ?? li).toLowerCase() === main.toLowerCase());
  if (rail) {
    if (rail.classList.contains("locked")) return { ok: false, detail: `${main} unlocks after the earlier steps are done` };
    if (!rail.classList.contains("on")) {
      await store.click(rail);
      await sleep(600);
    }
  } else if (!PARENT[step] || !findControl(exact(step))) {
    return { ok: false, detail: `I can't see the ${main} step in the workflow rail here` };
  }
  if (step === main && step !== "Analyze") return { ok: true };
  // Sub-tab (Analyze has its own tab too).
  const tab = findControl(exact(step), '.st-tabs button, .st-seg button, [role="tab"], button');
  if (!tab) return step === main ? { ok: true } : { ok: false, detail: `I opened ${main}, but I can't see its ${step} tab` };
  if (isDisabled(tab)) return { ok: false, detail: `${step} isn't available yet` };
  if (!tab.classList.contains("on") && tab.getAttribute("aria-selected") !== "true") await store.click(tab);
  return { ok: true };
}

export async function runTask(t: GeoTask, store: TaskStore): Promise<{ ok: boolean; detail?: string }> {
  switch (t.type) {
    case "open_step":
      return openStep(t.step, store);
    case "open_page":
      return press(store, PAGE_CONTROL[t.page], `I can't see the link to ${PAGE_LABEL[t.page]} on this screen`);
    case "ask_agents":
    case "what_if":
    case "improve_design":
    case "implement_design":
      return { ok: false, detail: "Handled by Hey Geo itself" };
    case "open_command_center":
      return press(store, /^Open Command Center$/i, "Open Design → Protect for a deployed facility first; the Command Center button is there");
    case "trigger_scenario": {
      const label = t.scenario === "leak" ? /^Trigger Water Leak$/i : t.scenario === "fire" ? /^Trigger Fire$/i : /^Usage spike$/i;
      const r = await press(store, label, PROTECT_FIRST);
      return r.ok ? { ok: true, detail: "Simulated incident started" } : r;
    }
    case "reset_simulation":
      return press(store, /^Reset Simulation$/i, PROTECT_FIRST);
    case "approve_plan": {
      if (findControl(/^Plan approved/i)) return { ok: false, detail: "The response plan is already approved" };
      const r = await press(store, /^Approve plan$/i, "Open the facility's Command Center (Design → Deploy) to approve the plan");
      return r.ok ? { ok: true, detail: "Plan approved and shared (simulation)" } : r;
    }
    case "acknowledge_incident":
      return press(store, /^Acknowledge$/i, "There's no incident to acknowledge on this screen");
    case "team_update":
      return press(
        store,
        t.team === "maintenance" ? /^Report investigation (started|complete)$/i : /^Report (security acknowledged|officer dispatched|officer on scene)$/i,
        `There's no next ${t.team} step on this screen (open the Command Center during an incident)`
      );
    case "complete_recovery":
      return press(store, /^Complete recovery$/i, "Recovery can be completed in the Command Center once incidents are resolved");
    case "emergency_call": {
      const live = !!findControl(/^Call emergency contact$|^Call again$/i);
      const r = await press(store, /^Call emergency (services \(simulated\)|contact)$|^Call again$/i, "Open the Command Center during a fire or leak incident first");
      if (!r.ok) return r;
      // The live call asks for a second tap on its own button; the person already allowed it twice here.
      const again = findControl(/^Tap again to call/i);
      if (again) {
        await store.click(again);
        await sleep(600);
      }
      return { ok: true, detail: live ? "Calling the emergency contact (not 911)" : "Simulated call, no real number was dialled" };
    }
  }
}

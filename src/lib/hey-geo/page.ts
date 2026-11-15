/**
 * What Hey Geo knows about the GeoStar page it sits on (browser only), read from
 * the DOM so the Studio needs no wiring: the step on screen, its sub-tab, and the
 * HAVEN facility whose twin is shown (its protection state is read, never
 * changed, from /api/protection/:id, the same route the Protect screen uses).
 */

import type { ProtectionState } from "@/lib/haven/engine";
import type { ScreenContext } from "./schema";

const textOf = (el: Element | null) => ((el as HTMLElement | null)?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();

/** The Studio step and sub-tab on screen ("design", "Protect"). */
export function studioStep(): { step: string | null; view: string | null } {
  const on = document.querySelector(".st-rail li.on b");
  const step = textOf(on).toLowerCase() || null;
  const tab = document.querySelector(".st-tabs button.on, .st-tabs [aria-selected='true']");
  return { step, view: textOf(tab).replace(/^\d+\s*/, "") || null };
}

/** The HAVEN facility whose twin (or protection screen) is on the page, if any. */
export function facilityOnScreen(): string | null {
  const el = document.querySelector<HTMLElement>("[data-facility-id]");
  const id = el?.getAttribute("data-facility-id");
  return id && /^[a-z0-9-]{1,150}$/.test(id) ? id : null;
}

export async function loadProtection(id: string, signal?: AbortSignal): Promise<ProtectionState | null> {
  try {
    const res = await fetch(`/api/protection/${encodeURIComponent(id)}?name=Facility`, { cache: "no-store", signal });
    if (!res.ok) return null;
    const s = (await res.json()) as ProtectionState;
    return s && typeof s.revision === "number" && s.facility?.id === id ? s : null;
  } catch {
    return null;
  }
}

export function appContext(): ScreenContext["app"] {
  const { step, view } = studioStep();
  return {
    role: (step ?? "unknown").slice(0, 24),
    ...(view ? { view: view.slice(0, 40) } : {}),
    path: `${location.pathname}${location.hash}`.slice(0, 200),
    facility: !!facilityOnScreen(),
  };
}

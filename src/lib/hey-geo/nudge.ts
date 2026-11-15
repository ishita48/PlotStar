/**
 * Hey Geo nudges: a small bubble by the orb that suggests one thing Geo can
 * do on the current view. Rare by design: a few per day at most, longer
 * gaps once someone already uses Hey Geo, and a week of silence after they
 * wave it away a few times.
 */

export type NudgeState = {
  lastShown: number; // ms epoch, 0 = never
  day: string; // YYYY-MM-DD the count belongs to
  shownToday: number;
  dismissals: number; // "Not now" clicks since the last snooze
  snoozedUntil: number; // ms epoch
  uses: number; // times Hey Geo was turned on
};

export type Nudge = { text: string; prompt: string };

export const NUDGE_KEY = "geostar:hey-geo:nudge";
export const FIRST_DELAY_MS = 25_000;
export const AUTO_HIDE_MS = 10_000;
const GAP_NEW_MS = 8 * 60_000;
const GAP_USER_MS = 30 * 60_000;
const MAX_PER_DAY = 3;
const DISMISSALS_TO_SNOOZE = 3;
const SNOOZE_MS = 7 * 24 * 60 * 60_000;

export const EMPTY_NUDGE: NudgeState = { lastShown: 0, day: "", shownToday: 0, dismissals: 0, snoozedUntil: 0, uses: 0 };

function dayOf(now: number) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseNudge(raw: string | null): NudgeState {
  try {
    const v = JSON.parse(raw || "null");
    if (!v || typeof v !== "object") return { ...EMPTY_NUDGE };
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
    return {
      lastShown: n(v.lastShown),
      day: typeof v.day === "string" ? v.day : "",
      shownToday: n(v.shownToday),
      dismissals: n(v.dismissals),
      snoozedUntil: n(v.snoozedUntil),
      uses: n(v.uses),
    };
  } catch {
    return { ...EMPTY_NUDGE };
  }
}

export function canNudge(s: NudgeState, now: number): boolean {
  if (now < s.snoozedUntil) return false;
  if (s.day === dayOf(now) && s.shownToday >= MAX_PER_DAY) return false;
  const gap = s.uses > 0 ? GAP_USER_MS : GAP_NEW_MS;
  return !s.lastShown || now - s.lastShown >= gap;
}

export function markShown(s: NudgeState, now: number): NudgeState {
  const day = dayOf(now);
  return { ...s, lastShown: now, day, shownToday: s.day === day ? s.shownToday + 1 : 1 };
}

export function markDismissed(s: NudgeState, now: number): NudgeState {
  const dismissals = s.dismissals + 1;
  if (dismissals >= DISMISSALS_TO_SNOOZE) return { ...s, dismissals: 0, snoozedUntil: now + SNOOZE_MS };
  return { ...s, dismissals };
}

export function markUsed(s: NudgeState): NudgeState {
  return { ...s, uses: s.uses + 1, dismissals: 0 };
}

/** One or two tips per Studio step (the "role" here is the step on screen). */
const BY_ROLE: Record<string, Nudge[]> = {
  define: [
    { text: "Not sure what to fill in? I can walk you through the brief step by step.", prompt: "Walk me through this brief step by step." },
    { text: "Want me to sketch how GeoStar goes from a brief to a design?", prompt: "Explain how the GeoStar workflow works with a flowchart." },
  ],
  discover: [{ text: "I can explain what the drone survey adds, with a quick sketch.", prompt: "Explain what this Discover step does, with a sketch." }],
  explore: [{ text: "Want me to point out the main parts of this layout?", prompt: "Point out the main parts of this layout and explain them." }],
  analyze: [{ text: "Want a plain-words comparison of the concepts on screen?", prompt: "Compare the concepts on screen in plain words." }],
  deliver: [{ text: "I can write a short handoff of this concept for your team.", prompt: "Write a shift handoff for this concept from what is on screen." }],
  design: [
    { text: "Want to see the facility's evacuation plan on the floor plan?", prompt: "Draw the evacuation plan and explain it." },
    { text: "I can walk you through protecting this facility.", prompt: "Walk me through setting up protection here step by step." },
  ],
};

const GENERAL: Nudge = { text: "Hi, I'm Geo. Ask me about anything on screen, or say “Hey Geo”.", prompt: "What can you do for me here?" };
const INCIDENT: Nudge = { text: "There's an active incident (simulated). Want me to draw the evacuation plan?", prompt: "Draw the evacuation plan for the current incident and explain it step by step." };

export function pickNudge(role: string | null, incident: boolean, seed: number): Nudge {
  if (incident) return INCIDENT;
  const list = (role && BY_ROLE[role]) || [GENERAL];
  return list[Math.abs(Math.floor(seed)) % list.length];
}

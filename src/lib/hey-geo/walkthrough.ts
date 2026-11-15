/**
 * Walkthrough state machine for Hey Geo.
 * ─────────────────────────────────────────
 *   idle → observing → locating → guiding → waiting_for_user → verifying
 *        → (guiding … next step) | completed | failed
 *
 * Every transition is explicit and driven by a real event: an agent reply,
 * a user click/view change observed in the DOM, or the user pressing
 * "I did it". Nothing advances on a timer, and a step is only marked done
 * after the agent has looked at the new screen state.
 */

import type { Expect } from "./schema";

export type WalkStatus =
  | "idle"
  | "observing"
  | "locating"
  | "guiding"
  | "waiting_for_user"
  | "verifying"
  | "completed"
  | "failed";

export type WalkState = {
  status: WalkStatus;
  goal: string | null;
  step: number;
  expect: Expect | null;
  /** What we saw the user do — sent to the agent on verification. */
  observation: string | null;
  error: string | null;
};

export type WalkEvent =
  | { type: "START"; goal: string }
  | { type: "CONTEXT_COLLECTED" }
  | { type: "AGENT_REPLIED"; goal: string; step: number; status: "continue" | "completed" | "failed"; expect?: Expect }
  | { type: "GUIDANCE_SHOWN" }
  | { type: "USER_ACTED"; observation: string }
  | { type: "ERROR"; message: string }
  | { type: "CANCEL" };

export const initialWalk: WalkState = {
  status: "idle",
  goal: null,
  step: 0,
  expect: null,
  observation: null,
  error: null,
};

/** Allowed transitions — anything else is ignored (and reported by `canTransition`). */
const ALLOWED: Record<WalkStatus, WalkEvent["type"][]> = {
  idle: ["START"],
  observing: ["CONTEXT_COLLECTED", "ERROR", "CANCEL"],
  locating: ["AGENT_REPLIED", "ERROR", "CANCEL"],
  guiding: ["GUIDANCE_SHOWN", "ERROR", "CANCEL"],
  waiting_for_user: ["USER_ACTED", "CANCEL"],
  verifying: ["CONTEXT_COLLECTED", "AGENT_REPLIED", "ERROR", "CANCEL"],
  completed: ["START", "CANCEL"],
  failed: ["START", "CANCEL"],
};

export function canTransition(state: WalkState, ev: WalkEvent): boolean {
  return ALLOWED[state.status].includes(ev.type);
}

export function walkReducer(state: WalkState, ev: WalkEvent): WalkState {
  if (!canTransition(state, ev)) return state;
  switch (ev.type) {
    case "START":
      return { ...initialWalk, status: "observing", goal: ev.goal, step: 1 };
    case "CONTEXT_COLLECTED":
      // First observation → locating the first target; after a user action →
      // still verifying until the agent has judged the new screen.
      return state.status === "observing" ? { ...state, status: "locating" } : state;
    case "AGENT_REPLIED":
      if (ev.status === "completed") {
        return { ...state, status: "completed", goal: ev.goal || state.goal, step: ev.step, expect: null };
      }
      if (ev.status === "failed") {
        return { ...state, status: "failed", step: ev.step, expect: null, error: "Hey Geo couldn't find a way forward." };
      }
      return {
        ...state,
        status: "guiding",
        goal: ev.goal || state.goal,
        step: ev.step,
        expect: ev.expect ?? { kind: "user_confirms" },
        observation: null,
      };
    case "GUIDANCE_SHOWN":
      return { ...state, status: "waiting_for_user" };
    case "USER_ACTED":
      return { ...state, status: "verifying", observation: ev.observation };
    case "ERROR":
      return { ...state, status: "failed", error: ev.message, expect: null };
    case "CANCEL":
      return initialWalk;
  }
}

export const isWalkActive = (s: WalkState) =>
  s.status !== "idle" && s.status !== "completed" && s.status !== "failed";

/** Heuristic: does this message ask to be walked through a task? */
export function looksLikeWalkthroughRequest(text: string): boolean {
  // "Where do I go?" and "my route step by step" are about getting out, not about the dashboard.
  if (looksLikeEvacuationRequest(text)) return false;
  return /\b(how (do|can|would) i|show me how|walk me through|guide me|help me (to )?(find|use|make|create|file|add|start|open|approve|dispatch)|where (is|can i find)|teach me (how )?to use)\b/i.test(
    text
  );
}

/** Heuristic: is this about getting out of the building (draw the plan, not a UI tour)? */
export function looksLikeEvacuationRequest(text: string): boolean {
  return /\b(evacuat\w*|get out|way out|exits?|escape|my route|safe route|where (do|should) (i|we) go|fire|refuge|leave the building|stairs|elevator)\b/i.test(text);
}

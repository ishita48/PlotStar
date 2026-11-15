/**
 * Authorisation for agent-proposed browser actions.
 * ─────────────────────────────────────────────────
 * The agent can only PROPOSE scroll / click / focus on an element from the
 * snapshot. Hey Geo shows the proposal; the user decides. This module decides
 * whether a proposal may be offered at all and how loud the confirmation is.
 */

import type { BrowserAction, ElementInfo } from "./schema";

const DESTRUCTIVE =
  /\b(delete|remove|erase|archive|discard|sign ?out|log ?out|leave|kick|revoke|reset|clear all|pay|purchase|buy|subscribe|submit|send|share|invite|publish|transfer|approve|dispatch|acknowledge|check ?in|escalate|on scene|resolve|mark resolved|complete|start|simulate|emergency|call|contact|hand ?off|arrival|prepare access|i need help|i'?m safe|announce|generate|deploy|trigger|apply|save|undo|decide|record|rotate|use site|use this site|accept|report|tap again)\b/i;

const CLICKABLE_ROLES = new Set(["button", "link", "tab", "menuitem", "checkbox", "radio", "switch", "option"]);
const FOCUSABLE_ROLES = new Set(["textbox", "searchbox", "combobox", "input", "textarea"]);

export type ActionDecision =
  | { allowed: false; reason: string }
  | { allowed: true; confirm: "none" | "simple" | "strong"; summary: string };

export function authorizeAction(action: BrowserAction, el: ElementInfo | undefined): ActionDecision {
  if (!el) return { allowed: false, reason: "That element isn't on screen anymore." };
  const label = (el.text || el.hint || el.role).slice(0, 60);
  const risky = DESTRUCTIVE.test(`${el.text} ${el.hint ?? ""}`);

  switch (action.type) {
    case "scroll_to":
      return { allowed: true, confirm: "none", summary: `Scroll to “${label}”` };
    case "focus":
      if (!FOCUSABLE_ROLES.has(el.role)) return { allowed: false, reason: "Only text fields can be focused." };
      return { allowed: true, confirm: "simple", summary: `Put the cursor in “${label}”` };
    case "click":
      if (!CLICKABLE_ROLES.has(el.role)) return { allowed: false, reason: "That isn't a button or link." };
      if (el.state?.includes("disabled")) return { allowed: false, reason: "That control is disabled." };
      return risky
        ? { allowed: true, confirm: "strong", summary: `Click “${label}”, this may change or delete something` }
        : { allowed: true, confirm: "simple", summary: `Click “${label}”` };
    default:
      return { allowed: false, reason: "Unsupported action." };
  }
}

/**
 * Did the user explicitly ask Hey Geo to do it for them ("click it for me",
 * "open my quiz", "take me to settings")? Only then may a non-destructive
 * click/focus run without a confirmation tap — like Hey Geo's "click around
 * for me". Destructive controls always need confirmation regardless.
 */
export function explicitlyAskedToAct(message: string): boolean {
  return /\b(click (it|that|this|on it|there)?\s*(for me)?|do it( for me)?|for me please|take me( to| there)?|go to|go there|open (it|that|the|my|up)|navigate|switch to|bring me|press (it|that|the))\b/i.test(
    message
  );
}

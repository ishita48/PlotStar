/**
 * Hey Geo "do it for me" — carrying out one step of a run in the page (browser only).
 * ─────────────────────────────────────────────────────────────────────────
 * The model picks ONE step at a time (schema.ts ActSchema) from the elements
 * we sent it. This module decides whether the step needs the user's OK
 * (anything that changes something for real), refuses what Hey Geo must never
 * do (typing into password / card fields), and performs the step with real
 * DOM events so React/Vue/Angular sites notice the change.
 */

import type { Act, ElementInfo } from "./schema";

/** Words on a control that mean "this changes something for real". */
const RISKY_LABEL =
  /\b(submit|send|post|publish|reply|comment|share|invite|pay|purchase|buy|checkout|check out|place order|order now|subscribe|donate|delete|remove|erase|discard|archive|withdraw|transfer|sign ?out|log ?out|sign ?in|log ?in|register|book|reserve|confirm|accept|agree|save changes|apply|approve|dispatch|acknowledge|check ?in|escalate|on scene|resolve|mark resolved|complete|start|reset|simulate|emergency|call|contact|hand ?off|arrival|prepare access|i need help|i'?m safe|announce|turn on alerts|generate|deploy|trigger|undo|decide|record|rotate|use site|use this site|report|tap again)\b/i;

export type ActCheck =
  | { ok: true; confirm: false }
  | { ok: true; confirm: true; why: string }
  | { ok: false; why: string };

/** May Hey Geo run this step, and does the user have to approve it first? */
export function checkAct(act: Act, info: ElementInfo | undefined, el: Element | undefined): ActCheck {
  if (act.type === "type") {
    if (!el) return { ok: false, why: "That field isn't on the page anymore." };
    const input = el as HTMLInputElement;
    const ac = el.getAttribute("autocomplete") || "";
    if (input.type === "password" || /^cc-|one-time-code|current-password|new-password/.test(ac)) {
      return { ok: false, why: "I don't type passwords, card numbers or codes, please fill that one in yourself." };
    }
  }
  if (act.type === "navigate" || act.type === "new_tab") {
    if (!act.url || !(/^https?:\/\//i.test(act.url) || /^\/[a-z]/.test(act.url))) return { ok: false, why: "I can only open web pages." };
  }
  const label = `${info?.text ?? ""} ${info?.hint ?? ""} ${el?.getAttribute?.("value") ?? ""}`;
  // A <button> is type="submit" by default, but it only submits inside a form
  // (and searching isn't a submission worth asking about).
  const form = (el as HTMLButtonElement | undefined)?.form ?? null;
  const submitButton =
    !!el && !!form && ((el as HTMLButtonElement).type === "submit" || el.getAttribute("type") === "submit") && !isSearchField(form);
  const pressEnterInForm = (act.type === "press" && act.key === "Enter") || (act.type === "type" && act.submit);
  const formLike = pressEnterInForm && !!el?.closest("form") && !isSearchField(el);
  if (act.risky) return { ok: true, confirm: true, why: act.reason || "This changes something" };
  if ((act.type === "click" && (RISKY_LABEL.test(label) || submitButton)) || formLike) {
    return { ok: true, confirm: true, why: `${act.type === "click" ? `Click “${(info?.text || "this").slice(0, 50)}”` : "Submit this form"}, this may send or change something` };
  }
  return { ok: true, confirm: false };
}

function isSearchField(el: Element | undefined): boolean {
  if (!el) return false;
  const t = `${el.getAttribute("type") ?? ""} ${el.getAttribute("role") ?? ""} ${el.getAttribute("name") ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("placeholder") ?? ""}`;
  return /search|\bq\b|find|filter/i.test(t) || !!el.closest('[role="search"], form[action*="search"]');
}

/** A one-line description of a step for the step list and the model's LOG. */
export function describeAct(act: Act, info?: ElementInfo): string {
  const what = info ? `“${info.text.slice(0, 50)}”` : "";
  switch (act.type) {
    case "click":
      return `Click ${what}`;
    case "type":
      return `Type “${(act.text || "").slice(0, 40)}”${what ? ` into ${what}` : ""}${act.submit ? " and press Enter" : ""}`;
    case "select":
      return `Choose “${act.text || ""}” in ${what}`;
    case "check":
      return `${act.checked === false ? "Untick" : "Tick"} ${what}`;
    case "press":
      return `Press ${act.key || "Enter"}`;
    case "scroll":
      return `Scroll ${act.direction || "down"}`;
    case "scroll_to":
      return `Scroll to ${what}`;
    case "navigate":
      return `Open ${shortUrl(act.url)}`;
    case "new_tab":
      return `Open ${shortUrl(act.url)} in a new tab`;
    case "wait":
      return "Wait for the page";
    case "ask":
      return "Ask you something";
    case "done":
      return "Done";
  }
}

const shortUrl = (u?: string) => {
  try {
    const x = new URL(u || "");
    return x.host.replace(/^www\./, "") + (x.pathname.length > 1 ? x.pathname.slice(0, 30) : "");
  } catch {
    return u || "the page";
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Click like a person: scroll into view, pointer/mouse events, then click(). */
export async function realClick(el: HTMLElement | SVGElement) {
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
  await sleep(60);
  const r = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
  const P = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
  el.dispatchEvent(new P("pointerdown", at));
  el.dispatchEvent(new MouseEvent("mousedown", at));
  (el as HTMLElement).focus?.({ preventScroll: true });
  el.dispatchEvent(new P("pointerup", at));
  el.dispatchEvent(new MouseEvent("mouseup", at));
  // SVG plan objects have no click(): send the event they listen for.
  if (typeof (el as HTMLElement).click === "function") (el as HTMLElement).click();
  else el.dispatchEvent(new MouseEvent("click", at));
}

/**
 * Set a field's value so frameworks see it: React/Vue track the native value
 * setter, so assign through the prototype's setter, then fire input/change.
 */
export function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  el.focus();
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function pressKey(el: Element, key: string) {
  const code = key === "Space" ? "Space" : key;
  const k = key === "Space" ? " " : key;
  const init = { key: k, code, bubbles: true, cancelable: true, composed: true, keyCode: k === "Enter" ? 13 : 0, which: k === "Enter" ? 13 : 0 };
  const down = el.dispatchEvent(new KeyboardEvent("keydown", init));
  el.dispatchEvent(new KeyboardEvent("keypress", init));
  el.dispatchEvent(new KeyboardEvent("keyup", init));
  // Plain forms only submit on a real Enter; do it ourselves if nothing handled it.
  if (down && k === "Enter" && (el instanceof HTMLInputElement) && el.form) {
    el.form.requestSubmit?.();
  }
}

export type ActResult = { ok: boolean; detail: string };

/**
 * Perform one in-page step on `el` (navigation and tabs are done by the
 * extension). Returns what happened, for the step list and the model's LOG.
 */
export async function performAct(act: Act, el: Element | undefined): Promise<ActResult> {
  const h = el as HTMLElement | undefined;
  try {
    switch (act.type) {
      case "click": {
        if (!h) return { ok: false, detail: "element not found" };
        if ((h as HTMLButtonElement).disabled || h.getAttribute("aria-disabled") === "true") return { ok: false, detail: "it's disabled" };
        await realClick(h);
        return { ok: true, detail: "clicked" };
      }
      case "type": {
        if (!h) return { ok: false, detail: "field not found" };
        const text = act.text ?? "";
        if (h instanceof HTMLInputElement || h instanceof HTMLTextAreaElement) {
          h.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
          setFieldValue(h, text);
        } else if (h.isContentEditable) {
          h.focus();
          document.execCommand("selectAll");
          if (!document.execCommand("insertText", false, text)) h.textContent = text;
          h.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          return { ok: false, detail: "that isn't a text field" };
        }
        if (act.submit) {
          await sleep(80);
          pressKey(h, "Enter");
          return { ok: true, detail: "typed and pressed Enter" };
        }
        return { ok: true, detail: "typed" };
      }
      case "select": {
        if (!(h instanceof HTMLSelectElement)) {
          // Custom dropdowns: open it; the next step picks the option.
          if (h) {
            await realClick(h);
            return { ok: true, detail: "opened the dropdown" };
          }
          return { ok: false, detail: "dropdown not found" };
        }
        const want = (act.text || "").trim().toLowerCase();
        const opt =
          Array.from(h.options).find((o) => o.text.trim().toLowerCase() === want || o.value.toLowerCase() === want) ||
          Array.from(h.options).find((o) => o.text.trim().toLowerCase().includes(want));
        if (!opt) return { ok: false, detail: `no option “${act.text}”` };
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
        if (setter) setter.call(h, opt.value);
        else h.value = opt.value;
        h.dispatchEvent(new Event("input", { bubbles: true }));
        h.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, detail: `chose “${opt.text.trim()}”` };
      }
      case "check": {
        if (!h) return { ok: false, detail: "checkbox not found" };
        const box = h as HTMLInputElement;
        const want = act.checked !== false;
        const isOn = box.checked ?? h.getAttribute("aria-checked") === "true";
        if (isOn === want) return { ok: true, detail: want ? "already ticked" : "already unticked" };
        await realClick(h);
        return { ok: true, detail: want ? "ticked" : "unticked" };
      }
      case "press": {
        const target = (h || document.activeElement || document.body) as Element;
        pressKey(target, act.key || "Enter");
        return { ok: true, detail: `pressed ${act.key || "Enter"}` };
      }
      case "scroll_to": {
        if (!h) return { ok: false, detail: "element not found" };
        h.scrollIntoView({ behavior: "smooth", block: "center" });
        return { ok: true, detail: "scrolled to it" };
      }
      default:
        return { ok: false, detail: "not an in-page step" };
    }
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e).slice(0, 80) };
  }
}

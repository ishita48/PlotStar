/**
 * Screen-context collection (browser only).
 * ─────────────────────────────────────────
 * Builds a compact, structured snapshot of what is visible in the viewport:
 * interactive controls, headings, text blocks and media, each with an id the
 * agent can target and a viewport rect. Ids map back to live Elements via the
 * returned registry, so annotations follow elements through scroll/resize.
 *
 * Privacy: input VALUES are never collected (only placeholder / label), and
 * anything inside Hey Geo's own UI ([data-geo-ui]) or the other assistants' UI
 * ([data-guide-ui]) is excluded.
 */

import type { ElementInfo, ScreenContext } from "./schema";

export type ElementRegistry = Map<string, Element>;

const INTERACTIVE =
  'button, a[href], [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="option"], input:not([type="hidden"]), textarea, select, [contenteditable="true"], [data-tour], [data-geo], [data-code], .st-rail li';
const CONTROL =
  'button, a[href], [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="option"]';
const STRUCTURE = "h1, h2, h3, h4, label, p, li, td, th, figcaption, pre, code, blockquote, dt, dd";
const MEDIA = "video, img[alt], iframe, canvas, svg[aria-label]";

const MAX_ELEMENTS = 160;
const MAX_VISIBLE_TEXT = 5500;

function roleOf(el: Element): string {
  // GeoStar Studio's workflow rail: list items that act as step buttons.
  if (el.matches(".st-rail li")) return "tab";
  // Plan objects (DH-01, GEN-02…) in the 2D plan are clickable SVG groups.
  if (el.hasAttribute("data-code")) return "button";
  // Clickable list rows (the CoStar site list): React handlers leave no attribute, the pointer cursor tells.
  if (el.tagName === "LI" && getComputedStyle(el).cursor === "pointer") return "button";
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.slice(0, 24);
  const tag = el.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "textarea") return "textarea";
  if (tag === "select") return "combobox";
  if (tag === "input") {
    const t = (el as HTMLInputElement).type;
    if (t === "checkbox" || t === "radio") return t;
    if (t === "button" || t === "submit") return "button";
    if (t === "search") return "searchbox";
    return "textbox";
  }
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "video") return "video";
  if (tag === "img" || tag === "svg" || tag === "canvas") return "image";
  if (tag === "iframe") return "embed";
  if (el.hasAttribute("data-tour") || el.hasAttribute("data-geo")) return "region";
  return "text";
}

/** The visible label a form field is known by: aria, <label for>, wrapping <label>, aria-labelledby. */
function fieldLabel(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return aria;
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const t = by
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent || "")
      .join(" ")
      .trim();
    if (t) return t;
  }
  const id = el.getAttribute("id");
  if (id) {
    const lab = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (lab?.textContent?.trim()) return lab.textContent.trim();
  }
  const wrap = el.closest("label");
  if (wrap?.textContent?.trim()) return wrap.textContent.trim();
  return "";
}

function labelOf(el: Element, role: string): string {
  const aria = el.getAttribute("aria-label") || el.getAttribute("title");
  if (role === "textbox" || role === "textarea" || role === "searchbox") {
    const ph = (el as HTMLInputElement).placeholder;
    const name = el.getAttribute("name");
    return (fieldLabel(el) || aria || ph || name || "text field").replace(/\s+/g, " ").trim();
  }
  if (role === "combobox" && el.tagName === "SELECT") {
    const opts = Array.from((el as HTMLSelectElement).options)
      .map((o) => o.text.trim())
      .filter(Boolean);
    const label = fieldLabel(el) || aria || el.getAttribute("name") || "dropdown";
    return `${label} (options: ${opts.slice(0, 12).join(" | ")}${opts.length > 12 ? " | …" : ""})`.replace(/\s+/g, " ");
  }
  if (role === "checkbox" || role === "radio") {
    return (fieldLabel(el) || aria || el.getAttribute("name") || role).replace(/\s+/g, " ").trim();
  }
  if (role === "image") return (el.getAttribute("alt") || aria || "image").trim();
  if (role === "embed") return (el.getAttribute("title") || aria || "embedded content").trim();
  if (role === "video") return (aria || "video player").trim();
  const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
  const clean = text.replace(/\s+/g, " ").trim();
  // Map markers and icon buttons: a number or letter plus the title says what it is ("3 · Site name · Good fit").
  if (aria && clean && clean.length <= 3 && aria !== clean) return `${clean} · ${aria}`.trim();
  return (aria && clean.length > 60 ? aria : clean || aria || "").trim();
}

/**
 * For form fields: the input type ("type=email"). During a do-it-for-me run
 * (withValues) also what's in it now, so Hey Geo can check its own typing.
 * Values are never read otherwise, and passwords / card fields never.
 */
function fieldHint(el: Element, withValues: boolean): string | undefined {
  const tag = el.tagName;
  if (tag === "SELECT") {
    if (!withValues) return undefined;
    const sel = el as HTMLSelectElement;
    return `selected=“${(sel.options[sel.selectedIndex]?.text || "").trim().slice(0, 40)}”`;
  }
  if (tag !== "INPUT" && tag !== "TEXTAREA" && !(el as HTMLElement).isContentEditable) return undefined;
  const type = tag === "INPUT" ? (el as HTMLInputElement).type || "text" : tag === "TEXTAREA" ? "textarea" : "editable";
  if (["checkbox", "radio", "button", "submit", "hidden"].includes(type)) return undefined;
  const ac = el.getAttribute("autocomplete") || "";
  if (type === "password" || /^cc-|one-time-code/.test(ac)) return `type=${type === "password" ? "password" : "secret"}`;
  if (!withValues) return `type=${type}`;
  const raw = tag === "INPUT" || tag === "TEXTAREA" ? (el as HTMLInputElement).value : (el as HTMLElement).innerText;
  const v = (raw || "").replace(/\s+/g, " ").trim();
  return `type=${type}${v ? ` value=“${v.slice(0, 30)}${v.length > 30 ? "…" : ""}”` : " empty"}`.slice(0, 60);
}

function stateOf(el: Element): string | undefined {
  const s: string[] = [];
  if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true" || el.classList.contains("locked")) s.push("disabled");
  if (el.matches(".st-rail li.on")) s.push("selected");
  if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current")) s.push("selected");
  if (el.getAttribute("aria-expanded") === "true") s.push("expanded");
  if ((el as HTMLInputElement).checked) s.push("checked");
  if (el === document.activeElement) s.push("focused");
  const tag = el.tagName.toLowerCase();
  if ((tag === "input" || tag === "textarea") && (el as HTMLInputElement).value) s.push("has text");
  return s.length ? s.join(",") : undefined;
}

function isVisible(el: Element, r: DOMRect, vw: number, vh: number): boolean {
  if (r.width < 2 || r.height < 2) return false;
  if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return false;
  const anyEl = el as any;
  if (typeof anyEl.checkVisibility === "function") {
    return anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
}

/** True if `el` is covered by an ancestor already collected with the same text (avoid duplicates). */
function isRedundant(el: Element, text: string, kept: Set<Element>): boolean {
  let p = el.parentElement;
  for (let i = 0; p && i < 4; i++, p = p.parentElement) {
    if (kept.has(p) && ((p as HTMLElement).innerText || "").replace(/\s+/g, " ").trim() === text) return true;
  }
  return false;
}

export function collectScreenContext(opts: {
  root?: ParentNode;
  app?: ScreenContext["app"];
  /** Include what's typed in form fields (do-it-for-me runs only). */
  withValues?: boolean;
  /** What the person pointed at: it is always included, and named as context.pointed. */
  pointed?: Element | null;
}): { context: ScreenContext; registry: ElementRegistry } {
  const root = opts.root ?? document;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const registry: ElementRegistry = new Map();
  const elements: ElementInfo[] = [];
  const kept = new Set<Element>();
  const textBits: string[] = [];
  let textLen = 0;
  let n = 0;

  const consider = (el: Element, kind: "interactive" | "structure" | "media") => {
    if (elements.length >= MAX_ELEMENTS || kept.has(el)) return;
    if (el.closest("[data-geo-ui], [data-guide-ui]")) return;
    const r = el.getBoundingClientRect();
    if (!isVisible(el, r, vw, vh)) return;
    const role = roleOf(el);
    const text = labelOf(el, role).slice(0, 160);
    if (kind === "structure") {
      if (text.length < 3) return;
      // Skip text that lives inside a control we already have (but not inside
      // big [data-tour] regions — their contents are what we want to read).
      const control = el.closest(CONTROL);
      if (control && kept.has(control)) return;
      if (isRedundant(el, text, kept)) return;
    }
    if (!text && kind === "interactive" && role !== "textbox" && role !== "textarea") {
      // Icon-only button without a label — still useful to point at.
      if (!el.querySelector("svg")) return;
    }
    const id = `e${++n}`;
    registry.set(id, el);
    kept.add(el);
    const hint = el.getAttribute("data-geo") || el.getAttribute("data-tour") || (el.getAttribute("data-code") ? `code=${el.getAttribute("data-code")}` : null) || fieldHint(el, !!opts.withValues);
    elements.push({
      id,
      role,
      text: text || "(icon)",
      ...(hint ? { hint: hint.slice(0, 60) } : {}),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      ...(stateOf(el) ? { state: stateOf(el) } : {}),
    });
    if (kind === "structure" && textLen < MAX_VISIBLE_TEXT) {
      const bit = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 600);
      if (bit) {
        textBits.push(bit);
        textLen += bit.length + 1;
      }
    }
  };

  root.querySelectorAll(INTERACTIVE).forEach((el) => consider(el, "interactive"));
  root.querySelectorAll("li").forEach((el) => {
    if (!el.matches(".st-rail li") && getComputedStyle(el).cursor === "pointer") consider(el, "interactive");
  });
  root.querySelectorAll(MEDIA).forEach((el) => consider(el, "media"));
  root.querySelectorAll(STRUCTURE).forEach((el) => consider(el, "structure"));

  // Page outline beyond the viewport: headings Hey Geo can scroll to.
  const vis = new Set(elements.map((e) => registry.get(e.id)));
  let outline = 0;
  root.querySelectorAll("h1, h2, h3, h4").forEach((el) => {
    if (outline >= 25 || elements.length >= MAX_ELEMENTS || vis.has(el)) return;
    if (el.closest("[data-geo-ui]")) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const onScreen = r.bottom > 0 && r.top < vh;
    if (onScreen) return;
    const anyEl = el as any;
    if (typeof anyEl.checkVisibility === "function" && !anyEl.checkVisibility({ checkVisibilityCSS: true })) return;
    const text = labelOf(el, "heading").slice(0, 120);
    if (text.length < 2) return;
    const id = `e${++n}`;
    registry.set(id, el);
    outline++;
    elements.push({
      id,
      role: "heading",
      text,
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      state: r.top >= vh ? "offscreen below" : "offscreen above",
    });
  });

  // Point and ask: the pointed element (or the scanned element that contains it) becomes the subject.
  let pointedId: string | undefined;
  const p = opts.pointed;
  if (p && p.isConnected && !p.closest("[data-geo-ui], [data-guide-ui]")) {
    for (let cur: Element | null = p; cur && !pointedId; cur = cur.parentElement) {
      for (const [id, el] of registry) if (el === cur) pointedId = id;
      if (cur === document.body) break;
    }
    if (!pointedId) {
      const target = p.closest("button, a, li, tr, td, th, [data-code], h1, h2, h3, h4, p, label, dd, dt, section, article") ?? p;
      const r = target.getBoundingClientRect();
      const role = roleOf(target);
      const id = `e${++n}`;
      registry.set(id, target);
      elements.push({
        id,
        role,
        text: (labelOf(target, role) || (target as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 160) || "(unlabelled)",
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        state: "pointed at",
      });
      pointedId = id;
    }
  }

  // Reading order (top-to-bottom, left-to-right) helps the model.
  elements.sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);

  return {
    registry,
    context: {
      url: location.pathname + location.search,
      title: document.title.slice(0, 200),
      viewport: { w: vw, h: vh, dpr: window.devicePixelRatio || 1, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
      elements,
      visibleText: textBits.join("\n").slice(0, MAX_VISIBLE_TEXT),
      ...(readSelection() ? { selection: readSelection() } : {}),
      ...(pointedId ? { pointed: pointedId } : {}),
      ...(opts.app ? { app: opts.app } : {}),
    },
  };
}

/** Human-readable description of an element (for walkthrough observations). */
export function describeElement(el: Element): string {
  const role = roleOf(el);
  return `${role} “${labelOf(el, role).slice(0, 60) || "(unlabelled)"}”`;
}

/** The user's highlighted text (ignoring selections inside Hey Geo's own UI). */
export function readSelection(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed) return undefined;
  const node = sel.anchorNode;
  const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
  if (el?.closest?.("[data-geo-ui]")) return undefined;
  const text = sel.toString().replace(/\s+/g, " ").trim();
  return text.length >= 2 ? text.slice(0, 2000) : undefined;
}

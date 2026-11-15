/**
 * Hey Geo — annotation engine (browser, framework-free).
 * ─────────────────────────────────────────────────────────
 * Draws arrows, circles, boxes, underlines, highlights, tooltips and the
 * flying Hey Geo cursor on a transparent overlay above the page.
 *
 *  - The overlay is `pointer-events: none`, so the page stays fully usable.
 *  - Targets are resolved every animation frame (getBoundingClientRect for
 *    elements; page coordinates for screenshot regions), so drawings stay
 *    glued to their target through scrolling, resizing and layout shifts.
 *  - Strokes animate in with `pathLength=1` dash offsets (no per-frame
 *    length measurement), and respect prefers-reduced-motion.
 *  - Annotations expire on their own; `clear()` removes everything.
 *
 * Kept free of React (ported from HAVEN's Hey Haven, itself built on StudyO's Buds).
 */

import type { AnnotationType } from "./schema";
import {
  arcControl,
  arrowPaths,
  arrowStart,
  bezierPoint,
  center,
  easeInOutCubic,
  edgePoint,
  ellipsePath,
  inflate,
  isOnScreen,
  roundedRectPath,
  tooltipPosition,
  underlinePath,
  type Pt,
  type Rect,
} from "./geometry";

export type DrawItem = {
  type: AnnotationType;
  /** Returns the target's current viewport rect, or null if it's gone. */
  resolve: () => Rect | null;
  color?: string;
  label?: string;
  durationMs?: number;
};

type Live = {
  id: number;
  item: DrawItem;
  color: string;
  group: SVGGElement;
  paths: SVGPathElement[];
  tip?: HTMLDivElement;
  /** Arrow start, stored relative to the target centre so it travels with it. */
  arrowOffset?: Pt;
  expiresAt: number;
  removing: boolean;
};

const SVG_NS = "http://www.w3.org/2000/svg";
const STYLE_ID = "hg-engine-style";
const DEFAULT_COLOR = "#1F4A36";
const DEFAULT_MS = 7000;

const CSS = `
.hg-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483000;}
.hg-layer svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.hg-stroke{fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1;animation:hg-draw .7s cubic-bezier(.65,0,.35,1) forwards}
.hg-fill{animation:hg-fade .35s ease-out forwards;opacity:0}
.hg-pulse{animation:hg-fade .35s ease-out forwards,hg-pulse 1.6s ease-in-out .35s infinite}
.hg-g{transition:opacity .35s ease}
.hg-g.hg-out{opacity:0}
.hg-tip{position:fixed;max-width:260px;padding:6px 10px;border-radius:9px;font:500 12px/1.35 var(--hg-sans,ui-sans-serif),ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;box-shadow:0 8px 24px -6px rgba(16,20,17,.4);pointer-events:none;opacity:0;transform:translateY(4px);transition:opacity .25s ease,transform .25s ease}
.hg-tip.hg-in{opacity:1;transform:none}
.hg-cursor{position:fixed;left:0;top:0;width:30px;height:30px;pointer-events:none;z-index:2147483001;opacity:0;transition:opacity .2s ease;will-change:transform}
.hg-cursor.hg-in{opacity:1}
.hg-cursor .hg-bob{animation:hg-bob 1.4s ease-in-out infinite}
.hg-cursor::after{content:"";position:absolute;left:-7px;top:-7px;width:20px;height:20px;border-radius:50%;border:2px solid transparent;opacity:0;transition:opacity .2s ease}
.hg-cursor[data-mood="listening"]::after{opacity:1;border-color:#6fa24e;animation:hg-ping 1.1s ease-out infinite}
.hg-cursor[data-mood="thinking"]::after{opacity:1;border-color:#6fa24e;border-top-color:transparent;animation:hg-spin .8s linear infinite}
.hg-cursor[data-mood="speaking"]::after{opacity:1;border-color:#1f4a36;animation:hg-pulse 1s ease-in-out infinite}
.hg-cursor[data-mood="drawing"]::after{opacity:1;border-color:#6fa24e}
.hg-say{position:fixed;left:0;top:0;max-width:280px;padding:8px 12px;border-radius:4px 12px 12px 12px;pointer-events:none;z-index:2147483001;
  background:#101411;color:#f3f8ea;font:500 12.5px/1.45 var(--hg-sans,ui-sans-serif),ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  box-shadow:0 10px 28px -8px rgba(16,20,17,.5);opacity:0;transition:opacity .2s ease}
.hg-say::before{content:"";display:inline-block;width:6px;height:6px;margin:0 7px 1px 0;border-radius:50%;background:#c9ec7a}
.hg-say.hg-in{opacity:1}
@keyframes hg-ping{0%{transform:scale(.7);opacity:1}100%{transform:scale(1.6);opacity:0}}
@keyframes hg-spin{to{transform:rotate(360deg)}}
@keyframes hg-draw{to{stroke-dashoffset:0}}
@keyframes hg-fade{to{opacity:1}}
@keyframes hg-pulse{0%,100%{opacity:1}50%{opacity:.55}}
@keyframes hg-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
@media (prefers-reduced-motion: reduce){.hg-stroke{animation:none;stroke-dashoffset:0}.hg-fill,.hg-pulse{animation:none;opacity:1}.hg-cursor .hg-bob{animation:none}}
.hg-reduced .hg-stroke{animation:none;stroke-dashoffset:0}
.hg-reduced .hg-fill,.hg-reduced .hg-pulse{animation:none;opacity:1}
`;

/** Hey Geo's cursor: a small GeoStar-green arrow, like the macOS companion. */
const CURSOR_SVG = `<div class="hg-bob"><svg width="30" height="30" viewBox="0 0 34 34" xmlns="${SVG_NS}">
<defs><linearGradient id="hg-cg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6FA24E"/><stop offset="1" stop-color="#1F4A36"/></linearGradient></defs>
<path d="M4 3 L29 15 L17.5 18 L12.5 30 Z" fill="url(#hg-cg)" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
</svg></div>`;

export class AnnotationEngine {
  private layer: HTMLDivElement | null = null;
  private svg: SVGSVGElement | null = null;
  private cursor: HTMLDivElement | null = null;
  private cursorTip: HTMLDivElement | null = null;
  private live: Live[] = [];
  private seq = 0;
  private raf = 0;
  private origin: Pt = { x: 0, y: 0 };
  private cursorTarget: { resolve: () => Rect | null; label?: string; color: string; until: number } | null = null;
  private cursorPos: Pt | null = null;
  /** Companion mode: the cursor rides next to the user's mouse when idle. */
  private following = false;
  private mouse: Pt | null = null;
  private pen: Pt | null = null;
  private sayEl: HTMLDivElement | null = null;
  private onMouse = (e: PointerEvent) => {
    this.mouse = { x: e.clientX, y: e.clientY };
    if (this.following) this.kick();
  };
  private flight: { from: Pt; ctrl: Pt; start: number; ms: number } | null = null;
  private reduced: () => boolean;
  private onChange?: (count: number) => void;

  private host: () => HTMLElement;

  constructor(opts: { reducedMotion?: () => boolean; onChange?: (count: number) => void; host?: () => HTMLElement | null } = {}) {
    this.host = () => opts.host?.() ?? document.body;
    this.reduced =
      opts.reducedMotion ??
      (() =>
        typeof matchMedia !== "undefined" &&
        (matchMedia("(prefers-reduced-motion: reduce)").matches ||
          document.documentElement.getAttribute("data-reduced-motion") === "true"));
    this.onChange = opts.onChange;
  }

  mount() {
    if (this.layer || typeof document === "undefined") return;
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    const layer = document.createElement("div");
    layer.className = "hg-layer";
    layer.setAttribute("data-geo-ui", "");
    layer.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS(SVG_NS, "svg");
    layer.appendChild(svg);
    const cursor = document.createElement("div");
    cursor.className = "hg-cursor";
    cursor.setAttribute("data-geo-ui", "");
    cursor.innerHTML = CURSOR_SVG;
    this.host().appendChild(layer);
    this.host().appendChild(cursor);
    this.layer = layer;
    this.svg = svg;
    this.cursor = cursor;
  }

  destroy() {
    window.removeEventListener("pointermove", this.onMouse);
    this.sayEl?.remove();
    this.sayEl = null;
    this.following = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.layer?.remove();
    this.cursor?.remove();
    this.cursorTip?.remove();
    this.layer = this.svg = this.cursor = this.cursorTip = null;
    this.live = [];
  }

  /** Where the cursor takes off from (Hey Geo's floating button). */
  setOrigin(p: Pt) {
    this.origin = p;
  }

  /** Hide all drawings temporarily (e.g. while grabbing a screenshot). */
  setHidden(hidden: boolean) {
    if (this.layer) this.layer.style.visibility = hidden ? "hidden" : "";
    if (this.cursor) this.cursor.style.visibility = hidden ? "hidden" : "";
    if (this.cursorTip) this.cursorTip.style.visibility = hidden ? "hidden" : "";
  }

  /** Turn the follow-the-mouse companion on/off. */
  companion(on: boolean) {
    this.mount();
    if (on === this.following) return;
    this.following = on;
    if (on) {
      window.addEventListener("pointermove", this.onMouse, { passive: true });
      if (!this.cursorPos) this.cursorPos = this.mouse ?? { x: innerWidth - 120, y: innerHeight - 140 };
      this.cursor?.classList.add("hg-in");
      this.kick();
    } else {
      window.removeEventListener("pointermove", this.onMouse);
      if (!this.cursorTarget && !this.pen) this.cursor?.classList.remove("hg-in");
      this.say(null);
      this.setMood("idle");
    }
  }

  /** Ring around the cursor: listening / thinking / speaking / drawing / idle. */
  setMood(mood: "idle" | "listening" | "thinking" | "speaking" | "drawing") {
    if (this.cursor) this.cursor.setAttribute("data-mood", mood);
  }

  /** Speech bubble that travels with the cursor (null hides it). */
  say(text: string | null) {
    if (!text) {
      this.sayEl?.classList.remove("hg-in");
      const el = this.sayEl;
      this.sayEl = null;
      if (el) setTimeout(() => el.remove(), 220);
      return;
    }
    this.mount();
    if (!this.sayEl) {
      const el = document.createElement("div");
      el.className = "hg-say";
      el.setAttribute("data-geo-ui", "");
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      this.host().appendChild(el);
      this.sayEl = el;
      requestAnimationFrame(() => el.classList.add("hg-in"));
    }
    this.sayEl.textContent = text;
    this.kick();
  }

  /** While drawing on the whiteboard, the cursor holds the pen. */
  penTo(p: Pt | null) {
    this.mount();
    this.pen = p;
    if (p) this.cursor?.classList.add("hg-in");
    else if (!this.following && !this.cursorTarget) this.cursor?.classList.remove("hg-in");
    this.kick();
  }

  get isFollowing() {
    return this.following;
  }

  get count() {
    return this.live.filter((l) => !l.removing).length + (this.cursorTarget ? 1 : 0);
  }

  draw(items: DrawItem[]) {
    this.mount();
    if (!this.svg || !this.layer) return;
    this.layer.classList.toggle("hg-reduced", this.reduced());
    const now = performance.now();
    for (const item of items) {
      const color = item.color || DEFAULT_COLOR;
      const ms = item.durationMs ?? DEFAULT_MS;
      if (item.type === "point") {
        this.flyCursor(item, color, now + ms);
        continue;
      }
      const g = document.createElementNS(SVG_NS, "g");
      g.setAttribute("class", "hg-g");
      const paths: SVGPathElement[] = [];
      const mk = (cls: string, attrs: Record<string, string>) => {
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("class", cls);
        p.setAttribute("pathLength", "1");
        for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
        g.appendChild(p);
        paths.push(p);
        return p;
      };
      const glow = `drop-shadow(0 0 6px ${color}66)`;
      switch (item.type) {
        case "circle":
        case "underline":
          mk("hg-stroke", { stroke: color, "stroke-width": "3.5", style: `filter:${glow}` });
          break;
        case "box":
          mk("hg-stroke", { stroke: color, "stroke-width": "3", style: `filter:${glow}` });
          break;
        case "arrow":
          mk("hg-stroke", { stroke: color, "stroke-width": "3.5", style: `filter:${glow}` });
          mk("hg-stroke", { stroke: color, "stroke-width": "3.5", style: `animation-delay:.55s` });
          break;
        case "highlight":
          mk("hg-pulse", { fill: `${color}26`, stroke: color, "stroke-width": "2", style: `filter:${glow}` });
          break;
        case "tooltip":
          break;
      }
      this.svg.appendChild(g);
      let tip: HTMLDivElement | undefined;
      if (item.label || item.type === "tooltip") {
        tip = this.makeTip(item.label || "Here", color);
      }
      const live: Live = { id: ++this.seq, item, color, group: g, paths, tip, expiresAt: now + ms, removing: false };
      if (item.type === "arrow") {
        const r = item.resolve();
        if (r) {
          const s = arrowStart(r, { w: innerWidth, h: innerHeight });
          const c = center(r);
          live.arrowOffset = { x: s.x - c.x, y: s.y - c.y };
        }
      }
      this.live.push(live);
    }
    this.kick();
  }

  clear() {
    for (const l of this.live) this.removeLive(l, true);
    this.live = [];
    this.cursorTarget = null;
    this.flight = null;
    this.cursor?.classList.remove("hg-in");
    this.cursorTip?.remove();
    this.cursorTip = null;
    this.emit();
  }

  // ── internals ─────────────────────────────────────────────────────
  private makeTip(text: string, color: string): HTMLDivElement {
    const tip = document.createElement("div");
    tip.className = "hg-tip";
    tip.setAttribute("data-geo-ui", "");
    tip.style.background = color;
    tip.textContent = text;
    this.host().appendChild(tip);
    requestAnimationFrame(() => tip.classList.add("hg-in"));
    return tip;
  }

  private flyCursor(item: DrawItem, color: string, until: number) {
    if (!this.cursor) return;
    const r = item.resolve();
    if (!r) return;
    const from = this.cursorPos ?? this.origin;
    const to = this.cursorAnchor(r);
    this.cursorTarget = { resolve: item.resolve, label: item.label, color, until };
    this.flight = this.reduced()
      ? null
      : { from, ctrl: arcControl(from, to), start: performance.now(), ms: Math.min(1100, 420 + Math.hypot(to.x - from.x, to.y - from.y) * 0.6) };
    this.cursorPos = this.flight ? from : to;
    this.cursor.classList.add("hg-in");
    this.cursorTip?.remove();
    this.cursorTip = item.label ? this.makeTip(item.label, color) : null;
    if (this.cursorTip) this.cursorTip.style.opacity = "0";
  }

  /** Cursor tip sits just below-left of the target centre, like a pointing hand. */
  private cursorAnchor(r: Rect): Pt {
    const c = center(r);
    return { x: c.x - 4, y: c.y - 2 };
  }

  private kick() {
    this.emit();
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private tick = () => {
    // Use one clock everywhere: rAF timestamps and performance.now() can
    // disagree (notably in background/headless tabs).
    const now = performance.now();
    this.raf = 0;
    const vw = innerWidth;
    const vh = innerHeight;

    for (const l of this.live) {
      if (l.removing) continue;
      if (now >= l.expiresAt) {
        this.removeLive(l);
        continue;
      }
      const r = l.item.resolve();
      if (!r) {
        this.removeLive(l);
        continue;
      }
      const visible = isOnScreen(r, { w: vw, h: vh });
      l.group.style.display = visible ? "" : "none";
      if (l.tip) l.tip.style.display = visible ? "" : "none";
      if (!visible) continue;
      this.layout(l, r, vw, vh);
    }
    this.live = this.live.filter((l) => !l.removing || l.group.isConnected);

    // Cursor flight / follow.
    if (this.cursorTarget && this.cursor) {
      const r = this.cursorTarget.resolve();
      if (!r || now >= this.cursorTarget.until) {
        if (!this.following && !this.pen) this.cursor.classList.remove("hg-in");
        this.cursorTip?.remove();
        this.cursorTip = null;
        this.cursorTarget = null;
        this.flight = null;
        this.emit();
      } else {
        const to = this.cursorAnchor(r);
        let pos = to;
        if (this.flight) {
          const t = Math.max(0, Math.min(1, (now - this.flight.start) / this.flight.ms));
          pos = bezierPoint(this.flight.from, this.flight.ctrl, to, easeInOutCubic(t));
          if (t >= 1) this.flight = null;
        }
        this.cursorPos = pos;
        this.cursor.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
        if (this.cursorTip) {
          const size = { w: this.cursorTip.offsetWidth || 120, h: this.cursorTip.offsetHeight || 28 };
          const p = tooltipPosition({ x: pos.x + 18, y: pos.y + 26, w: 1, h: 1 }, size, { w: vw, h: vh }, 4);
          this.cursorTip.style.left = `${p.x}px`;
          this.cursorTip.style.top = `${pos.y + 34 + size.h < vh ? pos.y + 34 : p.y}px`;
          this.cursorTip.style.opacity = this.flight ? "0" : "";
          if (!this.flight) this.cursorTip.classList.add("hg-in");
        }
      }
    }

    // Pen (whiteboard) > pointing target > follow the user's mouse.
    let settled = true;
    if (!this.cursorTarget && this.cursor && (this.pen || this.following)) {
      const goal = this.pen ?? (this.mouse ? { x: this.mouse.x + 16, y: this.mouse.y + 18 } : this.cursorPos);
      if (goal) {
        const cur = this.cursorPos ?? goal;
        // Springy lag when following; tight tracking while holding the pen.
        const k = this.pen ? 0.55 : 0.2;
        const pos = this.reduced() ? goal : { x: cur.x + (goal.x - cur.x) * k, y: cur.y + (goal.y - cur.y) * k };
        settled = Math.hypot(goal.x - pos.x, goal.y - pos.y) < 0.5;
        this.cursorPos = pos;
        this.cursor.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      }
    }
    if (this.sayEl && this.cursorPos) {
      const size = { w: this.sayEl.offsetWidth || 200, h: this.sayEl.offsetHeight || 40 };
      let x = this.cursorPos.x + 28;
      let y = this.cursorPos.y + 26;
      if (x + size.w > vw - 8) x = this.cursorPos.x - size.w - 8;
      if (y + size.h > vh - 8) y = this.cursorPos.y - size.h - 8;
      this.sayEl.style.transform = `translate(${Math.max(8, x)}px, ${Math.max(8, y)}px)`;
    }

    // Idle companion stops ticking once it has caught up; the next mouse
    // move (or any drawing) wakes the loop again.
    if (this.live.length || this.cursorTarget || this.pen || (this.following && !settled))
      this.raf = requestAnimationFrame(this.tick);
    else this.emit();
  };

  private layout(l: Live, r: Rect, vw: number, vh: number) {
    const [p0, p1] = l.paths;
    switch (l.item.type) {
      case "circle":
        p0.setAttribute("d", ellipsePath(r, Math.min(14, 6 + Math.min(r.w, r.h) * 0.12)));
        break;
      case "box":
        p0.setAttribute("d", roundedRectPath(inflate(r, 6), 12));
        break;
      case "underline":
        p0.setAttribute("d", underlinePath({ x: r.x, y: r.y, w: Math.min(r.w, vw - r.x - 4), h: r.h }));
        break;
      case "highlight":
        p0.setAttribute("d", roundedRectPath(inflate(r, 4), 10));
        break;
      case "arrow": {
        const c = center(r);
        const off = l.arrowOffset ?? { x: -120, y: 60 };
        const from = { x: Math.max(8, Math.min(vw - 8, c.x + off.x)), y: Math.max(8, Math.min(vh - 8, c.y + off.y)) };
        const to = edgePoint(r, from, 8);
        const { shaft, head } = arrowPaths(from, to);
        p0.setAttribute("d", shaft);
        p1.setAttribute("d", head);
        break;
      }
    }
    if (l.tip) {
      const size = { w: l.tip.offsetWidth || 140, h: l.tip.offsetHeight || 30 };
      let anchor = r;
      if (l.item.type === "arrow" && l.arrowOffset) {
        const c = center(r);
        anchor = { x: c.x + l.arrowOffset.x - 1, y: c.y + l.arrowOffset.y - 1, w: 2, h: 2 };
      }
      const p = tooltipPosition(anchor, size, { w: vw, h: vh }, l.item.type === "arrow" ? 6 : 12);
      l.tip.style.left = `${p.x}px`;
      l.tip.style.top = `${p.y}px`;
    }
  }

  private removeLive(l: Live, immediate = false) {
    if (l.removing && !immediate) return;
    l.removing = true;
    if (immediate || this.reduced()) {
      l.group.remove();
      l.tip?.remove();
      return;
    }
    l.group.classList.add("hg-out");
    l.tip?.classList.remove("hg-in");
    setTimeout(() => {
      l.group.remove();
      l.tip?.remove();
    }, 360);
  }

  private emit() {
    this.onChange?.(this.count);
  }
}

const TEXT_TAGS = new Set(["P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH", "LABEL", "DT", "DD", "FIGCAPTION", "BLOCKQUOTE", "SPAN", "CODE", "PRE"]);

/**
 * Resolver for a live element (null once it leaves the DOM).
 * Block-level text (a <p> spanning the whole card) is measured by its actual
 * text extent, so circles and underlines hug the words instead of the box.
 */
export function elementResolver(el: Element): () => Rect | null {
  const tight = TEXT_TAGS.has(el.tagName) && typeof document !== "undefined" && !!document.createRange;
  return () => {
    if (!el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    if (tight) {
      try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const t = range.getBoundingClientRect();
        if (t.width > 0 && t.height > 0 && t.width < r.width - 4) {
          return { x: t.left, y: t.top, w: t.width, h: t.height };
        }
      } catch {
        /* fall back to the element box */
      }
    }
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
}

/**
 * Resolver for a screenshot region: converted once to PAGE coordinates, then
 * offset by the current scroll each frame so it stays aligned while scrolling.
 */
export function regionResolver(viewportRect: Rect, scrollAtCapture: Pt): () => Rect | null {
  const page = { x: viewportRect.x + scrollAtCapture.x, y: viewportRect.y + scrollAtCapture.y };
  return () => ({ x: page.x - scrollX, y: page.y - scrollY, w: viewportRect.w, h: viewportRect.h });
}

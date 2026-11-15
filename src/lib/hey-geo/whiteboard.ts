/**
 * Hey Geo whiteboard — live drawing card (browser, framework-free).
 * ──────────────────────────────────────────────────────────────
 * Shows a paper-like card on screen and draws a laid-out diagram one stroke
 * at a time, reporting the pen position so Hey Geo's cursor can "hold the pen".
 * The card can be dragged by its header and closed; it stays until closed
 * or replaced by the next drawing.
 */

import { layoutDiagram, type Layout, type Op } from "./diagram";
import type { Diagram } from "./diagram-schema";
import type { Pt, Rect } from "./geometry";

const SVG_NS = "http://www.w3.org/2000/svg";
const STYLE_ID = "hg-whiteboard-style";
/** Upper bound on total drawing time; individual strokes are scaled to fit. */
const MAX_TOTAL_MS = 9000;

const CSS = `
.hg-board{position:fixed;z-index:2147482999;width:min(460px,calc(100vw - 24px));border-radius:16px;overflow:hidden;
  background:#fbfdf7;border:1px solid #d3ddcb;box-shadow:0 24px 60px -18px rgba(16,20,17,.38),0 2px 8px rgba(16,20,17,.06);
  font:500 13px var(--hg-sans,ui-sans-serif),ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#101411;opacity:0;transform:translateY(8px) scale(.98);
  transition:opacity .25s ease,transform .25s ease}
.hg-board.hg-in{opacity:1;transform:none}
.hg-board-head{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 14px;cursor:grab;user-select:none;background:#fff;border-bottom:1px solid #e8eee2}
.hg-board.hg-wide{width:min(620px,calc(100vw - 24px))}
.hg-board-caption{margin:0;padding:7px 14px 10px;color:#6b776e;font-size:11px;line-height:1.45;border-top:1px solid #e8eee2;background:#fff}
.hg-board-head:active{cursor:grabbing}
.hg-board-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;font-size:12.5px;letter-spacing:-.01em}
.hg-board-badge{font:500 9.5px var(--hg-mono,ui-monospace),ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:#1f4a36;background:#eef5e3;border:1px solid #d3ddcb;border-radius:999px;padding:2px 7px}
.hg-board-btn{border:0;background:transparent;color:#6b776e;width:24px;height:24px;border-radius:7px;cursor:pointer;font-size:16px;line-height:1}
.hg-board-btn:hover{background:#eef5e3;color:#101411}
.hg-board-body{padding:8px;background-image:radial-gradient(rgba(31,74,54,.10) 1px,transparent 1px);background-size:16px 16px}
.hg-board svg{display:block;width:100%;height:auto;max-height:min(58vh,520px)}
.hg-board text{font-family:var(--hg-sans,ui-sans-serif),ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
`;

export type WhiteboardOptions = {
  /** Called with the pen tip in viewport px while drawing (null when done). */
  onPen?: (p: Pt | null) => void;
  reducedMotion?: () => boolean;
  onClose?: () => void;
  /** Where the card is mounted (defaults to <html>). */
  host?: () => HTMLElement | null;
};

export class Whiteboard {
  private card: HTMLDivElement | null = null;
  private runId = 0;
  private opts: WhiteboardOptions;

  constructor(opts: WhiteboardOptions = {}) {
    this.opts = opts;
  }

  get open() {
    return !!this.card;
  }

  close() {
    this.runId++;
    this.opts.onPen?.(null);
    const c = this.card;
    this.card = null;
    if (c) {
      c.classList.remove("hg-in");
      setTimeout(() => c.remove(), 260);
      this.opts.onClose?.();
    }
  }

  /**
   * Lay out and draw a diagram, optionally next to an anchor element.
   * `wide` gives floor plans more room; `caption` is a line of small print under the drawing.
   */
  async draw(diagram: Diagram, anchor?: Rect | null, opts: { wide?: boolean; caption?: string; badge?: string; avoid?: Rect | null } = {}): Promise<void> {
    const layout = layoutDiagram(diagram);
    this.close();
    const run = ++this.runId;
    ensureStyle();
    const { card, svg } = this.buildCard(diagram.title || defaultTitle(diagram), layout, opts);
    this.card = card;
    (this.opts.host?.() ?? document.documentElement).appendChild(card);
    this.place(card, anchor ?? null, opts.avoid ?? null);
    requestAnimationFrame(() => card.classList.add("hg-in"));
    await wait(180);
    if (run !== this.runId) return;
    await this.animate(svg, layout.ops, run);
    if (run === this.runId) this.opts.onPen?.(null);
  }

  // ── internals ─────────────────────────────────────────────────────
  private buildCard(title: string, layout: Layout, opts: { wide?: boolean; caption?: string; badge?: string }) {
    const card = document.createElement("div");
    card.className = opts.wide ? "hg-board hg-wide" : "hg-board";
    card.setAttribute("data-geo-ui", "");
    card.setAttribute("role", "figure");
    card.setAttribute("aria-label", title);

    const head = document.createElement("div");
    head.className = "hg-board-head";
    const badge = document.createElement("span");
    badge.className = "hg-board-badge";
    badge.textContent = opts.badge ?? "Hey Geo";
    const t = document.createElement("div");
    t.className = "hg-board-title";
    t.textContent = title;
    const close = document.createElement("button");
    close.className = "hg-board-btn";
    close.setAttribute("aria-label", "Close drawing");
    close.textContent = "×";
    close.onclick = () => this.close();
    head.append(badge, t, close);
    this.makeDraggable(card, head);

    const body = document.createElement("div");
    body.className = "hg-board-body";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${layout.w} ${layout.h}`);
    svg.setAttribute("role", "img");
    body.appendChild(svg);
    card.append(head, body);
    if (opts.caption) {
      const caption = document.createElement("p");
      caption.className = "hg-board-caption";
      caption.textContent = opts.caption;
      card.appendChild(caption);
    }
    return { card, svg };
  }

  private place(card: HTMLDivElement, anchor: Rect | null, avoid: Rect | null = null) {
    const vw = innerWidth;
    const vh = innerHeight;
    const w = Math.min(card.classList.contains("hg-wide") ? 620 : 460, vw - 24);
    const h = Math.min(card.offsetHeight || 380, vh - 24);
    let x: number;
    let y: number;
    if (anchor) {
      const right = anchor.x + anchor.w + 16;
      const left = anchor.x - w - 16;
      x = right + w <= vw - 12 ? right : left >= 12 ? left : Math.max(12, Math.min(vw - w - 12, anchor.x));
      y = Math.max(12, Math.min(vh - h - 12, anchor.y + anchor.h / 2 - h / 2));
    } else {
      // Right-centre, clear of the floating buttons in the bottom-right corner.
      x = Math.max(12, vw - w - 96);
      y = Math.max(12, Math.min(vh - h - 96, vh / 2 - h / 2));
    }
    // Never on top of Hey Geo's own panel: move beside it when there is room.
    if (avoid && x < avoid.x + avoid.w && x + w > avoid.x && y < avoid.y + avoid.h && y + h > avoid.y) {
      if (avoid.x - w - 16 >= 12) x = avoid.x - w - 16;
      else if (avoid.x + avoid.w + 16 + w <= vw - 12) x = avoid.x + avoid.w + 16;
      else if (avoid.y - h - 12 >= 12) y = avoid.y - h - 12;
    }
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }

  private makeDraggable(card: HTMLDivElement, handle: HTMLElement) {
    let start: { x: number; y: number; left: number; top: number } | null = null;
    handle.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button")) return;
      start = { x: e.clientX, y: e.clientY, left: card.offsetLeft, top: card.offsetTop };
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    handle.addEventListener("pointermove", (e) => {
      if (!start) return;
      const left = Math.max(0, Math.min(innerWidth - 80, start.left + e.clientX - start.x));
      const top = Math.max(0, Math.min(innerHeight - 40, start.top + e.clientY - start.y));
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
    });
    handle.addEventListener("pointerup", () => (start = null));
  }

  private toScreen(svg: SVGSVGElement, p: DOMPoint | { x: number; y: number }): Pt | null {
    const m = svg.getScreenCTM?.();
    if (!m) return null;
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
  }

  private async animate(svg: SVGSVGElement, ops: Op[], run: number) {
    const reduced = this.opts.reducedMotion?.() ?? matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Build every element first (hidden) so we can measure and scale timings.
    type Step = { el: SVGElement; head?: SVGPathElement; len: number; op: Op };
    const steps: Step[] = [];
    for (const op of ops) {
      if (op.kind === "path") {
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", op.d);
        p.setAttribute("fill", op.fill ?? "none");
        p.setAttribute("stroke", op.color);
        p.setAttribute("stroke-width", String(op.width));
        p.setAttribute("stroke-linecap", "round");
        p.setAttribute("stroke-linejoin", "round");
        if (op.dashed) p.setAttribute("stroke-dasharray", "6 5");
        if (op.fill) p.style.fillOpacity = reduced ? "1" : "0";
        let head: SVGPathElement | undefined;
        svg.appendChild(p);
        if (op.head) {
          head = document.createElementNS(SVG_NS, "path");
          head.setAttribute("d", op.head);
          head.setAttribute("fill", "none");
          head.setAttribute("stroke", op.color);
          head.setAttribute("stroke-width", String(op.width));
          head.setAttribute("stroke-linecap", "round");
          head.setAttribute("stroke-linejoin", "round");
          head.style.opacity = reduced ? "1" : "0";
          svg.appendChild(head);
        }
        let len = 0;
        try {
          len = p.getTotalLength();
        } catch {
          len = 0;
        }
        if (!reduced && len > 0 && !op.dashed) {
          p.style.strokeDasharray = `${len}`;
          p.style.strokeDashoffset = `${len}`;
        } else if (!reduced) {
          p.style.opacity = "0";
        }
        steps.push({ el: p, head, len, op });
      } else {
        const t = document.createElementNS(SVG_NS, "text");
        t.setAttribute("x", String(op.x));
        t.setAttribute("y", String(op.y));
        t.setAttribute("text-anchor", op.anchor);
        t.setAttribute("font-size", String(op.size));
        t.setAttribute("fill", op.color);
        if (op.weight) t.setAttribute("font-weight", String(op.weight));
        if (op.halo) {
          t.setAttribute("stroke", "#FBFDF7");
          t.setAttribute("stroke-width", "4");
          t.setAttribute("paint-order", "stroke");
          t.setAttribute("stroke-linejoin", "round");
        }
        t.textContent = op.text;
        if (!reduced) t.style.opacity = "0";
        svg.appendChild(t);
        steps.push({ el: t, len: 0, op });
      }
    }
    if (reduced) return;

    const base = steps.map((s) => (s.op.kind === "path" ? Math.max(140, Math.min(900, s.len * 3.2)) : 90));
    const total = base.reduce((a, b) => a + b, 0);
    const k = total > MAX_TOTAL_MS ? MAX_TOTAL_MS / total : 1;

    for (let i = 0; i < steps.length; i++) {
      if (run !== this.runId || !svg.isConnected) return;
      const s = steps[i];
      const ms = base[i] * k;
      if (s.op.kind === "text") {
        const pen = this.toScreen(svg, { x: s.op.x, y: s.op.y - s.op.size / 2 });
        if (pen) this.opts.onPen?.(pen);
        s.el.style.transition = `opacity ${Math.max(80, ms)}ms ease`;
        s.el.style.opacity = "1";
        await wait(ms);
        continue;
      }
      const path = s.el as SVGPathElement;
      if (s.len > 0 && !s.op.dashed) {
        const t0 = performance.now();
        await new Promise<void>((resolve) => {
          const frame = () => {
            if (run !== this.runId || !svg.isConnected) return resolve();
            const t = Math.min(1, (performance.now() - t0) / ms);
            path.style.strokeDashoffset = `${s.len * (1 - t)}`;
            try {
              const pen = this.toScreen(svg, path.getPointAtLength(s.len * t));
              if (pen) this.opts.onPen?.(pen);
            } catch {
              /* detached */
            }
            if (t < 1) requestAnimationFrame(frame);
            else resolve();
          };
          requestAnimationFrame(frame);
        });
        path.style.strokeDasharray = "";
        path.style.strokeDashoffset = "";
      } else {
        path.style.transition = `opacity ${ms}ms ease`;
        path.style.opacity = "1";
        await wait(ms);
      }
      if (s.op.kind === "path" && s.op.fill) {
        path.style.transition = "fill-opacity .35s ease";
        path.style.fillOpacity = "1";
      }
      if (s.head) {
        s.head.style.transition = "opacity .12s ease";
        s.head.style.opacity = "1";
        await wait(90 * k);
      }
    }
  }
}

function defaultTitle(d: Diagram) {
  return d.kind === "flowchart" ? "Flowchart" : d.kind === "plot" ? "Graph" : "Sketch";
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

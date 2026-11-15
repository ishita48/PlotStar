/**
 * Hey Geo whiteboard — layout (pure, no DOM).
 * ────────────────────────────────────────
 * Turns a validated Diagram into an ordered list of draw ops (paths + text)
 * inside a viewBox. The whiteboard renderer animates the ops in order, with
 * Hey Geo's cursor riding the pen — so the order here is the drawing order.
 */

import { CANVAS_H, CANVAS_W, type Diagram, type Shape } from "./diagram-schema";

export type PathOp = {
  kind: "path";
  d: string;
  color: string;
  width: number;
  dashed?: boolean;
  fill?: string;
  /** Arrowhead path drawn right after the stroke. */
  head?: string;
};
export type TextOp = {
  kind: "text";
  x: number;
  y: number;
  text: string;
  size: number;
  anchor: "start" | "middle" | "end";
  color: string;
  weight?: number;
  /** Paint a paper-coloured halo so labels stay readable over lines. */
  halo?: boolean;
};
export type Op = PathOp | TextOp;
export type Layout = { w: number; h: number; ops: Op[] };

export const PALETTE = ["#1F4A36", "#6FA24E", "#2F6F9F", "#B7791F", "#B3261E", "#101411"];
const INK = "#101411";
const f = (n: number) => (Math.round(n * 10) / 10).toString();

// ── small geometry helpers ────────────────────────────────────────────
function pairs(flat: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

function polyPath(p: [number, number][], close = false): string {
  return p.map(([x, y], i) => `${i ? "L" : "M"}${f(x)},${f(y)}`).join(" ") + (close ? " Z" : "");
}

/** Catmull-Rom spline through points, as cubic beziers (smooth hand-drawn curves). */
export function smoothPath(p: [number, number][]): string {
  if (p.length < 3) return polyPath(p);
  let d = `M${f(p[0][0])},${f(p[0][1])}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[Math.min(p.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`;
  }
  return d;
}

export function arrowHead(from: [number, number], to: [number, number], size = 9): string {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const l = [to[0] - ux * size - uy * size * 0.55, to[1] - uy * size + ux * size * 0.55];
  const r = [to[0] - ux * size + uy * size * 0.55, to[1] - uy * size - ux * size * 0.55];
  return `M${f(l[0])},${f(l[1])} L${f(to[0])},${f(to[1])} L${f(r[0])},${f(r[1])}`;
}

/** Arc in maths convention (0° = +x, counter-clockwise), screen y grows down. */
export function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const steps = Math.max(8, Math.ceil(Math.abs(endDeg - startDeg) / 6));
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = ((startDeg + ((endDeg - startDeg) * i) / steps) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(t), cy - r * Math.sin(t)]);
  }
  return polyPath(pts);
}

function circlePath(cx: number, cy: number, rx: number, ry = rx): string {
  return `M${f(cx + rx)},${f(cy)} A${f(rx)},${f(ry)} 0 1 1 ${f(cx - rx)},${f(cy)} A${f(rx)},${f(ry)} 0 1 1 ${f(cx + rx)},${f(cy)}`;
}

function centroid(p: [number, number][]): [number, number] {
  const n = p.length || 1;
  return [p.reduce((a, q) => a + q[0], 0) / n, p.reduce((a, q) => a + q[1], 0) / n];
}

/** Labels sit on a near-white paper with a white halo — keep them dark enough to read. */
export function readableInk(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return INK;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.72 ? INK : color;
}

// ── sketch ────────────────────────────────────────────────────────────
function sketchOps(shapes: Shape[]): Op[] {
  const ops: Op[] = [];
  const labels: TextOp[] = [];
  shapes.forEach((s, i) => {
    const color = ("color" in s && s.color) || (s.shape === "text" ? INK : PALETTE[i % PALETTE.length]);
    const width = ("width" in s && s.width) || 2.5;
    const dashed = "dashed" in s ? s.dashed : undefined;
    const fill = "fill" in s && s.fill ? `${s.fill}33` : undefined;
    const label = "label" in s ? s.label : undefined;
    const addLabel = (x: number, y: number) => {
      if (label) labels.push({ kind: "text", x, y, text: label, size: 13, anchor: "middle", color: readableInk(color), weight: 600, halo: true });
    };
    switch (s.shape) {
      case "line":
      case "arrow": {
        const [a, b] = pairs(s.points);
        ops.push({ kind: "path", d: polyPath([a, b]), color, width, dashed, ...(s.shape === "arrow" ? { head: arrowHead(a, b) } : {}) });
        addLabel((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 8);
        break;
      }
      case "polyline":
      case "curve": {
        const p = pairs(s.points);
        ops.push({ kind: "path", d: s.shape === "curve" ? smoothPath(p) : polyPath(p), color, width, dashed });
        const last = p[p.length - 1];
        addLabel(last[0], last[1] - 10);
        break;
      }
      case "polygon": {
        const p = pairs(s.points);
        ops.push({ kind: "path", d: polyPath(p, true), color, width, dashed, fill });
        const c = centroid(p);
        addLabel(c[0], c[1] + 4);
        break;
      }
      // Big outlines (cell membranes, containers) are labelled just inside
      // their top edge so the centre stays free for whatever is inside them.
      case "circle":
        ops.push({ kind: "path", d: circlePath(s.cx, s.cy, s.r), color, width, dashed, fill });
        addLabel(s.cx, s.r > 40 ? s.cy - s.r + 18 : s.cy + 4);
        break;
      case "ellipse":
        ops.push({ kind: "path", d: circlePath(s.cx, s.cy, s.rx, s.ry), color, width, dashed, fill });
        addLabel(s.cx, s.ry > 40 ? s.cy - s.ry + 18 : s.cy + 4);
        break;
      case "rect":
        ops.push({ kind: "path", d: polyPath([[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]], true), color, width, dashed, fill });
        addLabel(s.x + s.w / 2, s.h > 80 ? s.y + 18 : s.y + s.h / 2 + 4);
        break;
      case "arc":
        ops.push({ kind: "path", d: arcPath(s.cx, s.cy, s.r, s.start, s.end), color, width, dashed });
        {
          const mid = (((s.start + s.end) / 2) * Math.PI) / 180;
          addLabel(s.cx + (s.r + 14) * Math.cos(mid), s.cy - (s.r + 14) * Math.sin(mid) + 4);
        }
        break;
      case "rightAngle": {
        const size = s.size ?? 12;
        const a = ((s.angle ?? 0) * Math.PI) / 180;
        const u1: [number, number] = [Math.cos(a), -Math.sin(a)];
        const u2: [number, number] = [Math.cos(a + Math.PI / 2), -Math.sin(a + Math.PI / 2)];
        const p1: [number, number] = [s.x + u1[0] * size, s.y + u1[1] * size];
        const p2: [number, number] = [s.x + (u1[0] + u2[0]) * size, s.y + (u1[1] + u2[1]) * size];
        const p3: [number, number] = [s.x + u2[0] * size, s.y + u2[1] * size];
        ops.push({ kind: "path", d: polyPath([p1, p2, p3]), color, width: Math.min(width, 2), dashed });
        break;
      }
      case "text":
        labels.push({ kind: "text", x: s.x, y: s.y, text: s.text, size: s.size ?? 14, anchor: s.anchor ?? "middle", color: readableInk(color), halo: true });
        break;
    }
  });
  // Labels after strokes so they sit on top, nudged apart if they collide.
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  return [...ops, ...labels.map((l) => placeLabel(placed, l, { w: CANVAS_W, h: CANVAS_H }))];
}

// ── flowchart (layered layout) ────────────────────────────────────────
type Box = { id: string; label: string; lines: string[]; shape: string; color?: string; w: number; h: number; x: number; y: number; rank: number };

function wrap(label: string, max = 16): string[] {
  const words = label.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

export function layoutFlowchart(d: Extract<Diagram, { kind: "flowchart" }>): Layout {
  const lr = d.direction === "LR";
  const boxes = new Map<string, Box>();
  for (const n of d.nodes) {
    const lines = wrap(n.label);
    const longest = Math.max(...lines.map((l) => l.length));
    let w = Math.max(70, longest * 7 + 24);
    let h = lines.length * 15 + 18;
    const shape = n.shape ?? "box";
    if (shape === "diamond") {
      w *= 1.35;
      h *= 1.6;
    }
    if (shape === "circle") w = h = Math.max(w, h);
    boxes.set(n.id, { id: n.id, label: n.label, lines, shape, color: n.color, w, h, x: 0, y: 0, rank: 0 });
  }

  // Ranks: longest path from sources, ignoring back edges (cycles = loops in algorithms).
  const out = new Map<string, string[]>();
  for (const e of d.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const state = new Map<string, number>(); // 1 = on stack, 2 = done
  const back = new Set<string>();
  const order: string[] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    for (const t of out.get(id) ?? []) {
      if (state.get(t) === 1) back.add(`${id}->${t}`);
      else if (!state.get(t)) visit(t);
    }
    state.set(id, 2);
    order.push(id);
  };
  for (const n of d.nodes) if (!state.get(n.id)) visit(n.id);
  order.reverse(); // topological (forward edges only)
  for (const id of order) {
    for (const t of out.get(id) ?? []) {
      if (back.has(`${id}->${t}`)) continue;
      const b = boxes.get(t)!;
      b.rank = Math.max(b.rank, boxes.get(id)!.rank + 1);
    }
  }

  // Order within ranks: appearance, then one barycenter pass.
  const ranks: Box[][] = [];
  for (const n of d.nodes) {
    const b = boxes.get(n.id)!;
    (ranks[b.rank] ??= []).push(b);
  }
  const index = new Map<string, number>();
  ranks.forEach((r) => r.forEach((b, i) => index.set(b.id, i)));
  const preds = new Map<string, string[]>();
  for (const e of d.edges) if (!back.has(`${e.from}->${e.to}`)) preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
  for (let r = 1; r < ranks.length; r++) {
    if (!ranks[r]) continue;
    ranks[r].sort((a, b) => {
      const bc = (x: Box) => {
        const p = preds.get(x.id) ?? [];
        return p.length ? p.reduce((s, id) => s + (index.get(id) ?? 0), 0) / p.length : index.get(x.id) ?? 0;
      };
      return bc(a) - bc(b);
    });
    ranks[r].forEach((b, i) => index.set(b.id, i));
  }

  // Coordinates.
  const GAP_MAIN = 46;
  const GAP_CROSS = 28;
  let main = 0;
  let maxCross = 0;
  const rows = ranks.filter(Boolean);
  const crossSize = (row: Box[]) => row.reduce((s, b) => s + (lr ? b.h : b.w), 0) + GAP_CROSS * (row.length - 1);
  for (const row of rows) maxCross = Math.max(maxCross, crossSize(row));
  for (const row of rows) {
    const thick = Math.max(...row.map((b) => (lr ? b.w : b.h)));
    let cross = (maxCross - crossSize(row)) / 2;
    for (const b of row) {
      if (lr) {
        b.x = main + (thick - b.w) / 2;
        b.y = cross;
        cross += b.h + GAP_CROSS;
      } else {
        b.y = main + (thick - b.h) / 2;
        b.x = cross;
        cross += b.w + GAP_CROSS;
      }
    }
    main += thick + GAP_MAIN;
  }

  const PAD = 18;
  const w = (lr ? main - GAP_MAIN : maxCross) + PAD * 2;
  const h = (lr ? maxCross : main - GAP_MAIN) + PAD * 2;
  const ops: Op[] = [];
  const nodeColor = (b: Box, i: number) => b.color || (b.shape === "diamond" ? "#2F6F9F" : PALETTE[i % 2 === 0 ? 0 : 1]);

  // Draw nodes in rank order, each edge right after its source node is drawn
  // (reads like someone sketching the flow).
  const drawn = new Set<string>();
  const edgeOps = (e: (typeof d.edges)[number]) => {
    const a = boxes.get(e.from)!;
    const b = boxes.get(e.to)!;
    const ac = [a.x + a.w / 2 + PAD, a.y + a.h / 2 + PAD];
    const bc = [b.x + b.w / 2 + PAD, b.y + b.h / 2 + PAD];
    const isBack = back.has(`${e.from}->${e.to}`) || (lr ? b.x <= a.x : b.y <= a.y);
    let start: [number, number];
    let end: [number, number];
    let dpath: string;
    if (!isBack) {
      start = lr ? [ac[0] + a.w / 2, ac[1]] : [ac[0], ac[1] + a.h / 2];
      end = lr ? [bc[0] - b.w / 2 - 2, bc[1]] : [bc[0], bc[1] - b.h / 2 - 2];
      const mid = lr ? (start[0] + end[0]) / 2 : (start[1] + end[1]) / 2;
      dpath = lr
        ? `M${f(start[0])},${f(start[1])} C${f(mid)},${f(start[1])} ${f(mid)},${f(end[1])} ${f(end[0])},${f(end[1])}`
        : `M${f(start[0])},${f(start[1])} C${f(start[0])},${f(mid)} ${f(end[0])},${f(mid)} ${f(end[0])},${f(end[1])}`;
    } else {
      // Loop back around the side.
      start = lr ? [ac[0], ac[1] + a.h / 2] : [ac[0] + a.w / 2, ac[1]];
      end = lr ? [bc[0], bc[1] + b.h / 2 + 2] : [bc[0] + b.w / 2 + 2, bc[1]];
      const out2 = lr ? Math.max(start[1], end[1]) + 30 : Math.max(start[0], end[0]) + 34;
      dpath = lr
        ? `M${f(start[0])},${f(start[1])} C${f(start[0])},${f(out2)} ${f(end[0])},${f(out2)} ${f(end[0])},${f(end[1])}`
        : `M${f(start[0])},${f(start[1])} C${f(out2)},${f(start[1])} ${f(out2)},${f(end[1])} ${f(end[0])},${f(end[1])}`;
    }
    const before: [number, number] = isBack
      ? lr
        ? [end[0], end[1] + 10]
        : [end[0] + 10, end[1]]
      : lr
      ? [end[0] - 10, end[1]]
      : [end[0], end[1] - 10];
    const res: Op[] = [{ kind: "path", d: dpath, color: "#5d6b61", width: 2, head: arrowHead(before, end, 8) }];
    if (e.label) {
      const lx = isBack ? (lr ? (start[0] + end[0]) / 2 : Math.max(start[0], end[0]) + 30) : (start[0] + end[0]) / 2 + (lr ? 0 : 8);
      const ly = isBack ? (lr ? Math.max(start[1], end[1]) + 26 : (start[1] + end[1]) / 2) : (start[1] + end[1]) / 2 + (lr ? -6 : 4);
      res.push({ kind: "text", x: lx, y: ly, text: e.label, size: 11, anchor: isBack || lr ? "middle" : "start", color: "#5d6b61", halo: true });
    }
    return res;
  };

  let ni = 0;
  for (const row of rows) {
    for (const b of row) {
      const cx = b.x + b.w / 2 + PAD;
      const cy = b.y + b.h / 2 + PAD;
      const color = nodeColor(b, ni++);
      let dpath: string;
      if (b.shape === "diamond") dpath = polyPath([[cx, cy - b.h / 2], [cx + b.w / 2, cy], [cx, cy + b.h / 2], [cx - b.w / 2, cy]], true);
      else if (b.shape === "circle") dpath = circlePath(cx, cy, b.w / 2);
      else {
        const r = b.shape === "pill" ? b.h / 2 : 9;
        const x0 = cx - b.w / 2;
        const y0 = cy - b.h / 2;
        dpath = `M${f(x0 + r)},${f(y0)} H${f(x0 + b.w - r)} Q${f(x0 + b.w)},${f(y0)} ${f(x0 + b.w)},${f(y0 + r)} V${f(y0 + b.h - r)} Q${f(x0 + b.w)},${f(y0 + b.h)} ${f(x0 + b.w - r)},${f(y0 + b.h)} H${f(x0 + r)} Q${f(x0)},${f(y0 + b.h)} ${f(x0)},${f(y0 + b.h - r)} V${f(y0 + r)} Q${f(x0)},${f(y0)} ${f(x0 + r)},${f(y0)} Z`;
      }
      ops.push({ kind: "path", d: dpath, color, width: 2.2, fill: `${color}14` });
      b.lines.forEach((line, li) => {
        ops.push({ kind: "text", x: cx, y: cy + (li - (b.lines.length - 1) / 2) * 15 + 4.5, text: line, size: 12.5, anchor: "middle", color: INK, weight: 600 });
      });
      drawn.add(b.id);
      for (const e of d.edges) {
        // Draw an edge once both ends exist (forward edges right after the target appears).
        if ((e.to === b.id && drawn.has(e.from)) || (e.from === b.id && drawn.has(e.to) && e.to !== b.id)) ops.push(...edgeOps(e));
      }
    }
  }
  return { w: Math.max(120, w), h: Math.max(80, h), ops };
}

// ── plot ──────────────────────────────────────────────────────────────
export function niceTicks(min: number, max: number, count = 5): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 1) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

const fmt = (v: number) => (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(0) : String(Math.round(v * 100) / 100));

/** Keep plot labels from piling on top of each other or off the canvas. */
function placeLabel(
  placed: { x: number; y: number; w: number; h: number }[],
  op: TextOp,
  bounds: { w: number; h: number }
): TextOp {
  const width = op.text.length * op.size * 0.56;
  const box = (o: TextOp) => {
    const x0 = o.anchor === "end" ? o.x - width : o.anchor === "middle" ? o.x - width / 2 : o.x;
    return { x: x0, y: o.y - o.size, w: width, h: op.size + 2 };
  };
  let out = { ...op };
  // Flip anchors that would spill past the edges.
  const b0 = box(out);
  if (b0.x + b0.w > bounds.w - 4) out = { ...out, anchor: "end", x: Math.min(out.x, bounds.w - 6) };
  if (box(out).x < 4) out = { ...out, anchor: "start", x: Math.max(out.x, 6) };
  const hit = (b: { x: number; y: number; w: number; h: number }) =>
    placed.some((p) => b.x < p.x + p.w && b.x + b.w > p.x && b.y < p.y + p.h && b.y + b.h > p.y);
  for (const dy of [0, -14, 14, -28, 28, -42]) {
    const cand = { ...out, y: Math.max(op.size + 2, Math.min(bounds.h - 4, out.y + dy)) };
    if (!hit(box(cand))) {
      placed.push(box(cand));
      return cand;
    }
  }
  placed.push(box(out));
  return out;
}

export function layoutPlot(d: Extract<Diagram, { kind: "plot" }>): Layout {
  const W = CANVAS_W;
  const H = CANVAS_H;
  const L = 46;
  const R = 16;
  const T = 18;
  const B = 36;
  const sx = (x: number) => L + ((x - d.x[0]) / (d.x[1] - d.x[0])) * (W - L - R);
  const sy = (y: number) => H - B - ((y - d.y[0]) / (d.y[1] - d.y[0])) * (H - T - B);
  const ops: Op[] = [];
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  const label = (op: TextOp) => ops.push(placeLabel(placed, op, { w: W, h: H }));

  // Grid + tick labels.
  for (const t of niceTicks(d.x[0], d.x[1])) {
    ops.push({ kind: "path", d: `M${f(sx(t))},${T} V${H - B}`, color: "#E3EADC", width: 1 });
    ops.push({ kind: "text", x: sx(t), y: H - B + 15, text: fmt(t), size: 10, anchor: "middle", color: "#5d6b61" });
  }
  for (const t of niceTicks(d.y[0], d.y[1])) {
    ops.push({ kind: "path", d: `M${L},${f(sy(t))} H${W - R}`, color: "#E3EADC", width: 1 });
    ops.push({ kind: "text", x: L - 6, y: sy(t) + 3.5, text: fmt(t), size: 10, anchor: "end", color: "#5d6b61" });
  }
  // Axes at zero when in range, else at the edges.
  const ax = d.y[0] <= 0 && d.y[1] >= 0 ? sy(0) : H - B;
  const ay = d.x[0] <= 0 && d.x[1] >= 0 ? sx(0) : L;
  ops.push({ kind: "path", d: `M${L},${f(ax)} H${W - R}`, color: INK, width: 1.6, head: arrowHead([W - R - 10, ax], [W - R, ax], 7) });
  ops.push({ kind: "path", d: `M${f(ay)},${H - B} V${T}`, color: INK, width: 1.6, head: arrowHead([ay, T + 10], [ay, T], 7) });
  if (d.xLabel) label({ kind: "text", x: W - R, y: ax - 7, text: d.xLabel, size: 12, anchor: "end", color: INK, weight: 600, halo: true });
  if (d.yLabel) label({ kind: "text", x: ay + 7, y: T + 10, text: d.yLabel, size: 12, anchor: "start", color: INK, weight: 600, halo: true });

  // Series — split where the curve leaves the y-range (asymptotes, steep growth).
  d.series.forEach((s, i) => {
    const color = s.color || PALETTE[i % PALETTE.length];
    const pts = [...s.points].sort((a, b) => a[0] - b[0]);
    let seg: [number, number][] = [];
    const flush = () => {
      if (seg.length >= 2) ops.push({ kind: "path", d: smoothPath(seg), color, width: 2.6 });
      seg = [];
    };
    for (const [x, y] of pts) {
      if (x < d.x[0] || x > d.x[1] || y < d.y[0] - (d.y[1] - d.y[0]) * 0.02 || y > d.y[1] + (d.y[1] - d.y[0]) * 0.02) {
        flush();
        continue;
      }
      seg.push([sx(x), sy(Math.max(d.y[0], Math.min(d.y[1], y)))]);
    }
    flush();
    if (s.label) {
      const visible = pts.filter(([x, y]) => x >= d.x[0] && x <= d.x[1] && y >= d.y[0] && y <= d.y[1]);
      const last = visible[visible.length - 1];
      if (last) label({ kind: "text", x: sx(last[0]) - 4, y: sy(last[1]) - 8, text: s.label, size: 12, anchor: "end", color, weight: 700, halo: true });
    }
  });
  for (const m of d.marks ?? []) {
    if (m.x < d.x[0] || m.x > d.x[1] || m.y < d.y[0] || m.y > d.y[1]) continue;
    ops.push({ kind: "path", d: circlePath(sx(m.x), sy(m.y), 4), color: "#1F4A36", width: 2, fill: "#1F4A36" });
    if (m.label) label({ kind: "text", x: sx(m.x) + 7, y: sy(m.y) - 7, text: m.label, size: 11, anchor: "start", color: "#1F4A36", weight: 600, halo: true });
  }
  return { w: W, h: H, ops };
}

export function layoutDiagram(d: Diagram): Layout {
  if (d.kind === "flowchart") return layoutFlowchart(d);
  if (d.kind === "plot") return layoutPlot(d);
  return { w: CANVAS_W, h: CANVAS_H, ops: sketchOps(d.shapes) };
}

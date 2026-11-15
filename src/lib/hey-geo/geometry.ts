/**
 * Pure geometry for Hey Geo — coordinate conversion and SVG path building.
 * No DOM access here so it is unit-testable and reusable by the extension.
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };

/**
 * Convert a Gemini-style normalised box [ymin, xmin, ymax, xmax] (0–1000,
 * relative to the screenshot) into viewport CSS pixels.
 *
 * The screenshot may have been captured at device resolution and then
 * downscaled before upload, so we go through fractions of the image rather
 * than pixels: fraction × viewport size. `cropOffset` handles captures that
 * include browser chrome above the page (rare with tab capture, but the
 * maths stays explicit).
 */
export function normBoxToViewport(
  box: [number, number, number, number],
  viewport: { w: number; h: number },
  cropOffset: { top: number; left: number } = { top: 0, left: 0 },
  captured: { w: number; h: number } = viewport
): Rect {
  const [ymin, xmin, ymax, xmax] = box.map((v) => Math.max(0, Math.min(1000, v))) as [
    number,
    number,
    number,
    number,
  ];
  // Fractions of the captured surface → captured CSS px → page viewport px.
  const x0 = (xmin / 1000) * captured.w - cropOffset.left;
  const y0 = (ymin / 1000) * captured.h - cropOffset.top;
  const x1 = (xmax / 1000) * captured.w - cropOffset.left;
  const y1 = (ymax / 1000) * captured.h - cropOffset.top;
  const sx = viewport.w / Math.max(1, captured.w - cropOffset.left);
  const sy = viewport.h / Math.max(1, captured.h - cropOffset.top);
  return clampRect(
    { x: x0 * sx, y: y0 * sy, w: Math.max(1, (x1 - x0) * sx), h: Math.max(1, (y1 - y0) * sy) },
    viewport
  );
}

export function clampRect(r: Rect, viewport: { w: number; h: number }): Rect {
  const x = Math.max(0, Math.min(viewport.w - 1, r.x));
  const y = Math.max(0, Math.min(viewport.h - 1, r.y));
  return { x, y, w: Math.max(1, Math.min(viewport.w - x, r.w)), h: Math.max(1, Math.min(viewport.h - y, r.h)) };
}

/** Scale (w, h) down so the longest side is ≤ max, preserving aspect ratio. */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number } {
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

/** Whether a captured frame plausibly shows this tab's viewport (aspect within tolerance). */
export function aspectMatches(a: { w: number; h: number }, b: { w: number; h: number }, tol = 0.04): boolean {
  if (!a.w || !a.h || !b.w || !b.h) return false;
  const ra = a.w / a.h;
  const rb = b.w / b.h;
  return Math.abs(ra - rb) / rb <= tol;
}

export const center = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function inflate(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

/**
 * Slightly hand-drawn ellipse around a rect (two overlapping passes with a
 * small wobble, like someone circling with a marker). Deterministic so it
 * doesn't jitter between frames.
 */
export function ellipsePath(r: Rect, pad = 10): string {
  const c = center(r);
  const rx = r.w / 2 + pad;
  const ry = r.h / 2 + pad * 0.8;
  const pts: string[] = [];
  const steps = 48;
  for (let i = 0; i <= steps + 6; i++) {
    const t = (i / steps) * Math.PI * 2 - Math.PI / 2;
    const wobble = 1 + 0.035 * Math.sin(i * 1.7);
    const x = c.x + Math.cos(t) * rx * wobble;
    const y = c.y + Math.sin(t) * ry * wobble;
    pts.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

export function roundedRectPath(r: Rect, radius = 10): string {
  const rr = Math.min(radius, r.w / 2, r.h / 2);
  const { x, y, w, h } = r;
  return [
    `M${x + rr},${y}`,
    `H${x + w - rr}`,
    `Q${x + w},${y} ${x + w},${y + rr}`,
    `V${y + h - rr}`,
    `Q${x + w},${y + h} ${x + w - rr},${y + h}`,
    `H${x + rr}`,
    `Q${x},${y + h} ${x},${y + h - rr}`,
    `V${y + rr}`,
    `Q${x},${y} ${x + rr},${y}`,
    "Z",
  ].join(" ");
}

/** Wavy underline beneath a rect. */
export function underlinePath(r: Rect, amplitude = 3, wavelength = 14): string {
  const y = r.y + r.h + 5;
  const parts = [`M${r.x.toFixed(1)},${y.toFixed(1)}`];
  for (let x = r.x; x < r.x + r.w; x += wavelength) {
    const mid = Math.min(x + wavelength / 2, r.x + r.w);
    const end = Math.min(x + wavelength, r.x + r.w);
    const dy = ((x - r.x) / wavelength) % 2 === 0 ? amplitude : -amplitude;
    parts.push(`Q${mid.toFixed(1)},${(y + dy).toFixed(1)} ${end.toFixed(1)},${y.toFixed(1)}`);
  }
  return parts.join(" ");
}

/** Point on the rect's border closest to `from` (so arrows stop at the edge). */
export function edgePoint(r: Rect, from: Pt, gap = 6): Pt {
  const c = center(r);
  const dx = from.x - c.x;
  const dy = from.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const sx = dx !== 0 ? (r.w / 2 + gap) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (r.h / 2 + gap) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/**
 * Pick a start point for an arrow: from the side of the screen with the most
 * room, ~140px away, so the arrow never starts off-screen.
 */
export function arrowStart(r: Rect, viewport: { w: number; h: number }, distance = 140): Pt {
  const c = center(r);
  const room = {
    left: r.x,
    right: viewport.w - (r.x + r.w),
    top: r.y,
    bottom: viewport.h - (r.y + r.h),
  };
  const best = (Object.keys(room) as (keyof typeof room)[]).reduce((a, b) => (room[b] > room[a] ? b : a));
  const d = Math.min(distance, Math.max(40, room[best] - 12));
  let p: Pt;
  switch (best) {
    case "left":
      p = { x: r.x - d, y: c.y + d * 0.35 };
      break;
    case "right":
      p = { x: r.x + r.w + d, y: c.y + d * 0.35 };
      break;
    case "top":
      p = { x: c.x - d * 0.35, y: r.y - d };
      break;
    default:
      p = { x: c.x - d * 0.35, y: r.y + r.h + d };
  }
  // The sideways offset can push the start past an edge near corners.
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(viewport.w - margin, p.x)),
    y: Math.max(margin, Math.min(viewport.h - margin, p.y)),
  };
}

/** Curved arrow shaft (quadratic bezier) + arrowhead, as two path strings. */
export function arrowPaths(from: Pt, to: Pt, head = 12): { shaft: string; head: string } {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  // Bend perpendicular to the line, 18% of its length.
  const cx = mx - (dy / len) * len * 0.18;
  const cy = my + (dx / len) * len * 0.18;
  const shaft = `M${from.x.toFixed(1)},${from.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`;
  // Tangent at the end of a quadratic bezier = to - control.
  const tx = to.x - cx;
  const ty = to.y - cy;
  const tl = Math.hypot(tx, ty) || 1;
  const ux = tx / tl;
  const uy = ty / tl;
  const left = { x: to.x - ux * head - uy * head * 0.55, y: to.y - uy * head + ux * head * 0.55 };
  const right = { x: to.x - ux * head + uy * head * 0.55, y: to.y - uy * head - ux * head * 0.55 };
  const headPath = `M${left.x.toFixed(1)},${left.y.toFixed(1)} L${to.x.toFixed(1)},${to.y.toFixed(1)} L${right.x.toFixed(1)},${right.y.toFixed(1)}`;
  return { shaft, head: headPath };
}

/** Point along a quadratic bezier — used to fly the Hey Geo cursor (like the macOS app). */
export function bezierPoint(from: Pt, ctrl: Pt, to: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * from.x + 2 * u * t * ctrl.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * ctrl.y + t * t * to.y,
  };
}

/** Control point for a natural-looking arc between two points (bulges upward). */
export function arcControl(from: Pt, to: Pt): Pt {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  return { x: mx, y: my - Math.min(220, dist * 0.35) };
}

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Place a tooltip next to a rect without leaving the viewport. */
export function tooltipPosition(
  r: Rect,
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  gap = 10
): Pt {
  let x = r.x + r.w / 2 - size.w / 2;
  let y = r.y - size.h - gap; // above by default
  if (y < 8) y = r.y + r.h + gap; // flip below
  x = Math.max(8, Math.min(viewport.w - size.w - 8, x));
  y = Math.max(8, Math.min(viewport.h - size.h - 8, y));
  return { x, y };
}

export function isOnScreen(r: Rect, viewport: { w: number; h: number }): boolean {
  return r.x + r.w > 0 && r.y + r.h > 0 && r.x < viewport.w && r.y < viewport.h && r.w > 0 && r.h > 0;
}

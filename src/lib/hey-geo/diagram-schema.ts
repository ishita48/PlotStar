/**
 * Hey Geo whiteboard — diagram spec.
 * ───────────────────────────────
 * The model never emits SVG or code. It describes a drawing with a small set
 * of primitives (sketch), a node/edge graph (flowchart) or sampled points
 * (plot). Everything is validated, clamped and size-capped here, then drawn
 * stroke-by-stroke by the whiteboard renderer.
 *
 * Sketch coordinates live on a 400 × 300 canvas, origin top-left.
 */

import { z } from "zod";

export const CANVAS_W = 400;
export const CANVAS_H = 300;

/**
 * Colours: accept #rgb, #rrggbb and #rrggbbaa (models like adding alpha) and
 * normalise to #rrggbb — the renderer applies its own translucency. Anything
 * else becomes "no colour" (palette default) instead of rejecting the shape.
 */
export function normalizeHex(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(v.trim());
  if (!m) return undefined;
  const h = m[1];
  if (h.length === 3) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toUpperCase();
  return `#${h.slice(0, 6)}`.toUpperCase();
}
const color = z.preprocess(normalizeHex, z.string().optional());
const X = z.number().min(-50).max(CANVAS_W + 50);
const Y = z.number().min(-50).max(CANVAS_H + 50);
/** Flat [x1, y1, x2, y2, …] list. */
const pts = (min: number, max: number) =>
  z
    .array(z.number().min(-50).max(450))
    .min(min * 2)
    .max(max * 2)
    .refine((a) => a.length % 2 === 0, "points must be x,y pairs");

const style = {
  color,
  fill: color,
  dashed: z.boolean().optional(),
  width: z.number().min(1).max(8).optional(),
  label: z.string().max(40).optional(),
};

export const ShapeSchema = z.discriminatedUnion("shape", [
  z.object({ shape: z.literal("line"), points: pts(2, 2), ...style }),
  z.object({ shape: z.literal("arrow"), points: pts(2, 2), ...style }),
  z.object({ shape: z.literal("polyline"), points: pts(2, 60), ...style }),
  z.object({ shape: z.literal("polygon"), points: pts(3, 30), ...style }),
  z.object({ shape: z.literal("curve"), points: pts(3, 60), ...style }),
  z.object({ shape: z.literal("circle"), cx: X, cy: Y, r: z.number().min(1).max(200), ...style }),
  z.object({ shape: z.literal("ellipse"), cx: X, cy: Y, rx: z.number().min(1).max(220), ry: z.number().min(1).max(170), ...style }),
  z.object({ shape: z.literal("rect"), x: X, y: Y, w: z.number().min(1).max(420), h: z.number().min(1).max(320), ...style }),
  /** Circular arc, angles in degrees (0 = +x, counter-clockwise like maths). */
  z.object({
    shape: z.literal("arc"),
    cx: X,
    cy: Y,
    r: z.number().min(2).max(200),
    start: z.number().min(-720).max(720),
    end: z.number().min(-720).max(720),
    ...style,
  }),
  /** Right-angle square at a vertex; `angle` = direction of one leg in degrees. */
  z.object({ shape: z.literal("rightAngle"), x: X, y: Y, size: z.number().min(4).max(40).optional(), angle: z.number().min(-360).max(360).optional(), ...style }),
  z.object({
    shape: z.literal("text"),
    x: X,
    y: Y,
    text: z.string().min(1).max(60),
    size: z.number().min(9).max(28).optional(),
    anchor: z.enum(["start", "middle", "end"]).optional(),
    color,
  }),
]);
export type Shape = z.infer<typeof ShapeSchema>;

export const FlowNodeSchema = z.object({
  id: z.string().min(1).max(20),
  label: z.string().min(1).max(48),
  shape: z.enum(["box", "diamond", "pill", "circle"]).optional(),
  color,
});
export const FlowEdgeSchema = z.object({
  from: z.string().min(1).max(20),
  to: z.string().min(1).max(20),
  label: z.string().max(24).optional(),
});

export const SeriesSchema = z.object({
  label: z.string().max(30).optional(),
  color,
  points: z.array(z.tuple([z.number(), z.number()])).min(2).max(160),
});

export const DiagramSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sketch"),
    title: z.string().max(80).optional(),
    shapes: z.array(ShapeSchema).min(1).max(60),
  }),
  z.object({
    kind: z.literal("flowchart"),
    title: z.string().max(80).optional(),
    direction: z.enum(["TB", "LR"]).optional(),
    nodes: z.array(FlowNodeSchema).min(1).max(16),
    edges: z.array(FlowEdgeSchema).max(28),
  }),
  z.object({
    kind: z.literal("plot"),
    title: z.string().max(80).optional(),
    x: z.tuple([z.number(), z.number()]),
    y: z.tuple([z.number(), z.number()]),
    xLabel: z.string().max(24).optional(),
    yLabel: z.string().max(24).optional(),
    series: z.array(SeriesSchema).min(1).max(4),
    marks: z
      .array(z.object({ x: z.number(), y: z.number(), label: z.string().max(24).optional() }))
      .max(8)
      .optional(),
  }),
]);
export type Diagram = z.infer<typeof DiagramSchema>;

/**
 * Lenient validation: drop individual bad shapes / dangling edges / non-finite
 * points instead of rejecting the whole drawing. Returns null if nothing
 * drawable is left.
 */
export function sanitizeDiagram(raw: unknown): Diagram | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, any>;
  if (d.kind === "sketch") {
    const shapes = (Array.isArray(d.shapes) ? d.shapes : [])
      .map((s: unknown) => ShapeSchema.safeParse(s))
      .filter((r: any) => r.success)
      .map((r: any) => r.data)
      .slice(0, 60);
    const res = DiagramSchema.safeParse({ kind: "sketch", title: d.title, shapes });
    return res.success ? res.data : null;
  }
  if (d.kind === "flowchart") {
    const nodes = (Array.isArray(d.nodes) ? d.nodes : [])
      .map((n: unknown) => FlowNodeSchema.safeParse(n))
      .filter((r: any) => r.success)
      .map((r: any) => r.data);
    const seen = new Set<string>();
    const uniq = nodes.filter((n: any) => (seen.has(n.id) ? false : (seen.add(n.id), true))).slice(0, 16);
    const ids = new Set(uniq.map((n: any) => n.id));
    const edges = (Array.isArray(d.edges) ? d.edges : [])
      .map((e: unknown) => FlowEdgeSchema.safeParse(e))
      .filter((r: any) => r.success && ids.has(r.data.from) && ids.has(r.data.to) && r.data.from !== r.data.to)
      .map((r: any) => r.data)
      .slice(0, 28);
    const res = DiagramSchema.safeParse({ kind: "flowchart", title: d.title, direction: d.direction, nodes: uniq, edges });
    return res.success ? res.data : null;
  }
  if (d.kind === "plot") {
    const series = (Array.isArray(d.series) ? d.series : [])
      .map((s: any) => ({
        ...s,
        points: (Array.isArray(s?.points) ? s.points : []).filter(
          (p: any) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
        ),
      }))
      .map((s: unknown) => SeriesSchema.safeParse(s))
      .filter((r: any) => r.success)
      .map((r: any) => r.data);
    const res = DiagramSchema.safeParse({ ...d, series });
    if (!res.success || res.data.kind !== "plot") return null;
    const p = res.data;
    if (!(p.x[1] > p.x[0]) || !(p.y[1] > p.y[0])) return null;
    return p;
  }
  return null;
}

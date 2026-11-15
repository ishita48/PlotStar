/**
 * Hey Geo — wire protocol between the browser and /api/hey-geo.
 * ───────────────────────────────────────────────────────────────
 * The model never runs code. It returns structured commands which are
 * validated here and then rendered by the annotation engine, the whiteboard
 * or the page's own buttons. Anything that doesn't validate or references an
 * element we didn't send is dropped, never "best-effort" executed.
 *
 * Shared by the server (validating model output) and the client (validating
 * the server response before drawing), so it must stay isomorphic.
 * Ported from HAVEN's Hey Haven; tasks are GeoStar's own (Studio steps and
 * the HAVEN protection controls in Design → Protect / Deploy).
 */

import { z } from "zod";
import { DiagramSchema, normalizeHex, sanitizeDiagram, type Diagram } from "./diagram-schema";

// ── Annotations ──────────────────────────────────────────────────────
export const ANNOTATION_TYPES = ["arrow", "circle", "box", "underline", "highlight", "point", "tooltip"] as const;
export type AnnotationType = (typeof ANNOTATION_TYPES)[number];

/** Where to draw: an id from the DOM snapshot the client sent. (Screenshots are not sent, so no regions.) */
export const TargetSchema = z.object({ kind: z.literal("element"), elementId: z.string().min(1).max(16) });
export type Target = z.infer<typeof TargetSchema>;

const HEX = /^#[0-9a-fA-F]{6}$/;
/** GeoStar greens for normal / safe, blue for "you are here", amber for proposed / warnings, red for hazards. */
export const ANNOTATION_COLORS = ["#1F4A36", "#6FA24E", "#2F6F9F", "#B7791F", "#B3261E", "#101411"];

export const AnnotationSchema = z.object({
  type: z.enum(ANNOTATION_TYPES),
  target: TargetSchema,
  label: z.string().max(80).optional(),
  color: z.preprocess(normalizeHex, z.string().regex(HEX).optional()),
  durationMs: z.number().int().min(1500).max(20000).optional(),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

// ── Browser actions (always proposed, never auto-run when they change something) ──
export const ACTION_TYPES = ["scroll_to", "click", "focus"] as const;
export const ActionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  elementId: z.string().min(1).max(16),
  reason: z.string().max(160),
});
export type BrowserAction = z.infer<typeof ActionSchema>;

// ── GeoStar tasks (carried out with the page's own buttons) ───────────
/** Studio steps and the sub-tabs of the steps that group several pages. */
export const STUDIO_STEPS = [
  "Define", "What to build", "Requirements", "Site", "Review brief",
  "Discover", "Explore", "Analyze", "Compare", "Decide", "Deliver", "Design", "Model", "Protect", "Deploy",
] as const;
/** Top-bar destinations outside the Studio steps. */
export const APP_PAGES = ["deal_desk", "data", "how_ai_works", "live_operations", "home", "agent_graph"] as const;
export type StudioStep = (typeof STUDIO_STEPS)[number];

export const TaskSchema = z.discriminatedUnion("type", [
  /** Open a Studio step or sub-tab (read-only: runs at once). */
  z.object({ type: z.literal("open_step"), step: z.enum(STUDIO_STEPS) }),
  /** Open a top-bar page or the Deal desk (read-only: runs at once). */
  z.object({ type: z.literal("open_page"), page: z.enum(APP_PAGES) }),
  /** Ask GeoStar's Deep Agents team (site evaluation, money, risks, CoStar evidence); the answer is spoken (runs at once). */
  z.object({ type: z.literal("ask_agents"), question: z.string().min(3).max(600) }),
  /** A quick what-if on the brief through the copilot (rack density, cooling, redundancy…): a preview with Apply (runs at once). */
  z.object({ type: z.literal("what_if"), question: z.string().min(3).max(600) }),
  /** Work out a better design for the active concept with the layout engine (a proposal; changes nothing yet). */
  z.object({ type: z.literal("improve_design"), goal: z.string().max(300).default("") }),
  /** Apply the last design proposal to the Studio (asks first). */
  z.object({ type: z.literal("implement_design") }),
  /** Open the live Command Center from Protect (read-only: runs at once). */
  z.object({ type: z.literal("open_command_center") }),
  /** HAVEN protection simulation: start a scenario or reset it (asks twice). */
  z.object({ type: z.literal("trigger_scenario"), scenario: z.enum(["leak", "fire", "usage"]) }),
  z.object({ type: z.literal("reset_simulation") }),
  /** Approve the generated response plan (asks twice). */
  z.object({ type: z.literal("approve_plan") }),
  /** Acknowledge the newest active incident. */
  z.object({ type: z.literal("acknowledge_incident") }),
  /** Record the next maintenance or security step in the Command Center. */
  z.object({ type: z.literal("team_update"), team: z.enum(["maintenance", "security"]) }),
  /** Finish recovery after the incidents are resolved. */
  z.object({ type: z.literal("complete_recovery") }),
  /** Start the Command Center's call: the simulated emergency-services call, or the configured emergency contact (never 911). Asks twice. */
  z.object({ type: z.literal("emergency_call") }),
]);
export type GeoTask = z.infer<typeof TaskSchema>;

// ── Walkthrough ──────────────────────────────────────────────────────
export const ExpectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), elementId: z.string().min(1).max(16) }),
  z.object({ kind: z.literal("view"), view: z.string().max(40) }),
  z.object({ kind: z.literal("user_confirms") }),
]);
export type Expect = z.infer<typeof ExpectSchema>;

export const WalkthroughSchema = z.object({
  goal: z.string().max(160),
  step: z.number().int().min(1).max(30),
  status: z.enum(["continue", "completed", "failed"]),
  expect: ExpectSchema.optional(),
});
export type WalkthroughPlan = z.infer<typeof WalkthroughSchema>;

// ── Do-it-for-me (multi-step work on the page) ───────────────────────
export const ACT_TYPES = ["click", "type", "select", "check", "press", "scroll", "scroll_to", "navigate", "new_tab", "wait", "ask", "done"] as const;
export const ActSchema = z.object({
  type: z.enum(ACT_TYPES),
  elementId: z.string().max(16).optional(),
  text: z.string().max(2000).optional(),
  submit: z.boolean().optional(),
  key: z.enum(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Space"]).optional(),
  direction: z.enum(["up", "down", "top", "bottom"]).optional(),
  checked: z.boolean().optional(),
  url: z
    .string()
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u) || /^\/[a-z]/.test(u), "http(s) or a GeoStar path only")
    .optional(),
  reason: z.string().max(160).default(""),
  risky: z.boolean().optional(),
});
export type Act = z.infer<typeof ActSchema>;
export const ACTS_NEEDING_ELEMENT = new Set<Act["type"]>(["click", "type", "select", "check", "scroll_to"]);

// ── Evacuation plan and reports ──────────────────────────────────────
export const EvacuationSchema = z.object({
  floor: z.number().int().min(-5).max(80).nullable().optional(),
  audience: z.enum(["me", "staff", "building"]).nullable().optional(),
});

export const ReportSchema = z.object({
  title: z.string().min(3).max(120),
  kind: z.enum(["incident", "status", "shift_handoff", "maintenance", "after_action", "other"]).catch("other").default("other"),
  sections: z.array(z.object({ heading: z.string().max(80), text: z.string().max(2400) })).min(1).max(10),
});
export type GeoReport = z.infer<typeof ReportSchema>;

// ── Agent response ───────────────────────────────────────────────────
export const AgentResponseSchema = z.object({
  speech: z.string().min(1).max(900),
  annotations: z.array(AnnotationSchema).max(6).default([]),
  diagram: DiagramSchema.nullable().optional(),
  diagramNear: z.string().max(16).nullable().optional(),
  evacuation: EvacuationSchema.nullable().optional(),
  action: ActionSchema.nullable().optional(),
  scroll: z
    .object({
      direction: z.enum(["up", "down", "top", "bottom"]),
      amount: z.enum(["little", "half", "screen"]).optional(),
    })
    .nullable()
    .optional(),
  tasks: z.array(TaskSchema).max(4).default([]),
  walkthrough: WalkthroughSchema.nullable().optional(),
  report: ReportSchema.nullable().optional(),
  automate: z.object({ goal: z.string().min(3).max(300) }).nullable().optional(),
  act: ActSchema.nullable().optional(),
  lesson: z
    .object({
      status: z.enum(["continue", "done"]),
      item: z.string().max(100).default(""),
      total: z.number().int().min(1).max(60).optional(),
    })
    .nullable()
    .optional(),
});
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

// ── Request (client → server) ────────────────────────────────────────
export const ElementInfoSchema = z.object({
  id: z.string().max(16),
  role: z.string().max(24),
  text: z.string().max(160),
  hint: z.string().max(60).optional(),
  rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  state: z.string().max(40).optional(),
});
export type ElementInfo = z.infer<typeof ElementInfoSchema>;

export const ScreenContextSchema = z.object({
  url: z.string().max(500),
  title: z.string().max(200),
  viewport: z.object({ w: z.number(), h: z.number(), dpr: z.number(), scrollX: z.number(), scrollY: z.number() }),
  elements: z.array(ElementInfoSchema).max(200),
  visibleText: z.string().max(6000),
  selection: z.string().max(2000).optional(),
  /** The element the person pointed at (under the mouse when they spoke, or clicked while Geo listened). */
  pointed: z.string().max(16).optional(),
  app: z
    .object({
      /** The Studio step on screen (define, discover, explore, analyze, deliver, design). */
      role: z.string().max(24).optional(),
      /** The page or sub-tab inside the step. */
      view: z.string().max(40).optional(),
      path: z.string().max(200).optional(),
      /** A HAVEN facility twin is on screen. */
      facility: z.boolean().optional(),
      /** The active concept and selected plan object in the Studio. */
      concept: z.string().max(40).optional(),
      selected: z.string().max(40).optional(),
      /** Whether a design proposal from Geo is waiting to be implemented. */
      proposal: z.string().max(300).optional(),
    })
    .optional(),
});
export type ScreenContext = z.infer<typeof ScreenContextSchema>;

export const AgentRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  mode: z.enum(["assist", "guide"]).default("assist"),
  voice: z.boolean().optional(),
  proactive: z.boolean().optional(),
  tzOffsetMin: z.number().int().min(-840).max(840).optional(),
  context: ScreenContextSchema,
  /** The HAVEN protection state of the facility on screen (simulation), when there is one. */
  protection: z.unknown().optional(),
  /** Reports Geo wrote earlier in this browser (titles only). */
  reports: z.array(z.object({ title: z.string().max(120), kind: z.string().max(24), at: z.string().max(40) })).max(5).optional(),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(1200) }))
    .max(12)
    .default([]),
  walkthrough: z
    .object({
      goal: z.string().max(160),
      step: z.number().int().min(1).max(30),
      observation: z.string().max(300),
    })
    .nullable()
    .optional(),
  agent: z
    .object({
      goal: z.string().max(300),
      step: z.number().int().min(1).max(40),
      log: z.array(z.string().max(300)).max(30).default([]),
    })
    .nullable()
    .optional(),
  lesson: z
    .object({
      goal: z.string().max(300),
      step: z.number().int().min(1).max(60),
      covered: z.array(z.string().max(100)).max(60).default([]),
    })
    .nullable()
    .optional(),
});
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

/**
 * Validate raw model output and drop anything that can't be rendered safely
 * (element targets, actions and expectations that reference unknown ids).
 * Returns null if the core response is unusable.
 */
export function sanitizeAgentResponse(raw: unknown, opts: { knownIds: Set<string> }): AgentResponse | null {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const annotations = Array.isArray(obj.annotations) ? obj.annotations : [];
  const keptAnnotations: Annotation[] = [];
  for (const a of annotations) {
    const parsed = AnnotationSchema.safeParse(a);
    if (!parsed.success || !opts.knownIds.has(parsed.data.target.elementId)) continue;
    keptAnnotations.push(parsed.data);
    if (keptAnnotations.length >= 6) break;
  }

  let action: BrowserAction | null = null;
  const pa = ActionSchema.safeParse(obj.action);
  if (pa.success && opts.knownIds.has(pa.data.elementId)) action = pa.data;

  let walkthrough: WalkthroughPlan | null = null;
  const pw = WalkthroughSchema.safeParse(obj.walkthrough);
  if (pw.success) {
    walkthrough = pw.data;
    const e = walkthrough.expect;
    if (e?.kind === "click" && !opts.knownIds.has(e.elementId)) walkthrough = { ...walkthrough, expect: { kind: "user_confirms" } };
  }

  const diagram: Diagram | null = sanitizeDiagram(obj.diagram);
  const diagramNear = diagram && typeof obj.diagramNear === "string" && opts.knownIds.has(obj.diagramNear) ? obj.diagramNear : null;

  const tasks = (Array.isArray(obj.tasks) ? obj.tasks : [])
    .map((t: unknown) => TaskSchema.safeParse(t))
    .filter((r: any) => r.success)
    .map((r: any) => r.data)
    .slice(0, 4);

  const pick = <T,>(schema: z.ZodType<T>, value: unknown): T | null => {
    const r = schema.safeParse(value);
    return r.success ? (r.data ?? null) : null;
  };
  const scroll = pick(AgentResponseSchema.shape.scroll, obj.scroll);
  const automate = pick(AgentResponseSchema.shape.automate, obj.automate);
  const evacuation = obj.evacuation ? pick(EvacuationSchema, obj.evacuation) : null;
  const report = obj.report ? pick(ReportSchema, obj.report) : null;
  const lesson = pick(AgentResponseSchema.shape.lesson, obj.lesson);

  let act: Act | null = null;
  const pact = ActSchema.safeParse(obj.act);
  if (pact.success) {
    const a = pact.data;
    const elOk = !ACTS_NEEDING_ELEMENT.has(a.type) || (!!a.elementId && opts.knownIds.has(a.elementId));
    const urlOk = !(a.type === "navigate" || a.type === "new_tab") || !!a.url;
    if (elOk && urlOk) act = a;
  }

  const speech = typeof obj.speech === "string" ? obj.speech.trim().slice(0, 900) : "";
  const result = AgentResponseSchema.safeParse({
    speech,
    annotations: keptAnnotations,
    diagram,
    diagramNear,
    evacuation,
    action,
    scroll,
    tasks,
    walkthrough,
    report,
    automate,
    act,
    lesson,
  });
  return result.success ? result.data : null;
}

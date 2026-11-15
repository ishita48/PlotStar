"use client";

/**
 * Hey Geo — GeoStar's on-screen assistant (ported from HAVEN's "Hey Haven", built on StudyO's Buds, inspired by Clicky).
 * ───────────────────────────────────────────────────────────────────────────────────────────────────────────
 * Turn it on (the orb, Alt+G, or say "Hey Geo") and a small cursor follows your mouse. Hold Ctrl+Alt (⌘+⌥ on Mac)
 * and talk, or keep talking in conversation mode, or type. Geo reads the page (and the HAVEN protection state when a
 * facility is on screen), answers out loud with Cartesia, points and circles things, sketches on a whiteboard, draws
 * the evacuation plan from the real protection state, clicks things when you ask, runs GeoStar tasks after you allow
 * them, writes reports, teaches step by step, and does multi-step work on the page.
 *
 * Pieces: src/lib/hey-geo/* and POST /api/hey-geo (Claude, with CoStar redaction) + /api/voice (Cartesia).
 * Mounted once in the Studio (src/components/studio/studio.tsx); it reads everything else from the DOM.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check, ClipboardCopy, Download, Eraser, FileText, Loader2, Map as MapIcon, Mic, Minus, MousePointerClick, Pause, Play, Power,
  Repeat, Send, SkipForward, Square, Volume2, VolumeX, X, Zap,
} from "lucide-react";
import { activeIncidents, responsePlan, type ProtectionState } from "@/lib/haven/engine";
import { collectScreenContext, describeElement, type ElementRegistry } from "@/lib/hey-geo/context";
import { AnnotationEngine, elementResolver, type DrawItem } from "@/lib/hey-geo/engine";
import { Whiteboard } from "@/lib/hey-geo/whiteboard";
import { buildEvacuationPlan, type EvacRequest } from "@/lib/hey-geo/evacuation";
import { AgentResponseSchema, type Act, type AgentResponse, type BrowserAction, type ElementInfo, type GeoReport, type GeoTask } from "@/lib/hey-geo/schema";
import {
  classifyInterruption, isConversationEnd, isLessonEnd, isRunStop, isSleepCommand, mediaRecorderSupported, setInkAvailable, speak,
  speechRecognitionSupported, startPushToTalk, startWakeWord, yesNo, type Listener, type Playback,
} from "@/lib/hey-geo/voice";
import { initialWalk, isWalkActive, looksLikeWalkthroughRequest, walkReducer } from "@/lib/hey-geo/walkthrough";
import { authorizeAction, explicitlyAskedToAct, type ActionDecision } from "@/lib/hey-geo/actions";
import { checkAct, describeAct, performAct, realClick } from "@/lib/hey-geo/automation";
import { isInstant, isReadOnly, needsStrongConfirm, runTask, taskLabel, type TaskStore, type TrackedTask } from "@/lib/hey-geo/tasks";
import { performScroll } from "@/lib/hey-geo/scroll";
import { AUTO_HIDE_MS, FIRST_DELAY_MS, NUDGE_KEY, canNudge, markDismissed, markShown, markUsed, parseNudge, pickNudge, type Nudge, type NudgeState } from "@/lib/hey-geo/nudge";
import { forgetAll, loadMessages, logTask, recentReports, saveMessages, saveReport } from "@/lib/hey-geo/memory";
import { appContext, facilityOnScreen, loadProtection, studioStep } from "@/lib/hey-geo/page";
import { implementDesign, planRect, proposalSummary, proposeDesign, showInEditor, type DesignProposal, type StudioLink } from "@/lib/hey-geo/design-loop";
import { PUBLIC_DATA_API } from "@/lib/plotstar-api";
import { AudioLines, Maximize2 } from "lucide-react";
import { RunTimeline, type RunView } from "./run-timeline";
import type { RunState } from "@/components/sponsors/langchain/use-agent-run";
import "./hey-geo.css";

/** A what-if preview from the copilot (POST /copilot/ask) or the agent team: before → after, applied only on Apply. */
type WhatIf = { patch: Record<string, number | string>; concept: string; changed: { metric: string; before_text: string; after_text: string }[] };
type GuideState = { open: boolean; status: string; speaking: boolean; error: string | null };
const stripMd = (t: string) => t.replace(/[*_`#>]+/g, "").replace(/\[(\d+)\]/g, "").replace(/\s+/g, " ").trim();
const firstSentences = (t: string, n = 2) => (stripMd(t).match(/[^.!?]+[.!?]+/g) ?? [stripMd(t)]).slice(0, n).join(" ").trim();
const DEICTIC = /\b(this|that|these|those|here|it)\b/i;
/** Questions about the project itself go straight to the Deep Agents team (site evaluation, money, risks, CoStar evidence, what-ifs). */
const PROJECT = /\b(what if|viab|financ|npv|payback|irr|capex|opex|build cost|risks?\b|neighbou?rs?|which concept|should we build|recommend|costar|comps\b|dossier|land (?:price|value|cost)|market\b|evaluate|evaluation|carbon|emissions|water use|air cooling|liquid cooling)/i;
const agentRunning = (s: RunState | undefined) => !!s && (s.status === "starting" || s.status === "running" || s.status === "awaiting_approval");
const liveView = (s: RunState): RunView => ({
  status: s.status,
  nodes: s.order.map((id) => s.nodes[id]).filter(Boolean),
  approval: s.approval,
  citations: s.citations ?? [],
  verification: s.verification,
  error: s.error,
});

type Status = "idle" | "listening" | "thinking" | "speaking";
type Msg = { id: string; at: number; role: "user" | "assistant"; text: string; report?: GeoReport; plan?: string[]; from?: string; whatIf?: WhatIf; applied?: boolean; run?: { id: string; view?: RunView } };
type Proposal =
  | { id: string; kind: "task"; task: GeoTask; label: string; strong: boolean; armed: boolean }
  | { id: string; kind: "action"; action: BrowserAction; decision: Extract<ActionDecision, { allowed: true }>; armed: boolean }
  | { id: string; kind: "act"; act: Act; why: string; armed: boolean };
type Run = { goal: string; step: number; log: string[]; status: "running" | "confirm" | "asking" | "done" | "stopped"; note?: string };
type Lesson = { goal: string; step: number; covered: string[]; total?: number; item: string; status: "running" | "paused" | "done" };
type Prefs = { muted: boolean; wake: boolean; converse: boolean; proactive: boolean; ctrlAlt: boolean; engine: "cartesia" | "elevenlabs" };
type Caption = { kind: "listening" | "you" | "geo" | "thinking"; text: string };
type AskOpts = { observation?: string; proactive?: boolean; silent?: boolean };
type Info = { configured: boolean; costarRedacted: boolean; voice: boolean };

const NAME = "Hey Geo";
const ORB = 48;
const POS_KEY = "geostar:hey-geo:pos";
const PREFS_KEY = "geostar:hey-geo:prefs";
const MAX_RUN_STEPS = 25;
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const HOLD_LABEL = IS_MAC ? "⌘+⌥" : "Ctrl+Alt";
const HOLD_MS = 220;
const DEFAULT_PREFS: Prefs = { muted: false, wake: false, converse: true, proactive: true, ctrlAlt: true, engine: "cartesia" };
const CAPTION_HOLD_MS = 7000;
/** Drawers the circle opens (the agent team, the ElevenLabs voice); the circle steps out of their way. */
const OBSTACLES = 'section[aria-label="Ask GeoStar"], section[aria-label^="GeoStar voice guide"]';
const AGENT_TIMEOUT_MS = 180_000;

const SUGGESTIONS: Record<string, string[]> = {
  define: ["Explain this site's hard gates", "Compare the top sites using what's on screen", "Which sites are a good fit?", "Walk me through the CoStar dossier", "Sketch how GeoStar picks a site"],
  discover: ["What does the drone survey add?", "Sketch the survey flow", "Take me to Explore"],
  explore: ["Explain this concept's checks", "Circle anything that fails a check", "Sketch this layout on the whiteboard", "What's in the yard?"],
  analyze: ["Compare the concepts on money, people, planet and resources", "Plot the concepts' scores", "Walk me through deciding step by step"],
  deliver: ["Write a handoff for this concept", "What can I export here?"],
  design: ["Draw the evacuation plan", "Walk me through protecting this facility", "Write an incident report", "Start the water leak simulation", "Open the Command Center"],
  default: ["What can you do here?", "Explain this screen with a flowchart", "Take me to Design"],
};

const uid = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function GeoGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 34 34" className={className} aria-hidden="true">
      <path d="M4 3 L29 15 L17.5 18 L12.5 30 Z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** Two soft notes when a task finishes or the facility changes (like Clicky's ping). */
function chime(urgent = false) {
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    (urgent ? [880, 660, 880] : [660, 880]).forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      const t = ctx.currentTime + i * 0.14;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.1, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.4);
    });
    setTimeout(() => ctx.close(), 1100);
  } catch {}
}

/** With the panel open, drawings go beside it (the whiteboard tries the right, then the left of this rect). */
function panelAnchor() {
  const r = document.querySelector(".hg-panel")?.getBoundingClientRect();
  return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
}

function reportText(r: GeoReport) {
  return `${r.title}\n${"=".repeat(Math.min(r.title.length, 60))}\n\n${r.sections.map((s) => `${s.heading}\n${s.text}`).join("\n\n")}\n\nWritten by Geo (GeoStar). Check figures against the screen before sharing.\n`;
}

/** Where the "Ask GeoStar" pill last was, so the circle keeps its place beside it while that panel is open. */
let lastPill: { right: number; bottom: number } | null = null;

/**
 * Home: bottom-right, above the Studio's sticky footer (Back / Continue), side by side with the "Ask GeoStar" pill:
 * the circle sits just left of it, on the same line. Without the pill it takes the corner itself.
 */
function homePos() {
  if (typeof window === "undefined") return { right: 20, bottom: 76 };
  const foot = Array.from(document.querySelectorAll("footer.st-foot, footer")).map((f) => f.getBoundingClientRect()).find((r) => r.height > 0 && r.bottom >= innerHeight - 2 && r.top > innerHeight * 0.6);
  const lift = foot ? Math.round(innerHeight - foot.top) : 0;
  const pill = document.querySelector('button[aria-label="Open Ask GeoStar"]')?.getBoundingClientRect();
  if (pill && pill.width > 0) {
    lastPill = {
      right: Math.round(innerWidth - pill.left + 10),
      // Centred on the pill's line, and never lower than the top of the footer.
      bottom: Math.max(lift + 6, Math.round(innerHeight - pill.bottom - (ORB - pill.height) / 2)),
    };
    return lastPill;
  }
  // The Ask GeoStar panel is open (its pill is gone): stay where the circle was; it steps aside if the panel covers it.
  if (lastPill && document.querySelector('section[aria-label="Ask GeoStar"]')) return lastPill;
  return { right: innerWidth <= 640 ? 12 : 20, bottom: lift + 14 };
}

function clampPos(p: { right: number; bottom: number }) {
  if (typeof window === "undefined") return p;
  return {
    right: Math.max(8, Math.min(window.innerWidth - ORB - 8, p.right)),
    bottom: Math.max(8, Math.min(window.innerHeight - ORB - 8, p.bottom)),
  };
}

/** The live-safety key of a protection state: which incidents are active and where the plan stands. */
function incidentKey(s: ProtectionState | null): string | null {
  if (!s) return null;
  const active = activeIncidents(s).filter((i) => i.kind === "fire" || i.kind === "leak");
  if (!active.length) return "clear";
  return `${active.map((i) => i.id).sort().join("+")}:${responsePlan(s)?.status ?? "none"}`;
}

export function HeyGeo({ studio }: { studio?: StudioLink } = {}) {
  const studioRef = useRef(studio);
  studioRef.current = studio;
  const [designProposal, setDesignProposal] = useState<DesignProposal | null>(null);
  const designRef = useRef(designProposal);
  designRef.current = designProposal;
  const [guide, setGuide] = useState<GuideState | null>(null);
  const [orbError, setOrbError] = useState(false);
  /** Dragged by the person: stays where they put it; otherwise it follows the footer. */
  const [pinned, setPinned] = useState(false);
  const pointedRef = useRef<Element | null>(null);
  const hoverRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const [fonts, setFonts] = useState<{ sans: string; mono: string }>({ sans: "", mono: "" });
  const [active, setActive] = useState(false);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [partial, setPartial] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [drawCount, setDrawCount] = useState(0);
  const [boardOpen, setBoardOpen] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [tasks, setTasks] = useState<TrackedTask[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [walk, dispatchWalk] = useReducer(walkReducer, initialWalk);
  const [pos, setPos] = useState<{ right: number; bottom: number }>({ right: 20, bottom: 126 });
  const [dodge, setDodge] = useState<{ right: number; bottom: number } | null>(null);
  const [nudge, setNudge] = useState<Nudge | null>(null);
  const [caption, setCaption] = useState<Caption | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [protection, setProtection] = useState<ProtectionState | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const threadRef = useRef(`geo${Math.random().toString(36).slice(2, 12)}`);
  const [, setViewport] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<AnnotationEngine | null>(null);
  const boardRef = useRef<Whiteboard | null>(null);
  const registryRef = useRef<ElementRegistry>(new Map());
  const elementsRef = useRef<Map<string, ElementInfo>>(new Map());
  const listenerRef = useRef<Listener | null>(null);
  const wakeRef = useRef<{ stop: () => void } | null>(null);
  const playbackRef = useRef<Playback | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchCleanupRef = useRef<(() => void) | null>(null);
  const holdRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; listening: boolean } | null>(null);
  const orbRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Latest-value refs for callbacks that outlive renders.
  const protRef = useRef(protection);
  protRef.current = protection;
  const walkRef = useRef(walk);
  walkRef.current = walk;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const activeRef = useRef(active);
  activeRef.current = active;
  const openRef = useRef(open);
  openRef.current = open;
  const runRef = useRef(run);
  runRef.current = run;
  const lessonRef = useRef(lesson);
  lessonRef.current = lesson;
  const proposalsRef = useRef(proposals);
  proposalsRef.current = proposals;

  const voiceInSupported = useMemo(() => typeof window !== "undefined" && (mediaRecorderSupported() || speechRecognitionSupported()), []);
  const wakeSupported = useMemo(() => typeof window !== "undefined" && speechRecognitionSupported(), []);

  // ── Mount ────────────────────────────────────────────────────────────
  useEffect(() => {
    setMounted(true);
    // The Studio loads Geist as --ps-sans / --ps-mono on its wrapper; the portal under <body> borrows them.
    const host = document.querySelector(".st") ?? document.body;
    const cs = getComputedStyle(host);
    setFonts({ sans: cs.getPropertyValue("--ps-sans").trim(), mono: cs.getPropertyValue("--ps-mono").trim() });
    const engine = new AnnotationEngine({ onChange: setDrawCount, host: () => rootRef.current });
    engineRef.current = engine;
    boardRef.current = new Whiteboard({
      host: () => rootRef.current,
      onPen: (p) => {
        engine.penTo(p);
        engine.setMood(p ? "drawing" : "idle");
      },
      onClose: () => setBoardOpen(false),
    });
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      if (p && typeof p.right === "number" && typeof p.bottom === "number") {
        setPos(clampPos(p));
        setPinned(true);
      } else setPos(clampPos(homePos()));
      const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
      if (saved) setPrefs({ ...DEFAULT_PREFS, ...saved });
    } catch {
      setPos(clampPos(homePos()));
    }
    setMessages(loadMessages<Omit<Msg, "at">>().map((m) => ({ ...m, id: m.id || uid() })) as Msg[]);
    fetch("/api/hey-geo", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Info>) : null))
      .then((v) => v && setInfo(v))
      .catch(() => {});
    fetch("/api/voice/status", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ stt?: boolean }>) : null))
      .then((v) => setInkAvailable(!!v?.stt))
      .catch(() => setInkAvailable(false));
    const onResize = () => {
      setViewport((n) => n + 1);
      setPos((p) => clampPos(p));
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      engine.destroy();
      boardRef.current?.close();
      listenerRef.current?.cancel();
      wakeRef.current?.stop();
      playbackRef.current?.stop();
      abortRef.current?.abort();
      watchCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (mounted) saveMessages(messages);
  }, [messages, mounted]);

  // ── What's on the page: the Studio step, and the facility's protection state (read-only, polled) ──
  useEffect(() => {
    let alive = true;
    let busy = false;
    const tick = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        setStep(studioStep().step);
        const id = facilityOnScreen();
        if (!id) {
          if (protRef.current) setProtection(null);
          return;
        }
        const s = await loadProtection(id);
        if (!alive || !s) return;
        const prev = protRef.current;
        if (!prev || prev.facility.id !== s.facility.id || prev.revision !== s.revision) setProtection(s);
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  // ── Home above the footer, and out of the way of the drawers it opens (agent team, ElevenLabs voice) ──
  useEffect(() => {
    const check = () => {
      const vw = innerWidth;
      const vh = innerHeight;
      if (!pinned) {
        const home = clampPos(homePos());
        if (home.right !== pos.right || home.bottom !== pos.bottom) {
          setPos(home);
          return;
        }
      }
      const orb = { left: vw - pos.right - ORB, top: vh - pos.bottom - ORB, right: vw - pos.right, bottom: vh - pos.bottom };
      let next: { right: number; bottom: number } | null = null;
      for (const el of Array.from(document.querySelectorAll(OBSTACLES))) {
        const r = el.getBoundingClientRect();
        if (r.width < 2) continue;
        const hit = orb.left < r.right + 6 && orb.right > r.left - 6 && orb.top < r.bottom + 6 && orb.bottom > r.top - 6;
        if (!hit) continue;
        // Tall drawers: step to their left; short ones: sit above.
        const left = vw - r.left + 10;
        next = r.height > vh * 0.5 && left + ORB + 8 <= vw ? { right: left, bottom: pos.bottom } : { right: pos.right, bottom: Math.min(vh - ORB - 8, vh - r.top + 10) };
        break;
      }
      setDodge((d) => (d?.right === next?.right && d?.bottom === next?.bottom ? d : next));
    };
    check();
    const timer = setInterval(check, 400);
    return () => clearInterval(timer);
  }, [pos, pinned]);

  // The ElevenLabs voice (when chosen) reports its state; the circle shows it.
  useEffect(() => {
    const onState = (e: Event) => setGuide((e as CustomEvent<GuideState>).detail ?? null);
    window.addEventListener("geostar:guide-state", onState);
    return () => window.removeEventListener("geostar:guide-state", onState);
  }, []);

  // Point and ask: remember where the mouse is (outside Geo's own UI).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest?.("[data-geo-ui]")) return;
      hoverRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, partial, open, proposals, walk.status, run, lesson]);

  const place = dodge ?? pos;
  useEffect(() => {
    const r = orbRef.current?.getBoundingClientRect();
    if (r) engineRef.current?.setOrigin({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }, [place.right, place.bottom, open, mounted]);

  useEffect(() => {
    if (!boardRef.current?.open || status !== "idle") engineRef.current?.setMood(status);
  }, [status]);

  const addMessage = useCallback((m: Omit<Msg, "id" | "at">) => setMessages((list) => [...list, { ...m, id: uid(), at: Date.now() }].slice(-30)), []);

  /** The element under the mouse right now (or within the last 20 s), outside Geo's own UI. */
  const elementUnderMouse = useCallback((): Element | null => {
    const h = hoverRef.current;
    if (!h || Date.now() - h.t > 20_000) return null;
    return document.elementsFromPoint(h.x, h.y).find((el) => !el.closest("[data-geo-ui]") && el !== document.body && el !== document.documentElement) ?? null;
  }, []);

  /** Mark the pointed element so the person sees what Geo will talk about. */
  const markPointed = useCallback((el: Element | null) => {
    pointedRef.current = el;
    if (el) engineRef.current?.draw([{ type: "box", resolve: elementResolver(el), color: "#6FA24E", label: "this", durationMs: 5000 }]);
  }, []);

  // While Geo listens, a click on the page picks the subject ("what is this?") instead of pressing it.
  useEffect(() => {
    if (status !== "listening") return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || t.closest("[data-geo-ui], [data-guide-ui]")) return;
      e.preventDefault();
      e.stopPropagation();
      markPointed(t);
    };
    const swallow = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t && !t.closest("[data-geo-ui], [data-guide-ui]")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("click", swallow, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("click", swallow, true);
    };
  }, [status, markPointed]);

  // ── Speech bubble next to the cursor, and the caption by the orb ─────
  const showSay = useCallback((text: string | null, holdMs = 0) => {
    if (sayTimerRef.current) clearTimeout(sayTimerRef.current);
    sayTimerRef.current = null;
    const engine = engineRef.current;
    if (!engine) return;
    if (!text || openRef.current || !activeRef.current) {
      engine.say(null);
      return;
    }
    engine.say(text);
    if (holdMs) sayTimerRef.current = setTimeout(() => engine.say(null), holdMs);
  }, []);

  const showCaption = useCallback((next: Caption | null, holdMs = 0) => {
    if (captionTimerRef.current) clearTimeout(captionTimerRef.current);
    captionTimerRef.current = null;
    setCaption(next);
    if (next && holdMs) captionTimerRef.current = setTimeout(() => setCaption(null), holdMs);
  }, []);

  const stopSpeaking = useCallback(() => {
    playbackRef.current?.stop();
    playbackRef.current = null;
    setStatus((s) => (s === "speaking" ? "idle" : s));
  }, []);

  /** Speak and resolve when done (immediately when muted). */
  const talk = useCallback((text: string, token: string | null | undefined): Promise<void> => {
    if (prefsRef.current.muted || !text) return Promise.resolve();
    playbackRef.current?.stop();
    setStatus("speaking");
    const pb = speak(text, token);
    playbackRef.current = pb;
    return pb.done.then(() => {
      if (playbackRef.current === pb) {
        playbackRef.current = null;
        setStatus((s) => (s === "speaking" ? "idle" : s));
      }
    });
  }, []);

  // ── On / off ─────────────────────────────────────────────────────────
  const deactivate = useCallback(() => {
    setActive(false);
    activeRef.current = false;
    stopSpeaking();
    listenerRef.current?.cancel();
    listenerRef.current = null;
    abortRef.current?.abort();
    setStatus("idle");
    setPartial("");
    setRun((r) => (r && (r.status === "running" || r.status === "confirm" || r.status === "asking") ? { ...r, status: "stopped", note: "Stopped when Geo was switched off." } : r));
    setLesson((l) => (l && l.status !== "done" ? { ...l, status: "paused" } : l));
    engineRef.current?.companion(false);
    engineRef.current?.clear();
    showSay(null);
    showCaption(null);
  }, [showCaption, showSay, stopSpeaking]);

  /** The facility's protection state, fresh (falls back to the last poll). */
  const freshProtection = useCallback(async (): Promise<ProtectionState | null> => {
    const id = facilityOnScreen();
    if (!id) return protRef.current;
    const s = await Promise.race([loadProtection(id), sleep(1500).then(() => null)]);
    if (s) {
      protRef.current = s;
      setProtection(s);
    }
    return s ?? protRef.current;
  }, []);

  // ── Evacuation plans (drawn from the protection state, never by the model) ───
  const drawEvacuation = useCallback((request: EvacRequest = {}, state: ProtectionState | null = protRef.current): string[] | null => {
    if (!state) {
      setError("Open Design → Protect, or a facility's Command Center under Deploy, to see its evacuation plan.");
      return null;
    }
    try {
      const plan = buildEvacuationPlan(state, request);
      setBoardOpen(true);
      void boardRef.current?.draw(plan.diagram, panelAnchor(), { wide: true, caption: plan.caption, badge: "Evacuation plan" });
      return plan.lines;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't draw the plan.");
      return null;
    }
  }, []);

  const drawReply = useCallback(
    (reply: AgentResponse, state: ProtectionState | null): string[] | null => {
      const engine = engineRef.current;
      if (!engine) return null;
      const items: DrawItem[] = [];
      for (const a of reply.annotations) {
        const el = registryRef.current.get(a.target.elementId);
        if (el) items.push({ type: a.type, resolve: elementResolver(el), color: a.color, label: a.label, durationMs: a.durationMs });
      }
      if (items.length) engine.draw(items);
      if (reply.evacuation) return drawEvacuation({ floor: reply.evacuation.floor ?? null, audience: reply.evacuation.audience ?? null }, state);
      if (reply.diagram && boardRef.current) {
        const near = reply.diagramNear ? registryRef.current.get(reply.diagramNear) : null;
        const anchor = near ? elementResolver(near)() : panelAnchor();
        setBoardOpen(true);
        void boardRef.current.draw(reply.diagram, anchor, { avoid: panelAnchor() });
      }
      return null;
    },
    [drawEvacuation]
  );

  const watchForStep = useCallback((reply: AgentResponse) => {
    watchCleanupRef.current?.();
    watchCleanupRef.current = null;
    const exp = reply.walkthrough?.expect;
    if (!exp || exp.kind === "user_confirms") return;
    if (exp.kind === "click") {
      const el = registryRef.current.get(exp.elementId);
      if (!el) return;
      const onClick = (e: MouseEvent) => {
        const t = e.target as Node | null;
        if (t && (el === t || el.contains(t))) {
          cleanup();
          dispatchWalk({ type: "USER_ACTED", observation: `The user clicked the ${describeElement(el)}.` });
        }
      };
      document.addEventListener("click", onClick, true);
      const cleanup = () => document.removeEventListener("click", onClick, true);
      watchCleanupRef.current = cleanup;
    } else if (exp.kind === "view") {
      // A Studio step or tab ("Protect"): watch what's selected on screen.
      const want = exp.view.replace(/^#/, "").toLowerCase();
      const check = () => {
        const { step: s, view } = studioStep();
        if ((s ?? "").includes(want) || (view ?? "").toLowerCase().includes(want)) {
          cleanup();
          dispatchWalk({ type: "USER_ACTED", observation: `The page switched to "${exp.view}".` });
        }
      };
      const timer = setInterval(check, 400);
      const cleanup = () => clearInterval(timer);
      watchCleanupRef.current = cleanup;
    }
  }, []);

  /** Fly the cursor to a control, then click it like a person would. */
  const flyAndClick = useCallback(async (el: Element) => {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    engineRef.current?.draw([{ type: "point", resolve: elementResolver(el), durationMs: 2000 }]);
    await sleep(700);
    if (el.isConnected) await realClick(el as HTMLElement);
  }, []);

  /** Run an approved click/focus on a live element (cursor flies there first). */
  const performAction = useCallback(
    (action: BrowserAction) => {
      const el = registryRef.current.get(action.elementId) as HTMLElement | undefined;
      if (!el || !el.isConnected) {
        setError("That isn't on screen anymore.");
        return;
      }
      if (action.type === "scroll_to") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (action.type === "focus") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => el.focus?.(), 500);
        return;
      }
      void flyAndClick(el);
    },
    [flyAndClick]
  );

  // ── GeoStar tasks ────────────────────────────────────────────────────
  const store = useMemo<TaskStore>(() => ({ click: (el) => flyAndClick(el) }), [flyAndClick]);

  /**
   * Say something Geo worked out without Claude (an agent answer, the engine's numbers) in the browser's own
   * voice: that text can carry CoStar figures, so it is not sent to a third-party voice service.
   */
  const sayLocal = useCallback(
    (text: string) => {
      showSay(text, 6000);
      showCaption({ kind: "geo", text }, CAPTION_HOLD_MS);
      void talk(text, null);
    },
    [showSay, showCaption, talk]
  );

  const toWhatIf = (p: any): WhatIf | undefined =>
    p?.patch && typeof p.patch === "object"
      ? {
          patch: p.patch,
          concept: String(p.consequences?.concept ?? ""),
          changed: (Array.isArray(p.consequences?.changed) ? p.consequences.changed : []).filter((c: any) => c && c.changed !== false).slice(0, 6),
        }
      : undefined;

  /** Geo's own tasks: the agent team, the what-if copilot and the layout engine's design loop. Null for page tasks. */
  const special = useCallback(
    (t: GeoTask): Promise<{ ok: boolean; detail?: string }> | null => {
      const link = studioRef.current;
      switch (t.type) {
        case "ask_agents":
          // The Studio's shared Deep Agents run: it shows in the status pill, the live graph and LangSmith, and inline here.
          return (async () => {
            const agent = link?.agent;
            if (!agent || !link?.body) return { ok: false, detail: "The agent team works inside the Studio" };
            if (agentRunning(agent.state)) return { ok: false, detail: "The agent team is still on the last question; it shows in the chat" };
            const runId = await agent.start(
              "/agents/chat",
              {
                ...link.body, question: t.question.slice(0, 800), thread_id: threadRef.current, stage: link.stage, market: link.market,
                concept_id: link.conceptId, selected: link.selected ?? null, facility_id: link.facilityId ?? null, last_score: link.lastScore ?? null,
              },
              t.question
            );
            if (!runId) return { ok: false, detail: "Couldn't reach the GeoStar agents. Is the API on port 8000 running?" };
            const msgId = uid();
            setMessages((list) => [...list, { id: msgId, at: Date.now(), role: "assistant" as const, text: "", from: "GeoStar agent team · Deep Agents", run: { id: runId } }].slice(-30));
            setOpen(true);
            // The live view follows the SSE stream; this poll of GET /agents/runs/{id} is the fallback and the finish line.
            const t0 = Date.now();
            for (;;) {
              await sleep(1500);
              const snap = await fetch(`${PUBLIC_DATA_API}/agents/runs/${encodeURIComponent(runId)}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
              if (snap) {
                const view: RunView = { status: snap.status, nodes: snap.nodes ?? [], approval: snap.approval ?? null, citations: snap.citations ?? [], verification: snap.verification ?? null, error: snap.error ?? null };
                const finished = snap.status === "done" || snap.status === "error";
                const answer: string = finished && typeof snap.answer === "string" ? snap.answer : "";
                setMessages((list) =>
                  list.map((m) => (m.id === msgId ? { ...m, run: { id: runId, view }, ...(finished ? { text: answer ? stripMd(answer).slice(0, 2400) : "", whatIf: toWhatIf(snap.proposal) } : {}) } : m))
                );
                if (finished) {
                  if (!answer) return { ok: false, detail: snap.error || "The agent team didn't produce an answer" };
                  sayLocal(firstSentences(answer) + (snap.proposal ? " The before and after is in the chat, with Apply." : ""));
                  return { ok: true, detail: "The agent team answered (open the graph for the full run)" };
                }
              }
              if (Date.now() - t0 > AGENT_TIMEOUT_MS) return { ok: false, detail: "The agent team didn't finish in time; the run is still in the graph" };
            }
          })();
        case "what_if":
          return (async () => {
            if (!link?.body) return { ok: false, detail: "Generate the layouts first, then ask for a what-if" };
            const r = await fetch(`${PUBLIC_DATA_API}/copilot/ask`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...link.body, question: t.question.slice(0, 600), concept_id: link.conceptId, selected: link.selected ?? null, stage: link.stage, market: link.market, thread_id: "hey-geo" }),
            });
            const d = await r.json().catch(() => null);
            if (!r.ok || !d?.answer) return { ok: false, detail: typeof d?.detail === "string" ? d.detail : `The copilot couldn't answer (${r.status})` };
            addMessage({ role: "assistant", text: stripMd(d.answer).slice(0, 1800), from: "GeoStar copilot · what-if", whatIf: toWhatIf(d.proposal) });
            sayLocal(firstSentences(d.answer) + (d.proposal ? " The before and after is in the panel, with Apply." : ""));
            if (d.proposal) setOpen(true);
            return { ok: true, detail: d.proposal ? "Preview ready, nothing applied yet" : "Answered" };
          })();
        case "improve_design":
          return (async () => {
            if (!link) return { ok: false, detail: "Open the Studio first" };
            const p = await proposeDesign(link, t.goal);
            setDesignProposal(p);
            // Ghosts with Accept / Reject in the design editor when it is open; otherwise outlines on the 2D plan.
            if (!showInEditor(p))
              engineRef.current?.draw(
              p.objects.map((o) => ({ type: "box" as const, resolve: () => planRect(o, p.siteD), color: "#6FA24E", label: `+ ${o.name || o.code} (proposed)`, durationMs: 20000 }))
            );
            const line = proposalSummary(p);
            addMessage({ role: "assistant", text: line });
            sayLocal(line);
            setOpen(true);
            return { ok: true, detail: `${p.objects.length} object${p.objects.length === 1 ? "" : "s"} proposed · nothing changed yet` };
          })();
        case "implement_design":
          return (async () => {
            const p = designRef.current;
            if (!p) return { ok: false, detail: "Ask me for a better design first" };
            const how = implementDesign(link ?? null, p);
            if (!how) return { ok: false, detail: "Nothing on this page can apply design edits" };
            setDesignProposal(null);
            engineRef.current?.clear();
            return { ok: true, detail: how === "event" ? "Applied by the design editor" : "Applied; the engine is re-checking the layout" };
          })();
        default:
          return null;
      }
    },
    [addMessage, sayLocal]
  );

  const executeTask = useCallback(
    async (t: GeoTask) => {
      const label = taskLabel(t);
      if (isInstant(t)) {
        const r = await runTask(t, store).catch((e: Error) => ({ ok: false, detail: e.message }));
        if (!r.ok && r.detail) {
          setError(r.detail);
          if (activeRef.current) showSay(r.detail, 4500);
        }
        return;
      }
      const id = uid();
      setTasks((list) => [...list.slice(-5), { id, task: t, label, status: "running", startedAt: Date.now() }]);
      const own = special(t);
      const r = await (own ?? runTask(t, store)).catch((e: Error) => ({ ok: false, detail: e.message || "Something went wrong" }));
      setTasks((list) => list.map((x) => (x.id === id ? { ...x, status: r.ok ? "done" : "failed", detail: r.detail } : x)));
      logTask({ label, type: t.type, status: r.ok ? "done" : "failed", detail: r.detail ?? "" });
      if (r.ok) {
        chime();
        // Geo's own tasks speak their result themselves.
        if (activeRef.current && !own) showSay(`${label}: done.`, 3500);
        void freshProtection();
      } else if (r.detail) {
        setError(`${label}: ${r.detail}`);
        if (activeRef.current) showSay(r.detail, 4500);
      }
    },
    [store, showSay, freshProtection, special]
  );

  const executeTaskRef = useRef(executeTask);
  executeTaskRef.current = executeTask;

  /** Navigation runs now; anything that changes something waits for Allow. */
  const startTasks = useCallback(
    (reply: AgentResponse) => {
      const queued: Proposal[] = [];
      for (const t of reply.tasks) {
        if (isReadOnly(t)) void executeTask(t);
        else queued.push({ id: uid(), kind: "task", task: t, label: taskLabel(t), strong: needsStrongConfirm(t), armed: false });
      }
      if (queued.length) {
        setProposals((list) => [...list, ...queued].slice(-6));
        setOpen(true);
      }
    },
    [executeTask]
  );

  // ── Listening (declared before ask so conversation mode can chain) ────
  const askRef = useRef<(text: string, opts?: AskOpts) => Promise<void>>(async () => {});
  const answerProposalRef = useRef<(id: string, yes: boolean) => void>(() => {});
  const lessonNextRef = useRef<(skip?: boolean) => void>(() => {});
  const stopRunRef = useRef<(note?: string) => void>(() => {});

  const stopListening = useCallback((submit: boolean) => {
    const l = listenerRef.current;
    listenerRef.current = null;
    if (!l) return;
    if (submit) l.stop();
    else l.cancel();
  }, []);

  /** What was said: a reply to a pending card, a lesson control, or a question. */
  const handleUtterance = useCallback(
    (said: string) => {
      if (isSleepCommand(said)) {
        showSay(`Bye! Hold ${HOLD_LABEL} or say “Hey Geo” anytime.`, 2500);
        setTimeout(() => deactivate(), 2200);
        return;
      }
      if (isConversationEnd(said)) {
        updatePrefs({ converse: false });
        showSay("Okay, I'll stop listening after each answer.", 2500);
        return;
      }
      const pending = proposalsRef.current[0];
      const yn = pending ? yesNo(said) : null;
      if (pending && yn) {
        answerProposalRef.current(pending.id, yn === "yes");
        return;
      }
      const r = runRef.current;
      if (r && (r.status === "running" || r.status === "confirm") && isRunStop(said)) {
        stopRunRef.current("Stopped at your request.");
        return;
      }
      const l = lessonRef.current;
      if (l && l.status !== "done") {
        if (isLessonEnd(said)) {
          setLesson(null);
          showSay("Okay, lesson ended.", 2000);
          return;
        }
        const kind = classifyInterruption(said);
        if (kind === "resume" || kind === "next") {
          lessonNextRef.current(kind === "next");
          return;
        }
        if (kind === "pause") {
          setLesson({ ...l, status: "paused" });
          return;
        }
      }
      if (r?.status === "asking") {
        setRun({ ...r, status: "running", log: [...r.log, `${r.step}. The user answered: ${said.slice(0, 200)}`] });
        return;
      }
      // Project questions go straight to the agent team; everything about the screen goes to Geo.
      const link = studioRef.current;
      if (PROJECT.test(said) && link?.agent && link.body && !agentRunning(link.agent.state)) {
        addMessage({ role: "user", text: said });
        showCaption({ kind: "thinking", text: "Asking GeoStar's agent team…" });
        void executeTaskRef.current({ type: "ask_agents", question: said });
        return;
      }
      void askRef.current(said);
    },
    [deactivate, showSay, updatePrefs]
  );

  const startListening = useCallback(
    (mode: "tap" | "hold" | "converse" = "tap", point = false) => {
      if (listenerRef.current) {
        if (mode === "tap") stopListening(true);
        return;
      }
      stopSpeaking();
      setError(null);
      setOrbError(false);
      // Talking with the keyboard shortcut: whatever the mouse is on is the subject ("what is this?").
      if (point) markPointed(elementUnderMouse());
      wakeRef.current?.stop(); // one recogniser at a time
      wakeRef.current = null;
      setStatus("listening");
      setPartial("");
      if (activeRef.current && !openRef.current) showSay("Listening…");
      showCaption({ kind: "listening", text: mode === "hold" ? `Listening… release ${HOLD_LABEL} when you're done` : "Listening…" });
      listenerRef.current = startPushToTalk(
        {
          onPartial: (t) => {
            setPartial(t);
            const isStatus = t === "Listening…" || t === "Transcribing…";
            if (activeRef.current && !openRef.current) showSay(isStatus ? t : `“${t}”`);
            showCaption({ kind: "listening", text: t });
          },
          onFinal: (t) => {
            listenerRef.current = null;
            setPartial("");
            setStatus("idle");
            const said = t.trim();
            if (!said) {
              showSay(null);
              showCaption({ kind: "geo", text: "I didn't catch anything. Try again." }, 2500);
              return;
            }
            showCaption({ kind: "you", text: said });
            handleUtterance(said);
          },
          onError: (msg) => {
            listenerRef.current = null;
            setPartial("");
            setStatus("idle");
            setError(msg);
            setOrbError(true);
            setTimeout(() => setOrbError(false), 5000);
            showSay(null);
            showCaption({ kind: "geo", text: msg }, 8000);
          },
        },
        { hold: mode === "hold", silenceMs: mode === "converse" ? 1000 : 1200 }
      );
    },
    [handleUtterance, showCaption, showSay, stopListening, stopSpeaking, markPointed, elementUnderMouse]
  );
  const startListeningRef = useRef(startListening);
  startListeningRef.current = startListening;

  /** After Geo finishes talking: keep the conversation going if it's on. */
  const listenAgain = useCallback(() => {
    if (activeRef.current && prefsRef.current.converse && voiceInSupported && !walkRef.current.expect) {
      setTimeout(() => {
        if (activeRef.current && !listenerRef.current && !playbackRef.current) startListeningRef.current("converse");
      }, 350);
    }
  }, [voiceInSupported]);

  // ── The core turn ────────────────────────────────────────────────────
  const runStepRef = useRef<(act: Act) => Promise<void>>(async () => {});
  const continueRunRef = useRef<() => void>(() => {});

  const ask = useCallback(
    async (text: string, opts: AskOpts = {}) => {
      const message = text.trim();
      if (!message) return;
      stopSpeaking();
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setError(null);
      setPartial("");
      setStatus("thinking");
      if (activeRef.current && !openRef.current) showSay(opts.proactive ? "Something changed, one moment…" : "Hmm, let me look…");
      if (!opts.silent) showCaption(opts.proactive ? { kind: "thinking", text: "Something changed in the facility, one moment…" } : { kind: "thinking", text: message });

      const w = walkRef.current;
      const r = runRef.current;
      const l = lessonRef.current;
      const inRun = !!r && r.status === "running";
      const inLesson = !!l && l.status === "running" && !!opts.silent;
      const continuing = !!opts.observation && isWalkActive(w);
      if (!continuing && !inRun && !inLesson && !opts.proactive) {
        addMessage({ role: "user", text: message });
        if (isWalkActive(w)) {
          watchCleanupRef.current?.();
          dispatchWalk({ type: "CANCEL" });
        }
      }
      const guide = !inRun && !inLesson && (continuing || (!isWalkActive(w) && looksLikeWalkthroughRequest(message)));
      if (guide && !continuing) dispatchWalk({ type: "START", goal: message.slice(0, 160) });

      try {
        const state = await freshProtection();
        // Point and ask: what the person pointed at while talking, or the element under the mouse when they type "this".
        const pointed = pointedRef.current ?? (!inRun && !inLesson && DEICTIC.test(message) ? elementUnderMouse() : null);
        pointedRef.current = null;
        const link = studioRef.current;
        const dp = designRef.current;
        const app = {
          ...appContext(),
          ...(link?.conceptId ? { concept: link.conceptId.slice(0, 40) } : {}),
          ...(link?.selected ? { selected: link.selected.slice(0, 40) } : {}),
          ...(dp ? { proposal: `${dp.objects.map((o) => o.code).join(", ")} for ${dp.conceptName}; failing checks ${dp.failingBefore} → ${dp.failingAfter}`.slice(0, 300) } : {}),
        };
        const { context, registry } = collectScreenContext({ app, withValues: inRun, pointed });
        registryRef.current = registry;
        elementsRef.current = new Map(context.elements.map((e) => [e.id, e]));
        dispatchWalk({ type: "CONTEXT_COLLECTED" });

        // The conversation so far, without this question (it is sent as PERSON).
        let past = messagesRef.current;
        if (past.at(-1)?.role === "user" && past.at(-1)?.text === message) past = past.slice(0, -1);
        const history = past.slice(-8).map((m) => ({ role: m.role, text: m.text.slice(0, 1200) }));
        const res = await fetch("/api/hey-geo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: ac.signal,
          body: JSON.stringify({
            message: continuing ? `(continue the walkthrough) ${message}` : message.slice(0, 2000),
            mode: guide ? "guide" : "assist",
            voice: activeRef.current && prefsRef.current.converse && !prefsRef.current.muted,
            proactive: !!opts.proactive,
            tzOffsetMin: new Date().getTimezoneOffset(),
            context,
            protection: state,
            reports: recentReports(),
            history,
            walkthrough: guide ? { goal: (continuing && w.goal) || message.slice(0, 160), step: continuing ? Math.max(1, w.step) : 1, observation: opts.observation || "Starting, nothing done yet." } : null,
            agent: inRun ? { goal: r!.goal, step: r!.step, log: r!.log.slice(-30) } : null,
            lesson: l && (inLesson || l.status === "running") ? { goal: l.goal, step: l.step, covered: l.covered.slice(-60) } : null,
          }),
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || `${NAME} hit an error (${res.status})`);
        }

        // Newline-delimited JSON: the spoken line first (start talking), then the full reply.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        let spoken: Promise<void> | null = null;
        let final: { reply: unknown; voiceToken: string | null } | null = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, nl).trim();
            buffered = buffered.slice(nl + 1);
            if (!line) continue;
            const event = JSON.parse(line) as { type: string; speech?: string; voiceToken?: string | null; reply?: unknown; error?: string };
            if (event.type === "speech" && event.speech && !spoken && !ac.signal.aborted) {
              showSay(event.speech);
              showCaption({ kind: "geo", text: event.speech });
              spoken = talk(event.speech, event.voiceToken);
            } else if (event.type === "final") final = { reply: event.reply, voiceToken: event.voiceToken ?? null };
            else if (event.type === "error") throw new Error(event.error || "Geo couldn't answer.");
          }
        }
        if (ac.signal.aborted) return;
        if (!final) throw new Error(`${NAME}'s reply was cut off, try again.`);
        const parsed = AgentResponseSchema.safeParse(final.reply);
        if (!parsed.success) throw new Error(`${NAME}'s reply didn't make sense, try asking again.`);
        const reply = parsed.data;

        if (reply.scroll) performScroll(reply.scroll);
        const planLines = drawReply(reply, state);
        if (!inRun) startTasks(reply);
        if (!inRun || reply.act?.type === "done" || reply.act?.type === "ask") {
          addMessage({ role: "assistant", text: reply.speech, ...(planLines ? { plan: planLines } : {}), ...(reply.report ? { report: reply.report } : {}) });
        }
        if (reply.report) {
          saveReport(reply.report);
          chime();
        }

        if (guide && reply.walkthrough) {
          dispatchWalk({ type: "AGENT_REPLIED", goal: reply.walkthrough.goal, step: reply.walkthrough.step, status: reply.walkthrough.status, expect: reply.walkthrough.expect });
          if (reply.walkthrough.status === "continue") {
            dispatchWalk({ type: "GUIDANCE_SHOWN" });
            watchForStep(reply);
          } else {
            watchCleanupRef.current?.();
            watchCleanupRef.current = null;
          }
        } else if (guide) {
          dispatchWalk({ type: "AGENT_REPLIED", goal: message, step: 1, status: "completed" });
        }

        // Clicks: run straight away only when explicitly asked and harmless; otherwise propose.
        if (reply.action) {
          const decision = authorizeAction(reply.action, elementsRef.current.get(reply.action.elementId));
          if (decision.allowed) {
            if (decision.confirm === "none" || (decision.confirm === "simple" && explicitlyAskedToAct(message))) performAction(reply.action);
            else {
              setProposals((list) => [...list, { id: uid(), kind: "action" as const, action: reply.action!, decision, armed: false }].slice(-6));
              setOpen(true);
            }
          }
        }

        if (reply.lesson) {
          const prev = lessonRef.current;
          const base = prev && (inLesson || prev.status === "running") ? prev : { goal: message.slice(0, 300), step: 1, covered: [] as string[], item: "", status: "running" as const };
          setLesson({
            ...base,
            item: reply.lesson.item,
            total: reply.lesson.total ?? base.total,
            covered: reply.lesson.item ? [...base.covered, reply.lesson.item].slice(-60) : base.covered,
            status: reply.lesson.status === "done" ? "done" : "running",
          });
        }

        if (reply.automate && !inRun) setRun({ goal: reply.automate.goal, step: 1, log: [], status: "running" });

        if (!spoken) {
          showSay(reply.speech);
          spoken = talk(reply.speech, final.voiceToken);
        }
        showCaption({ kind: "geo", text: reply.speech });
        setStatus((s) => (s === "thinking" ? "idle" : s));
        const stepDone = inRun && reply.act ? runStepRef.current(reply.act) : Promise.resolve();
        await Promise.all([spoken, stepDone]);
        if (abortRef.current !== ac) return;
        showSay(reply.speech, 4000);
        showCaption({ kind: "geo", text: reply.speech }, CAPTION_HOLD_MS);
        if (reply.lesson?.status === "continue" && lessonRef.current?.status === "running") {
          if (prefsRef.current.muted) await sleep(Math.min(9000, 2500 + reply.speech.length * 35));
          if (lessonRef.current?.status === "running") lessonNextRef.current();
          return;
        }
        if ((reply.automate && !inRun) || inRun) {
          continueRunRef.current();
          return;
        }
        listenAgain();
      } catch (e: any) {
        if (e?.name === "AbortError" || ac.signal.aborted || abortRef.current !== ac) return;
        setStatus("idle");
        const msg = e?.message || "Something went wrong.";
        setError(msg);
        showSay(msg, 4000);
        showCaption({ kind: "geo", text: msg }, 5000);
        if (isWalkActive(walkRef.current)) dispatchWalk({ type: "ERROR", message: msg });
        if (runRef.current?.status === "running") setRun({ ...runRef.current, status: "stopped", note: msg });
      }
    },
    [addMessage, drawReply, freshProtection, listenAgain, performAction, showCaption, showSay, startTasks, stopSpeaking, talk, watchForStep, elementUnderMouse]
  );
  askRef.current = ask;

  // ── Do it for me: one step at a time, re-reading the page after each ──
  const executeAct = useCallback(async (act: Act) => {
    const r = runRef.current;
    if (!r) return;
    const info = act.elementId ? elementsRef.current.get(act.elementId) : undefined;
    const el = act.elementId ? registryRef.current.get(act.elementId) : undefined;
    let detail: string;
    if (act.type === "navigate" || act.type === "new_tab") {
      const url = act.url ?? "";
      if (/^\/[a-z]/.test(url) && act.type === "navigate") {
        // Leaving /studio ends this run (the assistant lives on the Studio).
        window.location.assign(url);
        detail = "opened";
      } else {
        window.open(url, "_blank", "noopener");
        detail = "opened in a new tab (I can't see inside other tabs)";
      }
      await sleep(1200);
    } else if (act.type === "scroll") {
      performScroll({ direction: act.direction ?? "down", amount: "screen" });
      await sleep(500);
      detail = "scrolled";
    } else if (act.type === "wait") {
      await sleep(1500);
      detail = "waited";
    } else {
      if (el) engineRef.current?.draw([{ type: "point", resolve: elementResolver(el), durationMs: 1800 }]);
      await sleep(450);
      const result = await performAct(act, el);
      detail = result.ok ? result.detail : `failed: ${result.detail}`;
      await sleep(700);
    }
    setRun((cur) => (cur ? { ...cur, step: cur.step + 1, log: [...cur.log, `${cur.step}. ${describeAct(act, info)} → ${detail}`].slice(-30) } : cur));
  }, []);

  runStepRef.current = async (act: Act) => {
    const r = runRef.current;
    if (!r || r.status !== "running") return;
    if (act.type === "done") {
      setRun({ ...r, status: "done" });
      chime();
      logTask({ label: `Did: ${r.goal}`.slice(0, 120), type: "automate", status: "done", detail: `${r.step - 1} steps` });
      return;
    }
    if (act.type === "ask") {
      setRun({ ...r, status: "asking" });
      setOpen(true);
      return;
    }
    if (r.step > MAX_RUN_STEPS) {
      setRun({ ...r, status: "stopped", note: `Stopped after ${MAX_RUN_STEPS} steps.` });
      return;
    }
    const said = describeAct(act, act.elementId ? elementsRef.current.get(act.elementId) : undefined);
    if (r.log.slice(-3).filter((x) => x.includes(said)).length >= 2) {
      setRun({ ...r, status: "stopped", note: "I was going round in circles, so I stopped. Tell me what to try instead." });
      return;
    }
    const check = checkAct(act, act.elementId ? elementsRef.current.get(act.elementId) : undefined, act.elementId ? registryRef.current.get(act.elementId) : undefined);
    if (!check.ok) {
      setRun({ ...r, step: r.step + 1, log: [...r.log, `${r.step}. Refused: ${check.why}`] });
      return;
    }
    if (check.confirm) {
      setRun({ ...r, status: "confirm" });
      setProposals((list) => [...list, { id: uid(), kind: "act" as const, act, why: check.why, armed: false }].slice(-6));
      setOpen(true);
      return;
    }
    await executeAct(act);
  };

  continueRunRef.current = () => {
    const r = runRef.current;
    if (!r || r.status !== "running" || !activeRef.current) return;
    void askRef.current(r.goal);
  };

  useEffect(() => {
    if (run?.status === "running" && run.log.at(-1)?.includes("The user answered")) continueRunRef.current();
  }, [run]);

  stopRunRef.current = (note = "Stopped.") => {
    abortRef.current?.abort();
    setRun((r) => (r ? { ...r, status: "stopped", note } : r));
    setProposals((list) => list.filter((p) => p.kind !== "act"));
    stopSpeaking();
    setStatus("idle");
  };

  lessonNextRef.current = (skip = false) => {
    const l = lessonRef.current;
    if (!l || l.status === "done") return;
    const next = { ...l, step: l.step + 1, status: "running" as const };
    setLesson(next);
    lessonRef.current = next;
    void askRef.current(skip ? "Skip ahead to the next item." : "Continue with the next item.", { silent: true });
  };

  // ── Proposals: Allow / Skip ──────────────────────────────────────────
  answerProposalRef.current = (id: string, yes: boolean) => {
    const p = proposalsRef.current.find((x) => x.id === id);
    if (!p) return;
    const strong = p.kind === "task" ? p.strong : p.kind === "action" ? p.decision.confirm === "strong" : false;
    if (yes && strong && !p.armed) {
      setProposals((list) => list.map((x) => (x.id === id ? { ...x, armed: true } : x)));
      showSay("Say yes again, or tap “Yes, really do it”.", 3500);
      return;
    }
    setProposals((list) => list.filter((x) => x.id !== id));
    if (p.kind === "task") {
      if (yes) void executeTask(p.task);
      else logTask({ label: p.label, type: p.task.type, status: "skipped", detail: "Skipped by the user" });
      return;
    }
    if (p.kind === "action") {
      if (yes) performAction(p.action);
      return;
    }
    const r = runRef.current;
    if (!r) return;
    if (yes) {
      setRun({ ...r, status: "running" });
      runRef.current = { ...r, status: "running" };
      void executeAct(p.act).then(() => continueRunRef.current());
    } else {
      const next = { ...r, status: "running" as const, step: r.step + 1, log: [...r.log, `${r.step}. The user skipped: ${describeAct(p.act)}`] };
      setRun(next);
      runRef.current = next;
      continueRunRef.current();
    }
  };

  const activate = useCallback(
    async (opts: { greet?: boolean; listen?: boolean } = {}) => {
      if (!activeRef.current) {
        setActive(true);
        activeRef.current = true;
        engineRef.current?.companion(true);
        if (opts.greet) showSay(`Hi! I'm Geo. Hold ${HOLD_LABEL} and talk, or just ask.`, opts.listen ? 0 : 4500);
      }
      if (opts.listen && voiceInSupported) startListeningRef.current("converse");
    },
    [showSay, voiceInSupported]
  );

  // Continue the walkthrough once the user has acted (observed, not timed).
  useEffect(() => {
    if (walk.status !== "verifying" || !walk.observation) return;
    let cancelled = false;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!cancelled) void ask(walk.observation!, { observation: walk.observation! });
      })
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walk.status, walk.observation]);

  // ── Keyboard: Alt+G on/off · hold Ctrl+Alt (⌘+⌥) to talk · Esc ──
  useEffect(() => {
    const holding = (e: KeyboardEvent) => (IS_MAC ? e.metaKey : e.ctrlKey) && e.altKey;
    const onDown = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === "KeyG" || e.key === "g" || e.key === "G")) {
        e.preventDefault();
        if (activeRef.current) deactivate();
        else {
          void activate({ greet: true });
          setOpen(true);
        }
        return;
      }
      // Ctrl+Alt (⌘+⌥) on their own: hold to talk, or tap to turn Geo on and listen. Real chords and AltGr typing don't count.
      if (prefsRef.current.ctrlAlt && holding(e) && ["Control", "Alt", "Meta"].includes(e.key)) {
        // With the ElevenLabs voice chosen, the shortcut starts / ends that conversation instead.
        if (prefsRef.current.engine === "elevenlabs") {
          if (!e.repeat) holdRef.current = { listening: true, timer: null };
          return;
        }
        if (!holdRef.current && !e.repeat) {
          holdRef.current = {
            listening: false,
            timer: setTimeout(() => {
              if (!holdRef.current) return;
              holdRef.current.listening = true;
              void activate();
              startListeningRef.current("hold", true);
            }, HOLD_MS),
          };
        }
        return;
      }
      if (holdRef.current && !["Control", "Alt", "Meta"].includes(e.key)) {
        if (holdRef.current.timer) clearTimeout(holdRef.current.timer);
        if (holdRef.current.listening) stopListening(false);
        holdRef.current = null;
        setStatus((s) => (s === "listening" ? "idle" : s));
      }
      if (e.key === "Escape") {
        if (runRef.current?.status === "running" || runRef.current?.status === "confirm") stopRunRef.current("Stopped (Esc).");
        else if (engineRef.current && engineRef.current.count > 0) engineRef.current.clear();
        else if (boardRef.current?.open) boardRef.current.close();
        else if (playbackRef.current) stopSpeaking();
      }
    };
    const onUp = (e: KeyboardEvent) => {
      const h = holdRef.current;
      if (!h) return;
      if (!holding(e)) {
        if (h.timer) clearTimeout(h.timer);
        holdRef.current = null;
        if (prefsRef.current.engine === "elevenlabs") {
          window.dispatchEvent(new CustomEvent("geostar:guide", { detail: { action: "toggle" } }));
          return;
        }
        if (h.listening) stopListening(true);
        else if (listenerRef.current) stopListening(true);
        else {
          void activate();
          startListeningRef.current("tap", true);
        }
      }
    };
    const onBlur = () => {
      const h = holdRef.current;
      if (h?.timer) clearTimeout(h.timer);
      if (h?.listening) stopListening(true);
      holdRef.current = null;
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [activate, deactivate, stopListening, stopSpeaking]);

  // Wake word ("Hey Geo"), only while the user has switched it on.
  useEffect(() => {
    if (!prefs.wake || status === "listening") return;
    const handle = startWakeWord({
      onWake: (command) => {
        void activate({ greet: !command, listen: !command });
        if (command) handleUtterance(command);
      },
      onSleep: () => {
        if (activeRef.current) {
          showSay("Bye! Say “Hey Geo” when you need me.", 2200);
          setTimeout(() => deactivate(), 2000);
        }
      },
      onError: (msg) => {
        updatePrefs({ wake: false });
        setError(msg);
      },
    });
    wakeRef.current = handle;
    return () => {
      handle?.stop();
      if (wakeRef.current === handle) wakeRef.current = null;
    };
  }, [prefs.wake, status, activate, handleUtterance, deactivate, showSay, updatePrefs]);

  // Other parts of GeoStar can hand Geo a question: window event "hey-geo:ask".
  useEffect(() => {
    const onAsk = (e: Event) => {
      const d = (e as CustomEvent<{ text?: string; open?: boolean }>).detail || {};
      const text = String(d.text || "").trim().slice(0, 2000);
      if (!text) return;
      void activate();
      if (d.open !== false) setOpen(true);
      void askRef.current(text);
    };
    window.addEventListener("hey-geo:ask", onAsk);
    return () => window.removeEventListener("hey-geo:ask", onAsk);
  }, [activate]);

  useEffect(() => {
    if (open) engineRef.current?.say(null);
  }, [open]);

  // ── Speaking up by itself: a new simulated incident, an approved plan, all clear ──
  const key = incidentKey(protection);
  const seenRef = useRef<{ facility: string | null; key: string | null }>({ facility: null, key: null });
  useEffect(() => {
    const s = protection;
    if (!s || !key) return;
    const seen = seenRef.current;
    if (seen.facility !== s.facility.id) {
      seenRef.current = { facility: s.facility.id, key };
      return;
    }
    if (seen.key === key) return;
    const before = seen.key;
    seenRef.current = { facility: s.facility.id, key };
    if (!prefsRef.current.proactive) return;
    if (key !== "clear") {
      const isNew = !before || before === "clear" || before.split(":")[0] !== key.split(":")[0];
      const title = responsePlan(s)?.title ?? "Incident";
      chime(isNew);
      if (!activeRef.current) {
        setNudge({
          text: isNew ? `${title} (simulated). Want me to draw the evacuation plan?` : "The response plan was updated. Want me to redraw the evacuation plan?",
          prompt: "Draw the evacuation plan and walk me through it step by step.",
        });
        return;
      }
      drawEvacuation({ audience: "building" }, s);
      const running = !!runRef.current && ["running", "confirm", "asking"].includes(runRef.current.status);
      if (running) addMessage({ role: "assistant", text: isNew ? `New simulated incident: ${title}. I've drawn the evacuation plan.` : "The response plan changed; I've redrawn the evacuation plan." });
      else
        void askRef.current(
          isNew
            ? `(Automatic) A new simulated incident just started: ${title}. Tell me what's happening and what to do now.`
            : `(Automatic) The response plan was just ${responsePlan(s)?.status === "approved" ? "approved" : "updated"}. Tell me what changed.`,
          { proactive: true }
        );
    } else if (before && before !== "clear") {
      chime();
      if (boardRef.current?.open) boardRef.current.close();
      if (activeRef.current) {
        const text = "All clear: the simulated incident is resolved. Follow any final instructions from staff on site.";
        showSay(text, 6000);
        addMessage({ role: "assistant", text });
      }
    }
  }, [key, protection, drawEvacuation, showSay, addMessage]);

  // ── Nudges: now and then, a tip by the orb while Geo is off ──────────
  const readNudge = () => {
    try {
      return parseNudge(localStorage.getItem(NUDGE_KEY));
    } catch {
      return parseNudge(null);
    }
  };
  const writeNudge = (s: NudgeState) => {
    try {
      localStorage.setItem(NUDGE_KEY, JSON.stringify(s));
    } catch {}
  };
  const incidentOn = !!key && key !== "clear";

  useEffect(() => {
    if (active) {
      setNudge(null);
      writeNudge(markUsed(readNudge()));
    }
  }, [active]);

  useEffect(() => {
    if (active || open) return;
    let timer: ReturnType<typeof setTimeout>;
    const tryShow = () => {
      const now = Date.now();
      const s = readNudge();
      if (!canNudge(s, now)) return;
      const otherDialog = !!document.querySelector(OBSTACLES) || Array.from(document.querySelectorAll('[role="dialog"]')).some((el) => !el.closest("[data-geo-ui]"));
      if (document.hidden || otherDialog) {
        timer = setTimeout(tryShow, 30_000);
        return;
      }
      writeNudge(markShown(s, now));
      setNudge(pickNudge(studioStep().step, incidentOn, now / 1000));
    };
    timer = setTimeout(tryShow, FIRST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [incidentOn, active, open]);

  useEffect(() => {
    if (!nudge) return;
    const t = setTimeout(() => setNudge(null), incidentOn ? AUTO_HIDE_MS * 3 : AUTO_HIDE_MS);
    return () => clearTimeout(t);
  }, [nudge, incidentOn]);

  const acceptNudge = () => {
    const n = nudge;
    setNudge(null);
    if (!n) return;
    void activate();
    setOpen(true);
    if (/evacuation plan/i.test(n.prompt) && protRef.current) setTimeout(() => drawEvacuation({ audience: "building" }), 80);
    void askRef.current(n.prompt);
  };
  const dismissNudge = () => {
    setNudge(null);
    writeNudge(markDismissed(readNudge(), Date.now()));
  };

  const forget = useCallback(() => {
    setMessages([]);
    forgetAll();
    showSay("Okay, I've forgotten our conversation.", 2500);
  }, [showSay]);

  // ── Orb: click opens the panel, drag moves it ────────────────────────
  const drag = useRef<{ x: number; y: number; right: number; bottom: number; moved: boolean; long: boolean; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  const onOrbPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const d = { x: e.clientX, y: e.clientY, right: place.right, bottom: place.bottom, moved: false, long: false, timer: null as ReturnType<typeof setTimeout> | null };
    // Press and hold the circle: open the chat popover.
    d.timer = setTimeout(() => {
      if (drag.current === d && !d.moved) {
        d.long = true;
        togglePanel();
      }
    }, 550);
    drag.current = d;
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {}
  };
  const onOrbPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    if (d.timer) clearTimeout(d.timer);
    setPinned(true);
    setPos(clampPos({ right: d.right - dx, bottom: d.bottom - dy }));
  };
  const closePanel = (refocus = true) => {
    setOpen(false);
    if (refocus) orbRef.current?.focus();
  };
  const togglePanel = () => {
    if (openRef.current) {
      closePanel(false);
      return;
    }
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 60);
  };
  /** The circle: click to talk (again to send), or start / end the ElevenLabs conversation when that voice is chosen. */
  const orbClick = () => {
    if (prefsRef.current.engine === "elevenlabs") {
      window.dispatchEvent(new CustomEvent("geostar:guide", { detail: { action: "toggle" } }));
      return;
    }
    if (!voiceInSupported) {
      togglePanel();
      return;
    }
    if (listenerRef.current) {
      stopListening(true);
      return;
    }
    if (playbackRef.current) {
      stopSpeaking();
      return;
    }
    void activate();
    startListening("tap");
  };
  const onOrbPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.timer) clearTimeout(d.timer);
    if (d.long) return;
    if (d.moved) {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(pos));
      } catch {}
      return;
    }
    orbClick();
  };

  if (!mounted) return null;

  // ── Render ───────────────────────────────────────────────────────────
  const busy = status === "thinking";
  const runActive = !!run && (run.status === "running" || run.status === "confirm" || run.status === "asking");
  const statusLabel =
    status === "listening"
      ? "Listening…"
      : status === "thinking"
        ? runActive
          ? `Working · step ${run!.step}`
          : "Thinking…"
        : status === "speaking"
          ? "Speaking"
          : boardOpen
            ? "Drawing on the whiteboard"
            : drawCount > 0
              ? "Pointing on your screen"
              : active
                ? prefs.ctrlAlt
                  ? `On · tap or hold ${HOLD_LABEL} to talk`
                  : "On · tap the mic to talk"
                : prefs.wake
                  ? "Say “Hey Geo”"
                  : `Off · click the circle or hold ${HOLD_LABEL}`;

  const eleven = prefs.engine === "elevenlabs";
  const orbStatus: Status | "error" =
    orbError || (eleven && !!guide?.error && guide.open)
      ? "error"
      : eleven && guide?.open
        ? guide.status === "connecting"
          ? "thinking"
          : guide.speaking
            ? "speaking"
            : guide.status === "connected"
              ? "listening"
              : "idle"
        : status === "idle" && agentRunning(studio?.agent?.state)
          ? "thinking"
          : status;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const orbLeft = vw - place.right - ORB;
  const orbTop = vh - place.bottom - ORB;
  const panelOnLeft = orbLeft > vw / 2;
  const panelAbove = orbTop > vh / 2;
  /** Popovers open from the circle and always stay inside the window, whatever their width. */
  const floatAt = (width: number): React.CSSProperties => {
    const w = Math.min(width, vw - 24);
    const left = panelOnLeft ? vw - Math.max(12, place.right) - w : Math.max(12, orbLeft);
    return {
      left: Math.max(12, Math.min(vw - w - 12, left)),
      ...(panelAbove ? { bottom: place.bottom + ORB + 12 } : { top: orbTop + ORB + 12 }),
    };
  };
  const floatStyle = floatAt(320);
  const panelStyle: React.CSSProperties = {
    ...floatAt(360),
    maxHeight: Math.max(240, Math.min(500, (panelAbove ? vh - (place.bottom + ORB + 12) : vh - (orbTop + ORB + 12)) - 12)),
  };
  const suggestions = SUGGESTIONS[step ?? ""] ?? SUGGESTIONS.default;
  const rootStyle = { ...(fonts.sans ? { "--hg-sans": fonts.sans } : {}), ...(fonts.mono ? { "--hg-mono": fonts.mono } : {}) } as React.CSSProperties;

  return createPortal(
    <div data-geo-ui data-geo-root className="hg-root" ref={rootRef} style={rootStyle}>
      {open && (
        <div
          role="dialog"
          aria-label="Hey Geo assistant"
          aria-modal="false"
          id="hey-geo-panel"
          onKeyDown={(e) => {
            if (e.key === "Escape" && !e.defaultPrevented) {
              e.preventDefault();
              closePanel();
            }
          }}
          style={panelStyle}
          className={`hg-panel ${panelAbove ? "hg-from-below" : "hg-from-above"}`}
        >
          <div className="hg-head">
            <div className="hg-avatar">
              <GeoGlyph className="hg-avatar-glyph" />
              <StatusDot status={status} drawing={drawCount > 0 || boardOpen} />
            </div>
            <div className="hg-title">
              <div className="hg-name">{NAME}</div>
              <div className="hg-status" aria-live="polite">
                {statusLabel}
              </div>
            </div>
            <IconBtn title={active ? "Turn Geo off (Alt+G)" : "Turn Geo on (Alt+G)"} onClick={() => (active ? deactivate() : void activate({ greet: true }))} on={active}>
              <Power size={14} />
            </IconBtn>
            {protection && (
              <IconBtn
                title="Draw the evacuation plan"
                onClick={() => {
                  const lines = drawEvacuation({ audience: "building" });
                  if (lines) addMessage({ role: "assistant", text: "Here's the evacuation plan, drawn from the facility's protection state (simulation).", plan: lines });
                }}
              >
                <MapIcon size={14} />
              </IconBtn>
            )}
            {(drawCount > 0 || boardOpen) && (
              <IconBtn
                title="Clear drawings (Esc)"
                onClick={() => {
                  engineRef.current?.clear();
                  boardRef.current?.close();
                }}
              >
                <Eraser size={14} />
              </IconBtn>
            )}
            {status === "speaking" && (
              <IconBtn title="Stop talking" onClick={stopSpeaking}>
                <Square size={12} />
              </IconBtn>
            )}
            <IconBtn
              title={prefs.muted ? "Unmute voice" : "Mute voice"}
              onClick={() => {
                if (!prefs.muted) stopSpeaking();
                updatePrefs({ muted: !prefs.muted });
              }}
            >
              {prefs.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </IconBtn>
            <IconBtn
              title="Open the live agent graph (Deep Agents)"
              onClick={() => {
                closePanel(false);
                studioRef.current?.openGraph?.();
              }}
            >
              <Maximize2 size={13} />
            </IconBtn>
            <IconBtn title="Close Hey Geo" onClick={() => closePanel()}>
              <Minus size={14} />
            </IconBtn>
          </div>

          <div ref={scrollRef} className="hg-body">
            {messages.length === 0 && (
              <div className="hg-intro">
                <p>
                  Hi, I’m Geo. Click the circle and talk, hold <kbd>{HOLD_LABEL}</kbd> anywhere (point at something and ask “what is this?”), say “Hey Geo”, or
                  type. I explain what’s on screen, compare sites and concepts with the numbers shown, ask GeoStar’s agent team, propose better layouts,
                  sketch and point, and click around for you. I always ask before I change anything.
                </p>
                <div className="hg-chips">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        void activate();
                        handleUtterance(s);
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={m.role === "user" ? "hg-row hg-row-user" : "hg-row"}>
                <div className={m.role === "user" ? "hg-bubble hg-bubble-user" : "hg-bubble"}>
                  {m.from && <div className="hg-from">{m.from}</div>}
                  {m.text}
                  {m.plan && (
                    <ul className="hg-plan">
                      {m.plan.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  )}
                  {m.run && (
                    <RunTimeline
                      run={
                        studio?.agent && studio.agent.state.runId === m.run.id
                          ? liveView(studio.agent.state)
                          : (m.run.view ?? { status: "starting", nodes: [], approval: null, citations: [], verification: null, error: null })
                      }
                      onDecide={studio?.agent && studio.agent.state.runId === m.run.id ? (ok) => void studio.agent!.decide(ok) : undefined}
                      onOpenGraph={studio?.openGraph}
                    />
                  )}
                  {m.report && <ReportCard report={m.report} />}
                  {m.whatIf && (
                    <WhatIfCard
                      w={m.whatIf}
                      applied={!!m.applied}
                      canApply={!!studio?.applyPatch}
                      onApply={() => {
                        studioRef.current?.applyPatch?.(m.whatIf!.patch);
                        setMessages((list) => list.map((x) => (x.id === m.id ? { ...x, applied: true } : x)));
                        logTask({ label: "Applied a what-if", type: "what_if", status: "done", detail: Object.keys(m.whatIf!.patch).join(", ") });
                      }}
                    />
                  )}
                </div>
              </div>
            ))}
            {partial && (
              <div className="hg-row hg-row-user">
                <div className="hg-bubble hg-bubble-partial">{partial}</div>
              </div>
            )}
            {busy && (
              <div className="hg-busy">
                <Loader2 size={14} className="hg-spin" /> {statusLabel}
              </div>
            )}

            {designProposal && (
              <div className="hg-card hg-card-ask">
                <div className="hg-card-head">
                  <span>
                    <Zap size={12} /> Design proposal · {designProposal.conceptName}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setDesignProposal(null);
                      engineRef.current?.clear();
                    }}
                  >
                    Dismiss
                  </button>
                </div>
                <div className="hg-card-text">
                  Add {designProposal.objects.map((o) => `${o.name || o.code} (${Math.round(o.w)} × ${Math.round(o.d)} m)`).join(", ")}
                </div>
                <div className="hg-card-sub">{designProposal.reason}</div>
                <table className="hg-diff">
                  <thead>
                    <tr>
                      <th>Engine numbers</th>
                      <th>Now</th>
                      <th>Proposed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {designProposal.diffs.map((d) => (
                      <tr key={d.label} data-better={d.better === null ? "same" : d.better ? "yes" : "no"}>
                        <td>{d.label}</td>
                        <td>{d.before}</td>
                        <td>{d.after}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="hg-card-sub">Estimated by GeoStar's layout engine; proposed by {designProposal.source}. Ghost outlines show on the 2D plan.</div>
                <div className="hg-card-row">
                  <button type="button" className="hg-btn" onClick={() => void executeTask({ type: "implement_design" })}>
                    Implement the design
                  </button>
                </div>
              </div>
            )}

            {walk.status !== "idle" && (
              <div className="hg-card">
                <div className="hg-card-head">
                  <span>{walk.status === "completed" ? "Walkthrough complete" : walk.status === "failed" ? "Walkthrough stopped" : `Step ${walk.step}`}</span>
                  <button
                    type="button"
                    onClick={() => {
                      watchCleanupRef.current?.();
                      watchCleanupRef.current = null;
                      dispatchWalk({ type: "CANCEL" });
                      engineRef.current?.clear();
                    }}
                  >
                    {isWalkActive(walk) ? "Stop" : "Dismiss"}
                  </button>
                </div>
                <div className="hg-card-text">{walk.goal}</div>
                {walk.status === "waiting_for_user" && (
                  <div className="hg-card-row">
                    <span>{walk.expect?.kind === "click" ? "Click the highlighted control…" : walk.expect?.kind === "view" ? `Open ${walk.expect.view}…` : "Do this step, then tell me."}</span>
                    <button
                      type="button"
                      className="hg-btn"
                      onClick={() => {
                        watchCleanupRef.current?.();
                        watchCleanupRef.current = null;
                        dispatchWalk({ type: "USER_ACTED", observation: "The user says they finished this step." });
                      }}
                    >
                      <Check size={12} /> I did it
                    </button>
                  </div>
                )}
                {walk.status === "verifying" && (
                  <div className="hg-card-row">
                    <span>
                      <Loader2 size={12} className="hg-spin" /> Checking your screen…
                    </span>
                  </div>
                )}
                {walk.status === "failed" && walk.error && <div className="hg-card-error">{walk.error}</div>}
              </div>
            )}

            {lesson && (
              <div className="hg-card">
                <div className="hg-card-head">
                  <span>{lesson.status === "done" ? "Lesson complete" : `Step ${lesson.covered.length}${lesson.total ? ` of ${lesson.total}` : ""}${lesson.item ? ` · ${lesson.item}` : ""}`}</span>
                  <button type="button" onClick={() => setLesson(null)}>
                    {lesson.status === "done" ? "Dismiss" : "End"}
                  </button>
                </div>
                <div className="hg-card-text">{lesson.goal}</div>
                {lesson.status !== "done" && (
                  <div className="hg-card-row">
                    {lesson.status === "paused" ? (
                      <button type="button" className="hg-btn" onClick={() => lessonNextRef.current()}>
                        <Play size={12} /> Continue
                      </button>
                    ) : (
                      <button type="button" className="hg-btn hg-btn-quiet" onClick={() => setLesson({ ...lesson, status: "paused" })}>
                        <Pause size={12} /> Pause
                      </button>
                    )}
                    <button type="button" className="hg-btn hg-btn-quiet" onClick={() => lessonNextRef.current(true)}>
                      <SkipForward size={12} /> Next
                    </button>
                  </div>
                )}
              </div>
            )}

            {run && (
              <div className="hg-card">
                <div className="hg-card-head">
                  <span>
                    <Zap size={12} /> {run.status === "done" ? "Done" : run.status === "stopped" ? "Stopped" : run.status === "asking" ? "Needs your answer" : `Doing it · step ${run.step}`}
                  </span>
                  <button type="button" onClick={() => (runActive ? stopRunRef.current("Stopped.") : setRun(null))}>
                    {runActive ? "Stop" : "Dismiss"}
                  </button>
                </div>
                <div className="hg-card-text">{run.goal}</div>
                {run.log.length > 0 && (
                  <ol className="hg-steps">
                    {run.log.slice(-6).map((line, i) => (
                      <li key={i}>{line.replace(/^\d+\.\s*/, "")}</li>
                    ))}
                  </ol>
                )}
                {run.status === "asking" && (
                  <div className="hg-card-row">
                    <span>Type or say your answer below.</span>
                  </div>
                )}
                {run.note && <div className="hg-card-error">{run.note}</div>}
              </div>
            )}

            {proposals.map((p) => {
              const strong = p.kind === "task" ? p.strong : p.kind === "action" ? p.decision.confirm === "strong" : false;
              const title = p.kind === "task" ? p.label : p.kind === "action" ? p.decision.summary : describeAct(p.act, p.act.elementId ? elementsRef.current.get(p.act.elementId) : undefined);
              const why =
                p.kind === "task"
                  ? strong
                    ? "This changes what everyone on this facility sees, or places a call. Allow it only if you mean it."
                    : "Runs through the page's own controls."
                  : p.kind === "action"
                    ? p.action.reason
                    : p.why;
              return (
                <div key={p.id} className={strong ? "hg-card hg-card-strong" : "hg-card hg-card-ask"}>
                  <div className="hg-card-head">
                    <span>
                      <MousePointerClick size={12} /> Geo can do this for you
                    </span>
                  </div>
                  <div className="hg-card-text">{title}</div>
                  <div className="hg-card-sub">{why}</div>
                  <div className="hg-card-row">
                    <button type="button" className={p.armed ? "hg-btn hg-btn-danger" : "hg-btn"} onClick={() => answerProposalRef.current(p.id, true)}>
                      {p.armed ? "Yes, really do it" : "Allow"}
                    </button>
                    <button type="button" className="hg-btn hg-btn-quiet" onClick={() => answerProposalRef.current(p.id, false)}>
                      Skip
                    </button>
                  </div>
                </div>
              );
            })}

            {error && (
              <div className="hg-error" role="alert">
                {error}
              </div>
            )}
          </div>

          <div className="hg-toggles">
            {wakeSupported && (
              <Toggle on={prefs.wake} onClick={() => updatePrefs({ wake: !prefs.wake })} title="Listen for “Hey Geo” while this is on">
                <Mic size={12} /> {prefs.wake ? "“Hey Geo” on" : "“Hey Geo” off"}
              </Toggle>
            )}
            {voiceInSupported && (
              <Toggle on={prefs.converse} onClick={() => updatePrefs({ converse: !prefs.converse })} title="After answering, keep listening so you can talk back and forth">
                <Repeat size={12} /> Conversation
              </Toggle>
            )}
            {voiceInSupported && (
              <Toggle on={prefs.ctrlAlt} onClick={() => updatePrefs({ ctrlAlt: !prefs.ctrlAlt })} title={`Tap ${HOLD_LABEL} to turn Geo on and talk, or hold it while you speak`}>
                <Mic size={12} /> {HOLD_LABEL} to talk
              </Toggle>
            )}
            <Toggle on={prefs.proactive} onClick={() => updatePrefs({ proactive: !prefs.proactive })} title="When a simulated incident starts or a plan is approved: draw the evacuation plan and speak up (while Geo is on), or offer to (while it's off)">
              <Zap size={12} /> Speak up on incidents
            </Toggle>
            <Toggle
              on={eleven}
              onClick={() => {
                if (eleven) window.dispatchEvent(new CustomEvent("geostar:guide", { detail: { action: "stop" } }));
                updatePrefs({ engine: eleven ? "cartesia" : "elevenlabs" });
              }}
              title="Geo's voice engine: Cartesia (Geo's own pipeline: Claude with CoStar redaction, Cartesia Ink and Sonic) or ElevenLabs (the GeoStar voice guide agent)"
            >
              <AudioLines size={12} /> Voice: {eleven ? "ElevenLabs" : "Cartesia"}
            </Toggle>
            {messages.length > 0 && (
              <Toggle on={false} onClick={forget} title="Forget this conversation, the task log and reports in this browser">
                <X size={12} /> Forget
              </Toggle>
            )}
          </div>
          {info?.costarRedacted && <p className="hg-privacy">CoStar names, addresses, prices and coordinates are hidden from the AI. Numbers and gate results still reach it.</p>}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const t = input;
              setInput("");
              void activate();
              handleUtterance(t);
            }}
            className="hg-form"
          >
            {voiceInSupported && (
              <button
                type="button"
                onClick={() => {
                  void activate();
                  startListening("tap");
                }}
                title={status === "listening" ? "Stop and send" : `Talk (or hold ${HOLD_LABEL})`}
                aria-label={status === "listening" ? "Stop and send" : "Talk to Geo"}
                aria-pressed={status === "listening"}
                className={status === "listening" ? "hg-mic hg-mic-on" : "hg-mic"}
              >
                <Mic size={16} />
              </button>
            )}
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={run?.status === "asking" ? "Your answer…" : "Ask Geo, or tell it what to do…"}
              aria-label="Message Geo"
              maxLength={2000}
            />
            <button type="submit" disabled={!input.trim() || busy} title="Send" aria-label="Send" className="hg-send">
              {busy ? <Loader2 size={16} className="hg-spin" /> : <Send size={16} />}
            </button>
          </form>
        </div>
      )}

      {/* Caption by the orb (panel closed): listening, what you said, what Geo says */}
      {caption && !open && (
        <div role="status" aria-live="polite" style={floatStyle} className={`hg-caption ${panelAbove ? "hg-from-below" : "hg-from-above"}`} data-kind={caption.kind}>
          <div className="hg-caption-head">
            {caption.kind === "listening" ? (
              <>
                <span className="hg-wave" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>{" "}
                Listening
              </>
            ) : caption.kind === "thinking" ? (
              <>
                <Loader2 size={12} className="hg-spin" /> You asked · thinking
              </>
            ) : caption.kind === "you" ? (
              "You said"
            ) : (
              <>
                <GeoGlyph className="hg-caption-glyph" /> Geo
              </>
            )}
            <button type="button" aria-label="Hide" onClick={() => showCaption(null)}>
              <X size={11} />
            </button>
          </div>
          <p>{caption.text === "Listening…" ? `Go ahead, I'm listening.${prefs.ctrlAlt ? ` Tap ${HOLD_LABEL} to send.` : ""}` : caption.text}</p>
          <button type="button" className="hg-caption-open" onClick={() => setOpen(true)}>
            Open chat
          </button>
        </div>
      )}

      {/* Task tray (panel closed) */}
      {!open && !caption && tasks.length > 0 && (
        <div style={floatAt(280)} className={`hg-tray ${panelAbove ? "hg-from-below" : "hg-from-above"}`}>
          {tasks.map((t) => (
            <div key={t.id} className="hg-tray-item">
              {t.status === "running" ? (
                <Loader2 size={14} className="hg-spin" />
              ) : t.status === "done" ? (
                <span className="hg-tick hg-tick-ok">
                  <Check size={10} />
                </span>
              ) : (
                <span className="hg-tick hg-tick-bad">
                  <X size={10} />
                </span>
              )}
              <div className="hg-tray-text">
                <div>{t.label}</div>
                <div className="hg-tray-detail">{t.status === "running" ? "Working through the page…" : t.detail || (t.status === "done" ? "Done" : "Failed")}</div>
              </div>
              {t.status !== "running" && (
                <button type="button" aria-label="Dismiss" onClick={() => setTasks((list) => list.filter((x) => x.id !== t.id))}>
                  <X size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Nudge bubble (panel closed) */}
      {nudge && !active && !open && !caption && (
        <div role="status" style={floatAt(290)} className={`${incidentOn ? "hg-nudge hg-nudge-alert" : "hg-nudge"} ${panelAbove ? "hg-from-below" : "hg-from-above"}`}>
          <div className="hg-avatar hg-avatar-small">
            <GeoGlyph className="hg-avatar-glyph" />
          </div>
          <div className="hg-nudge-body">
            <p>{nudge.text}</p>
            <div>
              <button type="button" className="hg-btn" onClick={acceptNudge}>
                Ask Geo
              </button>
              <button type="button" className="hg-btn hg-btn-quiet" onClick={dismissNudge}>
                Not now
              </button>
            </div>
          </div>
          <button type="button" aria-label="Dismiss" onClick={dismissNudge} className="hg-x">
            <X size={12} />
          </button>
        </div>
      )}

      {/* The one launcher: click = open/close the panel, drag = move */}
      <button
        type="button"
        ref={orbRef}
        onPointerDown={onOrbPointerDown}
        onPointerMove={onOrbPointerMove}
        onPointerUp={onOrbPointerUp}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            // Shift+Enter opens the chat; Enter / Space talk.
            if (e.shiftKey) togglePanel();
            else orbClick();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          togglePanel();
        }}
        style={{ right: place.right, bottom: place.bottom, width: ORB, height: ORB, touchAction: "none" }}
        aria-label={`Hey Geo · hold ${HOLD_LABEL} · click to talk, press and hold for chat`}
        aria-expanded={open}
        aria-controls={open ? "hey-geo-panel" : undefined}
        title={`Hey Geo · hold ${HOLD_LABEL}`}
        className={`hg-orb${active ? " hg-orb-on" : ""}${nudge && !active ? " hg-orb-nudge" : ""}${incidentOn ? " hg-orb-alert" : ""}`}
        data-status={orbStatus}
      >
        <span className="hg-orb-ring" />
        {orbStatus === "speaking" ? (
          <span className="hg-bars" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        ) : orbStatus === "error" ? (
          <span className="hg-orb-bang" aria-hidden="true">
            !
          </span>
        ) : (
          <AudioLines size={20} className="hg-orb-glyph" aria-hidden="true" />
        )}
        {active && orbStatus === "idle" && <StatusDot status={status} drawing={drawCount > 0 || boardOpen} big />}
        {proposals.length > 0 && (
          <span className="hg-count hg-orb-count" title="Waiting for your Allow">
            {proposals.length}
          </span>
        )}
      </button>
    </div>,
    document.body
  );
}

// ── Small pieces ───────────────────────────────────────────────────────
function ReportCard({ report }: { report: GeoReport }) {
  const [copied, setCopied] = useState(false);
  const text = reportText(report);
  return (
    <div className="hg-report">
      <div className="hg-report-title">
        <FileText size={13} /> {report.title}
      </div>
      {report.sections.map((s, i) => (
        <div key={i} className="hg-report-section">
          <strong>{s.heading}</strong>
          <p>{s.text}</p>
        </div>
      ))}
      <div className="hg-card-row">
        <span className="hg-report-saved">Saved in this browser for a week</span>
        <button
          type="button"
          className="hg-btn hg-btn-quiet"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          <ClipboardCopy size={12} /> {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          className="hg-btn hg-btn-quiet"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `${report.title.replace(/[^\w-]+/g, "-").slice(0, 60) || "geostar-report"}.txt`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <Download size={12} /> Download
        </button>
      </div>
    </div>
  );
}

function WhatIfCard({ w, applied, canApply, onApply }: { w: WhatIf; applied: boolean; canApply: boolean; onApply: () => void }) {
  return (
    <div className="hg-report">
      <div className="hg-report-title">
        <Zap size={13} /> Preview{w.concept ? ` · ${w.concept}` : ""}
      </div>
      {w.changed.length > 0 && (
        <table className="hg-diff">
          <tbody>
            {w.changed.map((r) => (
              <tr key={r.metric}>
                <td>{r.metric}</td>
                <td>{r.before_text}</td>
                <td>{r.after_text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="hg-card-row">
        {applied ? (
          <span className="hg-report-saved">
            <Check size={12} /> Applied; the layouts are regenerating
          </span>
        ) : canApply ? (
          <button type="button" className="hg-btn" onClick={onApply}>
            Apply this change
          </button>
        ) : (
          <span className="hg-report-saved">Open the Studio to apply it</span>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status, drawing, big }: { status: Status; drawing: boolean; big?: boolean }) {
  return <span className={`hg-dot${big ? " hg-dot-big" : ""}`} data-status={status === "idle" && drawing ? "drawing" : status} />;
}

function IconBtn({ title, onClick, children, on }: { title: string; onClick: () => void; children: React.ReactNode; on?: boolean }) {
  return (
    <button type="button" title={title} aria-label={title} aria-pressed={on} onClick={onClick} className={on ? "hg-icon hg-icon-on" : "hg-icon"}>
      {children}
    </button>
  );
}

function Toggle({ on, onClick, title, children }: { on: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button type="button" title={title} aria-pressed={on} onClick={onClick} className={on ? "hg-toggle hg-toggle-on" : "hg-toggle"}>
      {children}
    </button>
  );
}

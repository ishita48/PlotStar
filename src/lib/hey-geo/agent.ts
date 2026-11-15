/**
 * Hey Geo — one Claude turn (server only).
 * ─────────────────────────────────────────
 * The person's request + a structured DOM snapshot + the HAVEN protection
 * state on screen + the conversation → a short spoken reply and validated
 * commands. Plain fetch to the Anthropic Messages API (no SDK dependency),
 * streamed so the spoken line goes out as soon as Claude has written it.
 * The system prompt is cached; everything live is in the user turn. Output is
 * JSON only and is sanitised against the ids we actually sent (schema.ts).
 * The caller redacts CoStar data before this runs (redact.ts).
 */

import { APP_MAP, SYSTEM } from "./prompt";
import { NOT_CAUGHT, parseModelReply, speechOnly } from "./reply";
import type { AgentRequest, AgentResponse, ElementInfo } from "./schema";

const API_URL = "https://api.anthropic.com/v1/messages";
export const heyGeoModel = () => process.env.HEY_GEO_MODEL || "claude-sonnet-5-5";
export const heyGeoConfigured = () => !!process.env.ANTHROPIC_API_KEY;

function elementLines(els: ElementInfo[]): string {
  return els
    .map((e) => {
      const [x, y, w, h] = e.rect;
      return `${e.id} ${e.role}${e.hint ? `[${e.hint}]` : ""} "${e.text.replace(/"/g, "'")}" @${x},${y},${w}x${h}${e.state ? ` (${e.state})` : ""}`;
    })
    .join("\n");
}

export type TurnExtra = { now?: string; protection: string; redaction: string | null; reports?: string };

export function buildUserPrompt(req: AgentRequest, extra: TurnExtra): string {
  const c = req.context;
  const parts = [
    `MODE: ${req.mode}`,
    `STEP: ${c.app?.role ?? "unknown"}${c.app?.view ? ` · ${c.app.view}` : ""} (the Studio step on screen)`,
    `PAGE: ${c.title} (${c.app?.path ?? c.url}), viewport ${c.viewport.w}x${c.viewport.h}`,
    extra.now ? `NOW: ${extra.now}` : "",
    extra.redaction ? `REDACTION: on. ${extra.redaction}` : "REDACTION: off (the operator allowed CoStar data to be sent).",
    c.selection ? `SELECTED TEXT (the person highlighted this):\n"""${c.selection}"""` : "",
    c.pointed ? `POINTED: ${c.pointed} (the element under the person's mouse when they spoke, or the one they clicked while you listened)` : "",
    c.app?.concept || c.app?.selected ? `STUDIO: active concept ${c.app?.concept ?? "none"}${c.app?.selected ? `, selected plan object ${c.app.selected}` : ""}` : "",
    c.app?.proposal ? `STUDIO PROPOSAL (from improve_design, waiting for implement_design): ${c.app.proposal}` : "STUDIO PROPOSAL: none",
    req.voice ? "VOICE CHAT: on" : "",
    req.proactive ? "PROACTIVE: on" : "",
    APP_MAP,
    `PROTECTION STATE (HAVEN, the facility on screen; the only source for facility, incident and route facts):\n${extra.protection}`,
    extra.reports ? `REPORTS GEO WROTE EARLIER IN THIS BROWSER:\n${extra.reports}` : "",
    `ELEMENTS (id role "label" @x,y,wxh in viewport px):\n${elementLines(c.elements) || "(none)"}`,
    `VISIBLE TEXT:\n${c.visibleText || "(none)"}`,
    req.walkthrough
      ? req.walkthrough.observation.startsWith("Starting")
        ? `WALKTHROUGH: new, goal="${req.walkthrough.goal}". This reply is step 1.`
        : `WALKTHROUGH: goal="${req.walkthrough.goal}", you just guided step ${req.walkthrough.step}. Observation since then: ${req.walkthrough.observation}. If the goal isn't done yet, this reply is step ${req.walkthrough.step + 1}.`
      : "",
    req.lesson
      ? `LESSON (step-by-step, one item per reply): goal="${req.lesson.goal}". This is step ${req.lesson.step}.\nCOVERED: ${req.lesson.covered.length ? req.lesson.covered.join(" | ") : "(nothing yet)"}`
      : "",
    req.agent
      ? `AGENT (do-it-for-me run): GOAL="${req.agent.goal}". This is step ${req.agent.step}.\nLOG:\n${req.agent.log.length ? req.agent.log.join("\n") : "(nothing done yet, start)"}\nReply with the next "act".`
      : "",
    `PERSON: ${req.message}`,
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** Belt-and-braces: the reply is read aloud, so strip markdown remnants. */
export function speakable(text: string): string {
  return (
    text
      .replace(/\$+([^$]*)\$+/g, "$1")
      .replace(/[*_`#]+/g, "")
      .replace(/\s+/g, " ")
      .trim() || text
  );
}

/** The finished "speech" string from a JSON reply that is still streaming in (null until its closing quote arrives). */
export function extractSpeech(partialJson: string): string | null {
  const m = /"speech"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(partialJson);
  if (!m) return null;
  try {
    const s = JSON.parse(`"${m[1]}"`);
    return typeof s === "string" && s.trim() ? s.trim() : null;
  } catch {
    return null;
  }
}

type Msg = { role: "user" | "assistant"; content: string };

/** Read Anthropic's server-sent events and yield each text delta. */
async function* textDeltas(body: ReadableStream<Uint8Array>): AsyncGenerator<{ text?: string; stop?: string; model?: string; error?: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffered.indexOf("\n\n")) >= 0) {
      const chunk = buffered.slice(0, sep);
      buffered = buffered.slice(sep + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data) continue;
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") yield { text: ev.delta.text };
      else if (ev.type === "message_start") yield { model: ev.message?.model };
      else if (ev.type === "message_delta" && ev.delta?.stop_reason) yield { stop: ev.delta.stop_reason };
      else if (ev.type === "error") yield { error: ev.error?.type ?? "error" };
    }
  }
}

export async function runHeyGeo(
  req: AgentRequest,
  extra: TurnExtra,
  opts: { onSpeech?: (speech: string) => void; signal?: AbortSignal } = {}
): Promise<AgentResponse & { model: string }> {
  const prompt = buildUserPrompt(req, extra);
  const knownIds = new Set(req.context.elements.map((e) => e.id));

  // The API wants turns to alternate, starting with the person.
  const history: Msg[] = [];
  for (const h of req.history) {
    if (!history.length && h.role === "assistant") continue;
    const last = history.at(-1);
    if (last?.role === h.role) last.content = `${last.content}\n${h.text}`;
    else history.push({ role: h.role, content: h.text });
  }
  if (history.at(-1)?.role === "user") history.push({ role: "assistant", content: "(no reply)" });

  const messages: Msg[] = [...history, { role: "user", content: prompt }];
  const first = await callClaude(messages, opts);
  if (first.stop === "refusal") return { ...speechOnly("I can't help with that one. Ask me about the site, the design or what's on screen."), model: first.model };
  let reply = parseModelReply(first.text, knownIds, true);
  let model = first.model;
  if (!reply) {
    // Not valid JSON: ask once more, then fall back to speaking the text. The person never sees a parse error.
    const nudge = "Reply again with valid JSON only, exactly in the format from the system prompt, no code fences and no prose. If my message was unclear or nonsense, set speech to one short friendly line saying you didn't catch it and suggesting what to try.";
    try {
      const second = await callClaude([...messages, { role: "assistant", content: first.text.slice(0, 4000) || "(no reply)" }, { role: "user", content: nudge }], { signal: opts.signal });
      model = second.model;
      reply = parseModelReply(second.text, knownIds, true) ?? parseModelReply(first.text, knownIds, false);
    } catch {
      reply = parseModelReply(first.text, knownIds, false);
    }
  }
  const out = reply ?? speechOnly(NOT_CAUGHT);
  return { ...out, speech: speakable(out.speech), model };
}

/** One streamed Claude call; reports the spoken line as soon as it is complete. */
async function callClaude(messages: Msg[], opts: { onSpeech?: (speech: string) => void; signal?: AbortSignal }): Promise<{ text: string; stop: string; model: string }> {
  const timeout = AbortSignal.timeout(45_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await fetch(API_URL, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2026-10-21",
      // Server-side refusal fallback: a declined turn is retried on the fallback model inside the same call.
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body: JSON.stringify({
      model: heyGeoModel(),
      max_tokens: 8000,
      stream: true,
      fallbacks: "default",
      // Voice latency: low effort, and no thinking pass before the reply (Sonnet 5.5's way to turn thinking off).
      ...(heyGeoModel() === "claude-sonnet-5-5" ? { thinking: { type: "between_tools" } } : {}),
      output_config: { effort: "low" },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages,
    }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    // Status and error type only: never echo request content or headers.
    let type = "";
    try {
      type = JSON.parse(detail)?.error?.type ?? "";
    } catch {}
    throw new Error(`Claude returned HTTP ${res.status}${type ? ` (${type})` : ""}`);
  }

  let text = "";
  let spoke = false;
  let stop = "";
  let model = heyGeoModel();
  for await (const ev of textDeltas(res.body)) {
    if (ev.error) throw new Error(`Claude stream error (${ev.error})`);
    if (ev.model) model = ev.model;
    if (ev.stop) stop = ev.stop;
    if (!ev.text) continue;
    text += ev.text;
    if (!spoke && opts.onSpeech) {
      const s = extractSpeech(text);
      if (s) {
        spoke = true;
        opts.onSpeech(speakable(s).slice(0, 900));
      }
    }
  }
  return { text, stop, model };
}

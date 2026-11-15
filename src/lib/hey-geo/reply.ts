/**
 * Hey Geo — turning the model's text into a reply, robustly (pure; shared by the server and the tests).
 * The model is asked for JSON only, but a reply can arrive in a code fence, with prose around it, with a trailing
 * comma, cut short, or as plain prose (odd input like "*Pewds*" sometimes gets a prose answer). The person never sees
 * a parse error: the JSON is repaired when it can be, and otherwise the text is spoken as a plain answer.
 */

import { sanitizeAgentResponse, type AgentResponse } from "./schema";

export const NOT_CAUGHT = "I didn't catch that. Try “explain this”, “compare these sites” or “make a better design”.";

/** The first balanced {...} in the text (strings and escapes respected), or null. */
export function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Parse JSON leniently: fences, prose around it, trailing commas, smart quotes around keys. Null when it can't. */
export function lenientJson(text: string): unknown | null {
  const cleaned = text.replace(/^\s*```(?:json|JSON)?\s*/, "").replace(/\s*```\s*$/, "").trim();
  const candidates = [cleaned, firstJsonObject(cleaned)].filter((c): c is string => !!c);
  for (const c of candidates) {
    for (const variant of [c, c.replace(/,\s*([}\]])/g, "$1"), c.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, "$1")]) {
      try {
        const v = JSON.parse(variant);
        if (v && typeof v === "object" && !Array.isArray(v)) return v;
      } catch {
        /* next variant */
      }
    }
  }
  return null;
}

/** A "speech" value from text that is JSON-like but broken (e.g. cut off after the speech field). */
export function speechFromBrokenJson(text: string): string | null {
  const m = /"speech"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!m) return null;
  try {
    const s = JSON.parse(`"${m[1]}"`);
    return typeof s === "string" && s.trim() ? s.trim() : null;
  } catch {
    return null;
  }
}

/** Plain text the model wrote instead of JSON, made speakable; null when there's nothing usable. */
export function proseAnswer(text: string): string | null {
  if (/^\s*[{[]/.test(text)) return null;
  const t = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length >= 2 ? t.slice(0, 900) : null;
}

/** The empty reply carrying only words. */
export function speechOnly(speech: string): AgentResponse {
  return { speech: speech.slice(0, 900), annotations: [], tasks: [] } as AgentResponse;
}

/**
 * The model's text → a validated reply. `strict` is false on the last attempt: then broken JSON or prose becomes a
 * plain spoken answer instead of null. Null means "ask the model once more for valid JSON".
 */
export function parseModelReply(text: string, knownIds: Set<string>, strict = true): AgentResponse | null {
  const json = lenientJson(text);
  if (json) {
    const clean = sanitizeAgentResponse(json, { knownIds });
    if (clean) return clean;
    // Valid JSON without a usable speech: keep whatever it says.
    const speech = typeof (json as { speech?: unknown }).speech === "string" ? ((json as { speech: string }).speech.trim() || null) : null;
    if (!strict) return speechOnly(speech ?? NOT_CAUGHT);
    return null;
  }
  if (strict) return null;
  return speechOnly(speechFromBrokenJson(text) ?? proseAnswer(text) ?? NOT_CAUGHT);
}

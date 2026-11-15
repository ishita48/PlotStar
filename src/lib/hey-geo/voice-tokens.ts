import { randomUUID } from "node:crypto";

/**
 * Server-issued, short-lived handles for text the server itself produced (Geo's own answers), so /api/voice can
 * speak it with Cartesia without ever accepting words from the browser. Kept on globalThis so every route bundle
 * shares one store. Ported from HAVEN (src/lib/voice-tokens.ts).
 */
type Entry = { text: string; expires: number };
const TTL_MS = 10 * 60 * 1000;
const store: Map<string, Entry> = ((globalThis as { __heyGeoVoiceTokens?: Map<string, Entry> }).__heyGeoVoiceTokens ??= new Map());

export function issueVoiceToken(text: string) {
  const now = Date.now();
  for (const [token, entry] of store) if (entry.expires < now) store.delete(token);
  if (store.size > 500) store.delete(store.keys().next().value!);
  const token = randomUUID();
  store.set(token, { text, expires: now + TTL_MS });
  return token;
}

export function voiceTokenText(token: string) {
  const entry = store.get(token);
  return entry && entry.expires >= Date.now() ? entry.text : null;
}

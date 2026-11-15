/**
 * Server-only Cartesia client for Hey Geo: Sonic text-to-speech and Ink speech-to-text. Imported only by route
 * handlers; CARTESIA_API_KEY is never a NEXT_PUBLIC_ variable, so it cannot reach the browser bundle, and it is
 * never logged. Ported from HAVEN (src/lib/cartesia.ts), with GeoStar's API version and auth header.
 */

const API = "https://api.cartesia.ai";
const VERSION = "2026-08-14";
export const TTS_MODEL = process.env.CARTESIA_TTS_MODEL || "sonic-3.6";
/** Geo's voice (a Cartesia Voice Library id, not a secret); same calm voice as GeoStar's dispatch call unless overridden. */
export const GEO_VOICE = process.env.CARTESIA_VOICE_GEO || "f014dce5-df0e-4cfa-98e1-bd4bb73bb0b1";
export const PCM_RATE = 24000;
export const cartesiaConfigured = () => !!process.env.CARTESIA_API_KEY?.trim();

const headers = (extra: Record<string, string> = {}) => ({
  "X-API-Key": process.env.CARTESIA_API_KEY?.trim() ?? "",
  "Cartesia-Version": VERSION,
  ...extra,
});

export class CartesiaError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Status line for logs: never the key, never the request body. */
async function failure(kind: string, response: Response) {
  const body = await response.text().catch(() => "");
  let detail = "";
  try {
    const j = JSON.parse(body);
    detail = String(j?.message ?? j?.error ?? j?.detail ?? "").slice(0, 160);
  } catch {}
  return new CartesiaError(`Cartesia ${kind} ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
}

/**
 * Start Sonic speech for `text`; resolves once the first audio bytes arrive. `mp3` for an <audio> element, or `pcm`
 * (raw 16-bit mono at PCM_RATE) for Web Audio playback chunk by chunk.
 */
export async function speak(text: string, signal?: AbortSignal, format: "mp3" | "pcm" = "mp3") {
  const started = performance.now();
  const response = await fetch(`${API}/tts/bytes`, {
    method: "POST",
    signal,
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      model_id: TTS_MODEL,
      transcript: text,
      language: "en",
      voice: { mode: "id", id: GEO_VOICE },
      output_format:
        format === "pcm" ? { container: "raw", encoding: "pcm_s16le", sample_rate: PCM_RATE } : { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
      generation_config: { speed: 1, emotion: "calm" },
    }),
  });
  if (!response.ok || !response.body) throw await failure("TTS", response);
  const reader = response.body.getReader();
  const first = await reader.read();
  const firstAudioMs = Math.round(performance.now() - started);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (first.value) controller.enqueue(first.value);
      if (first.done) controller.close();
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { stream, firstAudioMs };
}

/** Ink speech-to-text for one recorded question (webm/ogg/wav/mp3...). */
export async function transcribe(audio: Blob, signal?: AbortSignal) {
  const form = new FormData();
  form.append("file", audio, "question.webm");
  form.append("model", process.env.CARTESIA_STT_MODEL || "ink-whisper");
  form.append("language", "en");
  const response = await fetch(`${API}/stt`, { method: "POST", signal, headers: headers(), body: form });
  if (!response.ok) throw await failure("STT", response);
  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === "string" ? body.text.trim() : "";
}

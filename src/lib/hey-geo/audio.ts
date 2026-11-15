"use client";

/**
 * Browser side of Hey Geo's voice (ported from HAVEN's cartesia-voice.ts). The degradation ladder: Cartesia Sonic
 * streamed from /api/voice → the browser's own speech → the text that is always on screen. The page never sees the
 * Cartesia key; it only names WHAT to speak (a server-issued token, see /api/voice).
 */
export type Playback = { stop: () => void };
type Handlers = { onStart?: (firstAudioMs: number) => void; onEnd?: () => void; onError?: (blocked: boolean) => void };
const PCM_RATE = 24000;
let current: { stop: () => void } | null = null;
let context: AudioContext | null = null;

/** Stop whatever Geo is saying, Cartesia or browser speech. */
export function stopVoice() {
  const playing = current; current = null; playing?.stop();
  if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
}

/**
 * Fastest rung: raw PCM from /api/voice scheduled with Web Audio as each chunk arrives, so speech starts with the
 * first bytes instead of after the browser buffers an MP3. Resolves false if Web Audio can't run (then use MP3).
 */
async function playPcm(url: string, { onStart, onEnd, onError }: Handlers, started: number): Promise<boolean> {
  const AudioContextClass = typeof window !== "undefined" ? window.AudioContext : undefined;
  if (!AudioContextClass) return false;
  context ??= new AudioContextClass({ sampleRate: PCM_RATE });
  if (context.state === "suspended") await context.resume().catch(() => undefined);
  if (context.state !== "running") { onError?.(true); return true; }
  const audio = context, abort = new AbortController(), sources: AudioBufferSourceNode[] = [];
  let stopped = false, endTimer: ReturnType<typeof setTimeout> | undefined;
  const self = { stop: () => { stopped = true; abort.abort(); clearTimeout(endTimer); sources.forEach(source => { try { source.stop(); } catch { /* not started */ } }); onEnd?.(); } };
  current = self;
  try {
    const response = await fetch(`${url}&format=pcm`, { cache: "no-store", signal: abort.signal });
    if (!response.ok || !response.body) { if (current === self) current = null; onError?.(false); return true; }
    const reader = response.body.getReader();
    let playAt = 0, carry: Uint8Array | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || stopped) break;
      const bytes: Uint8Array = carry ? new Uint8Array([...carry, ...value]) : value;
      const usable = bytes.length - (bytes.length % 2);
      carry = usable < bytes.length ? bytes.slice(usable) : null;
      if (!usable) continue;
      const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + usable));
      const buffer = audio.createBuffer(1, samples.length, PCM_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
      const source = audio.createBufferSource();
      source.buffer = buffer; source.connect(audio.destination);
      if (!playAt) { playAt = audio.currentTime + 0.05; onStart?.(Math.round(performance.now() - started)); }
      source.start(playAt); playAt += buffer.duration; sources.push(source);
    }
    if (!stopped) endTimer = setTimeout(() => { if (current === self) current = null; onEnd?.(); }, Math.max(0, (playAt - audio.currentTime) * 1000));
  } catch {
    if (!stopped) { if (current === self) current = null; onError?.(false); }
  }
  return true;
}

/** MP3 through an <audio> element: plays progressively too, but only after the browser buffers enough to decode. */
function playMp3(url: string, { onStart, onEnd, onError }: Handlers, started: number) {
  const audio = new Audio();
  let finished = false;
  const done = () => { if (!finished) { finished = true; onEnd?.(); } };
  const self = { stop: () => { audio.pause(); audio.removeAttribute("src"); audio.load(); done(); } };
  current = self;
  audio.addEventListener("playing", () => onStart?.(Math.round(performance.now() - started)), { once: true });
  audio.addEventListener("ended", () => { if (current === self) current = null; done(); });
  audio.addEventListener("error", () => { if (current !== self) return; current = null; finished = true; onError?.(false); });
  audio.preload = "auto";
  audio.src = url;
  audio.play().catch((error: unknown) => {
    if (current !== self) return;
    current = null; finished = true;
    onError?.(error instanceof DOMException && error.name === "NotAllowedError");
  });
}

/** Speak one /api/voice URL. `onError(true)` means the browser blocked audio until the person taps something. */
export function playCartesia(url: string, handlers: Handlers = {}): Playback {
  stopVoice();
  const started = performance.now();
  void playPcm(url, handlers, started).then(handled => { if (!handled) playMp3(url, handlers, started); });
  return { stop: stopVoice };
}

/** Bottom rung: the browser's built-in voice, slower and calmer for guidance. */
export function speakWithBrowser(text: string, { rate = 1, onEnd }: { rate?: number; onEnd?: () => void } = {}) {
  if (typeof window === "undefined" || !window.speechSynthesis || !text.trim()) return false;
  stopVoice();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US"; utterance.rate = rate;
  const local = window.speechSynthesis.getVoices().find(voice => voice.localService && voice.lang.startsWith("en"));
  if (local) utterance.voice = local;
  utterance.onend = () => onEnd?.(); utterance.onerror = () => onEnd?.();
  window.speechSynthesis.speak(utterance);
  return true;
}

/**
 * Hey Geo — voice I/O (browser only). Ported from HAVEN's Hey Haven.
 * ─────────────────────────────────────
 * Input:
 *  - Cartesia Ink: the microphone is recorded (with simple voice-activity
 *    detection) and transcribed by /api/voice/transcribe, with the Cartesia key
 *    kept on the server. While recording, the browser's own recogniser (when there is
 *    one) shows live words as a preview; the words Hey Geo acts on are
 *    Cartesia's. Without MediaRecorder, the browser recogniser is the fallback.
 *  - Wake word: a continuous browser recognition session that only runs while
 *    the user has switched "Hey Geo" listening on, and only looks for the
 *    phrase. What follows the phrase is asked like any other question.
 * Output:
 *  - Cartesia Sonic through /api/voice?kind=answer&token=…: the server issued
 *    the token for words it produced itself, so the page never sends text to be
 *    spoken. Browser speech is the fallback. Playback is interruptible.
 */

import { playCartesia, speakWithBrowser, stopVoice } from "./audio";

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export const speechRecognitionSupported = () => !!recognitionCtor();
export const mediaRecorderSupported = () =>
  typeof window !== "undefined" && window.isSecureContext && typeof (window as any).MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

export function micErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "NotAllowedError":
    case "service-not-allowed":
      return "Microphone access is blocked, allow it in your browser's site settings, or type instead.";
    case "audio-capture":
    case "NotFoundError":
      return "No microphone found, you can type to Hey Geo instead.";
    case "network":
      return "Speech recognition needs a network connection, try again or type instead.";
    case "no-speech":
      return "I didn't catch anything, try again.";
    default:
      return "Voice input stopped unexpectedly, try again or type instead.";
  }
}

/** Set from /api/voice/status: whether the server can transcribe with Cartesia Ink. */
let inkAvailable = true;
export function setInkAvailable(on: boolean) {
  inkAvailable = on;
}

// ── Push-to-talk ─────────────────────────────────────────────────────
export type Listener = { stop: () => void; cancel: () => void };

/** Live words from the browser recogniser, shown while Cartesia records. Null when the browser has none. */
function startPreview(onText: (text: string) => void): (() => void) | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = navigator.language || "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  let text = "";
  rec.onresult = (e: any) => {
    let fin = "";
    let interim = "";
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) fin += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    text = `${fin} ${interim}`.replace(/\s+/g, " ").trim();
    if (text) onText(text);
  };
  rec.onerror = () => {};
  rec.onend = null;
  try {
    rec.start();
  } catch {
    return null;
  }
  return () => {
    try {
      rec.abort();
    } catch {
      /* already stopped */
    }
  };
}

/**
 * Start listening. Calls onPartial with live text, onFinal once with Cartesia's
 * transcript when the user stops (or pauses, unless `hold`), and onError with a
 * friendly message.
 */
export function startPushToTalk(
  cb: {
    onPartial: (text: string) => void;
    onFinal: (text: string) => void;
    onError: (message: string) => void;
  },
  opts: { hold?: boolean; silenceMs?: number; maxMs?: number } = {}
): Listener {
  // Without Cartesia on the server (or a recorder in the browser), the browser recogniser does the listening.
  if (!mediaRecorderSupported() || !inkAvailable) return startBrowserListening(cb);

  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let audio: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopPreview: (() => void) | null = null;
  let cancelled = false;
  let stopRequested = false;
  let heard = false;
  const chunks: Blob[] = [];
  const silenceMs = opts.silenceMs ?? 1200;
  const maxMs = opts.maxMs ?? 30_000;

  const release = () => {
    if (timer) clearInterval(timer);
    timer = null;
    stopPreview?.();
    stopPreview = null;
    stream?.getTracks().forEach((t) => t.stop());
    void audio?.close().catch(() => undefined);
    audio = null;
  };
  const finishRecording = () => {
    if (recorder?.state === "recording") recorder.stop();
    else release();
  };

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      // Stopped while the permission prompt was open: release the mic.
      if (cancelled || stopRequested) {
        release();
        if (stopRequested && !cancelled) cb.onFinal("");
        return;
      }
      const type = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : undefined;
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      recorder = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = async () => {
        release();
        if (cancelled) return;
        // Held to talk: the user decides there was speech, even if it was quiet.
        if (!heard && !opts.hold) {
          cb.onFinal("");
          return;
        }
        cb.onPartial("Transcribing…");
        try {
          const res = await fetch("/api/voice/transcribe", { method: "POST", body: new Blob(chunks, { type: rec.mimeType || "audio/webm" }) });
          const j = (await res.json().catch(() => ({}))) as { text?: unknown; error?: string };
          if (!res.ok || typeof j.text !== "string") throw new Error(j.error || "Transcription failed");
          if (!cancelled) cb.onFinal(j.text);
        } catch (e: any) {
          if (!cancelled) cb.onError(e?.message || "Transcription failed, try typing instead.");
        }
      };
      // Simple voice-activity detection on the microphone level.
      audio = new AudioContext();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 1024;
      audio.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const begun = performance.now();
      let quietSince = performance.now();
      timer = setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        const level = Math.sqrt(samples.reduce((sum, v) => sum + (v - 128) ** 2, 0) / samples.length);
        const now = performance.now();
        if (level > 6) {
          heard = true;
          quietSince = now;
        }
        const pause = !opts.hold && heard && now - quietSince > silenceMs;
        // Nothing said at all: give up after a while (hold mode waits for the key).
        const nothing = !opts.hold && !heard && now - begun > 8000;
        if (pause || nothing || now - begun > maxMs) finishRecording();
      }, 100);
      rec.start();
      cb.onPartial("Listening…");
      stopPreview = startPreview((t) => !cancelled && cb.onPartial(t));
    } catch (e: any) {
      release();
      if (!cancelled) cb.onError(micErrorMessage(e?.name || "unknown"));
    }
  })();

  return {
    stop: () => {
      stopRequested = true;
      finishRecording();
    },
    cancel: () => {
      cancelled = true;
      finishRecording();
    },
  };
}

/** Fallback when the browser can't record: its own recogniser, final text when the user pauses. */
function startBrowserListening(cb: {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
}): Listener {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    setTimeout(() => cb.onError("Voice input isn't available in this browser, type instead."), 0);
    return { stop: () => {}, cancel: () => {} };
  }
  const rec = new Ctor();
  rec.lang = navigator.language || "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  let finalText = "";
  let latest = "";
  let cancelled = false;
  let delivered = false;
  rec.onresult = (e: any) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    latest = (finalText + interim).trim();
    cb.onPartial(latest);
  };
  rec.onerror = (e: any) => {
    if (e.error === "aborted") return;
    if (e.error === "no-speech" && latest) return;
    cancelled = true;
    cb.onError(micErrorMessage(e.error));
  };
  rec.onend = () => {
    if (cancelled || delivered) return;
    delivered = true;
    cb.onFinal(latest);
  };
  try {
    rec.start();
  } catch {
    cb.onError(micErrorMessage("unknown"));
  }
  return {
    stop: () => rec.stop(),
    cancel: () => {
      cancelled = true;
      rec.abort();
    },
  };
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * Did the mic just hear Hey Geo's own voice? Speakers bleed into the mic, so a
 * transcript made mostly of words Hey Geo is saying is treated as echo.
 */
export function isEcho(heard: string, spoken: string | null | undefined): boolean {
  if (!spoken) return false;
  const h = words(heard);
  if (!h.length) return true;
  const said = new Set(words(spoken));
  return h.filter((w) => said.has(w)).length / h.length >= 0.7;
}

export type Interruption = "pause" | "resume" | "next" | "stop" | "turn";

const TRAILING_NAME = /\s+(?:geo|gio|jo|please)$/;

/** What the user meant by talking over Hey Geo. */
export function classifyInterruption(text: string): Interruption {
  const t = text
    .toLowerCase()
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:ok|okay|um|uh|hey|so|sorry|no)\s+/, "")
    .replace(TRAILING_NAME, "");
  if (/^(?:continue|go on|keep going|go ahead|resume|carry on|yes continue|you can continue)$/.test(t)) return "resume";
  if (/^(?:next|next one|next step|skip|skip it|skip this|skip that|move on|go next|keep going next)$/.test(t)) return "next";
  if (/^(?:wait|hold on|hang on|pause|one sec|one second|just a sec|just a second|wait a sec|wait a second|hold up)$/.test(t)) return "pause";
  if (/^(?:stop|stop talking|shh+|quiet|be quiet|enough|never mind|nevermind|cancel)$/.test(t)) return "stop";
  return "turn";
}

/** Should what the mic hears while Hey Geo talks cut it off? */
export function shouldBargeIn(partial: string, spoken: string | null | undefined): boolean {
  if (classifyInterruption(partial) !== "turn") return true;
  return words(partial).length >= 2 && !isEcho(partial, spoken);
}

/** Yes / no to "Geo wants to approve the plan — allow?" */
export function yesNo(text: string): "yes" | "no" | null {
  const t = text.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim().replace(TRAILING_NAME, "");
  if (/^(?:yes|yeah|yep|yup|sure|ok|okay|allow|allow it|do it|go ahead|go for it|confirm|approve|yes please|sounds good)$/.test(t)) return "yes";
  if (/^(?:no|nope|nah|don't|do not|skip it|cancel|deny|not now|no thanks|no thank you)$/.test(t)) return "no";
  return null;
}

/** "Stop the lesson" / "end the walkthrough" — not just a pause. */
export const isLessonEnd = (t: string) => /\b(?:stop|end|quit|exit|finish|cancel) (?:the )?(?:lesson|walkthrough|step by step|drill)\b/i.test(t);
/** "Stop", "cancel the task" while Hey Geo is doing something for you. */
export const isRunStop = (t: string) =>
  /^(?:stop|cancel|abort|halt|stop it|stop that|stop now|stop the task|cancel that|cancel it|cancel the task)$/.test(
    t.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim().replace(TRAILING_NAME, "")
  );

export const isConversationStart = (t: string) =>
  /\b(?:let'?s talk|let'?s chat|conversation mode|talk to me|keep listening)\b/i.test(t);
export const isConversationEnd = (t: string) =>
  /\b(?:stop listening|stop (?:the )?conversation|end (?:the )?conversation|conversation (?:mode )?off)\b/i.test(t);

// ── Wake word ("Hey Geo") ────────────────────────────────────────────
// "Hey Geo", plus the ways speech recognisers commonly mis-hear it.
const NAME = String.raw`(?:geo|gio|geeo|jeo|gee-o|g\.?\s?o\.?|joe|jo|zeo)`;
const WAKE = new RegExp(String.raw`\b(?:hey|hi|hay|hey there|okay|ok|yo)[,\s]+${NAME}(?![a-z])[,.!?\s]*`, "i");
const SLEEP = new RegExp(String.raw`\b(?:bye|goodbye|good bye|stop|go to sleep|turn off)[,\s]+${NAME}(?![a-z])|\bthat'?s all,? ${NAME}(?![a-z])`, "i");

/** "Bye Geo" / "stop Geo" — the user wants Hey Geo to switch off. */
export function isSleepCommand(transcript: string): boolean {
  return SLEEP.test(transcript);
}

/** Split a transcript on the wake phrase. Returns null if it isn't present. */
export function extractWakeCommand(transcript: string): { command: string } | null {
  const m = WAKE.exec(transcript);
  if (!m) return null;
  return { command: transcript.slice(m.index + m[0].length).trim() };
}

/**
 * Continuous listening for "Hey Geo …". Only runs while explicitly enabled
 * by the user (the UI shows a live indicator). Each recognised utterance that
 * starts with the wake phrase is passed to onWake (possibly empty, meaning
 * "wake up and listen").
 */
export function startWakeWord(cb: {
  onWake: (command: string) => void;
  onSleep?: () => void;
  onError: (message: string) => void;
}): { stop: () => void } | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  let stopped = false;
  let rec: SpeechRecognitionLike | null = null;
  const boot = () => {
    if (stopped) return;
    rec = new Ctor();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (!e.results[i].isFinal) continue;
        const said = e.results[i][0].transcript;
        if (cb.onSleep && isSleepCommand(said)) {
          cb.onSleep();
          continue;
        }
        const hit = extractWakeCommand(said);
        if (hit) cb.onWake(hit.command);
      }
    };
    rec.onerror = (e: any) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      stopped = true;
      cb.onError(micErrorMessage(e.error));
    };
    // Browsers end continuous sessions after silence — restart while enabled.
    rec.onend = () => {
      if (!stopped) setTimeout(boot, 250);
    };
    try {
      rec.start();
    } catch {
      /* already started */
    }
  };
  boot();
  return {
    stop: () => {
      stopped = true;
      rec?.abort();
    },
  };
}

// ── Speech output ────────────────────────────────────────────────────
export type Playback = { stop: () => void; done: Promise<void> };

/**
 * Say `text` out loud. With a `token` (issued by /api/hey-geo for this exact
 * text) Cartesia Sonic speaks it; otherwise, or if Cartesia fails, the
 * browser's voice does.
 */
export function speak(text: string, token?: string | null): Playback {
  let stopped = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    resolveDone();
  };
  const browser = () => {
    if (stopped || !speakWithBrowser(text, { onEnd: finish })) finish();
  };

  if (token) {
    playCartesia(`/api/voice?kind=answer&token=${encodeURIComponent(token)}`, {
      onEnd: finish,
      onError: (blocked) => (blocked ? finish() : browser()),
    });
  } else browser();

  return {
    stop: () => {
      stopped = true;
      stopVoice();
      finish();
    },
    done,
  };
}

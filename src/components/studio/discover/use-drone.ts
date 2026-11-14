'use client';
// Tello EDU flight state for Studio's Discover step. Same bridge and rules as the Smart Blocks drone view
// (src/components/dashboard-2/drone-discover.tsx): everything comes from bridge/server.py through /api/drone/*,
// nothing is simulated in the browser, and a --mock bridge's frames are labeled as a test pattern.
import { useCallback, useEffect, useRef, useState } from 'react';

export type Action = 'takeoff' | 'land' | 'up' | 'down' | 'left' | 'right' | 'forward' | 'back' | 'cw' | 'ccw' | 'emergency';
export type DroneStatus = {
  bridge: boolean; url: string; connected?: boolean; mock?: boolean; error?: string | null; battery?: number | null;
  height?: number | null; temp?: number | null; flying?: boolean; video?: boolean; ip?: string | null;
};
export type Capture = { url: string; time: number; simulated: boolean };
export type Phase = 'checking' | 'bridge-offline' | 'searching' | 'no-video' | 'test' | 'live';

export const SWEEP_STOPS = 8; // 8 × 45° = one full turn
export const LABEL: Record<Action, string> = {
  takeoff: 'Take off', land: 'Land', up: 'Up 30 cm', down: 'Down 30 cm', left: 'Left 30 cm', right: 'Right 30 cm',
  forward: 'Forward 30 cm', back: 'Back 30 cm', cw: 'Turn right 45°', ccw: 'Turn left 45°', emergency: 'Stop motors',
};
const KEYS: Record<string, Action> = { w: 'forward', s: 'back', a: 'left', d: 'right', q: 'ccw', e: 'cw', ArrowUp: 'up', ArrowDown: 'down', t: 'takeoff', l: 'land' };

function phaseOf(s: DroneStatus | null): Phase {
  if (!s) return 'checking';
  if (!s.bridge) return 'bridge-offline';
  if (!s.connected) return 'searching';
  if (s.mock) return 'test';
  return s.video ? 'live' : 'no-video';
}

async function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/drone/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export const captureSrc = (c: Capture) => `/api/drone${c.url}`;

export function useDrone() {
  const [status, setStatus] = useState<DroneStatus | null>(null);
  const [pending, setPending] = useState<Action | 'capture' | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [armStop, setArmStop] = useState(false);
  const [sweep, setSweep] = useState<number | null>(null); // stops completed, null = idle
  const [streamKey, setStreamKey] = useState(0);
  const [frameSeen, setFrameSeen] = useState(false);
  const sweepCancel = useRef(false);
  const busy = useRef(false);

  const phase = phaseOf(status);
  const connected = phase === 'live' || phase === 'test' || phase === 'no-video';
  const hasVideo = phase === 'live' || phase === 'test';
  const flying = !!status?.flying;

  // Poll the bridge. 1.5 s keeps telemetry fresh without flooding the drone's state socket.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try {
        const res = await fetch('/api/drone/status', { cache: 'no-store' });
        const next = (await res.json()) as DroneStatus;
        if (alive) setStatus(next);
      } catch {
        if (alive) setStatus({ bridge: false, url: '' });
      }
      if (alive) timer = setTimeout(tick, 1500);
    }
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  // Reopen the MJPEG stream whenever video (re)appears; drop it when it goes away.
  useEffect(() => {
    if (hasVideo) setStreamKey((k) => k + 1);
    else setFrameSeen(false);
  }, [hasVideo]);

  // Earlier captures stored on the bridge.
  useEffect(() => {
    if (!status?.bridge) return;
    let alive = true;
    fetch('/api/drone/snapshots', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : []))
      .then((list: Capture[]) => alive && Array.isArray(list) && setCaptures(list))
      .catch(() => {});
    return () => { alive = false; };
  }, [status?.bridge]);

  // "Stop motors" needs a second press within 3 s; it drops the drone out of the air.
  useEffect(() => {
    if (!armStop) return;
    const t = setTimeout(() => setArmStop(false), 3000);
    return () => clearTimeout(t);
  }, [armStop]);

  const send = useCallback(async (action: Action) => {
    if (action !== 'emergency' && busy.current) return false;
    if (action !== 'emergency') busy.current = true;
    setPending(action);
    setMessage({ text: `${LABEL[action]}…` });
    try {
      await post('command', { action });
      setMessage({ text: `${LABEL[action]} · done` });
      return true;
    } catch (err) {
      setMessage({ text: `${LABEL[action]}: ${(err as Error).message}`, error: true });
      return false;
    } finally {
      if (action !== 'emergency') busy.current = false;
      setPending(null);
    }
  }, []);

  const capture = useCallback(async (quiet = false) => {
    if (!quiet && busy.current) return false;
    setPending('capture');
    try {
      const shot = await post<Capture>('snapshot');
      setCaptures((list) => [shot, ...list.filter((c) => c.url !== shot.url)]);
      if (!quiet) setMessage({ text: 'Frame saved to the bridge’s captures folder' });
      return true;
    } catch (err) {
      setMessage({ text: `Capture: ${(err as Error).message}`, error: true });
      return false;
    } finally {
      setPending(null);
    }
  }, []);

  async function runSweep() {
    if (busy.current) return;
    busy.current = true;
    sweepCancel.current = false;
    setSweep(0);
    try {
      for (let stop = 0; stop < SWEEP_STOPS; stop++) {
        if (sweepCancel.current) break;
        setMessage({ text: `360° survey · frame ${stop + 1} of ${SWEEP_STOPS}` });
        if (!(await capture(true))) break;
        setSweep(stop + 1);
        if (stop === SWEEP_STOPS - 1 || sweepCancel.current) break;
        setPending('cw');
        try {
          await post('command', { action: 'cw' });
        } catch (err) {
          setMessage({ text: `Survey stopped: ${(err as Error).message}`, error: true });
          break;
        } finally {
          setPending(null);
        }
      }
      setMessage({ text: sweepCancel.current ? 'Survey cancelled' : '360° survey complete' });
    } finally {
      busy.current = false;
      setSweep(null);
    }
  }
  const cancelSweep = () => { sweepCancel.current = true; };

  function stopMotors() {
    if (!armStop) return setArmStop(true);
    setArmStop(false);
    sweepCancel.current = true;
    void send('emergency');
  }

  // Keyboard flying: W A S D move, ↑ ↓ height, Q E turn, T take off, L land, C capture.
  useEffect(() => {
    if (!connected) return;
    function onKey(e: KeyboardEvent) {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === 'c' && hasVideo) { e.preventDefault(); void capture(); return; }
      const action = KEYS[key];
      if (!action) return;
      if (action !== 'takeoff' && !flying) return;
      e.preventDefault();
      void send(action);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [connected, flying, hasVideo, send, capture]);

  return {
    status, phase, connected, hasVideo, flying, pending, message, captures, armStop, sweep, streamKey, frameSeen,
    setFrameSeen, retryStream: () => setTimeout(() => setStreamKey((k) => k + 1), 2000),
    send, capture, runSweep, cancelSweep, stopMotors,
  };
}

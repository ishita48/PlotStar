'use client';
// HAVEN dispatch: a real phone call to the facility's emergency contact, placed by a Cartesia or ElevenLabs voice
// agent through the GeoStar API (/haven/dispatch/*). The number lives in the API's .env; the browser only sees its last
// four digits. It never dials 911: the agent tells the contact to call 911 themselves if anyone is in danger.
import { useEffect, useRef, useState } from 'react';
import { Phone, PhoneCall, PhoneOff } from 'lucide-react';
import { PUBLIC_DATA_API } from '@/lib/plotstar-api';

export interface DispatchStatus {
  live: boolean;
  contact: string | null;
  reason?: string;
  from?: string | null;
  telephony?: string;
  provider?: string;
}

export interface DispatchIncident {
  incident_id: string;
  incident: string;
  zone: string;
  severity: 'warning' | 'critical' | 'unknown';
  detail: string;
  actions: string;
  facility: string;
  city: string;
}

interface Turn {
  speaker: string;
  text: string;
}

/** Whether the API can place a live call right now. null while loading or when the API is unreachable. */
export function useDispatchStatus(): DispatchStatus | null {
  const [status, setStatus] = useState<DispatchStatus | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(`${PUBLIC_DATA_API}/haven/dispatch/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && setStatus(d))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

const DONE = new Set(['done', 'failed']);

export function LiveEmergencyCall({ status, incident }: { status: DispatchStatus; incident: DispatchIncident }) {
  const [confirming, setConfirming] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [call, setCall] = useState<{ id: string; startedAt: string } | null>(null);
  const [callStatus, setCallStatus] = useState<string>('initiated');
  const [turns, setTurns] = useState<Turn[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Poll the call's status and transcript until ElevenLabs reports it finished (or three minutes pass).
  useEffect(() => {
    if (!call) return;
    let alive = true;
    const started = Date.now();
    const tick = async () => {
      try {
        const r = await fetch(`${PUBLIC_DATA_API}/haven/dispatch/call/${call.id}`);
        if (r.ok) {
          const d = await r.json();
          if (!alive) return;
          setCallStatus(d.status || 'in-progress');
          setTurns(d.transcript || []);
          if (DONE.has(d.status)) return;
        }
      } catch {
        /* keep polling */
      }
      if (alive && Date.now() - started < 200_000) timer.current = setTimeout(tick, 3000);
    };
    void tick();
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [call]);

  const place = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setPlacing(true);
    setError(null);
    try {
      const r = await fetch(`${PUBLIC_DATA_API}/haven/dispatch/call`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(incident),
      });
      const d = await r.json();
      if (!r.ok || !d.conversation_id) throw new Error(d.detail || 'The call could not be placed.');
      setCall({ id: d.conversation_id, startedAt: d.started_at });
      setCallStatus('initiated');
      setTurns([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The call could not be placed.');
    } finally {
      setPlacing(false);
    }
  };

  const finished = DONE.has(callStatus);
  const label = placing
    ? 'Placing the call…'
    : call && !finished
      ? `Calling ${status.contact}…`
      : confirming
        ? `Tap again to call ${status.contact}`
        : call
          ? 'Call again'
          : 'Call emergency contact';

  return (
    <>
      <p className="cc-note">
        HAVEN rings the emergency contact {status.contact} with a {status.provider} voice and reads out this incident. It
        does not call 911. The contact is told to call 911 if anyone is in danger.
      </p>
      <button
        className={`cc-emergency ${confirming ? 'is-confirming' : ''}`}
        disabled={placing || (!!call && !finished)}
        onClick={() => void place()}
        onBlur={() => setConfirming(false)}
      >
        {call && !finished ? <PhoneCall size={15} /> : <Phone size={15} />}
        {label}
      </button>
      {error && (
        <p className="cc-call-error" role="alert">
          <PhoneOff size={13} /> {error}
        </p>
      )}
      {call && (
        <div className="cc-call" role="status" aria-live="polite">
          <strong>
            Live call · {status.contact} · {callStatus === 'done' ? 'ended' : callStatus.replace('-', ' ')}
          </strong>
          {turns.length ? (
            <ol aria-label="Call transcript">
              {turns.map((turn, i) => (
                <li key={i}>
                  <b>{turn.speaker}</b>
                  <p>{turn.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="cc-report">Ringing. The transcript appears here as the call goes on.</p>
          )}
        </div>
      )}
    </>
  );
}

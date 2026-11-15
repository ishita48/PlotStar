'use client';
// Discover: Gemini hazard notes on one captured Tello frame. Sits on the frame's card: a small button, then a
// two-sentence description and the hazards it can see (people, water, wires, vehicles, debris), boxed on the thumbnail.
import { useState } from 'react';
import { LoaderCircle, ShieldAlert } from 'lucide-react';
import { gemini, load, save } from './api';
import s from './gemini.module.css';

type Hazard = { kind: string; label: string; severity: 'low' | 'medium' | 'high'; why: string; box: { x: number; y: number; w: number; h: number } | null };
type FrameNote = { summary: string; ground: string; visibility: string; hazards: Hazard[]; model: string };

export function FrameInsight({ src, simulated = false }: { src: string; simulated?: boolean }) {
  const key = `gs-frame:${src}`;
  const [note, setNote] = useState<FrameNote | null>(() => load<FrameNote>(key));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true); setError(null);
    try {
      const img = await fetch(src);
      if (!img.ok) throw new Error('Could not read the frame from the drone bridge');
      const form = new FormData();
      form.append('file', await img.blob(), 'frame.jpg');
      const r = await gemini<FrameNote>('/frame', { method: 'POST', body: form });
      setNote(r); save(key, r);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const worst = note?.hazards.some((h) => h.severity === 'high') ? 'high' : note?.hazards.some((h) => h.severity === 'medium') ? 'medium' : note?.hazards.length ? 'low' : 'none';
  return (
    <>
      {note && (
        <svg className={s.frameBoxes} viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          {note.hazards.filter((h) => h.box).map((h, i) => (
            <rect key={i} x={h.box!.x} y={h.box!.y} width={h.box!.w} height={h.box!.h} className={s[`sev_${h.severity}`]} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      )}
      <div className={s.frame}>
        {!note ? (
          <button type="button" className={s.frameBtn} onClick={() => void run()} disabled={busy}
            title={simulated ? 'This is a bridge test pattern, not a camera frame' : 'Describe this frame and flag hazards with Gemini'}>
            {busy ? <LoaderCircle size={12} className={s.spin} /> : <ShieldAlert size={12} />} {busy ? 'Checking…' : 'Hazards'}
          </button>
        ) : (
          <details className={s.frameNote}>
            <summary><span className={`${s.sevDot} ${s[`dot_${worst}`]}`} />{note.hazards.length ? `${note.hazards.length} hazard${note.hazards.length > 1 ? 's' : ''}` : 'No hazards seen'}<em>AI</em></summary>
            <p>{note.summary}</p>
            {note.hazards.map((h, i) => <p key={i} className={s.haz}><b className={s[`sevTxt_${h.severity}`]}>{h.severity}</b> {h.label}: {h.why}</p>)}
            <small>{note.ground} · visibility {note.visibility} · {note.model}</small>
          </details>
        )}
        {error && <p className={s.err}>{error}</p>}
      </div>
    </>
  );
}

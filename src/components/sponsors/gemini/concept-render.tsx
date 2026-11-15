'use client';
// Deliver: an AI street-view render of the chosen concept, prompted from its real geometry (building size, storeys,
// yard items and where they sit). Always labelled "AI render, not a photo". If this Gemini key cannot generate images,
// the card says so and offers nothing to click; no placeholder image is shown.
import { useEffect, useState } from 'react';
import { ImageIcon, LoaderCircle } from 'lucide-react';
import type { Concept } from '@/components/studio/types';
import { gemini, geminiStatus, postJson, type GeminiStatus } from './api';
import s from './gemini.module.css';

type Render = { image: string; prompt: string; model: string; view: string; label: string; note: string };

export function ConceptRender({ concept, brief, setting }: { concept: Concept; brief: Record<string, unknown>; setting?: string }) {
  const [status, setStatus] = useState<GeminiStatus | null | undefined>(undefined);
  const [view, setView] = useState<'south' | 'north' | 'east' | 'west'>('south');
  const [out, setOut] = useState<Render | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let alive = true; void geminiStatus().then((st) => alive && setStatus(st)); return () => { alive = false; }; }, []);

  async function run() {
    setBusy(true); setError(null);
    try {
      setOut(await gemini<Render>('/render', postJson({ concept, brief, view, setting: setting ?? '' })));
    } catch (e) {
      setError((e as Error).message);
      if ((e as Error).message.includes('not enabled')) setStatus((st) => (st ? { ...st, image_available: false, image_blocked: (e as Error).message } : st));
    } finally { setBusy(false); }
  }

  const unavailable = status === null || (status && !status.image_available);
  return (
    <div className="st-card">
      <h3>Street view (AI render)</h3>
      {unavailable ? (
        <p className="st-muted">Not available on this Gemini key. {status?.image_blocked ?? (status === null ? 'The Gemini status check failed.' : `No image model (${status?.image_model}) can be called.`)} Nothing is generated in its place.</p>
      ) : (
        <>
          <p className="st-muted">Gemini paints the chosen concept from its real dimensions: a {concept.building.w.toFixed(0)} × {concept.building.d.toFixed(0)} m, {concept.building.storeys}-storey building, {concept.building.h.toFixed(0)} m tall, with its yard equipment where the layout puts it. An illustration, not a photo of anything.</p>
          <div className={s.renderRow}>
            <select value={view} onChange={(e) => setView(e.target.value as typeof view)} aria-label="Viewpoint">
              {(['south', 'north', 'east', 'west'] as const).map((v) => <option key={v} value={v}>From the {v}</option>)}
            </select>
            <button type="button" className="st-btn" onClick={() => void run()} disabled={busy || status === undefined}>
              {busy ? <><LoaderCircle size={14} className={s.spin} /> Rendering…</> : <><ImageIcon size={14} /> Render street view</>}
            </button>
          </div>
        </>
      )}
      {error && !unavailable && <p className={s.err}>{error}</p>}
      {out && (
        <figure className={s.render}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={out.image} alt={`AI render of ${concept.name} seen from the ${out.view}; not a photo`} />
          <span className={s.aiBadge}>AI render, not a photo</span>
          <figcaption>{out.note} Model {out.model}. <details><summary>Prompt</summary><p>{out.prompt}</p></details></figcaption>
        </figure>
      )}
    </div>
  );
}

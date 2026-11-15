'use client';
// CoStar citations under an agent answer: one small chip per CoStar figure (record id + field), built on the server
// from the run's full CoStar evidence (services/api/app/sponsors/langchain/deep_agents/citations.py). A chip opens the
// CoStar dossier for that record. Shown in GeoStar's own UI only; the model never sees these fields.
import { useState } from 'react';
import { Database } from 'lucide-react';
import type { Citation } from '../langchain/use-agent-run';
import { CostarDossier } from './dossier';
import s from './citation-chips.module.css';

const fmt = (v: number | null) => (v == null ? '' : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v.toLocaleString(undefined, { maximumFractionDigits: 2 }));

export function CitationChips({ citations, mwIt, rackKw }: { citations: Citation[] | null | undefined; mwIt?: number; rackKw?: number }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!citations?.length) return null;
  return (
    <div className={s.row} aria-label="CoStar citations">
      <span className={s.lead}><Database size={11} /> CoStar sources</span>
      {citations.map((c, i) => (
        <button key={`${c.record_id}-${c.field}-${i}`} className={`${s.chip} ${c.kind === 'evidence' ? s.ev : ''}`}
          onClick={() => setOpen(c.record_id)}
          title={`${c.label}${c.value != null ? ` = ${fmt(c.value)}` : ''} · ${c.record_id} · ${c.field} · ${c.tag}${c.source ? ` · ${c.source}` : ''} · evidence ${c.evidence_id} (${c.tool}). Click to open the CoStar dossier.`}>
          {c.figure && <b>{c.figure}</b>}
          <span>{c.record_id.replace('costar:', '#')}</span>
          <code>{c.field}</code>
        </button>
      ))}
      {open && <CostarDossier parcelId={open} mwIt={mwIt} rackKw={rackKw} initialTab="comps" onClose={() => setOpen(null)} />}
    </div>
  );
}

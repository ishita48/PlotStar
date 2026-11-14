'use client';
import { useState } from 'react';
import { Box, Check, ChevronDown, Leaf, Users, Wallet, X } from 'lucide-react';
import { vexcelOrthoUrl } from '@/lib/plotstar-api';
import type { OptimizeResult } from './optimize-types';
import { RunPanel } from './run-panel';
import { LabelTag, MatterportPanel } from '../site-evidence';
import type { ExploreSite } from './types';
import { fmtMoney, fmtNum, GATE_TITLE, plainGate, verdict } from './types';

function Ring({ value }: { value: number }) {
  const r = 34,
    c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 84 84" className="xp-ring" aria-label={`Score ${value} of 100`}>
      <circle cx="42" cy="42" r={r} className="xp-ring-bg" />
      <circle
        cx="42"
        cy="42"
        r={r}
        className="xp-ring-fg"
        strokeDasharray={`${(value / 100) * c} ${c}`}
        transform="rotate(-90 42 42)"
      />
      <text x="42" y="46" textAnchor="middle">
        {Math.round(value)}
      </text>
    </svg>
  );
}

export function SitePanel({
  site,
  mw,
  run,
  runBusy,
  onWhatIf,
  onOpen3d,
  onClose,
}: {
  site: ExploreSite;
  mw: number;
  run: OptimizeResult | null;
  runBusy: boolean;
  onWhatIf: (changes: Record<string, number>) => void;
  onOpen3d: () => void;
  onClose: () => void;
}) {
  const v = verdict(site);
  const [sources, setSources] = useState(false);
  const p = site.screen?.power;
  return (
    <div className="xp-panel">
      <div className="xp-panel-hero">
        {site.parcelId ? (
          // Vexcel aerial (CoStar's own photo CDN refuses hotlinking)
          // eslint-disable-next-line @next/next/no-img-element
          <img src={vexcelOrthoUrl(site.parcelId)} alt={`Aerial view of ${site.name}`} />
        ) : (
          <div className="xp-panel-hero-empty" />
        )}
        <span className="xp-hero-credit">Vexcel aerial</span>
        <span className="xp-letter">{site.letter}</span>
        <button className="xp-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <div className="xp-panel-body">
        <h2>{site.name}</h2>
        <p className="xp-sub">
          {site.area}
          <br />
          {fmtNum(site.lotAcres, 1)} acres · {(site.propertySubtype || site.propertyType || '').replace(/^Industrial_/, '')}
          {site.availability && site.availability !== 'Not listed' ? ` · ${site.availability}` : ' · Not on the market'}
        </p>

        <div className={`xp-verdict xp-${v.tone}`}>
          {v.tone === 'good' ? <Check size={18} /> : v.tone === 'bad' ? <X size={18} /> : <span>!</span>}
          <div>
            <b>{v.label}</b>
            <span>{v.reason}</span>
          </div>
        </div>

        <div className="xp-scores">
          <Ring value={site.pillars.overall} />
          <div className="xp-bars">
            {[
              { k: 'money', label: 'Money', icon: Wallet },
              { k: 'people', label: 'People', icon: Users },
              { k: 'planet', label: 'Planet', icon: Leaf },
            ].map(({ k, label, icon: Icon }) => {
              const val = site.pillars[k as 'money' | 'people' | 'planet'];
              return (
                <div key={k} className="xp-bar">
                  <span>
                    <Icon size={13} /> {label}
                  </span>
                  <i>
                    <em style={{ width: `${val}%` }} />
                  </i>
                  <b>{Math.round(val)}</b>
                </div>
              );
            })}
          </div>
        </div>

        <RunPanel run={run} siteId={site.id} mw={mw} onWhatIf={onWhatIf} busy={runBusy} />

        <section className="xp-block">
          <div className="xp-block-head">
            <h3>Checks</h3>
            <span className="xp-muted">pass / fail, never averaged</span>
          </div>
          <ul className="xp-checks">
            {site.screen?.gates.map((g) => (
              <li key={g.gate} className={`xp-${g.status === 'Pass' ? 'good' : g.status === 'Fail' ? 'bad' : 'check'}`}>
                <span className="xp-dot" />
                <div>
                  <b>{GATE_TITLE[g.gate] ?? g.gate}</b>
                  <span>{plainGate(g)}</span>
                </div>
              </li>
            ))}
          </ul>
          {p && (
            <p className="xp-fine">
              {p.residential_within_1mi ?? 0} CoStar-recorded homes or apartment communities within 1 mile (a lower bound).
              Existing building power: {p.building_service_mw != null ? `~${p.building_service_mw} MW` : 'unknown'}. Grid
              capacity needs utility confirmation.
            </p>
          )}
        </section>

        {site.parcelId && (
          <section className="xp-block">
            <MatterportPanel site={site} />
          </section>
        )}

        <button className="xp-primary" onClick={onOpen3d}>
          <Box size={16} /> See it in 3D with a {mw} MW campus
        </button>

        <button className="xp-sources" onClick={() => setSources(!sources)}>
          Sources <ChevronDown size={13} style={{ transform: sources ? 'rotate(180deg)' : '' }} />
        </button>
        {sources && (
          <div className="xp-fine xp-source-list">
            <p>{site.provenance}</p>
            <p>Acquisition basis: {site.landCostBasis}</p>
            {site.screen?.gates.map((g) => (
              <p key={g.gate}>
                {g.gate}: {g.source}
                {g.retrieved_at ? `, retrieved ${new Date(g.retrieved_at).toLocaleDateString()}` : ''}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

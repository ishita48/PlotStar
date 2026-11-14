'use client';
import { useEffect, useState } from 'react';
import { Box, Check, ChevronDown, Droplets, Factory, Flame, Leaf, Users, Wallet, X, Zap } from 'lucide-react';
import { PUBLIC_DATA_API, vexcelOrthoUrl } from '@/lib/plotstar-api';
import { LabelTag, MatterportPanel } from '../site-evidence';
import type { ExploreSite } from './types';
import { fmtMoney, fmtNum, GATE_TITLE, plainGate, verdict } from './types';

type Cooling = 'air' | 'hybrid' | 'water';
interface Impact {
  energy_gwh_per_year: number;
  water_gal_per_day: number;
  co2_t_per_year: number;
  capex_usd: number;
  peak_mw_facility: number;
  formula: Record<string, string>;
}

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
  onOpen3d,
  onClose,
}: {
  site: ExploreSite;
  mw: number;
  onOpen3d: () => void;
  onClose: () => void;
}) {
  const v = verdict(site);
  const waterOk = site.screen?.power.water_cooling_ok ?? false;
  const [cooling, setCooling] = useState<Cooling>(waterOk ? 'hybrid' : 'air');
  const [impact, setImpact] = useState<Impact | null>(null);
  const [sources, setSources] = useState(false);
  const fits = site.supportableMw == null ? null : site.supportableMw >= mw;

  useEffect(() => {
    let alive = true;
    fetch(`${PUBLIC_DATA_API}/impact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mw_it: mw, cooling }),
    })
      .then((r) => r.json())
      .then((d) => alive && setImpact(d))
      .catch(() => alive && setImpact(null));
    return () => {
      alive = false;
    };
  }, [mw, cooling]);

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

        <section className="xp-block">
          <div className="xp-block-head">
            <h3>If you build {mw} MW here</h3>
            <LabelTag label="Estimated" />
          </div>
          {fits === false && (
            <p className="xp-warn">
              The lot fits about {site.supportableMw} MW at our density assumption. {mw} MW needs a bigger site or
              phases.
            </p>
          )}
          <div className="xp-cooling">
            {(['air', 'hybrid', 'water'] as Cooling[]).map((c) => (
              <button
                key={c}
                className={cooling === c ? 'on' : ''}
                disabled={c === 'water' && !waterOk}
                title={c === 'water' && !waterOk ? 'Water stress is too high for water cooling here' : ''}
                onClick={() => setCooling(c)}
              >
                {c === 'air' ? 'Air cooled' : c === 'hybrid' ? 'Hybrid' : 'Water cooled'}
              </button>
            ))}
          </div>
          <div className="xp-tiles">
            <div>
              <Zap size={15} />
              <small>Electricity</small>
              <b>{impact ? `${fmtNum(impact.energy_gwh_per_year)} GWh/yr` : '…'}</b>
            </div>
            <div>
              <Droplets size={15} />
              <small>Water</small>
              <b>{impact ? `${fmtNum(impact.water_gal_per_day / 1000)}K gal/day` : '…'}</b>
            </div>
            <div>
              <Flame size={15} />
              <small>Carbon</small>
              <b>{impact ? `${fmtNum(impact.co2_t_per_year / 1000, 1)}K t/yr` : '…'}</b>
            </div>
            <div>
              <Factory size={15} />
              <small>Build cost</small>
              <b>{impact ? fmtMoney(impact.capex_usd) : '…'}</b>
            </div>
          </div>
          <p className="xp-fine">
            Land {fmtMoney(site.landCost)} ({site.labels?.landCost ?? 'Unknown'}). Planning estimates from team assumptions;
            carbon uses a placeholder grid factor until ERCOT hourly data is cached.
          </p>
        </section>

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
            {impact && Object.entries(impact.formula).map(([k, f]) => <p key={k}>{k}: {f}</p>)}
          </div>
        )}
      </div>
    </div>
  );
}

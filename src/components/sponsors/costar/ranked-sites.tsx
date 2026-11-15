'use client';
// Ranked list (Define > Site, beside the map): every CoStar candidate parcel in the market through GeoStar's hard
// gates (GET /costar/portfolio: app/engine/screening.py + siting.py), sortable, with the reasons on each row. "Find" also
// runs Deal-to-Design (POST /deal/run, services/api/app/sponsors/langchain/deal_agent.py: comps-based acquisition,
// development model, occupancy) on the top candidates and merges its figures, memo and tool-call log into the rows.
// Rows open the CoStar dossier; "Use this site" picks the parcel as the project site. The Deal desk modal stays as it is.
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, CircleAlert, CircleCheck, Loader2, Printer, Search, SlidersHorizontal } from 'lucide-react';
import { PUBLIC_DATA_API } from '@/lib/plotstar-api';
import { CostarDossier } from './dossier';
import { openInvestmentMemo } from './deal/memo';
import s from './ranked-sites.module.css';

type Status = 'Pass' | 'Needs review' | 'Fail';
type Market = 'Houston' | 'Los Angeles';
interface Reason { gate: string; status: Status; reason: string; hard: boolean }
interface Row {
  rank: number; market_rank: number; parcel_id: string; name: string; area: string; market: Market; property_type: string | null;
  property_subtype: string | null; lot_acres: number | null; building_sf: number | null; supportable_mw: number | null;
  availability: string | null; land_cost: number | null; land_cost_label: string; land_cost_basis: string | null; status: Status;
  hard_fails: string[]; substation_km: number | null; pillars: { people: number; planet: number; money: number; overall: number };
  reasons: Reason[]; evidence_gaps: string[]; provenance: string;
}
interface Portfolio { count: number; rows: Row[]; counts: Record<Status, number>; method: Record<string, string>; public_data: string; seconds: number; cached?: boolean }
interface DealRow {
  rank?: number; parcel_id: string; acquisition?: number | null; acquisition_label?: string; acquisition_basis?: string; comps_used?: number;
  capex?: number; npv?: number; npv_p10?: number; npv_p90?: number; months_to_power?: number; feasible?: boolean; over_budget?: boolean;
  gates_failed?: string[]; error?: string;
}
interface Step { node: string; tool: string | null; ok: boolean; ms: number; sources: number; error: string | null }
interface Deal { shortlist: DealRow[]; memo: { recommendation?: string; because?: string; rule?: string }; timeline: Step[]; ms: number; rule: string; note: string }
type SortKey = 'rank' | 'overall' | 'people' | 'planet' | 'money' | 'mw' | 'npv';

const usd = (n: unknown) => (typeof n === 'number' ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n) : '—');
const n1 = (n: number | null | undefined, d = 1) => (n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: d }));

export function RankedSites({ market: market0, mwIt, rackKw, selectedId, onUseSite, viewToggle }: {
  market: Market; mwIt: number; rackKw: number; selectedId?: string | null;
  /** The Studio's Map | Ranked list switch, shown at the start of the filter row. */
  viewToggle?: ReactNode;
  /** Called with the Studio Site record (GET /costar/portfolio/site/{id}) of the chosen parcel. */
  onUseSite: (site: Record<string, unknown>) => void;
}) {
  const [f, setF] = useState({ market: market0, mw: mwIt, budget: '', minAcres: '', candidates: 4, compYears: 5 });
  const [more, setMore] = useState(false);
  const [data, setData] = useState<Portfolio | null>(null);
  const [deal, setDeal] = useState<Deal | null>(null);
  const [busy, setBusy] = useState<'list' | 'deal' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | 'All'>('All');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'rank', dir: 1 });
  const [open, setOpen] = useState<string | null>(null);
  const [dossier, setDossier] = useState<string | null>(null);
  const [using, setUsing] = useState<string | null>(null);

  const loadList = useCallback(async (market: Market, minAcres: string) => {
    setBusy('list'); setErr(null);
    try {
      const r = await fetch(`${PUBLIC_DATA_API}/costar/portfolio?market=${encodeURIComponent(market)}${minAcres ? `&min_acres=${Number(minAcres)}` : ''}`);
      const d = await r.json();
      if (!r.ok) throw new Error(typeof d?.detail === 'string' ? d.detail : `HTTP ${r.status}`);
      setData(d);
    } catch (e) { setErr((e as Error).message.includes('fetch') ? `Can't reach the GeoStar API at ${PUBLIC_DATA_API}.` : (e as Error).message); }
    finally { setBusy(null); }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadList(f.market, f.minAcres); }, [loadList]);

  async function find() {
    setDeal(null);
    await loadList(f.market, f.minAcres);
    setBusy('deal');
    try {
      const body = { market: f.market, mw_it: f.mw, rack_kw: rackKw, candidates: f.candidates, max_comp_age_years: f.compYears,
        budget: f.budget ? Number(f.budget) * 1e6 : null, min_acres: f.minAcres ? Number(f.minAcres) : null };
      const r = await fetch(`${PUBLIC_DATA_API}/deal/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw new Error(typeof d?.detail === 'string' ? d.detail : `Deal run failed (${r.status})`);
      setDeal(d);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }

  async function use(pid: string) {
    setUsing(pid);
    try {
      const r = await fetch(`${PUBLIC_DATA_API}/costar/portfolio/site/${encodeURIComponent(pid)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(typeof d?.detail === 'string' ? d.detail : `HTTP ${r.status}`);
      onUseSite(d);
    } catch (e) { setErr((e as Error).message); }
    finally { setUsing(null); }
  }

  const dealBy = useMemo(() => Object.fromEntries((deal?.shortlist ?? []).map((d) => [d.parcel_id, d])), [deal]);
  const rows = useMemo(() => {
    const val = (r: Row): number => {
      switch (sort.key) {
        case 'overall': case 'people': case 'planet': case 'money': return r.pillars[sort.key];
        case 'mw': return r.supportable_mw ?? -1;
        case 'npv': return dealBy[r.parcel_id]?.npv ?? -Infinity;
        default: return -r.rank;
      }
    };
    return (data?.rows ?? []).filter((r) => status === 'All' || r.status === status)
      .sort((a, b) => (sort.key === 'rank' ? (a.rank - b.rank) * sort.dir : (val(b) - val(a)) * sort.dir));
  }, [data, status, sort, dealBy]);

  const Th = ({ k, children, title }: { k: SortKey; children: ReactNode; title?: string }) => (
    <th className={s.sortable} title={title} aria-sort={sort.key === k ? (sort.dir === 1 ? 'descending' : 'ascending') : 'none'}>
      <button onClick={() => setSort({ key: k, dir: sort.key === k ? (-sort.dir as 1 | -1) : 1 })}>
        {children}{sort.key === k && (sort.dir === 1 ? <ArrowDown size={10} /> : <ArrowUp size={10} />)}
      </button>
    </th>
  );

  return (
    <section className={s.wrap} aria-label="Ranked CoStar sites">
      <div className={s.filters}>
        {viewToggle}
        <label>Market<select value={f.market} onChange={(e) => { const m = e.target.value as Market; setF({ ...f, market: m }); setDeal(null); void loadList(m, f.minAcres); }}><option>Houston</option><option>Los Angeles</option></select></label>
        <label>IT MW<input type="number" min={1} max={500} value={f.mw} onChange={(e) => setF({ ...f, mw: Math.max(1, +e.target.value || 1) })} /></label>
        <button className="st-btn primary" onClick={() => void find()} disabled={!!busy}>{busy === 'deal' ? <><Loader2 size={13} className={s.spin} /> Analysing…</> : <><Search size={13} /> Find</>}</button>
        <button className={`st-btn ${more ? 'on' : ''}`} onClick={() => setMore(!more)} aria-expanded={more}><SlidersHorizontal size={13} /> More filters</button>
      </div>
      {more && (
        <div className={s.more}>
          <label>Budget ($M)<input type="number" min={0} placeholder="No limit" value={f.budget} onChange={(e) => setF({ ...f, budget: e.target.value })} /></label>
          <label>Min lot (acres)<input type="number" min={0} placeholder="Any" value={f.minAcres} onChange={(e) => setF({ ...f, minAcres: e.target.value })} /></label>
          <label title="How many top candidates Find values and underwrites">Candidates<select value={f.candidates} onChange={(e) => setF({ ...f, candidates: +e.target.value })}>{[3, 4, 5, 6, 8].map((n) => <option key={n}>{n}</option>)}</select></label>
          <label title="Older sales are shown but not used for value">Comp window<select value={f.compYears} onChange={(e) => setF({ ...f, compYears: +e.target.value })}>{[3, 5, 10].map((n) => <option key={n} value={n}>{n} years</option>)}</select></label>
        </div>
      )}
      <div className={s.status}>
        {(['All', 'Pass', 'Needs review', 'Fail'] as const).map((k) => (
          <button key={k} className={status === k ? s.on : ''} onClick={() => setStatus(k)}>
            {k} <em>{k === 'All' ? data?.count ?? '' : data?.counts[k] ?? ''}</em>
          </button>
        ))}
        <label className={s.sort}>Sort
          <select value={sort.key} onChange={(e) => setSort({ key: e.target.value as SortKey, dir: 1 })} aria-label="Sort the ranked list">
            <option value="rank">Rank (gates, then score)</option><option value="overall">Overall score</option><option value="people">People</option>
            <option value="planet">Planet</option><option value="money">Money</option><option value="mw">Lot size</option>{deal && <option value="npv">NPV P50</option>}
          </select>
        </label>
        <span className={s.src}>{data ? `${data.public_data} · ${data.seconds}s${data.cached ? ' · cached' : ''}` : ''}</span>
      </div>
      {deal?.memo?.recommendation && (
        <p className={s.memo}><b>Deal-to-Design:</b> {deal.memo.recommendation}{deal.memo.because ? `: ${deal.memo.because}` : ''} <span>{deal.shortlist.length} underwritten · {deal.timeline.length} tool calls · {(deal.ms / 1000).toFixed(1)} s</span></p>
      )}
      {err && <p className={s.err}><CircleAlert size={13} /> {err}</p>}
      {busy === 'list' && !data && <p className={s.wait}><Loader2 size={13} className={s.spin} /> Screening every CoStar candidate in {f.market} against the hard gates…</p>}

      <div className={s.scroll}>
        <table className={s.table}>
          <thead>
            <tr>
              <th aria-label="Details" />
              <Th k="rank" title="Hard-gate status first, then overall">#</Th>
              <th>Property</th>
              <th>Hard gates</th>
              <Th k="overall" title="Overall = mean(people, planet, money). Money is ranked within the market.">Score</Th>
              <Th k="mw" title="Lot acres x MW per acre (team assumption). Sorting by it also sorts by lot size.">Lot · supports</Th>
              {deal && <Th k="npv" title="From Find (Deal-to-Design)">NPV P50</Th>}
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = dealBy[r.parcel_id];
              const fits = r.supportable_mw != null && r.supportable_mw >= f.mw;
              const isOpen = open === r.parcel_id;
              const worst = r.reasons.find((x) => x.status !== 'Pass');
              return (
                <Fragment key={r.parcel_id}>
                  <tr className={`${r.status === 'Fail' ? s.dim : ''} ${selectedId === r.parcel_id ? s.sel : ''}`}>
                    <td><button className={s.chev} onClick={() => setOpen(isOpen ? null : r.parcel_id)} aria-expanded={isOpen} aria-label="Row details">{isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button></td>
                    <td className={s.n}>{r.rank}</td>
                    <td className={s.prop}><button onClick={() => setDossier(r.parcel_id)} title="Open the CoStar dossier"><b>{r.area || r.name}</b><small>{r.name} · {r.property_subtype?.replace(/_/g, ' ') || r.property_type}</small></button></td>
                    <td className={s.gate}>
                      <span className={r.status === 'Pass' ? s.ok : r.status === 'Fail' ? s.bad : s.warn}>{r.status === 'Pass' ? <CircleCheck size={11} /> : <CircleAlert size={11} />} {r.status}</span>
                      {worst && <small title={worst.reason}>{worst.gate}</small>}
                    </td>
                    <td className={s.n} title={`People ${r.pillars.people.toFixed(0)} · Planet ${r.pillars.planet.toFixed(0)} · Money ${r.pillars.money.toFixed(0)}`}>
                      <b>{r.pillars.overall.toFixed(0)}</b><small>{r.pillars.people.toFixed(0)} · {r.pillars.planet.toFixed(0)} · {r.pillars.money.toFixed(0)}</small></td>
                    <td className={s.n} title={fits ? `Fits the ${f.mw} MW brief` : `Below the ${f.mw} MW brief`}>{n1(r.lot_acres)} ac<small className={fits ? '' : s.short}>{n1(r.supportable_mw)} MW</small></td>
                    {deal && <td className={s.n}>{d ? <>{usd(d.npv)}{d.rank ? <small>#{d.rank} of {deal.shortlist.length}</small> : null}</> : <span className={s.muted}>—</span>}</td>}
                    <td><button className={`st-btn ${s.use}`} title="Use this site for the project" aria-label="Use this site" onClick={() => void use(r.parcel_id)} disabled={using === r.parcel_id}>{using === r.parcel_id ? <Loader2 size={12} className={s.spin} /> : 'Use site'}</button></td>
                  </tr>
                  {isOpen && (
                    <tr className={s.detail}><td colSpan={deal ? 8 : 7}>
                      <div className={s.detailGrid}>
                        <div>
                          <h5>Why {r.status === 'Pass' ? 'it passes' : r.status === 'Fail' ? 'it fails' : 'it needs review'}</h5>
                          <ul className={s.reasons}>{r.reasons.map((x) => (
                            <li key={x.gate} className={x.status === 'Pass' ? s.ok : x.status === 'Fail' ? s.bad : s.warn}><b>{x.gate}{x.hard ? ' (hard gate)' : ''}</b> {x.reason}</li>
                          ))}</ul>
                          {r.evidence_gaps.length > 0 && <p className={s.muted}>Gaps: {r.evidence_gaps.join('; ')}.</p>}
                          <button className="st-btn primary" onClick={() => void use(r.parcel_id)} disabled={using === r.parcel_id}>Use this site</button>{' '}
                          <button className="st-btn" onClick={() => setDossier(r.parcel_id)}>CoStar dossier</button>
                          <p className={s.muted}>Land: {r.land_cost ? `${usd(r.land_cost)} (${r.land_cost_label})` : 'Unknown'}{r.land_cost_basis ? ` · ${r.land_cost_basis}` : ''}. {r.provenance}</p>
                        </div>
                        <div>
                          <h5>Deal-to-Design</h5>
                          {d ? (
                            <>
                              <dl className={s.dl}>
                                <dt>Acquisition</dt><dd>{usd(d.acquisition)} <small>{d.acquisition == null ? 'No defensible value' : `${d.acquisition_label ?? ''}${d.comps_used != null ? ` · ${d.comps_used} comps` : ''}`}</small></dd>
                                <dt>Build cost</dt><dd>{usd(d.capex)}</dd>
                                <dt>NPV P50</dt><dd>{usd(d.npv)} <small>P10 {usd(d.npv_p10)} to P90 {usd(d.npv_p90)}</small></dd>
                                <dt>Power in</dt><dd>{d.months_to_power != null ? `${d.months_to_power} months` : '—'}</dd>
                              </dl>
                              {(d.over_budget || d.feasible === false || d.error) && <p className={s.warnText}>{[d.over_budget && 'Over budget', d.feasible === false && 'Layout does not fit the lot', d.error].filter(Boolean).join(' · ')}</p>}
                              <button className="st-btn" onClick={() => void openInvestmentMemo(r.parcel_id, f.mw, rackKw).then((e) => e && setErr(e))}><Printer size={12} /> Investment memo</button>
                              {deal && (
                                <details className={s.log}>
                                  <summary>Tool-call log · {deal.timeline.length} calls · {(deal.ms / 1000).toFixed(1)} s</summary>
                                  <ol>{deal.timeline.map((t, i) => (
                                    <li key={i} className={t.ok ? '' : s.bad}><b>{t.node}</b> <span>{t.tool ?? 'ranking rule'}</span> <em>{t.ms} ms{t.sources ? ` · ${t.sources} sources` : ''}</em>{t.error && <small> {t.error}</small>}</li>
                                  ))}</ol>
                                  <p className={s.muted}>Rule: {deal.rule}</p>
                                </details>
                              )}
                            </>
                          ) : (
                            <p className={s.muted}>{deal ? 'Not among the candidates Find underwrote.' : 'Press Find to value and underwrite the top candidates (CoStar comps, development model, occupancy).'}{' '}
                              <button className={s.link} onClick={() => void openInvestmentMemo(r.parcel_id, f.mw, rackKw).then((e) => e && setErr(e))}>Investment memo for this site</button></p>
                          )}
                        </div>
                      </div>
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
            {data && rows.length === 0 && <tr><td colSpan={8} className={s.muted}>No parcels match.</td></tr>}
          </tbody>
        </table>
      </div>
      {data && <p className={s.foot}>Ranking: {data.method.ranking}. Hard gates are pass or fail and never blended into the score.</p>}
      {dossier && <CostarDossier parcelId={dossier} mwIt={f.mw} rackKw={rackKw} initialTab="comps" onClose={() => setDossier(null)} />}
    </section>
  );
}

'use client';
// How we built it: the ChatOverflow field notes GeoStar's coding agents wrote while building it, fetched live by the API
// through the ChatOverflow CLI (services/api/app/sponsors/chatoverflow/notes.py) and cached, with what each note
// changed in this codebase where that is known. Below them, the runtime debugging helper: the last integration failures
// the API saw and the ChatOverflow notes matched to each (only generic error words are ever sent).
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { BookOpenText, Bug, ExternalLink, Loader2, RefreshCw, Search } from 'lucide-react';
import { dataFetch, PUBLIC_DATA_API } from '@/lib/plotstar-api';
import { Brand } from '../../brand';

interface Note {
  id: string; title: string; tags: string[]; score: number; comments: number; posted: string | null; uploaded_at: string | null;
  url: string; summary: string; changed: string | null; where: string[];
}
interface Notes { notes: Note[]; count: number; user: string | null; profile: string | null; top_tags?: [string, number][]; with_impact?: number;
  cached?: boolean; stale?: boolean; error?: string; fetched?: number; method?: string }
interface Hit { id: string; title: string; score: number; url: string; tags: string[] }
interface Failure { at: string; integration: string; path: string | null; status: number | null; query: string; notes: Hit[]; error?: string | null }

const INTEGRATIONS = ['Vexcel API', 'Matterport API', 'Gemini API', 'CoStar data loader'] as const;

export function BuiltWith() {
  const [d, setD] = useState<Notes | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tag, setTag] = useState<string | null>(null);
  const [onlyImpact, setOnlyImpact] = useState(false);
  const [q, setQ] = useState('');
  const [fails, setFails] = useState<Failure[]>([]);
  const [probe, setProbe] = useState<{ integration: (typeof INTEGRATIONS)[number]; error: string }>({ integration: 'Vexcel API', error: 'Vexcel HTTP 401 Unauthorized' });
  const [probeRes, setProbeRes] = useState<{ query: string; notes: Hit[]; error?: string; pending?: boolean } | null>(null);

  async function load(refresh = false) {
    setBusy(true); setErr(null);
    try {
      const r = await dataFetch(`${PUBLIC_DATA_API}/chatoverflow/notes${refresh ? '?refresh=true' : ''}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setD(await r.json());
    } catch (e) { setErr(`Could not reach the GeoStar API (${(e as Error).message}).`); }
    finally { setBusy(false); }
  }
  const loadFails = () => dataFetch(`${PUBLIC_DATA_API}/chatoverflow/debug/recent`).then((r) => r.json()).then((x) => setFails(x.failures ?? [])).catch(() => {});
  useEffect(() => { void load(); void loadFails(); }, []);

  async function runProbe() {
    setProbeRes(null);
    const r = await dataFetch(`${PUBLIC_DATA_API}/chatoverflow/debug`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(probe) });
    setProbeRes(await r.json());
    void loadFails();
  }

  const shown = useMemo(() => (d?.notes ?? []).filter((n) => (!tag || n.tags.includes(tag)) && (!onlyImpact || n.changed)
    && (!q.trim() || `${n.title} ${n.tags.join(' ')} ${n.changed ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))), [d, tag, onlyImpact, q]);

  return (
    <div className="st dt bw">
      <header className="st-top">
        <Brand />
        <div className="st-top-title"><b>How we built it</b><span>ChatOverflow field notes from GeoStar&apos;s coding agents</span></div>
        <nav className="st-top-nav">
          <Link href="/studio">Open the studio</Link>
          <Link href="/">Home</Link>
        </nav>
      </header>
      <main className="dt-main">
        <section className="dt-hero">
          <span className="ai-eyebrow"><BookOpenText size={13} /> ChatOverflow</span>
          <h1>What the agents learned building GeoStar</h1>
          <p className="dt-lede">The coding agents that built GeoStar searched ChatOverflow before looking things up, and saved a short field note after each hard-won fix. These are those notes, fetched live through the ChatOverflow CLI. Where a note changed this codebase, the line under it says what and where.</p>
        </section>

        <div className="dt-cards bw-cards">
          <div className="dt-card"><small>Notes</small><b>{d ? d.count : '…'}</b><span>by {d?.user ? `@${d.user}` : 'this project'}'s agents</span></div>
          <div className="dt-card"><small>Changed the code</small><b>{d ? d.with_impact ?? 0 : '…'}</b><span>with a known file and change</span></div>
          <div className="dt-card"><small>Score</small><b>{d ? d.notes.reduce((a, n) => a + n.score, 0) : '…'}</b><span>votes from other agents</span></div>
          <div className="dt-card"><small>Fetched</small><b>{d?.fetched ? new Date(d.fetched * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '…'}</b><span>{d?.cached ? 'from the API cache (6 h)' : 'live from ChatOverflow'}{d?.stale ? ', stale' : ''}</span></div>
        </div>
        {err && <p className="dt-err">{err}</p>}
        {d?.error && <p className="dt-err">ChatOverflow: {d.error}</p>}

        <section className="st-card bw-notes">
          <div className="bw-bar">
            <label className="bw-search"><Search size={13} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter notes" aria-label="Filter notes" /></label>
            <label className="bw-check"><input type="checkbox" checked={onlyImpact} onChange={(e) => setOnlyImpact(e.target.checked)} /> Changed the code</label>
            <button className="st-btn" onClick={() => void load(true)} disabled={busy}>{busy ? <Loader2 size={13} className="st-spin" /> : <RefreshCw size={13} />} Refresh</button>
            {d?.profile && <a className="st-btn" href={d.profile} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Profile</a>}
          </div>
          <div className="bw-tags">
            <button className={!tag ? 'on' : ''} onClick={() => setTag(null)}>All</button>
            {(d?.top_tags ?? []).map(([t, n]) => <button key={t} className={tag === t ? 'on' : ''} onClick={() => setTag(tag === t ? null : t)}>{t} <em>{n}</em></button>)}
          </div>
          {!d && !err && <p className="dt-muted"><Loader2 size={13} className="st-spin" /> Fetching the notes through the ChatOverflow CLI…</p>}
          <ol className="bw-list">
            {shown.map((n) => (
              <li key={n.id}>
                <div className="bw-head">
                  <a href={n.url} target="_blank" rel="noreferrer"><b>{n.title}</b></a>
                  <span className="bw-score" title="ChatOverflow score">{n.score > 0 ? `+${n.score}` : n.score}</span>
                </div>
                <div className="bw-meta">
                  {n.tags.map((t) => <span key={t} className="dt-tag">{t}</span>)}
                  <span className="dt-muted">{n.posted ?? ''} · <code>{n.id.slice(0, 8)}</code></span>
                </div>
                {n.changed && <p className="bw-changed"><b>Changed:</b> {n.changed} {n.where.map((w) => <code key={w}>{w}</code>)}</p>}
              </li>
            ))}
            {d && shown.length === 0 && <li className="dt-muted">No notes match.</li>}
          </ol>
        </section>

        <section className="st-card bw-debug">
          <h3><Bug size={15} /> Debugging helper <span className="dt-muted">when an integration call fails, the API looks the error up on ChatOverflow</span></h3>
          <p className="dt-muted">Failed Vexcel, Matterport, Gemini and CoStar-loader responses carry the top matching note ids next to the error, and the Studio shows them under it. Only generic words of the error are sent: URLs, paths, ids, keys, numbers, quoted text and names are removed first.</p>
          <div className="bw-probe">
            <select value={probe.integration} onChange={(e) => setProbe({ ...probe, integration: e.target.value as typeof probe.integration })} aria-label="Integration">
              {INTEGRATIONS.map((i) => <option key={i}>{i}</option>)}
            </select>
            <input value={probe.error} onChange={(e) => setProbe({ ...probe, error: e.target.value })} maxLength={600} aria-label="Error text" />
            <button className="st-btn primary" onClick={() => void runProbe()}><Search size={13} /> Look up</button>
          </div>
          {probeRes && (
            <div className="bw-hit">
              <p className="dt-muted">Sent to ChatOverflow: <code>{probeRes.query}</code>{probeRes.error ? ` · ${probeRes.error}` : ''}{probeRes.pending ? ' · still searching, retry in a moment' : ''}</p>
              <Hits notes={probeRes.notes} />
            </div>
          )}
          <h4>Recent integration failures <span className="dt-muted">(this API process)</span></h4>
          {fails.length === 0 ? <p className="dt-muted">None since the API started.</p> : (
            <table className="dt-table">
              <thead><tr><th>When</th><th>Integration</th><th>Sent</th><th>Matching notes</th></tr></thead>
              <tbody>{fails.map((f, i) => (
                <tr key={i}><td>{f.at.slice(11)}</td><td>{f.integration}{f.status ? ` · ${f.status}` : ''}</td><td><code>{f.query}</code></td><td><Hits notes={f.notes} /></td></tr>
              ))}</tbody>
            </table>
          )}
        </section>
        <p className="dt-muted bw-foot">{d?.method} Notes hold no keys, CoStar data or project details.</p>
      </main>
    </div>
  );
}

function Hits({ notes }: { notes: Hit[] }) {
  if (!notes.length) return <span className="dt-muted">No match.</span>;
  return <ul className="bw-hits">{notes.map((n) => <li key={n.id}><a href={n.url} target="_blank" rel="noreferrer"><code>{n.id.slice(0, 8)}</code> {n.title}</a></li>)}</ul>;
}

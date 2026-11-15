'use client';
// The visible debate (services/api/app/sponsors/langchain/deep_agents/debate.py): finance, community and grid
// specialists argue the concept choice in two rounds and the orchestrator sums up. Every claim cites facts from a fact
// sheet computed by GeoStar's engines; each claim shows those facts and whether its numbers matched them.
import { useState } from 'react';
import { ArrowRight, CircleAlert, CircleCheck, Scale } from 'lucide-react';
import type { Debate, DebateClaim, DebateFact } from './use-agent-run';

const LENS_COLOUR: Record<string, string> = { finance: '#1f4a36', community: '#6fa24e', grid: '#8f6b12' };

function FactChip({ id, facts }: { id: string; facts: Record<string, DebateFact> }) {
  const f = facts[id];
  return <span className={`db-fact ${f ? '' : 'bad'}`} title={f ? `${f.concept}: ${f.text} (${f.label}, ${f.owner})` : 'Unknown fact id'}>{id}{f ? ` · ${f.text}` : ' ?'}</span>;
}

function ClaimRow({ c, facts }: { c: DebateClaim; facts: Record<string, DebateFact> }) {
  return (
    <li className={`db-claim ${c.stance}`}>
      <div className="db-claim-head">
        <code>{c.id}</code>
        <span className={`db-stance ${c.stance}`}>{c.stance}{c.responds_to ? <> <ArrowRight size={10} /> {c.responds_to}</> : null}</span>
        <span className={`db-check ${c.grounded ? 'ok' : 'warn'}`}>{c.grounded ? <CircleCheck size={11} /> : <CircleAlert size={11} />} {c.grounded ? 'numbers match the facts' : c.unverified_numbers.length ? `unverified: ${c.unverified_numbers.join(', ')}` : 'no valid fact cited'}</span>
      </div>
      <p>{c.text}</p>
      <div className="db-facts">{c.facts.map((id) => <FactChip key={id} id={id} facts={facts} />)}</div>
    </li>
  );
}

export function DebateView({ d }: { d: Debate }) {
  const [showFacts, setShowFacts] = useState(false);
  const facts = Object.fromEntries(d.facts.map((f) => [f.id, f]));
  const claims = d.rounds.flatMap((r) => r.turns.flatMap((t) => t.claims));
  const grounded = claims.filter((c) => c.grounded).length;
  return (
    <div className="db">
      <header className="db-head">
        <div><span className="ai-eyebrow"><Scale size={13} /> Debate · {d.mode === 'model' ? 'Claude specialists' : 'rule-based'}</span><h3>{d.question}</h3>
          <p className="ai-dim">{d.note} {claims.length} claims, {grounded} with numbers that match the facts they cite. Concepts: {d.concepts.map((c) => `${c.name} (rank ${c.rank})`).join(' · ')}.</p></div>
      </header>
      {d.summary && (
        <section className={`db-summary ${d.summary.grounded ? 'ok' : 'warn'}`}>
          <small>Orchestrator&apos;s summary</small>
          <b>Recommend: {d.summary.recommendation_name}</b>
          <p>{d.summary.text}</p>
          {d.summary.agreements.length > 0 && <p className="ai-dim"><b>Agreed:</b> {d.summary.agreements.join(' · ')}</p>}
          {d.summary.open_disagreements.length > 0 && <p className="ai-dim"><b>Still disputed:</b> {d.summary.open_disagreements.join(' · ')}</p>}
          <div className="db-facts">{d.summary.facts.map((id) => <FactChip key={id} id={id} facts={facts} />)}</div>
        </section>
      )}
      {d.rounds.map((r) => (
        <section key={r.round} className="db-round">
          <h4>Round {r.round} · {r.round === 1 ? 'opening positions' : 'rebuttals'}</h4>
          <div className="db-turns">
            {r.turns.map((t) => (
              <article key={t.agent} className="db-turn" style={{ borderTopColor: LENS_COLOUR[t.lens] ?? '#1f4a36' }}>
                <header><b>{t.title}</b><span>backs <em>{t.position_name}</em></span></header>
                <ol>{t.claims.map((c) => <ClaimRow key={c.id} c={c} facts={facts} />)}</ol>
              </article>
            ))}
            {r.turns.length < 3 && <article className="db-turn db-wait"><span className="ai-dim">Waiting for the other specialists…</span></article>}
          </div>
        </section>
      ))}
      <button className="st-btn" onClick={() => setShowFacts(!showFacts)}>{showFacts ? 'Hide' : 'Show'} the fact sheet ({d.facts.length} computed facts)</button>
      {showFacts && (
        <table className="db-sheet">
          <thead><tr><th>Id</th><th>Concept</th><th>Fact</th><th>Owner</th><th>Label</th></tr></thead>
          <tbody>{d.facts.map((f) => <tr key={f.id}><td><code>{f.id}</code></td><td>{f.concept}</td><td>{f.text}</td><td>{f.owner}</td><td>{f.label}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}

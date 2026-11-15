'use client';
// Starts the visible debate (POST /agents/debate) on the Studio's current brief, site and concepts, and opens the
// Agent Intelligence panel, where the rounds appear in the live graph and the Debate tab.
import { Scale } from 'lucide-react';
import type { RunState } from './use-agent-run';

export function DebateButton({ body, agent, onOpen, disabled }: {
  body: Record<string, unknown>; disabled?: boolean; onOpen: () => void;
  agent: { state: RunState; start: (path: '/agents/debate', body: unknown, title: string) => Promise<string | null> };
}) {
  const live = agent.state.kind === 'debate' && (agent.state.status === 'running' || agent.state.status === 'starting');
  return (
    <button className="st-btn" disabled={disabled || live} title="Finance, community and grid specialists argue which concept to build, with every claim tied to computed numbers"
      onClick={() => { void agent.start('/agents/debate', body, 'Which concept should we build?'); onOpen(); }}>
      <Scale size={13} /> {live ? 'Debating…' : 'Debate the concepts'}
    </button>
  );
}

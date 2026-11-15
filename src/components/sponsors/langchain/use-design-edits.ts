'use client';
// Applies layout edits the Design Editor agent made after a person approved them (deep_agents/design_agent.py emits a
// `design_edit` event with the full edit for one concept). Each approved edit is applied once, through the Studio's own
// commit function, so the engine re-measures it exactly like a hand edit.
import { useEffect, useRef } from 'react';
import type { RunState } from './use-agent-run';

export function useAgentDesignEdits<E>(s: RunState, apply: (conceptId: string, edit: E) => void) {
  const seen = useRef<string>('');
  const fn = useRef(apply);
  fn.current = apply;
  useEffect(() => {
    const last = s.designEdits.length ? `${s.runId}:${s.designEdits.length}` : '';
    if (!last || last === seen.current) return;
    seen.current = last;
    const d = s.designEdits[s.designEdits.length - 1];
    fn.current(d.concept_id, d.edit as E);
  }, [s.runId, s.designEdits]);
}

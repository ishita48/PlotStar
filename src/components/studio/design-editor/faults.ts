// Which object a failing engine check is about, so the editor can turn that object red with the engine's reason.
// The engine decides pass/fail; this only points at the culprit, and only for checks the engine reports as failing.
// When the engine names the objects itself (check.codes) that list is used as is.
import type { Concept } from '../types';

export type Faults = Record<string, string[]>;
interface R { code: string; x: number; y: number; w: number; d: number }

const overlap = (a: R, b: R) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.05 && Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y) > 0.05;

export function faultsOf(c: Concept, siteW: number, siteD: number, setback: number): { byCode: Faults; general: string[] } {
  const byCode: Faults = {};
  const general: string[] = [];
  let hits = 0;
  const add = (code: string, why: string) => { hits++; (byCode[code] ??= []).includes(why) || byCode[code].push(why); };
  const all: R[] = [{ code: 'BUILDING', ...c.building }, ...c.yard];
  for (const k of c.checks) {
    if (k.ok) continue;
    if (k.codes?.length) { k.codes.forEach((code) => add(code, `${k.name}: ${k.detail}`)); continue; }
    hits = 0;
    if (k.name === 'Inside the setback') {
      for (const r of all) {
        const m = Math.min(r.x, r.y, siteW - r.x - r.w, siteD - r.y - r.d);
        if (m < setback - 1e-6) add(r.code, m < 0 ? 'Outside the site boundary' : `${m.toFixed(1)} m from the boundary; the setback is ${setback} m`);
      }
    } else if (k.name === 'Nothing overlaps') {
      all.forEach((a, i) => all.slice(i + 1).forEach((b) => {
        if (overlap(a, b)) { add(a.code, `Overlaps ${b.code === 'BUILDING' ? 'the building' : b.code}`); add(b.code, `Overlaps ${a.code === 'BUILDING' ? 'the building' : a.code}`); }
      }));
    } else if (k.name === 'Fits the building envelope') add('BUILDING', k.detail);
    else if (/generator noise|backup power/i.test(k.name) && c.yard.some((y) => y.code === 'GEN')) add('GEN', `${k.name}: ${k.detail}`);
    else if (/obstacle/i.test(k.name)) {
      const named = all.filter((r) => k.detail.includes(r.code === 'BUILDING' ? 'Building' : r.code));
      named.forEach((r) => add(r.code, k.detail));
    }
    if (!hits) general.push(`${k.name}: ${k.detail}`);
  }
  return { byCode, general };
}

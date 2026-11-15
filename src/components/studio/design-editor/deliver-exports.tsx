'use client';
// Deliver: one CAD/BIM export panel (format dropdown) and the decision evidence report. Every file is built in the
// browser from the engine's response for the chosen concept; nothing is re-computed here.
import { useState } from 'react';
import { Download, FileJson } from 'lucide-react';
import type { Concept, StudioResult } from '../types';
import { download } from '../types';
import { downloadDxf, downloadMassingGlb } from './export';
import { conceptIfc } from './ifc';
import { COLUMN_GRID_M } from './geometry';

const FORMATS = {
  dxf: { label: 'DXF plan (layered, metres)', note: 'R12 ASCII. Layers SITE, SETBACK, BUILDING, ROOM_<type>, YARD_<type>, ADDED_<type>, RACK_ROWS, GENERATORS, ROUTE_<kind>, LABELS. Local site coordinates in metres: x east, y north, origin at the south-west corner of the site rectangle.' },
  glb: { label: 'GLB 3D massing', note: 'glTF binary: rooms per storey, outdoor items at their stated heights, generators and the site plate, named by code. A massing model; no aerial photo, no Vexcel mesh.' },
  ifc: { label: 'IFC4 spaces and massing', note: 'IFC4 (STEP): project, site, building, a storey per level, an IfcSpace per room and an IfcBuildingElementProxy per outdoor item, as extruded rectangles. No walls, slabs, doors or MEP elements.' },
} as const;
type Fmt = keyof typeof FORMATS;

const slug = (s: string) => s.replace(/\W+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'concept';

export const FORMULAS = [
  'Racks = ceil(IT MW x 1000 / rack kW); halls default to about 5 MW each.',
  'Facility MW = IT MW x PUE for the chosen cooling (pue_<cooling>).',
  'Cost to build = equipment (IT MW x capex_per_mw x equipment_share_of_capex x redundancy factor) + cooling plant (IT MW x cooling_capex_<cooling>) + shell (gross floor m2 x shell_cost_per_m2 x (1 + (storeys - 1) x multistorey_cost_premium)) + distribution (power route m x busway_cost_per_m + cooling route m x pipe_cost_per_m) + grid connection (km to substation x interconnect_cost_per_km) + added items.',
  'Added items = battery MWh (m2 x bess_mwh_per_m2) x bess_cost_per_mwh + canopy kWp (m2 x roof_solar_kw_per_m2) x solar_cost_per_kwp + tank m2 x tank_cost_per_m2 + parking m2 x paving_cost_per_m2 + tree buffer m2 x landscape_cost_per_m2 + gatehouse m2 x gatehouse_cost_per_m2 + noise wall length x noise_wall_cost_per_m. Custom objects are measured but not costed.',
  'Energy per year = IT MW x it_load_factor x 8760 h x PUE x average wholesale price, with the flexible share moved to cheaper hours.',
  'Ten-year cost = cost to build + land + 10 x (energy + operations + water) per year.',
  'Net present value over analysis_years at discount_rate; the likely range is the 10th to 90th percentile of 400 draws on delay, build cost, revenue and energy price.',
  'Site coverage = (building footprint + outdoor items except tree buffers) / site area.',
  'Generator noise at a distance = genset_dba_at_7m + 10 log10(generators needed) - noise_wall_loss_dba (if a noise wall is within 20 m) - 20 log10(distance / 7 m).',
  'Water per year = IT MWh x WUE (L/kWh) for the chosen cooling. Carbon per year = facility MWh x grid carbon intensity.',
  'Solar potential kWp = footprint x roof_solar_usable_share x roof_solar_kw_per_m2 + canopy kWp.',
];
export const LIMITATIONS = [
  'The site is a rectangle derived from the recorded lot size; the true parcel shape is not in the data.',
  'Layouts are conceptual: rooms are sized from per-MW planning assumptions. Nothing here is engineering design or a code review (fire, egress, structure, utility).',
  'Cost, energy, water and carbon figures use the listed assumptions; those marked verify need a source check. The grid connection cost is a scenario, not a quote.',
  `The 3D view draws a ${COLUMN_GRID_M} m column grid, doors, exits and in-hall cooling units as drawing aids from GeoStar assumptions; they are not designed elements and are not exported as such.`,
  'Objects proposed by an AI model are sized by stated rules and engine assumptions and then checked by the engine like any other edit; their source is recorded.',
  'Exports: DXF holds 2D polylines and labels; GLB is a massing model; IFC4 holds spaces and proxies only.',
];

export function evidenceReport(base: Record<string, unknown>, chosen: Concept, r: StudioResult) {
  return {
    ...base,
    generated_at: new Date().toISOString(),
    generator: 'GeoStar Studio',
    chosen_concept: { id: chosen.id, name: chosen.name, variant: chosen.variant ?? null, why: chosen.why ?? null, edited: !!chosen.edited, removed: chosen.removed ?? [] },
    quantities: { metrics: chosen.metrics, money: chosen.money, people: chosen.people, planet: chosen.planet, resources: chosen.resources },
    checks: chosen.checks,
    feasible: chosen.feasible,
    formulas: FORMULAS,
    limitations: LIMITATIONS,
    coordinates: { units: 'metres', frame: 'x east, y north, origin at the south-west corner of the site rectangle', site_w: r.brief.site_w, site_d: r.brief.site_d, setback_m: r.brief.setback_m },
  };
}

export function DeliverExports({ result, chosen, report, project }: { result: StudioResult; chosen: Concept; report: Record<string, unknown>; project: string }) {
  const [fmt, setFmt] = useState<Fmt>('dxf');
  const [busy, setBusy] = useState(false);
  const { site_w: W, site_d: D, setback_m: S } = result.brief;
  const go = async () => {
    setBusy(true);
    try {
      if (fmt === 'dxf') downloadDxf(chosen, W, D, S, project);
      else if (fmt === 'glb') await downloadMassingGlb(chosen, W, D, project);
      else download(`${slug(project)}-${slug(chosen.id)}.ifc`, conceptIfc(chosen, W, D, project), 'application/x-step');
    } finally { setBusy(false); }
  };
  const failing = chosen.checks.filter((k) => !k.ok);
  return (
    <>
      <div className="st-card dx-card">
        <h3>CAD and BIM export</h3>
        <p className="st-muted">The chosen concept as drawn, including your edits. Units are metres in local site coordinates.</p>
        <div className="dx-row">
          <select value={fmt} onChange={(e) => setFmt(e.target.value as Fmt)} aria-label="Export format">
            {(Object.keys(FORMATS) as Fmt[]).map((k) => <option key={k} value={k}>{FORMATS[k].label}</option>)}
          </select>
          <button className="st-btn primary" onClick={() => void go()} disabled={busy}><Download size={14} /> {busy ? 'Preparing…' : 'Download'}</button>
        </div>
        <p className="st-small st-muted">{FORMATS[fmt].note}</p>
        <p className="st-small"><span className="st-tag st-tag-estimated">Prototype</span> Concept geometry for coordination. Not for construction.</p>
      </div>
      <div className="st-card dx-card">
        <h3>Decision evidence</h3>
        <p className="st-muted">One JSON file with the brief, the site gates and their sources, the chosen concept&apos;s geometry and quantities, every check ({failing.length ? `${failing.length} failing` : 'all passing'}), every assumption with its basis, the formulas behind the numbers and the limitations of this prototype.</p>
        <button className="st-btn" onClick={() => download(`${slug(project)}-decision.json`, JSON.stringify(evidenceReport(report, chosen, result), null, 2), 'application/json')}>
          <FileJson size={14} /> Download decision report</button>
      </div>
    </>
  );
}

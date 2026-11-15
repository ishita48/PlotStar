// Minimal IFC4 (STEP, ISO-10303-21) export of one concept: project, site, building, one storey per level, an IfcSpace
// per room and an IfcBuildingElementProxy per outdoor item, each with a simple extruded rectangle. Units are metres,
// coordinates are the site frame (x east, y north, origin at the site's south-west corner). It is a massing and space
// model for coordination, not a BIM of walls, slabs or MEP.
import type { Concept } from '../types';

const B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
/** A random IFC GlobalId (22 characters of IFC base64 over 128 bits). */
export function ifcGuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  for (let i = 0; i < 22; i++) { s = B64[Number(n & 63n)] + s; n >>= 6n; }
  return s;
}
const str = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '?').slice(0, 250)}'`;
const num = (n: number) => { const v = Number.isFinite(n) ? n : 0; const s = v.toFixed(4).replace(/0+$/, ''); return s.endsWith('.') ? `${s}` : s.includes('.') ? s : `${s}.`; };

export function conceptIfc(c: Concept, siteW: number, siteD: number, project: string): string {
  const L: string[] = [];
  let id = 0;
  const add = (e: string) => { id += 1; L.push(`#${id}=${e};`); return `#${id}`; };
  const pt3 = (x: number, y: number, z: number) => add(`IFCCARTESIANPOINT((${num(x)},${num(y)},${num(z)}))`);
  const origin = pt3(0, 0, 0);
  const zDir = add('IFCDIRECTION((0.,0.,1.))');
  const world = add(`IFCAXIS2PLACEMENT3D(${origin},$,$)`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${world},$)`);
  const body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const units = add(`IFCUNITASSIGNMENT((${add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)')},${add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)')},${add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)')},${add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)')}))`);
  const proj = add(`IFCPROJECT('${ifcGuid()}',$,${str(project)},${str(`GeoStar concept ${c.name}. Planning evidence, not engineering design.`)},$,$,$,(${ctx}),${units})`);
  const place = (rel: string | null, x: number, y: number, z: number) => add(`IFCLOCALPLACEMENT(${rel ?? '$'},${add(`IFCAXIS2PLACEMENT3D(${pt3(x, y, z)},$,$)`)})`);
  /** a w x d rectangle from its south-west corner, extruded h metres up */
  const box = (w: number, d: number, h: number) => {
    const p2 = add(`IFCAXIS2PLACEMENT2D(${add(`IFCCARTESIANPOINT((${num(w / 2)},${num(d / 2)}))`)},$)`);
    const prof = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${p2},${num(Math.max(0.01, w))},${num(Math.max(0.01, d))})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(${prof},${world},${zDir},${num(Math.max(0.01, h))})`);
    return add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${add(`IFCSHAPEREPRESENTATION(${body},'Body','SweptSolid',(${solid}))`)}))`);
  };
  const sitePl = place(null, 0, 0, 0);
  const site = add(`IFCSITE('${ifcGuid()}',$,'Site',${str(`Site rectangle ${siteW.toFixed(0)} x ${siteD.toFixed(0)} m (estimated from lot size)`)},$,${sitePl},${box(siteW, siteD, 0.01)},$,.ELEMENT.,$,$,$,$,$)`);
  const bPl = place(sitePl, 0, 0, 0);
  const bld = add(`IFCBUILDING('${ifcGuid()}',$,${str(c.name)},$,$,${bPl},$,$,.ELEMENT.,$,$,$)`);
  const fh = c.building.floor_h ?? 6;
  const storeys: string[] = [], storeyPl: string[] = [];
  for (let l = 0; l < c.building.storeys; l++) {
    const pl = place(bPl, 0, 0, l * fh);
    storeyPl.push(pl);
    storeys.push(add(`IFCBUILDINGSTOREY('${ifcGuid()}',$,'Level ${l + 1}',$,$,${pl},$,$,.ELEMENT.,${num(l * fh)})`));
  }
  const spaces: string[][] = storeys.map(() => []);
  for (const r of c.rooms) {
    const l = Math.min(c.building.storeys - 1, r.level ?? 0);
    const pl = place(storeyPl[l], r.x, r.y, 0);
    spaces[l].push(add(`IFCSPACE('${ifcGuid()}',$,${str(r.code)},${str(`${r.name}; ${Math.round(r.w * r.d)} m2`)},${str(r.type)},${pl},${box(r.w, r.d, r.type === 'corridor' ? 0.15 : fh)},${str(r.name)},.ELEMENT.,.INTERNAL.,$)`));
  }
  const yard: string[] = [];
  for (const y of c.yard) {
    const pl = place(sitePl, y.x, y.y, 0);
    yard.push(add(`IFCBUILDINGELEMENTPROXY('${ifcGuid()}',$,${str(y.code)},${str(`${y.name}${y.added ? ' (added in GeoStar)' : ''}${y.source ? `; ${y.source}` : ''}`)},${str(y.type)},${pl},${box(y.w, y.d, y.h ?? 3)},${str(y.code)},.NOTDEFINED.)`));
  }
  add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${proj},(${site}))`);
  add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${site},(${bld}))`);
  add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${bld},(${storeys.join(',')}))`);
  storeys.forEach((s, i) => { if (spaces[i].length) add(`IFCRELAGGREGATES('${ifcGuid()}',$,$,$,${s},(${spaces[i].join(',')}))`); });
  if (yard.length) add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${ifcGuid()}',$,$,$,(${yard.join(',')}),${site})`);
  const stamp = new Date().toISOString().slice(0, 19);
  return [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('GeoStar concept export: spaces and massing'),'2;1');",
    `FILE_NAME(${str(`${project}.ifc`)},'${stamp}',('GeoStar'),('GeoStar'),'GeoStar Studio','GeoStar Studio','');`,
    "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;', ...L, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
}

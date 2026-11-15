// Client-side exports of the concept being edited: a layered 2D DXF and a 3D GLB of the three.js scene.
import * as THREE from 'three';
import type { Concept } from '../types';
import { download } from '../types';

const slug = (s: string) => s.replace(/\W+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'concept';
const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').slice(0, 120);

/** ASCII DXF (R12 entities, metres, site frame: x east, y north, origin at the site's south-west corner). Layers:
 * SITE, SETBACK, BUILDING, ROOM_<TYPE>[_L<n>], YARD_<TYPE> (generated), ADDED_<TYPE> (placed by the user or an
 * accepted proposal), RACK_ROWS, GENERATORS, ROUTE_<KIND>, LABELS. */
export function conceptDxf(c: Concept, siteW: number, siteD: number, setback: number): string {
  const out: string[] = [
    '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1009', '9', '$INSUNITS', '70', '6', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
  ];
  const f = (n: number) => n.toFixed(3);
  const rect = (layer: string, x: number, y: number, w: number, d: number) => {
    out.push('0', 'POLYLINE', '8', layer, '66', '1', '70', '1');
    for (const [px, py] of [[x, y], [x + w, y], [x + w, y + d], [x, y + d]]) out.push('0', 'VERTEX', '8', layer, '10', f(px), '20', f(py), '30', '0');
    out.push('0', 'SEQEND');
  };
  const text = (x: number, y: number, h: number, s: string) =>
    out.push('0', 'TEXT', '8', 'LABELS', '10', f(x), '20', f(y), '30', '0', '40', Math.max(0.3, h).toFixed(2), '1', clean(s));
  rect('SITE', 0, 0, siteW, siteD);
  text(1, siteD + 1, 2, `Site ${siteW.toFixed(0)} x ${siteD.toFixed(0)} m, setback ${setback} m. ${c.name}. GeoStar concept, not engineering design.`);
  if (setback > 0) rect('SETBACK', setback, setback, siteW - 2 * setback, siteD - 2 * setback);
  rect('BUILDING', c.building.x, c.building.y, c.building.w, c.building.d);
  for (const r of c.rooms) {
    rect(`ROOM_${r.type.toUpperCase()}${c.building.storeys > 1 && r.level != null ? `_L${r.level + 1}` : ''}`, r.x, r.y, r.w, r.d);
    if ((r.level ?? 0) === 0) text(r.x + 0.5, r.y + 0.5, Math.min(1.2, r.d / 4), `${r.code} ${r.name}`);
    for (const row of r.rows ?? []) rect('RACK_ROWS', row.x, row.y, row.v ? row.w : (row.w * row.n) / row.cap, row.v ? (row.d * row.n) / row.cap : row.d);
  }
  for (const y of c.yard) {
    rect(`${y.added ? 'ADDED' : 'YARD'}_${y.type.toUpperCase()}`, y.x, y.y, y.w, y.d);
    text(y.x + 0.3, y.y + 0.3, Math.min(1.5, Math.max(0.3, Math.min(y.w, y.d) / 4)), `${y.code} ${y.name}${y.source ? ` (${y.source})` : ''}`);
  }
  for (const e of c.equipment) rect('GENERATORS', e.x, e.y, e.w, e.d);
  for (const kind of ['power', 'cooling', 'data'] as const)
    for (const line of c.routes[kind])
      for (let i = 0; i < line.length - 1; i++)
        out.push('0', 'LINE', '8', `ROUTE_${kind.toUpperCase()}`, '10', f(line[i][0]), '20', f(line[i][1]), '11', f(line[i + 1][0]), '21', f(line[i + 1][1]));
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\n');
}

export function downloadDxf(c: Concept, siteW: number, siteD: number, setback: number, project: string) {
  download(`${slug(project)}-${slug(c.id)}.dxf`, conceptDxf(c, siteW, siteD, setback), 'application/dxf');
}

const skip = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData?.noExport) return true; return false; };

/** A clean copy of the model: real geometry only (no aerial photo, no Vexcel mesh, no tags, handles, highlights or
 * proposals), world transforms baked in, parts merged into one node per object code (and one for glass). */
export async function downloadGlb(scene: THREE.Scene, c: Concept, project: string): Promise<void> {
  const [{ GLTFExporter }, { mergeGeometries }] = await Promise.all([
    import('three/examples/jsm/exporters/GLTFExporter.js'),
    import('three/examples/jsm/utils/BufferGeometryUtils.js'),
  ]);
  scene.updateMatrixWorld(true);
  const root = new THREE.Group();
  root.name = `GeoStar ${c.name}`;
  root.userData = { concept: c.id, units: 'metres', frame: 'x east, y up, z south; origin at the site centre', note: 'GeoStar concept, not engineering design' };
  const buckets = new Map<string, { geos: THREE.BufferGeometry[]; transparent: boolean; opacity: number }>();
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.visible || skip(o)) return;
    const mat = (Array.isArray(o.material) ? o.material[0] : o.material) as THREE.MeshStandardMaterial;
    if (!mat || (mat as unknown as THREE.ShaderMaterial).isShaderMaterial || !o.geometry?.attributes?.position) return;
    const base = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()) as THREE.BufferGeometry;
    for (const k of Object.keys(base.attributes)) if (k !== 'position' && k !== 'normal') base.deleteAttribute(k);
    if (!base.attributes.normal) base.computeVertexNormals();
    const paint = (g: THREE.BufferGeometry, col: THREE.Color) => {
      const n = g.attributes.position.count, a = new Float32Array(n * 3);
      for (let v = 0; v < n; v++) { a[v * 3] = col.r; a[v * 3 + 1] = col.g; a[v * 3 + 2] = col.b; }
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
      return g;
    };
    const add = (code: string, g: THREE.BufferGeometry) => {
      const key = `${code || 'Site'}${mat.transparent ? ' (glass)' : ''}`;
      const b = buckets.get(key) ?? { geos: [], transparent: !!mat.transparent, opacity: mat.opacity ?? 1 };
      b.geos.push(g); buckets.set(key, b);
    };
    const tint = mat.color ?? new THREE.Color('#cccccc');
    if (o instanceof THREE.InstancedMesh) {
      const codes: string[] = o.userData.codes ?? [];
      const m = new THREE.Matrix4(), col = new THREE.Color();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        if (o.instanceColor) o.getColorAt(i, col); else col.copy(tint);
        add(codes[i], paint(base.clone().applyMatrix4(m.premultiply(o.matrixWorld)), col));
      }
    } else add(o.userData.code ?? '', paint(base.applyMatrix4(o.matrixWorld), tint));
  });
  for (const [name, b] of buckets) {
    const merged = mergeGeometries(b.geos, false);
    b.geos.forEach((g) => g.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05, transparent: b.transparent, opacity: b.opacity }));
    mesh.name = name;
    root.add(mesh);
  }
  const glb = await new GLTFExporter().parseAsync(root, { binary: true });
  root.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([glb as ArrayBuffer], { type: 'model/gltf-binary' }));
  a.download = `${slug(project)}-${slug(c.id)}.glb`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** A GLB massing model built straight from the engine's geometry (no 3D view needed): rooms as boxes per storey,
 * outdoor items as boxes at their stated heights, the site as a thin plate. Y is up, metres, origin at the site's
 * south-west corner (glTF x = east, -z = north). */
export async function downloadMassingGlb(c: Concept, siteW: number, siteD: number, project: string): Promise<void> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const { TYPE_STYLE } = await import('../types');
  const root = new THREE.Group();
  root.name = `GeoStar ${c.name} (massing)`;
  root.userData = { concept: c.id, units: 'metres', frame: 'x east, y up, -z north; origin at the site south-west corner', note: 'Massing model, not engineering design' };
  const mats = new Map<string, THREE.MeshStandardMaterial>();
  const mat = (color: string, opacity = 1) => {
    const k = `${color}${opacity}`;
    if (!mats.has(k)) mats.set(k, new THREE.MeshStandardMaterial({ color, roughness: 0.85, transparent: opacity < 1, opacity }));
    return mats.get(k)!;
  };
  const box = (name: string, x: number, y: number, z: number, w: number, d: number, h: number, color: string, opacity = 1) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.05, w), Math.max(0.02, h), Math.max(0.05, d)), mat(color, opacity));
    m.position.set(x + w / 2, z + h / 2, -(y + d / 2));
    m.name = name;
    root.add(m);
  };
  box('Site', 0, 0, -0.05, siteW, siteD, 0.05, '#d5dece');
  const fh = c.building.floor_h ?? 6;
  for (const r of c.rooms) box(`${r.code} ${r.name}`, r.x, r.y, (r.level ?? 0) * fh, r.w, r.d, r.type === 'corridor' ? 0.15 : fh * 0.9, TYPE_STYLE[r.type]?.fill ?? '#dddddd', r.type === 'corridor' ? 1 : 0.85);
  for (const y of c.yard) box(`${y.code} ${y.name}`, y.x, y.y, 0, y.w, y.d, Math.max(0.1, y.h ?? 3), TYPE_STYLE[y.type]?.stroke ?? '#888888');
  for (const e of c.equipment) box(e.code, e.x, e.y, 0, e.w, e.d, e.h, '#8a6a2a');
  const glb = await new GLTFExporter().parseAsync(root, { binary: true });
  root.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
  mats.forEach((m) => m.dispose());
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([glb as ArrayBuffer], { type: 'model/gltf-binary' }));
  a.download = `${slug(project)}-${slug(c.id)}-massing.glb`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

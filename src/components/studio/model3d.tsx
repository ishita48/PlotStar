'use client';
// Detailed 3D model of one concept on the real Vexcel aerial of the site. Everything is built from the same
// geometry as the 2D plan: individual racks, aisle containment, cable trays, equipment in each room, outdoor plant.
// In edit mode the building and each outdoor item can be dragged; the parent re-checks the numbers on release.
import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useLoader, useThree, type ThreeEvent } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { vexcelOrthoUrl } from '@/lib/plotstar-api';
import type { Concept, Room, RoomType } from './types';
import { ROUTE_COLOR } from './types';
import type { Layers } from './plan2d';

const WALL = 4.2;
const FLOOR: Record<RoomType, string> = {
  data_hall: '#dde5dc', electrical: '#efe2c4', battery: '#ecd3c8', mechanical: '#cfe1ea', corridor: '#c6d4c1', support: '#e4e0ee',
  network: '#dbd3ea', loading: '#e6e0d0', reserve: '#eef0ea', yard_sub: '#b9bdb6', yard_gen: '#cfc8b4', yard_cool: '#c5d6de',
  yard_water: '#c9d6dc', yard_bess: '#d6dad3', yard_solar: '#c9d3c4',
};
/** One box in site coordinates: x east, y north, z up (metres), from its minimum corner. */
interface B { x: number; y: number; z: number; w: number; d: number; h: number; color: string; code?: string }
interface Cyl { x: number; y: number; r: number; h: number; color: string }
export interface MoveEdit { code: string; dx: number; dy: number }
export type ViewPreset = { preset: 'iso' | 'top'; n: number };

function fill(out: B[], r: Room, u: { w: number; d: number; h: number; color: string }, max: number, aisle = 1.4) {
  const m = 1.2, along = r.w >= r.d;
  const len = (along ? r.w : r.d) - 2 * m, span = (along ? r.d : r.w) - 2 * m;
  if (len < u.w || span < u.d) return;
  const perRow = Math.floor(len / (u.w + 0.06)), rows = Math.max(1, Math.floor((span + aisle) / (u.d + aisle)));
  let n = 0;
  for (let j = 0; j < rows && n < max; j++)
    for (let i = 0; i < perRow && n < max; i++, n++) {
      const a = m + i * (u.w + 0.06), b = m + j * (u.d + aisle);
      out.push(along ? { x: r.x + a, y: r.y + b, z: 0.12, w: u.w, d: u.d, h: u.h, color: u.color, code: r.code }
        : { x: r.x + b, y: r.y + a, z: 0.12, w: u.d, d: u.w, h: u.h, color: u.color, code: r.code });
    }
}

function buildBuilding(c: Concept, racks: boolean) {
  const solid: B[] = [], glass: B[] = [], glow: B[] = [];
  const t = 0.25;
  for (const r of c.rooms) {
    solid.push({ x: r.x, y: r.y, z: 0, w: r.w, d: r.d, h: 0.12, color: FLOOR[r.type], code: r.code });
    if (r.type === 'corridor' || r.type === 'reserve') continue;
    for (const w of [{ x: r.x, y: r.y, w: r.w, d: t }, { x: r.x, y: r.y + r.d - t, w: r.w, d: t }, { x: r.x, y: r.y, w: t, d: r.d }, { x: r.x + r.w - t, y: r.y, w: t, d: r.d }])
      solid.push({ ...w, z: 0, h: WALL, color: '#eceee9', code: r.code });
    if (r.type === 'data_hall' && racks) {
      const rows = r.rows ?? [];
      rows.forEach((w, j) => {
        const rw = w.w / w.cap;
        for (let i = 0; i < w.n; i++) solid.push({ x: w.x + i * rw + 0.02, y: w.y, z: 0.12, w: rw - 0.04, d: w.d, h: 2.1, color: i % 9 === 4 ? '#2c353b' : '#1d2327', code: r.code });
        if (w.n) {
          glow.push({ x: w.x, y: w.y + w.d - 0.03, z: 1.85, w: (w.w * w.n) / w.cap, d: 0.05, h: 0.07, color: '#58c8ff' });
          solid.push({ x: w.x, y: w.y + 0.35, z: 2.55, w: w.w, d: 0.5, h: 0.08, color: '#d7a23c', code: r.code });
        }
        const nx = rows[j + 1];
        if (j % 2 === 0 && nx && w.n && nx.n) glass.push({ x: w.x, y: w.y + w.d, z: 0.12, w: w.w, d: nx.y - w.y - w.d, h: 2.25, color: '#7fc4e8' });
      });
      solid.push({ x: r.x + r.w - 1.5, y: r.y + 1, z: 2.7, w: 0.6, d: r.d - 2, h: 0.08, color: '#d7a23c', code: r.code });
    } else if (r.type === 'electrical') {
      if (r.code.startsWith('SWG')) fill(solid, r, { w: 1.0, d: 1.6, h: 2.3, color: '#8d9398' }, 24);
      else fill(solid, r, { w: 0.8, d: 0.9, h: 2.0, color: '#5f7384' }, 40);
    } else if (r.type === 'battery') fill(solid, r, { w: 0.6, d: 1.0, h: 1.9, color: '#3f6b54' }, 60, 1.2);
    else if (r.type === 'mechanical') {
      fill(solid, r, { w: 1.4, d: 2.2, h: 2.2, color: '#4f86a6' }, 20, 2);
      const along = r.w >= r.d;
      for (const k of [0.35, 0.65])
        solid.push(along ? { x: r.x + 0.8, y: r.y + r.d * k, z: 3.1, w: r.w - 1.6, d: 0.32, h: 0.32, color: '#2f7fb0', code: r.code }
          : { x: r.x + r.w * k, y: r.y + 0.8, z: 3.1, w: 0.32, d: r.d - 1.6, h: 0.32, color: '#2f7fb0', code: r.code });
    } else if (r.type === 'network') fill(solid, r, { w: 0.6, d: 1.0, h: 2.1, color: '#3a3350' }, 16);
    else if (r.type === 'loading') fill(solid, r, { w: 1.2, d: 1.2, h: 1.1, color: '#c9a24a' }, 14, 2.6);
    else if (r.type === 'support') {
      fill(solid, r, { w: 1.6, d: 0.8, h: 0.75, color: '#b6a888' }, r.code.startsWith('NOC') ? 12 : r.code.startsWith('SEC') ? 3 : 24, 2);
      if (r.code.startsWith('NOC')) glow.push({ x: r.x + 0.6, y: r.y + r.d - 0.5, z: 1.1, w: Math.min(r.w - 1.2, 9), d: 0.1, h: 1.9, color: '#3ea6ff' });
    }
  }
  const b = c.building, e = 0.45, hx = WALL + 0.8;
  for (const w of [{ x: b.x - e, y: b.y - e, w: b.w + 2 * e, d: e }, { x: b.x - e, y: b.y + b.d, w: b.w + 2 * e, d: e }, { x: b.x - e, y: b.y, w: e, d: b.d }, { x: b.x + b.w, y: b.y, w: e, d: b.d }])
    solid.push({ ...w, z: 0, h: hx, color: '#cfd5cc' });
  return { solid, glass, glow };
}

function buildRoof(c: Concept) {
  const b = c.building, z = WALL + 1.1, out: B[] = [];
  const mx = b.w * 0.11, my = b.d * 0.11; // panels on the central ~60% of the roof
  for (let y = b.y + my; y + 3.6 < b.y + b.d - my; y += 4.4)
    for (let x = b.x + mx; x + 5.8 < b.x + b.w - mx; x += 6.2) out.push({ x, y, z, w: 5.8, d: 3.6, h: 0.1, color: '#1f3a5f' });
  return out;
}

function buildYard(r: Room, c: Concept) {
  const solid: B[] = [{ x: r.x, y: r.y, z: 0, w: r.w, d: r.d, h: 0.1, color: FLOOR[r.type], code: r.code }];
  const cyl: Cyl[] = [];
  const grid = (uw: number, ud: number, gx: number, gy: number, max: number, each: (x: number, y: number) => void) => {
    let n = 0;
    for (let y = r.y + 1.5; y + ud <= r.y + r.d - 1 && n < max; y += ud + gy)
      for (let x = r.x + 1.5; x + uw <= r.x + r.w - 1 && n < max; x += uw + gx, n++) each(x, y);
  };
  if (r.type === 'yard_gen') {
    for (const g of c.equipment) {
      solid.push({ x: g.x - 0.15, y: g.y, z: 0.1, w: g.w + 0.3, d: g.d, h: 0.6, color: '#3b3f3c', code: r.code });
      solid.push({ x: g.x, y: g.y + 0.2, z: 0.7, w: g.w, d: g.d - 0.4, h: 2.9, color: '#e3ddcb', code: r.code });
      solid.push({ x: g.x + 0.1, y: g.y + 0.2, z: 0.9, w: g.w - 0.2, d: 0.12, h: 2.3, color: '#8f978f', code: r.code });
      solid.push({ x: g.x + g.w / 2 - 0.25, y: g.y + g.d - 2.2, z: 3.6, w: 0.5, d: 0.5, h: 1.7, color: '#2b2f2d', code: r.code });
    }
  } else if (r.type === 'yard_sub') {
    const along = r.w >= r.d, n = Math.max(2, Math.min(4, Math.round((r.w * r.d) / 500)));
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      const tx = along ? r.x + r.w * f - 2 : r.x + r.w / 2 - 2, ty = along ? r.y + r.d / 2 - 2.5 : r.y + r.d * f - 2.5;
      solid.push({ x: tx, y: ty, z: 0.1, w: 4, d: 5, h: 3.6, color: '#6f7d74', code: r.code });
      solid.push({ x: tx - 0.8, y: ty + 0.4, z: 0.4, w: 0.7, d: 4.2, h: 2.8, color: '#58645c', code: r.code }, { x: tx + 4.1, y: ty + 0.4, z: 0.4, w: 0.7, d: 4.2, h: 2.8, color: '#58645c', code: r.code });
      for (const k of [0.8, 1.85, 2.9]) solid.push({ x: tx + k, y: ty + 2.3, z: 3.7, w: 0.3, d: 0.3, h: 1.6, color: '#cfc7b3', code: r.code });
    }
    const gy = r.y + r.d - 3;
    solid.push({ x: r.x + 3, y: gy, z: 0.1, w: 0.4, d: 0.4, h: 9, color: '#8a918b', code: r.code }, { x: r.x + r.w - 3.4, y: gy, z: 0.1, w: 0.4, d: 0.4, h: 9, color: '#8a918b', code: r.code },
      { x: r.x + 3, y: gy, z: 8.8, w: r.w - 6, d: 0.4, h: 0.4, color: '#8a918b', code: r.code });
    for (const w of [{ x: r.x, y: r.y, w: r.w, d: 0.1 }, { x: r.x, y: r.y + r.d - 0.1, w: r.w, d: 0.1 }, { x: r.x, y: r.y, w: 0.1, d: r.d }, { x: r.x + r.w - 0.1, y: r.y, w: 0.1, d: r.d }])
      solid.push({ ...w, z: 0.1, h: 2.4, color: '#7b857e', code: r.code });
  } else if (r.type === 'yard_cool') {
    grid(2.4, 6, 1.4, 1.6, 80, (x, y) => {
      solid.push({ x, y, z: 0.1, w: 2.4, d: 6, h: 2.5, color: '#dfe7ea', code: r.code });
      for (const k of [0.6, 3.5]) solid.push({ x: x + 0.3, y: y + k, z: 2.6, w: 1.8, d: 1.8, h: 0.12, color: '#2e3b42', code: r.code });
    });
  } else if (r.type === 'yard_water') cyl.push({ x: r.x + r.w / 2, y: r.y + r.d / 2, r: Math.min(r.w, r.d) / 2 - 1, h: r.h ?? 8, color: '#c9d9e2' });
  else if (r.type === 'yard_bess') {
    grid(6, 2.4, 1.6, 1.4, 60, (x, y) => {
      solid.push({ x, y, z: 0.1, w: 6, d: 2.4, h: 2.9, color: '#f4f5f2', code: r.code });
      solid.push({ x: x + 0.2, y: y - 0.03, z: 0.4, w: 1.4, d: 0.06, h: 2.2, color: '#3b8f5e', code: r.code });
    });
  } else if (r.type === 'yard_solar') {
    for (const [px, py] of [[0.5, 0.5], [r.w - 0.8, 0.5], [0.5, r.d - 0.8], [r.w - 0.8, r.d - 0.8], [r.w / 2, 0.5], [r.w / 2, r.d - 0.8]])
      solid.push({ x: r.x + px, y: r.y + py, z: 0.1, w: 0.25, d: 0.25, h: 3.6, color: '#8a918b', code: r.code });
    for (let y = r.y + 0.2; y + 3.6 <= r.y + r.d; y += 3.9)
      for (let x = r.x + 0.2; x + 5.8 <= r.x + r.w; x += 6.0) solid.push({ x, y, z: 3.7, w: 5.8, d: 3.6, h: 0.1, color: '#1f3a5f', code: r.code });
  }
  return { solid, cyl };
}

function Boxes({ boxes, cx, cz, kind = 'solid', onPick, onDown }: {
  boxes: B[]; cx: number; cz: number; kind?: 'solid' | 'glass' | 'glow'; onPick?: (code: string | null) => void;
  onDown?: (e: ThreeEvent<PointerEvent>, code: string | undefined) => void;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), col = new THREE.Color();
    boxes.forEach((b, i) => {
      m.compose(new THREE.Vector3(b.x + b.w / 2 - cx, b.z + b.h / 2, cz - (b.y + b.d / 2)), q, new THREE.Vector3(b.w, b.h, b.d));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, col.set(b.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [boxes, cx, cz]);
  if (!boxes.length) return null;
  return (
    <instancedMesh ref={ref} key={boxes.length} args={[undefined, undefined, boxes.length]} castShadow={kind === 'solid'} receiveShadow={kind === 'solid'}
      onClick={onPick ? (e) => { e.stopPropagation(); onPick(boxes[e.instanceId ?? 0]?.code ?? null); } : undefined}
      onPointerDown={onDown ? (e) => onDown(e, boxes[e.instanceId ?? 0]?.code) : undefined}>
      <boxGeometry args={[1, 1, 1]} />
      {kind === 'glow' ? <meshBasicMaterial toneMapped={false} />
        : kind === 'glass' ? <meshStandardMaterial transparent opacity={0.26} roughness={0.15} depthWrite={false} />
          : <meshStandardMaterial roughness={0.82} metalness={0.04} />}
    </instancedMesh>
  );
}

function Tag({ text, at, size, strong }: { text: string; at: [number, number, number]; size: number; strong?: boolean }) {
  const { tex, aspect } = useMemo(() => {
    const c = document.createElement('canvas'), g = c.getContext('2d')!;
    const font = '600 30px Arial, Helvetica, sans-serif';
    g.font = font;
    const w = Math.ceil(g.measureText(text).width) + 44, h = 60;
    c.width = w; c.height = h;
    g.font = font;
    g.fillStyle = strong ? '#264d39' : '#ffffff';
    g.strokeStyle = strong ? '#264d39' : '#9fb0a3';
    g.lineWidth = 3;
    g.beginPath(); g.roundRect(2, 2, w - 4, h - 4, 12); g.fill(); g.stroke();
    g.fillStyle = strong ? '#ffffff' : '#18231d';
    g.textBaseline = 'middle';
    g.fillText(text, 22, h / 2 + 1);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return { tex: t, aspect: w / h };
  }, [text, strong]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <group>
      <Line points={[[at[0], WALL, at[2]], [at[0], at[1] - size / 2, at[2]]]} color={strong ? '#264d39' : '#6f7d74'} lineWidth={1.2} />
      {/* constant size on screen, so tags stay readable without growing when you zoom in */}
      <sprite position={at} scale={[0.025 * aspect, 0.025, 1]} renderOrder={20}>
        <spriteMaterial map={tex} depthTest={false} transparent sizeAttenuation={false} />
      </sprite>
    </group>
  );
}

class Safe extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

function Aerial({ id, half }: { id: string; half: number }) {
  const tex = useLoader(THREE.TextureLoader, vexcelOrthoUrl(id, Math.round(half)));
  const map = useMemo(() => { tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; return tex; }, [tex]);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.08, 0]} receiveShadow>
      <planeGeometry args={[half * 2, half * 2]} />
      <meshStandardMaterial map={map} roughness={1} />
    </mesh>
  );
}

function Rig({ view, target, span }: { view: ViewPreset; target: [number, number, number]; span: number }) {
  const { camera, controls } = useThree();
  useEffect(() => {
    if (view.preset === 'top') camera.position.set(target[0], span * 1.7, target[2] + 0.01);
    else camera.position.set(target[0] + span * 0.62, span * 0.72, target[2] + span * 0.86);
    const c = controls as unknown as { target: THREE.Vector3; update: () => void } | null;
    c?.target.set(...target);
    c?.update();
  }, [view, camera, controls, target, span]);
  return null;
}

const TAGGED: RoomType[] = ['data_hall', 'reserve','yard_sub', 'yard_gen', 'yard_cool', 'yard_water', 'yard_bess', 'yard_solar'];

export default function Model3D({ concept, siteW, siteD, setback, layers, selected, onSelect, aerialId, edit, onMove, view }: {
  concept: Concept; siteW: number; siteD: number; setback: number; layers: Layers; selected: string | null;
  onSelect: (code: string | null) => void; aerialId: string | null; edit: boolean; onMove: (m: MoveEdit) => void; view: ViewPreset;
}) {
  const cx = siteW / 2, cz = siteD / 2;
  const b = concept.building;
  const frame = useMemo(() => {
    const all = [b, ...concept.yard];
    const x0 = Math.min(...all.map((r) => r.x)), x1 = Math.max(...all.map((r) => r.x + r.w));
    const y0 = Math.min(...all.map((r) => r.y)), y1 = Math.max(...all.map((r) => r.y + r.d));
    return { target: [(x0 + x1) / 2 - cx, 0, cz - (y0 + y1) / 2] as [number, number, number], span: Math.max(x1 - x0, y1 - y0) * 0.95 + 45 };
    // frame once per concept so the camera does not jump while editing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [concept.id, siteW, siteD]);
  const building = useMemo(() => buildBuilding(concept, layers.racks), [concept, layers.racks]);
  const roofPanels = useMemo(() => (layers.roof > 0 ? buildRoof(concept) : []), [concept, layers.roof]);
  const yard = useMemo(() => concept.yard.map((r) => ({ r, ...buildYard(r, concept) })), [concept]);
  const trees = useMemo(() => {
    const out: B[] = [];
    if (aerialId && layers.aerial) return out;
    if (setback < 5) return out;
    const m = setback / 2;
    for (let x = m; x < siteW - m; x += 15) out.push({ x: x - 2, y: m - 2, z: 1.2, w: 4, d: 4, h: 4.6, color: x % 30 < 15 ? '#5d8a5e' : '#4c7a52' }, { x: x - 2, y: siteD - m - 2, z: 1.2, w: 4, d: 4, h: 4.6, color: '#57855a' });
    for (let y = m + 15; y < siteD - m - 8; y += 15) out.push({ x: m - 2, y: y - 2, z: 1.2, w: 4, d: 4, h: 4.6, color: '#57855a' }, { x: siteW - m - 2, y: y - 2, z: 1.2, w: 4, d: 4, h: 4.6, color: '#4c7a52' });
    return out;
  }, [aerialId, layers.aerial, setback, siteW, siteD]);

  // dragging: `drag` while the pointer is down, `held` between release and the re-checked layout arriving
  const [drag, setDrag] = useState<(MoveEdit & { sx: number; sz: number }) | null>(null);
  const [held, setHeld] = useState<MoveEdit | null>(null);
  useEffect(() => setHeld(null), [concept]);
  const ground = (e: ThreeEvent<PointerEvent>) => e.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
  const isYard = (code: string | undefined) => !!code && concept.yard.some((y) => y.code === code);
  const down = (e: ThreeEvent<PointerEvent>, code: string | undefined) => {
    if (!edit || !code) return;
    const p = ground(e);
    if (!p) return;
    e.stopPropagation();
    setDrag({ code: isYard(code) ? code : 'BUILDING', dx: 0, dy: 0, sx: p.x, sz: p.z });
  };
  const move = (e: ThreeEvent<PointerEvent>) => {
    if (!drag) return;
    const p = ground(e);
    if (p) setDrag({ ...drag, dx: Math.round(p.x - drag.sx), dy: Math.round(drag.sz - p.z) });
  };
  useEffect(() => {
    if (!drag) return;
    const up = () => {
      if (drag.dx || drag.dy) { setHeld({ code: drag.code, dx: drag.dx, dy: drag.dy }); onMove({ code: drag.code, dx: drag.dx, dy: drag.dy }); }
      setDrag(null);
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, [drag, onMove]);
  const off = (code: string): [number, number, number] => {
    const m = drag?.code === code ? drag : held?.code === code ? held : null;
    return m ? [m.dx, 0, -m.dy] : [0, 0, 0];
  };

  const sel = [...concept.rooms, ...concept.yard].find((r) => r.code === selected);
  const tagSize = frame.span * 0.03;
  const half = Math.min(600, Math.max(siteW, siteD) / 2 + 90);
  const showAerial = !!aerialId && layers.aerial;
  const reach = Math.max(siteW, siteD) * 0.6 + 60; // the light and its shadow box cover the whole site
  const pos = (r: { x: number; y: number; w: number; d: number }, y: number): [number, number, number] => [r.x + r.w / 2 - cx, y, cz - (r.y + r.d / 2)];
  const loading = concept.rooms.find((r) => r.type === 'loading');

  return (
    <Canvas shadows dpr={[1, 2]} camera={{ position: [frame.target[0] + frame.span * 0.62, frame.span * 0.72, frame.target[2] + frame.span * 0.86], fov: 36, near: 1, far: 12000 }}
      onPointerMissed={() => onSelect(null)} style={{ cursor: drag ? 'grabbing' : edit ? 'grab' : 'auto' }}>
      <color attach="background" args={['#e9ede6']} />
      <hemisphereLight args={['#ffffff', '#aab6a3', 0.75]} />
      <directionalLight position={[reach * 0.9, reach * 1.25, reach * 0.55]} intensity={2.1} castShadow
        shadow-mapSize={[4096, 4096]} shadow-bias={-0.0005} shadow-normalBias={0.05}>
        <orthographicCamera attach="shadow-camera" args={[-reach, reach, reach, -reach, 1, reach * 6]} />
      </directionalLight>
      <Rig view={view} target={frame.target} span={frame.span} />

      {/* ground: the real aerial of the site when there is one */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.12, 0]} receiveShadow onPointerMove={move}>
        <planeGeometry args={[6000, 6000]} />
        <meshStandardMaterial color="#dfe5d9" roughness={1} />
      </mesh>
      {showAerial && <Safe><Suspense fallback={null}><Aerial id={aerialId!} half={half} /></Suspense></Safe>}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.04, 0]} receiveShadow>
        <planeGeometry args={[siteW, siteD]} />
        <meshStandardMaterial color={showAerial ? '#f4f6f1' : '#d5dece'} transparent opacity={showAerial ? 0.2 : 1} roughness={1} />
      </mesh>
      <Line points={[[-cx, 0.05, -cz], [cx, 0.05, -cz], [cx, 0.05, cz], [-cx, 0.05, cz], [-cx, 0.05, -cz]]} color="#2f6a48" lineWidth={2.5} />
      <Line points={[[-cx + setback, 0.05, -cz + setback], [cx - setback, 0.05, -cz + setback], [cx - setback, 0.05, cz - setback], [-cx + setback, 0.05, cz - setback], [-cx + setback, 0.05, -cz + setback]]}
        color="#6f8f79" lineWidth={1.2} dashed dashSize={4} gapSize={3} />
      {loading && b.y > 4 && (
        <mesh position={[loading.x + loading.w / 2 - cx, 0, cz - b.y / 2]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[7, b.y]} />
          <meshStandardMaterial color="#5d625f" roughness={1} />
        </mesh>
      )}
      <Boxes boxes={trees} cx={cx} cz={cz} />

      {/* building */}
      <group position={off('BUILDING')}>
        <Boxes boxes={building.solid} cx={cx} cz={cz} onPick={onSelect} onDown={down} />
        <Boxes boxes={building.glow} cx={cx} cz={cz} kind="glow" />
        <Boxes boxes={building.glass} cx={cx} cz={cz} kind="glass" />
        {layers.roof > 0 && (
          <>
            <mesh position={pos(b, WALL + 0.95)}>
              <boxGeometry args={[b.w + 0.9, 0.3, b.d + 0.9]} />
              <meshStandardMaterial color="#f1f3ee" transparent opacity={layers.roof} depthWrite={layers.roof > 0.95} roughness={0.9} />
            </mesh>
            <Boxes boxes={roofPanels} cx={cx} cz={cz} />
          </>
        )}
        {sel && !isYard(sel.code) && (
          <mesh position={pos(sel, WALL / 2 + 0.2)}>
            <boxGeometry args={[sel.w + 0.3, WALL + 0.5, sel.d + 0.3]} />
            <meshStandardMaterial color="#2f9a63" transparent opacity={0.22} depthWrite={false} />
          </mesh>
        )}
        {layers.tags && concept.rooms.filter((r) => TAGGED.includes(r.type) || r.code === selected).map((r) => (
          <Tag key={r.code} text={r.name} at={pos(r, WALL + tagSize * 1.6)} size={tagSize} strong={r.code === selected} />
        ))}
      </group>

      {/* outdoor plant: each item moves on its own */}
      {layers.yard && yard.map(({ r, solid, cyl }) => (
        <group key={r.code} position={off(r.code)}>
          <Boxes boxes={solid} cx={cx} cz={cz} onPick={onSelect} onDown={down} />
          {cyl.map((k, i) => (
            <mesh key={i} position={[k.x - cx, k.h / 2 + 0.1, cz - k.y]} castShadow onClick={(e) => { e.stopPropagation(); onSelect(r.code); }} onPointerDown={(e) => down(e, r.code)}>
              <cylinderGeometry args={[k.r, k.r, k.h, 40]} />
              <meshStandardMaterial color={k.color} roughness={0.6} metalness={0.2} />
            </mesh>
          ))}
          {selected === r.code && (
            <mesh position={pos(r, 2.2)}>
              <boxGeometry args={[r.w + 0.4, 4.4, r.d + 0.4]} />
              <meshStandardMaterial color="#2f9a63" transparent opacity={0.2} depthWrite={false} />
            </mesh>
          )}
          {layers.tags && <Tag text={r.name} at={pos(r, WALL + tagSize * 1.6)} size={tagSize} strong={r.code === selected} />}
        </group>
      ))}

      {(['power', 'cooling', 'data'] as const).map((k, ki) => layers[k] && concept.routes[k].map((line, i) => (
        <Line key={`${k}${i}`} points={line.map(([x, y]) => [x - cx, WALL + 1.6 + ki * 0.5, cz - y] as [number, number, number])} color={ROUTE_COLOR[k]} lineWidth={2.5} />
      )))}
      <OrbitControls makeDefault enabled={!drag} target={frame.target} maxPolarAngle={Math.PI / 2.06} minDistance={12} maxDistance={frame.span * 7} />
    </Canvas>
  );
}

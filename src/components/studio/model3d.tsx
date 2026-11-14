'use client';
// 3D model of one concept, built from the same geometry as the plan. Roof off so the rooms and racks are visible.
import { useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import type { Concept, Room } from './types';
import { ROUTE_COLOR, TYPE_STYLE } from './types';
import type { Layers } from './plan2d';

const WALL = 3.2;

function Box({ r, cx, cz, h, color, selected, onSelect, opacity = 1 }: {
  r: { x: number; y: number; w: number; d: number }; cx: number; cz: number; h: number; color: string; selected?: boolean;
  onSelect?: () => void; opacity?: number;
}) {
  return (
    <mesh position={[r.x + r.w / 2 - cx, h / 2, cz - (r.y + r.d / 2)]} castShadow receiveShadow
      onClick={onSelect ? (e) => { e.stopPropagation(); onSelect(); } : undefined}>
      <boxGeometry args={[r.w, h, r.d]} />
      <meshStandardMaterial color={selected ? '#3b8f5e' : color} transparent={opacity < 1} opacity={opacity} roughness={0.85} />
    </mesh>
  );
}

function RoomMesh({ r, cx, cz, selected, onSelect, racks }: {
  r: Room; cx: number; cz: number; selected: boolean; onSelect: () => void; racks: boolean;
}) {
  const st = TYPE_STYLE[r.type];
  const flat = r.type === 'corridor' || r.type === 'reserve';
  const t = 0.25; // wall thickness
  const walls = flat ? [] : [
    { x: r.x, y: r.y, w: r.w, d: t }, { x: r.x, y: r.y + r.d - t, w: r.w, d: t },
    { x: r.x, y: r.y, w: t, d: r.d }, { x: r.x + r.w - t, y: r.y, w: t, d: r.d },
  ];
  return (
    <group>
      <Box r={r} cx={cx} cz={cz} h={0.2} color={selected ? '#9fd0af' : st.fill} onSelect={onSelect} />
      {walls.map((w, i) => <Box key={i} r={w} cx={cx} cz={cz} h={WALL} color={selected ? '#3b8f5e' : '#c9cfc8'} onSelect={onSelect} />)}
      {racks && r.rows?.map((w, i) => w.n > 0 && (
        <Box key={`r${i}`} r={{ x: w.x, y: w.y, w: (w.w * w.n) / w.cap, d: w.d }} cx={cx} cz={cz} h={2.2} color="#27332d" onSelect={onSelect} />
      ))}
      {!flat && r.type !== 'data_hall' && (
        <Box r={{ x: r.x + r.w * 0.2, y: r.y + r.d * 0.2, w: r.w * 0.6, d: r.d * 0.6 }} cx={cx} cz={cz} h={1.9} color={st.stroke}
          onSelect={onSelect} opacity={0.85} />
      )}
    </group>
  );
}

export default function Model3D({ concept, siteW, siteD, layers, selected, onSelect }: {
  concept: Concept; siteW: number; siteD: number; layers: Layers; selected: string | null; onSelect: (code: string | null) => void;
}) {
  const cx = siteW / 2, cz = siteD / 2;
  const span = Math.max(concept.building.w + 70, concept.building.d) * 1.5 + 60;
  const target = useMemo<[number, number, number]>(
    () => [concept.building.x + concept.building.w / 2 - cx + 15, 0, cz - (concept.building.y + concept.building.d / 2)],
    [concept, cx, cz],
  );
  return (
    <Canvas shadows camera={{ position: [target[0] + span * 0.7, span * 0.85, target[2] + span * 0.95], fov: 38, near: 1, far: 9000 }}
      onPointerMissed={() => onSelect(null)}>
      <color attach="background" args={['#eef1ea']} />
      <ambientLight intensity={0.85} />
      <directionalLight position={[span, span * 1.4, span * 0.6]} intensity={1.5} castShadow shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-span} shadow-camera-right={span} shadow-camera-top={span} shadow-camera-bottom={-span} shadow-camera-far={span * 5} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]} receiveShadow>
        <planeGeometry args={[siteW, siteD]} />
        <meshStandardMaterial color="#dfe6d8" roughness={1} />
      </mesh>
      <Line points={[[-cx, 0.1, -cz], [cx, 0.1, -cz], [cx, 0.1, cz], [-cx, 0.1, cz], [-cx, 0.1, -cz]]} color="#3b6b50" lineWidth={2} />
      {concept.rooms.map((r) => (
        <RoomMesh key={r.code} r={r} cx={cx} cz={cz} selected={selected === r.code} onSelect={() => onSelect(r.code)} racks={layers.racks} />
      ))}
      {layers.yard && concept.yard.map((r) => (
        <Box key={r.code} r={r} cx={cx} cz={cz} h={r.type === 'yard_gen' ? 0.25 : (r.h ?? 4)} color={selected === r.code ? '#3b8f5e' : TYPE_STYLE[r.type].stroke}
          opacity={r.type === 'yard_gen' ? 1 : 0.9} onSelect={() => onSelect(r.code)} />
      ))}
      {layers.yard && concept.equipment.map((e) => <Box key={e.code} r={e} cx={cx} cz={cz} h={e.h} color="#8a6a2a" />)}
      {(['power', 'cooling', 'data'] as const).map((k, ki) => layers[k] && concept.routes[k].map((line, i) => (
        <Line key={`${k}${i}`} points={line.map(([x, y]) => [x - cx, WALL + 0.6 + ki * 0.5, cz - y] as [number, number, number])}
          color={ROUTE_COLOR[k]} lineWidth={2.5} />
      )))}
      <OrbitControls makeDefault target={target} maxPolarAngle={Math.PI / 2.05} minDistance={25} maxDistance={span * 6} />
    </Canvas>
  );
}

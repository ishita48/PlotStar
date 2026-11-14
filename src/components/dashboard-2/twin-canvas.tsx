'use client';
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import { Vector3 } from 'three';
import { BuildingBatch, STATIC_BUILDING_PARTS } from './haven/building-shell';
import { floorY } from './haven/building-layout';
import { evacuationPlans, monitoringPoints, type Point3 } from '@/lib/haven/config';
import {
  activeIncidents,
  effectivePlan,
  routeAvailability,
  type ProtectionState,
} from '@/lib/haven/engine';

function Camera({
  floor,
  command,
}: {
  floor: number | null;
  command: { sequence: number; action: string };
}) {
  const { camera, invalidate } = useThree();
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const previousFloor = useRef(floor);
  useEffect(() => {
    const target = new Vector3(0, floor ? floorY(floor) + 0.2 : 4.2, 0);
    if (previousFloor.current === floor && (command.action === 'in' || command.action === 'out'))
      camera.position
        .sub(target)
        .multiplyScalar(command.action === 'in' ? 0.8 : 1.2)
        .add(target);
    else camera.position.set(16, (floor ? floorY(floor) : 4) + 11, 18);
    controls.current?.target.copy(target);
    camera.lookAt(target);
    controls.current?.update();
    previousFloor.current = floor;
    invalidate();
  }, [camera, floor, command, invalidate]);
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      minDistance={6}
      maxDistance={60}
      maxPolarAngle={Math.PI / 2.05}
      enableDamping={false}
    />
  );
}
function Model({
  state,
  floor,
  operational,
  onPick,
}: {
  state: ProtectionState;
  floor: number | null;
  operational: boolean;
  onPick: (id: string) => void;
}) {
  const incidents = activeIncidents(state);
  const hazard = incidents.some((i) => i.kind === 'leak' || i.kind === 'fire');
  const fire = incidents.some((i) => i.kind === 'fire');
  const plan = effectivePlan(state);
  const available = routeAvailability(state);
  const parts = useMemo(
    () =>
      STATIC_BUILDING_PARTS.filter((p) => floor === null || (p.floor === floor && !p.roof)).map(
        (p) => ({
          ...p,
          color:
            hazard &&
            p.floor === 4 &&
            p.position[0] > 1 &&
            (p.entity.startsWith('room') || p.entity.startsWith('corridor'))
              ? fire
                ? '#e48272'
                : '#dca472'
              : p.color,
        }),
      ),
    [floor, hazard, fire],
  );
  const path = plan ? evacuationPlans[plan].points : [];
  const segments: Point3[][] = [];
  for (let i = 1; i < path.length; i++)
    if (
      floor === null ||
      (Math.abs(path[i][1] - (floorY(floor) + 0.3)) < 0.15 &&
        Math.abs(path[i - 1][1] - path[i][1]) < 0.15)
    )
      segments.push([path[i - 1], path[i]]);
  return (
    <group>
      <mesh position={[0, -0.06, 0]}>
        <boxGeometry args={[20, 0.12, 15]} />
        <meshStandardMaterial color="#e2e9dc" />
      </mesh>
      <BuildingBatch items={parts} onPick={onPick} />
      {operational &&
        monitoringPoints
          .filter(
            (s) => state.config[s.protection].enabled && (floor === null || floor === s.floor),
          )
          .map((sensor) => (
            <mesh
              key={sensor.id}
              position={sensor.position}
              onClick={(e) => {
                e.stopPropagation();
                onPick(sensor.id);
              }}
            >
              <sphereGeometry args={[0.14, 12, 10]} />
              <meshStandardMaterial
                color={
                  incidents.some((i) => i.kind === sensor.protection)
                    ? '#e45b4b'
                    : sensor.protection === 'leak' || sensor.protection === 'waterUsage'
                      ? '#5d9fae'
                      : '#c2cc70'
                }
                emissive={
                  incidents.some((i) => i.kind === sensor.protection) ? '#b74637' : '#406d52'
                }
                emissiveIntensity={0.25}
              />
            </mesh>
          ))}
      {operational &&
        segments.map((points, i) => (
          <Line
            key={i}
            points={points}
            color="#398b60"
            lineWidth={5}
            depthTest={false}
            renderOrder={10}
          />
        ))}
      {operational &&
        Object.entries(evacuationPlans).map(([id, route]) => (
          <group key={id} position={route.exitPosition}>
            <mesh
              onClick={() =>
                onPick(
                  `${route.name} · ${available[id as keyof typeof evacuationPlans] ? 'scenario-clear' : 'blocked in demo'}`,
                )
              }
            >
              <boxGeometry args={[0.45, 0.7, 0.45]} />
              <meshStandardMaterial
                color={available[id as keyof typeof evacuationPlans] ? '#68a682' : '#ce5b4b'}
              />
            </mesh>
            {!available[id as keyof typeof evacuationPlans] && (
              <Line
                points={[
                  [-0.3, 0.5, 0],
                  [0.3, -0.3, 0],
                ]}
                color="#b3493c"
                lineWidth={5}
                depthTest={false}
              />
            )}
          </group>
        ))}
      {operational && hazard && (floor === null || floor === 4) && (
        <mesh position={[2.5, floorY(4) + 0.21, 0.55]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[4, 1.2]} />
          <meshBasicMaterial
            color={fire ? '#e45f49' : '#6bb7c4'}
            transparent
            opacity={0.75}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
}
export default function TwinCanvas({
  state,
  floor,
  command,
  operational,
  onPick,
  onUnavailable,
}: {
  state: ProtectionState;
  floor: number | null;
  command: { sequence: number; action: string };
  operational: boolean;
  onPick: (id: string) => void;
  onUnavailable: () => void;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2');
    if (!context) {
      onUnavailable();
      return;
    }
    context.getExtension('WEBGL_lose_context')?.loseContext();
    setReady(true);
  }, [onUnavailable]);
  return (
    <div
      className="hv-canvas"
      role="img"
      aria-label={`${state.facility.name} representative 3D digital twin`}
    >
      {ready ? (
        <Canvas
          frameloop="demand"
          dpr={1}
          camera={{ position: [16, 15, 18], fov: 38 }}
          gl={{ antialias: true, powerPreference: 'low-power' }}
        >
          <color attach="background" args={['#edf2e9']} />
          <ambientLight intensity={1.8} />
          <directionalLight position={[10, 20, 12]} intensity={2.2} />
          <Model state={state} floor={floor} operational={operational} onPick={onPick} />
          <Camera floor={floor} command={command} />
        </Canvas>
      ) : (
        <div className="hv-model-loading">Preparing the 3D renderer…</div>
      )}
    </div>
  );
}

'use client';
import { Suspense, useEffect, useRef, useState, type ComponentRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import { Vector3 } from 'three';
import {
  BLACKWELL_CENTER,
  BLACKWELL_HOME,
  BlackwellModel,
  MARKER_SCALE,
  blackwellElevation,
  scaleFootprint,
  toBlackwell,
} from './haven/blackwell-model';
import { evacuationPlans, levelY, monitoringPoints, type Point3 } from '@/lib/haven/config';
import {
  activeIncidents,
  effectivePlan,
  routeAvailability,
  type ProtectionState,
} from '@/lib/haven/engine';

/** Isolated floors orbit the south bar, where the Level 4 monitoring and routes sit. */
const FLOOR_TARGET: [number, number] = [20, -10];

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
    const target = floor
      ? new Vector3(FLOOR_TARGET[0], blackwellElevation(floor) + 1, FLOOR_TARGET[1])
      : new Vector3(...BLACKWELL_CENTER);
    if (previousFloor.current === floor && (command.action === 'in' || command.action === 'out'))
      camera.position
        .sub(target)
        .multiplyScalar(command.action === 'in' ? 0.8 : 1.2)
        .add(target);
    else {
      const offset = new Vector3(...BLACKWELL_HOME)
        .sub(new Vector3(...BLACKWELL_CENTER))
        .setLength(floor ? 70 : 118);
      camera.position.copy(target).add(offset);
    }
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
      minDistance={20}
      maxDistance={220}
      maxPolarAngle={Math.PI / 2.1}
      enableDamping={false}
    />
  );
}
function Overlays({
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
  if (!operational) return null;
  const incidents = activeIncidents(state);
  const hazard = incidents.some((i) => i.kind === 'leak' || i.kind === 'fire');
  const fire = incidents.some((i) => i.kind === 'fire');
  const plan = effectivePlan(state);
  const available = routeAvailability(state);
  const path = plan ? evacuationPlans[plan].points : [];
  const segments: Point3[][] = [];
  for (let i = 1; i < path.length; i++)
    if (
      floor === null ||
      (Math.abs(path[i][1] - (levelY(floor) + 0.3)) < 0.15 &&
        Math.abs(path[i - 1][1] - path[i][1]) < 0.15)
    )
      segments.push([toBlackwell(path[i - 1]), toBlackwell(path[i])]);
  const l4 = floor === null || floor === 4;
  return (
    <group>
      {monitoringPoints
        .filter((s) => state.config[s.protection].enabled && (floor === null || floor === s.floor))
        .map((sensor) => (
          <mesh
            key={sensor.id}
            position={toBlackwell(sensor.position)}
            renderOrder={6}
            onClick={(e) => {
              e.stopPropagation();
              onPick(sensor.id);
            }}
          >
            <sphereGeometry args={[0.14 * MARKER_SCALE, 14, 12]} />
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
      {segments.map((points, i) => (
        <Line
          key={i}
          points={points}
          color="#398b60"
          lineWidth={5}
          depthTest={false}
          renderOrder={10}
        />
      ))}
      {Object.entries(evacuationPlans).map(([id, route]) => (
        <group key={id} position={toBlackwell(route.exitPosition)}>
          <mesh
            onClick={() =>
              onPick(
                `${route.name} · ${available[id as keyof typeof evacuationPlans] ? 'scenario-clear' : 'blocked in demo'}`,
              )
            }
          >
            <boxGeometry args={[0.45 * MARKER_SCALE, 0.7 * MARKER_SCALE, 0.45 * MARKER_SCALE]} />
            <meshStandardMaterial
              color={available[id as keyof typeof evacuationPlans] ? '#68a682' : '#ce5b4b'}
            />
          </mesh>
          {!available[id as keyof typeof evacuationPlans] && (
            <Line
              points={[
                [-0.9, 1.5, 0],
                [0.9, -0.9, 0],
              ]}
              color="#b3493c"
              lineWidth={5}
              depthTest={false}
            />
          )}
        </group>
      ))}
      {hazard && l4 && (
        <>
          {/* Affected east wing of Level 4, then the hazard itself in the corridor. */}
          <mesh
            position={toBlackwell([3.5, levelY(4) + 0.16, 0])}
            rotation={[-Math.PI / 2, 0, 0]}
            renderOrder={4}
          >
            <planeGeometry args={scaleFootprint([5, 6.4])} />
            <meshBasicMaterial
              color={fire ? '#e48272' : '#dca472'}
              transparent
              opacity={0.3}
              depthWrite={false}
            />
          </mesh>
          <mesh
            position={toBlackwell([2.5, levelY(4) + 0.21, 0.55])}
            rotation={[-Math.PI / 2, 0, 0]}
            renderOrder={5}
          >
            <planeGeometry args={scaleFootprint([4, 1.2])} />
            <meshBasicMaterial
              color={fire ? '#e45f49' : '#6bb7c4'}
              transparent
              opacity={0.75}
              depthWrite={false}
            />
          </mesh>
        </>
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
      aria-label={`${state.facility.name} 3D digital twin · Blackwell Hall model`}
    >
      {ready ? (
        <Canvas
          frameloop="demand"
          dpr={[1, 1.5]}
          camera={{ position: BLACKWELL_HOME, fov: 34, near: 0.5, far: 800 }}
          gl={{ antialias: true, powerPreference: 'low-power' }}
        >
          <color attach="background" args={['#edf2e9']} />
          <ambientLight intensity={1.4} />
          <directionalLight position={[-40, 90, 30]} intensity={2.2} />
          <hemisphereLight args={['#fffdf5', '#a9bdb1', 1]} />
          <mesh position={[23, -0.25, -42]}>
            <boxGeometry args={[90, 0.12, 120]} />
            <meshStandardMaterial color="#e2e9dc" />
          </mesh>
          <Suspense fallback={null}>
            <BlackwellModel floor={floor} />
          </Suspense>
          <Overlays state={state} floor={floor} operational={operational} onPick={onPick} />
          <Camera floor={floor} command={command} />
        </Canvas>
      ) : (
        <div className="hv-model-loading">Preparing the 3D renderer…</div>
      )}
    </div>
  );
}

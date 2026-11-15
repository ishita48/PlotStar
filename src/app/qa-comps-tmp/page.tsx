'use client';
// TEMPORARY QA page for the CoStar comps 3D component. Deleted after the screenshot.
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import CostarComps3D, { useNeighbours } from '@/components/sponsors/costar/comps-3d';

function Probe() { const { data, error } = useNeighbours('costar:236314', 29.7122913, -95.490459, 1500); return <div id="probe" style={{ position: 'absolute', top: 0, right: 0, zIndex: 50, background: '#fff' }}>{data ? `count ${data.count}` : error ? `error ${error}` : 'loading'}</div>; }

export default function Page() {
  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      <Canvas camera={{ position: [900, 1100, 1500], fov: 36, near: 1, far: 14000 }}>
        <color attach="background" args={['#e7ebe4']} />
        <hemisphereLight args={['#ffffff', '#a4b09d', 0.9]} />
        <directionalLight position={[800, 1200, 500]} intensity={2} />
        <mesh rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[6000, 6000]} /><meshStandardMaterial color="#dce2d6" /></mesh>
        <mesh position={[0, 6, 0]}><boxGeometry args={[150, 12, 110]} /><meshStandardMaterial color="#f1f3ee" /></mesh>
        <CostarComps3D parcelId="costar:236314" lat={29.7122913} lon={-95.490459} radiusM={1500} />
        <OrbitControls makeDefault />
      </Canvas>
      <Probe />
    </div>
  );
}

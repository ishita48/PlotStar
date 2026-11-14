'use client';
// Real 3D plot of a site: Vexcel photorealistic city mesh (where Vexcel has 3D coverage) or the Vexcel
// aerial photo as the ground (everywhere else), with a generated data-center campus sized from the MW target.
import { Component, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { TilesPlugin, TilesRenderer } from '3d-tiles-renderer/r3f';
import { GLTFExtensionsPlugin, ReorientationPlugin } from '3d-tiles-renderer/plugins';
import { vexcel3dRootUrl, vexcelOrthoUrl } from '@/lib/plotstar-api';

const DEG = Math.PI / 180;
const GROUND_HALF = 200; // metres; matches the ortho buffer

/** Conceptual campus layout. Every dimension is a planning assumption, not a design. */
export function campusLayout(mw: number, floors = 2) {
  const gfa = mw * 230; // m² gross floor area per MW IT (same constant as the design engine)
  const footprint = gfa / floors;
  const width = Math.sqrt(footprint * 1.6);
  const depth = footprint / width;
  const height = floors * 6;
  const generators = Math.ceil(mw / 2.5); // 2.5 MW gensets, N (team assumption)
  const rooftopUnits = Math.max(4, Math.round(mw * 0.8));
  return { gfa, footprint, width, depth, height, generators, rooftopUnits };
}

function Campus({ mw, y = 0 }: { mw: number; y?: number }) {
  const L = useMemo(() => campusLayout(mw), [mw]);
  const cols = Math.ceil(Math.sqrt(L.rooftopUnits * (L.width / L.depth)));
  const rows = Math.ceil(L.rooftopUnits / cols);
  const genCols = Math.min(L.generators, 12);
  return (
    <group position={[0, y, 0]}>
      {/* data hall */}
      <mesh position={[0, L.height / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[L.width, L.height, L.depth]} />
        <meshStandardMaterial color="#eef1ea" roughness={0.7} />
      </mesh>
      {/* lime brand stripe */}
      <mesh position={[0, L.height - 0.6, L.depth / 2 + 0.05]}>
        <boxGeometry args={[L.width, 1.2, 0.1]} />
        <meshStandardMaterial color="#adc479" />
      </mesh>
      {/* rooftop cooling units */}
      {Array.from({ length: L.rooftopUnits }).map((_, i) => {
        const cx = (i % cols) - (cols - 1) / 2,
          cz = Math.floor(i / cols) - (rows - 1) / 2;
        return (
          <mesh
            key={i}
            position={[(cx * L.width * 0.85) / cols, L.height + 1.2, (cz * L.depth * 0.8) / rows]}
            castShadow
          >
            <boxGeometry args={[Math.min(8, (L.width * 0.6) / cols), 2.4, Math.min(5, (L.depth * 0.5) / rows)]} />
            <meshStandardMaterial color="#a9b8a4" roughness={0.6} />
          </mesh>
        );
      })}
      {/* generator yard */}
      {Array.from({ length: L.generators }).map((_, i) => (
        <mesh
          key={`g${i}`}
          position={[
            -L.width / 2 + 8 + (i % genCols) * 9,
            1.6,
            L.depth / 2 + 14 + Math.floor(i / genCols) * 6,
          ]}
          castShadow
        >
          <boxGeometry args={[7, 3.2, 3]} />
          <meshStandardMaterial color="#3b4a40" roughness={0.8} />
        </mesh>
      ))}
      {/* substation pad */}
      <mesh position={[L.width / 2 + 40, 0.3, -L.depth / 4]} receiveShadow>
        <boxGeometry args={[50, 0.6, 36]} />
        <meshStandardMaterial color="#c9cfc4" />
      </mesh>
      {[0, 1, 2].map((i) => (
        <mesh key={`t${i}`} position={[L.width / 2 + 25 + i * 15, 3, -L.depth / 4]} castShadow>
          <boxGeometry args={[6, 6, 6]} />
          <meshStandardMaterial color="#6f7c72" />
        </mesh>
      ))}
    </group>
  );
}

function AerialGround({ parcelId }: { parcelId: string }) {
  const tex = useLoader(THREE.TextureLoader, vexcelOrthoUrl(parcelId, GROUND_HALF));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[GROUND_HALF * 2, GROUND_HALF * 2]} />
      <meshStandardMaterial map={tex} roughness={1} />
    </mesh>
  );
}

/** Finds the mesh surface under the site so the campus sits on the ground. */
function GroundProbe({ target, onGround }: { target: React.RefObject<THREE.Group | null>; onGround: (y: number) => void }) {
  const ray = useMemo(() => new THREE.Raycaster(new THREE.Vector3(0, 2000, 0), new THREE.Vector3(0, -1, 0)), []);
  const done = useRef(false);
  const frames = useRef(0);
  useFrame(() => {
    if (done.current || !target.current || frames.current++ % 20) return;
    const hits = ray.intersectObject(target.current, true);
    if (hits.length) {
      // lowest hit under a small footprint approximates the ground, not a rooftop
      onGround(hits[hits.length - 1].point.y);
      if (frames.current > 400) done.current = true;
    }
  });
  return null;
}

function VexcelMesh({ url, lat, lon, mw }: { url: string; lat: number; lon: number; mw: number }) {
  const gl = useThree((s) => s.gl);
  const ext = useMemo(
    () => ({
      dracoLoader: new DRACOLoader().setDecoderPath('/decoders/draco/'),
      ktxLoader: new KTX2Loader().setTranscoderPath('/decoders/basis/').detectSupport(gl),
    }),
    [gl],
  );
  const orient = useMemo(() => ({ lat: lat * DEG, lon: lon * DEG, height: 0, up: '+y', recenter: true }), [lat, lon]);
  const group = useRef<THREE.Group>(null);
  const tilesRef = useRef<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const [ground, setGround] = useState(0);
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    let t: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    let n = 0;
    const onModel = () => {
      n++;
      if (n <= 3 || n % 10 === 0) {
        const b = new THREE.Box3().setFromObject(t.group);
        console.info('[plotstar-3d] models', n, 'bounds', b.min.toArray().map(Math.round), b.max.toArray().map(Math.round));
      }
    };
    const onErr = (e: { error?: Error; url?: string }) => console.info('[plotstar-3d] load-error', e.url, e.error?.message);
    const timer = setInterval(() => {
      if (t || !tilesRef.current) return;
      t = tilesRef.current;
      console.info('[plotstar-3d] attached', !!t.addEventListener);
      t.addEventListener('load-model', onModel);
      t.addEventListener('load-error', onErr);
      t.addEventListener('load-tileset', (e: { url: string }) => console.info('[plotstar-3d] tileset', e.url.slice(-80)));
      setTimeout(() => {
        console.info('[plotstar-3d] after 20s: visible', t.visibleTiles?.size, 'active', t.activeTiles?.size, JSON.stringify(t.stats));
      }, 20000);
    }, 200);
    return () => {
      clearInterval(timer);
      t?.removeEventListener('load-model', onModel);
      t?.removeEventListener('load-error', onErr);
    };
  }, [url]);
  return (
    <>
      <group ref={group}>
        <TilesRenderer ref={tilesRef} url={url} errorTarget={40} loadSiblings={false} maxDepth={12}>
          <TilesPlugin plugin={GLTFExtensionsPlugin} args={[ext]} />
          <TilesPlugin plugin={ReorientationPlugin} args={[orient]} />
        </TilesRenderer>
      </group>
      <GroundProbe target={group} onGround={setGround} />
      <Campus mw={mw} y={ground + 0.2} />
    </>
  );
}

class Boundary extends Component<{ children: React.ReactNode; fallback: React.ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? this.props.fallback : this.props.children;
  }
}

export default function Site3D({
  parcelId,
  lat,
  lng,
  mw,
}: {
  parcelId: string;
  lat: number;
  lng: number;
  mw: number;
}) {
  const [mesh, setMesh] = useState<{ url: string; collection: string } | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    fetch(vexcel3dRootUrl(lat, lng))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && setMesh(d ? { url: d.tileset_url, collection: d.collection } : null))
      .catch(() => alive && setMesh(null));
    return () => {
      alive = false;
    };
  }, [lat, lng]);
  const L = campusLayout(mw);
  const span = Math.max(L.width, L.depth) + 120;

  return (
    <div className="real-3d-wrap">
      {mesh === undefined ? (
        <div className="real-3d-status">Loading the real site…</div>
      ) : (
        <Boundary fallback={<div className="real-3d-status">3D view unavailable on this device.</div>}>
          <Canvas shadows camera={{ position: [span * 0.9, span * 0.75, span * 0.9], fov: 45, near: 1, far: 20000 }}>
            <color attach="background" args={['#dfe5da']} />
            <hemisphereLight args={['#ffffff', '#b9c4b0', 0.9]} />
            <directionalLight position={[300, 500, 200]} intensity={1.6} castShadow />
            <Suspense fallback={null}>
              {mesh ? (
                <VexcelMesh url={mesh.url} lat={lat} lon={lng} mw={mw} />
              ) : (
                <>
                  <AerialGround parcelId={parcelId} />
                  <Campus mw={mw} />
                </>
              )}
            </Suspense>
            <OrbitControls makeDefault maxPolarAngle={Math.PI / 2.1} minDistance={40} maxDistance={2500} />
          </Canvas>
        </Boundary>
      )}
      <div className="real-3d-note">
        {mesh
          ? `Real 3D city: Vexcel ${mesh.collection}. `
          : mesh === null
            ? 'Real aerial ground: Vexcel orthophoto. '
            : ''}
        Proposed campus is conceptual: {Math.round(L.footprint).toLocaleString()} m² hall, {L.generators} generators,
        substation pad.
      </div>
    </div>
  );
}

'use client';
// 2D plan of one concept, drawn to scale in metres. North is up. Click a room to inspect it.
import { useEffect, useRef, useState } from 'react';
import type { Concept, Room } from './types';
import { ROUTE_COLOR, TYPE_STYLE } from './types';

export interface Layers { racks: boolean; labels: boolean; power: boolean; cooling: boolean; data: boolean; yard: boolean; site: boolean }

export function Plan2D({
  concept, siteW, siteD, setback, layers, selected, onSelect, mini = false,
}: {
  concept: Concept; siteW: number; siteD: number; setback: number; layers?: Layers; selected?: string | null;
  onSelect?: (code: string | null) => void; mini?: boolean;
}) {
  const L = layers ?? { racks: !mini, labels: !mini, power: false, cooling: false, data: false, yard: true, site: false };
  const ref = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState({ w: mini ? 380 : 700, h: mini ? 180 : 600 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: Math.max(50, el.clientWidth), h: Math.max(50, el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const b = concept.building;
  const fy = (y: number, d = 0) => siteD - y - d; // flip so north is up
  // frame the building and its yard unless the whole site is asked for
  const all = [b, ...concept.yard];
  const x0 = Math.min(...all.map((r) => r.x)), x1 = Math.max(...all.map((r) => r.x + r.w));
  const y0 = Math.min(...all.map((r) => r.y)), y1 = Math.max(...all.map((r) => r.y + r.d));
  const pad = L.site ? 12 : Math.max(8, (x1 - x0) * 0.07);
  const vb = L.site ? { x: -pad, y: -pad, w: siteW + 2 * pad, h: siteD + 2 * pad } : { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  const px = Math.max(vb.w / box.w, vb.h / box.h); // metres per screen pixel
  const sw = px * 1.1;

  const room = (r: Room, yard = false) => {
    const st = TYPE_STYLE[r.type];
    const sel = selected === r.code;
    const wpx = r.w / px, dpx = r.d / px;
    const label = yard ? r.name : wpx > 120 ? `${r.code} · ${r.name}` : r.code;
    const fits = dpx > 18 && wpx > label.length * 6.2 + 10;
    return (
      <g key={r.code} data-code={r.code} onClick={(e) => { e.stopPropagation(); onSelect?.(r.code); }} style={{ cursor: onSelect ? 'pointer' : 'default' }}>
        <rect x={r.x} y={fy(r.y, r.d)} width={r.w} height={r.d} fill={sel ? '#cfe3d3' : st.fill} stroke={sel ? '#173626' : st.stroke}
          strokeWidth={sel ? sw * 2.2 : sw} strokeDasharray={r.type === 'reserve' ? `${px * 5} ${px * 4}` : undefined} />
        {L.racks && r.rows?.map((w, i) => (
          <g key={i}>
            <rect x={w.x} y={fy(w.y, w.d)} width={w.w} height={w.d} fill="none" stroke="#b7c2b6" strokeWidth={sw * 0.5} />
            {w.n > 0 && <rect x={w.x} y={fy(w.y, w.d)} width={(w.w * w.n) / w.cap} height={w.d} fill="#2b3a33" />}
          </g>
        ))}
        {L.labels && fits && (
          <text x={r.x + px * 5} y={fy(r.y, r.d) + px * 13} fontSize={px * 10.5} fill="#1f2a24" paintOrder="stroke" stroke={sel ? '#cfe3d3' : st.fill}
            strokeWidth={px * 3} style={{ pointerEvents: 'none' }}>
            <tspan fontWeight={600}>{label}</tspan>
            {dpx > 34 && wpx > 70 && <tspan x={r.x + px * 5} dy={px * 12.5} fill="#55625a">{Math.round(r.w * r.d).toLocaleString()} m²{r.racks ? ` · ${r.racks} racks` : ''}</tspan>}
          </text>
        )}
      </g>
    );
  };

  return (
    <svg ref={ref} className="st-plan" viewBox={`${vb.x} ${fy(vb.y, vb.h)} ${vb.w} ${vb.h}`} preserveAspectRatio="xMidYMid meet"
      onClick={() => onSelect?.(null)} role="img" aria-label={`Plan of ${concept.name}`}>
      <rect x={0} y={0} width={siteW} height={siteD} fill="#fbfcf9" stroke="#3b6b50" strokeWidth={sw * 1.6} />
      <rect x={setback} y={setback} width={siteW - 2 * setback} height={siteD - 2 * setback} fill="none" stroke="#8fa493"
        strokeWidth={sw} strokeDasharray={`${px * 6} ${px * 5}`} />
      <rect x={b.x} y={fy(b.y, b.d)} width={b.w} height={b.d} fill="#fff" stroke="#1f2a24" strokeWidth={sw * 2} />
      {concept.rooms.map((r) => room(r))}
      {L.yard && concept.yard.map((r) => room(r, true))}
      {L.yard && concept.equipment.map((e) => (
        <rect key={e.code} x={e.x} y={fy(e.y, e.d)} width={e.w} height={e.d} fill="#8a6a2a" style={{ pointerEvents: 'none' }} />
      ))}
      {(['power', 'cooling', 'data'] as const).map((k) => L[k] && concept.routes[k].map((line, i) => (
        <polyline key={`${k}${i}`} points={line.map(([x, y]) => `${x},${fy(y)}`).join(' ')} fill="none" stroke={ROUTE_COLOR[k]}
          strokeWidth={sw * 2} strokeLinejoin="round" opacity={0.9} style={{ pointerEvents: 'none' }} />
      )))}
      {!mini && (
        <g style={{ pointerEvents: 'none' }} fontSize={px * 10.5} fill="#44504a">
          <text x={b.x + b.w / 2} y={fy(b.y) + px * 14} textAnchor="middle">{b.w.toFixed(0)} m</text>
          <text x={b.x - px * 6} y={fy(b.y, b.d / 2)} textAnchor="end">{b.d.toFixed(0)} m</text>
          <text x={vb.x + vb.w - px * 8} y={fy(vb.y, vb.h) + px * 16} textAnchor="end">N ↑</text>
          {L.site && <text x={px * 4} y={-px * 5} fill="#3b6b50">Site {Math.round(siteW)} × {Math.round(siteD)} m · setback {setback} m</text>}
        </g>
      )}
    </svg>
  );
}

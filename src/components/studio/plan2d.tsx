'use client';
// 2D plan of one storey of a concept, drawn to scale in metres. North is up. Click a room to inspect it.
// With the design editor attached (`editor`), outdoor items and the building can be dragged, objects a failing check
// is about are drawn red, AI proposals are drawn as dashed ghosts, and a new object can be dropped from the asset panel.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { vexcelOrthoUrl } from '@/lib/plotstar-api';
import type { Concept, Room } from './types';
import { ROUTE_COLOR, TYPE_STYLE } from './types';
import { DOOR_M, doorsOf, exitsOf, niceLength } from './design-editor/geometry';

export interface Layers {
  racks: boolean; labels: boolean; power: boolean; cooling: boolean; data: boolean; yard: boolean; site: boolean;
  /** 3D: floating name tags; both views: the Vexcel aerial under the drawing; 3D: roof opacity 0 (off) to 1. */
  tags: boolean; aerial: boolean; roof: number;
  /** Storey shown (null = all in 3D, ground floor in the plan); 3D: how far the storeys are pulled apart, 0 to 1. */
  level: number | null; explode: number;
  /** 3D: Vexcel 3D mesh of the surroundings, where Vexcel has coverage. */
  context: boolean;
  /** Explore's Layers popover (all optional; undefined means the default noted) */
  columns?: boolean; // column grid, default on
  slabs?: boolean; // floor slabs, default on
  walls?: boolean; // interior walls with door gaps, default on
  isolate?: boolean; // structure only
  units?: boolean; // in-hall cooling units, default on
  equipment?: boolean; // electrical / battery / mechanical equipment in rooms, default on
  labelMode?: 'major' | 'all';
  equipIds?: boolean;
  dims?: boolean; // measure lines
  compass?: boolean;
}

/** Design editor hooks into the plan; all optional. */
export interface Editor2D {
  bad?: Record<string, string[]>;
  ghosts?: Room[];
  placing?: { w: number; d: number; label: string } | null;
  onPlace?: (x: number, y: number) => void;
  /** a drag finished: move the building ('BUILDING') or an outdoor item by (dx, dy) metres, y north */
  onMove?: (code: string, dx: number, dy: number) => void;
  toolbar?: ReactNode;
}

export function Plan2D({
  concept, siteW, siteD, setback, layers, selected, onSelect, mini = false, aerialId = null, editor,
}: {
  concept: Concept; siteW: number; siteD: number; setback: number; layers?: Layers; selected?: string | null;
  onSelect?: (code: string | null) => void; mini?: boolean; aerialId?: string | null; editor?: Editor2D;
}) {
  const L = layers ?? { racks: !mini, labels: !mini, power: false, cooling: false, data: false, yard: true, site: false, tags: false, aerial: false, roof: 0, level: null, explode: 0, context: false };
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
  const level = Math.min(L.level ?? 0, b.storeys - 1);
  const rooms = concept.rooms.filter((r) => (r.level ?? 0) === level);
  const fy = (y: number, d = 0) => siteD - y - d; // flip so north is up
  const all = [b, ...concept.yard];
  const x0 = Math.min(...all.map((r) => r.x)), x1 = Math.max(...all.map((r) => r.x + r.w));
  const y0 = Math.min(...all.map((r) => r.y)), y1 = Math.max(...all.map((r) => r.y + r.d));
  const pad = L.site ? (L.dims ? 22 : 12) : Math.max(8, (x1 - x0) * (L.dims ? 0.13 : 0.07));
  const vb = L.site ? { x: -pad, y: -pad, w: siteW + 2 * pad, h: siteD + 2 * pad } : { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  const px = Math.max(vb.w / box.w, vb.h / box.h); // metres per screen pixel
  const sw = px * 1.1;
  const aerial = !mini && L.aerial && aerialId;
  const half = Math.min(600, Math.round(Math.max(siteW, siteD) / 2 + 90));

  // editing: drag in plan metres (svg y points south, so north = -svg dy)
  const [drag, setDrag] = useState<{ code: string; sx: number; sy: number; dx: number; dy: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const toSvg = (e: { clientX: number; clientY: number }) => {
    const el = ref.current, m = el?.getScreenCTM();
    if (!el || !m) return null;
    const pt = el.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const q = pt.matrixTransform(m.inverse());
    return { x: q.x, y: q.y };
  };
  const startDrag = (code: string) => (e: React.PointerEvent) => {
    if (!editor?.onMove || e.button !== 0) return;
    const q = toSvg(e);
    if (!q) return;
    e.stopPropagation();
    ref.current?.setPointerCapture(e.pointerId);
    setDrag({ code, sx: q.x, sy: q.y, dx: 0, dy: 0 });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!editor) return;
    const q = toSvg(e);
    if (!q) return;
    if (editor.placing) setHover({ x: q.x, y: siteD - q.y });
    if (drag) setDrag({ ...drag, dx: Math.round(q.x - drag.sx), dy: Math.round(drag.sy - q.y) });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!editor) return;
    if (drag) {
      if (drag.dx || drag.dy) editor.onMove?.(drag.code, drag.dx, drag.dy);
      setDrag(null);
      return;
    }
    if (editor.placing && editor.onPlace) {
      const q = toSvg(e);
      if (q) editor.onPlace(Math.round(q.x - editor.placing.w / 2), Math.round(siteD - q.y - editor.placing.d / 2));
    }
  };
  useEffect(() => { setDrag(null); }, [concept]);
  useEffect(() => { if (!editor?.placing) setHover(null); }, [editor?.placing]);
  const shift = (code: string) => (drag?.code === code ? `translate(${drag.dx} ${-drag.dy})` : undefined);
  const bad = editor?.bad ?? {};

  // floating toolbar next to the selected outdoor item
  const [tb, setTb] = useState<{ left: number; top: number } | null>(null);
  const selYard = editor?.toolbar && selected ? concept.yard.find((y) => y.code === selected) : undefined;
  useLayoutEffect(() => {
    const el = ref.current, host = el?.parentElement, m = el?.getScreenCTM();
    if (!selYard || !el || !host || !m) { setTb(null); return; }
    const pt = el.createSVGPoint();
    pt.x = selYard.x + selYard.w; pt.y = siteD - selYard.y - selYard.d;
    const q = pt.matrixTransform(m), hb = host.getBoundingClientRect();
    setTb({ left: Math.min(hb.width - 180, Math.max(4, q.x - hb.left + 8)), top: Math.max(4, q.y - hb.top - 8) });
  }, [selYard, siteD, box, concept]);

  const room = (r: Room, yard = false) => {
    const st = TYPE_STYLE[r.type];
    const sel = selected === r.code;
    const isBad = !!bad[r.code];
    const wpx = r.w / px, dpx = r.d / px;
    const label = yard ? r.name : wpx > 120 ? `${r.code} · ${r.name}` : r.code;
    const fits = dpx > 18 && wpx > label.length * 6.2 + 10;
    return (
      <g key={r.code} data-code={r.code} onClick={(e) => { e.stopPropagation(); onSelect?.(r.code); }} transform={yard ? shift(r.code) : undefined}
        onPointerDown={yard ? startDrag(r.code) : editor?.onMove ? startDrag('BUILDING') : undefined}
        style={{ cursor: editor?.onMove ? (drag ? 'grabbing' : 'grab') : onSelect ? 'pointer' : 'default' }}>
        <rect x={r.x} y={fy(r.y, r.d)} width={r.w} height={r.d} fill={isBad ? '#f6d5d0' : sel ? '#cfe3d3' : st.fill} stroke={isBad ? '#b3362b' : sel ? '#173626' : st.stroke}
          strokeWidth={sel || isBad ? sw * 2.2 : sw} strokeDasharray={r.type === 'reserve' ? `${px * 5} ${px * 4}` : undefined} fillOpacity={yard && aerial ? 0.85 : 1} />
        {L.racks && r.rows?.map((w, i) => {
          const fw = w.v ? w.w : (w.w * w.n) / w.cap, fd = w.v ? (w.d * w.n) / w.cap : w.d;
          return (
            <g key={i}>
              <rect x={w.x} y={fy(w.y, w.d)} width={w.w} height={w.d} fill="none" stroke="#b7c2b6" strokeWidth={sw * 0.5} />
              {w.n > 0 && <rect x={w.x} y={fy(w.y, fd)} width={fw} height={fd} fill="#2b3a33" />}
            </g>
          );
        })}
        {L.labels && fits && (
          <text x={r.x + px * 5} y={fy(r.y, r.d) + px * 13} fontSize={px * 10.5} fill="#1f2a24" paintOrder="stroke" stroke={sel ? '#cfe3d3' : st.fill}
            strokeWidth={px * 3} style={{ pointerEvents: 'none' }}>
            <tspan fontWeight={600}>{label}</tspan>
            {dpx > 34 && wpx > (r.racks && wpx > 118 ? 118 : 62) && <tspan x={r.x + px * 5} dy={px * 12.5} fill="#55625a">{Math.round(r.w * r.d).toLocaleString()} m²{r.racks && wpx > 118 ? ` · ${r.racks} racks` : ''}</tspan>}
          </text>
        )}
      </g>
    );
  };

  return (
    <>
    <svg ref={ref} className="st-plan" viewBox={`${vb.x} ${fy(vb.y, vb.h)} ${vb.w} ${vb.h}`} preserveAspectRatio="xMidYMid meet"
      onClick={() => { if (!editor?.placing) onSelect?.(null); }} role="img" aria-label={`Plan of ${concept.name}`}
      onPointerMove={editor ? onPointerMove : undefined} onPointerUp={editor ? onPointerUp : undefined}
      style={editor?.placing ? { cursor: 'copy' } : undefined}>
      {aerial && <image href={vexcelOrthoUrl(aerialId, half)} x={siteW / 2 - half} y={siteD / 2 - half} width={half * 2} height={half * 2} preserveAspectRatio="none" />}
      <rect x={0} y={0} width={siteW} height={siteD} fill={aerial ? '#ffffff' : '#fbfcf9'} fillOpacity={aerial ? 0.18 : 1} stroke="#3b6b50" strokeWidth={sw * 1.6} />
      <rect x={setback} y={setback} width={siteW - 2 * setback} height={siteD - 2 * setback} fill="none" stroke={aerial ? '#eaf3ea' : '#8fa493'}
        strokeWidth={sw} strokeDasharray={`${px * 6} ${px * 5}`} />
      <g transform={shift('BUILDING')}>
      <rect x={b.x} y={fy(b.y, b.d)} width={b.w} height={b.d} fill="#fff" stroke={bad.BUILDING ? '#b3362b' : '#1f2a24'} strokeWidth={sw * (bad.BUILDING ? 3 : 2)}
        onPointerDown={editor?.onMove ? startDrag('BUILDING') : undefined} />
      {rooms.map((r) => room(r))}
      </g>
      {L.yard && concept.yard.map((r) => room(r, true))}
      {L.yard && concept.equipment.map((e) => (
        <rect key={e.code} x={e.x} y={fy(e.y, e.d)} width={e.w} height={e.d} fill="#8a6a2a" style={{ pointerEvents: 'none' }} transform={shift('GEN')} />
      ))}
      {editor?.ghosts?.map((g) => (
        <g key={g.code} style={{ pointerEvents: 'none' }}>
          <rect x={g.x} y={fy(g.y, g.d)} width={g.w} height={g.d} fill="#c9ec7a" fillOpacity={0.45} stroke="#6fa24e" strokeWidth={sw * 2} strokeDasharray={`${px * 5} ${px * 3}`} />
          <text x={g.x + px * 4} y={fy(g.y, g.d) - px * 4} fontSize={px * 10.5} fill="#1f4a36" fontWeight={600} paintOrder="stroke" stroke="#ffffff" strokeWidth={px * 3}>Proposal: {g.name}</text>
        </g>
      ))}
      {Object.entries(bad).map(([code, why]) => {
        const r = code === 'BUILDING' ? b : concept.yard.find((y) => y.code === code);
        if (!r) return null;
        return (
          <text key={`bad-${code}`} x={r.x} y={fy(r.y, r.d) - px * 4} fontSize={px * 10} fill="#b3362b" fontWeight={600} paintOrder="stroke" stroke="#ffffff"
            strokeWidth={px * 3} style={{ pointerEvents: 'none' }} transform={shift(code)}>{code === 'BUILDING' ? 'Building' : code}: {why[0]}</text>
        );
      })}
      {editor?.placing && hover && (
        <rect x={hover.x - editor.placing.w / 2} y={fy(hover.y - editor.placing.d / 2, editor.placing.d)} width={editor.placing.w} height={editor.placing.d}
          fill="#6fa24e" fillOpacity={0.35} stroke="#1f4a36" strokeWidth={sw * 1.5} style={{ pointerEvents: 'none' }} />
      )}
      {(['power', 'cooling', 'data'] as const).map((k) => L[k] && concept.routes[k].map((line, i) => (
        <polyline key={`${k}${i}`} points={line.map(([x, y]) => `${x},${fy(y)}`).join(' ')} fill="none" stroke={ROUTE_COLOR[k]}
          strokeWidth={sw * 2} strokeLinejoin="round" opacity={0.9} style={{ pointerEvents: 'none' }} />
      )))}
      {!mini && (L.walls ?? true) && (
        <g style={{ pointerEvents: 'none' }} transform={shift('BUILDING')}>
          {doorsOf(concept).filter((d) => d.level === level).map((d, i) => {
            const X = d.x, Y = fy(d.y), h = DOOR_M / 2, r = DOOR_M * 0.9;
            return d.o === 'h' ? (
              <g key={i}><rect x={X - h} y={Y - px * 2.5} width={DOOR_M} height={px * 5} fill="#ffffff" />
                <path d={`M${X - h} ${Y} L${X - h} ${Y - r} A${r} ${r} 0 0 1 ${X - h + r} ${Y}`} fill="none" stroke="#6b776e" strokeWidth={sw * 0.7} /></g>
            ) : (
              <g key={i}><rect x={X - px * 2.5} y={Y - h} width={px * 5} height={DOOR_M} fill="#ffffff" />
                <path d={`M${X} ${Y - h} L${X + r} ${Y - h} A${r} ${r} 0 0 1 ${X} ${Y - h + r}`} fill="none" stroke="#6b776e" strokeWidth={sw * 0.7} /></g>
            );
          })}
          {level === 0 && exitsOf(concept).map((x, i) => {
            const ox = x.side === 'e' ? 1 : x.side === 'w' ? -1 : 0, oy = x.side === 'n' ? -1 : x.side === 's' ? 1 : 0;
            const X = x.x + ox * px * 6, Y = fy(x.y) + oy * px * 6;
            return (
              <g key={`x${i}`}>
                <rect x={x.x - (x.o === 'h' ? DOOR_M / 2 : px * 2.5)} y={fy(x.y) - (x.o === 'h' ? px * 2.5 : DOOR_M / 2)} width={x.o === 'h' ? DOOR_M : px * 5} height={x.o === 'h' ? px * 5 : DOOR_M} fill="#2e7d4f" />
                <text x={X + ox * px * 2} y={Y + oy * px * 8 + px * 3.5} fontSize={px * 9} fontWeight={700} fill="#2e7d4f" textAnchor={ox > 0 ? 'start' : ox < 0 ? 'end' : 'middle'} paintOrder="stroke" stroke="#ffffff" strokeWidth={px * 2.5}>EXIT</text>
              </g>
            );
          })}
        </g>
      )}
      {!mini && L.dims && (() => {
        const tick = (x1: number, y1: number, x2: number, y2: number, label: string, color = '#1f4a36') => {
          const hor = Math.abs(y2 - y1) < 1e-6, t = px * 5;
          return (
            <g stroke={color} strokeWidth={sw * 1.1} fill={color}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} />
              {hor ? <><line x1={x1} y1={y1 - t} x2={x1} y2={y1 + t} /><line x1={x2} y1={y2 - t} x2={x2} y2={y2 + t} /></>
                : <><line x1={x1 - t} y1={y1} x2={x1 + t} y2={y1} /><line x1={x2 - t} y1={y2} x2={x2 + t} y2={y2} /></>}
              <text x={(x1 + x2) / 2 + (hor ? 0 : -px * 4)} y={(y1 + y2) / 2 + (hor ? px * 13 : px * 3.5)} textAnchor={hor ? 'middle' : 'end'} stroke="#ffffff" strokeWidth={px * 3} paintOrder="stroke" fontSize={px * 10.5} fontWeight={600}>{label}</text>
            </g>
          );
        };
        return (
          <g style={{ pointerEvents: 'none' }}>
            <g transform={shift('BUILDING')}>
              {tick(b.x, fy(b.y) + px * 10, b.x + b.w, fy(b.y) + px * 10, `${b.w.toFixed(1)} m`)}
              {tick(b.x - px * 10, fy(b.y, b.d), b.x - px * 10, fy(b.y), `${b.d.toFixed(1)} m`)}
            </g>
            {setback > 0 && tick(siteW / 2, fy(0), siteW / 2, fy(setback), `setback ${setback} m`, '#6f8f79')}
            {L.site && tick(0, fy(0) + px * 22, siteW, fy(0) + px * 22, `site ${siteW.toFixed(0)} m`, '#3b6b50')}
          </g>
        );
      })()}
      {!mini && (() => {
        const len = niceLength(vb.w * 0.16), x0 = vb.x + px * 14, y0 = fy(vb.y) - px * 14;
        const nx = vb.x + vb.w - px * 22, ny = fy(vb.y, vb.h) + px * 16;
        return (
          <g style={{ pointerEvents: 'none' }} fill={aerial ? '#ffffff' : '#1f2a24'} stroke={aerial ? '#1f2a24' : 'none'} paintOrder="stroke" strokeWidth={px * 2.5}>
            <rect x={x0} y={y0 - px * 4} width={len / 2} height={px * 4} fill="#1f2a24" stroke="#ffffff" strokeWidth={px * 0.8} />
            <rect x={x0 + len / 2} y={y0 - px * 4} width={len / 2} height={px * 4} fill="#ffffff" stroke="#1f2a24" strokeWidth={px * 0.8} />
            <text x={x0 + len + px * 5} y={y0} fontSize={px * 10}>{len} m</text>
            <path d={`M${nx} ${ny - px * 2} l${px * 6} ${px * 16} l${-px * 6} ${-px * 5} l${-px * 6} ${px * 5} z`} fill="#1f2a24" stroke="#ffffff" strokeWidth={px * 1} />
            <text x={nx} y={ny + px * 28} fontSize={px * 10} fontWeight={700} textAnchor="middle">N</text>
          </g>
        );
      })()}
      {!mini && (
        <g style={{ pointerEvents: 'none' }} fontSize={px * 10.5} fill={aerial ? '#ffffff' : '#44504a'} paintOrder="stroke" stroke={aerial ? '#1f2a24' : 'none'} strokeWidth={px * 2.5}>
          {!L.dims && <text x={b.x + b.w / 2} y={fy(b.y) + px * 14} textAnchor="middle">{b.w.toFixed(0)} m</text>}
          {!L.dims && <text x={b.x - px * 6} y={fy(b.y, b.d / 2)} textAnchor="end">{b.d.toFixed(0)} m</text>}
          {b.storeys > 1 && <text x={vb.x + vb.w - px * 34} y={fy(vb.y, vb.h) + px * 16} textAnchor="end">Level {level + 1} of {b.storeys}</text>}
          {L.site && <text x={px * 4} y={-px * 5}>Site {Math.round(siteW)} × {Math.round(siteD)} m · setback {setback} m</text>}
        </g>
      )}
    </svg>
    {tb && selYard && !drag && <div className="st-plan-float" style={{ position: 'absolute', left: tb.left, top: tb.top, transform: 'translateY(-100%)', zIndex: 5 }}>{editor?.toolbar}</div>}
    </>
  );
}

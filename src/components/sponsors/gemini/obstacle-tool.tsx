'use client';
// Explore toolbar: "Find obstacles with Gemini". One icon button; a small popover shows Gemini's boxes on the Vexcel
// aerial and a keep/discard list. Applying stores the kept boxes for this site and regenerates the layouts, which
// then avoid them (POST /studio/generate site.obstacles, metres from the site's south-west corner, y north).
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle, RefreshCw, ScanSearch, TriangleAlert, X } from 'lucide-react';
import { vexcelOrthoUrl } from '@/lib/plotstar-api';
import { gemini, KIND_COLOR, load, obstacleKey, postJson, save, type ObstacleScan, type ObstacleState } from './api';
import s from './gemini.module.css';

export function ObstacleTool({ aerialId, siteW, siteD, onApply, busy = false }: {
  aerialId: string | null; siteW: number; siteD: number; onApply: () => void; busy?: boolean;
}) {
  const key = aerialId ? obstacleKey(aerialId) : null;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ObstacleState | null>(() => (key ? load<ObstacleState>(key) : null));
  const [loadedKey, setLoadedKey] = useState(key);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  // The toolbar is frosted (its own stacking context), so the popover is portalled to the studio root and fixed in place.
  const [at, setAt] = useState<{ left: number; top: number; host: Element } | null>(null);
  if (key !== loadedKey) { setLoadedKey(key); setState(key ? load<ObstacleState>(key) : null); }

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { const t = e.target as Node; if (!box.current?.contains(t) && !pop.current?.contains(t)) setOpen(false); };
    const away = () => setOpen(false);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', away);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); window.removeEventListener('resize', away); };
  }, [open]);

  const update = (next: ObstacleState | null) => { setState(next); if (key) save(key, next); };

  async function scan(refresh = false) {
    if (!aerialId) return;
    setScanning(true); setError(null);
    try {
      const r = await gemini<ObstacleScan>('/obstacles', postJson({ site_id: aerialId, site_w: siteW, site_d: siteD, refresh }));
      update({ scan: r, keep: r.obstacles.filter((o) => o.suggest_keep).map((o) => o.id), applied: state?.applied.filter((id) => r.obstacles.some((o) => o.id === id)) ?? [] });
    } catch (e) { setError((e as Error).message); } finally { setScanning(false); }
  }

  function toggleOpen() {
    if (open) { setOpen(false); return; }
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(380, window.innerWidth - 32);
    setAt({ left: Math.max(16, Math.min(r.left, window.innerWidth - width - 16)), top: r.bottom + 8, host: box.current?.closest('.st') ?? document.body });
    setOpen(true);
  }

  const applied = state?.applied.length ?? 0;
  const dirty = !!state && (state.keep.length !== state.applied.length || state.keep.some((id) => !state.applied.includes(id)));
  const resized = !!state && (Math.round(state.scan.site.w) !== Math.round(siteW) || Math.round(state.scan.site.d) !== Math.round(siteD));

  return (
    <div className={s.anchor} ref={box}>
      <button type="button" className={`st-btn ${applied ? 'primary' : ''} ${s.iconBtn}`} onClick={toggleOpen} disabled={!aerialId}
        aria-expanded={open} title={aerialId ? 'Find obstacles with Gemini: boxes existing buildings, trees, water and paving on the Vexcel aerial' : 'Choose a site with an aerial first'}>
        <ScanSearch size={14} />{applied > 0 && <b className={s.count}>{applied}</b>}
      </button>
      {open && at && createPortal(
        <div className={s.pop} ref={pop} role="dialog" aria-label="Mapped obstacles" style={{ left: at.left, top: at.top, maxHeight: `calc(100vh - ${at.top + 16}px)` }}>
          <header className={s.popHead}>
            <div><b>Mapped obstacles</b><small>Gemini on the Vexcel aerial</small></div>
            <button type="button" className={s.x} onClick={() => setOpen(false)} aria-label="Close"><X size={14} /></button>
          </header>
          {!state && (
            <div className={s.popBody}>
              <p className={s.muted}>Gemini reads the Vexcel aerial of the {Math.round(siteW)} × {Math.round(siteD)} m site rectangle and boxes existing buildings, trees, water, parking, paving and roads. You choose which ones the layouts must avoid.</p>
              <button type="button" className="st-btn primary" onClick={() => void scan()} disabled={scanning}>
                {scanning ? <><LoaderCircle size={13} className={s.spin} /> Reading the aerial…</> : <><ScanSearch size={13} /> Find obstacles with Gemini</>}
              </button>
              {error && <p className={s.err}>{error}</p>}
            </div>
          )}
          {state && (
            <>
              <ObstacleMap state={state} aerialId={aerialId!} hover={hover} onToggle={(id) => update({ ...state, keep: toggle(state.keep, id) })} />
              <div className={s.popBody}>
                {state.scan.scene && <p className={s.scene}>{state.scan.scene}</p>}
                <p className={s.caveat}><TriangleAlert size={12} /> Aerial position: {state.scan.mapping.image_footprint === 'exact' ? 'exact, from Vexcel pixel bounds' : 'assumed'}. Site rectangle: assumed centred on the site point, north up; the parcel boundary is not in the data, so boxes near the edge may belong to neighbours.</p>
                {resized && <p className={s.caveat}><TriangleAlert size={12} /> Scanned for a {Math.round(state.scan.site.w)} × {Math.round(state.scan.site.d)} m rectangle. Re-scan to cover the current {Math.round(siteW)} × {Math.round(siteD)} m.</p>}
                <ul className={s.list}>
                  {state.scan.obstacles.map((o) => {
                    const on = state.keep.includes(o.id);
                    return (
                      <li key={o.id} onMouseEnter={() => setHover(o.id)} onMouseLeave={() => setHover(null)} className={on ? '' : s.off}>
                        <label title={o.advice ?? undefined}>
                          <input type="checkbox" checked={on} onChange={() => update({ ...state, keep: toggle(state.keep, o.id) })} />
                          <i style={{ background: KIND_COLOR[o.kind] }} />
                          <span>{o.label}<small>{o.kind} · {Math.round(o.w)} × {Math.round(o.d)} m · {Math.round(o.confidence * 100)}%{o.advice ? ' · check' : ''}</small></span>
                        </label>
                      </li>
                    );
                  })}
                  {!state.scan.obstacles.length && <li className={s.muted}>Gemini found nothing on the site rectangle.</li>}
                </ul>
                {error && <p className={s.err}>{error}</p>}
              </div>
              <footer className={s.popFoot}>
                <span>Keep {state.keep.length} of {state.scan.obstacles.length} · {state.scan.model}</span>
                <button type="button" className="st-btn" onClick={() => void scan(true)} disabled={scanning} title="Ask Gemini again">
                  {scanning ? <LoaderCircle size={13} className={s.spin} /> : <RefreshCw size={13} />}
                </button>
                <button type="button" className="st-btn primary" disabled={busy || !dirty}
                  onClick={() => { update({ ...state, applied: [...state.keep] }); onApply(); }}>
                  {busy ? 'Generating…' : 'Apply to layouts'}
                </button>
              </footer>
            </>
          )}
        </div>,
        at.host,
      )}
    </div>
  );
}

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

/** The aerial, the site rectangle and Gemini's boxes, in metres from the site centre (north up). */
function ObstacleMap({ state, aerialId, hover, onToggle }: { state: ObstacleState; aerialId: string; hover: string | null; onToggle: (id: string) => void }) {
  const { scan } = state;
  const W = scan.site.w, D = scan.site.d;
  const img = { west: scan.image.x0 - W / 2, east: scan.image.x1 - W / 2, south: scan.image.y0 - D / 2, north: scan.image.y1 - D / 2 };
  const pad = Math.max(10, 0.06 * Math.max(W, D));
  const vb = `${-W / 2 - pad} ${-D / 2 - pad} ${W + 2 * pad} ${D + 2 * pad}`;
  const keep = useMemo(() => new Set(state.keep), [state.keep]);
  const sw = Math.max(W, D) / 260;
  return (
    <svg className={s.map} viewBox={vb} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Gemini's boxes on the Vexcel aerial">
      <image href={vexcelOrthoUrl(aerialId, scan.image.buffer_m)} x={img.west} y={-img.north} width={img.east - img.west} height={img.north - img.south} preserveAspectRatio="none" />
      <rect x={-W / 2} y={-D / 2} width={W} height={D} fill="none" stroke="#c9ec7a" strokeWidth={sw * 1.6} />
      {scan.obstacles.map((o) => {
        const on = keep.has(o.id), hot = hover === o.id;
        return (
          <rect key={o.id} x={o.local.west} y={-o.local.north} width={o.local.east - o.local.west} height={o.local.north - o.local.south}
            fill={on ? KIND_COLOR[o.kind] : 'none'} fillOpacity={hot ? 0.45 : 0.22} stroke={on ? KIND_COLOR[o.kind] : '#ffffff'}
            strokeWidth={sw * (hot ? 2.4 : 1.2)} strokeDasharray={on ? undefined : `${sw * 4} ${sw * 3}`} style={{ cursor: 'pointer' }}
            onClick={() => onToggle(o.id)}>
            <title>{`${o.label} (${o.kind}) · ${on ? 'kept' : 'discarded'}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

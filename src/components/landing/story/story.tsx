'use client';
// GeoStar landing. One story told in three acts, most important first (inverted pyramid):
// the promise, then the three things GeoStar does, then each act in depth, then HAVEN, then the details.
// The light shifts from day (Find) to dusk (Design) to night (Protect), because that is when HAVEN works.
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowRight, Command, CornerDownLeft, MapPin, PencilRuler, Search, ShieldCheck, Sparkles } from 'lucide-react';
import { Star } from '@/components/brand';
import { TYPES, type TypeStory } from './data';
import { Design, Find, Haven, Protect } from './acts';

export const CHAPTERS = [
  { id: 'find', n: 'I', label: 'Find', icon: MapPin },
  { id: 'design', n: 'II', label: 'Design', icon: PencilRuler },
  { id: 'protect', n: 'III', label: 'Protect', icon: ShieldCheck },
  { id: 'haven', n: '+', label: 'HAVEN', icon: Sparkles },
] as const;
type ChapterId = (typeof CHAPTERS)[number]['id'];

export function Story() {
  const root = useRef<HTMLDivElement>(null);
  const [typeId, setTypeId] = useState<TypeStory['id']>('data-center');
  const type = useMemo(() => TYPES.find((t) => t.id === typeId) ?? TYPES[0], [typeId]);
  const [chapter, setChapter] = useState<ChapterId | null>(null);
  const [docked, setDocked] = useState(false);
  const [palette, setPalette] = useState(false);

  // Reveal-on-scroll, chapter tracking, dock visibility and the reading-progress line.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reveal = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add('in'), reveal.unobserve(e.target))),
      { rootMargin: '0px 0px -12% 0px' },
    );
    el.querySelectorAll('[data-reveal]').forEach((n) => reveal.observe(n));
    const chapters = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && setChapter(e.target.id as ChapterId)),
      { rootMargin: '-45% 0px -50% 0px' },
    );
    el.querySelectorAll('[data-chapter]').forEach((n) => chapters.observe(n));
    const hero = el.querySelector('.ps-hero');
    const dock = new IntersectionObserver(([e]) => {
      setDocked(!e.isIntersecting);
      if (e.isIntersecting) setChapter(null);
    }, { threshold: 0.15 });
    if (hero) dock.observe(hero);
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - innerHeight;
        el.style.setProperty('--read', String(max > 0 ? scrollY / max : 0));
      });
    };
    onScroll();
    addEventListener('scroll', onScroll, { passive: true });
    return () => { reveal.disconnect(); chapters.disconnect(); dock.disconnect(); removeEventListener('scroll', onScroll); cancelAnimationFrame(raf); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="ps" ref={root} data-tone={chapter === 'protect' || chapter === 'haven' ? 'dark' : 'light'}>
      <a className="ps-skip" href="#find">Skip to the story</a>
      <TopBar chapter={chapter} onPalette={() => setPalette(true)} />
      <Hero type={type} onType={setTypeId} />
      <Pyramid />
      <Find type={type} onType={setTypeId} />
      <Design type={type} onType={setTypeId} />
      <Protect />
      <Haven />
      <Close />
      <Dock show={docked} chapter={chapter} onPalette={() => setPalette(true)} />
      {palette && <Palette onClose={() => setPalette(false)} onType={setTypeId} />}
    </div>
  );
}

export function Wordmark() {
  return (
    <Link href="/" className="ps-mark" aria-label="GeoStar home">
      <Star className="ps-mark-star" />
      <span>Geo<b>Star</b></span>
    </Link>
  );
}

function TopBar({ chapter, onPalette }: { chapter: ChapterId | null; onPalette: () => void }) {
  return (
    <header className="ps-top">
      <Wordmark />
      <nav aria-label="Story chapters" className="ps-top-links">
        {CHAPTERS.map((c) => (
          <a key={c.id} href={`#${c.id}`} aria-current={chapter === c.id ? 'true' : undefined}>{c.label}</a>
        ))}
      </nav>
      <button type="button" className="ps-kbd-btn" onClick={onPalette} aria-label="Open the command menu">
        <Search size={14} /><span>Jump to…</span><kbd>Ctrl K</kbd>
      </button>
      <Link href="/dashboard-2" className="ps-btn ps-btn-ink ps-btn-sm">Start a project <ArrowRight size={14} /></Link>
      <i className="ps-read" aria-hidden="true" />
    </header>
  );
}

/* ---------------------------------------------------------------- hero */

const BEATS = [
  { k: 'scan', t: 'Reading the place', d: 'Grid, water, schools, flood, people.' },
  { k: 'pick', t: 'Parcel B fits best', d: 'Ranked on what matters to you.' },
  { k: 'build', t: 'A building, drafted', d: 'Edit it, then export the CAD.' },
  { k: 'guard', t: 'Protected for life', d: 'HAVEN watches water, power and smoke.' },
] as const;

function Hero({ type, onType }: { type: TypeStory; onType: (id: TypeStory['id']) => void }) {
  const [beat, setBeat] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setBeat((b) => (b + 1) % BEATS.length), 2800);
    return () => clearInterval(t);
  }, [paused]);

  return (
    <section className="ps-hero" aria-labelledby="ps-hero-title">
      <div className="ps-hero-copy">
        <p className="ps-kicker" data-reveal><i />For commercial builders and developers</p>
        <h1 id="ps-hero-title" data-reveal>
          From an empty plot<br />to a building that <em>looks after itself.</em>
        </h1>
        <p className="ps-lede" data-reveal>
          GeoStar finds the right place to build, designs what goes on it, and protects it once people move in.
          One record of the place, from the first map to the last alarm that never had to ring.
        </p>

        <div className="ps-ask" data-reveal>
          <span className="ps-ask-q">What are you building?</span>
          <div className="ps-chips" role="radiogroup" aria-label="Project type">
            {TYPES.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={t.id === type.id} className="ps-chip" onClick={() => onType(t.id)}>
                {t.short}
              </button>
            ))}
          </div>
          <p className="ps-ask-a" aria-live="polite"><span>{type.question}</span></p>
        </div>

        <div className="ps-actions" data-reveal>
          <Link href="/dashboard-2" className="ps-btn ps-btn-ink">Find my site <ArrowRight size={16} /></Link>
          <a href="#find" className="ps-btn ps-btn-soft">Watch the story</a>
        </div>
      </div>

      <figure
        className="ps-hero-art"
        data-beat={BEATS[beat].k}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        data-reveal
      >
        <HeroPlot />
        <figcaption className="ps-glass ps-beat">
          <ol className="ps-beat-steps" aria-label="The GeoStar story in four beats">
            {BEATS.map((b, i) => (
              <li key={b.k}>
                <button type="button" aria-current={i === beat ? 'step' : undefined} onClick={() => { setBeat(i); setPaused(true); }}>
                  <span className="sr">{b.t}</span>
                </button>
              </li>
            ))}
          </ol>
          <div key={beat} className="ps-beat-text">
            <b>{BEATS[beat].t}</b>
            <span>{BEATS[beat].d}</span>
          </div>
        </figcaption>
      </figure>
    </section>
  );
}

/** Isometric plot that tells the whole story: scan, choose, build, protect. Driven by data-beat on the figure. */
function HeroPlot() {
  const h = 120;
  return (
    <svg className="ps-plot" viewBox="0 0 520 440" role="img" aria-label="A plot of land is scanned, the best parcel is chosen, a building rises on it and sensors light up inside.">
      <defs>
        <linearGradient id="psGround" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#e7e5de" />
        </linearGradient>
        <radialGradient id="psScan" cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#c9ec7a" stopOpacity=".55" /><stop offset="1" stopColor="#c9ec7a" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* ground slab */}
      <path d="M260 120 L490 240 L260 360 L30 240 Z" fill="url(#psGround)" />
      <path d="M30 240 L260 360 L260 378 L30 258 Z" fill="#dcd9d1" />
      <path d="M490 240 L260 360 L260 378 L490 258 Z" fill="#cfccc4" />
      {/* parcel grid */}
      <g className="ps-plot-grid">
        {[1, 2, 3, 4, 5].map((i) => {
          const t = i / 6;
          return (
            <g key={i}>
              <line x1={260 - 230 * t} y1={120 + 120 * t} x2={490 - 230 * t} y2={240 + 120 * t} />
              <line x1={260 + 230 * t} y1={120 + 120 * t} x2={30 + 230 * t} y2={240 + 120 * t} />
            </g>
          );
        })}
      </g>
      {/* context: river and roads */}
      <path className="ps-plot-river" d="M70 262 C150 250 170 300 250 300 S370 330 440 286" />
      <path className="ps-plot-road" d="M296 150 L452 231" />
      {/* the chosen parcel */}
      <path className="ps-plot-parcel" d="M260 188 L340 230 L260 272 L180 230 Z" />
      {/* scanning ring */}
      <ellipse className="ps-plot-scan" cx="260" cy="240" rx="210" ry="110" fill="url(#psScan)" />
      {/* candidate pins */}
      {[[150, 230, 'a'], [260, 222, 'b'], [372, 252, 'c']].map(([x, y, id]) => (
        <g key={id as string} transform={`translate(${x} ${y})`}>
          <g className={`ps-pin ps-pin-${id}`}>
            <ellipse className="ps-pin-halo" rx="16" ry="8" />
            <path d="M0 0 C-9 -12 -10 -18 -10 -22 a10 10 0 0 1 20 0 c0 4 -1 10 -10 22Z" />
            <circle cy="-22" r="3.6" fill="#fff" />
          </g>
        </g>
      ))}
      {/* building rises from the parcel */}
      <g className="ps-bldg">
        <path className="l" d={`M200 236 L260 268 L260 ${268 - h} L200 ${236 - h} Z`} />
        <path className="r" d={`M260 268 L320 236 L320 ${236 - h} L260 ${268 - h} Z`} />
        <path className="t" d={`M200 ${236 - h} L260 ${204 - h} L320 ${236 - h} L260 ${268 - h} Z`} />
        {[1, 2, 3, 4].map((f) => (
          <g key={f} className="ps-bldg-floor">
            <path d={`M200 ${236 - f * 24} L260 ${268 - f * 24} L320 ${236 - f * 24}`} />
          </g>
        ))}
        {[0, 1, 2, 3, 4].map((f) => [0, 1, 2].map((c) => {
          // Windows on the right face, which climbs 32 px over its 60 px run.
          const x = 266 + c * 18, y = 268 - f * 24 - (x - 260) * (32 / 60) - 6, k = 10 * (32 / 60);
          return <path key={`${f}${c}`} className="ps-win" d={`M${x} ${y} L${x + 10} ${y - k} L${x + 10} ${y - k - 11} L${x} ${y - 11} Z`} />;
        }))}
        {/* sensors */}
        {[[232, 226, 'w'], [290, 196, 'e'], [240, 170, 'w'], [296, 150, 's'], [262, 140, 'e']].map(([x, y, k], i) => (
          <g key={i} className={`ps-dot ps-dot-${k}`} transform={`translate(${x} ${y})`} style={{ '--d': `${i * 120}ms` } as CSSProperties}>
            <circle r="9" className="ring" /><circle r="3.4" />
          </g>
        ))}
      </g>
      {/* shield ring once protected */}
      <ellipse className="ps-shield" cx="260" cy="236" rx="118" ry="62" />
    </svg>
  );
}

/* ---------------------------------------------------------------- pyramid: the three things */

function Pyramid() {
  const items = [
    { id: 'find', n: '01', t: 'Find the right place', d: 'Every factor that decides a site, weighed the way your project needs it. Power and water for a data center. Schools, parks and the river for homes.', icon: MapPin },
    { id: 'design', n: '02', t: 'Design what goes on it', d: 'A building modelled on the parcel. Edit it, finalize it, and hand engineers a CAD file. Walk it as a Gaussian splat before ground is broken.', icon: PencilRuler },
    { id: 'protect', n: '03', t: 'Protect it for life', d: 'Sensors where buildings really fail: hidden leaks, hot circuits, smoke. HAVEN watches them and tells the right person in plain words.', icon: ShieldCheck },
  ];
  return (
    <section className="ps-pyr" aria-label="What GeoStar does">
      <p className="ps-pyr-lead" data-reveal>GeoStar does three things, in the order a building lives them.</p>
      <ol className="ps-pyr-list">
        {items.map((it, i) => (
          <li key={it.id} data-reveal style={{ '--i': i } as CSSProperties}>
            <a href={`#${it.id}`} className="ps-neu ps-pyr-card">
              <span className="ps-pyr-n">{it.n}</span>
              <span className="ps-pyr-ico" aria-hidden="true"><it.icon size={20} strokeWidth={1.6} /></span>
              <h2>{it.t}</h2>
              <p>{it.d}</p>
              <span className="ps-pyr-go">Read act {i + 1} <ArrowRight size={14} /></span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ---------------------------------------------------------------- close */

function Close() {
  return (
    <section className="ps-close" aria-labelledby="ps-close-title">
      <div className="ps-close-inner" data-reveal>
        <Star className="ps-close-star" />
        <h2 id="ps-close-title">Every building starts as a plot.<br /><em>Start yours well.</em></h2>
        <p>Pick a project type, choose a city and GeoStar walks you from the map to the model to the sensors.</p>
        <div className="ps-actions ps-actions-c">
          <Link href="/dashboard-2" className="ps-btn ps-btn-lime">Start a project <ArrowRight size={16} /></Link>
          <Link href="/explore" className="ps-btn ps-btn-ghost-light">Explore the map</Link>
        </div>
      </div>
      <footer className="ps-foot">
        <Wordmark />
        <nav aria-label="Product">
          <Link href="/dashboard-2">Locate · Design · Protect</Link>
          <Link href="/projects">Projects dashboard</Link>
          <Link href="/explore">Explore</Link>
          <Link href="/studio">Data center studio</Link>
        </nav>
        <small>© {new Date().getFullYear()} GeoStar. Concept models and planning evidence, not engineering design.</small>
      </footer>
    </section>
  );
}

/* ---------------------------------------------------------------- global action bar */

function Dock({ show, chapter, onPalette }: { show: boolean; chapter: ChapterId | null; onPalette: () => void }) {
  const idx = CHAPTERS.findIndex((c) => c.id === chapter);
  return (
    <div className={`ps-dock ps-glass ${show ? 'show' : ''}`} role="toolbar" aria-label="Story navigation" aria-hidden={!show} inert={!show}>
      <ol className="ps-dock-steps">
        {CHAPTERS.map((c, i) => (
          <li key={c.id} className={i < idx ? 'past' : i === idx ? 'now' : ''}>
            <a href={`#${c.id}`} aria-current={i === idx ? 'step' : undefined}>
              <c.icon size={15} strokeWidth={1.8} aria-hidden="true" />
              <span>{c.label}</span>
            </a>
          </li>
        ))}
      </ol>
      <button type="button" className="ps-dock-k" onClick={onPalette} aria-label="Open the command menu"><Command size={15} /></button>
      <Link href="/dashboard-2" className="ps-btn ps-btn-ink ps-btn-sm">Start <ArrowRight size={14} /></Link>
    </div>
  );
}

type Action = { id: string; group: string; label: string; hint?: string; run: () => void };

function Palette({ onClose, onType }: { onClose: () => void; onType: (id: TypeStory['id']) => void }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const go = useCallback((href: string) => () => { onClose(); location.assign(href); }, [onClose]);
  const jump = useCallback((id: string) => () => { onClose(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }, [onClose]);

  const actions: Action[] = useMemo(() => [
    { id: 'start', group: 'Go', label: 'Start a project', hint: 'Locate, Design, Protect', run: go('/dashboard-2') },
    { id: 'explore', group: 'Go', label: 'Explore the map', hint: 'Real parcels, public data', run: go('/explore') },
    { id: 'studio', group: 'Go', label: 'Open the data center studio', run: go('/studio') },
    { id: 'projects', group: 'Go', label: 'Open the projects dashboard', run: go('/projects') },
    ...CHAPTERS.map((c) => ({ id: `ch-${c.id}`, group: 'Read', label: `${c.label}`, hint: `Act ${c.n}`, run: jump(c.id) })),
    ...TYPES.map((t) => ({ id: `ty-${t.id}`, group: 'Show me', label: `Rank sites for ${t.label.toLowerCase()}`, run: () => { onType(t.id); jump('find')(); } })),
  ], [go, jump, onType]);

  const list = actions.filter((a) => (a.label + ' ' + (a.hint ?? '') + ' ' + a.group).toLowerCase().includes(q.trim().toLowerCase()));
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => setAt(0), [q]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setAt((a) => Math.min(list.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') list[at]?.run();
  };

  let lastGroup = '';
  return (
    <div className="ps-pal-scrim" onMouseDown={onClose}>
      <div className="ps-pal ps-glass" role="dialog" aria-modal="true" aria-label="Command menu" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <label className="ps-pal-in">
          <Search size={16} aria-hidden="true" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Where to? Try “solar” or “protect”"
            role="combobox"
            aria-expanded="true"
            aria-controls="ps-pal-list"
            aria-activedescendant={list[at] ? `pal-${list[at].id}` : undefined}
          />
          <kbd>Esc</kbd>
        </label>
        <ul id="ps-pal-list" role="listbox" className="ps-pal-list">
          {list.length === 0 && <li className="ps-pal-empty">Nothing matches “{q}”.</li>}
          {list.map((a, i) => {
            const head = a.group !== lastGroup ? (lastGroup = a.group) : null;
            return (
              <li key={a.id} role="presentation">
                {head && <span className="ps-pal-group">{head}</span>}
                <div id={`pal-${a.id}`} role="option" aria-selected={i === at} className="ps-pal-item" onMouseEnter={() => setAt(i)} onClick={a.run}>
                  <span>{a.label}</span>{a.hint && <small>{a.hint}</small>}
                  {i === at && <CornerDownLeft size={14} className="ps-pal-enter" aria-hidden="true" />}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

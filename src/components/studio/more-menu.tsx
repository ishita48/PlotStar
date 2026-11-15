'use client';
// The Studio top bar's "More" menu: the secondary pages and Reset, so the bar keeps only what is used all the time.
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';

const PAGES: [string, string][] = [
  ['/studio/agent', 'How the AI works'],
  ['/studio/data', 'Data'],
  ['/explore', 'Live operations'],
  ['/studio/built-with', 'How we built it'],
  ['/', 'Home'],
];

export function MoreMenu({ onReset }: { onReset: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="st-more" ref={box}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        More <ChevronDown size={12} />
      </button>
      {open && (
        <div className="st-more-menu" role="menu">
          {PAGES.map(([href, label]) => (
            <Link key={href} href={href} role="menuitem" onClick={() => setOpen(false)}>
              {label}
            </Link>
          ))}
          <hr />
          <button
            type="button"
            role="menuitem"
            className="st-more-reset"
            title="Clear the brief, site and layouts and start again"
            onClick={() => {
              setOpen(false);
              onReset();
            }}
          >
            <RotateCcw size={12} /> Reset the project
          </button>
        </div>
      )}
    </div>
  );
}

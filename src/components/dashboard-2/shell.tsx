'use client';

import Link from 'next/link';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Layers3,
  MapPin,
  ShieldCheck,
  Sun,
  PanelLeft,
  Radar,
} from 'lucide-react';
import type { ReactNode } from 'react';

export type Module = 'locate' | 'design' | 'protect' | 'deploy';
export type Status = 'pending' | 'active' | 'completed';

export function StatusIndicator({ status }: { status: Status }) {
  return (
    <span className={`d2-status d2-status-${status}`}>
      {status === 'completed' ? <Check size={12} strokeWidth={3} aria-hidden="true" /> : <i />}
      <span className="d2-sr-only">
        {status === 'completed' ? 'Completed' : status === 'active' ? 'In progress' : 'Pending'}
      </span>
    </span>
  );
}

const modules = [
  { id: 'locate', label: 'Locate', detail: 'Find the right place', icon: MapPin },
  { id: 'design', label: 'Design', detail: 'Shape what comes next', icon: Layers3 },
  { id: 'protect', label: 'Protect', detail: 'Care for what you build', icon: ShieldCheck },
  { id: 'deploy', label: 'Deploy', detail: 'Watch over it, live', icon: Radar },
] as const;

export function Sidebar({
  active,
  complete,
  onSelect,
  children,
  statuses,
}: {
  active: Module;
  complete: boolean;
  onSelect: (module: Module) => void;
  children: ReactNode;
  statuses?: Partial<Record<Module, Status>>;
}) {
  return (
    <aside className="d2-sidebar">
      <Link href="/dashboard-2" className="d2-brand" aria-label="AFTERLIGHT home">
        <span className="d2-brand-icon">
          <Sun size={24} strokeWidth={1.6} />
        </span>
        <span>
          AFTERLIGHT<small>A place for possibility.</small>
        </span>
      </Link>
      <div className="d2-sidebar-body">
        <p className="d2-overline">YOUR WORKSPACE</p>
        <nav aria-label="Planning modules" className="d2-modules">
          {modules.map(({ id, label, detail, icon: Icon }) => (
            <button
              key={id}
              onClick={() => onSelect(id)}
              aria-current={active === id ? 'page' : undefined}
              className={`d2-module ${active === id ? 'is-active' : ''}`}
            >
              <Icon size={20} strokeWidth={1.7} aria-hidden="true" />
              <span>
                {label}
                <small>{detail}</small>
              </span>
              <StatusIndicator
                status={
                  statuses?.[id] ||
                  (id === 'locate' ? (complete ? 'completed' : 'active') : 'pending')
                }
              />
            </button>
          ))}
        </nav>
        <div className="d2-sidebar-project">{children}</div>
      </div>
      <div className="d2-sidebar-bottom">
        <div className="d2-workspace-name">
          <PanelLeft size={17} />
          <span>
            Planning studio<small>Interface preview</small>
          </span>
          <span className="d2-local-dot" />
        </div>
        <Link href="/projects">
          <ArrowLeft size={14} /> Original dashboard
        </Link>
      </div>
    </aside>
  );
}

export function StepNavigation({
  step,
  completed,
  onSelect,
  busy,
  names = ['Describe', 'Pick', 'Finalize'],
  label = 'Locate',
  linear = true,
}: {
  step: number;
  completed: boolean[];
  onSelect: (step: number) => void;
  busy: boolean;
  names?: string[];
  label?: string;
  /** When false, every step stays selectable instead of unlocking in order. */
  linear?: boolean;
}) {
  return (
    <nav className="d2-stepbar" aria-label={`${label} steps`}>
      <ol>
        {names.map((name, index) => (
          <li key={name}>
            {index > 0 && <ChevronRight className="d2-step-chevron" size={15} aria-hidden="true" />}
            <button
              aria-current={step === index ? 'step' : undefined}
              className={step === index ? 'is-active' : ''}
              disabled={busy || (linear && index > 0 && !completed[index - 1])}
              onClick={() => onSelect(index)}
            >
              <StatusIndicator
                status={completed[index] ? 'completed' : step === index ? 'active' : 'pending'}
              />
              <span>{name}</span>
            </button>
          </li>
        ))}
      </ol>
      <span className="d2-step-count">
        {label.toUpperCase()} <span>/</span> 0{step + 1}
      </span>
    </nav>
  );
}

export function PrimaryCard({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`d2-primary ${className}`}>{children}</section>;
}

export function Placeholder({ module }: { module: 'design' | 'protect' }) {
  const Icon = module === 'design' ? Layers3 : ShieldCheck;
  const title = module === 'design' ? 'Design' : 'Protect';
  return (
    <PrimaryCard className="d2-placeholder">
      <span className="d2-placeholder-icon">
        <Icon size={48} strokeWidth={1.2} />
      </span>
      <p className="d2-overline">THE NEXT CHAPTER</p>
      <h1>{title}</h1>
      <span className="d2-coming">Coming Soon</span>
      <p>
        {module === 'design'
          ? 'A thoughtful space to bring your vision into focus.'
          : 'Peace of mind, built into every possibility.'}
      </p>
    </PrimaryCard>
  );
}

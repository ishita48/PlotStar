"use client";

import { Activity, FileText, LayoutDashboard, Map, SlidersHorizontal, Zap } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { IntegrationStatus } from "@/lib/api";
import { PRODUCT } from "@/lib/brand";
import { useApi } from "@/lib/useApi";

export const TABS = [
  { href: "/dashboard/portfolio", label: "Portfolio", icon: LayoutDashboard },
  { href: "/dashboard/sites", label: "Site Explorer", icon: Map },
  { href: "/dashboard/power", label: "PowerReady", icon: Zap },
  { href: "/dashboard/optimize", label: "Optimization Studio", icon: SlidersHorizontal },
  { href: "/dashboard/live-grid", label: "Live Grid", icon: Activity },
  { href: "/dashboard/reports", label: "Reports", icon: FileText },
] as const;

export function Sidebar() {
  const path = usePathname();
  return (
    <aside className="flex shrink-0 flex-col border-b border-line bg-panel md:sticky md:top-0 md:h-screen md:w-60 md:border-b-0 md:border-r">
      <Link href="/" className="flex items-baseline gap-2 px-5 py-5">
        <span className="text-lg font-bold tracking-tight">{PRODUCT}</span>
      </Link>
      <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:overflow-visible md:pb-0">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = path.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                active ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel-2 hover:text-text"
              }`}
            >
              <Icon size={16} />
              {label}
            </Link>
          );
        })}
      </nav>
      <IntegrationDots />
    </aside>
  );
}

function IntegrationDots() {
  const { data, error } = useApi<IntegrationStatus>("/integrations/status");
  const rows: [string, boolean | null, string?][] = data
    ? [
        ["API", true],
        ["CoStar extract", data.costar.loaded],
        ["Matterport", data.matterport.configured],
        ["Vexcel imagery", false, data.vexcel.configured ? "key set, adapter pending" : "no key"],
        ["Bedrock agent", data.bedrock.configured, data.bedrock.note],
      ]
    : [["API", error ? false : null]];
  return (
    <div className="mt-auto hidden border-t border-line px-5 py-4 md:block">
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted">Integrations</div>
      <ul className="mt-2 space-y-1.5">
        {rows.map(([name, ok, note]) => (
          <li key={name} className="flex items-center gap-2 text-xs text-muted" title={note}>
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: ok == null ? "var(--muted)" : ok ? "var(--ok)" : "var(--warn)" }}
            />
            {name}
            {note && <span className="truncate text-[10px] text-muted/70">· {note}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

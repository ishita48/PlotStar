"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { SiteDetailPanel } from "@/components/SiteDetailPanel";
import { ErrorBox, LabelChip, Skeleton } from "@/components/ui";
import type { SiteSummary } from "@/lib/api";
import { humanize, num, usd } from "@/lib/format";
import { useApi } from "@/lib/useApi";

const SiteMap = dynamic(() => import("@/components/SiteMap"), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

export default function SitesPage() {
  const [market, setMarket] = useState("Houston");
  const [minAcres, setMinAcres] = useState(0);
  const [heavyOnly, setHeavyOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const path = useMemo(() => {
    const q = new URLSearchParams({ market, candidates_only: "true", limit: "1000" });
    if (minAcres > 0) q.set("min_acres", String(minAcres));
    if (heavyOnly) q.set("heavy_power", "true");
    return `/sites?${q}`;
  }, [market, minAcres, heavyOnly]);
  const { data, error, loading } = useApi<{ count: number; sites: SiteSummary[] }>(path);
  const sites = data?.sites ?? [];

  const ctl = "rounded-lg border border-line bg-panel px-3 py-1.5 text-sm outline-none focus:border-accent/70";

  return (
    <>
      <PageHeader
        title="Site Explorer"
        subtitle="Industrial, flex and land properties from the CoStar Data Extract. Click a pin or row for detail; click any value to see its source record."
        right={
          <div className="flex flex-wrap items-center gap-2">
            <select className={ctl} value={market} onChange={(e) => (setMarket(e.target.value), setSelected(null))}>
              <option>Houston</option>
              <option>Los Angeles</option>
            </select>
            <select className={ctl} value={minAcres} onChange={(e) => setMinAcres(Number(e.target.value))}>
              <option value={0}>Any lot size</option>
              <option value={2}>≥ 2 acres</option>
              <option value={5}>≥ 5 acres</option>
              <option value={10}>≥ 10 acres</option>
              <option value={20}>≥ 20 acres</option>
            </select>
            <label className={`${ctl} flex cursor-pointer items-center gap-2`}>
              <input type="checkbox" checked={heavyOnly} onChange={(e) => setHeavyOnly(e.target.checked)} className="accent-[var(--accent)]" />
              Heavy power only
            </label>
          </div>
        }
      />

      {error && <ErrorBox error={error} />}

      <div className="grid gap-4 2xl:grid-cols-[1fr_420px] xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <div className="relative h-[460px] overflow-hidden rounded-xl border border-line">
            <SiteMap sites={sites} market={market} selected={selected} onSelect={setSelected} />
            <div className="pointer-events-none absolute bottom-3 left-3 z-[500] flex gap-3 rounded-lg bg-bg/80 px-3 py-2 text-[11px] text-muted backdrop-blur">
              <Legend c="#f5a524" t="Heavy power (≥ 800 A)" />
              <Legend c="#5aa9ff" t="Industrial / Flex" />
              <Legend c="#3ccf91" t="Land" />
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-line bg-panel">
            <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
              <span className="text-sm font-semibold">
                {loading ? "Loading…" : `${num(data?.count)} candidate properties`}
              </span>
              <LabelChip label="Sourced" />
            </div>
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-panel text-left text-xs text-muted">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2 font-medium">Property</th>
                    <th className="px-2 py-2 font-medium">Type</th>
                    <th className="px-2 py-2 text-right font-medium">Lot (ac)</th>
                    <th className="px-2 py-2 text-right font-medium">Building SF</th>
                    <th className="px-2 py-2 font-medium">Power</th>
                    <th className="px-2 py-2 font-medium">Availability</th>
                    <th className="px-4 py-2 text-right font-medium">Price signal</th>
                  </tr>
                </thead>
                <tbody className="tabular">
                  {sites.map((s) => (
                    <tr
                      key={s.parcel_id}
                      onClick={() => setSelected(s.parcel_id)}
                      className={`cursor-pointer border-b border-line/40 transition hover:bg-panel-2 ${
                        selected === s.parcel_id ? "bg-accent/10" : ""
                      }`}
                    >
                      <td className="px-4 py-2">
                        <div className="font-medium">{s.name ?? s.address ?? "Unnamed"}</div>
                        <div className="text-xs text-muted">{s.address}</div>
                      </td>
                      <td className="px-2 py-2 text-muted">{humanize(s.property_subtype ?? s.property_type)}</td>
                      <td className="px-2 py-2 text-right">{num(s.lot_acres, 1)}</td>
                      <td className="px-2 py-2 text-right">{num(s.building_sf)}</td>
                      <td className="px-2 py-2">
                        {s.has_heavy_power === 1 ? (
                          <span className="text-accent">Heavy{s.amps_high ? ` · ${num(s.amps_high)} A` : ""}</span>
                        ) : s.has_heavy_power === 0 ? (
                          <span className="text-muted">Standard</span>
                        ) : (
                          <span className="text-muted/60">Unknown</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-muted">{s.availability}</td>
                      <td className="px-4 py-2 text-right">
                        {s.asking_price_low ? (
                          <span title="Asking price (active listing)">{usd(s.asking_price_low)} ask</span>
                        ) : s.last_sale_price ? (
                          <span className="text-muted" title={`Last sale ${s.last_sale_date} · ${s.last_sale_status}`}>
                            {usd(s.last_sale_price)} sold {s.last_sale_date?.slice(0, 4)}
                          </span>
                        ) : (
                          <span className="text-muted/60">Unknown</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!loading && sites.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-muted">
                        No properties match these filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="xl:sticky xl:top-6 xl:self-start">
          {selected ? (
            <SiteDetailPanel parcelId={selected} onClose={() => setSelected(null)} />
          ) : (
            <div className="rounded-xl border border-dashed border-line p-6 text-sm text-muted">
              Select a property on the map or in the table to see its CoStar record, 3D scans and evidence.
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Legend({ c, t }: { c: string; t: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: c }} />
      {t}
    </span>
  );
}

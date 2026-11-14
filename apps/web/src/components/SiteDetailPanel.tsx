"use client";

import { Box, ExternalLink, X } from "lucide-react";
import { useState } from "react";
import { matterportEmbedUrl, type Label, type MatterportModel, type SiteDetail } from "@/lib/api";
import { humanize, num, usd } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import { useAudit } from "./AuditProvider";
import { ErrorBox, LabelChip, PhaseBadge, Skeleton } from "./ui";

type Row = { field: string; label: string; value: string };

export function SiteDetailPanel({ parcelId, onClose }: { parcelId: string; onClose: () => void }) {
  const { data, error, loading } = useApi<SiteDetail>(`/sites/${encodeURIComponent(parcelId)}`);
  const { openParcelAudit } = useAudit();

  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Skeleton className="h-[600px]" />;
  const p = data.parcel;
  const L = (f: string): Label => data.labels[f] ?? "Unknown";

  const rows: Row[] = [
    { field: "property_type", label: "Type", value: humanize(p.property_subtype ?? p.property_type) },
    { field: "lot_acres", label: "Lot size", value: p.lot_acres == null ? "Unknown" : `${num(p.lot_acres, 2)} acres` },
    { field: "building_sf", label: "Building", value: p.building_sf == null ? "Unknown" : `${num(p.building_sf)} SF` },
    { field: "year_built", label: "Year built", value: (p.year_built as number | null)?.toString() ?? "Unknown" },
    { field: "building_class", label: "Class", value: (p.building_class as string | null) ?? "Unknown" },
    {
      field: "has_heavy_power",
      label: "Heavy power",
      value: p.has_heavy_power == null ? "Unknown" : p.has_heavy_power ? "Yes (≥ 800 A)" : "No",
    },
    { field: "amps_high", label: "Service (amps)", value: num(p.amps_high) },
    { field: "volts_high", label: "Service (volts)", value: num(p.volts_high as number | null) },
    { field: "ceiling_height_ft", label: "Clear height", value: p.ceiling_height_ft == null ? "Unknown" : `${p.ceiling_height_ft} ft` },
    { field: "zoning", label: "Zoning (as recorded)", value: (p.zoning as string | null) ?? "Unknown" },
    { field: "availability", label: "Availability", value: p.availability },
    {
      field: "asking_price_low",
      label: "Asking price",
      value:
        p.asking_price_low == null
          ? "Unknown"
          : p.asking_price_high && p.asking_price_high !== p.asking_price_low
            ? `${usd(p.asking_price_low)} to ${usd(p.asking_price_high)}`
            : usd(p.asking_price_low),
    },
    {
      field: "last_sale_price",
      label: "Last sale",
      value:
        p.last_sale_price == null
          ? "Unknown"
          : `${usd(p.last_sale_price)} · ${p.last_sale_date ?? "date unknown"} · ${p.last_sale_status}${p.last_sale_is_portfolio ? " (portfolio share)" : ""}`,
    },
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel">
      {p.photo_url && (
        // CoStar CDN photo, linked from the record's primaryPhoto.attachmentUri
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.photo_url} alt={p.name ?? p.address ?? "Property photo"} className="h-44 w-full object-cover" />
      )}
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold leading-tight">{p.name ?? p.address ?? "Unnamed property"}</h2>
            <p className="text-sm text-muted">
              {[p.address, p.city, p.state].filter(Boolean).join(", ")}
              {p.building_park ? ` · ${p.building_park}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-muted hover:text-text" aria-label="Close detail">
            <X size={18} />
          </button>
        </div>
        <p className="mt-2 text-[11px] text-muted">
          CoStar property {p.costar_property_id} · <code>{p.source_file}</code> line {p.source_row}
        </p>

        <dl className="mt-4 divide-y divide-line/60 text-sm">
          {rows.map((r) => (
            <button
              key={r.field}
              onClick={() => openParcelAudit(p.parcel_id, r.field)}
              className="grid w-full grid-cols-[120px_1fr_auto] items-center gap-2 py-2 text-left transition hover:bg-panel-2"
              title="Show evidence"
            >
              <dt className="text-muted">{r.label}</dt>
              <dd className={`tabular ${r.value === "Unknown" ? "text-muted/60" : ""}`}>{r.value}</dd>
              <LabelChip label={L(r.field)} />
            </button>
          ))}
        </dl>

        <Section title="Hard-gate screening" phase={2}>
          Residential proximity, water stress (WRI Aqueduct), flood exposure, cooling compatibility and zoning constraints
          will be evaluated here as Pass, Fail or Needs review, each with its measured value and threshold.
        </Section>

        <Section title="Aerial imagery (Vexcel)" phase={1}>
          The Vexcel key is configured. The imagery adapter is waiting on the Vexcel quickstart for the exact endpoint, so no
          image is shown rather than a placeholder.
        </Section>

        <Matterport ids={data.matterport_model_ids} />
      </div>
    </div>
  );
}

function Section({ title, phase, children }: { title: string; phase: number; children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-dashed border-line p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        {title} <PhaseBadge phase={phase} />
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted">{children}</p>
    </div>
  );
}

function Matterport({ ids }: { ids: string[] }) {
  const [idx, setIdx] = useState(0);
  const [embed, setEmbed] = useState(false);
  const id = ids[idx];
  const { data, error } = useApi<MatterportModel>(id ? `/matterport/models/${id}` : null);

  if (ids.length === 0)
    return <p className="mt-4 text-xs text-muted">No Matterport scan is recorded for this property.</p>;

  return (
    <div className="mt-4 rounded-lg border border-line bg-panel-2 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Box size={15} className="text-accent" /> Matterport 3D ({ids.length} scan{ids.length > 1 ? "s" : ""})
        </div>
        {ids.length > 1 && (
          <select
            className="rounded border border-line bg-bg px-2 py-0.5 text-xs"
            value={idx}
            onChange={(e) => (setIdx(Number(e.target.value)), setEmbed(false))}
          >
            {ids.map((m, i) => (
              <option key={m} value={i}>
                Scan {i + 1}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-warn">Matterport metadata unavailable: {error.message}</p>}
      {data && (
        <p className="mt-1 text-xs text-muted">
          {data.name?.trim()} · {data.visibility} · retrieved {new Date(data.retrieved_at).toLocaleString()}
        </p>
      )}
      {embed ? (
        <iframe
          src={matterportEmbedUrl(id)}
          className="mt-3 aspect-video w-full rounded-md border border-line"
          allow="xr-spatial-tracking; fullscreen"
          allowFullScreen
          title={`Matterport model ${id}`}
        />
      ) : (
        <button onClick={() => setEmbed(true)} className="group relative mt-3 block w-full overflow-hidden rounded-md border border-line">
          {data?.image?.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={data.image.url} alt="Matterport preview" className="aspect-video w-full object-cover opacity-80 transition group-hover:opacity-100" />
          ) : (
            <div className="aspect-video w-full bg-bg" />
          )}
          <span className="absolute inset-0 grid place-items-center text-sm font-semibold">
            <span className="rounded-full bg-black/60 px-4 py-2">Open 3D tour</span>
          </span>
        </button>
      )}
      <a
        href={matterportEmbedUrl(id)}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-flex items-center gap-1 text-xs text-muted hover:text-text"
      >
        Open in Matterport <ExternalLink size={11} />
      </a>
    </div>
  );
}

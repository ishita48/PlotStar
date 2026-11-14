"use client";

import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { SiteSummary } from "@/lib/api";
import { humanize, num } from "@/lib/format";

const CENTERS: Record<string, [number, number]> = {
  Houston: [29.78, -95.4],
  "Los Angeles": [34.03, -118.3],
};

function FitBounds({ sites, market }: { sites: SiteSummary[]; market: string }) {
  const map = useMap();
  useEffect(() => {
    if (sites.length === 0) {
      map.setView(CENTERS[market] ?? CENTERS.Houston, 10);
      return;
    }
    const lats = sites.map((s) => s.lat);
    const lons = sites.map((s) => s.lon);
    map.fitBounds(
      [
        [Math.min(...lats), Math.min(...lons)],
        [Math.max(...lats), Math.max(...lons)],
      ],
      { padding: [30, 30], maxZoom: 13 },
    );
  }, [sites, market, map]);
  return null;
}

function color(s: SiteSummary) {
  if (s.has_heavy_power === 1) return "#f5a524";
  if (s.property_type === "Land") return "#3ccf91";
  return "#5aa9ff";
}

export default function SiteMap({
  sites,
  market,
  selected,
  onSelect,
}: {
  sites: SiteSummary[];
  market: string;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <MapContainer center={CENTERS[market] ?? CENTERS.Houston} zoom={10} className="h-full w-full" scrollWheelZoom>
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
      />
      <FitBounds sites={sites} market={market} />
      {sites.map((s) => {
        const isSel = s.parcel_id === selected;
        const r = Math.max(5, Math.min(16, 4 + Math.sqrt(s.lot_acres ?? 1) * 1.6));
        return (
          <CircleMarker
            key={s.parcel_id}
            center={[s.lat, s.lon]}
            radius={isSel ? r + 4 : r}
            pathOptions={{
              color: isSel ? "#ffffff" : color(s),
              weight: isSel ? 3 : 1.5,
              fillColor: color(s),
              fillOpacity: isSel ? 0.9 : 0.55,
            }}
            eventHandlers={{ click: () => onSelect(s.parcel_id) }}
          >
            <Tooltip direction="top" offset={[0, -6]}>
              <div className="text-xs">
                <div className="font-semibold">{s.name ?? s.address ?? s.parcel_id}</div>
                <div>
                  {humanize(s.property_subtype ?? s.property_type)} · {num(s.lot_acres, 1)} ac
                </div>
              </div>
            </Tooltip>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}

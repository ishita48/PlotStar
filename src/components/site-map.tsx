'use client';
import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Map as LibreMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { AmenityResult, Site } from '@/lib/types';
import { scoreSite } from '@/lib/engine';
export default function SiteMap({
  sites,
  selectedId,
  weights,
  onSelect,
  amenities,
}: {
  sites: Site[];
  selectedId: string;
  weights: Record<string, number>;
  onSelect: (id: string) => void;
  amenities?: AmenityResult | null;
}) {
  const container = useRef<HTMLDivElement>(null),
    map = useRef<LibreMap | null>(null),
    markers = useRef<maplibregl.Marker[]>([]),
    callback = useRef(onSelect);
  callback.current = onSelect;
  const [failed, setFailed] = useState(false),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!container.current) return;
    try {
      const m = new maplibregl.Map({
        container: container.current,
        center: [-74.65, 40.34],
        zoom: 12.2,
        pitch: 0,
        style: {
          version: 8,
          sources: {
            osm: {
              type: 'raster',
              tiles: [
                process.env.NEXT_PUBLIC_MAP_TILE_URL ||
                  'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
              ],
              tileSize: 256,
              attribution:
                '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
              maxzoom: 19,
            },
          },
          layers: [
            {
              id: 'basemap',
              type: 'raster',
              source: 'osm',
              paint: { 'raster-saturation': -0.8, 'raster-contrast': -0.08, 'raster-opacity': 0.8 },
            },
          ],
        },
        attributionControl: { compact: false },
      });
      map.current = m;
      m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
      m.on('style.load', () => setLoaded(true));
      m.on('load', () => {
        setLoaded(true);
        setFailed(false);
      });
      m.on('error', (e) => {
        if (/WebGL|initialize|style.*load/i.test(e.error?.message || '')) setFailed(true);
      });
      return () => {
        markers.current.forEach((m) => m.remove());
        m.remove();
        map.current = null;
      };
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    if (!map.current || !loaded) return;
    markers.current.forEach((m) => m.remove());
    markers.current = [];
    for (const s of sites) {
      const el = document.createElement('button');
      el.className = `site-marker ${s.id === selectedId ? 'selected' : ''}`;
      el.setAttribute('aria-label', `Select ${s.name}`);
      el.textContent = `${s.id.slice(-1).toUpperCase()} · ${scoreSite(s, weights)}`;
      el.onclick = () => callback.current(s.id);
      markers.current.push(
        new maplibregl.Marker({ element: el }).setLngLat([s.lng, s.lat]).addTo(map.current),
      );
    }
    for (const a of amenities?.points || []) {
      const el = document.createElement('div');
      el.className = 'amenity-marker';
      el.title = `${a.name} · OpenStreetMap`;
      markers.current.push(
        new maplibregl.Marker({ element: el }).setLngLat([a.lng, a.lat]).addTo(map.current),
      );
    }
  }, [sites, selectedId, weights, loaded, amenities]);
  useEffect(() => {
    const site = sites.find((s) => s.id === selectedId);
    if (map.current && site) map.current.easeTo({ center: [site.lng, site.lat], duration: 800 });
  }, [selectedId, sites]);
  return (
    <div className="map-container">
      <div
        ref={container}
        className="map-canvas"
        aria-label="Interactive OpenStreetMap site comparison map"
      />
      {failed && (
        <div className="map-fallback">
          <b>Base map unavailable</b>
          <span>Candidate locations remain illustrative. Select a site below.</span>
          <div>
            {sites.map((s) => (
              <button key={s.id} onClick={() => onSelect(s.id)}>
                {s.name} · {s.lat}, {s.lng}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="map-label">
        <span className="pulse-dot" /> PRINCETON REGION <span>4 illustrative candidates</span>
      </div>
      <div className="map-legend">
        <i /> Illustrative candidate <i className="amenity" /> Live mapped amenity
      </div>
    </div>
  );
}

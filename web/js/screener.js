// "Where to build": click the Houston map to screen a site.
//   * Flood zone   FEMA National Flood Hazard Layer, queried live      (hard gate, Sourced)
//   * Homes nearby OpenStreetMap residential areas, pre-rasterized     (hard gate, Estimated)
//   * Grid access  nearest substation and 345 kV line from OSM        (information, Estimated)
// CoStar sites appear as pins and a ranked shortlist when web/data/costar-sites.json
// exists (built locally by bridge/costar_sites.py; it holds CoStar data, so it is
// never committed).

import { $, $$, h, fmt, ICON, chip } from "./util.js";
import { auditable } from "./audit.js";
import { getJSON } from "./data.js";

const FEMA = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query";
const PRESETS = {
  channelview: { lat: 29.8366, lon: -95.1174, zoom: 13 },
  zenith: { lat: 29.9101, lon: -95.7832, zoom: 13 },
  brays: { lat: 29.707, lon: -95.392, zoom: 14 },
  downtown: { lat: 29.7604, lon: -95.3698, zoom: 14 },
};
const GAPS = [
  "Water stress (WRI Aqueduct)",
  "Zoning and deed restrictions",
  "Utility capacity and connection date",
  "Parcel price and availability (CoStar)",
];
const SEARCH_KM = 3;
const KM_LAT = 111.32;
const kmLon = (lat) => 111.32 * Math.cos((lat * Math.PI) / 180);

let grid = null;
let costar = null;
let bits = null;
let map, pin;
let site = null;
let seq = 0;
let bufferKm = 0.5;

export async function initScreener() {
  map = L.map("map", { scrollWheelZoom: false, zoomSnap: 0.5 }).setView([29.8, -95.37], 10);
  const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
  L.tileLayer(`${esri}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 16,
    attribution: 'Tiles &copy; Esri — Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, and the GIS user community · Grid data &copy; OpenStreetMap contributors',
  }).addTo(map);
  map.createPane("labels");
  map.getPane("labels").style.zIndex = 450;
  map.getPane("labels").style.pointerEvents = "none";
  L.tileLayer(`${esri}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16, pane: "labels" }).addTo(map);
  // Don't hijack page scrolling until someone interacts with the map.
  map.on("click focus", () => map.scrollWheelZoom.enable());
  map.on("mouseout", () => map.scrollWheelZoom.disable());
  map.on("click", (e) => screen(e.latlng.lat, e.latlng.lng));

  $$(".preset").forEach((b) =>
    b.addEventListener("click", () => {
      const p = PRESETS[b.dataset.preset];
      map.flyTo([p.lat, p.lon], p.zoom, { duration: 0.9 });
      screen(p.lat, p.lon, { preset: b.dataset.preset });
    }),
  );

  grid = await getJSON("data/houston-grid.json", 20000);
  bits = Uint8Array.from(atob(grid.residential.bits), (c) => c.charCodeAt(0));
  drawLayers();
  const when = new Date(grid.retrieved_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  $("#src-osm").innerHTML = `<i class="dot on"></i>Snapshot, ${when}`;
  $("#map-src").textContent = `OpenStreetMap · ${when}`;
  await loadCostar();

  // Shareable links: ?site=channelview opens with that example screened.
  const preset = new URLSearchParams(location.search).get("site");
  if (preset === "costar-top") $('.preset[data-preset="costar-top"]')?.click();
  if (PRESETS[preset]) {
    const p = PRESETS[preset];
    map.setView([p.lat, p.lon], p.zoom);
    screen(p.lat, p.lon, { preset });
  }
}

/* ---------------------------------------------------------------- map layers */

function drawLayers() {
  const renderer = L.canvas({ padding: 0.4 });
  const r = grid.residential;
  const b = grid.bbox;

  const canvas = document.createElement("canvas");
  canvas.width = r.cols;
  canvas.height = r.rows;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(r.cols, r.rows);
  for (let row = 0; row < r.rows; row++) {
    for (let col = 0; col < r.cols; col++) {
      const i = row * r.cols + col;
      if (!((bits[i >> 3] >> (i & 7)) & 1)) continue;
      const p = ((r.rows - 1 - row) * r.cols + col) * 4;
      img.data.set([232, 123, 164, 84], p);
    }
  }
  ctx.putImageData(img, 0, 0);
  L.imageOverlay(canvas.toDataURL(), [[b.south, b.west], [b.south + r.rows * r.cell_lat, b.west + r.cols * r.cell_lon]], {
    className: "homes-layer",
    interactive: false,
  }).addTo(map);

  for (const [kv, style] of [["138", { color: "#86b6ef", weight: 1.4 }], ["345", { color: "#1c5cab", weight: 2.6 }]]) {
    for (const flat of grid.lines[kv]) {
      const ll = [];
      for (let i = 0; i < flat.length; i += 2) ll.push([flat[i + 1], flat[i]]);
      L.polyline(ll, { ...style, opacity: 0.95, renderer, interactive: false }).addTo(map);
    }
  }

  for (const [lon, lat, kv, name] of grid.substations) {
    const m = L.circleMarker([lat, lon], {
      renderer, radius: kv >= 300 ? 5 : 3.2, color: "#ffffff", weight: 1.5, fillColor: kv >= 300 ? "#0b0b0b" : "#52514e", fillOpacity: 1,
    });
    m.bindTooltip(`${name || "Substation"}${kv ? ` · ${kv} kV` : ""}`, { className: "sub-tip", direction: "top", offset: [0, -5] });
    m.on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      screen(lat, lon);
    });
    m.addTo(map);
  }
}

/* ---------------------------------------------------------------- CoStar sites */

async function loadCostar() {
  try {
    costar = await getJSON("data/costar-sites.json", 8000);
  } catch {
    return; // CoStar data isn't on this machine
  }
  for (const c of costar.sites) {
    const icon = L.divIcon({ className: `costar-pin ${c.screen.verdict}`, html: "<span></span>", iconSize: [14, 14] });
    L.marker([c.lat, c.lon], { icon, title: `${c.name} (CoStar)`, riseOnHover: true })
      .on("click", () => screen(c.lat, c.lon, { site: c }))
      .addTo(map);
  }
  const top = costar.sites.find((c) => c.screen.verdict === "pass");
  if (top) {
    const b = h("button", { class: "preset", "data-preset": "costar-top" }, "Top CoStar site");
    b.addEventListener("click", () => {
      map.flyTo([top.lat, top.lon], 15, { duration: 0.9 });
      screen(top.lat, top.lon, { site: top, preset: "costar-top" });
    });
    $(".presets").append(b);
  }
  $("#legend-costar").hidden = false;
  const s = costar.summary;
  $("#src-costar").innerHTML = `<i class="dot on"></i>${s.sites} Houston sites, on this laptop only`;
  renderShortlist();
}

const sqft = (v) => (!v ? "—" : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M sq ft` : `${Math.round(v / 1000)}K sq ft`);

const powerText = (p) => {
  const spec = [p.amps && `${fmt.int(p.amps)} A`, p.volts && `${p.volts} V`, p.phases && `${p.phases}-phase`].filter(Boolean).join(", ");
  if (p.heavy === true) return `Heavy power${spec ? ` (${spec})` : ""}`;
  if (p.heavy === false) return `Standard${spec ? ` (${spec})` : ""}`;
  return spec || "Not recorded";
};

function costarAudit(c) {
  return () => ({
    title: c.name,
    value: `CoStar property ${c.id}`,
    label: "Sourced",
    source: costar.source,
    retrieved: `Screened ${new Date(costar.generated_at).toLocaleString("en-US")}`,
    formula: `Fields from ${c.source.file} (id ${c.id}): lot size, building area, electric service, zoning, construction year, active listings, parcel numbers.\nShortlist order: ${costar.screening.shortlist_order}.`,
    inputs: [["Rank", `${c.rank} of ${costar.sites.length}`], ["Matterport 3D models", String(c.matterport_models)]],
    note: "CoStar data stays on the demo laptop; it is not published with the site.",
  });
}

function costarCard(c) {
  const listed = c.listing.active.length
    ? `${c.listing.active.join(" and ")}${c.listing.asking_low ? `, asking ${fmt.money(c.listing.asking_low)}${c.listing.asking_high && c.listing.asking_high !== c.listing.asking_low ? `–${fmt.money(c.listing.asking_high)}` : ""}` : ""}`
    : "Not listed now";
  const facts = [
    ["Use", `${c.use}${c.year_built ? `, built ${c.year_built}` : ""}`],
    ["Lot", c.lot_acres ? `${c.lot_acres.toFixed(1)} acres` : "Not recorded"],
    ["Building", c.building_sf ? `${fmt.int(c.building_sf)} sq ft` : "Not recorded"],
    ["Power", powerText(c.power)],
    ["Zoning", c.zoning || "Not recorded"],
    ["Listed", listed],
    ["Parcel", c.parcels[0] || "Not recorded"],
    ["3D scan", c.matterport_models ? `${c.matterport_models} Matterport model${c.matterport_models > 1 ? "s" : ""}` : "None"],
  ];
  const src = h("span", {}, `CoStar · property ${c.id}`);
  auditable(src, costarAudit(c));
  return h("div", { class: "costar-card" },
    h("p", { class: "costar-name" }, c.name, h("span", { class: "costar-rank" }, `#${c.rank}`)),
    h("p", { class: "fine" }, c.address),
    h("dl", { class: "costar-facts" }, facts.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
    h("p", { class: "g-note" }, chip("Sourced"), " ", src));
}

function renderShortlist() {
  const s = costar.summary;
  const box = $("#costar");
  const pass = costar.sites.filter((c) => c.screen.verdict === "pass");
  const steps = [
    ["CoStar's Houston industrial, flex and land sites", s.sites],
    ["Outside FEMA's 100-year floodplain", costar.sites.filter((c) => c.screen.flood_status === "pass").length],
    [`Also more than ${fmt.dist(0.5)} from homes`, pass.length],
    ["Also have heavy power", s.pass_with_heavy_power],
  ];
  const max = steps[0][1] || 1;
  const funnel = h("div", { class: "funnel" }, steps.map(([label, n]) =>
    h("div", { class: "funnel-row" },
      h("span", { class: "funnel-label" }, label),
      h("span", { class: "funnel-bar" }, h("i", { style: { width: `${Math.max((n / max) * 100, 1.5)}%` } })),
      h("span", { class: "funnel-n" }, fmt.int(n)))));

  const row = (c) => {
    const tr = h("tr", { tabindex: 0, title: "Show on the map" },
      h("td", {}, c.rank),
      h("td", {}, h("strong", {}, c.name), h("span", { class: "fine", style: { display: "block" } }, `${c.use} · ${c.city}`)),
      h("td", {}, c.lot_acres ? `${c.lot_acres.toFixed(1)} ac` : "—"),
      h("td", {}, sqft(c.building_sf)),
      h("td", {}, c.power.heavy === true ? (c.power.amps ? `Heavy, ${fmt.int(c.power.amps)} A` : "Heavy") : c.power.heavy === false ? "Standard" : "—"),
      h("td", {}, c.screen.line345_km != null ? fmt.dist(c.screen.line345_km) : "—"),
      h("td", {}, c.screen.flood?.zone ? `Zone ${c.screen.flood.zone}` : "—"),
      h("td", {}, c.listing.active.length ? c.listing.active.join(", ") : "—"));
    const go = () => {
      map.flyTo([c.lat, c.lon], 15, { duration: 0.9 });
      screen(c.lat, c.lon, { site: c });
      $("#map").scrollIntoView({ behavior: "smooth", block: "center" });
    };
    tr.addEventListener("click", go);
    tr.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go()));
    return tr;
  };
  const top = pass.slice(0, 8);
  box.replaceChildren(
    h("div", { class: "shortlist-head" },
      h("div", {}, h("p", { class: "kicker" }, "CoStar data · Houston"), h("h3", {}, "Which of CoStar's Houston sites could host a data center?")),
      chip("Sourced")),
    h("p", { class: "shortlist-lede" },
      `Every industrial, flex and land property in CoStar's Houston data, run through the same gates. ${s.flood_fails} sit in the floodplain and ${s.homes_fails} are within ${fmt.dist(0.5)} of homes. ${pass.length} pass; ${s.pass_with_heavy_power} of those already have heavy power.`),
    funnel,
    h("div", { class: "table-scroll" },
      h("table", { class: "data-table shortlist-table" },
        h("thead", {}, h("tr", {}, ...["#", "Site", "Lot", "Building", "Power", "345 kV line", "Flood", "Listed"].map((t) => h("th", {}, t)))),
        h("tbody", {}, top.map(row)))),
    h("p", { class: "fine", style: { marginTop: "10px" } },
      `Showing the top ${top.length} of ${pass.length} that pass. Order: ${costar.screening.shortlist_order}. Largest lot in the data: ${s.largest_lot_acres} acres; median ${s.median_lot_acres} acres.`),
  );
  box.hidden = false;
}

/* ---------------------------------------------------------------- geometry */

const inArea = (lat, lon) => grid && lat >= grid.bbox.south && lat <= grid.bbox.north && lon >= grid.bbox.west && lon <= grid.bbox.east;

function residentialKm(lat, lon) {
  const r = grid.residential;
  const b = grid.bbox;
  const r0 = Math.floor((lat - b.south) / r.cell_lat);
  const c0 = Math.floor((lon - b.west) / r.cell_lon);
  const span = Math.ceil(SEARCH_KM / (r.cell_lat * KM_LAT)) + 1;
  const kx = kmLon(lat);
  let best = null;
  for (let row = r0 - span; row <= r0 + span; row++) {
    if (row < 0 || row >= r.rows) continue;
    for (let col = c0 - span; col <= c0 + span; col++) {
      if (col < 0 || col >= r.cols) continue;
      const i = row * r.cols + col;
      if (!((bits[i >> 3] >> (i & 7)) & 1)) continue;
      const la0 = b.south + row * r.cell_lat;
      const lo0 = b.west + col * r.cell_lon;
      const dy = Math.max(la0 - lat, 0, lat - (la0 + r.cell_lat)) * KM_LAT;
      const dx = Math.max(lo0 - lon, 0, lon - (lo0 + r.cell_lon)) * kx;
      const d = Math.hypot(dx, dy);
      if (best === null || d < best) best = d;
    }
  }
  return best !== null && best <= SEARCH_KM ? best : null;
}

function nearestSubstation(lat, lon) {
  const kx = kmLon(lat);
  let best = null;
  for (const [slon, slat, kv, name, operator] of grid.substations) {
    const d = Math.hypot((slon - lon) * kx, (slat - lat) * KM_LAT);
    if (!best || d < best.km) best = { km: d, kv, name, operator };
  }
  return best;
}

function nearestLineKm(lat, lon, kv) {
  const kx = kmLon(lat);
  let best = Infinity;
  for (const flat of grid.lines[kv]) {
    for (let i = 0; i + 3 < flat.length; i += 2) {
      const ax = (flat[i] - lon) * kx, ay = (flat[i + 1] - lat) * KM_LAT;
      const bx = (flat[i + 2] - lon) * kx, by = (flat[i + 3] - lat) * KM_LAT;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

/* ---------------------------------------------------------------- FEMA */

async function femaZone(lat, lon) {
  const url = `${FEMA}?geometry=${lon.toFixed(6)},${lat.toFixed(6)}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF&returnGeometry=false&f=json`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || "service error");
    const feats = (j.features || []).map((f) => f.attributes);
    // On a zone boundary, report the more hazardous zone.
    feats.sort((a, b) => (b.SFHA_TF === "T") - (a.SFHA_TF === "T"));
    const f = feats[0];
    return { state: "ok", url, at: new Date(), zone: f?.FLD_ZONE ?? null, subtype: f?.ZONE_SUBTY ?? null, sfha: f?.SFHA_TF ?? null };
  } catch (e) {
    return { state: "error", url, at: new Date(), error: e.name === "AbortError" ? "timed out" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

function floodGate(f) {
  if (f.state === "pending") return { status: "pending", text: ["Checking FEMA's flood map…"] };
  if (f.state === "error") return { status: "review", text: [`FEMA's flood service didn't answer (${f.error}). Check again before deciding.`] };
  if (!f.zone) return { status: "review", text: ["FEMA has no flood map at this exact point."] };
  const z = f.zone.toUpperCase();
  const sub = (f.subtype || "").toUpperCase();
  if (sub.includes("FLOODWAY")) return { status: "fail", text: [`Zone ${z}, regulatory floodway: the channel that carries floodwater.`] };
  if (/^V/.test(z)) return { status: "fail", text: [`Zone ${z}: coastal high-hazard area.`] };
  if (f.sfha === "T" || /^A/.test(z)) return { status: "fail", text: [`Zone ${z}: inside the 1% annual chance (100-year) floodplain.`] };
  if (z === "OPEN WATER") return { status: "fail", text: ["Open water."] };
  if (z === "D") return { status: "review", text: ["Zone D: flood risk undetermined."] };
  if (sub.includes("0.2 PCT")) return { status: "pass", text: ["Zone X, 0.2% annual chance (500-year) area. Outside the 100-year floodplain."] };
  return { status: "pass", text: [`Zone ${z}: minimal flood hazard.`] };
}

/* ---------------------------------------------------------------- screening */

async function screen(lat, lon, opts = {}) {
  const id = ++seq;
  $$(".preset").forEach((b) => b.classList.toggle("active", b.dataset.preset === opts.preset));
  if (!pin) {
    pin = L.marker([lat, lon], { icon: L.divIcon({ className: "site-pin", html: "<span></span>" }), keyboard: false, interactive: false }).addTo(map);
  } else {
    pin.setLatLng([lat, lon]);
    const el = pin.getElement()?.firstChild; // replay the drop animation
    if (el) {
      el.style.animation = "none";
      void el.offsetWidth;
      el.style.animation = "";
    }
  }
  const inside = !!grid && inArea(lat, lon);
  site = {
    lat, lon, costar: opts.site || null, inside,
    flood: { state: "pending" },
    homesKm: inside ? residentialKm(lat, lon) : undefined,
    sub: inside ? nearestSubstation(lat, lon) : null,
    line345: inside ? nearestLineKm(lat, lon, "345") : null,
  };
  renderPanel();
  const flood = await femaZone(lat, lon);
  if (id !== seq) return; // a newer click won
  site.flood = flood;
  renderPanel();
}

function homesGate() {
  if (!site.inside) return { status: "review", text: ["Outside our Houston map data. Needs an imagery review."] };
  const buf = h("span", {}, fmt.dist(bufferKm));
  if (site.homesKm == null) return { status: "pass", text: [`No residential areas mapped within ${SEARCH_KM} km.`] };
  const dist = h("span", {}, fmt.dist(site.homesKm));
  auditable(dist, homesAudit);
  auditable(buf, homesAudit);
  if (site.homesKm <= bufferKm) return { status: "fail", text: ["Residential area ", dist, " away, inside the ", buf, " buffer."] };
  return { status: "pass", text: ["Nearest residential area ", dist, " away. Buffer: ", buf, "."] };
}

function homesAudit() {
  return {
    title: "Distance to homes",
    value: site.homesKm == null ? `None within ${SEARCH_KM} km` : fmt.dist(site.homesKm),
    label: "Estimated",
    source: "OpenStreetMap residential areas (landuse=residential)",
    url: "https://www.openstreetmap.org/copyright",
    retrieved: new Date(grid.retrieved_at).toLocaleString("en-US"),
    formula: `${grid.residential.method}.\nDistance = straight line from this point to the nearest marked cell.\nFail if distance ≤ buffer.`,
    inputs: [["Buffer (team assumption)", fmt.dist(bufferKm)], ["Residential areas used", fmt.int(grid.residential.areas_used)]],
    note: "OSM land-use coverage is incomplete, and cells are about 110 m across. Aerial imagery (Vexcel) confirms homes before a decision.",
  };
}

function floodAudit() {
  const f = site.flood;
  return {
    title: "FEMA flood zone",
    value: f.zone ? `Zone ${f.zone}${f.subtype ? ` · ${f.subtype.toLowerCase()}` : ""}` : "No zone returned",
    label: "Sourced",
    source: "FEMA National Flood Hazard Layer, flood hazard zones",
    url: f.url,
    retrieved: f.at?.toLocaleString("en-US"),
    formula: "Point-in-polygon query of FEMA's flood hazard zone layer at this location.\nFail inside a Special Flood Hazard Area (zones A and V) or a floodway.",
    note: "A preliminary screen. A site survey and local floodplain rules still apply.",
  };
}

function gridRow() {
  if (!site.inside) return { status: "info", text: ["Outside our Houston grid map."] };
  const s = site.sub;
  const subDist = h("span", {}, fmt.dist(s.km));
  const lineDist = h("span", {}, fmt.dist(site.line345));
  auditable(subDist, () => ({
    title: "Nearest substation",
    value: `${fmt.dist(s.km)} · ${s.name || "unnamed"}`,
    label: "Estimated",
    source: "OpenStreetMap power=substation",
    url: "https://www.openstreetmap.org/copyright",
    retrieved: new Date(grid.retrieved_at).toLocaleString("en-US"),
    formula: "Straight-line distance to the nearest mapped substation.",
    inputs: [["Voltage", s.kv ? `${s.kv} kV` : "not tagged"], ["Operator", s.operator || "not tagged"]],
    note: "A nearby substation is not available capacity. Connection needs a utility study.",
  }));
  auditable(lineDist, () => ({
    title: "Nearest 345 kV transmission line",
    value: fmt.dist(site.line345),
    label: "Estimated",
    source: "OpenStreetMap power=line, voltage 345 kV",
    url: "https://www.openstreetmap.org/copyright",
    retrieved: new Date(grid.retrieved_at).toLocaleString("en-US"),
    formula: "Shortest straight-line distance to any 345 kV line segment.",
    note: "Large loads usually connect at 138 kV or 345 kV; the utility decides where.",
  }));
  return {
    status: "info",
    text: [`${s.name || "Unnamed substation"}${s.kv ? ` (${s.kv} kV)` : ""} is `, subDist, " away. Nearest 345 kV line: ", lineDist, "."],
  };
}

const STATUS = {
  pass: [ICON.check, "Pass"], fail: [ICON.x, "Fail"], review: [ICON.alert, "Review"],
  pending: [ICON.spinner, "Checking"], info: [ICON.info, "Info"],
};

function gateRow({ status, name, text, label, note }) {
  const [icon, word] = STATUS[status];
  return h("li", { class: `gate ${status}` },
    h("span", { class: "g-icon", html: icon }),
    h("div", { class: "g-head" }, h("span", { class: "g-name" }, name), h("span", { class: "g-status" }, word)),
    h("p", { class: "g-detail" }, ...text),
    h("p", { class: "g-note" }, chip(label), " ", note));
}

function ensureSkeleton() {
  const panel = $("#screen-panel");
  if (panel.querySelector(".screen-results")) return;
  const out = h("output", { for: "buffer" }, fmt.dist(bufferKm));
  const range = h("input", { type: "range", id: "buffer", min: 250, max: 2000, step: 50, value: bufferKm * 1000 });
  const paint = () => range.style.setProperty("--p", `${((range.value - 250) / 1750) * 100}%`);
  paint();
  range.addEventListener("input", () => {
    bufferKm = range.value / 1000;
    out.textContent = fmt.dist(bufferKm);
    paint();
    if (site) renderPanel();
  });
  panel.replaceChildren(
    h("div", { class: "screen-results" }),
    h("div", { class: "threshold" },
      h("label", { for: "buffer" }, h("span", {}, "Homes buffer ", h("span", { class: "fine" }, "· team assumption")), out),
      range),
    h("div", { class: "gaps" }, h("p", {}, "Still needed before a decision"), h("ul", {})),
  );
}

function gapsFor(s) {
  return s.costar ? [...GAPS.slice(0, 3), "Lease or sale terms (CoStar has availability, not price)"] : GAPS;
}

function renderPanel() {
  ensureSkeleton();
  const flood = { name: "Flood zone", label: "Sourced", note: "FEMA flood map, live", ...floodGate(site.flood) };
  const homes = { name: "Homes nearby", label: "Estimated", note: "OpenStreetMap", ...homesGate() };
  const gridInfo = { name: "Grid access", label: "Estimated", note: "Distance isn't capacity. Needs a utility study.", ...gridRow() };
  if (site.flood.state === "ok" && site.flood.zone) {
    const z = h("span", {}, "FEMA flood map, live");
    auditable(z, floodAudit);
    flood.note = z;
  }

  const gates = [flood, homes];
  const fails = gates.filter((g) => g.status === "fail");
  let v;
  if (fails.length) {
    v = ["v-fail", ICON.x, "Fails screening",
      `Failed the ${fails.map((g) => g.name.toLowerCase()).join(" and ")} ${fails.length > 1 ? "gates" : "gate"}. A low price can't buy this back.`];
  } else if (gates.some((g) => g.status === "pending")) {
    v = ["v-pending", ICON.spinner, "Screening…", "Checking FEMA's flood map."];
  } else if (gates.some((g) => g.status === "review")) {
    v = ["v-review", ICON.alert, "Needs review", "Some checks couldn't be completed here."];
  } else {
    v = ["v-pass", ICON.check, "Passes the first screen", `No hard gate failed. ${gapsFor(site).length} checks still need data.`];
  }
  const [cls, icon, title, sub] = v;
  $("#screen-panel .gaps ul").replaceChildren(...gapsFor(site).map((g) => h("li", {}, g)));

  const { lat, lon } = site;
  const la = Math.abs(lat).toFixed(4);
  const lo = Math.abs(lon).toFixed(4);
  $("#screen-panel .screen-results").replaceChildren(...[
    h("div", { class: `verdict ${cls}` },
      h("span", { class: "v-icon", html: icon }),
      h("div", {}, h("h3", {}, title), h("p", {}, sub))),
    site.costar ? costarCard(site.costar) : null,
    h("p", { class: "coords" },
      `${la}° ${lat >= 0 ? "N" : "S"}, ${lo}° ${lon >= 0 ? "E" : "W"} · `,
      h("a", { href: `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lon.toFixed(5)}#map=16/${lat.toFixed(5)}/${lon.toFixed(5)}`, target: "_blank", rel: "noopener" }, "open map")),
    h("ul", { class: "gates" }, gateRow(flood), gateRow(homes), gateRow(gridInfo)),
  ].filter(Boolean));
}



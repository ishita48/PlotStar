// Power section: the building's service versus the first phase, and the 2025 pause budget,
// drawn as every hour of the year.

import { $, h, fmt, chip, hourShort, onResize } from "./util.js";
import { s as svgEl, showTip, hideTip, tipRows } from "./charts.js";
import { auditable } from "./audit.js";
import { store, on, emit, mva } from "./store.js";

const ORANGE = "#eb6834";
const HOUSTON = "#b4441a";

export function initPower() {
  const mw = $("#pw-mw"), flex = $("#pw-flex");
  mw.addEventListener("input", () => {
    store.pod = +mw.value;
    render();
    emit("pod");
  });
  flex.addEventListener("input", () => {
    store.flex = +flex.value / 100;
    render();
    emit("pod");
  });
  on((type) => {
    if (type === "select") {
      mw.value = store.pod;
      render();
    }
  });
  onResize($("#pb-heat"), drawHeat);
  drawHeat();
  renderTable();
  const pb = store.pauses;
  $("#pb-method").replaceChildren(
    `${pb.method.four_cp} ${pb.method.houston} ${pb.method.caveat} Source: `,
    h("a", { href: pb.source.page, target: "_blank", rel: "noopener" }, pb.source.dataset), ".",
  );
  render();
}

const fill = (el) => el.style.setProperty("--p", `${((el.value - el.min) / (el.max - el.min)) * 100}%`);

function render() {
  $("#pw-mw-out").textContent = `${store.pod} MW`;
  $("#pw-flex-out").textContent = fmt.pct(store.flex);
  fill($("#pw-mw"));
  fill($("#pw-flex"));
  renderGap();
  renderStats();
}

/* ---------------------------------------------------------------- the power gap */

function renderGap() {
  const s = store.selected;
  if (!s) return;
  const p = s.power, sc = s.screen;
  const have = (p.service_kva || 0) / 1000;
  const max = Math.max(store.pod, have, 0.1);
  const bar = (cls, v, label, value) =>
    h("div", { class: `gap-row ${cls}` },
      h("span", { class: "gap-label" }, label),
      h("span", { class: "gap-track" }, h("i", { style: { width: `${Math.max((v / max) * 100, v ? 1.5 : 0)}%` } })),
      h("span", { class: "gap-val" }, value));
  const haveVal = h("span", {}, p.service_kva ? `≈${mva(p.service_kva)}` : "Not recorded");
  auditable(haveVal, () => ({
    title: "Electrical service today", value: p.service_kva ? `≈${mva(p.service_kva)}` : "Not recorded",
    label: p.volts_assumed ? "Estimated" : "Sourced", source: "CoStar Data Extract: electric service (amps, volts, phases)",
    formula: "kVA = √3 × volts × amps ÷ 1000 for three-phase service",
    inputs: [["Amps", p.amps ? fmt.int(p.amps) : "—"], ["Volts", p.volts ? `${p.volts}` : "480 (assumed)"], ["Phases", p.phases || "3 (assumed)"]],
    note: p.volts_assumed ? "CoStar records no voltage for this building; 480 V three-phase is typical for heavy industrial service." : undefined,
  }));
  const gapMw = store.pod - have;
  $("#pw-gap").replaceChildren(
    h("p", { class: "kicker" }, `Power at ${s.name}`),
    bar("have", have, "Service today", haveVal),
    bar("need", store.pod, "First phase", `${store.pod} MW`),
    h("p", { class: "gap-sum" }, p.service_kva ? h("strong", {}, `${gapMw > 0 ? gapMw.toFixed(1) : 0} MW to get from the grid`) : h("strong", {}, "Service size not recorded: the utility check comes first"),
      h("span", {}, `345 kV line ${fmt.dist(sc.line345_km)} · substation ${fmt.dist(sc.substation?.km ?? 0)}${sc.substation?.kv ? ` (${sc.substation.kv} kV)` : ""}`)),
    h("p", { class: "fine" }, "Distance is not capacity. The pause commitment below is what a utility can count on while it builds."),
  );
}

/* ---------------------------------------------------------------- pause budget */

function renderStats() {
  const pb = store.pauses, sm = pb.summary;
  const flexMw = store.pod * store.flex;
  const saved = flexMw * 1000 * pb.tcrf.per_kw_year;
  const deferred = flexMw * sm.pause_hours;
  const stat = (value, label, sub, info, cls = "") => {
    const v = h("p", { class: `stat-value ${cls}` }, value);
    if (info) auditable(v, info);
    return h("div", { class: "pb-stat" }, h("p", { class: "stat-label" }, label), v, h("p", { class: "stat-sub" }, sub));
  };
  $("#pb-stats").replaceChildren(
    stat(`${sm.pause_hours} h`, `Pause hours in ${pb.year}`, `${fmt.pct(sm.share_of_year, 1)} of the year, on ${sm.pause_days} days`, () => ({
      title: `Hours the site would have paused in ${pb.year}`, value: `${sm.pause_hours} hours`, label: "Sourced",
      source: pb.source.dataset, url: pb.source.page, retrieved: `File read ${new Date(pb.generated_at).toLocaleDateString("en-US")}`,
      formula: `${pb.method.four_cp} ${pb.method.houston}`,
      inputs: [["Summer-peak alert hours", sm.four_cp_hours], ["Houston stress hours", sm.houston_hours], ["Hours in the file", pb.source.hours_in_file]],
      note: pb.method.caveat,
    })),
    stat(`${pb.peaks_caught} of 4`, "Summer peaks caught", pb.peaks.map((p) => new Date(`${p.date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })).join(" · "), () => ({
      title: "ERCOT's four summer peaks (4CP), 2025", value: `${pb.peaks_caught} of 4 inside the pause hours`, label: "Sourced",
      source: pb.source.dataset, url: pb.source.page,
      formula: "For each of June to September, the hour with ERCOT's highest system load. Transmission charges for the next year are set by a customer's load in these intervals.",
      inputs: pb.peaks.map((p) => [p.date, `${fmt.int(p.mw)} MW, ${hourShort(p.hour)}–${hourShort(p.hour + 1)}`]),
      note: "Hourly data; ERCOT's official 4CP intervals are 15 minutes inside these hours.",
    })),
    stat(`≈$${fmt.int(saved / 1000)}K`, "Transmission charge avoided", `per year, if ${fmt.pct(store.flex)} of ${store.pod} MW pauses`, () => ({
      title: "Transmission charge avoided by pausing at the summer peaks", value: `≈$${fmt.int(saved)} per year`, label: "Estimated",
      source: pb.tcrf.basis,
      formula: "avoided = MW that pause × 1000 × $ per kW-year (the monthly $ per 4CP kVA × 12)",
      inputs: [["MW that pause", flexMw.toFixed(1)], ["$ per 4CP kVA per month", `$${pb.tcrf.per_kva_month}`], ["$ per kW per year", `$${pb.tcrf.per_kw_year}`]],
      note: "Assumes the pausing load is fully off in all four peak intervals and a power factor of 1. Not a quote: check CenterPoint's current tariff.",
    }), "accent"),
    stat(`${fmt.int(deferred)} MWh`, "Work moved, not lost", `${fmt.pct(deferred / (store.pod * 8760 || 1), 2)} of the year's energy, caught up after each peak`),
  );
}

function heatColor(load, lo, hi) {
  // one-hue ramp, light to dark (sequential): wash -> ink-2
  const t = Math.max(0, Math.min(1, (load - lo) / (hi - lo)));
  const a = [240, 239, 236], b = [82, 81, 78];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t ** 1.4)).join(",")})`;
}

function drawHeat() {
  const el = $("#pb-heat");
  const cal = store.pauses.calendar;
  const width = Math.max(el.parentElement.clientWidth, 720);
  const m = { top: 30, right: 6, bottom: 20, left: 34 };
  const cw = (width - m.left - m.right) / cal.length;
  const ch = 6;
  const height = m.top + 24 * ch + m.bottom;
  el.replaceChildren();
  const svg = svgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}`, "shape-rendering": "crispEdges" }, el);
  const loads = cal.flatMap((d) => d.load.filter((v) => v != null));
  const lo = Math.min(...loads), hi = Math.max(...loads);
  const g = svgEl("g", {}, svg);
  cal.forEach((d, di) => {
    const x = m.left + di * cw;
    d.load.forEach((v, hr) => {
      const flag = d.pause[hr];
      svgEl("rect", { x: x.toFixed(2), y: m.top + hr * ch, width: Math.max(cw, 1).toFixed(2), height: ch, fill: flag ? (flag === 2 ? HOUSTON : ORANGE) : v == null ? "#fff" : heatColor(v, lo, hi) }, g);
    });
  });
  // month labels
  cal.forEach((d, di) => {
    if (d.date.endsWith("-01")) {
      const x = m.left + di * cw;
      svgEl("line", { x1: x, x2: x, y1: m.top + 24 * ch, y2: m.top + 24 * ch + 5, stroke: "#c3c2b7" }, svg);
      svgEl("text", { x: x + 2, y: height - 4, text: new Date(`${d.date}T12:00:00`).toLocaleDateString("en-US", { month: "short" }) }, svg);
    }
  });
  for (const hr of [0, 6, 12, 18]) svgEl("text", { x: m.left - 6, y: m.top + hr * ch + ch, "text-anchor": "end", text: hourShort(hr) }, svg);
  // the four summer peaks, labeled above the grid
  for (const p of store.pauses.peaks) {
    const di = cal.findIndex((d) => d.date === p.date);
    const x = m.left + (di + 0.5) * cw;
    svgEl("path", { d: `M${x - 4},${m.top - 9} L${x + 4},${m.top - 9} L${x},${m.top - 3} Z`, fill: "#0b0b0b" }, svg);
  }
  const top = store.pauses.replay_day;
  const ti = cal.findIndex((d) => d.date === top.date);
  if (ti >= 0) svgEl("text", { class: "halo", x: m.left + (ti + 0.5) * cw, y: m.top - 13, "text-anchor": "middle", text: `Year's peak, ${new Date(`${top.date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` }, svg);

  // hover: which hour is under the pointer
  const hit = svgEl("rect", { x: m.left, y: m.top, width: cw * cal.length, height: 24 * ch, fill: "transparent" }, svg);
  const mark = svgEl("rect", { width: Math.max(cw, 2) + 2, height: ch + 2, fill: "none", stroke: "#0b0b0b", "stroke-width": 1.5, visibility: "hidden" }, svg);
  const move = (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const py = ((e.clientY - box.top) / box.height) * height;
    const di = Math.max(0, Math.min(cal.length - 1, Math.floor((px - m.left) / cw)));
    const hr = Math.max(0, Math.min(23, Math.floor((py - m.top) / ch)));
    const d = cal[di];
    mark.setAttribute("x", m.left + di * cw - 1);
    mark.setAttribute("y", m.top + hr * ch - 1);
    mark.setAttribute("visibility", "visible");
    const flag = d.pause[hr];
    const why = { 1: "Pause: could set the month's peak", 2: "Pause: Houston's tightest hours", 3: "Pause: summer peak and Houston stress" }[flag] || "Runs normally";
    showTip(tipRows(`${new Date(`${d.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}, ${hourShort(hr)}–${hourShort(hr + 1)}`, [
      { k: "Texas grid load", v: d.load[hr] != null ? `${fmt.int(d.load[hr])} MW` : "—" },
      { k: why, v: "", color: flag ? (flag === 2 ? HOUSTON : ORANGE) : undefined },
    ]), e.clientX, e.clientY);
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", () => {
    mark.setAttribute("visibility", "hidden");
    hideTip();
  });

  $("#pb-legend").replaceChildren(
    h("span", { class: "item" }, h("span", { class: "sw sw-ramp" }), `Texas grid load, ${fmt.int(lo / 1000)}–${fmt.int(hi / 1000)} GW`),
    h("span", { class: "item" }, h("span", { class: "sw", style: { background: ORANGE } }), "Pause: a day that could set the month's peak"),
    h("span", { class: "item" }, h("span", { class: "sw", style: { background: HOUSTON } }), "Pause: Houston's tightest hours"),
    h("span", { class: "item" }, h("span", { class: "sw-tri" }), "The four summer peaks"),
  );
}

function renderTable() {
  const pb = store.pauses;
  const peakDates = new Set(pb.peaks.map((p) => p.date));
  $("#pb-table").replaceChildren(h("div", { class: "table-scroll" }, h("table", { class: "data-table" },
    h("thead", {}, h("tr", {}, ...["Day", "Daily peak", "Peak hour", "Share of the month's peak", ""].map((t) => h("th", {}, t)))),
    h("tbody", {}, pb.alert_days.map((d) => h("tr", {},
      h("td", {}, new Date(`${d.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })),
      h("td", {}, `${fmt.int(d.mw)} MW`),
      h("td", {}, `${hourShort(d.peak_hour)}–${hourShort(d.peak_hour + 1)}`),
      h("td", {}, fmt.pct(d.share_of_month_peak, 1)),
      h("td", {}, peakDates.has(d.date) ? chip("Sourced") : ""))))),
  ), h("p", { class: "fine" }, `Plus ${pb.summary.houston_hours} hours when Houston's own load (COAST zone) came within 2% of its ${pb.year} peak of ${fmt.int(pb.coast_peak.mw)} MW. Rows marked are the month's actual peak.`));
}

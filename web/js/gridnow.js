// Hero: the Texas grid right now, from ERCOT (live through the bridge, or the snapshot).

import { $, h, fmt, clock, dayLabel, hourShort, ICON, onResize } from "./util.js";
import { s, lin, niceDomain, frame, yGrid, hoverLayer, showTip, tipRows, hatchDefs } from "./charts.js";
import { auditable } from "./audit.js";

export const FUEL_COLOR = {
  Coal: "#e34948", Nuclear: "#6250d6", Gas: "#eb6834", Wind: "#2a78d6",
  Batteries: "#1baf7a", Solar: "#eda100", Other: "#e87ba4",
};
export const FUEL_NAME = {
  Coal: "Coal", Nuclear: "Nuclear", Gas: "Natural gas", Wind: "Wind",
  Batteries: "Batteries", Solar: "Solar", Other: "Hydro & other",
};

let st = null; // { data, live, base }

export function initGridNow(ercot, base) {
  st = { ...ercot, base };
  render();
  onResize($("#gn-chart"), drawChart);
  if (base !== null && ercot.live) setInterval(refresh, 5 * 60 * 1000);
}

async function refresh() {
  try {
    const res = await fetch(`${st.base}/api/ercot`, { cache: "no-store" });
    if (!res.ok) return;
    st.data = await res.json();
    st.live = true;
    render();
  } catch {
    /* keep showing the last data */
  }
}

const retrievedText = () =>
  new Date(st.data.retrieved_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const rtUrl = (date) => st.data.sources.rt_price.replace("YYYYMMDD", date.replaceAll("-", ""));

function render() {
  const d = st.data;
  const n = d.now;

  $("#gn-updated").textContent = `${st.live ? "Live" : "Snapshot"} · ${dayLabel(n.fuel_date)}, ${clock(n.fuel_minute)} CT`;
  const pill = $("#pill-ercot");
  pill.querySelector(".dot").className = `dot ${st.live ? "on" : ""}`;
  pill.querySelector("span").textContent = st.live ? "ERCOT live" : "ERCOT snapshot";
  pill.title = st.live ? "Live ERCOT data, refreshed every 5 minutes" : `Saved ERCOT data from ${retrievedText()}`;
  $("#src-ercot").innerHTML = `<i class="dot ${st.live ? "on" : ""}"></i>${st.live ? "Live, every 5 minutes" : `Snapshot, ${retrievedText()}`}`;

  stat("#gn-demand", h("span", {}, fmt.gw(n.demand_mw), h("small", {}, "GW")), () => ({
    title: "Texas electricity demand",
    value: `${fmt.int(n.demand_mw)} MW`,
    label: "Sourced",
    source: "ERCOT supply and demand dashboard",
    url: d.sources.demand,
    retrieved: `${retrievedText()} · 5-minute reading for ${clock(n.demand_minute)} CT`,
    formula: "Latest actual 5-minute ERCOT system demand.",
    note: "Covers the whole ERCOT region, not only Houston.",
  }));

  stat("#gn-price", h("span", {}, fmt.price(n.price), h("small", {}, "/MWh")), () => ({
    title: "Houston real-time power price",
    value: `${fmt.price(n.price)} per MWh`,
    label: "Sourced",
    source: "ERCOT real-time settlement point prices (LZ_HOUSTON)",
    url: rtUrl(n.price_date),
    retrieved: retrievedText(),
    formula: `15-minute real-time settlement point price for the Houston load zone, interval ending ${clock(n.price_minute_ending)} CT on ${dayLabel(n.price_date)}.`,
    note: "A wholesale price, not what a customer pays under contract.",
  }));

  stat("#gn-renew", h("span", {}, fmt.pct(n.renewable_share)), () => ({
    title: "Wind and solar share of generation",
    value: fmt.pct(n.renewable_share, 1),
    label: "Sourced",
    source: "ERCOT fuel mix dashboard",
    url: d.sources.fuel_mix,
    retrieved: `${retrievedText()} · 5-minute interval starting ${clock(n.fuel_minute)} CT`,
    formula: "(Wind + Solar) ÷ total generation, including battery discharge",
    inputs: [
      ["Wind", `${fmt.int(n.mix.Wind)} MW`],
      ["Solar", `${fmt.int(n.mix.Solar)} MW`],
      ["Total generation", `${fmt.int(n.total_mw)} MW`],
    ],
  }));

  const charging = n.charging_mw > n.mix.Batteries;
  $("#gn-batt-label").textContent = charging ? "Batteries charging" : "Batteries supplying";
  const battMw = charging ? n.charging_mw : n.mix.Batteries;
  stat("#gn-batt", h("span", {}, fmt.gw(battMw), h("small", {}, "GW")), () => ({
    title: charging ? "Batteries charging" : "Batteries supplying the grid",
    value: `${fmt.int(battMw)} MW`,
    label: "Sourced",
    source: "ERCOT fuel mix dashboard (Power Storage)",
    url: d.sources.fuel_mix,
    retrieved: `${retrievedText()} · ${clock(n.fuel_minute)} CT`,
    formula: charging ? "Power Storage Charging, latest 5-minute interval" : "Power Storage Discharging, latest 5-minute interval",
    note: "Texas batteries typically charge on cheap midday solar and discharge into the evening peak.",
  }));

  renderSignal(n);
  renderLegend(n);
  renderTable();
  drawChart();
}

function stat(sel, content, info) {
  const el = $(sel);
  el.replaceChildren(content);
  auditable(el, info);
}

function renderSignal(n) {
  const c = n.price_cheaper_than_share;
  const box = $("#gn-signal");
  let cls, icon, title, why;
  const pctEl = h("span", {}, fmt.pct(c >= 0.5 ? c : 1 - c));
  if (c >= 0.5) {
    [cls, icon, title] = ["sig-run", ICON.bolt, "Good time to run flexible work"];
    why = h("p", { class: "sig-why" }, "Houston power is cheaper than ", pctEl, " of the last 24 hours.");
  } else if (c <= 0.2) {
    [cls, icon, title] = ["sig-ease", ICON.pause, "Ease off flexible work"];
    why = h("p", { class: "sig-why" }, "Houston power is pricier than ", pctEl, " of the last 24 hours.");
  } else {
    [cls, icon, title] = ["sig-normal", ICON.minus, "Normal operation"];
    why = h("p", { class: "sig-why" }, "Houston power is mid-range: cheaper than ", pctEl, " of the last 24 hours.");
  }
  box.className = `signal ${cls}`;
  box.replaceChildren(h("span", { class: "sig-icon", html: icon }), h("p", { class: "sig-title" }, title), why);
  auditable(pctEl, () => ({
    title: "SiteStar's run / ease-off signal",
    value: `Cheaper than ${fmt.pct(c)} of recent prices`,
    label: "Estimated",
    source: "ERCOT real-time prices, LZ_HOUSTON, last 24 hours",
    url: rtUrl(n.price_date),
    retrieved: retrievedText(),
    formula: `share = count(last ${n.price_window_intervals} fifteen-minute prices > latest price) ÷ ${n.price_window_intervals}\nshare ≥ 50%  → run flexible work\nshare ≤ 20%  → ease off\notherwise    → normal`,
    inputs: [["Latest price", `${fmt.price(n.price)}/MWh`], ["Share", fmt.pct(c, 1)]],
    note: "A simple, transparent rule for the live view. The optimizer below plans a whole day.",
  }));
}

function renderLegend(n) {
  const fuels = [...st.data.fuels].reverse();
  $("#gn-legend").replaceChildren(
    ...fuels.map((f) =>
      h("span", { class: "item" },
        h("span", { class: "sw", style: { background: FUEL_COLOR[f] } }),
        FUEL_NAME[f], " ", h("span", { class: "val" }, `${fmt.gw(n.mix[f])} GW`)),
    ),
  );
}

function renderTable() {
  const fuels = st.data.fuels;
  const rows = [];
  for (const day of st.data.days) {
    if (!day.hourly_fuel) continue;
    for (let hr = 0; hr < 24; hr++) {
      const vals = fuels.map((f) => day.hourly_fuel[f][hr]);
      if (vals.some((v) => v == null)) continue;
      const total = vals.reduce((a, b) => a + b, 0);
      rows.push(h("tr", {}, h("td", {}, `${dayLabel(day.date)} ${clock(hr * 60)}`), ...vals.map((v) => h("td", {}, fmt.gw(v))), h("td", {}, fmt.gw(total))));
    }
  }
  $("#gn-table").replaceChildren(
    h("div", { class: "table-scroll", style: { maxHeight: "320px" } },
      h("table", { class: "data-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Hour (CT)"), ...fuels.map((f) => h("th", {}, FUEL_NAME[f])), h("th", {}, "Total"))),
        h("tbody", {}, rows))),
    h("p", { class: "fine", style: { marginTop: "6px" } }, "Hourly averages of ERCOT's 5-minute fuel mix, in GW."),
  );
}

function drawChart() {
  const el = $("#gn-chart");
  const fuels = st.data.fuels;
  const days = st.data.days.filter((d) => d.fuel?.minutes?.length).slice(0, 2);
  if (!days.length) return;
  const narrow = el.clientWidth < 560;
  const f = frame(el, narrow ? 220 : 270, { top: 26, right: 12, bottom: 26, left: 48 });
  const span = 1440 * days.length;

  const pts = [];
  days.forEach((day, di) => {
    day.fuel.minutes.forEach((m, i) => {
      const vals = fuels.map((fu) => day.fuel[fu][i]);
      pts.push({ t: di * 1440 + m, day: day.date, minute: m, vals, total: vals.reduce((a, b) => a + b, 0) });
    });
  });
  const dom = niceDomain(0, Math.max(...pts.map((p) => p.total)), narrow ? 3 : 4);
  const x = lin(0, span, f.x0, f.x1);
  const y = lin(0, dom.hi, f.y1, f.y0);

  hatchDefs(f.svg, "gn-hatch", "#e1e0d9");
  yGrid(f.svg, f, dom.ticks, y, (v) => (v === 0 ? "0" : `${v / 1000} GW`));

  // stacked areas, bottom to top
  const cum = pts.map(() => 0);
  fuels.forEach((fu, k) => {
    const lower = cum.slice();
    pts.forEach((p, i) => (cum[i] += p.vals[k]));
    let d = "";
    pts.forEach((p, i) => (d += `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(cum[i]).toFixed(1)}`));
    for (let i = pts.length - 1; i >= 0; i--) d += `L${x(pts[i].t).toFixed(1)},${y(lower[i]).toFixed(1)}`;
    s("path", { d: `${d}Z`, fill: FUEL_COLOR[fu], "fill-opacity": 0.92, stroke: "#ffffff", "stroke-width": 1, "stroke-linejoin": "round" }, f.svg);
  });

  // the rest of today
  const lastT = pts[pts.length - 1].t;
  if (span - lastT > 15) {
    s("rect", { x: x(lastT), y: f.y0, width: f.x1 - x(lastT), height: f.y1 - f.y0, fill: "url(#gn-hatch)" }, f.svg);
    if (f.x1 - x(lastT) > 90) {
      s("text", { class: "halo", x: (x(lastT) + f.x1) / 2, y: (f.y0 + f.y1) / 2, "text-anchor": "middle", text: "later today" }, f.svg);
    }
  }

  // axis, day labels, now marker
  s("line", { class: "baseline", x1: f.x0, x2: f.x1, y1: Math.round(y(0)) + 0.5, y2: Math.round(y(0)) + 0.5 }, f.svg);
  for (let t = 0; t <= span; t += narrow ? 720 : 360) {
    s("text", { x: x(t), y: f.height - 6, "text-anchor": t === 0 ? "start" : t === span ? "end" : "middle", text: hourShort((t % 1440) / 60) }, f.svg);
  }
  const nowX = x(lastT);
  days.forEach((day, di) => {
    const dx = x(di * 1440);
    if (di > 0) s("line", { class: "baseline", x1: Math.round(dx) + 0.5, x2: Math.round(dx) + 0.5, y1: f.y0 - 18, y2: f.y1 }, f.svg);
    const isToday = di === days.length - 1 && day.kind === "today";
    const nearNow = isToday && nowX - dx < 70;
    s("text", { class: "day-label", x: dx + (di ? 6 : 0), y: f.y0 - 9, text: `${dayLabel(day.date)}${isToday ? (nearNow ? " · now" : " · today") : ""}` }, f.svg);
  });
  s("line", { class: "now-line", x1: nowX, x2: nowX, y1: f.y0, y2: f.y1 }, f.svg);
  s("circle", { cx: nowX, cy: y(pts[pts.length - 1].total), r: 4, fill: "#0b0b0b", stroke: "#ffffff", "stroke-width": 2 }, f.svg);

  hoverLayer(f, pts.map((p) => x(p.t)), (i, e) => {
    const p = pts[i];
    const rows = fuels
      .map((fu, k) => ({ color: FUEL_COLOR[fu], k: FUEL_NAME[fu], v: `${fmt.gw(p.vals[k])} GW · ${fmt.pct(p.vals[k] / p.total)}` }))
      .reverse();
    showTip(tipRows(`${dayLabel(p.day)}, ${clock(p.minute)} CT`, [...rows, "sep", { k: "Total generation", v: `${fmt.gw(p.total)} GW` }]), e.clientX, e.clientY);
  });
}

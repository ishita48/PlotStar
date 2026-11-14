// "Connect now, not later": the hourly-schedule step of SiteStar's optimizer,
// run on a real ERCOT day.
//
// It's a small linear program, solved exactly by filling the best hours first:
//   minimize   sum_h  c_h * x_h        c = price (lowest cost) or fossil share (cleanest)
//   subject to sum_h  x_h = E          E = flexible work for the day, MWh
//              0 <= x_h <= cap_h - M   cap = grid limit in tight hours, else facility size
// where M is the must-run load and x_h the flexible load in hour h.

import { $, $$, h, fmt, hourShort, hourRange, dayLabel, ICON, onResize } from "./util.js";
import { s, lin, niceDomain, frame, yGrid, hoverLayer, showTip, tipRows, columnPath } from "./charts.js";
import { auditable } from "./audit.js";

const CAPACITY = 100; // MW
const AVERAGE = 80; // MW
const COLORS = { price: "#2a78d6", must: "#d6d5cf", wait: "#0b0b0b", flat: "#898781", limit: "#d03b3b" };

let ercot = null;
let days = [];
let dayIdx = 0;
let goal = "cost";
let plan = null;

export function initFlex(store) {
  ercot = store.data;
  days = ercot.days.filter((d) => d.complete && d.hourly_price?.length === 24 && d.hourly_price.every((v) => v != null));
  if (!days.length) {
    $("#fx-feasible").textContent = "No complete day of ERCOT prices is available right now.";
    return;
  }
  dayIdx = Math.max(0, days.findIndex((d) => d.kind === "actual"));
  renderDays();
  for (const id of ["fx-flex", "fx-limit", "fx-tight"]) $(`#${id}`).addEventListener("input", update);
  $$("#fx-goal button").forEach((b) =>
    b.addEventListener("click", () => {
      goal = b.dataset.goal;
      update();
    }),
  );
  onResize($("#fx-price"), drawCharts);
  update();
}

const hasFossil = (day) => day.hourly_fossil_share?.length === 24 && day.hourly_fossil_share.every((v) => v != null);
const kindText = (day) => (day.price_kind === "real-time" ? "actual prices" : "day-ahead prices");

function renderDays() {
  $("#fx-days").replaceChildren(
    ...days.map((day, i) =>
      h("button", {
        type: "button", "aria-pressed": String(i === dayIdx),
        onclick: () => {
          dayIdx = i;
          renderDays();
          update();
        },
      }, dayLabel(day.date), h("small", {}, kindText(day))),
    ),
  );
}

function inputs() {
  return { flex: +$("#fx-flex").value / 100, limit: +$("#fx-limit").value, tightN: +$("#fx-tight").value };
}

function paintSlider(id, text) {
  const el = $(`#${id}`);
  el.style.setProperty("--p", `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
  $(`#${id}-out`).textContent = text;
}

function update() {
  const p = inputs();
  paintSlider("fx-flex", `${Math.round(p.flex * 100)}%`);
  paintSlider("fx-limit", `${p.limit} MW`);
  paintSlider("fx-tight", `${p.tightN} h`);

  const day = days[dayIdx];
  const fossil = hasFossil(day) ? day.hourly_fossil_share : null;
  if (!fossil && goal === "clean") goal = "cost";
  $$("#fx-goal button").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.goal === goal));
    const off = b.dataset.goal === "clean" && !fossil;
    b.disabled = off;
    b.title = off ? "Needs the hour-by-hour fuel mix, which only exists for past hours" : "";
  });

  plan = solve(day, fossil, { ...p, goal });
  renderFeasible();
  renderResults();
  renderTable();
  drawCharts();
}

export function solve(day, fossil, { flex, limit, tightN, goal: g }) {
  const prices = day.hourly_price;
  const H = 24;
  const tight = new Set([...Array(H).keys()].sort((a, b) => prices[b] - prices[a]).slice(0, tightN));
  const must = AVERAGE * (1 - flex);
  const work = AVERAGE * flex * H;
  const room = Array.from({ length: H }, (_, hr) => Math.max((tight.has(hr) ? limit : CAPACITY) - must, 0));
  const flat = Array(H).fill(AVERAGE);
  const base = { day, prices, fossil, tight, must, work, flat, limit, tightN, flex, goal: g };

  if (tightN > 0 && must > limit) return { ...base, ok: false, why: "must" };
  if (room.reduce((a, b) => a + b, 0) + 1e-9 < work) return { ...base, ok: false, why: "room" };

  const score = g === "clean" ? (hr) => fossil[hr] : (hr) => prices[hr];
  const order = [...Array(H).keys()].sort((a, b) => score(a) - score(b) || prices[a] - prices[b]);
  const x = Array(H).fill(0);
  let left = work;
  for (const hr of order) {
    const take = Math.min(room[hr], left);
    x[hr] = take;
    left -= take;
    if (left <= 1e-9) break;
  }
  const load = x.map((v) => must + v);
  const cost = (L) => L.reduce((a, mw, hr) => a + mw * prices[hr], 0);
  const fossilShare = (L) => L.reduce((a, mw, hr) => a + mw * fossil[hr], 0) / L.reduce((a, b) => a + b, 0);
  const peak = (L) => Math.max(...(tightN ? [...tight].map((hr) => L[hr]) : L));
  return {
    ...base, ok: true, x, load,
    cost: cost(load), costFlat: cost(flat),
    fossilOpt: fossil ? fossilShare(load) : null, fossilFlat: fossil ? fossilShare(flat) : null,
    peak: peak(load), peakFlat: peak(flat),
    moved: load.reduce((a, mw) => a + Math.max(AVERAGE - mw, 0), 0),
  };
}

/* ---------------------------------------------------------------- text */

function renderFeasible() {
  const p = plan;
  const box = $("#fx-feasible");
  let ok, title, sub;
  if (!p.ok && p.why === "must") {
    [ok, title, sub] = [false, "Can't connect under this limit",
      `Work that must always run needs ${Math.round(p.must)} MW, more than the ${p.limit} MW the grid can promise in tight hours. Let more work wait, or find more capacity.`];
  } else if (!p.ok) {
    [ok, title, sub] = [false, "Can't finish the work by midnight",
      "There isn't enough room under the limit to fit the deferred work. Raise the limit or use fewer tight hours."];
  } else if (p.tightN === 0) {
    [ok, title, sub] = [true, "No grid limit today", "With no tight hours, SiteStar just moves flexible work into cheaper hours."];
  } else if (AVERAGE > p.limit) {
    [ok, title, sub] = [true, `Connects under a ${p.limit} MW limit`,
      `The flat schedule needs ${AVERAGE} MW during tight hours, so it would wait for grid upgrades. SiteStar's schedule stays under the limit and still finishes every job.`];
  } else {
    [ok, title, sub] = [true, `Both schedules fit under ${p.limit} MW`, "SiteStar still cuts cost by running flexible work in cheaper hours."];
  }
  box.className = `feasible ${ok ? "ok" : "no"}`;
  box.replaceChildren(h("span", { class: "v-icon", html: ok ? ICON.check : ICON.x }), h("div", {}, h("strong", {}, title), h("span", {}, sub)));
}

function tile(label, value, sub, info) {
  const v = h("p", { class: "r-value" }, value);
  if (info) auditable(v, info);
  return h("div", { class: "result" }, h("p", { class: "r-label" }, label), v, h("p", { class: "r-sub" }, ...[].concat(sub)));
}

function priceSource() {
  const day = plan.day;
  const url = (day.price_kind === "real-time" ? ercot.sources.rt_price : ercot.sources.dam_price).replace("YYYYMMDD", day.date.replaceAll("-", ""));
  return {
    title: `Houston power prices, ${dayLabel(day.date)}`,
    value: `${fmt.price(Math.min(...day.hourly_price))} – ${fmt.price(Math.max(...day.hourly_price))} per MWh`,
    label: "Sourced",
    source: day.price_kind === "real-time" ? "ERCOT real-time settlement point prices, LZ_HOUSTON" : "ERCOT day-ahead settlement point prices, LZ_HOUSTON",
    url,
    retrieved: new Date(ercot.retrieved_at).toLocaleString("en-US"),
    formula: day.price_kind === "real-time" ? "Hourly price = average of the four 15-minute real-time prices in that hour." : "Hourly day-ahead market prices as published by ERCOT.",
    note: "Wholesale prices, not a contracted rate.",
  };
}

function renderResults() {
  const p = plan;
  const box = $("#fx-results");
  if (!p.ok) {
    box.replaceChildren(
      tile("Power cost this day", "—", "No feasible schedule"),
      tile("Load in tight hours", "—", `Limit ${p.limit} MW`),
      tile("Fossil share of power", "—", ""),
      tile("Work moved", "—", ""),
    );
    return;
  }
  const save = (p.cost - p.costFlat) / Math.abs(p.costFlat);
  const costInfo = () => ({
    title: "Power cost for the day",
    value: `${fmt.money(p.cost)} vs ${fmt.money(p.costFlat)} flat`,
    label: "Estimated",
    source: priceSource().source,
    url: priceSource().url,
    retrieved: new Date(ercot.retrieved_at).toLocaleString("en-US"),
    formula: "cost = Σ over 24 hours of load (MW × 1 h) × price ($/MWh)",
    inputs: [
      ["Flat schedule", fmt.money(p.costFlat)],
      ["SiteStar schedule", fmt.money(p.cost)],
      ["Difference", `${fmt.money(p.cost - p.costFlat)} (${fmt.signedPct(save, 1)})`],
      ["Facility", `${CAPACITY} MW, averaging ${AVERAGE} MW`],
    ],
    note: "Energy cost only, at wholesale prices. Both schedules do the same total work.",
  });
  const fossilTile = p.fossilOpt == null
    ? tile("Fossil share of power", "—", "Needs past-hour fuel mix")
    : tile("Fossil share of power", fmt.pct(p.fossilOpt), [`vs ${fmt.pct(p.fossilFlat)} flat`], () => ({
      title: "Fossil share of the power used",
      value: `${fmt.pct(p.fossilOpt, 1)} vs ${fmt.pct(p.fossilFlat, 1)} flat`,
      label: "Estimated",
      source: "ERCOT fuel mix dashboard, hourly averages",
      url: ercot.sources.fuel_mix,
      retrieved: new Date(ercot.retrieved_at).toLocaleString("en-US"),
      formula: "share = Σ load_h × fossil_h ÷ Σ load_h\nfossil_h = (gas + coal) ÷ total ERCOT generation in hour h",
      note: "Uses the grid-average mix, not marginal emissions. A proxy for carbon, not a measurement.",
    }));
  box.replaceChildren(
    tile("Power cost this day", fmt.money(p.cost), [`vs ${fmt.money(p.costFlat)} flat · `, h("b", {}, fmt.signedPct(save, 1))], costInfo),
    tile(p.tightN ? "Load in tight hours" : "Peak load", `${Math.round(p.peak)} MW`, `vs ${p.peakFlat} MW flat`, () => ({
      title: p.tightN ? "Highest load during tight hours" : "Peak load",
      value: `${Math.round(p.peak)} MW vs ${p.peakFlat} MW flat`,
      label: "Simulated",
      source: "SiteStar schedule for a modeled 100 MW facility",
      formula: "max of hourly load over the tight hours",
      inputs: [["Grid limit (scenario)", `${p.limit} MW`], ["Tight hours", p.tightN ? [...p.tight].sort((a, b) => a - b).map(hourShort).join(", ") : "none"]],
      note: "A scenario, not a utility interconnection study.",
    })),
    fossilTile,
    tile("Work moved", `${fmt.int(p.moved)} MWh`, "All finished by midnight", () => ({
      title: "Flexible work moved to other hours",
      value: `${fmt.int(p.moved)} MWh of ${fmt.int(p.work)} MWh flexible`,
      label: "Simulated",
      source: "SiteStar schedule for a modeled 100 MW facility",
      formula: "moved = Σ max(80 MW − SiteStar load_h, 0) × 1 h",
      note: "Total energy is unchanged; only its timing moves.",
    })),
  );
}

function renderTable() {
  const p = plan;
  const day = p.day;
  const rows = day.hourly_price.map((price, hr) =>
    h("tr", {},
      h("td", {}, hourRange(hr)),
      h("td", {}, fmt.price(price)),
      h("td", {}, p.tight.has(hr) ? "yes" : ""),
      h("td", {}, p.fossil ? fmt.pct(p.fossil[hr]) : "—"),
      h("td", {}, AVERAGE),
      h("td", {}, p.ok ? p.load[hr].toFixed(1) : "—")),
  );
  $("#fx-table").replaceChildren(
    h("div", { class: "table-scroll", style: { maxHeight: "320px" } },
      h("table", { class: "data-table" },
        h("thead", {}, h("tr", {}, ...["Hour (CT)", "Price $/MWh", "Tight hour", "Fossil share", "Flat MW", "SiteStar MW"].map((t) => h("th", {}, t)))),
        h("tbody", {}, rows))),
  );
}

/* ---------------------------------------------------------------- charts */

function drawCharts() {
  if (!plan) return;
  drawPrice();
  drawLoad();
  auditable($("#fx-price-chip"), priceSource);
}

const MARGIN = { top: 22, right: 16, bottom: 24, left: 50 };

function bands(f) {
  const bw = (f.x1 - f.x0) / 24;
  return { bw, cx: (hr) => f.x0 + (hr + 0.5) * bw, left: (hr) => f.x0 + hr * bw };
}

function tightBands(f, b, label) {
  const hours = [...plan.tight].sort((a, b2) => a - b2);
  hours.forEach((hr) => s("rect", { class: "band", x: b.left(hr), y: f.y0, width: b.bw, height: f.y1 - f.y0 }, f.svg));
  if (label && hours.length) {
    const first = hours[0];
    const nearRight = b.left(first) > f.x1 - 90;
    s("text", { class: "band-label halo", x: nearRight ? b.left(hours[hours.length - 1]) + b.bw - 4 : b.left(first) + 4, y: f.y1 - 6, "text-anchor": nearRight ? "end" : "start", text: "Tight hours" }, f.svg);
  }
}

function xLabels(f, b) {
  for (let hr = 0; hr < 24; hr += 3) s("text", { x: b.cx(hr), y: f.height - 6, "text-anchor": "middle", text: hourShort(hr) }, f.svg);
}

function drawPrice() {
  const el = $("#fx-price");
  const prices = plan.prices;
  const f = frame(el, 170, MARGIN);
  const b = bands(f);
  const dom = niceDomain(Math.min(0, ...prices), Math.max(...prices), 3);
  const y = lin(dom.lo, dom.hi, f.y1, f.y0);
  tightBands(f, b, true);
  yGrid(f.svg, f, dom.ticks, y, (v) => `$${v}`);
  s("line", { class: "baseline", x1: f.x0, x2: f.x1, y1: Math.round(y(Math.max(dom.lo, 0))) + 0.5, y2: Math.round(y(Math.max(dom.lo, 0))) + 0.5 }, f.svg);
  const d = prices.map((v, hr) => `${hr ? "L" : "M"}${b.cx(hr).toFixed(1)},${y(v).toFixed(1)}`).join("");
  s("path", { d, fill: "none", stroke: COLORS.price, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, f.svg);
  const hi = prices.indexOf(Math.max(...prices));
  const lo = prices.indexOf(Math.min(...prices));
  for (const [hr, above] of [[hi, true], [lo, false]]) {
    s("circle", { cx: b.cx(hr), cy: y(prices[hr]), r: 4, fill: COLORS.price, stroke: "#ffffff", "stroke-width": 2 }, f.svg);
    s("text", { class: "halo", x: b.cx(hr), y: y(prices[hr]) + (above ? -9 : 17), "text-anchor": "middle", style: { fill: "#0b0b0b", fontWeight: 600 }, text: fmt.price(prices[hr]) }, f.svg);
  }
  xLabels(f, b);
  hoverLayer(f, prices.map((_, hr) => b.cx(hr)), (hr, e) => showTip(tipFor(hr), e.clientX, e.clientY));
}

function drawLoad() {
  const el = $("#fx-load");
  const p = plan;
  const f = frame(el, 230, MARGIN);
  const b = bands(f);
  const y = lin(0, CAPACITY, f.y1, f.y0);
  const narrow = f.width < 520;
  tightBands(f, b, false);
  yGrid(f.svg, f, [0, 25, 50, 75, 100], y, (v) => `${v} MW`);

  if (p.ok) {
    const w = Math.min(24, b.bw * 0.64);
    p.load.forEach((total, hr) => {
      const x = b.cx(hr) - w / 2;
      const flexPart = total - p.must;
      const mustTop = y(p.must);
      if (flexPart > 0.05) {
        s("path", { d: columnPath(x, w, mustTop, y(0), 0), fill: COLORS.must }, f.svg);
        s("path", { d: columnPath(x, w, y(total), mustTop - 2, 4), fill: COLORS.wait }, f.svg);
      } else {
        s("path", { d: columnPath(x, w, mustTop, y(0), 4), fill: COLORS.must }, f.svg);
      }
    });
  } else {
    s("text", { x: (f.x0 + f.x1) / 2, y: y(45), "text-anchor": "middle", style: { fill: "#52514e", fontSize: "13px" }, text: "No feasible schedule under these settings" }, f.svg);
  }

  s("line", { class: "baseline", x1: f.x0, x2: f.x1, y1: Math.round(y(0)) + 0.5, y2: Math.round(y(0)) + 0.5 }, f.svg);
  // flat schedule
  s("line", { x1: f.x0, x2: f.x1, y1: y(AVERAGE), y2: y(AVERAGE), stroke: COLORS.flat, "stroke-width": 2 }, f.svg);
  s("text", { class: "halo", x: f.x0 + 4, y: y(AVERAGE) - 7, "text-anchor": "start", style: { fill: "#52514e", fontWeight: 500 }, text: narrow ? `Flat ${AVERAGE}` : `Flat schedule ${AVERAGE} MW` }, f.svg);
  // grid limit during tight hours
  const hours = [...p.tight].sort((a, b2) => a - b2);
  hours.forEach((hr) => s("line", { x1: b.left(hr) + 1, x2: b.left(hr) + b.bw - 1, y1: y(p.limit), y2: y(p.limit), stroke: COLORS.limit, "stroke-width": 2.5, "stroke-linecap": "round" }, f.svg));
  if (hours.length) {
    const first = hours[0];
    const nearRight = b.left(first) > f.x1 - 120;
    const ly = Math.abs(p.limit - AVERAGE) < 8 ? y(p.limit) + 15 : y(p.limit) - 7;
    s("text", { x: nearRight ? b.left(hours[hours.length - 1]) + b.bw : b.left(first), y: ly, "text-anchor": nearRight ? "end" : "start", class: "halo", style: { fill: COLORS.limit, fontWeight: 600 }, text: narrow ? `Limit ${p.limit}` : `Grid limit ${p.limit} MW` }, f.svg);
  }
  xLabels(f, b);
  hoverLayer(f, p.prices.map((_, hr) => b.cx(hr)), (hr, e) => showTip(tipFor(hr), e.clientX, e.clientY));
}

function tipFor(hr) {
  const p = plan;
  const rows = [
    { color: COLORS.price, k: "Price", v: `${fmt.price(p.prices[hr])}/MWh` },
    ...(p.fossil ? [{ k: "Grid fossil share", v: fmt.pct(p.fossil[hr]) }] : []),
    "sep",
    { color: COLORS.flat, k: "Flat schedule", v: `${AVERAGE} MW` },
  ];
  if (p.ok) {
    rows.push(
      { color: COLORS.must, k: "Must run", v: `${p.must.toFixed(0)} MW` },
      { color: COLORS.wait, k: "Can wait", v: `${(p.load[hr] - p.must).toFixed(1)} MW` },
      { k: "SiteStar total", v: `${p.load[hr].toFixed(1)} MW` },
    );
  }
  if (p.tight.has(hr)) rows.push("sep", { color: COLORS.limit, k: "Tight hour · limit", v: `${p.limit} MW` });
  return tipRows(hourRange(hr), rows);
}

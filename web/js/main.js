// SiteStar site entry point.

import { $, $$ } from "./util.js";
import { findBridge, loadErcot } from "./data.js";
import { initGridNow } from "./gridnow.js";
import { initScreener } from "./screener.js";
import { initFlex } from "./flex.js";
import { initLive } from "./live.js";

// Presenter keys: 1-4 jump between sections, 0 back to the top.
const KEYS = { 0: "#top", 1: "#where", 2: "#how", 3: "#live", 4: "#evidence" };
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
  const target = KEYS[e.key];
  if (target) $(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
});

// Gentle reveal on scroll.
const io = new IntersectionObserver(
  (entries) => entries.forEach((en) => en.isIntersecting && (en.target.classList.add("in"), io.unobserve(en.target))),
  { rootMargin: "0px 0px -8% 0px" },
);
$$(".reveal").forEach((el) => io.observe(el));

function fail(sel, text) {
  const el = $(sel);
  if (el) el.textContent = text;
}

(async function start() {
  const base = await findBridge();
  initLive(base);

  initScreener().catch((err) => {
    console.error(err);
    fail("#screen-panel", "Couldn't load the Houston grid map data.");
  });

  try {
    const ercot = await loadErcot(base);
    initGridNow(ercot, base);
    initFlex(ercot);
  } catch (err) {
    console.error(err);
    fail("#gn-updated", "ERCOT data unavailable");
    fail("#fx-feasible", "ERCOT data is unavailable right now.");
  }
})();

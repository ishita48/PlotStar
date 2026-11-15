/**
 * Hey Geo scrolling (browser only).
 * Picks what the user is actually reading — the window on normal pages,
 * or the scrollable panel under the middle of the screen in app-like layouts
 * (like GeoStar's Studio) — and scrolls it smoothly.
 */

export type ScrollCommand = {
  direction: "up" | "down" | "top" | "bottom";
  amount?: "little" | "half" | "screen";
};

function scrollableAncestor(el: Element | null): HTMLElement | null {
  for (let cur = el as HTMLElement | null; cur && cur !== document.body; cur = cur.parentElement) {
    if (cur.closest("[data-geo-ui]")) return null;
    const cs = getComputedStyle(cur);
    if (/(auto|scroll|overlay)/.test(cs.overflowY) && cur.scrollHeight > cur.clientHeight + 20) return cur;
  }
  return null;
}

export function scrollTarget(): HTMLElement | Window {
  const doc = document.scrollingElement as HTMLElement | null;
  const pageScrolls = !!doc && doc.scrollHeight > innerHeight + 20;
  // What's under the centre of the viewport (ignoring Hey Geo's overlays)?
  const hit = document
    .elementsFromPoint(innerWidth / 2, innerHeight / 2)
    .find((e) => !(e as Element).closest("[data-geo-ui]")) as Element | undefined;
  const panel = scrollableAncestor(hit ?? null);
  if (panel) return panel;
  if (pageScrolls) return window;
  // App-like layout with no window scroll: fall back to the biggest scrollable panel.
  let best: HTMLElement | null = null;
  document.querySelectorAll<HTMLElement>("main, section, div, article").forEach((el) => {
    if (el.closest("[data-geo-ui]") || el.scrollHeight <= el.clientHeight + 20) return;
    if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) return;
    if (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth) best = el;
  });
  return best ?? window;
}

export function performScroll(cmd: ScrollCommand): void {
  const target = scrollTarget();
  const viewH = target === window ? innerHeight : (target as HTMLElement).clientHeight;
  const factor = cmd.amount === "little" ? 0.3 : cmd.amount === "half" ? 0.5 : 0.85;
  const delta = Math.round(viewH * factor) * (cmd.direction === "up" ? -1 : 1);
  if (cmd.direction === "top" || cmd.direction === "bottom") {
    const top = cmd.direction === "top" ? 0 : target === window ? document.documentElement.scrollHeight : (target as HTMLElement).scrollHeight;
    target.scrollTo({ top, behavior: "smooth" });
  } else {
    target.scrollBy({ top: delta, behavior: "smooth" });
  }
}

/**
 * Hey Geo memory (browser only). One conversation per browser, kept a week, plus a
 * log of what Geo did and the reports it wrote. Stored in localStorage only:
 * nothing goes to a GeoStar server, and "Forget" clears all of it.
 * (HAVEN kept these in Convex per signed-in person; GeoStar has no accounts.)
 */

import type { GeoReport } from "./schema";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const KEYS = { messages: "geostar:hey-geo:messages", tasks: "geostar:hey-geo:tasks", reports: "geostar:hey-geo:reports" } as const;

type Stamped<T> = T & { at: number };

function read<T>(key: string): Stamped<T>[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    const cutoff = Date.now() - WEEK_MS;
    return Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && typeof x.at === "number" && x.at > cutoff) : [];
  } catch {
    return [];
  }
}
function write(key: string, list: unknown[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage unavailable (private window): memory lasts for this page only */
  }
}

export function loadMessages<T extends object>(): Stamped<T>[] {
  return read<T>(KEYS.messages).slice(-30);
}
export function saveMessages<T extends object>(list: Stamped<T>[]) {
  write(KEYS.messages, list.slice(-30));
}

export type TaskLogEntry = { label: string; type: string; status: "done" | "failed" | "skipped"; detail: string };
export function logTask(entry: TaskLogEntry) {
  write(KEYS.tasks, [...read<TaskLogEntry>(KEYS.tasks), { ...entry, at: Date.now() }].slice(-40));
}

export function saveReport(report: GeoReport) {
  write(KEYS.reports, [...read<GeoReport>(KEYS.reports), { ...report, at: Date.now() }].slice(-10));
}
/** Titles of recent reports, for Geo's context. */
export function recentReports(): { title: string; kind: string; at: string }[] {
  return read<GeoReport>(KEYS.reports)
    .slice(-3)
    .map((r) => ({ title: r.title.slice(0, 120), kind: r.kind, at: new Date(r.at).toISOString() }));
}

export function forgetAll() {
  try {
    for (const k of Object.values(KEYS)) localStorage.removeItem(k);
  } catch {
    /* nothing stored */
  }
}

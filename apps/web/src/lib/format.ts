export const usd = (n: number | null | undefined, compact = true) =>
  n == null
    ? "Unknown"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        notation: compact ? "compact" : "standard",
        maximumFractionDigits: compact ? 1 : 0,
      }).format(n);

export const num = (n: number | null | undefined, digits = 0) =>
  n == null ? "Unknown" : new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(n);

export const pct = (n: number | null | undefined) => (n == null ? "Unknown" : `${Math.round(n * 100)}%`);

export const humanize = (s: string | null | undefined) =>
  s ? s.replace(/^(Industrial|GeneralRetail|Specialty|HealthCare|MultiFamily)_/, "").replace(/([a-z])([A-Z])/g, "$1 $2") : "Unknown";

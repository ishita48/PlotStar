/**
 * Hey Geo — keeps licensed CoStar data out of the model (server side).
 * ─────────────────────────────────────────────────────────────────────
 * GeoStar shows CoStar property records (names, street addresses, prices,
 * rents, coordinates). Sponsor permission to send them to an outside AI is
 * unconfirmed, so unless COPILOT_LLM_COSTAR=1 every string of a Hey Geo turn
 * is redacted here before it reaches Claude:
 *   - street addresses ("5142 Greens Rd, Houston, TX 77032", "7676 I-45 N")  → [address]
 *   - ZIP codes after a state ("TX 77032")                                   → [address]
 *   - dollar amounts, prices and rents ("$1.2M", "$24.50/SF/yr", "USD 900k") → [price]
 *   - latitude / longitude pairs and labelled coordinates                    → [coordinates]
 *   - CoStar ids ("costar:12345", "CoStar ID 12345", "Property ID 123456")   → [costar-id]
 *   - phone numbers and e-mail addresses (contacts)                          → [phone] / [email]
 *   - CoStar property names and addresses known to GeoStar's data API, plus
 *     the facility name on screen (exact matches, see costar-names.ts)        → [property name]
 * Same as the Deep Agents' redacted view: full records stay in the browser.
 */

export type RedactionCounts = Record<"address" | "price" | "coordinates" | "costarId" | "contact" | "propertyName", number>;

export const costarAllowed = () => process.env.COPILOT_LLM_COSTAR === "1";

const SUFFIX =
  "(?:Street|St|ST|Road|Rd|RD|Avenue|Ave|AVE|Av|Boulevard|Blvd|BLVD|Drive|Dr|DR|Lane|Ln|LN|Parkway|Pkwy|PKWY|Highway|Hwy|HWY|Freeway|Fwy|FWY|Frwy|Expressway|Expy|Way|Court|Ct|Place|Pl|Circle|Cir|Trail|Trl|Loop|Terrace|Ter|Plaza|Plz|Square|Sq|Pike|Turnpike|Tpke|Crossing|Xing|Ridge|Bend|Cove|Commons|Alley|Aly|Grove|Heights|Hts|Landing|Ldg|Mews|Oval|Park|Pass|Walk|Byway)";
const HIGHWAY = "(?:I|IH|US|SH|FM|RM|TX|CR|Hwy|HWY|Highway|Interstate|Beltway|Loop|Spur|State Highway|County Road|Route|Rte|SR)[- ]?\\d{1,4}[A-Z]?";
const DIRECTION = "(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West)";
/** ", Suite 200", ", Houston", ", TX 77032" — whatever follows the street line. */
const TAIL =
  `(?:\\.?\\s+${DIRECTION}\\b)?(?:\\s+(?:Frontage|Service|Feeder)(?:\\s+(?:Rd|Road))?)?(?:,?\\s*(?:Suite|Ste|Unit|Bldg|Building|#)\\s*[\\w-]+)?(?:,\\s*[A-Z][a-zA-Z.]+(?:\\s[A-Z][a-zA-Z.]+){0,2})?(?:,?\\s*[A-Z]{2}\\b)?(?:\\s*\\d{5}(?:-\\d{4})?)?`;

const RULES: { kind: keyof RedactionCounts; re: RegExp; to: string }[] = [
  // CoStar ids first, so their digits are not mistaken for anything else.
  { kind: "costarId", re: /\bco-?star[\s:#_-]*(?:prop(?:erty)?[\s_-]*)?(?:id[\s:#_-]*)?\d{3,}\b/gi, to: "[costar-id]" },
  { kind: "costarId", re: /\b(?:property|prop|listing|parcel)[\s_-]?(?:id|#)[\s:#]*\d{4,}\b/gi, to: "[costar-id]" },
  { kind: "contact", re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, to: "[email]" },
  { kind: "contact", re: /(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g, to: "[phone]" },
  // Coordinates: degree pairs, labelled values, and bare decimal pairs with 3+ decimals (29.7604, -95.3698).
  { kind: "coordinates", re: /-?\d{1,3}(?:\.\d+)?\s?°\s?[NS]?\s*,?\s*-?\d{1,3}(?:\.\d+)?\s?°\s?[EW]?/g, to: "[coordinates]" },
  { kind: "coordinates", re: /\b(lat(?:itude)?|lon(?:gitude)?|lng)\b\s*[:=]?\s*-?\d{1,3}\.\d+/gi, to: "$1 [coordinates]" },
  { kind: "coordinates", re: /\(?-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}\)?/g, to: "[coordinates]" },
  // Street addresses: "5142 Greens Rd", "1200 N Main St, Houston, TX 77002", "7676 I-45 N", "12000 Hwy 290".
  { kind: "address", re: new RegExp(`\\b\\d{1,6}[A-Z]?\\s+(?:${DIRECTION}\\.?\\s+)?${HIGHWAY}\\b${TAIL}`, "g"), to: "[address]" },
  {
    kind: "address",
    re: new RegExp(`\\b\\d{1,6}[A-Z]?(?:-\\d{1,5})?\\s+(?:${DIRECTION}\\.?\\s+)?(?:[A-Z0-9][A-Za-z0-9'.&-]*\\s+){0,4}?${SUFFIX}\\b${TAIL}`, "g"),
    to: "[address]",
  },
  { kind: "address", re: /\b(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\s\d{5}(?:-\d{4})?\b/g, to: "[address]" },
  // Money: "$1.2M", "$24.50/SF/yr", "$ 3,400,000", "USD 900k", "$85 per acre".
  {
    kind: "price",
    re: /(?:US)?\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:[kKmMbB]|MM|mm|bn|BN|million|billion|thousand)\b)?(?:\s?(?:\/|per\s)\s?(?:sq\.?\s?ft|square\s+f(?:oo|ee)t|SF|sf|ft²|acre|ac|AC|mo|month|yr|year|unit|kW|kw|MW|mw|room)\.?(?:\s?\/\s?(?:yr|year|mo|month))?)?/g,
    to: "[price]",
  },
  { kind: "price", re: /\bUSD\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|K|M|MM|bn|million|billion))?\b/g, to: "[price]" },
];

export function emptyCounts(): RedactionCounts {
  return { address: 0, price: 0, coordinates: 0, costarId: 0, contact: 0, propertyName: 0 };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One case-insensitive regex for a list of exact names (longest first, so "Park 4" never splits "Presidents Park 4"). */
export function namesPattern(names: string[]): RegExp | null {
  const list = [...new Set(names.map((n) => n.replace(/\s+/g, " ").trim()).filter((n) => n.length >= 5))].sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  return new RegExp(`(?<![\\w])(?:${list.map((n) => escapeRe(n).replace(/ /g, "\\s+")).join("|")})(?![\\w])`, "gi");
}

/** Redact one string, adding to `counts`. `names` matches CoStar property names / addresses to hide. */
export function redactText(text: string, counts: RedactionCounts, names: RegExp | null = null): string {
  let out = text;
  const apply = (rule: (typeof RULES)[number]) => {
    out = out.replace(rule.re, (...m) => {
      counts[rule.kind]++;
      return rule.to.includes("$1") ? rule.to.replace("$1", String(m[1])) : rule.to;
    });
  };
  // CoStar ids first, then the exact CoStar names and addresses, then the patterns (contacts, coordinates, addresses, money).
  RULES.filter((r) => r.kind === "costarId").forEach(apply);
  if (names)
    out = out.replace(names, () => {
      counts.propertyName++;
      return "[property name]";
    });
  RULES.filter((r) => r.kind !== "costarId").forEach(apply);
  return out;
}

/** Redact every string inside a JSON-like value (keys are left alone). */
export function redactDeep<T>(value: T, counts: RedactionCounts, names: RegExp | null = null): T {
  if (typeof value === "string") return redactText(value, counts, names) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, counts, names)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, counts, names);
    return out as T;
  }
  return value;
}

export const totalRedactions = (c: RedactionCounts) => Object.values(c).reduce((a, b) => a + b, 0);

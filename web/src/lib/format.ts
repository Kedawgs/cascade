const usd2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usd0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** Rounds half away from zero to `decimals` places, without float drift like 1.005 -> 1.00. */
export function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.sign(n) * (Math.round((Math.abs(n) + Number.EPSILON) * f) / f);
}

/** "$1,046.76" */
export function formatUsd(n: number): string {
  return usd2.format(n);
}

/** "$1,000" for whole amounts, "$500.50" otherwise. */
export function formatUsdShort(n: number): string {
  const cents = Math.round(n * 100);
  return cents % 100 === 0 ? usd0.format(cents / 100) : usd2.format(n);
}

/** USDC amounts in sentences: "1,000" or "284.14". */
export function formatUsdc(n: number): string {
  return formatUsdShort(n).replace("$", "");
}

/** "3.6600" (TAO is always shown with 4 decimals). */
export function formatTao(n: number, decimals = 4): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

/** "+0.0213" */
export function formatSignedTao(n: number): string {
  return `${n < 0 ? "-" : "+"}${formatTao(Math.abs(n))}`;
}

/** 0.0438 -> "4.4%" */
export function formatPercent(fraction: number, decimals = 1): string {
  return `${(fraction * 100).toFixed(decimals)}%`;
}

// Newer ICU versions put a narrow no-break space before AM/PM; keep output predictable.
function normalizeSpaces(s: string): string {
  return s.replace(/[  ]/g, " ");
}

/** "Oct 1" */
export function formatDay(d: Date): string {
  return dayFmt.format(d);
}

/** "Oct 1, 9:14 AM" */
export function formatDateTime(d: Date): string {
  return normalizeSpaces(dateTimeFmt.format(d));
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** 240000 -> "4 minutes", 4000 -> "4 seconds" */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return plural(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, "minute");
  return plural(Math.round(minutes / 60), "hour");
}

/** "just now", "2 minutes ago", "3 hours ago", "on Oct 1" */
export function formatRelative(d: Date, now: number): string {
  const seconds = Math.max(0, Math.floor((now - d.getTime()) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  return `on ${formatDay(d)}`;
}

/** "5HEo…7tQb" for SS58 keys, "0x12ab…cdef" for EVM addresses. */
export function shortAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  const head = addr.startsWith("0x") ? 6 : 4;
  return `${addr.slice(0, head)}…${addr.slice(-4)}`;
}

/** Keeps what a person types into an amount box to digits and one decimal point. */
export function sanitizeAmountInput(raw: string, maxDecimals: number): string {
  const cleaned = raw.replace(/,/g, "").replace(/[^\d.]/g, "");
  const [whole = "", ...rest] = cleaned.split(".");
  const trimmedWhole = whole.replace(/^0+(?=\d)/, "");
  if (rest.length === 0) return trimmedWhole;
  const decimals = rest.join("").slice(0, maxDecimals);
  return maxDecimals === 0 ? trimmedWhole : `${trimmedWhole || "0"}.${decimals}`;
}

/** Parses a sanitized amount string. Empty or incomplete input gives null. */
export function parseAmount(s: string): number | null {
  if (s === "" || s === ".") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// What the site check reads in the live site's files (spec 6.6): the 0x-addresses, the https hosts and the
// lazily loaded chunks they name; and how a file is read, as a stream capped at a byte limit.

/** A 40-hex address with hex boundaries, so a 64-hex hash never matches. */
export const ADDRESS_RE = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
/** The host of a URL: https, http, wss, ws, or protocol-relative `//host` (after a quote, `(`, `=` or a
 * space, so a `// comment` doesn't count). */
export const HOST_RE = /(?:(?:https?|wss?):|(?<=["'(\s=`]))\/\/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?=[/:"'`\s)?#]|$)/g;
/** A Next.js chunk path, with or without /_next/ (turbopack names its lazy chunks `static/chunks/….js`). */
export const CHUNK_RE = /\/_next\/static\/chunks\/[A-Za-z0-9_./-]+?\.js(?![A-Za-z0-9_])|(?<![A-Za-z0-9_/])static\/chunks\/[A-Za-z0-9_./-]+?\.js(?![A-Za-z0-9_])/g;
const chunkPath = (m: string) => (m.startsWith("/_next/") ? m : `/_next/${m}`);
/** Any quoted same-origin script path, "/….js" or "/….mjs" (never `//host/…`): what a dynamic import(), a
 * `new Worker` or `serviceWorker.register` can load from outside /_next/static/chunks/. */
export const SCRIPT_PATH_RE = /(["'`])(\/(?!\/)[A-Za-z0-9_\-./]*\.m?js)\1/g;

export interface ScanResult {
  addresses: string[];
  hosts: string[];
  chunks: string[];
}

const uniq = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** The addresses, hosts and chunk paths in a script, lowercased (paths as they are), deduplicated, sorted. */
export function scanScript(text: string): ScanResult {
  return {
    addresses: uniq([...text.matchAll(ADDRESS_RE)].map((m) => m[0].toLowerCase())),
    hosts: uniq([...text.matchAll(HOST_RE)].map((m) => m[1].toLowerCase())),
    chunks: uniq([...[...text.matchAll(CHUNK_RE)].map((m) => chunkPath(m[0])), ...[...text.matchAll(SCRIPT_PATH_RE)].map((m) => m[2])]),
  };
}

/** The scripts a page loads: every `<script src>` and `<link rel=modulepreload>` or `<link rel=preload
 * as=script>`. A same-origin one is a path to fetch and scan (wherever it is: /_next/static/, /cdn-cgi/, …);
 * a cross-origin one is never fetched, its host is reported for approval; one whose source is a data: or
 * blob: URL (code that comes from no host at all) is named as such ("data: URL", "blob: URL"). */
export function pageScripts(html: string, origin: string): { srcs: string[]; foreignHosts: string[]; embedded: string[] } {
  const srcs = new Set<string>();
  const foreign = new Set<string>();
  const embedded = new Set<string>();
  const take = (ref: string) => {
    let u: URL;
    try {
      u = new URL(ref, origin);
    } catch {
      return;
    }
    if (u.protocol === "data:" || u.protocol === "blob:") embedded.add(`${u.protocol} URL`);
    else if (u.origin === new URL(origin).origin) srcs.add(u.pathname);
    else foreign.add(u.hostname.toLowerCase());
  };
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    const src = attr(m[1], "src");
    if (src) take(src);
  }
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const rel = (attr(m[1], "rel") ?? "").toLowerCase().split(/\s+/);
    const as = (attr(m[1], "as") ?? "").toLowerCase();
    const href = attr(m[1], "href");
    if (href && (rel.includes("modulepreload") || (rel.includes("preload") && as === "script"))) take(href);
  }
  return { srcs: [...srcs], foreignHosts: [...foreign].sort(), embedded: [...embedded].sort() };
}

/** A Content-Security-Policy header's policies, each normalized (directives trimmed, their names lowercased,
 * runs of spaces made one, empty ones dropped, joined by "; "). Several policies come comma-separated: Cloudflare
 * sends one header per matching _headers rule, and fetch joins them with ", " (a policy holds no comma). */
export function cspPolicies(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((p) =>
      p
        .split(";")
        .map((d) => d.trim().split(/\s+/))
        .filter((d) => d[0] !== "")
        .map(([name, ...sources]) => [name.toLowerCase(), ...sources].join(" "))
        .join("; "),
    )
    .filter((p) => p !== "");
}

/** An inline script's hash source ('sha256-…', or sha384, sha512): every build changes them. */
const HASH_SOURCE = /^'sha(?:256|384|512)-[A-Za-z0-9+/_=-]*'$/;
/** A normalized policy without its hash sources. */
const withoutHashes = (p: string) =>
  p
    .split("; ")
    .map((d) => d.split(" ").filter((s) => !HASH_SOURCE.test(s)).join(" "))
    .join("; ");
const samePolicies = (x: readonly string[], y: readonly string[]) => {
  const a = [...x].sort();
  const b = [...y].sort();
  return a.length === b.length && a.every((p, i) => p === b[i]);
};

/** How a page's live policies differ from the approved ones (normalized, in any order): undefined when they
 * are the same; `hashes` when they differ only in the inline scripts' hashes (what a site deployed without new
 * approved lists looks like); else `changed`, with a short line naming what differs (the header missing, a
 * policy dropped, the directives that differ: a new host, 'unsafe-inline', a directive gone). */
export function cspDifference(approved: readonly string[], live: readonly string[]): { kind: "changed" | "hashes"; detail: string } | undefined {
  if (samePolicies(approved, live)) return undefined;
  if (live.length === 0) return { kind: "changed", detail: "the page has no Content-Security-Policy" };
  const a = approved.map(withoutHashes);
  const l = live.map(withoutHashes);
  if (samePolicies(a, l)) return { kind: "hashes", detail: "differs only in the inline scripts' hashes" };
  const count = (ps: readonly string[]) => {
    const m = new Map<string, number>();
    for (const d of ps.flatMap((p) => p.split("; "))) m.set(d, (m.get(d) ?? 0) + 1);
    return m;
  };
  const ca = count(a);
  const cl = count(l);
  const names = [...new Set([...ca.keys(), ...cl.keys()].filter((d) => ca.get(d) !== cl.get(d)).map((d) => d.split(" ")[0]))].sort();
  const policies = a.length === l.length ? "" : `${l.length} polic${l.length === 1 ? "y" : "ies"} where the build has ${a.length}; `;
  return { kind: "changed", detail: `${policies}${names.length ? `differs in ${names.join(", ")}` : "the same directives, split into other policies"}` };
}

/** Whether `host` (lowercase) is on `list`: by name, or below a `*.domain` wildcard (a CSP host source). */
export const hostListed = (list: readonly string[], host: string): boolean =>
  list.some((x) => {
    const h = x.toLowerCase();
    return h === host || (h.startsWith("*.") && host.endsWith(h.slice(1)));
  });

const attr = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs)?.slice(1).find((x) => x !== undefined);

/** The body as text, read as a stream and cancelled once past `maxBytes` (never buffering more). */
export async function readCapped(res: Response, maxBytes: number): Promise<{ text: string } | { tooLarge: true }> {
  if (!res.body) return { text: "" };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return { text: new TextDecoder().decode(all) };
}

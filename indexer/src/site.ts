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
  // every <script and <link start tag (one inside a comment, a script's text or another tag's value counts too:
  // more findings, never fewer), its attributes read as the browser's tokenizer reads them
  for (const m of html.matchAll(/<(script|link)(?=[\t\n\f\r />])/gi)) {
    const a = tagAttrs(html, m.index + m[0].length);
    if (m[1].toLowerCase() === "script") {
      const src = a.get("src");
      if (src) take(src);
      continue;
    }
    const rel = (a.get("rel") ?? "").toLowerCase().split(/[\t\n\f\r ]+/);
    const as = (a.get("as") ?? "").toLowerCase();
    const href = a.get("href");
    if (href && (rel.includes("modulepreload") || (rel.includes("preload") && as === "script"))) take(href);
  }
  return { srcs: [...srcs], foreignHosts: [...foreign].sort(), embedded: [...embedded].sort() };
}

const SPACE = new Set(["\t", "\n", "\f", "\r", " "]);

/** The attributes of the start tag whose name ends at `at`, read as the HTML tokenizer reads them: a name runs
 * to a space, /, > or =, its ASCII letters lowercased; a value is quoted (a > inside doesn't end the tag) or runs
 * to a space or > (a quote inside is part of it); character references in a value are decoded; the first of a
 * repeated name is kept. It stops at the > that ends the tag. */
function tagAttrs(html: string, at: number): Map<string, string> {
  const out = new Map<string, string>();
  const n = html.length;
  let i = at;
  for (;;) {
    while (i < n && (SPACE.has(html[i]) || html[i] === "/")) i++;
    if (i >= n || html[i] === ">") return out;
    const start = i++;
    while (i < n && !SPACE.has(html[i]) && html[i] !== "/" && html[i] !== ">" && html[i] !== "=") i++;
    const name = html.slice(start, i).replace(/[A-Z]/g, (c) => c.toLowerCase());
    while (i < n && SPACE.has(html[i])) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < n && SPACE.has(html[i])) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const end = html.indexOf(q, i + 1);
        value = html.slice(i + 1, end === -1 ? n : end);
        i = end === -1 ? n : end + 1;
      } else {
        const s = i;
        while (i < n && !SPACE.has(html[i]) && html[i] !== ">") i++;
        value = html.slice(s, i);
      }
    }
    if (!out.has(name)) out.set(name, decodeRefs(value));
  }
}

/** Every named character reference that decodes to ASCII: the characters that can change what a URL means
 * (`&colon;`, `&sol;`, `&Tab;`, …). Any other named reference decodes to a character outside ASCII, which keeps a
 * URL relative to the page, as it is left undecoded. */
const NAMED_ASCII: Readonly<Record<string, string>> = {
  Tab: "\t",
  NewLine: "\n",
  excl: "!",
  quot: '"',
  QUOT: '"',
  num: "#",
  dollar: "$",
  percnt: "%",
  amp: "&",
  AMP: "&",
  apos: "'",
  lpar: "(",
  rpar: ")",
  ast: "*",
  midast: "*",
  plus: "+",
  comma: ",",
  period: ".",
  sol: "/",
  colon: ":",
  semi: ";",
  lt: "<",
  LT: "<",
  equals: "=",
  gt: ">",
  GT: ">",
  quest: "?",
  commat: "@",
  lsqb: "[",
  lbrack: "[",
  bsol: "\\",
  rsqb: "]",
  rbrack: "]",
  Hat: "^",
  lowbar: "_",
  UnderBar: "_",
  grave: "`",
  DiacriticalGrave: "`",
  lcub: "{",
  lbrace: "{",
  verbar: "|",
  vert: "|",
  VerticalLine: "|",
  rcub: "}",
  rbrace: "}",
  fjlig: "fj",
};
/** The ASCII ones a browser also decodes without the semicolon (unless = follows, in an attribute value). */
const LEGACY = new Set(["amp", "AMP", "lt", "LT", "gt", "GT", "quot", "QUOT"]);

/** An attribute value as a browser reads it: numeric character references (decimal or hex, the semicolon
 * optional; an invalid one is U+FFFD) and the named ones in NAMED_ASCII decoded. */
export function decodeRefs(v: string): string {
  if (!v.includes("&")) return v;
  return v.replace(/&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*))(;?)/g, (m, dec, hex, name, semi, at: number) => {
    if (name !== undefined) {
      if (semi) return NAMED_ASCII[name] ?? m;
      return LEGACY.has(name) && v[at + m.length] !== "=" ? NAMED_ASCII[name] : m;
    }
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "�";
  });
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

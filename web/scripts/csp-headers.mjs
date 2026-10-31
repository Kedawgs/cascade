// After `next build`: allows the exported pages' inline scripts, by their sha256 hashes, in out/_headers
// (the copy of public/_headers). The committed fallback (the `/*` rule) allows no inline script at all
// (script-src 'self'), so a deploy that skipped this step breaks loudly instead of running open. This
// step gives the fallback every exported page's hashes, the 404 page's too, and each page a rule of its
// own with only its hashes: Cloudflare joins the two with a comma, the browser enforces both, so a page
// runs only its own inline scripts and the 404 page only its own and the pages'. Next's static export
// writes a few inline scripts into every page (the RSC payload and the chunk list), and they change with
// every build. Fails the build rather than write a file Cloudflare Pages would refuse (a line over 2,000
// characters, more than 100 rules).
// a CommonJS bundle: Node's ESM loader sees no named exports on it, so the module object is imported whole
import nextEnv from "@next/env";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "# ---- each page's own policy (written by scripts/csp-headers.mjs after next build) ----";
const MAX_LINE = 2000;
const MAX_RULES = 100;
/** Script types a browser runs; anything else (JSON data) isn't subject to script-src. */
const RUNS = new Set(["", "text/javascript", "application/javascript", "module"]);

/** The sha256 source expressions of the inline scripts in `html` that run, in page order, each once. */
export function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1];
    if (/\ssrc\s*=/i.test(attrs)) continue;
    const type = (/\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? "").toLowerCase();
    if (!RUNS.has(type)) continue;
    const hash = `'sha256-${createHash("sha256").update(m[2], "utf8").digest("base64")}'`;
    if (!out.includes(hash)) out.push(hash);
  }
  return out;
}

/** The path Cloudflare Pages serves an exported page at (trailingSlash: folder/index.html → /folder/),
 * or null for a file that isn't a page of its own (the 404 page is served on any unknown path). */
export function routeOf(file) {
  if (file === "index.html") return "/";
  const m = /^(.+)\/index\.html$/.exec(file);
  if (!m || m[1] === "404" || m[1] === "_not-found") return null;
  return `/${m[1]}/`;
}

/** The `/*` rule's Content-Security-Policy line in a _headers file: its index and its policy. */
function fallbackLine(headers) {
  const lines = headers.split("\n");
  let inFallback = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) inFallback = lines[i].trim() === "/*";
    else if (inFallback && lines[i].trim().startsWith("Content-Security-Policy:")) {
      return { index: i, policy: lines[i].trim().slice("Content-Security-Policy:".length).trim() };
    }
  }
  throw new Error("public/_headers has no Content-Security-Policy for /*");
}

/** The Content-Security-Policy of the `/*` rule in a _headers file. */
export const fallbackPolicy = (headers) => fallbackLine(headers).policy;

/** `policy` with its script-src as 'self' and `hashes`. */
const withScripts = (policy, hashes) => policy.replace(/(^|;\s*)script-src [^;]*/, (_m, lead) => `${lead}${["script-src 'self'", ...hashes].join(" ")}`);

/** `policy` with `origins` added to its connect-src, each once (a run on its own output adds nothing twice). */
function withConnect(policy, origins) {
  if (origins.length === 0) return policy;
  return policy.replace(/(^|;\s*)connect-src ([^;]*)/, (_m, lead, values) => {
    const have = values.trim().split(/\s+/);
    return `${lead}connect-src ${[...have, ...origins.filter((o) => !have.includes(o))].join(" ")}`;
  });
}

/** `v` as the history indexer's origin: exactly an https origin (scheme and host, a port at most: no path,
 * slash, query, fragment, credentials or wildcard), else null. The same rule as the site's
 * (src/lib/cascade/config.ts, indexerOrigin; a test holds the two together), so the policy names exactly
 * the origin the code connects to, never a wildcard. */
export function indexerOrigin(v) {
  if (!v) return null;
  let url;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  return url.protocol === "https:" && url.origin === v && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(url.hostname) ? v : null;
}

/** `headers` with the fallback allowing every page's inline scripts and those of `others` (the 404 page),
 * and one rule per page after it allowing that page's alone; both with `connect` (the indexer's origin,
 * when the build names one) added to connect-src. A previous run's hashes and rules are replaced. The
 * committed fallback's script-src must be 'self' alone. */
export function withPageRules(headers, pages, others = [], connect = []) {
  const base = headers.includes(MARKER) ? headers.slice(0, headers.indexOf(MARKER)) : headers;
  const { index, policy } = fallbackLine(base);
  // a previous run's hashes are taken off again; what is left must be the committed 'self' alone
  const committed = withConnect(policy.replace(/(^|;\s*)script-src 'self'(?: 'sha256-[A-Za-z0-9+/=]+')+/, "$1script-src 'self'"), connect);
  const scripts = /(?:^|;\s*)script-src ([^;]*)/.exec(committed)?.[1].trim();
  if (scripts !== "'self'") throw new Error(`the fallback Content-Security-Policy's script-src must be 'self' alone, not "${scripts ?? "(none)"}"`);
  const every = [...new Set([...pages.map((p) => p.html), ...others].flatMap(inlineScriptHashes))];
  const lines = base.trimEnd().split("\n");
  lines[index] = `  Content-Security-Policy: ${withScripts(committed, every)}`;
  const rules = pages.map(({ route, html }) => `${route}\n  Content-Security-Policy: ${withScripts(committed, inlineScriptHashes(html))}`);
  const text = `${lines.join("\n")}\n\n${MARKER}\n${rules.join("\n\n")}\n`;
  const long = text.split("\n").find((l) => l.length > MAX_LINE);
  if (long) throw new Error(`a _headers line is over Cloudflare's 2,000 characters (${long.length}): ${long.slice(0, 80)}…`);
  const count = text.split("\n").filter((l) => /^[/h]/.test(l)).length;
  if (count > MAX_RULES) throw new Error(`_headers would have ${count} rules, over Cloudflare's 100`);
  return text;
}

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? htmlFiles(join(dir, e.name)) : e.name.endsWith(".html") ? [join(dir, e.name)] : []));
}

/** The value of NEXT_PUBLIC_CASCADE_INDEXER_URL `next build` inlined into the exported scripts under
 * `out` (config.ts passes it by name, and the minified bundle keeps that name as the property), or null
 * when the bundle names none. Throws when the scripts name two different values. */
export function inlinedIndexerUrl(out) {
  const files = jsFiles(out);
  const values = new Set();
  for (const file of files) {
    for (const m of readFileSync(file, "utf8").matchAll(/NEXT_PUBLIC_CASCADE_INDEXER_URL:(?:"((?:[^"\\]|\\.)*)"|(void 0|undefined|null))/g)) {
      values.add(m[1] === undefined ? null : m[1]);
    }
  }
  if (values.size > 1) throw new Error(`the exported scripts name more than one NEXT_PUBLIC_CASCADE_INDEXER_URL: ${[...values].join(", ")}`);
  return values.size === 1 ? [...values][0] : null;
}

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? jsFiles(join(dir, e.name)) : e.name.endsWith(".js") ? [join(dir, e.name)] : []));
}

/** The environment `next build` built with: the process's, with the `.env` files of `dir` (web/)
 * loaded the way Next loads them (`.env.local` and friends, never overriding a value the process has),
 * so the policy reads the same NEXT_PUBLIC_CASCADE_INDEXER_URL the bundle inlined.
 * @param {string} dir */
export function buildEnv(dir) {
  return nextEnv.loadEnvConfig(dir, false, { info: () => undefined, error: console.error }, true).combinedEnv;
}

/** Writes `out`'s _headers from the pages exported there, with the indexer's origin in connect-src when
 * the build's environment names one (NEXT_PUBLIC_CASCADE_INDEXER_URL: `env`, or the process's environment
 * with `dir`'s .env files loaded as `next build` loads them). Fails rather than write a policy that
 * disagrees with what the exported scripts inlined: the page may connect exactly where its code asks.
 * @param {string} out
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [dir] */
export function build(out, env, dir = fileURLToPath(new URL("..", import.meta.url))) {
  const environment = env ?? buildEnv(dir);
  const headersPath = join(out, "_headers");
  const files = htmlFiles(out).map((file) => ({ route: routeOf(relative(out, file).split(sep).join("/")), html: readFileSync(file, "utf8") }));
  const pages = files.filter((p) => p.route !== null).sort((a, b) => a.route.localeCompare(b.route));
  if (pages.length === 0) throw new Error("no exported pages in out/: run next build first");
  const others = files.filter((p) => p.route === null).map((p) => p.html);
  const value = environment.NEXT_PUBLIC_CASCADE_INDEXER_URL;
  const indexer = indexerOrigin(value);
  if (value && !indexer) {
    console.warn("csp-headers: NEXT_PUBLIC_CASCADE_INDEXER_URL isn't an https origin; the site ignores it, and the policy doesn't name it");
  }
  const inlined = inlinedIndexerUrl(out);
  if ((inlined ?? "") !== (value ?? "")) {
    throw new Error(
      `the exported scripts inlined NEXT_PUBLIC_CASCADE_INDEXER_URL=${inlined === null ? "(none)" : JSON.stringify(inlined)} but the policy would be built from ${value === undefined ? "(none)" : JSON.stringify(value)}: build and this step must see the same environment`,
    );
  }
  writeFileSync(headersPath, withPageRules(readFileSync(headersPath, "utf8"), pages, others, indexer ? [indexer] : []));
  return { pages: pages.map((p) => p.route), indexer };
}

function main() {
  const { pages, indexer } = build(fileURLToPath(new URL("../out", import.meta.url)));
  console.log(
    `csp-headers: a Content-Security-Policy for each of ${pages.length} pages in out/_headers (${pages.join(" ")}), and the fallback with all their inline scripts and the 404 page's${indexer ? `; connect-src also allows the indexer at ${indexer}` : ""}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

// After `next build`: allows the exported pages' inline scripts, by their sha256 hashes, in out/_headers
// (the copy of public/_headers). The committed fallback (the `/*` rule) allows no inline script at all
// (script-src 'self'), so a deploy that skipped this step breaks loudly instead of running open. This
// step gives the fallback every exported page's hashes, the 404 page's too, and each page a rule of its
// own with only its hashes: Cloudflare joins the two with a comma, the browser enforces both, so a page
// runs only its own inline scripts and the 404 page only its own and the pages'. Next's static export
// writes a few inline scripts into every page (the RSC payload and the chunk list), and they change with
// every build. Fails the build rather than write a file Cloudflare Pages would refuse (a line over 2,000
// characters, more than 100 rules).
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

/** `headers` with the fallback allowing every page's inline scripts and those of `others` (the 404 page),
 * and one rule per page after it allowing that page's alone. A previous run's hashes and rules are
 * replaced. The committed fallback's script-src must be 'self' alone. */
export function withPageRules(headers, pages, others = []) {
  const base = headers.includes(MARKER) ? headers.slice(0, headers.indexOf(MARKER)) : headers;
  const { index, policy } = fallbackLine(base);
  // a previous run's hashes are taken off again; what is left must be the committed 'self' alone
  const committed = policy.replace(/(^|;\s*)script-src 'self'(?: 'sha256-[A-Za-z0-9+/=]+')+/, "$1script-src 'self'");
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

function main() {
  const out = fileURLToPath(new URL("../out", import.meta.url));
  const headersPath = join(out, "_headers");
  const files = htmlFiles(out).map((file) => ({ route: routeOf(relative(out, file).split(sep).join("/")), html: readFileSync(file, "utf8") }));
  const pages = files.filter((p) => p.route !== null).sort((a, b) => a.route.localeCompare(b.route));
  if (pages.length === 0) throw new Error("no exported pages in out/: run next build first");
  const others = files.filter((p) => p.route === null).map((p) => p.html);
  writeFileSync(headersPath, withPageRules(readFileSync(headersPath, "utf8"), pages, others));
  console.log(
    `csp-headers: a Content-Security-Policy for each of ${pages.length} pages in out/_headers (${pages.map((p) => p.route).join(" ")}), and the fallback with all their inline scripts and the 404 page's`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

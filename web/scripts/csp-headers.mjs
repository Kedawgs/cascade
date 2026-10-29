// After `next build`: gives each exported page its own Content-Security-Policy in out/_headers (the
// copy of public/_headers), allowing only that page's inline scripts by their sha256 hashes. Next's
// static export writes a few inline scripts into every page (the RSC payload and the chunk list), and
// they change with every build, so their hashes are taken from the built pages. Fails the build
// rather than write a file Cloudflare Pages would refuse (a line over 2,000 characters, more than
// 100 rules).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** What the fallback policy allows of inline scripts, which each page's own policy narrows. */
export const INLINE_SCRIPTS = "script-src 'self' 'unsafe-inline'";
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

/** The Content-Security-Policy of the `/*` rule in a _headers file. */
export function fallbackPolicy(headers) {
  const block = headers.split(/\n(?=\S)/).find((b) => b.split("\n")[0].trim() === "/*");
  const line = block?.split("\n").find((l) => l.trim().startsWith("Content-Security-Policy:"));
  if (!line) throw new Error("public/_headers has no Content-Security-Policy for /*");
  return line.trim().slice("Content-Security-Policy:".length).trim();
}

/** `headers` with one rule per page after it: the fallback policy with script-src narrowed to 'self'
 * and the page's inline-script hashes. A previous run's rules are replaced. */
export function withPageRules(headers, pages) {
  const base = headers.includes(MARKER) ? headers.slice(0, headers.indexOf(MARKER)) : headers;
  const fallback = fallbackPolicy(base);
  if (!fallback.includes(INLINE_SCRIPTS)) throw new Error(`the fallback Content-Security-Policy has no "${INLINE_SCRIPTS}" to narrow`);
  const rules = pages.map(({ route, html }) => {
    const policy = fallback.replace(INLINE_SCRIPTS, ["script-src 'self'", ...inlineScriptHashes(html)].join(" "));
    return `${route}\n  Content-Security-Policy: ${policy}`;
  });
  const text = `${base.trimEnd()}\n\n${MARKER}\n${rules.join("\n\n")}\n`;
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
  const pages = htmlFiles(out)
    .map((file) => ({ route: routeOf(relative(out, file).split(sep).join("/")), html: readFileSync(file, "utf8") }))
    .filter((p) => p.route !== null)
    .sort((a, b) => a.route.localeCompare(b.route));
  if (pages.length === 0) throw new Error("no exported pages in out/: run next build first");
  writeFileSync(headersPath, withPageRules(readFileSync(headersPath, "utf8"), pages));
  console.log(`csp-headers: a Content-Security-Policy for each of ${pages.length} pages in out/_headers (${pages.map((p) => p.route).join(" ")})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

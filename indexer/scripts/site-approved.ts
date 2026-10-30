import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cspPolicies, pageScripts, scanScript } from "../src/site.ts";

// pnpm site:approved ../web/out [--extra-hosts <host,…>] [--extra-script-hosts <host,…>]
//
// Writes src/site-approved.ts from the static export about to be deployed (its HTML, its _next/static
// JavaScript and its _headers), which the site check compares the live site against (spec 6.6): every
// 0x-address; the hosts its pages load scripts from (the only hosts a live page may load a script from); every
// host its text names (approved as a mention only); and each page's Content-Security-Policy. Run it on the
// build you deploy, review the lists in git, then deploy the Worker with them. It also prints the largest file:
// on Workers Free a chunk near the byte cap (SITE_MAX_BYTES) can use up a run's CPU.

const TARGET = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "site-approved.ts");
/** Any origin will do for reading the export's pages: their own scripts are paths, so a script with a host is
 * one they load from elsewhere. */
const BUILD_ORIGIN = "https://build.invalid";

type OutFile = { path: string; text: string; bytes: number };

/** The export's HTML files and its _next/static scripts, with their text and size. */
export function readOut(dir: string): OutFile[] {
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  return walk(dir)
    .map((f) => ({ f, rel: relative(dir, f).split(sep).join("/") }))
    .filter(({ rel }) => rel.endsWith(".html") || (rel.startsWith("_next/static/") && rel.endsWith(".js")))
    .map(({ f, rel }) => {
      const text = readFileSync(f, "utf8");
      return { path: `/${rel}`, text, bytes: Buffer.byteLength(text) };
    });
}

/** The export's _headers file (written by the site's `pnpm build`), or "" when it has none. */
export const readHeaders = (dir: string): string => (existsSync(join(dir, "_headers")) ? readFileSync(join(dir, "_headers"), "utf8") : "");

type HeaderRule = { pattern: string; headers: [string, string][] };

/** A _headers file's rules, in order: each URL pattern with its headers (names lowercased; `! Name`, which
 * detaches a header earlier rules set, as `!name`). Comments and blank lines are skipped. */
export function headerRules(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (/^\S/.test(line)) {
      rules.push({ pattern: line.trim(), headers: [] });
      continue;
    }
    const detach = /^\s+!\s*(\S+)\s*$/.exec(line);
    const m = /^\s+([^:\s!][^:]*):\s*(.*)$/.exec(line);
    if (rules.length && (detach || m)) rules[rules.length - 1].headers.push(detach ? [`!${detach[1].toLowerCase()}`, ""] : [m![1].trim().toLowerCase(), m![2].trim()]);
  }
  return rules;
}

/** A path pattern as a RegExp: `*` (the splat) matches anything, `:name` one path segment, the rest itself. A
 * rule for an absolute URL (another host's) is refused: which host it applies to can't be told from here. */
function patternRe(pattern: string): RegExp {
  if (!pattern.startsWith("/")) throw new Error(`out/_headers has a rule for an absolute URL (${pattern}): this script only reads path rules`);
  const re = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/:[A-Za-z]\w*/g, "[^/]+");
  return new RegExp(`^${re}$`);
}

/** The Content-Security-Policy policies Workers sends for `path`: those of every rule whose pattern matches it,
 * in the file's order (a detached header drops what came before). */
export function cspFor(rules: readonly HeaderRule[], path: string): string[] {
  let out: string[] = [];
  for (const r of rules) {
    if (!patternRe(r.pattern).test(path)) continue;
    for (const [name, value] of r.headers) {
      if (name === "!content-security-policy") out = [];
      else if (name === "content-security-policy") out.push(...cspPolicies(value));
    }
  }
  return out;
}

/** The path an exported page is served at (folder per route, trailing slash: faq/index.html → /faq/), or null
 * for a file that isn't a page of its own (the 404 page). As web/scripts/csp-headers.mjs's routeOf. */
export function routeOf(file: string): string | null {
  if (file === "index.html") return "/";
  const m = /^(.+)\/index\.html$/.exec(file);
  if (!m || m[1] === "404" || m[1] === "_not-found") return null;
  return `/${m[1]}/`;
}

/** The hosts a policy lets scripts load from: the host sources of its script-src (its default-src when it has
 * none), without scheme, port or path. Keywords ('self', hashes, 'strict-dynamic') and bare schemes are not
 * hosts. */
export function scriptSrcHosts(policy: string): string[] {
  const directives = new Map(
    policy
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0] !== "")
      .map(([name, ...sources]) => [name.toLowerCase(), sources] as const),
  );
  const sources = directives.get("script-src") ?? directives.get("default-src") ?? [];
  const hosts = sources.flatMap((s) => {
    if (s.startsWith("'") || /^[a-z][a-z0-9+.-]*:$/i.test(s)) return [];
    const host = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[:/].*$/, "").toLowerCase();
    return host.includes(".") ? [host] : [];
  });
  return [...new Set(hosts)].sort();
}

export function approvedLists(files: readonly OutFile[], headers = "") {
  const addresses = new Set<string>();
  const scriptHosts = new Set<string>();
  const bundleHosts = new Set<string>();
  let largest = { path: "", bytes: 0 };
  for (const f of files) {
    const s = scanScript(f.text);
    for (const a of s.addresses) addresses.add(a);
    for (const h of s.hosts) bundleHosts.add(h);
    // a script the page itself loads from elsewhere: <script src>, modulepreload, preload as=script
    if (f.path.endsWith(".html")) for (const h of pageScripts(f.text, BUILD_ORIGIN).foreignHosts) scriptHosts.add(h);
    if (f.bytes > largest.bytes) largest = { path: f.path, bytes: f.bytes };
  }
  const rules = headerRules(headers);
  for (const r of rules) {
    for (const [name, value] of r.headers) if (name === "content-security-policy") for (const p of cspPolicies(value)) for (const h of scriptSrcHosts(p)) scriptHosts.add(h);
  }
  // each page's policies, as the live page must carry them
  const routes = files.map((f) => routeOf(f.path.slice(1))).filter((r): r is string => r !== null);
  const csp = Object.fromEntries([...new Set(routes)].sort().map((r) => [r, cspFor(rules, r)]));
  return { addresses: [...addresses].sort(), scriptHosts: [...scriptHosts].sort(), bundleHosts: [...bundleHosts].sort(), csp, largest };
}

export function renderApproved(
  lists: { addresses: string[]; scriptHosts: string[]; bundleHosts: string[]; csp: Record<string, string[]> },
  date: string,
  extra: { hosts?: readonly string[]; scriptHosts?: readonly string[] } = {},
): string {
  const list = (xs: string[], indent = "") => (xs.length ? `[\n${xs.map((x) => `${indent}  ${JSON.stringify(x)},`).join("\n")}\n${indent}]` : "[]");
  const pages = Object.entries(lists.csp);
  const record = pages.length ? `{\n${pages.map(([page, ps]) => `  ${JSON.stringify(page)}: ${list(ps, "  ")},`).join("\n")}\n}` : "{}";
  return [
    `// Generated by \`pnpm site:approved ../web/out\` (scripts/site-approved.ts), built ${date}, from the static export`,
    "// deployed. The site check reports anything else (spec 6.6). Review changes in git.",
    ...(extra.hosts?.length ? [`// Added by hand (--extra-hosts): ${extra.hosts.join(", ")}`] : []),
    ...(extra.scriptHosts?.length ? [`// Added by hand (--extra-script-hosts): ${extra.scriptHosts.join(", ")}`] : []),
    "",
    "/** Every 0x-address in the export's HTML and JavaScript. */",
    `export const APPROVED_ADDRESSES: readonly string[] = ${list(lists.addresses)};`,
    "",
    "/** The hosts the export's pages load scripts from (a cross-origin <script src>, modulepreload or preload, or a",
    " * host in a script-src of its _headers): the only hosts a live page may load a script from. */",
    `export const APPROVED_SCRIPT_HOSTS: readonly string[] = ${list(lists.scriptHosts)};`,
    "",
    "/** Every host the export's text names (RPCs, explorers, links, a dependency's gateways): approved as a mention",
    " * in a page or script, never as a script source. */",
    `export const SEEN_IN_BUNDLE_HOSTS: readonly string[] = ${list(lists.bundleHosts)};`,
    "",
    "/** Each page's Content-Security-Policy as out/_headers gives it, one string per policy (Workers sends a page",
    " * the policy of every rule matching it: the /* fallback and the page's own). The live page must carry exactly",
    " * these. They change with every build (the inline scripts' hashes): regenerate on every site deploy. */",
    `export const APPROVED_CSP: Readonly<Record<string, readonly string[]>> = ${record};`,
    "",
  ].join("\n");
}

/** A host name as the site check reports one: lowercase labels, no scheme, port, path or wildcard. */
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const USAGE = "usage: pnpm site:approved <web/out directory> [--extra-hosts <host,host,...>] [--extra-script-hosts <host,host,...>]";

export async function main(argv: string[], o: { target: string; print: (l: string) => void; today: () => string }): Promise<number> {
  const args = argv.filter((a) => a !== "--");
  const extra: Record<string, string[]> = {};
  for (const flag of ["--extra-hosts", "--extra-script-hosts"]) {
    const at = args.indexOf(flag);
    if (at === -1) continue;
    const value = args[at + 1];
    const hosts = (value ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => h !== "");
    if (!value || value.startsWith("--") || hosts.length === 0 || !hosts.every((h) => HOST.test(h))) {
      o.print(`${flag} takes host names only, comma-separated (e.g. static.cloudflareinsights.com)\n${USAGE}`);
      return 2;
    }
    extra[flag] = hosts;
    args.splice(at, 2);
  }
  const dir = args[0];
  if (!dir) {
    o.print(USAGE);
    return 2;
  }
  const files = readOut(dir);
  const headers = readHeaders(dir);
  if (headers === "") {
    o.print(`${dir} has no _headers: build the site with pnpm build (its last step writes each page's Content-Security-Policy)`);
    return 2;
  }
  let lists: ReturnType<typeof approvedLists>;
  try {
    lists = approvedLists(files, headers);
  } catch (e) {
    o.print(e instanceof Error ? e.message : String(e));
    return 2;
  }
  const bare = Object.entries(lists.csp).filter(([, ps]) => ps.length === 0);
  if (bare.length) {
    o.print(`out/_headers gives no Content-Security-Policy for ${bare.map(([p]) => p).join(", ")}: a page must have one`);
    return 2;
  }
  // hand-added hosts (what Cloudflare injects into the served pages) join their list, and are named in the file
  const add = (xs: string[], more: string[] = []) => [...new Set([...xs, ...more])].sort();
  const out = {
    addresses: lists.addresses,
    scriptHosts: add(lists.scriptHosts, extra["--extra-script-hosts"]),
    bundleHosts: add(lists.bundleHosts, extra["--extra-hosts"]),
    csp: lists.csp,
  };
  writeFileSync(o.target, renderApproved(out, o.today(), { hosts: extra["--extra-hosts"], scriptHosts: extra["--extra-script-hosts"] }));
  o.print(
    `${files.length} files: ${out.addresses.length} addresses, ${out.scriptHosts.length} script hosts, ${out.bundleHosts.length} hosts seen in the bundle, the Content-Security-Policy of ${Object.keys(out.csp).length} pages written to ${o.target}`,
  );
  o.print(`largest file: ${lists.largest.path} (${lists.largest.bytes} bytes); on Workers Free keep it well under SITE_MAX_BYTES or set SITE_FILES_PER_RUN=1`);
  o.print(
    "The live site also carries what Cloudflare injects (the Web Analytics beacon's script, /cdn-cgi/ scripts): if the site check reports one, check it is Cloudflare's and run this again with --extra-script-hosts <host> (a script loaded from it) or --extra-hosts <host> (a host a script names), so the addition stays in the file for review.",
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), { target: TARGET, print: (l) => console.log(l), today: () => new Date().toISOString().slice(0, 10) }).then((c) => process.exit(c));
}

import type { Config } from "./config.ts";
import { cspDifference, cspPolicies, hostListed, pageScripts, readCapped, type ScanResult, scanScript } from "./site.ts";
import { APPROVED_ADDRESSES, APPROVED_CSP, APPROVED_SCRIPT_HOSTS, SEEN_IN_BUNDLE_HOSTS } from "./site-approved.ts";
import { setMeta } from "./store.ts";

// The site check (spec 6.6), in its own cron every two minutes, never the tick: a tampered site could serve a
// huge or hostile file, and the worst it can do here is stop a site-check invocation. Its state lives in meta
// (its own small writes): the pass under way, the file being tried, and the last complete pass's result,
// which the tick turns into alerts. It sends no email and never touches the tick's lease.
//
// Cadence. The cron is how often a run may work, not how often the site is judged: a pass starts at the first
// run PASS_EVERY_S after the last pass finished, reads every page in SITE_PAGES in that first run, then
// SITE_FILES_PER_RUN scripts a run. The real build (9 pages, 32 scripts, 20 a run on Paid) is one pass of two
// runs, finished 2 minutes after it starts, so a change to the live site is judged within about 64 minutes
// (the hour, the pass, the next tick); at the 400-file cap a pass takes 20 runs (40 minutes) at most.

/** A new pass starts this long after the last one finished. */
export const PASS_EVERY_S = 3600;
/** The most script files a pass takes. The real build has 32; a site with more than this is padded to hide a
 * script past the end, so a capped pass is a critical, never a quiet truncation. */
export const MAX_FILES = 400;
const FETCH_TIMEOUT_S = 15;

/** How long a run can last: its pages and files, each up to the fetch timeout, and a margin. A mark younger
 * than this may be a sibling run still working, not a dead one (a `*\/2` run can overlap the last). */
export const siteRunMaxS = (site: Pick<Config["site"], "pages">, filesPerRun: number): number => (site.pages.length + filesPerRun) * FETCH_TIMEOUT_S + 120;

export interface SiteProblem {
  file: string;
  kind: "too_large" | "killed" | "unreadable";
  detail: string;
}

interface Pass {
  startedAt: number;
  queue: string[];
  done: string[];
  /** each address and host named, with the first file it was seen in */
  addresses: Record<string, string>;
  hosts: Record<string, string>;
  /** each host a page loads a script from (a cross-origin <script src>, modulepreload or preload), with the page */
  scriptHosts?: Record<string, string>;
  /** scripts whose source is a data: or blob: URL ("data: URL"), with the page that loads them */
  embedded?: Record<string, string>;
  /** pages whose Content-Security-Policy header isn't the approved one, with how it differs */
  csp?: Record<string, string>;
  /** pages whose Content-Security-Policy differs from the approved one only in the inline scripts' hashes */
  cspHashes?: string[];
  problems: SiteProblem[];
  capped: boolean;
  /** each queued file with the [page, file] pairs it was reached from: the page, and the file of that page's
   * own HTML it came through (itself when the page names it, the script that names it otherwise) */
  refs?: Record<string, [string, string][]>;
  /** each page read again after one of its files was gone (once a pass): the files its current HTML names,
   * or null when it couldn't be read again */
  reread?: Record<string, string[] | null>;
  /** how many times each page was read again (at most 2 a pass) */
  rereadN?: Record<string, number>;
  /** files dropped this pass because the site was redeployed under it */
  dropped?: number;
}

export interface SiteResult {
  finishedAt: number;
  /** every file was read and scanned */
  complete: boolean;
  files: string[];
  /** an address or host named that isn't approved, a host a page loads a script from that isn't approved as a
   * script source (`script_host`), or a script from a data: or blob: URL (`script`, never approved) */
  unapproved: { kind: "address" | "host" | "script_host" | "script"; value: string; file: string }[];
  /** pages whose Content-Security-Policy header is missing or isn't the build's (out/_headers), with how */
  csp?: { page: string; detail: string }[];
  /** pages whose Content-Security-Policy differs from the build's only in the inline scripts' hashes: the
   * approved lists are older than the site deployed (a warning, site.stale_lists) */
  staleCsp?: string[];
  /** configured Cascade addresses found nowhere (judged on a complete pass only) */
  missing: string[];
  problems: SiteProblem[];
  /** more script files than a pass takes: the pass is incomplete, and it is a critical */
  capped: boolean;
  /** the approved lists are empty (not generated yet): nothing was judged against them */
  noApprovedLists?: boolean;
  /** files dropped this pass as gone with a redeployed build (not a finding by itself) */
  dropped?: number;
  /** passes in a row, this one included, that dropped files */
  raceStreak?: number;
}

/** What the live site is judged against (src/site-approved.ts, generated from the build deployed). */
export interface ApprovedLists {
  addresses: readonly string[];
  /** the only hosts a page may load a script from (a `*.domain` wildcard from a script-src matches below it) */
  scriptHosts: readonly string[];
  /** hosts the bundle merely names: approved as a mention, never as a script source */
  bundleHosts: readonly string[];
  /** each page's Content-Security-Policy policies (normalized, any order) */
  csp: Readonly<Record<string, readonly string[]>>;
}

const APPROVED: ApprovedLists = { addresses: APPROVED_ADDRESSES, scriptHosts: APPROVED_SCRIPT_HOSTS, bundleHosts: SEEN_IN_BUNDLE_HOSTS, csp: APPROVED_CSP };

export interface SiteJobOptions {
  db: D1Database;
  cfg: Pick<Config, "site" | "budgets" | "deployment">;
  fetch: typeof fetch;
  nowS: number;
  approved?: ApprovedLists;
  /** how a file's text is scanned (a test replaces it to simulate a file that kills a run) */
  scanText?: (text: string) => ScanResult;
  /** the most files a pass takes (MAX_FILES) */
  maxFiles?: number;
  /** the time a mark is written at, seconds (the Worker's clock; the run's start time by default) */
  clock?: () => number;
}

const json = <T>(s: string | undefined): T | undefined => {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};

async function readMeta(db: D1Database): Promise<Record<string, string>> {
  const rs = await db.prepare("SELECT k, v FROM meta WHERE k LIKE 'site\\_%' ESCAPE '\\'").all<{ k: string; v: string }>();
  return Object.fromEntries(rs.results.map((r) => [r.k, r.v]));
}

/** One site-check invocation: start a pass when it is due, then check up to SITE_FILES_PER_RUN files. */
export async function runSiteJob(o: SiteJobOptions): Promise<{ skipped: string } | { checked: number; finished: boolean }> {
  const { db, cfg, nowS } = o;
  const put = (k: string, v: string) => setMeta(db, k, v).run();
  const meta = await readMeta(db);
  const scan = o.scanText ?? scanScript;
  const maxFiles = o.maxFiles ?? MAX_FILES;
  const clock = o.clock ?? (() => nowS);
  const approved = o.approved ?? APPROVED;
  // lists not generated yet: judging against them would report everything, so nothing is judged
  const noApprovedLists =
    approved.addresses.length === 0 && approved.scriptHosts.length === 0 && approved.bundleHosts.length === 0 && Object.keys(approved.csp).length === 0;
  const get = async (path: string) =>
    o.fetch(new URL(path, cfg.site.url).toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_S * 1000), headers: { accept: "text/html, application/javascript, */*" } });
  const ok = async () => {
    if (meta.site_fail_since) {
      meta.site_fail_since = "";
      await put("site_fail_since", "");
    }
  };
  const failed = async () => {
    if (!meta.site_fail_since) {
      meta.site_fail_since = String(nowS);
      await put("site_fail_since", String(nowS));
    }
  };

  let pass = json<Pass>(meta.site_pass);
  const trying = json<{ file: string; at: number }>(meta.site_trying);
  if (trying) {
    if (nowS - trying.at < siteRunMaxS(cfg.site, cfg.budgets.siteFilesPerRun)) return { skipped: "another run is working" };
    // an earlier run died on this file (CPU, memory or wall time): skip it, report it, go on
    if (pass) {
      pass.queue = pass.queue.filter((f) => f !== trying.file);
      pass.problems.push({ file: trying.file, kind: "killed", detail: "it stopped a site-check invocation (CPU, memory or wall time)" });
    }
    await put("site_trying", "");
  }

  const add = (p: Pass, file: string, s: ScanResult) => {
    for (const a of s.addresses) p.addresses[a] ??= file;
    for (const h of s.hosts) p.hosts[h] ??= file;
    // a page names a chunk itself; a script passes on the pages it was reached from
    const via = (c: string): [string, string][] => (cfg.site.pages.includes(file) ? [[file, c]] : (p.refs?.[file] ?? []));
    for (const c of s.chunks) enqueue(p, c, via(c));
  };
  const enqueue = (p: Pass, file: string, from: [string, string][] = []) => {
    if (from.length > 0 && !p.done.includes(file)) {
      const have = ((p.refs ??= {})[file] ??= []);
      for (const f of from) if (!have.some((h) => h[0] === f[0] && h[1] === f[1])) have.push(f);
    }
    if (p.done.includes(file) || p.queue.includes(file)) return;
    if (p.done.length + p.queue.length >= maxFiles) {
      p.capped = true;
      return;
    }
    p.queue.push(file);
  };

  /** A page's response judged and read into the pass: its policy, its scripts and what its HTML names. Returns
   * the files its HTML names (undefined when it was over the byte cap). */
  const takePage = async (p: Pass, page: string, res: Response): Promise<string[] | undefined> => {
    // a page read again adds to what its first reading found, never replaces it: a bad policy or a foreign
    // script seen in either reading is judged
    // the policy the browser enforces on the page (it decides which scripts run), judged before the body is
    // read, so a page over the byte cap is judged on it too
    if (!noApprovedLists) {
      const want = approved.csp[page];
      const differs = want
        ? cspDifference(want, cspPolicies(res.headers.get("content-security-policy")))
        : { kind: "changed" as const, detail: "no approved policy: the build approved has no such page (pnpm site:approved on the build deployed)" };
      // only the inline scripts' hashes: a site deployed without new lists (a warning); anything else: a critical
      if (differs?.kind === "hashes") {
        if (!p.cspHashes?.includes(page)) (p.cspHashes ??= []).push(page);
      }
      else if (differs) (p.csp ??= {})[page] = differs.detail;
    }
    const r = await readCapped(res, cfg.budgets.siteMaxBytes);
    if ("tooLarge" in r) {
      p.problems.push({ file: page, kind: "too_large", detail: `over the byte cap (${cfg.budgets.siteMaxBytes} bytes)` });
      return undefined;
    }
    // the whole page: inline scripts, and addresses and hosts in attributes too
    const scanned = scan(r.text);
    add(p, page, scanned);
    const { srcs, foreignHosts, embedded } = pageScripts(r.text, cfg.site.url);
    for (const s of srcs) enqueue(p, s, [[page, s]]);
    // a script from elsewhere is never fetched: its host is judged as a script source (a mention isn't enough)
    for (const h of foreignHosts) (p.scriptHosts ??= {})[h] ??= page;
    // code from a data: or blob: URL comes from no host: named as what it is
    for (const e of embedded) (p.embedded ??= {})[e] ??= page;
    return [...srcs, ...scanned.chunks];
  };

  if (!pass) {
    const last = json<SiteResult>(meta.site_result);
    if (last && nowS - last.finishedAt < PASS_EVERY_S) return { checked: 0, finished: false };
    const p: Pass = { startedAt: nowS, queue: [], done: [], addresses: {}, hosts: {}, problems: [], capped: false };
    let answered = 0;
    for (const page of cfg.site.pages) {
      let res: Response | undefined;
      try {
        res = await get(page);
      } catch {
        res = undefined;
      }
      if (!res || !res.ok) {
        // one page that can't be read never stops the others being checked: it is named (site.unreachable)
        await res?.body?.cancel().catch(() => undefined);
        p.problems.push({ file: page, kind: "unreadable", detail: res ? `HTTP ${res.status}` : "no answer" });
        continue;
      }
      answered++;
      await takePage(p, page, res);
    }
    // not one page answered: the site is down (or unreachable from here); the next run tries again
    if (answered === 0) {
      await failed();
      return { checked: 0, finished: false };
    }
    await ok();
    pass = p;
  }

  /** A file came back 404 or 410. If every page it was reached from, read again (once a pass), no longer names
   * what led to it, the site was redeployed since the page was read (a new build has new file names): the file
   * is dropped with the others that went with that build, and the page's current files are queued. A page that
   * can't be read again, or still names it, leaves it a missing file, a broken site. */
  const goneWithTheBuild = async (p: Pass, file: string): Promise<boolean> => {
    const refs = p.refs?.[file] ?? [];
    if (refs.length === 0) return false;
    const reread = (p.reread ??= {});
    const counts = (p.rereadN ??= {});
    for (const page of new Set(refs.map((r) => r[0]))) {
      // read again once; a second time only when a file the first re-read named is gone too (a second redeploy)
      const named = refs.some((r) => r[0] === page && reread[page]?.includes(r[1]));
      if (page in reread && !(named && (counts[page] ?? 0) < 2)) continue;
      counts[page] = (counts[page] ?? 0) + 1;
      reread[page] = null;
      let res: Response | undefined;
      try {
        res = await get(page);
      } catch {
        res = undefined;
      }
      if (!res || !res.ok) {
        await res?.body?.cancel().catch(() => undefined);
        continue;
      }
      reread[page] = (await takePage(p, page, res)) ?? null;
    }
    const current = (r: [string, string]) => reread[r[0]] === null || reread[r[0]]?.includes(r[1]);
    if (refs.some(current)) return false;
    // everything still queued that came only through files the pages no longer name went with the old build
    const before = p.queue.length;
    p.queue = p.queue.filter((f) => f !== file && ((p.refs?.[f] ?? []).length === 0 || p.refs![f].some((r) => !(r[0] in reread) || current(r))));
    p.dropped = (p.dropped ?? 0) + (before - p.queue.length);
    console.log(`site check: ${file} is gone because the site was redeployed during the pass (${[...new Set(refs.map((r) => r[0]))].join(", ")} no longer name it); the pages' current files are checked`);
    return true;
  };

  let checked = 0;
  while (pass.queue.length > 0 && checked < cfg.budgets.siteFilesPerRun) {
    const file = pass.queue[0];
    // marked before fetching: a run that dies on this file leaves the mark for the next to find
    await put("site_trying", JSON.stringify({ file, at: clock() }));
    let res: Response | undefined;
    try {
      res = await get(file);
    } catch {
      res = undefined;
    }
    if (res && (res.status === 404 || res.status === 410) && (await goneWithTheBuild(pass, file))) {
      // the site was redeployed since this pass read the page: the file is gone because the page no longer
      // names it, and the page's current files are queued in its place
      await res.body?.cancel().catch(() => undefined);
      await put("site_trying", "");
      checked++;
      continue;
    }
    if (!res || !res.ok) {
      await res?.body?.cancel().catch(() => undefined);
      pass.problems.push({ file, kind: "unreadable", detail: res ? `HTTP ${res.status}` : "no answer" });
      await failed();
    } else {
      const r = await readCapped(res, cfg.budgets.siteMaxBytes);
      if ("tooLarge" in r) pass.problems.push({ file, kind: "too_large", detail: `over the byte cap (${cfg.budgets.siteMaxBytes} bytes): not scanned` });
      else {
        add(pass, file, scan(r.text));
        pass.done.push(file);
      }
      await ok();
    }
    pass.queue.shift();
    await put("site_trying", "");
    checked++;
  }

  if (pass.queue.length > 0) {
    await put("site_pass", JSON.stringify(pass));
    return { checked, finished: false };
  }
  const okAddresses = new Set(approved.addresses.map((a) => a.toLowerCase()));
  // a host may be named if the bundle names it or a page may load scripts from it; loaded from only if the latter
  const okNamed = [...approved.bundleHosts, ...approved.scriptHosts];
  const badScriptHosts = Object.entries(pass.scriptHosts ?? {}).filter(([h]) => !hostListed(approved.scriptHosts, h));
  // a host reported as a script source isn't reported again for the page naming it in that <script src>
  const reported = new Set(badScriptHosts.map(([h]) => h));
  const complete = pass.problems.length === 0 && !pass.capped;
  const d = cfg.deployment;
  const ours = [...new Set([d.frontDoor, d.staker, d.vault, d.baseAdapter, d.bitAdapter, d.oracle].map((a) => a.toLowerCase()))];
  const result: SiteResult = {
    finishedAt: nowS,
    complete,
    files: pass.done,
    unapproved: noApprovedLists
      ? []
      : [
          ...Object.entries(pass.addresses)
            .filter(([a]) => !okAddresses.has(a))
            .map(([value, file]) => ({ kind: "address" as const, value, file })),
          ...badScriptHosts.map(([value, file]) => ({ kind: "script_host" as const, value, file })),
          ...Object.entries(pass.hosts)
            .filter(([h]) => !reported.has(h) && !hostListed(okNamed, h))
            .map(([value, file]) => ({ kind: "host" as const, value, file })),
          ...Object.entries(pass.embedded ?? {}).map(([value, file]) => ({ kind: "script" as const, value, file })),
        ],
    csp: Object.entries(pass.csp ?? {}).map(([page, detail]) => ({ page, detail })),
    staleCsp: pass.cspHashes ?? [],
    missing: complete ? ours.filter((a) => pass.addresses[a] === undefined) : [],
    problems: pass.problems,
    capped: pass.capped,
    noApprovedLists,
    dropped: pass.dropped ?? 0,
    raceStreak: pass.dropped ? (json<SiteResult>(meta.site_result)?.raceStreak ?? 0) + 1 : 0,
  };
  await db.batch([setMeta(db, "site_result", JSON.stringify(result)), setMeta(db, "site_pass", "")]);
  return { checked, finished: true };
}

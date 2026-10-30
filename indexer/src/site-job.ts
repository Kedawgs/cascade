import type { Config } from "./config.ts";
import { hostListed, pageScripts, readCapped, type ScanResult, scanScript } from "./site.ts";
import { APPROVED_ADDRESSES, APPROVED_SCRIPT_HOSTS, SEEN_IN_BUNDLE_HOSTS } from "./site-approved.ts";
import { setMeta } from "./store.ts";

// The site check (spec 6.6), in its own cron every two minutes, never the tick: a tampered site could serve a
// huge or hostile file, and the worst it can do here is stop a site-check invocation. Its state lives in meta
// (its own small writes): the pass under way, the file being tried, and the last complete pass's result,
// which the tick turns into alerts. It sends no email and never touches the tick's lease.
//
// Cadence. The cron is how often a run may work, not how often the site is judged: a pass starts at the first
// run PASS_EVERY_S after the last pass finished, reads every page in SITE_PAGES in that first run, then
// SITE_FILES_PER_RUN scripts a run. The real build (8 pages, 32 scripts, 20 a run on Paid) is one pass of two
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
  problems: SiteProblem[];
  capped: boolean;
}

export interface SiteResult {
  finishedAt: number;
  /** every file was read and scanned */
  complete: boolean;
  files: string[];
  /** an address or host named that isn't approved, a host a page loads a script from that isn't approved as a
   * script source (`script_host`), or a script from a data: or blob: URL (`script`, never approved) */
  unapproved: { kind: "address" | "host" | "script_host" | "script"; value: string; file: string }[];
  /** configured Cascade addresses found nowhere (judged on a complete pass only) */
  missing: string[];
  problems: SiteProblem[];
  /** more script files than a pass takes: the pass is incomplete, and it is a critical */
  capped: boolean;
  /** the approved lists are empty (not generated yet): nothing was judged against them */
  noApprovedLists?: boolean;
}

/** What the live site is judged against (src/site-approved.ts, generated from the build deployed). */
export interface ApprovedLists {
  addresses: readonly string[];
  /** the only hosts a page may load a script from (a `*.domain` wildcard from a script-src matches below it) */
  scriptHosts: readonly string[];
  /** hosts the bundle merely names: approved as a mention, never as a script source */
  bundleHosts: readonly string[];
}

const APPROVED: ApprovedLists = { addresses: APPROVED_ADDRESSES, scriptHosts: APPROVED_SCRIPT_HOSTS, bundleHosts: SEEN_IN_BUNDLE_HOSTS };

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
    for (const c of s.chunks) enqueue(p, c);
  };
  const enqueue = (p: Pass, file: string) => {
    if (p.done.includes(file) || p.queue.includes(file)) return;
    if (p.done.length + p.queue.length >= maxFiles) {
      p.capped = true;
      return;
    }
    p.queue.push(file);
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
      const r = await readCapped(res, cfg.budgets.siteMaxBytes);
      if ("tooLarge" in r) {
        p.problems.push({ file: page, kind: "too_large", detail: `over the byte cap (${cfg.budgets.siteMaxBytes} bytes)` });
        continue;
      }
      // the whole page: inline scripts, and addresses and hosts in attributes too
      add(p, page, scan(r.text));
      const { srcs, foreignHosts, embedded } = pageScripts(r.text, cfg.site.url);
      for (const s of srcs) enqueue(p, s);
      // a script from elsewhere is never fetched: its host is judged as a script source (a mention isn't enough)
      for (const h of foreignHosts) (p.scriptHosts ??= {})[h] ??= page;
      // code from a data: or blob: URL comes from no host: named as what it is
      for (const e of embedded) (p.embedded ??= {})[e] ??= page;
    }
    // not one page answered: the site is down (or unreachable from here); the next run tries again
    if (answered === 0) {
      await failed();
      return { checked: 0, finished: false };
    }
    await ok();
    pass = p;
  }

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
  const approved = o.approved ?? APPROVED;
  // lists not generated yet: judging against them would report everything, so nothing is judged
  const noApprovedLists = approved.addresses.length === 0 && approved.scriptHosts.length === 0 && approved.bundleHosts.length === 0;
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
    missing: complete ? ours.filter((a) => pass.addresses[a] === undefined) : [],
    problems: pass.problems,
    capped: pass.capped,
    noApprovedLists,
  };
  await db.batch([setMeta(db, "site_result", JSON.stringify(result)), setMeta(db, "site_pass", "")]);
  return { checked, finished: true };
}

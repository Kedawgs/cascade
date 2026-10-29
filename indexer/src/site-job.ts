import type { Config } from "./config.ts";
import { pageScripts, readCapped, type ScanResult, scanScript } from "./site.ts";
import { APPROVED_ADDRESSES, APPROVED_HOSTS } from "./site-approved.ts";
import { setMeta } from "./store.ts";

// The site check (spec 6.6), in its own cron every two minutes, never the tick: a tampered site could serve a
// huge or hostile file, and the worst it can do here is stop a site-check invocation. Its state lives in meta
// (its own small writes): the pass under way, the file being tried, and the last complete pass's result,
// which the tick turns into alerts. It sends no email and never touches the tick's lease.

/** A run can last at most this long (files per run × the fetch timeout, and a margin): a mark younger than
 * this may be a sibling run still working, not a dead one (build note: a `*\/2` run can overlap the last). */
export const SITE_RUN_MAX_S = 300;
/** A new pass starts this long after the last one finished. */
const PASS_EVERY_S = 3600;
const MAX_FILES = 80;
const FETCH_TIMEOUT_MS = 15_000;

export interface SiteProblem {
  file: string;
  kind: "too_large" | "killed" | "unreadable";
  detail: string;
}

interface Pass {
  startedAt: number;
  queue: string[];
  done: string[];
  /** each address and host, with the first file it was seen in */
  addresses: Record<string, string>;
  hosts: Record<string, string>;
  problems: SiteProblem[];
  capped: boolean;
}

export interface SiteResult {
  finishedAt: number;
  /** every file was read and scanned */
  complete: boolean;
  files: string[];
  unapproved: { kind: "address" | "host"; value: string; file: string }[];
  /** configured Cascade addresses found nowhere (judged on a complete pass only) */
  missing: string[];
  problems: SiteProblem[];
  capped: boolean;
}

export interface SiteJobOptions {
  db: D1Database;
  cfg: Pick<Config, "site" | "budgets" | "deployment">;
  fetch: typeof fetch;
  nowS: number;
  approved?: { addresses: readonly string[]; hosts: readonly string[] };
  /** how a file's text is scanned (a test replaces it to simulate a file that kills a run) */
  scanText?: (text: string) => ScanResult;
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
  const get = async (path: string) => o.fetch(new URL(path, cfg.site.url).toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "text/html, application/javascript, */*" } });
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
    if (nowS - trying.at < SITE_RUN_MAX_S) return { skipped: "another run is working" };
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
    if (p.done.length + p.queue.length >= MAX_FILES) {
      if (!p.capped) console.warn(`site check: more than ${MAX_FILES} files; checking the first ${MAX_FILES}`);
      p.capped = true;
      return;
    }
    p.queue.push(file);
  };

  if (!pass) {
    const last = json<SiteResult>(meta.site_result);
    if (last && nowS - last.finishedAt < PASS_EVERY_S) return { checked: 0, finished: false };
    const p: Pass = { startedAt: nowS, queue: [], done: [], addresses: {}, hosts: {}, problems: [], capped: false };
    for (const page of cfg.site.pages) {
      let res: Response;
      try {
        res = await get(page);
      } catch {
        await failed();
        return { checked: 0, finished: false };
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        await failed();
        return { checked: 0, finished: false };
      }
      const r = await readCapped(res, cfg.budgets.siteMaxBytes);
      if ("tooLarge" in r) {
        p.problems.push({ file: page, kind: "too_large", detail: `over the byte cap (${cfg.budgets.siteMaxBytes} bytes)` });
        continue;
      }
      const { inline, srcs } = pageScripts(r.text);
      for (const s of inline) add(p, `${page} (inline script)`, scan(s));
      for (const s of srcs) enqueue(p, s);
    }
    await ok();
    pass = p;
  }

  let checked = 0;
  while (pass.queue.length > 0 && checked < cfg.budgets.siteFilesPerRun) {
    const file = pass.queue[0];
    // marked before fetching: a run that dies on this file leaves the mark for the next to find
    await put("site_trying", JSON.stringify({ file, at: nowS }));
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
  const approved = o.approved ?? { addresses: APPROVED_ADDRESSES, hosts: APPROVED_HOSTS };
  const okAddresses = new Set(approved.addresses.map((a) => a.toLowerCase()));
  const okHosts = new Set(approved.hosts.map((h) => h.toLowerCase()));
  const complete = pass.problems.length === 0;
  const d = cfg.deployment;
  const ours = [...new Set([d.frontDoor, d.staker, d.vault, d.baseAdapter, d.bitAdapter, d.oracle].map((a) => a.toLowerCase()))];
  const result: SiteResult = {
    finishedAt: nowS,
    complete,
    files: pass.done,
    unapproved: [
      ...Object.entries(pass.addresses)
        .filter(([a]) => !okAddresses.has(a))
        .map(([value, file]) => ({ kind: "address" as const, value, file })),
      ...Object.entries(pass.hosts)
        .filter(([h]) => !okHosts.has(h))
        .map(([value, file]) => ({ kind: "host" as const, value, file })),
    ],
    missing: complete ? ours.filter((a) => pass.addresses[a] === undefined) : [],
    problems: pass.problems,
    capped: pass.capped,
  };
  await db.batch([setMeta(db, "site_result", JSON.stringify(result)), setMeta(db, "site_pass", "")]);
  return { checked, finished: true };
}

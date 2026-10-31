import { type Hex, keccak256, toBytes } from "viem";
import { type Finding, markSent, reconcile } from "./alerts.ts";
import { type ChainName, type Config, hostDomain, rolesOf, scanAddresses } from "./config.ts";
import { type AlertItem, type Outgoing, renderCritical, renderWarnings, sendAll } from "./email.ts";
import { decode, identify, type RawLog } from "./logs.ts";
import { CONTRACT_NAMES, txLink } from "./rules/context.ts";
import { Budget, createRpc } from "./rpc.ts";
import { REREAD, SETTLE, WINDOW } from "./scan.ts";
import { type AlertRow, alertOf, returnedIds, setMeta } from "./store.ts";

// The hourly cross-validation of the logs (the pen test's MON-1): the tick reads each chain's logs through one
// RPC, and a node that omits a watched log blinds the monitor without any lag, blind or reorg signal. Every hour
// a second, independent endpoint per chain (another provider: BASE_LOGS_RPC_URL_2, BITTENSOR_RPC_URL_2, or their
// _SECRET) re-reads the newest settled range of the watched addresses, and its logs are compared, by the same uid
// the scan gives them, with what the store holds for that range. A log the second serves and the store lacks is
// the critical indexer.logs_omitted (the primary omitted a watched event); a stored log the second, REREAD blocks
// past it, doesn't serve is the warning indexer.logs_extra. One alert per chain, the logs listed in its facts,
// raised and re-sent by this job and resolved by it once the store holds every omitted log (the tick leaves these
// two rules' alerts alone). Only blocks the tick has itself re-read from a node REREAD past them are judged, so
// the primary's log index lagging its head is never read as an omission. A second endpoint that fails is noted in
// meta, and the tick's indexer.unverified warns once it has failed for logsCheckUnverifiedS. The cost is bounded:
// at most logsCheck{Base,Bittensor}Blocks per chain per run, in the chain's windows, within LOGS_CHECK_BUDGET
// requests.

export interface LogsCheckDeps {
  env: { DB: D1Database; EMAIL?: SendEmail };
  cfg: Config;
  nowS: number;
  fetch: typeof fetch;
  /** the RPC client's clock and sleep (tests inject theirs: a retry's backoff is real otherwise) */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Requests the whole run may make (both chains, retries included). */
export const LOGS_CHECK_BUDGET = 12;
/** The windows the second endpoints are asked in (Base's from BASE_LOG_WINDOW at run time). */
export const LOGS_CHECK_WINDOW: Record<ChainName, bigint> = { base: WINDOW.base, bittensor: WINDOW.bittensor };
/** At most this many mismatched logs are listed in a chain's alert; the counts say the rest. */
const MAX_FINDINGS = 20;
/** The omitted uids kept (meta logs_omitted_uids:{chain}) until the store has them all, at most. */
const MAX_TRACKED = 100;
const OMITTED_UIDS = "logs_omitted_uids:";
const RUN_MS = 120_000;
const TIMEOUT_MS = 15_000;

/** What a run did on a chain: the range compared and the counts, or why nothing was compared. */
export type ChainCheck = { from: bigint; to: bigint; primary: number; second: number; omitted: number; extra: number } | "behind" | "failed" | "catching up" | "no cursor";
/** The run's wall time at most, and each request's (OnFinality's public Bittensor node answers in 1.3-5 s). */
export type LogsCheckResult = Record<ChainName, ChainCheck>;

const CHAINS: readonly ChainName[] = ["bittensor", "base"];
const NAMES: Record<ChainName, string> = { base: "Base", bittensor: "Bittensor" };
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const num = (s: string | undefined) => (s === undefined || s === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));
const json = <T>(s: string | undefined): T | undefined => {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
/** The hash of a set of uids, for the facts. */
const hashOf = (uids: Iterable<Hex>) => keccak256(toBytes([...uids].sort().join(","))).slice(0, 10);

type Row = Record<string, unknown>;

/** The hourly cross-check: the newest settled range of each chain re-read through the second endpoint and compared
 * with the store; mismatches raised as alerts (and emailed) by this job, as the watchdog does; where it got to
 * (meta logs_check_to:{chain}) and whether the endpoint answered (meta logs_check_fail_since:{chain},
 * logs_check_error:{chain}) recorded. Never throws: a chain that can't be checked says why in the result. */
export async function runLogsCheck(deps: LogsCheckDeps): Promise<LogsCheckResult> {
  const { cfg, nowS } = deps;
  const db = deps.env.DB;
  const t = cfg.thresholds;
  const result = { base: "no cursor", bittensor: "no cursor" } as LogsCheckResult;
  let settled: Partial<Record<ChainName, bigint>>;
  let meta: Record<string, string>;
  let open: AlertRow[];
  try {
    const rs = await db.batch<Row>([
      db.prepare("SELECT chain, settled_to FROM cursors"),
      db.prepare("SELECT k, v FROM meta WHERE k IN ('catching_up', 'last_warning_at') OR k LIKE 'logs_check_%' OR k LIKE 'logs_omitted_uids:%'"),
      db.prepare("SELECT * FROM alerts WHERE rule IN ('indexer.logs_omitted', 'indexer.logs_extra') AND resolved_at IS NULL ORDER BY id"),
    ]);
    settled = Object.fromEntries(rs[0].results.map((r) => [r.chain as ChainName, BigInt(r.settled_to as number)]));
    meta = Object.fromEntries(rs[1].results.map((r) => [r.k as string, r.v as string]));
    open = rs[2].results.map(alertOf);
  } catch (e) {
    console.error(`logs check: the database can't be read: ${message(e)}`);
    return result;
  }
  const writes: D1PreparedStatement[] = [];

  // an omission alert heals once the store has every log it named (a re-read found them, or the owner added
  // them): resolved here, since the tick leaves this job's alerts alone
  for (const chain of CHAINS) {
    const alert = open.find((a) => a.alertKey === `indexer.logs_omitted:${chain}`);
    const uids = json<Hex[]>(meta[`${OMITTED_UIDS}${chain}`]) ?? [];
    if (!alert || uids.length === 0) continue;
    try {
      const have = await db.prepare("SELECT COUNT(*) AS n FROM logs WHERE chain = ?1 AND removed = 0 AND uid IN (SELECT value FROM json_each(?2))").bind(chain, JSON.stringify(uids)).first<number>("n");
      if (Number(have) >= uids.length) {
        writes.push(db.prepare("UPDATE alerts SET resolved_at = ?1 WHERE id = ?2").bind(nowS, alert.id), setMeta(db, `${OMITTED_UIDS}${chain}`, ""));
        open = open.filter((a) => a.id !== alert.id);
        result[chain] = "no cursor";
      }
    } catch (e) {
      console.error(`logs check: the omitted ${chain} logs couldn't be looked up: ${message(e)}`);
    }
  }

  const budget = new Budget(LOGS_CHECK_BUDGET);
  const now = deps.now ?? Date.now;
  const rpc = createRpc({
    urls: { base: cfg.rpc.base, baseLogs: cfg.rpc.baseLogs2, bittensor: cfg.rpc.bittensor2 },
    fetch: deps.fetch,
    budget,
    retries: 1,
    timeoutMs: TIMEOUT_MS,
    deadlineMs: now() + RUN_MS,
    now,
    sleep: deps.sleep,
  });
  const roleOf = rolesOf(cfg.deployment, cfg.bridges);
  const addresses = scanAddresses(cfg);
  const catchingUp = (meta.catching_up ?? "").split(",").filter(Boolean);
  const findings: Finding[] = [];

  for (const chain of CHAINS) {
    // only blocks the tick has re-read from a node REREAD past them: a log still missing there isn't the primary's
    // log index lagging its head (which the next tick's re-read would have added), it is omitted
    const to = settled[chain] === undefined ? undefined : (settled[chain] as bigint) - REREAD[chain];
    const start = cfg.deployment[chain].startBlock;
    if (to === undefined || to < start) continue;
    if (catchingUp.includes(chain)) {
      result[chain] = "catching up";
      continue;
    }
    const cap = BigInt(chain === "base" ? t.logsCheckBaseBlocks : t.logsCheckBittensorBlocks);
    const last = meta[`logs_check_to:${chain}`];
    const from = max(max(last ? BigInt(last) + 1n : start, to - cap + 1n), start);
    if (from > to) {
      result[chain] = { from, to, primary: 0, second: 0, omitted: 0, extra: 0 };
      continue;
    }
    const window = chain === "base" ? cfg.baseLogWindow : LOGS_CHECK_WINDOW.bittensor;
    const primaryUrl = chain === "base" ? cfg.rpc.baseLogs : cfg.rpc.bittensor;
    const secondUrl = chain === "base" ? cfg.rpc.baseLogs2 : cfg.rpc.bittensor2;

    // the second endpoint's logs, window by window, each accepted only from a node settled past its end; the
    // lowest head that answered says how far past the range the second node is
    const second: RawLog[] = [];
    let checkedTo: bigint | undefined;
    let lowestHead: bigint | undefined;
    try {
      for (let a = from; a <= to; a = checkedTo + 1n) {
        const b = min(a + window - 1n, to);
        const r = await rpc.logsWithHead(chain, { address: addresses[chain], fromBlock: a, toBlock: b });
        if (r.head < b + SETTLE[chain]) break;
        second.push(...r.logs);
        lowestHead = lowestHead === undefined ? r.head : min(lowestHead, r.head);
        checkedTo = b;
      }
    } catch (e) {
      const why = message(e);
      console.warn(`logs check: ${chain}'s second endpoint failed: ${why}`);
      if (!num(meta[`logs_check_fail_since:${chain}`])) writes.push(setMeta(db, `logs_check_fail_since:${chain}`, String(nowS)));
      writes.push(setMeta(db, `logs_check_error:${chain}`, why.slice(0, 200)));
      result[chain] = "failed";
      continue;
    }
    if (num(meta[`logs_check_fail_since:${chain}`])) writes.push(setMeta(db, `logs_check_fail_since:${chain}`, ""));
    if (checkedTo === undefined || lowestHead === undefined) {
      result[chain] = "behind";
      continue;
    }

    // what the store holds for the range
    let stored: Row[];
    try {
      stored = (
        await db
          .prepare("SELECT uid, block, log_index, tx_hash, contract, event FROM logs WHERE chain = ?1 AND block BETWEEN ?2 AND ?3 AND removed = 0 ORDER BY block, log_index")
          .bind(chain, Number(from), Number(checkedTo))
          .all<Row>()
      ).results;
    } catch (e) {
      console.error(`logs check: the stored ${chain} logs can't be read: ${message(e)}`);
      continue;
    }
    const storedUids = new Set(stored.map((r) => r.uid as Hex));
    // the second's logs, by the uid the scan would give them (its own identity scheme), those at watched addresses
    const secondLogs = identify(chain, second).flatMap((x) => {
      const log = decode(chain, x, roleOf);
      return log ? [log] : [];
    });
    const secondUids = new Set(secondLogs.map((l) => l.uid));
    const omitted = secondLogs.filter((l) => !storedUids.has(l.uid));
    // an absence counts only from a node REREAD blocks past the log (the scan's rule for trusting one)
    const extra = stored.filter((r) => !secondUids.has(r.uid as Hex) && lowestHead >= BigInt(r.block as number) + REREAD[chain]);

    const common = {
      chain,
      chainName: NAMES[chain],
      range: `${from}-${checkedTo}`,
      primary: `${stored.length} logs, hash ${hashOf(storedUids)}`,
      second: `${secondUids.size} logs, hash ${hashOf(secondUids)}`,
      "primary endpoint": hostDomain(primaryUrl),
      "second endpoint": hostDomain(secondUrl),
    };
    const eventOf = (contract: string, event: string) => `${CONTRACT_NAMES[contract as keyof typeof CONTRACT_NAMES] ?? contract} ${event}`;
    const listed = (logs: { contract: string; event: string; block: bigint | number; txHash: Hex }[]) =>
      Object.fromEntries(logs.slice(0, MAX_FINDINGS).map((l, i) => [`log ${i + 1}`, `${eventOf(l.contract, l.event)}, block ${l.block}, ${txLink(chain, l.txHash)}`]));
    const andMore = (n: number) => (n > 1 ? ` and ${n - 1} more` : "");
    // one alert per chain (a lying primary can't send one critical per log): its logs are in the facts, and
    // the omitted uids are kept in meta, so the alert is resolved once the store has them all
    if (omitted.length) {
      const first = omitted[0];
      findings.push({
        rule: "indexer.logs_omitted",
        key: `indexer.logs_omitted:${chain}`,
        subject: `The ${NAMES[chain]} logs RPC omitted ${omitted.length} watched event${omitted.length === 1 ? "" : "s"}: ${eventOf(first.contract, first.event)}${andMore(omitted.length)}`,
        facts: { ...common, omitted: `${omitted.length} of the ${secondUids.size} logs the second served`, ...listed(omitted) },
      });
      const known = json<Hex[]>(meta[`${OMITTED_UIDS}${chain}`]) ?? [];
      writes.push(setMeta(db, `${OMITTED_UIDS}${chain}`, JSON.stringify([...new Set([...known, ...omitted.map((l) => l.uid)])].slice(-MAX_TRACKED))));
    }
    if (extra.length) {
      const first = extra[0];
      findings.push({
        rule: "indexer.logs_extra",
        key: `indexer.logs_extra:${chain}`,
        subject: `The second ${NAMES[chain]} RPC lacks ${extra.length} log${extra.length === 1 ? "" : "s"} the ${NAMES[chain]} logs RPC served: ${eventOf(first.contract as string, first.event as string)}${andMore(extra.length)}`,
        facts: { ...common, lacking: `${extra.length} of the ${stored.length} logs stored`, ...listed(extra.map((r) => ({ contract: r.contract as string, event: r.event as string, block: r.block as number, txHash: r.tx_hash as Hex }))) },
      });
    }
    writes.push(setMeta(db, `logs_check_to:${chain}`, String(checkedTo)), setMeta(db, `logs_check_at:${chain}`, String(nowS)));
    result[chain] = { from, to: checkedTo, primary: stored.length, second: secondUids.size, omitted: omitted.length, extra: extra.length };
  }

  // the alerts, as the watchdog raises its own: opened or kept here, and re-sent here while unacknowledged (the
  // tick leaves this job's alerts alone)
  const r = reconcile(db, { open, findings, nowS, t, holdActive: false, lastWarningSentAt: num(meta.last_warning_at) });
  if (writes.length === 0 && r.statements.length === 0) return result;
  let ids: ReturnType<typeof returnedIds>;
  try {
    ids = returnedIds(await db.batch([...writes, ...r.statements]));
  } catch (e) {
    console.error(`logs check: the results couldn't be recorded: ${message(e)}`);
    return result;
  }
  if (r.due.length === 0) return result;
  const itemOf = (d: (typeof r.due)[number]): AlertItem => ({ due: d, alertId: ids.alerts.get(d.key) ?? open.find((a) => a.alertKey === d.key)?.id });
  const criticals = r.due.filter((d) => d.tier === "critical");
  const warnings = r.due.filter((d) => d.tier === "warning");
  const outgoing: Outgoing[] = criticals.map((d, i) => ({ id: i, ...renderCritical(itemOf(d)) }));
  if (warnings.length) outgoing.push({ id: criticals.length, ...renderWarnings(warnings.map(itemOf)) });
  const sent = await sendAll(deps.env, cfg, outgoing);
  const sentDues = [...criticals.filter((_, i) => sent.sent.includes(i)), ...(sent.sent.includes(criticals.length) ? warnings : [])];
  if (sentDues.length) {
    try {
      await db.batch(markSent(db, sentDues, nowS));
    } catch (e) {
      console.error(`logs check: the emails couldn't be marked sent: ${message(e)}`);
    }
  }
  return result;
}

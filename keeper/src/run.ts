import { type Address, type Hex, hexToNumber } from "viem";
import type { DeploymentV32 } from "../../ops/src/keeper/core/deployment.ts";
import { chainLabel, SendRefused } from "../../ops/src/keeper/core/errors.ts";
import { type MonitorClient, monitorOverHttp } from "../../ops/src/keeper/core/hold.ts";
import { oneLine, scrubSecrets } from "../../ops/src/keeper/core/failures.ts";
import type { JournalRow } from "../../ops/src/keeper/core/journal.ts";
import { encodeMemory, fromJson, type KeeperMemory, loadMemory, MemoryTooNew, toJson } from "../../ops/src/keeper/core/memory.ts";
import { REPLACE_AFTER_MS, roundDue, runRound } from "../../ops/src/keeper/core/round.ts";
import { type Rpc, RpcError } from "../../ops/src/keeper/core/rpc.ts";
import type { ChainName, Sent } from "../../ops/src/keeper/core/types.ts";
import { targetV32 } from "../../ops/src/keeper/core/v32/actions.ts";
import { depsV32, type KeeperDepsV32 } from "../../ops/src/keeper/core/v32/reads.ts";
import { CHAIN_LEGACY, CLAIM_POLICY, CRON_LEASE_MS, coordinatorOf, type KeeperConfig, type KeeperEnv, LOOKUP_WINDOWS_PER_RUN, MULTICALL3, READ_DEADLINE_MS, RECEIPT_POLL_MS, RECEIPT_WAIT_MS, readConfig, SEND_WINDOW_MS } from "./config.ts";
import type { Acquired, Commit, Control, Fenced } from "./coordinator.ts";
import { type JournalStub, NotSent, runJournal } from "./journal.ts";
import { type PooledTx, poolMatches, type ProofCtx, rowProblem, type StoredRow } from "./proof.ts";
import { BudgetSpent, freshLearned, type Learned, LeaseGone, type Meter, ReadDeadline, REQUEST_TIMEOUT_MS, RESERVE, runRpc, SEND_NEEDS, withTimeout } from "./rpc.ts";
import { KeyProblem, keeperKey } from "./signer.ts";

// One cron run (design-keeper-worker.md §5): take the lease and load the memory and the unsettled journal rows in one
// call; stop early when the kill switch is on or the back-off says the round isn't due; settle the rows a cut-off run
// left; run the core's runRound once; commit the memory and the journal's changes, fenced by the lease, and release it.
// Every send renews the lease first and starts only within the run's first 45 s.

/** The run is past its send window (45 s): the send isn't started, and the next run decides. An RPC-like wait (the
 * reads took that long), never a refusal of the action. */
export class OutOfTime extends RpcError {}

/** What the run keeps besides the core's memory: the reads it batches, and the write-aheads no node knew last run. */
interface HostState {
  learned: Learned;
  unseen: Record<string, number>;
}

/** The coordinator's methods a run calls (tests wrap them, to cut a run off at a chosen point). */
export interface CoordinatorApi extends JournalStub {
  acquire(req: { holder: string; kind: "cron" | "hand"; ttlMs: number; load?: boolean }): Promise<Acquired>;
  renew(req: { holder: string; token: number; ttlMs: number }): Promise<Fenced>;
  release(req: { holder: string; token: number }): Promise<Fenced>;
  commit(req: Commit): Promise<Fenced>;
  /** The kill switch on (unfenced: a stop only makes things safer) */
  stop(req: { reason: string; by: string }): Promise<unknown>;
}

export interface RunOptions {
  /** The round's clock (ms) and its wait: tests set them */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  holder?: string;
  leaseMs?: number;
  coordinator?: (env: KeeperEnv, name: string) => CoordinatorApi;
  /** Where every line goes besides the run's own list (default console.log) */
  print?: (line: string) => void;
  fetch?: typeof fetch;
  /** The monitor the rails read (tests: the fake world's); default: the MONITOR service binding, none without it */
  monitor?: MonitorClient | null;
  /** Tests: a change to the deps before the round (a stop landing mid-round, say) */
  wrapDeps?: (deps: KeeperDepsV32) => void;
  /** How long one request may take (default REQUEST_TIMEOUT_MS, 20 s): tests shorten it */
  requestTimeoutMs?: number;
}

export type Outcome = "not-configured" | "stopped" | "held" | "not-due" | "memory-too-new" | "ran" | "lease-lost" | "failed";

export interface RunReport {
  outcome: Outcome;
  lines: string[];
  token?: number;
  meter?: Meter;
  /** The coordinator calls the run made */
  calls: number;
  stoppedItself?: string;
  batches?: { batches: number; answered: number; direct: number };
}

/** The lines the runs table keeps besides the run's summary (design §4: every loud line; Task 53: the hotkey watch's and the
 * buffer rule's; Task 65: each claim's and payout's GAS USED, the gas record the settings are tuned from; R12d: the spend
 * cap's, SPEND CAP and SPEND CAP ROOM, each said once a change; R12g: a quiet skip's reason, "Skipped this round (…): …",
 * since the round's summary, its last line, names only that the close waits, and a reverted close's skip carries its
 * transaction). */
const LOUD =
  /^(JOURNAL ROW REFUSED|Stopped|STOPPED|THE KEEPER|STILL|SKIPPING|Skipped this round|DELIVERY HELD|REPLACING|NO RECEIPT|NEVER SENT|FINAL|REPORT|SENT, BUT NOT SAVED|LEASE|NOT RUNNING|Late receipt|Replaced|Watch ended|Settling|CCIP FAILURE|REEXEC|PARK|MIGRATION NOTICE|HELD|STAKE MISSING|Stake is no longer missing|UNLISTED STAKE|Unlisted stake|ROOT HOLD|Hotkey 0x|GAS USED|SPEND CAP)/;

const receiptOf = async (rpc: Rpc, chain: ChainName, hash: Hex) =>
  (await rpc.request(chain, "eth_getTransactionReceipt", [hash])) as { status: Hex; blockNumber: Hex; gasUsed: Hex; effectiveGasPrice: Hex; to?: Address | null; logs?: Sent["logs"] } | null;

/** One cron run. Never throws: whatever happens is in the report and the log. */
export async function cronRun(env: KeeperEnv, o: RunOptions = {}): Promise<RunReport> {
  const now = o.now ?? Date.now;
  const started = now();
  const print = o.print ?? ((l: string) => console.log(l));
  const lines: string[] = [];
  let redact = (t: string) => t;
  const log = (line: string) => {
    const clean = redact(scrubSecrets(line));
    lines.push(clean);
    print(clean);
  };
  let calls = 0;
  const counted = <T>(p: Promise<T>) => {
    calls++;
    return p;
  };

  const { config: cfg, problems } = readConfig(env);
  let key: ReturnType<typeof keeperKey> | undefined;
  try {
    key = keeperKey(env.KEEPER_PRIVATE_KEY);
    redact = key.redact;
  } catch (e) {
    if (!(e instanceof KeyProblem)) throw e;
    problems.push(e.message);
  }
  if (!cfg || !key) {
    log(`NOT RUNNING: ${problems.join("; ")}`);
    return { outcome: "not-configured", lines, calls };
  }
  const d = cfg.deployment;
  const stub = o.coordinator ? o.coordinator(env, d.name) : (coordinatorOf(env, d.name) as unknown as CoordinatorApi);
  /** The lease once granted: released if anything below throws (the review's Minor 5) */
  let held: { holder: string; token: number } | undefined;
  const inner = async (): Promise<RunReport> => {
  const holder = o.holder ?? `cron:${crypto.randomUUID()}`;
  const leaseMs = o.leaseMs ?? CRON_LEASE_MS;
  const got = await counted(stub.acquire({ holder, kind: "cron", ttlMs: leaseMs, load: true }));
  if (!got.granted) {
    if (got.why === "stopped") log(`Not run: the keeper is stopped (${got.control.reason ?? "no reason given"}${got.control.by ? `, by ${got.control.by}` : ""})`);
    else if (got.why === "wanted") log(`Not run: a hand run (${got.holder}) is waiting for the lease`);
    else log(`Not run: ${got.kind === "hand" ? "a hand run" : "another cron run"} (${got.holder}) holds the lease until ${new Date(got.until).toISOString()}`);
    return { outcome: got.why === "stopped" ? "stopped" : "held", lines, calls };
  }
  const token = got.token;
  const lease = { holder, token };
  held = lease;
  const done = async (c: Omit<Commit, "holder" | "token">): Promise<Fenced> => counted(stub.commit({ ...lease, ...c }));

  let memory: KeeperMemory;
  try {
    const loaded = loadMemory(got.load?.memory);
    memory = loaded.memory;
    if (loaded.reset === "older") log("The saved memory is an older version: this run starts with a fresh one (holds and revert budgets reset, as a restart does); the journal is kept");
  } catch (e) {
    if (!(e instanceof MemoryTooNew)) throw e;
    log(`NOT RUNNING: ${e.message}`);
    await done({ lines: lines.filter((l) => LOUD.test(l)), release: true });
    return { outcome: "memory-too-new", lines, token, calls };
  }
  if (!roundDue(memory, now())) {
    log(`Not due: the back-off holds the next round until ${new Date(memory.nextAt).toISOString()}`);
    await counted(stub.release(lease));
    return { outcome: "not-due", lines, token, calls };
  }

  const host: HostState = { learned: freshLearned(), unseen: {}, ...(got.load?.host ? fromJson<Partial<HostState>>(got.load.host) : {}) };
  /** The lease renewed (each phase of the round, every quarter of its length while it reads, before every send): a refused
   * renew ends the run's reads and sends (LeaseGone) */
  let renewedAt = now();
  const renew = async (what: string) => {
    const r = await counted(stub.renew({ ...lease, ttlMs: leaseMs }));
    renewedAt = now();
    if (!r.ok) throw new LeaseGone(`${what}: the lease is no longer this run's (${r.why}); nothing more is read or sent`);
  };
  /** Before every request: the run's 90 s for reading, and the lease kept as the round reads. Not before a broadcast (the
   * re-review's N4): it comes right after its write-ahead, which the object took only on this run's valid lease (and, for
   * a cron, with the kill switch off), so a transaction signed and written ahead always goes out, and its row's "sent"
   * is true; a send in flight finishes. */
  const guard = async (chain: ChainName, method: string) => {
    if (method === "eth_sendRawTransaction") return;
    if (now() - started >= READ_DEADLINE_MS) throw new ReadDeadline(`the run's ${READ_DEADLINE_MS / 1000} s for reading are up: ${chain} ${method} not asked; the next run reads on`);
    if (now() - renewedAt >= leaseMs / 4) await renew(`${chain} ${method} not asked`);
  };
  const timeoutMs = o.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const { rpc, logs, meter, batches } = runRpc(cfg, { fetch: o.fetch, learned: host.learned, now, log, multicall3: MULTICALL3, guard, requestTimeoutMs: timeoutMs });
  // the monitor through its service binding, one way (design §6), each request counted as a subrequest and given up if
  // it hangs
  const binding = env.MONITOR;
  const viaBinding = binding ? withTimeout((input, init) => binding.fetch(input as string | URL | Request, init), timeoutMs, () => "the monitor's status") : undefined;
  const monitor =
    o.monitor !== undefined
      ? o.monitor
      : viaBinding
        ? monitorOverHttp("https://cascade-indexer.internal", {
            fetch: async (input, init) => {
              await guard("base", "the monitor's status");
              meter.count++;
              meter.byMethod.monitor = (meter.byMethod.monitor ?? 0) + 1;
              return viaBinding(input as string | URL | Request, init);
            },
          })
        : null;
  const pending = fromJson<StoredRow[]>(got.load?.pending ?? "[]");
  const j = runJournal({ writeAhead: (r) => counted(stub.writeAhead(r)), replaced: (r) => counted(stub.replaced(r)), update: (r) => counted(stub.update(r)), since: (r) => counted(stub.since(r)) }, lease, pending, log);
  const deployment: DeploymentV32 = d;
  const deps = depsV32({
    rpc,
    logs,
    logsWindow: { base: cfg.baseLogWindow },
    deployment,
    signer: key.signer,
    send: {
      chains: { base: { chainId: d.chainIds.base, legacy: CHAIN_LEGACY.base }, bittensor: { chainId: d.chainIds.bittensor, legacy: CHAIN_LEGACY.bittensor } },
      maxGasPrice: cfg.maxGasPrice,
      receiptTimeoutMs: RECEIPT_WAIT_MS,
      pollMs: RECEIPT_POLL_MS,
      now,
      ...(o.sleep ? { sleep: o.sleep } : {}),
    },
    journal: j.journal,
    memory,
    // the rails (Task 50a): the monitor (a hold, or a monitor that can't see, stops everything), the deliveries switch
    // from the control row; the Worker never carries an outage override, nor a hold file
    rails: { monitor, deliveriesOn: got.control.deliveries },
    log,
    // a lookup by id reads its share of the run, and on next run (Task 52w)
    lookupWindows: LOOKUP_WINDOWS_PER_RUN,
  });

  let report: RunReport = { outcome: "ran", lines, token, calls, meter, batches: batches.stats };
  try {
    // the rows a run cut off left: watched by the core from now, or held, or never sent (design §5)
    // the Worker's own key (R4, D-M1): after a rotation DEPLOYMENT's keeper is the plan's first, and readiness holds the key
    // to keeper() on both contracts; its rows are proven by it, and only its own transactions are replaced
    const me = key.address;
    const proof: ProofCtx = { keeper: me, chainIds: d.chainIds, legacy: CHAIN_LEGACY };
    const s = await settle(j.rows, memory, rpc, host, j.journal, log, d, proof);
    // then the core's own settling (Task 50a: a receipt settles a row at its cost, a nonce passed with none drops it),
    // the rule the spend cap and the send path keep too; the rows settle adopted into the watch first, so a late receipt
    // is still reported, its bridge message recorded and a delivery's revert counted by the round
    await deps.settleJournal();

    /** Before every send and replacement: the run's send window, a chain held by an unsettled write-ahead, then the
     * lease renewed (a refused renew ends the send before anything is signed: a lost lease, or the kill switch). */
    const beforeSend = async (chain: ChainName, label: string) => {
      if (s.held.has(chain)) {
        throw new SendRefused("waiting", `${chainLabel(chain)}: a transaction a cut-off run wrote ahead is not settled yet; ${label} not sent, and nothing is sent on ${chainLabel(chain)} this run`);
      }
      if (now() - started > SEND_WINDOW_MS) throw new OutOfTime(`the run is past its ${SEND_WINDOW_MS / 1000} s send window: ${label} not sent; the next run decides`);
      const left = meter.budget + RESERVE - meter.count;
      if (left < SEND_NEEDS) throw new BudgetSpent(`only ${left} RPC requests are left this run, fewer than a send needs (about ${SEND_NEEDS}): ${label} not sent; the next run sends`);
      const r = await counted(stub.renew({ ...lease, ttlMs: leaseMs }));
      renewedAt = now();
      if (!r.ok) throw new NotSent(`${label} not sent: ${r.why}`);
    };
    const sendCall = deps.sendCall;
    deps.sendCall = async (req) => {
      await beforeSend(req.chain, req.label);
      return sendCall(req);
    };
    const replace = deps.replace;
    if (replace) {
      // the core's options passed on as they are (T51 re-review R1): `cancel`, for a claim (never fee-bumped) and for any
      // stuck send on a chain at its spend cap, makes the replacement the 21,000-gas cancel at its nonce, which passes the
      // cap but never a hold; dropped here, a stuck claim would be re-sent at a higher fee, and nothing could pass the cap
      deps.replace = async (req, hashes, opts) => {
        await beforeSend(req.chain, opts?.cancel ? `the cancel of ${req.label}` : `the replacement of ${req.label}`);
        // the transaction a replacement would take the place of (the newest still pooled, as replaceRaw picks it) must be
        // the request itself, or the keeper's cancel at its nonce: anything else is never replaced
        for (const h of [...hashes].reverse()) {
          const tx = (await rpc.request(req.chain, "eth_getTransactionByHash", [h])) as PooledTx | null;
          if (!tx) continue;
          if (tx.blockNumber !== null) break;
          if (tx.from.toLowerCase() === me.toLowerCase() && hexToNumber(tx.nonce) === req.nonce && !poolMatches(tx, req, me)) {
            return { replaced: false, reason: `transaction ${h} at nonce ${req.nonce} is not ${req.label} (its call differs): it is never replaced` };
          }
          break;
        }
        return replace(req, hashes, opts);
      };
    }
    // a phase of the round: the lease renewed before the round reads and sends (a refused renew: nothing is read or sent)
    // (refused: the round is not run, and what settle did is still committed)
    const go = await renew("the round").then(
      () => true,
      (e: unknown) => {
        log(`Not run: ${(e as Error).message}`);
        return false;
      },
    );
    o.wrapDeps?.(deps);
    const target = targetV32(deployment);
    const result = go ? await runRound(deps, target, memory, { intervalMs: 60_000, policy: CLAIM_POLICY, live: true, now }) : undefined;
    // and after it, before its commit: a lost lease is said here, and the commit is refused by the token
    await renew("the commit").catch((e: unknown) => log(`${(e as Error).message}`));

    // a row the core no longer watches, with no receipt seen: its watch ended (another transaction took the nonce, or
    // it was dropped); the core said so
    const watched = (r: JournalRow) => memory.unreceipted.some((u) => u.hashes.some((h) => r.hashes.some((x) => x.toLowerCase() === h.toLowerCase())));
    for (const r of j.rows) {
      if ((r.status === "signed" || r.status === "sent") && !watched(r) && !s.heldRows.has(r.hashes[0].toLowerCase())) await j.journal.update(r.hashes[0], { status: "dropped" });
    }
    host.learned = batches.learned();
    const stop = result?.end ? `THE KEEPER STOPPED ITSELF: ${oneLine(result.end.reason, 400)}` : undefined;
    if (stop) log(`${stop}. Later runs don't start until pnpm ops keeper start`);
    const summary = `Round ${memory.tick} (lease token ${token}): ${[...lines].reverse().find((l) => !l.startsWith("Base:") && !l.startsWith("Bittensor:")) ?? "no line"}`;
    const c = await done({ memory: encodeMemory(memory), journal: toJson(j.patches), host: toJson(host), lines: [summary, ...lines.filter((l) => LOUD.test(l))], stop, release: true });
    if (!c.ok) {
      log(`LEASE LOST: this run's memory was not saved (${c.why}); the journal rows it wrote ahead stay for the next run, which settles them by their hashes`);
      report = { ...report, outcome: "lease-lost" };
      // a self-stop is saved all the same: the switch needs no lease, and a stop only makes things safer
      if (stop) {
        await counted(stub.stop({ reason: stop, by: "the keeper itself" })).catch(() => undefined);
        report = { ...report, stoppedItself: stop };
      }
    } else if (stop) report = { ...report, stoppedItself: stop };
  } catch (e) {
    // a fault of the host's own (not the round's, which runRound reports): nothing of the memory is saved
    log(`Failed this run: ${oneLine((e as Error).message)}; the memory is not saved, and the next run decides`);
    await done({ lines: lines.filter((l) => LOUD.test(l)), release: true }).catch(() => undefined);
    report = { ...report, outcome: "failed" };
  }
  return { ...report, lines, calls };
  };
  try {
    return await inner();
  } catch (e) {
    // anything the run's own steps throw (the acquire, a memory that doesn't parse, the deps): said scrubbed, the lease
    // released, never thrown out of the cron
    log(`Failed this run: ${oneLine((e as Error).message)}; nothing is saved, and the next run decides`);
    if (held) await counted(stub.release(held)).catch(() => undefined);
    return { outcome: "failed", lines, calls };
  }
}

/** The journal's unsettled rows that no watch in the memory covers (the run that sent them was cut off before it
 * committed): one the chain mined, or one a node knows or that was broadcast, is watched by the core from now (its
 * receipt, a replacement after 15 minutes, "probably dropped" after 6 hours: today's rules); one written ahead that no
 * node knows, with its nonce still free, holds its chain's sends for this run and is marked never sent the second run
 * (it is never broadcast again: a delivery's quote would be stale); one whose nonce another transaction took can never
 * land. */
async function settle(rows: StoredRow[], memory: KeeperMemory, rpc: Rpc, host: HostState, journal: ReturnType<typeof runJournal>["journal"], log: (l: string) => void, d: DeploymentV32, proof: ProofCtx) {
  const held = new Set<ChainName>();
  const heldRows = new Set<string>();
  const watched = (r: JournalRow) => memory.unreceipted.some((u) => u.hashes.some((h) => r.hashes.some((x) => x.toLowerCase() === h.toLowerCase())));
  const adopt = (r: JournalRow) => {
    const fn = r.request.functionName;
    // a send that carries a bridge message (a close or the notice's flush, a payout, a park's refund: Task 52), whose id
    // the watch records from its receipt
    const message =
      fn === "closeBatch"
        ? { adapter: d.addresses.baseAdapter, direction: "Base → Bittensor" as const }
        : fn === "processPayouts" || fn === "refundParked"
          ? // a refund's adapter is its park's (R4: any pair's), the one the request is sent to
            { adapter: fn === "refundParked" ? r.request.to : d.addresses.bitAdapter, direction: "Bittensor → Base" as const }
          : undefined;
    const n = r.hashes.length - 1;
    memory.unreceipted.push({ hashes: [...r.hashes], chain: r.chain, what: r.request.label, message, request: r.request, since: r.at, replacements: n, replaceAt: r.at + REPLACE_AFTER_MS * 2 ** n, passed: 0 });
    log(`Settling: ${r.request.label} (nonce ${r.nonce}, transaction ${r.hashes.at(-1)}) has no saved watch (its run was cut off): it is watched from now, as any transaction without a receipt`);
  };
  for (const r of rows) {
    if ((r.status !== "signed" && r.status !== "sent") || watched(r)) continue;
    const k = r.hashes[0].toLowerCase();
    // only a row its own signed transaction proves is adopted (its request is what a replacement would sign)
    const bad = await rowProblem(r, proof);
    if (bad) {
      await journal.update(r.hashes[0], { status: "dropped" });
      log(`JOURNAL ROW REFUSED: ${r.request?.label ?? "a row"} (nonce ${r.nonce}, transaction ${r.hashes.at(-1)}): ${bad}; it is not watched, and is marked dropped`);
      continue;
    }
    try {
      let mined = false;
      for (const h of r.hashes) if (await receiptOf(rpc, r.chain, h)) mined = true;
      if (mined || r.status === "sent") {
        adopt(r);
        continue;
      }
      let known = false;
      for (const h of r.hashes) if (await rpc.request(r.chain, "eth_getTransactionByHash", [h])) known = true;
      if (known) {
        await journal.update(r.hashes[0], { status: "sent" });
        adopt(r);
        continue;
      }
      const next = hexToNumber((await rpc.request(r.chain, "eth_getTransactionCount", [r.from, "latest"])) as Hex);
      if (next > r.nonce) {
        await journal.update(r.hashes[0], { status: "never-sent" });
        log(`NEVER SENT: ${r.request.label} (nonce ${r.nonce}, transaction ${r.hashes.at(-1)}): another transaction took its nonce, so it can never land`);
        continue;
      }
      host.unseen[k] = (host.unseen[k] ?? 0) + 1;
      if (host.unseen[k] >= 2) {
        delete host.unseen[k];
        await journal.update(r.hashes[0], { status: "never-sent" });
        log(`NEVER SENT: ${r.request.label} (nonce ${r.nonce}, transaction ${r.hashes.at(-1)}): no node has known it for two runs and its nonce is still free; it is never broadcast again, and the keeper decides afresh`);
        continue;
      }
      held.add(r.chain);
      heldRows.add(k);
      log(
        `Settling: ${r.request.label} (nonce ${r.nonce}, transaction ${r.hashes.at(-1)}) was written ahead by a run cut off before its broadcast, and no node knows it: nothing is sent on ${chainLabel(r.chain)} this run; if no node knows it next run either, it is marked never sent`,
      );
    } catch (e) {
      // the chain can't be read now: a write-ahead holds its chain, a broadcast one is watched
      if (r.status === "sent") adopt(r);
      else {
        held.add(r.chain);
        heldRows.add(k);
        log(`Settling: ${r.request.label} (nonce ${r.nonce}) couldn't be looked up (${oneLine((e as Error).message, 200)}): nothing is sent on ${chainLabel(r.chain)} this run`);
      }
    }
  }
  return { held, heldRows };
}

export type { Control, KeeperConfig };

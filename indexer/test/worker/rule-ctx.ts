import type { Hex } from "viem";
import type { Config } from "../../src/config.ts";
import type { StoredLog } from "../../src/logs.ts";
import { logQuery, type RuleCtx } from "../../src/rules/context.ts";
import type { BaseState, BitState, ChainReading, Snapshot } from "../../src/snapshot.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import { testConfig, tx } from "./fixtures.ts";

export const baseState = (over: Partial<BaseState> = {}): BaseState => ({ taoWethPool: {}, wethUsdcPool: {}, claimable: {}, deliveryOf: {}, ...over });
export const bitState = (over: Partial<BitState> = {}): BitState => ({ stakes: {}, alpha: {}, payoutBatches: {}, ...over });
export const reading = <T>(block: bigint, time: number, state: T): ChainReading<T> => ({ block, time, state });

/** A rule context for tests: no readings, no logs, everything settled far ahead, and every log given
 * stored for the first time by this tick, unless given. */
export function ruleCtx(over: Partial<RuleCtx> & { logs?: RuleCtx["logs"]; storedLogs?: StoredLog[] } = {}): RuleCtx {
  const cfg: Config = over.cfg ?? testConfig();
  const snap: Snapshot = over.snap ?? { at: 1_800_000_000, nonces: { base: {}, bittensor: {} }, safeNonces: {}, messageStates: {}, deliveredReads: [] };
  const { storedLogs, ...rest } = over;
  const logs = over.logs ?? logQuery(storedLogs ?? []);
  return {
    cfg,
    nowS: 1_800_000_000,
    snap,
    previous: { base: over.history?.base[0], bittensor: over.history?.bittensor[0] },
    history: { base: [], bittensor: [] },
    holds: [],
    hours: [],
    settled: { base: { block: 10n ** 9n, time: 2_000_000_000 }, bittensor: { block: 10n ** 9n, time: 2_000_000_000 } },
    newUids: new Set(logs.all().map((l) => l.uid)),
    payoutDelayS: 3600,
    lagLimitS: 900,
    logs,
    checks: { batches: [], chunks: [] },
    blockTime: () => undefined,
    txs: new Map(),
    newTxs: [],
    nonces: [],
    messages: [],
    t: DEFAULTS,
    holdActive: false,
    meta: {},
    writes: { batchChecks: [], chunkChecks: [], nonces: [], meta: [] },
    ...rest,
  };
}

let n = 0;
/** A stored log with sensible defaults, for building rule contexts. */
export function slog(o: Partial<StoredLog> & Pick<StoredLog, "contract" | "event">): StoredLog {
  n++;
  return {
    uid: tx(100_000 + n),
    chain: o.contract === "vault" || o.contract === "bitAdapter" ? "bittensor" : "base",
    address: "0x0000000000000000000000000000000000000001" as Hex,
    block: 1n,
    logIndex: 0,
    txHash: tx(200_000 + n),
    data: "0x",
    args: {},
    ...o,
  };
}

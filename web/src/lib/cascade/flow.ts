import type { Deployment } from "./config";
import { bodyWithin } from "./indexer";

// The monitor's public GET /v1/flow document, as indexer/src/flow.ts builds it (FlowV1 and its parts,
// field for field). Amounts are decimal strings of base units (wei, rao, USDC units), times unix seconds.

/** decimal base units; null when unknown or stale */
export type Amount = string | null;
export interface FlowChain { block: string; time: number; stale: boolean }
export type NoticeKind =
  | "paused" | "ownershipPending" | "guardianProposed" | "bridgeProposed" | "frontDoorProposed"
  | "fmAdminScheduled" | "fmMigration" | "fmPaused";
export interface Notice {
  kind: NoticeKind;
  chain: "base" | "bittensor";
  /** address of the contract it concerns */
  contract: string;
  /** the proposed guardian / bridge / door / owner / FM admin or migration target */
  target?: string;
  /** unix s it can take effect (absent: any time, or not applicable) */
  earliest?: number;
  /** the transaction that started it, when the monitor stored it */
  tx?: string;
}
/** One bridge direction: the binding one of the source pool's outbound limiter and the destination pool's inbound one. */
export interface Bucket {
  /** the binding limiter's room, capacity and refill per hour; null when unknown, and when no limiter binds or the lane is closed */
  roomLeft: Amount;
  capacity: Amount;
  perHour: Amount;
  /** whether a rate limit applies: false is no limit (CCIP's limiter off on both pools), never "switched off"; null when unknown */
  enabled: boolean | null;
  /** whether both pools still list the other chain (isSupportedChain): false is a closed lane; null when unknown */
  supported: boolean | null;
  inFlight: number;
}
export interface FlowV1 {
  v: 1;
  deployment: string;
  generatedAt: number;
  chains: { base: FlowChain | null; bittensor: FlowChain | null };
  swap: {
    taoWethPoolTao: Amount; wethUsdcPoolUsdc: Amount; twapUsdcPerTao: Amount; spotUsdcPerTao: Amount;
    buyQuote1000Tao: Amount; sellQuote: { taoIn: string; usdcOut: string } | null;
  };
  backing: {
    alphaBacking: Amount; wTaoSupply: Amount; lockPoolFmTao: Amount; fmTaoSupplyBase: Amount;
    /** the lower of the two layers, in parts per million */
    ratioPpm: number | null;
  };
  bridgeIn: Bucket;
  bridgeOut: Bucket;
  /** openBatch.start + batchInterval when the open batch holds anything */
  batch: { nextSendAt: number | null };
  vault: {
    totalAssets: Amount;
    /** TAO per share, 1e18 */
    price: Amount;
    pendingPayouts: Amount;
    nextPayoutAt: number | null;
    paused: boolean | null;
  };
  validator: { hotkey: string | null; ourStake: Amount; takeBps: number | null; backups: string[] };
  frontDoor: { paused: boolean | null };
  notices: Notice[];
  addresses: {
    vault: string; frontDoor: string; staker: string; taoWethPool: string; wethUsdcPool: string;
    alphaVault: string; lockPool: string; baseTokenPool: string; wTao: string; fmTaoBase: string;
  };
}

/** A request may take this long before the page says it can't check. */
export const FLOW_TIMEOUT_MS = 5_000;
/** The most the document may weigh (a real one is a few KB). */
export const MAX_FLOW_BYTES = 256 * 1024;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Whether `x` has every top-level part of a v1 document, each of the right kind. Deeper fields are read
 * defensively by flowView (a number it can't read shows as a dash). */
function isFlow(x: unknown): x is FlowV1 {
  if (!isObject(x) || x.v !== 1) return false;
  if (typeof x.deployment !== "string" || typeof x.generatedAt !== "number" || !Number.isFinite(x.generatedAt)) return false;
  if (!Array.isArray(x.notices)) return false;
  for (const k of ["swap", "backing", "bridgeIn", "bridgeOut", "batch", "vault", "validator", "frontDoor", "addresses"]) {
    if (!isObject(x[k])) return false;
  }
  const chains = x.chains;
  if (!isObject(chains) || !("base" in chains) || !("bittensor" in chains)) return false;
  const reading = (c: unknown) => c === null || (isObject(c) && typeof c.time === "number" && Number.isFinite(c.time));
  return reading(chains.base) && reading(chains.bittensor);
}

/** The monitor's flow document and when it arrived (on this device's clock); null when the deployment names
 * no indexer, or the request fails in any way (a timeout, a network error, any status but 200, a body over
 * MAX_FLOW_BYTES, one that isn't JSON, a version other than 1, or a missing part). Never throws. */
export async function fetchFlow(
  d: Deployment,
  o: { fetch?: typeof globalThis.fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ flow: FlowV1; receivedAt: number } | null> {
  if (!d.indexerUrl) return null;
  const f = o.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? FLOW_TIMEOUT_MS);
  try {
    const res = await f(`${d.indexerUrl}/v1/flow`, { method: "GET", mode: "cors", credentials: "omit", signal: controller.signal });
    if (res.status !== 200) return null;
    const flow = JSON.parse(await bodyWithin(res, o.maxBytes ?? MAX_FLOW_BYTES)) as unknown;
    return isFlow(flow) ? { flow, receivedAt: Date.now() } : null;
  } catch {
    controller.abort();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

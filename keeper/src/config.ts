import { type DeploymentV32, decodeDeployment } from "../../ops/src/keeper/core/deployment.ts";
import type { ClaimPolicy } from "../../ops/src/keeper/core/rewards.ts";
import type { ChainName } from "../../ops/src/keeper/core/types.ts";
import { joinDeploymentVars } from "./deployment-vars.ts";

// The keeper Worker's settings (design-keeper-worker.md §2 to §6), read at the start of every invocation from its vars
// and secrets. Nothing here reads KEEPER_PRIVATE_KEY: only signer.ts does, once a run.

/** A Durable Object namespace and a service binding, as far as the keeper uses them (the node tests' type checks read
 * this file too, without the Workers runtime's types) */
interface Namespace<Id = unknown> {
  idFromName(name: string): Id;
  get(id: Id): unknown;
}
interface Service {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/** The bindings and vars wrangler.jsonc gives the Worker, and the secrets set at deploy. */
export interface KeeperEnv {
  COORDINATOR: Namespace;
  KEEPER_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** cascade-indexer, for the monitor's /v1/status (Task 50a's hold) */
  MONITOR?: Service;
  /** The v3.2 deployment, as `pnpm config:from-record` prints it (a JSON object, or its text). A real record is above
   * the 5 kB a var holds, so it comes without its for-life list, which the numbered parts below carry */
  DEPLOYMENT?: unknown;
  /** The deployment's for-life list in parts of at most 5 kB (deployment-vars.ts): DEPLOYMENT_FOR_LIFE_1, _2, ..., each
   * saying which part of how many it is. None set: DEPLOYMENT carries the list itself */
  [part: `DEPLOYMENT_FOR_LIFE_${number}`]: unknown;
  BASE_RPC_URL?: string;
  BASE_LOGS_RPC_URL?: string;
  BITTENSOR_RPC_URL?: string;
  /** Secrets that override the three URLs above (keyed provider URLs) */
  BASE_RPC_URL_SECRET?: string;
  BASE_LOGS_RPC_URL_SECRET?: string;
  BITTENSOR_RPC_URL_SECRET?: string;
  BASE_LOG_WINDOW?: string;
  /** The gap between two requests to one chain's RPC, in ms: {"base": 100, "bittensor": 600} */
  RPC_SPACING_MS?: unknown;
  KEEPER_SUBREQUEST_BUDGET?: string;
  MAX_GAS_PRICE_BASE_GWEI?: string;
  MAX_GAS_PRICE_BITTENSOR_GWEI?: string;
  /** Whether the keeper re-executes Cascade's CCIP FAILUREs by itself (Task 52; ops' OPS_REEXEC_AUTO): "on" or "off", unset
   * or empty off (the founder's ruling: by hand only, pnpm ops reexec, until the rehearsals). It decides alone: DEPLOYMENT
   * never carries it (config-from-record leaves it out) */
  OPS_REEXEC_AUTO?: string;
  /** Secrets: the keeper's key (pnpm keeper:new-key) and the control token's SHA-256 (pnpm keeper:new-token) */
  KEEPER_PRIVATE_KEY?: string;
  CONTROL_TOKEN_SHA256?: string;
}

/** Each chain's transaction type: Bittensor's EVM takes legacy (gas price) transactions, Base EIP-1559 ones. */
export const CHAIN_LEGACY = { base: false, bittensor: true } as const;

/** Multicall3, at one address on both chains (the monitor reads both through it). */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** The run's time rules (design §3, §5): a cron run holds the lease 120 s, starts no send after 45 s and waits at
 * most 40 s for a receipt; a hand run holds it 10 min, renewed every 2 min. */
export const CRON_LEASE_MS = 120_000;
export const SEND_WINDOW_MS = 45_000;
export const RECEIPT_WAIT_MS = 40_000;
export const RECEIPT_POLL_MS = 3_000;
/** No request goes out after a run's first 90 s (the review's Important 3): the round fails soft and commits */
export const READ_DEADLINE_MS = 90_000;
/** The most eth_getLogs windows a run's lookups by id read in all (Task 52w: a park's send the Sent index lost, a
 * FAILURE's attempt): a sixth of the default budget; a longer lookup reads on next run from where it stopped, and the
 * rest of the round keeps its share (core/v32/reads.ts V32Env.lookupWindows). */
export const LOOKUP_WINDOWS_PER_RUN = 50;
/** KEEPER_SUBREQUEST_BUDGET's highest value: with a send's 100 spare requests, a retry each, the object's calls and the
 * monitor's, a run stays under the platform's 1,000 subrequests */
export const MAX_SUBREQUEST_BUDGET = 400;
export const HAND_LEASE_MS = 10 * 60_000;
/** A hand acquire refused while a cron run holds the lease keeps it from the next cron for this long (design §3: the CLI
 * waits up to 3 min) */
export const HAND_WAIT_MS = 3 * 60_000;
/** The runs table keeps a week (design §4) */
export const RUNS_KEPT_MS = 7 * 86_400_000;

/** The claim policy the round reports by: ops' CLAIM_POLICY (config.ts; a node test holds them equal). */
export const CLAIM_POLICY: ClaimPolicy = { claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 };

/** ops' defaults for the per-chain gas price caps (config.ts maxGasPrices; a node test holds them equal) */
const DEFAULT_GAS_GWEI: Record<ChainName, string> = { base: "5", bittensor: "100" };

export interface KeeperConfig {
  deployment: DeploymentV32;
  urls: { base: string; baseLogs: string; bittensor: string };
  baseLogWindow: bigint;
  spacingMs: Record<ChainName, number>;
  subrequestBudget: number;
  maxGasPrice: Record<ChainName, bigint>;
}

/** What is wrong with the settings, each problem in words (none: usable), and the settings when usable. */
export function readConfig(env: KeeperEnv): { config?: KeeperConfig; problems: string[] } {
  const problems: string[] = [];
  let deployment: DeploymentV32 | undefined;
  // DEPLOYMENT, with its for-life list joined from the numbered parts when it comes in parts (a var holds 5 kB)
  const joined = joinDeploymentVars(env as unknown as Record<string, unknown>);
  problems.push(...joined.problems);
  if (joined.text !== undefined) {
    try {
      deployment = decodeDeployment(joined.text);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  const url = (name: "BASE_RPC_URL" | "BASE_LOGS_RPC_URL" | "BITTENSOR_RPC_URL"): string => {
    const v = (env[`${name}_SECRET`] || env[name] || "").trim();
    try {
      const u = new URL(v);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    } catch {
      // the value itself is never quoted: a keyed URL is a secret
      problems.push(`${name} is not a URL`);
    }
    return v;
  };
  const urls = { base: url("BASE_RPC_URL"), baseLogs: url("BASE_LOGS_RPC_URL"), bittensor: url("BITTENSOR_RPC_URL") };
  const whole = (name: string, v: string | undefined, fallback: number): number => {
    const t = (v ?? "").trim();
    if (!t) return fallback;
    if (!/^\d+$/.test(t)) {
      problems.push(`${name} "${t}" is not a whole number`);
      return fallback;
    }
    return Number(t);
  };
  const baseLogWindow = BigInt(whole("BASE_LOG_WINDOW", env.BASE_LOG_WINDOW, 10_000) || 10_000);
  const subrequestBudget = whole("KEEPER_SUBREQUEST_BUDGET", env.KEEPER_SUBREQUEST_BUDGET, 300);
  if (subrequestBudget > MAX_SUBREQUEST_BUDGET) problems.push(`KEEPER_SUBREQUEST_BUDGET ${subrequestBudget} is above ${MAX_SUBREQUEST_BUDGET} (a run must stay under the platform's 1,000 subrequests)`);
  let spacingMs: Record<ChainName, number> = { base: 100, bittensor: 600 };
  if (env.RPC_SPACING_MS !== undefined && env.RPC_SPACING_MS !== "") {
    const s = (typeof env.RPC_SPACING_MS === "string" ? safeJson(env.RPC_SPACING_MS) : env.RPC_SPACING_MS) as Partial<Record<ChainName, unknown>> | undefined;
    const ok = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 10_000;
    if (!s || !ok(s.base) || !ok(s.bittensor)) problems.push('RPC_SPACING_MS is not {"base": <ms>, "bittensor": <ms>}');
    else spacingMs = { base: s.base as number, bittensor: s.bittensor as number };
  }
  const gwei = (chain: ChainName): bigint => {
    const name = `MAX_GAS_PRICE_${chain.toUpperCase()}_GWEI`;
    const t = ((chain === "base" ? env.MAX_GAS_PRICE_BASE_GWEI : env.MAX_GAS_PRICE_BITTENSOR_GWEI) ?? "").trim() || DEFAULT_GAS_GWEI[chain];
    if (!/^(\d+)(\.\d{1,9})?$/.test(t) || Number(t) <= 0) {
      problems.push(`${name} "${t}" is not a gas price in gwei (e.g. 5 or 0.5)`);
      return 0n;
    }
    const [w, f = ""] = t.split(".");
    return BigInt(w) * 10n ** 9n + BigInt(f.padEnd(9, "0"));
  };
  const maxGasPrice = { base: gwei("base"), bittensor: gwei("bittensor") };
  // the automatic re-execution: the Worker's own var, off unless it says on, whatever DEPLOYMENT holds (fail safe)
  const auto = (env.OPS_REEXEC_AUTO ?? "").trim();
  if (auto && !/^(on|off)$/i.test(auto)) problems.push(`OPS_REEXEC_AUTO "${auto}" is not on or off`);
  if (problems.length || !deployment) return { problems };
  return { config: { deployment: { ...deployment, reexecAuto: auto.toLowerCase() === "on" }, urls, baseLogWindow, spacingMs, subrequestBudget, maxGasPrice }, problems };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The one Durable Object of a deployment, named after it (design §3). */
export const coordinatorOf = (env: Pick<KeeperEnv, "COORDINATOR">, name: string) => env.COORDINATOR.get(env.COORDINATOR.idFromName(name));

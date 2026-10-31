import { getAddress, type Hex } from "viem";
import { ConfigError } from "./errors.ts";
import { jsonSetting, mergeThresholds, type Thresholds } from "./thresholds.ts";

export { ConfigError } from "./errors.ts";

export type ChainName = "base" | "bittensor";
/** The contracts whose logs are scanned, by what they are: a log is always keyed by its chain and
 * role, never by its event name alone (names collide, and on v3-test the staker on Base and the
 * Bittensor adapter share an address). */
export type Role = "vault" | "bitAdapter" | "frontDoor" | "baseAdapter" | "staker";
export type RoleOf = (chain: ChainName, address: Hex) => Role | undefined;

/** One v3 deployment: its contracts (lowercase), where each chain's history starts, and the blocks up
 * to which its own setup transactions run (their events are the baseline, not alerts). */
export interface Deployment {
  /** "<frontDoor>:<vault>", lowercase */
  id: string;
  base: { chainId: 8453; startBlock: bigint; baselineBlock: bigint };
  bittensor: { chainId: 964; startBlock: bigint; baselineBlock: bigint };
  frontDoor: Hex;
  baseAdapter: Hex;
  staker: Hex;
  oracle: Hex;
  vault: Hex;
  bitAdapter: Hex;
  vaultColdkey: Hex;
  stakeHotkey: Hex;
  batchMaxWaitS: number;
}

/** Public contracts the monitor reads but doesn't scan. */
export interface Tokens {
  /** Multicall3, at the same address on both chains */
  multicall3: Hex;
  base: { fmTao: Hex; usdc: Hex; weth: Hex; taoWethPool: Hex; wethUsdcPool: Hex; offRamp: Hex };
  bittensor: { fmTao: Hex; lockPool: Hex; offRamp: Hex; alphaVault: Hex };
}

export type PriceSource = "coingecko" | "coinbase";

export interface Config {
  deployment: Deployment;
  /** the bridges a batch (on Bittensor) or a payout (on Base) may arrive through */
  bridges: { base: Hex[]; bittensor: Hex[] };
  tokens: Tokens;
  rpc: { base: string; baseLogs: string; bittensor: string };
  budgets: {
    /** external fetches per invocation (Workers Free allows 50) */
    subrequests: number;
    /** logs decoded per tick */
    decode: number;
    /** the scan stops starting windows this many seconds into the tick */
    scanWallS: number;
    /** the tick's lease, at least three scans long */
    leaseS: number;
    siteFilesPerRun: number;
    siteMaxBytes: number;
  };
  baseLogWindow: bigint;
  site: { origin: string; url: string; pages: string[] };
  alerts: { from: string; mode: "send" | "log"; to: string[] };
  thresholds: Thresholds;
  priceSources: PriceSource[];
}

/** The vars in wrangler.jsonc, all public. */
export const VAR_NAMES = [
  "DEPLOYMENT",
  "BRIDGES",
  "TOKENS",
  "BASE_RPC_URL",
  "BASE_LOGS_RPC_URL",
  "BITTENSOR_RPC_URL",
  "BASE_LOG_WINDOW",
  "SUBREQUEST_BUDGET",
  "DECODE_BUDGET",
  "SCAN_WALL_S",
  "LEASE_S",
  "SITE_FILES_PER_RUN",
  "SITE_MAX_BYTES",
  "SITE_ORIGIN",
  "SITE_URL",
  "SITE_PAGES",
  "ALERT_FROM",
  "ALERT_MODE",
  "THRESHOLDS",
  "PRICE_SOURCES",
] as const;

/** The secrets (`wrangler secret put`, or a git-ignored .dev.vars locally). A secret can't share a
 * var's name (the Worker sees one value per name), so each override is the var's name + _SECRET. */
export const SECRET_NAMES = ["ALERT_TO", "THRESHOLDS_SECRET", "BASE_RPC_URL_SECRET", "BASE_LOGS_RPC_URL_SECRET", "BITTENSOR_RPC_URL_SECRET"] as const;

export type ConfigEnv = { readonly [K in (typeof VAR_NAMES)[number] | (typeof SECRET_NAMES)[number]]?: unknown };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** A checksummed address (EIP-55, as the ops record and ops/src/config.ts write them), lowercased. */
function address(field: string, x: unknown): Hex {
  if (typeof x !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(x)) throw new ConfigError(field, "is not an address");
  if (getAddress(x) !== x) throw new ConfigError(field, "is not a checksummed address");
  return x.toLowerCase() as Hex;
}

function bytes32(field: string, x: unknown): Hex {
  if (typeof x !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(x)) throw new ConfigError(field, "is not 32 bytes of hex");
  return x.toLowerCase() as Hex;
}

/** A block number: a whole number 0 or more, as a JSON integer or a decimal string. */
function block(field: string, x: unknown): bigint {
  if (typeof x === "number" && Number.isSafeInteger(x) && x >= 0) return BigInt(x);
  if (typeof x === "string" && /^\d{1,20}$/.test(x)) return BigInt(x);
  throw new ConfigError(field, "is not a whole block number");
}

/** A whole number from a var (a decimal string, or a JSON number), within [min, max]. */
function int(field: string, x: unknown, min: number, max: number): number {
  const n = typeof x === "number" ? x : typeof x === "string" && /^\d{1,15}$/.test(x) ? Number(x) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new ConfigError(field, `is not a whole number from ${min} to ${max}`);
  return n;
}

function object(field: string, raw: unknown, keys: readonly string[]): Record<string, unknown> {
  const x = jsonSetting(field, raw);
  if (!isObject(x)) throw new ConfigError(field, "is not a JSON object");
  for (const k of Object.keys(x)) if (!keys.includes(k)) throw new ConfigError(`${field}.${k}`, "is not a known field");
  return x;
}

/** An https:// URL. Its value is never put in an error: a keyed URL holds its key. */
function httpsUrl(field: string, x: unknown): string {
  if (typeof x !== "string") throw new ConfigError(field, "is not set");
  let u: URL;
  try {
    u = new URL(x);
  } catch {
    throw new ConfigError(field, "is not a URL");
  }
  if (u.protocol !== "https:") throw new ConfigError(field, "is not an https:// URL");
  return x;
}

/** An address: no whitespace, no control character (C0, DEL, C1: a header can't be split by one). */
const EMAIL = /^[^\s@,<>"\u0000-\u001f\u007f-\u009f]+@[^\s@,<>"\u0000-\u001f\u007f-\u009f]+\.[^\s@,<>"\u0000-\u001f\u007f-\u009f]+$/;

const CHAIN_KEYS = ["chainId", "startBlock", "baselineBlock"] as const;

function chainOf<C extends number>(field: string, x: unknown, chainId: C): { chainId: C; startBlock: bigint; baselineBlock: bigint } {
  if (!isObject(x)) throw new ConfigError(field, "is not an object");
  for (const k of Object.keys(x)) if (!(CHAIN_KEYS as readonly string[]).includes(k)) throw new ConfigError(`${field}.${k}`, "is not a known field");
  if (x.chainId !== chainId) throw new ConfigError(`${field}.chainId`, `is not ${chainId}`);
  const startBlock = block(`${field}.startBlock`, x.startBlock);
  const baselineBlock = block(`${field}.baselineBlock`, x.baselineBlock);
  if (baselineBlock < startBlock) throw new ConfigError(`${field}.baselineBlock`, "is before the start block");
  return { chainId, startBlock, baselineBlock };
}

const DEPLOYMENT_KEYS = ["base", "bittensor", "frontDoor", "baseAdapter", "staker", "oracle", "vault", "bitAdapter", "vaultColdkey", "stakeHotkey", "batchMaxWaitS"] as const;

function parseDeployment(raw: unknown): Deployment {
  const x = object("DEPLOYMENT", raw, DEPLOYMENT_KEYS);
  const a = (k: string) => address(`DEPLOYMENT.${k}`, x[k]);
  const d: Deployment = {
    id: "",
    base: chainOf("DEPLOYMENT.base", x.base, 8453 as const),
    bittensor: chainOf("DEPLOYMENT.bittensor", x.bittensor, 964 as const),
    frontDoor: a("frontDoor"),
    baseAdapter: a("baseAdapter"),
    staker: a("staker"),
    oracle: a("oracle"),
    vault: a("vault"),
    bitAdapter: a("bitAdapter"),
    vaultColdkey: bytes32("DEPLOYMENT.vaultColdkey", x.vaultColdkey),
    stakeHotkey: bytes32("DEPLOYMENT.stakeHotkey", x.stakeHotkey),
    batchMaxWaitS: int("DEPLOYMENT.batchMaxWaitS", x.batchMaxWaitS, 0, 10 * 365 * 86400),
  };
  d.id = `${d.frontDoor}:${d.vault}`;
  // a log is told apart by its chain and address, so no two scanned contracts on one chain may share one
  const base = [d.frontDoor, d.baseAdapter, d.staker, d.oracle];
  if (new Set(base).size !== base.length) throw new ConfigError("DEPLOYMENT", "has two Base contracts at one address");
  if (d.vault === d.bitAdapter) throw new ConfigError("DEPLOYMENT", "has the vault and the Bittensor adapter at one address");
  return d;
}

function addressList(field: string, x: unknown): Hex[] {
  if (!Array.isArray(x) || x.length === 0) throw new ConfigError(field, "is not a list of at least one address");
  return x.map((v, i) => address(`${field}[${i}]`, v));
}

function parseBridges(raw: unknown, d: Deployment): Config["bridges"] {
  if (jsonSetting("BRIDGES", raw) === undefined) return { base: [d.baseAdapter], bittensor: [d.bitAdapter] };
  const x = object("BRIDGES", raw, ["base", "bittensor"]);
  const bridges = { base: addressList("BRIDGES.base", x.base), bittensor: addressList("BRIDGES.bittensor", x.bittensor) };
  // a bridge is scanned and roled as an adapter: it can't be one of the deployment's other contracts there
  if (bridges.base.some((b) => b === d.frontDoor || b === d.staker || b === d.oracle)) throw new ConfigError("BRIDGES.base", "lists another of the deployment's contracts");
  if (bridges.bittensor.includes(d.vault)) throw new ConfigError("BRIDGES.bittensor", "lists the vault");
  return bridges;
}

const TOKEN_KEYS = {
  base: ["fmTao", "usdc", "weth", "taoWethPool", "wethUsdcPool", "offRamp"],
  bittensor: ["fmTao", "lockPool", "offRamp", "alphaVault"],
} as const;

function parseTokens(raw: unknown): Tokens {
  const x = object("TOKENS", raw, ["multicall3", "base", "bittensor"]);
  const chain = <K extends string>(name: "base" | "bittensor", keys: readonly K[]): Record<K, Hex> => {
    const c = object(`TOKENS.${name}`, x[name], keys);
    return Object.fromEntries(keys.map((k) => [k, address(`TOKENS.${name}.${k}`, c[k])])) as Record<K, Hex>;
  };
  return {
    multicall3: address("TOKENS.multicall3", x.multicall3),
    base: chain("base", TOKEN_KEYS.base),
    bittensor: chain("bittensor", TOKEN_KEYS.bittensor),
  };
}

function stringList(field: string, raw: unknown): string[] {
  const x = jsonSetting(field, raw);
  if (!Array.isArray(x) || !x.every((v) => typeof v === "string")) throw new ConfigError(field, "is not a JSON list of strings");
  return x;
}

const PRICE_SOURCES: readonly PriceSource[] = ["coingecko", "coinbase"];

/** The setting from a secret when it is set, else from its var. */
const secretOr = (env: ConfigEnv, name: "BASE_RPC_URL" | "BASE_LOGS_RPC_URL" | "BITTENSOR_RPC_URL") => {
  const secret = env[`${name}_SECRET`];
  return secret !== undefined && secret !== "" ? ([`${name}_SECRET`, secret] as const) : ([name, env[name]] as const);
};

/** The Worker's whole configuration, checked: every address checksummed, every block whole, every
 * number in range, every URL https. Throws a ConfigError naming the field (never a value); the Worker
 * then refuses to run, with a log line only. */
export function parseConfig(env: ConfigEnv): Config {
  const deployment = parseDeployment(env.DEPLOYMENT);
  const rpc = (name: "BASE_RPC_URL" | "BASE_LOGS_RPC_URL" | "BITTENSOR_RPC_URL") => {
    const [field, value] = secretOr(env, name);
    return httpsUrl(field, value);
  };

  const scanWallS = int("SCAN_WALL_S", env.SCAN_WALL_S, 1, 900);
  const leaseS = int("LEASE_S", env.LEASE_S, 1, 3600);
  if (leaseS < 3 * scanWallS) throw new ConfigError("LEASE_S", "must be at least three times SCAN_WALL_S");

  const origin = env.SITE_ORIGIN;
  const originOf = (x: string) => {
    try {
      return new URL(x).origin;
    } catch {
      return undefined;
    }
  };
  if (typeof origin !== "string" || !/^https:\/\//.test(origin) || originOf(origin) !== origin) {
    throw new ConfigError("SITE_ORIGIN", "is not an https:// origin (scheme and host, no path)");
  }
  const pages = stringList("SITE_PAGES", env.SITE_PAGES);
  if (pages.length === 0 || !pages.every((p) => /^\/[\w\-./]*$/.test(p))) throw new ConfigError("SITE_PAGES", "is not a list of paths from /");

  const mode = env.ALERT_MODE;
  if (mode !== "send" && mode !== "log") throw new ConfigError("ALERT_MODE", 'is not "send" or "log"');
  const from = env.ALERT_FROM;
  if (typeof from !== "string" || !EMAIL.test(from)) throw new ConfigError("ALERT_FROM", "is not an email address");
  const toRaw = env.ALERT_TO;
  if (toRaw !== undefined && typeof toRaw !== "string") throw new ConfigError("ALERT_TO", "is not a comma-separated list");
  const to = (toRaw ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (!to.every((t) => EMAIL.test(t))) throw new ConfigError("ALERT_TO", "holds something that isn't an email address");
  if (mode === "send" && to.length === 0) throw new ConfigError("ALERT_TO", 'is empty, and ALERT_MODE is "send"');

  const sources = stringList("PRICE_SOURCES", env.PRICE_SOURCES);
  if (!sources.every((s) => (PRICE_SOURCES as readonly string[]).includes(s)) || new Set(sources).size !== sources.length) {
    throw new ConfigError("PRICE_SOURCES", `may list only ${PRICE_SOURCES.join(" and ")}, once each`);
  }

  return {
    deployment,
    bridges: parseBridges(env.BRIDGES, deployment),
    tokens: parseTokens(env.TOKENS),
    rpc: { base: rpc("BASE_RPC_URL"), baseLogs: rpc("BASE_LOGS_RPC_URL"), bittensor: rpc("BITTENSOR_RPC_URL") },
    budgets: {
      subrequests: int("SUBREQUEST_BUDGET", env.SUBREQUEST_BUDGET, 10, 10_000),
      decode: int("DECODE_BUDGET", env.DECODE_BUDGET, 1, 100_000),
      scanWallS,
      leaseS,
      siteFilesPerRun: int("SITE_FILES_PER_RUN", env.SITE_FILES_PER_RUN, 1, 80),
      siteMaxBytes: int("SITE_MAX_BYTES", env.SITE_MAX_BYTES, 1, 100_000_000),
    },
    baseLogWindow: BigInt(int("BASE_LOG_WINDOW", env.BASE_LOG_WINDOW, 1, 100_000)),
    site: { origin, url: httpsUrl("SITE_URL", env.SITE_URL), pages },
    alerts: { from, mode, to },
    thresholds: mergeThresholds(env.THRESHOLDS, env.THRESHOLDS_SECRET),
    priceSources: sources as PriceSource[],
  };
}

/** Which scanned contract `address` is on `chain`: Base holds the front door, its adapter and the
 * staker; Bittensor the vault and its adapter. Every bridge listed in BRIDGES is an adapter on its chain
 * (a second, legitimately activated bridge carries batches and payouts too). One address can be two
 * roles on two chains. */
export function rolesOf(d: Deployment, bridges: Config["bridges"] = { base: [d.baseAdapter], bittensor: [d.bitAdapter] }): RoleOf {
  const roles: Record<ChainName, Map<string, Role>> = {
    base: new Map<string, Role>([
      ...bridges.base.map((b): [string, Role] => [b, "baseAdapter"]),
      [d.frontDoor, "frontDoor"],
      [d.baseAdapter, "baseAdapter"],
      [d.staker, "staker"],
    ]),
    bittensor: new Map<string, Role>([
      ...bridges.bittensor.map((b): [string, Role] => [b, "bitAdapter"]),
      [d.vault, "vault"],
      [d.bitAdapter, "bitAdapter"],
    ]),
  };
  return (chain, a) => roles[chain].get(a.toLowerCase());
}

/** The addresses each chain's log scan reads: the deployment's contracts there, and every other bridge
 * BRIDGES lists. */
export function scanAddresses(cfg: Pick<Config, "deployment" | "bridges">): Record<ChainName, Hex[]> {
  const d = cfg.deployment;
  const plus = (own: Hex[], bridges: Hex[]) => [...own, ...bridges.filter((b) => !own.includes(b))];
  return {
    base: plus([d.frontDoor, d.baseAdapter, d.staker], cfg.bridges.base),
    bittensor: plus([d.vault, d.bitAdapter], cfg.bridges.bittensor),
  };
}

/** A URL's registrable domain, the last two labels of its host (drpc.org, publicnode.com): never a
 * subdomain, path or query, where a provider's key can sit (https://KEY.base-mainnet.quiknode.pro/…). An
 * IP address or a one-label host as it is. No public-suffix list: a host under e.g. co.uk shows as co.uk,
 * which says less but leaks nothing. (Ported from ops/src/send.ts.) */
export function hostDomain(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "(an invalid URL)";
  }
  if (/^[\d.]+$/.test(host) || host.startsWith("[") || !host.includes(".")) return host;
  return host.split(".").slice(-2).join(".");
}

/** A URL fit for a log line or an error: its registrable domain only. */
export const redact = hostDomain;

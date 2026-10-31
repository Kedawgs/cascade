import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type Hex, parseEther } from "viem";

export type ChainName = "base" | "bittensor";

export interface ChainTarget {
  name: ChainName;
  rpcUrl: string;
  chainId: number;
  legacy: boolean;
}

export type Env = Record<string, string | undefined>;

/** Live addresses, copied from contracts/test/fork/ForkBase.sol:58-70. */
export const LIVE = {
  base: {
    CHAIN_ID: 8453,
    SELECTOR: 15971525489660198786n,
    ROUTER: "0x881e3A65B4d4a04dD529061dd0071cf975F58bCD",
    ONRAMP: "0xF75bf16b03aaE98677926F0987F195A2153996B9",
    OFFRAMP: "0x16E577f1724AE2598F9b43a52C19E6f67eE13808",
    TOKEN: "0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67",
    POOL: "0xF5AC6D6Bd12d8b87dE3c136FAc9375961577e794",
  },
  bittensor: {
    CHAIN_ID: 964,
    SELECTOR: 2135107236357186872n,
    ROUTER: "0xD941fBEcD2b971d0F54b4C34286C95faB52B60B8",
    ONRAMP: "0x5aA05e14ac7FaF23F1757d46429E6CA7e3FC1274",
    OFFRAMP: "0xF9410A08FD57e629c66E1f37a5Ae8f0a757d9AD9",
    TOKEN: "0xC5b6C1632d34901239396F5E1BDe54B342900256",
    POOL: "0xB66b9c085ab711ECC373aaF6dc959a4A6B42BE2e",
  },
  ALPHA_VAULT: "0x11837459896D96F821a8D88eC93a3C8D152033D4",
} as const satisfies {
  base: Record<string, Address | number | bigint>;
  bittensor: Record<string, Address | number | bigint>;
  ALPHA_VAULT: Address;
};

/** Bittensor's precompiles. */
export const PRECOMPILE = {
  balanceTransfer: "0x0000000000000000000000000000000000000800",
  staking: "0x0000000000000000000000000000000000000805",
  addressMapping: "0x000000000000000000000000000000000000080C",
} as const satisfies Record<string, Address>;

/** The throwaway test wallet: deployer, owner, guardian and keeper for the test run. */
export const WALLET: Address = "0x770932787DD3bcE64f14E31f4746bCe22E214fFF";
/** Its Bittensor twin (SS58, prefix 42), where TAO top-ups go. */
export const WALLET_SS58 = "5FxSW9dM8DbAWUFtADJPX5Wb7DctrJHadkJ3TB1GpBGvxQH2";

/** Base tokens, Uniswap v3 pools and router for v3 (checked on chain 2026-10-26; the same constants as
 * contracts/test/fork/BaseForkV3.t.sol). TAO on Base is LIVE.base.TOKEN. */
export const BASE_V3 = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  /** Uniswap v3 TAO/WETH, 0.3% */
  TAO_WETH_POOL: "0x82dD34C6631C286cDD1dB16f2c232f60E402Dd5A",
  /** Uniswap v3 WETH/USDC, 0.05% */
  WETH_USDC_POOL: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
  SWAP_ROUTER_02: "0x2626664c2603336E57B271c5C0b26F421741e481",
  /** Uniswap's QuoterV2: prices a swap path with an eth_call */
  QUOTER_V2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
} as const satisfies Record<string, Address>;

const TAO = 10n ** 18n;

/** The adapters' MAX_MESSAGE_VALUE, ForeverMoney's 5,000 TAO pool bucket: the most an adapter's own
 * per-message cap (maxMessageValue) may be, and the whole cap of the a2b4412 build's adapters, which
 * have no maxMessageValue of their own. */
export const ADAPTER_MAX_MESSAGE_VALUE = 5_000n * TAO;

/** What a deployment plan reads from its settings (v2 and v3 alike). */
export interface DeploySettings {
  baseGas: { base: bigint; perEntry: bigint };
  minSendAmount: bigint;
  bitGas: { base: bigint; perEntry: bigint };
  /** Each adapter's per-message cap, its constructor's Config.maxMessageValue (0 < cap <= 5,000 TAO): a
   * send above it reverts MessageTooLarge. What each must cover is plan.ts's adapterCapProblems. */
  adapterMaxMessageValue: { base: bigint; bittensor: bigint };
  batchInterval: number;
  minDeposit: bigint;
  depositCap: bigint;
  redeemRequestFee: bigint;
  hotkey: Hex;
  minDirectDeposit: bigint;
  payoutDelay: number;
  adapterReserve: bigint;
  vaultReserve: bigint;
}

/** Test settings from the spec's table. */
export const SETTINGS = {
  baseGas: { base: 540_000n, perEntry: 26_450n },
  minSendAmount: 10n ** 16n,
  bitGas: { base: 120_000n, perEntry: 29_900n },
  /** The lane's whole 5,000 TAO, as before the cap was a constructor argument: a test deploy behaves as
   * it did. */
  adapterMaxMessageValue: { base: ADAPTER_MAX_MESSAGE_VALUE, bittensor: ADAPTER_MAX_MESSAGE_VALUE },
  batchInterval: 600,
  minDeposit: 10n ** 16n,
  depositCap: 15n * 10n ** 16n,
  redeemRequestFee: 10n ** 14n,
  hotkey: "0x58aef7b1efb44806fe14c6c58d0c1eb634a59fd2513f0ced6f2d10e0569af40d" as Hex,
  minDirectDeposit: 10n ** 16n,
  payoutDelay: 3600,
  adapterReserve: 10n ** 12n,
  vaultReserve: 15n * 10n ** 11n,
} as const satisfies DeploySettings;

/** The v3 test deployment: the spec's launch values, except the batch interval and the payout delay,
 * kept at 10 minutes and 1 hour so the owner's test run doesn't wait (at launch: 21_600 s, and the
 * vault's default of 24 hours). The reserves and direct-deposit minimum are v2's; both adapters' gas
 * models are raised (below). */
export const SETTINGS_V3 = {
  ...SETTINGS,
  /** The gas a batch asks CCIP for on Bittensor, as contracts/test/adapters/AdapterGas.t.sol calibrates
   * it (v2's was 540,000 + 26,450 per entry). A delivery's first redeem writes a payout batch and starts
   * a burn window, about 105,000 gas a deposit doesn't cost, and a deposit costs about 28,500 gas against
   * 15,000 for a further redeem, so many deposits with one redeem bind: 50+1 keeps the test's 15% headroom
   * over the mock, the real AlphaVault's 52,844 and a 300,000 precompile allowance with 4,509 gas to
   * spare, and every other measured shape within 50 + 50 has more. 780,000 + 200 x 31,100 is exactly the
   * adapters' 7,000,000 cap. A delivery that runs short loses nothing but waits for a manual
   * re-execution. */
  baseGas: { base: 780_000n, perEntry: 31_100n },
  /** The gas a payout asks CCIP for on Base. The rehearsal, relaying with the limit enforced, measured
   * the Base receiver needing about 134.6k for one entry: 90% of v2's 149,900. 170,000 + 29,900 per
   * entry keeps one entry at about two thirds of its limit. */
  bitGas: { base: 170_000n, perEntry: 29_900n },
  minDeposit: 4n * 10n ** 16n,
  depositCap: 40n * 10n ** 18n,
  maxBatchValue: 10n * 10n ** 18n,
  batchInterval: 600,
  payoutDelay: 3600,
  redeemRequestFee: 10n ** 14n,
  /** tao.bot, 5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u */
  hotkey: "0x56a9aee6291bd03ab6d36d4d13e2bebae7cd403518066c72fba1b417d6ddd748" as Hex,
  /** The test wallet for the test run. It must be a plain account (verify checks it has no code on
   * either chain), so its address means the same owner on Base and on Bittensor. */
  treasury: WALLET,
  rewardCutBps: 1_000,
  swapFeeBps: 15,
  /** $0.05, in USDC units */
  depositFeeUsdc: 50_000n,
  /** The front door's default, read back by verify. */
  maxDeliverySlippageBps: 150,
  deliveryRouteId: 0,
} as const;

/** The vault's owner-set limits, each read back by verify under its view's name. Amounts in wei, the
 * floors and dust in rao. */
export interface VaultLimits {
  maxDailyOutflowBps: bigint;
  minDailyOutflow: bigint;
  maxEntryValue: bigint;
  maxMessageValue: bigint;
  minChunk: number;
  maxFeeBps: bigint;
  maxFeeAbs: bigint;
  maxTotalAssets: bigint;
  hotkeyDustRao: bigint;
  claimGasRequired: bigint;
  fallbackMinStakeRao: bigint;
  fallbackMinRemainRao: bigint;
  unstakeMarginRao: bigint;
}

/** The vault's limits as CascadeVault.sol's state defaults leave them (readback.test checks them against
 * the source): what a test deployment runs with, and what verify reads back. */
export const VAULT_DEFAULTS: VaultLimits = {
  maxDailyOutflowBps: 2_000n,
  minDailyOutflow: 100n * 10n ** 18n,
  maxEntryValue: 2_000n * 10n ** 18n,
  maxMessageValue: 4_000n * 10n ** 18n,
  minChunk: 10,
  maxFeeBps: 100n,
  maxFeeAbs: 2n * 10n ** 16n,
  maxTotalAssets: 1_000n * 10n ** 18n,
  hotkeyDustRao: 1_000_000n,
  claimGasRequired: 55_000_000n,
  fallbackMinStakeRao: 2_000_000n,
  fallbackMinRemainRao: 20_000_000n,
  unstakeMarginRao: 0n,
};

/** The vault limits a launch sets during deploy (before the vault's hand-off) and verify checks, sized
 * for the 40 TAO deposit cap: a vault of about 40-60 TAO. The defaults were sized for a 1,000 TAO beta.
 * The reasoning, and which are product decisions, is in ops/LAUNCH-SETTINGS.md. The others keep their
 * defaults. */
export const LAUNCH_VAULT_LIMITS = {
  /** setOutflowLimits: each 24-hour window, a front door's redeems burn at most the larger of 20% of the
   * vault and 10 TAO. The default floor, 100 TAO, is more than the whole vault: a forged bridge message
   * could force-exit everyone in one day. At 10 TAO a forced exit takes at most 25% of a 40 TAO vault a
   * day (20% of 50 or 60). What holds a forged batch is the guardian, within the 24 h payout delay: its
   * pause() stops processPayouts, as does removeFrontDoor or disableBridge. The owner can't act in that
   * time behind a 48 h timelock: cancelPayoutBatch (re-minting the shares) is owner-only, so it goes
   * through the timelock, once the guardian holds the batch (it works while paused). The cost: one
   * holder of the whole 40 TAO cap needs 4 windows to leave (10
   * TAO each, asking again each day), and when many leave at once the first come are served first. A
   * lower floor exits a big holder slower (5 TAO: 8 windows); a higher one bounds a forced exit worse. */
  maxDailyOutflowBps: 2_000n,
  minDailyOutflow: 10n * TAO,
  /** setMessageLimits: one redeem entry burns at most 10 TAO per delivery (the floor: the allowance
   * binds first anyway); one payout message to Base carries at most 15 TAO (default 4,000), near the 10
   * TAO batch and above the most a day's allowance can be at 60 TAO (12), so a day's redeems still go
   * home in one message and one bridge fee. A single entry above it still goes, alone. Chunks of at least
   * 10 entries, as before. */
  maxEntryValue: 10n * TAO,
  maxMessageValue: 15n * TAO,
  minChunk: 10,
  /** setFeeLimits: a payout pays its bridge fee only up to the larger of 1% of the chunk and 0.005 TAO
   * (default 0.02). The live fee is about 0.00105 TAO, so this leaves about 5 times for fee swings and a
   * TAO price drop; above it the payout waits (nothing is lost) until fees fall or the owner raises it.
   * 0.02 TAO could take half of a 0.04 TAO minimum deposit; 0.005 at most an eighth. */
  maxFeeBps: 100n,
  maxFeeAbs: 5n * 10n ** 15n,
  /** setMaxTotalAssets: direct deposits on Bittensor stop once the vault holds 44 TAO (default 1,000):
   * 10% above the 40 TAO deposit cap, some room for rewards (it never stops a front-door batch, which it
   * doesn't check). It bounds a mispriced deposit after a hotkey swap, and the large direct deposit that
   * draining the outflow allowance's base with a gift needs (a README soft spot: at 44 TAO the gift goes
   * almost entirely to the other holders). A direct deposit no longer raises that base, which counts only
   * root stake that has ramped in. */
  maxTotalAssets: 44n * TAO,
} as const satisfies Partial<VaultLimits>;

/** The front door's batch limits as its constructor sets them. */
export const FRONT_DOOR_DEFAULTS = { maxDeposits: 50, maxRedeems: 50 } as const;

/** How fast a deployment runs: "test" is SETTINGS_V3 as is; "launch" batches hourly and pays out after a
 * day, and the keeper may wait a day before closing a thin batch. Chosen when a v3 plan is made. */
export type Cadence = "test" | "launch";

/** The v3 test settings as the a2b4412 build deployed them (the live v3-test record, whose plan has no
 * `build`): v2's gas toward Bittensor, and adapters with no cap of their own, so the lane's 5,000 TAO.
 * verify and deploy read a record with the settings it was deployed with. */
export const SETTINGS_V3_A2B4412 = {
  ...SETTINGS_V3,
  baseGas: SETTINGS.baseGas,
  adapterMaxMessageValue: { base: ADAPTER_MAX_MESSAGE_VALUE, bittensor: ADAPTER_MAX_MESSAGE_VALUE },
} as const;

const { treasury: _testTreasury, ...SETTINGS_V3_NO_TREASURY } = SETTINGS_V3;

/** The launch: hourly batches, a day's payout delay, the launch's vault limits (LAUNCH_VAULT_LIMITS) and
 * 50 TAO adapter caps; the rest as the test settings, the 40 TAO deposit cap, 10 TAO batches and the
 * 0.0001 ETH redeem request fee included. It has no treasury: a launch plan takes its treasury, like its
 * owner, guardian and keeper, from its roles (roles.ts), never the test wallet. */
export const SETTINGS_V3_LAUNCH = {
  ...SETTINGS_V3_NO_TREASURY,
  batchInterval: 3_600,
  payoutDelay: 86_400,
  vaultLimits: LAUNCH_VAULT_LIMITS,
  /** One message carries at most 50 TAO either way: five times the 10 TAO batch and above the 15 TAO
   * payout message, so a stolen or buggy send moves at most that, not the lane's 5,000. Raising the
   * front door's maxBatchValue or the vault's maxMessageValue or maxEntryValue past 50 TAO needs new
   * adapters first (7 days through the bridge registry). */
  adapterMaxMessageValue: { base: 50n * TAO, bittensor: 50n * TAO },
} as const;

/** The keeper's longest wait before closing a batch with entries: null = no extra wait, close as soon as
 * the contract allows (closeMaxWaitS returns 0). */
export const CADENCE = {
  test: { closeMaxWaitS: null },
  launch: { closeMaxWaitS: 86_400 },
} as const satisfies Record<Cadence, { closeMaxWaitS: number | null }>;

/** OPS_CADENCE=launch makes a new v3 plan a launch plan; unset, empty or "test" is test; anything else is refused. */
export function cadenceFromEnv(env: Env): Cadence {
  const v = env.OPS_CADENCE?.trim() ?? "";
  if (v === "" || v === "test") return "test";
  if (v === "launch") return "launch";
  throw new Error(`OPS_CADENCE "${v}" is not a cadence: use launch, or leave it unset for test; nothing sent`);
}

/** When a reward claim is worth its cost (spec, keeper and reward policy): when what is waiting is at
 * least `claimMultiple` times the cost, or monthly while one claim costs under `monthlyClaimMaxUsd`. */
export interface ClaimPolicy {
  /** One claim's cost, in TAO wei. */
  claimCostTao: bigint;
  claimMultiple: bigint;
  monthlyClaimMaxUsd: number;
}

/** τ0.057 is the docs' figure for a full basket, until a real claim is measured. */
export const CLAIM_POLICY = { claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 } as const satisfies ClaimPolicy;

/** The claim policy, with a measured claim cost from OPS_CLAIM_COST_TAO (in TAO, e.g. 0.045) when set. */
export function claimPolicy(env: Env): ClaimPolicy {
  const cost = env.OPS_CLAIM_COST_TAO?.trim();
  if (!cost) return { ...CLAIM_POLICY };
  if (!/^\d+(\.\d{1,18})?$/.test(cost) || parseEther(cost) === 0n) {
    throw new Error(`OPS_CLAIM_COST_TAO "${cost}" is not an amount of TAO above 0 (e.g. 0.045)`);
  }
  return { ...CLAIM_POLICY, claimCostTao: parseEther(cost) };
}

/** The v2 test deployment: its record is deployments/test-2026-10.json. */
export const V2_DEPLOYMENT = "test-2026-10";

/** The deployment the CLI works on: OPS_DEPLOYMENT (e.g. v3-test), else the v2 test deployment. It
 * names the record file, so it holds only letters, digits, '.', '_' and '-', from a letter or digit. */
export function deploymentName(env: Env): string {
  const name = env.OPS_DEPLOYMENT?.trim() || V2_DEPLOYMENT;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`OPS_DEPLOYMENT "${name}" is not a plain name: use letters, digits, '.', '_' and '-' (e.g. v3-test)`);
  }
  return name;
}

/** A deployment named v3… gets the v3 plan when its record is first created. */
export const isV3Deployment = (env: Env): boolean => deploymentName(env).startsWith("v3");

/** The deployment's record: deployments/<name>.json, or rehearsal-<name>.json on the local forks;
 * without OPS_DEPLOYMENT, the v2 records test-2026-10.json and rehearsal.json. */
export function recordPath(env: Env, live: boolean): string {
  const name = deploymentName(env);
  const file = live ? `${name}.json` : name === V2_DEPLOYMENT ? "rehearsal.json" : `rehearsal-${name}.json`;
  return join(paths(env).deploymentsDir, file);
}

export function targets(env: Env): { live: Record<ChainName, ChainTarget>; rehearsal: Record<ChainName, ChainTarget> } {
  return {
    live: {
      base: { name: "base", rpcUrl: env.OPS_BASE_RPC ?? "https://mainnet.base.org", chainId: 8453, legacy: false },
      bittensor: {
        name: "bittensor",
        // the archive node: the lite node keeps only minutes of event history, which the keeper scans
        rpcUrl: env.OPS_BITTENSOR_RPC ?? "https://archive.chain.opentensor.ai",
        chainId: 964,
        legacy: true,
      },
    },
    rehearsal: {
      base: { name: "base", rpcUrl: "http://127.0.0.1:8545", chainId: 31337, legacy: false },
      bittensor: { name: "bittensor", rpcUrl: "http://127.0.0.1:8547", chainId: 31338, legacy: true },
    },
  };
}

/** Where the live tools read Base's logs: OPS_BASE_LOGS_RPC; without it OPS_BASE_RPC (a keyed provider
 * usually serves logs), unless that is mainnet.base.org, which refuses eth_getLogs outright ("request
 * limit reached", checked 2026-10-28); else publicnode. The site reads Base's logs the same way
 * (web/src/lib/cascade/config.ts, baseLogs). */
export function baseLogsTarget(env: Env): ChainTarget {
  const logs = env.OPS_BASE_LOGS_RPC?.trim();
  const base = env.OPS_BASE_RPC?.trim();
  const refuses = (url: string) => {
    try {
      return new URL(url).hostname === "mainnet.base.org";
    } catch {
      return false;
    }
  };
  const rpcUrl = logs || (base && !refuses(base) ? base : "https://base-rpc.publicnode.com");
  return { name: "base", rpcUrl, chainId: 8453, legacy: false };
}

/** The block range of one eth_getLogs to the Base logs server: OPS_BASE_LOGS_WINDOW, by default 10,000
 * (publicnode accepted 50,000-block ranges, 2026-10-28; the old 100-block window was mainnet.base.org's).
 * Lower it for a provider that caps ranges lower. */
export function baseLogsWindow(env: Env): bigint {
  const v = env.OPS_BASE_LOGS_WINDOW?.trim();
  if (!v) return 10_000n;
  if (!/^[1-9]\d*$/.test(v)) throw new Error(`OPS_BASE_LOGS_WINDOW "${v}" is not a number of blocks (e.g. 10000)`);
  return BigInt(v);
}

/** The highest gas price the keeper sends at, per chain, in wei: OPS_MAX_GAS_PRICE_BASE and
 * OPS_MAX_GAS_PRICE_BITTENSOR, in gwei (decimals allowed), by default 5 gwei on Base (its price sits
 * well under 0.1 gwei and spikes to about 1) and 100 gwei on Bittensor (its EVM's sits about 10). Over
 * the cap a send is refused, not sent and never cancelled, and tried again later: a fee spike should cost
 * a wait, not the wallet's ETH or TAO. */
export function maxGasPrices(env: Env): Record<ChainName, bigint> {
  const gwei = (name: string, fallback: bigint): bigint => {
    const v = env[name]?.trim();
    return v ? gweiToWei(name, v) : fallback;
  };
  return { base: gwei("OPS_MAX_GAS_PRICE_BASE", 5n * 10n ** 9n), bittensor: gwei("OPS_MAX_GAS_PRICE_BITTENSOR", 100n * 10n ** 9n) };
}

/** A gas price given in gwei ("5", "0.5", up to 9 decimals) as wei; refused, naming `name` (the
 * variable or flag it came from), when it isn't one. */
export function gweiToWei(name: string, v: string): bigint {
  if (!/^(\d+)(\.\d{1,9})?$/.test(v) || Number(v) <= 0) throw new Error(`${name} "${v}" is not a gas price in gwei (e.g. 5 or 0.5)`);
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole) * 10n ** 9n + BigInt(frac.padEnd(9, "0"));
}

/** The commands whose sends have no gas price cap: the emergency commands and the owner's, which a
 * person runs by hand and means, gas spike or not. A guardian's pause during a spike must go out. */
export const UNCAPPED_COMMANDS: readonly string[] = ["pause", "unpause", "wind-down", "sweep"];

/** The gas price cap a command's sends go under: none for the hand-run emergency and owner commands
 * (UNCAPPED_COMMANDS), unless `--max-gas-price <gwei>` names one for that run (`overrideGwei`, both
 * chains); maxGasPrices (the environment's, or the defaults) for every other command: run, deploy,
 * close, stake, payouts, deliver, claim. */
export function gasPriceCapFor(cmd: string, env: Env, overrideGwei?: string): Record<ChainName, bigint> | undefined {
  if (overrideGwei !== undefined) {
    const wei = gweiToWei("--max-gas-price", overrideGwei);
    return { base: wei, bittensor: wei };
  }
  return UNCAPPED_COMMANDS.includes(cmd) ? undefined : maxGasPrices(env);
}

/** A gas price in gwei for a message: "0.012 gwei", "5 gwei". */
export const gweiOf = (wei: bigint): string => `${Number(wei) / 1e9} gwei`;

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export function paths(env: Env) {
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  return {
    keystore: env.OPS_KEYSTORE ?? join(home, ".foundry", "keystores", "9ffde5b1-4193-4175-9eb3-a26f9d027214"),
    passwordFile: env.OPS_PASSWORD_FILE ?? join(home, ".foundry", "cascade-test.pw"),
    foundryBin: env.OPS_FOUNDRY_BIN ?? join(home, ".foundry", "bin"),
    contractsDir: join(repoRoot, "contracts"),
    deploymentsDir: join(repoRoot, "ops", "deployments"),
  };
}

export type Paths = ReturnType<typeof paths>;

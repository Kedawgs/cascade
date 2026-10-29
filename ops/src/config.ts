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

/** What a deployment plan reads from its settings (v2 and v3 alike). */
export interface DeploySettings {
  baseGas: { base: bigint; perEntry: bigint };
  minSendAmount: bigint;
  bitGas: { base: bigint; perEntry: bigint };
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
 * vault's default of 24 hours). The reserves, direct-deposit minimum and Base adapter's gas model are
 * v2's; the Bittensor adapter's payout gas is raised (below). */
export const SETTINGS_V3 = {
  ...SETTINGS,
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

/** How fast a deployment runs: "test" is SETTINGS_V3 as is; "launch" batches hourly and pays out after a
 * day, and the keeper may wait a day before closing a thin batch. Chosen when a v3 plan is made. */
export type Cadence = "test" | "launch";

const { treasury: _testTreasury, ...SETTINGS_V3_NO_TREASURY } = SETTINGS_V3;

/** The launch: hourly batches and a day's payout delay. It has no treasury: a launch plan takes its
 * treasury, like its owner, guardian and keeper, from its roles (roles.ts), never the test wallet. */
export const SETTINGS_V3_LAUNCH = { ...SETTINGS_V3_NO_TREASURY, batchInterval: 3_600, payoutDelay: 86_400 } as const;

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

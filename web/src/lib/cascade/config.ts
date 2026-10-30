import { type Address, encodePacked, isAddress } from "viem";
import EXPECTED from "./deployments.json";

/** The live deployment the site talks to, from `web/.env.local` (written by `pnpm ops web-config`). */
export interface Deployment {
  frontDoor: Address;
  baseAdapter: Address;
  vault: Address;
  bitAdapter: Address;
  /** The Bittensor block the contracts were deployed in: where log scans start. */
  bitBlock: bigint;
  vaultSs58: string;
  hotkeySs58: string;
  /** v3 only: the one-transaction staker and the price oracle. Absent on a v2 deployment. */
  staker?: Address;
  oracle?: Address;
  /** Launch cadence only: the longest a batch waits before it can close, in seconds. Absent = batchInterval alone. */
  batchMaxWaitS?: number;
  /** v3: the vault's payout delay, in seconds (written by `pnpm ops web-config`). Absent = not known here. */
  payoutDelayS?: number;
}

/** When the open batch can be expected to close, by the latest: its interval, or the deployment's max wait if longer. */
export const batchCloseAt = (openStart: number, batchInterval: number, batchMaxWaitS?: number): Date =>
  new Date((openStart + Math.max(batchInterval, batchMaxWaitS ?? 0)) * 1000);

/** A v3 deployment has both the staker and the oracle; a v2 one has neither (readDeployment refuses any
 * other mix), and only then does the site keep the v2 flows. */
export const isV3 = (d: Deployment): boolean => Boolean(d.staker && d.oracle);

type Env = Record<string, string | undefined>;

const address = (v: string | undefined): Address | null => (v && isAddress(v, { strict: true }) && v !== v.toLowerCase() ? v : null);

/** The deployment the env names, or null when it names none (the site then shows it isn't connected).
 * Throws for an env that names a v3 deployment (a staker, an oracle or a payout delay, which only a v3
 * deployment writes) without both a valid staker and oracle: the build fails there, rather than the
 * site quietly running the v2 flows against v3 contracts. */
export function readDeployment(env: Env): Deployment | null {
  const frontDoor = address(env.NEXT_PUBLIC_CASCADE_FRONT_DOOR);
  const baseAdapter = address(env.NEXT_PUBLIC_CASCADE_BASE_ADAPTER);
  const vault = address(env.NEXT_PUBLIC_CASCADE_VAULT);
  const bitAdapter = address(env.NEXT_PUBLIC_CASCADE_BIT_ADAPTER);
  const block = env.NEXT_PUBLIC_CASCADE_BIT_BLOCK;
  const vaultSs58 = env.NEXT_PUBLIC_CASCADE_VAULT_SS58;
  const hotkeySs58 = env.NEXT_PUBLIC_CASCADE_HOTKEY_SS58;
  if (!frontDoor || !baseAdapter || !vault || !bitAdapter || !block || !/^\d+$/.test(block) || !vaultSs58 || !hotkeySs58) {
    return null;
  }
  const staker = address(env.NEXT_PUBLIC_CASCADE_STAKER);
  const oracle = address(env.NEXT_PUBLIC_CASCADE_ORACLE);
  const namesV3 = [env.NEXT_PUBLIC_CASCADE_STAKER, env.NEXT_PUBLIC_CASCADE_ORACLE, env.NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S].some((v) => !!v);
  if (namesV3 && (!staker || !oracle)) {
    throw new Error(
      "The env names a v3 deployment but not both its staker and its oracle as checksummed addresses " +
        "(NEXT_PUBLIC_CASCADE_STAKER, NEXT_PUBLIC_CASCADE_ORACLE). Refusing to fall back to the v2 flows: run `pnpm ops web-config` again.",
    );
  }
  const maxWait = env.NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S;
  const batchMaxWaitS = maxWait && /^[1-9]\d*$/.test(maxWait) ? Number(maxWait) : undefined;
  // 0 is a real setting (no delay), so it is kept; anything but plain digits is left out
  const delay = env.NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S;
  const payoutDelayS = delay && /^(0|[1-9]\d*)$/.test(delay) ? Number(delay) : undefined;
  return {
    frontDoor,
    baseAdapter,
    vault,
    bitAdapter,
    bitBlock: BigInt(block),
    vaultSs58,
    hotkeySs58,
    ...(staker ? { staker } : {}),
    ...(oracle ? { oracle } : {}),
    ...(batchMaxWaitS ? { batchMaxWaitS } : {}),
    ...(payoutDelayS !== undefined ? { payoutDelayS } : {}),
  };
}

/** How the site describes a deployment (the FAQ's answers): "testing" (a test deployment: one key holds
 * every role, and depositing isn't recommended), "early" (the launch: real deposits under a cap, the owner
 * one hardware wallet, a separate guardian, no multisig or timelock yet), or "live" (a multisig owner
 * behind a timelock). */
export type Stage = "testing" | "early" | "live";

/** A deployment the site may be built for, as committed in deployments.json (reviewed in git). */
export interface ExpectedDeployment {
  version: 2 | 3;
  stage: Stage;
  frontDoor: string;
  baseAdapter: string;
  vault: string;
  bitAdapter: string;
  /** v3 only. */
  staker?: string;
  oracle?: string;
  bitBlock: string;
  vaultSs58: string;
  hotkeySs58: string;
}

/** Every deployment the site may be built for, by its ops name. A build env that names any other fails
 * the build (checkedDeployment), and the browser checks again before sending (wiring.ts). */
export const EXPECTED_DEPLOYMENTS = EXPECTED as Readonly<Record<string, ExpectedDeployment>>;

const sameAddress = (a: string | undefined, b: string | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** The name of the committed deployment `d` is, every address, block and name alike; undefined for any other. */
export function knownDeployment(d: Deployment, list: Readonly<Record<string, ExpectedDeployment>> = EXPECTED_DEPLOYMENTS): string | undefined {
  return Object.entries(list).find(
    ([, e]) =>
      sameAddress(e.frontDoor, d.frontDoor) &&
      sameAddress(e.baseAdapter, d.baseAdapter) &&
      sameAddress(e.vault, d.vault) &&
      sameAddress(e.bitAdapter, d.bitAdapter) &&
      (e.version === 3) === isV3(d) &&
      sameAddress(e.staker, d.staker) &&
      sameAddress(e.oracle, d.oracle) &&
      e.bitBlock === String(d.bitBlock) &&
      e.vaultSs58 === d.vaultSs58 &&
      e.hotkeySs58 === d.hotkeySs58,
  )?.[0];
}

/** The stage deployments.json gives `d`; "testing", the most careful wording, for no deployment or one not listed. */
export function deploymentStage(d: Deployment | null, list: Readonly<Record<string, ExpectedDeployment>> = EXPECTED_DEPLOYMENTS): Stage {
  const name = d ? knownDeployment(d, list) : undefined;
  return name ? list[name].stage : "testing";
}

/** The env's deployment, only if it is one of the committed ones: anything else throws, so `next build`
 * (and `next dev`) fail rather than make a site that sends to contracts no one reviewed. */
export function checkedDeployment(d: Deployment | null): Deployment | null {
  if (d && !knownDeployment(d)) {
    throw new Error(
      "The env names a deployment that isn't in web/src/lib/cascade/deployments.json. Refusing to build a site " +
        "for contracts that aren't listed there: add the deployment to that file in a reviewed commit, or run " +
        "`pnpm ops web-config` for a listed one.",
    );
  }
  return d;
}

/** Next inlines each NEXT_PUBLIC_ value only where it is written out by name. */
export const DEPLOYMENT = checkedDeployment(readDeployment({
  NEXT_PUBLIC_CASCADE_FRONT_DOOR: process.env.NEXT_PUBLIC_CASCADE_FRONT_DOOR,
  NEXT_PUBLIC_CASCADE_BASE_ADAPTER: process.env.NEXT_PUBLIC_CASCADE_BASE_ADAPTER,
  NEXT_PUBLIC_CASCADE_VAULT: process.env.NEXT_PUBLIC_CASCADE_VAULT,
  NEXT_PUBLIC_CASCADE_BIT_ADAPTER: process.env.NEXT_PUBLIC_CASCADE_BIT_ADAPTER,
  NEXT_PUBLIC_CASCADE_BIT_BLOCK: process.env.NEXT_PUBLIC_CASCADE_BIT_BLOCK,
  NEXT_PUBLIC_CASCADE_VAULT_SS58: process.env.NEXT_PUBLIC_CASCADE_VAULT_SS58,
  NEXT_PUBLIC_CASCADE_HOTKEY_SS58: process.env.NEXT_PUBLIC_CASCADE_HOTKEY_SS58,
  NEXT_PUBLIC_CASCADE_STAKER: process.env.NEXT_PUBLIC_CASCADE_STAKER,
  NEXT_PUBLIC_CASCADE_ORACLE: process.env.NEXT_PUBLIC_CASCADE_ORACLE,
  NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S: process.env.NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S,
  NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: process.env.NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S,
}));

export const TOKENS = {
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  weth: "0x4200000000000000000000000000000000000006",
  tao: "0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67",
} as const satisfies Record<string, Address>;

export const UNISWAP = {
  router: "0x2626664c2603336E57B271c5C0b26F421741e481",
  quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
} as const satisfies Record<string, Address>;

/** CCIP OffRamp 2.0.0 on each chain (contracts/test/fork/ForkBase.sol). */
export const OFFRAMP = {
  base: "0x16E577f1724AE2598F9b43a52C19E6f67eE13808",
  bittensor: "0xF9410A08FD57e629c66E1f37a5Ae8f0a757d9AD9",
} as const satisfies Record<string, Address>;

export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

/** Public RPCs only: no key ever goes into the site. Base's refuses eth_getLogs, so the site never asks it for logs. */
/** Public RPCs the browser reads (no keys in the bundle). Bittensor is OpenTensor's archive node: the
 * lite node keeps only minutes of event history, so older deliveries and stakes would look missing. */
export const RPC = {
  base: "https://mainnet.base.org",
  /** Base log reads: mainnet.base.org refuses eth_getLogs. PublicNode allows CORS *, windows of at most 2,000 blocks. */
  baseLogs: "https://base-rpc.publicnode.com",
  bittensor: "https://archive.chain.opentensor.ai",
} as const;

/** How far below the oracle's value a delivery's price floor sits, in basis points. */
export const DELIVERY_TOLERANCE_BPS = 200;
/** How long a delivery instruction stays valid: 7 days, in seconds. */
export const DELIVERY_VALIDITY_S = 604_800;
/** The delivery destination code for USDC on Base. */
export const DESTINATION_BASE = 6;
/** USDC's EIP-712 domain for permits (chainId 8453, verifyingContract TOKENS.usdc). */
export const USDC_PERMIT = { name: "USD Coin", version: "2" } as const;

/** The yield, in percent a year and before Cascade's reward cut, that the stake form's break-even
 * line assumes: tao.bot's 30-day root yield, October 2026. */
export const ROOT_YIELD_PCT = 5.9;

export const SLIPPAGE_BPS = 50n;
/** The smallest unstake (and remainder) the form allows (see units.checkUnstake): 0.011 TAO. The vault
 * defers, without burning, a front-door redeem worth less than 0.01 TAO at the batch's price
 * (MIN_REDEEM_VALUE), and the user would have paid the request fee for nothing; 10% more covers the
 * rounding between the form's price and the vault's. */
export const MIN_UNSTAKE_WEI = 11n * 10n ** 15n;

/** USDC –0.05%→ WETH –0.3%→ TAO, Uniswap v3 (the cheapest, deepest route on Base). */
export const PATH_USDC_TO_TAO = encodePacked(
  ["address", "uint24", "address", "uint24", "address"],
  [TOKENS.usdc, 500, TOKENS.weth, 3000, TOKENS.tao],
);
/** TAO –0.3%→ WETH –0.05%→ USDC: selling TAO, and (as exactOutput's reversed path) buying an exact TAO amount. */
export const PATH_TAO_TO_USDC = encodePacked(
  ["address", "uint24", "address", "uint24", "address"],
  [TOKENS.tao, 3000, TOKENS.weth, 500, TOKENS.usdc],
);

export const explorer = {
  baseTx: (hash: string) => `https://basescan.org/tx/${hash}`,
  bittensorTx: (hash: string) => `https://evm.taostats.io/tx/${hash}`,
  ccip: (messageId: string) => `https://ccip.chain.link/msg/${messageId}`,
  /** Every bridge message an address sent, on Chainlink's explorer. */
  ccipAddress: (address: string) => `https://ccip.chain.link/address/${address}`,
  account: (ss58: string) => `https://taostats.io/account/${ss58}`,
};

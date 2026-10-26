import { type Address, encodePacked, isAddress } from "viem";

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
}

/** A v3 deployment has both the staker and the oracle; otherwise the site keeps the v2 flows. */
export const isV3 = (d: Deployment): boolean => Boolean(d.staker && d.oracle);

type Env = Record<string, string | undefined>;

const address = (v: string | undefined): Address | null => (v && isAddress(v, { strict: true }) && v !== v.toLowerCase() ? v : null);

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
  const maxWait = env.NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S;
  const batchMaxWaitS = maxWait && /^[1-9]\d*$/.test(maxWait) ? Number(maxWait) : undefined;
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
  };
}

/** Next inlines each NEXT_PUBLIC_ value only where it is written out by name. */
export const DEPLOYMENT = readDeployment({
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
});

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
/** The smallest unstake (and remainder) that can always be paid out (see units.checkUnstake). */
export const MIN_UNSTAKE_WEI = 5n * 10n ** 15n;

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

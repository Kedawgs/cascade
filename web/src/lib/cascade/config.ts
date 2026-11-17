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
  /** v3.2 only: the read-only lenses that serve the getters v3.2 moved off the vault (CascadeVaultLens, on
   * Bittensor) and off the front door (CascadeDoorLens, on Base). Both or neither (readDeployment refuses
   * one alone), and only on a v3 deployment: with them the site uses v3.2's ABIs (isV32). */
  vaultLens?: Address;
  doorLens?: Address;
  /** The history indexer's origin (`https://…`, no path), from NEXT_PUBLIC_CASCADE_INDEXER_URL: a first
   * visit starts its scan of the vault's history from the indexer's seed, verified against the chain
   * (live.ts, seed.ts). Absent = the site reads the whole history from the chains itself, as before.
   * Required on v3.2 (readDeployment refuses a v3.2 env without it): its outside-price veto reads it. */
  indexerUrl?: string;
}

/** `v` as the indexer's origin, only when it is exactly an https origin (scheme and host, a port at most:
 * no path, slash, query, fragment, credentials or wildcard); null for anything else, so a value that
 * isn't one leaves the site reading the chains as before. The CSP build step (scripts/csp-headers.mjs)
 * applies the same rule, so the page may connect exactly where the code asks. */
export function indexerOrigin(v: string | undefined): string | null {
  if (!v) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  return url.protocol === "https:" && url.origin === v && HOSTNAME.test(url.hostname) ? v : null;
}

/** A DNS name: labels of letters, digits and hyphens (no wildcard, which the URL parser lets through). */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** Minutes from a batch leaving Base to its TAO staked: the crossing (Chainlink, at the slow end of its
 * usual 20–30 minutes) and the stake. The stake form's estimate and the panel after a stake both count
 * them. */
export const BRIDGE_MINUTES = 25;
export const STAKE_MINUTES = 2;

/** When the open batch can be expected to close, by the latest: its interval, or the deployment's max wait if longer. */
export const batchCloseAt = (openStart: number, batchInterval: number, batchMaxWaitS?: number): Date =>
  new Date((openStart + Math.max(batchInterval, batchMaxWaitS ?? 0)) * 1000);

/** A v3 deployment has both the staker and the oracle; a v2 one has neither (readDeployment refuses any
 * other mix), and only then does the site keep the v2 flows. */
export const isV3 = (d: Deployment): boolean => Boolean(d.staker && d.oracle);

/** A v3.2 deployment is a v3 one with both lenses (readDeployment refuses any other mix): the site then calls
 * and decodes with v3.2's ABIs (abi.ts) and reads the moved getters through the lenses. Every other
 * deployment, v3-launch above all, keeps its own ABIs and flows exactly as they are. */
export const isV32 = (d: Deployment | null | undefined): boolean => !!d && isV3(d) && Boolean(d.vaultLens && d.doorLens);

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
  const vaultLens = address(env.NEXT_PUBLIC_CASCADE_VAULT_LENS);
  const doorLens = address(env.NEXT_PUBLIC_CASCADE_DOOR_LENS);
  const namesV32 = [env.NEXT_PUBLIC_CASCADE_VAULT_LENS, env.NEXT_PUBLIC_CASCADE_DOOR_LENS].some((v) => !!v);
  if (namesV32 && (!vaultLens || !doorLens || !staker || !oracle)) {
    throw new Error(
      "The env names a v3.2 deployment but not both its lenses as checksummed addresses (NEXT_PUBLIC_CASCADE_VAULT_LENS, " +
        "NEXT_PUBLIC_CASCADE_DOOR_LENS) on a v3 deployment with a staker and an oracle. Refusing to read v3.2's contracts " +
        "through v3-launch's getters: run `pnpm ops web-config` again.",
    );
  }
  const maxWait = env.NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S;
  const batchMaxWaitS = maxWait && /^[1-9]\d*$/.test(maxWait) ? Number(maxWait) : undefined;
  // 0 is a real setting (no delay), so it is kept; anything but plain digits is left out
  const delay = env.NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S;
  const payoutDelayS = delay && /^(0|[1-9]\d*)$/.test(delay) ? Number(delay) : undefined;
  const indexerUrl = indexerOrigin(env.NEXT_PUBLIC_CASCADE_INDEXER_URL);
  // v3.2's outside-price veto reads the indexer before every stake and USDC unstake, and fails closed without it
  // (price-veto.ts): a v3.2 site with no indexer would refuse them all, so none is built
  if (vaultLens && doorLens && !indexerUrl) {
    throw new Error(
      "The env names a v3.2 deployment but no indexer: NEXT_PUBLIC_CASCADE_INDEXER_URL must be the indexer's https origin " +
        "(no path). v3.2 checks the price on Base against the indexer's outside price before every stake and USDC unstake, " +
        "and refuses them without it. Refusing to build a site that would refuse them all: set it (`pnpm ops web-config` " +
        "writes it from OPS_INDEXER_URL).",
    );
  }
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
    ...(vaultLens && doorLens ? { vaultLens, doorLens } : {}),
    ...(batchMaxWaitS ? { batchMaxWaitS } : {}),
    ...(payoutDelayS !== undefined ? { payoutDelayS } : {}),
    ...(indexerUrl ? { indexerUrl } : {}),
  };
}

/** How the site describes a deployment (the FAQ's answers): "testing" (a test deployment: one key holds
 * every role, and depositing isn't recommended), "early" (the launch: real deposits under a cap, the owner
 * one hardware wallet, a separate guardian, no multisig or timelock yet), "live" (a multisig owner
 * behind a timelock), or "retired" (a version of Cascade that is retired: the site shows only the ways out,
 * never a stake or a deposit; Task 60, spec §7 "Retiring v3-launch"). */
export type Stage = "testing" | "early" | "live" | "retired";
const STAGES: readonly string[] = ["testing", "early", "live", "retired"] satisfies Stage[];

/** A deployment the site may be built for, as committed in deployments.json (reviewed in git). */
export interface ExpectedDeployment {
  version: 2 | 3;
  stage: Stage;
  /** A retired deployment only: the stage it was retired from (v3-launch's, at Task 69, "early"), which words its FAQ and
   * audit card: its owner and guardian are still what that stage's answers say (wordingStage). */
  retiredFrom?: Exclude<Stage, "retired">;
  /** v3.2 only: whether the site offers USDC delivery. `false` is the founder's switch for when ForeverMoney or the
   * pools can't be trusted, the stalemate's answer (spec §5): every USDC option is hidden, Receive TAO and the claim
   * stay open, and an account with a delivery preference is prompted to claim, which clears it. Absent = on; every
   * v3.2 entry names it (deployments.test.ts). A deployment without Receive TAO can't turn it off (checkedDeployment). */
  usdcDelivery?: boolean;
  frontDoor: string;
  baseAdapter: string;
  vault: string;
  bitAdapter: string;
  /** Whether the deployment's contract source is published (the public repository, the explorers' verified source).
   * Absent = published. `false` while a new deployment's code waits to be published (v3.2-launch's did, until Task 70):
   * the site then never says "open source" of its contracts, and says when the code comes instead (sourcePublished). */
  sourcePublished?: boolean;
  /** v3 only. */
  staker?: string;
  oracle?: string;
  /** v3.2 only: its two lenses, both or neither (a v3 entry with them is a v3.2 deployment). */
  vaultLens?: string;
  doorLens?: string;
  bitBlock: string;
  vaultSs58: string;
  hotkeySs58: string;
  /** Pinned settings: a build whose env gives another value (or none) fails (checkedDeployment). */
  payoutDelayS?: number;
  batchMaxWaitS?: number;
  /** The vault's unstake limits as the deployment set them (ops/src/config.ts; the FAQ quotes them): one
   * unstake's most (maxEntryValue), and the daily outflow, a share of the stake or a floor if larger. */
  unstakeLimits?: { maxEntryTao: number; dailyOutflowPct: number; dailyFloorTao: number };
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
      sameAddress(e.vaultLens, d.vaultLens) &&
      sameAddress(e.doorLens, d.doorLens) &&
      e.bitBlock === String(d.bitBlock) &&
      e.vaultSs58 === d.vaultSs58 &&
      e.hotkeySs58 === d.hotkeySs58,
  )?.[0];
}

/** The committed entry `d` is, or undefined for no deployment or one not listed. */
export function deploymentEntry(d: Deployment | null, list: Readonly<Record<string, ExpectedDeployment>> = EXPECTED_DEPLOYMENTS): ExpectedDeployment | undefined {
  const name = d ? knownDeployment(d, list) : undefined;
  return name ? list[name] : undefined;
}

/** The stage deployments.json gives `d`. It fails closed: "testing", the most careful wording, for no
 * deployment, one not listed, or a stage that isn't exactly one of the four. */
export function deploymentStage(d: Deployment | null, list: Readonly<Record<string, ExpectedDeployment>> = EXPECTED_DEPLOYMENTS): Stage {
  const stage: unknown = deploymentEntry(d, list)?.stage;
  return typeof stage === "string" && STAGES.includes(stage) ? (stage as Stage) : "testing";
}

/** The stage the site's words describe `d` as (the FAQ, the audit card): its stage, but for a retired one the stage it
 * was retired from (its entry's `retiredFrom`), whose owner and guardian it still has. It fails closed: "testing" for a
 * retired entry that doesn't name exactly one of the other three, as for any stage deploymentStage doesn't know. */
export function wordingStage(d: Deployment | null, list: Readonly<Record<string, ExpectedDeployment>> = EXPECTED_DEPLOYMENTS): Exclude<Stage, "retired"> {
  const stage = deploymentStage(d, list);
  return stage === "retired" ? retiredWording(deploymentEntry(d, list)?.retiredFrom) : stage;
}

/** Whether the site may say `d`'s contracts are open source (deployments.json `sourcePublished`): yes unless its entry
 * says false. No deployment, or an entry that doesn't say, keeps the words the site always had. */
export function sourcePublished(d: Deployment | null, list: Readonly<Record<string, ExpectedDeployment>> = EXPECTED_DEPLOYMENTS): boolean {
  return deploymentEntry(d, list)?.sourcePublished !== false;
}

/** A retired deployment's `retiredFrom`, exactly testing, early or live; "testing" for anything else (fail closed). */
export const retiredWording = (v: unknown): Exclude<Stage, "retired"> => (v === "early" || v === "live" || v === "testing" ? v : "testing");

/** Whether the site offers USDC delivery for `d` (deployments.json `usdcDelivery`, v3.2's switch: spec §5). Only a v3.2
 * deployment can turn it off, since only v3.2 has Receive TAO (an unstake with no delivery) for its unstakes to take
 * instead; every other deployment keeps its USDC unstake, whatever its entry says (checkedDeployment refuses that
 * entry). On v3.2 it is off for `false`, and fails closed for any value that isn't a boolean; absent, it is on. */
export function usdcDeliveryOn(d: Deployment | null, list: Readonly<Record<string, ExpectedDeployment>> = EXPECTED_DEPLOYMENTS): boolean {
  if (!isV32(d)) return true;
  const v: unknown = deploymentEntry(d, list)?.usdcDelivery;
  return v === undefined || v === true;
}

const PINNED = [
  ["payoutDelayS", "NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S"],
  ["batchMaxWaitS", "NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S"],
] as const;

/** The env's deployment, only if it is one of the committed ones, with the settings its entry pins: anything
 * else throws, so `next build` (and `next dev`) fail rather than make a site that sends to contracts no one
 * reviewed, or describes their timing wrongly. */
export function checkedDeployment(d: Deployment | null, list: Readonly<Record<string, ExpectedDeployment>> = EXPECTED_DEPLOYMENTS): Deployment | null {
  if (!d) return d;
  const name = knownDeployment(d, list);
  if (!name) {
    throw new Error(
      "The env names a deployment that isn't in web/src/lib/cascade/deployments.json. Refusing to build a site " +
        "for contracts that aren't listed there: add the deployment to that file in a reviewed commit, or run " +
        "`pnpm ops web-config` for a listed one.",
    );
  }
  for (const [key, env] of PINNED) {
    const pinned = list[name][key];
    if (pinned !== undefined && d[key] !== pinned) {
      throw new Error(
        `The env's ${env} is ${d[key] ?? "not set"}, but deployments.json pins ${name}'s at ${pinned}. Refusing to build a site ` +
          "that describes the deployment's timing wrongly: run `pnpm ops web-config` again.",
      );
    }
  }
  if (!isV32(d) && list[name].usdcDelivery === false) {
    throw new Error(
      `deployments.json turns off ${name}'s USDC delivery (usdcDelivery: false), but only a v3.2 deployment can: it has Receive TAO ` +
        "for its unstakes instead. Refusing to build a site whose unstakes would have nowhere to go.",
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
  NEXT_PUBLIC_CASCADE_VAULT_LENS: process.env.NEXT_PUBLIC_CASCADE_VAULT_LENS,
  NEXT_PUBLIC_CASCADE_DOOR_LENS: process.env.NEXT_PUBLIC_CASCADE_DOOR_LENS,
  NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S: process.env.NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S,
  NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: process.env.NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S,
  NEXT_PUBLIC_CASCADE_INDEXER_URL: process.env.NEXT_PUBLIC_CASCADE_INDEXER_URL,
}));

export const TOKENS = {
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  weth: "0x4200000000000000000000000000000000000006",
  tao: "0xf3081494B87e8D5fb7960f066E931D1D0e6E3d67",
} as const satisfies Record<string, Address>;

/** ForeverMoney's TAO on Base, as a wallet adds it (EIP-747; add-to-wallet.ts): what a claim or a cancel pays out,
 * on v3-launch and v3.2 alike. Its address is TOKENS.tao, the one place it is typed: ops deploys every Base contract
 * with the same token (ops/src/config.ts LIVE.base.TOKEN, read back by ops verify), and wiring.ts holds the front
 * door's asset() and the adapter's token() to TOKENS.tao before anything is sent. Every front door refuses an asset
 * without 18 decimals (CascadeFrontDoor's UnsupportedDecimals); "TAO" is the token's own symbol() (a wallet checks
 * it against the token before adding it). add-to-wallet.test.ts holds all three to those sources. */
export const FM_TAO = { address: TOKENS.tao, symbol: "TAO", decimals: 18 } as const;

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

/** ForeverMoney's AlphaVault on Bittensor (ops/src/config.ts LIVE.ALPHA_VAULT): a batch can't be taken
 * while it is paused or migrating, so nothing offers to send one then. */
export const ALPHA_VAULT: Address = "0x11837459896D96F821a8D88eC93a3C8D152033D4";

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
/** How long a stopped stake can be carried on: a day. One stopped longer ago is started again at
 * today's price (flows.ts, freshStakeTerms; trail.ts shows it so). */
export const RESUME_WINDOW_MS = 24 * 60 * 60_000;
/** How far ahead of the real time a record's date may be and still be read as it is: a day, as far as a
 * device's clock plausibly runs fast. The op log reads a date further ahead as a day old (oplog.ts), so
 * it lapses; and a search of the chain for a record's transaction reaches this much further back than
 * the record's age says (facts.ts, searchBaseSince), so a clock put back since never hides one. */
export const CLOCK_AHEAD_MS = 24 * 60 * 60_000;
/** Before any stake is sent, the quote it is priced from is checked against the 30-minute TWAP of
 * Cascade's own oracle (CascadeTwapOracle.usdcValue), read on the other Base RPC: a spot price more than
 * this far from the oracle's, either way, in basis points, sends nothing (flows.ts, assertPriceAgrees).
 * 5%: over the oracle's first 14 hours on mainnet (30–31 Oct 2026, TAO $230–$238, read every 15
 * minutes), what buying $20 to $1,000 of TAO paid sat between 0.3% under and 0.9% over the oracle (p95
 * 0.8%), pool fees and impact included; TAO moves about 1% in a typical half hour, so 5% is about five
 * such moves against a 30-minute average, which an honest market all but never shows, while a quote 5%
 * off the oracle is one no honest pool gives. */
export const PRICE_CHECK_BPS = 500n;
/** The bridge fee is read on both Base RPCs before Send it now is offered: quotes more than this far
 * apart, in basis points, are trusted from neither (reads.ts, readOpenBatch). 10%: the two reads are
 * seconds apart, and the fee moves only when the bridge's price feeds update, a step of a few percent. */
export const FEE_CHECK_BPS = 1_000n;
/** The smallest unstake (and remainder) the form allows on v3.2 (see units.checkUnstake): 0.033 TAO. v3.2's
 * vault defers, without burning, a front-door redeem worth less than 0.03 TAO at the batch's price
 * (MIN_REDEEM_VALUE, contracts/src/CascadeConstants.sol), and the user would have paid the request fee for
 * nothing; 10% more covers the rounding between the form's price and the vault's. */
export const MIN_UNSTAKE_WEI = 33n * 10n ** 15n;
/** The same for v3-launch and every deployment before v3.2: 0.011 TAO, over their vault's 0.01 TAO. */
export const MIN_UNSTAKE_WEI_V3 = 11n * 10n ** 15n;
/** The unstake minimum of deployment `d`: v3.2's for a v3.2 deployment, else v3-launch's. */
export const minUnstakeWei = (d: Deployment | null | undefined): bigint => (isV32(d) ? MIN_UNSTAKE_WEI : MIN_UNSTAKE_WEI_V3);

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
  /** A contract (or any address) on Base. */
  baseAddress: (addr: string) => `https://basescan.org/address/${addr}`,
  /** A contract on Bittensor's EVM, on the same explorer as bittensorTx. */
  bittensorAddress: (addr: string) => `https://evm.taostats.io/address/${addr}`,
  /** A contract's verified source, on Sourcify's viewer, by chain id. Every v3.2 contract is an exact match there on
   * both chains; the block explorers need not carry the source (Basescan has none for them), and Bittensor's EVM
   * explorer was down when the founder tried it (2026-11-16). */
  code: (chainId: number, addr: string) => `https://repo.sourcify.dev/${chainId}/${addr}`,
  /** A validator's page on taostats, by its SS58 hotkey (the FAQ links the same pages). */
  validator: (hotkeySs58: string) => `https://taostats.io/validators/${hotkeySs58}`,
  /** The bridge lane on Chainlink's CCIP explorer. It has no page per lane, so this is the page of the
   * Base token pool, which every Base-to-Bittensor transfer of the bridged TAO goes through: its messages
   * are the lane's traffic. (`ccipAddress` is the same page for any sender.) */
  ccipLane: (baseTokenPool: string) => `https://ccip.chain.link/address/${baseTokenPool}`,
};

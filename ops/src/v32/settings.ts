import { type Address, formatEther, getAddress, type Hex, isAddress, zeroAddress } from "viem";
import { type ChainName, deploymentName, type Env, paths, WALLET } from "../config.ts";
import { adapterCapProblems, ROUTE_0 } from "../plan.ts";
import { MS_PER_BLOCK_PINS } from "./classes.ts";
import type { AccountKind } from "../safe.ts";
import { decodeSs58 } from "../ss58.ts";

/** R6 (ChatGPT R2 claim C): the gas limit a write-off's execute is sent with, set by the file, never a wallet's estimate.
 * The vault gives the write-off's coldkey-total read its own cap, WRITE_OFF_READ_GAS 45,000,000 (the chain's ceiling for
 * that read under spec 490: 256 hotkeys on 129 subnets), whole (requireGasFor): through execute's self-call and the
 * read's call, each at 63/64, about 46.5M at the transaction. Under Bittensor's per-transaction ceiling (scheduler.ts
 * checks it against keeper/core/ceiling.ts). Only the gas used is paid, but the owner's account must hold the limit at
 * the gas price up front (budget.ts counts it). */
export const WRITE_OFF_EXECUTE_GAS = 47_000_000n;

/** R11 (ChatGPT r3, claim 1): the vault's cap on the write-off's read of the unlisted stake (CascadeFormulas
 * WRITE_OFF_READ_GAS), which verify prices the live read against (test/v32-verify.test.ts holds it to the source). */
export const WRITE_OFF_READ_GAS = 45_000_000n;

/** R11 (ChatGPT r3, claim 2): the gas the Bittensor adapter's canSendPayouts() gives each of its reads of ForeverMoney's
 * AlphaVault (CcipBittensorAdapter.RAIL_READ_GAS), which verify asks each getter with (held to the source too). */
export const ALPHA_READ_GAS = 30_000n;

// v3.2's launch settings (spec Appendix B) and the plan's inputs (spec §7). v3.2 deploys constructor-only: every
// setting below is a constructor parameter, nothing is set afterwards (§7 step 4, "nothing to set"). v3-launch's
// settings (config.ts SETTINGS_V3_LAUNCH, LAUNCH_VAULT_LIMITS) are a different deployment's and stay as they are.

const TAO = 10n ** 18n;

/** Who holds each role, the same accounts on both chains (the founder's decisions: one Ledger, the guardian its
 * second account, a keeper of its own, the treasury of Appendix B). */
export interface V32Roles {
  owner: Address;
  guardian: Address;
  keeper: Address;
  treasury: Address;
}

/** The validators, as bytes32 hotkeys from configuration (never contract constants): the primary is the vault's
 * first and stake hotkey; the standby is recorded for verify and for Task 68, never passed to a constructor. */
export interface V32Validators {
  primary: Hex;
  standby: Hex;
}

/** A gas model: the destination gas a message asks CCIP for, `base + entries * perEntry` (CcipAdapterBase.gasFor). */
export interface GasModel {
  base: bigint;
  perEntry: bigint;
}

export interface SettingsV32 {
  treasury: Address;
  frontDoor: {
    depositCap: bigint;
    maxBatchValue: bigint;
    minDeposit: bigint;
    batchInterval: bigint;
    redeemRequestFee: bigint;
    maxDeposits: number;
    maxRedeems: number;
    maxDeliverySlippageBps: number;
    /** milliseconds (Revision 28): MS_PER_BLOCK_PINS.base */
    msPerBlock: bigint;
  };
  vault: {
    launchChain: bigint;
    payoutDelay: bigint;
    maxDailyOutflowBps: bigint;
    minDailyOutflow: bigint;
    globalOutflowBps: bigint;
    maxEntryValue: bigint;
    maxMessageValue: bigint;
    minChunk: number;
    maxFeeBps: bigint;
    maxFeeAbs: bigint;
    maxTotalAssets: bigint;
    rewardCutBps: number;
    rewardVesting: bigint;
    idleBufferBps: number;
    unstakeGas: bigint;
    unstakeMarginRao: bigint;
    minDirectDeposit: bigint;
    hotkeyDustRao: bigint;
    /** milliseconds (Revision 28): MS_PER_BLOCK_PINS.bittensor */
    msPerBlock: bigint;
  };
  adapters: { maxMessageValue: { base: bigint; bittensor: bigint }; minSendAmount: bigint };
  staker: { route0: typeof ROUTE_0; deliveryRouteId: number; swapFeeBps: number; depositFeeUsdc: bigint };
  /** Each adapter's destination gas: the Base adapter's toward Bittensor, the Bittensor adapter's toward Base.
   * `source` names the measurement the figures come from (Task 65 set it: Task 61a's fork measurement); a live deploy
   * refuses without it (liveGasProblem). */
  gas: { towardBittensor: GasModel; towardBase: GasModel; source?: string };
}

/** Every Appendix B launch value, once (spec Appendix B; contracts/test/utils/DefaultParams.sol's
 * withLaunchValues agrees where it sets one, and test/v32-plan.test.ts reads both sources to hold it so, but for the
 * fixtures' own rewardVesting and redeemRequestFee, which Appendix B alone sets). The
 * owner, guardian and keeper are the plan's roles; claimGasRequired and the pools' floors are the plan's inputs
 * (Appendix B: measured at deploy). */
export const SETTINGS_V32_LAUNCH = {
  /** Immutable in the adapters and the front door, scheduled on the vault, the staker's too. */
  treasury: "0x34D1f7DC8Cb62280d0bc617b784Bd2c4668809f6",
  frontDoor: {
    depositCap: 40n * TAO,
    maxBatchValue: 10n * TAO,
    minDeposit: (4n * TAO) / 100n,
    /** 1 hour */
    batchInterval: 3_600n,
    /** 0.0002 ETH (the founder, 2026-11-16; 0.0001 ETH before, v3-launch's): a full redeem list, 50 requests, pays 0.01
     * ETH into the pot, about 2.3 times the bridge fee to close a full 50 + 50 batch (about 0.0043 ETH), so a list filled
     * with fake requests still closes itself on its pot (R12a; the monitor's batch.redeem_fee_thin warns below 1.5 times) */
    redeemRequestFee: 2n * 10n ** 14n,
    maxDeposits: 50,
    maxRedeems: 50,
    /** 1.5% */
    maxDeliverySlippageBps: 150,
    /** Base's block time as the deploy calibrates it, in milliseconds: twice as fast as its 0.2 s blocks (Revision 28) */
    msPerBlock: 120n,
  },
  vault: {
    launchChain: 8_453n,
    /** 24 hours */
    payoutDelay: 86_400n,
    maxDailyOutflowBps: 2_000n,
    minDailyOutflow: 10n * TAO,
    globalOutflowBps: 2_000n,
    maxEntryValue: 10n * TAO,
    maxMessageValue: 15n * TAO,
    minChunk: 10,
    /** 1% */
    maxFeeBps: 100n,
    maxFeeAbs: (15n * TAO) / 1_000n,
    maxTotalAssets: 44n * TAO,
    /** 10% */
    rewardCutBps: 1_000,
    /** 30 days, the contract's maximum (R4, the vault-favour review's Medium 1: was 7): the claim policy's longest gap
     * between claims on a small vault (core/rewards.ts CLAIM_GAP_MAX_S), so a holder present only while rewards vest takes
     * no more than its time share of them */
    rewardVesting: 2_592_000n,
    idleBufferBps: 0,
    unstakeGas: 400_000n,
    unstakeMarginRao: 0n,
    minDirectDeposit: TAO / 100n,
    /** 0.001 TAO */
    hotkeyDustRao: 1_000_000n,
    /** Bittensor's block time as the deploy calibrates it, in milliseconds: twice as fast as its 12 s blocks (Revision 28) */
    msPerBlock: 7_200n,
  },
  adapters: {
    /** 50 TAO each: a stolen or buggy send moves at most that. */
    maxMessageValue: { base: 50n * TAO, bittensor: 50n * TAO },
    /** The Base adapter's minSendAmount (immutable), below the 0.04 TAO minimum deposit. */
    minSendAmount: TAO / 100n,
  },
  staker: {
    /** Uniswap, USDC -0.05%-> WETH -0.3%-> TAO and back, through SwapRouter02 (v3-launch's route 0). */
    route0: ROUTE_0,
    /** The only id the constructor can name: the route must be active. */
    deliveryRouteId: 0,
    /** 0.15% */
    swapFeeBps: 15,
    /** $0.05, in USDC units */
    depositFeeUsdc: 50_000n,
  },
  /** Appendix B has no gas row: these are the figures contracts/test/adapters/AdapterGas.t.sol calibrates and Task 61a
   * measured on the forks (the testnet's Task 64 was dropped on 2026-11-11), written in by Task 65, which set `source`,
   * the measurement's record (`deploy --v32 --live` refuses without one: liveGasProblem). The adapters' gas is
   * immutable: a wrong figure means new adapters. */
  gas: {
    /** The Base adapter's, toward Bittensor, and the Bittensor adapter's inbound pair: the R4 review's launch pair,
     * which includes the park's gas reserve (PARK_GAS_RESERVE, 150,000, counted once, here), exactly 7,000,000 at 100
     * entries. Task 61a's forks kept it: the tightest point, 50 + 1, has 260,376 over the 15% rule. */
    towardBittensor: { base: 1_300_000n, perEntry: 57_000n },
    /** The Bittensor adapter's, toward Base (the T61a review's I-2, raised at Task 65 from 140,000 / 29,900): the Base
     * fork at block 57,607,777 measured one payout at 126,003 with the live door's netForwarded write (2,800 more than
     * the forks first read), fifty at 1,373,140; at 180,000 / 32,000 they have 42% and 30% over their need. */
    towardBase: { base: 180_000n, perEntry: 32_000n },
    source:
      "Task 61a's fork measurement (2026-11-14: BaseForkV32 at Base block 57,607,777 and BittensorForkV32 at Bittensor block 9,508,000; AdapterGas.t.sol re-calibrated), written in by Task 65 (toward Base raised to 180,000 / 32,000 by the T61a review's I-2; toward Bittensor kept)",
  },
} as const satisfies SettingsV32;

/** The contracts' own bounds the plan checks its inputs and settings against, so that no CREATE reverts on one
 * (each copied from the source; test/v32-plan.test.ts reads the source to hold them equal). */
export const BOUNDS_V32 = {
  /** CascadeMessages.MAX_ENTRIES: entries a side in one message. */
  maxEntries: 50,
  /** CcipAdapterBase.GAS_CAP: the most gas any message asks for. */
  gasCap: 7_000_000n,
  /** CcipAdapterBase.MAX_MESSAGE_VALUE: the lane's per-message limit. */
  maxMessageValue: 5_000n * TAO,
  /** CascadeConstants.MIN_CLAIM_GAS and MAX_CLAIM_GAS: claimGasRequired's bounds (MAX 63,400,000 since the Task 65 review:
   * with the claim's own work, 500,000 allowed, and a 1,000,000 margin, the most Bittensor's per-transaction ceiling holds;
   * MIN 54,100,000 since the R5 contracts review: the call forwards 63/64 of what is left, so at 53,200,000 left the
   * precompile would get about 52,370,000, under its 53,200,000; at 54,100,000 it gets about 53,255,000). */
  minClaimGas: 54_100_000n,
  maxClaimGas: 63_400_000n,
  /** CascadeFrontDoor.MAX_BATCH_VALUE: the lane's 5,000 TAO, the most a batch can be set to hold; since R7 setCaps also
   * refuses a minDeposit above it (pnpm ops set-caps refuses it first, in plain words). */
  maxBatchValue: 5_000n * TAO,
} as const;

/** The founder level of caps (the plan's Global Constraints): the launch values themselves. */
export const FOUNDER_LEVEL = {
  depositCap: SETTINGS_V32_LAUNCH.frontDoor.depositCap,
  maxTotalAssets: SETTINGS_V32_LAUNCH.vault.maxTotalAssets,
} as const;

/** v3-launch's live keeper, the key its keeper signs with (the plan's Global Constraints "Keys" line names it). v3.2's
 * keeper is a fresh key of its own (the founder's decision, 2026-11-07), so no v3.2 plan ever names this one. */
export const V3_LAUNCH_KEEPER: Address = "0xBE2a34FE20C3006E759537922C807c228707DC23";

/** Who holds each fixed role at launch (the founder's decisions; the plan's Global Constraints, "Keys"): the owner,
 * the guardian (the Ledger's second account, never the owner) and Appendix B's treasury. test/v32-deploy.test.ts holds
 * them to the plan's text. The keeper is not here: it is a fresh key, a plan input from OPS_V32_KEEPER_ADDRESS
 * (keeperFromEnv), with no default. */
export const ROLES_V32_LAUNCH: Omit<V32Roles, "keeper"> = {
  owner: "0x478965abDe80ef000e0f3e60008B43ac46130bFC",
  guardian: "0xf996A598B75ab25B140bC50989C76eBB56B0187F",
  treasury: SETTINGS_V32_LAUNCH.treasury,
};

/** The plan's measured inputs (Appendix B: measured before deploy): the front door's pool floors, TAO/WETH then
 * WETH/USDC (Task 61 step 4 measured them; the founder ruled the values, floors.ts FLOOR_RULES), and the vault's
 * claimGasRequired. Unset, `deploy --v32` refuses without them.
 *
 * claimGasRequired (Task 65, the controller's ruling of 2026-11-15): 55,000,000, v3-launch's own value, 900,000 over
 * MIN_CLAIM_GAS, 54,100,000: the 53,200,000 claimRootWithHotkey needs (its declared weight, read by eth_estimateGas on the
 * live chain, research_notes bittensor_evm_home_chain.md) at the call's 63/64 forwarding. No fork can run the real claim;
 * the mainnet canary measures one (runbook section 3.5, step 7). The setting is the owner's, immediate both ways
 * (setClaimGasRequired), within 54,100,000 to 63,400,000.
 *
 * The pool floors (Task 61 step 4, `pnpm ops pool-floors`, read 2026-11-13 from mainnet.base.org): each pool's 30-minute
 * harmonic-mean liquidity (CascadeTwapOracle.meanLiquidity's formula) at the last block of each of 30 days by time, from
 * block 57,076,681 (2026-11-13 21:35 UTC) back to block 52,655,382 (2026-10-15 21:35 UTC).
 * - TAO/WETH 0.3%: median 3,363,287,060,484,724,984,767; lowest 435,581,045,435,153,588,269 (2026-11-04), highest
 *   4,574,902,528,459,607,591,476. The founder's floor (2026-11-13): a quarter of the median, 840,821,765,121,181,246,191,
 *   which only the two thinnest days fell below (half the median, 2 of the 30 readings were below it).
 * - WETH/USDC 0.05%: median 890,124,659,366,939,137; lowest 451,512,037,179,130,368 (2026-11-13, the latest), highest
 *   1,204,445,089,383,236,011, falling over the month. The founder's floor (2026-11-13): half the lowest,
 *   225,756,018,589,565,184 (half the median sat only 1.4% under the latest reading).
 * Both are owner-adjustable after the deploy: setMinPoolLiquidity, a raise at once, a cut a 48-hour item. */
export const MEASURED_V32: { poolFloors?: [bigint, bigint]; claimGasRequired?: bigint } = {
  poolFloors: [840_821_765_121_181_246_191n, 225_756_018_589_565_184n],
  claimGasRequired: 55_000_000n,
};

const RESERVE_TARGET = 10n ** 15n;
const TOKEN_RESERVE_TARGET = 10n ** 15n;

/** What the founder funds once every contract is deployed (spec §7 step 2), from the contracts' constants
 * (test/v32-deploy.test.ts reads the source to hold them so), in wei:
 * - the vault's ED_RESERVE, and the 500 rao Bittensor's EVM leaves out of every balance it reports (the existential
 *   deposit), so a native balance reads 500 rao below what was sent: the vault gets both, and reads exactly ED_RESERVE
 *   (v3-launch funded its vault 1,500 rao for a 1,000-rao ED_RESERVE);
 * - the Bittensor adapter's native reserve, RESERVE_TARGET plus the same 500 rao, so it reads exactly RESERVE_TARGET
 *   (`adapterReserve`), with no margin: anyone can call sweepSurplus, which leaves exactly that target, so a margin
 *   would only be swept away (the controller's ruling on Task 56's review; the monitor's rule carries the margin);
 * - its token cushion, TOKEN_RESERVE_TARGET (`adapterCushion`), booked with approve then fundCushion (R4, F-1: the
 *   sweep leaves the booked tokenCushion, whatever it is, and sends a plain transfer of the token on to the treasury;
 *   pnpm ops fund-cushion writes the two calls). */
export const FUNDING_V32 = {
  edReserve: 10n ** 12n,
  reserveTarget: RESERVE_TARGET,
  tokenReserveTarget: TOKEN_RESERVE_TARGET,
  existentialDeposit: 5n * 10n ** 11n,
  adapterReserve: RESERVE_TARGET + 5n * 10n ** 11n,
  adapterCushion: TOKEN_RESERVE_TARGET,
  /** CcipBittensorAdapter.SHORTFALL_TOLERANCE_WEI, 1 rao: the most a conversion's mint may come out short, which the booked
   * cushion covers (a mint is whole rao, so a shortfall is 0 or exactly this); a booked cushion under it covers none, and
   * verify fails it as it does an empty one (merge 7b, M3) */
  shortfallTolerance: 10n ** 9n,
  /** From how much token surplus (beyond the token parks and the booked cushion) verify warns (merge 7b, M7): 1,000 rao.
   * A mint's rounding in the adapter's favour adds a rao or so, so only about a thousand of them reach it, and a plain
   * transfer of any real size does (the cushion's own 0.001 is a thousand times more); below it the surplus is noise
   * (the monitor's bridge.cushion_low shows it as a fact) */
  tokenSurplusWarn: 1_000n * 10n ** 9n,
} as const;

/** Why a live deploy must not send the adapters' gas models (immutable), or null: they carry no measurement record
 * (`gas.source`), so they are still the mock figures. */
export function liveGasProblem(source: string | undefined): string | null {
  return source?.trim()
    ? null
    : "the adapters' gas models are not measured yet: SETTINGS_V32_LAUNCH.gas has no source, the record of the measurement Tasks 61, 64 and 65 set with the measured figures (the adapters' gas is immutable); nothing read or sent";
}

/** Whether the CLI's deployment (OPS_DEPLOYMENT) is a v3.2 one: its name starts with "v3.2" (v3.2-launch). */
export const isV32Deployment = (env: Env): boolean => deploymentName(env).startsWith("v3.2");

// ---- the block times (Revision 28) ----

/** What is wrong with each scheduler contract's block time, as lines naming each; none when both are their chains' pins
 * (MS_PER_BLOCK_PINS). The constructor takes milliseconds since Revision 28, so a block time in seconds, the 12 and 2
 * before it, would be taken as 12 ms and 2 ms and stretch every delay's block floor many times over: the plan and the
 * deploy refuse anything but the pin. A missing value (a plan made before Revision 28, which named it secondsPerBlock) is
 * refused too. */
export function msPerBlockProblems(s: { vault: { msPerBlock?: bigint }; frontDoor: { msPerBlock?: bigint } }): string[] {
  const out: string[] = [];
  for (const [who, v, chain] of [
    ["the vault", s.vault.msPerBlock, "bittensor"],
    ["the front door", s.frontDoor.msPerBlock, "base"],
  ] as const) {
    const pin = MS_PER_BLOCK_PINS[chain];
    const label = chain === "base" ? "Base" : "Bittensor";
    if (v === undefined) out.push(`${who}'s msPerBlock is missing (a plan from before Revision 28 named it secondsPerBlock, in seconds): plan it again`);
    else if (v !== pin) out.push(`${who}'s msPerBlock is ${v}, not ${label}'s pin of ${pin} ms (MS_PER_BLOCK_PINS): it is milliseconds (Revision 28), and ${v} would be taken as ${v} ms`);
  }
  return out;
}

// ---- the cap relations (spec §3.9, §7 step 3) ----

/** What breaks the cap relations across the pair, as lines naming each value; none when they hold:
 * `adapterBase.maxMessageValue >= frontDoor.maxBatchValue`, `adapterBit.maxMessageValue >=
 * max(vault.maxMessageValue, vault.maxEntryValue, frontDoor.maxBatchValue)`, the Base adapter's minSendAmount within
 * its cap (adapterCapProblems, ruling B7d), each cap within the lane's 5,000 TAO, and each gas model within GAS_CAP
 * at the largest legal message, 2 * MAX_ENTRIES entries (the adapter's constructor refuses one above it). */
export function capRelationProblemsV32(s: Pick<SettingsV32, "frontDoor" | "vault" | "adapters" | "gas">): string[] {
  const out = adapterCapProblems({
    baseCap: s.adapters.maxMessageValue.base,
    bitCap: s.adapters.maxMessageValue.bittensor,
    minSendAmount: s.adapters.minSendAmount,
    maxBatchValue: s.frontDoor.maxBatchValue,
    vaultMaxMessageValue: s.vault.maxMessageValue,
    maxEntryValue: s.vault.maxEntryValue,
  });
  for (const chain of ["base", "bittensor"] as const) {
    const cap = s.adapters.maxMessageValue[chain];
    if (cap === 0n || cap > BOUNDS_V32.maxMessageValue) {
      out.push(`the ${chain === "base" ? "Base" : "Bittensor"} adapter's maxMessageValue (${formatEther(cap)} TAO) is not above 0 and at most the lane's 5000 TAO`);
    }
  }
  const largest = BigInt(2 * BOUNDS_V32.maxEntries);
  for (const [name, g] of [
    ["toward Bittensor", s.gas.towardBittensor],
    ["toward Base", s.gas.towardBase],
  ] as const) {
    if (g.base + largest * g.perEntry > BOUNDS_V32.gasCap) {
      out.push(`the gas model ${name} (${g.base} + ${g.perEntry} an entry) asks more than GAS_CAP (${BOUNDS_V32.gasCap}) for ${largest} entries`);
    }
  }
  return out;
}

// ---- the Safe warning (ruling B7a: one helper for deploy, verify and the sign page) ----

/** What signs for the owner: an AccountKind's kind (safe.ts), with a Safe's threshold and signer count when read. */
export interface OwnerKind {
  kind: AccountKind["kind"];
  /** An account's EIP-7702 delegate, if its code is one: it still counts as an account. */
  delegation?: Address;
  threshold?: bigint;
  owners?: number;
}

/** Section 5's residual, quoted (spec §5, "The single-key residual and its mitigation"). */
export const SINGLE_KEY_RESIDUAL = [
  "Until the Safe, one Ledger owns every contract on both chains and its second account is the guardian, so a copied seed copies both and the guardian is no check on the owner.",
  "funds stay safe only if the founder does",
] as const;

/** What signs for the owner, in words (deploy's and verify's lines, and the Safe warning). */
export const ownerDescription = (o: OwnerKind): string => {
  switch (o.kind) {
    case "account":
      return o.delegation ? `an account delegated to ${o.delegation} by EIP-7702 (it counts as an account)` : "a plain account";
    case "safe":
      return `a Safe with a threshold of ${o.threshold ?? "?"} and ${o.owners ?? "?"} signers`;
    case "timelock":
      return "a timelock";
    case "contract":
      return "a contract that is not a Safe";
  }
};

/** A Safe that answers getThreshold() >= 2 and getOwners().length >= 3. Anything else, an EIP-7702 delegated
 * account included, is not. */
export const isSafeOwner = (o: OwnerKind): boolean => o.kind === "safe" && (o.threshold ?? 0n) >= 2n && (o.owners ?? 0) >= 3;

/** The loud warning for caps above the founder level (a deposit cap above 40 TAO or maxTotalAssets above 44 TAO)
 * while the owner is not a Safe of at least 2 of 3 signers, quoting section 5's residual; null otherwise. A
 * warning only: deploy, verify, the schedule command and the sign page print it and never refuse (spec §7, D1, D2).
 * An owner whose kind could not be read (undefined) is not known to be a Safe, so it warns, saying so. */
export function capsWarning(caps: { depositCap?: bigint; maxTotalAssets?: bigint }, owner: OwnerKind | undefined): string | null {
  const above: string[] = [];
  if (caps.depositCap !== undefined && caps.depositCap > FOUNDER_LEVEL.depositCap) {
    above.push(`a deposit cap of ${formatEther(caps.depositCap)} TAO (the founder level is ${formatEther(FOUNDER_LEVEL.depositCap)})`);
  }
  if (caps.maxTotalAssets !== undefined && caps.maxTotalAssets > FOUNDER_LEVEL.maxTotalAssets) {
    above.push(`maxTotalAssets of ${formatEther(caps.maxTotalAssets)} TAO (the founder level is ${formatEther(FOUNDER_LEVEL.maxTotalAssets)})`);
  }
  if (!above.length || (owner && isSafeOwner(owner))) return null;
  return [
    `WARNING: ${above.join(" and ")} is above the founder level, and the owner is ${owner ? ownerDescription(owner) : "of a kind that could not be read"}, not a Safe with at least 2 of 3 signers.`,
    `Spec section 5: "${SINGLE_KEY_RESIDUAL[0]}" Until then, "${SINGLE_KEY_RESIDUAL[1]}".`,
    "This is a warning: nothing is refused.",
  ].join("\n");
}

// ---- the plan's inputs from the environment (paths and hotkeys only) ----

/** Where the plan's inputs are named (ops/.env, which the CLI loads, or the shell). Key files are passed by path
 * only: nothing here opens them. */
export const V32_ENV = {
  baseKeystore: "OPS_V32_DEPLOYER_BASE_KEYSTORE",
  basePasswordFile: "OPS_V32_DEPLOYER_BASE_PASSWORD_FILE",
  bittensorKeystore: "OPS_V32_DEPLOYER_BITTENSOR_KEYSTORE",
  bittensorPasswordFile: "OPS_V32_DEPLOYER_BITTENSOR_PASSWORD_FILE",
  primaryHotkey: "OPS_V32_PRIMARY_HOTKEY",
  standbyHotkey: "OPS_V32_STANDBY_HOTKEY",
  keeper: "OPS_V32_KEEPER_ADDRESS",
} as const;

export interface DeployerKey {
  keystore: string;
  passwordFile: string;
}

/** One fresh deployer key per chain, by path: both set, never the same file on both chains, and never the test
 * wallet's keystore (OPS_KEYSTORE). Throws naming every problem. Reads no file. */
export function deployerKeysFromEnv(env: Env): Record<ChainName, DeployerKey> {
  const problems: string[] = [];
  const get = (name: string) => {
    const v = env[name]?.trim() ?? "";
    if (!v) problems.push(`${name} is not set`);
    return v;
  };
  const keys: Record<ChainName, DeployerKey> = {
    base: { keystore: get(V32_ENV.baseKeystore), passwordFile: get(V32_ENV.basePasswordFile) },
    bittensor: { keystore: get(V32_ENV.bittensorKeystore), passwordFile: get(V32_ENV.bittensorPasswordFile) },
  };
  const same = (a: string, b: string) => a !== "" && a.replaceAll("\\", "/").toLowerCase() === b.replaceAll("\\", "/").toLowerCase();
  if (same(keys.base.keystore, keys.bittensor.keystore)) problems.push("the Base and Bittensor deployers are the same keystore: each chain needs its own fresh key");
  for (const chain of ["base", "bittensor"] as const) {
    if (same(keys[chain].keystore, paths(env).keystore)) problems.push(`the ${chain === "base" ? "Base" : "Bittensor"} deployer is the test wallet's keystore: use a fresh key`);
  }
  if (problems.length) throw new Error(`the v3.2 deployer keys are not ready:\n  ${problems.join("\n  ")}\nnothing read or sent`);
  return keys;
}

/** A hotkey as bytes32, from an SS58 address (Bittensor's prefix 42, checksum checked) or 32 bytes of hex. */
export function parseHotkey(name: string, value: string | undefined): Hex {
  const v = value?.trim() ?? "";
  if (!v) throw new Error(`${name} is not set`);
  let key: Hex;
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) key = v.toLowerCase() as Hex;
  else if (v.startsWith("0x")) throw new Error(`${name} "${v}" is not 32 bytes of hex`);
  else {
    try {
      key = decodeSs58(v);
    } catch (e) {
      throw new Error(`${name} "${v}" is not an SS58 address or 32 bytes of hex (${(e as Error).message})`);
    }
  }
  if (/^0x0{64}$/.test(key)) throw new Error(`${name} is the zero hotkey`);
  return key;
}

/** What is wrong with the validators, or nothing: each a non-zero bytes32, and two different hotkeys. */
export function validatorProblems(v: V32Validators): string[] {
  const out: string[] = [];
  for (const [name, key] of [
    ["the primary", v.primary],
    ["the standby", v.standby],
  ] as const) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key) || /^0x0{64}$/.test(key)) out.push(`${name} hotkey "${key}" is not a non-zero bytes32`);
  }
  if (v.primary.toLowerCase() === v.standby.toLowerCase()) out.push(`the primary and the standby are the same hotkey (${v.primary}): the standby must be another validator`);
  return out;
}

/** The validators from OPS_V32_PRIMARY_HOTKEY and OPS_V32_STANDBY_HOTKEY (SS58 or hex); nothing defaults. Throws
 * naming every problem. */
export function validatorsFromEnv(env: Env): V32Validators {
  const problems: string[] = [];
  const get = (name: string): Hex => {
    try {
      return parseHotkey(name, env[name]);
    } catch (e) {
      problems.push((e as Error).message);
      return `0x${"00".repeat(32)}`;
    }
  };
  const v = { primary: get(V32_ENV.primaryHotkey), standby: get(V32_ENV.standbyHotkey) };
  if (!problems.length) problems.push(...validatorProblems(v));
  if (problems.length) throw new Error(`the v3.2 validators are not ready:\n  ${problems.join("\n  ")}\nnothing read or sent`);
  return v;
}

// ---- the roles ----

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What is wrong with a set of roles, or nothing: each a non-zero address; the guardian never the owner (v3.2's
 * constructors refuse it); the keeper never the owner, the guardian or the treasury (a keeper-only key); no role
 * the test wallet; the treasury Appendix B's. */
export function roleProblemsV32(r: V32Roles): string[] {
  const out: string[] = [];
  const names = ["owner", "guardian", "keeper", "treasury"] as const;
  for (const n of names) {
    const a = r[n];
    if (typeof a !== "string" || !isAddress(a, { strict: false })) out.push(`the ${n} "${String(a)}" is not an address`);
    else if (sameAddress(a, zeroAddress)) out.push(`the ${n} is the zero address`);
    else if (sameAddress(a, WALLET)) out.push(`the ${n} is the test wallet ${WALLET}: v3.2 names no role after it`);
  }
  if (out.length) return out;
  if (sameAddress(r.guardian, r.owner)) out.push(`the guardian (${r.guardian}) is also the owner: v3.2's constructors refuse that`);
  if (sameAddress(r.keeper, r.owner)) out.push(`the keeper (${r.keeper}) is also the owner`);
  if (sameAddress(r.keeper, r.guardian)) out.push(`the keeper (${r.keeper}) is also the guardian`);
  if (sameAddress(r.keeper, r.treasury)) out.push(`the keeper (${r.keeper}) is also the treasury: the keeper holds no other role`);
  if (sameAddress(r.keeper, V3_LAUNCH_KEEPER)) out.push(`the keeper (${r.keeper}) is v3-launch's live keeper: v3.2's keeper is a fresh key of its own`);
  if (!sameAddress(r.treasury, SETTINGS_V32_LAUNCH.treasury)) out.push(`the treasury (${r.treasury}) is not Appendix B's ${SETTINGS_V32_LAUNCH.treasury}`);
  return out;
}

/** The v3.2 keeper's address from OPS_V32_KEEPER_ADDRESS (checksummed, or all lower case): a fresh key, so never
 * v3-launch's live keeper, the owner, the guardian, the treasury or the test wallet (roleProblemsV32). There is no
 * default. Throws naming every problem. */
export function keeperFromEnv(env: Env, fixed: Omit<V32Roles, "keeper"> = ROLES_V32_LAUNCH): Address {
  const name = V32_ENV.keeper;
  const v = env[name]?.trim() ?? "";
  const problems: string[] = [];
  let keeper: Address = zeroAddress;
  if (!v) problems.push(`${name} is not set: the v3.2 keeper is a fresh key, and there is no default`);
  else if (!isAddress(v, { strict: true })) problems.push(`${name} "${v}" is not an address (or its checksum is wrong)`);
  else {
    keeper = getAddress(v);
    problems.push(...roleProblemsV32({ ...fixed, keeper }));
  }
  if (problems.length) throw new Error(`the v3.2 keeper is not ready:\n  ${problems.join("\n  ")}\nnothing read or sent`);
  return keeper;
}

/** The launch's roles: the founder's fixed ones and the keeper from the plan's inputs (keeperFromEnv). */
export const rolesV32FromEnv = (env: Env): V32Roles => ({ ...ROLES_V32_LAUNCH, keeper: keeperFromEnv(env) });

/** What is wrong with the deployers, or nothing: each a non-zero address, one per chain (two different keys), and
 * a fresh single-use key, so never the test wallet and never a role's account. */
export function deployerProblems(d: Record<ChainName, Address>, r: V32Roles): string[] {
  const out: string[] = [];
  for (const chain of ["base", "bittensor"] as const) {
    const a = d[chain];
    const label = chain === "base" ? "Base" : "Bittensor";
    if (typeof a !== "string" || !isAddress(a, { strict: false }) || sameAddress(a, zeroAddress)) {
      out.push(`the ${label} deployer "${String(a)}" is not a non-zero address`);
      continue;
    }
    if (sameAddress(a, WALLET)) out.push(`the ${label} deployer is the test wallet ${WALLET}: use a fresh key`);
    for (const n of ["owner", "guardian", "keeper", "treasury"] as const) {
      if (typeof r[n] === "string" && sameAddress(a, r[n])) out.push(`the ${label} deployer is also the ${n}: use a fresh key`);
    }
  }
  if (!out.length && sameAddress(d.base, d.bittensor)) out.push(`both chains' deployer is ${getAddress(d.base)}: each chain needs its own fresh key`);
  return out;
}

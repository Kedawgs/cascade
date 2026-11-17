import { type Address, formatUnits, type Hex, type Log, parseEventLogs } from "viem";
import { BASE_CHAIN, DIRECT_ORIGIN, VAULT_LENS, VAULT_V32 } from "./abi";
import type { Clients } from "./chain";
import { type Deployment, isV32, RPC } from "./config";
import { type FlowCall, isRevert, noGas, redeemDirectCall, rejected, revertReason, setBaseOriginCall, setDirectOriginCall, type Simulation } from "./flows";
import { STAKE_MISSING } from "./trail";
import { floorRao, toDisplay } from "./units";
import { formatTao } from "../format";
import { contractWalletNote } from "../stake-form";

// ---- "Withdraw on Bittensor": v3.2's emergency way out (Task 59b; the founder's question, 2026-11-05) ----
//
// If unstaking through Base ever stops (ForeverMoney's TAO fails, the bridge or the front door is off), a holder can
// still leave from Bittensor: the vault's own redeemDirect, sent from the holder's wallet on Bittensor EVM, pays the
// shares' value in native TAO to the same address there (spec §3.3, §6; contracts/README.md "Direct access"). This page
// reads and sends to the vault and its lens on Bittensor only: never ForeverMoney, the bridge or the front door.
//
// What it sends is the user's shares, all of them as read at the click, with acceptMissing false (flows.ts,
// redeemDirectCall): while stake is missing the vault refuses it, and the page says why and waits. The vault's opt-in
// to be paid at the floor price is not offered: the web never passes true (spec §3.1 and §7, contracts/README.md).

/** Bittensor EVM's chain id. */
export const BITTENSOR_CHAIN_ID = 964;

/** Chain 964 as the wallet is asked to add it (EIP-3085, wallet_addEthereumChain): the site's own Bittensor RPC and its
 * explorer (config.ts RPC.bittensor, explorer.bittensorTx), so no new host is named. */
export const BITTENSOR_WALLET_CHAIN = {
  chainId: "0x3c4",
  chainName: "Bittensor EVM",
  nativeCurrency: { name: "TAO", symbol: "TAO", decimals: 18 },
  rpcUrls: [RPC.bittensor],
  blockExplorerUrls: ["https://evm.taostats.io"],
};

// ---- the words (Task 59b; each new sentence is in the report) ----

export const DIRECT_EXIT_TITLE = "Withdraw on Bittensor";
export const DIRECT_EXIT_SUB = "An emergency way out: your stake as TAO, straight from the vault to this address on Bittensor.";
/** Unstake's other ways out: after the page's link, "Withdraw on Bittensor". */
export const OTHER_WAYS_OUT = "for emergencies, your stake as TAO straight from the vault, without Base.";
/** The order of magnitude of the withdrawal's least gas limit at today's price (exitGasFloor: about 0.015 TAO with the
 * launch's two hotkeys at 6 gwei, about 0.02 with four); the page's hold gives the exact figure (review of d33c4b5, M3). */
export const GAS_NOTE = "Network fees on Bittensor are paid in TAO, so this address needs about 0.02 TAO there, most of it not spent.";
export const NETWORK_NOTE = "Your wallet switches to Bittensor EVM (chain 964), and adds it first if it needs to.";
export const NO_GAS = "This address has no TAO on Bittensor for the network fee. Send it a little, then come back.";
export const CONTRACT_WALLET_REFUSAL =
  "This wallet is a contract account, so it can't withdraw on Bittensor: its address there may belong to someone else. Unstake from Base instead.";
export const NOTHING_STAKED = "This address has nothing staked in Cascade.";
export const ORIGIN_STEP_LABEL = "Withdraw here, not from Base";
export const ORIGIN_STEP_NOTE = "This address then withdraws on Bittensor, not from Base, until it is switched back.";
/** Why someone might take the origin step, which the withdrawal doesn't need (the controller's follow-up ruling). */
export const ORIGIN_STEP_WHY = "Optional: this stops Base from withdrawing these shares while you leave here.";
/** The switch back (Task 59b follow-up): setRedeemOrigin(8453). It withdraws nothing itself (Task 59b review, M5). */
export const SWITCH_BACK_LABEL = "Use Base for withdrawals again";
/** The switch back's note for an address home on Bittensor (DIRECT_ORIGIN), for which Base worked before. */
export const SWITCH_BACK_NOTE = "Unstaking from Base then works again for this address; withdrawing here still works.";
/** The switch back's note, exact for the address's origin (Task 59b review, M5): "again" only where Base worked before
 * (DIRECT_ORIGIN, set from Base); origin 0 (shares only from the reward cut) never unstaked from Base; another chain's
 * front door stops unstaking the address once Base is named (CascadeBatchLib: only the origin's doors burn for it). */
export function switchBackNote(origin: bigint): string {
  if (origin === DIRECT_ORIGIN) return SWITCH_BACK_NOTE;
  if (origin === 0n) return "Unstaking from Base then works for this address; withdrawing here still works.";
  return "Unstaking from Base then works for this address, and no longer from the other chain it uses now; withdrawing here still works.";
}
/** The origin step and the switch back, once the vault's RedeemOriginSet (or a read of the origin) shows it (M3). */
export const ORIGIN_DONE = "Done: this address now withdraws here, not from Base.";
export const BASE_DONE = "Done: this address now uses Base for withdrawals.";
export const VAULT_PAUSED = "Cascade's vault is paused, so withdrawals here wait until it reopens.";
export const ZERO_VALUE = "This stake is too small to pay anything after its own cost.";
export const STAKE_CHANGED = "Your stake changed since you looked, so nothing was sent. Check it and try again.";
export const UNSTAKE_SHORT = "The vault can't unstake this much right now, so nothing was sent. Try again later.";
export const WOULD_FAIL = "This wouldn't go through on Bittensor right now, so nothing was sent. Try again in a moment.";
export const UNREACHABLE = "We couldn't reach Bittensor just now. Nothing was sent. Try again.";
export const SWITCH_DECLINED = "Switch your wallet to Bittensor EVM to continue.";
/** Chain 964 as a user adds it by hand, from what the wallet is asked to add (BITTENSOR_WALLET_CHAIN; M6). */
export const BITTENSOR_BY_HAND = `network ${BITTENSOR_WALLET_CHAIN.chainName}, RPC ${BITTENSOR_WALLET_CHAIN.rpcUrls[0]}, chain ID ${BITTENSOR_CHAIN_ID}, symbol ${BITTENSOR_WALLET_CHAIN.nativeCurrency.symbol}`;
export const CANT_SWITCH = `Your wallet couldn't switch to Bittensor EVM. Add it by hand: ${BITTENSOR_BY_HAND}. Then try again.`;
export const DECLINED = "You declined in your wallet. Nothing was sent.";
export const NO_TAO_GAS = "Network fees on Bittensor are paid in TAO, and this address doesn't have enough. Send it a little TAO there and try again.";
export const SEND_FAILED = "Your wallet couldn't send this. Try again.";
/** The vault's gas guard refused it (InsufficientGas, Revision 28): the walk's read of the chain's minimum stake must start
 * with its whole 100,000 gas, so a gas limit set by hand too low is refused rather than read short. The page names the
 * withdrawal's gas limit (review M-6), so the words say to keep it. */
export const LOW_GAS = "This was sent with too little gas, so it didn't go through. Try again, and keep the gas this page sets.";
export const NO_WALLET = "Connect your wallet first.";
export const REVERTED = "This failed on Bittensor. Only the network fee was spent.";
export const LOST = "We couldn't confirm it yet. Check it on Bittensor in a few minutes.";
/** A second withdrawal clicked while the first one LOST named isn't mined yet and the shares haven't moved (M7). */
export const STILL_CONFIRMING = "Your last withdrawal isn't confirmed yet, so nothing more was sent. Check it on Bittensor in a few minutes.";
/** Beside the withdraw button while that hold lasts: a withdrawal dropped and never mined holds it until the page is
 * reloaded, which forgets it (Task 60 review, Minor 7). */
export const HELD_NOTE = "If your last withdrawal never shows on Bittensor, reload this page to try again.";
const PAID_UNREAD = "Withdrawn to this address on Bittensor. The receipt can't be read right now, so the amount isn't shown.";

/** What the page shows as what the user will receive: an estimate, the value less the exit's own cost, which the
 * leaver pays (spec §3.3; design-leaver-pays.md's words, as the unstake quote has them). */
export const estimateText = (valueWei: bigint): string => `About ${formatTao(toDisplay(valueWei, 18), 4)} TAO, less any unstake fee the chain charges (none today).`;
export const withdrawLabel = (valueWei: bigint): string => `Withdraw ${formatTao(toDisplay(valueWei, 18), 4)} TAO`;

// ---- the reads ----

/** What the page reads: the account's shares and the vault's price inputs, its pause and the missing stake, the
 * account's redeem origin and TAO for gas, all on Bittensor at one block; and the account's code on both chains (a
 * contract wallet is refused). */
export interface DirectExitReads {
  shares: bigint;
  supply: bigint;
  totalAssets: bigint;
  /** The account's redeem origin: 0 (none yet), a chain id (8453 for Base), or DIRECT_ORIGIN (Bittensor itself). */
  origin: bigint;
  stakeMissing: boolean;
  paused: boolean;
  /** The account's own TAO on Bittensor: what pays the network fee there. */
  gasWei: bigint;
  /** The account's code on Base and on Bittensor ("0x" for none). */
  codeBase: Hex;
  codeBittensor: Hex;
  /** The active front doors on Base (the lens's activeDoors(8453)): only with one can Base be named the origin again. */
  baseDoors: bigint;
  /** The caller's gas rule's inputs (contracts/README.md, operator note 13; review M-6), from the lens: the listed
   * hotkeys (the most positions the unstake walk tries), the least gas each removal gets, and what the walk leaves for
   * the exit's work after it. */
  hotkeyCount: bigint;
  unstakeGas: bigint;
  exitGasReserve: bigint;
  /** Bittensor's gas price now, as the site's other balance checks read one (viem's maxFeePerGas: the base fee with
   * its headroom, and the tip), and that tip (maxPriorityFeePerGas): the withdrawal is signed at both, so the price the
   * balance is checked at is the one the wallet signs (review of d33c4b5, M2). */
  gasPriceWei: bigint;
  priorityFeeWei: bigint;
}

/** v3.2 only: the vault (the share token, its pause) and its lens (the price, the origin, the missing stake, the caller's
 * gas rule's inputs), on Bittensor at one block, and the lens checked to read that vault (a lens of another vault would
 * show someone else's figures); the account's TAO there and the gas price now; its code on both chains. */
export async function readDirectExit(c: Pick<Clients, "base" | "bittensor">, d: Deployment, account: Address): Promise<DirectExitReads> {
  if (!isV32(d) || !d.vaultLens) throw new Error("Only a v3.2 deployment has this page's way out (its vault lens and direct exit)");
  const vault = { address: d.vault, abi: VAULT_V32 } as const;
  const lens = { address: d.vaultLens, abi: VAULT_LENS } as const;
  const blockNumber = await c.bittensor.getBlockNumber();
  const [shares, supply, paused, totalAssets, origin, stakeMissing, target, baseDoors, hotkeyCount, unstakeGas, exitGasReserve] = await c.bittensor.multicall({
    blockNumber,
    allowFailure: false,
    contracts: [
      { ...vault, functionName: "balanceOf", args: [account] },
      { ...vault, functionName: "totalSupply" },
      { ...vault, functionName: "paused" },
      { ...lens, functionName: "totalAssets" },
      { ...lens, functionName: "redeemOrigin", args: [account] },
      { ...lens, functionName: "stakeMissing" },
      { ...lens, functionName: "target" },
      { ...lens, functionName: "activeDoors", args: [BASE_CHAIN] },
      { ...lens, functionName: "hotkeyCount" },
      { ...lens, functionName: "unstakeGas" },
      { ...lens, functionName: "EXIT_GAS_RESERVE" },
    ],
  });
  if (target.toLowerCase() !== d.vault.toLowerCase()) throw new Error("The vault lens reads another vault");
  const gasWei = await c.bittensor.getBalance({ address: account, blockNumber });
  const fees = await c.bittensor.estimateFeesPerGas();
  const codeBittensor = (await c.bittensor.getCode({ address: account })) ?? "0x";
  const codeBase = (await c.base.getCode({ address: account })) ?? "0x";
  return {
    shares,
    supply,
    paused,
    totalAssets,
    origin,
    stakeMissing,
    gasWei,
    codeBase,
    codeBittensor,
    baseDoors,
    hotkeyCount,
    unstakeGas,
    exitGasReserve,
    gasPriceWei: fees.maxFeePerGas,
    priorityFeeWei: fees.maxPriorityFeePerGas,
  };
}

// ---- the withdrawal's gas (review M-6) ----

/** The exit's own work beside what the caller's gas rule names (contracts/README.md, operator note 13: EXIT_GAS_RESERVE
 * + listed positions × unstakeGas + "the exit's own work"): the transaction's intrinsic gas, redeemDirect's reads and
 * burn, the walk's reads of each position and the gas guard's capped read of the chain's minimum stake (100,000), and
 * the walk's own steps around each removal. In the mock an exit whose every removal is refused costs about 65,000 in
 * all (README, the walk's gas); this errs high, as the founder rules for gas constants. */
export const EXIT_WORK_GAS = 500_000n;

/** The least gas a withdrawal is sent with (review M-6): the caller's gas rule, from the lens's figures. While each
 * removal's share of the gas above the reserve is at least unstakeGas, the walk keeps EXIT_GAS_RESERVE for the exit's
 * payment; below it, removals that burn their gas can eat the reserve and the exit runs out of gas, reverting whole
 * (its fee lost). The walk tries at most the listed hotkeys (the stake hotkey is always one of them). It runs in a
 * library the vault calls by delegatecall, which forwards at most 63/64 of the gas left (EIP-150), so the walk's gas,
 * EXIT_GAS_RESERVE + hotkeys × unstakeGas, needs ceil(that / 63) more before the call (review of d33c4b5, M1). */
export const exitGasFloor = (r: Pick<DirectExitReads, "exitGasReserve" | "hotkeyCount" | "unstakeGas">): bigint => {
  const walk = r.exitGasReserve + r.hotkeyCount * r.unstakeGas;
  return walk + (walk + 62n) / 63n + EXIT_WORK_GAS;
};

/** The gas limit a withdrawal is sent with: the estimate from the account plus a quarter (rounded up), or the floor
 * when that is more. A wallet's own estimate can sit right at what one run needed, below the rule. */
export const exitGasLimit = (estimate: bigint, floor: bigint): bigint => {
  const padded = (estimate * 5n + 3n) / 4n;
  return padded > floor ? padded : floor;
};

/** 0.0001 TAO: what the need and the balance are shown to. */
const TAO_STEP = 10n ** 14n;
/** The words for an address whose TAO can't cover a withdrawal's gas limit at today's price: what it needs (rounded up)
 * and what it has (rounded down), so neither looks better than it is. Most of it stays: the chain charges the gas
 * used, the limit is what the wallet must be able to pay. */
export const needTaoText = (needWei: bigint, haveWei: bigint): string =>
  `This address needs about ${formatTao(toDisplay(((needWei + TAO_STEP - 1n) / TAO_STEP) * TAO_STEP, 18), 4)} TAO on Bittensor to cover the network fee (most of it isn't spent), and has ${formatTao(toDisplay((haveWei / TAO_STEP) * TAO_STEP, 18), 4)}. Send it a little more, then come back.`;

/** What `shares` are worth to redeemDirect before the exit's own cost: the vault's assetsForRedeem (CascadeMath: 1e6
 * virtual shares and 1 wei of virtual assets, rounded down) at the lens's totalAssets, which prices the stake at
 * min(visible, booked), floored to rao as redeemDirect floors it. */
export function directExitValue(shares: bigint, totalAssets: bigint, supply: bigint): bigint {
  return floorRao((shares * (totalAssets + 1n)) / (supply + 10n ** 6n));
}

/** EIP-7702's delegation designator: a key account that runs a delegate's code. Its key still signs on Bittensor. */
const DELEGATION = /^0xef0100[0-9a-f]{40}$/i;
const hasContractCode = (code: Hex) => code !== "0x" && !DELEGATION.test(code);

/** What the page knows of the connected wallet besides its code: its wagmi connector, and whether it runs a batch
 * atomically on Base (stake-form.ts atomicOf, from its EIP-5792 capabilities). */
export interface WalletInfo {
  connectorId?: string;
  atomic?: string;
}

/** A contract account can't withdraw on Bittensor: redeemDirect pays whoever controls the address on chain 964, and
 * for a contract wallet that may be someone else (contracts/README.md, "Who can use direct access"). Refused by the
 * stake form's own rule (stake-form.ts contractWalletNote: code on Base other than an EIP-7702 delegation, Base
 * Account, or no code but atomic batches, a smart account not yet deployed), and for any code on Bittensor but a
 * delegation. A key account, an EIP-7702 one included, is not refused: its key signs on Bittensor too. */
export function isContractWallet(r: Pick<DirectExitReads, "codeBase" | "codeBittensor">, w: WalletInfo = {}): boolean {
  return contractWalletNote({ code: r.codeBase, ...w }) !== null || hasContractCode(r.codeBittensor);
}

export interface DirectExitView {
  /** Why nothing here can be sent from this wallet (a contract account, nothing staked), or null. */
  refusal: string | null;
  /** The shares' value (the estimate's figure). */
  valueWei: bigint;
  estimate: string;
  /** The origin step: shown for an address with shares whose redeem origin isn't Bittensor itself. */
  originStep: boolean;
  canSetOrigin: boolean;
  /** The switch back: shown for an address with shares whose redeem origin isn't Base, while Base has an active door. */
  switchBack: boolean;
  canSwitchBack: boolean;
  /** Why the withdrawal waits (no TAO for gas, or too little for its least gas limit at today's price; the vault paused,
   * stake missing, a stake worth nothing), or null. */
  hold: string | null;
  canWithdraw: boolean;
}

/** What the page shows for reads `r`. The origin step doesn't hold the withdrawal: redeemDirect reads no origin. It is
 * offered first, and still while the withdrawal waits (setRedeemOrigin works paused and while stake is missing), so a
 * holder can stop Base from unstaking the address meanwhile. The switch back (setRedeemOrigin(8453)) is offered while the
 * origin isn't Base and Base has an active door (the vault refuses a chain without one, UnknownOrigin). */
export function directExitView(r: DirectExitReads, w: WalletInfo = {}): DirectExitView {
  const valueWei = directExitValue(r.shares, r.totalAssets, r.supply);
  const base = { valueWei, estimate: estimateText(valueWei) };
  const refusal = isContractWallet(r, w) ? CONTRACT_WALLET_REFUSAL : r.shares === 0n ? NOTHING_STAKED : null;
  if (refusal) return { ...base, refusal, originStep: false, canSetOrigin: false, switchBack: false, canSwitchBack: false, hold: null, canWithdraw: false };
  const originStep = r.origin !== DIRECT_ORIGIN;
  const switchBack = r.origin !== BASE_CHAIN && r.baseDoors > 0n;
  // the least the withdrawal's gas limit can be, at today's price (review M-6), said with how much it needs, none at all
  // included (review of d33c4b5, M3); the click checks its own limit again
  const floorWei = exitGasFloor(r) * r.gasPriceWei;
  const gasHold = r.gasWei < floorWei ? needTaoText(floorWei, r.gasWei) : null;
  const hold = gasHold ?? (r.paused ? VAULT_PAUSED : r.stakeMissing ? STAKE_MISSING : valueWei === 0n ? ZERO_VALUE : null);
  return {
    ...base,
    refusal: null,
    originStep,
    canSetOrigin: originStep && r.gasWei > 0n,
    switchBack,
    canSwitchBack: switchBack && r.gasWei > 0n,
    hold,
    canWithdraw: hold === null,
  };
}

// ---- sending ----

/** A stop of the page's own, in its words; `hash` when a transaction was sent (to look it up). */
export class DirectExitStop extends Error {
  readonly hash?: Hex;

  constructor(message: string, hash?: Hex) {
    super(message);
    this.name = "DirectExitStop";
    if (hash) this.hash = hash;
  }
}

/** The wallet on Bittensor EVM (its EIP-1193 provider in the app, use-direct-exit.ts; fakes in tests). */
export interface BittensorWallet {
  chainId(): Promise<number>;
  /** wallet_switchEthereumChain to 964. */
  switchChain(): Promise<void>;
  /** wallet_addEthereumChain with BITTENSOR_WALLET_CHAIN. */
  addChain(): Promise<void>;
  /** Sends `call` from the account on Bittensor (the wallet's chain checked to be 964 first), with `tx`'s gas limit and
   * fees when given (else the wallet's own): its hash. */
  send(call: FlowCall, tx?: WithdrawalTx): Promise<Hex>;
}

/** What a withdrawal is signed with (review M-6; the review of d33c4b5, M2): its gas limit (exitGasLimit) and the fees
 * its balance was checked at, so the wallet can't price it above what the page said the address can cover. */
export interface WithdrawalTx {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Bittensor as the site reads it (its public archive node): the page's reads, a simulation from the account, its gas
 * estimate from the account (throws as viem does: a revert, or Bittensor not answering), a receipt waited for, and an
 * earlier transaction's receipt looked up without waiting (null while it isn't mined). */
export interface BittensorChain {
  read(): Promise<DirectExitReads>;
  simulate(call: FlowCall): Promise<Simulation>;
  estimate(call: FlowCall): Promise<bigint>;
  wait(hash: Hex): Promise<{ status: "success" | "reverted"; logs: readonly Log[] }>;
  mined(hash: Hex): Promise<"success" | "reverted" | null>;
}

/** A withdrawal sent whose receipt LOST couldn't wait for: its transaction, and the shares it was sent for (M7). */
export interface Unconfirmed {
  hash: Hex;
  shares: bigint;
}

/** Whether a withdrawal not yet confirmed (`u`) still holds a second one: while its receipt hasn't shown (`mined`) and
 * the shares read now are still those it was sent for. Once it is mined, or the shares moved, the page's usual checks
 * decide (Task 59b review, M7). */
export const unconfirmedHolds = (u: Unconfirmed | null, shares: bigint, mined: boolean): boolean => u !== null && !mined && shares === u.shares;

const codeOf = (e: unknown): number | undefined => {
  const err = e as { code?: number; data?: { originalError?: { code?: number } }; cause?: unknown } | undefined;
  return err?.code === 4902 || err?.data?.originalError?.code === 4902 ? 4902 : err?.cause !== undefined && err.cause !== e ? codeOf(err.cause) : err?.code;
};
/** The wallet doesn't know chain 964 yet (EIP-3326's 4902; MetaMask Mobile wraps it in originalError). */
const unknownChain = (e: unknown): boolean => codeOf(e) === 4902;

/** Puts the wallet on Bittensor EVM, adding chain 964 first when the wallet doesn't know it. */
export async function ensureBittensor(w: BittensorWallet): Promise<void> {
  if ((await w.chainId()) === BITTENSOR_CHAIN_ID) return;
  try {
    await w.switchChain();
  } catch (e) {
    if (rejected(e)) throw new DirectExitStop(SWITCH_DECLINED);
    if (!unknownChain(e)) throw new DirectExitStop(CANT_SWITCH);
    try {
      await w.addChain();
      // most wallets switch as they add; one that only adds is asked again
      if ((await w.chainId()) !== BITTENSOR_CHAIN_ID) await w.switchChain();
    } catch (e2) {
      throw new DirectExitStop(rejected(e2) ? SWITCH_DECLINED : CANT_SWITCH);
    }
  }
  if ((await w.chainId()) !== BITTENSOR_CHAIN_ID) throw new DirectExitStop(CANT_SWITCH);
}

export type DirectStep = "origin" | "withdraw" | "base";
/** What a step came to: its transaction (none when there was nothing to send); for the origin step and the switch back,
 * whether the chain shows the new origin (`confirmed`, M3); for a withdrawal, what the vault's events say it paid (none
 * when the receipt doesn't show it). */
export type DirectOutcome =
  | { step: "origin" | "base"; hash?: Hex; confirmed?: boolean }
  | { step: "withdraw"; hash: Hex; paid?: { paidWei: bigint; costWei: bigint } };

/** Whether a receipt's logs hold the vault's own RedeemOriginSet for `account`, naming `origin`. */
export function originSetIn(logs: readonly Log[], d: Deployment, account: Address, origin: bigint): boolean {
  const own = logs.filter((l) => l.address.toLowerCase() === d.vault.toLowerCase());
  return parseEventLogs({ abi: VAULT_V32, logs: own as Log[], eventName: "RedeemOriginSet" }).some(
    (e) => e.args.user.toLowerCase() === account.toLowerCase() && e.args.chain === origin,
  );
}

/** Why the vault would refuse, from a simulation's revert. */
function simulationRefusal(revert: string | undefined): string {
  if (revert === "StakeMissing") return STAKE_MISSING;
  if (revert === "EnforcedPause") return VAULT_PAUSED;
  if (revert === "ZeroAmount") return ZERO_VALUE;
  if (revert === "UnstakeShort") return UNSTAKE_SHORT;
  if (revert === "InsufficientGas") return LOW_GAS;
  if (revert === "ERC20InsufficientBalance") return STAKE_CHANGED;
  return WOULD_FAIL;
}

/** One of the page's three steps, from the click: the reads again (what is sent is what they show, and only if it is
 * what the user saw), the page's refusals, the wallet on Bittensor EVM, a simulation from the account, the transaction,
 * its receipt. The origin step sends `setRedeemOrigin(DIRECT_ORIGIN)`; the switch back `setRedeemOrigin(8453)`, only
 * while Base has an active door; the withdrawal `redeemDirect(shares, false)` of the user's shares, all of them, with
 * its gas limit set (exitGasLimit: the estimate plus a quarter, never below the caller's gas rule) and its fees the price
 * read, refused unsent when the account's TAO can't cover that limit at that price (review M-6). Nothing
 * else, and nothing to any other contract. A withdrawal LOST couldn't confirm (`unconfirmed`) holds a second one while its
 * receipt doesn't show and the shares are still those it was sent for (M7). The origin step and the switch back are
 * confirmed from the vault's RedeemOriginSet in the receipt, else a read of the origin, never assumed (M3). Throws
 * DirectExitStop with the words. */
export async function runDirectStep(
  step: DirectStep,
  o: { wallet: BittensorWallet; chain: BittensorChain; d: Deployment; account: Address; shownShares: bigint; kind: WalletInfo; unconfirmed?: Unconfirmed | null },
): Promise<DirectOutcome> {
  let r: DirectExitReads;
  try {
    r = await o.chain.read();
  } catch {
    throw new DirectExitStop(UNREACHABLE);
  }
  const view = directExitView(r, o.kind);
  if (view.refusal) throw new DirectExitStop(view.refusal);
  let call: FlowCall;
  if (step === "origin") {
    if (!view.originStep) return { step: "origin" };
    if (r.gasWei === 0n) throw new DirectExitStop(NO_GAS);
    call = setDirectOriginCall(o.d);
  } else if (step === "base") {
    // already home on Base: nothing to send; no active door there: the vault would refuse it (UnknownOrigin)
    if (r.origin === BASE_CHAIN) return { step: "base" };
    if (r.baseDoors === 0n) throw new DirectExitStop(WOULD_FAIL);
    if (r.gasWei === 0n) throw new DirectExitStop(NO_GAS);
    call = setBaseOriginCall(o.d);
  } else {
    if (r.shares !== o.shownShares) throw new DirectExitStop(STAKE_CHANGED);
    if (view.hold) throw new DirectExitStop(view.hold);
    // the last withdrawal isn't confirmed and the shares haven't moved: never a second one on a guess (a receipt that
    // can't be read holds too)
    const u = o.unconfirmed ?? null;
    if (u && r.shares === u.shares) {
      const mined = await o.chain.mined(u.hash).catch(() => null);
      if (unconfirmedHolds(u, r.shares, mined !== null)) throw new DirectExitStop(STILL_CONFIRMING, u.hash);
    }
    call = redeemDirectCall(r.shares, o.d);
  }

  await ensureBittensor(o.wallet);
  let sim: Simulation;
  try {
    sim = await o.chain.simulate(call);
  } catch {
    throw new DirectExitStop(UNREACHABLE);
  }
  if (!sim.ok) throw new DirectExitStop(simulationRefusal(sim.revert));

  // the withdrawal's gas (review M-6): never below the caller's gas rule, the TAO checked to cover it at today's price,
  // and signed at that price (the review of d33c4b5, M2); the origin step and the switch back are small calls the wallet
  // prices itself
  let tx: WithdrawalTx | undefined;
  if (step === "withdraw") {
    let estimate: bigint;
    try {
      estimate = await o.chain.estimate(call);
    } catch (e) {
      throw new DirectExitStop(isRevert(e) ? simulationRefusal(revertReason(e)) : UNREACHABLE);
    }
    tx = { gas: exitGasLimit(estimate, exitGasFloor(r)), maxFeePerGas: r.gasPriceWei, maxPriorityFeePerGas: r.priorityFeeWei };
    const need = tx.gas * tx.maxFeePerGas;
    if (r.gasWei < need) throw new DirectExitStop(needTaoText(need, r.gasWei));
  }

  let hash: Hex;
  try {
    hash = await o.wallet.send(call, tx);
  } catch (e) {
    throw new DirectExitStop(rejected(e) ? DECLINED : noGas(e) ? NO_TAO_GAS : revertReason(e) === "InsufficientGas" ? LOW_GAS : SEND_FAILED);
  }
  let receipt: { status: "success" | "reverted"; logs: readonly Log[] };
  try {
    receipt = await o.chain.wait(hash);
  } catch {
    throw new DirectExitStop(LOST, hash);
  }
  if (receipt.status !== "success") throw new DirectExitStop(REVERTED, hash);
  if (step !== "withdraw") {
    const want = step === "origin" ? DIRECT_ORIGIN : BASE_CHAIN;
    let confirmed = originSetIn(receipt.logs, o.d, o.account, want);
    if (!confirmed) confirmed = await o.chain.read().then((now) => now.origin === want, () => false);
    return { step, hash, confirmed };
  }
  const paid = directExitPaid(receipt.logs, o.d, o.account);
  return { step: "withdraw", hash, ...(paid ? { paid } : {}) };
}

/** What the vault's events in a withdrawal's receipt say: RedeemedDirect's `assets` for the account, the TAO paid, and
 * ShortfallAbsorbed's `amount`, the exit's own cost the leaver bore (what the walk left untaken and what the chain
 * kept), both from the vault itself. Null when the receipt shows no RedeemedDirect for the account. */
export function directExitPaid(logs: readonly Log[], d: Deployment, account: Address): { paidWei: bigint; costWei: bigint } | null {
  const own = logs.filter((l) => l.address.toLowerCase() === d.vault.toLowerCase());
  const events = parseEventLogs({ abi: VAULT_V32, logs: own as Log[] });
  const redeemed = events.find((e) => e.eventName === "RedeemedDirect" && e.args.user.toLowerCase() === account.toLowerCase());
  if (!redeemed || redeemed.eventName !== "RedeemedDirect") return null;
  const costWei = events.reduce((sum, e) => (e.eventName === "ShortfallAbsorbed" ? sum + e.args.amount : sum), 0n);
  return { paidWei: redeemed.args.assets, costWei };
}

/** A step's outcome in words. The origin step and the switch back: done once the chain shows it, else that it can't be
 * confirmed yet (M3); nothing when nothing was sent. A withdrawal: what was paid, exactly, and the exit's own cost when
 * there was one. */
export function outcomeLines(o: DirectOutcome): string[] {
  if (o.step !== "withdraw") {
    if (!o.hash) return [];
    if (!o.confirmed) return [LOST];
    return [o.step === "origin" ? ORIGIN_DONE : BASE_DONE];
  }
  if (!o.paid) return [PAID_UNREAD];
  const lines = [`You received ${formatUnits(o.paid.paidWei, 18)} TAO on Bittensor.`];
  if (o.paid.costWei > 0n) lines.push(`${formatUnits(o.paid.costWei, 18)} TAO of its value went to the cost of unstaking it.`);
  return lines;
}

/** Any error from a step in words: the page's own as written, never a raw RPC or library message. */
export const directExitMessage = (e: unknown): string => (e instanceof DirectExitStop ? e.message : e instanceof Error && e.name === "FlowBusyError" ? e.message : UNREACHABLE);

/** The account's gas estimate for `call` on Bittensor (viem's estimateContractGas): throws a revert as viem decodes it
 * from the call's ABI, or Bittensor's failure to answer. */
export const estimateOnBittensor = (c: Pick<Clients, "bittensor">, account: Address, call: FlowCall): Promise<bigint> =>
  c.bittensor.estimateContractGas({ account, address: call.to, abi: call.abi, functionName: call.functionName, args: call.args } as never);

/** The account's simulation of `call` on Bittensor: not ok if the vault would revert, with its reason. Throws when
 * Bittensor can't be asked. */
export async function simulateOnBittensor(c: Pick<Clients, "bittensor">, account: Address, call: FlowCall): Promise<Simulation> {
  try {
    await c.bittensor.simulateContract({ account, address: call.to, abi: call.abi, functionName: call.functionName, args: call.args } as never);
    return { ok: true };
  } catch (e) {
    if (!isRevert(e)) throw e;
    const revert = revertReason(e);
    return { ok: false, ...(revert !== undefined ? { revert } : {}) };
  }
}

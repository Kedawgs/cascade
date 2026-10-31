import { type Abi, type Address, type Hex, parseSignature, size } from "viem";
import { base } from "viem/chains";
import { ERC20, FRONT_DOOR, ROUTER, STAKER } from "./abi";
import { DESTINATION_BASE, type Deployment, PATH_TAO_TO_USDC, PRICE_CHECK_BPS, RESUME_WINDOW_MS, SLIPPAGE_BPS, TOKENS, UNISWAP, USDC_PERMIT } from "./config";
import type { ClaimOp, DepositOp, OpState } from "./oplog";
import type { FrontDoorState } from "./reads";
import { STAKE_LAPSED } from "./trail";
import type { Balances, DepositQuote, OpenBatch, WithdrawalQuote } from "./types";
import { floorRao, lessSlippage, toDisplay } from "./units";
import type { Wiring } from "./wiring";
import { formatTao, formatUsdShort } from "../format";
import { ethNeeded, needEthText, sendGate, sendNowValue } from "../send-now";

/** One contract call in a flow, named so a resumed flow knows what it already sent. */
export interface FlowCall {
  key: string;
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

const call = (key: string, to: Address, abi: Abi, functionName: string, args: readonly unknown[], value?: bigint): FlowCall => ({
  key,
  to,
  abi,
  functionName,
  args,
  ...(value !== undefined ? { value } : {}),
});

/** A stop of a flow's own, in the site's words, with the state it leaves the record in. */
export class FlowError extends Error {
  readonly state: OpState;

  constructor(message: string, state: OpState) {
    super(message);
    this.state = state;
  }
}

/** USDC → exactly `targetTao` TAO (unused USDC never leaves the wallet) → the front door. Every approval
 * is for exactly the most the call after it may spend: Uniswap's router the swap's most (`usdcIn`), the
 * front door the exact deposit. None is unlimited, but the router's may not be spent in full: the
 * exact-output swap pays only what the TAO costs, so up to the 0.5% slippage margin stays approved to
 * that fixed router until the next approval replaces it. */
export function stakeCalls(q: Pick<DepositQuote, "usdcIn" | "targetTao">, w: Balances, d: Deployment, account: Address): FlowCall[] {
  const out: FlowCall[] = [];
  if (w.usdcRouterAllowance < q.usdcIn) out.push(call("approveUsdc", TOKENS.usdc, ERC20, "approve", [UNISWAP.router, q.usdcIn]));
  out.push(
    call("swap", UNISWAP.router, ROUTER, "exactOutput", [
      { path: PATH_TAO_TO_USDC, recipient: account, amountOut: q.targetTao, amountInMaximum: q.usdcIn },
    ]),
  );
  out.push(...depositTaoCalls(q.targetTao, w, d));
  return out;
}

// ---- v3: one stake through CascadeStaker ----

/** CascadeStaker's route 0: the default Uniswap route. */
export const STAKE_ROUTE = 0;
/** How long a permit, and the stake it pays for, stay valid: 30 minutes. */
export const STAKE_WINDOW_S = 30 * 60;
export const stakeDeadline = (nowMs: number): bigint => BigInt(Math.floor(nowMs / 1000) + STAKE_WINDOW_S);

/** A USDC permit the user signed, split as `stakeWithPermit` takes it. */
export interface PermitSignature {
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

function stakerOf(d: Deployment): Address {
  if (!d.staker) throw new Error("This deployment has no staker (v2), so a v3 stake can't be built for it");
  return d.staker;
}

/** v3: USDC → TAO → the front door in one CascadeStaker transaction, always for the connected account.
 * With a permit, one `stakeWithPermit`; without, an approval of exactly `usdcIn` to the staker (left out
 * when its allowance already covers it), then `stake`. The staker is never allowed more than this stake. */
export function stakeV3Calls(
  q: Pick<DepositQuote, "usdcIn" | "minTaoOut">,
  w: Balances,
  d: Deployment,
  account: Address,
  permit?: PermitSignature,
  deadline: bigint = permit?.deadline ?? stakeDeadline(Date.now()),
): FlowCall[] {
  const staker = stakerOf(d);
  const terms = [account, q.usdcIn, q.minTaoOut, STAKE_ROUTE, deadline] as const;
  if (permit) return [call("stake", staker, STAKER, "stakeWithPermit", [...terms, permit.deadline, permit.v, permit.r, permit.s])];
  const out: FlowCall[] = [];
  if (w.usdcStakerAllowance < q.usdcIn) out.push(call("approveUsdc", TOKENS.usdc, ERC20, "approve", [staker, q.usdcIn]));
  out.push(call("stake", staker, STAKER, "stake", terms));
  return out;
}

const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** The EIP-2612 permit one stake signs: USDC's own domain on Base, exactly `value` for the staker. */
export function permitTypedData(owner: Address, d: Deployment, value: bigint, nonce: bigint, deadline: bigint) {
  return {
    domain: { name: USDC_PERMIT.name, version: USDC_PERMIT.version, chainId: base.id, verifyingContract: TOKENS.usdc },
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: { owner, spender: stakerOf(d), value, nonce, deadline },
  } as const;
}

export type PermitTypedData = ReturnType<typeof permitTypedData>;

/** A wallet's 65-byte signature as USDC's permit takes it (v is 27 or 28, however the wallet wrote it).
 * Anything else, like a smart wallet's wrapped signature, can't be a permit from this account. */
export function splitSignature(sig: Hex): { v: number; r: Hex; s: Hex } {
  if (size(sig) !== 65) throw new Error("not a 65-byte signature");
  const p = parseSignature(sig);
  return { v: p.v !== undefined ? Number(p.v) : 27 + (p.yParity ?? 0), r: p.r, s: p.s };
}

/** Base answered a call with a revert (rather than not answering at all). */
export function isRevert(e: unknown): boolean {
  const err = e as { name?: string; cause?: unknown } | undefined;
  return err?.name === "ContractFunctionRevertedError" || (err?.cause !== undefined && err.cause !== e && isRevert(err.cause));
}

const permitCall = (owner: Address, d: Deployment, value: bigint, p: PermitSignature): FlowCall =>
  call("permit", TOKENS.usdc, ERC20, "permit", [owner, stakerOf(d), value, p.deadline, p.v, p.r, p.s]);

/** The reason a call reverted, as Base answered it: a custom error's name (when the call's ABI lists it)
 * or a revert string, like Uniswap's "Too little received". Undefined when there is none to read. */
export function revertReason(e: unknown): string | undefined {
  const err = e as { name?: string; data?: { errorName?: string }; reason?: string; cause?: unknown } | undefined;
  if (err?.name === "ContractFunctionRevertedError") {
    const name = err.data?.errorName;
    return name && name !== "Error" ? name : err.reason;
  }
  return err?.cause !== undefined && err.cause !== e ? revertReason(err.cause) : undefined;
}

const DECLINED_SIGNATURE =
  "You declined the signature in your wallet, so nothing was sent. Continue when you're ready: your wallet will then ask you to approve the USDC and to stake.";
const WONT_GO_THROUGH =
  "This stake wouldn't go through on Base right now (usually because the price moved since your quote), so nothing was sent. Stake again at today's price.";
const UNREACHABLE = "We couldn't reach Base just now. Nothing was sent. Continue to try again.";

/** Reasons the staker or the front door gives, in plain words (contracts/src/CascadeStaker.sol and
 * CascadeFrontDoor.sol); anything else keeps the general wording. */
const BELOW_MIN = new Set(["BelowMinDeposit", "AmountTooSmall"]);
const PAUSED = new Set(["EnforcedPause", "RouteInactive"]);
/** The staker's floor check, or the router's own ("Too little received", which some nodes answer
 * with no data, only "execution reverted: Too little received"). */
const priceMoved = (reason: string) => reason === "InsufficientOutput" || /too little received/i.test(reason);

/** What the user reads when the pre-send check says a stake would revert. */
export function stakeRefusal(reason: string | undefined, minUsd?: number): string {
  if (reason === undefined) return WONT_GO_THROUGH;
  if (BELOW_MIN.has(reason)) {
    return `That's below the minimum stake${minUsd !== undefined ? ` of about ${formatUsdShort(minUsd)}` : ""}, so nothing was sent.`;
  }
  if (reason === "CapExceeded") return "Cascade is full for now, so nothing was sent. Try a smaller amount, or try again later.";
  // full by value: a smaller stake may still fit
  if (reason === "BatchValueFull") return "The current batch filled up, so nothing was sent. Try a smaller amount, or try again soon.";
  // its list of stakes (50) is full: no amount fits until the next batch
  if (reason === "BatchFull") return "The current batch has as many stakes as it can take, so nothing was sent. A new one opens once it leaves, so try again soon.";
  if (PAUSED.has(reason)) return "Staking is paused right now, so nothing was sent. Try again later.";
  if (priceMoved(reason)) return "The price moved since your quote, so this stake wouldn't go through and nothing was sent. Stake again at today's price.";
  return WONT_GO_THROUGH;
}

// ---- Before any stake: the quote it is priced from, against Cascade's oracle ----

/** What a stake's price check needs of its quote: the USDC in, the TAO the swap is expected to give for
 * it, and Cascade's fees, which come off the USDC before the swap (CascadeStaker). */
export type SpotQuote = Pick<DepositQuote, "usdcIn" | "expectedTao" | "depositFeeUsdc" | "swapFeeUsdc">;

/** The USDC units one TAO costs at the quote: what is swapped (the USDC after Cascade's fees) over the
 * TAO expected for it, so the pools' fees and this size's impact are in it. Zero for a quote of nothing. */
export function spotUsdcPerTao(q: SpotQuote): bigint {
  const swapped = q.usdcIn - q.depositFeeUsdc - q.swapFeeUsdc;
  return q.expectedTao > 0n && swapped > 0n ? (swapped * 10n ** 18n) / q.expectedTao : 0n;
}

/** Whether a spot price agrees with the oracle's: within `bps` of the oracle's, either way. A price of
 * nothing (a read that gave none) agrees with nothing. */
export function pricesAgree(spot: bigint, oracle: bigint, bps: bigint = PRICE_CHECK_BPS): boolean {
  if (spot <= 0n || oracle <= 0n) return false;
  const gap = spot > oracle ? spot - oracle : oracle - spot;
  return gap * 10_000n <= oracle * bps;
}

export const PRICE_UNCHECKED = "We couldn't double-check today's price just now, so nothing was sent. Try again in a moment.";
export const PRICE_DISAGREES = "The price we were quoted doesn't match Cascade's price oracle, so nothing was sent. Try again in a few minutes.";

/** Every stake's check before the wallet is asked anything: the quote's price (from one RPC, Uniswap's
 * quoter) against the oracle's 30-minute TWAP (`oracle`: reads.ts reads it on the other RPC). The quote
 * is what the stake's floor is cut from, so a lying RPC, or a pool pushed off its price, would otherwise
 * set a floor the market can run down to. Disagreement, or an oracle that can't be read, sends nothing. */
export async function assertPriceAgrees(q: SpotQuote, oracle: () => Promise<bigint>): Promise<void> {
  let o: bigint;
  try {
    o = await oracle();
  } catch {
    throw new FlowError(PRICE_UNCHECKED, "needs-you");
  }
  if (!pricesAgree(spotUsdcPerTao(q), o)) throw new FlowError(PRICE_DISAGREES, "needs-you");
}

export interface StakeV3Input {
  q: Pick<DepositQuote, "usdcIn" | "minTaoOut"> & SpotQuote;
  w: Balances;
  d: Deployment;
  account: Address;
  /** USDC's permit nonce for the account, read fresh just before signing. */
  nonce: () => Promise<bigint>;
  /** ms since the epoch */
  now: number;
  /** The oracle's price of one TAO in USDC units (reads.ts, readOraclePrice), for the price check. */
  oracle: () => Promise<bigint>;
  /** The smallest stake in dollars, as the form shows it; read only to explain a stake under it. */
  minUsd?: () => Promise<number>;
}

/** v3: how this stake is paid for, as the calls to send, once its quote checks out against the oracle
 * (assertPriceAgrees). A plain key account signs one USDC permit and sends one `stakeWithPermit`. An
 * account with code (an EIP-7702 smart account, whose permit USDC may refuse), a wallet that can't sign
 * a permit, or a permit USDC refuses in the pre-send check pays by an exact approval and `stake` instead
 * (one batch where the wallet can). An allowance that already covers the stake needs neither. A
 * declined signature stops here, "needs you", with nothing asked again until the user continues; a
 * stake that would revert for its own reasons stops before anything is sent. */
export async function planStakeV3(port: WalletPort, x: StakeV3Input): Promise<FlowCall[]> {
  await assertPriceAgrees(x.q, x.oracle);
  const deadline = stakeDeadline(x.now);
  const byApproval = () => stakeV3Calls(x.q, x.w, x.d, x.account, undefined, deadline);
  if (x.w.usdcStakerAllowance >= x.q.usdcIn || (await port.hasCode(x.account))) return byApproval();

  // wallets sign for Base's chain id only while they are on Base
  await toBase(port);
  const typed = permitTypedData(x.account, x.d, x.q.usdcIn, await x.nonce(), deadline);
  let permit: PermitSignature;
  try {
    const { v, r, s } = await port.signPermit(typed);
    permit = { deadline, v, r, s };
  } catch (e) {
    if (rejected(e)) throw new FlowError(DECLINED_SIGNATURE, "needs-you");
    return byApproval();
  }

  const calls = stakeV3Calls(x.q, x.w, x.d, x.account, permit);
  let stake: Simulation;
  let refused: boolean;
  try {
    stake = await port.simulate(calls[0]);
    if (stake.ok) return calls;
    // the stake would revert: because USDC refuses this permit, or because the stake itself can't go through
    refused = !(await port.simulate(permitCall(x.account, x.d, x.q.usdcIn, permit))).ok;
  } catch {
    throw new FlowError(UNREACHABLE, "needs-you");
  }
  if (refused) return byApproval();
  const minUsd = stake.revert !== undefined && BELOW_MIN.has(stake.revert) ? await x.minUsd?.().catch(() => undefined) : undefined;
  throw new FlowError(stakeRefusal(stake.revert, minUsd), "failed");
}

// ---- Carrying on a stake that stopped: at today's terms, never the recorded ones ----

/** Whether a quote has moved from the one the user saw: by more than the slippage margin they accepted
 * on it (0.5%), either way. Past that, the figures they agreed to no longer hold, and they are asked
 * again. A figure of nothing is always a move. */
export function quoteMoved(nowTao: bigint, wasTao: bigint, bps: bigint = SLIPPAGE_BPS): boolean {
  if (wasTao <= 0n) return true;
  const gap = nowTao > wasTao ? nowTao - wasTao : wasTao - nowTao;
  return gap * 10_000n > wasTao * bps;
}

/** Today's figure against the one the user last saw, for the words that ask them again. */
export interface QuoteMove {
  nowTao: bigint;
  wasTao: bigint;
  /** Today's price per TAO, in dollars. */
  priceUsd: number;
}

const taoText = (wei: bigint) => `${formatTao(toDisplay(wei, 18), 4)} TAO`;

export const quoteMovedText = (m: QuoteMove): string =>
  `The price moved since you started: you'd now get about ${taoText(m.nowTao)} (was ${taoText(m.wasTao)}). Continue at today's price if that's fine.`;

/** The quote moved materially since the user last saw a figure: nothing is sent until they say today's
 * is fine (useFlows.resumeStake with `accepted`, the figure shown). A "needs you" stop, like a declined
 * signature. */
export class QuoteMovedError extends FlowError {
  readonly move: QuoteMove;

  constructor(move: QuoteMove) {
    super(quoteMovedText(move), "needs-you");
    this.name = "QuoteMovedError";
    this.move = move;
  }
}

export const RESUME_UNQUOTED = "We couldn't get today's price just now, so nothing was sent. Try again in a moment.";

export interface FreshTermsInput {
  /** The stake as recorded: what it was for, the TAO the user saw, and when it started. */
  op: Pick<DepositOp, "usdcIn" | "targetTao" | "createdAt">;
  /** ms since the epoch */
  now: number;
  /** Today's quote for the same USDC, exactly as a fresh stake is quoted (CascadeData.quoteDeposit). */
  quote: () => Promise<DepositQuote>;
  /** The TAO figure the user agreed to after being told the price moved (the one they were shown), if any. */
  accepted?: bigint;
  /** A check of today's quote before it is taken (the oracle's, assertPriceAgrees); it throws to refuse. */
  check?: (q: DepositQuote) => Promise<void>;
  /** Writes today's terms to the record, so Activity shows what is being sent. */
  record: (patch: Pick<DepositOp, "targetTao" | "minTaoOut" | "priceUsd" | "feesUsd">) => void;
}

/** A stopped stake's terms, quoted again now. The floor a record keeps is the one it was quoted with
 * when it started, however long ago: carrying it on at that floor would send a stake the market can
 * fill far under today's price (or one that can't fill), so it is never sent. Instead: a stake stopped
 * a day or more ago isn't carried on at all (STAKE_LAPSED: start again); today's quote is read, exactly
 * as a fresh stake's; if its TAO moved from the figure the user last saw (`accepted`, else the
 * recorded one) by more than the 0.5% they accepted, they are asked again (QuoteMovedError) and nothing
 * is sent; else, once `check` passes, today's terms are recorded and returned, their floor the one to
 * send. A quote that can't be read, or isn't one for this stake, sends nothing. */
export async function freshStakeTerms(x: FreshTermsInput): Promise<DepositQuote> {
  if (x.now - x.op.createdAt >= RESUME_WINDOW_MS) throw new FlowError(STAKE_LAPSED, "failed");
  let q: DepositQuote;
  try {
    q = await x.quote();
  } catch {
    throw new FlowError(RESUME_UNQUOTED, "needs-you");
  }
  if (q.usdcIn !== x.op.usdcIn || q.targetTao <= 0n || q.minTaoOut <= 0n) throw new FlowError(RESUME_UNQUOTED, "needs-you");
  const was = x.accepted ?? x.op.targetTao;
  if (quoteMoved(q.targetTao, was)) throw new QuoteMovedError({ nowTao: q.targetTao, wasTao: was, priceUsd: q.taoPriceUsd });
  await x.check?.(q);
  x.record({ targetTao: q.targetTao, minTaoOut: q.minTaoOut, priceUsd: q.taoPriceUsd, feesUsd: q.feesUsd });
  return q;
}

/** The calls that carry on a v3 stake: by approval (a declined or refused permit is never asked for
 * again), with a fresh deadline. A stake already sent is only waited for, and a wallet batch still being
 * checked is rebuilt as it was sent, at the floor it was sent with, so its receipts line up (nothing in
 * it is sent again). One not yet sent goes at `fresh`'s floor, today's quote's (planResumeStakeV3),
 * and can't be built without it: the recorded floor is never the one sent. */
export function resumeStakeV3Calls(
  op: Pick<DepositOp, "usdcIn" | "minTaoOut" | "hashes" | "callsId">,
  w: Balances,
  d: Deployment,
  account: Address,
  nowMs: number,
  fresh?: Pick<DepositQuote, "minTaoOut">,
): FlowCall[] {
  const deadline = stakeDeadline(nowMs);
  // a batch is only ever sent for an approval and the stake together
  if (op.callsId) return stakeV3Calls({ usdcIn: op.usdcIn, minTaoOut: op.minTaoOut ?? 0n }, { ...w, usdcStakerAllowance: 0n }, d, account, undefined, deadline);
  if (op.hashes.stake) return stakeV3Calls({ usdcIn: op.usdcIn, minTaoOut: op.minTaoOut ?? 0n }, w, d, account, undefined, deadline).filter((c) => c.key === "stake");
  if (!fresh) throw new Error("A stake not yet sent is carried on only at a fresh quote's floor (planResumeStakeV3), never the recorded one");
  return stakeV3Calls({ usdcIn: op.usdcIn, minTaoOut: fresh.minTaoOut }, w, d, account, undefined, deadline);
}

const UNCHECKED = "We couldn't check whether your stake already went through. Try again in a moment.";

/** Carrying on a v3 stake. One whose stake hash or wallet batch is recorded is only waited for. Otherwise
 * the chain is searched (`findStake`) for this account's stake of this amount: one found is adopted as
 * this stake's (`adopt`) and only waited for, so nothing is sent; a search that can't be completed sends
 * nothing. None found carries on at today's terms (freshStakeTerms: a fresh quote, the user's say-so
 * when it moved, the oracle's check), by approval at today's floor. */
export async function planResumeStakeV3(x: {
  op: Pick<DepositOp, "usdcIn" | "targetTao" | "minTaoOut" | "hashes" | "callsId" | "createdAt">;
  w: Balances;
  d: Deployment;
  account: Address;
  now: number;
  /** The stake transaction the chain shows for this record, or null; throws when it can't tell. */
  findStake: () => Promise<Hex | null>;
  adopt: (hash: Hex) => void;
  quote: FreshTermsInput["quote"];
  accepted?: bigint;
  /** The oracle's price of one TAO in USDC units (reads.ts, readOraclePrice), for the price check. */
  oracle: () => Promise<bigint>;
  record: FreshTermsInput["record"];
}): Promise<FlowCall[]> {
  if (x.op.hashes.stake || x.op.callsId) return resumeStakeV3Calls(x.op, x.w, x.d, x.account, x.now);
  let found: Hex | null;
  try {
    found = await x.findStake();
  } catch {
    throw new FlowError(UNCHECKED, "needs-you");
  }
  if (found) {
    x.adopt(found);
    return resumeStakeV3Calls({ ...x.op, hashes: { ...x.op.hashes, stake: found } }, x.w, x.d, x.account, x.now);
  }
  const q = await freshStakeTerms({ op: x.op, now: x.now, quote: x.quote, accepted: x.accepted, check: (fresh) => assertPriceAgrees(fresh, x.oracle), record: x.record });
  return resumeStakeV3Calls(x.op, x.w, x.d, x.account, x.now, q);
}

/** Carrying on a v2 stake, or a deposit of TAO already in the wallet (usdcIn 0). What the chain shows
 * done is dropped first (stillToSend: the deposit already in the open batch, the swap's TAO already in
 * the wallet), so a deposit whose hash was lost to a reload is never made twice. A v2 swap that was
 * sent (its hash recorded) or shows done is never quoted again; one never sent goes at today's terms
 * (freshStakeTerms), never the recorded ones. A deposit of wallet TAO has no price to quote. */
export async function planResumeDeposit(x: {
  op: Pick<DepositOp, "usdcIn" | "targetTao" | "hashes" | "createdAt">;
  w: Balances;
  d: Deployment;
  account: Address;
  now: number;
  /** What the chain shows for the account: TAO in the wallet, and TAO in the open batch. */
  chain: { walletTao: bigint; depositOf: bigint };
  quote: FreshTermsInput["quote"];
  accepted?: bigint;
  record: FreshTermsInput["record"];
}): Promise<FlowCall[]> {
  if (x.op.usdcIn === 0n) return stillToSend(depositTaoCalls(x.op.targetTao, x.w, x.d), x.op, x.chain);
  const left = stillToSend(stakeCalls(x.op, x.w, x.d, x.account), x.op, x.chain);
  if (x.op.hashes.swap || !left.some((c) => c.key === "swap")) return left;
  const q = await freshStakeTerms({ op: x.op, now: x.now, quote: x.quote, accepted: x.accepted, record: x.record });
  return stakeCalls(q, x.w, x.d, x.account);
}

/** TAO already in the wallet into the front door: an exact approval, then the deposit, in whole rao. */
export function depositTaoCalls(taoWei: bigint, w: Balances, d: Deployment): FlowCall[] {
  const amount = floorRao(taoWei);
  const out: FlowCall[] = [];
  if (w.taoFrontDoorAllowance < amount) out.push(call("approveTao", TOKENS.tao, ERC20, "approve", [d.frontDoor, amount]));
  out.push(call("deposit", d.frontDoor, FRONT_DOOR, "deposit", [amount]));
  return out;
}

/** How long a wallet-TAO deposit waits for its price before it goes ahead unpriced (the price only feeds
 * the Activity line). */
const PRICE_WAIT_MS = 3_000;

/** A deposit of TAO already in the wallet, as recorded before anything is sent: priced at what selling
 * TAO pays at the click (`price`, read then). A price that can't be read, or isn't back within
 * `priceWaitMs`, leaves it unpriced; it never holds up the deposit for long, and never records $0. */
export async function walletTaoDepositOp(x: {
  id: string;
  account: Address;
  taoWei: bigint;
  now: number;
  price: () => Promise<number>;
  priceWaitMs?: number;
}): Promise<DepositOp> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const priceUsd = await Promise.race([
    Promise.resolve()
      .then(x.price)
      .then(
        (p) => (p > 0 ? p : undefined),
        () => undefined,
      ),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, x.priceWaitMs ?? PRICE_WAIT_MS, undefined);
    }),
  ]).finally(() => clearTimeout(timer));
  return {
    id: x.id,
    kind: "deposit",
    account: x.account,
    createdAt: x.now,
    usdcIn: 0n,
    targetTao: floorRao(x.taoWei),
    ...(priceUsd !== undefined ? { priceUsd } : {}),
    hashes: {},
    state: "running",
  };
}

// ---- The ways out: a sale of TAO to USDC is checked against the oracle; claiming TAO never is ----

/** A sale as quoted: the TAO sold and the USDC it pays. */
export interface SaleQuote {
  taoWei: bigint;
  usdcOut: bigint;
}

/** The USDC units a sale pays per TAO. Zero for a sale of nothing. */
export const saleUsdcPerTao = (s: SaleQuote): bigint => (s.taoWei > 0n ? (s.usdcOut * 10n ** 18n) / s.taoWei : 0n);

/** Whether a sale's price agrees with the oracle's: a sale pays a little under it (the pools' fees,
 * this size's impact), but not more than `bps` under; anything over it is the user's gain. A price of
 * nothing agrees with nothing. */
export function saleAgrees(sale: bigint, oracle: bigint, bps: bigint = PRICE_CHECK_BPS): boolean {
  if (sale <= 0n || oracle <= 0n) return false;
  return sale >= oracle || (oracle - sale) * 10_000n <= oracle * bps;
}

export const SALE_DISAGREES =
  "The price we were quoted for selling your TAO is more than 5% under Cascade's price oracle, so it wasn't sold. Keep it as TAO for now, or try again in a few minutes.";
export const SALE_UNCHECKED = "We couldn't double-check today's price just now, so your TAO wasn't sold. Keep it as TAO for now, or try again in a moment.";

/** A sale held by the price check: nothing was sold, and the TAO is the user's to claim or keep as
 * TAO, which no check ever holds (useFlows offers "Claim as TAO instead"). */
export class SaleRefusedError extends FlowError {
  constructor(message: string) {
    super(message, "needs-you");
    this.name = "SaleRefusedError";
  }
}

/** The floor of a sale of `taoWei` to USDC (0.5% under today's quote), once the quote checks out
 * against the oracle (`oracle`, when the deployment has one: v2 has none, and sells unchecked). The
 * one price check on the ways out, and only on the sale: a claim kept as TAO asks nothing of it. */
export async function saleFloor(x: { taoWei: bigint; quote: () => Promise<bigint>; oracle?: () => Promise<bigint> }): Promise<bigint> {
  const out = await x.quote();
  if (x.oracle) {
    let o: bigint;
    try {
      o = await x.oracle();
    } catch {
      throw new SaleRefusedError(SALE_UNCHECKED);
    }
    if (!saleAgrees(saleUsdcPerTao({ taoWei: x.taoWei, usdcOut: out }), o)) throw new SaleRefusedError(SALE_DISAGREES);
  }
  return lessSlippage(out);
}

/** TAO in the wallet back to USDC (TAO –0.3%→ WETH –0.05%→ USDC) with a minimum. When the router's
 * allowance falls short it is approved for exactly this sale, never an open amount. */
export function sellTaoCalls(taoWei: bigint, minUsdc: bigint, w: Balances, account: Address): FlowCall[] {
  const out: FlowCall[] = [];
  if (w.taoRouterAllowance < taoWei) out.push(call("approveTao", TOKENS.tao, ERC20, "approve", [UNISWAP.router, taoWei]));
  out.push(
    call("swap", UNISWAP.router, ROUTER, "exactInput", [
      { path: PATH_TAO_TO_USDC, recipient: account, amountIn: taoWei, amountOutMinimum: minUsdc },
    ]),
  );
  return out;
}

/** The redeem request fee is due once per open batch: a second request in it must send 0. */
export function unstakeCall(shares: bigint, redeemOf: bigint, redeemRequestFee: bigint, d: Deployment): FlowCall {
  return call("request", d.frontDoor, FRONT_DOOR, "requestRedeem", [shares], redeemOf === 0n ? redeemRequestFee : 0n);
}

/** v3: the unstake request and the USDC delivery preference in one call, under the same fee rule. */
export function unstakeV3Call(shares: bigint, redeemOf: bigint, fee: bigint, q: Pick<WithdrawalQuote, "minUsdcPerTao" | "deliveryDeadline">, d: Deployment): FlowCall {
  return call(
    "request",
    d.frontDoor,
    FRONT_DOOR,
    "requestRedeemWithDelivery",
    [shares, q.minUsdcPerTao, BigInt(q.deliveryDeadline), DESTINATION_BASE],
    redeemOf === 0n ? fee : 0n,
  );
}

/** Code at an account that leaves its nonce its own key's: none (a plain key account), or an EIP-7702
 * delegation (0xef0100 and the 20-byte address it delegates to). */
const ownNonce = (code: Hex | undefined) => code === undefined || code === "0x" || (size(code) === 23 && code.toLowerCase().startsWith("0xef0100"));

/** An unstake's request, with what its record keeps before it is sent: the fee it pays and the
 * account's pending nonce on Base, read last so it is as close to the send as it can be (the request's
 * own nonce is at least this; facts.ts tells a dropped request from one Base can't see by it). Only for
 * an account whose nonce is its own key's (ownNonce): a contract account, like a Base Account, sends
 * through others whose nonces move instead, so its record keeps none, as does one whose code can't be
 * read. A nonce left out never stops the request: its record just waits longer before a drop is
 * believed. */
export async function planUnstake(x: {
  q: Pick<WithdrawalQuote, "shares" | "minUsdcPerTao" | "deliveryDeadline">;
  d: Deployment;
  v3: boolean;
  frontDoor: () => Promise<Pick<FrontDoorState, "redeemOf" | "redeemRequestFee">>;
  /** The code at the account on Base (undefined or "0x" when there is none). */
  accountCode: () => Promise<Hex | undefined>;
  pendingNonce: () => Promise<number>;
  record: (patch: { fee: bigint; nonce?: number }) => void;
}): Promise<FlowCall[]> {
  const fd = await x.frontDoor();
  const c = x.v3 ? unstakeV3Call(x.q.shares, fd.redeemOf, fd.redeemRequestFee, x.q, x.d) : unstakeCall(x.q.shares, fd.redeemOf, fd.redeemRequestFee, x.d);
  const own = await x.accountCode().then(ownNonce, () => false);
  const nonce = own ? await x.pendingNonce().catch(() => undefined) : undefined;
  x.record({ fee: c.value ?? 0n, ...(nonce !== undefined ? { nonce } : {}) });
  return [c];
}

export function claimCalls(claimable: bigint, minUsdc: bigint, w: Balances, d: Deployment, account: Address, keepTao: boolean): FlowCall[] {
  const out = [call("claim", d.frontDoor, FRONT_DOOR, "claim", [])];
  return keepTao ? out : [...out, ...sellTaoCalls(claimable, minUsdc, w, account)];
}

// ---- Send it now: the open batch on its way, the user paying its bridge fee ----

/** closeBatch with `value`: the front door pays the bridge fee from the batch's pot first, then from the
 * value, and refunds the rest to the sender. */
export const sendNowCall = (value: bigint, d: Deployment): FlowCall => call("close", d.frontDoor, FRONT_DOOR, "closeBatch", [], value);

export const SEND_UNREAD = "We couldn't read the batch on Base just now, so nothing was sent. Try again in a moment.";
export const SEND_PAUSED = "Cascade is paused right now, so the batch can't be sent. Nothing was sent.";
export const SEND_GONE = "It's already on its way, so nothing was sent.";
export const SEND_NOT_YOURS = "Nothing of yours is waiting in this batch any more, so nothing was sent.";
export const SEND_NOT_YET = "This batch can't be sent yet, so nothing was sent.";
export const SEND_NO_FEE = "We couldn't read the bridge fee just now, so nothing was sent. Try again in a moment.";
export const SEND_FEE_UNCONFIRMED = "The bridge fee couldn't be confirmed just now (our two sources for it disagree), so nothing was sent. Try again in a moment.";
export const SEND_FEE_ROSE = "The bridge fee rose just now, so nothing was sent. Try again.";
export const SEND_NOT_NOW = "This batch can't be sent right now (it may have just left), so nothing was sent.";
export const SEND_FREE = "It leaves on its own any moment now, at no cost to you, so nothing was sent.";
export const SEND_COVERED = "Its fees cover the bridge fee, so it leaves on its own within the hour. Nothing was sent.";
export const SEND_BLOCKED = "Bittensor's side isn't accepting batches right now, so nothing was sent.";
export const SEND_UNCHECKED = "We couldn't check Bittensor's side just now, so nothing was sent. Try again in a minute.";
export const SEND_NO_REFUND = "Your wallet couldn't receive the refund of what the fee doesn't take, so nothing was sent.";
const SEND_UNREACHABLE = "We couldn't reach Base just now, so nothing was sent. Try again in a moment.";

/** Why a batch sendGate doesn't open isn't sent (send-now.ts). */
const GATE_REFUSAL = { blocked: SEND_BLOCKED, unchecked: SEND_UNCHECKED, free: SEND_FREE, covered: SEND_COVERED, early: SEND_NOT_YET } as const;

/** Send it now, checked right before the wallet is asked: the open batch is read again, and nothing is
 * sent while Cascade is paused, once the batch the user saw (`batchId`) has left, when nothing of the
 * account's is in it any more, unless sendGate opens it on the read's own clock (Bittensor's side was
 * checked and can take it, and the keeper is holding it five minutes past its interval, or hasn't sent it
 * five minutes past its max wait), when its fee can't be read or the two Base RPCs disagree about it
 * (reads.ts, readOpenBatch), or when the wallet can't cover the value and the network fee. The call is
 * then run from the account (`simulate`) and goes only if Base says it would go through. Gives the call
 * and the batch it was priced from. */
export async function planSendNow(x: {
  d: Deployment;
  batchId: bigint;
  read: () => Promise<OpenBatch>;
  simulate: (c: FlowCall) => Promise<Simulation>;
}): Promise<{ call: FlowCall; batch: OpenBatch }> {
  let b: OpenBatch;
  try {
    b = await x.read();
  } catch {
    throw new FlowError(SEND_UNREAD, "needs-you");
  }
  if (b.paused) throw new FlowError(SEND_PAUSED, "failed");
  if (b.id !== x.batchId) throw new FlowError(SEND_GONE, "failed");
  if (b.mine.depositWei === 0n && b.mine.redeemShares === 0n) throw new FlowError(SEND_NOT_YOURS, "failed");
  // just read: Base's clock is the read's block time
  const gate = sendGate(b, x.d.batchMaxWaitS, b.chainTime);
  if (gate !== "open") throw new FlowError(GATE_REFUSAL[gate], gate === "unchecked" ? "needs-you" : "failed");
  if (b.feeWei === undefined) throw new FlowError(b.feeUnconfirmed ? SEND_FEE_UNCONFIRMED : SEND_NO_FEE, "needs-you");
  const c = sendNowCall(sendNowValue(b.feeWei, b.potWei), x.d);
  const need = ethNeeded(b);
  if (b.ethWei !== undefined && b.ethWei < need) throw new FlowError(needEthText(need, b.ethPriceUsd), "needs-you");
  let sim: Simulation;
  try {
    sim = await x.simulate(c);
  } catch (e) {
    throw new FlowError(noGas(e) ? needEthText(need, b.ethPriceUsd) : SEND_UNREACHABLE, "needs-you");
  }
  if (!sim.ok) {
    if (sim.revert === "InsufficientFee") throw new FlowError(SEND_FEE_ROSE, "needs-you");
    if (sim.revert === "EnforcedPause") throw new FlowError(SEND_PAUSED, "failed");
    if (sim.revert === "TransferFailed") throw new FlowError(SEND_NO_REFUND, "failed");
    throw new FlowError(SEND_NOT_NOW, "failed");
  }
  return { call: c, batch: b };
}

export function cancelCall(kind: "deposit" | "withdrawal", amount: bigint, d: Deployment): FlowCall {
  return kind === "deposit"
    ? call("cancel", d.frontDoor, FRONT_DOOR, "cancelDeposit", [amount])
    : call("cancel", d.frontDoor, FRONT_DOOR, "cancelRedeem", [amount]);
}

/** On resuming a stake whose hashes were lost (a reload while the wallet broadcast), drop what the
 * chain shows already happened: the deposit (in the open batch) or the swap (TAO in the wallet). */
export function stillToSend(
  calls: FlowCall[],
  op: { hashes: Partial<Record<string, Hex>>; targetTao: bigint },
  chain: { walletTao: bigint; depositOf: bigint },
): FlowCall[] {
  if (!op.hashes.deposit && chain.depositOf >= op.targetTao) return [];
  if (!op.hashes.swap && chain.walletTao >= op.targetTao) return calls.filter((c) => c.key !== "approveUsdc" && c.key !== "swap");
  return calls;
}

/** Retrying a deposit whose swap worked but whose deposit failed: forget the failed deposit (its hash
 * or wallet batch would only be read again) but keep the swap, and send one step at a time. */
export function retryPatch(op: Pick<DepositOp, "state" | "hashes" | "callsId" | "mode">): Partial<DepositOp> {
  if (op.state !== "failed") return {};
  const { approveUsdc, swap } = op.hashes;
  return {
    hashes: { ...(approveUsdc ? { approveUsdc } : {}), ...(swap ? { swap } : {}) },
    callsId: undefined,
    mode: "sequential",
    state: "running",
    error: undefined,
  };
}

const CLAIM_UNCHECKED = "We couldn't check your claim on Base just now, so nothing was sent. Try again in a moment.";

/** Carrying on a claim that stopped. The claim is kept only when Base shows it went through
 * (`claimed`, from its receipt), so only the steps after it are sent again; one Base shows didn't, like
 * a wallet batch that failed whole (its hash recorded under every step), is forgotten with its batch id.
 * Either way the rest goes one step at a time, as retryPatch does for a deposit. A claim Base can't
 * show yet (`claimed` undefined) stops here: forgetting it could send a second claim. */
export function claimRetryPatch(op: Pick<ClaimOp, "hashes">, claimed: boolean | undefined): Partial<ClaimOp> {
  const { claim } = op.hashes;
  if (claim && claimed === undefined) throw new FlowError(CLAIM_UNCHECKED, "needs-you");
  return {
    hashes: claimed && claim ? { claim } : {},
    callsId: undefined,
    mode: "sequential",
    state: "running",
    error: undefined,
  };
}

export class FlowBusyError extends Error {
  constructor() {
    super("Your wallet is already busy with another step. Finish or cancel it first.");
    this.name = "FlowBusyError";
  }
}

/** One flow at a time, claimed synchronously before anything is read, so a double click can never
 * start a second stake. `onChange` mirrors the running label into React state. */
export function createFlowGuard(onChange: (label: string | null) => void) {
  let active: string | null = null;
  return {
    get active() {
      return active;
    },
    async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
      if (active) throw new FlowBusyError();
      active = label;
      onChange(label);
      try {
        return await fn();
      } finally {
        active = null;
        onChange(null);
      }
    },
  };
}

/** One flow at a time across the whole app (the stake form, the claim box and the wallet-TAO box each
 * use the flows hook): every screen subscribes to see which flow runs, and a second is refused. */
export function createSharedFlowGuard() {
  const listeners = new Set<(label: string | null) => void>();
  const guard = createFlowGuard((label) => listeners.forEach((l) => l(label)));
  return {
    get active() {
      return guard.active;
    },
    run: guard.run,
    subscribe(listener: (label: string | null) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** What a flow needs from the wallet; wagmi provides it in the app (use-flows.ts), fakes in tests. */
export interface WalletPort {
  switchToBase(): Promise<void>;
  /** The wallet can send several calls as one atomic batch on Base (EIP-5792). */
  canBatch(): Promise<boolean>;
  sendBatch(calls: FlowCall[]): Promise<{ id: string }>;
  waitBatch(id: string): Promise<{ status: "success" | "failure"; hashes: Hex[] }>;
  send(call: FlowCall): Promise<Hex>;
  /** Waits for `hash` to be mined, or for the transaction the wallet put in its place (`onReplaced`
   * hears of that one first). */
  wait(hash: Hex, onReplaced?: (r: Replacement) => void): Promise<{ status: "success" | "reverted" }>;
  /** The account has code on Base (an EIP-7702 smart account or a contract wallet). */
  hasCode(account: Address): Promise<boolean>;
  /** Asks the wallet to sign a USDC permit, split into v, r, s; rejects if the user declines. */
  signPermit(typedData: PermitTypedData): Promise<{ v: number; r: Hex; s: Hex }>;
  /** Runs `call` from the account on Base without sending it: not ok if it would revert, with the
   * reason when Base gives one. Throws when Base can't be asked. */
  simulate(call: FlowCall): Promise<Simulation>;
}

/** A transaction the wallet put in place of one before it was mined, with viem's reason: sped up
 * ("repriced": the same call at a higher fee), cancelled, or replaced by a different transaction. */
export interface Replacement {
  hash: Hex;
  reason: "repriced" | "cancelled" | "replaced";
}

/** A pre-send check: whether the call would go through and, when not, why (see `revertReason`). */
export interface Simulation {
  ok: boolean;
  revert?: string;
}

/** Where a flow keeps its progress: the operation log entry it belongs to. */
export interface FlowStore {
  hashes(): Record<string, Hex | undefined>;
  setHash(key: string, hash: Hex): void;
  setState(state: OpState, error?: string): void;
  callsId(): string | undefined;
  setCallsId(id: string): void;
  mode(): "batch" | "sequential" | undefined;
  setMode(mode: "batch" | "sequential"): void;
}

/** The contracts aren't wired as this site's build says (wiring.ts): nothing goes in or is asked back
 * from it, but the ways out stay open (needsWiring). */
export const WIRING_MISMATCH =
  "This site doesn't match Cascade's contracts, so staking and unstaking are off. You can still claim, cancel, or swap your TAO to USDC.";
/** The wiring couldn't be read when a stake or unstake was clicked: nothing was sent. */
export const WIRING_UNCHECKED = "We can't check Cascade's contracts right now, so nothing was sent. Try again in a moment.";

/** The flows (by their labels in useFlows) that don't wait for the contracts to check out: a claim, a
 * cancel and a swap of wallet TAO only touch the listed front door and the fixed Uniswap router, send no
 * ETH and approve only that router, and a user should always be able to get their own money out. */
const EXITS: ReadonlySet<string> = new Set(["claim", "cancel", "swap"]);

/** Whether a flow (by its label in useFlows) waits for the contracts to check out: every flow but the
 * ways out (EXITS), so a stake (new, carried on, or of wallet TAO), an unstake, and any flow added later
 * is held unless it is named there. */
export const needsWiring = (label: string): boolean => !EXITS.has(label);

/** Before any flow builds or sends anything: the contracts must check out (`check`, see wiring.ts). A
 * mismatch stops it for good; a check that can't be done stops it too, never failing open. */
export async function assertWired(check: () => Promise<Wiring>): Promise<void> {
  let wiring: Wiring;
  try {
    wiring = await check();
  } catch {
    throw new FlowError(WIRING_UNCHECKED, "needs-you");
  }
  if (wiring !== "ok") throw new FlowError(WIRING_MISMATCH, "failed");
}

/** Why sending is off, before anyone clicks: only a mismatch, which turns the actions off. A check that
 * couldn't be read says nothing on its own (a message appearing by itself would move the page): its
 * actions stay as they are, and a click checks again and, failing, says why nothing was sent
 * (assertWired), in response to the click. Null too while it passes or is still being checked. */
export function wiringNotice(q: { data?: Wiring; isError: boolean }): string | null {
  return q.data === "mismatch" ? WIRING_MISMATCH : null;
}

/** The wallet can't pay the network fee (viem's and the node's wordings). */
const noGas = (e: unknown): boolean => {
  const err = e as { message?: string; cause?: unknown } | undefined;
  return /insufficient funds|exceeds the balance/i.test(err?.message ?? "") || (err?.cause !== undefined && noGas(err.cause));
};

const NO_ETH = "Network fees on Base are paid in ETH, and this wallet doesn't have enough. Add a little ETH on Base and try again.";

/** What a user sees for an error: our own messages as written, a refusal or missing ETH in plain words,
 * and never a raw RPC or library message (those can carry an RPC address). */
export function userMessage(e: unknown): string {
  if (e instanceof FlowError || e instanceof FlowBusyError) return e.message;
  if (rejected(e)) return "You declined in your wallet. Nothing was sent.";
  if (noGas(e)) return NO_ETH;
  return "We couldn't reach Base just now. Nothing was sent. Try again.";
}

const codeOf = (e: unknown): number | undefined => {
  const err = e as { code?: number; cause?: unknown };
  return err?.code ?? (err?.cause !== undefined ? codeOf(err.cause) : undefined);
};

const rejected = (e: unknown): boolean => {
  const err = e as { name?: string; code?: number; message?: string; cause?: unknown };
  return (
    err?.name === "UserRejectedRequestError" ||
    err?.code === 4001 ||
    /user (rejected|denied)|rejected the request/i.test(err?.message ?? "") ||
    (err?.cause !== undefined && rejected(err.cause))
  );
};

/** EIP-5792 / EIP-7702 answers that mean "not as a batch": declined upgrade (5750), atomicity not
 * supported (5760), unsupported chain (5710), unsupported method (4100, -32601). */
const NO_BATCH = new Set([5750, 5760, 5710, 5700, 4100, -32601]);

function revertMessage(key: string): string {
  if (key === "swap") return "The price moved before the swap went through, so nothing was deposited. Try again.";
  if (key === "stake") return "The price moved before the stake went through, so no USDC left your wallet. Stake again at today's price.";
  if (key === "close") return "Sending the batch didn't go through, usually because it had just left. Only Base's network fee was spent.";
  return "A transaction failed on Base. Nothing after it was sent.";
}

const LOST = "We couldn't confirm the transaction yet. Continue to check it again; nothing is sent twice.";
/** Send it now has nothing to continue: it is offered again, or shows as sending, from the chain's reads. */
const CLOSE_DECLINED = "You declined in your wallet, so nothing was sent.";
const CLOSE_LOST = "We couldn't confirm it yet. Check its status in a few minutes.";
const REPLACED = "This step was cancelled or replaced in your wallet, so it didn't go through. Nothing after it was sent.";

function fail(store: FlowStore, message: string, state: OpState): never {
  store.setState(state, message);
  throw new FlowError(message, state);
}

async function toBase(port: WalletPort): Promise<void> {
  try {
    await port.switchToBase();
  } catch (e) {
    throw new FlowError(rejected(e) ? "Switch your wallet to Base to continue." : "Your wallet could not switch to Base.", "needs-you");
  }
}

/** Sends `calls`: as one batch when the wallet can (and has not turned batching down), else one at a
 * time. A call whose hash is already recorded is never sent again, only waited for, so a stopped flow
 * resumes where it stopped. Anything that stops the flow leaves the record "needs-you" or "failed". */
export async function runFlow(port: WalletPort, store: FlowStore, calls: FlowCall[]): Promise<void> {
  store.setState("running");
  try {
    await toBase(port);
  } catch (e) {
    fail(store, (e as FlowError).message, "needs-you");
  }

  // a wallet batch already sent is only ever waited for, whatever the record's mode says: its calls
  // here are rebuilt only so its receipts line up, and must never go out one at a time
  const pendingBatch = store.callsId();
  const nothingSent = calls.every((c) => !store.hashes()[c.key]);
  const batchable = pendingBatch !== undefined || (store.mode() !== "sequential" && nothingSent && calls.length > 1 && (await port.canBatch().catch(() => false)));
  if (batchable) {
    let id = pendingBatch;
    if (!id) {
      try {
        ({ id } = await port.sendBatch(calls));
      } catch (e) {
        const code = codeOf(e);
        if (code !== undefined && NO_BATCH.has(code)) {
          store.setMode("sequential");
          fail(store, "Your wallet didn't take the steps as one batch. Continue to confirm them one at a time.", "needs-you");
        }
        if (rejected(e)) {
          store.setMode("sequential");
          fail(store, "You cancelled in your wallet. Continue to confirm the steps one at a time.", "needs-you");
        }
        fail(store, "Your wallet could not send the batch.", "failed");
      }
      store.setCallsId(id);
      store.setMode("batch");
    }
    let r: { status: "success" | "failure"; hashes: Hex[] };
    try {
      r = await port.waitBatch(id);
    } catch {
      fail(store, LOST, "needs-you");
    }
    // a smart account usually runs the whole batch in one transaction
    calls.forEach((c, i) => {
      const h = r.hashes.length === calls.length ? r.hashes[i] : r.hashes[0];
      if (h) store.setHash(c.key, h);
    });
    if (r.status !== "success") fail(store, "The batch failed on Base, so nothing in it went through. Try again.", "failed");
    store.setState("sent");
    return;
  }

  store.setMode("sequential");
  for (const c of calls) {
    let hash = store.hashes()[c.key];
    if (!hash) {
      try {
        hash = await port.send(c);
      } catch (e) {
        if (rejected(e)) fail(store, c.key === "close" ? CLOSE_DECLINED : "You cancelled in your wallet. Continue when you're ready.", "needs-you");
        fail(store, noGas(e) ? NO_ETH : "Your wallet couldn't send this step. Try again.", "failed");
      }
      store.setHash(c.key, hash);
    }
    let r: { status: "success" | "reverted" };
    let replaced = false;
    try {
      r = await port.wait(hash, (x) => {
        // sped up: the same call under a new hash, the one that counts from now on
        if (x.reason === "repriced") store.setHash(c.key, x.hash);
        // cancelled, or another transaction took its nonce: this step never happened
        else replaced = true;
      });
    } catch {
      fail(store, c.key === "close" ? CLOSE_LOST : LOST, "needs-you");
    }
    if (replaced) fail(store, REPLACED, "failed");
    if (r.status !== "success") fail(store, revertMessage(c.key), "failed");
  }
  store.setState("sent");
}

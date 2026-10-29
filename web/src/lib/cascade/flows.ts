import { type Abi, type Address, type Hex, parseSignature, size } from "viem";
import { base } from "viem/chains";
import { ERC20, FRONT_DOOR, ROUTER, STAKER } from "./abi";
import { DESTINATION_BASE, type Deployment, PATH_TAO_TO_USDC, TOKENS, UNISWAP, USDC_PERMIT } from "./config";
import type { ClaimOp, DepositOp, OpState } from "./oplog";
import type { Balances, DepositQuote, WithdrawalQuote } from "./types";
import { floorRao } from "./units";
import type { Wiring } from "./wiring";
import { formatUsdShort } from "../format";

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

/** USDC → exactly `targetTao` TAO (unused USDC never leaves the wallet) → the front door. Every approval
 * is for exactly what the call after it may spend: Uniswap's router the swap's most (`usdcIn`), the front
 * door the exact deposit. None is ever left open. */
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
const BATCH_FULL = new Set(["BatchValueFull", "BatchFull"]);
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
  if (BATCH_FULL.has(reason)) return "The current batch filled up, so nothing was sent. Try a smaller amount, or try again soon.";
  if (PAUSED.has(reason)) return "Staking is paused right now, so nothing was sent. Try again later.";
  if (priceMoved(reason)) return "The price moved since your quote, so this stake wouldn't go through and nothing was sent. Stake again at today's price.";
  return WONT_GO_THROUGH;
}

export interface StakeV3Input {
  q: Pick<DepositQuote, "usdcIn" | "minTaoOut">;
  w: Balances;
  d: Deployment;
  account: Address;
  /** USDC's permit nonce for the account, read fresh just before signing. */
  nonce: () => Promise<bigint>;
  /** ms since the epoch */
  now: number;
  /** The smallest stake in dollars, as the form shows it; read only to explain a stake under it. */
  minUsd?: () => Promise<number>;
}

/** v3: how this stake is paid for, as the calls to send. A plain key account signs one USDC permit and
 * sends one `stakeWithPermit`. An account with code (an EIP-7702 smart account, whose permit USDC may
 * refuse), a wallet that can't sign a permit, or a permit USDC refuses in the pre-send check pays by an
 * exact approval and `stake` instead (one batch where the wallet can). An allowance that already covers
 * the stake needs neither. A declined signature stops here, "needs you", with nothing asked again until
 * the user continues; a stake that would revert for its own reasons stops before anything is sent. */
export async function planStakeV3(port: WalletPort, x: StakeV3Input): Promise<FlowCall[]> {
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

/** Carrying on a v3 stake that stopped: by approval (a declined or refused permit is never asked for
 * again), at the floor the user agreed to, with a fresh deadline. A stake already sent is only waited
 * for, and a wallet batch still being checked is rebuilt as it was sent so its receipts line up. */
export function resumeStakeV3Calls(
  op: Pick<DepositOp, "usdcIn" | "minTaoOut" | "hashes" | "callsId">,
  w: Balances,
  d: Deployment,
  account: Address,
  nowMs: number,
): FlowCall[] {
  if (op.minTaoOut === undefined) throw new Error("This stake has no recorded minimum, so it can't be carried on");
  // a batch is only ever sent for an approval and the stake together
  const calls = stakeV3Calls({ usdcIn: op.usdcIn, minTaoOut: op.minTaoOut }, op.callsId ? { ...w, usdcStakerAllowance: 0n } : w, d, account, undefined, stakeDeadline(nowMs));
  return op.hashes.stake && !op.callsId ? calls.filter((c) => c.key === "stake") : calls;
}

const UNCHECKED = "We couldn't check whether your stake already went through. Try again in a moment.";

/** Carrying on a v3 stake, first making sure it didn't already go through. Unless its stake hash or its
 * wallet batch is recorded (those are only waited for), the chain is searched (`findStake`) for this
 * account's stake of this amount: one found is adopted as this stake's (`adopt`) and only waited for,
 * so nothing is sent; none found carries on as `resumeStakeV3Calls` does. A search that can't be
 * completed sends nothing. */
export async function planResumeStakeV3(x: {
  op: Pick<DepositOp, "usdcIn" | "minTaoOut" | "hashes" | "callsId">;
  w: Balances;
  d: Deployment;
  account: Address;
  now: number;
  /** The stake transaction the chain shows for this record, or null; throws when it can't tell. */
  findStake: () => Promise<Hex | null>;
  adopt: (hash: Hex) => void;
}): Promise<FlowCall[]> {
  let hashes = x.op.hashes;
  if (!hashes.stake && !x.op.callsId) {
    let found: Hex | null;
    try {
      found = await x.findStake();
    } catch {
      throw new FlowError(UNCHECKED, "needs-you");
    }
    if (found) {
      x.adopt(found);
      hashes = { ...hashes, stake: found };
    }
  }
  return resumeStakeV3Calls({ ...x.op, hashes }, x.w, x.d, x.account, x.now);
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

export function claimCalls(claimable: bigint, minUsdc: bigint, w: Balances, d: Deployment, account: Address, keepTao: boolean): FlowCall[] {
  const out = [call("claim", d.frontDoor, FRONT_DOOR, "claim", [])];
  return keepTao ? out : [...out, ...sellTaoCalls(claimable, minUsdc, w, account)];
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
  wait(hash: Hex): Promise<{ status: "success" | "reverted" }>;
  /** The account has code on Base (an EIP-7702 smart account or a contract wallet). */
  hasCode(account: Address): Promise<boolean>;
  /** Asks the wallet to sign a USDC permit, split into v, r, s; rejects if the user declines. */
  signPermit(typedData: PermitTypedData): Promise<{ v: number; r: Hex; s: Hex }>;
  /** Runs `call` from the account on Base without sending it: not ok if it would revert, with the
   * reason when Base gives one. Throws when Base can't be asked. */
  simulate(call: FlowCall): Promise<Simulation>;
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

export class FlowError extends Error {
  readonly state: OpState;

  constructor(message: string, state: OpState) {
    super(message);
    this.state = state;
  }
}

/** The contracts aren't wired as this site's build says (wiring.ts): nothing is ever sent from it. */
export const WIRING_MISMATCH = "This site doesn't match Cascade's contracts, so staking, unstaking and claiming are off. Nothing will be sent.";
/** The wiring couldn't be read: nothing is sent until it can. */
export const WIRING_UNCHECKED = "We can't check Cascade's contracts right now, so nothing can be sent. Try again in a moment.";

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

/** Why sending is off, from the wiring check's state, before anyone clicks; null while it passes or is
 * still being checked (a click then waits for it, through assertWired). */
export function wiringNotice(q: { data?: Wiring; isError: boolean }): string | null {
  if (q.data === "mismatch") return WIRING_MISMATCH;
  if (q.isError && q.data !== "ok") return WIRING_UNCHECKED;
  return null;
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
  return "A transaction failed on Base. Nothing after it was sent.";
}

const LOST = "We couldn't confirm the transaction yet. Continue to check it again; nothing is sent twice.";

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

  const pendingBatch = store.callsId();
  const nothingSent = calls.every((c) => !store.hashes()[c.key]);
  const batchable =
    store.mode() !== "sequential" && (pendingBatch !== undefined || (nothingSent && calls.length > 1 && (await port.canBatch().catch(() => false))));
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
        if (rejected(e)) fail(store, "You cancelled in your wallet. Continue when you're ready.", "needs-you");
        fail(store, noGas(e) ? NO_ETH : "Your wallet couldn't send this step. Try again.", "failed");
      }
      store.setHash(c.key, hash);
    }
    let r: { status: "success" | "reverted" };
    try {
      r = await port.wait(hash);
    } catch {
      fail(store, LOST, "needs-you");
    }
    if (r.status !== "success") fail(store, revertMessage(c.key), "failed");
  }
  store.setState("sent");
}

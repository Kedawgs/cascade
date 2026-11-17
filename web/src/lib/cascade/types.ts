/**
 * The data contract between the Cascade UI and the chains.
 *
 * Every value comes from Base or Bittensor (see ./live.ts) or is derived from chain data by stated
 * arithmetic; anything the chain cannot give is left undefined and hidden. Amounts that feed a
 * transaction are exact `bigint`s (TAO wei, csTAO share units, USDC units, ETH wei); the numbers
 * beside them are for display only. Writes are wallet flows (./flows.ts), not part of this contract.
 */

import type { Clients } from "./chain";
import type { Deployment, Stage } from "./config";
import type { DeliveryLimit } from "./delivery-limit";
import type { PriceImpact } from "./impact";
import type { FigureStore } from "../remembered";
import type { OpLog } from "./oplog";
import type { DepositRecord, WithdrawalRecord } from "./records";

export type { DepositRecord, DepositStepKey, StepStatus, TrailStep, WithdrawalRecord, WithdrawalStepKey } from "./records";

export type SourceChain = "base" | "ethereum" | "arbitrum" | "polygon" | "bnb";

/** The account's stake, from contract reads alone: it never waits on the vault's history. */
export interface Position {
  /** csTAO the account holds on Bittensor. */
  shares: bigint;
  /** What those shares are worth in TAO now. */
  taoWei: bigint;
  taoBalance: number;
  usdValue: number;
  taoPriceUsd: number;
  /** v3.2: TAO's price couldn't be read: `taoPriceUsd` and `usdValue` are 0 and not to be shown (live.ts getPosition). */
  priceMissing?: true;
  /** v3.2 (R6, ChatGPT R2 claim B): the account's redeem origin is already another than Base's (DIRECT_ORIGIN, or another
   * chain's door): a stake into it still mints, but can leave only on Bittensor, by whoever controls the address there
   * (stake-form.ts originDepositNote). None while it is Base's or not set yet (a Base deposit makes it Base's). */
  withdrawsOnBittensor?: true;
}

/** What can be unstaked: the shares not already asked back (in the open batch, or on their way to the
 * vault), and their TAO now. Waits on the vault's history only while one of this browser's unstakes is
 * on its way and the scan hasn't seen it arrive. */
export interface Available {
  availableShares: bigint;
  availableTaoWei: bigint;
  /** v3: the most TAO one more unstake request can carry (units.unstakeMostWei). Absent on v2. */
  mostTaoWei?: bigint;
  /** Whether one of this browser's unstakes arrived can't be told yet: the history indexer's word on
   * those blocks hasn't been confirmed by the chain. The figures above are then zero and shown as
   * "checking…", never as an amount (live.ts, getAvailable). */
  checking?: true;
  /** v3.2: the vault lens reads stake missing (`stakeMissing()`): the vault refuses every delivery until it is
   * reconnected, so a request now would only wait, and the form holds it (stake-form.ts, requestHold). */
  stakeMissing?: true;
  /** v3.2: the account holds shares whose redeem origin isn't Base's (DIRECT_ORIGIN, another chain, or none yet: the
   * reward cut's): a Base request of them is skipped by the vault and its fee spent for nothing (Review Focus 4), so
   * the form holds it and says what to do. */
  originElsewhere?: true;
}

/** Figures that need the vault's history (its logs since deployment, scanned from where this browser
 * last stopped): "–" until it has been read. */
export interface PositionHistory {
  /** TAO from deposits still on their way (open batch or on the bridge). */
  pendingTao: number;
  /** Value now + TAO taken out − TAO put in; undefined until there is a deposit. */
  rewardsEarnedTao?: number;
  /** Average price paid across this browser's deposits, or null. */
  avgEntryPriceUsd: number | null;
  /** The account's history came from the history indexer's seed and this browser hasn't read it all from
   * the chain itself yet: an event left out of a seed could move the figures, so `rewardsEarnedTao` is
   * left out and the UI says "checking…" (no number), until the background read matches (live.ts) and
   * this clears. */
  provisional?: true;
}

export interface StakeProof {
  /** Everything that can be staked is staked (idle TAO is below what a stake needs). */
  allStaked: boolean;
  stakedTao: number;
  owedTao: number;
  /** The vault holds TAO waiting until one position reaches the chain's 0.02-TAO minimum. */
  waitingForMinimum: boolean;
  /** Bittensor's minimum stake for one position. */
  minimumTao: number;
  checkedAt: Date;
  validatorHotkey: string;
  explorerUrl: string;
  /** v3.2: the vault lens reads stake missing: staking and unstaking wait while Cascade reconnects to its validator. */
  stakeMissing?: true;
}

/** Protocol-wide figures read on Bittensor. A missing value shows as "–". (No count of stakers: there is no indexer.)
 * The TAO price is not one of them: it is read on Base, on its own (getTaoPrice), so it neither waits for Bittensor's
 * node nor fails with it. */
export interface ProtocolStats {
  totalStakedTao?: number;
}

export interface RewardRecord {
  date: Date;
  taoAccrued: number;
  runningTotalTao: number;
}

export interface DepositQuote {
  usdcIn: bigint;
  /** TAO the swap would give now, and the exact (whole-rao) TAO the deposit asks for. */
  expectedTao: bigint;
  targetTao: bigint;
  estTao: number;
  amountUsd: number;
  taoPriceUsd: number;
  /** Uniswap pool fees on this route; Base gas is extra (cents). */
  feesUsd: number;
  closesAt: Date;
  etaMinutes: number;
  /** The front door's batch interval, in seconds: how often a batch can leave. */
  batchIntervalS?: number;
  /** The least TAO the swap may return (whole rao, rounded up); v2 has no such floor, so it equals targetTao. */
  minTaoOut: bigint;
  /** Cascade's flat and percentage fees in USDC units (zero on v2), and both in dollars. */
  depositFeeUsdc: bigint;
  swapFeeUsdc: bigint;
  cascadeFeesUsd: number;
  /** v3.2 only: the swap's own price impact, the USDC swapped and its TAO against what the veto's $100 buys
   * (impact.ts). Absent on every other deployment. */
  impact?: PriceImpact;
}

export interface WithdrawalQuote {
  shares: bigint;
  taoWei: bigint;
  taoAmount: number;
  usdcAmount: number;
  /** ETH to send with `requestRedeem` (the request fee, only for the first request in a batch). */
  fee: bigint;
  /** The bridge fee taken from the payout, in TAO wei. */
  bridgeFeeWei: bigint;
  feesUsd: number;
  taoPriceUsd: number;
  closesAt: Date;
  etaMinutes: number;
  /** The front door's batch interval, in seconds: how often a batch can leave. */
  batchIntervalS?: number;
  /** v3 delivery: the least USDC (units) per whole TAO the sale may pay, and its unix-second deadline. Zero on v2. */
  minUsdcPerTao: bigint;
  deliveryDeadline: number;
  /** v3.2 only: the delivery sale's own price impact, the payout's TAO and its USDC against what the veto's 0.5 TAO
   * sells for (impact.ts). Absent on every other deployment. */
  impact?: PriceImpact;
}

/** v3, for the stake form's break-even line: what leaving costs beyond the percentage fees, and the
 * share of rewards Cascade keeps. */
export interface RoundTripCosts {
  /** The unstake request fee (ETH, at today's ETH price) and the bridge fee back to Base (TAO, at
   * today's TAO price), in dollars. */
  exitFixedUsd: number;
  rewardCutBps: number;
}

export interface Limits {
  minTao: bigint;
  maxTao: bigint;
  minUsd: number;
  maxUsd: number;
  /** Which limit leaves no room for even the smallest deposit: the deposit cap, or the open batch
   * (which frees up once it leaves). */
  full: "cap" | "batch" | null;
  /** v3.2 (R8): the open batch is what limits a stake now, and it can close: the most a stake could be once it has left
   * (the next batch's whole value limit, held to the cap's room, which a close leaves as it is: the cap counts the open
   * batch already). The stake form offers to close the batch first for a stake between `maxUsd` and this. Absent
   * otherwise, and on every other deployment. R9 (M-2, L-1): with the open batch it was read from (`batchId`); whether it
   * can close because its limits are reached (`due` "full": the keeper sends it on its next round, whatever its fees) or
   * by time alone ("time": under half its limits, its interval passed, so the keeper may hold it for its fee rule); and how
   * long this data source's reads have found that same batch closable that same way (`closableForMs`, to this read's
   * start from the answer of the first read that did: 0 on that read), so the form offers a paid close only once the
   * keeper's next round has had a chance to send it for free. R10 (M-A, L-B): it starts again when the batch becomes
   * closable another way (due by time, then full) and when no read has found it closable for over about two refreshes
   * (live.ts CLOSABLE_GAP_MS). */
  afterClose?: { maxTao: bigint; maxUsd: number; batchId: bigint; due: "full" | "time"; closableForMs: number };
}

export interface Balances {
  usdc: bigint;
  tao: bigint;
  eth: bigint;
  usdcRouterAllowance: bigint;
  /** v3: USDC the staker may already take (zero on v2, which has no staker). */
  usdcStakerAllowance: bigint;
  taoRouterAllowance: bigint;
  taoFrontDoorAllowance: bigint;
  /** TAO waiting to be claimed on Base (an unstake's payout, or a deposit the vault sent back). */
  claimable: bigint;
}

/** The open batch on Base as the public "Next batch" line needs it, from one multicall (reads.ts,
 * readNextBatch). */
export interface NextBatch {
  id: bigint;
  /** When it started (unix seconds): it can close `interval` seconds later, or sooner once it's full. */
  start: number;
  interval: number;
  canClose: boolean;
  paused: boolean;
  /** v3.2: the front door's pause stops new deposits only, never a close (spec §3.5, I-20): a paused batch still
   * leaves. Absent on v3-launch, whose pause holds the batch too. */
  closesWhilePaused?: true;
  /** How many deposits and unstake requests wait in it. */
  deposits: number;
  redeems: number;
  /** Base's clock when it was read: the timestamp of the block the multicall read (unix seconds). */
  chainTime: number;
}

/** The open batch on Base as "Send it now" needs it (reads.ts, readOpenBatch). Anyone may send a batch once
 * it can close by paying its bridge fee (CascadeFrontDoor.closeBatch): the batch's pot of unstake-request
 * fees pays first, and whatever the fee doesn't take goes back to the sender. */
export interface OpenBatch {
  id: bigint;
  /** When it started (unix seconds): it can close `interval` seconds later, or sooner once it's full. */
  start: number;
  interval: number;
  canClose: boolean;
  paused: boolean;
  /** v3.2: the front door's pause stops new deposits only, never a close (spec §3.5, I-20), so a paused batch can
   * still be sent. Absent on v3-launch, whose pause stops closes too. */
  closesWhilePaused?: true;
  /** Base's clock when it was read: the timestamp of the block the multicall read (unix seconds). */
  chainTime: number;
  /** The account's own entries in it: the TAO it deposits and the shares it asks back; on v3.2 (R11) the first second
   * (Base's clock) its cancel works, five minutes after the last deposit to its entry (0: no wait, build B). */
  mine: { depositWei: bigint; redeemShares: bigint; cancelableAt?: number };
  /** v3.2: the redeem list's length and limit. A request from an account with none in it, to a full list, closes the
   * batch first on its pot alone, and reverts InsufficientFee when the pot is short of the bridge fee. */
  nRedeems?: number;
  maxRedeems?: number;
  /** The unstake-request fees it holds, which pay its bridge fee first. */
  potWei: bigint;
  /** The deposits it holds (TAO wei): on v3.2 the minValue of a close the site sends so a deposit can go in after it
   * when the batch is due by time alone (R8: a cancel landing first then makes that close revert BatchTooSmall); a full
   * batch's close names a total still full (R12c, `limits`; R12e: the highest line that held). */
  totalWei?: bigint;
  /** v3.2 (R12c): its deposit list's length and the door's limits, from the same block: what makes it full, so a close the
   * site sends before a stake names a total still full (units.ts closeFirstFloor: R12e, the highest line that held). */
  limits?: { nDeposits: number; maxDeposits: number; maxBatchValue: bigint; minDeposit: bigint; depositCap: bigint; netForwarded: bigint };
  /** Read only once it can close (with entries, and not paused); each is undefined when its read failed.
   * The bridge fee to send it now, as the bridge quotes it for this batch's exact message, read on both
   * Base RPCs and kept only when they agree (reads.ts, readOpenBatch). */
  feeWei?: bigint;
  /** The two Base RPCs quoted bridge fees more than FEE_CHECK_BPS apart, so neither is trusted and
   * `feeWei` is left out. */
  feeUnconfirmed?: true;
  /** The account's ETH on Base, and an allowance for closeBatch's network fee. */
  ethWei?: bigint;
  gasWei?: bigint;
  ethPriceUsd?: number;
  /** Read while the keeper may still send it for free at its interval (until five minutes after it, and
   * not full): the keeper's own weighing of its fees against its bridge fee (send-now.ts,
   * closeEconomicsOf). null when any of it can't be read: the keeper then holds the batch too. */
  economics?: CloseEconomics | null;
  /** Read once it can close: whether Bittensor's side can take a batch: "open" (the vault not paused,
   * ForeverMoney's AlphaVault not paused, with no migration announced or finished), "paused" (any of
   * those), or "unchecked" (it couldn't be read). Only "open" lets a batch be sent from here. */
  bittensor?: "open" | "paused" | "unchecked";
}

/** v3.2 (R12d, M2): what a deposit's cancel reads at the click (reads.ts readCancelState): the open batch's id, Base's
 * clock, and the account's deposit and cooldown, from one block; OpenBatch's own fields, so an OpenBatch is one too. */
export type CancelRead = Pick<OpenBatch, "id" | "chainTime"> & { mine: Pick<OpenBatch["mine"], "depositWei" | "cancelableAt"> };

/** v3.2 (R12d, M2): the redeem list as an unstake reads it first (reads.ts readRedeemList): its length, its limit, and the
 * account's own request in it (shares). */
export interface RedeemListRead {
  nRedeems: number;
  maxRedeems: number;
  redeemShares: bigint;
}

/** What closing the open batch earns and costs, as the keeper weighs it, in USDC units (6 decimals):
 * Cascade's fees in the batch (the staker's deposit and swap fees on the deposits it made, and the pot)
 * and the bridge fee. The keeper sends a batch at its interval once the first covers the second. */
export interface CloseEconomics {
  feesUsdc: bigint;
  bridgeFeeUsdc: bigint;
}

export interface CascadeData {
  readonly deployment: Deployment;
  readonly clients: Clients;
  readonly opLog: OpLog;
  /** What this browser remembers of the public display figures between visits (remembered.ts): the yield, the total
   * staked and the TAO price shown as information, each a reading an earlier visit took from the chain. Never a balance,
   * a limit, a quote, nor anything a transaction or a button's state is decided from. */
  readonly figures: FigureStore;
  /** The founder's switches for this deployment, from its entry in deployments.json (config.ts; Task 60): its stage
   * ("retired" shows only the ways out), and whether the site offers USDC delivery (v3.2's switch, spec §5). */
  readonly stage: Stage;
  readonly usdcDelivery: boolean;
  /** v3.2 only: whether the front door holds a USDC delivery preference for the account (its `deliveryOf`), for the
   * prompt to claim while USDC delivery is off. Rejects on any other deployment, and when it can't be read. */
  getDeliveryPreference(account: string): Promise<boolean>;
  getProtocolStats(): Promise<ProtocolStats>;
  /** What one TAO sells for, in dollars (reads.ts taoPriceUsd): one read on Base, nothing from Bittensor. */
  getTaoPrice(): Promise<number>;
  /** The yield in TAO of root staking with the vault's validator over the last 30 days, after its take
   * and Cascade's cut, as a percent. Rejects when there is no figure that can be stood behind. */
  getApy(): Promise<number>;
  getPosition(account: string): Promise<Position>;
  /** v3: the account's share, after Cascade's cut, of the rewards the vault has earned and not yet collected, in TAO.
   * Its own read, for the Rewards page alone: the stake itself (getPosition) never waits on it. Null when it can't be
   * told (unknown, never zero), and on v2, where nothing is read. */
  getPendingRewards(account: string): Promise<number | null>;
  getAvailable(account: string): Promise<Available>;
  getPositionHistory(account: string): Promise<PositionHistory>;
  getProof(): Promise<StakeProof>;
  getLimits(): Promise<Limits>;
  getBalances(account: string): Promise<Balances>;
  listRewards(account: string): Promise<RewardRecord[]>;
  /** Every deposit of the account (a receipt picks its own from this list: hooks.ts, useDeposit). */
  listDeposits(account: string): Promise<DepositRecord[]>;
  /** Every unstake of the account (a receipt picks its own from this list: hooks.ts, useWithdrawal). */
  listWithdrawals(account: string): Promise<WithdrawalRecord[]>;
  quoteDeposit(usdcUnits: bigint): Promise<DepositQuote>;
  quoteWithdrawal(account: string, shares: bigint): Promise<WithdrawalQuote>;
  /** v3.2 only: the live USDC delivery limit for the account (delivery-limit.ts): what of its TAO a USDC unstake would
   * also sell, whether it has a delivery preference set, and the largest sale that clears every floor right now.
   * Rejects on any other deployment, and when any of it can't be read. */
  getDeliveryLimit(account: string): Promise<DeliveryLimit>;
  /** v3.2 only: at the click, why this USDC unstake can't be delivered now (the limit's words), or null when its own
   * sale clears at the minimum it sends (delivery-limit.ts clickRefusal). Rejects when that can't be read. */
  deliveryRefusal(account: string, q: WithdrawalQuote): Promise<string | null>;
  /** The costs of a later unstake of `taoWei`, and Cascade's reward cut. */
  quoteRoundTrip(taoWei: bigint): Promise<RoundTripCosts>;
  /** The open batch, the account's part in it, and once it can close what sending it now costs. */
  getOpenBatch(account: string): Promise<OpenBatch>;
  /** The open batch for anyone: when it started, what waits in it, and Base's clock (one multicall). */
  getNextBatch(): Promise<NextBatch>;
  /** Whether the contracts are wired to each other as the build's config says (wiring.ts); an answer is
   * kept 15 minutes. Rejects when they can't be read right now: nothing may be sent until it resolves "ok". */
  checkWiring(): Promise<"ok" | "mismatch">;
  /** Drops the kept answer, so the next checkWiring reads the chain again (after each flow). */
  forgetWiring(): void;
}

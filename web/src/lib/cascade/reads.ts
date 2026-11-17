import { type Address, encodeAbiParameters, encodePacked, type Hex, parseAbiParameters, parseEventLogs, type PublicClient } from "viem";
import { chainNowMs, freshTip, isRecent } from "./fresh";
import { isFull, SEND_GRACE_S } from "../batch-clock";
import { closeEconomicsOf } from "../send-now";
import {
  ADAPTER,
  ALPHA_VAULT_ABI,
  BASE_CHAIN,
  BIT_ADAPTER_V32,
  DOOR_LENS,
  ERC20,
  FRONT_DOOR_V32,
  frontDoorAbi,
  MULTICALL3_ABI,
  ORACLE_V32,
  QUOTER,
  STAKER,
  STAKER_V32,
  STAKING,
  STAKING_ADDRESS,
  TWAP_ORACLE,
  VAULT,
  VAULT_LENS,
  VAULT_V32,
} from "./abi";
import { APY_WINDOW_S, basketTwrKey, decodeTwr, netApyPercent, STORAGE_QUERY } from "./apy";
import { BLOCK_SPAN, blockMsOf, blocksIn } from "./blocktime";
import type { Clients } from "./chain";
import { ALPHA_VAULT, type Deployment, FEE_CHECK_BPS, isV3, isV32, MULTICALL3, PATH_TAO_TO_USDC, PATH_USDC_TO_TAO, TOKENS, UNISWAP } from "./config";
import { type DeliveryMarket, deliveryFloorPerTao, type SaleQuoteAt } from "./delivery-limit";
import type { CancelRead, NextBatch, OpenBatch, RedeemListRead } from "./types";
import { contractRefused } from "./wiring";
import { RAO, toDisplay } from "./units";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** v3.2's vault lens, which serves the getters that moved off the vault (spec §8.1). The share token
 * (balanceOf, totalSupply) and `paused` stay on the vault. */
const vaultLensOf = (d: Deployment) => ({ address: d.vaultLens as Address, abi: VAULT_LENS }) as const;

/** The vault's stake hotkey: on v3.2 its lens's, else the vault's own. */
const readStakeHotkey = (client: Pick<PublicClient, "readContract">, d: Deployment): Promise<Hex> =>
  isV32(d)
    ? client.readContract({ ...vaultLensOf(d), functionName: "stakeHotkey" })
    : client.readContract({ address: d.vault, abi: VAULT, functionName: "stakeHotkey" });

export interface FrontDoorState {
  depositOf: bigint;
  redeemOf: bigint;
  claimable: bigint;
  openBatchId: bigint;
  /** When the open batch started (unix seconds): it can close `batchInterval` later. */
  openStart: number;
  openTotal: bigint;
  openDeposits: number;
  openRedeems: number;
  netForwarded: bigint;
  depositCap: bigint;
  minDeposit: bigint;
  redeemRequestFee: bigint;
  canClose: boolean;
  batchInterval: number;
  /** The most one batch carries, in TAO wei, and how many deposits its list holds. */
  maxBatchValue: bigint;
  maxDeposits: number;
  /** v3.2 (R11): the first second (Base's clock, unix) the account's cancel works: five minutes after the last deposit
   * to its entry, whoever made it (`cancelableAt`); 0 means no wait (build B: the door paused or its primary disabled).
   * Read in the same multicall as `depositOf`. Absent on v3-launch, which has no cooldown. */
  cancelableAt?: number;
  /** v3.2 (R12d, M1): with `cancelableAt`, the clock it was read on: Base's (`chainTime`, the block's own timestamp,
   * getCurrentBlockTimestamp in the same multicall) and this device's when the read landed (`readAt`, ms). The receipt
   * counts the cancel's wait on Base's clock from them (batch-clock.ts chainNow), so a device clock minutes off neither
   * holds the button past the cooldown nor offers it early. */
  cancelClock?: { chainTime: number; readAt: number };
}

export async function readFrontDoor(c: Pick<Clients, "base">, d: Deployment, account: Address = ZERO): Promise<FrontDoorState> {
  const v32 = isV32(d);
  const fd = { address: d.frontDoor, abi: frontDoorAbi(d) } as const;
  const out = (await c.base.multicall({
    allowFailure: false,
    contracts: [
      { ...fd, functionName: "depositOf", args: [account] },
      { ...fd, functionName: "redeemOf", args: [account] },
      { ...fd, functionName: "claimable", args: [account] },
      { ...fd, functionName: "openBatch" },
      { ...fd, functionName: "netForwarded" },
      { ...fd, functionName: "depositCap" },
      { ...fd, functionName: "minDeposit" },
      { ...fd, functionName: "redeemRequestFee" },
      { ...fd, functionName: "canClose" },
      { ...fd, functionName: "batchInterval" },
      { ...fd, functionName: "maxBatchValue" },
      { ...fd, functionName: "maxDeposits" },
      // R11: the account's cancel cooldown, from the same block as its deposit; R12d (M1): and that block's time, the clock
      // the receipt counts the wait on
      ...(v32
        ? ([
            { address: MULTICALL3, abi: MULTICALL3_ABI, functionName: "getCurrentBlockTimestamp" },
            { address: d.frontDoor, abi: FRONT_DOOR_V32, functionName: "cancelableAt", args: [account] },
          ] as const)
        : []),
    ] as never,
  })) as unknown[];
  const readAt = Date.now();
  const [depositOf, redeemOf, claimable, open, netForwarded, depositCap, minDeposit, redeemRequestFee, canClose, interval, maxBatchValue, maxDeposits, time, cancelableAt] = out as [
    bigint,
    bigint,
    bigint,
    readonly [bigint, bigint, bigint, bigint, bigint, bigint],
    bigint,
    bigint,
    bigint,
    bigint,
    boolean,
    bigint | number,
    bigint,
    number,
    bigint | undefined,
    bigint | undefined,
  ];
  const [id, start, total, , nDeposits, nRedeems] = open;
  return {
    depositOf,
    redeemOf,
    claimable,
    openBatchId: id,
    openStart: Number(start),
    openTotal: total,
    openDeposits: Number(nDeposits),
    openRedeems: Number(nRedeems),
    netForwarded,
    depositCap,
    minDeposit,
    redeemRequestFee,
    canClose,
    batchInterval: Number(interval),
    maxBatchValue,
    maxDeposits,
    ...(v32 && cancelableAt !== undefined ? { cancelableAt: Number(cancelableAt) } : {}),
    ...(v32 && cancelableAt !== undefined && time !== undefined ? { cancelClock: { chainTime: Number(time), readAt } } : {}),
  };
}

/** v3.2 (R12d, M2): what a deposit's cancel checks at the click (flows.ts planCancelDeposit), and nothing more: the open
 * batch's id, the account's deposit in it and its cooldown, and Base's clock, in one multicall (one block). The open
 * batch's whole read (readOpenBatch) waits on fee quotes from two RPCs, prices, a log scan and Bittensor, none of which
 * a cancel uses. Shaped as OpenBatch's own fields. */
export async function readCancelState(c: Pick<Clients, "base">, d: Deployment, account: Address): Promise<CancelRead> {
  const out = (await c.base.multicall({
    allowFailure: false,
    contracts: [
      { address: d.frontDoor, abi: FRONT_DOOR_V32, functionName: "openBatch" },
      { address: d.frontDoor, abi: FRONT_DOOR_V32, functionName: "depositOf", args: [account] },
      { address: MULTICALL3, abi: MULTICALL3_ABI, functionName: "getCurrentBlockTimestamp" },
      { address: d.frontDoor, abi: FRONT_DOOR_V32, functionName: "cancelableAt", args: [account] },
    ],
  })) as unknown[];
  const [open, depositWei, time, cancelableAt] = out as [readonly [bigint, ...unknown[]], bigint, bigint, bigint];
  return { id: open[0], chainTime: Number(time), mine: { depositWei, cancelableAt: Number(cancelableAt) } };
}

/** v3.2 (R12d, M2): the redeem list as an unstake checks it first (flows.ts assertRedeemListOpen): its length, its limit
 * and the account's own request, in one multicall. Only a full list with none of the account's in it needs the batch's
 * bridge fee, the slow part of the open batch's read. */
export async function readRedeemList(c: Pick<Clients, "base">, d: Deployment, account: Address): Promise<RedeemListRead> {
  const out = (await c.base.multicall({
    allowFailure: false,
    contracts: [
      { address: d.frontDoor, abi: FRONT_DOOR_V32, functionName: "openBatch" },
      { address: d.frontDoor, abi: FRONT_DOOR_V32, functionName: "maxRedeems" },
      { address: d.frontDoor, abi: FRONT_DOOR_V32, functionName: "redeemOf", args: [account] },
    ],
  })) as unknown[];
  const [open, maxRedeems, redeemShares] = out as [readonly [bigint, bigint, bigint, bigint, bigint, bigint], number, bigint];
  return { nRedeems: Number(open[5]), maxRedeems: Number(maxRedeems), redeemShares };
}

export interface VaultState {
  shares: bigint;
  totalAssets: bigint;
  totalSupply: bigint;
  rootStakeWei: bigint;
  pendingPayouts: bigint;
  /** The vault's liquid TAO (Bittensor reads it 500 rao below what it holds), as Multicall3's getEthBalance gives it in
   * the same call as the figures above. */
  balanceWei: bigint;
  stakeHotkey: Hex;
  payoutDelay: number;
  nominatorMinWei: bigint;
  /** v3: the most TAO one front-door unstake request can carry (the vault burns no more of it per
   * delivery; the rest stays staked). Absent on v2. */
  maxEntryValue?: bigint;
  /** v3.2 only, from its lens: whether stake is missing (the vault refuses every delivery and direct exit until it
   * is reconnected, spec §3.1), and the account's redeem origin (0, a chain id, or DIRECT_ORIGIN, spec §3.4). */
  stakeMissing?: boolean;
  redeemOrigin?: bigint;
}

/** v3.2: the account holds shares a Base door won't burn: its redeem origin isn't Base's (DIRECT_ORIGIN, another
 * chain's, or none yet, the reward cut's), so the vault skips a request of them (RedeemSkipped, CascadeBatchLib
 * `origin[user] != chain`). False while the origin isn't known, as on v3-launch, which has none. */
export const originElsewhere = (v: Pick<VaultState, "shares" | "redeemOrigin">): boolean => v.redeemOrigin !== undefined && v.redeemOrigin !== BASE_CHAIN && v.shares > 0n;

/** v3.2 (R6, ChatGPT R2 claim B): a Base deposit into the account leaves only on Bittensor: its redeem origin is already
 * set, and not to Base (DIRECT_ORIGIN, or another chain's door), shares or none. An origin of 0 isn't: the deposit makes
 * it Base's. */
export const depositLeavesElsewhere = (v: Pick<VaultState, "redeemOrigin">): boolean => v.redeemOrigin !== undefined && v.redeemOrigin !== 0n && v.redeemOrigin !== BASE_CHAIN;

/** The account's csTAO as of `block` (the vault's balanceOf then, from the archive node): what the
 * account's Deposited and Redeemed up to that block must add up to (live.ts, the seed's tripwire). */
export async function readSharesAt(c: Pick<Clients, "bittensor">, d: Deployment, account: Address, block: bigint): Promise<bigint> {
  return (await c.bittensor.readContract({ address: d.vault, abi: VAULT, functionName: "balanceOf", args: [account], blockNumber: block })) as bigint;
}

/** The vault's figures as one multicall read them, and the block it read them all at: Multicall3's own getBlockNumber,
 * asked first and last in the same multicall; null if the two differ (the calls didn't all run in one block, so no one
 * block can be claimed for them). */
interface VaultRead {
  state: VaultState;
  block: bigint | null;
}

/** What every vault multicall asks of Multicall3 itself, beside the vault's own figures: the block it is answered at
 * (`blockOf`, put first and last in the list), and the vault's liquid TAO. The balance is Multicall3's getEthBalance,
 * the read the site made before in a call of its own: on a client that batches through Multicall3, as the site's
 * Bittensor client does (chain.ts), viem's getBalance asks exactly this function, never eth_getBalance (chain.test.ts
 * pins it). In the same call, it costs no round trip. */
const blockOf = { address: MULTICALL3, abi: MULTICALL3_ABI, functionName: "getBlockNumber" } as const;
const liquidOf = (d: Deployment) => ({ address: MULTICALL3, abi: MULTICALL3_ABI, functionName: "getEthBalance", args: [d.vault] }) as const;

/** How a vault multicall is sent: as one call, whatever its size (viem otherwise splits a batch over 1,024 bytes into
 * several calls, which, read at the newest block, could be answered at different blocks), and failing as a whole. */
const AS_ONE = { allowFailure: false, batchSize: 0 } as const;

/** The vault's state for `account`, in one round trip's wait when it can be: the newest block's header and the vault's
 * figures are asked at the same time, the figures naming the one block they were all read at. They stand when that
 * header is recent (fresh.ts: no older than five minutes by Base's clock) and the figures are from its block or a later
 * one: at least as new as a block known to be recent. Otherwise as before, in two more round trips: a tip known to be
 * recent (freshTip asks again: another server may answer), then the figures pinned to it, so a server that is behind
 * errors instead of answering from the past. Either way an old picture of the chain is never returned as the present. */
export async function readVault(c: Pick<Clients, "bittensor"> & Partial<Pick<Clients, "base">>, d: Deployment, account: Address = ZERO): Promise<VaultState> {
  const read = (blockNumber?: bigint) => (isV32(d) ? readVaultV32(c, d, account, blockNumber) : readVaultV3(c, d, account, blockNumber));
  const [first, tip, nowMs] = await Promise.all([read(), c.bittensor.getBlock({ blockTag: "latest" }), chainNowMs(c)]);
  if (first.block !== null && first.block >= tip.number && isRecent(tip, nowMs)) return first.state;
  return (await read(await freshTip(c, nowMs))).state;
}

/** v3-launch's vault (and v2's): every getter on the vault itself, with its balance, in one multicall, at `blockNumber`
 * when given, else the newest block. */
async function readVaultV3(c: Pick<Clients, "bittensor">, d: Deployment, account: Address, blockNumber?: bigint): Promise<VaultRead> {
  const v = { address: d.vault, abi: VAULT } as const;
  const v3 = isV3(d);
  const [block, balanceWei, shares, totalAssets, totalSupply, rootStakeRao, pendingPayouts, stakeHotkey, payoutDelay, nominatorMin, maxEntryValue, blockAfter] =
    await c.bittensor.multicall({
      ...(blockNumber !== undefined ? { blockNumber } : {}),
      ...AS_ONE,
      contracts: [
        blockOf,
        liquidOf(d),
        { ...v, functionName: "balanceOf", args: [account] },
        { ...v, functionName: "totalAssets" },
        { ...v, functionName: "totalSupply" },
        { ...v, functionName: "rootStakeRao" },
        { ...v, functionName: "pendingPayouts" },
        { ...v, functionName: "stakeHotkey" },
        { ...v, functionName: "payoutDelay" },
        { address: STAKING_ADDRESS, abi: STAKING, functionName: "getNominatorMinRequiredStake" },
        // v2's vault has no per-unstake limit to ask about
        v3 ? { ...v, functionName: "maxEntryValue" } : { ...v, functionName: "totalSupply" },
        blockOf,
      ],
    });
  return {
    block: block === blockAfter ? block : null,
    state: {
      ...(v3 ? { maxEntryValue } : {}),
      shares,
      totalAssets,
      totalSupply,
      rootStakeWei: rootStakeRao * RAO,
      pendingPayouts,
      balanceWei,
      stakeHotkey,
      payoutDelay: Number(payoutDelay),
      nominatorMinWei: nominatorMin * RAO,
    },
  };
}

export interface PendingRewards {
  /** Root dividends the whole vault has earned and not yet collected (wei). */
  wei: bigint;
  /** The share Cascade keeps, in basis points (0 on v2, which has no cut). */
  cutBps: number;
}

/** v3.2's vault: the share token on the vault, everything else on its lens, in the same multicall, with the vault's
 * balance (at `blockNumber` when given, else the newest block). The stake is
 * priced as the vault prices it (CascadeFormulas.pricedStakeRao): the smaller of the stake the chain shows on the
 * listed hotkeys (`visibleStakeRao`) and the stake the vault booked (`bookedStake`), both in rao. Read in the same
 * block: whether stake is missing (the lens's `stakeMissing()`, the vault's own guard) and the account's redeem
 * origin, which say whether an unstake request can go now (Task 59). */
async function readVaultV32(c: Pick<Clients, "bittensor">, d: Deployment, account: Address, blockNumber?: bigint): Promise<VaultRead> {
  const v = { address: d.vault, abi: VAULT_V32 } as const;
  const lens = { address: d.vaultLens as Address, abi: VAULT_LENS } as const;
  const [block, balanceWei, shares, totalSupply, totalAssets, visibleRao, bookedRao, pendingPayouts, stakeHotkey, payoutDelay, maxEntryValue, stakeMissing, redeemOrigin, nominatorMin, blockAfter] =
    await c.bittensor.multicall({
      ...(blockNumber !== undefined ? { blockNumber } : {}),
      ...AS_ONE,
      contracts: [
        blockOf,
        liquidOf(d),
        { ...v, functionName: "balanceOf", args: [account] },
        { ...v, functionName: "totalSupply" },
        { ...lens, functionName: "totalAssets" },
        { ...lens, functionName: "visibleStakeRao" },
        { ...lens, functionName: "bookedStake" },
        { ...lens, functionName: "pendingPayouts" },
        { ...lens, functionName: "stakeHotkey" },
        { ...lens, functionName: "payoutDelay" },
        { ...lens, functionName: "maxEntryValue" },
        { ...lens, functionName: "stakeMissing" },
        { ...lens, functionName: "redeemOrigin", args: [account] },
        { address: STAKING_ADDRESS, abi: STAKING, functionName: "getNominatorMinRequiredStake" },
        blockOf,
      ],
    });
  return {
    block: block === blockAfter ? block : null,
    state: {
      maxEntryValue,
      shares,
      totalAssets,
      totalSupply,
      rootStakeWei: (visibleRao < bookedRao ? visibleRao : bookedRao) * RAO,
      pendingPayouts,
      balanceWei,
      stakeHotkey,
      payoutDelay: Number(payoutDelay),
      nominatorMinWei: nominatorMin * RAO,
      stakeMissing,
      redeemOrigin,
    },
  };
}

/** v3.2: the account's redeem origin as of `block` (the vault lens's `redeemOrigin`, from the archive node, as
 * readSharesAt reads a past balance): what a delivery in that block went by. */
export async function readRedeemOriginAt(c: Pick<Clients, "bittensor">, d: Deployment, account: Address, block: bigint): Promise<bigint> {
  return (await c.bittensor.readContract({ ...vaultLensOf(d), functionName: "redeemOrigin", args: [account], blockNumber: block })) as bigint;
}

/** The most hotkeys v3.2's vault lists (CascadeConstants.MAX_HOTKEYS): a count above it is no reading to stand behind. */
const MAX_HOTKEYS = 4n;

/** What the vault has earned but not collected yet; undefined when any read fails (unknown, not zero). On v3.2 the
 * vault holds stake on every listed hotkey (the stake hotkey and a standby, MAX_HOTKEYS at most), and each earns, so
 * what waits is their sum (Task 58's concern 3); v3-launch lists one, `stakeHotkey`. */
export async function readPendingRewards(
  c: Pick<Clients, "bittensor">,
  d: Deployment,
  stakeHotkey: Hex,
): Promise<PendingRewards | undefined> {
  const v = { address: d.vault, abi: VAULT } as const;
  try {
    if (isV32(d)) {
      const lens = vaultLensOf(d);
      const [coldkey, cut, count] = await c.bittensor.multicall({
        allowFailure: false,
        contracts: [
          { ...lens, functionName: "coldkey" },
          { ...lens, functionName: "rewardCutBps" },
          { ...lens, functionName: "hotkeyCount" },
        ],
      });
      if (count > MAX_HOTKEYS) return undefined;
      if (count === 0n) return { wei: 0n, cutBps: Number(cut) };
      const listed = await c.bittensor.multicall({
        allowFailure: false,
        contracts: Array.from({ length: Number(count) }, (_, i) => ({ ...lens, functionName: "hotkeys" as const, args: [BigInt(i)] as const })),
      });
      const waiting = await c.bittensor.multicall({
        allowFailure: false,
        contracts: listed.map((hotkey) => ({ address: STAKING_ADDRESS, abi: STAKING, functionName: "getUnclaimedRootTaoByHotkey" as const, args: [coldkey, hotkey] as const })),
      });
      return { wei: waiting.reduce((sum, w) => sum + w, 0n), cutBps: Number(cut) };
    }
    const [coldkey, cut] = await c.bittensor.multicall({
      allowFailure: false,
      contracts: [
        { ...v, functionName: "coldkey" },
        // v2 has no cut, so there is nothing to ask
        isV3(d) ? { ...v, functionName: "rewardCutBps" } : { ...v, functionName: "totalSupply" },
      ],
    });
    const wei = await c.bittensor.readContract({
      address: STAKING_ADDRESS,
      abi: STAKING,
      functionName: "getUnclaimedRootTaoByHotkey",
      args: [coldkey as Hex, stakeHotkey],
    });
    return { wei, cutBps: isV3(d) ? Number(cut) : 0 };
  } catch {
    return undefined;
  }
}

export interface WalletState {
  usdc: bigint;
  tao: bigint;
  eth: bigint;
  usdcRouterAllowance: bigint;
  /** v3: USDC the staker may take (zero on v2, which has no staker). */
  usdcStakerAllowance: bigint;
  taoRouterAllowance: bigint;
  taoFrontDoorAllowance: bigint;
}

export async function readWallet(c: Pick<Clients, "base">, d: Deployment, account: Address): Promise<WalletState> {
  const usdc = { address: TOKENS.usdc, abi: ERC20 } as const;
  const tao = { address: TOKENS.tao, abi: ERC20 } as const;
  const [[usdcBal, taoBal, usdcRouter, taoRouter, taoFrontDoor], [usdcStaker]] = await Promise.all([
    c.base.multicall({
      allowFailure: false,
      contracts: [
        { ...usdc, functionName: "balanceOf", args: [account] },
        { ...tao, functionName: "balanceOf", args: [account] },
        { ...usdc, functionName: "allowance", args: [account, UNISWAP.router] },
        { ...tao, functionName: "allowance", args: [account, UNISWAP.router] },
        { ...tao, functionName: "allowance", args: [account, d.frontDoor] },
      ],
    }),
    // v2 has no staker to ask about
    d.staker
      ? c.base.multicall({ allowFailure: false, contracts: [{ ...usdc, functionName: "allowance", args: [account, d.staker] }] })
      : Promise.resolve([0n] as const),
  ]);
  return {
    usdc: usdcBal,
    tao: taoBal,
    eth: await c.base.getBalance({ address: account }),
    usdcRouterAllowance: usdcRouter,
    usdcStakerAllowance: usdcStaker,
    taoRouterAllowance: taoRouter,
    taoFrontDoorAllowance: taoFrontDoor,
  };
}

/** USDC's permit nonce for `account`: the next permit it signs must carry it. */
export async function readPermitNonce(c: Pick<Clients, "base">, account: Address): Promise<bigint> {
  return (await c.base.readContract({ address: TOKENS.usdc, abi: ERC20, functionName: "nonces", args: [account] })) as bigint;
}

async function quote(
  c: Pick<Clients, "base">,
  functionName: "quoteExactInput" | "quoteExactOutput",
  path: Hex,
  amount: bigint,
): Promise<bigint> {
  const out = (await c.base.readContract({ address: UNISWAP.quoter, abi: QUOTER, functionName, args: [path, amount] })) as readonly [
    bigint,
    ...unknown[],
  ];
  return out[0];
}

/** TAO bought for `usdcUnits` (pool fees included). */
export const quoteBuy = (c: Pick<Clients, "base">, usdcUnits: bigint) => quote(c, "quoteExactInput", PATH_USDC_TO_TAO, usdcUnits);
/** USDC needed to buy exactly `taoWei`. */
export const quoteBuyExact = (c: Pick<Clients, "base">, taoWei: bigint) => quote(c, "quoteExactOutput", PATH_TAO_TO_USDC, taoWei);
/** USDC paid for selling `taoWei`. */
export const quoteSell = (c: Pick<Clients, "base">, taoWei: bigint) => quote(c, "quoteExactInput", PATH_TAO_TO_USDC, taoWei);

/** What selling 0.01 TAO pays, per TAO, in dollars: the price a user actually gets. */
export async function taoPriceUsd(c: Pick<Clients, "base">): Promise<number> {
  return toDisplay((await quoteSell(c, 10n ** 16n)) * 100n, 6);
}

/** The oracle's price of one TAO, in USDC units: the 30-minute TWAP of Cascade's own CascadeTwapOracle
 * (`usdcValue(1e18)`), for the check every stake makes of the quote it is priced from (flows.ts,
 * assertPriceAgrees). It is read on the second Base RPC (`baseCheck`: the other one the CSP allows, on
 * a connection that gives up in seconds), so the quote and what it is checked against come from
 * different servers as well as different sources; when that one can't answer, on the first, where the
 * TWAP contract's answer still stands apart from the quoter's. Rejects when neither answers (nothing
 * is then sent), and for a deployment without an oracle (v2). */
export async function readOraclePrice(c: Pick<Clients, "base" | "baseCheck">, d: Deployment): Promise<bigint> {
  const oracle = d.oracle;
  if (!oracle) throw new Error("This deployment has no price oracle (v2), so a quote can't be checked against one");
  const read = (client: Pick<PublicClient, "readContract">) =>
    client.readContract({ address: oracle, abi: TWAP_ORACLE, functionName: "usdcValue", args: [10n ** 18n] }) as Promise<bigint>;
  try {
    return await read(c.baseCheck);
  } catch {
    return read(c.base);
  }
}

/** What 0.001 ETH sells for, per ETH, in dollars (WETH –0.05%→ USDC). */
export async function ethPriceUsd(c: Pick<Clients, "base">): Promise<number> {
  const path = encodePacked(["address", "uint24", "address"], [TOKENS.weth, 500, TOKENS.usdc]);
  return toDisplay((await quote(c, "quoteExactInput", path, 10n ** 15n)) * 1000n, 6);
}

/** The bridge fee the vault would pay to send `taoWei` back to Base for `account` (one payout entry).
 * The adapter's own quote, which also refuses an amount below the bridge floor. */
export async function quotePayoutFee(c: Pick<Clients, "bittensor">, d: Deployment, account: Address, taoWei: bigint): Promise<bigint> {
  const message = encodeAbiParameters(parseAbiParameters("uint8, bytes32, uint32, (address user, uint256 amount)[]"), [
    2,
    `0x${"00".repeat(32)}`,
    0,
    [{ user: account, amount: taoWei }],
  ]);
  return (await c.bittensor.readContract({
    address: d.bitAdapter,
    abi: ADAPTER,
    functionName: "quoteFee",
    args: [8453n, d.frontDoor, message, taoWei],
    account: d.vault,
  })) as bigint;
}

/** One entry of a batch's deposit or redeem list (CascadeMessages.Entry). */
export interface BatchEntry {
  user: Address;
  amount: bigint;
}

/** The chain id the front door's batches go to: the vault's, Bittensor's (wiring.ts checks vaultChain). */
const VAULT_CHAIN = 964n;

/** CascadeMessages.encodeBatch: abi.encode(uint8 BATCH = 1, uint64 batchId, Entry[] deposits, Entry[] redeems). */
export const encodeBatch = (id: bigint, deposits: readonly BatchEntry[], redeems: readonly BatchEntry[]): Hex =>
  encodeAbiParameters(
    parseAbiParameters("uint8 kind, uint64 batchId, (address user, uint256 amount)[] deposits, (address user, uint256 amount)[] redeems"),
    [1, id, deposits, redeems],
  );

/** The gas allowed for closeBatch when checking a wallet can pay for it: about 700,000 measured on Base
 * with one entry (most of it the bridge's), with room for a full batch. Only the balance check uses it;
 * the wallet estimates the real figure. */
export const CLOSE_GAS = 1_500_000n;

/** The bridge fee closeBatch would pay to send the open batch now: the front door's primary bridge
 * (wiring.ts checks it is the deployment's adapter) quotes the batch's exact message for the vault on
 * Bittensor, asked from the front door, as closeBatch asks it inside (the adapter's message names its
 * sender). */
export async function quoteCloseFee(
  c: Pick<Clients, "base">,
  d: Deployment,
  b: { id: bigint; deposits: readonly BatchEntry[]; redeems: readonly BatchEntry[]; totalDeposits: bigint },
): Promise<bigint> {
  return (await c.base.readContract({
    address: d.baseAdapter,
    abi: ADAPTER,
    functionName: "quoteFee",
    args: [VAULT_CHAIN, d.vault, encodeBatch(b.id, b.deposits, b.redeems), b.totalDeposits],
    account: d.frontDoor,
  })) as bigint;
}

const settled = <T>(r: PromiseSettledResult<T>): T | undefined => (r.status === "fulfilled" ? r.value : undefined);

/** Whether two quotes of the bridge fee agree: within FEE_CHECK_BPS of the larger. */
export function feesAgree(a: bigint, b: bigint, bps: bigint = FEE_CHECK_BPS): boolean {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return (hi - lo) * 10_000n <= hi * bps;
}

/** The open batch for anyone, in one multicall on Base: when it started, its interval, whether it can
 * close, whether Cascade is paused, how many deposits and unstake requests wait in it, and the time of
 * the block all of that was read at (Multicall3's own clock, so a countdown runs on Base's clock). */
export async function readNextBatch(c: Pick<Clients, "base">, d: Deployment): Promise<NextBatch> {
  const fd = { address: d.frontDoor, abi: frontDoorAbi(d) } as const;
  const [open, canClose, interval, paused, time] = await c.base.multicall({
    allowFailure: false,
    contracts: [
      { ...fd, functionName: "openBatch" },
      { ...fd, functionName: "canClose" },
      { ...fd, functionName: "batchInterval" },
      { ...fd, functionName: "paused" },
      { address: MULTICALL3, abi: MULTICALL3_ABI, functionName: "getCurrentBlockTimestamp" },
    ],
  });
  const [id, start, , , nDeposits, nRedeems] = open as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  return {
    id,
    start: Number(start),
    interval: Number(interval),
    canClose,
    paused,
    // v3.2's pause stops new deposits only: its batch still leaves (spec §3.5, I-20)
    ...(isV32(d) ? { closesWhilePaused: true as const } : {}),
    deposits: Number(nDeposits),
    redeems: Number(nRedeems),
    chainTime: Number(time),
  };
}

/** v3.2: whether USDC delivery waits for the market (spec §3.7, I-31): the front door's `deliver` refuses
 * `ThinPool` while either pool's 30-minute harmonic-mean in-range liquidity (the oracle's `meanLiquidity`) is under
 * its floor (`minPoolLiquidity`, [0] TAO/WETH, [1] WETH/USDC; a floor of 0 checks nothing). One multicall on Base;
 * rejects when it can't be read, and for a deployment without an oracle. */
export async function readThinPool(c: Pick<Clients, "base">, d: Deployment): Promise<boolean> {
  if (!d.oracle) throw new Error("This deployment has no price oracle, so its pools' depth can't be read");
  const fd = { address: d.frontDoor, abi: FRONT_DOOR_V32 } as const;
  const [[taoWeth, wethUsdc], floor0, floor1] = await c.base.multicall({
    allowFailure: false,
    contracts: [
      { address: d.oracle, abi: ORACLE_V32, functionName: "meanLiquidity" },
      { ...fd, functionName: "minPoolLiquidity", args: [0n] },
      { ...fd, functionName: "minPoolLiquidity", args: [1n] },
    ],
  });
  return taoWeth < floor0 || wethUsdc < floor1;
}

/** The staker's RouterKind.UniswapV3 (CascadeStaker.RouterKind): the only route kind Uniswap's quoter can price, as the
 * keeper quotes it (ops/src/keeper/state.ts); on any other the keeper waits, so nothing is delivered. */
const UNISWAP_V3_ROUTE = 0;

/** v3.2: what a USDC delivery meets now, apart from its size (delivery-limit.ts), every figure from the contracts and
 * all of it at one block (the latest when read: Task 59a review, M3): whether either pool's 30-minute mean liquidity
 * (the oracle's `meanLiquidity`) is under its floor (the front door's `minPoolLiquidity`: deliver refuses ThinPool; one
 * at its floor passes, a floor of 0 checks nothing), the front door's `maxDeliverySlippageBps`, the staker's
 * `swapFeeBps`, the staker's live delivery route (`routes[deliveryRouteId]`, which sellFor sells along: M2) and, along
 * it, what 1 TAO sells for, for the user's floor a USDC request sets now (deliveryFloorPerTao). A route that is off, or
 * isn't Uniswap v3 (which the quoter can't price, and the keeper waits on), can't deliver: no path, and no floor read.
 * Rejects when any of it can't be read, and for a deployment without a staker and an oracle. */
export async function readDeliveryMarket(c: Pick<Clients, "base">, d: Deployment): Promise<DeliveryMarket> {
  if (!d.oracle || !d.staker) throw new Error("This deployment has no oracle or staker, so it delivers no USDC");
  const blockNumber = await c.base.getBlockNumber();
  const fd = { address: d.frontDoor, abi: FRONT_DOOR_V32 } as const;
  const staker = { address: d.staker, abi: STAKER_V32 } as const;
  const [[taoWeth, wethUsdc], floor0, floor1, slippage, swapFeeBps, routeId] = await c.base.multicall({
    allowFailure: false,
    blockNumber,
    contracts: [
      { address: d.oracle, abi: ORACLE_V32, functionName: "meanLiquidity" },
      { ...fd, functionName: "minPoolLiquidity", args: [0n] },
      { ...fd, functionName: "minPoolLiquidity", args: [1n] },
      { ...fd, functionName: "maxDeliverySlippageBps" },
      { ...staker, functionName: "swapFeeBps" },
      { ...staker, functionName: "deliveryRouteId" },
    ],
  });
  const [kind, , , sellPath, active] = (await c.base.readContract({ ...staker, functionName: "routes", args: [routeId], blockNumber })) as readonly [
    number,
    Address,
    Hex,
    Hex,
    boolean,
  ];
  const market = { thin: taoWeth < floor0 || wethUsdc < floor1, slippageBps: BigInt(slippage), swapFeeBps: BigInt(swapFeeBps), blockNumber };
  if (!active || Number(kind) !== UNISWAP_V3_ROUTE) return { ...market, minUsdcPerTao: 0n, sellPath: null };
  const [oneTao] = (await c.base.readContract({ address: UNISWAP.quoter, abi: QUOTER, functionName: "quoteExactInput", args: [sellPath, 10n ** 18n], blockNumber })) as readonly [
    bigint,
    ...unknown[],
  ];
  return { ...market, minUsdcPerTao: deliveryFloorPerTao(oneTao, BigInt(swapFeeBps)), sellPath };
}

/** v3.2's reward vesting, in seconds, as the vault lens reads it: the owner's period (`rewardVestingS`, rewardVesting:
 * 1 to 30 days, what the next restart of either drip takes), the running claim schedule's (`vestingPeriodS`,
 * vestingPeriod: the owner's, or what was left of the old schedule when that was longer; 0 before the first claim), and
 * the adoption drip's (`adoptVestingPeriodS`, adoptVestingPeriod: Revision 27, an adopted gift vesting on its own drip,
 * never restarting the claim schedule) while it still has something to add at the chain's time: its amount above 0 and
 * its end (adoptVestingStart + adoptVestingPeriod) still ahead; 0 once it has ended, before the first adoption, or when
 * a write-down at a supply of 0 set it with nothing in it. */
export interface RewardVesting {
  rewardVestingS: number;
  vestingPeriodS: number;
  adoptVestingPeriodS: number;
}

/** v3.2: the reward vesting periods (RewardVesting), in one multicall on the lens with the chain's time, for the FAQ's
 * answers (Task 58 concern 5; Task 60; its review, Minor 4, and Revision 27: the leaving answer says the longest of the
 * three). v3-launch's is a constant in its vault (7 days, faq.ts FAQ_FACTS), never read. */
export async function readRewardVesting(c: Pick<Clients, "bittensor">, d: Deployment): Promise<RewardVesting> {
  if (!isV32(d) || !d.vaultLens) throw new Error("Only a v3.2 vault's reward vesting is the owner's, read through its lens");
  const lens = d.vaultLens;
  const [reward, running, adoptAmount, adoptStart, adoptPeriod, time] = (await c.bittensor.multicall({
    allowFailure: false,
    contracts: [
      { address: lens, abi: VAULT_LENS, functionName: "rewardVesting" },
      { address: lens, abi: VAULT_LENS, functionName: "vestingPeriod" },
      { address: lens, abi: VAULT_LENS, functionName: "adoptVestingAmount" },
      { address: lens, abi: VAULT_LENS, functionName: "adoptVestingStart" },
      { address: lens, abi: VAULT_LENS, functionName: "adoptVestingPeriod" },
      { address: MULTICALL3, abi: MULTICALL3_ABI, functionName: "getCurrentBlockTimestamp" },
    ],
  })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  // CascadeFormulas.unvestedRewards: a drip has nothing left once its period has passed since its start
  const adopting = adoptAmount > 0n && adoptStart + adoptPeriod > time;
  return { rewardVestingS: Number(reward), vestingPeriodS: Number(running), adoptVestingPeriodS: adopting ? Number(adoptPeriod) : 0 };
}

/** v3.2: whether the front door holds a USDC delivery preference for `account` (`deliveryOf`: a floor set; receiving
 * TAO clears it, and with it the delivery of everything of the account's still waiting: Task 59a review, I1). Rejects
 * when it can't be read. */
export async function readDeliveryPreference(c: Pick<Clients, "base">, d: Deployment, account: Address): Promise<boolean> {
  const [minUsdcPerTao] = (await c.base.readContract({ address: d.frontDoor, abi: FRONT_DOOR_V32, functionName: "deliveryOf", args: [account] })) as readonly [
    bigint,
    bigint,
    number,
  ];
  return minUsdcPerTao !== 0n;
}

/** v3.2: each of `sizes` (TAO wei) as a delivery would sell it now, in one multicall on Base at the market's block
 * (`at.blockNumber`): what it pays along the staker's delivery route (`at.sellPath`, Uniswap's quoter, as the keeper
 * quotes it) before the staker's fee, and the front door's oracle's 30-minute value of it (`usdcValue`, deliver's market
 * floor before the slippage allowance). A call the contract refused (a revert: a size the pools can't take, an oracle
 * whose history is short) leaves that figure unknown, so its sale doesn't clear; any other failure (the RPC's rate
 * limit, a timeout) rejects, so the limit reads as unreadable, never as "no delivery" (Task 59a review, M1). Along no
 * route, nothing is asked and every figure is unknown. */
export async function quoteDeliveries(
  c: Pick<Clients, "base">,
  d: Deployment,
  sizes: readonly bigint[],
  at: Pick<DeliveryMarket, "sellPath" | "blockNumber">,
): Promise<SaleQuoteAt[]> {
  if (!d.oracle) throw new Error("This deployment has no oracle, so it delivers no USDC");
  const oracle = d.oracle;
  const path = at.sellPath;
  if (path === null) return sizes.map((taoWei) => ({ taoWei, grossUsdc: undefined, twapUsdc: undefined }));
  const results = await c.base.multicall({
    allowFailure: true,
    blockNumber: at.blockNumber,
    contracts: sizes.flatMap((s) => [
      { address: UNISWAP.quoter, abi: QUOTER, functionName: "quoteExactInput", args: [path, s] } as const,
      { address: oracle, abi: ORACLE_V32, functionName: "usdcValue", args: [s] } as const,
    ]),
  });
  const known = <T>(r: { status: "success"; result: unknown } | { status: "failure"; error: unknown }, pick: (x: unknown) => T): T | undefined => {
    if (r.status === "success") return pick(r.result);
    if (contractRefused(r.error)) return undefined;
    throw r.error;
  };
  return sizes.map((taoWei, i) => ({
    taoWei,
    grossUsdc: known(results[2 * i] as never, (x) => (x as readonly [bigint, ...unknown[]])[0]),
    twapUsdc: known(results[2 * i + 1] as never, (x) => x as bigint),
  }));
}

/** What 1 ETH sells for in USDC units (WETH –0.05%→ USDC): the keeper's ETH price. */
export async function ethPriceUsdc(c: Pick<Clients, "base">): Promise<bigint> {
  return quote(c, "quoteExactInput", encodePacked(["address", "uint24", "address"], [TOKENS.weth, 500, TOKENS.usdc]), 10n ** 18n);
}

/** Whether Bittensor's side can take a batch now, as the keeper checks before sending one: "open" when
 * the vault isn't paused and ForeverMoney's AlphaVault (which the Bittensor adapter deposits the batch's
 * TAO into) isn't paused, with no migration announced or finished; "paused" when any of that holds;
 * "unchecked" when it can't be read, never guessed open. On v3.2 the AlphaVault is the one of the rail now
 * primary on each chain (R4-O round 3, as the keeper reads it): the front door's primary's Bittensor half's and
 * the vault's primary's (each adapter's own alphaVault()), so after ForeverMoney's migration and the switch to the
 * replacement rail it is the new vault, and before the switch the old vault's notice holds. */
export async function readBittensorSide(c: Pick<Clients, "bittensor" | "base">, d: Deployment): Promise<"open" | "paused" | "unchecked"> {
  if (isV32(d)) return readBittensorSideV32(c, d);
  try {
    const [vaultPaused, alphaPaused, migrationReadyAt, migrationFinished] = await c.bittensor.multicall({
      allowFailure: false,
      contracts: [
        // the vault keeps `paused` on v3.2 too
        { address: d.vault, abi: VAULT, functionName: "paused" },
        { address: ALPHA_VAULT, abi: ALPHA_VAULT_ABI, functionName: "isPaused" },
        { address: ALPHA_VAULT, abi: ALPHA_VAULT_ABI, functionName: "migrationReadyAt" },
        { address: ALPHA_VAULT, abi: ALPHA_VAULT_ABI, functionName: "migrationFinished" },
      ],
    });
    return !vaultPaused && !alphaPaused && migrationReadyAt === 0n && !migrationFinished ? "open" : "paused";
  } catch {
    return "unchecked";
  }
}

/** readBittensorSide on v3.2: the AlphaVaults of the rail now primary on each chain, each once. */
async function readBittensorSideV32(c: Pick<Clients, "bittensor" | "base">, d: Deployment): Promise<"open" | "paused" | "unchecked"> {
  try {
    const [doorPrimary, [vaultPaused, vaultPrimary]] = await Promise.all([
      c.base.readContract({ address: d.doorLens as Address, abi: DOOR_LENS, functionName: "primaryBridge" }),
      c.bittensor.multicall({
        allowFailure: false,
        contracts: [
          { address: d.vault, abi: VAULT, functionName: "paused" },
          { address: d.vaultLens as Address, abi: VAULT_LENS, functionName: "primaryBridge" },
        ],
      }),
    ]);
    const doorHalf = await c.base.readContract({ address: doorPrimary, abi: ADAPTER, functionName: "remoteAdapter" });
    const named = await c.bittensor.multicall({
      allowFailure: false,
      contracts: [doorHalf, vaultPrimary as Address].map((a) => ({ address: a, abi: BIT_ADAPTER_V32, functionName: "alphaVault" }) as const),
    });
    const vaults: Address[] = [];
    for (const v of named as Address[]) if (!vaults.some((x) => x.toLowerCase() === v.toLowerCase())) vaults.push(v);
    const reads = await c.bittensor.multicall({
      allowFailure: false,
      contracts: vaults.flatMap((v) => [
        { address: v, abi: ALPHA_VAULT_ABI, functionName: "isPaused" } as const,
        { address: v, abi: ALPHA_VAULT_ABI, functionName: "migrationReadyAt" } as const,
        { address: v, abi: ALPHA_VAULT_ABI, functionName: "migrationFinished" } as const,
      ]),
    });
    const vaultsClear = vaults.every((_, i) => reads[3 * i] === false && reads[3 * i + 1] === 0n && reads[3 * i + 2] === false);
    return !vaultPaused && vaultsClear ? "open" : "paused";
  } catch {
    return "unchecked";
  }
}

/** The open batch's deposits the staker made (facts.ts, stakerDepositsIn), given its id and age in seconds. */
export type StakerDeposits = (batchId: bigint, ageS: number) => Promise<{ count: number; tao: bigint }>;

/** The open batch, the account's entries in it, and what deciding on Send it now takes. The batch comes
 * from one multicall, with the time of the block it read; with entries and not paused, more is read:
 * - while the keeper may still send it for free at its interval (until five minutes after, and not full),
 *   its fees weighed against its bridge fee as the keeper weighs them (send-now.ts, closeEconomicsOf):
 *   the staker's deposits in it (`stakerDeposits`, from Base's logs), the staker's fees, the oracle's TAO
 *   price and ETH's, null when any of it can't be read (the keeper then holds it too) or on v2;
 * - once it can close: the account's ETH, a gas allowance, ETH's price, and whether Bittensor's side can
 *   take it (false when that can't be read);
 * - either way the bridge fee, for this batch's exact message, asked of both Base RPCs (the second on
 *   `baseCheck`, which gives up in seconds): the larger when they agree (feesAgree), left out and marked
 *   unconfirmed when they don't (a send is never priced on one server's word), left out when either
 *   can't answer. Each figure is left out when its read fails, never guessed.
 * v3-launch's paused front door can't close a batch, so nothing more is read for it; v3.2's pause stops new
 * deposits only (spec §3.5, I-20), so its batch is read on and marked `closesWhilePaused`. */
export async function readOpenBatch(
  c: Pick<Clients, "base" | "baseCheck" | "bittensor">,
  d: Deployment,
  account: Address,
  stakerDeposits?: StakerDeposits,
): Promise<OpenBatch> {
  const v32 = isV32(d);
  const fd = { address: d.frontDoor, abi: frontDoorAbi(d) } as const;
  const out = (await c.base.multicall({
    allowFailure: false,
    contracts: [
      { ...fd, functionName: "openBatch" },
      { ...fd, functionName: "openDeposits" },
      { ...fd, functionName: "openRedeems" },
      { ...fd, functionName: "canClose" },
      { ...fd, functionName: "batchInterval" },
      { ...fd, functionName: "paused" },
      { ...fd, functionName: "depositOf", args: [account] },
      { ...fd, functionName: "redeemOf", args: [account] },
      { address: MULTICALL3, abi: MULTICALL3_ABI, functionName: "getCurrentBlockTimestamp" },
      // v3.2: the account's cancel cooldown (R11) and the redeem list's limit (a full list's request closes it first); and
      // (R12c) the door's limits, for the minValue of a close the site sends before a stake (units.ts closeFirstFloor)
      ...(v32
        ? ([
            { address: d.frontDoor, abi: FRONT_DOOR_V32, functionName: "cancelableAt", args: [account] },
            { address: d.frontDoor, abi: FRONT_DOOR_V32, functionName: "maxRedeems" },
            { address: d.frontDoor, abi: FRONT_DOOR_V32, functionName: "maxDeposits" },
            { address: d.frontDoor, abi: FRONT_DOOR_V32, functionName: "maxBatchValue" },
            { address: d.frontDoor, abi: FRONT_DOOR_V32, functionName: "minDeposit" },
            { address: d.frontDoor, abi: FRONT_DOOR_V32, functionName: "depositCap" },
            { address: d.frontDoor, abi: FRONT_DOOR_V32, functionName: "netForwarded" },
          ] as const)
        : []),
    ] as never,
  })) as unknown[];
  const [open, deposits, redeems, canClose, interval, paused, depositOf, redeemOf, time, cancelableAt, maxRedeems, maxDeposits, maxBatchValue, minDeposit, depositCap, netForwarded] = out as [
    readonly [bigint, bigint, bigint, bigint, bigint, bigint],
    readonly { user: Address; amount: bigint }[],
    readonly { user: Address; amount: bigint }[],
    boolean,
    bigint | number,
    boolean,
    bigint,
    bigint,
    bigint,
    bigint | undefined,
    number | undefined,
    number | undefined,
    bigint | undefined,
    bigint | undefined,
    bigint | undefined,
    bigint | undefined,
  ];
  const [id, start, totalDeposits, feePot] = open;
  const batch: OpenBatch = {
    id,
    start: Number(start),
    interval: Number(interval),
    canClose,
    paused,
    chainTime: Number(time),
    mine: { depositWei: depositOf, redeemShares: redeemOf, ...(v32 && cancelableAt !== undefined ? { cancelableAt: Number(cancelableAt) } : {}) },
    potWei: feePot,
    totalWei: totalDeposits,
    ...(v32 ? { closesWhilePaused: true as const } : {}),
    ...(v32 && maxRedeems !== undefined ? { nRedeems: redeems.length, maxRedeems: Number(maxRedeems) } : {}),
    ...(v32 && maxDeposits !== undefined && maxBatchValue !== undefined && minDeposit !== undefined && depositCap !== undefined && netForwarded !== undefined
      ? { limits: { nDeposits: deposits.length, maxDeposits: Number(maxDeposits), maxBatchValue, minDeposit, depositCap, netForwarded } }
      : {}),
  };
  if ((paused && !v32) || deposits.length + redeems.length === 0) return batch;
  const weigh = isV3(d) && !isFull(batch) && batch.chainTime < batch.start + batch.interval + SEND_GRACE_S;
  if (!canClose && !weigh) return batch;

  const none = Promise.resolve(undefined);
  const message = { id, deposits, redeems, totalDeposits };
  const [fee, fee2, ethUsdc, eth, gas, bitSide, tao, staker, staked] = await Promise.allSettled([
    quoteCloseFee(c, d, message),
    quoteCloseFee({ base: c.baseCheck }, d, message),
    ethPriceUsdc(c),
    canClose ? c.base.getBalance({ address: account }) : none,
    canClose ? c.base.estimateFeesPerGas().then((f) => CLOSE_GAS * f.maxFeePerGas) : none,
    canClose ? readBittensorSide(c, d) : none,
    weigh ? c.base.readContract({ address: d.oracle as Address, abi: TWAP_ORACLE, functionName: "usdcValue", args: [10n ** 18n] }) : none,
    weigh ? readStakerFees(c, d) : none,
    weigh && stakerDeposits ? stakerDeposits(id, batch.chainTime - batch.start) : none,
  ]);
  const [feeA, feeB] = [settled(fee), settled(fee2)];
  const agree = feeA !== undefined && feeB !== undefined && feesAgree(feeA, feeB);
  const feeWei = agree ? (feeA > feeB ? feeA : feeB) : undefined;
  const feeUnconfirmed = feeA !== undefined && feeB !== undefined && !agree;
  const ethPrice = settled(ethUsdc);
  const ethWei = settled(eth);
  const gasWei = settled(gas);
  let economics: OpenBatch["economics"];
  if (weigh) {
    const taoPriceUsdc = settled(tao);
    const fees = settled(staker);
    const deposited = settled(staked);
    // as the keeper: a price or a bridge fee of 0 would count any batch as covered, so it counts as unread
    economics =
      feeWei && ethPrice && taoPriceUsdc && fees && deposited
        ? closeEconomicsOf({
            nStaked: deposited.count,
            depositFeeUsdc: fees.depositFeeUsdc,
            stakedTao: deposited.tao < totalDeposits ? deposited.tao : totalDeposits,
            taoPriceUsdc,
            swapFeeBps: Number(fees.swapFeeBps),
            feePot,
            ethPriceUsdc: ethPrice,
            bridgeFeeWei: feeWei,
          })
        : null;
  }
  return {
    ...batch,
    ...(feeWei !== undefined ? { feeWei } : {}),
    ...(feeUnconfirmed ? { feeUnconfirmed: true as const } : {}),
    ...(canClose && ethWei !== undefined ? { ethWei } : {}),
    ...(canClose && gasWei !== undefined ? { gasWei } : {}),
    ...(ethPrice ? { ethPriceUsd: toDisplay(ethPrice, 6) } : {}),
    ...(economics !== undefined ? { economics } : {}),
    ...(canClose ? { bittensor: settled(bitSide) ?? "unchecked" } : {}),
  };
}

/** What a send of the batch did, from its receipt: the front door's BatchClosed for the batch the user
 * meant to send ("sent"), for another batch ("other": that one had left, and the next one, already able
 * to close, went in its place), each with the bridge fee and the part of it the batch's pot paid (the
 * sender paid the rest); or its BatchRolled ("rolled": the batch had left and the next was empty, so
 * closeBatch only restarted its timer and refunded everything sent). Undefined when it can't be read. */
export type CloseOutcome = { kind: "sent" | "other"; feeWei: bigint; potUsedWei: bigint } | { kind: "rolled" };

export async function readCloseOutcome(c: Pick<Clients, "base">, d: Deployment, hash: Hex, batchId: bigint): Promise<CloseOutcome | undefined> {
  try {
    const receipt = await c.base.getTransactionReceipt({ hash });
    const own = receipt.logs.filter((l) => l.address.toLowerCase() === d.frontDoor.toLowerCase());
    // v3.2's BatchClosed has seven fields (potCarried), so another topic than v3-launch's six
    const abi = frontDoorAbi(d);
    const [closed] = parseEventLogs({ abi, eventName: "BatchClosed", logs: own });
    if (closed) return { kind: closed.args.id === batchId ? "sent" : "other", feeWei: closed.args.fee, potUsedWei: closed.args.potUsed };
    return parseEventLogs({ abi, eventName: "BatchRolled", logs: own }).length > 0 ? { kind: "rolled" } : undefined;
  } catch {
    return undefined;
  }
}

/** The share of rewards Cascade keeps, in basis points; v2 has no cut, so nothing is asked. */
export async function readRewardCutBps(c: Pick<Clients, "bittensor">, d: Deployment): Promise<number> {
  if (!isV3(d)) return 0;
  if (isV32(d)) return Number(await c.bittensor.readContract({ ...vaultLensOf(d), functionName: "rewardCutBps" }));
  return Number(await c.bittensor.readContract({ address: d.vault, abi: VAULT, functionName: "rewardCutBps" }));
}

/**
 * The APY of root staking with the vault's validator over the last 30 days: its on-chain return
 * series (BasketTwr) read through the storage-query precompile now and 30 days back, less Cascade's
 * cut. Needs an archive node (the site's Bittensor RPC is one). Undefined when there's no figure to show.
 *
 * On the yield's own two connections (chain.ts), which wait long enough for the public archive node (a read of today's
 * state can take 18 s, one of 30-day-old state 10 to 40 s): today's reads on `bittensorYield`, which batches them among
 * themselves; the two of the block 30 days back (its series value and its header) on `bittensorDeep`, each a request of
 * its own, never in a batch, since a batch answers only when its slowest call has. Nothing else uses either connection,
 * so the yield holds no other read back, and none holds it.
 */
export async function readApyPercent(c: Pick<Clients, "bittensorYield" | "bittensorDeep">, d: Deployment): Promise<number | undefined> {
  const chain = c.bittensorYield;
  const [hotkey, rewardCutBps, head] = await Promise.all([
    readStakeHotkey(chain, d),
    readRewardCutBps({ bittensor: chain }, d),
    chain.getBlock(),
  ]);
  // 30 days back in Bittensor's blocks at its block time as measured (blocktime.ts); none while it can't be read
  const ms = await blockMsOf(chain, BLOCK_SPAN.bittensor, head).catch(() => undefined);
  if (ms === undefined) return undefined;
  const back = blocksIn(APY_WINDOW_S * 1000, ms);
  if (head.number <= back) return undefined;
  const key = basketTwrKey(hotkey);
  const thenNumber = head.number - back;
  const [now, then, thenBlock] = await Promise.all([
    chain.call({ to: STORAGE_QUERY, data: key, blockNumber: head.number }),
    c.bittensorDeep.call({ to: STORAGE_QUERY, data: key, blockNumber: thenNumber }),
    c.bittensorDeep.getBlock({ blockNumber: thenNumber }),
  ]);
  return netApyPercent({
    twrNow: decodeTwr(now.data),
    twrThen: decodeTwr(then.data),
    seconds: Number(head.timestamp - thenBlock.timestamp),
    rewardCutBps,
  });
}

export interface StakerFees {
  swapFeeBps: bigint;
  depositFeeUsdc: bigint;
}

/** Cascade's fees on the staker: a percentage of the swap and a flat USDC fee per deposit. */
export async function readStakerFees(c: Pick<Clients, "base">, d: Deployment): Promise<StakerFees> {
  if (!d.staker) return { swapFeeBps: 0n, depositFeeUsdc: 0n };
  const staker = { address: d.staker, abi: STAKER } as const;
  const [swapFeeBps, depositFeeUsdc] = await c.base.multicall({
    allowFailure: false,
    contracts: [
      { ...staker, functionName: "swapFeeBps" },
      { ...staker, functionName: "depositFeeUsdc" },
    ],
  });
  return { swapFeeBps: BigInt(swapFeeBps), depositFeeUsdc };
}

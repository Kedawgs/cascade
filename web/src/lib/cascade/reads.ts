import { type Address, encodeAbiParameters, encodePacked, type Hex, parseAbiParameters } from "viem";
import { freshTip } from "./fresh";
import { ADAPTER, ERC20, FRONT_DOOR, QUOTER, STAKER, STAKING, STAKING_ADDRESS, VAULT } from "./abi";
import { APY_WINDOW_BLOCKS, basketTwrKey, decodeTwr, netApyPercent, STORAGE_QUERY } from "./apy";
import type { Clients } from "./chain";
import { type Deployment, isV3, PATH_TAO_TO_USDC, PATH_USDC_TO_TAO, TOKENS, UNISWAP } from "./config";
import { RAO, toDisplay } from "./units";

const ZERO: Address = "0x0000000000000000000000000000000000000000";

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
}

export async function readFrontDoor(c: Pick<Clients, "base">, d: Deployment, account: Address = ZERO): Promise<FrontDoorState> {
  const fd = { address: d.frontDoor, abi: FRONT_DOOR } as const;
  const [depositOf, redeemOf, claimable, open, netForwarded, depositCap, minDeposit, redeemRequestFee, canClose, interval, maxBatchValue, maxDeposits] =
    await c.base.multicall({
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
      ],
    });
  const [id, start, total, , nDeposits, nRedeems] = open as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
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
  };
}

export interface VaultState {
  shares: bigint;
  totalAssets: bigint;
  totalSupply: bigint;
  rootStakeWei: bigint;
  pendingPayouts: bigint;
  /** The vault's liquid TAO (Bittensor reads it 500 rao below what it holds). */
  balanceWei: bigint;
  stakeHotkey: Hex;
  payoutDelay: number;
  nominatorMinWei: bigint;
}

export async function readVault(c: Pick<Clients, "bittensor">, d: Deployment, account: Address = ZERO): Promise<VaultState> {
  const v = { address: d.vault, abi: VAULT } as const;
  // read at a block known to be recent: a server that is behind then errors instead of answering from the past
  const blockNumber = await freshTip(c);
  const [shares, totalAssets, totalSupply, rootStakeRao, pendingPayouts, stakeHotkey, payoutDelay, nominatorMin] =
    await c.bittensor.multicall({
      blockNumber,
      allowFailure: false,
      contracts: [
        { ...v, functionName: "balanceOf", args: [account] },
        { ...v, functionName: "totalAssets" },
        { ...v, functionName: "totalSupply" },
        { ...v, functionName: "rootStakeRao" },
        { ...v, functionName: "pendingPayouts" },
        { ...v, functionName: "stakeHotkey" },
        { ...v, functionName: "payoutDelay" },
        { address: STAKING_ADDRESS, abi: STAKING, functionName: "getNominatorMinRequiredStake" },
      ],
    });
  return {
    shares,
    totalAssets,
    totalSupply,
    rootStakeWei: rootStakeRao * RAO,
    pendingPayouts,
    balanceWei: await c.bittensor.getBalance({ address: d.vault, blockNumber }),
    stakeHotkey,
    payoutDelay: Number(payoutDelay),
    nominatorMinWei: nominatorMin * RAO,
  };
}

export interface PendingRewards {
  /** Root dividends the whole vault has earned and not yet collected (wei). */
  wei: bigint;
  /** The share Cascade keeps, in basis points (0 on v2, which has no cut). */
  cutBps: number;
}

/** What the vault has earned but not collected yet; undefined when any read fails (unknown, not zero). */
export async function readPendingRewards(
  c: Pick<Clients, "bittensor">,
  d: Deployment,
  stakeHotkey: Hex,
): Promise<PendingRewards | undefined> {
  const v = { address: d.vault, abi: VAULT } as const;
  try {
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

/** The share of rewards Cascade keeps, in basis points; v2 has no cut, so nothing is asked. */
export async function readRewardCutBps(c: Pick<Clients, "bittensor">, d: Deployment): Promise<number> {
  if (!isV3(d)) return 0;
  return Number(await c.bittensor.readContract({ address: d.vault, abi: VAULT, functionName: "rewardCutBps" }));
}

/**
 * The APY of root staking with the vault's validator over the last 30 days: its on-chain return
 * series (BasketTwr) read through the storage-query precompile now and 30 days back, less Cascade's
 * cut. Needs an archive node (the site's Bittensor RPC is one). Undefined when there's no figure to show.
 */
export async function readApyPercent(c: Pick<Clients, "bittensorHistory">, d: Deployment): Promise<number | undefined> {
  const chain = c.bittensorHistory;
  const [hotkey, rewardCutBps, head] = await Promise.all([
    chain.readContract({ address: d.vault, abi: VAULT, functionName: "stakeHotkey" }),
    readRewardCutBps({ bittensor: chain }, d),
    chain.getBlock(),
  ]);
  if (head.number <= APY_WINDOW_BLOCKS) return undefined;
  const key = basketTwrKey(hotkey);
  const thenNumber = head.number - APY_WINDOW_BLOCKS;
  const [now, then, thenBlock] = await Promise.all([
    chain.call({ to: STORAGE_QUERY, data: key, blockNumber: head.number }),
    chain.call({ to: STORAGE_QUERY, data: key, blockNumber: thenNumber }),
    chain.getBlock({ blockNumber: thenNumber }),
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

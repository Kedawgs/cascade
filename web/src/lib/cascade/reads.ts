import type { Address, Hex } from "viem";
import { ERC20, FRONT_DOOR, QUOTER, STAKING, STAKING_ADDRESS, VAULT } from "./abi";
import type { Clients } from "./chain";
import { type Deployment, PATH_TAO_TO_USDC, PATH_USDC_TO_TAO, TOKENS, UNISWAP } from "./config";
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
}

export async function readFrontDoor(c: Pick<Clients, "base">, d: Deployment, account: Address = ZERO): Promise<FrontDoorState> {
  const fd = { address: d.frontDoor, abi: FRONT_DOOR } as const;
  const [depositOf, redeemOf, claimable, open, netForwarded, depositCap, minDeposit, redeemRequestFee, canClose, interval] =
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
  const [shares, totalAssets, totalSupply, rootStakeRao, pendingPayouts, stakeHotkey, payoutDelay, nominatorMin] =
    await c.bittensor.multicall({
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
    balanceWei: await c.bittensor.getBalance({ address: d.vault }),
    stakeHotkey,
    payoutDelay: Number(payoutDelay),
    nominatorMinWei: nominatorMin * RAO,
  };
}

export interface WalletState {
  usdc: bigint;
  tao: bigint;
  eth: bigint;
  usdcRouterAllowance: bigint;
  taoRouterAllowance: bigint;
  taoFrontDoorAllowance: bigint;
}

export async function readWallet(c: Pick<Clients, "base">, d: Deployment, account: Address): Promise<WalletState> {
  const usdc = { address: TOKENS.usdc, abi: ERC20 } as const;
  const tao = { address: TOKENS.tao, abi: ERC20 } as const;
  const [usdcBal, taoBal, usdcRouter, taoRouter, taoFrontDoor] = await c.base.multicall({
    allowFailure: false,
    contracts: [
      { ...usdc, functionName: "balanceOf", args: [account] },
      { ...tao, functionName: "balanceOf", args: [account] },
      { ...usdc, functionName: "allowance", args: [account, UNISWAP.router] },
      { ...tao, functionName: "allowance", args: [account, UNISWAP.router] },
      { ...tao, functionName: "allowance", args: [account, d.frontDoor] },
    ],
  });
  return {
    usdc: usdcBal,
    tao: taoBal,
    eth: await c.base.getBalance({ address: account }),
    usdcRouterAllowance: usdcRouter,
    taoRouterAllowance: taoRouter,
    taoFrontDoorAllowance: taoFrontDoor,
  };
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

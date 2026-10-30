import type { Hex } from "viem";
import { ADMIN_VIEWS, ALPHA_VAULT, ERC20, FRONT_DOOR_VIEWS, OFFRAMP, ORACLE, SAFE, STAKING, TREASURY, UNISWAP_POOL, VAULT_VIEWS } from "../../src/abi.ts";
import type { Config } from "../../src/config.ts";
import { Budget, createRpc } from "../../src/rpc.ts";
import { STAKING_PRECOMPILE, STORAGE_QUERY } from "../../src/subtensor.ts";
import { type ChainSpec, ethCall, type FetchRecord, fakeChains, REVERT, TEST_URLS } from "./fake-rpc.ts";

const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
export const OWNER = "0x00000000000000000000000000000000000000a1" as Hex;
export const GUARDIAN = "0x00000000000000000000000000000000000000a2" as Hex;
export const KEEPER = "0x00000000000000000000000000000000000000a3" as Hex;
export const TREASURY_WALLET = "0x00000000000000000000000000000000000000a4" as Hex;
export const VALIDATOR_OWNER = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;

/** Everything both chains answer, as plain values a test can change between reads. A view listed in
 * `reverts` ("vault.price", "base.oracle.usdcValue") reverts. */
export function deploymentState(cfg: Config) {
  const d = cfg.deployment;
  return {
    reverts: new Set<string>(),
    bit: {
      price: 10n ** 18n,
      totalAssets: 50n * 10n ** 18n,
      totalSupply: 50n * 10n ** 18n,
      rootStakeRao: 49n * 10n ** 9n,
      pendingPayouts: 0n,
      paused: false,
      owner: OWNER,
      pendingOwner: ZERO,
      guardian: GUARDIAN,
      pendingGuardian: ZERO,
      keeper: KEEPER,
      stakeHotkey: d.stakeHotkey,
      hotkeys: [d.stakeHotkey] as Hex[],
      stakes: { [d.stakeHotkey]: 49n * 10n ** 9n } as Record<Hex, bigint>,
      balance: 10n ** 18n,
      payoutDelay: 3600n,
      maxDailyOutflowBps: 2000n,
      minDailyOutflow: 100n * 10n ** 18n,
      burnWindow: [1_700_000_000n, 0n] as [bigint, bigint],
      lastClaimAt: 1_700_000_000n,
      unclaimed: 3n * 10n ** 16n,
      /** the stake hotkey's owner in SubtensorModule `Owner`; null: no entry */
      hotkeyOwner: VALIDATOR_OWNER as Hex | null,
      minStakeRao: 2_000_000n,
      rewardCutBps: 1000,
      treasury: TREASURY_WALLET,
      lockPoolFmTao: 100n * 10n ** 18n,
      adapterBalance: 10n ** 13n,
      keeperBalance: 10n ** 18n,
      alpha: { isPaused: false, migrationReadyAt: 0n, migrationFinished: false },
      payoutBatches: {} as Record<Hex, { queuedAt: bigint; cursor: number; count: number; chunk: number; remaining: bigint }>,
      offRamp: {} as Record<Hex, number>,
    },
    base: {
      openBatch: [7n, 1_700_000_000n, 0n, 0n, 0n, 0n] as [bigint, bigint, bigint, bigint, bigint, bigint],
      totalClaimable: 0n,
      totalFeeCredit: 0n,
      netForwarded: 0n,
      depositCap: 40n * 10n ** 18n,
      maxBatchValue: 10n * 10n ** 18n,
      maxDeposits: 100,
      maxRedeems: 100,
      batchInterval: 600n,
      paused: false,
      owner: OWNER,
      pendingOwner: ZERO,
      guardian: GUARDIAN,
      pendingGuardian: ZERO,
      keeper: KEEPER,
      oracle: d.oracle,
      stakerOwner: OWNER,
      stakerPendingOwner: ZERO,
      stakerTreasury: TREASURY_WALLET,
      frontDoorTao: 0n,
      frontDoorEth: 0n,
      fmTaoSupply: 100n * 10n ** 18n,
      taoWeth: { slot0: [79228162514264337593543950336n, 0, 0, 1, 1, 0, true] as const, liquidity: 5n * 10n ** 18n, tao: 30n * 10n ** 18n, token0: cfg.tokens.base.fmTao },
      wethUsdc: { slot0: [3961408125713216879677197516800n, 0, 0, 1, 1, 0, true] as const, liquidity: 9n * 10n ** 18n, token0: cfg.tokens.base.weth },
      oracleValue: 400_000_000n,
      keeperBalance: 10n ** 17n,
      claimable: {} as Record<Hex, bigint>,
      deliveryOf: {} as Record<Hex, [bigint, bigint, number]>,
      /** `${bridge}:${messageHash}` → delivered */
      delivered: {} as Record<string, boolean>,
      offRamp: {} as Record<Hex, number>,
      /** nonce() of each Safe on Base */
      safes: {} as Record<Hex, bigint>,
    },
    /** eth_getTransactionCount per chain and address */
    nonces: { base: {} as Record<Hex, bigint>, bittensor: {} as Record<Hex, bigint> },
  };
}

export type DeploymentState = ReturnType<typeof deploymentState>;

const lc = (a: unknown) => String(a).toLowerCase() as Hex;

/** A fake of both chains answering every view the readings ask, from `state`, at heads `heads`. */
export function fakeDeployment(cfg: Config, state: DeploymentState, o: { heads?: { base: bigint; bittensor: bigint }; lagBy?: { base?: bigint; bittensor?: bigint }; onFetch?: (f: FetchRecord) => void } = {}) {
  const d = cfg.deployment;
  const t = cfg.tokens;
  const heads = o.heads ?? { base: 37_100_000n, bittensor: 6_905_000n };
  const v = <T>(chain: string, name: string, value: () => T) => () => (state.reverts.has(`${chain}.${name}`) ? REVERT : value());
  const b = state.base;
  const x = state.bit;
  const balances = (chain: "base" | "bittensor") => (a: Hex) => {
    const k = lc(a);
    if (chain === "base") return k === d.frontDoor ? b.frontDoorEth : k === lc(b.keeper) ? b.keeperBalance : 0n;
    return k === d.vault ? x.balance : k === d.bitAdapter ? x.adapterBalance : k === lc(x.keeper) ? x.keeperBalance : 0n;
  };
  const counts = (chain: "base" | "bittensor") => ([a]: readonly unknown[]) => `0x${(state.nonces[chain][lc(a)] ?? 0n).toString(16)}`;
  const safeContracts = Object.fromEntries(Object.keys(b.safes).map((a) => [a, { abi: SAFE, fns: { nonce: () => b.safes[a as Hex] } }]));
  const baseSpec: ChainSpec = {
    head: heads.base,
    lagBy: o.lagBy?.base,
    blockTime: (n) => 1_800_000_000 + Number(n - heads.base) * 2,
    calls: {
      eth_getTransactionCount: counts("base"),
      eth_call: ethCall(
        {
          [d.frontDoor]: {
            abi: [...FRONT_DOOR_VIEWS, ...ADMIN_VIEWS],
            fns: {
              openBatch: v("frontDoor", "openBatch", () => b.openBatch),
              totalClaimable: v("frontDoor", "totalClaimable", () => b.totalClaimable),
              totalFeeCredit: v("frontDoor", "totalFeeCredit", () => b.totalFeeCredit),
              netForwarded: v("frontDoor", "netForwarded", () => b.netForwarded),
              depositCap: v("frontDoor", "depositCap", () => b.depositCap),
              maxBatchValue: v("frontDoor", "maxBatchValue", () => b.maxBatchValue),
              maxDeposits: v("frontDoor", "maxDeposits", () => b.maxDeposits),
              maxRedeems: v("frontDoor", "maxRedeems", () => b.maxRedeems),
              batchInterval: v("frontDoor", "batchInterval", () => b.batchInterval),
              paused: v("frontDoor", "paused", () => b.paused),
              owner: v("frontDoor", "owner", () => b.owner),
              pendingOwner: v("frontDoor", "pendingOwner", () => b.pendingOwner),
              guardian: v("frontDoor", "guardian", () => b.guardian),
              pendingGuardian: v("frontDoor", "pendingGuardian", () => b.pendingGuardian),
              keeper: v("frontDoor", "keeper", () => b.keeper),
              oracle: v("frontDoor", "oracle", () => b.oracle),
              claimable: ([u]) => b.claimable[lc(u)] ?? 0n,
              deliveryOf: ([u]) => b.deliveryOf[lc(u)] ?? [0n, 0n, 0],
              delivered: ([bridge, hash]) => b.delivered[`${lc(bridge)}:${lc(hash)}`] ?? false,
            },
          },
          [d.staker]: { abi: [...ADMIN_VIEWS, ...TREASURY], fns: { owner: () => b.stakerOwner, pendingOwner: () => b.stakerPendingOwner, treasury: () => b.stakerTreasury } },
          [t.base.fmTao]: {
            abi: ERC20,
            fns: { totalSupply: v("fmTao", "totalSupply", () => b.fmTaoSupply), balanceOf: ([a]) => (lc(a) === d.frontDoor ? b.frontDoorTao : lc(a) === t.base.taoWethPool ? b.taoWeth.tao : 0n) },
          },
          [t.base.taoWethPool]: { abi: UNISWAP_POOL, fns: { slot0: () => b.taoWeth.slot0, liquidity: () => b.taoWeth.liquidity, token0: () => b.taoWeth.token0 } },
          [t.base.wethUsdcPool]: { abi: UNISWAP_POOL, fns: { slot0: () => b.wethUsdc.slot0, liquidity: () => b.wethUsdc.liquidity, token0: () => b.wethUsdc.token0 } },
          [d.oracle]: { abi: ORACLE, fns: { usdcValue: v("base", "oracle.usdcValue", () => b.oracleValue) } },
          [t.base.offRamp]: { abi: OFFRAMP, fns: { getExecutionState: ([id]) => b.offRamp[lc(id)] ?? 0 } },
          ...safeContracts,
        },
        { time: (at) => 1_800_000_000 + Number(at - heads.base) * 2, balance: balances("base") },
      ),
    },
  };
  const bitSpec: ChainSpec = {
    head: heads.bittensor,
    lagBy: o.lagBy?.bittensor,
    blockTime: (n) => 1_800_000_000 + Number(n - heads.bittensor) * 12,
    calls: {
      eth_getTransactionCount: counts("bittensor"),
      eth_call: ethCall(
        {
          [d.vault]: {
            abi: [...VAULT_VIEWS, ...ADMIN_VIEWS, ...TREASURY],
            fns: {
              treasury: () => x.treasury,
              price: v("vault", "price", () => x.price),
              totalAssets: v("vault", "totalAssets", () => x.totalAssets),
              totalSupply: v("vault", "totalSupply", () => x.totalSupply),
              rootStakeRao: v("vault", "rootStakeRao", () => x.rootStakeRao),
              pendingPayouts: v("vault", "pendingPayouts", () => x.pendingPayouts),
              paused: v("vault", "paused", () => x.paused),
              owner: v("vault", "owner", () => x.owner),
              pendingOwner: v("vault", "pendingOwner", () => x.pendingOwner),
              guardian: v("vault", "guardian", () => x.guardian),
              pendingGuardian: v("vault", "pendingGuardian", () => x.pendingGuardian),
              keeper: v("vault", "keeper", () => x.keeper),
              stakeHotkey: v("vault", "stakeHotkey", () => x.stakeHotkey),
              hotkeys: ([i]) => (Number(i) < x.hotkeys.length ? x.hotkeys[Number(i)] : REVERT),
              payoutDelay: v("vault", "payoutDelay", () => x.payoutDelay),
              maxDailyOutflowBps: () => x.maxDailyOutflowBps,
              minDailyOutflow: () => x.minDailyOutflow,
              burnWindows: () => x.burnWindow,
              lastClaimAt: () => x.lastClaimAt,
              minStakeRao: () => x.minStakeRao,
              rewardCutBps: () => x.rewardCutBps,
              getPayoutBatch: ([key]) => {
                const p = x.payoutBatches[lc(key)];
                return {
                  sourceChain: p ? 8453n : 0n,
                  frontDoor: p ? d.frontDoor : ZERO,
                  batchId: 0n,
                  queuedAt: p?.queuedAt ?? 0n,
                  cursor: p?.cursor ?? 0,
                  count: p?.count ?? 0,
                  chunk: p?.chunk ?? 0,
                  remaining: p?.remaining ?? 0n,
                  payoutsHash: `0x${"00".repeat(32)}`,
                };
              },
            },
          },
          [STAKING_PRECOMPILE]: {
            abi: STAKING,
            fns: { getStake: ([hk]) => x.stakes[lc(hk)] ?? 0n, getUnclaimedRootTaoByHotkey: () => x.unclaimed },
          },
          [STORAGE_QUERY]: { raw: () => (x.hotkeyOwner === null ? "0x" : x.hotkeyOwner) },
          [t.bittensor.fmTao]: { abi: ERC20, fns: { balanceOf: ([a]) => (lc(a) === t.bittensor.lockPool ? x.lockPoolFmTao : 0n) } },
          [t.bittensor.alphaVault]: { abi: ALPHA_VAULT, fns: { isPaused: () => x.alpha.isPaused, migrationReadyAt: () => x.alpha.migrationReadyAt, migrationFinished: () => x.alpha.migrationFinished } },
          [t.bittensor.offRamp]: { abi: OFFRAMP, fns: { getExecutionState: ([id]) => x.offRamp[lc(id)] ?? 0 } },
        },
        { time: (at) => 1_800_000_000 + Number(at - heads.bittensor) * 12, balance: balances("bittensor") },
      ),
    },
  };
  const net = fakeChains({ base: baseSpec, bittensor: bitSpec }, { onFetch: o.onFetch });
  const budget = new Budget(45);
  const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget, sleep: async () => {}, spacingMs: { base: 0, bittensor: 0 } });
  return { net, rpc, budget, heads, specs: { base: baseSpec, bittensor: bitSpec } };
}

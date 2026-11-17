import { type Abi, decodeAbiParameters, type Hex, numberToHex } from "viem";
import {
  ADAPTER_PEER_VIEWS,
  ADMIN_VIEWS,
  ALPHA_VAULT,
  BIT_ADAPTER_V32_VIEWS,
  BIT_RAIL_VIEWS,
  BRIDGE_VIEWS,
  CCIP_SELECTOR,
  DOOR_LENS_VIEWS,
  ERC20,
  FRONT_DOOR_V32_VIEWS,
  FRONT_DOOR_VIEWS,
  OFFRAMP,
  ORACLE,
  ORACLE_V32,
  QUOTER_V2,
  SAFE,
  SAFE_OWNERS,
  STAKING,
  TOKEN_POOL,
  TREASURY,
  UNISWAP_POOL,
  VAULT_LENS_VIEWS,
  VAULT_V32_VIEWS,
  VAULT_VIEWS,
} from "../../src/abi.ts";
import { type Config, PATH_USDC_TO_TAO, UNISWAP_QUOTER } from "../../src/config.ts";
import { Budget, createRpc } from "../../src/rpc.ts";
import { LOCK_POOL, TOKEN_ADMIN_REGISTRY } from "../../src/abi.ts";
import {
  DELEGATES_PREFIX,
  ROOT_STAKE_UNLOCK_INTERVAL_KEY,
  STAKING_HOTKEYS_PREFIX,
  STAKING_PRECOMPILE,
  STORAGE_QUERY,
  TOTAL_HOTKEY_ALPHA_PREFIX,
  UIDS_PREFIX,
} from "../../src/subtensor.ts";
import { type ChainSpec, ethCall, type FakeContracts, type FetchRecord, fakeChains, REVERT, TEST_URLS } from "./fake-rpc.ts";

type Fns = Record<string, (args: readonly unknown[], at: bigint) => unknown>;

const ZERO = "0x0000000000000000000000000000000000000000" as Hex;

/** A SCALE `Vec<AccountId32>` as SubtensorModule stores it: a compact length (one byte below 64 items, two
 * below 16,384), then the ids. */
export function encodeAccountIds(ids: readonly Hex[]): Hex {
  const n = ids.length;
  const len = n < 64 ? [n << 2] : [((n << 2) | 1) & 0xff, (n << 2) >> 8];
  return `0x${len.map((b) => b.toString(16).padStart(2, "0")).join("")}${ids.map((id) => id.slice(2).toLowerCase()).join("")}`;
}
export const OWNER = "0x00000000000000000000000000000000000000a1" as Hex;
export const GUARDIAN = "0x00000000000000000000000000000000000000a2" as Hex;
export const KEEPER = "0x00000000000000000000000000000000000000a3" as Hex;
export const TREASURY_WALLET = "0x00000000000000000000000000000000000000a4" as Hex;
/** ForeverMoney's 2-of-3 Safe: the administrator of both tokens in the TokenAdminRegistries (R3, 2026-11-05) */
export const FM_SAFE = "0xadf60fcc63217961c931d57f1dce2c5d70af3546" as Hex;
export const VALIDATOR_OWNER = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex;

/** A CCIP token pool's rate-limit bucket as getCurrent*RateLimiterState answers it (amounts in TAO). */
export const bucket = (tokens: bigint, capacity = 5000n, isEnabled = true) => ({ tokens: tokens * 10n ** 18n, lastUpdated: 1_800_000_000, isEnabled, capacity: capacity * 10n ** 18n, rate: 6n * 10n ** 17n });

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
      /** the hotkeys SubtensorModule `StakingHotkeys` lists for the vault's coldkey (where its stake sits) */
      stakingHotkeys: [d.stakeHotkey] as Hex[],
      minStakeRao: 2_000_000n,
      rewardCutBps: 1000,
      treasury: TREASURY_WALLET,
      lockPoolFmTao: 100n * 10n ** 18n,
      adapterBalance: 10n ** 13n,
      keeperBalance: 10n ** 18n,
      /** the guardian's TAO: its launch funding, 0.01 */
      guardianBalance: 10n ** 16n,
      alpha: {
        isPaused: false,
        migrationReadyAt: 0n,
        migrationFinished: false,
        pausedUntil: 0n,
        pauseableAfter: 0n,
        migrationTarget: ZERO,
        migrationExecuted: false,
        pendingAdmin: [ZERO, 0] as [Hex, number],
        /** backing(wTAO) */
        backing: 101n * 10n ** 18n,
      },
      /** R4-O round 4: ForeverMoney's other AlphaVaults (a migration's new one), by lowercase address, as `alpha` */
      vaults: {} as Record<
        Hex,
        { isPaused: boolean; migrationReadyAt: bigint; migrationFinished: boolean; pausedUntil: bigint; pauseableAfter: bigint; migrationTarget: Hex; migrationExecuted: boolean; pendingAdmin: [Hex, number]; backing: bigint }
      >,
      /** wTAO's total supply (the lock pool holds lockPoolFmTao of it) */
      wTaoSupply: 100n * 10n ** 18n,
      /** the lock pool's buckets for the Base lane, and whether it lists Base (isSupportedChain) */
      lane: { inbound: bucket(5000n), outbound: bucket(4000n), supported: true },
      /** the lock pool's rebalancer (getRebalancer), and wTAO's TokenAdminRegistry entry (getTokenConfig) */
      rebalancer: ZERO as Hex,
      registry: { administrator: FM_SAFE as Hex, pendingAdministrator: ZERO as Hex, tokenPool: cfg.tokens.bittensor.lockPool as Hex },
      /** the raw storage the 0x807 query answers for the validator (as the live chain did on 2026-10-31) */
      storage: { delegates: "0x0000" as Hex, totalHotkeyAlpha: "0x8a54d1d2fda00300" as Hex, uids: "0x0100" as Hex, unlockInterval: "0x" as Hex },
      claimGasRequired: 55_000_000n,
      baseFee: 5_000_000_000n,
      primaryBridge: d.bitAdapter,
      maxFeeAbs: 5n * 10n ** 15n,
      maxFeeBps: 100n,
      /** the vault's largest chunk and its bridge's cap (read live 2026-10-31: a quote above the cap reverts) */
      maxMessageValue: 15n * 10n ** 18n,
      bridgeMaxMessageValue: 50n * 10n ** 18n,
      /** what quoteFee answers (a full chunk's fee, as the launch's adapter quoted it on 2026-10-31) */
      payoutFeeQuote: 1_315_669_376_468_497n,
      /** the addresses answering quoteFee: the Bittensor adapter, and any a test adds */
      quoteBridges: [d.bitAdapter] as Hex[],
      payoutBatches: {} as Record<Hex, { queuedAt: bigint; cursor: number; count: number; chunk: number; remaining: bigint }>,
      offRamp: {} as Record<Hex, number>,
      /** nonce() of each Safe on Bittensor */
      safes: {} as Record<Hex, bigint>,
      /** getThreshold() and getOwners() of each Safe on Bittensor */
      safeOwners: {} as Record<Hex, { threshold: bigint; owners: Hex[] }>,
      /** the validator storage of other hotkeys than the stake hotkey's (the standby's), by hotkey */
      storageOf: {} as Record<Hex, { delegates: Hex; totalHotkeyAlpha: Hex; uids: Hex }>,
      // v3.2 only: the vault keeps the token, ownership and pause surface and launchChain; the vault lens answers the rest
      launchChain: 8453n,
      /** the lens's target(): the vault it reads (DEPLOYMENT.vault unless a test points it elsewhere) */
      vaultLensTarget: d.vault as Hex,
      // booked below visible (rootStakeRao, 49e9): a gift of 1e9 rao not yet adopted
      bookedStake: 48n * 10n ** 9n,
      /** wei, as last written; lastStakeAt six hours before the head's time */
      rampingStake: 2n * 10n ** 18n,
      lastStakeAt: 1_799_978_400n,
      missingStakeRao: 0n,
      surplusStakeRao: 10n ** 9n,
      unlistedStakeRao: 0n,
      /** R6 (claim C): eth_estimateGas of getTotalColdkeyStakeOnSubnet(the vault's coldkey, root): the read's own gas and
       * the transaction's 21,000 (one listed hotkey with root stake, 16,875); an Error: the node refuses the estimate */
      writeOffReadEstimate: (21_000n + 16_875n) as bigint | Error,
      stakeMissing: false,
      grossAssets: 50n * 10n ** 18n,
      unvestedRewards: 4n * 10n ** 15n,
      vestingAmount: 5n * 10n ** 15n,
      vestingStart: 1_799_990_000n,
      vestingPeriod: 86_400n,
      /** the adoption drip (Revision 27), beside the claim schedule: none before the first adoption */
      adoptVestingAmount: 0n,
      adoptVestingStart: 0n,
      adoptVestingPeriod: 0n,
      rewardVesting: 86_400n,
      lastAdoptAt: 0n,
      idleBufferBps: 500,
      globalOutflowBps: 3000n,
      globalWindow: [1_799_000_000n, 2n * 10n ** 18n] as [bigint, bigint],
      /** activeDoors(chain) by chain id */
      activeDoors: { "8453": 1n } as Record<string, bigint>,
      /** doorState(peer) by peer id (Unknown 0, Active 1, Removed 2) */
      doorStates: {} as Record<Hex, number>,
      exits: { exitsOpen: true, ownerHold: false, guardianHold: false, pausedBy: 0, primaryDisabledBy: 0, launchDoorRemovedBy: 0, lastOwnerClose: 0n, lastGuardianClose: 0n, pendingSince: 0n },
      /** MS_PER_BLOCK, the deploy's calibration (Revision 28) */
      msPerBlock: 7_200n,
      /** scheduled(id): an id not listed answers the empty item */
      scheduled: {} as Record<Hex, ScheduledItemAnswer>,
      /** the limits a scheduled setter's direction is judged against, and the dust allowance a keeper's removal reads */
      maxEntryValue: 10n * 10n ** 18n,
      minChunk: 5,
      maxTotalAssets: 44n * 10n ** 18n,
      hotkeyDustRao: 1000n,
      /** getUnclaimedRootTaoByHotkey(coldkey, hotkey) of hotkeys other than the stake hotkey */
      unclaimedOf: {} as Record<Hex, bigint>,
      /** each Bittensor adapter's parks and reserve targets (the wTAO it holds: wTaoOf) */
      parks: { parkedNative: 3n * 10n ** 14n, parkedTokens: 0n, reserveTarget: 10n ** 15n, tokenReserveTarget: 10n ** 15n, tokenCushion: 10n ** 15n },
      /** wTAO.balanceOf of addresses other than the lock pool */
      wTaoOf: {} as Record<Hex, bigint>,
      /** each Bittensor adapter's peer (its remoteAdapter and remoteChainId) and, through the vault lens, whether the vault
       * has it enabled and has ever had it (bridgeEnabled, bridgeKnown): the launch rail's half, coherent */
      rails: { [d.bitAdapter]: { remoteAdapter: d.baseAdapter, remoteChainId: 8453n, enabled: true, known: true } } as Record<Hex, FakeRailHalf>,
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
      canClose: false,
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
      // slot0: the observations as the live pools hold them once TAO/WETH's has grown to its cardinalityNext
      taoWeth: { slot0: [79228162514264337593543950336n, 0, 0, 2000, 2000, 0, true] as [bigint, number, number, number, number, number, boolean], liquidity: 5n * 10n ** 18n, tao: 30n * 10n ** 18n, token0: cfg.tokens.base.fmTao },
      wethUsdc: { slot0: [3961408125713216879677197516800n, 0, 0, 5000, 5000, 0, true] as [bigint, number, number, number, number, number, boolean], liquidity: 9n * 10n ** 18n, token0: cfg.tokens.base.weth },
      /** the Base pool's buckets for the Bittensor lane, and whether it lists Bittensor (isSupportedChain) */
      lane: { inbound: bucket(5000n), outbound: bucket(5000n), supported: true },
      /** FM-TAO's TokenAdminRegistry entry (getTokenConfig) */
      registry: { administrator: FM_SAFE as Hex, pendingAdministrator: ZERO as Hex, tokenPool: cfg.tokens.base.tokenPool as Hex },
      oracleValue: 400_000_000n,
      /** QuoterV2: TAO wei a $1,000 deposit gets; USDC units per TAO a sale gets (the sale's amountIn is recorded in `asked.quoterIn`) */
      buyQuote: 2_450n * 10n ** 15n,
      sellUsdcPerTao: 395_000_000n,
      /** USDC.balanceOf(wethUsdcPool) */
      wethUsdcPoolUsdc: 12_000_000n * 10n ** 6n,
      keeperBalance: 10n ** 17n,
      /** the guardian's ETH on Base: its launch funding, 0.001 */
      guardianBalance: 10n ** 15n,
      /** R12a: the front door's redeemRequestFee: v3-launch's 0.0001 ETH, or v3.2's launch 0.0002 ETH (the founder,
       * 2026-11-16) */
      redeemRequestFee: d.version === "v3.2" ? 2n * 10n ** 14n : 10n ** 14n,
      /** R12a: what a Base bridge's quoteFee answers for a batch (the 0.0042646 ETH Base's router quoted for 7,000,000 gas on
       * 2026-10-21), and the addresses answering it: the Base adapter, and any a test adds */
      closeQuote: 4_264_600_000_000_000n,
      closeQuoteBridges: [d.baseAdapter] as Hex[],
      claimable: {} as Record<Hex, bigint>,
      deliveryOf: {} as Record<Hex, [bigint, bigint, number]>,
      /** `${bridge}:${messageHash}` → delivered */
      delivered: {} as Record<string, boolean>,
      offRamp: {} as Record<Hex, number>,
      /** nonce() of each Safe on Base */
      safes: {} as Record<Hex, bigint>,
      /** getThreshold() and getOwners() of each Safe on Base */
      safeOwners: {} as Record<Hex, { threshold: bigint; owners: Hex[] }>,
      // v3.2 only: the door lens answers the front door's base state
      /** the door lens's target(): the front door it reads */
      doorLensTarget: d.frontDoor as Hex,
      primaryBridge: d.baseAdapter,
      potCarried: 7n * 10n ** 13n,
      minDeposit: 3n * 10n ** 16n,
      maxDeliverySlippageBps: 150,
      minPoolLiquidity: [10n ** 17n, 10n ** 16n] as [bigint, bigint],
      meanLiquidity: [6n * 10n ** 17n, 2n * 10n ** 17n] as [bigint, bigint],
      minCardinality: 1_801,
      exits: { exitsOpen: true, ownerHold: false, guardianHold: false, primaryDisabledBy: 0, lastOwnerClose: 0n, lastGuardianClose: 0n, pendingSince: 0n },
      msPerBlock: 120n,
      scheduled: {} as Record<Hex, ScheduledItemAnswer>,
      /** FM-TAO.balanceOf of addresses other than the front door and the TAO/WETH pool */
      fmTaoOf: {} as Record<Hex, bigint>,
      /** ETH balances of addresses other than the front door and the keeper */
      ethOf: {} as Record<Hex, bigint>,
      /** each Base adapter's peer and, through the door lens, whether the front door has it enabled and known */
      rails: { [d.baseAdapter]: { remoteAdapter: d.bitAdapter, remoteChainId: 964n, enabled: true, known: true } } as Record<Hex, FakeRailHalf>,
    },
    /** eth_getTransactionCount per chain and address */
    nonces: { base: {} as Record<Hex, bigint>, bittensor: {} as Record<Hex, bigint> },
    /** what the readings asked of the views that take arguments */
    asked: {
      quoterIn: [] as bigint[],
      bucketSelectors: [] as string[],
      supportedSelectors: [] as string[],
      backingOf: [] as Hex[],
      quotes: [] as { bridge: Hex; destChain: bigint; recipient: Hex; entries: number; amount: bigint; sum: bigint }[],
      /** R12a: the Base bridges' close quotes: a batch message's deposits and redeem requests, and the deposits' sum */
      closeQuotes: [] as { bridge: Hex; destChain: bigint; recipient: Hex; deposits: number; redeems: number; amount: bigint; sum: bigint }[],
      /** every SubtensorModule storage key the 0x807 query was asked for */
      storageKeys: [] as Hex[],
      /** activeDoors(chain) and doorState(peer) as asked of the vault lens */
      activeDoorsOf: [] as bigint[],
      doorStateOf: [] as Hex[],
    },
  };
}

/** scheduled(id) as the lenses answer it (CascadeTypes.sol Item). */
export interface ScheduledItemAnswer {
  scheduledAt: bigint;
  readyAt: bigint;
  class: number;
  kind: number;
  selector: Hex;
  readyBlock: bigint;
}
const NO_ITEM: ScheduledItemAnswer = { scheduledAt: 0n, readyAt: 0n, class: 0, kind: 0, selector: "0x00000000", readyBlock: 0n };

/** v3.2: one adapter as a rail half: its immutables (remoteAdapter, remoteChainId), and its own chain's contract's
 * bridgeEnabled and bridgeKnown of it (the lens answers them; an address not listed reads false). */
export interface FakeRailHalf {
  remoteAdapter: Hex;
  remoteChainId: bigint;
  enabled: boolean;
  known: boolean;
  /** its setup (R4-O's fix round, Minor 8), else its chain's RAIL_SETUP: the same as the deploy's adapter's */
  router?: Hex;
  token?: Hex;
  remoteSelector?: bigint;
  alphaVault?: Hex;
  /** on Bittensor, canSendPayouts() (R4, S-H1): true unless given */
  canSendPayouts?: boolean;
}

/** What every rail half answers for its setup unless its FakeRailHalf says otherwise (R4-O's fix round, Minor 8): one
 * router, token and remote selector on each chain, and on Bittensor one AlphaVault, as the deploy's adapters share them. */
export const RAIL_SETUP = {
  base: { router: "0x00000000000000000000000000000000000c1b0a" as Hex, token: "0x00000000000000000000000000000000000c1b0b" as Hex, remoteSelector: 2135107236357186872n },
  bittensor: {
    router: "0x00000000000000000000000000000000000c1e0a" as Hex,
    token: "0x00000000000000000000000000000000000c1e0b" as Hex,
    remoteSelector: 15971525489660198786n,
    // the deploy's AlphaVault (TOKENS' in the test vars): the vault the monitor reads ForeverMoney's state at, until a switch
    alphaVault: "0x11837459896d96f821a8d88ec93a3c8d152033d4" as Hex,
  },
};

export type DeploymentState = ReturnType<typeof deploymentState>;

const lc = (a: unknown) => String(a).toLowerCase() as Hex;

/** A fake of both chains answering every view the readings ask, from `state`, at heads `heads`. */
export function fakeDeployment(cfg: Config, state: DeploymentState, o: { heads?: { base: bigint; bittensor: bigint }; lagBy?: { base?: bigint; bittensor?: bigint }; onFetch?: (f: FetchRecord) => void } = {}) {
  const d = cfg.deployment;
  const t = cfg.tokens;
  const heads = o.heads ?? { base: 37_100_000n, bittensor: 6_905_000n };
  const v =
    <T>(chain: string, name: string, value: (args: readonly unknown[]) => T) =>
    (args: readonly unknown[]) =>
      state.reverts.has(`${chain}.${name}`) ? REVERT : value(args);
  /** a token pool's buckets: either direction, asked by the remote chain's selector (recorded); and whether it lists that
   * chain, for its own remote selector only (any other reads false, as a live pool answers) */
  const lane = (chain: string, buckets: { inbound: ReturnType<typeof bucket>; outbound: ReturnType<typeof bucket>; supported: boolean }) => ({
    getCurrentInboundRateLimiterState: v(chain, "pool.inbound", ([sel]) => {
      state.asked.bucketSelectors.push(`${chain}:${sel}`);
      return buckets.inbound;
    }),
    getCurrentOutboundRateLimiterState: v(chain, "pool.outbound", ([sel]) => {
      state.asked.bucketSelectors.push(`${chain}:${sel}`);
      return buckets.outbound;
    }),
    isSupportedChain: v(chain, "pool.isSupportedChain", ([sel]) => {
      state.asked.supportedSelectors.push(`${chain}:${sel}`);
      return buckets.supported && sel === (chain === "base" ? CCIP_SELECTOR.bittensor : CCIP_SELECTOR.base);
    }),
  });
  /** a TokenAdminRegistry: the rail token's entry (getTokenConfig; another token's is all zeros, as a live registry answers) */
  const registry = (chain: "base" | "bittensor", entry: { administrator: Hex; pendingAdministrator: Hex; tokenPool: Hex }) => ({
    getTokenConfig: v(chain, "registry.getTokenConfig", ([token]) =>
      lc(token) === (chain === "base" ? t.base.fmTao : t.bittensor.fmTao) ? entry : { administrator: ZERO, pendingAdministrator: ZERO, tokenPool: ZERO },
    ),
  });
  const b = state.base;
  const x = state.bit;
  const balances = (chain: "base" | "bittensor") => (a: Hex) => {
    const k = lc(a);
    if (chain === "base") return k === d.frontDoor ? b.frontDoorEth : k === lc(b.keeper) ? b.keeperBalance : k === lc(b.guardian) ? b.guardianBalance : (b.ethOf[k] ?? 0n);
    return k === d.vault ? x.balance : k === d.bitAdapter ? x.adapterBalance : k === lc(x.keeper) ? x.keeperBalance : k === lc(x.guardian) ? x.guardianBalance : 0n;
  };
  const counts = (chain: "base" | "bittensor") => ([a]: readonly unknown[]) => `0x${(state.nonces[chain][lc(a)] ?? 0n).toString(16)}`;
  /** a Safe answers nonce() and, when listed in safeOwners, getThreshold() and getOwners() */
  const safesOf = (nonces: Record<Hex, bigint>, owners: Record<Hex, { threshold: bigint; owners: Hex[] }>) =>
    Object.fromEntries(
      [...new Set([...Object.keys(nonces), ...Object.keys(owners)])].map((a) => [
        a,
        {
          abi: [...SAFE, ...SAFE_OWNERS],
          fns: {
            nonce: () => nonces[a as Hex] ?? REVERT,
            getThreshold: () => owners[a as Hex]?.threshold ?? REVERT,
            getOwners: () => owners[a as Hex]?.owners ?? REVERT,
          },
        },
      ]),
    );
  const safeContracts = safesOf(b.safes, b.safeOwners);
  const bitSafeContracts = safesOf(x.safes, x.safeOwners);
  const v32 = d.version === "v3.2";
  const fnsOf = (c: FakeContracts, a: Hex): Fns => (c[a] as { fns: Fns }).fns;
  const omit = (f: Fns, ...names: string[]): Fns => Object.fromEntries(Object.entries(f).filter(([k]) => !names.includes(k)));
  const item = (m: Record<Hex, ScheduledItemAnswer>) => ([id]: readonly unknown[]) => m[lc(id)] ?? NO_ITEM;
  /** an adapter's immutables, as a rail half (a view listed in `reverts` as `${chain}.remoteAdapter` reverts) */
  const peerFns = (chain: "baseBridge" | "bridge", rails: Record<Hex, FakeRailHalf>, a: Hex): Fns => {
    const setup = chain === "baseBridge" ? RAIL_SETUP.base : RAIL_SETUP.bittensor;
    const field = (name: "router" | "token" | "remoteSelector") => v(chain, name, () => (rails[lc(a)] ? (rails[lc(a)][name] ?? setup[name]) : REVERT));
    return {
      remoteAdapter: v(chain, "remoteAdapter", () => rails[lc(a)]?.remoteAdapter ?? REVERT),
      remoteChainId: v(chain, "remoteChainId", () => rails[lc(a)]?.remoteChainId ?? REVERT),
      router: field("router"),
      token: field("token"),
      remoteSelector: field("remoteSelector"),
      ...(chain === "bridge"
        ? {
            alphaVault: v(chain, "alphaVault", () => (rails[lc(a)] ? (rails[lc(a)].alphaVault ?? RAIL_SETUP.bittensor.alphaVault) : REVERT)),
            // R4 (S-H1): as the adapter answers it, from its own AlphaVault's state (paused, a migration announced or
            // finished, or no such vault: false), unless the half says otherwise
            canSendPayouts: v(chain, "canSendPayouts", () => {
              const h = rails[lc(a)];
              if (!h) return REVERT;
              if (h.canSendPayouts !== undefined) return h.canSendPayouts;
              const named = lc(h.alphaVault ?? RAIL_SETUP.bittensor.alphaVault);
              const s = named === lc(t.bittensor.alphaVault) ? state.bit.alpha : state.bit.vaults[named];
              return !!s && !s.isPaused && s.migrationReadyAt === 0n && !s.migrationFinished;
            }),
          }
        : {}),
    };
  };
  /** a lens's bridgeEnabled and bridgeKnown, from the rail halves (an address not listed reads false, as the mapping) */
  const registryFns = (chain: "vault" | "doorLens", rails: Record<Hex, FakeRailHalf>): Fns => ({
    bridgeEnabled: v(chain, "bridgeEnabled", ([a]) => rails[lc(a)]?.enabled ?? false),
    bridgeKnown: v(chain, "bridgeKnown", ([a]) => rails[lc(a)]?.known ?? false),
  });
  /** v3.2's Base contracts in place of v3.1's: the front door without CascadeBase's getters, the door lens with them,
   * the oracle with its pool-depth views */
  const baseV32 = (c: FakeContracts): FakeContracts =>
    !v32
      ? c
      : {
          ...c,
          [d.frontDoor]: {
            abi: FRONT_DOOR_V32_VIEWS,
            fns: {
              ...omit(fnsOf(c, d.frontDoor), "guardian", "pendingGuardian"),
              potCarried: v("frontDoor", "potCarried", () => b.potCarried),
              minDeposit: v("frontDoor", "minDeposit", () => b.minDeposit),
              minPoolLiquidity: v("frontDoor", "minPoolLiquidity", ([i]) => (Number(i) < 2 ? b.minPoolLiquidity[Number(i)] : REVERT)),
              maxDeliverySlippageBps: v("frontDoor", "maxDeliverySlippageBps", () => b.maxDeliverySlippageBps),
            },
          },
          [d.doorLens as Hex]: {
            abi: DOOR_LENS_VIEWS,
            fns: {
              target: v("doorLens", "target", () => b.doorLensTarget),
              guardian: v("doorLens", "guardian", () => b.guardian),
              keeper: v("doorLens", "keeper", () => b.keeper),
              primaryBridge: v("doorLens", "primaryBridge", () => b.primaryBridge),
              exitsOpen: v("doorLens", "exitsOpen", () => b.exits.exitsOpen),
              ownerHold: v("doorLens", "ownerHold", () => b.exits.ownerHold),
              guardianHold: v("doorLens", "guardianHold", () => b.exits.guardianHold),
              primaryDisabledBy: v("doorLens", "primaryDisabledBy", () => b.exits.primaryDisabledBy),
              lastOwnerClose: v("doorLens", "lastOwnerClose", () => b.exits.lastOwnerClose),
              lastGuardianClose: v("doorLens", "lastGuardianClose", () => b.exits.lastGuardianClose),
              pendingSince: v("doorLens", "pendingSince", () => b.exits.pendingSince),
              MS_PER_BLOCK: v("doorLens", "MS_PER_BLOCK", () => b.msPerBlock),
              scheduled: v("doorLens", "scheduled", item(b.scheduled)),
              ...registryFns("doorLens", b.rails),
            },
          },
          // each Base adapter's immutables, as a rail half (beside its close quote, R12a, when it answers one)
          ...Object.fromEntries(
            Object.keys(b.rails).map((a) => {
              const quotes = c[a as Hex] as { abi: Abi; fns: Fns } | undefined;
              return [a, { abi: [...ADAPTER_PEER_VIEWS, ...(quotes?.abi ?? [])], fns: { ...(quotes?.fns ?? {}), ...peerFns("baseBridge", b.rails, a as Hex) } }];
            }),
          ),
          [d.oracle]: {
            abi: ORACLE_V32,
            fns: {
              usdcValue: v("base", "oracle.usdcValue", () => b.oracleValue),
              meanLiquidity: v("base", "oracle.meanLiquidity", () => b.meanLiquidity),
              MIN_CARDINALITY: v("base", "oracle.MIN_CARDINALITY", () => b.minCardinality),
            },
          },
        };
  /** v3.2's vault: its token, ownership and pause surface and launchChain only; the vault lens answers the rest */
  const bitV32 = (c: FakeContracts): FakeContracts => {
    if (!v32) return c;
    const vaultFns = fnsOf(c, d.vault);
    return {
      ...c,
      // the rail halves that answer no fee quote (the quote bridges answer their immutables themselves)
      ...Object.fromEntries(
        Object.keys(x.rails)
          .filter((a) => !x.quoteBridges.map(lc).includes(lc(a)))
          .map((a) => [a, { abi: BIT_RAIL_VIEWS, fns: peerFns("bridge", x.rails, a as Hex) }]),
      ),
      [d.vault]: {
        abi: VAULT_V32_VIEWS,
        fns: { owner: vaultFns.owner, pendingOwner: vaultFns.pendingOwner, paused: vaultFns.paused, totalSupply: vaultFns.totalSupply, launchChain: v("vault", "launchChain", () => x.launchChain) },
      },
      [d.vaultLens as Hex]: {
        abi: VAULT_LENS_VIEWS,
        fns: {
          ...omit(vaultFns, "owner", "pendingOwner", "paused", "pendingGuardian", "rootStakeRao"),
          target: v("vault", "target", () => x.vaultLensTarget),
          visibleStakeRao: v("vault", "visibleStakeRao", () => x.rootStakeRao),
          bookedStake: v("vault", "bookedStake", () => x.bookedStake),
          rampingStake: v("vault", "rampingStake", () => x.rampingStake),
          lastStakeAt: v("vault", "lastStakeAt", () => x.lastStakeAt),
          missingStakeRao: v("vault", "missingStakeRao", () => x.missingStakeRao),
          surplusStakeRao: v("vault", "surplusStakeRao", () => x.surplusStakeRao),
          unlistedStakeRao: v("vault", "unlistedStakeRao", () => x.unlistedStakeRao),
          stakeMissing: v("vault", "stakeMissing", () => x.stakeMissing),
          grossAssets: v("vault", "grossAssets", () => x.grossAssets),
          unvestedRewards: v("vault", "unvestedRewards", () => x.unvestedRewards),
          vestingAmount: v("vault", "vestingAmount", () => x.vestingAmount),
          vestingStart: v("vault", "vestingStart", () => x.vestingStart),
          vestingPeriod: v("vault", "vestingPeriod", () => x.vestingPeriod),
          adoptVestingAmount: v("vault", "adoptVestingAmount", () => x.adoptVestingAmount),
          adoptVestingStart: v("vault", "adoptVestingStart", () => x.adoptVestingStart),
          adoptVestingPeriod: v("vault", "adoptVestingPeriod", () => x.adoptVestingPeriod),
          rewardVesting: v("vault", "rewardVesting", () => x.rewardVesting),
          lastAdoptAt: v("vault", "lastAdoptAt", () => x.lastAdoptAt),
          idleBufferBps: v("vault", "idleBufferBps", () => x.idleBufferBps),
          globalOutflowBps: v("vault", "globalOutflowBps", () => x.globalOutflowBps),
          burnWindows: v("vault", "burnWindows", ([peer]) => (lc(peer) === `0x${"00".repeat(32)}` ? x.globalWindow : x.burnWindow)),
          activeDoors: v("vault", "activeDoors", ([chain]) => {
            state.asked.activeDoorsOf.push(chain as bigint);
            return x.activeDoors[String(chain)] ?? 0n;
          }),
          doorState: v("vault", "doorState", ([peer]) => {
            state.asked.doorStateOf.push(lc(peer));
            return x.doorStates[lc(peer)] ?? 0;
          }),
          exitsOpen: v("vault", "exitsOpen", () => x.exits.exitsOpen),
          ownerHold: v("vault", "ownerHold", () => x.exits.ownerHold),
          guardianHold: v("vault", "guardianHold", () => x.exits.guardianHold),
          pausedBy: v("vault", "pausedBy", () => x.exits.pausedBy),
          primaryDisabledBy: v("vault", "primaryDisabledBy", () => x.exits.primaryDisabledBy),
          launchDoorRemovedBy: v("vault", "launchDoorRemovedBy", () => x.exits.launchDoorRemovedBy),
          lastOwnerClose: v("vault", "lastOwnerClose", () => x.exits.lastOwnerClose),
          lastGuardianClose: v("vault", "lastGuardianClose", () => x.exits.lastGuardianClose),
          pendingSince: v("vault", "pendingSince", () => x.exits.pendingSince),
          MS_PER_BLOCK: v("vault", "MS_PER_BLOCK", () => x.msPerBlock),
          scheduled: v("vault", "scheduled", item(x.scheduled)),
          maxEntryValue: v("vault", "maxEntryValue", () => x.maxEntryValue),
          minChunk: v("vault", "minChunk", () => x.minChunk),
          maxTotalAssets: v("vault", "maxTotalAssets", () => x.maxTotalAssets),
          hotkeyDustRao: v("vault", "hotkeyDustRao", () => x.hotkeyDustRao),
          ...registryFns("vault", x.rails),
        },
      },
    };
  };
  const baseSpec: ChainSpec = {
    head: heads.base,
    lagBy: o.lagBy?.base,
    blockTime: (n) => 1_800_000_000 + Number(n - heads.base) * 2,
    calls: {
      eth_getTransactionCount: counts("base"),
      eth_call: ethCall(
        baseV32({
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
              canClose: v("frontDoor", "canClose", () => b.canClose),
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
              redeemRequestFee: v("frontDoor", "redeemRequestFee", () => b.redeemRequestFee),
            },
          },
          // R12a: each Base bridge's fee for a batch (CascadeMessages.encodeBatch: kind, id, deposits, redeems)
          ...Object.fromEntries(
            b.closeQuoteBridges.map((bridge) => [
              bridge,
              {
                abi: BRIDGE_VIEWS,
                fns: {
                  quoteFee: v("baseBridge", "quoteFee", ([destChain, recipient, message, amount]) => {
                    const entry = { type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }] } as const;
                    const [, , deposits, redeems] = decodeAbiParameters([{ type: "uint8" }, { type: "uint64" }, entry, entry], message as Hex);
                    const sum = (deposits as readonly (readonly [Hex, bigint])[]).reduce((t, e) => t + e[1], 0n);
                    state.asked.closeQuotes.push({ bridge: lc(bridge), destChain: destChain as bigint, recipient: lc(recipient), deposits: deposits.length, redeems: redeems.length, amount: amount as bigint, sum });
                    return b.closeQuote;
                  }),
                },
              },
            ]),
          ),
          [d.staker]: { abi: [...ADMIN_VIEWS, ...TREASURY], fns: { owner: () => b.stakerOwner, pendingOwner: () => b.stakerPendingOwner, treasury: () => b.stakerTreasury } },
          [t.base.fmTao]: {
            abi: ERC20,
            fns: { totalSupply: v("fmTao", "totalSupply", () => b.fmTaoSupply), balanceOf: ([a]) => (lc(a) === d.frontDoor ? b.frontDoorTao : lc(a) === t.base.taoWethPool ? b.taoWeth.tao : (b.fmTaoOf[lc(a)] ?? 0n)) },
          },
          [t.base.usdc]: { abi: ERC20, fns: { balanceOf: v("base", "usdc.balanceOf", ([a]) => (lc(a) === t.base.wethUsdcPool ? b.wethUsdcPoolUsdc : 0n)) } },
          [UNISWAP_QUOTER]: {
            abi: QUOTER_V2,
            fns: {
              quoteExactInput: v("base", "quoter", ([path, amountIn]) => {
                state.asked.quoterIn.push(amountIn as bigint);
                const out = lc(path) === lc(PATH_USDC_TO_TAO) ? b.buyQuote : ((amountIn as bigint) * b.sellUsdcPerTao) / 10n ** 18n;
                return [out, [0n], [0], 150_000n];
              }),
            },
          },
          [t.base.taoWethPool]: { abi: UNISWAP_POOL, fns: { slot0: () => b.taoWeth.slot0, liquidity: () => b.taoWeth.liquidity, token0: () => b.taoWeth.token0 } },
          [t.base.wethUsdcPool]: { abi: UNISWAP_POOL, fns: { slot0: () => b.wethUsdc.slot0, liquidity: () => b.wethUsdc.liquidity, token0: () => b.wethUsdc.token0 } },
          [d.oracle]: { abi: ORACLE, fns: { usdcValue: v("base", "oracle.usdcValue", () => b.oracleValue) } },
          [t.base.offRamp]: { abi: OFFRAMP, fns: { getExecutionState: ([id]) => b.offRamp[lc(id)] ?? 0 } },
          [t.base.tokenPool]: { abi: TOKEN_POOL, fns: lane("base", b.lane) },
          [t.base.tokenAdminRegistry]: { abi: TOKEN_ADMIN_REGISTRY, fns: registry("base", b.registry) },
          ...safeContracts,
        }),
        // the reading's block time is the spec's, so a test can change Base's block time (its 200 ms blocks since 2026-11-05)
        { time: (at) => baseSpec.blockTime!(at), balance: balances("base") },
      ),
    },
  };
  const bitSpec: ChainSpec = {
    head: heads.bittensor,
    lagBy: o.lagBy?.bittensor,
    blockTime: (n) => 1_800_000_000 + Number(n - heads.bittensor) * 12,
    calls: {
      eth_getTransactionCount: counts("bittensor"),
      // R6 (claim C): the write-off's aggregate read, priced by the node
      eth_estimateGas: () => {
        const e = x.writeOffReadEstimate;
        if (e instanceof Error) throw e;
        return numberToHex(e);
      },
      eth_call: ethCall(
        bitV32({
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
              claimGasRequired: v("vault", "claimGasRequired", () => x.claimGasRequired),
              maxFeeAbs: () => x.maxFeeAbs,
              maxFeeBps: () => x.maxFeeBps,
              primaryBridge: () => x.primaryBridge,
              maxMessageValue: () => x.maxMessageValue,
              getPayoutBatch: v("vault", "getPayoutBatch", ([key]) => {
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
              }),
            },
          },
          [STAKING_PRECOMPILE]: {
            abi: STAKING,
            fns: { getStake: ([hk]) => x.stakes[lc(hk)] ?? 0n, getUnclaimedRootTaoByHotkey: ([, hk]) => x.unclaimedOf[lc(hk)] ?? x.unclaimed },
          },
          [STORAGE_QUERY]: {
            raw: (key) => {
              state.asked.storageKeys.push(key);
              // another hotkey's validator storage (the standby's): its key ends with, or holds, that hotkey
              const other = Object.entries(x.storageOf).find(([hk]) => key.includes(hk.slice(2).toLowerCase()))?.[1];
              const s = other ? { ...x.storage, ...other } : x.storage;
              return key.startsWith(STAKING_HOTKEYS_PREFIX)
                ? encodeAccountIds(x.stakingHotkeys)
                : key.startsWith(DELEGATES_PREFIX)
                  ? s.delegates
                  : key.startsWith(TOTAL_HOTKEY_ALPHA_PREFIX)
                    ? s.totalHotkeyAlpha
                    : key.startsWith(UIDS_PREFIX)
                      ? s.uids
                      : key === ROOT_STAKE_UNLOCK_INTERVAL_KEY
                        ? x.storage.unlockInterval
                        : x.hotkeyOwner === null
                          ? "0x"
                          : x.hotkeyOwner;
            },
          },
          [t.bittensor.fmTao]: {
            abi: ERC20,
            fns: { balanceOf: ([a]) => (lc(a) === t.bittensor.lockPool ? x.lockPoolFmTao : (x.wTaoOf[lc(a)] ?? 0n)), totalSupply: v("wTao", "totalSupply", () => x.wTaoSupply) },
          },
          [t.bittensor.alphaVault]: {
            abi: ALPHA_VAULT,
            fns: {
              isPaused: () => x.alpha.isPaused,
              migrationReadyAt: () => x.alpha.migrationReadyAt,
              migrationFinished: () => x.alpha.migrationFinished,
              pausedUntil: () => x.alpha.pausedUntil,
              pauseableAfter: () => x.alpha.pauseableAfter,
              migrationTarget: () => x.alpha.migrationTarget,
              migrationExecuted: () => x.alpha.migrationExecuted,
              pendingDefaultAdmin: () => x.alpha.pendingAdmin,
              backing: v("alphaVault", "backing", ([token]) => {
                state.asked.backingOf.push(lc(token));
                return x.alpha.backing;
              }),
            },
          },
          // ForeverMoney's other AlphaVaults (R4-O round 4)
          ...Object.fromEntries(
            Object.entries(x.vaults).map(([a, s]) => [
              a,
              {
                abi: ALPHA_VAULT,
                fns: {
                  isPaused: () => s.isPaused,
                  migrationReadyAt: () => s.migrationReadyAt,
                  migrationFinished: () => s.migrationFinished,
                  pausedUntil: () => s.pausedUntil,
                  pauseableAfter: () => s.pauseableAfter,
                  migrationTarget: () => s.migrationTarget,
                  migrationExecuted: () => s.migrationExecuted,
                  pendingDefaultAdmin: () => s.pendingAdmin,
                  backing: () => s.backing,
                },
              },
            ]),
          ),
          [t.bittensor.lockPool]: { abi: [...TOKEN_POOL, ...LOCK_POOL], fns: { ...lane("bittensor", x.lane), getRebalancer: v("bittensor", "pool.getRebalancer", () => x.rebalancer) } },
          [t.bittensor.tokenAdminRegistry]: { abi: TOKEN_ADMIN_REGISTRY, fns: registry("bittensor", x.registry) },
          ...Object.fromEntries(
            x.quoteBridges.map((bridge) => [
              bridge,
              {
                abi: [...BRIDGE_VIEWS, ...BIT_ADAPTER_V32_VIEWS, ...BIT_RAIL_VIEWS],
                fns: {
                  // v3.2's immutables as a rail half, parks and targets (v3.1's readings never ask)
                  ...peerFns("bridge", x.rails, bridge),
                  parkedNative: v("bridge", "parkedNative", () => x.parks.parkedNative),
                  parkedTokens: v("bridge", "parkedTokens", () => x.parks.parkedTokens),
                  RESERVE_TARGET: v("bridge", "RESERVE_TARGET", () => x.parks.reserveTarget),
                  TOKEN_RESERVE_TARGET: v("bridge", "TOKEN_RESERVE_TARGET", () => x.parks.tokenReserveTarget),
                  tokenCushion: v("bridge", "tokenCushion", () => x.parks.tokenCushion),
                  quoteFee: v("bridge", "quoteFee", ([destChain, recipient, message, amount]) => {
                    const [, , , entries] = decodeAbiParameters(
                      [{ type: "uint8" }, { type: "bytes32" }, { type: "uint32" }, { type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }] }],
                      message as Hex,
                    );
                    // the adapter's _checkSend: MessageTooLarge
                    if ((amount as bigint) > x.bridgeMaxMessageValue) return REVERT;
                    const sum = (entries as readonly (readonly [Hex, bigint])[]).reduce((t, e) => t + e[1], 0n);
                    state.asked.quotes.push({ bridge: lc(bridge), destChain: destChain as bigint, recipient: lc(recipient), entries: entries.length, amount: amount as bigint, sum });
                    return x.payoutFeeQuote;
                  }),
                  maxMessageValue: () => x.bridgeMaxMessageValue,
                },
              },
            ]),
          ),
          [t.bittensor.offRamp]: { abi: OFFRAMP, fns: { getExecutionState: ([id]) => x.offRamp[lc(id)] ?? 0 } },
          ...bitSafeContracts,
        }),
        { time: (at) => 1_800_000_000 + Number(at - heads.bittensor) * 12, balance: balances("bittensor"), baseFee: () => x.baseFee },
      ),
    },
  };
  const net = fakeChains({ base: baseSpec, bittensor: bitSpec }, { onFetch: o.onFetch });
  const budget = new Budget(45);
  const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget, sleep: async () => {}, spacingMs: { base: 0, bittensor: 0 } });
  return { net, rpc, budget, heads, specs: { base: baseSpec, bittensor: bitSpec } };
}

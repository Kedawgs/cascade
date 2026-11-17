import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { doorParksOf, flowOf, type AdminLog, type FlowInput, type FlowV1, STALE_AFTER_S } from "../../src/flow.ts";
import { PARK_TIMEOUT_S } from "../../src/parks.ts";
import { slog } from "./rule-ctx.ts";
import type { TrackedItem } from "../../src/scheduler.ts";
import type { BaseState, BitState, Bucket, ChainReading, Exits, ScheduledItem } from "../../src/snapshot.ts";
import { testConfig, testConfigV32, tx } from "./fixtures.ts";

const cfg = testConfig();
const d = cfg.deployment;
const NOW = 1_800_000_000;
const E18 = 10n ** 18n;
const HK1 = ("0x" + "11".repeat(32)) as `0x${string}`;
const HK2 = ("0x" + "22".repeat(32)) as `0x${string}`;
const bucket = (o: Partial<Bucket> = {}): Bucket => ({ tokens: 5n * E18, isEnabled: true, capacity: 20n * E18, rate: E18 / 100n, ...o });

const baseState = (o: Partial<BaseState> = {}): BaseState => ({
  taoWethPool: {},
  wethUsdcPool: {},
  claimable: {},
  deliveryOf: {},
  fmTaoSupply: 1000n * E18,
  buyQuote1000: 3n * E18,
  wethUsdcPoolUsdc: 7_000_000_000n,
  oracleValue: 300_000_000n,
  paused: false,
  // the Base pool's buckets: outbound to Bittensor (5 TAO left), inbound from it (6)
  lane: { outbound: bucket(), inbound: bucket({ tokens: 6n * E18 }), supported: true },
  ...o,
});
const bitState = (o: Partial<BitState> = {}): BitState => ({
  stakes: {},
  payoutBatches: {},
  alpha: { backing: 1000n * E18 },
  wTaoSupply: 1000n * E18,
  lockPoolFmTao: 1000n * E18,
  totalAssets: 500n * E18,
  price: E18,
  pendingPayouts: 0n,
  paused: false,
  // the lock pool's buckets: outbound to Base (2 TAO left), inbound from it (7)
  lane: { outbound: bucket({ tokens: 2n * E18 }), inbound: bucket({ tokens: 7n * E18 }), supported: true },
  ...o,
});
const rd = <T>(state: T, age = 10): ChainReading<T> => ({ block: 123n, time: NOW - age, state });
const input = (o: Partial<FlowInput> = {}): FlowInput => ({
  base: rd(baseState()),
  bittensor: rd(bitState()),
  inFlight: { toBittensor: 1, toBase: 2 },
  adminLogs: [],
  cfg,
  nowS: NOW,
  ...o,
});
const log = (o: Partial<AdminLog> & { event: string }): AdminLog => ({
  chain: "base",
  address: d.frontDoor,
  args: {},
  txHash: tx(1),
  block: 1,
  ...o,
});

describe("flowOf", () => {
  it("stalesOneChainOnly", () => {
    const f = flowOf(input({ bittensor: rd(bitState(), STALE_AFTER_S + 1) }));
    expect(f.chains.bittensor?.stale).toBe(true);
    expect(f.chains.base?.stale).toBe(false);
    expect(f.vault.totalAssets).toBeNull();
    expect(f.vault.paused).toBeNull();
    expect(f.bridgeOut.roomLeft).toBeNull();
    expect(f.bridgeOut.enabled).toBeNull();
    expect(f.bridgeOut.inFlight).toBe(2);
    expect(f.backing.alphaBacking).toBeNull();
    expect(f.swap.buyQuote1000Tao).toBe((3n * E18).toString());
    // the bridge in needs both pools: the stale Bittensor half's inbound bucket is unknown, so its room is
    expect(f.bridgeIn.roomLeft).toBeNull();
    expect(f.bridgeIn.supported).toBeNull();
    expect(f.frontDoor.paused).toBe(false);
    // 600 s exactly is still fresh
    expect(flowOf(input({ bittensor: rd(bitState(), STALE_AFTER_S) })).chains.bittensor?.stale).toBe(false);
  });

  it("aMissingHalfIsNull", () => {
    const f = flowOf(input({ base: null, bittensor: null }));
    expect(f.chains).toEqual({ base: null, bittensor: null });
    expect(f.swap.spotUsdcPerTao).toBeNull();
    expect(f.swap.sellQuote).toBeNull();
    expect(f.backing.ratioPpm).toBeNull();
    expect(f.frontDoor.paused).toBeNull();
    expect(f.validator.hotkey).toBeNull();
    // unknown, never "none"
    expect(f.validator.backups).toBeNull();
    expect(f.batch.nextSendAt).toBeNull();
    expect(f.vault.nextPayoutAt).toBeNull();
    expect(f.vault.paused).toBeNull();
    expect(f.addresses.vault).toBe(d.vault);
    // a stale Base half leaves the lock layer unknown, so the ratio is unknown: never the AlphaVault layer alone
    const g = flowOf(input({ base: rd(baseState(), 9999), bittensor: rd(bitState({ alpha: { backing: 999n * E18 } })) }));
    expect(g.backing.ratioPpm).toBeNull();
    expect(g.backing.fmTaoSupplyBase).toBeNull();
    expect(g.backing.alphaBacking).toBe((999n * E18).toString());
  });

  it("backingTakesTheLowerLayer", () => {
    const f = flowOf(input({ bittensor: rd(bitState({ alpha: { backing: (1000n * E18 * 10002n) / 10000n }, lockPoolFmTao: (1000n * E18 * 9990n) / 10000n })) }));
    expect(f.backing.ratioPpm).toBe(999_000);
    const g = flowOf(input({ bittensor: rd(bitState({ alpha: { backing: (1000n * E18 * 9980n) / 10000n } })) }));
    expect(g.backing.ratioPpm).toBe(998_000);
  });

  it("backing needs both layers known: never a better number than the weaker layer", () => {
    // the reviewer's case: Base minted unbacked (FM-TAO's supply 20,000 against a lock of 13,985.61), its reading stale.
    // The AlphaVault layer alone would read 100.04%; the lock layer, unseen, is at 69.9%.
    const bit = bitState({ alpha: { backing: 13_992_600n * 10n ** 15n }, wTaoSupply: 13_985_650n * 10n ** 15n, lockPoolFmTao: 13_985_610n * 10n ** 15n });
    const inflated = baseState({ fmTaoSupply: 20_000n * E18 });
    const stale = flowOf(input({ base: rd(inflated, STALE_AFTER_S + 100), bittensor: rd(bit) }));
    expect(stale.backing.ratioPpm).toBeNull();
    // the same reading fresh: the lock layer is the weaker, and it counts
    expect(flowOf(input({ base: rd(inflated), bittensor: rd(bit) })).backing.ratioPpm).toBe(699_280);
    // no Base reading at all
    expect(flowOf(input({ base: null, bittensor: rd(bit) })).backing.ratioPpm).toBeNull();
    // any one of the four amounts unread leaves the ratio unknown
    expect(flowOf(input({ bittensor: rd(bitState({ alpha: {} })) })).backing.ratioPpm).toBeNull();
    expect(flowOf(input({ bittensor: rd(bitState({ wTaoSupply: undefined })) })).backing.ratioPpm).toBeNull();
    expect(flowOf(input({ bittensor: rd(bitState({ lockPoolFmTao: undefined })) })).backing.ratioPpm).toBeNull();
    expect(flowOf(input({ base: rd(baseState({ fmTaoSupply: undefined })) })).backing.ratioPpm).toBeNull();
    // a stale Bittensor half leaves it unknown too
    expect(flowOf(input({ bittensor: rd(bitState(), STALE_AFTER_S + 1) })).backing.ratioPpm).toBeNull();
  });

  it("zeroSupplyIsNotInfinity", () => {
    const f = flowOf(input({ bittensor: rd(bitState({ wTaoSupply: 0n, lockPoolFmTao: 990n * E18 })) }));
    expect(f.backing.ratioPpm).toBe(990_000);
    const s = JSON.stringify(flowOf(input({ base: rd(baseState({ fmTaoSupply: 0n })), bittensor: rd(bitState({ wTaoSupply: 0n })) })));
    expect(s).not.toMatch(/Infinity|NaN/);
    expect(flowOf(input({ base: rd(baseState({ fmTaoSupply: 0n })), bittensor: rd(bitState({ wTaoSupply: 0n })) })).backing.ratioPpm).toBeNull();
  });

  it("a bridge direction's room is the tighter of the source pool's outbound and the destination pool's inbound", () => {
    const f = flowOf(input());
    // in: Base's outbound (5 TAO) binds before the lock pool's inbound (7)
    expect(f.bridgeIn).toEqual({ roomLeft: (5n * E18).toString(), capacity: (20n * E18).toString(), perHour: (36n * E18).toString(), enabled: true, supported: true, inFlight: 1 });
    // out: the lock pool's outbound (2) binds before Base's inbound (6)
    expect(f.bridgeOut).toEqual({ roomLeft: (2n * E18).toString(), capacity: (20n * E18).toString(), perHour: (36n * E18).toString(), enabled: true, supported: true, inFlight: 2 });
    // a tighter destination binds, with its own capacity and refill
    const tight = bucket({ tokens: 3n * E18, capacity: 10n * E18, rate: 1000n });
    const g = flowOf(input({ bittensor: rd(bitState({ lane: { outbound: bucket(), inbound: tight, supported: true } })) }));
    expect(g.bridgeIn).toEqual({ roomLeft: (3n * E18).toString(), capacity: (10n * E18).toString(), perHour: "3600000", enabled: true, supported: true, inFlight: 1 });
    const h = flowOf(input({ base: rd(baseState({ lane: { outbound: bucket(), inbound: tight, supported: true } })), bittensor: rd(bitState({ lane: { outbound: bucket({ tokens: 9n * E18 }), inbound: bucket(), supported: true } })) }));
    expect(h.bridgeOut.roomLeft).toBe((3n * E18).toString());
    // either bucket unread, or either chain without a fresh reading: unknown
    const unknown = { roomLeft: null, capacity: null, perHour: null, enabled: null, supported: null, inFlight: 1 };
    expect(flowOf(input({ base: rd(baseState({ lane: undefined })) })).bridgeIn).toEqual(unknown);
    expect(flowOf(input({ bittensor: rd(bitState({ lane: { outbound: bucket(), supported: true } })) })).bridgeIn).toEqual({ ...unknown, supported: true });
    expect(flowOf(input({ base: rd(baseState(), STALE_AFTER_S + 1) })).bridgeIn).toEqual(unknown);
    expect(flowOf(input({ bittensor: null })).bridgeIn).toEqual(unknown);
  });

  it("a limiter that is off is no limit, never switched off; only a lane no longer listed is closed", () => {
    // CCIP stores a limiter switched off as capacity, rate and tokens 0, and lets transfers through unlimited
    const off: Bucket = { tokens: 0n, isEnabled: false, capacity: 0n, rate: 0n };
    const none = { roomLeft: null, capacity: null, perHour: null };
    // one side off: the other side binds
    const a = flowOf(input({ base: rd(baseState({ lane: { outbound: off, inbound: bucket(), supported: true } })) }));
    expect(a.bridgeIn).toEqual({ roomLeft: (7n * E18).toString(), capacity: (20n * E18).toString(), perHour: (36n * E18).toString(), enabled: true, supported: true, inFlight: 1 });
    // both sides off: no limit at all
    const b = flowOf(input({ base: rd(baseState({ lane: { outbound: off, inbound: bucket(), supported: true } })), bittensor: rd(bitState({ lane: { outbound: bucket(), inbound: off, supported: true } })) }));
    expect(b.bridgeIn).toEqual({ ...none, enabled: false, supported: true, inFlight: 1 });
    expect(b.bridgeOut.enabled).toBe(true);
    // a lane removed from either pool reads all zeros and off as well, and isSupportedChain false: closed, both ways
    const c = flowOf(input({ base: rd(baseState({ lane: { outbound: off, inbound: off, supported: false } })) }));
    expect(c.bridgeIn).toEqual({ ...none, enabled: null, supported: false, inFlight: 1 });
    expect(c.bridgeOut).toEqual({ ...none, enabled: null, supported: false, inFlight: 2 });
    expect(flowOf(input({ bittensor: rd(bitState({ lane: { outbound: off, inbound: off, supported: false } })) })).bridgeIn.supported).toBe(false);
    // support unread (or a reading from before it was read): unknown, never assumed
    const u = flowOf(input({ base: rd(baseState({ lane: { outbound: bucket(), inbound: bucket() } })) }));
    expect(u.bridgeIn).toEqual({ ...none, enabled: null, supported: null, inFlight: 1 });
    expect(u.bridgeOut.supported).toBeNull();
  });

  it("nextSendOnlyWithSomethingInTheBatch", () => {
    const ob = { id: 1n, start: NOW - 100, totalDeposits: 0n, feePot: 0n, nDeposits: 0, nRedeems: 0 };
    // interval null: batchInterval unread
    const at = (o: Partial<typeof ob>, interval: number | null = 3600) => flowOf(input({ base: rd(baseState({ openBatch: { ...ob, ...o }, batchInterval: interval ?? undefined })) })).batch.nextSendAt;
    // an empty open batch: known to hold nothing
    expect(at({})).toBe("none");
    expect(at({}, null)).toBe("none");
    expect(at({ nDeposits: 1 })).toBe(NOW - 100 + 3600);
    expect(at({ nRedeems: 2 })).toBe(NOW - 100 + 3600);
    // unread: unknown, never "none"
    expect(at({ nDeposits: 1 }, null)).toBeNull();
    expect(flowOf(input({ base: rd(baseState({ openBatch: undefined, batchInterval: 3600 })) })).batch.nextSendAt).toBeNull();
    expect(flowOf(input({ base: rd(baseState({ openBatch: { ...ob, nDeposits: 1 }, batchInterval: 3600 }), STALE_AFTER_S + 1) })).batch.nextSendAt).toBeNull();
  });

  it("nextPayoutIsTheEarliestBatch", () => {
    const b = (queuedAt: number) => ({ queuedAt, cursor: 0, count: 1, chunk: 1, remaining: 1n });
    const f = flowOf(input({ bittensor: rd(bitState({ payoutDelay: 1000, payoutBatches: { [HK1]: b(NOW - 50), [HK2]: b(NOW - 500) } })) }));
    expect(f.vault.nextPayoutAt).toBe(NOW - 500 + 1000);
    expect(flowOf(input({ bittensor: rd(bitState({ payoutDelay: 1000 })) })).vault.nextPayoutAt).toBe("none");
    // a batch that has just finished reads count 0 and a zeroed struct: skipped, never a 1970 time
    const done = { queuedAt: 0, cursor: 0, count: 0, chunk: 0, remaining: 0n };
    expect(flowOf(input({ bittensor: rd(bitState({ payoutDelay: 1000, payoutBatches: { [HK1]: done } })) })).vault.nextPayoutAt).toBe("none");
    expect(flowOf(input({ bittensor: rd(bitState({ payoutDelay: 1000, payoutBatches: { [HK1]: done, [HK2]: b(NOW - 50) } })) })).vault.nextPayoutAt).toBe(NOW - 50 + 1000);
    // the delay unread, or a batch's read failed: unknown, never "none"
    expect(flowOf(input({ bittensor: rd(bitState({ payoutBatches: { [HK1]: b(NOW) } })) })).vault.nextPayoutAt).toBeNull();
    expect(flowOf(input({ bittensor: rd(bitState({ payoutDelay: 1000, payoutBatchFailed: true })) })).vault.nextPayoutAt).toBeNull();
    expect(flowOf(input({ bittensor: rd(bitState({ payoutDelay: 1000 }), STALE_AFTER_S + 1) })).vault.nextPayoutAt).toBeNull();
  });

  it("an unread pause or hotkey set is unknown, never \"not paused\" or \"no backup\"", () => {
    const f = flowOf(input({ base: rd(baseState({ paused: undefined })), bittensor: rd(bitState({ paused: undefined, stakeHotkey: HK1, hotkeys: undefined })) }));
    expect(f.frontDoor.paused).toBeNull();
    expect(f.vault.paused).toBeNull();
    expect(f.validator.backups).toBeNull();
    // the vault's set holding only the stake hotkey: known, no backup
    expect(flowOf(input({ bittensor: rd(bitState({ stakeHotkey: HK1, hotkeys: [HK1] })) })).validator.backups).toEqual([]);
  });

  it("takeDefaultsTo1800", () => {
    const take = (t: number | null | undefined) => flowOf(input({ bittensor: rd(bitState({ stakeHotkey: HK1, validator: { hotkey: HK1, take: t } })) })).validator.takeBps;
    expect(take(null)).toBe(1800);
    expect(take(11_796)).toBe(1800);
    expect(take(65_535)).toBe(10_000);
    expect(take(undefined)).toBeNull();
  });

  it("backupsExcludeTheStakeHotkey", () => {
    const f = flowOf(input({ bittensor: rd(bitState({ stakeHotkey: HK1, hotkeys: [HK1, HK2], stakes: { [HK1]: 42n } })) }));
    expect(f.validator.backups).toEqual([HK2]);
    expect(f.validator.hotkey).toBe(HK1);
    expect(f.validator.ourStake).toBe("42");
  });

  it("spotPriceFromBothPools", () => {
    const tb = cfg.tokens.base;
    // 1 TAO = 0.0001 WETH, 1 WETH = 3000 USDC -> 0.3 USDC; with the WETH/USDC pool as token0=USDC, and TAO token1
    const Q96 = 1n << 96n;
    const isqrt = (n: bigint) => { let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
    // tao token0: weth_raw per tao_raw = 1e-4
    const sqrtA = isqrt((Q96 * Q96) / 10_000n);
    // weth token0: usdc_raw per weth_raw = 3000e6/1e18 = 3e-9
    const sqrtB = isqrt((Q96 * Q96 * 3n) / 1_000_000_000n);
    const f = flowOf(input({ base: rd(baseState({ taoWethPool: { sqrtPriceX96: sqrtA, token0: tb.fmTao }, wethUsdcPool: { sqrtPriceX96: sqrtB, token0: tb.weth } })) }));
    expect(Math.abs(Number(f.swap.spotUsdcPerTao) - 300_000)).toBeLessThan(5);
    // swapped token order gives the same price from inverted sqrt prices
    const inv = (s: bigint) => (Q96 * Q96) / s;
    const g = flowOf(input({ base: rd(baseState({ taoWethPool: { sqrtPriceX96: inv(sqrtA), token0: tb.weth }, wethUsdcPool: { sqrtPriceX96: inv(sqrtB), token0: tb.usdc } })) }));
    expect(Math.abs(Number(g.swap.spotUsdcPerTao) - 300_000)).toBeLessThan(50);
    // twap and quotes
    expect(f.swap.twapUsdcPerTao).toBe("300000000");
    expect(flowOf(input({ base: rd(baseState({ oracleReverted: true })) })).swap.twapUsdcPerTao).toBeNull();
    expect(flowOf(input({ base: rd(baseState({ sellQuote: { taoIn: 5n, usdcOut: 6n } })) })).swap.sellQuote).toEqual({ taoIn: "5", usdcOut: "6" });
  });

  it("noticesFromStateAndLogs", () => {
    const other = "0x00000000000000000000000000000000000000aa";
    const logs: AdminLog[] = [
      log({ event: "BridgeProposed", args: { bridge: other, readyAt: "1900000000" }, txHash: tx(2) }),
      log({ event: "BridgeActivated", args: { bridge: other }, txHash: tx(3) }),
      log({ event: "BridgeProposed", args: { bridge: other, readyAt: "1900000500" }, txHash: tx(4) }),
      log({ event: "FrontDoorProposed", args: { chain: "964", addr: other, readyAt: "1900000600" }, txHash: tx(5), chain: "bittensor", address: d.vault }),
      log({ event: "FrontDoorProposed", args: { chain: "8453", addr: other, readyAt: "1900000700" }, txHash: tx(6), chain: "bittensor", address: d.vault }),
      log({ event: "FrontDoorProposalCancelled", args: { chain: "8453", addr: other }, chain: "bittensor", address: d.vault }),
      log({ event: "OwnershipTransferStarted", args: { previousOwner: other, newOwner: other }, txHash: tx(7), address: d.staker }),
      log({ event: "GuardianProposed", args: { guardian: other, readyAt: "1900000900" }, txHash: tx(8) }),
    ];
    const f = flowOf(
      input({
        adminLogs: logs,
        base: rd(baseState({ paused: true, stakerPendingOwner: other, pendingGuardian: other })),
        bittensor: rd(bitState({ paused: true, pendingOwner: "0x0000000000000000000000000000000000000000" })),
      }),
    );
    const k = (kind: string) => f.notices.filter((n) => n.kind === kind);
    expect(k("bridgeProposed")).toEqual([{ kind: "bridgeProposed", chain: "base", contract: d.frontDoor, target: other, earliest: 1900000500, tx: tx(4) }]);
    expect(k("frontDoorProposed")).toEqual([{ kind: "frontDoorProposed", chain: "bittensor", contract: d.vault, target: other, earliest: 1900000600, tx: tx(5) }]);
    expect(k("paused").map((n) => n.contract).sort()).toEqual([d.frontDoor, d.vault].sort());
    expect(k("ownershipPending")).toEqual([{ kind: "ownershipPending", chain: "base", contract: d.staker, target: other, tx: tx(7) }]);
    expect(k("guardianProposed")).toEqual([{ kind: "guardianProposed", chain: "base", contract: d.frontDoor, target: other, earliest: 1900000900, tx: tx(8) }]);
    // nothing pending, nothing noted
    expect(flowOf(input()).notices).toEqual([]);
  });

  it("aLogWithoutItsTargetIsSkipped", () => {
    const logs = [
      log({ event: "BridgeProposed", args: { readyAt: "1900000000" } }),
      log({ event: "FrontDoorProposed", args: { chain: "8453", readyAt: "1900000000" }, chain: "bittensor", address: d.vault }),
      log({ event: "BridgeActivated", args: {} }),
    ];
    const other = "0x00000000000000000000000000000000000000aa";
    logs.push(log({ event: "BridgeProposed", args: { bridge: other, readyAt: "1900000000" }, txHash: tx(5) }));
    const f = flowOf(input({ adminLogs: logs }));
    expect(f.notices).toEqual([{ kind: "bridgeProposed", chain: "base", contract: d.frontDoor, target: other, earliest: 1900000000, tx: tx(5) }]);
  });

  it("aBadReadyAtLeavesNoEarliest", () => {
    const other = "0x00000000000000000000000000000000000000aa";
    const logs = [
      log({ event: "BridgeProposed", args: { bridge: other, readyAt: "soon" }, txHash: tx(2) }),
      log({ event: "BridgeProposed", args: { bridge: "0x00000000000000000000000000000000000000bb", readyAt: "" }, txHash: tx(4) }),
      log({ event: "GuardianProposed", args: { guardian: other }, txHash: tx(3) }),
    ];
    const f = flowOf(input({ adminLogs: logs, base: rd(baseState({ pendingGuardian: other })) }));
    expect(f.notices.map((n) => n.kind).sort()).toEqual(["bridgeProposed", "bridgeProposed", "guardianProposed"]);
    for (const n of f.notices) expect("earliest" in n).toBe(false);
    expect(JSON.stringify(f)).not.toMatch(/NaN|null,"earliest/);
  });

  it("ownershipTxIsTheTransferNamingThePendingOwner", () => {
    const A = "0x00000000000000000000000000000000000000AA";
    const B = "0x00000000000000000000000000000000000000bb";
    const C = "0x00000000000000000000000000000000000000cc";
    const logs = [
      log({ event: "OwnershipTransferStarted", args: { previousOwner: C, newOwner: A.toLowerCase() }, txHash: tx(10) }),
      log({ event: "OwnershipTransferStarted", args: { previousOwner: C, newOwner: B }, txHash: tx(11) }),
      log({ event: "OwnershipTransferStarted", args: { previousOwner: C, newOwner: A.toLowerCase() }, txHash: tx(12) }),
      log({ event: "OwnershipTransferStarted", args: { previousOwner: C, newOwner: B }, txHash: tx(13) }),
    ];
    const n = (pending: string) => flowOf(input({ adminLogs: logs, base: rd(baseState({ pendingOwner: pending as `0x${string}` })) })).notices.filter((x) => x.kind === "ownershipPending");
    expect(n(A)).toEqual([{ kind: "ownershipPending", chain: "base", contract: d.frontDoor, target: A, tx: tx(12) }]);
    expect(n(C)).toEqual([{ kind: "ownershipPending", chain: "base", contract: d.frontDoor, target: C }]);
  });

  it("guardianTxIsTheProposalNamingThePendingGuardian", () => {
    const A = "0x00000000000000000000000000000000000000AA";
    const B = "0x00000000000000000000000000000000000000bb";
    const C = "0x00000000000000000000000000000000000000cc";
    const logs = [
      log({ event: "GuardianProposed", args: { guardian: A.toLowerCase(), readyAt: "1900000001" }, txHash: tx(20) }),
      // a later proposal of another guardian (cancelled, or replaced since): never the pending one's
      log({ event: "GuardianProposed", args: { guardian: B, readyAt: "1900000002" }, txHash: tx(21) }),
    ];
    const n = (pending: string) => flowOf(input({ adminLogs: logs, base: rd(baseState({ pendingGuardian: pending as `0x${string}` })) })).notices.filter((x) => x.kind === "guardianProposed");
    expect(n(A)).toEqual([{ kind: "guardianProposed", chain: "base", contract: d.frontDoor, target: A, earliest: 1900000001, tx: tx(20) }]);
    expect(n(B)).toEqual([{ kind: "guardianProposed", chain: "base", contract: d.frontDoor, target: B, earliest: 1900000002, tx: tx(21) }]);
    // no stored proposal names it: no transaction and no time, as the ownership notice does
    expect(n(C)).toEqual([{ kind: "guardianProposed", chain: "base", contract: d.frontDoor, target: C }]);
  });

  it("fmNotices", () => {
    const admin = "0x00000000000000000000000000000000000000bb";
    const f = flowOf(
      input({
        bittensor: rd(
          bitState({
            alpha: {
              backing: E18,
              pendingAdmin: { admin, schedule: NOW + 100 },
              migrationReadyAt: BigInt(NOW + 200),
              migrationTarget: admin,
              pausedUntil: BigInt(NOW + 300),
            },
          }),
        ),
      }),
    );
    const av = cfg.tokens.bittensor.alphaVault;
    expect(f.notices).toEqual([
      { kind: "fmAdminScheduled", chain: "bittensor", contract: av, target: admin, earliest: NOW + 100 },
      { kind: "fmMigration", chain: "bittensor", contract: av, target: admin, earliest: NOW + 200 },
      { kind: "fmPaused", chain: "bittensor", contract: av },
    ]);
    const quiet = flowOf(input({ bittensor: rd(bitState({ alpha: { pausedUntil: BigInt(NOW - 1), migrationReadyAt: 0n, pendingAdmin: { admin: "0x" + "0".repeat(40) as `0x${string}`, schedule: 0 } } })) }));
    expect(quiet.notices).toEqual([]);
  });

  it("theDocumentIsTheAllowListedShape", () => {
    const keys = (v: unknown, path = ""): string[] =>
      v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v).flatMap(([k, x]) => [`${path}${k}`, ...keys(x, `${path}${k}.`)]) : [];
    const f: FlowV1 = flowOf(input({ base: rd(baseState({ sellQuote: { taoIn: 1n, usdcOut: 2n } })), bittensor: rd(bitState({ stakeHotkey: HK1, hotkeys: [HK1] })) }));
    const bucketKeys = ["roomLeft", "capacity", "perHour", "enabled", "supported", "inFlight"];
    const expected = [
      "v", "deployment", "generatedAt",
      "chains", "chains.base", "chains.base.block", "chains.base.time", "chains.base.stale",
      "chains.bittensor", "chains.bittensor.block", "chains.bittensor.time", "chains.bittensor.stale",
      "swap", ...["taoWethPoolTao", "wethUsdcPoolUsdc", "twapUsdcPerTao", "spotUsdcPerTao", "buyQuote1000Tao", "sellQuote", "sellQuote.taoIn", "sellQuote.usdcOut"].map((k) => `swap.${k}`),
      "backing", ...["alphaBacking", "wTaoSupply", "lockPoolFmTao", "fmTaoSupplyBase", "ratioPpm"].map((k) => `backing.${k}`),
      "bridgeIn", ...bucketKeys.map((k) => `bridgeIn.${k}`),
      "bridgeOut", ...bucketKeys.map((k) => `bridgeOut.${k}`),
      "batch", "batch.nextSendAt",
      "vault", ...["totalAssets", "price", "pendingPayouts", "nextPayoutAt", "paused"].map((k) => `vault.${k}`),
      "validator", ...["hotkey", "ourStake", "takeBps", "backups"].map((k) => `validator.${k}`),
      "frontDoor", "frontDoor.paused",
      "notices",
      "addresses", ...["vault", "frontDoor", "staker", "taoWethPool", "wethUsdcPool", "alphaVault", "lockPool", "baseTokenPool", "wTao", "fmTaoBase"].map((k) => `addresses.${k}`),
    ];
    const got = keys(f);
    expect(got.sort()).toEqual(expected.sort());
    expect(got.filter((k) => /alert|threshold|hold|rule/i.test(k.split(".").pop()!))).toEqual([]);
  });

  describe("v3.2's states and money-out figures, for the security page (the web copy audit's N1 to N5 and S9)", () => {
    const cfg32 = testConfigV32();
    const d32 = cfg32.deployment;
    const PRIMARY = d32.bitAdapter.toLowerCase() as Hex;
    const open: Exits = { open: true, ownerHold: false, guardianHold: false, pausedBy: 0, primaryDisabledBy: 0, launchDoorRemovedBy: 0, lastOwnerClose: 0, lastGuardianClose: 0, pendingSince: 0 };
    /** a healthy v3.2 vault: 1,000 TAO priced, nothing ramping; 20% a day through this door, 30% through all; 30 TAO burned */
    const bit32 = (o: Partial<BitState> = {}) =>
      bitState({
        stakeMissing: false,
        primaryBridge: PRIMARY,
        rails: { [PRIMARY]: { canSendPayouts: true } },
        exits: open,
        payoutDelay: 86_400,
        rootStakeRao: 1000n * 10n ** 9n,
        bookedStake: 1000n * 10n ** 9n,
        rampingStake: 0n,
        lastStakeAt: 0,
        maxDailyOutflowBps: 2000n,
        globalOutflowBps: 3000n,
        minDailyOutflow: 10n * E18,
        burnWindow: { start: NOW - 3600, burned: 30n * E18 },
        globalWindow: { start: NOW - 3600, burned: 30n * E18 },
        ...o,
      });
    const flow32 = (o: Partial<FlowInput> = {}, bit: Partial<BitState> = {}, base: Partial<BaseState> = {}) =>
      flowOf(input({ cfg: cfg32, base: rd(baseState({ exits: open, ...base })), bittensor: rd(bit32(bit)), parks: [], ...o }));

    it("all well: none of v3.2's notices, and the exits part: the wait before payouts, today's limit and what it has burned, nothing parked", () => {
      const f = flow32();
      expect(f.notices).toEqual([]);
      expect(f.exits).toEqual({ payoutDelayS: 86_400, dailyLimit: String(200n * E18), usedToday: String(30n * E18), parked: "0", parkedRefundFrom: "none" });
    });

    it("the day's limit is the binding window's: every door's together when its rest is the smaller", () => {
      const f = flow32({}, { globalWindow: { start: NOW - 3600, burned: 290n * E18 } });
      expect(f.exits).toMatchObject({ dailyLimit: String(300n * E18), usedToday: String(290n * E18) });
      // a window that ended counts nothing: today's burned is 0
      expect(flow32({}, { burnWindow: { start: NOW - 86_500, burned: 30n * E18 }, globalWindow: { start: NOW - 86_500, burned: 30n * E18 } }).exits).toMatchObject({ usedToday: "0" });
    });

    it("unknown, never 0, while a limit or a window is unread, the delay is unread, or the Bittensor reading is stale", () => {
      expect(flow32({}, { globalOutflowBps: undefined }).exits).toMatchObject({ dailyLimit: null, usedToday: null });
      expect(flow32({}, { burnWindow: undefined }).exits).toMatchObject({ dailyLimit: null, usedToday: null });
      expect(flow32({}, { payoutDelay: undefined }).exits?.payoutDelayS).toBeNull();
      const stale = flowOf(input({ cfg: cfg32, bittensor: rd(bit32({ stakeMissing: true }), STALE_AFTER_S + 1), parks: [{ amount: E18, parkedAt: NOW - 60 }] }));
      expect(stale.exits).toEqual({ payoutDelayS: null, dailyLimit: null, usedToday: null, parked: null, parkedRefundFrom: null });
      expect(stale.notices).toEqual([]);
    });

    it("stake missing (N1), the vault's primary unable to send payouts (N3: its canSendPayouts()), and a route switched off (N4: a primary disabled on either chain, or the launch door removed), once", () => {
      expect(flow32({}, { stakeMissing: true }).notices).toEqual([{ kind: "stakeMissing", chain: "bittensor", contract: d32.vault }]);
      expect(flow32({}, { rails: { [PRIMARY]: { canSendPayouts: false } } }).notices).toEqual([{ kind: "payoutsClosed", chain: "bittensor", contract: PRIMARY }]);
      // unread: no notice (unknown is never said as closed)
      expect(flow32({}, { rails: { [PRIMARY]: {} } }).notices).toEqual([]);
      expect(flow32({}, {}, { exits: { ...open, primaryDisabledBy: 1 } }).notices).toEqual([{ kind: "routeDisabled", chain: "base", contract: d32.frontDoor }]);
      expect(flow32({}, { exits: { ...open, launchDoorRemovedBy: 2 } }).notices).toEqual([{ kind: "routeDisabled", chain: "bittensor", contract: d32.vault }]);
      expect(flow32({}, { exits: { ...open, primaryDisabledBy: 1 } }, { exits: { ...open, primaryDisabledBy: 2 } }).notices.filter((n) => n.kind === "routeDisabled")).toHaveLength(1);
    });

    it("deposits waiting on Bittensor (N2): the front door's open parks with TAO, their sum, and when the oldest can be sent back to Base", () => {
      const f = flow32({ parks: [{ amount: 2n * E18, parkedAt: NOW - 3600 }, { amount: E18, parkedAt: NOW - 7200 }] });
      expect(f.exits).toMatchObject({ parked: String(3n * E18), parkedRefundFrom: NOW - 7200 + PARK_TIMEOUT_S });
      expect(f.notices).toEqual([{ kind: "parked", chain: "bittensor", contract: d32.bitAdapter, earliest: NOW - 7200 + PARK_TIMEOUT_S }]);
      // a park whose time isn't known: the sum, the date unknown
      expect(flow32({ parks: [{ amount: E18 }] }).exits).toMatchObject({ parked: String(E18), parkedRefundFrom: null });
      // the parks unread: unknown
      expect(flow32({ parks: undefined }).exits).toMatchObject({ parked: null, parkedRefundFrom: null });
    });

    it("doorParksOf: from the park events, the front door's open parks with TAO, each with its BatchParked's time (or told by its block from the reading)", () => {
      const AD = d32.bitAdapter;
      const parked = (key: Hex, block: bigint, o: Record<string, string> = {}) =>
        slog({ contract: "bitAdapter", event: "BatchParked", address: AD, block, args: { key, messageId: tx(70), recipient: d32.vault, sender: d32.frontDoor, amount: String(E18), converted: "false", reason: "0x00000000", ...o } });
      const ended = (key: Hex, block: bigint) => slog({ contract: "bitAdapter", event: "ParkedDelivered", address: AD, block, args: { key } });
      const K = (n: number) => tx(80 + n);
      const logs = [
        parked(K(1), 6_900_000n),
        parked(K(2), 6_900_100n),
        ended(K(2), 6_900_200n),
        parked(K(3), 6_900_300n, { sender: "0x00000000000000000000000000000000000000e9" }),
        parked(K(4), 6_900_400n, { amount: "0" }),
        parked(K(5), 6_900_500n),
      ];
      const times = new Map([[6_900_000n, NOW - 10_000]]);
      expect(doorParksOf(logs, d32, (b) => times.get(b), { block: 6_901_000n, time: NOW })).toEqual([
        { amount: E18, parkedAt: NOW - 10_000 },
        { amount: E18, parkedAt: NOW - 500 * 12 },
      ]);
      expect(doorParksOf(logs, d32, () => undefined, undefined)).toEqual([{ amount: E18 }, { amount: E18 }]);
      // told by its block at Bittensor's block time as measured (6 s a block here)
      expect(doorParksOf(logs, d32, (b) => times.get(b), { block: 6_901_000n, time: NOW }, 6)[1]).toEqual({ amount: E18, parkedAt: NOW - 500 * 6 });
    });

    it("v3.2's document is the allow-listed shape with the exits part; v3-launch's has none", () => {
      const keys = (v: unknown, path = ""): string[] =>
        v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v).flatMap(([k, x]) => [`${path}${k}`, ...keys(x, `${path}${k}.`)]) : [];
      expect(keys(flow32()).filter((k) => k.startsWith("exits"))).toEqual(["exits", ...["payoutDelayS", "dailyLimit", "usedToday", "parked", "parkedRefundFrom"].map((k) => `exits.${k}`)]);
      expect(flowOf(input())).not.toHaveProperty("exits");
    });
  });

  describe("v3.2's pending scheduled items, from the record the admin rules keep and the lens's reads", () => {
    const cfg32 = testConfigV32();
    const d32 = cfg32.deployment;
    const DAY = 86_400;
    const G = "0x00000000000000000000000000000000000000b2" as Hex;
    const open: Exits = { open: true, ownerHold: false, guardianHold: false, pausedBy: 0, primaryDisabledBy: 0, launchDoorRemovedBy: 0, lastOwnerClose: 0, lastGuardianClose: 0, pendingSince: 0 };
    const item = (o: Partial<TrackedItem> = {}): TrackedItem => ({
      chain: "bittensor",
      role: "vault",
      id: tx(51),
      kind: 1,
      selector: "0xa7016023",
      readyAt: NOW + 2 * DAY,
      data: "0xa701602300000000000000000000000000000000000000000000000000000000000000b2",
      setter: "setGuardian",
      args: { newGuardian: G },
      canonical: true,
      uid: tx(52),
      block: "6900200",
      tx: tx(53),
      ...o,
    });
    const lensItem = (i: TrackedItem, o: Partial<ScheduledItem> = {}): ScheduledItem => ({ scheduledAt: i.readyAt - 8 * DAY, readyAt: i.readyAt, class: 2, kind: i.kind, selector: i.selector, readyBlock: 1n, ...o });
    const at = (i: TrackedItem, read?: ScheduledItem, exits: Exits = open) => rd(bitState({ exits, msPerBlock: 7_200, scheduled: read ? { [i.id]: read } : {} }));

    it("shows each pending item with its kind, setter, arguments, readyAt and the transaction that scheduled it", () => {
      const i = item();
      const f = flowOf(input({ cfg: cfg32, bittensor: at(i, lensItem(i)), items: [i] }));
      expect(f.notices).toEqual([
        { kind: "itemScheduled", chain: "bittensor", contract: d32.vault, target: G, earliest: i.readyAt, tx: i.tx, item: { id: i.id, kind: "GuardianSwap", setter: "setGuardian", args: { newGuardian: G } } },
      ]);
      // a front door item without an address argument names no target
      const fd = item({ chain: "base", role: "frontDoor", id: tx(61), setter: "setBatchInterval", args: { interval: "300" }, kind: 0 });
      const g = flowOf(input({ cfg: cfg32, base: rd(baseState({ exits: open, scheduled: { [fd.id]: lensItem(fd) } })), items: [fd] }));
      expect(g.notices).toEqual([{ kind: "itemScheduled", chain: "base", contract: d32.frontDoor, earliest: fd.readyAt, tx: fd.tx, item: { id: fd.id, kind: "Ordinary", setter: "setBatchInterval", args: { interval: "300" } } }]);
    });

    it("an item the lens hasn't read, or a stale chain's, is still shown: unread is never 'nothing pending'", () => {
      const i = item();
      expect(flowOf(input({ cfg: cfg32, bittensor: at(i), items: [i] })).notices).toHaveLength(1);
      expect(flowOf(input({ cfg: cfg32, bittensor: rd(bitState({}), STALE_AFTER_S + 1), items: [i] })).notices).toHaveLength(1);
      expect(flowOf(input({ cfg: cfg32, bittensor: null, items: [i] })).notices).toHaveLength(1);
      // an item whose calldata didn't decode: shown, setter and arguments unknown
      const odd = item({ setter: undefined, args: undefined, canonical: undefined });
      expect(flowOf(input({ cfg: cfg32, bittensor: at(odd), items: [odd] })).notices[0]).toMatchObject({ item: { setter: null, args: null } });
    });

    it("leaves out an item the lens reads gone, one a closure or stamp killed, and one past its window", () => {
      const i = item();
      expect(flowOf(input({ cfg: cfg32, bittensor: at(i, { ...lensItem(i), readyAt: 0, scheduledAt: 0 }), items: [i] })).notices).toEqual([]);
      expect(flowOf(input({ cfg: cfg32, bittensor: at(i, lensItem(i), { ...open, lastOwnerClose: i.readyAt - 8 * DAY }), items: [i] })).notices).toEqual([]);
      // past both its windows: in time, and its readyBlock (1) plus 42,000 calibrated blocks (7,200 ms) before the reading's
      const old = item({ readyAt: NOW - 7 * DAY - 100 });
      expect(flowOf(input({ cfg: cfg32, bittensor: { ...at(old, lensItem(old)), block: 100_000n }, items: [old] })).notices).toEqual([]);
      // past its window in time only, its blocks still to come (Revision 28): it can still run, so it is shown; and with
      // MS_PER_BLOCK unread, unknown, shown too
      expect(flowOf(input({ cfg: cfg32, bittensor: { ...at(old, lensItem(old)), block: 42_001n }, items: [old] })).notices).toHaveLength(1);
      const unread = at(old, lensItem(old));
      expect(flowOf(input({ cfg: cfg32, bittensor: { ...unread, block: 100_000n, state: { ...unread.state, msPerBlock: undefined } }, items: [old] })).notices).toHaveLength(1);
    });

    it("leaves out a finished item (the record marks it: past its window, killed, or reverting at execute), even while the lens hasn't read it", () => {
      const done = item({ lapsed: true });
      expect(flowOf(input({ cfg: cfg32, bittensor: at(done), items: [done] })).notices).toEqual([]);
      expect(flowOf(input({ cfg: cfg32, bittensor: null, items: [done] })).notices).toEqual([]);
      expect(flowOf(input({ cfg: cfg32, bittensor: at(done, lensItem(done)), items: [done] })).notices).toEqual([]);
    });
  });
});

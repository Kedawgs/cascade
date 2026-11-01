import { describe, expect, it } from "vitest";
import { flowOf, type AdminLog, type FlowInput, type FlowV1, STALE_AFTER_S } from "../../src/flow.ts";
import type { BaseState, BitState, Bucket, ChainReading } from "../../src/snapshot.ts";
import { testConfig, tx } from "./fixtures.ts";

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
  lane: { outbound: bucket() },
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
  lane: { outbound: bucket({ tokens: 2n * E18 }) },
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
    expect(f.bridgeIn.roomLeft).toBe((5n * E18).toString());
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
    expect(f.validator.backups).toEqual([]);
    expect(f.addresses.vault).toBe(d.vault);
    // a stale Base half drops only the Base layer
    const g = flowOf(input({ base: rd(baseState(), 9999), bittensor: rd(bitState({ alpha: { backing: 999n * E18 } })) }));
    expect(g.backing.ratioPpm).toBe(999_000);
    expect(g.backing.fmTaoSupplyBase).toBeNull();
  });

  it("backingTakesTheLowerLayer", () => {
    const f = flowOf(input({ bittensor: rd(bitState({ alpha: { backing: (1000n * E18 * 10002n) / 10000n }, lockPoolFmTao: (1000n * E18 * 9990n) / 10000n })) }));
    expect(f.backing.ratioPpm).toBe(999_000);
    const g = flowOf(input({ bittensor: rd(bitState({ alpha: { backing: (1000n * E18 * 9980n) / 10000n } })) }));
    expect(g.backing.ratioPpm).toBe(998_000);
  });

  it("zeroSupplyIsNotInfinity", () => {
    const f = flowOf(input({ bittensor: rd(bitState({ wTaoSupply: 0n, lockPoolFmTao: 990n * E18 })) }));
    expect(f.backing.ratioPpm).toBe(990_000);
    const s = JSON.stringify(flowOf(input({ base: rd(baseState({ fmTaoSupply: 0n })), bittensor: rd(bitState({ wTaoSupply: 0n })) })));
    expect(s).not.toMatch(/Infinity|NaN/);
    expect(flowOf(input({ base: rd(baseState({ fmTaoSupply: 0n })), bittensor: rd(bitState({ wTaoSupply: 0n })) })).backing.ratioPpm).toBeNull();
  });

  it("bucketPerHourAndDisabled", () => {
    const f = flowOf(input({ base: rd(baseState({ lane: { outbound: bucket({ rate: 1000n, isEnabled: false }) } })) }));
    expect(f.bridgeIn).toEqual({ roomLeft: (5n * E18).toString(), capacity: (20n * E18).toString(), perHour: "3600000", enabled: false, inFlight: 1 });
    expect(flowOf(input({ base: rd(baseState({ lane: undefined })) })).bridgeIn.roomLeft).toBeNull();
  });

  it("nextSendOnlyWithSomethingInTheBatch", () => {
    const ob = { id: 1n, start: NOW - 100, totalDeposits: 0n, feePot: 0n, nDeposits: 0, nRedeems: 0 };
    const at = (o: Partial<typeof ob>) => flowOf(input({ base: rd(baseState({ openBatch: { ...ob, ...o }, batchInterval: 3600 })) })).batch.nextSendAt;
    expect(at({})).toBeNull();
    expect(at({ nDeposits: 1 })).toBe(NOW - 100 + 3600);
    expect(at({ nRedeems: 2 })).toBe(NOW - 100 + 3600);
  });

  it("nextPayoutIsTheEarliestBatch", () => {
    const b = (queuedAt: number) => ({ queuedAt, cursor: 0, count: 1, chunk: 1, remaining: 1n });
    const f = flowOf(input({ bittensor: rd(bitState({ payoutDelay: 1000, payoutBatches: { [HK1]: b(NOW - 50), [HK2]: b(NOW - 500) } })) }));
    expect(f.vault.nextPayoutAt).toBe(NOW - 500 + 1000);
    expect(flowOf(input()).vault.nextPayoutAt).toBeNull();
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
    const bucketKeys = ["roomLeft", "capacity", "perHour", "enabled", "inFlight"];
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
});

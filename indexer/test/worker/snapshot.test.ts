import { encodeAbiParameters, type Hex, keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import { compact, expand, hourRollup, payoutsDone, peerIdOf, readSnapshot, type SnapshotInputs } from "../../src/snapshot.ts";
import { decodeAccountId, OWNER_PREFIX, ownerStorageKey } from "../../src/subtensor.ts";
import { deploymentState, fakeDeployment, GUARDIAN, KEEPER, OWNER, VALIDATOR_OWNER } from "./fake-deployment.ts";
import { testConfig } from "./fixtures.ts";

const cfg = testConfig();
const d = cfg.deployment;
const h = (s: string) => keccak256(toBytes(s)) as Hex;
const USER = "0x00000000000000000000000000000000000a11ce" as Hex;
const SAFE_OWNER = "0x00000000000000000000000000000000005afe00" as Hex;

const inputs = (over: Partial<SnapshotInputs> = {}): SnapshotInputs => ({
  last: {},
  pendingMessages: [],
  watched: [],
  payoutUsers: [],
  deliveredChecks: [],
  pendingPayoutKeys: [],
  ...over,
});

describe("readSnapshot", () => {
  it("reads both chains' state, each pinned to the block it was read at", async () => {
    const state = deploymentState(cfg);
    state.base.claimable[USER] = 5n * 10n ** 16n;
    state.base.deliveryOf[USER] = [400_000_000n, 1_800_000_500n, 6];
    const { rpc, heads } = fakeDeployment(cfg, state);
    const s = await readSnapshot(rpc, cfg, inputs({ payoutUsers: [USER] }), 1_800_000_030);
    expect(s.at).toBe(1_800_000_030);
    expect(s.bittensor?.block).toBe(heads.bittensor);
    expect(s.bittensor?.time).toBe(1_800_000_000);
    expect(s.base?.block).toBe(heads.base);
    expect(s.bittensor?.state).toMatchObject({
      price: 10n ** 18n,
      totalAssets: 50n * 10n ** 18n,
      totalSupply: 50n * 10n ** 18n,
      rootStakeRao: 49n * 10n ** 9n,
      pendingPayouts: 0n,
      paused: false,
      owner: OWNER,
      guardian: GUARDIAN,
      keeper: KEEPER,
      stakeHotkey: d.stakeHotkey,
      hotkeys: [d.stakeHotkey],
      stakes: { [d.stakeHotkey]: 49n * 10n ** 9n },
      balance: 10n ** 18n,
      payoutDelay: 3600,
      burnWindow: { start: 1_700_000_000, burned: 0n },
      lastClaimAt: 1_700_000_000,
      unclaimed: 3n * 10n ** 16n,
      hotkeyOwner: VALIDATOR_OWNER,
      lockPoolFmTao: 100n * 10n ** 18n,
      adapterBalance: 10n ** 13n,
      alpha: { isPaused: false, migrationReadyAt: 0n, migrationFinished: false },
    });
    expect(s.base?.state).toMatchObject({
      openBatch: { id: 7n, start: 1_700_000_000, totalDeposits: 0n, feePot: 0n, nDeposits: 0, nRedeems: 0 },
      depositCap: 40n * 10n ** 18n,
      maxRedeems: 100,
      batchInterval: 600,
      owner: OWNER,
      oracle: d.oracle,
      fmTaoSupply: 100n * 10n ** 18n,
      taoWethPool: { liquidity: 5n * 10n ** 18n, tao: 30n * 10n ** 18n, token0: cfg.tokens.base.fmTao },
      oracleValue: 400_000_000n,
      claimable: { [USER]: 5n * 10n ** 16n },
      deliveryOf: { [USER]: { minUsdcPerTao: 400_000_000n, deadline: 1_800_000_500, destination: 6 } },
    });
  });

  it("leaves only a failed read's field undefined", async () => {
    const state = deploymentState(cfg);
    state.reverts.add("vault.price");
    state.reverts.add("base.oracle.usdcValue");
    const { rpc } = fakeDeployment(cfg, state);
    const s = await readSnapshot(rpc, cfg, inputs(), 1);
    expect(s.bittensor?.state.price).toBeUndefined();
    expect(s.bittensor?.state.totalAssets).toBe(50n * 10n ** 18n);
    expect(s.base?.state.oracleValue).toBeUndefined();
    expect(s.base?.state.oracleReverted).toBe(true);
    expect(s.base?.state.fmTaoSupply).toBe(100n * 10n ** 18n);
  });

  it("drops a chain's reading from a block not newer than the last, keeping the other's", async () => {
    const state = deploymentState(cfg);
    const { rpc, heads } = fakeDeployment(cfg, state, { lagBy: { base: 2n } });
    const s = await readSnapshot(rpc, cfg, inputs({ last: { base: heads.base - 2n, bittensor: heads.bittensor - 5n } }), 1);
    expect(s.base).toBeUndefined();
    expect(s.bittensor?.block).toBe(heads.bittensor);
  });

  it("drops a chain whose read fails, and keeps going", async () => {
    const state = deploymentState(cfg);
    const { rpc, specs } = fakeDeployment(cfg, state);
    specs.base.failNext = { count: 5, status: 403 };
    const s = await readSnapshot(rpc, cfg, inputs(), 1);
    expect(s.base).toBeUndefined();
    expect(s.bittensor).toBeDefined();
  });

  it("reads watched addresses' transaction counts in one batch per chain, and a Safe's nonce in the multicall", async () => {
    const state = deploymentState(cfg);
    state.nonces.base[OWNER] = 12n;
    state.nonces.base[KEEPER] = 40n;
    state.nonces.bittensor[KEEPER] = 9n;
    state.base.safes[SAFE_OWNER] = 4n;
    const { rpc, net } = fakeDeployment(cfg, state);
    const s = await readSnapshot(
      rpc,
      cfg,
      inputs({
        watched: [
          { chain: "base", address: OWNER },
          { chain: "base", address: KEEPER },
          { chain: "bittensor", address: KEEPER },
          { chain: "base", address: SAFE_OWNER, isSafe: true },
        ],
      }),
      1,
    );
    expect(s.nonces).toEqual({ base: { [OWNER]: 12n, [KEEPER]: 40n }, bittensor: { [KEEPER]: 9n } });
    expect(s.safeNonces).toEqual({ [SAFE_OWNER]: 4n });
    const countRequests = net.fetches.filter((f) => f.methods.includes("eth_getTransactionCount"));
    expect(countRequests.map((f) => [f.chain, f.methods.length])).toEqual(expect.arrayContaining([["base", 2], ["bittensor", 1]]));
    expect(countRequests).toHaveLength(2);
    // two multicalls and two count batches
    expect(net.count()).toBe(4);
  });

  it("reads each landing's delivered(...) at the block of the Base reading", async () => {
    const state = deploymentState(cfg);
    const hash = h("message");
    state.base.delivered[`${d.baseAdapter}:${hash}`] = true;
    const { rpc, heads } = fakeDeployment(cfg, state);
    const s = await readSnapshot(
      rpc,
      cfg,
      inputs({
        deliveredChecks: [
          { landedUid: h("landing 1"), key: h("k"), chunk: 0, bridge: d.baseAdapter, hash },
          { landedUid: h("landing 2"), key: h("k"), chunk: 0, bridge: d.baseAdapter, hash: h("other") },
        ],
      }),
      1,
    );
    expect(s.deliveredReads).toEqual([
      { landedUid: h("landing 1"), key: h("k"), chunk: 0, block: heads.base, value: true },
      { landedUid: h("landing 2"), key: h("k"), chunk: 0, block: heads.base, value: false },
    ]);
  });

  it("reads bridge messages' states on their destination's OffRamp", async () => {
    const state = deploymentState(cfg);
    state.bit.offRamp[h("to bittensor")] = 2;
    state.base.offRamp[h("to base")] = 3;
    const { rpc } = fakeDeployment(cfg, state);
    const s = await readSnapshot(
      rpc,
      cfg,
      inputs({
        pendingMessages: [
          { messageId: h("to bittensor"), direction: "base>bittensor" },
          { messageId: h("to base"), direction: "bittensor>base" },
        ],
      }),
      1,
    );
    expect(s.messageStates).toEqual({ [h("to bittensor")]: "SUCCESS", [h("to base")]: "FAILURE" });
  });

  it("marks a pending payout batch done only from a reading after its queue block", async () => {
    const state = deploymentState(cfg);
    state.bit.payoutBatches[h("still")] = { queuedAt: 1n, cursor: 1, count: 3, chunk: 1, remaining: 5n };
    const { rpc, heads } = fakeDeployment(cfg, state);
    const pending = [
      { key: h("done"), queuedBlock: heads.bittensor - 100n },
      { key: h("still"), queuedBlock: heads.bittensor - 100n },
      // a node that hasn't seen the queue answers count 0 too: not done
      { key: h("unseen"), queuedBlock: heads.bittensor },
    ];
    const s = await readSnapshot(rpc, cfg, inputs({ pendingPayoutKeys: pending }), 1);
    expect(s.bittensor?.state.payoutBatches[h("still")]).toMatchObject({ cursor: 1, count: 3 });
    expect(payoutsDone(s, pending)).toEqual([{ key: h("done"), block: heads.bittensor }]);
  });

  it("reads the stakes of the hotkeys it is given, and the set the vault holds now", async () => {
    const state = deploymentState(cfg);
    const added = h("added hotkey");
    state.bit.hotkeys = [d.stakeHotkey, added];
    state.bit.stakes[added] = 7n;
    const { rpc } = fakeDeployment(cfg, state);
    const s = await readSnapshot(rpc, cfg, inputs({ hotkeys: [d.stakeHotkey, added] }), 1);
    expect(s.bittensor?.state.hotkeys).toEqual([d.stakeHotkey, added]);
    expect(s.bittensor?.state.stakes).toEqual({ [d.stakeHotkey]: 49n * 10n ** 9n, [added]: 7n });
  });

  it("reads the hotkey's owner as null when SubtensorModule has none", async () => {
    const state = deploymentState(cfg);
    state.bit.hotkeyOwner = null;
    const { rpc } = fakeDeployment(cfg, state);
    expect((await readSnapshot(rpc, cfg, inputs(), 1)).bittensor?.state.hotkeyOwner).toBeNull();
  });
});

describe("readings in D1", () => {
  it("compact and expand round-trip, bigints included", async () => {
    const { rpc } = fakeDeployment(cfg, deploymentState(cfg));
    const s = await readSnapshot(rpc, cfg, inputs({ payoutUsers: [USER] }), 99);
    expect(expand(compact(s))).toEqual(s);
    expect(typeof compact(s)).toBe("string");
  });

  it("hourRollup keeps the highest and lowest price across the ticks of an hour, and starts afresh the next", async () => {
    const state = deploymentState(cfg);
    const { rpc } = fakeDeployment(cfg, state);
    const at = (s: number) => 3600 * 1000 + s;
    state.bit.price = 10n ** 18n;
    let agg = hourRollup(undefined, await readSnapshot(rpc, cfg, inputs(), at(0)), 400);
    state.bit.price = 10n ** 18n + 5n;
    agg = hourRollup(agg, await readSnapshot(rpc, cfg, inputs(), at(60)), 402);
    state.bit.price = 10n ** 18n - 3n;
    agg = hourRollup(agg, await readSnapshot(rpc, cfg, inputs(), at(120)));
    expect(agg).toMatchObject({ hour: 3600 * 1000, ticks: 3, priceHigh: 10n ** 18n + 5n, priceLow: 10n ** 18n - 3n, priceLast: 10n ** 18n - 3n, spotSum: 802, spotCount: 2 });
    expect(agg.supplyFirst).toBe(100n * 10n ** 18n);
    const next = hourRollup(agg, await readSnapshot(rpc, cfg, inputs(), at(3600)));
    expect(next).toMatchObject({ hour: 3600 * 1001, ticks: 1, priceHigh: 10n ** 18n - 3n });
  });
});

describe("keys", () => {
  it("peerIdOf is the vault's peerId: keccak256(abi.encode(uint64 chain, address))", () => {
    expect(peerIdOf(8453n, d.frontDoor)).toBe(keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [8453n, d.frontDoor])));
  });

  it("ownerStorageKey is twox128(SubtensorModule) ++ twox128(Owner) ++ blake2_128_concat(hotkey)", () => {
    const hotkey = "0x56a9aee6291bd03ab6d36d4d13e2bebae7cd403518066c72fba1b417d6ddd748" as Hex;
    // computed apart from the code: twox128("SubtensorModule") (the site's BasketTwr prefix),
    // twox128("Owner") (confirmed by the Tasks 11–20 review with its own xxhash), then blake2b-128 of the
    // key from CPython's hashlib (hashlib.blake2b(key, digest_size=16)), then the key itself
    expect(ownerStorageKey(hotkey)).toBe(
      "0x658faa385070e074c85bf6b568cf0555" +
        "eca6b7a1fdc9f689184ecb4f359c0518" +
        "6c1664b37fae67165907bd92805ee938" +
        "56a9aee6291bd03ab6d36d4d13e2bebae7cd403518066c72fba1b417d6ddd748",
    );
    expect(OWNER_PREFIX).toBe("0x658faa385070e074c85bf6b568cf0555eca6b7a1fdc9f689184ecb4f359c0518");
  });

  it("decodes an account id, and empty storage as null", () => {
    expect(decodeAccountId("0x")).toBeNull();
    expect(decodeAccountId(undefined)).toBeNull();
    expect(decodeAccountId(VALIDATOR_OWNER)).toBe(VALIDATOR_OWNER);
    expect(decodeAccountId("0x1234")).toBeNull();
  });
});

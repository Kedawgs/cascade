import { encodeAbiParameters, type Hex, keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import { CCIP_SELECTOR } from "../../src/abi.ts";
import { compact, compactHour, expand, expandHour, hourRollup, payoutsDone, peerIdOf, quoteAmountOf, readSnapshot, type SnapshotInputs } from "../../src/snapshot.ts";
import { decodeAccountId, decodeAccountIds, OWNER_PREFIX, ownerStorageKey, STAKING_HOTKEYS_PREFIX, stakingHotkeysKey } from "../../src/subtensor.ts";
import { deploymentState, encodeAccountIds, fakeDeployment, GUARDIAN, KEEPER, OWNER, VALIDATOR_OWNER } from "./fake-deployment.ts";
import { testConfig } from "./fixtures.ts";
import { bitState } from "./rule-ctx.ts";
import { reads } from "./v3-test-fixtures.ts";

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
      alpha: {
        isPaused: false,
        migrationReadyAt: 0n,
        migrationFinished: false,
        pausedUntil: 0n,
        pauseableAfter: 0n,
        migrationTarget: "0x0000000000000000000000000000000000000000",
        migrationExecuted: false,
        pendingAdmin: { admin: "0x0000000000000000000000000000000000000000", schedule: 0 },
        backing: 101n * 10n ** 18n,
      },
      wTaoSupply: 100n * 10n ** 18n,
      lane: {
        inbound: { tokens: 5000n * 10n ** 18n, isEnabled: true, capacity: 5000n * 10n ** 18n, rate: 6n * 10n ** 17n },
        outbound: { tokens: 4000n * 10n ** 18n, isEnabled: true, capacity: 5000n * 10n ** 18n, rate: 6n * 10n ** 17n },
      },
      validator: { hotkey: d.stakeHotkey, take: 0, rootStake: 1_021_436_954_236_042n, rootUid: 1 },
      rootUnlockInterval: 0n,
      claimGasRequired: 55_000_000n,
      baseFee: 5_000_000_000n,
      primaryBridge: d.bitAdapter,
      maxFeeAbs: 5n * 10n ** 15n,
      maxFeeBps: 100n,
      // the largest chunk the vault sends, and the most its bridge takes (read live 2026-10-31: 15 and 50 TAO)
      maxMessageValue: 15n * 10n ** 18n,
      bridgeMaxMessageValue: 50n * 10n ** 18n,
      // the quote rounded up to whole rao, as the vault rounds the fee it checks
      payoutFeeQuote: 1_315_670_000_000_000n,
    });
    expect(s.base?.state).toMatchObject({
      openBatch: { id: 7n, start: 1_700_000_000, totalDeposits: 0n, feePot: 0n, nDeposits: 0, nRedeems: 0 },
      depositCap: 40n * 10n ** 18n,
      maxRedeems: 100,
      batchInterval: 600,
      owner: OWNER,
      oracle: d.oracle,
      fmTaoSupply: 100n * 10n ** 18n,
      taoWethPool: { liquidity: 5n * 10n ** 18n, tao: 30n * 10n ** 18n, token0: cfg.tokens.base.fmTao, cardinality: 2000, cardinalityNext: 2000 },
      wethUsdcPool: { cardinality: 5000, cardinalityNext: 5000 },
      lane: {
        inbound: { tokens: 5000n * 10n ** 18n, isEnabled: true, capacity: 5000n * 10n ** 18n, rate: 6n * 10n ** 17n },
        outbound: { tokens: 5000n * 10n ** 18n, isEnabled: true, capacity: 5000n * 10n ** 18n, rate: 6n * 10n ** 17n },
      },
      oracleValue: 400_000_000n,
      claimable: { [USER]: 5n * 10n ** 16n },
      deliveryOf: { [USER]: { minUsdcPerTao: 400_000_000n, deadline: 1_800_000_500, destination: 6 } },
    });
  });

  it("asks the token pools for the Base-Bittensor lane's buckets, the AlphaVault's backing for wTAO, and a full payout chunk's fee", async () => {
    const state = deploymentState(cfg);
    const other = "0x00000000000000000000000000000000000b1d9e" as Hex;
    state.bit.quoteBridges.push(other);
    const { rpc } = fakeDeployment(cfg, state);
    await readSnapshot(rpc, cfg, inputs(), 1);
    // the lane's selectors: the Base pool is asked about Bittensor, the lock pool about Base
    expect(state.asked.bucketSelectors).toEqual(expect.arrayContaining([`base:${CCIP_SELECTOR.bittensor}`, `bittensor:${CCIP_SELECTOR.base}`]));
    expect(state.asked.backingOf).toEqual([cfg.tokens.bittensor.fmTao]);
    // the quote: a chunk of the most entries a payout chunk holds (100), to the front door on Base, at the primary bridge;
    // worth 1 TAO until a reading has named the largest chunk the vault sends
    expect(state.asked.quotes).toEqual([{ bridge: d.bitAdapter, destChain: 8453n, recipient: d.frontDoor, entries: 100, amount: 10n ** 18n, sum: 10n ** 18n }]);
    // then worth that (the lower of the vault's and its bridge's maxMessageValue), so a fee in basis points is priced;
    // and from the bridge the last reading named, when it moved
    await readSnapshot(rpc, cfg, inputs({ bitBridge: other, payoutQuoteAmount: 15n * 10n ** 18n }), 2);
    expect(state.asked.quotes.at(-1)).toEqual({ bridge: other, destChain: 8453n, recipient: d.frontDoor, entries: 100, amount: 15n * 10n ** 18n, sum: 15n * 10n ** 18n });
    // more than the bridge takes reverts (MessageTooLarge): the quote is left unread
    const s = await readSnapshot(rpc, cfg, inputs({ payoutQuoteAmount: 51n * 10n ** 18n }), 3);
    expect(s.bittensor?.state.payoutFeeQuote).toBeUndefined();
  });

  it("asks each token pool whether it still lists the other chain: a lane removed reads false, a failed read is unread", async () => {
    const state = deploymentState(cfg);
    const { rpc } = fakeDeployment(cfg, state);
    const s = await readSnapshot(rpc, cfg, inputs(), 1);
    expect(s.base?.state.lane?.supported).toBe(true);
    expect(s.bittensor?.state.lane?.supported).toBe(true);
    // the same selectors as the buckets: the Base pool is asked about Bittensor, the lock pool about Base
    expect(state.asked.supportedSelectors.sort()).toEqual([`base:${CCIP_SELECTOR.bittensor}`, `bittensor:${CCIP_SELECTOR.base}`].sort());
    state.base.lane.supported = false;
    state.reverts.add("bittensor.pool.isSupportedChain");
    const t = await readSnapshot(rpc, cfg, inputs(), 2);
    expect(t.base?.state.lane?.supported).toBe(false);
    expect(t.bittensor?.state.lane?.supported).toBeUndefined();
    expect(t.bittensor?.state.lane?.outbound).toBeDefined();
  });

  it("reads the validator's take, root stake and root uid, and an unset RootStakeUnlockInterval as 0; an absent entry as null", async () => {
    const state = deploymentState(cfg);
    const { rpc } = fakeDeployment(cfg, state);
    state.bit.storage.delegates = "0x";
    state.bit.storage.uids = "0x";
    state.bit.storage.unlockInterval = "0x6801000000000000";
    const s = await readSnapshot(rpc, cfg, inputs(), 1);
    expect(s.bittensor?.state.validator).toEqual({ hotkey: d.stakeHotkey, take: null, rootStake: 1_021_436_954_236_042n, rootUid: null });
    expect(s.bittensor?.state.rootUnlockInterval).toBe(360n);
    // an answer that doesn't decode is unread, never a value
    state.bit.storage.delegates = "0x1234567890";
    state.bit.storage.unlockInterval = "0x01";
    const t = await readSnapshot(rpc, cfg, inputs(), 2);
    expect(t.bittensor?.state.validator?.take).toBeUndefined();
    expect(t.bittensor?.state.rootUnlockInterval).toBeUndefined();
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
    const { rpc, net, specs } = fakeDeployment(cfg, state);
    specs.base.code = { [SAFE_OWNER]: "0x608060405273ffffffffffffffffffffffffffffffffffffffff" };
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
    expect(s.safeNonces).toEqual({ base: { [SAFE_OWNER]: 4n }, bittensor: {} });
    const countRequests = net.fetches.filter((f) => f.methods.includes("eth_getTransactionCount"));
    // the Safe's code is asked in the same batch as Base's counts
    expect(countRequests.map((f) => [f.chain, f.methods.length])).toEqual(expect.arrayContaining([["base", 3], ["bittensor", 1]]));
    expect(countRequests).toHaveLength(2);
    // two multicalls and two count batches
    expect(net.count()).toBe(4);
  });

  it("keeps a code only from a well-formed answer: null, odd-length or non-hex is unread", async () => {
    const at = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
    const { rpc, specs } = fakeDeployment(cfg, deploymentState(cfg));
    specs.base.code = { [at(1)]: null, [at(2)]: "0xabc", [at(3)]: "0xzz", [at(4)]: "0x", [at(5)]: "0x6080" };
    const s = await readSnapshot(rpc, cfg, inputs({ codesOf: [1, 2, 3, 4, 5].map((n) => ({ chain: "base" as const, address: at(n) })) }), 1);
    expect(s.codes?.base).toEqual({ [at(4)]: "0x", [at(5)]: "0x6080" });
  });

  it("never takes an EIP-7702 delegated account (code 0xef0100…) for a Safe, though its delegate answers nonce()", async () => {
    const DELEGATED = "0x0000000000000000000000000000000000007702" as Hex;
    const state = deploymentState(cfg);
    state.nonces.base[DELEGATED] = 31n;
    state.base.safes[DELEGATED] = 2n;
    state.base.safes[SAFE_OWNER] = 4n;
    const { rpc, specs } = fakeDeployment(cfg, state);
    specs.base.code = { [DELEGATED]: `0xef0100${"ab".repeat(20)}`, [SAFE_OWNER]: "0x6080604052" };
    const both = (address: Hex) => [{ chain: "base" as const, address }, { chain: "base" as const, address, isSafe: true }];
    const s = await readSnapshot(rpc, cfg, inputs({ watched: [...both(DELEGATED), ...both(SAFE_OWNER)] }), 1);
    // the delegated account is judged by its transaction count; only the real Safe by its nonce()
    expect(s.safeNonces).toEqual({ base: { [SAFE_OWNER]: 4n }, bittensor: {} });
    expect(s.nonces.base[DELEGATED]).toBe(31n);
  });

  it("keeps each chain's Safe nonce() apart: one Safe address on both chains (Safe's same-address deploys) has two", async () => {
    const state = deploymentState(cfg);
    state.base.safes[SAFE_OWNER] = 4n;
    state.bit.safes[SAFE_OWNER] = 9n;
    const { rpc, specs } = fakeDeployment(cfg, state);
    specs.base.code = { [SAFE_OWNER]: "0x6080604052" };
    specs.bittensor.code = { [SAFE_OWNER]: "0x6080604052" };
    const watched = (["base", "bittensor"] as const).map((chain) => ({ chain, address: SAFE_OWNER, isSafe: true }));
    const s = await readSnapshot(rpc, cfg, inputs({ watched }), 1);
    expect(s.safeNonces).toEqual({ base: { [SAFE_OWNER]: 4n }, bittensor: { [SAFE_OWNER]: 9n } });
    // each read in its own chain's multicall, at that reading's block
    expect(s.base?.block).toBeDefined();
    expect(s.bittensor?.block).toBeDefined();
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
    expect(s.bittensor?.state.payoutBatchFailed).toBeUndefined();
    // a batch read that fails leaves its key out and says so: the batches are then not all known
    state.reverts.add("vault.getPayoutBatch");
    const t = await readSnapshot(rpc, cfg, inputs({ pendingPayoutKeys: pending }), 2);
    expect(t.bittensor?.state.payoutBatches).toEqual({});
    expect(t.bittensor?.state.payoutBatchFailed).toBe(true);
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

  it("reads the chain's list of the coldkey's staking hotkeys, and the stake on each it was told of last time, listed by the vault or not", async () => {
    const state = deploymentState(cfg);
    const swapped = h("the validator's new hotkey");
    // after a hotkey swap: the vault still lists the old hotkey, the chain holds the stake on the new one
    state.bit.stakingHotkeys = [swapped];
    state.bit.stakes = { [swapped]: 49n * 10n ** 9n };
    const { rpc } = fakeDeployment(cfg, state);
    // the first reading after the swap learns the chain's list; the stake on the new hotkey is read from the next
    const first = await readSnapshot(rpc, cfg, inputs({ hotkeys: [d.stakeHotkey] }), 1);
    expect(first.bittensor?.state.stakedHotkeys).toEqual([swapped]);
    expect(first.bittensor?.state.stakes).toEqual({ [d.stakeHotkey]: 0n });
    const next = await readSnapshot(rpc, cfg, inputs({ hotkeys: [d.stakeHotkey], stakedHotkeys: first.bittensor?.state.stakedHotkeys }), 2);
    expect(next.bittensor?.state.stakes).toEqual({ [d.stakeHotkey]: 0n, [swapped]: 49n * 10n ** 9n });
    // the configured stake hotkey is read even when the vault's set no longer lists it
    const other = h("another listed hotkey");
    state.bit.stakes[other] = 5n;
    const unlisted = await readSnapshot(rpc, cfg, inputs({ hotkeys: [other], stakeHotkey: other }), 3);
    expect(unlisted.bittensor?.state.stakes).toEqual({ [other]: 5n, [d.stakeHotkey]: 0n });
    // no entry for the coldkey: an empty list, not unknown
    state.bit.stakingHotkeys = [];
    expect((await readSnapshot(rpc, cfg, inputs(), 4)).bittensor?.state.stakedHotkeys).toEqual([]);
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
    // the validator's root stake: the hour's highest (validator.root_stake_drop compares with a day of them)
    expect(agg.validatorStakeHigh).toBe(1_021_436_954_236_042n);
    // the AlphaVault's backing over wTAO's supply, in ppm: the hour's range (a week of it sets backingToleranceBps)
    expect([agg.backingPpmLow, agg.backingPpmHigh]).toEqual([1_010_000, 1_010_000]);
    state.bit.alpha.backing = 99n * 10n ** 18n;
    const dipped = hourRollup(agg, await readSnapshot(rpc, cfg, inputs(), at(180)));
    expect([dipped.backingPpmLow, dipped.backingPpmHigh]).toEqual([990_000, 1_010_000]);
    expect(quoteAmountOf({ ...bitState({}), maxMessageValue: 15n * 10n ** 18n, bridgeMaxMessageValue: 50n * 10n ** 18n })).toBe(15n * 10n ** 18n);
    expect(quoteAmountOf({ ...bitState({}), bridgeMaxMessageValue: 50n * 10n ** 18n })).toBe(50n * 10n ** 18n);
    expect(quoteAmountOf(undefined)).toBeUndefined();
    const next = hourRollup(agg, await readSnapshot(rpc, cfg, inputs(), at(3600)));
    expect(next).toMatchObject({ hour: 3600 * 1001, ticks: 1, priceHigh: 10n ** 18n - 3n });
  });

  it("an hour row round-trips through its JSON, bigints included", async () => {
    const { rpc } = fakeDeployment(cfg, deploymentState(cfg));
    const agg = hourRollup(undefined, await readSnapshot(rpc, cfg, inputs(), 3600 * 7), 401.5);
    expect(expandHour(compactHour(agg))).toEqual(agg);
    expect(expandHour("not json")).toBeUndefined();
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

  it("reads a live hotkey's Owner as 32 bytes and an absent one as empty (recorded from the chain)", () => {
    expect(ownerStorageKey(reads.stakeHotkey as Hex).length).toBe(2 + 2 * (32 + 16 + 32));
    expect(decodeAccountId(reads.ownerOfStakeHotkey as Hex)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(reads.ownerOfAbsentHotkey).toBe("0x");
    expect(decodeAccountId(reads.ownerOfAbsentHotkey as Hex)).toBeNull();
  });

  it("FM-TAO's supply on Base was within its Bittensor lock when recorded", () => {
    expect(BigInt(reads.fmTao.baseSupply)).toBeLessThanOrEqual(BigInt(reads.fmTao.lockPool));
  });

  it("decodes an account id, and empty storage as null", () => {
    expect(decodeAccountId("0x")).toBeNull();
    expect(decodeAccountId(undefined)).toBeNull();
    expect(decodeAccountId(VALIDATOR_OWNER)).toBe(VALIDATOR_OWNER);
    expect(decodeAccountId("0x1234")).toBeNull();
  });

  it("stakingHotkeysKey is twox128(SubtensorModule) ++ twox128(StakingHotkeys) ++ blake2_128_concat(coldkey)", () => {
    // twox128("StakingHotkeys") from the same xxhash64 that reproduces twox128("SubtensorModule"), ("Owner") and
    // ("BasketTwr") (src/apy.ts); the coldkey's blake2b-128 as ownerStorageKey's test computes a hotkey's
    const coldkey = "0x56a9aee6291bd03ab6d36d4d13e2bebae7cd403518066c72fba1b417d6ddd748" as Hex;
    expect(stakingHotkeysKey(coldkey)).toBe(
      "0x658faa385070e074c85bf6b568cf0555" + "b7d32a0408ab25b30dac6ec2cb66fe1f" + "6c1664b37fae67165907bd92805ee938" + coldkey.slice(2),
    );
    expect(STAKING_HOTKEYS_PREFIX.slice(0, 34)).toBe(OWNER_PREFIX.slice(0, 34));
    expect(stakingHotkeysKey(d.vaultColdkey).length).toBe(2 + 2 * (32 + 16 + 32));
  });

  it("decodes a SCALE Vec<AccountId32>: a compact length then the ids; empty storage as no hotkeys; anything else as null", () => {
    const a = h("a");
    const b = h("b");
    expect(decodeAccountIds("0x")).toEqual([]);
    expect(decodeAccountIds(undefined)).toBeNull();
    expect(decodeAccountIds(encodeAccountIds([]))).toEqual([]);
    expect(encodeAccountIds([])).toBe("0x00");
    expect(decodeAccountIds(encodeAccountIds([a]))).toEqual([a]);
    expect(decodeAccountIds(encodeAccountIds([a, b]))).toEqual([a, b]);
    // 70 ids: a two-byte compact length
    const many = Array.from({ length: 70 }, (_, i) => h(`id ${i}`));
    expect(encodeAccountIds(many).slice(0, 6)).toBe("0x1901");
    expect(decodeAccountIds(encodeAccountIds(many))).toEqual(many);
    // a length that doesn't fit the bytes, an odd value, a lone owner-style word
    expect(decodeAccountIds(`0x08${a.slice(2)}`)).toBeNull();
    expect(decodeAccountIds("0x1234")).toBeNull();
    expect(decodeAccountIds(a)).toBeNull();
    expect(decodeAccountIds("0xzz")).toBeNull();
  });
});

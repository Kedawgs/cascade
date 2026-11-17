import { type Abi, type AbiFunction, decodeFunctionData, encodeAbiParameters, encodeFunctionData, type Hex, keccak256, parseAbi, toBytes, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { CCIP_SELECTOR, MULTICALL3, STAKE_RAMP_S, VAULT_LENS_VIEWS } from "../../src/abi.ts";
import {
  alphaVaultsOf,
  type BitState,
  compact,
  compactHour,
  expand,
  expandHour,
  hourRollup,
  payoutsDone,
  peerIdOf,
  quoteAmountOf,
  railCandidatesOf,
  readSnapshot,
  type SnapshotInputs,
  stillRamping,
} from "../../src/snapshot.ts";
import {
  DELEGATES_PREFIX,
  decodeAccountId,
  decodeAccountIds,
  delegatesKey,
  OWNER_PREFIX,
  ownerStorageKey,
  STAKING_PRECOMPILE,
  STAKING_HOTKEYS_PREFIX,
  stakingHotkeysKey,
  TOTAL_HOTKEY_ALPHA_PREFIX,
  totalHotkeyAlphaKey,
  UIDS_PREFIX,
  uidsKey,
} from "../../src/subtensor.ts";
import deploymentV32 from "../fixtures/deployment-v3.2.json";
import { deploymentState, encodeAccountIds, fakeDeployment, GUARDIAN, KEEPER, OWNER, RAIL_SETUP, TREASURY_WALLET, VALIDATOR_OWNER } from "./fake-deployment.ts";
import { testConfig, testConfigV32 } from "./fixtures.ts";
import { bitState } from "./rule-ctx.ts";
import { reads } from "./v3-test-fixtures.ts";

const cfg = testConfig();
const d = cfg.deployment;
const h = (s: string) => keccak256(toBytes(s)) as Hex;
const lc = (x: string) => x.toLowerCase() as Hex;
/** A view's selector, by name, from an ABI. */
const sel = (abi: Abi, name: string) => toFunctionSelector(abi.find((x): x is AbiFunction => x.type === "function" && x.name === name)!);
const USER = "0x00000000000000000000000000000000000a11ce" as Hex;
const SAFE_OWNER = "0x00000000000000000000000000000000005afe00" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
/** ForeverMoney's 2-of-3 Safe, as the fake registries answer it (fake-deployment.ts FM_SAFE) */
const FM_SAFE = "0xadf60fcc63217961c931d57f1dce2c5d70af3546" as Hex;

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

  it("R12a: asks the front door's redeem request fee, and its primary bridge's fee for a full batch (50 deposits and 50 redeem requests to the vault)", async () => {
    for (const c of [cfg, testConfigV32()]) {
      const state = deploymentState(c);
      const other = "0x00000000000000000000000000000000000b2d9e" as Hex;
      state.base.closeQuoteBridges.push(other);
      const { rpc } = fakeDeployment(c, state);
      const s = await readSnapshot(rpc, c, inputs(), 1);
      // the door's own fee as read: v3-launch's 0.0001 ETH, v3.2's launch 0.0002 ETH (the fake world's)
      expect(s.base?.state).toMatchObject({ redeemRequestFee: c.deployment.version === "v3.2" ? 2n * 10n ** 14n : 10n ** 14n, fullBatchQuote: 4_264_600_000_000_000n });
      // to the vault on Bittensor at the deployment's Base adapter, worth 1 TAO until a reading has named maxBatchValue
      expect(state.asked.closeQuotes).toEqual([{ bridge: lc(c.deployment.baseAdapter), destChain: 964n, recipient: lc(c.deployment.vault), deposits: 50, redeems: 50, amount: 10n ** 18n, sum: 10n ** 18n }]);
      // then worth the front door's batch limit, at the primary bridge the last reading named
      await readSnapshot(rpc, c, inputs({ baseBridge: other, fullBatchAmount: 10n * 10n ** 18n }), 2);
      expect(state.asked.closeQuotes.at(-1)).toEqual({ bridge: other, destChain: 964n, recipient: lc(c.deployment.vault), deposits: 50, redeems: 50, amount: 10n * 10n ** 18n, sum: 10n * 10n ** 18n });
    }
  });

  it("reads each chain's TokenAdminRegistry entry for the rail's token and the lock pool's rebalancer (R3 FM-L2)", async () => {
    const state = deploymentState(cfg);
    const { rpc } = fakeDeployment(cfg, state);
    const s = await readSnapshot(rpc, cfg, inputs(), 1);
    // FM-TAO's entry on Base, wTAO's on Bittensor: ForeverMoney's Safe administers both, none pending, each the watched pool
    expect(s.base?.state.registry).toEqual({ administrator: FM_SAFE, pendingAdministrator: ZERO, tokenPool: cfg.tokens.base.tokenPool });
    expect(s.bittensor?.state.registry).toEqual({ administrator: FM_SAFE, pendingAdministrator: ZERO, tokenPool: cfg.tokens.bittensor.lockPool });
    expect(s.bittensor?.state.lockPoolRebalancer).toBe(ZERO);
    // (another token's entry reads all zeros: these were asked for FM-TAO and wTAO)
    // a failed read leaves only its field unread
    state.reverts.add("bittensor.registry.getTokenConfig");
    state.reverts.add("bittensor.pool.getRebalancer");
    const t = await readSnapshot(rpc, cfg, inputs(), 2);
    expect(t.bittensor?.state.registry).toBeUndefined();
    expect(t.bittensor?.state.lockPoolRebalancer).toBeUndefined();
    expect(t.bittensor?.state.lane?.inbound).toBeDefined();
    expect(t.base?.state.registry).toBeDefined();
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

describe("readSnapshot on a v3.2 deployment (DEPLOYMENT.version v3.2)", () => {
  const cfg32 = testConfigV32();
  const d32 = cfg32.deployment;
  const E18 = 10n ** 18n;
  const STANDBY = h("the standby validator");
  const SECOND_BIT = "0xB17d9E0000000000000000000000000000000B1d" as Hex;
  const SECOND_BASE = "0x89ed499783Be6bD00724Cb268224E727B26731a5" as Hex;
  const A = "0x00000000000000000000000000000000000000a5" as Hex;
  const B = "0x00000000000000000000000000000000000000b6" as Hex;

  it("reads every moved getter through the vault lens and the door lens, in the same one multicall a chain", async () => {
    const state = deploymentState(cfg32);
    const { rpc, net } = fakeDeployment(cfg32, state);
    const s = await readSnapshot(rpc, cfg32, inputs(), 1);
    // the fake's v3.2 vault answers only its token, ownership and pause surface: everything else here came from the lens
    expect(s.bittensor?.state).toMatchObject({
      price: E18,
      totalAssets: 50n * E18,
      totalSupply: 50n * E18,
      // visibleStakeRao(): v3.1's rootStakeRao, the same sum of the listed hotkeys' root stake, in rao
      rootStakeRao: 49n * 10n ** 9n,
      pendingPayouts: 0n,
      paused: false,
      owner: OWNER,
      guardian: GUARDIAN,
      keeper: KEEPER,
      treasury: TREASURY_WALLET,
      stakeHotkey: d32.stakeHotkey,
      hotkeys: [d32.stakeHotkey],
      payoutDelay: 3600,
      burnWindow: { start: 1_700_000_000, burned: 0n },
      lastClaimAt: 1_700_000_000,
      minStakeRao: 2_000_000n,
      rewardCutBps: 1000,
      claimGasRequired: 55_000_000n,
      primaryBridge: d32.bitAdapter,
      maxFeeAbs: 5n * 10n ** 15n,
      maxFeeBps: 100n,
      maxMessageValue: 15n * E18,
      bridgeMaxMessageValue: 50n * E18,
      payoutFeeQuote: 1_315_670_000_000_000n,
      unclaimed: 3n * 10n ** 16n,
    });
    // v3.2 has no pending guardian (setGuardian is a scheduled item)
    expect(s.bittensor?.state).not.toHaveProperty("pendingGuardian");
    expect(s.base?.state).toMatchObject({ owner: OWNER, guardian: GUARDIAN, keeper: KEEPER, oracle: d32.oracle, primaryBridge: d32.baseAdapter, depositCap: 40n * E18, oracleValue: 400_000_000n });
    expect(s.base?.state).not.toHaveProperty("pendingGuardian");
    // one multicall a chain, and on Bittensor the write-off read's gas estimate (R6, claim C), nothing else (no watched
    // address, no code asked)
    expect(net.count()).toBe(3);
  });

  it("R6 (ChatGPT R2 claim C): prices the write-off's aggregate read for the vault's coldkey (eth_estimateGas less the 21,000 a transaction starts with); unread when the node refuses the estimate, and on v3-launch", async () => {
    const state = deploymentState(cfg32);
    state.bit.writeOffReadEstimate = 21_000n + 12_345_678n;
    const asked: unknown[][] = [];
    const { rpc } = fakeDeployment(cfg32, state, { onFetch: (f) => f.methods.forEach((m, i) => m === "eth_estimateGas" && asked.push(f.params[i])) });
    const s = await readSnapshot(rpc, cfg32, inputs(), 1);
    expect(s.bittensor?.state.writeOffReadGas).toBe(12_345_678n);
    // asked of the staking precompile, for the vault's coldkey on root
    expect(asked).toHaveLength(1);
    const tx = asked[0][0] as { to: Hex; data: Hex };
    expect(tx.to.toLowerCase()).toBe("0x0000000000000000000000000000000000000805");
    expect(tx.data).toBe(encodeFunctionData({ abi: parseAbi(["function getTotalColdkeyStakeOnSubnet(bytes32 coldkey, uint256 netuid) view returns (uint256)"]), functionName: "getTotalColdkeyStakeOnSubnet", args: [cfg32.deployment.vaultColdkey, 0n] }));
    state.bit.writeOffReadEstimate = new Error("out of gas");
    const refused = await readSnapshot(fakeDeployment(cfg32, state).rpc, cfg32, inputs(), 1);
    expect(refused.bittensor?.state).not.toHaveProperty("writeOffReadGas");
    expect(refused.bittensor?.state.unlistedStakeRao).toBeDefined();
    const launch = await readSnapshot(fakeDeployment(cfg, deploymentState(cfg)).rpc, cfg, inputs(), 1);
    expect(launch.bittensor?.state).not.toHaveProperty("writeOffReadGas");
  });

  it("R11 (ChatGPT r3, claim 1): the lens's read of the unlisted stake (the write-off's bound) reverting in an answered multicall is recorded as failed outright; never when the lens itself is unchecked or another vault's, nor on v3-launch", async () => {
    const state = deploymentState(cfg32);
    const { rpc } = fakeDeployment(cfg32, state);
    const ok = await readSnapshot(rpc, cfg32, inputs(), 1);
    expect(ok.bittensor?.state.unlistedStakeRao).toBe(0n);
    expect(ok.bittensor?.state).not.toHaveProperty("unlistedStakeFailed");
    // the precompile's getTotalColdkeyStakeOnSubnet failing makes the lens revert: the rest of the reading stands
    state.reverts.add("vault.unlistedStakeRao");
    const failed = await readSnapshot(rpc, cfg32, inputs(), 2);
    expect(failed.bittensor?.state.unlistedStakeFailed).toBe(true);
    expect(failed.bittensor?.state).not.toHaveProperty("unlistedStakeRao");
    expect(failed.bittensor?.state.bookedStake).toBeDefined();
    // the lens unchecked (its target() unanswered): unread, not failed
    state.reverts.add("vault.target");
    const unchecked = await readSnapshot(rpc, cfg32, inputs(), 3);
    expect(unchecked.bittensor?.state.lensUnchecked).toBe(true);
    expect(unchecked.bittensor?.state).not.toHaveProperty("unlistedStakeFailed");
    // another vault's lens: the same
    state.reverts.delete("vault.target");
    state.bit.vaultLensTarget = "0x00000000000000000000000000000000000000e7" as Hex;
    const mismatch = await readSnapshot(rpc, cfg32, inputs(), 4);
    expect(mismatch.bittensor?.state.lensMismatch).toBeDefined();
    expect(mismatch.bittensor?.state).not.toHaveProperty("unlistedStakeFailed");
    const launchState = deploymentState(cfg);
    launchState.reverts.add("vault.unlistedStakeRao");
    const launch = await readSnapshot(fakeDeployment(cfg, launchState).rpc, cfg, inputs(), 1);
    expect(launch.bittensor?.state).not.toHaveProperty("unlistedStakeFailed");
  });

  it("reads the ledger views: booked, ramping, missing, surplus and unlisted stake, the stake guard, gross assets, the vesting schedule and the global window", async () => {
    const state = deploymentState(cfg32);
    Object.assign(state.bit, { bookedStake: 50n * 10n ** 9n, missingStakeRao: 10n ** 9n, stakeMissing: true, unlistedStakeRao: 7n, surplusStakeRao: 0n, lastAdoptAt: 1_799_000_000n });
    const { rpc } = fakeDeployment(cfg32, state);
    const s = await readSnapshot(rpc, cfg32, inputs(), 1);
    expect(s.bittensor?.state).toMatchObject({
      // visibleStakeRao, never the booked stake
      rootStakeRao: 49n * 10n ** 9n,
      bookedStake: 50n * 10n ** 9n,
      // wei, as last written, and when: what still ramps in is that spent over STAKE_RAMP from then
      rampingStake: 2n * 10n ** 18n,
      lastStakeAt: 1_799_978_400,
      missingStakeRao: 10n ** 9n,
      surplusStakeRao: 0n,
      unlistedStakeRao: 7n,
      stakeMissing: true,
      grossAssets: 50n * E18,
      // the write-down and the vesting snapshot log nothing: the schedule is read, never rebuilt from events
      unvestedRewards: 4n * 10n ** 15n,
      vestingAmount: 5n * 10n ** 15n,
      vestingStart: 1_799_990_000,
      vestingPeriod: 86_400,
      rewardVesting: 86_400,
      lastAdoptAt: 1_799_000_000,
      idleBufferBps: 500,
      globalOutflowBps: 3000n,
      // burnWindows(bytes32(0)): every door's window together
      globalWindow: { start: 1_799_000_000, burned: 2n * E18 },
    });
  });

  it("reads the adoption drip beside the claim schedule (Revision 27): with one running, both drips rebuilt at the reading's time are the lens's unvestedRewards", async () => {
    const state = deploymentState(cfg32);
    // the claim schedule 10,000 s into its day, the adoption drip 100,000 s into its 7 days; the lens's total is both
    // drips' sum (CascadeVaultLens.unvestedRewards: CascadeFormulas.unvestedRewards of each at the head's time)
    Object.assign(state.bit, {
      unvestedRewards: 6_925_264_550_264_549n,
      vestingAmount: 5n * 10n ** 15n,
      vestingStart: 1_799_990_000n,
      vestingPeriod: 86_400n,
      adoptVestingAmount: 3n * 10n ** 15n,
      adoptVestingStart: 1_799_900_000n,
      adoptVestingPeriod: 604_800n,
      lastAdoptAt: 1_799_900_000n,
    });
    const { rpc } = fakeDeployment(cfg32, state);
    const s = await readSnapshot(rpc, cfg32, inputs(), 1);
    const bit = s.bittensor!.state;
    expect(bit).toMatchObject({
      vestingAmount: 5n * 10n ** 15n,
      vestingStart: 1_799_990_000,
      vestingPeriod: 86_400,
      adoptVestingAmount: 3n * 10n ** 15n,
      adoptVestingStart: 1_799_900_000,
      adoptVestingPeriod: 604_800,
    });
    // CascadeFormulas.unvestedRewards: amount × what is left of the period / the period, floored; 0 once it is over
    const drip = (amount: bigint, start: number, period: number) => {
      const elapsed = s.bittensor!.time - start;
      return elapsed >= period ? 0n : (amount * BigInt(period - elapsed)) / BigInt(period);
    };
    const claim = drip(bit.vestingAmount!, bit.vestingStart!, bit.vestingPeriod!);
    const adoption = drip(bit.adoptVestingAmount!, bit.adoptVestingStart!, bit.adoptVestingPeriod!);
    // the claim schedule alone is short of the total: the running drip holds the rest
    expect(adoption).toBeGreaterThan(0n);
    expect(claim).toBeLessThan(bit.unvestedRewards!);
    expect(claim + adoption).toBe(bit.unvestedRewards);
  });

  it("works out the part of the ramp still entering the allowance base as the vault does: spent linearly over STAKE_RAMP (a day) from lastStakeAt, at the reading's time", async () => {
    expect(STAKE_RAMP_S).toBe(86_400);
    const { rpc } = fakeDeployment(cfg32, deploymentState(cfg32));
    const s = await readSnapshot(rpc, cfg32, inputs(), 1);
    // six hours of a day gone: three quarters of 2 TAO still ramp in
    expect(s.bittensor?.time).toBe(1_800_000_000);
    expect(stillRamping(s.bittensor!)).toBe(15n * 10n ** 17n);
    const at = (time: number, over: Partial<BitState>) => ({ block: 1n, time, state: { ...s.bittensor!.state, ...over } });
    // the vault's floor (amount × left / period), and none from a day on
    expect(stillRamping(at(1_799_978_400 + 1, { rampingStake: 7n }))).toBe((7n * 86_399n) / 86_400n);
    expect(stillRamping(at(1_799_978_400 + 86_400, {}))).toBe(0n);
    // unknown while either half is unread
    expect(stillRamping(at(1_800_000_000, { lastStakeAt: undefined }))).toBeUndefined();
    expect(stillRamping(at(1_800_000_000, { rampingStake: undefined }))).toBeUndefined();
  });

  it("reads each lens's target() and, when it isn't the deployment's contract, leaves every field read through that lens unread and says which", async () => {
    const OTHER = "0x00000000000000000000000000000000000000e7" as Hex;
    const state = deploymentState(cfg32);
    state.bit.vaultLensTarget = OTHER;
    state.base.doorLensTarget = OTHER;
    const { rpc } = fakeDeployment(cfg32, state);
    const s = await readSnapshot(rpc, cfg32, inputs({ hotkeys: [d32.stakeHotkey], pendingPayoutKeys: [{ key: h("k"), queuedBlock: 1n }] }), 1);
    const bit = s.bittensor!.state;
    for (const k of ["price", "totalAssets", "rootStakeRao", "pendingPayouts", "guardian", "keeper", "treasury", "stakeHotkey", "hotkeys", "bookedStake", "grossAssets", "unvestedRewards", "adoptVestingAmount", "adoptVestingStart", "adoptVestingPeriod", "unlistedStakeRao", "stakeMissing", "rampingStake", "lastStakeAt", "activeDoors"] as const) {
      expect(bit[k], k).toBeUndefined();
    }
    expect(bit.exits).toEqual({});
    expect(bit.payoutBatchFailed).toBe(true);
    // the vault's own surface, the precompile and the bridges are still read
    expect(bit).toMatchObject({ totalSupply: 50n * E18, owner: OWNER, launchChain: 8453n, stakes: { [d32.stakeHotkey]: 49n * 10n ** 9n } });
    expect(bit.adapters?.[d32.bitAdapter]?.parkedNative).toBe(3n * 10n ** 14n);
    expect(bit.lensMismatch).toEqual({ lens: d32.vaultLens, target: OTHER, expected: d32.vault });
    const base = s.base!.state;
    for (const k of ["guardian", "primaryBridge"] as const) expect(base[k], k).toBeUndefined();
    expect(base.exits).toEqual({});
    expect(base).toMatchObject({ owner: OWNER, keeper: KEEPER, potCarried: 7n * 10n ** 13n });
    expect(base.lensMismatch).toEqual({ lens: d32.doorLens, target: OTHER, expected: d32.frontDoor });
    // a target() that fails to answer is unchecked: the fields stay unread, but nothing names a mismatch
    state.bit.vaultLensTarget = d32.vault;
    state.reverts.add("vault.target");
    const t = await readSnapshot(rpc, cfg32, inputs(), 2);
    expect(t.bittensor?.state.price).toBeUndefined();
    expect(t.bittensor?.state).not.toHaveProperty("lensMismatch");
    expect(t.bittensor?.state.lensUnchecked).toBe(true);
    // the right target: read as usual, nothing named
    state.reverts.delete("vault.target");
    const u = await readSnapshot(rpc, cfg32, inputs(), 3);
    expect(u.bittensor?.state.price).toBe(E18);
    expect(u.bittensor?.state).not.toHaveProperty("lensMismatch");
    expect(u.base?.state.lensMismatch).toEqual({ lens: d32.doorLens, target: OTHER, expected: d32.frontDoor });
  });

  it("puts every read that walks the staking precompile without a gas cap last in Bittensor's multicall, unlistedStakeRao the very last", async () => {
    const calls: { target: Hex; selector: Hex }[][] = [];
    const { rpc } = fakeDeployment(cfg32, deploymentState(cfg32), {
      onFetch: (f) => {
        if (f.chain !== "bittensor") return;
        f.methods.forEach((m, i) => {
          if (m !== "eth_call") return;
          const { args } = decodeFunctionData({ abi: MULTICALL3, data: (f.params[i][0] as { data: Hex }).data });
          if (args?.[0]) calls.push((args[0] as readonly { target: Hex; callData: Hex }[]).map((c) => ({ target: lc(c.target), selector: c.callData.slice(0, 10) as Hex })));
        });
      },
    });
    await readSnapshot(rpc, cfg32, inputs({ hotkeys: [d32.stakeHotkey] }), 1);
    const plan = calls.at(-1)!;
    const lens = d32.vaultLens as Hex;
    const walks = new Set(["price", "totalAssets", "grossAssets", "visibleStakeRao", "missingStakeRao", "surplusStakeRao", "stakeMissing", "unlistedStakeRao"].map((n) => `${lens}:${sel(VAULT_LENS_VIEWS, n)}`));
    const precompile = (c: { target: Hex }) => c.target === STAKING_PRECOMPILE.toLowerCase();
    const isWalk = (c: { target: Hex; selector: Hex }) => walks.has(`${c.target}:${c.selector}`) || precompile(c);
    const first = plan.findIndex(isWalk);
    expect(first).toBeGreaterThan(0);
    // from the first such read on, nothing else
    expect(plan.slice(first).every(isWalk)).toBe(true);
    expect(plan.slice(first).length).toBe(walks.size + plan.filter(precompile).length);
    expect(plan.at(-1)).toEqual({ target: lens, selector: sel(VAULT_LENS_VIEWS, "unlistedStakeRao") });
  });

  it("reads the exits machine on both chains (open, each hold, who closed, the clocks, pendingSince), and activeDoors(launchChain) with the door's state", async () => {
    const state = deploymentState(cfg32);
    state.bit.exits = { exitsOpen: false, ownerHold: false, guardianHold: true, pausedBy: 2, primaryDisabledBy: 0, launchDoorRemovedBy: 0, lastOwnerClose: 0n, lastGuardianClose: 1_799_999_000n, pendingSince: 0n };
    state.base.exits = { exitsOpen: true, ownerHold: false, guardianHold: false, primaryDisabledBy: 0, lastOwnerClose: 1_799_500_000n, lastGuardianClose: 0n, pendingSince: 1_799_000_000n };
    state.bit.doorStates[peerIdOf(8453n, d32.frontDoor)] = 1;
    const { rpc } = fakeDeployment(cfg32, state);
    const s = await readSnapshot(rpc, cfg32, inputs(), 1);
    expect(s.bittensor?.state.exits).toEqual({ open: false, ownerHold: false, guardianHold: true, pausedBy: 2, primaryDisabledBy: 0, launchDoorRemovedBy: 0, lastOwnerClose: 0, lastGuardianClose: 1_799_999_000, pendingSince: 0 });
    expect(s.base?.state.exits).toEqual({ open: true, ownerHold: false, guardianHold: false, primaryDisabledBy: 0, lastOwnerClose: 1_799_500_000, lastGuardianClose: 0, pendingSince: 1_799_000_000 });
    expect(s.bittensor?.state).toMatchObject({ launchChain: 8453n, activeDoors: 1n, doorState: 1 });
    // each scheduler's block time as the deploy calibrated it, through its lens: the lapse counts its window in blocks in it
    expect(s.bittensor?.state.msPerBlock).toBe(7_200);
    expect(s.base?.state.msPerBlock).toBe(120);
    // activeDoors is asked for the launch chain (Base, 8453), doorState for the configured front door's peer id
    expect(state.asked.activeDoorsOf).toEqual([8453n]);
    expect(state.asked.doorStateOf).toEqual([peerIdOf(8453n, d32.frontDoor)]);
  });

  it("reads each Bittensor bridge's park totals, reserve targets, TAO and wTAO, each Base bridge's ETH and FM-TAO, and the AlphaVault's migrationReadyAt", async () => {
    const cfgB = testConfigV32({ BRIDGES: JSON.stringify({ base: [deploymentV32.baseAdapter, SECOND_BASE], bittensor: [deploymentV32.bitAdapter, SECOND_BIT] }) });
    const db = cfgB.deployment;
    const second = SECOND_BIT.toLowerCase() as Hex;
    const state = deploymentState(cfgB);
    state.bit.quoteBridges.push(second);
    state.bit.wTaoOf[db.bitAdapter] = 2n * 10n ** 15n;
    state.bit.alpha.migrationReadyAt = 1_900_000_000n;
    state.base.ethOf[db.baseAdapter] = 5n;
    state.base.fmTaoOf[db.baseAdapter] = 6n;
    const { rpc } = fakeDeployment(cfgB, state);
    const s = await readSnapshot(rpc, cfgB, inputs(), 1);
    // the token cushion booked (R4, F-1), beside the wTAO it holds
    const parks = { parkedNative: 3n * 10n ** 14n, parkedTokens: 0n, reserveTarget: 10n ** 15n, tokenReserveTarget: 10n ** 15n, tokenCushion: 10n ** 15n };
    expect(s.bittensor?.state.adapters).toEqual({
      [db.bitAdapter]: { balance: 10n ** 13n, tokens: 2n * 10n ** 15n, ...parks },
      [second]: { balance: 0n, tokens: 0n, ...parks },
    });
    expect(s.base?.state.adapters).toEqual({ [db.baseAdapter]: { balance: 5n, tokens: 6n }, [SECOND_BASE.toLowerCase()]: { balance: 0n, tokens: 0n } });
    expect(s.bittensor?.state.alpha.migrationReadyAt).toBe(1_900_000_000n);
  });

  it("reads each rail half on its own chain, at that chain's one block: every BRIDGES adapter's peer and the peer's chain, and whether its chain's contract has it enabled and has ever had it (rails.incoherent)", async () => {
    const N = "0x00000000000000000000000000000000000b2b2b" as Hex;
    const N2 = "0x00000000000000000000000000000000000b1b1b" as Hex;
    // a Bittensor half also answers canSendPayouts() (R4, S-H1): open while its AlphaVault is
    const BIT_HALF = { ...RAIL_SETUP.bittensor, canSendPayouts: true };
    const state = deploymentState(cfg32);
    const { rpc } = fakeDeployment(cfg32, state);
    const s = await readSnapshot(rpc, cfg32, inputs(), 1);
    // the launch rail: the Base adapter names the Bittensor adapter on Bittensor (964), and back on Base (8453); and each
    // half's setup, which a new pair must share with the deploy's adapter (R4-O's fix round, Minor 8)
    expect(s.base?.state.rails).toEqual({ [d32.baseAdapter]: { remote: d32.bitAdapter, remoteChainId: 964n, enabled: true, known: true, ...RAIL_SETUP.base } });
    expect(s.bittensor?.state.rails).toEqual({ [d32.bitAdapter]: { remote: d32.baseAdapter, remoteChainId: 8453n, enabled: true, known: true, ...BIT_HALF } });
    // beyond BRIDGES, the candidates the last readings named: here N (never enabled on the front door) and N' (enabled)
    const more = deploymentState(cfg32);
    more.base.rails[N] = { remoteAdapter: N2, remoteChainId: 964n, enabled: false, known: false };
    const OTHER = "0x00000000000000000000000000000000000c4c4c" as Hex;
    more.bit.rails[N2] = { remoteAdapter: N, remoteChainId: 8453n, enabled: true, known: true, router: OTHER };
    const { rpc: rpc2 } = fakeDeployment(cfg32, more);
    const t = await readSnapshot(rpc2, cfg32, inputs({ railCandidates: { base: [N, d32.baseAdapter], bittensor: [N2] } }), 2);
    expect(t.base?.state.rails).toEqual({ [d32.baseAdapter]: { remote: d32.bitAdapter, remoteChainId: 964n, enabled: true, known: true, ...RAIL_SETUP.base }, [N]: { remote: N2, remoteChainId: 964n, enabled: false, known: false, ...RAIL_SETUP.base } });
    expect(t.bittensor?.state.rails).toEqual({ [d32.bitAdapter]: { remote: d32.baseAdapter, remoteChainId: 8453n, enabled: true, known: true, ...BIT_HALF }, [N2]: { remote: N, remoteChainId: 8453n, enabled: true, known: true, ...BIT_HALF, router: OTHER } });
    // the deploy's adapters are read as rail halves (the fields' reference) even when BRIDGES doesn't list them
    const cfgOther = testConfigV32({ BRIDGES: JSON.stringify({ base: [SECOND_BASE], bittensor: [deploymentV32.bitAdapter] }) });
    const { rpc: rpc3 } = fakeDeployment(cfgOther, deploymentState(cfgOther));
    const o3 = await readSnapshot(rpc3, cfgOther, inputs(), 6);
    expect(o3.base?.state.rails?.[d32.baseAdapter]).toEqual({ remote: d32.bitAdapter, remoteChainId: 964n, enabled: true, known: true, ...RAIL_SETUP.base });
    // a read that fails is left unread, never false: an adapter's peer, the vault lens's bridgeEnabled
    state.reverts.add("bridge.remoteAdapter");
    state.reverts.add("vault.bridgeEnabled");
    const u = await readSnapshot(rpc, cfg32, inputs(), 3);
    expect(u.bittensor?.state.rails?.[d32.bitAdapter]).toEqual({ remoteChainId: 8453n, known: true, ...BIT_HALF });
    // a door lens that reads another contract: enabled and known unread; the adapter's own immutables are still read
    state.base.doorLensTarget = "0x00000000000000000000000000000000000000e7" as Hex;
    const w = await readSnapshot(rpc, cfg32, inputs(), 4);
    expect(w.base?.state.rails).toEqual({ [d32.baseAdapter]: { remote: d32.bitAdapter, remoteChainId: 964n, ...RAIL_SETUP.base } });
    // canSendPayouts() as the adapter answers it: false while its AlphaVault is paused; a failing read left unread
    state.bit.alpha.isPaused = true;
    expect((await readSnapshot(rpc, cfg32, inputs(), 7)).bittensor?.state.rails?.[d32.bitAdapter]?.canSendPayouts).toBe(false);
    state.reverts.add("bridge.canSendPayouts");
    expect((await readSnapshot(rpc, cfg32, inputs(), 8)).bittensor?.state.rails?.[d32.bitAdapter]).not.toHaveProperty("canSendPayouts");
    // a v3-launch deployment reads none of it
    const { rpc: rpc31 } = fakeDeployment(cfg, deploymentState(cfg));
    const v = await readSnapshot(rpc31, cfg, inputs({ railCandidates: { base: [N], bittensor: [N2] } }), 5);
    expect(v.base?.state).not.toHaveProperty("rails");
    expect(v.bittensor?.state).not.toHaveProperty("rails");
  });

  it("R4-O round 4: alphaVaultsOf names the AlphaVaults of the rail now primary on each chain from the last readings (TOKENS' for a half not read yet), and the deploy adapter's own; the snapshot reads ForeverMoney's state there, as one", async () => {
    const N = "0x00000000000000000000000000000000000b2b2b" as Hex;
    const N2 = "0x00000000000000000000000000000000000b1b1b" as Hex;
    const NEW = "0x00000000000000000000000000000000000a2fa0" as Hex;
    const tokensVault = cfg32.tokens.bittensor.alphaVault;
    const base = { primaryBridge: N, rails: { [N]: { remote: N2 } } } as unknown as Parameters<typeof alphaVaultsOf>[0]["base"];
    const bit = { primaryBridge: N2, rails: { [N2]: { alphaVault: NEW }, [d32.bitAdapter]: { alphaVault: tokensVault } } } as unknown as Parameters<typeof alphaVaultsOf>[0]["bittensor"];
    expect(alphaVaultsOf({ base, bittensor: bit }, cfg32)).toEqual({ primary: [NEW], deploy: tokensVault });
    // the door's half not read yet: TOKENS' in its place
    expect(alphaVaultsOf({ base: { ...base, rails: {} } as never, bittensor: bit }, cfg32)).toEqual({ primary: [tokensVault, NEW], deploy: tokensVault });
    expect(alphaVaultsOf({}, cfg32)).toEqual({ primary: [tokensVault], deploy: undefined });
    // read at both (half switched): paused when either is, the notice the later one
    const state = deploymentState(cfg32);
    state.bit.vaults[NEW] = { ...state.bit.alpha, isPaused: true, migrationReadyAt: 5n };
    state.bit.alpha.migrationReadyAt = 9n;
    const { rpc } = fakeDeployment(cfg32, state);
    const s = await readSnapshot(rpc, cfg32, inputs({ alphaVaults: { primary: [tokensVault, NEW], deploy: tokensVault } }), 1);
    expect(s.bittensor?.state.alphaVaults).toEqual([tokensVault, NEW]);
    expect(s.bittensor?.state.alpha).toMatchObject({ isPaused: true, migrationReadyAt: 9n, migrationFinished: false });
    expect(s.bittensor?.state.deployAlpha).toEqual({ vault: tokensVault, migrationTarget: "0x0000000000000000000000000000000000000000", migrationFinished: false, migrationExecuted: false });
    // the new vault alone
    const t = await readSnapshot(rpc, cfg32, inputs({ alphaVaults: { primary: [NEW], deploy: tokensVault } }), 2);
    expect(t.bittensor?.state.alpha).toMatchObject({ isPaused: true, migrationReadyAt: 5n });
    // the target rule's vault is the deploy adapter's own, whatever TOKENS names
    const u = await readSnapshot(rpc, cfg32, inputs({ alphaVaults: { primary: [NEW], deploy: NEW } }), 3);
    expect(u.bittensor?.state.deployAlpha).toMatchObject({ vault: NEW, migrationFinished: false });
    expect(u.bittensor?.state.deployAlpha?.vault).not.toBe(tokensVault);
  });

  it("railCandidatesOf: the last readings' primaries, and the half on each chain that the other chain's primary names", () => {
    const N = "0x00000000000000000000000000000000000b2b2b" as Hex;
    const N2 = "0x00000000000000000000000000000000000b1b1b" as Hex;
    expect(railCandidatesOf({})).toEqual({ base: [], bittensor: [] });
    const base = { taoWethPool: {}, wethUsdcPool: {}, claimable: {}, deliveryOf: {}, primaryBridge: N, rails: { [N]: { remote: N2, remoteChainId: 964n, enabled: true, known: true } } };
    const bit = bitState({ primaryBridge: d32.bitAdapter, rails: { [d32.bitAdapter]: { remote: d32.baseAdapter, remoteChainId: 8453n, enabled: true, known: true } } });
    expect(railCandidatesOf({ base, bittensor: bit })).toEqual({ base: [N, d32.baseAdapter], bittensor: [d32.bitAdapter, N2] });
    // a peer unread names nothing; a primary that is its own chain's peer of the other is listed once
    expect(railCandidatesOf({ base: { ...base, rails: {} }, bittensor: bitState({ primaryBridge: N2, rails: { [N2]: { remote: N } } }) })).toEqual({ base: [N], bittensor: [N2] });
  });

  it("reads the oracle's meanLiquidity and MIN_CARDINALITY beside the pools' cardinality, the front door's floors, minimum deposit and carried pot", async () => {
    const state = deploymentState(cfg32);
    const { rpc } = fakeDeployment(cfg32, state);
    const s = await readSnapshot(rpc, cfg32, inputs(), 1);
    expect(s.base?.state).toMatchObject({
      meanLiquidity: { taoWeth: 6n * 10n ** 17n, wethUsdc: 2n * 10n ** 17n },
      minCardinality: 1_801,
      // the front door's block time as the deploy calibrated it, through its lens (Revision 28)
      msPerBlock: 120,
      // minPoolLiquidity(0) is the TAO/WETH pool's floor, (1) the WETH/USDC pool's (CascadeFrontDoor.deliver)
      minPoolLiquidity: { taoWeth: 10n ** 17n, wethUsdc: 10n ** 16n },
      minDeposit: 3n * 10n ** 16n,
      potCarried: 7n * 10n ** 13n,
      taoWethPool: { cardinality: 2000, cardinalityNext: 2000 },
      wethUsdcPool: { cardinality: 5000, cardinalityNext: 5000 },
    });
  });

  it("reads the owner's code, threshold and signers on both chains (the owner the last reading named): a threshold and signers only from a contract's own code", async () => {
    const DELEGATED = "0x0000000000000000000000000000000000007702" as Hex;
    const state = deploymentState(cfg32);
    for (const chain of [state.base, state.bit]) {
      chain.safeOwners[SAFE_OWNER] = { threshold: 2n, owners: [A, B, OWNER] };
      chain.safeOwners[DELEGATED] = { threshold: 1n, owners: [A] };
    }
    const { rpc, specs } = fakeDeployment(cfg32, state);
    for (const c of [specs.base, specs.bittensor]) c.code = { [SAFE_OWNER]: "0x6080604052", [DELEGATED]: `0xef0100${"ab".repeat(20)}` };
    const s = await readSnapshot(rpc, cfg32, inputs({ owners: { base: SAFE_OWNER, bittensor: SAFE_OWNER } }), 1);
    for (const r of [s.base?.state, s.bittensor?.state]) expect(r?.ownerSafe).toEqual({ address: SAFE_OWNER, threshold: 2n, signers: [A, B, OWNER] });
    // the owner's code is read in the counts batch, whether or not codesOf names it
    expect(s.codes?.base[SAFE_OWNER]).toBe("0x6080604052");
    expect(s.codes?.bittensor[SAFE_OWNER]).toBe("0x6080604052");
    // an account (no code: nothing decodes) and an EIP-7702 delegation (its delegate may answer) are no Safe
    const t = await readSnapshot(rpc, cfg32, inputs({ owners: { base: OWNER, bittensor: DELEGATED } }), 2);
    expect(t.base?.state.ownerSafe).toEqual({ address: OWNER });
    expect(t.bittensor?.state.ownerSafe).toEqual({ address: DELEGATED });
    // no owner named yet (the first reading): none asked
    const { rpc: fresh } = fakeDeployment(cfg32, deploymentState(cfg32));
    expect((await readSnapshot(fresh, cfg32, inputs(), 3)).base?.state).not.toHaveProperty("ownerSafe");
  });

  it("reads both validators: the primary (the stake hotkey) and the standby (STANDBY_HOTKEY), each its take, root stake and root uid", async () => {
    const cfgS = testConfigV32({ STANDBY_HOTKEY: STANDBY });
    const state = deploymentState(cfgS);
    // take 42 of 65,535; 1e10 rao on root; uid 7
    state.bit.storageOf[STANDBY] = { delegates: "0x2a00", totalHotkeyAlpha: "0x00e40b5402000000", uids: "0x0700" };
    const { rpc } = fakeDeployment(cfgS, state);
    const s = await readSnapshot(rpc, cfgS, inputs(), 1);
    expect(s.bittensor?.state.validator).toEqual({ hotkey: d32.stakeHotkey, take: 0, rootStake: 1_021_436_954_236_042n, rootUid: 1 });
    expect(s.bittensor?.state.standby).toEqual({ hotkey: STANDBY, take: 42, rootStake: 10_000_000_000n, rootUid: 7 });
    // a configuration value, never a constant: on a v3.1 deployment too
    const cfg31 = testConfig({ STANDBY_HOTKEY: STANDBY });
    const { rpc: rpc31 } = fakeDeployment(cfg31, state);
    expect((await readSnapshot(rpc31, cfg31, inputs(), 2)).bittensor?.state.standby).toEqual({ hotkey: STANDBY, take: 42, rootStake: 10_000_000_000n, rootUid: 7 });
    // the hour's aggregates keep the standby's root stake, the hour's highest, beside the primary's
    expect(hourRollup(undefined, s).standbyStakeHigh).toBe(10_000_000_000n);
  });

  it("STANDBY_HOTKEY unset reads no standby: no other hotkey's validator storage is asked, and nothing fails", async () => {
    for (const c of [cfg32, cfg]) {
      const state = deploymentState(c);
      const { rpc } = fakeDeployment(c, state);
      const s = await readSnapshot(rpc, c, inputs(), 1);
      expect(c.standbyHotkey).toBeUndefined();
      expect(s.bittensor?.state).not.toHaveProperty("standby");
      expect(s.bittensor?.state.validator).toEqual({ hotkey: c.deployment.stakeHotkey, take: 0, rootStake: 1_021_436_954_236_042n, rootUid: 1 });
      const validatorKeys = state.asked.storageKeys.filter((k) => [DELEGATES_PREFIX, TOTAL_HOTKEY_ALPHA_PREFIX, UIDS_PREFIX].some((p) => k.startsWith(p)));
      expect(validatorKeys).toEqual([delegatesKey(c.deployment.stakeHotkey), totalHotkeyAlphaKey(c.deployment.stakeHotkey, 0), uidsKey(0, c.deployment.stakeHotkey)]);
      expect(hourRollup(undefined, s).standbyStakeHigh).toBeUndefined();
    }
  });

  it("reads the unclaimed root rewards of every hotkey in the set, not only the stake hotkey's", async () => {
    const other = h("a second listed hotkey");
    const state = deploymentState(cfg32);
    state.bit.hotkeys = [d32.stakeHotkey, other];
    state.bit.unclaimedOf[other] = 5n;
    const { rpc } = fakeDeployment(cfg32, state);
    const s = await readSnapshot(rpc, cfg32, inputs({ hotkeys: [d32.stakeHotkey, other] }), 1);
    expect(s.bittensor?.state.unclaimedBy).toEqual({ [d32.stakeHotkey]: 3n * 10n ** 16n, [other]: 5n });
  });

  it("reads the limits a scheduled setter is judged against (the entry and message caps, minChunk, maxTotalAssets, the delivery slippage) and the hotkey dust allowance", async () => {
    const { rpc } = fakeDeployment(cfg32, deploymentState(cfg32));
    const s = await readSnapshot(rpc, cfg32, inputs(), 1);
    expect(s.bittensor?.state).toMatchObject({ maxEntryValue: 10n * E18, maxMessageValue: 15n * E18, minChunk: 5, maxTotalAssets: 44n * E18, hotkeyDustRao: 1000n });
    expect(s.base?.state).toMatchObject({ maxDeliverySlippageBps: 150 });
    // v3-launch reads none of them
    const v31 = await readSnapshot(fakeDeployment(cfg, deploymentState(cfg)).rpc, cfg, inputs(), 1);
    for (const k of ["maxEntryValue", "minChunk", "maxTotalAssets", "hotkeyDustRao"]) expect(v31.bittensor?.state, k).not.toHaveProperty(k);
    expect(v31.base?.state).not.toHaveProperty("maxDeliverySlippageBps");
  });

  it("reads each scheduled item it is given through its chain's lens (an id the lens doesn't hold reads the empty item)", async () => {
    const state = deploymentState(cfg32);
    const item = { scheduledAt: 1_799_000_000n, readyAt: 1_799_172_800n, class: 0, kind: 0, selector: "0x12345678" as Hex, readyBlock: 9_500_000n };
    state.bit.scheduled[h("vault item")] = item;
    state.base.scheduled[h("door item")] = { ...item, kind: 2, readyBlock: 37_200_000n };
    const { rpc } = fakeDeployment(cfg32, state);
    const ids = [
      { chain: "bittensor" as const, id: h("vault item") },
      { chain: "base" as const, id: h("door item") },
      { chain: "base" as const, id: h("gone") },
    ];
    const s = await readSnapshot(rpc, cfg32, inputs({ scheduledIds: ids }), 1);
    const read = { scheduledAt: 1_799_000_000, readyAt: 1_799_172_800, class: 0, kind: 0, selector: "0x12345678", readyBlock: 9_500_000n };
    expect(s.bittensor?.state.scheduled).toEqual({ [h("vault item")]: read });
    expect(s.base?.state.scheduled).toEqual({
      [h("door item")]: { ...read, kind: 2, readyBlock: 37_200_000n },
      [h("gone")]: { scheduledAt: 0, readyAt: 0, class: 0, kind: 0, selector: "0x00000000", readyBlock: 0n },
    });
  });

  it("reads each pending payout batch through the vault lens", async () => {
    const state = deploymentState(cfg32);
    state.bit.payoutBatches[h("still")] = { queuedAt: 1n, cursor: 1, count: 3, chunk: 1, remaining: 5n };
    const { rpc, heads } = fakeDeployment(cfg32, state);
    const pending = [{ key: h("still"), queuedBlock: heads.bittensor - 100n }];
    const s = await readSnapshot(rpc, cfg32, inputs({ pendingPayoutKeys: pending }), 1);
    expect(s.bittensor?.state.payoutBatches[h("still")]).toEqual({ queuedAt: 1, cursor: 1, count: 3, chunk: 1, remaining: 5n });
    expect(s.bittensor?.state.payoutBatchFailed).toBeUndefined();
  });

  it("a failed lens read leaves only its field unread", async () => {
    const state = deploymentState(cfg32);
    for (const r of ["vault.bookedStake", "vault.unlistedStakeRao", "doorLens.exitsOpen", "base.oracle.meanLiquidity", "bridge.parkedNative"]) state.reverts.add(r);
    const { rpc } = fakeDeployment(cfg32, state);
    const s = await readSnapshot(rpc, cfg32, inputs(), 1);
    expect(s.bittensor?.state.bookedStake).toBeUndefined();
    expect(s.bittensor?.state.unlistedStakeRao).toBeUndefined();
    expect(s.bittensor?.state.missingStakeRao).toBe(0n);
    expect(s.base?.state.exits?.open).toBeUndefined();
    expect(s.base?.state.exits?.ownerHold).toBe(false);
    expect(s.base?.state.meanLiquidity).toBeUndefined();
    expect(s.bittensor?.state.adapters?.[d32.bitAdapter]?.parkedNative).toBeUndefined();
    expect(s.bittensor?.state.adapters?.[d32.bitAdapter]?.parkedTokens).toBe(0n);
  });

  it("a v3.1 deployment (v3-launch) reads none of it, whatever it is given", async () => {
    const state = deploymentState(cfg);
    const { rpc } = fakeDeployment(cfg, state);
    const s = await readSnapshot(rpc, cfg, inputs({ owners: { base: OWNER, bittensor: OWNER }, scheduledIds: [{ chain: "base", id: h("x") }] }), 1);
    for (const k of ["bookedStake", "stakeMissing", "exits", "adapters", "scheduled", "ownerSafe", "launchChain", "activeDoors", "doorState", "unclaimedBy", "globalWindow", "vestingAmount", "adoptVestingAmount"]) {
      expect(s.bittensor?.state, k).not.toHaveProperty(k);
    }
    for (const k of ["primaryBridge", "exits", "adapters", "scheduled", "ownerSafe", "meanLiquidity", "minCardinality", "potCarried", "minPoolLiquidity", "minDeposit"]) {
      expect(s.base?.state, k).not.toHaveProperty(k);
    }
    // its own reads as before: the pending guardians, rootStakeRao from the vault
    expect(s.bittensor?.state).toMatchObject({ pendingGuardian: "0x0000000000000000000000000000000000000000", rootStakeRao: 49n * 10n ** 9n });
    expect(s.base?.state.pendingGuardian).toBe("0x0000000000000000000000000000000000000000");
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

import { type Address, encodeAbiParameters, encodeEventTopics, type Hex, parseAbi, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { CLAIM_POLICY } from "../src/config.ts";
import { type KeeperDeps, type KeeperState, launchTarget, runLoop } from "../src/keeper/actions.ts";
import type { DeliveryRead } from "../src/keeper/core/delivery.ts";
import {
  encodeMemory,
  freshMemory,
  fromJson,
  type KeeperMemory,
  loadMemory,
  MEMORY_VERSION,
  MemoryTooNew,
  revertOf,
  saveRevert,
  toJson,
} from "../src/keeper/core/memory.ts";
import { roundDue, runRound } from "../src/keeper/core/round.ts";
import { DESTINATION_BASE } from "../src/keeper/delivery.ts";
import { payoutsHash } from "../src/keeper/payouts.ts";
import type { RewardsRead } from "../src/keeper/rewards.ts";
import type { StatusDetail } from "../src/keeper/status.ts";
import { ReceiptTimeout, RevertedOnChain, type Sent, SendRefused } from "../src/send.ts";
import type { CallRequest } from "../src/types.ts";
import { SENT, stubDeps, v3Record } from "./fake-keeper.ts";

const TAO = 10n ** 18n;
const T = 1_800_000_000;
const KEY: Hex = `0x${"aa".repeat(32)}`;
const H1: Hex = `0x${"71".repeat(32)}`;
const H2: Hex = `0x${"72".repeat(32)}`;
const MSG: Hex = `0x${"5e".repeat(32)}`;
const alice: Address = "0x000000000000000000000000000000000000a11c";
const rec = v3Record();

const quiet: KeeperState = {
  now: T,
  frontDoor: { canClose: false, nDeposits: 0, nRedeems: 0, paused: false, openStart: T, batchInterval: 600, full: false, now: T },
  closeMaxWaitS: 0,
  alphaVault: { healthy: true },
  vault: { paused: false, available: 0n, minStakeWei: 2n * 10n ** 15n, rootStake: 0n, nominatorMinWei: 0n, batches: [], payoutDelay: 3600 },
  detail: { claimable: [] } as unknown as StatusDetail,
};
const closeDue: KeeperState = { ...quiet, frontDoor: { ...quiet.frontDoor, canClose: true, nDeposits: 1, openStart: T - 600 } };
const payoutDue: KeeperState = { ...quiet, vault: { ...quiet.vault, batches: [{ key: KEY, queuedAt: T - 7200, cursor: 0, count: 1 }] } };
const stakeDue: KeeperState = { ...quiet, vault: { ...quiet.vault, available: TAO } };
const paused: KeeperState = { ...stakeDue, vault: { ...stakeDue.vault, paused: true } };

/** The Base adapter's Sent log, so a late receipt records its bridge message. */
const SENT_LOG = {
  address: rec.plan.addresses.baseAdapter,
  topics: encodeEventTopics({
    abi: parseAbi(["event Sent(bytes32 indexed messageId, uint64 destChain, address indexed sender, address indexed recipient, uint256 amount, uint256 fee, uint256 gasLimit)"]),
    eventName: "Sent",
    args: { messageId: MSG, sender: rec.plan.addresses.frontDoor, recipient: rec.plan.addresses.vault },
  }) as Hex[],
  data: encodeAbiParameters(parseAbiParameters("uint64, uint256, uint256, uint256"), [1n, 0n, 0n, 0n]),
};

const req = (fn: string): CallRequest => ({ chain: "base", nonce: 4, label: fn, to: rec.plan.addresses.frontDoor, abi: [], functionName: fn, args: [] });

/** A recorded scenario: per round (counted by refresh, the round's first call), what each readState answers in turn,
 * what each send throws (or a success), the receipt lookups, and the wallet's mined nonce. */
const SCRIPT: { reads: (KeeperState | Error)[]; sends?: (Error | undefined)[]; receipt?: { reverted: boolean; logs: Sent["logs"] } | null }[] = [
  // 1: a close goes out with no receipt yet: watched
  { reads: [closeDue, closeDue], sends: [new ReceiptTimeout("base", 4, H1, req("closeBatch"))] },
  // 2-4: a payout its simulation refuses three times: the breaker trips; then alice's delivery (credited in round 4)
  // reverts (her budget)
  { reads: [payoutDue, payoutDue], sends: [new SendRefused("estimate", "Bittensor: pay out batch would fail, nothing sent (PayoutDelayed())")], receipt: null },
  { reads: [payoutDue, payoutDue], sends: [new SendRefused("estimate", "Bittensor: pay out batch would fail, nothing sent (PayoutDelayed())")], receipt: null },
  {
    reads: [payoutDue, payoutDue],
    sends: [new SendRefused("estimate", "Bittensor: pay out batch would fail, nothing sent (PayoutDelayed())"), new RevertedOnChain("base", "deliver", H2, "BelowMinimum()")],
    receipt: null,
  },
  // 5: the close's late receipt lands (its bridge message recorded); a stake reverts and the chains can't be read again
  { reads: [stakeDue, stakeDue, new Error("the node is down")], sends: [new RevertedOnChain("bittensor", "stake the vault's idle TAO", H2)], receipt: { reverted: false, logs: [SENT_LOG] } },
  // 6: the next round's read explains it (the vault was paused)
  { reads: [paused] },
  // 7-12: quiet rounds while the breaker's back-off and alice's hold run
  { reads: [quiet] },
  { reads: [payoutDue] },
  { reads: [payoutDue] },
  { reads: [payoutDue, payoutDue] },
  { reads: [payoutDue, payoutDue] },
  { reads: [payoutDue, payoutDue] },
];

/** The scenario's chain: the same answers to the same calls, however the run is split. */
function world() {
  let round = 0;
  let read = 0;
  let sent = 0;
  const lines: string[] = [];
  const sends: { fn: string; args: unknown[]; value?: bigint }[] = [];
  const messages: Hex[] = [];
  const step = () => SCRIPT[Math.min(round, SCRIPT.length) - 1];
  const delivery: DeliveryRead = {
    user: alice,
    claimable: TAO,
    pref: { minUsdcPerTao: 1n, deadline: T + 86_400 * 30, destination: DESTINATION_BASE },
    quoteUsdc: 400_000_000n,
    twapUsdc: 400_000_000n,
    slippageBps: 150,
    now: T,
  };
  const rewards: RewardsRead = {
    hotkey: `0x${"11".repeat(32)}`,
    waitingWei: 2n * TAO,
    lastClaimAt: T - 86_400,
    now: T,
    taoPriceUsd: 400,
    claimGasRequired: 55_000_000n,
    gasPriceWei: 10n ** 10n,
    walletWei: TAO,
  };
  const deps: KeeperDeps = stubDeps({
    refresh: () => {
      round++;
      read = 0;
      sent = 0;
    },
    readState: async () => {
      const r = step().reads[Math.min(read++, step().reads.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
    sendCall: async (r) => {
      sends.push({ fn: r.functionName, args: r.args, value: r.value });
      const e = step().sends?.[sent++];
      if (e) throw e;
      return { ...SENT, logs: [] };
    },
    quoteClose: async () => 1n,
    payoutLogs: async () => [{ kind: "redeemed", key: KEY, user: alice, shares: 1n, assets: TAO, blockNumber: 1n, logIndex: 0 }],
    batchInfo: async () => ({ payoutsHash: payoutsHash([{ user: alice, shares: 1n, assets: TAO }]), count: 1 }),
    readRewards: async () => rewards,
    deliveryCandidates: async () => [alice],
    // alice's TAO is credited from round 4 on
    readDelivery: async () => (round >= 4 ? delivery : { ...delivery, claimable: 0n }),
    simulateDeliver: async () => ({ ok: true, usdcOut: 399_000_000n }),
    receipt: async () => step().receipt ?? null,
    minedNonce: async () => 4,
    recordMessage: (m) => void messages.push(m.id),
    log: (l) => void lines.push(l),
  });
  return { deps, lines, sends, messages, time: T * 1000 };
}

const OPTS = { intervalMs: 60_000, policy: CLAIM_POLICY, rewardsEveryTicks: 1000 };
const ROUNDS = SCRIPT.length;

describe("a run split across invocations behaves as one loop", () => {
  it("aRunSplitAcrossInvocationsBehavesAsOneLoop: the memory through JSON between every round of a recorded scenario", async () => {
    // one loop, its memory in the process
    const a = world();
    const loopMemory = freshMemory();
    const end = await runLoop(a.deps, rec, { ...OPTS, maxTicks: ROUNDS, now: () => a.time, sleep: async (ms) => void (a.time += ms) }, loopMemory);
    expect(end).toEqual({ stopped: false });

    // the same scenario, one invocation a round: each loads the memory from the last one's JSON and saves its own
    const b = world();
    let saved = encodeMemory(freshMemory());
    for (let i = 0; i < ROUNDS; i++) {
      const { memory } = loadMemory(saved);
      const r = await runRound(b.deps, launchTarget(rec), memory, { ...OPTS, now: () => b.time });
      expect(r.end).toBeUndefined();
      saved = encodeMemory(r.memory);
      if (i < ROUNDS - 1) b.time += r.waitMs;
    }

    expect(b.lines).toEqual(a.lines);
    expect(b.sends).toEqual(a.sends);
    expect(b.messages).toEqual(a.messages);
    expect(fromJson<KeeperMemory>(saved)).toEqual(fromJson<KeeperMemory>(encodeMemory(loopMemory)));

    // the scenario exercised every kind of memory: a watched transaction, the breaker, a revert budget, an unread revert
    const said = (re: RegExp) => expect(a.lines.some((l) => re.test(l)), String(re)).toBe(true);
    said(/^Rewards: a claim is due/);
    said(/^Failed this round \(no receipt yet, closing the batch\)/);
    said(/^SKIPPING paying out batch 0xaaaaaaaa…: refused 3 times in a row/);
    said(/^Delivery to 0x000000000000000000000000000000000000a11c waits: Base: deliver reverted on chain \(transaction 0x7272/);
    said(/^Late receipt: closing the batch went through \(transaction 0x7171.*bridge message 0x5e5e/);
    said(/^Failed this round \(a revert not yet explained, staking\)/);
    said(/^Not done: the vault was paused; the transaction reverted on chain \(transaction 0x7272/);
    said(/^Recovered after/);
    expect(a.messages).toEqual([MSG]);
    expect(a.sends.filter((s) => s.fn === "processPayouts").length).toBeGreaterThanOrEqual(4);
  });

  it("the memory carries a version: an older one starts afresh, a newer one is refused, none is a first run", () => {
    expect(loadMemory(undefined)).toEqual({ memory: freshMemory(), reset: "none" });
    expect(loadMemory(toJson({ ...freshMemory(), v: MEMORY_VERSION - 1, tick: 9 }))).toEqual({ memory: freshMemory(), reset: "older" });
    expect(() => loadMemory(toJson({ ...freshMemory(), v: MEMORY_VERSION + 1 }))).toThrow(MemoryTooNew);
    const m = { ...freshMemory(), tick: 3, reads: { cursor: { to: 12n } } };
    expect(loadMemory(encodeMemory(m))).toEqual({ memory: m });
  });

  it("JSON keeps bigints and refuses what it would lose (a Map, a Set, Infinity)", () => {
    expect(fromJson(toJson({ a: 1n, b: [2n, { c: -3n }], d: "4" }))).toEqual({ a: 1n, b: [2n, { c: -3n }], d: "4" });
    expect(() => toJson({ held: new Map() })).toThrow(/a Map at "held"/);
    expect(() => toJson({ s: new Set() })).toThrow(/a Set/);
    expect(() => toJson({ holdEnd: Number.NEGATIVE_INFINITY })).toThrow(/-Infinity at "holdEnd"/);
  });

  it("a saved revert comes back as the same error: class, chain, hash, reason and message", () => {
    const e = new RevertedOnChain("bittensor", "pay out batch 0xaaaa… to Base", H2, "UnstakeShort()");
    const back = revertOf(fromJson(toJson(saveRevert(e))));
    expect(back).toBeInstanceOf(RevertedOnChain);
    expect([back.chain, back.hash, back.reason, back.message]).toEqual([e.chain, e.hash, e.reason, e.message]);
  });

  it("the back-off is in the memory: a round is due only from memory.nextAt", async () => {
    const w = world();
    const r = await runRound(w.deps, launchTarget(rec), freshMemory(), { ...OPTS, now: () => w.time });
    expect(r.memory.nextAt).toBe(w.time + r.waitMs);
    expect(roundDue(r.memory, w.time + r.waitMs - 1)).toBe(false);
    expect(roundDue(r.memory, w.time + r.waitMs)).toBe(true);
  });
});

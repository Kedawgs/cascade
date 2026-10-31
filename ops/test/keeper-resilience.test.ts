import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, encodeAbiParameters, encodeEventTopics, getAddress, type Hex, parseAbi, parseAbiParameters } from "viem";
import { describe, expect, it, vi } from "vitest";
import { CLAIM_POLICY, WALLET } from "../src/config.ts";
import { KEEPER_STOPPED, type KeeperDeps, type KeeperState, runCommand, runLoop } from "../src/keeper/actions.ts";
import { DESTINATION_BASE } from "../src/keeper/delivery.ts";
import {
  classifyFailure,
  DeliveryReverted,
  type FailureKind,
  KeeperHasCode,
  KeeperNotReady,
  NotNow,
  nextWaitMs,
  PayoutListMismatch,
  RevertUnread,
  scrubSecrets,
} from "../src/keeper/failures.ts";
import { payoutsHash } from "../src/keeper/payouts.ts";
import { keeperDeps } from "../src/keeper/state.ts";
import type { StatusDetail } from "../src/keeper/status.ts";
import { buildPlanV3 } from "../src/plan.ts";
import { RecordMismatch, saveRecord } from "../src/record.ts";
import { RpcError } from "../src/rpc.ts";
import { ReceiptTimeout, RevertedOnChain, type Sent, SendRefused } from "../src/send.ts";
import type { CallRequest } from "../src/types.ts";
import { COLDKEY, fakeChain, SENT, stubDeps, v3Record } from "./fake-keeper.ts";

const TAO = 10n ** 18n;
const T = 1_800_000_000;
const KEY: Hex = `0x${"aa".repeat(32)}`;
const HASH: Hex = `0x${"7e".repeat(32)}`;
const alice: Address = "0x000000000000000000000000000000000000a11c";
const DELEGATED: Hex = `0xef0100${getAddress("0x00000000000000000000000000000000005eeeee").slice(2).toLowerCase()}`;
const rec = v3Record();

/** Nothing but a close due: no payout, nothing to stake. */
const closeDue: KeeperState = {
  now: T,
  frontDoor: { canClose: true, nDeposits: 1, nRedeems: 0, paused: false, openStart: T - 600, batchInterval: 600, full: false, now: T },
  closeMaxWaitS: 0,
  alphaVault: { healthy: true },
  vault: { paused: false, available: 0n, minStakeWei: 2n * 10n ** 15n, rootStake: 0n, nominatorMinWei: 0n, batches: [], payoutDelay: 3600 },
  detail: { claimable: [] } as unknown as StatusDetail,
};
/** The batch closed by someone else: a new, empty one opened that can't close yet. */
const closedElsewhere: KeeperState = { ...closeDue, frontDoor: { ...closeDue.frontDoor, nDeposits: 0, canClose: false, openStart: T } };
/** A payout due, and nothing else. */
const payoutDue: KeeperState = {
  ...closeDue,
  frontDoor: { ...closeDue.frontDoor, canClose: false, nDeposits: 0 },
  vault: { ...closeDue.vault, batches: [{ key: KEY, queuedAt: T - 7200, cursor: 0, count: 1 }] },
};
/** Idle TAO to stake, and nothing else. */
const stakeDue: KeeperState = { ...closeDue, frontDoor: { ...closeDue.frontDoor, canClose: false, nDeposits: 0 }, vault: { ...closeDue.vault, available: TAO } };

/** Keeper deps whose state reads come from `reads` in turn (the last one again once they run out; an
 * Error there is thrown), and whose sends throw what `sends` gives for that send (in order; nothing, or
 * past its end: a success). */
function world(reads: (KeeperState | Error)[], sends: (Error | undefined)[] = [], over: Partial<KeeperDeps> = {}) {
  const lines: string[] = [];
  let read = 0;
  let sent = 0;
  const readState = vi.fn(async () => {
    const r = reads[Math.min(read++, reads.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  });
  const sendCall = vi.fn(async (_r: CallRequest): Promise<Sent> => {
    const e = sends[sent++];
    if (e) throw e;
    return { ...SENT, logs: [] };
  });
  const deps = stubDeps({
    readState,
    sendCall,
    quoteClose: async () => 1n,
    payoutLogs: async () => [],
    batchInfo: async () => ({ payoutsHash: payoutsHash([]), count: 0 }),
    readRewards: async () => {
      throw new Error("rewards are not part of these tests");
    },
    log: (l) => void lines.push(l),
    ...over,
  });
  return { deps, lines, readState, sendCall, sends: () => sendCall.mock.calls.map((c) => c[0].functionName) };
}

const opts = { intervalMs: 0, policy: CLAIM_POLICY, rewardsEveryTicks: 1000 };
const failed = (lines: string[]) => lines.filter((l) => l.startsWith("Failed this round") || l.startsWith("STILL FAILING"));

/** What a race or a passing fault looks like, and what must stop the keeper. */
const CONTINUE: [string, Error, FailureKind][] = [
  ["an earlier transaction still pending", new SendRefused("waiting", "Base: an earlier transaction from the keeper (nonce 3) is still waiting to be mined; nothing sent — try again once it is"), "waiting"],
  ["a nonce race", new SendRefused("nonce", "Base: the wallet's next nonce is 5, the plan expected 4"), "nonce"],
  ["a simulation the chain changed under", new SendRefused("estimate", "Base: close the open batch would fail, nothing sent (BatchNotReady())"), "estimate"],
  ["a gas price over the cap", new SendRefused("fee", "Base: the gas price is 7.5 gwei, over the 5 gwei cap (OPS_MAX_GAS_PRICE_BASE); close the open batch waits for it to fall; nothing sent"), "fee"],
  ["no receipt yet (a slow block)", new ReceiptTimeout("bittensor", 7, HASH), "receipt"],
  ["the chain changed since the round's read", new NotNow("the open batch is empty"), "not-now"],
  ["an RPC error", new RpcError("base eth_call: HTTP 503"), "rpc"],
  ["an RPC that rate-limits", new RpcError("bittensor eth_call: still rate limited after 6 retries"), "rpc"],
  ["a dropped connection", new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }), "network"],
  ["a request that timed out", Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }), "network"],
  ["a send that failed before it went out", new Error("Base: close the open batch failed: insufficient funds"), "unexpected"],
];
const STOP: [string, Error, FailureKind][] = [
  ["the keeper wallet holds code (the 7702 guard)", new KeeperHasCode("base", WALLET, DELEGATED), "keeper-has-code"],
  ["a wrong keeper key", new SendRefused("signer", `the keystore signs as an unknown account, not the keeper ${WALLET}; nothing sent`), "signer"],
  ["a record not complete and verified", new KeeperNotReady("the deployment is not complete and verified yet (the read-back has not passed): run deploy, then verify"), "not-ready"],
  ["a record that now holds another deployment", new RecordMismatch("deployments/v3-launch.json now holds another deployment"), "record"],
  ["an RPC on another chain", new SendRefused("chain-id", "Base: the RPC reports chain id 1, expected 8453"), "chain-id"],
  ["the live gate", new SendRefused("not-live", "--live was given but an RPC points at this machine"), "not-live"],
  ["a revert nothing explains", new RevertedOnChain("base", "close the open batch and send it to Bittensor", HASH), "reverted"],
];

describe("each keeper failure is classified: wait for the next round, or stop", () => {
  it("races and passing faults wait; a compromised key, a wrong key or record, and the unexplained stop", () => {
    for (const [name, e, kind] of CONTINUE) expect(classifyFailure(e), name).toMatchObject({ stop: false, kind });
    for (const [name, e, kind] of STOP) expect(classifyFailure(e), name).toMatchObject({ stop: true, kind, message: e.message });
    expect(classifyFailure("boom")).toMatchObject({ stop: false, kind: "unexpected", message: "boom" });
  });

  it("a network failure names its code, never the URL (which can carry an API key)", () => {
    const e = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND lb.drpc.org?dkey=secret"), { code: "ENOTFOUND" }) });
    expect(classifyFailure(e).message).toBe("fetch failed (ENOTFOUND)");
  });
});

describe("run survives what it should and stops on what it must", () => {
  it("a failed send waits for the next round, which sends again: never in the same round", async () => {
    for (const [name, e, kind] of CONTINUE) {
      const w = world([closeDue], [e]);
      const end = await runLoop(w.deps, rec, { ...opts, maxTicks: 3 });
      expect(end, name).toEqual({ stopped: false });
      expect(w.sends(), name).toEqual(["closeBatch", "closeBatch", "closeBatch"]);
      expect(failed(w.lines), name).toEqual([expect.stringMatching(/^Failed this round \(.+, closing the batch\): .+; next round in 0 s$/)]);
      expect(failed(w.lines)[0], name).toContain(classifyFailure(e).message);
      expect(w.lines.filter((l) => l.startsWith("Recovered")), name).toEqual(["Recovered after 1 failed round"]);
      expect(w.lines.some((l) => l.startsWith("Stopped")), `${name} (${kind})`).toBe(false);
    }
  });

  it("a stop reason ends the run at once, with the reason as its last line", async () => {
    for (const [name, e, kind] of STOP) {
      // a revert is re-read to tell a lost race from the unexplained: here the chain is as it was
      const w = world([closeDue], [e]);
      const end = await runLoop(w.deps, rec, { ...opts, maxTicks: 3 });
      expect(end, name).toEqual({ stopped: true, kind, reason: e.message });
      expect(w.sendCall, name).toHaveBeenCalledOnce();
      expect(w.lines.at(-1), name).toBe(`Stopped: ${e.message}`);
    }
  });

  it("a read that fails (an RPC down, a dropped connection) skips the round, sending nothing", async () => {
    let n = 0;
    const errors = [new RpcError("bittensor eth_blockNumber: HTTP 502"), new TypeError("fetch failed")];
    const w = world([closeDue], [], {
      readState: async () => {
        const e = errors[n++];
        if (e) throw e;
        return closeDue;
      },
    });
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 3 })).toEqual({ stopped: false });
    expect(w.sends()).toEqual(["closeBatch"]);
    expect(failed(w.lines)).toEqual([
      "Failed this round (RPC error, reading the chains): bittensor eth_blockNumber: HTTP 502; next round in 0 s",
      "Failed this round (network error, reading the chains): fetch failed; next round in 0 s",
    ]);
  });

  it("the record re-read each round: another deployment there stops it; a passing read error only skips the round", async () => {
    const mismatch = world([closeDue], [], {
      refresh: () => {
        throw new RecordMismatch("deployments/v3-launch.json now holds another deployment");
      },
    });
    expect(await runLoop(mismatch.deps, rec, { ...opts, maxTicks: 3 })).toEqual({
      stopped: true,
      kind: "record",
      reason: "deployments/v3-launch.json now holds another deployment",
    });
    expect(mismatch.readState).not.toHaveBeenCalled();
    expect(mismatch.lines).toEqual(["Stopped: deployments/v3-launch.json now holds another deployment"]);

    let n = 0;
    const busy = world([closeDue], [], {
      refresh: () => {
        if (n++ === 0) throw Object.assign(new Error("EBUSY: resource busy or locked, open 'deployments/v3-launch.json'"), { code: "EBUSY" });
      },
    });
    expect(await runLoop(busy.deps, rec, { ...opts, maxTicks: 2 })).toEqual({ stopped: false });
    // round 1 read nothing and sent nothing; round 2 closed
    expect(busy.readState).toHaveBeenCalledTimes(2);
    expect(busy.sends()).toEqual(["closeBatch"]);
    expect(failed(busy.lines)).toEqual([expect.stringMatching(/^Failed this round \(unexpected error, re-reading the record\): EBUSY/)]);
  });

  it("someone else closing the batch first, before the close re-reads it, is a wait: nothing sent that round", async () => {
    // round 1 decides on a batch to close; the close's own read finds it closed. Round 2 closes the next
    const w = world([closeDue, closedElsewhere, closeDue, closeDue]);
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 2 })).toEqual({ stopped: false });
    expect(w.sends()).toEqual(["closeBatch"]);
    expect(failed(w.lines)).toEqual(["Failed this round (the chain changed, closing the batch): the open batch is empty; next round in 0 s"]);
  });

  it("a payout another caller made first, before the payout re-reads it, is a wait too", async () => {
    const paid: KeeperState = { ...payoutDue, vault: { ...payoutDue.vault, batches: [] } };
    const w = world([payoutDue, paid, paid]);
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 2 })).toEqual({ stopped: false });
    expect(w.sendCall).not.toHaveBeenCalled();
    expect(failed(w.lines)).toEqual([expect.stringMatching(/^Failed this round \(the chain changed, paying out batch 0xaaaaaaaa…\): no payout is pending for batch 0xaaaaaaaa…/)]);
  });
});

describe("a keeper transaction that reverts on chain", () => {
  const reverted = (label: string) => new RevertedOnChain("base", label, HASH);

  it("is a lost race when the re-read shows why: another close landed, the batch was paid out, the TAO is gone, or a pause", async () => {
    const cases: [string, KeeperState, KeeperState, string, string][] = [
      ["close", closeDue, closedElsewhere, "closeBatch", "another close landed first"],
      ["close", closeDue, { ...closeDue, frontDoor: { ...closeDue.frontDoor, paused: true } }, "closeBatch", "the front door was paused"],
      ["close", closeDue, { ...closeDue, alphaVault: { healthy: false } }, "closeBatch", "AlphaVault was paused or began migrating"],
      ["payouts", payoutDue, { ...payoutDue, vault: { ...payoutDue.vault, batches: [] } }, "processPayouts", "another caller paid this batch out first"],
      ["payouts", payoutDue, { ...payoutDue, vault: { ...payoutDue.vault, batches: [{ key: KEY, queuedAt: T - 7200, cursor: 1, count: 2 }] } }, "processPayouts", "another caller paid this batch out first"],
      ["payouts", payoutDue, { ...payoutDue, vault: { ...payoutDue.vault, paused: true } }, "processPayouts", "the vault was paused"],
      ["stake", stakeDue, { ...stakeDue, vault: { ...stakeDue.vault, available: 0n } }, "stakeIdle", "the idle TAO is no longer above the staking floor"],
      ["stake", stakeDue, { ...stakeDue, vault: { ...stakeDue.vault, paused: true } }, "stakeIdle", "the vault was paused"],
    ];
    for (const [kind, before, after, fn, why] of cases) {
      // the round's read, the action's own read, then the read after the revert
      const w = world([before, before, after, before, before], [reverted(kind)]);
      expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 2 }), why).toEqual({ stopped: false });
      expect(w.sends(), why).toEqual([fn, fn]);
      expect(w.lines.filter((l) => l.startsWith("Not done:")), why).toEqual([
        `Not done: ${why}; the transaction reverted on chain (transaction ${HASH}); the next round decides again`,
      ]);
      expect(failed(w.lines), why).toEqual([]);
    }
  });

  it("stops the keeper when the chain is as it was (unexplained), or the re-read fails, with the revert and its hash", async () => {
    const unexplained = world([closeDue], [reverted("close")]);
    expect(await runLoop(unexplained.deps, rec, { ...opts, maxTicks: 3 })).toMatchObject({ stopped: true, kind: "reverted" });
    expect(unexplained.lines.at(-1)).toBe(`Stopped: ${reverted("close").message}`);
    expect(unexplained.lines.at(-1)).toContain(HASH);

    let n = 0;
    const blind = world([closeDue], [reverted("close")], {
      readState: async () => {
        if (n++ >= 2) throw new RpcError("base eth_call: HTTP 503");
        return closeDue;
      },
    });
    expect(await runLoop(blind.deps, rec, { ...opts, maxTicks: 3 })).toMatchObject({ stopped: true, kind: "reverted" });
    expect(blind.sendCall).toHaveBeenCalledOnce();
  });
});

describe("deliveries in a run that must survive", () => {
  const delivering = (sends: (Error | undefined)[], over: Partial<KeeperDeps> = {}) =>
    world([closeDue], sends, {
      deliveryCandidates: async () => [alice],
      readDelivery: async (user) => ({
        user,
        claimable: TAO,
        pref: { minUsdcPerTao: 240_000_000n, deadline: T + 3600, destination: DESTINATION_BASE },
        quoteUsdc: 252_000_000n,
        twapUsdc: 250_000_000n,
        slippageBps: 150,
        now: T,
      }),
      simulateDeliver: async () => ({ ok: true, usdcOut: 251_000_000n }),
      ...over,
    });

  it("a delivery with no receipt yet ends the round: nothing else is sent while it may be pending", async () => {
    const w = delivering([new ReceiptTimeout("base", 9, HASH)]);
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 1 })).toEqual({ stopped: false });
    expect(w.sends()).toEqual(["deliver"]);
    expect(failed(w.lines)).toEqual([expect.stringMatching(/^Failed this round \(no receipt yet, delivering to 0x0+a11c\): Base: no receipt yet for nonce 9/)]);
  });

  it("a delivery that reverts while nothing changed (unexplained) fails the round once, is held, and the round's close still goes", async () => {
    // the explained reverts (the user claimed first, the price moved) are below, under "re-checked at once"
    const w = delivering([new RevertedOnChain("base", `deliver ${alice}'s TAO as USDC`, HASH)]);
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 2 })).toEqual({ stopped: false });
    // held, not retried unchanged: round 2 only closes
    expect(w.sends()).toEqual(["deliver", "closeBatch", "closeBatch"]);
    expect(failed(w.lines)).toEqual([
      expect.stringMatching(/^Failed this round \(an unexplained delivery revert, delivering to 0x0+a11c\): .*still passes on the same facts and nothing explains it; held for 30 minutes/),
    ]);
    expect(w.lines).toContain("Recovered after 1 failed round");
    expect(classifyFailure(new DeliveryReverted(alice, new RevertedOnChain("base", "deliver", HASH)))).toMatchObject({ stop: false, kind: "delivery-reverted" });
  });

  it("a delivery refused for the wrong key or chain stops the keeper, as any send would", async () => {
    for (const e of [new SendRefused("signer", "the keystore signs as 0x00, not the keeper; nothing sent"), new SendRefused("chain-id", "Base: the RPC reports chain id 1, expected 8453")]) {
      const w = delivering([e]);
      expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 2 })).toMatchObject({ stopped: true });
      expect(w.sends()).toEqual(["deliver"]);
      expect(w.lines.at(-1)).toBe(`Stopped: ${e.message}`);
    }
  });
});

describe("a run that keeps failing says so, and backs off", () => {
  it("after 10 failed rounds in a row each line says STILL FAILING, and the run goes on", async () => {
    const w = world([closeDue], [], {
      readState: async () => {
        throw new RpcError("base eth_call: HTTP 503");
      },
    });
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 12 })).toEqual({ stopped: false });
    const lines = failed(w.lines);
    expect(lines).toHaveLength(12);
    expect(lines.slice(0, 9).every((l) => l.startsWith("Failed this round (RPC error, reading the chains): base eth_call: HTTP 503"))).toBe(true);
    expect(lines.slice(9)).toEqual([
      "STILL FAILING (10 rounds; RPC error, reading the chains): base eth_call: HTTP 503; next round in 0 s",
      "STILL FAILING (11 rounds; RPC error, reading the chains): base eth_call: HTTP 503; next round in 0 s",
      "STILL FAILING (12 rounds; RPC error, reading the chains): base eth_call: HTTP 503; next round in 0 s",
    ]);
  });

  it("waits the interval, doubled for each further failed round up to 5 minutes, and the interval again once a round works", async () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => nextWaitMs(60_000, n))).toEqual([60_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
    // an interval longer than the cap is never shortened
    expect(nextWaitMs(600_000, 4)).toBe(600_000);
    expect(nextWaitMs(0, 4)).toBe(0);

    let n = 0;
    const waits: number[] = [];
    const w = world([closeDue], [], {
      readState: async () => {
        if (n++ < 5) throw new RpcError("base eth_call: HTTP 503");
        return closeDue;
      },
    });
    const sleep = async (ms: number) => void waits.push(ms);
    await runLoop(w.deps, rec, { ...opts, intervalMs: 60_000, maxTicks: 7, sleep });
    expect(waits).toEqual([60_000, 120_000, 240_000, 300_000, 300_000, 60_000]);
    expect(failed(w.lines).map((l) => l.replace(/^.*next round in /, ""))).toEqual(["1 min", "2 min", "4 min", "5 min", "5 min"]);
    expect(w.lines).toContain("Recovered after 5 failed rounds");
  });
});

describe("pnpm ops run's exit code tells the supervisor whether to restart it", () => {
  it("exits KEEPER_STOPPED (3) when it stops itself, saying so loudly; never restarted", async () => {
    expect(KEEPER_STOPPED).toBe(3);
    const w = world([closeDue], [new KeeperHasCode("base", WALLET, DELEGATED)]);
    const lines: string[] = [];
    expect(await runCommand(async () => ({ deps: w.deps, rec }), (l) => void lines.push(l), opts)).toBe(KEEPER_STOPPED);
    expect(w.lines.at(-1)).toMatch(/^Stopped: Base: the keeper wallet .* has code/);
    expect(lines.at(-1)).toMatch(/^THE KEEPER STOPPED ITSELF: .*exit code 3/);
  });

  it("a start it refuses (a wrong key, no record) is the same deliberate stop: nothing read, nothing sent", async () => {
    const lines: string[] = [];
    const start = async (): Promise<never> => {
      throw new Error(`the keeper's keystore /keys/k.json signs as no account (it can't be opened), not the record's keeper ${WALLET}`);
    };
    expect(await runCommand(start, (l) => void lines.push(l), opts)).toBe(KEEPER_STOPPED);
    expect(lines[0]).toMatch(/^Stopped: the keeper's keystore .* signs as no account/);
    expect(lines.at(-1)).toMatch(/^THE KEEPER STOPPED ITSELF/);
  });

  it("exits 0 when its rounds run out (tests only: run has no limit)", async () => {
    const w = world([closeDue]);
    expect(await runCommand(async () => ({ deps: w.deps, rec }), () => undefined, { ...opts, maxTicks: 1 })).toBe(0);
  });
});

describe("the record's re-read tells a changed record from a passing read error", () => {
  it("throws RecordMismatch when the record is gone or holds another deployment, and anything else as it is", () => {
    const launch = v3Record("live", buildPlanV3(0, 0, COLDKEY));
    const path = join(mkdtempSync(join(tmpdir(), "ops-refresh-")), "v3-launch.json");
    saveRecord(path, launch);
    const deps = keeperDeps(fakeChain([], {}).ctx, launch, path);
    expect(() => deps.refresh()).not.toThrow();

    writeFileSync(path, '{"target": "live", "pla');
    const torn = (() => {
      try {
        deps.refresh();
      } catch (e) {
        return e;
      }
    })();
    expect(torn).toBeInstanceOf(Error);
    expect(torn).not.toBeInstanceOf(RecordMismatch);

    const other = v3Record("live", buildPlanV3(1, 0, COLDKEY));
    saveRecord(path, other);
    expect(() => deps.refresh()).toThrow(RecordMismatch);
    expect(() => deps.refresh()).toThrow(/now holds another deployment/);

    rmSync(path);
    expect(() => deps.refresh()).toThrow(RecordMismatch);
    expect(() => deps.refresh()).toThrow(/is gone/);
  });
});

const SENT_EVENT = parseAbi([
  "event Sent(bytes32 indexed messageId, uint64 destChain, address indexed sender, address indexed recipient, uint256 amount, uint256 fee, uint256 gasLimit)",
]);
const MESSAGE: Hex = `0x${"5a".repeat(32)}`;
/** The Base adapter's Sent log for a close's bridge message. */
const sentLog = {
  address: rec.plan.addresses.baseAdapter,
  topics: encodeEventTopics({ abi: SENT_EVENT, args: { messageId: MESSAGE, sender: rec.plan.addresses.frontDoor, recipient: rec.plan.addresses.vault } }) as Hex[],
  data: encodeAbiParameters(parseAbiParameters("uint64, uint256, uint256, uint256"), [964n, 10n ** 16n, 1n, 1n]),
};
const MINUTE = 60_000;
/** A clock each round's wait moves on by `step`. */
const clock = (step: number) => {
  let t = 0;
  return { now: () => t, sleep: async () => void (t += step) };
};

/** A close due and alice's delivery ready on the same facts every time, unless `read` (her nth delivery
 * read) or `simulate` (the nth simulation) say otherwise; `deliverSend(n)` is what her nth deliver send
 * throws (nothing: it goes through). */
function deliveryWorld(o: {
  deliverSend?: (n: number) => Error | undefined;
  read?: (n: number) => { claimable?: bigint; quoteUsdc?: bigint };
  simulate?: (n: number) => { ok: true; usdcOut: bigint } | { ok: false; reason: string };
}) {
  const lines: string[] = [];
  let sent = 0;
  let reads = 0;
  let sims = 0;
  const sendCall = vi.fn(async (r: CallRequest): Promise<Sent> => {
    if (r.functionName === "deliver") {
      const e = o.deliverSend?.(++sent);
      if (e) throw e;
    }
    return { ...SENT, logs: [] };
  });
  const deps = stubDeps({
    readState: async () => closeDue,
    sendCall,
    quoteClose: async () => 1n,
    deliveryCandidates: async () => [alice],
    readDelivery: async (user) => ({
      user,
      claimable: TAO,
      pref: { minUsdcPerTao: 240_000_000n, deadline: T + 3600, destination: DESTINATION_BASE },
      quoteUsdc: 252_000_000n,
      twapUsdc: 250_000_000n,
      slippageBps: 150,
      now: T,
      ...(o.read?.(++reads) ?? {}),
    }),
    simulateDeliver: async () => o.simulate?.(++sims) ?? { ok: true, usdcOut: 251_000_000n },
    readRewards: async () => {
      throw new Error("rewards are not part of these tests");
    },
    log: (l) => void lines.push(l),
  });
  return { deps, lines, sends: () => sendCall.mock.calls.map((c) => c[0].functionName) };
}
const deliveryRevert = () => new RevertedOnChain("base", `deliver ${alice}'s TAO as USDC`, HASH);
const waitsFor = (lines: string[]) => lines.filter((l) => l.startsWith(`Delivery to ${alice} waits:`));

describe("a delivery that reverts on chain is re-checked at once", () => {
  it("explained when the user claimed first: held, the round's close still goes, and no failure", async () => {
    // her 3rd read is the re-check after the revert
    const w = deliveryWorld({ deliverSend: (n) => (n === 1 ? deliveryRevert() : undefined), read: (n) => (n >= 3 ? { claimable: 0n } : {}) });
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 2 })).toEqual({ stopped: false });
    expect(w.sends()).toEqual(["deliver", "closeBatch", "closeBatch"]);
    expect(waitsFor(w.lines)).toEqual([expect.stringMatching(new RegExp(`reverted on chain \\(transaction ${HASH}\\): nothing is claimable;`))]);
    expect(failed(w.lines)).toEqual([]);
  });

  it("explained when its simulation now fails (the price moved): held, no failure", async () => {
    const w = deliveryWorld({
      deliverSend: (n) => (n === 1 ? deliveryRevert() : undefined),
      simulate: (n) => (n >= 3 ? { ok: false, reason: "Error(Too little received)" } : { ok: true, usdcOut: 251_000_000n }),
    });
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 2 })).toEqual({ stopped: false });
    expect(w.sends()).toEqual(["deliver", "closeBatch", "closeBatch"]);
    expect(waitsFor(w.lines)[0]).toMatch(/reverted on chain .*: deliver would revert now \(Error\(Too little received\)\)/);
    expect(failed(w.lines)).toEqual([]);
  });

  it("unexplained when it still passes on the same facts: a failed round, held 30 minutes; the second in a day holds her for hours, and the keeper never stops", async () => {
    const w = deliveryWorld({ deliverSend: () => deliveryRevert() });
    // each round's wait is 31 minutes: every 30-minute hold has run out by the next round
    const end = await runLoop(w.deps, rec, { ...opts, maxTicks: 5, ...clock(31 * MINUTE) });
    expect(end).toEqual({ stopped: false });
    // the second revert runs out her budget (REVERT_BUDGET in a day): held six hours, the closes go on
    expect(w.sends()).toEqual(["deliver", "closeBatch", "deliver", "closeBatch", "closeBatch", "closeBatch", "closeBatch"]);
    expect(failed(w.lines)).toEqual([
      expect.stringMatching(/^Failed this round \(an unexplained delivery revert, delivering to 0x0+a11c\): .*reverted on chain.*still passes on the same facts and nothing explains it/),
    ]);
    expect(w.lines.filter((l) => l.startsWith("DELIVERY HELD:"))).toEqual([
      expect.stringMatching(/^DELIVERY HELD: deliver to 0x0+a11c reverted on chain 2 times within 24 hours \(the last: transaction 0x7e.*, and nothing explains it\); held 6 hours, until 1970-01-01 06:31 UTC/),
    ]);
    expect(w.lines.some((l) => l.startsWith("Stopped"))).toBe(false);
  });

  it("an unexplained revert's hold keeps her waiting within the 30 minutes", async () => {
    const w = deliveryWorld({ deliverSend: (n) => (n === 1 ? deliveryRevert() : undefined) });
    await runLoop(w.deps, rec, { ...opts, maxTicks: 3, ...clock(10 * MINUTE) });
    // rounds at 0, 10 and 20 minutes: only the first delivers
    expect(w.sends()).toEqual(["deliver", "closeBatch", "closeBatch", "closeBatch"]);
  });

  it("every hold ends after 30 minutes, even on the same facts (a refused estimate's too)", async () => {
    const w = deliveryWorld({ deliverSend: () => new SendRefused("estimate", "Base: deliver would fail, nothing sent (BelowMinimum())") });
    await runLoop(w.deps, rec, { ...opts, maxTicks: 4, ...clock(10 * MINUTE) });
    // rounds at 0, 10, 20 and 30 minutes: tried again at 30
    expect(w.sends()).toEqual(["deliver", "closeBatch", "closeBatch", "closeBatch", "deliver", "closeBatch"]);
  });
});

describe("failures that would otherwise repeat forever stop the keeper", () => {
  it("30 rounds in a row failed on something unexpected stop it", async () => {
    const w = world([new Error("something odd")]);
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 40 })).toMatchObject({ stopped: true, kind: "unexpected" });
    expect(w.readState).toHaveBeenCalledTimes(30);
    expect(failed(w.lines)).toHaveLength(29);
    expect(w.lines.at(-1)).toBe("Stopped: 30 rounds in a row failed on something unexpected; the last: something odd");
  });

  it("any other outcome between them starts the count again", async () => {
    const odd = new Error("something odd");
    const w = world([...Array(29).fill(odd), new RpcError("base eth_call: HTTP 503"), ...Array(29).fill(odd)]);
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 59 })).toEqual({ stopped: false });
  });

  it("a payout list that doesn't match the vault's stops it at once: it would block every other action", async () => {
    expect(classifyFailure(new PayoutListMismatch("x"))).toMatchObject({ stop: true, kind: "payout-list" });
    const w = world([payoutDue], [], { batchInfo: async () => ({ payoutsHash: payoutsHash([]), count: 1 }) });
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 3 })).toMatchObject({ stopped: true, kind: "payout-list" });
    expect(w.sendCall).not.toHaveBeenCalled();
    expect(w.lines.at(-1)).toMatch(/^Stopped: the payout list rebuilt from the vault's events \(0 entries\) does not match batch 0xaaaaaaaa…/);
  });
});

describe("a transaction that went through is never lost from the log", () => {
  it("a send whose record save fails is logged loudly with its hash and bridge message; the round still counts as done", async () => {
    const w = world([closeDue], [], {
      sendCall: async () => ({ ...SENT, logs: [sentLog] }),
      recordMessage: () => {
        throw Object.assign(new Error("EPERM: operation not permitted, rename 'deployments/v3-launch.json.tmp'"), { code: "EPERM" });
      },
    });
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 1 })).toEqual({ stopped: false });
    expect(w.lines).toContainEqual(
      `SENT, BUT NOT SAVED: transaction ${SENT.hash}, bridge message ${MESSAGE} went through, but saving it to the record failed (EPERM: operation not permitted, rename 'deployments/v3-launch.json.tmp'); follow it with: pnpm ops track ${MESSAGE}`,
    );
    expect(w.lines.at(-1)).toBe(`Done: the open batch is ready to close (transaction ${SENT.hash}, bridge message ${MESSAGE})`);
    expect(failed(w.lines)).toEqual([]);
  });

  it("a transaction with no receipt is looked up in later rounds; once it lands, its bridge message is recorded", async () => {
    let asked = 0;
    const recorded: unknown[] = [];
    const w = world([closeDue], [new ReceiptTimeout("base", 4, HASH), new SendRefused("waiting", "Base: an earlier transaction is still waiting to be mined")], {
      receipt: async (chain, hash) => {
        expect([chain, hash]).toEqual(["base", HASH]);
        return ++asked < 2 ? null : { reverted: false, logs: [sentLog] };
      },
      recordMessage: (m) => void recorded.push(m),
    });
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 3 })).toEqual({ stopped: false });
    expect(recorded).toEqual([{ id: MESSAGE, direction: "Base → Bittensor", hash: HASH }]);
    expect(w.lines).toContain(`Late receipt: closing the batch went through (transaction ${HASH}, bridge message ${MESSAGE})`);
    expect(asked).toBe(2);
  });

  it("a late receipt that reverted is said so", async () => {
    const w = world([closeDue], [new ReceiptTimeout("base", 4, HASH)], { receipt: async () => ({ reverted: true, logs: [] }) });
    await runLoop(w.deps, rec, { ...opts, maxTicks: 2 });
    expect(w.lines).toContain(`Late receipt: closing the batch reverted on chain (transaction ${HASH})`);
  });
});

describe("the same action skipped round after round is said loudly", () => {
  it("a close another caller beats every round: STILL FAILING once it has happened `stillFailingAfter` rounds in a row", async () => {
    const reads = Array(4).fill([closeDue, closeDue, closedElsewhere]).flat() as KeeperState[];
    const w = world(reads, Array(4).fill(new RevertedOnChain("base", "close the open batch and send it to Bittensor", HASH)));
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 4, stillFailingAfter: 3 })).toEqual({ stopped: false });
    const notDone = `Not done: another close landed first; the transaction reverted on chain (transaction ${HASH}); the next round decides again`;
    expect(w.lines.filter((l) => l.includes("Not done:"))).toEqual([
      notDone,
      notDone,
      `STILL FAILING (3 rounds; closing the batch): ${notDone}`,
      `STILL FAILING (4 rounds; closing the batch): ${notDone}`,
    ]);
  });

  it("a delivery the wallet's guard refuses every round: logged once, then STILL FAILING", async () => {
    const pending = new SendRefused("waiting", "Base: an earlier transaction from the keeper (nonce 3) is still waiting to be mined; nothing sent — try again once it is");
    const w = deliveryWorld({ deliverSend: () => pending });
    await runLoop(w.deps, rec, { ...opts, maxTicks: 4, stillFailingAfter: 3 });
    const said = `${pending.message}; it is tried again next round`;
    expect(w.lines.filter((l) => l.includes(pending.message))).toEqual([
      `Delivery to ${alice} waits: ${said}`,
      `STILL FAILING (3 rounds; delivering to ${alice}): ${said}`,
      `STILL FAILING (4 rounds; delivering to ${alice}): ${said}`,
    ]);
  });
});

describe("a revert whose re-read fails", () => {
  const reverted = new RevertedOnChain("base", "close the open batch and send it to Bittensor", HASH);
  const down = new RpcError("base eth_call: HTTP 503");

  it("fails that round only; the next round's read explains it: a skip", async () => {
    const w = world([closeDue, closeDue, down, closedElsewhere], [reverted]);
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 2 })).toEqual({ stopped: false });
    expect(classifyFailure(new RevertUnread(reverted, down))).toMatchObject({ stop: false, kind: "revert-unread" });
    expect(failed(w.lines)).toEqual([expect.stringMatching(/^Failed this round \(a revert not yet explained, closing the batch\): .*reverted on chain.*HTTP 503/)]);
    expect(w.lines).toContain(`Not done: another close landed first; the transaction reverted on chain (transaction ${HASH}); the next round decides again`);
  });

  it("stops the keeper when the next round's read shows nothing to explain it, or fails again", async () => {
    for (const next of [closeDue, down]) {
      const w = world([closeDue, closeDue, down, next], [reverted]);
      expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 3 })).toEqual({ stopped: true, kind: "reverted", reason: reverted.message });
      expect(w.sendCall).toHaveBeenCalledOnce();
      expect(w.lines.at(-1)).toBe(`Stopped: ${reverted.message}`);
    }
  });
});

describe("no failure line carries a secret from a URL", () => {
  it("strips a URL to its domain and drops key-like parameters", () => {
    const out = scrubSecrets(
      "request to https://lb.drpc.org/ogrpc?network=base&dkey=SECRETKEY123 failed; https://base-mainnet.g.alchemy.com/v2/ALCHEMYKEY9; wss://user:hunter2@node.example.com:8546/ws; api_key=XYZ789",
    );
    for (const secret of ["SECRETKEY123", "ALCHEMYKEY9", "hunter2", "XYZ789", "ogrpc", "/v2/"]) expect(out).not.toContain(secret);
    expect(out).toContain("drpc.org");
    expect(out).toContain("alchemy.com");
    expect(scrubSecrets(`transaction ${HASH}, user ${alice}, 0.5 TAO`)).toBe(`transaction ${HASH}, user ${alice}, 0.5 TAO`);
  });

  it("in a failed round's line, a stop's line and its reason, and a start refused", async () => {
    const w = world([new RpcError("base eth_call: request to https://lb.drpc.org/ogrpc?network=base&dkey=SECRETKEY123 failed: HTTP 503"), closeDue]);
    await runLoop(w.deps, rec, { ...opts, maxTicks: 2 });
    expect(failed(w.lines)).toEqual([expect.stringContaining("drpc.org")]);
    expect(w.lines.join("\n")).not.toContain("SECRETKEY123");

    const wrong = new SendRefused("chain-id", "Base: the RPC at https://base.example.com/v2/APIKEY456 reports chain id 1, expected 8453");
    const s = world([closeDue], [wrong]);
    const end = await runLoop(s.deps, rec, { ...opts, maxTicks: 2 });
    expect(JSON.stringify(end)).not.toContain("APIKEY456");
    expect(s.lines.join("\n")).not.toContain("APIKEY456");

    const lines: string[] = [];
    const start = async (): Promise<never> => {
      throw new Error("could not open https://rpc.example.com/?token=TOKEN789");
    };
    await runCommand(start, (l) => void lines.push(l), opts);
    expect(lines.join("\n")).not.toContain("TOKEN789");
  });
});

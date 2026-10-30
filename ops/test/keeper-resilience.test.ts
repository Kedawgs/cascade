import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, getAddress, type Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { CLAIM_POLICY, WALLET } from "../src/config.ts";
import { KEEPER_STOPPED, type KeeperDeps, type KeeperState, runCommand, runLoop } from "../src/keeper/actions.ts";
import { DESTINATION_BASE } from "../src/keeper/delivery.ts";
import { classifyFailure, type FailureKind, KeeperHasCode, KeeperNotReady, NotNow, nextWaitMs } from "../src/keeper/failures.ts";
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

/** Keeper deps whose state reads come from `reads` in turn (the last one again once they run out), and
 * whose sends throw what `sends` gives for that send (in order; nothing, or past its end: a success). */
function world(reads: KeeperState[], sends: (Error | undefined)[] = [], over: Partial<KeeperDeps> = {}) {
  const lines: string[] = [];
  let read = 0;
  let sent = 0;
  const readState = vi.fn(async () => reads[Math.min(read++, reads.length - 1)]);
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

  it("a delivery that reverts on chain (the user claimed first, the price moved) is held, and the round's close still goes", async () => {
    const w = delivering([new RevertedOnChain("base", `deliver ${alice}'s TAO as USDC`, HASH)]);
    expect(await runLoop(w.deps, rec, { ...opts, maxTicks: 2 })).toEqual({ stopped: false });
    // held, not retried unchanged: round 2 only closes
    expect(w.sends()).toEqual(["deliver", "closeBatch", "closeBatch"]);
    expect(w.lines.filter((l) => l.startsWith(`Delivery to ${alice} waits:`))).toEqual([
      expect.stringMatching(new RegExp(`reverted on chain \\(transaction ${HASH}\\); not retried until the claimable amount, the preference or the quote against the floors changes$`)),
    ]);
    expect(failed(w.lines)).toEqual([]);
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

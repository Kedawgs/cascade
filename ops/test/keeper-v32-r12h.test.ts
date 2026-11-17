import { type AbiFunction, type Address, getAddress, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { KEEPER_CALLS_V32 } from "../src/keeper/core/abi.ts";
import { encodeMemory, freshMemory, loadMemory } from "../src/keeper/core/memory.ts";
import { runRound } from "../src/keeper/core/round.ts";
import { RpcError } from "../src/keeper/core/rpc.ts";
import { ADDR, deploymentFor, depsFor, RAO, revertWith, type SentCall, T, TAO, type World, world } from "./keeper-v32-world.ts";
import { targetV32 } from "../src/keeper/core/v32/actions.ts";

// R12h (the keeper review of R12g, Fable: M1): a close the chain reverted is not counted when its own block explains it.
// The replay naming the door's WrongBatch, BatchTooSmall or BatchNotReady at the block it was mined in or the one before
// is the explanation, whatever a later read shows; a replay naming no reason is explained by a deposit of the batch
// cancelled from the read the close was sent on through its block (the door's DepositCancelled logs). Before R12h the
// re-read at "latest", seconds after the broadcast, decided alone: a holder's cancel just before each close (a higher tip)
// and its deposit back just after (a lower one) left it closable as it was sent, a wait the breaker counted, and three in a
// row skipped the close for 5 minutes, doubling to an hour, while the holder kept the batch full. And (optional in the
// review) the fee rule's close names 0 when the pot covers its quote. On fake chains.

const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const d = deploymentFor();
const target = targetV32(d);
const OPTS = { intervalMs: 60_000, policy: { claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 }, rewardsEveryTicks: 1000 };
/** The world's door's minDeposit */
const MIN = 4n * 10n ** 16n;
const AGED = at("a11ce");
const FRESH = at("f1e5");
const NOTICE = BigInt(T + 7 * 86_400);
const TOO_SMALL = "the open batch holds less than when it was read (a deposit was cancelled)";
const NOT_READY = "the open batch can't close now (canClose() went false since the read: a cancel took it under every line that let it close, or a roll restarted its timer)";
const NO_REASON = "its replay names no reason (the call passes at the block it was mined in and at the one before, or the replay couldn't be read)";
const NAMED = "its replay names that at the block it was mined in or the one before, whatever the batch holds now";
const HASH = "0x[0-9a-f]{64}";
/** `text` as a regular expression's literal */
const lit = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Base's head in round `i`: a minute of its 2-second blocks a round */
const headAt = (i: number) => 10_000n + BigInt(i) * 30n;

type Round = { lines: string[]; failing: number; refusals: Record<string, { n: number } | undefined>; end: unknown };

/** `n` rounds a minute apart, Base's head a minute on each, the memory through JSON between them; `before(i)` sets the
 * batch the round reads. Each round's end is kept: none may stop the keeper. */
async function rounds(w: World, n: number, o: { before?: (i: number) => void } = {}): Promise<Round[]> {
  const out: Round[] = [];
  let saved = encodeMemory(freshMemory());
  for (let i = 0; i < n; i++) {
    const memory = loadMemory(saved).memory;
    w.time.base = T + i * 60;
    w.time.bittensor = T + i * 60;
    w.head.base = headAt(i);
    o.before?.(i);
    const lines: string[] = [];
    const { deps } = depsFor(w, memory, d, (l) => lines.push(l));
    const r = await runRound(deps, target, memory, { ...OPTS, now: () => (T + i * 60) * 1000 });
    out.push({ lines, failing: r.memory.failing, refusals: r.memory.refusals as Round["refusals"], end: r.end });
    saved = encodeMemory(r.memory);
  }
  return out;
}

/** The chain mines `w`'s closes as `fate` says (`k`: the close's number, from 0), and the replay of a reverted one (its
 * eth_call at the block it was mined in, then the one before) answers as `replay` does */
function minedAs(w: World, fate: (c: SentCall, k: number) => "mine" | "revert", replay: (args: readonly unknown[]) => unknown) {
  let k = 0;
  w.fns.push(...(KEEPER_CALLS_V32 as readonly AbiFunction[]).filter((f) => f.type === "function" && f.name === "closeBatch"));
  w.answers[`${ADDR.frontDoor.toLowerCase()}:closeBatch`] = replay;
  w.fate = (c) => (c.fn === "closeBatch" ? fate(c, k++) : "mine");
}
/** CascadeFrontDoor.closeBatch's checks on the world as it is: what the replay of a mined close meets */
const doorChecks = (w: World) => (args: readonly unknown[]) => {
  if (args[0] !== w.door.id) throw revertWith("WrongBatch", [w.door.id]);
  if (!w.door.canClose) throw revertWith("BatchNotReady");
  if (w.door.deposits.length + w.door.redeems.length > 0 && w.door.totalDeposits < (args[1] as bigint)) throw revertWith("BatchTooSmall");
  return [];
};
/** Whether the door's checks refuse `args` on the world as it is now (the close mid-block) */
const refuses = (w: World, args: readonly unknown[]) => {
  try {
    doorChecks(w)(args);
    return false;
  } catch {
    return true;
  }
};

/** The batch the round reads: full by value before its interval (6 of the 10 TAO limit, ten minutes old), closable; its
 * close names 5 TAO, the least total still full */
const full = (w: World, i = 0) => {
  w.door.canClose = true;
  w.door.start = BigInt(T + i * 60 - 600);
  w.door.totalDeposits = 6n * TAO;
  w.door.deposits = [{ user: AGED, amount: 6n * TAO }];
};
/** A DepositCancelled of the aged holder's `amount` logged by the door: of the open batch, in the block at Base's head,
 * unless said otherwise */
const logCancel = (w: World, amount: bigint, o: { batchId?: bigint; block?: bigint } = {}) =>
  w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "DepositCancelled", args: { batchId: o.batchId ?? w.door.id, user: AGED, amount }, block: o.block ?? w.head.base });
/** The aged holder cancels `amount` of its entry in the block at Base's head (logCancel); `under` also takes the batch
 * under every line that let it close before its interval (canClose() false) */
const cancel = (w: World, amount: bigint, o: { under?: boolean } = {}) => {
  w.door.totalDeposits -= amount;
  w.door.deposits = w.door.deposits.map((x) => (x.user === AGED ? { ...x, amount: x.amount - amount } : x));
  if (o.under) w.door.canClose = false;
  logCancel(w, amount);
};
/** A second address deposits `amount` back into the batch (a lower tip: after the close in its block) */
const putBack = (w: World, amount: bigint) => {
  w.door.totalDeposits += amount;
  w.door.deposits = [...w.door.deposits, { user: FRESH, amount }];
  w.door.canClose = true;
};
const failedOrStopped = (r: Round[]) => r.flatMap((x) => x.lines).filter((l) => l.startsWith("Failed this round") || l.startsWith("Stopped") || /SKIPPING/.test(l));
const cancelled = (amount: string, block: bigint) =>
  `a deposit of ${amount} TAO was cancelled from it in block ${block}, between the read it was sent on (block ${block}) and the block it was mined in (${block}), whatever the batch holds now`;

describe("R12h (M1): a close whose own block explains its revert is the round's quiet skip, whatever the read after it shows", () => {
  it("a tip-ordered cancel and deposit around each of three closes (both block-end states closable, so the replay names no reason): the cancel's log explains each, the round's quiet skip; the breaker never trips and the fourth round closes the full batch (before R12h the re-read found the TAO back: three counted waits tripped the breaker, and the fourth round's close was skipped for 5 minutes)", async () => {
    const w = world();
    // 1 TAO + 1 rao takes the 6 TAO batch under its 5 TAO floor for the close, then goes back in
    const pair = TAO + RAO;
    minedAs(
      w,
      (c, k) => {
        if (k >= 3) return "mine";
        cancel(w, pair);
        const voided = refuses(w, c.args);
        putBack(w, pair);
        return voided ? "revert" : "mine";
      },
      doorChecks(w),
    );
    const r = await rounds(w, 4, { before: (i) => full(w, i) });
    expect(r.map((x) => x.end)).toEqual([undefined, undefined, undefined, undefined]);
    expect(w.sends.map((s) => [s.fn, s.args])).toEqual(Array.from({ length: 4 }, () => ["closeBatch", [7n, 5n * TAO]]));
    expect(r.map((x) => [x.failing, x.refusals.close])).toEqual(Array.from({ length: 4 }, () => [0, undefined]));
    expect(failedOrStopped(r)).toEqual([]);
    for (const [i, x] of r.slice(0, 3).entries()) {
      expect(x.lines).toContainEqual(
        `Skipped this round (closing the batch): batch 7 changed under the close after its simulation passed (${NO_REASON}); transaction ${w.sends[i].hash} reverted on chain; ${cancelled("1.000000001", headAt(i))}; the next round decides again`,
      );
    }
    expect(r[3].lines).toContainEqual(expect.stringMatching(new RegExp(`^Done: .*\\(transaction ${w.sends[3].hash}`)));
  });

  it("the replay names BatchTooSmall at the close's block, the cancelled TAO put back a block later, before the read after it: the round's quiet skip whatever that read shows, three rounds running; the breaker never trips and the fourth round closes it (before R12h the read after it, the TAO back, counted each)", async () => {
    const w = world();
    let restore = false;
    minedAs(
      w,
      (_c, k) => {
        if (k >= 3) return "mine";
        cancel(w, TAO + RAO);
        restore = true;
        return "revert";
      },
      (args) => {
        try {
          return doorChecks(w)(args);
        } finally {
          // the next block: the holder's deposit back, before anything reads the batch again
          if (restore) putBack(w, TAO + RAO);
          restore = false;
        }
      },
    );
    const r = await rounds(w, 4, { before: (i) => full(w, i) });
    expect(w.sends.map((s) => [s.fn, s.args])).toEqual(Array.from({ length: 4 }, () => ["closeBatch", [7n, 5n * TAO]]));
    expect(r.map((x) => [x.end, x.failing, x.refusals.close])).toEqual(Array.from({ length: 4 }, () => [undefined, 0, undefined]));
    expect(failedOrStopped(r)).toEqual([]);
    for (const [i, x] of r.slice(0, 3).entries()) {
      expect(x.lines).toContainEqual(`Skipped this round (closing the batch): batch 7 changed under the close after its simulation passed (BatchTooSmall: ${TOO_SMALL}); transaction ${w.sends[i].hash} reverted on chain; ${NAMED}; the next round decides again`);
    }
  });

  it("a revert with no reason and no cancel of the batch in its blocks is still counted: another batch's cancel, or this one's before the read it was sent on, explains nothing; three rounds running trip the breaker, never a stop", async () => {
    const w = world();
    minedAs(
      w,
      () => {
        logCancel(w, RAO, { batchId: 6n });
        logCancel(w, RAO, { block: w.head.base - 1n });
        return "revert";
      },
      () => [],
    );
    const r = await rounds(w, 3, { before: (i) => full(w, i) });
    expect(r.map((x) => x.end)).toEqual([undefined, undefined, undefined]);
    expect(r.map((x) => [x.failing, x.refusals.close?.n])).toEqual([
      [1, 1],
      [2, 2],
      [0, 3],
    ]);
    expect(r[0].lines.at(-1)).toMatch(
      new RegExp(
        `^Failed this round \\(it waits, closing the batch\\): the close of batch 7 waits: ${lit(NO_REASON)}; transaction ${HASH} reverted on chain; no deposit of it was cancelled from block 10000 \\(the read it was sent on\\) to block 10000 \\(the one it was mined in\\); read again, it can still close, so nothing explains it; the next round decides again; next round in `,
      ),
    );
    expect(r[2].lines).toContainEqual(expect.stringMatching(/^SKIPPING closing the batch: refused 3 times in a row \(it waits: the close of batch 7 waits: its replay names no reason/));
    // its cancels read on the door, for batch 7, from the read's block to the close's
    expect(w.logQueries.filter((q) => q.topics[0] === numberToHex(7n, { size: 32 }) && q.from === q.to).map((q) => [q.from, q.to])).toEqual([
      [10_000n, 10_000n],
      [10_030n, 10_030n],
      [10_060n, 10_060n],
    ]);
  });

  it("the cancels can't be read (a window refused): read again, the batch still closable as it was sent, a counted wait that says so, never a stop", async () => {
    const w = world();
    minedAs(w, () => "revert", () => []);
    w.logsFail = (_n, _chain, q) => (q.topics[0] === numberToHex(7n, { size: 32 }) ? new RpcError("base eth_getLogs: HTTP 503") : undefined);
    const [x] = await rounds(w, 1, { before: () => full(w) });
    expect([x.end, x.failing, x.refusals.close?.n]).toEqual([undefined, 1, 1]);
    expect(x.lines.at(-1)).toMatch(
      new RegExp(
        `^Failed this round \\(it waits, closing the batch\\): the close of batch 7 waits: ${lit(NO_REASON)}; transaction ${HASH} reverted on chain; its cancels from block 10000 \\(the read it was sent on\\) to block 10000 \\(the one it was mined in\\) couldn't be read \\(base eth_getLogs: HTTP 503\\); read again, it can still close, so nothing explains it; `,
      ),
    );
  });

  it("mined quiet skips between counted waits, round after round: a counted wait, a cancel's quiet skip, two counted waits: the quiet one neither adds to the count nor starts it again, so the fourth round trips the breaker", async () => {
    const w = world();
    minedAs(
      w,
      (_c, k) => {
        if (k === 1) {
          cancel(w, TAO + RAO);
          putBack(w, TAO + RAO);
        }
        return "revert";
      },
      doorChecks(w),
    );
    const r = await rounds(w, 4, { before: (i) => full(w, i) });
    expect(r.map((x) => x.end)).toEqual([undefined, undefined, undefined, undefined]);
    expect(r.map((x) => x.refusals.close?.n)).toEqual([1, 1, 2, 3]);
    expect(r[1].lines).toContainEqual(expect.stringMatching(/^Skipped this round \(closing the batch\): batch 7 changed under the close after its simulation passed \(its replay names no reason .*; a deposit of 1\.000000001 TAO was cancelled from it in block 10030, /));
    expect(r[1].lines.filter((l) => l.startsWith("Failed this round"))).toEqual([]);
    expect(r[3].lines).toContainEqual(expect.stringMatching(/^SKIPPING closing the batch: refused 3 times in a row/));
    expect(w.sends.map((s) => s.fn)).toEqual(["closeBatch", "closeBatch", "closeBatch", "closeBatch"]);
  });

  it("the replay names the door's WrongBatch or BatchNotReady while the batch read after it is still the same and closable: the round's quiet skip, the batch not read again (before R12h each was a counted wait)", async () => {
    for (const [name, args, why] of [
      ["WrongBatch", [8n], "the open batch is another one now (another close landed first)"],
      ["BatchNotReady", [], NOT_READY],
      ["BatchTooSmall", [], TOO_SMALL],
    ] as const) {
      const w = world();
      minedAs(
        w,
        () => "revert",
        () => {
          throw revertWith(name, [...args]);
        },
      );
      const [x] = await rounds(w, 1, { before: () => full(w) });
      expect([x.end, x.failing, x.refusals.close], name).toEqual([undefined, 0, undefined]);
      expect(x.lines, name).toContainEqual(`Skipped this round (closing the batch): batch 7 changed under the close after its simulation passed (${name}: ${why}); transaction ${w.sends[0].hash} reverted on chain; ${NAMED}; the next round decides again`);
    }
  });
});

describe("R12h: cancelsIn, the reverted close's cancels as the door logs them", () => {
  const ofBatch7 = (w: World) => w.logQueries.filter((q) => q.address === ADDR.frontDoor && q.topics[0] === numberToHex(7n, { size: 32 })).map((q) => [q.from, q.to]);

  it("batch 7's DepositCancelled from `from` through `to`, in at most CANCELS_WINDOWS windows read from the end (two of the public RPCs' 100 blocks here); another batch's are left out", async () => {
    const w = world();
    logCancel(w, RAO, { block: 9_000n });
    logCancel(w, 2n * RAO, { block: 9_950n });
    logCancel(w, 3n * RAO, { batchId: 6n, block: 9_990n });
    const { deps } = depsFor(w);
    // a range longer than two windows is read from its end: 9,801 to 10,000
    expect(await deps.cancelsIn(7n, 9_000n, 10_000n)).toEqual([{ block: 9_950n, user: AGED, amount: 2n * RAO }]);
    expect(ofBatch7(w)).toEqual([
      [9_801n, 9_900n],
      [9_901n, 10_000n],
    ]);
    // one within them is read whole
    expect(await deps.cancelsIn(7n, 9_000n, 9_100n)).toEqual([{ block: 9_000n, user: AGED, amount: RAO }]);
    // a read's block past the close's (a node behind another): the close's block alone
    expect(await deps.cancelsIn(7n, 9_960n, 9_950n)).toEqual([{ block: 9_950n, user: AGED, amount: 2n * RAO }]);
  });

  it("the logs server behind the close's block: one more look a moment later; still behind, it throws (the close then reads the batch again and says so)", async () => {
    const w = world();
    const { deps } = depsFor(w);
    await expect(deps.cancelsIn(7n, 10_000n, 10_001n)).rejects.toThrow("the Base logs server is at block 10000, behind block 10001");
    // caught up by the second look
    let looks = 0;
    Object.defineProperty(w.head, "base", { get: () => (looks++ === 0 ? 9_999n : 10_000n), configurable: true });
    expect(await deps.cancelsIn(7n, 10_000n, 10_000n)).toEqual([]);
    expect(looks).toBe(2);
  });
});

describe("R12h: the notice's one close the same", () => {
  /** The notice's world: the batch full by value before its interval (closable by the door's own rule), so a cancel under
   * every line that let it close makes canClose() false: the notice's close names 0, which only that can void */
  const notice = () => {
    const w = world();
    w.alpha.migrationReadyAt = NOTICE;
    return w;
  };

  it("a tip-ordered cancel under every line and a deposit back around each of three notice's closes (the replay naming no reason): each the round's quiet skip by the cancel's log; the fourth round's close lands (before R12h: three counted waits tripped the breaker)", async () => {
    const w = notice();
    minedAs(
      w,
      (c, k) => {
        if (k >= 3) return "mine";
        cancel(w, TAO + RAO, { under: true });
        const voided = refuses(w, c.args);
        putBack(w, TAO + RAO);
        return voided ? "revert" : "mine";
      },
      doorChecks(w),
    );
    const r = await rounds(w, 4, { before: (i) => full(w, i) });
    expect(w.sends.map((s) => [s.fn, s.args])).toEqual(Array.from({ length: 4 }, () => ["closeBatch", [7n, 0n]]));
    expect(r.map((x) => [x.end, x.failing, x.refusals.flush])).toEqual(Array.from({ length: 4 }, () => [undefined, 0, undefined]));
    expect(failedOrStopped(r)).toEqual([]);
    for (const [i, x] of r.slice(0, 3).entries()) {
      expect(x.lines).toContainEqual(
        `Skipped this round (closing batch 7 once (ForeverMoney's migration notice)): batch 7 changed under the notice's close after its simulation passed (${NO_REASON}); transaction ${w.sends[i].hash} reverted on chain; ${cancelled("1.000000001", headAt(i))}; the next round decides again`,
      );
    }
    expect(r[3].lines).toContainEqual(expect.stringMatching(new RegExp(`^Done: .*\\(transaction ${w.sends[3].hash}`)));
  });

  it("the replay names BatchNotReady or WrongBatch while the batch read after it is still closable: the notice's close's quiet skip (before R12h: a counted wait)", async () => {
    for (const [name, args] of [
      ["BatchNotReady", []],
      ["WrongBatch", [8n]],
    ] as const) {
      const w = notice();
      minedAs(
        w,
        () => "revert",
        () => {
          throw revertWith(name, [...args]);
        },
      );
      const r = await rounds(w, 3);
      expect(r.map((x) => [x.end, x.failing, x.refusals.flush]), name).toEqual(Array.from({ length: 3 }, () => [undefined, 0, undefined]));
      expect(failedOrStopped(r), name).toEqual([]);
      expect(r[0].lines, name).toContainEqual(expect.stringMatching(new RegExp(`^Skipped this round \\(closing batch 7 once \\(ForeverMoney's migration notice\\)\\): batch 7 changed under the notice's close after its simulation passed \\(${name}: .*; ${lit(NAMED)}; `)));
    }
  });
});

describe("R12h (the review's optional): a fee-rule close names 0 when the pot covers its quote", () => {
  /** Past its interval, not full (2 TAO of 10): the fee rule decides it. `pot`: its fee pot covers the bridge fee alone
   * (twice the quote); else the pot is empty and the staker's deposit of its 2 TAO pays the fees that cover it (a deposit
   * fee and the swap fee, about $1.25 against a $0.30 bridge fee) */
  const feeDue = (w: World, o: { pot: boolean }) => {
    w.door.deposits = [{ user: AGED, amount: 2n * TAO }];
    w.door.totalDeposits = 2n * TAO;
    w.door.start = BigInt(T - 4_000);
    w.door.canClose = true;
    w.door.feePot = o.pot ? 2n * w.door.closeFee : 0n;
    if (!o.pot) w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "DepositRequested", args: { batchId: 7n, user: AGED, amount: 2n * TAO, payer: ADDR.staker }, block: 9_990n });
  };
  /** The holder cancels `amount` of its entry just before the close in its block (a higher tip); then the door's checks */
  const cancelsFirst = (w: World, amount: bigint) =>
    minedAs(
      w,
      (c) => {
        cancel(w, amount);
        return refuses(w, c.args) ? "revert" : "mine";
      },
      doorChecks(w),
    );

  it("the pot covering the quote (it keeps none of the float): minValue 0, so a cancel of any size just before it can't void it, and it lands (before R12h it named the total less a minimum deposit, and a cancel of more voided it)", async () => {
    const w = world();
    feeDue(w, { pot: true });
    cancelsFirst(w, 15n * 10n ** 17n);
    const [x] = await rounds(w, 1);
    expect(w.sends.map((s) => [s.fn, s.args])).toEqual([["closeBatch", [7n, 0n]]]);
    expect([x.end, x.failing, x.refusals.close]).toEqual([undefined, 0, undefined]);
    expect(x.lines).toContainEqual(expect.stringMatching(new RegExp(`^Done: .*\\(transaction ${w.sends[0].hash}`)));
  });

  it("the pot short of the quote, the staker's deposit fees covering it: the total less one minimum deposit, as R12g", async () => {
    const w = world();
    feeDue(w, { pot: false });
    cancelsFirst(w, RAO);
    const [x] = await rounds(w, 1);
    expect(w.sends.map((s) => [s.fn, s.args])).toEqual([["closeBatch", [7n, 2n * TAO - MIN]]]);
    expect([x.end, x.failing, x.refusals.close]).toEqual([undefined, 0, undefined]);
  });
});

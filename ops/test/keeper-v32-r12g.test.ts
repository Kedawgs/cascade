import { type AbiFunction, type Address, getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { KEEPER_CALLS_V32 } from "../src/keeper/core/abi.ts";
import { classifyFailure, NotNow, Waits } from "../src/keeper/core/failures.ts";
import { encodeMemory, freshMemory, loadMemory } from "../src/keeper/core/memory.ts";
import { runRound } from "../src/keeper/core/round.ts";
import { RpcError } from "../src/keeper/core/rpc.ts";
import { closeV32, flushV32, rollV32, targetV32 } from "../src/keeper/core/v32/actions.ts";
import { feeCloseFloor } from "../src/keeper/core/v32/reads.ts";
import { ADDR, deploymentFor, depsFor, RAO, revertWith, type SentCall, T, TAO, type World, world } from "./keeper-v32-world.ts";

// R12g (the keeper review of R12e-R12f, Fable): a close, the notice's close or a roll the chain reverted never stops the
// keeper, whatever its replay names or fails to name (a reverted close moves nothing): the batch is read again, a batch that
// moved or shrank under it is the round's quiet skip, one still closable as it was (or unread) a wait the breaker counts.
// The fee rule's close names the total less one minimum deposit, so a holder's 1-rao cancels no longer void it. The
// reviewer's four probes, as tests. R12h (keeper-v32-r12h.test.ts) puts the close's own block first: a door reason the
// replay names, or no reason with a cancel of the batch logged up to its block, is the round's quiet skip whatever the
// read after it shows; the tests here that pinned R12g's counts are rewritten to that. On fake chains.

const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const d = deploymentFor();
const target = targetV32(d);
const OPTS = { intervalMs: 60_000, policy: { claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 }, rewardsEveryTicks: 1000 };
/** The world's door's minDeposit */
const MIN = 4n * 10n ** 16n;
const AGED = at("a11ce");
const FRESH = at("f1e5");
const NOTICE = BigInt(T + 7 * 86_400);
const NOT_READY = "the open batch can't close now (canClose() went false since the read: a cancel took it under every line that let it close, or a roll restarted its timer)";
const TOO_SMALL = "the open batch holds less than when it was read (a deposit was cancelled)";
const NO_REASON = "its replay names no reason (the call passes at the block it was mined in and at the one before, or the replay couldn't be read)";
/** R12h: what a counted wait with no reason replayed says of its batch's cancels (the world's Base head stays at 10,000) */
const NO_CANCEL = "no deposit of it was cancelled from block 10000 (the read it was sent on) to block 10000 (the one it was mined in)";
/** R12h: what a quiet skip by a door reason the replay names says */
const NAMED = "its replay names that at the block it was mined in or the one before, whatever the batch holds now";
const HASH = "0x[0-9a-f]{64}";
/** `text` as a regular expression's literal */
const lit = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type KeeperDepsOf = ReturnType<typeof depsFor>["deps"];
type Round = { lines: string[]; failing: number; refusals: Record<string, { n: number } | undefined>; end: unknown };

/** `n` rounds a minute apart, the memory through JSON between them; `before(i)` sets the batch the round reads, and
 * `under(i, deps)` may change the chain under the round's sends. Each round's end is kept: none may stop the keeper. */
async function rounds(w: World, n: number, o: { before?: (i: number) => void; under?: (i: number, deps: KeeperDepsOf) => void } = {}): Promise<Round[]> {
  const out: Round[] = [];
  let saved = encodeMemory(freshMemory());
  for (let i = 0; i < n; i++) {
    const memory = loadMemory(saved).memory;
    w.time.base = T + i * 60;
    w.time.bittensor = T + i * 60;
    o.before?.(i);
    const lines: string[] = [];
    const { deps } = depsFor(w, memory, d, (l) => lines.push(l));
    o.under?.(i, deps);
    const r = await runRound(deps, target, memory, { ...OPTS, now: () => (T + i * 60) * 1000 });
    out.push({ lines, failing: r.memory.failing, refusals: r.memory.refusals as Round["refusals"], end: r.end });
    saved = encodeMemory(r.memory);
  }
  return out;
}

/** The chain mines `w`'s closes (and rolls) as `fate` says, and the replay of a reverted one (its eth_call at the block it was
 * mined in, then the one before) answers as `replay` does */
function minedAs(w: World, fate: (c: SentCall) => "mine" | "revert", replay: (args: readonly unknown[]) => unknown) {
  w.fns.push(...(KEEPER_CALLS_V32 as readonly AbiFunction[]).filter((f) => f.type === "function" && f.name === "closeBatch"));
  w.answers[`${ADDR.frontDoor.toLowerCase()}:closeBatch`] = replay;
  w.fate = (c) => (c.fn === "closeBatch" ? fate(c) : "mine");
}
/** CascadeFrontDoor.closeBatch's checks on the world as it is: what the replay of a mined close meets */
const doorChecks = (w: World) => (args: readonly unknown[]) => {
  if (args[0] !== w.door.id) throw revertWith("WrongBatch", [w.door.id]);
  if (!w.door.canClose) throw revertWith("BatchNotReady");
  if (w.door.deposits.length + w.door.redeems.length > 0 && w.door.totalDeposits < (args[1] as bigint)) throw revertWith("BatchTooSmall");
  return [];
};
/** A replay that passes at both blocks: the revert has no reason the keeper can read */
const passes = () => [];
/** A replay the node can't answer (an RPC error, no revert) */
const unreadable = () => {
  throw new RpcError("base eth_call: HTTP 503");
};

/** The batch the round reads: full by value before its interval (6 of the 10 TAO limit, ten minutes old), closable */
const full = (w: World, i = 0) => {
  w.door.canClose = true;
  w.door.start = BigInt(T + i * 60 - 600);
  w.door.totalDeposits = 6n * TAO;
  w.door.deposits = [{ user: AGED, amount: 6n * TAO }];
};
/** The round's read is the first, the action's own the second, the re-read after a mined revert the third */
const atRead = (deps: KeeperDepsOf, k: number, change: () => void) => {
  const read = deps.readState.bind(deps);
  let n = 0;
  (deps as { readState: typeof deps.readState }).readState = async (x) => {
    if (++n === k) change();
    return read(x);
  };
};
const failedOrStopped = (r: Round[]) => r.flatMap((x) => x.lines).filter((l) => l.startsWith("Failed this round") || l.startsWith("Stopped") || /SKIPPING/.test(l));

describe("R12g (finding 1): a close the chain reverted never stops the keeper, whatever its replay names", () => {
  it("probe 1 (R12h): the replay passes at both blocks because a holder cancelled just before the close with a high tip and deposited just after with a low one, the door still closable with the same total: the cancel logged in its block explains it, the round's quiet skip, three rounds running, never counted nor a stop (R12g counted each, so the third tripped the breaker; before R12g the raw revert stopped the keeper)", async () => {
    const w = world();
    minedAs(w, () => {
      w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "DepositCancelled", args: { batchId: 7n, user: AGED, amount: TAO + RAO }, block: w.head.base });
      return "revert";
    }, passes);
    const r = await rounds(w, 3, { before: (i) => full(w, i) });
    expect(r.map((x) => x.end)).toEqual([undefined, undefined, undefined]);
    expect(w.sends.map((s) => [s.fn, s.args])).toEqual(Array.from({ length: 3 }, () => ["closeBatch", [7n, 5n * TAO]]));
    expect(r.map((x) => [x.failing, x.refusals.close])).toEqual([
      [0, undefined],
      [0, undefined],
      [0, undefined],
    ]);
    expect(failedOrStopped(r)).toEqual([]);
    expect(r[0].lines).toContainEqual(expect.stringMatching(new RegExp(`^Skipped this round \\(closing the batch\\): batch 7 changed under the close after its simulation passed \\(${lit(NO_REASON)}\\); transaction ${HASH} reverted on chain; a deposit of 1\\.000000001 TAO was cancelled from it in block 10000, `)));
  });

  it("the same replay with no cancel of the batch logged in its blocks: nothing explains it, a wait the breaker counts, three rounds running trip it, never a stop (keeper-v32-r12h.test.ts: another batch's cancel, or one before the read, explains nothing)", async () => {
    const w = world();
    minedAs(w, () => "revert", passes);
    const r = await rounds(w, 3, { before: (i) => full(w, i) });
    expect(r.map((x) => x.end)).toEqual([undefined, undefined, undefined]);
    expect(w.sends.map((s) => [s.fn, s.args])).toEqual(Array.from({ length: 3 }, () => ["closeBatch", [7n, 5n * TAO]]));
    expect(r.map((x) => [x.failing, x.refusals.close?.n])).toEqual([
      [1, 1],
      [2, 2],
      [0, 3],
    ]);
    expect(r[0].lines.at(-1)).toMatch(
      new RegExp(
        `^Failed this round \\(it waits, closing the batch\\): the close of batch 7 waits: ${lit(NO_REASON)}; transaction ${HASH} reverted on chain; ${lit(NO_CANCEL)}; read again, it can still close, so nothing explains it; the next round decides again; next round in `,
      ),
    );
    expect(r[2].lines).toContainEqual(expect.stringMatching(/^SKIPPING closing the batch: refused 3 times in a row \(it waits: the close of batch 7 waits: its replay names no reason/));
  });

  it("probe 4: the replay passes, and the total read again is higher (a rao cancelled before the close, 0.04 TAO deposited after): the same counted wait, never a stop", async () => {
    const w = world();
    full(w);
    minedAs(w, () => {
      w.door.deposits = [
        { user: AGED, amount: 6n * TAO - RAO },
        { user: FRESH, amount: MIN },
      ];
      w.door.totalDeposits = 6n * TAO - RAO + MIN;
      return "revert";
    }, passes);
    const [x] = await rounds(w, 1);
    expect(x.end).toBeUndefined();
    expect([x.failing, x.refusals.close?.n]).toEqual([1, 1]);
    expect(x.lines.at(-1)).toMatch(/^Failed this round \(it waits, closing the batch\): the close of batch 7 waits: its replay names no reason .*; read again, it can still close, so nothing explains it; /);
  });

  it("the replay can't be read (an RPC error, no revert), or names a reason the keeper's table doesn't: the same counted wait, never a stop", async () => {
    const w = world();
    minedAs(w, () => "revert", unreadable);
    const [x] = await rounds(w, 1, { before: () => full(w) });
    expect(x.end).toBeUndefined();
    expect([x.failing, x.refusals.close?.n]).toEqual([1, 1]);
    expect(x.lines.at(-1)).toMatch(new RegExp(`^Failed this round \\(it waits, closing the batch\\): the close of batch 7 waits: ${lit(NO_REASON)}; transaction ${HASH} reverted on chain; ${lit(NO_CANCEL)}; read again, it can still close`));
    // a reason no rule names (InsufficientFee): before R12g it went to the race check, which stopped the keeper
    const v = world();
    minedAs(v, () => "revert", () => {
      throw revertWith("InsufficientFee");
    });
    const [y] = await rounds(v, 1, { before: () => full(v) });
    expect(y.end).toBeUndefined();
    expect([y.failing, y.refusals.close?.n]).toEqual([1, 1]);
    expect(y.lines.at(-1)).toMatch(/^Failed this round \(it waits, closing the batch\): the close of batch 7 waits: .*InsufficientFee.*, a reason the keeper's revert table doesn't name; transaction 0x[0-9a-f]{64} reverted on chain; read again, it can still close/);
  });

  it("the replay passes, and the batch read again is closed by another, emptied, no longer closable or holds less (a cancel): the round's quiet skip, never a failed round nor a count for the breaker", async () => {
    const cases: [string, (w: World) => void][] = [
      [
        "batch 7 is closed already",
        (w) => {
          w.door.id = 8n;
          w.door.deposits = [];
          w.door.totalDeposits = 0n;
          w.door.canClose = false;
        },
      ],
      [
        "it is empty",
        (w) => {
          w.door.deposits = [];
          w.door.totalDeposits = 0n;
        },
      ],
      ["it is not ready to close", (w) => (w.door.canClose = false)],
      [
        "it holds less than the read it was sent on (5.5 TAO of 6 TAO: a deposit was cancelled)",
        (w) => {
          w.door.deposits = [{ user: AGED, amount: 55n * 10n ** 17n }];
          w.door.totalDeposits = 55n * 10n ** 17n;
        },
      ],
    ];
    for (const [why, change] of cases) {
      const w = world();
      full(w);
      minedAs(w, () => (change(w), "revert"), passes);
      const [x] = await rounds(w, 1);
      expect(x.end, why).toBeUndefined();
      expect([x.failing, x.refusals.close], why).toEqual([0, undefined]);
      expect(failedOrStopped([x]), why).toEqual([]);
      expect(x.lines, why).toContainEqual(
        `Skipped this round (closing the batch): batch 7 changed under the close after its simulation passed (${NO_REASON}); transaction ${w.sends[0].hash} reverted on chain; read again, ${why}; the next round decides again`,
      );
    }
  });

  it("the notice's one close the same (flushV32): its replay passing at both blocks or unreadable is a counted wait, never a stop; the batch read again closed by another is its quiet skip", async () => {
    for (const replay of [passes, unreadable]) {
      const w = world();
      w.alpha.migrationReadyAt = NOTICE;
      minedAs(w, () => "revert", replay);
      const r = await rounds(w, 3);
      expect(r.map((x) => x.end)).toEqual([undefined, undefined, undefined]);
      expect(w.sends.map((s) => [s.fn, s.args])).toEqual(Array.from({ length: 3 }, () => ["closeBatch", [7n, 0n]]));
      expect(r.map((x) => [x.failing, x.refusals.flush?.n])).toEqual([
        [1, 1],
        [2, 2],
        [0, 3],
      ]);
      expect(r[0].lines.at(-1)).toMatch(
        new RegExp(
          `^Failed this round \\(it waits, closing batch 7 once \\(ForeverMoney's migration notice\\)\\): the notice's close of batch 7 waits: ${lit(NO_REASON)}; transaction ${HASH} reverted on chain; ${lit(NO_CANCEL)}; read again, it can still close, so nothing explains it; `,
        ),
      );
      expect(r[2].lines).toContainEqual(expect.stringMatching(/^SKIPPING closing batch 7 once \(ForeverMoney's migration notice\): refused 3 times in a row/));
    }
    // another close landed first: batch 8 open (opened during the notice), the notice's one close done
    const w = world();
    w.alpha.migrationReadyAt = NOTICE;
    minedAs(w, () => {
      w.door.id = 8n;
      w.door.start = BigInt(w.time.base);
      w.door.deposits = [];
      w.door.totalDeposits = 0n;
      w.door.canClose = false;
      return "revert";
    }, passes);
    const e = await flushV32(depsFor(w).deps, target, 7n).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NotNow);
    expect((e as NotNow).onRead).toBe(true);
    expect((e as Error).message).toMatch(/^batch 7 changed under the notice's close after its simulation passed \(its replay names no reason .*\); transaction 0x[0-9a-f]{64} reverted on chain; read again, batch 7 is closed already; the next round decides again$/);
  });

  it("the roll the same (rollV32): reverted with no reason, the batch read again still empty and able to roll, or the re-read failing: a wait the breaker counts, three rounds running trip it, never a stop; an entry landed first is a skip as before", async () => {
    const empty = (w: World) => {
      w.door.deposits = [];
      w.door.totalDeposits = 0n;
      w.door.canClose = true;
    };
    for (const replay of [passes, unreadable]) {
      const w = world();
      empty(w);
      minedAs(w, () => "revert", replay);
      const r = await rounds(w, 3, { before: () => empty(w) });
      expect(r.map((x) => x.end)).toEqual([undefined, undefined, undefined]);
      expect(w.sends.map((s) => [s.fn, s.args])).toEqual(Array.from({ length: 3 }, () => ["closeBatch", [7n, 0n]]));
      expect(r.map((x) => [x.failing, x.refusals.roll?.n])).toEqual([
        [1, 1],
        [2, 2],
        [0, 3],
      ]);
      expect(r[0].lines.at(-1)).toMatch(
        new RegExp(`^Failed this round \\(it waits, rolling the empty batch\\): the roll of batch 7 waits: ${lit(NO_REASON)}; transaction ${HASH} reverted on chain; read again, it is still empty and can still roll, so nothing explains it; the next round decides again; `),
      );
      expect(r[2].lines).toContainEqual(expect.stringMatching(/^SKIPPING rolling the empty batch: refused 3 times in a row \(it waits: the roll of batch 7 waits: /));
    }
    // the roll's re-read fails: a counted wait too (before R12g: the raw revert, which the round's race check stopped on)
    const w = world();
    empty(w);
    minedAs(w, () => "revert", passes);
    const [x] = await rounds(w, 1, {
      under: (_i, deps) =>
        atRead(deps, 3, () => {
          throw new RpcError("base eth_call: HTTP 503");
        }),
    });
    expect(x.end).toBeUndefined();
    expect([x.failing, x.refusals.roll?.n]).toEqual([1, 1]);
    expect(x.lines.at(-1)).toMatch(/^Failed this round \(it waits, rolling the empty batch\): the roll of batch 7 waits: its replay names no reason .*; the batch couldn't be read again \(base eth_call: HTTP 503\); the next round decides again; /);
    // an entry landed first: not rolled, a skip
    const v = world();
    empty(v);
    minedAs(v, () => {
      v.door.deposits = [{ user: FRESH, amount: MIN }];
      v.door.totalDeposits = MIN;
      return "revert";
    }, passes);
    const r = await rollV32(depsFor(v).deps, target);
    expect(r).toMatchObject({ rolled: false, reason: expect.stringMatching(/^an entry or another close landed first; the roll reverted \(transaction 0x[0-9a-f]{64}\)$/) });
  });
});

describe("R12g (finding 4): minedNotReady's branches, and flushV32's mined path", () => {
  it("probes 2 and 3 (R12h): BatchNotReady named by the replay: the round's quiet skip whatever a read after it would show (closed by another, emptied, still closable, or unreadable): the batch isn't read again (R12g read it again and counted an unread one, or one still closable)", async () => {
    for (const how of ["closed", "empty", "closable", "unreadable"] as const) {
      const w = world();
      minedAs(w, () => "revert", () => {
        throw revertWith("BatchNotReady");
      });
      let reads = 0;
      const [x] = await rounds(w, 1, {
        before: () => full(w),
        under: (_i, deps) =>
          atRead(deps, 3, () => {
            reads++;
            if (how === "unreadable") throw new RpcError("base eth_call: HTTP 503");
            if (how === "closed") w.door.id = 8n;
            if (how !== "closable") {
              w.door.deposits = [];
              w.door.totalDeposits = 0n;
            }
          }),
      });
      expect(x.end, how).toBeUndefined();
      expect([x.failing, x.refusals.close], how).toEqual([0, undefined]);
      expect(reads, how).toBe(0);
      expect(x.lines, how).toContainEqual(
        `Skipped this round (closing the batch): batch 7 changed under the close after its simulation passed (BatchNotReady: ${NOT_READY}); transaction ${w.sends[0].hash} reverted on chain; ${NAMED}; the next round decides again`,
      );
    }
  });

  it("flushV32 mined (R12h): BatchNotReady or WrongBatch named by the replay is its quiet skip, whether the batch has since moved or reads closable again as it was (R12g counted the second); a replay naming no reason, no cancel logged and the batch still closable, a counted wait", async () => {
    const notice = () => {
      const w = world();
      w.alpha.migrationReadyAt = NOTICE;
      return w;
    };
    const quietly = (e: unknown, name: string, why: string, hash: string) => {
      expect([e instanceof Waits, (e as NotNow).onRead, classifyFailure(e).stop], name).toEqual([true, true, false]);
      expect((e as Error).message, name).toBe(`batch 7 changed under the notice's close after its simulation passed (${name}: ${why}); transaction ${hash} reverted on chain; ${NAMED}; the next round decides again`);
    };
    const WRONG = "the open batch is another one now (another close landed first)";
    // BatchNotReady, the cancel landed and stayed: not closable at its block
    const a = notice();
    minedAs(a, () => ((a.door.canClose = false), "revert"), doorChecks(a));
    quietly(await flushV32(depsFor(a).deps, target, 7n).catch((x: unknown) => x), "BatchNotReady", NOT_READY, a.sends[0].hash);
    // BatchNotReady at its block, the door closable again since (a deposit back): the same
    const b = notice();
    minedAs(b, () => "revert", () => {
      throw revertWith("BatchNotReady");
    });
    quietly(await flushV32(depsFor(b).deps, target, 7n).catch((x: unknown) => x), "BatchNotReady", NOT_READY, b.sends[0].hash);
    // WrongBatch: another close landed first (batch 8 open): the notice's one close is done, a quiet skip
    const c = notice();
    minedAs(c, () => {
      c.door.id = 8n;
      c.door.start = BigInt(c.time.base);
      c.door.deposits = [];
      c.door.totalDeposits = 0n;
      c.door.canClose = false;
      return "revert";
    }, doorChecks(c));
    quietly(await flushV32(depsFor(c).deps, target, 7n).catch((x: unknown) => x), "WrongBatch", WRONG, c.sends[0].hash);
    // WrongBatch at its block while batch 7 reads open after it: the same
    const e = notice();
    minedAs(e, () => "revert", () => {
      throw revertWith("WrongBatch", [8n]);
    });
    quietly(await flushV32(depsFor(e).deps, target, 7n).catch((x: unknown) => x), "WrongBatch", WRONG, e.sends[0].hash);
    // no reason replayed, no cancel of batch 7 logged, still closable as it was sent: nothing explains it, counted
    const f = notice();
    minedAs(f, () => "revert", passes);
    const ef = await flushV32(depsFor(f).deps, target, 7n).catch((x: unknown) => x);
    expect([ef instanceof Waits, (ef as NotNow).onRead, classifyFailure(ef).stop]).toEqual([true, false, false]);
    expect((ef as Error).message).toBe(`the notice's close of batch 7 waits: ${NO_REASON}; transaction ${f.sends[0].hash} reverted on chain; ${NO_CANCEL}; read again, it can still close, so nothing explains it; the next round decides again`);
    // through the round: the quiet skip three rounds running, then the flush goes
    const r = notice();
    let cancel = true;
    minedAs(r, () => {
      if (cancel) r.door.canClose = false;
      return r.door.canClose ? "mine" : "revert";
    }, doorChecks(r));
    const out = await rounds(r, 4, {
      before: (i) => {
        r.door.canClose = true;
        cancel = i < 3;
      },
    });
    expect(out.map((x) => [x.end, x.failing, x.refusals.flush])).toEqual(Array.from({ length: 4 }, () => [undefined, 0, undefined]));
    expect(failedOrStopped(out)).toEqual([]);
    for (const x of out.slice(0, 3)) expect(x.lines).toContainEqual(expect.stringMatching(/^Skipped this round \(closing batch 7 once \(ForeverMoney's migration notice\)\): batch 7 changed under the notice's close after its simulation passed \(BatchNotReady: /));
    expect(r.sends.map((s) => s.fn)).toEqual(["closeBatch", "closeBatch", "closeBatch", "closeBatch"]);
  });
});

describe("R12g (finding 2): the fee rule's close names the total less one minimum deposit, and a mined WrongBatch or BatchTooSmall is read again", () => {
  /** Past its interval, not full (2 TAO of 10), its pot covering the bridge fee: the fee rule closes it. A fresh batch each
   * round (the door opens the next one when a close lands) */
  const feeDue = (w: World, i = 0) => {
    w.door.deposits = [{ user: AGED, amount: 2n * TAO }];
    w.door.totalDeposits = 2n * TAO;
    w.door.start = BigInt(T + i * 60 - 4_000);
    w.door.canClose = true;
    // R12h: the staker's deposit fees cover the bridge fee, its pot empty (a pot covering the quote names 0:
    // keeper-v32-r12h.test.ts), as the staker's 2 TAO deposit into this batch says
    w.door.feePot = 0n;
    w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "DepositRequested", args: { batchId: w.door.id, user: AGED, amount: 2n * TAO, payer: ADDR.staker }, block: 9_990n });
  };
  /** Before the close in its block (a higher tip), the holder cancels `amount` of the aged entry; then the door's checks */
  const cancelsFirst = (w: World, amount: (i: number) => bigint) => {
    let round = 0;
    minedAs(
      w,
      (c) => {
        const a = amount(round++);
        w.door.totalDeposits -= a;
        w.door.deposits = [{ ...w.door.deposits[0], amount: w.door.deposits[0].amount - a }];
        try {
          doorChecks(w)(c.args);
        } catch {
          return "revert";
        }
        // the close took the batch: the next one opens
        w.door.id++;
        return "mine";
      },
      doorChecks(w),
    );
  };

  it("feeCloseFloor: the total less one minimum deposit, at least 0", () => {
    expect(feeCloseFloor(2n * TAO, MIN)).toBe(2n * TAO - MIN);
    expect(feeCloseFloor(MIN + RAO, MIN)).toBe(RAO);
    expect(feeCloseFloor(MIN, MIN)).toBe(0n);
    expect(feeCloseFloor(RAO, MIN)).toBe(0n);
    expect(feeCloseFloor(0n, MIN)).toBe(0n);
  });

  it("the round's read carries the floor only for a close the fee rule decides: not for a batch full by its limits (its own floor) nor at the max wait (0)", async () => {
    const fees = world();
    feeDue(fees);
    const s = await depsFor(fees).deps.readState({ economics: true });
    expect([s.v32.feeFloor, s.v32.fullFloor]).toEqual([2n * TAO - MIN, undefined]);
    const value = world();
    full(value);
    const v = await depsFor(value).deps.readState({ economics: true });
    expect([v.v32.feeFloor, v.v32.fullFloor]).toEqual([undefined, 5n * TAO]);
    const late = world();
    feeDue(late);
    late.door.start = BigInt(T - 90_000);
    const l = await depsFor(late).deps.readState({ economics: true });
    expect([l.v32.feeFloor, l.v32.fullFloor]).toEqual([undefined, undefined]);
  });

  it("a holder's 1-rao cancel landing just before each of three fee-rule closes (a high tip): each lands, no failed round, no breaker count (before R12g each named the exact total and reverted BatchTooSmall, a counted wait: the third tripped the breaker, and every fee-rule batch then waited for its max wait)", async () => {
    const w = world();
    cancelsFirst(w, () => RAO);
    const r = await rounds(w, 3, { before: (i) => feeDue(w, i) });
    expect(r.map((x) => x.end)).toEqual([undefined, undefined, undefined]);
    expect(w.sends.map((s) => [s.fn, s.args])).toEqual([
      ["closeBatch", [7n, 2n * TAO - MIN]],
      ["closeBatch", [8n, 2n * TAO - MIN]],
      ["closeBatch", [9n, 2n * TAO - MIN]],
    ]);
    expect(r.map((x) => [x.failing, x.refusals.close])).toEqual([
      [0, undefined],
      [0, undefined],
      [0, undefined],
    ]);
    expect(failedOrStopped(r)).toEqual([]);
    expect(w.door.id).toBe(10n);
  });

  it("a mass cancel (more than one minimum deposit) still voids it: reverted BatchTooSmall, which its replay names, the round's quiet skip; the next round's fee rule decides on what is left and closes it at its own floor", async () => {
    const w = world();
    feeDue(w);
    cancelsFirst(w, (i) => (i === 0 ? 5n * 10n ** 17n : 0n));
    const r = await rounds(w, 2);
    expect(r.map((x) => x.end)).toEqual([undefined, undefined]);
    expect(w.sends.map((s) => [s.fn, s.args])).toEqual([
      ["closeBatch", [7n, 2n * TAO - MIN]],
      ["closeBatch", [7n, 15n * 10n ** 17n - MIN]],
    ]);
    expect(r.map((x) => [x.failing, x.refusals.close])).toEqual([
      [0, undefined],
      [0, undefined],
    ]);
    expect(r[0].lines).toContainEqual(
      `Skipped this round (closing the batch): batch 7 changed under the close after its simulation passed (BatchTooSmall: ${TOO_SMALL}); transaction ${w.sends[0].hash} reverted on chain; ${NAMED}; the next round decides again`,
    );
    expect(failedOrStopped(r)).toEqual([]);
  });

  it("a mined WrongBatch (R12h): another close landed first is the round's quiet skip, and so is batch 7 reading open and closable after it, as the replay names WrongBatch at its block (R12g counted that)", async () => {
    const w = world();
    full(w);
    minedAs(w, () => {
      w.door.id = 8n;
      w.door.start = BigInt(w.time.base);
      w.door.deposits = [];
      w.door.totalDeposits = 0n;
      w.door.canClose = false;
      return "revert";
    }, doorChecks(w));
    const [x] = await rounds(w, 1);
    expect([x.end, x.failing, x.refusals.close]).toEqual([undefined, 0, undefined]);
    expect(x.lines).toContainEqual(
      `Skipped this round (closing the batch): batch 7 changed under the close after its simulation passed (WrongBatch: the open batch is another one now (another close landed first)); transaction ${w.sends[0].hash} reverted on chain; ${NAMED}; the next round decides again`,
    );
    const v = world();
    full(v);
    minedAs(v, () => "revert", () => {
      throw revertWith("WrongBatch", [8n]);
    });
    const e = await closeV32(depsFor(v).deps, target).catch((y: unknown) => y);
    expect([e instanceof Waits, (e as NotNow).onRead, classifyFailure(e).stop]).toEqual([true, true, false]);
    expect((e as Error).message).toBe(`batch 7 changed under the close after its simulation passed (WrongBatch: the open batch is another one now (another close landed first)); transaction ${v.sends[0].hash} reverted on chain; ${NAMED}; the next round decides again`);
  });
});

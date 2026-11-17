import { type Address, ContractFunctionExecutionError, ContractFunctionRevertedError, ContractFunctionZeroDataError, encodeAbiParameters, HttpRequestError, keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { Clients } from "./chain";
import type { Deployment } from "./config";
import {
  deferralCause,
  EXIT_HOLD_KEEP_MS,
  type ExitReads,
  freshNote,
  freshWarning,
  HOLD_S,
  heldUntil,
  leftTodayWei,
  MIN_REDEEM_WEI,
  PAYOUTS_ON_HOLD,
  readExitHold,
  shownExitHold,
  unstakeHoldLines,
} from "./exit-hold";

// v3.2's holds on a front-door unstake (R4): the one-day hold on fresh shares (B-H1) and the closed rail (S-H1), and the
// day's allowance left (the web copy's M2), read at one block. A deferral names none of them, so the trail tells them
// apart from these reads at its delivery's block.

const E18 = 10n ** 18n;
const NOW = 1_800_000_000;
const SHARE = 10n ** 24n; // one whole share (24 decimals)
/** price(): wei per share unit, × 1e18; 1e12 is 1 TAO a share */
const ONE_TAO_A_SHARE = 10n ** 12n;
const reads = (o: Partial<ExitReads> = {}): ExitReads => ({
  time: NOW,
  payoutsOpen: true,
  fresh: { since: 0, shares: 0n },
  balance: 10n * SHARE,
  price: ONE_TAO_A_SHARE,
  outflow: { stakeRao: 1000n * 10n ** 9n, bookedRao: 1000n * 10n ** 9n, rampingWei: 0n, lastStakeAt: 0, bps: 2000n, globalBps: 3000n, floor: 10n * E18, door: { start: NOW - 3600, burned: 30n * E18 }, global: { start: NOW - 3600, burned: 30n * E18 } },
  ...o,
});

describe("the one-day hold on fresh shares", () => {
  it("holds a deposit's shares until a day after their clock (the share-weighted `since`), and nothing after", () => {
    expect(HOLD_S).toBe(86_400);
    expect(heldUntil(reads({ fresh: { since: NOW - 3600, shares: 2n * SHARE } }))).toBe(NOW - 3600 + 86_400);
    expect(heldUntil(reads({ fresh: { since: NOW - 86_400, shares: 2n * SHARE } }))).toBeNull();
    expect(heldUntil(reads({ fresh: { since: NOW - 60, shares: 0n } }))).toBeNull();
  });

  it("says how much is held and for how long; nothing when none is", () => {
    expect(freshNote(reads({ fresh: { since: NOW - 3600, shares: 2n * SHARE } }), NOW * 1000)).toBe("2 TAO of your stake is from a deposit less than a day old. It can be unstaked through Base in about 23 hours.");
    expect(freshNote(reads(), NOW * 1000)).toBeNull();
  });

  it("warns before an unstake that reaches into fresh shares: the older part goes, the rest waits; none of it when the older part is under the minimum", () => {
    const r = reads({ fresh: { since: NOW - 3600, shares: 6n * SHARE } });
    // 4 TAO is older: asking for 3 is fine, 5 reaches into the fresh ones
    expect(freshWarning(r, 3n * E18, NOW * 1000)).toBeNull();
    expect(freshWarning(r, 5n * E18, NOW * 1000)).toBe("Only about 4 TAO of this can be unstaked now. The rest is from a deposit less than a day old: it stays staked, and you can unstake it in about 23 hours.");
    const all = reads({ fresh: { since: NOW - 3600, shares: 10n * SHARE } });
    expect(freshWarning(all, 5n * E18, NOW * 1000)).toBe("None of this can be unstaked yet: it is from a deposit less than a day old. Unstake it in about 23 hours.");
  });

  it("says nothing of the hold once its end has passed on the visitor's clock (never \"in about 0 seconds\")", () => {
    const r = reads({ fresh: { since: NOW - 3600, shares: 6n * SHARE } });
    const end = (NOW - 3600 + 86_400) * 1000;
    expect(freshNote(r, end - 1000)).toBe("6 TAO of your stake is from a deposit less than a day old. It can be unstaked through Base in about 1 second.");
    expect(freshNote(r, end)).toBeNull();
    expect(freshWarning(r, 5n * E18, end)).toBeNull();
    expect(unstakeHoldLines(r, 5n * E18, end + 60_000)).toMatchObject({ fresh: null, warning: null });
  });

  it("rounds a wait up and an amount that can go now down, so neither is overstated", () => {
    // 22 hours 10 minutes is "about 23 hours", 70 seconds "about 2 minutes"
    const later = reads({ fresh: { since: NOW - 86_400 + 22 * 3600 + 600, shares: 2n * SHARE } });
    expect(freshNote(later, NOW * 1000)).toMatch(/in about 23 hours\.$/);
    expect(freshNote(reads({ fresh: { since: NOW - 86_400 + 70, shares: 2n * SHARE } }), NOW * 1000)).toMatch(/in about 2 minutes\.$/);
    // 4.00006 TAO older: "about 4 TAO" can go, never 4.0001; the 5.99994 held reads 6
    const r = reads({ fresh: { since: NOW - 3600, shares: 6n * SHARE - 6n * 10n ** 19n } });
    expect(freshWarning(r, 5n * E18, NOW * 1000)).toMatch(/^Only about 4 TAO of this can be unstaked now\./);
    expect(freshNote(r, NOW * 1000)).toMatch(/^6 TAO of your stake/);
    // what is left today, down: 169.99995 is "about 169.9999 TAO"
    const left = reads({ outflow: { ...reads().outflow!, door: { start: NOW - 3600, burned: 30n * E18 + 5n * 10n ** 13n } } });
    expect(unstakeHoldLines(left, null, NOW * 1000).leftToday).toBe("about 169.9999 TAO");
  });
});

describe("why a front-door unstake was deferred, from the reads at its delivery's block (the event names no cause)", () => {
  it("the rail closed first: every door redeem is deferred while the primary can't send payouts", () => {
    expect(deferralCause(reads({ payoutsOpen: false, fresh: { since: NOW - 60, shares: 10n * SHARE } }), 5n * SHARE)).toBe("rail");
  });

  it("a rail that couldn't be read is never said as the day's limit: unread, unless the hold or the minimum is enough alone", () => {
    expect(deferralCause(reads({ payoutsOpen: undefined }), 5n * SHARE)).toBe("unread");
    expect(deferralCause(reads({ payoutsOpen: undefined, fresh: { since: NOW - 60, shares: 10n * SHARE } }), 5n * SHARE)).toBe("hold");
    expect(deferralCause(reads({ payoutsOpen: undefined }), 2n * 10n ** 22n)).toBe("minimum");
  });

  it("the hold when the shares held a day are worth under the minimum; the minimum when the request itself was; else the allowance or the entry limit", () => {
    expect(MIN_REDEEM_WEI).toBe(3n * 10n ** 16n);
    expect(deferralCause(reads({ fresh: { since: NOW - 60, shares: 10n * SHARE } }), 5n * SHARE)).toBe("hold");
    // a hold that ended counts nothing
    expect(deferralCause(reads({ fresh: { since: NOW - 86_400, shares: 10n * SHARE } }), 5n * SHARE)).toBe("limit");
    expect(deferralCause(reads(), 2n * 10n ** 22n)).toBe("minimum");
    expect(deferralCause(reads({ fresh: { since: NOW - 60, shares: 4n * SHARE } }), 5n * SHARE)).toBe("limit");
  });
});

describe("roughly how much of today's unstake limit is left (the web copy's M2): the smaller of the two windows' rests", () => {
  it("this door's 20% of the priced stake less its burns, against every door's 30%; a window that ended counts nothing", () => {
    expect(leftTodayWei(reads())).toBe(170n * E18);
    expect(leftTodayWei(reads({ outflow: { ...reads().outflow!, global: { start: NOW - 3600, burned: 290n * E18 } } }))).toBe(10n * E18);
    expect(leftTodayWei(reads({ outflow: { ...reads().outflow!, door: { start: NOW - 90_000, burned: 199n * E18 } } }))).toBe(200n * E18);
    // the ramp's unspent part leaves the base, the floor holds it up
    expect(leftTodayWei(reads({ outflow: { ...reads().outflow!, stakeRao: 0n, bookedRao: 0n, door: { start: 0, burned: 0n }, global: { start: 0, burned: 0n } } }))).toBe(10n * E18);
    expect(leftTodayWei(reads({ outflow: undefined }))).toBeUndefined();
  });
});

describe("the Unstake form's lines from the reads: the rail's notice, the hold's countdown and warning, and today's limit left (M2)", () => {
  it("all clear: no notice, no hold, the limit left as a rough figure", () => {
    expect(unstakeHoldLines(reads(), 2n * E18, NOW * 1000)).toEqual({ onHold: null, fresh: null, warning: null, leftToday: "about 170 TAO" });
  });

  it("the rail closed: the approved notice, beside the hold's lines", () => {
    const l = unstakeHoldLines(reads({ payoutsOpen: false, fresh: { since: NOW - 3600, shares: 6n * SHARE } }), 5n * E18, NOW * 1000);
    expect(l.onHold).toBe(PAYOUTS_ON_HOLD);
    expect(l.fresh).toBe("6 TAO of your stake is from a deposit less than a day old. It can be unstaked through Base in about 23 hours.");
    expect(l.warning).toMatch(/^Only about 4 TAO of this can be unstaked now\./);
  });

  it("today's limit left is a dash while the rail is closed: the vault reads the allowance as 0 then", () => {
    expect(unstakeHoldLines(reads({ payoutsOpen: false }), null, NOW * 1000).leftToday).toBe("–");
  });

  it("a read that failed keeps the last one only for EXIT_HOLD_KEEP_MS (two minutes), never as live past it", () => {
    expect(EXIT_HOLD_KEEP_MS).toBe(120_000);
    const data = reads();
    const at = NOW * 1000;
    expect(shownExitHold({ data, isError: false, dataUpdatedAt: at - 3_600_000 }, at)).toBe(data);
    expect(shownExitHold({ data, isError: true, dataUpdatedAt: at - 60_000 }, at)).toBe(data);
    expect(shownExitHold({ data, isError: true, dataUpdatedAt: at - 120_001 }, at)).toBeUndefined();
    expect(shownExitHold({ data: undefined, isError: true, dataUpdatedAt: 0 }, at)).toBeUndefined();
  });

  it("nothing read yet, or no amount: no lines, the limit a dash", () => {
    expect(unstakeHoldLines(undefined, 2n * E18, NOW * 1000)).toEqual({ onHold: null, fresh: null, warning: null, leftToday: "–" });
    expect(unstakeHoldLines(reads({ fresh: { since: NOW - 3600, shares: 6n * SHARE } }), null, NOW * 1000).warning).toBeNull();
  });
});

describe("readExitHold: one multicall at the block (the newest fresh one, or the delivery's), then the primary's canSendPayouts()", () => {
  const d = { vault: "0x00000000000000000000000000000000000000f1", vaultLens: "0x00000000000000000000000000000000000000f2", doorLens: "0x00000000000000000000000000000000000000f3", frontDoor: "0x00000000000000000000000000000000000000f4", bitAdapter: "0x00000000000000000000000000000000000000f5", baseAdapter: "0x00000000000000000000000000000000000000f6", version: 3 } as unknown as Deployment;
  const ACCOUNT = "0x00000000000000000000000000000000000000a1" as Address;
  const PRIMARY = "0x00000000000000000000000000000000000000b7" as Address;
  const peer = keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [8453n, d.frontDoor]));
  /** What viem's multicall (allowFailure) reports for a call when the node fails the whole aggregate3 call: the batch's
   * error, under aggregate3. A JSON-RPC -32603 ("internal error") with a message is mapped to a revert inside it. */
  const batchFailed = (cause: Error) => new ContractFunctionExecutionError(cause as never, { abi: [], functionName: "aggregate3" });
  const internal = (functionName: string) => new ContractFunctionRevertedError({ abi: [], functionName, message: "Internal JSON-RPC error. (-32603)" });
  /** The view's own failures, by kind: the contract refused it (no such view), the node not reached (HTTP 429), or the node's
   * internal error (-32603), each as the multicall reports it for the view's call */
  const viewFailure = (k: "revert" | "transport" | "internal") =>
    k === "revert" ? new ContractFunctionZeroDataError({ functionName: "canSendPayouts" }) : batchFailed(k === "transport" ? new HttpRequestError({ url: "https://bittensor.example", status: 429 }) : internal("aggregate3"));
  function client(o: { canSend?: boolean | "revert" | "transport" | "internal"; fail?: string[] } = {}) {
    const answers: Record<string, unknown> = {
      primaryBridge: PRIMARY,
      freshShares: [BigInt(NOW - 60), 3n * SHARE],
      balanceOf: 10n * SHARE,
      price: ONE_TAO_A_SHARE,
      visibleStakeRao: 1000n * 10n ** 9n,
      bookedStake: 1000n * 10n ** 9n,
      rampingStake: 0n,
      lastStakeAt: 0n,
      maxDailyOutflowBps: 2000n,
      globalOutflowBps: 3000n,
      minDailyOutflow: 10n * E18,
    };
    const asked: { fn: string; args?: readonly unknown[]; block?: bigint }[] = [];
    const bittensor = {
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber?: bigint; blockTag?: string }) => ({ number: blockNumber ?? 900n, timestamp: BigInt(NOW) })),
      // allowFailure: each call's own answer, a status and its result or error
      multicall: vi.fn(async ({ contracts, blockNumber, allowFailure }: { contracts: { address: Address; functionName: string; args?: readonly unknown[] }[]; blockNumber: bigint; allowFailure: boolean }) =>
        contracts.map((x) => {
          if (!allowFailure) throw new Error("the read must allow each call to fail on its own");
          // the primary's view, read on its own (the review's N1)
          if (x.functionName === "canSendPayouts") {
            asked.push({ fn: `${x.address}.canSendPayouts`, block: blockNumber });
            return typeof o.canSend === "string" ? { status: "failure", error: viewFailure(o.canSend) } : { status: "success", result: o.canSend ?? true };
          }
          asked.push({ fn: x.functionName, args: x.args, block: blockNumber });
          const result = x.functionName === "burnWindows" ? (x.args?.[0] === peer ? [BigInt(NOW - 3600), 30n * E18] : [BigInt(NOW - 3600), 40n * E18]) : answers[x.functionName];
          return o.fail?.includes(x.functionName) ? { status: "failure", error: new Error(`${x.functionName} failed`) } : { status: "success", result };
        }),
      ),
      // a read through the client's batch scheduler reports a batch's -32603 under the view itself, where it looks like the
      // contract's refusal: what the view's read must not rely on
      readContract: vi.fn(async ({ functionName, address, blockNumber }: { functionName: string; address: Address; blockNumber: bigint }) => {
        asked.push({ fn: `${address}.${functionName}`, block: blockNumber });
        if (o.canSend === "revert") throw new ContractFunctionZeroDataError({ functionName });
        if (o.canSend === "transport") throw new HttpRequestError({ url: "https://bittensor.example", status: 429 });
        if (o.canSend === "internal") throw new ContractFunctionExecutionError(internal(functionName) as never, { abi: [], functionName });
        return o.canSend ?? true;
      }),
    };
    return { c: { bittensor } as unknown as Pick<Clients, "bittensor">, asked };
  }

  it("reads at the block asked: the fresh shares, the balance, the price, the windows by this door's peer and the global one, then the primary's view", async () => {
    const { c, asked } = client({ canSend: false });
    const r = await readExitHold(c, d, ACCOUNT, 777n);
    expect(r).toMatchObject({ time: NOW, payoutsOpen: false, fresh: { since: NOW - 60, shares: 3n * SHARE }, balance: 10n * SHARE, price: ONE_TAO_A_SHARE });
    expect(r.outflow).toMatchObject({ door: { start: NOW - 3600, burned: 30n * E18 }, global: { start: NOW - 3600, burned: 40n * E18 } });
    expect(asked.every((a) => a.block === 777n)).toBe(true);
    expect(asked.at(-1)?.fn).toBe(`${PRIMARY}.canSendPayouts`);
    expect(asked.find((a) => a.fn === "freshShares")?.args).toEqual([ACCOUNT]);
  });

  it("a primary that refuses the view (none such) leaves the rail unknown, never closed; a node that can't be reached rejects the read", async () => {
    const { c } = client({ canSend: "revert" });
    expect((await readExitHold(c, d, ACCOUNT, 777n)).payoutsOpen).toBeUndefined();
    await expect(readExitHold(client({ canSend: "transport" }).c, d, ACCOUNT, 777n)).rejects.toThrow();
  });

  it("a node's internal error (JSON-RPC -32603) on the view rejects the read: never taken for the contract's refusal (the review's N1)", async () => {
    const { c, asked } = client({ canSend: "internal" });
    await expect(readExitHold(c, d, ACCOUNT, 777n)).rejects.toThrow(/-32603/);
    // the view is read in a multicall of its own, at the same block
    expect(asked.at(-1)).toEqual({ fn: `${PRIMARY}.canSendPayouts`, block: 777n });
  });

  it("an allowance input that fails leaves only the limit unknown: the rail, the fresh shares and the balance still read (M6)", async () => {
    const r = await readExitHold(client({ canSend: false, fail: ["visibleStakeRao"] }).c, d, ACCOUNT, 777n);
    expect(r).toMatchObject({ payoutsOpen: false, fresh: { since: NOW - 60, shares: 3n * SHARE }, balance: 10n * SHARE });
    expect(r.outflow).toBeUndefined();
    // what a cause needs failing rejects the read: nothing is guessed
    await expect(readExitHold(client({ fail: ["freshShares"] }).c, d, ACCOUNT, 777n)).rejects.toThrow(/freshShares/);
  });

  it("at a delivery's block reads only what a cause needs, never the allowance's inputs", async () => {
    const { c, asked } = client();
    const r = await readExitHold(c, d, ACCOUNT, 777n, { outflow: false });
    expect(asked.map((a) => a.fn)).toEqual(["primaryBridge", "freshShares", "balanceOf", "price", `${PRIMARY}.canSendPayouts`]);
    expect(r.outflow).toBeUndefined();
  });

  it("the closed rail's notice is the approved copy (N3)", () => {
    expect(PAYOUTS_ON_HOLD).toBe("Unstakes through Base are on hold. The bridge can't send payouts right now. Requests keep your stake; a regular wallet can withdraw on Bittensor.");
  });
});

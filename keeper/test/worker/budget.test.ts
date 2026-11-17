import { reset } from "cloudflare:test";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryJournal } from "../../../ops/src/keeper/core/journal.ts";
import { freshMemory, fromJson, toJson } from "../../../ops/src/keeper/core/memory.ts";
import type { Rpc } from "../../../ops/src/keeper/core/rpc.ts";
import { depsV32 } from "../../../ops/src/keeper/core/v32/reads.ts";
import { ADDR, deploymentFor, marketOf, revertWith, rpcOf, SIGNER, T, world } from "../../../ops/test/keeper-v32-world.ts";
import { MULTICALL3 } from "../../src/config.ts";
import { BudgetSpent, batched, freshLearned, meter, metered, RESERVE } from "../../src/rpc.ts";

import { chains, closeDue, coordinator, keeperRun, savedMemory, started, testEnv } from "./harness.ts";

// One run's budget (design-keeper-worker.md §5), measured in local workerd over the fake chains: its CPU (no network:
// the fake answers at once, so the run's time is its own work), its subrequests, and the rules that keep a run inside
// them (the subrequest budget, the 45 s send window, Multicall3).

beforeEach(async () => {
  await reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const quiet = { print: () => undefined };

describe("a run's budget", () => {
  it("measures a full round, cold (a fresh object: the for-life list, nothing learned to batch) and warm, and a quiet one", async () => {
    const c = chains((w) => {
      // a batch past its interval and inside its max wait: the close rule prices it (oracle, staker, quoter, the
      // bridge fee, the batch's deposit logs) before it decides; its fees cover the bridge fee, so it closes
      w.door.feePot = 10n ** 16n;
      w.fate = (x) => {
        if (x.fn === "closeBatch") {
          w.door.id += 1n;
          w.door.deposits = [];
          w.door.totalDeposits = 0n;
          w.door.feePot = 0n;
          w.door.start = BigInt(w.time.base);
        }
        return "mine";
      };
    });
    await started();
    const t = Date.now();
    const measure = async (at: number) => {
      const t0 = performance.now();
      const r = await keeperRun(testEnv, { ...quiet, now: () => at });
      return { r, ms: performance.now() - t0, sends: c.w.sends.splice(0).map((x) => x.fn) };
    };
    const cold = await measure(t);
    // a new batch with deposits and fees, due the same way
    c.w.door.deposits = [{ user: "0x000000000000000000000000000000000000de01", amount: 2n * 10n ** 18n }];
    c.w.door.totalDeposits = 2n * 10n ** 18n;
    c.w.door.feePot = 10n ** 16n;
    c.w.door.start = BigInt(c.w.time.base - 4_000);
    const warm = await measure(t + 61_000);
    const calm = await measure(t + 122_000);
    // two users credited on Base with a live preference: the round delivers to the older credit, after reading both
    c.w.market = marketOf();
    // new blocks on Base, the credits among them
    c.w.head.base += 300n;
    for (const [i, user] of (["0x00000000000000000000000000000000000d0001", "0x00000000000000000000000000000000000d0002"] as const).entries()) {
      c.w.door.claimable[user] = 2n * 10n ** 18n;
      c.w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "PayoutReceived", args: { batchKey: `0x${"ab".repeat(32)}`, chunk: 0, user, amount: 2n * 10n ** 18n }, block: c.w.head.base - 100n + BigInt(i) });
      const pref = [300_000_000n, BigInt(T + 7 * 86_400), 6] as const;
      c.w.door.prefs[user] = pref;
      c.w.logs.push({ chain: "base", address: ADDR.frontDoor, event: "DeliverySet", args: { user, minUsdcPerTao: pref[0], deadline: pref[1], destination: 6 }, block: c.w.head.base - 150n });
    }
    const deliveries = await measure(t + 183_000);
    const n = (r: typeof cold.r) => r.meter?.count ?? 0;
    const unbatched = (r: typeof cold.r) => n(r) - (r.batches?.batches ?? 0) + (r.batches?.answered ?? 0);
    const said = (name: string, x: typeof cold) =>
      `${name}: ${x.ms.toFixed(0)} ms, ${n(x.r)} RPC requests (${unbatched(x.r)} without Multicall3), ${x.r.calls} coordinator calls, sends ${x.sends.join(", ") || "none"}, by method ${JSON.stringify(x.r.meter?.byMethod)}`;
    console.warn(`measured (local workerd, fake RPC):
  ${said("cold round", cold)}
  ${said("warm round", warm)}
  ${said("quiet round", calm)}
  ${said("two delivery candidates", deliveries)}`);
    expect([cold.sends, warm.sends, calm.sends, deliveries.sends]).toEqual([["closeBatch"], ["closeBatch"], [], ["deliver"]]);
    expect(n(deliveries.r)).toBeLessThan(80);
    // well inside the defaults: 30 s of CPU, 300 RPC requests (KEEPER_SUBREQUEST_BUDGET), 1,000 subrequests
    for (const x of [cold, warm, calm]) expect(x.ms).toBeLessThan(5_000);
    // a cold round reads Task 52's scans from the start blocks too: the five park events and both lanes' Sent, about 66
    // more requests over the fake chains' 9,900 blocks (Bittensor's 1,000 a window); a warm round reads them once each
    expect(n(cold.r)).toBeLessThan(250);
    expect(n(warm.r)).toBeLessThan(80);
    expect(n(calm.r)).toBeLessThan(40);
    expect(unbatched(warm.r)).toBeGreaterThan(2 * n(warm.r));
  });

  it("a broadcast is never refused by the budget (the review's W3): its transaction is signed and written ahead by then, so it goes out, counted, whatever the send path's settling used", async () => {
    const m = meter(5);
    // the budget and the send's own spare both used up (the settling of many rows, say)
    m.count = 5 + RESERVE;
    const asked: string[] = [];
    const rpc = metered({ request: async (_c, method) => (asked.push(method), "0x01") }, m);
    await expect(rpc.request("base", "eth_getTransactionReceipt", ["0x"])).rejects.toBeInstanceOf(BudgetSpent);
    await expect(rpc.request("base", "eth_estimateGas", [{}])).rejects.toBeInstanceOf(BudgetSpent);
    expect(await rpc.request("base", "eth_sendRawTransaction", ["0x02"])).toBe("0x01");
    expect(asked).toEqual(["eth_sendRawTransaction"]);
  });

  it("a run past its subrequest budget asks nothing more and sends nothing", async () => {
    const c = chains((w) => closeDue(w));
    await started();
    const r = await keeperRun({ ...testEnv, KEEPER_SUBREQUEST_BUDGET: "6" }, quiet);
    expect(r.meter?.count).toBe(6);
    expect(r.lines.some((l) => /^Failed this round \(RPC error, .*the run's 6 RPC requests \(KEEPER_SUBREQUEST_BUDGET\) are spent/.test(l))).toBe(true);
    expect(c.w.sends).toEqual([]);
  });

  it("a slow round keeps its lease (renewed as it reads): the next cron is refused, and the round commits", async () => {
    const c = chains((w) => closeDue(w));
    await started();
    // every request takes 40 ms for real, so the round runs for well over its 300 ms lease
    c.hold.wait = () => new Promise((r) => setTimeout(r, 40));
    const slow = keeperRun(testEnv, { ...quiet, leaseMs: 300 });
    await new Promise((r) => setTimeout(r, 700));
    const next = await coordinator().acquire({ holder: "cron:next", kind: "cron", ttlMs: 60_000 });
    expect(next).toMatchObject({ granted: false, why: "held" });
    const r = await slow;
    expect(r.outcome, r.lines.join(" | ")).toBe("ran");
    expect(c.w.sends.map((x) => x.fn)).toEqual(["closeBatch"]);
  });

  it("stops reading 90 s into a run, sends nothing more, and commits what it has, its log cursors included", async () => {
    const c = chains((w) => closeDue(w));
    await started();
    // the run's clock moves 2 s with every request (a slow node), so 90 s are up partway through the round
    let t = Date.now();
    const asked: number[] = [];
    c.hold.wait = async () => {
      asked.push(t);
      t += 2_000;
    };
    const start = t;
    const r = await keeperRun(testEnv, { ...quiet, now: () => t });
    expect(r.outcome, r.lines.join(" | ")).toBe("ran");
    expect(r.lines.some((l) => l.includes("the run's 90 s for reading are up")), r.lines.join(" | ")).toBe(true);
    expect(Math.max(...asked) - start).toBeLessThan(90_000);
    expect(c.w.sends).toEqual([]);
    const m = fromJson<{ memory: { tick: number } }>(await coordinator().status());
    expect(m.memory.tick).toBe(1);
    // the scan of the vault's payout batches finished before the deadline: its cursor is saved
    const saved = fromJson<{ reads: { v32: { queued?: { scannedTo?: bigint } } } }>(await savedMemory());
    expect(saved.reads.v32.queued?.scannedTo).toBe(c.w.head.bittensor);
  });

  it("a transaction signed and written ahead goes out even when the run's 90 s for reading run out before its broadcast: its row's \"sent\" is true, and it is watched (the re-review's N4)", async () => {
    const c = chains((w) => {
      closeDue(w);
      // a close that lands takes the open batch with it
      w.fate = (x) => {
        if (x.fn === "closeBatch") {
          w.door.id = 8n;
          w.door.deposits = [];
          w.door.totalDeposits = 0n;
          w.door.start = BigInt(w.time.base);
        }
        return "mine";
      };
    });
    await started();
    let t = Date.now();
    // the run's clock passes its read deadline right after the write-ahead, before the broadcast
    const r = await keeperRun(testEnv, {
      ...quiet,
      now: () => t,
      sleep: async (ms) => void (t += ms),
      coordinator: (e, n) => {
        const x = coordinator(n, e);
        return {
          acquire: (q) => x.acquire(q),
          renew: (q) => x.renew(q),
          release: (q) => x.release(q),
          commit: (q) => x.commit(q),
          writeAhead: async (q) => {
            const done = await x.writeAhead(q);
            t += 91_000;
            return done;
          },
          replaced: (q) => x.replaced(q),
          update: (q) => x.update(q),
          since: (q) => x.since(q),
          stop: (q) => x.stop(q),
        };
      },
    });
    expect(r.outcome, r.lines.join(" | ")).toBe("ran");
    expect(c.w.sends.map((x) => x.fn)).toEqual(["closeBatch"]);
    const [row] = fromJson<{ status: string; hashes: string[] }[]>(await coordinator().since({ sinceMs: 0 }));
    expect([row.status, row.hashes]).toEqual(["sent", [c.w.sends[0].hash]]);
    // the next run reads its receipt (a late one): it went through, and nothing is sent again
    const next = await keeperRun(testEnv, { ...quiet, now: () => t + 120_000 });
    expect(next.lines.some((l) => l.startsWith(`Late receipt: closing the batch went through (transaction ${c.w.sends[0].hash})`)), [...r.lines, "--", ...next.lines].join(" | ")).toBe(true);
    expect(c.w.sends).toHaveLength(1);
  });

  it("a request no answer comes back to is given up (RequestTimeout, 20 s; here 50 ms), so a hung node can't hold a run past its deadline and its lease: the round fails soft and the run commits (the re-review's N8)", { timeout: 15_000 }, async () => {
    const c = chains((w) => closeDue(w));
    await started();
    // the node never answers its chain id (asked before the round's first send)
    c.hold.when = (f) => f.method === "eth_chainId";
    const t0 = performance.now();
    const r = await keeperRun(testEnv, { ...quiet, requestTimeoutMs: 50 });
    expect(r.outcome, r.lines.join(" | ")).toBe("ran");
    expect(r.lines.some((l) => /eth_chainId: no answer in 0\.05 s; given up, the next run asks again/.test(l)), r.lines.join(" | ")).toBe(true);
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(c.w.sends).toEqual([]);
    expect(fromJson<{ memory: { tick: number } }>(await coordinator().status()).memory.tick).toBe(1);
  });

  it("no send starts after the run's first 45 s", async () => {
    const c = chains((w) => closeDue(w));
    await started();
    const t = Date.now();
    let first = true;
    const r = await keeperRun(testEnv, {
      ...quiet,
      now: () => {
        if (first) {
          first = false;
          return t;
        }
        return t + 46_000;
      },
    });
    expect(c.w.sends).toEqual([]);
    expect(r.lines.some((l) => l.includes("the run is past its 45 s send window: close batch 7 and send it to Bittensor not sent; the next run decides"))).toBe(true);
  });
});

describe("Multicall3 batching", () => {
  /** The fake world's RPC with Multicall3's aggregate3 answered by the world itself, call by call */
  const withMulticall = (inner: Rpc, asked: string[]): Rpc => ({
    async request(chain, method, params) {
      asked.push(method);
      const p = params[0] as { to?: string; data?: Hex };
      if (method === "eth_call" && p.to?.toLowerCase() === MULTICALL3.toLowerCase()) {
        const { decodeFunctionData, encodeFunctionResult, parseAbi } = await import("viem");
        const abi = parseAbi(["struct Call3 { address target; bool allowFailure; bytes callData; }", "struct Result { bool success; bytes returnData; }", "function aggregate3(Call3[] calls) payable returns (Result[] returnData)", "function getEthBalance(address) view returns (uint256)"]);
        const calls = decodeFunctionData({ abi, data: p.data as Hex }).args[0] as unknown as { target: Hex; callData: Hex }[];
        const out = [];
        for (const c of calls) {
          try {
            if (c.target.toLowerCase() === MULTICALL3.toLowerCase()) {
              const a = decodeFunctionData({ abi, data: c.callData }).args[0] as Hex;
              out.push({ success: true, returnData: encodeFunctionResult({ abi, functionName: "getEthBalance", result: BigInt((await inner.request(chain, "eth_getBalance", [a, "latest"])) as Hex) }) });
            } else out.push({ success: true, returnData: (await inner.request(chain, "eth_call", [{ to: c.target, data: c.callData }, "latest"])) as Hex });
          } catch {
            out.push({ success: false, returnData: "0x" as Hex });
          }
        }
        return encodeFunctionResult({ abi, functionName: "aggregate3", result: out });
      }
      return inner.request(chain, method, params);
    },
  });
  const deps = (rpc: Rpc) => depsV32({ rpc, deployment: deploymentFor(), signer: SIGNER, send: { chains: { base: { chainId: 8453, legacy: false }, bittensor: { chainId: 964, legacy: true } }, receiptTimeoutMs: 0 }, journal: memoryJournal(), memory: freshMemory(), rails: { monitor: null, deliveriesOn: true }, log: () => undefined });

  it("answers the round's reads with exactly what reading them one by one gives, in far fewer requests", async () => {
    const w = world();
    const direct: string[] = [];
    const plain = await deps(withMulticall(rpcOf(w), direct)).readState({ economics: true });
    const asked: string[] = [];
    const learned = freshLearned();
    // a first run learns which reads the round makes; the next batches them
    const first = batched(withMulticall(rpcOf(w), []), { learned, now: () => 0, log: () => undefined, multicall3: MULTICALL3 });
    await deps(first.rpc).readState({ economics: true });
    const second = batched(withMulticall(rpcOf(w), asked), { learned: first.learned(), now: () => 0, log: () => undefined, multicall3: MULTICALL3 });
    const viaBatch = await deps(second.rpc).readState({ economics: true });
    expect(toJson(viaBatch)).toBe(toJson(plain));
    expect(asked.filter((m) => m === "eth_call").length).toBeLessThanOrEqual(3);
    expect(direct.filter((m) => m === "eth_call").length).toBeGreaterThan(25);
    expect(second.stats.batches).toBeGreaterThanOrEqual(1);
  });

  it("a read that reverts inside the batch is asked again on its own, so its error is the node's own", async () => {
    const w = world();
    w.answers[`${deploymentFor().addresses.frontDoor.toLowerCase()}:canClose`] = () => {
      throw revertWith("Paused");
    };
    const learned = freshLearned();
    const first = batched(rpcOf(w), { learned, now: () => 0, log: () => undefined, multicall3: MULTICALL3 });
    const e1 = await deps(first.rpc).readState().catch((e: Error) => e);
    const second = batched(withMulticall(rpcOf(w), []), { learned: first.learned(), now: () => 0, log: () => undefined, multicall3: MULTICALL3 });
    const e2 = await deps(second.rpc).readState().catch((e: Error) => e);
    expect(e2).toBeInstanceOf(Error);
    expect((e2 as Error).message).toBe((e1 as Error).message);
    expect(second.stats.direct).toBeGreaterThanOrEqual(1);
  });

  it("an estimate or a broadcast ends the batch: what is read after a send is read fresh", async () => {
    const w = world();
    const learned = freshLearned();
    const first = batched(withMulticall(rpcOf(w), []), { learned, now: () => 0, log: () => undefined, multicall3: MULTICALL3 });
    await deps(first.rpc).readState();
    const b = batched(withMulticall(rpcOf(w), []), { learned: first.learned(), now: () => 0, log: () => undefined, multicall3: MULTICALL3 });
    const d = deps(b.rpc);
    const before = await d.readState();
    w.door.totalDeposits = 5n * 10n ** 18n;
    // within the batch's time and with no send between, the batch answers (one block for the whole round's read)
    expect((await d.readState()).v32.openTotal).toBe(before.v32.openTotal);
    await b.rpc.request("base", "eth_estimateGas", [{}]).catch(() => undefined);
    expect((await d.readState()).v32.openTotal).toBe(5n * 10n ** 18n);
  });

  it("a batch answers for 15 seconds at most: a read after that is fresh", async () => {
    const w = world();
    let t = 0;
    const learned = freshLearned();
    const first = batched(withMulticall(rpcOf(w), []), { learned, now: () => t, log: () => undefined, multicall3: MULTICALL3 });
    await deps(first.rpc).readState();
    const b = batched(withMulticall(rpcOf(w), []), { learned: first.learned(), now: () => t, log: () => undefined, multicall3: MULTICALL3 });
    const d = deps(b.rpc);
    await d.readState();
    w.door.totalDeposits = 6n * 10n ** 18n;
    t = 14_000;
    expect((await d.readState()).v32.openTotal).toBe(2n * 10n ** 18n);
    t = 15_000;
    expect((await d.readState()).v32.openTotal).toBe(6n * 10n ** 18n);
  });

  it("a batch that fails as a whole turns batching off for the run, said once", async () => {
    const w = world();
    const lines: string[] = [];
    const learned = freshLearned();
    const first = batched(rpcOf(w), { learned, now: () => 0, log: () => undefined, multicall3: MULTICALL3 });
    await deps(first.rpc).readState();
    // the world has no Multicall3: its eth_call answers "unexpected call"
    const b = batched(rpcOf(w), { learned: first.learned(), now: () => 0, log: (l) => lines.push(l), multicall3: MULTICALL3 });
    const s = await deps(b.rpc).readState();
    expect(s.v32.openId).toBe(7n);
    expect(lines.filter((l) => l.includes("reading through Multicall3 failed"))).toHaveLength(2);
    expect(lines.every((l) => /^(Base|Bittensor): reading through Multicall3 failed \(.+\); this run reads one by one$/.test(l))).toBe(true);
  });
});

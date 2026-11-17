import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { payoutsHash, type Payout } from "../../../ops/src/keeper/core/payouts.ts";
import { handCommandV32, type HandCommandV32, LeaseLost } from "../../../ops/src/keeper/lease-client.ts";
import { ADDR, type Batch, deploymentFor, failInWorld, laneMessage, monitorOf, rpcOf, sendInWorld, SIGNER, T, TAO, type World, world } from "../../../ops/test/keeper-v32-world.ts";
import { make, routes } from "./fake-routes.ts";

// The v3.2 hand commands (ops/src/keeper/lease-client.ts handCommandV32, which cli.ts runs with the cast signer; the
// review's Minor 8): close, payouts and run against ops' fake v3.2 world, under the fake control routes' lease. Each send
// renews the lease first and is written ahead to the Worker's journal; the one-shot payouts read the rails again before
// each batch (the review's Important 4).

const CLAIM = { claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 };

/** A payout batch queued in the world, with its list's logs (as ops' keeper-v32.test.ts queue) */
function queue(w: World, key: Hex, list: Payout[], block: bigint): Batch {
  list.forEach((p, i) => w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "Redeemed", args: { key, user: p.user, shares: p.shares, assets: p.assets }, block: block + BigInt(i) }));
  const total = list.reduce((t, p) => t + p.assets, 0n);
  w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "PayoutBatchQueued", args: { key, sourceChain: 8453n, batchId: 7n, count: list.length, total, price: 10n ** 12n }, block: block + 50n });
  const b: Batch = { sourceChain: 8453n, frontDoor: ADDR.frontDoor, batchId: 7n, queuedAt: BigInt(T - 2 * 86_400), cursor: 0, count: list.length, chunk: 0, remaining: total, payoutsHash: payoutsHash(list) };
  w.vault.batches[key.toLowerCase()] = b;
  w.vault.pending += total;
  return b;
}

function setup(over: (w: World) => void = () => undefined) {
  const w = world();
  over(w);
  const r = routes();
  const lines: string[] = [];
  const control = make(r, lines);
  const base = (cmd: HandCommandV32["cmd"], o: Partial<HandCommandV32> = {}): HandCommandV32 => ({
    cmd,
    live: true,
    name: "v3.2-launch",
    deployment: deploymentFor(),
    signer: SIGNER,
    rpc: rpcOf(w),
    chains: { base: { chainId: 8453, legacy: false }, bittensor: { chainId: 964, legacy: true } },
    receiptTimeoutMs: 0,
    pollMs: 0,
    sleep: async () => undefined,
    rails: (deliveriesOn) => ({ monitor: monitorOf(w), deliveriesOn }),
    control,
    policy: CLAIM,
    log: (l) => lines.push(l),
    ...o,
  });
  return { w, r, lines, base };
}

describe("a v3.2 hand command", () => {
  it("close: under the lease, the send renewed first and written ahead to the Worker's journal, the lease released", async () => {
    const s = setup((w) => {
      w.door.start = BigInt(w.time.base - 90_000);
    });
    expect(await handCommandV32(s.base("close"))).toBe(0);
    expect(s.w.sends.map((x) => x.fn)).toEqual(["closeBatch"]);
    const actions = s.r.st.calls.map((c) => (c.path === "/v1/lease" ? `lease:${c.body.action}` : c.path === "/v1/journal" ? `journal:${c.body.action}` : c.path));
    // acquire, the rails' spend-cap read, the renew right before the send, its write-ahead, then the release
    expect(actions.indexOf("lease:acquire")).toBe(0);
    expect(actions.indexOf("lease:renew")).toBeLessThan(actions.indexOf("journal:writeAhead"));
    expect(actions.at(-1)).toBe("lease:release");
    expect(s.r.st.journal.map((x) => [x.request.functionName, x.status])).toEqual([["closeBatch", "landed"]]);
    expect(s.lines.some((l) => /^Done \(transaction 0x[0-9a-f]{64}, cost [\d.]+ ETH\)$/.test(l))).toBe(true);
  });

  it("payouts: the rails read again before each batch, so a hold raised after the first stops the second", async () => {
    const at = (n: string): Address => `0x${n.padStart(40, "0")}` as Address;
    const A: Hex = `0x${"ab".repeat(32)}`;
    const B: Hex = `0x${"cd".repeat(32)}`;
    const s = setup((w) => {
      w.door.canClose = false;
      queue(w, A, [{ user: at("a11c"), shares: TAO, assets: TAO }], 5_000n);
      queue(w, B, [{ user: at("b0b"), shares: TAO, assets: TAO }], 6_000n);
      // the monitor holds the keeper once the first payout is mined
      w.fate = (c) => {
        if (c.fn === "processPayouts") w.monitor.hold = ["vault.share_price_drop"];
        return "mine";
      };
    });
    expect(await handCommandV32(s.base("payouts"))).toBe(1);
    expect(s.w.sends.map((x) => x.fn)).toEqual(["processPayouts"]);
    expect(s.lines.filter((l) => l.startsWith("Not sent: HOLD: "))).toHaveLength(1);
    expect(s.w.monitor.statusReads).toBeGreaterThanOrEqual(2);
  });

  it("--without-lease: said loudly, no lease, the command's own journal", async () => {
    const s = setup((w) => {
      w.door.start = BigInt(w.time.base - 90_000);
    });
    expect(await handCommandV32(s.base("close", { withoutLease: "Cloudflare is down" }))).toBe(0);
    expect(s.r.st.calls).toEqual([]);
    expect(s.lines.slice(0, 3).every((l) => l.startsWith("WITHOUT THE LEASE: "))).toBe(true);
    expect(s.w.sends.map((x) => x.fn)).toEqual(["closeBatch"]);
  });

  it("a lease lost before the send: nothing is signed, LeaseLost", async () => {
    const s = setup((w) => {
      w.door.start = BigInt(w.time.base - 90_000);
    });
    // the founder breaks it from elsewhere as soon as it is taken
    const f = s.r.f;
    s.r.st.down = false;
    const broken = async (input: string | URL | Request, init?: RequestInit) => {
      const res = await f(input, init);
      const body = init?.body ? (JSON.parse(String(init.body)) as { action?: string }) : {};
      if (body.action === "acquire") {
        s.r.st.holder = "hand:someone-else";
        s.r.st.token++;
      }
      return res;
    };
    const control = make({ ...s.r, f: broken as typeof fetch }, s.lines);
    await expect(handCommandV32(s.base("close", { control }))).rejects.toBeInstanceOf(LeaseLost);
    expect(s.w.sends).toEqual([]);
  });

  it("run: a stuck claim is cancelled at its nonce, never sent again at a higher fee (T51 re-review R1: the hand run's replace passes the core's cancel on), written to the Worker's journal as its replacement", async () => {
    const s = setup((w) => {
      w.door.canClose = false;
      w.vault.hotkeys[0].credits = 2n * TAO;
      // nothing is mined: the claim, then its cancel, wait in the pool
      w.pooled = true;
      w.fate = () => "hold";
    });
    // the round's clock moves 20 minutes between its two rounds: the claim's watch is due its replacement in the second
    let t = Date.now();
    const runOptions = { maxTicks: 2, now: () => t, sleep: async () => void (t += 20 * 60_000) };
    expect(await handCommandV32(s.base("run", { runOptions }))).toBe(0);
    expect(s.w.sends.map((x) => [x.fn, x.gas])).toEqual([
      ["claimRewards", 57_000_000n],
      ["transfer", 21_000n],
    ]);
    expect(s.lines.some((l) => l.startsWith("REPLACING"))).toBe(false);
    expect(s.lines).toContainEqual(expect.stringMatching(/^CANCELLING transaction 0x[0-9a-f]{64} \(claiming the rewards on hotkey 0x11111111…, nonce 5\)/));
    const replaced = s.r.st.calls.filter((c) => c.path === "/v1/journal" && c.body.action === "replaced");
    expect(replaced).toHaveLength(1);
  });

  it("run: the core's rounds under the lease, the lease released when the run ends", async () => {
    const s = setup((w) => {
      w.door.start = BigInt(w.time.base - 90_000);
    });
    expect(await handCommandV32(s.base("run", { runOptions: { maxTicks: 1 } }))).toBe(0);
    expect(s.w.sends.map((x) => x.fn)).toEqual(["closeBatch"]);
    expect(s.r.st.calls.at(-1)?.body.action).toBe("release");
  });
});

/** One of Cascade's sends in CCIP FAILURE on lane `direction` (an honest attempt wrote it): its message */
function failing(w: World, direction: "Base → Bittensor" | "Bittensor → Base", n: bigint) {
  const toBittensor = direction === "Base → Bittensor";
  const payload = toBittensor ? { recipient: ADDR.vault, sender: ADDR.frontDoor, message: `0x0${n}` as Hex } : { recipient: ADDR.frontDoor, sender: ADDR.vault, message: `0x0${n}` as Hex };
  const msg = laneMessage(direction, payload, { amount: TAO, number: n });
  sendInWorld(w, direction, msg, payload, { block: 9_000n + n });
  failInWorld(w, direction, msg);
  return msg;
}

describe("pnpm ops reexec by hand (Task 52w: one of the one-shot commands, on handCommandV32)", () => {
  it("without --send it checks only: no lease taken, nothing signed or sent", async () => {
    let id: Hex = "0x";
    const s = setup((w) => {
      w.door.canClose = false;
      id = failing(w, "Base → Bittensor", 1n).id;
    });
    expect(await handCommandV32(s.base("reexec", { reexec: { id, send: false } }))).toBe(0);
    expect(s.r.st.calls).toEqual([]);
    expect(s.w.sends).toEqual([]);
    expect(s.lines[0]).toBe("Checking only (no --send): nothing is signed or sent, so the Worker's lease is not taken");
    expect(s.lines.at(-1)).toBe(`Nothing sent. To send it: pnpm ops reexec ${id.toLowerCase()} --live --send`);
  });

  it("with --send: under the lease, renewed before the send and written ahead to the Worker's journal, released; delivered", async () => {
    let id: Hex = "0x";
    const s = setup((w) => {
      w.door.canClose = false;
      id = failing(w, "Bittensor → Base", 2n).id;
    });
    expect(await handCommandV32(s.base("reexec", { reexec: { id, send: true } }))).toBe(0);
    expect(s.w.sends.map((x) => [x.fn, x.chain])).toEqual([["execute", "base"]]);
    const actions = s.r.st.calls.map((c) => (c.path === "/v1/lease" ? `lease:${c.body.action}` : c.path === "/v1/journal" ? `journal:${c.body.action}` : c.path));
    expect(actions[0]).toBe("lease:acquire");
    expect(actions.lastIndexOf("lease:renew")).toBeLessThan(actions.indexOf("journal:writeAhead"));
    expect(actions.at(-1)).toBe("lease:release");
    expect(s.r.st.journal.map((x) => [x.request.functionName, x.status])).toEqual([["execute", "landed"]]);
    expect(s.lines.at(-1)).toMatch(new RegExp(`^Done \\(transaction 0x[0-9a-f]{64}\\): bridge message ${id.toLowerCase()} is delivered\\.$`));
    expect(s.w.messageStates[id.toLowerCase()]).toBe(2);
  });

  it("with --send and no lease to be had: refused before anything is signed (the one-shot rules: the lease, or --without-lease)", async () => {
    let id: Hex = "0x";
    const s = setup((w) => {
      id = failing(w, "Base → Bittensor", 3n).id;
    });
    s.r.st.down = true;
    await expect(handCommandV32(s.base("reexec", { reexec: { id, send: true } }))).rejects.toThrow(/can't be reached/);
    expect(s.w.sends).toEqual([]);
    const without = await handCommandV32(s.base("reexec", { reexec: { id, send: true }, withoutLease: "Cloudflare is down" }));
    expect(without).toBe(0);
    expect(s.lines.filter((l) => l.startsWith("WITHOUT THE LEASE: "))).toHaveLength(3);
    expect(s.w.sends.map((x) => x.fn)).toEqual(["execute"]);
  });
});

describe("the hand close and payouts warn when their lane has an open CCIP FAILURE of Cascade's (Task 52w): the operator decides, and is told", () => {
  it("close: the warning names the message, its lane and the hand command, before the close, which goes", async () => {
    let id: Hex = "0x";
    const s = setup((w) => {
      w.door.start = BigInt(w.time.base - 90_000);
      id = failing(w, "Base → Bittensor", 1n).id;
      // one on the other lane: not this command's
      failing(w, "Bittensor → Base", 2n);
    });
    expect(await handCommandV32(s.base("close"))).toBe(0);
    expect(s.w.sends.map((x) => x.fn)).toEqual(["closeBatch"]);
    const warnings = s.lines.filter((l) => l.startsWith("WARNING:"));
    expect(warnings).toEqual([
      `WARNING: bridge message ${id.toLowerCase()} (Base → Bittensor) is in CCIP FAILURE on Bittensor's OffRamp. The keeper's own rounds send no close on this lane while it is open; this command sends anyway, because you ran it. Check it with: pnpm ops reexec ${id.toLowerCase()} --live`,
    ]);
    expect(s.lines.indexOf(warnings[0])).toBeLessThan(s.lines.findIndex((l) => l.startsWith("Done (transaction")));
  });

  it("payouts: the same toward Base; none when the lane's messages are delivered", async () => {
    const at = (n: string): Address => `0x${n.padStart(40, "0")}` as Address;
    let id: Hex = "0x";
    const s = setup((w) => {
      w.door.canClose = false;
      queue(w, `0x${"ab".repeat(32)}`, [{ user: at("a11c"), shares: TAO, assets: TAO }], 5_000n);
      id = failing(w, "Bittensor → Base", 2n).id;
    });
    expect(await handCommandV32(s.base("payouts"))).toBe(0);
    expect(s.w.sends.map((x) => x.fn)).toEqual(["processPayouts"]);
    expect(s.lines.filter((l) => l.startsWith("WARNING:"))).toEqual([
      `WARNING: bridge message ${id.toLowerCase()} (Bittensor → Base) is in CCIP FAILURE on Base's OffRamp. The keeper's own rounds send no payout on this lane while it is open; this command sends anyway, because you ran it. Check it with: pnpm ops reexec ${id.toLowerCase()} --live`,
    ]);
    const q = setup((w) => {
      w.door.start = BigInt(w.time.base - 90_000);
      const m = failing(w, "Base → Bittensor", 1n);
      w.messageStates[m.id.toLowerCase()] = 2;
    });
    expect(await handCommandV32(q.base("close"))).toBe(0);
    expect(q.lines.filter((l) => l.startsWith("WARNING:"))).toEqual([]);
  });
});

describe("Task 53's one-shots by hand (claim, adopt, add-hotkey, remove-hotkey, park), on handCommandV32: they check first and take the lease only to send", () => {
  const HK_NEW: Hex = `0x${"5e".repeat(32)}`;
  it("without --send: checked and simulated, no lease taken, nothing signed or sent", async () => {
    const s = setup((w) => {
      w.door.canClose = false;
    });
    expect(await handCommandV32(s.base("add-hotkey", { oneShot: { hotkey: HK_NEW, send: false } }))).toBe(0);
    expect(s.r.st.calls).toEqual([]);
    expect(s.w.sends).toEqual([]);
    expect(s.lines[0]).toBe("Checking only (no --send): nothing is signed or sent, so the Worker's lease is not taken");
    expect(s.lines.at(-1)).toBe(`Nothing sent. To send it: pnpm ops add-hotkey ${HK_NEW} --live --send`);
  });

  it("with --send: under the lease, renewed before the send and written ahead to the Worker's journal, then released", async () => {
    const s = setup((w) => {
      w.door.canClose = false;
      w.vault.hotkeys[0].credits = 2n * TAO;
    });
    expect(await handCommandV32(s.base("claim", { oneShot: { send: true } }))).toBe(0);
    expect(s.w.sends.map((x) => [x.fn, x.gas])).toEqual([["claimRewards", 57_000_000n]]);
    const actions = s.r.st.calls.map((c) => (c.path === "/v1/lease" ? `lease:${c.body.action}` : c.path === "/v1/journal" ? `journal:${c.body.action}` : c.path));
    expect(actions[0]).toBe("lease:acquire");
    expect(actions.lastIndexOf("lease:renew")).toBeLessThan(actions.indexOf("journal:writeAhead"));
    expect(actions.at(-1)).toBe("lease:release");
    expect(s.r.st.journal.map((x) => [x.request.functionName, x.status])).toEqual([["claimRewards", "landed"]]);
  });

  it("with --send and no lease to be had: refused before anything is signed; --without-lease said loudly, and sent", async () => {
    const s = setup((w) => {
      w.door.canClose = false;
      w.vault.hotkeys.push({ hotkey: HK_NEW, stakeRao: 0n, credits: 0n, lastClaimAt: BigInt(T) });
      w.vault.hotkeyCount = 3;
    });
    s.r.st.down = true;
    await expect(handCommandV32(s.base("remove-hotkey", { oneShot: { hotkey: HK_NEW, send: true } }))).rejects.toThrow(/can't be reached/);
    expect(s.w.sends).toEqual([]);
    expect(await handCommandV32(s.base("remove-hotkey", { oneShot: { hotkey: HK_NEW, send: true }, withoutLease: "Cloudflare is down" }))).toBe(0);
    expect(s.lines.filter((l) => l.startsWith("WITHOUT THE LEASE: "))).toHaveLength(3);
    expect(s.w.sends.map((x) => [x.fn, ...x.args.map(String)])).toEqual([["removeHotkey", HK_NEW, "false"]]);
  });

  it("a lease lost before the send: nothing is signed (LeaseLost), as for every hand send", async () => {
    const s = setup((w) => {
      w.door.canClose = false;
      w.vault.surplusStakeRao = 5_000_000n;
    });
    const f = s.r.f;
    const broken = async (input: string | URL | Request, init?: RequestInit) => {
      const res = await f(input, init);
      const body = init?.body ? (JSON.parse(String(init.body)) as { action?: string }) : {};
      if (body.action === "acquire") {
        s.r.st.holder = "hand:someone-else";
        s.r.st.token++;
      }
      return res;
    };
    const control = make({ ...s.r, f: broken as typeof fetch }, s.lines);
    await expect(handCommandV32(s.base("adopt", { oneShot: { send: true }, control }))).rejects.toBeInstanceOf(LeaseLost);
    expect(s.w.sends).toEqual([]);
  });
});

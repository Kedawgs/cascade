import { type Address, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { encodeBatch } from "../src/keeper/core/batch.ts";
import { freshMemory } from "../src/keeper/core/memory.ts";
import { payoutsHash } from "../src/keeper/core/payouts.ts";
import { targetV32 } from "../src/keeper/core/v32/actions.ts";
import { addHotkeyByHand, adoptByHand, claimByHand, parkByHand, removeHotkeyByHand } from "../src/keeper/core/v32/hand.ts";
import { ADDR, CREATED, deploymentFor, depsFor, HK_SECOND, HK_STAKE, parkInWorld, RAO, T, TAO, type World, world } from "./keeper-v32-world.ts";

// Task 53's hand one-shots on the v3.2 core (core/v32/hand.ts): claim, adopt, add-hotkey, remove-hotkey and park. Each
// checks what the keeper's round would, simulates its call and says so; it sends only with --send (`send`), through the
// one send path (the rails read now refuse it under a hold); its words name the record as the command does (--live).
// The lease is lease-client.ts's, tested with the Worker's routes (keeper/test/node/hand-v32.test.ts). On fake chains.

const d = deploymentFor();
const t = targetV32(d);
const POLICY = { claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 };
const HK_NEW: Hex = `0x${"5e".repeat(32)}`;
const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const lower = (a: string) => a.toLowerCase();

function quiet(): World {
  const w = world();
  w.door.canClose = false;
  return w;
}

/** One one-shot on `w`: what it returned, said and sent. */
async function shot(w: World, f: (deps: ReturnType<typeof depsFor>["deps"]) => Promise<number>) {
  const lines: string[] = [];
  const { deps } = depsFor(w, freshMemory(), d, (l) => lines.push(l));
  const before = w.sends.length;
  const code = await f(deps);
  return { code, lines, sent: w.sends.slice(before).map((s) => `${s.fn}${s.args.length ? ` ${s.args.map(String).join(" ")}` : ""}`) };
}

describe("pnpm ops claim (v3.2, Task 53)", () => {
  it("checks each listed hotkey by the claim policy and simulates the claim; only --send sends it, through the one send path", async () => {
    const w = quiet();
    w.vault.hotkeys[0].credits = 2n * TAO;
    const dry = await shot(w, (deps) => claimByHand(deps, t, freshMemory(), { send: false, live: true, policy: POLICY, now: T * 1000 }));
    expect(dry.code).toBe(0);
    expect(dry.sent).toEqual([]);
    expect(dry.lines[0]).toMatch(new RegExp(`^Rewards on hotkey ${HK_STAKE}: 2 TAO wait; a claim is due \\(`));
    // R6b: a hotkey with nothing waiting on it has nothing to claim, whatever the round
    expect(dry.lines).toContain(`Rewards on hotkey ${HK_SECOND}: 0 TAO wait; no claim due (τ0 is waiting: nothing to claim)`);
    expect(dry.lines).toContainEqual(`Checked: the claim on hotkey ${HK_STAKE} (a 57,000,000 gas limit, 0.057 TAO up front at most): its simulation passes.`);
    expect(dry.lines.at(-1)).toBe(`Nothing sent. To send it: pnpm ops claim ${HK_STAKE} --live --send`);
    const sent = await shot(w, (deps) => claimByHand(deps, t, freshMemory(), { send: true, live: true, policy: POLICY, now: T * 1000 }));
    expect([sent.code, sent.sent]).toEqual([0, [`claimRewards ${HK_STAKE}`]]);
    expect(sent.lines.at(-1)).toMatch(/^Done \(transaction 0x[0-9a-f]{64}, cost [\d.]+ TAO\)$/);
  });

  it("refuses: nothing due, a hotkey not listed, the buffer rule (the root hold set and a payout due), and the rails' hold", async () => {
    const none = await shot(quiet(), (deps) => claimByHand(deps, t, freshMemory(), { send: true, live: false, policy: POLICY }));
    expect([none.code, none.sent, none.lines.at(-1)]).toEqual([1, [], "Not sent: no claim is due by the claim policy"]);
    const stranger = await shot(quiet(), (deps) => claimByHand(deps, t, freshMemory(), { hotkey: HK_NEW, send: true, live: false, policy: POLICY }));
    expect(stranger.lines.at(-1)).toBe(`Not sent: hotkey ${HK_NEW} is not listed on the vault`);
    // the buffer rule: a claim stamps the pair it claims on, so none while the root hold is set and a payout is due
    const w = quiet();
    w.vault.hotkeys[0].credits = 2n * TAO;
    w.rootHold = 7_200n;
    const key = `0x${"ab".repeat(32)}` as Hex;
    const list = [{ user: at("a11c"), shares: TAO, assets: TAO }];
    w.vault.batches[key] = { sourceChain: 8453n, frontDoor: ADDR.frontDoor, batchId: 7n, queuedAt: BigInt(T - 2 * 86_400), cursor: 0, count: 1, chunk: 0, remaining: TAO, payoutsHash: payoutsHash(list) };
    w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "PayoutBatchQueued", args: { key, sourceChain: 8453n, batchId: 7n, count: 1, total: TAO, price: 10n ** 12n }, block: 5_050n });
    const held = await shot(w, (deps) => claimByHand(deps, t, freshMemory(), { send: true, live: true, policy: POLICY }));
    expect([held.code, held.sent]).toEqual([1, []]);
    expect(held.lines.at(-1)).toBe(
      "Not sent: claims wait while a payout is due: Bittensor holds root stake 7200 blocks (about 24 hours) after each add, remove or claim on a hotkey (RootStakeUnlockInterval), and a claim stamps the pair it claims on (the buffer rule); pay the batch out first (pnpm ops payouts --live)",
    );
    // the monitor's hold: checked, simulated, never sent
    const h = quiet();
    h.vault.hotkeys[0].credits = 2n * TAO;
    h.monitor.hold = ["vault.share_price_drop"];
    const hold = await shot(h, (deps) => claimByHand(deps, t, freshMemory(), { send: true, live: true, policy: POLICY, now: T * 1000 }));
    expect([hold.code, hold.sent]).toEqual([1, []]);
    expect(hold.lines.at(-1)).toMatch(/^Not sent: HOLD: /);
  });
});

describe("pnpm ops adopt (v3.2, Task 53)", () => {
  it("a surplus at least the chain's minimum, a day after the last adoption: checked, then adopted with --send; none: refused", async () => {
    const w = quiet();
    w.vault.surplusStakeRao = 5_000_000n;
    w.vault.lastAdoptAt = BigInt(CREATED);
    const dry = await shot(w, (deps) => adoptByHand(deps, t, freshMemory(), { send: false, live: false }));
    expect([dry.code, dry.sent, dry.lines.at(-1)]).toEqual([0, [], "Nothing sent. To send it: pnpm ops adopt --send"]);
    const sent = await shot(w, (deps) => adoptByHand(deps, t, freshMemory(), { send: true, live: false, now: T * 1000 }));
    expect([sent.code, sent.sent]).toEqual([0, ["adoptStake"]]);
    const none = await shot(quiet(), (deps) => adoptByHand(deps, t, freshMemory(), { send: true, live: false }));
    expect([none.code, none.sent, none.lines.at(-1)]).toEqual([1, [], "Not sent: there is no surplus to adopt now"]);
  });
});

describe("pnpm ops add-hotkey and remove-hotkey (v3.2, Task 53: the keeper's own)", () => {
  it("add-hotkey: checked and simulated, listed with --send; refused when listed already or the set is full", async () => {
    const w = quiet();
    w.vault.offList[HK_NEW] = (45n * TAO) / RAO;
    const dry = await shot(w, (deps) => addHotkeyByHand(deps, t, freshMemory(), { hotkey: HK_NEW, send: false, live: true }));
    expect([dry.code, dry.sent]).toEqual([0, []]);
    expect(dry.lines).toContainEqual(`Checked: listing hotkey ${HK_NEW} (addHotkey, as the keeper): its simulation passes.`);
    expect(dry.lines.at(-1)).toBe(`Nothing sent. To send it: pnpm ops add-hotkey ${HK_NEW} --live --send`);
    const sent = await shot(w, (deps) => addHotkeyByHand(deps, t, freshMemory(), { hotkey: HK_NEW, send: true, live: true, now: T * 1000 }));
    expect([sent.code, sent.sent]).toEqual([0, [`addHotkey ${HK_NEW}`]]);
    expect(sent.lines).toContainEqual(`Hotkey ${HK_NEW} listed on the vault (addHotkey)`);
    const again = await shot(w, (deps) => addHotkeyByHand(deps, t, freshMemory(), { hotkey: HK_NEW, send: true, live: true }));
    expect(again.lines.at(-1)).toBe(`Not sent: hotkey ${HK_NEW} is listed already`);
    w.vault.hotkeys.push({ hotkey: `0x${"77".repeat(32)}`, stakeRao: 0n, credits: 0n, lastClaimAt: BigInt(T) });
    w.vault.hotkeyCount = 4;
    const full = await shot(w, (deps) => addHotkeyByHand(deps, t, freshMemory(), { hotkey: `0x${"78".repeat(32)}`, send: true, live: true }));
    expect(full.lines.at(-1)).toBe("Not sent: the vault's set of hotkeys is full (4): a slot is freed first (pnpm ops remove-hotkey <hotkey> --live --send, or the owner's)");
    // the vault's own refusal (the reserved last slot), named by the simulation
    const v = quiet();
    v.simulate = (c) => (c.fn === "addHotkey" ? { error: "SlotReserved" } : 200_000n);
    const reserved = await shot(v, (deps) => addHotkeyByHand(deps, t, freshMemory(), { hotkey: HK_NEW, send: true, live: true }));
    expect([reserved.code, reserved.sent]).toEqual([1, []]);
    expect(reserved.lines.at(-1)).toMatch(/^Not sent: listing hotkey 0x5e.* would revert now \(.*SlotReserved/);
  });

  it("R6b (U9): remove-hotkey refuses while Bittensor still owes the vault deferred rewards on the hotkey above the dust allowance (the unclaimed read leaves them out), or they can't be read; sends once they are paid", async () => {
    const w = quiet();
    w.vault.hotkeys.push({ hotkey: HK_NEW, stakeRao: 0n, credits: 0n, lastClaimAt: BigInt(T) });
    w.vault.hotkeyCount = 3;
    // 0.002 subnet alpha still owed on it: a debt of -2,000,000 rao (an I64F64) in DeferredBasketDebts(hotkey, the vault)
    w.deferred[lower(HK_NEW)] = { alphaDebtRao: -2_000_000n };
    const owed = await shot(w, (deps) => removeHotkeyByHand(deps, t, freshMemory(), { hotkey: HK_NEW, send: true, live: true }));
    expect([owed.code, owed.sent]).toEqual([1, []]);
    expect(owed.lines.at(-1)).toBe(
      `Not sent: Bittensor still owes the vault deferred rewards on hotkey ${HK_NEW} (2,000,000 rao of subnet alpha and 0 rao of TAO, which the unclaimed-rewards read leaves out), more than the 1,000,000 rao dust allowance: a removal now would strand them. A claim pays them once they convert (its credits then show, and the keeper claims them); remove it after. To give them up instead, the owner's pnpm ops remove-hotkey ${HK_NEW} --as owner --forfeit --for-wallet --live`,
    );
    // the precompile not there (an anvil fork): unread, refused
    w.rootHold = "absent";
    const unread = await shot(w, (deps) => removeHotkeyByHand(deps, t, freshMemory(), { hotkey: HK_NEW, send: true, live: true }));
    expect(unread.lines.at(-1)).toMatch(/^Not sent: the vault's deferred rewards on hotkey 0x5e.* can't be read now \(the storage-query precompile answered nothing for the block number/);
    // paid: within the dust allowance, it goes
    w.rootHold = 0n;
    w.deferred[lower(HK_NEW)] = { alphaDebtRao: -999_999n };
    const paid = await shot(w, (deps) => removeHotkeyByHand(deps, t, freshMemory(), { hotkey: HK_NEW, send: true, live: true, now: T * 1000 }));
    expect([paid.code, paid.sent]).toEqual([0, [`removeHotkey ${HK_NEW} false`]]);
  });

  it("remove-hotkey: only an empty hotkey that is not the stake hotkey and has no credits; removeHotkey(h, false) with --send", async () => {
    const w = quiet();
    w.vault.hotkeys.push({ hotkey: HK_NEW, stakeRao: 0n, credits: 0n, lastClaimAt: BigInt(T) });
    w.vault.hotkeyCount = 3;
    const dry = await shot(w, (deps) => removeHotkeyByHand(deps, t, freshMemory(), { hotkey: HK_NEW, send: false, live: true }));
    expect([dry.code, dry.sent, dry.lines.at(-1)]).toEqual([0, [], `Nothing sent. To send it: pnpm ops remove-hotkey ${HK_NEW} --live --send`]);
    const sent = await shot(w, (deps) => removeHotkeyByHand(deps, t, freshMemory(), { hotkey: HK_NEW, send: true, live: true, now: T * 1000 }));
    expect([sent.code, sent.sent]).toEqual([0, [`removeHotkey ${HK_NEW} false`]]);
    const refusals: [Hex, (w: World) => void, string][] = [
      [HK_STAKE, () => undefined, `hotkey ${HK_STAKE} is the stake hotkey: the owner's setStakeHotkey to another listed hotkey comes first`],
      [HK_SECOND, () => undefined, `hotkey ${HK_SECOND} holds 5 TAO of the vault's stake: only the owner's removeHotkey moves it (pnpm ops remove-hotkey ${HK_SECOND} --as owner --for-wallet --live)`],
      [HK_SECOND, (x) => void ((x.vault.hotkeys[1].stakeRao = 0n), (x.vault.hotkeys[1].credits = TAO / 10n)), `0.1 TAO of credits wait on hotkey ${HK_SECOND}: claim them first (pnpm ops claim ${HK_SECOND} --live --send), and remove it once they read 0`],
      [HK_NEW, () => undefined, `hotkey ${HK_NEW} is not listed: there is nothing to free`],
    ];
    for (const [hk, set, why] of refusals) {
      const x = quiet();
      set(x);
      const r = await shot(x, (deps) => removeHotkeyByHand(deps, t, freshMemory(), { hotkey: hk, send: true, live: true }));
      expect([r.code, r.sent, r.lines.at(-1)], why).toEqual([1, [], `Not sent: ${why}`]);
    }
  });
});

describe("pnpm ops park (v3.2, Task 53)", () => {
  const ours = (id: bigint) => ({ recipient: ADDR.vault, sender: ADDR.frontDoor, message: encodeBatch(id, [{ user: at("de01"), amount: TAO }], []) });

  it("says each park of Cascade's that is due a job, as the park job reads them; with its key and --send, that park's job", async () => {
    const w = quiet();
    // a park 15 days old whose delivery would fail (the floor raised): due its refund
    const p = parkInWorld(w, ours(41n), { parkedAt: BigInt(T - 15 * 86_400) });
    w.parkSim = () => "BelowConversionFloor";
    const list = await shot(w, (deps) => parkByHand(deps, t, freshMemory(), { send: false, live: true, now: T * 1000 }));
    expect([list.code, list.sent]).toEqual([0, []]);
    expect(list.lines).toContainEqual(expect.stringMatching(new RegExp(`^Park ${p.key}: refund due: park 0x[0-9a-f]{8}… is 14 days old: refunded to its door on Base \\(bridge fee 0\\.004 TAO\\)$`)));
    const dry = await shot(w, (deps) => parkByHand(deps, t, freshMemory(), { key: p.key, send: false, live: true, now: T * 1000 }));
    expect([dry.code, dry.sent, dry.lines.at(-1)]).toEqual([0, [], `Nothing sent. To send it: pnpm ops park ${p.key} --live --send`]);
    const sent = await shot(w, (deps) => parkByHand(deps, t, freshMemory(), { key: p.key, send: true, live: true, now: T * 1000 }));
    expect(sent.code).toBe(0);
    expect(sent.sent.map((x) => x.split(" ")[0])).toEqual(["refundParked"]);
  });

  it("nothing due: said; a key that is due nothing, or --send with no key, is refused; under a hold nothing but a notice's conversion goes", async () => {
    const empty = await shot(quiet(), (deps) => parkByHand(deps, t, freshMemory(), { send: false, live: true, now: T * 1000 }));
    expect([empty.code, empty.lines.at(-1)]).toEqual([1, "No park of Cascade's is due a job now."]);
    const w = quiet();
    const young = parkInWorld(w, ours(42n));
    w.parkSim = () => "BelowConversionFloor";
    const notDue = await shot(w, (deps) => parkByHand(deps, t, freshMemory(), { key: young.key, send: true, live: true, now: T * 1000 }));
    expect([notDue.code, notDue.sent, notDue.lines.at(-1)]).toEqual([1, [], `Not sent: park ${young.key} is due no job now (see above)`]);
    // under a hold, ForeverMoney's notice running: the token park's conversion goes, and only it
    const h = quiet();
    const tok = parkInWorld(h, ours(43n));
    h.alpha.migrationReadyAt = BigInt(T + 6 * 86_400);
    h.monitor.hold = ["vault.share_price_drop"];
    const conv = await shot(h, (deps) => parkByHand(deps, t, freshMemory(), { key: tok.key, send: true, live: true, now: T * 1000 }));
    expect(conv.lines).toContainEqual(expect.stringMatching(new RegExp(`^Park ${tok.key}: convert \\(deliverParked during the notice\\) due: `)));
    expect([conv.code, conv.sent.map((x) => x.split(" ")[0])]).toEqual([0, ["deliverParked"]]);
  });
});

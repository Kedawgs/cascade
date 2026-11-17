import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AbiFunction, type Address, getAddress, type Hex, parseAbi, parseEther, parseTransaction } from "viem";
import { describe, expect, it } from "vitest";
import { CLAIM_POLICY } from "../src/config.ts";
import { act, type KeeperState, launchTarget } from "../src/keeper/actions.ts";
import { CLAIM_SOURCE } from "../src/keeper/core/abi.ts";
import { decideNext, type State } from "../src/keeper/core/due.ts";
import type { SendRefused } from "../src/keeper/core/errors.ts";
import { classifyFailure, HeldRefusal, KeeperNotReady, Waits } from "../src/keeper/core/failures.ts";
import { memoryJournal, spentOf } from "../src/keeper/core/journal.ts";
import { encodeMemory, freshMemory, type KeeperMemory, loadMemory } from "../src/keeper/core/memory.ts";
import { type Payout, payoutsHash } from "../src/keeper/core/payouts.ts";
import {
  adoptionDue,
  beingFreed,
  CLAIM_GAS_REQUIRED_MAX,
  CLAIM_LEAD_S,
  CLAIM_ROUND_SLACK_S,
  claimCeilingProblem,
  claimFor,
  claimGasLimit,
  type HotkeyRead,
  type RewardsRead,
  slotFreeable,
  STAKE_RAMP_S,
} from "../src/keeper/core/rewards.ts";
import { MAX_HOTKEYS } from "../src/keeper/core/v32/payout.ts";
import { BITTENSOR_TX_GAS_CEILING } from "../src/keeper/core/ceiling.ts";
import { SPEND_CAP_DEFAULT } from "../src/keeper/deployment-v32.ts";
import { KNOWN_ABI } from "../src/wallet.ts";
import { claimFitProblem, DAY_OF_SENDS_GAS } from "../src/keeper/core/v32/claims.ts";
import { memoryJournal as journalOf } from "../src/keeper/core/journal.ts";
import { LATE_RECEIPT_MS, REPLACE_AFTER_MS, runRound } from "../src/keeper/core/round.ts";
import { adoptV32, claimRevertedLateV32, claimV32, LATE_CLAIM_SLACK_MS, targetV32 } from "../src/keeper/core/v32/actions.ts";
import { unsettledOnBittensor } from "../src/keeper/core/v32/claims.ts";
import { addressMapping } from "../src/keeper/core/v32/readiness.ts";
import type { StatusDetail } from "../src/keeper/status.ts";
import { SENT, stubDeps, v3Record } from "./fake-keeper.ts";
import { ADDR, deploymentFor, depsFor, HK_SECOND, HK_STAKE, KEY, marketOf, RAO, revertWith, T, TAO, type World, world } from "./keeper-v32-world.ts";

// Task 51 on the v3.2 core: claims on every listed hotkey (the standby included once listed), each by the claim policy,
// read from one claim source; a hotkey being freed claimed until its credits read 0 (preflight A17, over the plan's
// noClaimOnAHotkeyBeingFreed); the adoption of a surplus, at most once per STAKE_RAMP by the chain's own clock; the round
// order (payouts, then stake or unstake, then claims: spec §3.8), across invocations too; the rails, readiness and the
// spend cap apply to both; v3-launch's run never claims. On fake chains.

const lower = (a: string) => a.toLowerCase();
const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const HK_STANDBY: Hex = `0x${"40".repeat(32)}`;
const HK_OLD: Hex = `0x${"33".repeat(32)}`;
const KEY_A: Hex = `0x${"ab".repeat(32)}`;
const ALICE = at("a11c");
const COLDKEY = addressMapping(ADDR.vault);
const POLICY = { claimCostTao: 57n * 10n ** 15n, claimMultiple: 25n, monthlyClaimMaxUsd: 20 };
const OPTS = { intervalMs: 60_000, policy: POLICY, rewardsEveryTicks: 1 };
const d = deploymentFor();
const t = targetV32(d);
const src = (path: string) => readFileSync(new URL(`../../contracts/src/${path}`, import.meta.url), "utf8");

/** The vault's listed hotkeys, as given; the stake hotkey the first unless `stake` says otherwise. */
function listed(w: World, hks: { hotkey: Hex; stakeRao?: bigint; credits?: bigint; lastClaimAt?: bigint }[], stake: Hex = hks[0].hotkey) {
  w.vault.hotkeys = hks.map((h) => ({ hotkey: h.hotkey, stakeRao: h.stakeRao ?? 0n, credits: h.credits ?? 0n, lastClaimAt: h.lastClaimAt ?? BigInt(T - 86_400) }));
  w.vault.hotkeyCount = hks.length;
  w.vault.stakeHotkey = stake;
}

/** A world where nothing is due but what a test adds: the batch can't close, no idle TAO, no payout. */
function quiet(): World {
  const w = world();
  w.door.canClose = false;
  return w;
}

/** A stake hotkey 2 TAO of rewards wait on (over 25 times the 0.057 TAO a claim costs) and a second, quiet one. */
const dueOnStake = (w: World) =>
  listed(w, [
    { hotkey: HK_STAKE, stakeRao: (45n * TAO) / RAO, credits: 2n * TAO },
    { hotkey: HK_SECOND, stakeRao: (5n * TAO) / RAO },
  ]);

/** A payout batch due in the world, its list's logs and its queue (as keeper-v32-rails.test.ts's queue). */
function queue(w: World, key: Hex, list: Payout[], block = 5_000n) {
  list.forEach((p, i) => w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "Redeemed", args: { key, user: p.user, shares: p.shares, assets: p.assets }, block: block + BigInt(i) }));
  const total = list.reduce((x, p) => x + p.assets, 0n);
  w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "PayoutBatchQueued", args: { key, sourceChain: 8453n, batchId: 7n, count: list.length, total, price: 10n ** 12n }, block: block + 50n });
  w.vault.batches[key.toLowerCase()] = {
    sourceChain: 8453n,
    frontDoor: ADDR.frontDoor,
    batchId: 7n,
    queuedAt: BigInt(T - 2 * 86_400),
    cursor: 0,
    count: list.length,
    chunk: 0,
    remaining: total,
    payoutsHash: payoutsHash(list),
  };
  w.vault.pending += total;
}

/** `n` rounds a minute apart from `from` (s), each its own invocation: its deps built afresh, its memory loaded from the
 * JSON the last one saved (`saved`, else a fresh one), one journal across them (the Worker's lives in its Durable
 * Object). What each round sent, by function. */
async function rounds(
  w: World,
  n: number,
  o: { saved?: string; journal?: ReturnType<typeof memoryJournal>; from?: number; dep?: typeof d; between?: (i: number) => void; allowStop?: boolean } = {},
) {
  const lines: string[] = [];
  const journal = o.journal ?? memoryJournal();
  let saved = o.saved ?? encodeMemory(freshMemory());
  const sent: string[][] = [];
  const dep = o.dep ?? d;
  let memory: KeeperMemory = freshMemory();
  for (let i = 0; i < n; i++) {
    o.between?.(i);
    memory = loadMemory(saved).memory;
    const now = ((o.from ?? T) + i * 60) * 1000;
    const before = w.sends.length;
    const r = await runRound(depsFor(w, memory, dep, (l) => lines.push(l), { journal }).deps, targetV32(dep), memory, { ...OPTS, now: () => now });
    if (!o.allowStop) expect(r.end, `round ${i + 1}: ${lines.at(-1)}`).toBeUndefined();
    sent.push(w.sends.slice(before).map((s) => (s.fn === "claimRewards" ? `claimRewards ${String(s.args[0]).slice(0, 4)}` : s.fn)));
    saved = encodeMemory(r.memory);
  }
  return { lines, saved, memory, journal, sent };
}

describe("claims on every listed hotkey, by the claim policy (plan Task 51)", () => {
  it("claimsEachListedHotkeySeparately: getUnclaimedRootTaoByHotkey(the vault's coldkey, h) for every listed hotkey, each claimed on its own by the policy, one a round; RootClaimable never read", async () => {
    const w = quiet();
    listed(w, [
      { hotkey: HK_STAKE, stakeRao: (45n * TAO) / RAO, credits: 2n * TAO },
      { hotkey: HK_STANDBY, stakeRao: (5n * TAO) / RAO, credits: (3n * TAO) / 2n },
      // half a TAO: under 25 × 0.057, and its last claim a day ago (the monthly claim comes after 30 days)
      { hotkey: HK_SECOND, stakeRao: TAO / RAO, credits: TAO / 2n },
    ]);
    const r = await rounds(w, 3);
    expect(r.sent).toEqual([["claimRewards 0x11"], ["claimRewards 0x40"], []]);
    for (const s of w.sends) expect([s.chain, lower(s.to), s.gas]).toEqual(["bittensor", lower(ADDR.vault), 57_000_000n]);
    // every listed hotkey's credits, from the claim source, for the vault's own coldkey
    expect(new Set(w.creditReads.map((x) => `${lower(x.coldkey)}:${x.hotkey}`))).toEqual(new Set([HK_STAKE, HK_STANDBY, HK_SECOND].map((h) => `${lower(COLDKEY)}:${h}`)));
    // the staking precompile is asked the claim source, each hotkey's stake and the for-life flag: never RootClaimable
    const asked = new Set(w.calls.filter((c) => lower(c.to) === lower(ADDR.staking)).map((c) => c.fn));
    for (const fn of asked) expect(["getUnclaimedRootTaoByHotkey", "getStake", "getRejectStakingHotkeyGrowth"], fn).toContain(fn);
    // each hotkey's decision is said once, when it changes
    expect(r.lines.filter((l) => l.startsWith("Rewards on hotkey 0x22222222…: no claim due (τ0.5 is waiting, below 25×"))).toHaveLength(1);
    expect(r.lines.filter((l) => l.startsWith("Rewards on hotkey 0x11111111…: a claim is due ("))).toHaveLength(1);
  });

  it("Task 65: a claim's gas limit is claimGasRequired plus the margin, held to Bittensor's per-transaction ceiling (64,900,000): at the vault's top, 63.4M, it goes at the ceiling", async () => {
    expect(claimGasLimit(55_000_000n)).toBe(57_000_000n);
    expect(claimGasLimit(62_900_000n)).toBe(64_900_000n);
    expect(claimGasLimit(CLAIM_GAS_REQUIRED_MAX)).toBe(BITTENSOR_TX_GAS_CEILING);
    expect(claimGasLimit(73_500_000n)).toBe(BITTENSOR_TX_GAS_CEILING);
    // in a round, the vault's claimGasRequired at its top: the claim is sent with the ceiling, 1,500,000 over the setting
    const w = quiet();
    dueOnStake(w);
    w.answers[`${lower(ADDR.vaultLens)}:claimGasRequired`] = () => CLAIM_GAS_REQUIRED_MAX;
    const r = await rounds(w, 1, { dep: deploymentFor({ spendCap: { base: 10n ** 18n, bittensor: TAO } }) });
    expect(r.sent).toEqual([["claimRewards 0x11"]]);
    expect(w.sends[0].gas).toBe(64_900_000n);
  });

  it("Task 65: a claim whose claimGasRequired and the claim's own work (500,000 allowed) can't fit under the ceiling is refused with a clear line, never sent", async () => {
    // at the ceiling now: 64,400,000 and the allowance fit exactly; one gas more does not
    expect(claimCeilingProblem(CLAIM_GAS_REQUIRED_MAX)).toBeUndefined();
    expect(claimCeilingProblem(64_400_000n)).toBeUndefined();
    expect(claimCeilingProblem(64_400_001n)).toBe(
      "the vault's claimGasRequired (64,400,001) and the claim's own work outside the precompile call (500,000 allowed) need more than Bittensor's per-transaction gas ceiling (64,900,000): no transaction can carry the claim; the owner lowers claimGasRequired (setClaimGasRequired, at once) to at most 63,400,000",
    );
    // a lower ceiling (should the runtime's limit fall) refuses what fits today
    expect(claimCeilingProblem(CLAIM_GAS_REQUIRED_MAX, 63_000_000n)).toMatch(/need more than Bittensor's per-transaction gas ceiling \(63,000,000\): .* to at most 62,500,000$/);
    // the cap check says it first, at readiness and before each claim
    expect(claimFitProblem(TAO, 64_400_001n, 10n ** 9n)).toMatch(/^the vault's claimGasRequired \(64,400,001\) .* to at most 63,400,000$/);
    const w = quiet();
    dueOnStake(w);
    w.answers[`${lower(ADDR.vaultLens)}:claimGasRequired`] = () => 64_500_000n;
    const r = await rounds(w, 2, { dep: deploymentFor({ spendCap: { base: 10n ** 18n, bittensor: TAO } }) });
    expect(r.sent.flat().filter((f) => f.startsWith("claim"))).toEqual([]);
    expect(r.lines.filter((l) => l.startsWith("CLAIMS CAN'T FIT: the vault's claimGasRequired (64,500,000)"))).toHaveLength(1);
    expect(r.lines.filter((l) => l.startsWith("Rewards on hotkey 0x11111111…: a claim is due (") && l.includes(", but it waits: the vault's claimGasRequired (64,500,000)"))).toHaveLength(1);
  });

  it("each hotkey by its own last claim (R6b: the round comes 28 days after a staked hotkey's last claim, whatever a claim costs); one claimed a day ago is counted in it", async () => {
    const w = quiet();
    // $300 a TAO: a 0.057 TAO claim costs $17.10
    w.market = marketOf({ spot: 300_000_000n });
    listed(w, [
      { hotkey: HK_STAKE, stakeRao: (45n * TAO) / RAO, credits: TAO / 2n, lastClaimAt: BigInt(T - 86_400) },
      { hotkey: HK_STANDBY, stakeRao: (5n * TAO) / RAO, credits: TAO / 2n, lastClaimAt: BigInt(T - 31 * 86_400) },
    ]);
    const r = await rounds(w, 2);
    expect(r.sent).toEqual([["claimRewards 0x40"], []]);
    expect(r.lines).toContain(
      "Rewards on hotkey 0x40404040…: a claim is due (the claim round: its last claim was 31 days ago, and every staked hotkey is claimed at least every 28 days; a claim costs about τ0.057 ($17.10 at $300.00 a TAO), and τ0.5 is waiting)",
    );
  });

  it("the standby is read and claimed once it is listed, never before", async () => {
    const w = quiet();
    listed(w, [{ hotkey: HK_STAKE, stakeRao: (50n * TAO) / RAO }, { hotkey: HK_STANDBY, stakeRao: (5n * TAO) / RAO, credits: 2n * TAO }]);
    // not listed yet (Task 68 lists it)
    w.vault.hotkeyCount = 1;
    const r = await rounds(w, 2);
    expect(w.creditReads.map((x) => x.hotkey)).not.toContain(HK_STANDBY);
    expect(w.sends).toEqual([]);
    // addHotkey(standby)
    w.vault.hotkeyCount = 2;
    const s = await rounds(w, 1, { saved: r.saved, journal: r.journal, from: T + 120 });
    expect(w.creditReads.map((x) => x.hotkey)).toContain(HK_STANDBY);
    expect(s.sent).toEqual([["claimRewards 0x40"]]);
  });

  it("the claim source is named in one place (Task 64 confirms it on chain; a change there is one line): getUnclaimedRootTaoByHotkey, never RootClaimable", () => {
    expect(CLAIM_SOURCE.name).toBe("getUnclaimedRootTaoByHotkey");
    const core = fileURLToPath(new URL("../src/keeper/core/", import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".ts") ? [join(dir, f)] : []));
    const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
    const hits = files(core).flatMap((f) => [...code(readFileSync(f, "utf8")).matchAll(/getUnclaimedRootTaoByHotkey/g)].map(() => f.slice(core.length).replaceAll("\\", "/")));
    expect(hits).toEqual(["abi.ts"]);
    expect(files(core).filter((f) => /RootClaimable/.test(code(readFileSync(f, "utf8"))))).toEqual([]);
  });

  it("a claim the chain reverted with no reason: another caller's claim landing first (anyone may, KEEPER_FALLBACK after a hotkey's last) waits", async () => {
    const w = quiet();
    dueOnStake(w);
    w.fate = (c) => {
      if (c.fn !== "claimRewards") return "mine";
      // the other caller's claim paid them and the vault stamped it
      w.vault.hotkeys[0].credits = 0n;
      w.vault.hotkeys[0].lastClaimAt = BigInt(w.time.bittensor);
      return "revert";
    };
    const e = await claimV32(depsFor(w).deps, t, HK_STAKE, POLICY).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Waits);
    expect((e as Error).message).toMatch(/another caller claimed hotkey 0x11111111…'s rewards first/);
    expect(classifyFailure(e).stop).toBe(false);
    // R8 (L-B): credits that fell with no claim stamped (an unstake under it) explain nothing: it is held
    const v = quiet();
    dueOnStake(v);
    v.fate = (c) => {
      if (c.fn !== "claimRewards") return "mine";
      v.vault.hotkeys[0].credits = TAO;
      return "revert";
    };
    const m = freshMemory();
    const f = await claimV32(depsFor(v, m).deps, t, HK_STAKE, POLICY, { memory: m, now: T * 1000 }).catch((x: unknown) => x);
    expect(f).toBeInstanceOf(HeldRefusal);
    expect((f as Error).message).toMatch(/^the claim reverted on chain with no reason, and nothing read since explains it/);
  });

  it("an unexplained claim revert never stops the keeper: claims on that one hotkey wait a day, said loudly, and the round goes on (the other hotkeys' claims, the payouts); it is tried again after 24 h", async () => {
    const w = quiet();
    listed(w, [
      { hotkey: HK_STAKE, stakeRao: (45n * TAO) / RAO, credits: 2n * TAO },
      { hotkey: HK_STANDBY, stakeRao: (5n * TAO) / RAO, credits: (3n * TAO) / 2n },
    ]);
    // the chain refuses the stake hotkey's claim, burning its gas, with no reason, and nothing read after explains it
    let refuse = true;
    w.fate = (c) => (c.fn === "claimRewards" && c.args[0] === HK_STAKE && refuse ? "revert" : "mine");
    const r = await rounds(w, 3, {
      between: (i) => {
        // a payout due in the second round goes (its logs near the head, past the cursors); paid out by the third
        if (i === 1) {
          queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }], 9_900n);
          w.vault.balance = TAO + 10n ** 15n;
        }
        if (i === 2) delete w.vault.batches[KEY_A.toLowerCase()];
      },
    });
    expect(r.sent).toEqual([["claimRewards 0x11", "claimRewards 0x40"], ["processPayouts"], []]);
    const held = r.lines.filter((l) => l.startsWith("HELD: "));
    expect(held).toEqual([
      expect.stringMatching(
        /^HELD: claiming the rewards on hotkey 0x11111111…: the claim reverted on chain with no reason, and nothing read since explains it \(transaction 0x[0-9a-f]{64}\): claims on hotkey 0x11111111… wait 24 hours, until 2027-01-16 08:00 UTC, or until a claim on it pays \(pnpm ops claim <hotkey> --live --send ignores the hold\) or the vault's claimGasRequired changes; a repeat doubles the wait; the keeper's other work goes on$/,
      ),
    ]);
    expect(r.lines).toContainEqual(
      expect.stringMatching(
        /^Rewards on hotkey 0x11111111…: a claim is due \(.*\), but it waits: its last claim reverted on chain with nothing to explain it \(transaction 0x[0-9a-f]{64}\): it is tried again at 2027-01-16 08:00 UTC, or once a claim on it pays or the vault's claimGasRequired changes$/,
      ),
    );
    // 24 h on (both chains' clocks with the keeper's), it is tried again
    refuse = false;
    w.time.base = T + 86_400;
    w.time.bittensor = T + 86_400;
    const s = await rounds(w, 1, { saved: r.saved, journal: r.journal, from: T + 86_400 });
    expect(s.sent).toEqual([["claimRewards 0x11"]]);
  });

  it("R7 (M1), R8 (L-B): an unexplained claim revert's hold never ends on credits alone (rising: root credits move every epoch; falling: an unstake may lower them), only on time, or early once a claim on it has paid", async () => {
    const w = quiet();
    dueOnStake(w);
    w.fate = (c) => (c.fn === "claimRewards" && w.vault.hotkeys[0].credits >= 2n * TAO ? "revert" : "mine");
    const r = await rounds(w, 2);
    expect(r.sent).toEqual([["claimRewards 0x11"], []]);
    // a reward epoch later (both chains' clocks with the keeper's): more waits on it, and the hold stands
    const step = async (s: number, saved: string, journal: ReturnType<typeof memoryJournal>) => {
      w.time.base = T + s;
      w.time.bittensor = T + s;
      return rounds(w, 1, { saved, journal, from: T + s });
    };
    w.vault.hotkeys[0].credits = (5n * TAO) / 2n;
    const s = await step(3_600, r.saved, r.journal);
    expect(s.sent).toEqual([[]]);
    // R8 (L-B): credits falling with no claim paid (an unstake can lower them) is no sign of one: the hold stands
    w.vault.hotkeys[0].credits = (3n * TAO) / 2n;
    const u = await step(7_200, s.saved, s.journal);
    expect(u.sent).toEqual([[]]);
    // another caller's claim paid (the vault stamped its last claim after the hold began), and more than 25 claims' worth
    // waits again: it goes at once
    w.vault.hotkeys[0].lastClaimAt = BigInt(T + 9_000);
    w.vault.hotkeys[0].credits = (7n * TAO) / 4n;
    const v = await step(10_800, u.saved, u.journal);
    expect(v.sent).toEqual([["claimRewards 0x11"]]);
  });

  it("R7 (M1): repeat unexplained reverts on the same hotkey back off, 1, 2, 4, 8, then 16 days at most, each repeat said loudly; a claim that pays forgets them", async () => {
    const w = quiet();
    dueOnStake(w);
    let refuse = true;
    w.fate = (c) => (c.fn === "claimRewards" && c.args[0] === HK_STAKE && refuse ? "revert" : "mine");
    const DAY = 86_400;
    let saved: string | undefined;
    let journal: ReturnType<typeof memoryJournal> | undefined;
    const day = async (n: number) => {
      w.time.base = T + n * DAY;
      w.time.bittensor = T + n * DAY;
      const r = await rounds(w, 1, { ...(saved ? { saved } : {}), ...(journal ? { journal } : {}), from: T + n * DAY });
      saved = r.saved;
      journal = r.journal;
      return r;
    };
    const first = await day(0);
    expect(first.sent).toEqual([["claimRewards 0x11"]]);
    expect(first.lines.filter((l) => l.startsWith("HELD: "))).toEqual([expect.stringContaining("wait 24 hours, until 2027-01-16 08:00 UTC")]);
    // each repeat: tried at the hold's end, reverted again, held twice as long (16 days at most), said loudly
    const repeats: [number, number, string, string][] = [
      [1, 2, "2 days", "2027-01-18 08:00"],
      [3, 3, "4 days", "2027-01-22 08:00"],
      [7, 4, "8 days", "2027-01-30 08:00"],
      [15, 5, "16 days", "2027-02-15 08:00"],
      [31, 6, "16 days", "2027-03-03 08:00"],
    ];
    for (const [n, strikes, wait, until] of repeats) {
      // the day before its hold ends: nothing sent
      expect((await day(n - 1)).sent, `day ${n - 1}`).toEqual([[]]);
      const r = await day(n);
      expect(r.sent, `day ${n}`).toEqual([["claimRewards 0x11"]]);
      expect(r.lines.filter((l) => l.startsWith("HELD: ")), `day ${n}`).toEqual([
        expect.stringMatching(
          new RegExp(
            `^HELD: claiming the rewards on hotkey 0x11111111…: CLAIM REVERTED AGAIN: the claim reverted on chain with no reason ${strikes} times in a row, and nothing read since explains it \\(transaction 0x[0-9a-f]{64}\\): claims on hotkey 0x11111111… wait ${wait}, until ${until} UTC \\(each repeat doubles the wait, up to 16 days\\), or until a claim on it pays \\(pnpm ops claim <hotkey> --live --send ignores the hold\\) or the vault's claimGasRequired changes; check the hotkey and the vault's claimGasRequired \\(runbook section 5, claim\\); the keeper's other work goes on$`,
          ),
        ),
      ]);
    }
    // the next try pays: the repeats are forgotten, so a later unexplained revert holds a day again
    refuse = false;
    expect((await day(47)).sent).toEqual([["claimRewards 0x11"]]);
    refuse = true;
    w.vault.hotkeys[0].credits = 2n * TAO;
    const later = await day(48);
    expect(later.sent).toEqual([["claimRewards 0x11"]]);
    expect(later.lines.filter((l) => l.startsWith("HELD: "))).toEqual([expect.stringContaining("the claim reverted on chain with no reason, and nothing read since explains it")]);
    expect(later.lines.filter((l) => l.startsWith("HELD: "))).toEqual([expect.stringContaining("wait 24 hours")]);
  });

  /** Rounds at `s` seconds past T, both chains' clocks with the keeper's, one memory and journal carried across them. */
  const clockRounds = (w: World) => {
    let saved: string | undefined;
    let journal: ReturnType<typeof memoryJournal> | undefined;
    return async (s: number) => {
      w.time.base = T + s;
      w.time.bittensor = T + s;
      const r = await rounds(w, 1, { ...(saved ? { saved } : {}), ...(journal ? { journal } : {}), from: T + s });
      saved = r.saved;
      journal = r.journal;
      return r;
    };
  };
  const heldLines = (r: { lines: string[] }) => r.lines.filter((l) => l.startsWith("HELD: "));

  it("R8 (M-A): a claim whose receipt came late, reverted, is held as one reverted at its send: HELD, and the next readings don't claim it again; a late repeat says CLAIM REVERTED AGAIN and holds twice as long", async () => {
    const w = quiet();
    dueOnStake(w);
    // every claim misses the receipt wait (the Worker's 40 s, about three Bittensor blocks, for a ~57M-gas claim)
    w.fate = (c) => (c.fn === "claimRewards" ? "hold" : "mine");
    /** The last claim sent lands late, reverted with no reason (the precompile burned its gas) */
    const lateRevert = () => {
      const c = w.sends.filter((x) => x.fn === "claimRewards").at(-1) as (typeof w.sends)[number];
      w.receipts[c.hash] = { status: "0x0", logs: [] };
      w.nonce.bittensor.latest++;
    };
    const at = clockRounds(w);
    expect((await at(0)).sent).toEqual([["claimRewards 0x11"]]);
    // its receipt is found a round later: reverted
    lateRevert();
    const late = await at(60);
    expect(late.lines).toContainEqual(expect.stringMatching(/^Late receipt: claiming the rewards on hotkey 0x11111111… reverted on chain \(transaction 0x[0-9a-f]{64}\)$/));
    expect(heldLines(late)).toEqual([
      expect.stringMatching(
        /^HELD: claiming the rewards on hotkey 0x11111111…: the claim reverted on chain with no reason, and nothing read since explains it \(transaction 0x[0-9a-f]{64}\): claims on hotkey 0x11111111… wait 24 hours, until 2027-01-16 08:01 UTC, or until a claim on it pays/,
      ),
    ]);
    // the claim is still due by the policy, and nothing is sent until the hold ends
    expect(late.sent).toEqual([[]]);
    expect((await at(120)).sent).toEqual([[]]);
    expect((await at(86_400)).sent).toEqual([[]]);
    // a day on it is tried again; late and reverted again: twice as long, said loudly
    expect((await at(86_400 + 120)).sent).toEqual([["claimRewards 0x11"]]);
    lateRevert();
    const repeat = await at(86_400 + 180);
    expect(heldLines(repeat)).toEqual([
      expect.stringMatching(/^HELD: claiming the rewards on hotkey 0x11111111…: CLAIM REVERTED AGAIN: the claim reverted on chain with no reason 2 times in a row, .* wait 2 days, until 2027-01-18 08:03 UTC/),
    ]);
    expect(repeat.sent).toEqual([[]]);
    expect((await at(3 * 86_400)).sent).toEqual([[]]);
  });

  it("R8 (L-B): a paid claim is told by the vault's own clock against itself (its lastClaimAt past the one read with the hold), so Bittensor's clock running ahead of the keeper's never ends a hold on an older claim", async () => {
    const w = quiet();
    dueOnStake(w);
    // the hotkey's last claim stamped 5 minutes ahead of the keeper's clock (Bittensor's block time running fast)
    w.vault.hotkeys[0].lastClaimAt = BigInt(T + 300);
    w.fate = (c) => (c.fn === "claimRewards" ? "revert" : "mine");
    const r = await rounds(w, 3);
    expect(r.sent).toEqual([["claimRewards 0x11"], [], []]);
    expect(r.lines.filter((l) => l.startsWith("HELD: "))).toHaveLength(1);
  });

  it("R9 (L-2): a late-reverted claim another caller's claim beat (the hotkey's last claim moved past the one read before the send, Bittensor's clock against itself) is a wait, never a hold or a strike: the next due claim goes at once", async () => {
    const w = quiet();
    dueOnStake(w);
    // the claim misses the receipt wait
    w.fate = (c) => (c.fn === "claimRewards" ? "hold" : "mine");
    const at = clockRounds(w);
    expect((await at(0)).sent).toEqual([["claimRewards 0x11"]]);
    // it carries the hotkey's last claim as read before the send
    const c = w.sends.at(-1) as (typeof w.sends)[number];
    // a stranger's claim lands first (anyone may, once the schedule has vested and 7 days have passed), stamped by
    // Bittensor's block time an hour behind the keeper's clock: only the last claim read before the send can tell it
    w.vault.hotkeys[0].lastClaimAt = BigInt(T - 3_600);
    w.vault.hotkeys[0].credits = 0n;
    // the keeper's lands after it, reverted with no reason
    w.receipts[c.hash] = { status: "0x0", logs: [] };
    w.nonce.bittensor.latest++;
    const late = await at(60);
    expect(late.lines).toContainEqual(expect.stringMatching(/^Late receipt: claiming the rewards on hotkey 0x11111111… reverted on chain/));
    expect(heldLines(late)).toEqual([]);
    expect(late.lines).toContainEqual(
      "Not done: another caller claimed hotkey 0x11111111…'s rewards first (anyone may once the claim schedule has vested and 7 days have passed since its last claim); the next round decides again",
    );
    // rewards on it again an epoch later: claimed at once, nothing held
    w.fate = () => "mine";
    w.vault.hotkeys[0].credits = 2n * TAO;
    expect((await at(3_600)).sent).toEqual([["claimRewards 0x11"]]);
  });

  it("R9 (L-2): claimRevertedLateV32 by the last claim read before the send when it has one (one chain's clock against itself), else by the keeper's: a last claim stamped within LATE_CLAIM_SLACK_MS before the keeper stopped waiting for the receipt is another caller's; a hold keeps the last claim read before the send, so a later paid claim ends it", async () => {
    const H: Hex = `0x${"ce".repeat(32)}`;
    const since = (T + 40) * 1000;
    const late = (w: World, m: KeeperMemory, x: { last?: number; deps?: Partial<ReturnType<typeof depsFor>["deps"]> } = {}) =>
      claimRevertedLateV32({ ...depsFor(w, m).deps, ...x.deps }, m, { hotkey: HK_STAKE, hash: H, now: since, since, ...(x.last !== undefined ? { last: x.last } : {}) });
    const refusedOf = (m: KeeperMemory) => (m.reads.rewards as { refused?: Record<string, { last?: number; strikes?: number }> } | undefined)?.refused?.[lower(HK_STAKE)];
    expect(LATE_CLAIM_SLACK_MS).toBe(10 * 60_000);
    // no last claim from before the send (a watch kept from before R9): the keeper's clock, with its slack
    for (const [stamp, wait] of [
      [T + 6, true],
      // 9 minutes before the keeper stopped waiting (a 5-minute receipt wait by hand, and the clocks apart): still a wait
      [T + 40 - 540, true],
      [T + 40 - 600, true],
      [T + 40 - 601, false],
      [T - 86_400, false],
    ] as const) {
      const w = quiet();
      dueOnStake(w);
      w.vault.hotkeys[0].lastClaimAt = BigInt(stamp);
      const m = freshMemory();
      const r = await late(w, m);
      if (wait) {
        expect(r, String(stamp)).toEqual({ wait: "another caller claimed hotkey 0x11111111…'s rewards first (anyone may once the claim schedule has vested and 7 days have passed since its last claim); the next round decides again" });
        expect(refusedOf(m), String(stamp)).toBeUndefined();
      } else {
        expect(r, String(stamp)).toEqual({ held: expect.stringContaining("wait 24 hours") });
        expect(refusedOf(m)?.last, String(stamp)).toBe(stamp);
      }
    }
    // with it: moved past it, however long before the keeper's clock, is a wait; not moved, a hold, whatever the
    // keeper's clock says
    const moved = quiet();
    dueOnStake(moved);
    moved.vault.hotkeys[0].lastClaimAt = BigInt(T - 3_600);
    expect(await late(moved, freshMemory(), { last: T - 86_400 })).toMatchObject({ wait: expect.stringMatching(/^another caller claimed/) });
    const still = quiet();
    dueOnStake(still);
    still.vault.hotkeys[0].lastClaimAt = BigInt(T - 60);
    const sm = freshMemory();
    expect(await late(still, sm, { last: T - 60 })).toMatchObject({ held: expect.stringContaining("wait 24 hours") });
    expect(refusedOf(sm)).toMatchObject({ last: T - 60, strikes: 1 });
    // the read after the revert failed: held, keeping the last claim read before the send (not the keeper's clock)
    const unread = quiet();
    dueOnStake(unread);
    const um = freshMemory();
    const failing = { readClaims: async () => Promise.reject(new Error("bittensor eth_call: fetch failed")) };
    expect(await late(unread, um, { last: T - 86_400, deps: failing })).toMatchObject({ held: expect.stringContaining("wait 24 hours") });
    expect(refusedOf(um)?.last).toBe(T - 86_400);
  });

  it("R8 (M-A): a late revert the claim's table names (replayed at its block) waits, unheld, as at its send", async () => {
    const w = quiet();
    dueOnStake(w);
    w.fate = (c) => (c.fn === "claimRewards" ? "hold" : "mine");
    const at = clockRounds(w);
    expect((await at(0)).sent).toEqual([["claimRewards 0x11"]]);
    const c = w.sends.at(-1) as (typeof w.sends)[number];
    w.receipts[c.hash] = { status: "0x0", logs: [] };
    w.nonce.bittensor.latest++;
    // replayed at its block, it reverts InsufficientGas (claimGasRequired raised under it)
    w.callAt = (x) => (x.fn === "claimRewards" ? revertWith("InsufficientGas") : undefined);
    const late = await at(60);
    expect(heldLines(late)).toEqual([]);
    expect(late.lines).toContainEqual(expect.stringMatching(/^Not done: the claim on hotkey 0x11111111… waits: the call's gas fell short: .* \(InsufficientGas\); transaction 0x[0-9a-f]{64} reverted on chain; the next round decides again$/));
  });

  it("R8 (L-A): a claim held after an unexplained revert goes again once the vault's claimGasRequired changes (the owner's set-claim-gas), said; a repeat then holds a day again", async () => {
    const w = quiet();
    dueOnStake(w);
    w.fate = (c) => (c.fn === "claimRewards" ? "revert" : "mine");
    const at = clockRounds(w);
    const first = await at(0);
    expect(first.sent).toEqual([["claimRewards 0x11"]]);
    expect(heldLines(first)).toEqual([expect.stringContaining("wait 24 hours")]);
    expect((await at(3_600)).sent).toEqual([[]]);
    // the owner raises claimGasRequired: the hold ends at the next reading, and the claim goes (and reverts again here)
    w.answers[`${lower(ADDR.vaultLens)}:claimGasRequired`] = () => 56_000_000n;
    const fixed = await at(7_200);
    expect(fixed.lines).toContain(
      "Claims on hotkey 0x11111111… go again: the vault's claimGasRequired is 56,000,000 now, not the 55,000,000 its claim reverted at, so its hold ends (a repeat holds a day again)",
    );
    expect(fixed.sent).toEqual([["claimRewards 0x11"]]);
    expect(w.sends.at(-1)?.gas).toBe(58_000_000n);
    expect(heldLines(fixed)).toEqual([expect.stringMatching(/^HELD: claiming the rewards on hotkey 0x11111111…: the claim reverted on chain with no reason, .* wait 24 hours/)]);
    // the setting unchanged since: the hold stands
    expect((await at(10_800)).sent).toEqual([[]]);
  });

  it("the named waits: a claim its simulation refuses InsufficientGas (claimGasRequired raised since it was read) or UnknownHotkey (removed) waits, never a stop; so does one whose hotkey was removed under it on chain", async () => {
    for (const [error, why] of [
      ["InsufficientGas", "the call's gas fell short: a claim's of the vault's claimGasRequired (changed since it was read), an adoption's of its read of the chain's minimum (the gas guard)"],
      ["UnknownHotkey", "the hotkey is no longer listed"],
    ] as const) {
      const w = quiet();
      dueOnStake(w);
      w.simulate = (c) => (c.fn === "claimRewards" ? { error } : 200_000n);
      const e = await claimV32(depsFor(w).deps, t, HK_STAKE, POLICY).catch((x: unknown) => x);
      expect(e, error).toBeInstanceOf(Waits);
      expect((e as Error).message).toBe(`the claim on hotkey 0x11111111… waits: ${why} (${error}); the next round decides again`);
      expect(classifyFailure(e).stop).toBe(false);
      expect(w.sends).toEqual([]);
    }
    const v = quiet();
    listed(v, [{ hotkey: HK_SECOND, stakeRao: (5n * TAO) / RAO }, { hotkey: HK_STAKE, stakeRao: (45n * TAO) / RAO, credits: 2n * TAO }], HK_SECOND);
    v.fate = (c) => {
      if (c.fn !== "claimRewards") return "mine";
      v.vault.hotkeyCount = 1;
      return "revert";
    };
    const e = await claimV32(depsFor(v).deps, t, HK_STAKE, POLICY).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Waits);
    expect((e as Error).message).toMatch(/^hotkey 0x11111111… was removed under the claim; transaction 0x[0-9a-f]{64} reverted on chain; the next round decides again$/);
  });

  it("a Base read failure (TAO's price for the policy) never holds a Bittensor-only claim: the 25-times claim goes, and so does the claim round's (R6b), its cost said unpriced", async () => {
    const w = quiet();
    dueOnStake(w);
    w.answers[`${lower(ADDR.quoter)}:quoteExactInput`] = () => {
      throw new Error("Base's RPC is down");
    };
    const r = await rounds(w, 1);
    expect(r.sent).toEqual([["claimRewards 0x11"]]);
    const v = quiet();
    listed(v, [{ hotkey: HK_STAKE, stakeRao: (40n * TAO) / RAO, credits: TAO / 10n, lastClaimAt: BigInt(T - 28 * 86_400) }]);
    v.answers[`${lower(ADDR.quoter)}:quoteExactInput`] = () => {
      throw new Error("Base's RPC is down");
    };
    const s = await rounds(v, 1);
    expect(s.sent).toEqual([["claimRewards 0x11"]]);
    expect(s.lines).toContainEqual(expect.stringContaining("a claim costs about τ0.057 (TAO's price couldn't be read), and τ0.1 is waiting"));
  });

  it("a one-shot claim decides again on what it reads now: a hotkey not due, not listed, or a claim with no room under the cap is refused, nothing sent", async () => {
    const w = quiet();
    dueOnStake(w);
    // the second hotkey: nothing waiting on it
    const notDue = await claimV32(depsFor(w).deps, t, HK_SECOND, POLICY).catch((x: unknown) => x);
    expect(classifyFailure(notDue)).toMatchObject({ stop: false, kind: "not-now" });
    expect((notDue as Error).message).toMatch(/^not claiming on hotkey 0x22222222…: τ0 is waiting/);
    const unlisted = await claimV32(depsFor(w).deps, t, HK_OLD, POLICY).catch((x: unknown) => x);
    expect((unlisted as Error).message).toBe("hotkey 0x33333333… is no longer listed; nothing claimed");
    const founder = deploymentFor({ spendCap: { base: 10n ** 18n, bittensor: parseEther("0.033") } });
    const capped = await claimV32(depsFor(w, freshMemory(), founder).deps, targetV32(founder), HK_STAKE, POLICY).catch((x: unknown) => x);
    expect(capped).toBeInstanceOf(Waits);
    expect((capped as Error).message).toMatch(/^the claim on hotkey 0x11111111… waits: Bittensor's 24 h spend cap \(0\.033 TAO\) can't fit a claim/);
    const adopt = await adoptV32(depsFor(w).deps, t).catch((x: unknown) => x);
    expect((adopt as Error).message).toMatch(/^not adopting: no surplus of at least the chain's minimum stake/);
    expect(w.sends).toEqual([]);
  });
});

describe("R6b (U1, U2): every staked hotkey claimed in one round, before the claim schedule ends", () => {
  const DAY = 86_400;
  /** A claim schedule the lens reads: from `start` (s) over 30 days, an amount vesting. */
  const schedule = (w: World, start: number) => (w.vault.vesting = { start: BigInt(start), period: 2_592_000n, amount: TAO });

  it("the standby is claimed in the same round as the stake hotkey even when its own claim costs more than waits on it, its line saying the cost", async () => {
    const w = quiet();
    w.market = marketOf({ spot: 300_000_000n });
    listed(w, [
      { hotkey: HK_STAKE, stakeRao: (36n * TAO) / RAO, credits: 2n * TAO },
      // a 10% standby: about a month's rewards at 40 TAO, under the 0.057 TAO a claim costs
      { hotkey: HK_STANDBY, stakeRao: (4n * TAO) / RAO, credits: 18n * 10n ** 15n, lastClaimAt: BigInt(T - 10 * DAY) },
    ]);
    const r = await rounds(w, 3);
    expect(r.sent).toEqual([["claimRewards 0x11"], ["claimRewards 0x40"], []]);
    expect(r.lines).toContain(
      "Rewards on hotkey 0x40404040…: a claim is due (the claim round: the claim schedule restarted at 2027-01-15 08:00 UTC, after this hotkey's last claim (2027-01-05 08:00 UTC), so it is claimed in the same round; its claim costs about τ0.057 ($17.10 at $300.00 a TAO), more than the τ0.018 waiting, but it is claimed anyway)",
    );
  });

  it("the round comes 2 days before the claim schedule ends, whatever a claim costs in dollars; a day earlier nothing is due and the line names the round's time", async () => {
    const w = quiet();
    // $400 a TAO: a 0.057 TAO claim costs $22.80, over the old $20 ceiling for monthly claims
    w.market = marketOf({ spot: 400_000_000n });
    const last = T - 28 * DAY - 60;
    schedule(w, last);
    listed(w, [
      { hotkey: HK_STAKE, stakeRao: (36n * TAO) / RAO, credits: TAO / 10n, lastClaimAt: BigInt(last) },
      { hotkey: HK_STANDBY, stakeRao: (4n * TAO) / RAO, credits: TAO / 100n, lastClaimAt: BigInt(last) },
    ]);
    const r = await rounds(w, 3);
    expect(r.sent).toEqual([["claimRewards 0x11"], ["claimRewards 0x40"], []]);
    expect(r.lines).toContain(
      "Rewards on hotkey 0x11111111…: a claim is due (the claim round: the claim schedule ends at 2027-01-17 07:59 UTC, and every staked hotkey is claimed 2 days before it ends; a claim costs about τ0.057 ($22.80 at $400.00 a TAO), and τ0.1 is waiting)",
    );
    expect(r.lines).toContain(
      "Rewards on hotkey 0x40404040…: a claim is due (the claim round: the claim schedule ends at 2027-01-17 07:59 UTC, and every staked hotkey is claimed 2 days before it ends; its claim costs about τ0.057 ($22.80 at $400.00 a TAO), more than the τ0.01 waiting, but it is claimed anyway)",
    );
    // a day earlier: no round yet
    const v = quiet();
    v.market = marketOf({ spot: 400_000_000n });
    schedule(v, T - 27 * DAY);
    listed(v, [
      { hotkey: HK_STAKE, stakeRao: (36n * TAO) / RAO, credits: TAO / 10n, lastClaimAt: BigInt(T - 27 * DAY) },
      { hotkey: HK_STANDBY, stakeRao: (4n * TAO) / RAO, credits: TAO / 100n, lastClaimAt: BigInt(T - 27 * DAY) },
    ]);
    const s = await rounds(v, 1);
    expect(s.sent).toEqual([[]]);
    expect(s.lines).toContain("Rewards on hotkey 0x11111111…: no claim due (τ0.1 is waiting, below 25× the τ0.057 a claim costs (τ1.425); the next claim round is at 2027-01-16 08:00 UTC)");
  });

  it("no hotkey's backlog passes one period: with no schedule running, a staked hotkey 28 days after its last claim opens the round, and one claimed more than 5 days before it follows; one claimed within 5 days is counted in it (R7, M2)", async () => {
    const w = quiet();
    listed(w, [
      { hotkey: HK_STAKE, stakeRao: (36n * TAO) / RAO, credits: TAO / 10n, lastClaimAt: BigInt(T - 28 * DAY) },
      { hotkey: HK_STANDBY, stakeRao: (3n * TAO) / RAO, credits: TAO / 100n, lastClaimAt: BigInt(T - 6 * DAY) },
      { hotkey: HK_SECOND, stakeRao: TAO / RAO, credits: TAO / 100n, lastClaimAt: BigInt(T - 4 * DAY) },
    ]);
    const r = await rounds(w, 3);
    expect(r.sent).toEqual([["claimRewards 0x11"], ["claimRewards 0x40"], []]);
    expect(r.lines).toContainEqual(expect.stringMatching(/^Rewards on hotkey 0x11111111…: a claim is due \(the claim round: its last claim was 28 days ago, and every staked hotkey is claimed at least every 28 days; a claim costs about τ0\.057 \(/));
  });

  it("R7 (M2): the round provably ends: 4 staked hotkeys at one claim a day (a spend cap that fits one), each claim restarting the schedule; once each is claimed, nothing until the next round", () => {
    // the slack covers a whole round at one claim a day: the round's oldest claim is MAX_HOTKEYS - 1 days before its last
    expect(CLAIM_ROUND_SLACK_S).toBe((MAX_HOTKEYS + 1) * DAY);
    const PERIOD = 30 * DAY;
    /** `steps` chances to claim, `gap` apart (one claim each: the cap fits no more), from a round already due. */
    const simulate = (gap: number, steps: number) => {
      let hotkeys: HotkeyRead[] = [HK_STAKE, HK_SECOND, HK_STANDBY, HK_OLD].map((hotkey, i) => ({
        hotkey,
        waitingWei: TAO / 100n,
        lastClaimAt: T - 28 * DAY - 600 + i * 60,
        stakeRao: (10n * TAO) / RAO,
        stakeHotkey: i === 0,
      }));
      let schedule = { start: T - 28 * DAY, period: PERIOD, amount: TAO };
      const claims: [number, number][] = [];
      for (let step = 0; step < steps; step++) {
        const now = T + step * gap;
        // rewards accrue on each between chances
        hotkeys = hotkeys.map((h) => ({ ...h, waitingWei: h.waitingWei + TAO / 1_000n }));
        const i = hotkeys.findIndex((h) => claimFor(h, { now, taoPriceUsd: 300, schedule }, POLICY).claim);
        if (i < 0) continue;
        claims.push([step, i]);
        hotkeys[i] = { ...hotkeys[i], lastClaimAt: now, waitingWei: 0n };
        schedule = { start: now, period: PERIOD, amount: TAO };
      }
      return claims;
    };
    // a day and a minute apart (the cap's 24 h window lets the next go just after): one round of four, then the next
    // round 28 days after the first claim (its backlog), and so on: never a claim a day for ever
    expect(simulate(DAY + 60, 70)).toEqual([
      [0, 0], [1, 1], [2, 2], [3, 3],
      [28, 0], [29, 1], [30, 2], [31, 3],
      [56, 0], [57, 1], [58, 2], [59, 3],
    ]);
    // a day and a half apart (the cap's room cut by a fee spike): still one claim of each, then quiet until the backlog
    const slow = simulate(1.5 * DAY, 30);
    expect(slow.filter(([s]) => s < 18).map(([, i]) => i)).toEqual([0, 1, 2, 3]);
  });

  it("R8 (L-E): below about 7 days of rewardVesting the 5-day slack is longer than the period less its lead, so only the first hotkey keeps that cadence; the others are claimed about every 5 days and a round's cadence more (runbook section 4 says so; the slack stays 5 days, which M2's ending needs)", () => {
    /** Two staked hotkeys, a chance to claim every 10 minutes (no cap), rewards accruing too slowly for the 25-times
     * claim: the days each is claimed on, over 40 days. */
    const days = (period: number) => {
      let hotkeys: HotkeyRead[] = [HK_STAKE, HK_SECOND].map((hotkey, i) => ({ hotkey, waitingWei: TAO / 100n, lastClaimAt: T - 28 * DAY - 600 + i * 60, stakeRao: (10n * TAO) / RAO, stakeHotkey: i === 0 }));
      let schedule = { start: T - 28 * DAY, period, amount: TAO };
      const on: number[][] = [[], []];
      for (let now = T; now < T + 40 * DAY; now += 600) {
        const i = hotkeys.findIndex((h) => claimFor(h, { now, taoPriceUsd: 300, schedule }, POLICY).claim);
        if (i < 0) continue;
        on[i].push(Math.round((now - T) / DAY));
        hotkeys[i] = { ...hotkeys[i], lastClaimAt: now, waitingWei: TAO / 100n };
        schedule = { start: now, period, amount: TAO };
      }
      return on;
    };
    const gaps = (xs: number[]) => [...new Set(xs.slice(1).map((x, i) => x - xs[i]))];
    // 4 days (a lead of 2): the first every 2 days, the second every 6
    const [first4, second4] = days(4 * DAY);
    expect([gaps(first4), gaps(second4)]).toEqual([[2], [6]]);
    // 6 days (a lead of 2): every 4, and every 8
    const [first6, second6] = days(6 * DAY);
    expect([gaps(first6), gaps(second6)]).toEqual([[4], [8]]);
    // 8 days: the period less its lead (6) is over the slack, and every staked hotkey goes together, every 6 days
    const [first8, second8] = days(8 * DAY);
    expect([gaps(first8), gaps(second8)]).toEqual([[6], [6]]);
    expect(CLAIM_ROUND_SLACK_S).toBe(5 * DAY);
  });

  it("R7 (L6): a claim schedule no longer than twice the lead (rewardVesting of 4 days or less) still brings the round: the lead is half its period", () => {
    for (const [period, lead, words] of [
      [DAY, DAY / 2, "12 hours"],
      [2 * DAY, DAY, "1 day"],
      [4 * DAY, 2 * DAY, "2 days"],
      [30 * DAY, CLAIM_LEAD_S, "2 days"],
    ] as const) {
      // claimed (and the schedule restarted) a minute after the round's time has come, then a minute before it
      const start = T - (period - lead) - 60;
      const h: HotkeyRead = { hotkey: HK_STAKE, waitingWei: TAO / 100n, lastClaimAt: start, stakeRao: (40n * TAO) / RAO, stakeHotkey: true };
      const c = claimFor(h, { now: T, taoPriceUsd: 300, schedule: { start, period, amount: TAO } }, POLICY);
      expect(c.claim, `${period}`).toBe(true);
      expect(c.reason, `${period}`).toContain(`and every staked hotkey is claimed ${words} before it ends`);
      expect(claimFor(h, { now: T - 120, taoPriceUsd: 300, schedule: { start, period, amount: TAO } }, POLICY).claim, `${period}`).toBe(false);
    }
  });

  it("a claim that books nothing (the chain skips one under its threshold) never repeats: the claimed hotkey is out of the round once its claim lands", async () => {
    const w = quiet();
    schedule(w, T - 29 * DAY);
    listed(w, [{ hotkey: HK_STAKE, stakeRao: (40n * TAO) / RAO, credits: 10n ** 14n, lastClaimAt: BigInt(T - 29 * DAY) }]);
    // the claim lands, but the chain pays nothing: the schedule doesn't restart, and the view still reads its credits
    w.vault.claimBooksNothing = true;
    const r = await rounds(w, 3);
    expect(r.sent.flat()).toEqual(["claimRewards 0x11"]);
  });

  it("the sign page never sends claimRewards: only the keeper may claim while rewards still vest (U1), and ops claims only as the keeper", () => {
    expect(KNOWN_ABI.map((f) => f.name)).not.toContain("claimRewards");
  });

  it("a claim refused NotKeeper (the keeper's key no longer the vault's keeper, which alone may claim while rewards vest) waits, in plain words", async () => {
    const w = quiet();
    dueOnStake(w);
    w.simulate = (c) => (c.fn === "claimRewards" ? { error: "NotKeeper" } : 200_000n);
    const e = await claimV32(depsFor(w).deps, t, HK_STAKE, POLICY).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Waits);
    expect((e as Error).message).toBe(
      "the claim on hotkey 0x11111111… waits: the keeper's key isn't the vault's keeper() now, and only the keeper may claim while rewards still vest (a rotation: the next round's readiness says so) (NotKeeper); the next round decides again",
    );
  });
});

describe("a hotkey being freed (preflight A17, over the plan's noClaimOnAHotkeyBeingFreed)", () => {
  /** The stake hotkey and a second one, each with too little waiting for the policy; the swap's old hotkey, emptied of
   * stake, 0.01 TAO of credits on it and its last claim an hour ago. */
  const freeing = (w: World) =>
    listed(w, [
      { hotkey: HK_STAKE, stakeRao: (45n * TAO) / RAO, credits: TAO / 2n },
      { hotkey: HK_SECOND, stakeRao: (5n * TAO) / RAO, credits: 10n ** 16n },
      { hotkey: HK_OLD, stakeRao: 0n, credits: 10n ** 16n, lastClaimAt: BigInt(T - 3_600) },
    ]);
  const read = async (w: World, h: Hex): Promise<HotkeyRead> => (await depsFor(w).deps.readClaims()).hotkeys.find((x) => x.hotkey === h) as HotkeyRead;

  it("claimsAHotkeyBeingFreedUntilItsCreditsReadZero: claimed while credits wait on it, whatever the policy; only once they read 0 may its slot be freed", async () => {
    const w = quiet();
    freeing(w);
    // the claim paid as the vault's balance (claimToBalance), kept liquid by the idle buffer so no stake follows
    w.vault.claimPaysTo = "balance";
    w.vault.idleBufferBps = 100;
    const before = await depsFor(w).deps.readClaims();
    const old = before.hotkeys.find((x) => x.hotkey === HK_OLD) as HotkeyRead;
    expect(beingFreed(old)).toBe(true);
    expect(slotFreeable(old)).toBe(false);
    expect(claimFor(old, before, POLICY).claim).toBe(true);
    // the same credits on a hotkey that holds stake: the policy waits
    expect(claimFor(before.hotkeys[1], before, POLICY).claim).toBe(false);
    const r = await rounds(w, 3);
    expect(r.sent).toEqual([["claimRewards 0x33"], [], []]);
    expect(r.lines.some((l) => l.startsWith("Rewards on hotkey 0x33333333…: a claim is due (it holds none of the vault's stake (a swap's old hotkey, or the old stake hotkey) and τ0.01 of credits wait on it"))).toBe(true);
    const after = await read(w, HK_OLD);
    expect(after.waitingWei).toBe(0n);
    expect(slotFreeable(after)).toBe(true);
    // credits on it again (a late settlement): claimed again, until they read 0
    w.vault.hotkeys[2].credits = 10n ** 15n;
    const s = await rounds(w, 2, { saved: r.saved, journal: r.journal, from: T + 600 });
    expect(s.sent).toEqual([["claimRewards 0x33"], []]);
    // the stake hotkey, empty (a fresh vault), is never "being freed"
    expect(beingFreed({ hotkey: HK_STAKE, stakeRao: 0n, waitingWei: 0n, lastClaimAt: 0, stakeHotkey: true })).toBe(false);
  });

  it("R8 (L-B): a hotkey being freed whose claim reverted still clears its hold once a claim on it pays (the founder's, by hand, which ignores the hold): its slot is freeable, and credits on it again are claimed at once", async () => {
    const w = quiet();
    freeing(w);
    w.vault.claimPaysTo = "balance";
    w.vault.idleBufferBps = 100;
    let refuse = true;
    w.fate = (c) => (c.fn === "claimRewards" && refuse ? "revert" : "mine");
    const r = await rounds(w, 2);
    expect(r.sent).toEqual([["claimRewards 0x33"], []]);
    expect(r.lines.filter((l) => l.startsWith("HELD: "))).toEqual([expect.stringMatching(/^HELD: claiming the rewards on hotkey 0x33333333…: the claim reverted on chain/)]);
    // ten minutes on, the founder's claim by hand pays it (claimV32 with the run's memory: the hold doesn't stop it)
    refuse = false;
    w.time.base = T + 600;
    w.time.bittensor = T + 600;
    const m = loadMemory(r.saved).memory;
    await claimV32(depsFor(w, m, d, () => undefined, { journal: r.journal }).deps, t, HK_OLD, POLICY, { memory: m, now: (T + 600) * 1000 });
    const after = await read(w, HK_OLD);
    expect([after.waitingWei, slotFreeable(after)]).toEqual([0n, true]);
    // the next reading sees its last claim past the hold: the hold is gone
    const s = await rounds(w, 1, { saved: encodeMemory(m), journal: r.journal, from: T + 660 });
    const refused = (loadMemory(s.saved).memory.reads.rewards as { refused?: Record<string, unknown> }).refused ?? {};
    expect(Object.keys(refused)).toEqual([]);
    // credits on it again (a late settlement): claimed at once, no hold left
    w.vault.hotkeys[2].credits = 10n ** 15n;
    const u = await rounds(w, 1, { saved: s.saved, journal: s.journal, from: T + 720 });
    expect(u.sent).toEqual([["claimRewards 0x33"]]);
  });

  it("a standby listed and not staked yet is never called being freed: listed, nothing staked yet (T51 review M3)", async () => {
    const w = quiet();
    listed(w, [{ hotkey: HK_STAKE, stakeRao: (50n * TAO) / RAO }, { hotkey: HK_STANDBY }]);
    const r = await rounds(w, 1);
    expect(r.lines).toContain("Rewards on hotkey 0x40404040…: no claim due (listed, nothing staked yet (or emptied), and nothing waits on it: nothing to claim)");
    expect(r.lines.filter((l) => l.includes("being freed"))).toEqual([]);
  });

  it("credits a claim pays as stake on the hotkey itself (the runtime's retained swap credits): then it holds stake, is no longer being freed, and never freeable by the keeper (I-6: the owner's removeHotkey)", async () => {
    const w = quiet();
    freeing(w);
    w.vault.claimPaysTo = "stake";
    const r = await rounds(w, 2);
    expect(r.sent).toEqual([["claimRewards 0x33"], []]);
    const after = await read(w, HK_OLD);
    expect([after.waitingWei, after.stakeRao > 0n]).toEqual([0n, true]);
    expect(beingFreed(after)).toBe(false);
    expect(slotFreeable(after)).toBe(false);
  });
});

describe("the round order: payouts, then stake or unstake, then claims (spec §3.8)", () => {
  /** A payout due (1 TAO, liquid), 10 TAO idle to stake, and a claim due on the stake hotkey. */
  function busy(): World {
    const w = quiet();
    queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }]);
    w.vault.balance = TAO + 10n * TAO + 10n ** 15n;
    dueOnStake(w);
    return w;
  }

  it("aRoundRunsPayoutsThenStakeThenClaims: one send a round, the claim only once the payout and the stake are done (its credits not even read before)", async () => {
    const w = busy();
    const r = await rounds(w, 3, {
      between: (i) => {
        // the payout went: its batch is paid out
        if (i === 1) {
          delete w.vault.batches[KEY_A.toLowerCase()];
          w.vault.pending = 0n;
          w.vault.balance -= TAO;
        }
        // the stake went; nothing read the claims before it
        if (i === 2) {
          w.vault.balance = 10n ** 15n;
          expect(w.creditReads).toEqual([]);
        }
      },
    });
    expect(r.sent).toEqual([["processPayouts"], ["stakeIdle"], ["claimRewards 0x11"]]);
  });

  it("decideNext: the adoption, then the claims, after everything else; never on a capped Bittensor, while a Bittensor send is unsettled, or under the migration exception; one skipped by the breaker gives way to the next", () => {
    const S = (o: Partial<State> = {}): State => ({
      now: T,
      frontDoor: { canClose: false, nDeposits: 0, nRedeems: 0, paused: false, openStart: T, batchInterval: 600, full: false, now: T },
      closeMaxWaitS: 0,
      alphaVault: { healthy: true },
      vault: { paused: false, available: 0n, minStakeWei: 2n * 10n ** 15n, rootStake: 0n, nominatorMinWei: 0n, batches: [], payoutDelay: 3600 },
      ...o,
    });
    const claims = [
      { hotkey: HK_STAKE, reason: "due 1" },
      { hotkey: HK_SECOND, reason: "due 2" },
    ];
    expect(decideNext(S({ claims, adopt: { reason: "adopt" } })).action).toEqual({ kind: "adopt" });
    expect(decideNext(S({ claims })).action).toEqual({ kind: "claim", hotkey: HK_STAKE });
    const payout = S().vault;
    expect(decideNext(S({ claims, vault: { ...payout, batches: [{ key: KEY_A, queuedAt: T - 7_200, cursor: 0, count: 1 }] } })).action?.kind).toBe("payouts");
    expect(decideNext(S({ claims, vault: { ...payout, available: TAO } })).action?.kind).toBe("stake");
    expect(decideNext(S({ claims, frontDoor: { ...S().frontDoor, canClose: true, nDeposits: 1 } })).action?.kind).toBe("close");
    expect(decideNext(S({ claims, capped: new Set(["bittensor"]) })).action).toBeNull();
    expect(decideNext(S({ claims, adopt: { reason: "adopt" }, rewardsWait: "a payout is still unsettled" })).action).toBeNull();
    expect(decideNext(S({ claims, onlyConversions: true })).action).toBeNull();
    expect(decideNext(S({ claims, skipped: new Set([`claim:${lower(HK_STAKE)}`]) })).action).toEqual({ kind: "claim", hotkey: HK_SECOND });
    // a claim is never offered on v3-launch's state, which has none
    expect(decideNext(S()).action).toBeNull();
  });

  describe("a claim never comes before the round's stake or unstake across invocations (the order held across a cut-off)", () => {
    /** Round 1 sends the payout and gets no receipt. Then ForeverMoney pauses AlphaVault (payouts wait while it is
     * paused, claims don't), and the node's pool forgets the payout (its pending nonce back to its mined one), so the
     * nonce guard alone would let a claim take the payout's nonce. */
    async function payoutInFlight() {
      const w = quiet();
      queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }]);
      w.vault.balance = TAO + 10n ** 15n;
      dueOnStake(w);
      w.fate = (c) => (c.fn === "processPayouts" ? "hold" : "mine");
      const r1 = await rounds(w, 1);
      expect(r1.sent).toEqual([["processPayouts"]]);
      w.alpha.paused = true;
      w.nonce.bittensor.pending = w.nonce.bittensor.latest;
      return { w, r1 };
    }
    /** The payout lands. */
    const lands = (w: World) => {
      w.receipts[w.sends[0].hash] = { status: "0x1", logs: [] };
      w.nonce.bittensor.latest++;
      w.nonce.bittensor.pending = w.nonce.bittensor.latest;
    };

    it("theOrderHoldsAcrossACutOff: the round's memory (its watch on the payout, through JSON) holds the claims until the payout settles; then the claim goes", async () => {
      const { w, r1 } = await payoutInFlight();
      expect(loadMemory(r1.saved).memory.unreceipted.map((u) => u.chain)).toEqual(["bittensor"]);
      const r2 = await rounds(w, 2, { saved: r1.saved, journal: r1.journal, from: T + 60 });
      expect(r2.sent).toEqual([[], []]);
      expect(r2.lines.filter((l) => l.startsWith("CLAIMS WAIT: "))).toEqual([
        `CLAIMS WAIT: paying out batch 0xabababab… (transaction ${w.sends[0].hash}) is still unsettled on Bittensor: claims and the adoption come after the round's payouts and stake, so they wait until it settles`,
      ]);
      lands(w);
      const r3 = await rounds(w, 1, { saved: r2.saved, journal: r2.journal, from: T + 180 });
      expect(r3.sent).toEqual([["claimRewards 0x11"]]);
    });

    it("what holds them, each on its own: a Bittensor send the memory watches, or one the journal holds unsettled within the watch's 6 hours; never a Base send", async () => {
      const w = quiet();
      const journal = memoryJournal();
      const { deps } = depsFor(w, freshMemory(), d, () => undefined, { journal });
      const m = freshMemory();
      const now = T * 1000;
      expect(await unsettledOnBittensor(deps, m, now)).toBeUndefined();
      const watch = (chain: "base" | "bittensor") => ({ hashes: [`0x${"0b".repeat(32)}` as Hex], chain, what: "staking", since: now, replacements: 0, replaceAt: now, passed: 0 });
      m.unreceipted.push(watch("base"));
      expect(await unsettledOnBittensor(deps, m, now)).toBeUndefined();
      m.unreceipted.push(watch("bittensor"));
      expect(await unsettledOnBittensor(deps, m, now)).toBe(`staking (transaction 0x${"0b".repeat(32)}) is still unsettled on Bittensor`);
      // the journal alone (a fresh memory): a row signed or sent, written within LATE_RECEIPT_MS
      const row = { chain: "bittensor" as const, from: KEY.address, nonce: 5, hashes: [`0x${"0c".repeat(32)}` as Hex], request: { chain: "bittensor" as const, nonce: 5, label: "stake the vault's idle TAO", to: ADDR.vault, abi: [], functionName: "stakeIdle", args: [] }, raw: "0x" as Hex, at: now - LATE_RECEIPT_MS + 1 };
      journal.rows.push({ ...row, status: "landed" }, { ...row, chain: "base", status: "sent" }, { ...row, status: "signed", at: now - LATE_RECEIPT_MS });
      expect(await unsettledOnBittensor(deps, freshMemory(), now)).toBeUndefined();
      journal.rows.push({ ...row, status: "sent" });
      expect(await unsettledOnBittensor(deps, freshMemory(), now)).toBe(`stake the vault's idle TAO (transaction 0x${"0c".repeat(32)}) is still unsettled on Bittensor (the keeper's journal)`);
    });

    it("and when the run was cut off before it saved its memory: the journal's unsettled payout (written ahead of its broadcast) holds them", async () => {
      const { w, r1 } = await payoutInFlight();
      // the next invocation starts from the memory before round 1: no watch
      const r2 = await rounds(w, 2, { saved: encodeMemory(freshMemory()), journal: r1.journal, from: T + 60 });
      expect(r2.sent).toEqual([[], []]);
      expect(r2.lines.some((l) => l.startsWith("CLAIMS WAIT: pay out batch 0xabababab… to Base (transaction ") && l.includes("is still unsettled on Bittensor (the keeper's journal)"))).toBe(true);
      lands(w);
      const r3 = await rounds(w, 1, { saved: r2.saved, journal: r2.journal, from: T + 180 });
      expect(r3.sent).toEqual([["claimRewards 0x11"]]);
    });
  });
});

describe("the adoption (spec §3.1, §3.10.2)", () => {
  it("adoptWhenSurplusAtLeastTheMinimum: a surplus of at least the chain's minimum stake is adopted; under it, while paused, or with stake missing, nothing", async () => {
    const run = async (edit: (w: World) => void = () => undefined) => {
      const w = quiet();
      w.vault.lastAdoptAt = BigInt(T - 2 * 86_400);
      w.vault.surplusStakeRao = 2_000_000n;
      edit(w);
      return (await rounds(w, 1)).sent;
    };
    expect(await run()).toEqual([["adoptStake"]]);
    expect(await run((w) => (w.vault.surplusStakeRao = 1_999_999n))).toEqual([[]]);
    expect(await run((w) => (w.vault.paused = true))).toEqual([[]]);
    expect(await run((w) => (w.vault.stakeMissing = true))).toEqual([[]]);
    const a = { surplusRao: 2_000_000n, minStakeRao: 2_000_000n, paused: false, stakeMissing: false, lastAdoptAt: T - 86_400, now: T };
    expect(adoptionDue(a).adopt).toBe(true);
    expect(adoptionDue({ ...a, surplusRao: 0n })).toMatchObject({ adopt: false, surplus: false });
  });

  it("adoptionsStakeRampIsReadFromTheChain: at most once per STAKE_RAMP from the chain's lastAdoptAt, whatever the keeper's memory (each round here a fresh one); another caller's adoption counts too", async () => {
    // the ramp is the vault's constant, CascadeConstants.sol's since R4 (the door hold shares it)
    expect(src("CascadeConstants.sol")).toMatch(/uint256 constant STAKE_RAMP = 1 days;/);
    expect(src("CascadeVault.sol")).toMatch(/uint256 internal constant STAKE_RAMP = Constants\.STAKE_RAMP;/);
    expect(STAKE_RAMP_S).toBe(86_400);
    const w = quiet();
    /** Both chains' clocks, and the keeper's, at `s` (the monitor reads them a minute ago) */
    const at = async (s: number) => {
      w.time.base = s;
      w.time.bittensor = s;
      return (await rounds(w, 1, { from: s })).sent;
    };
    w.vault.surplusStakeRao = 5_000_000n;
    w.vault.lastAdoptAt = BigInt(T - 86_399);
    expect(await at(T)).toEqual([[]]);
    w.vault.lastAdoptAt = BigInt(T - 86_400);
    expect(await at(T)).toEqual([["adoptStake"]]);
    expect(w.vault.lastAdoptAt).toBe(BigInt(T));
    // another gift within the day: the chain's lastAdoptAt (the adoption just made) holds it, though the memory is new
    w.vault.surplusStakeRao = 5_000_000n;
    expect(await at(T + 86_399)).toEqual([[]]);
    expect(await at(T + 86_400)).toEqual([["adoptStake"]]);
    // another caller adopted an hour ago (anyone may, KEEPER_FALLBACK after the last): the keeper waits a day from it
    w.vault.surplusStakeRao = 5_000_000n;
    w.vault.lastAdoptAt = BigInt(T + 4 * 86_400 - 3_600);
    expect(await at(T + 4 * 86_400)).toEqual([[]]);
    expect(await at(T + 5 * 86_400 - 3_600)).toEqual([["adoptStake"]]);
  });

  it("an adoption the chain reverted AdoptTooSoon or BelowMinAdoption after its simulation passed (another adoption, the surplus gone) waits, never a stop", async () => {
    for (const error of ["AdoptTooSoon", "BelowMinAdoption"]) {
      const w = quiet();
      w.vault.lastAdoptAt = BigInt(T - 2 * 86_400);
      w.vault.surplusStakeRao = 5_000_000n;
      w.fate = (c) => (c.fn === "adoptStake" ? "revert" : "mine");
      w.fns.push(...(parseAbi(["function adoptStake()"]) as unknown as AbiFunction[]));
      w.answers[`${lower(ADDR.vault)}:adoptStake`] = () => {
        throw revertWith(error);
      };
      const e = await adoptV32(depsFor(w).deps, t).catch((x: unknown) => x);
      expect(e, error).toBeInstanceOf(Waits);
      expect((e as Error).message).toMatch(new RegExp(`\\(${error}\\); transaction 0x[0-9a-f]{64} reverted on chain`));
    }
  });
});

describe("the rails, readiness and the spend cap apply: claims and adoptions are sends, not exceptions", () => {
  /** A claim and an adoption both due. */
  function bothDue(): World {
    const w = quiet();
    dueOnStake(w);
    w.vault.surplusStakeRao = 5_000_000n;
    w.vault.lastAdoptAt = BigInt(T - 2 * 86_400);
    return w;
  }

  it("claimsAreStoppedByAHold: under a hold nothing is sent and the claims aren't even read; once it clears, the adoption then the claim go", async () => {
    const w = bothDue();
    w.monitor.hold = ["h-1"];
    const r = await rounds(w, 2);
    expect(r.sent).toEqual([[], []]);
    expect(w.creditReads).toEqual([]);
    expect(w.calls.filter((c) => ["hotkeys", "surplusStakeRao", "lastAdoptAt"].includes(c.fn))).toEqual([]);
    w.monitor.hold = [];
    const s = await rounds(w, 2, { saved: r.saved, journal: r.journal, from: T + 120 });
    expect(s.sent).toEqual([["adoptStake"], ["claimRewards 0x11"]]);
  });

  it("at the one send path too: a one-shot claim or adoption under a hold is refused (SendRefused rails), a wait", async () => {
    const w = bothDue();
    w.monitor.hold = ["h-1"];
    for (const run of [() => claimV32(depsFor(w).deps, t, HK_STAKE, POLICY), () => adoptV32(depsFor(w).deps, t)]) {
      const e = await run().catch((x: unknown) => x);
      expect((e as SendRefused).reason).toBe("rails");
      expect(classifyFailure(e).stop).toBe(false);
    }
    expect(w.sends).toEqual([]);
  });

  it("readiness: the live checks run before them as before every v3.2 send (keeper() not the key: nothing read or sent); the deployment's keeper is no gate (R4, D-M1: after a rotation it is the plan's first)", async () => {
    const w = bothDue();
    w.vault.keeper = at("bad");
    const m = freshMemory();
    const r = await runRound(depsFor(w, m).deps, t, m, { ...OPTS, now: () => T * 1000 });
    expect(r.end?.kind).toBe("not-ready");
    expect(w.sends).toEqual([]);
    expect(w.creditReads).toEqual([]);
    // a deployment naming another keeper while keeper() names the key: the round runs, and claims
    const rotated = bothDue();
    const m2 = freshMemory();
    const r2 = await runRound(depsFor(rotated, m2, deploymentFor({ keeper: at("bad") })).deps, targetV32(deploymentFor({ keeper: at("bad") })), m2, { ...OPTS, now: () => T * 1000 });
    expect(r2.end?.kind).not.toBe("not-ready");
    expect(rotated.sends.some((x) => x.fn === "adoptStake" || x.fn === "claimRewards")).toBe(true);
    void KeeperNotReady;
    void claimV32;
    void adoptV32;
  });

  it("the cap fits a claim (the founder, 2026-11-08): Bittensor's cap must hold one claim's worst case at the fee cap now plus a day of payouts and stakes; under it, claims wait and the keeper says which setting to raise, at readiness and before each claim, never silently", async () => {
    // the default, 0.4 TAO (Task 51 fix round 2): a 57M claim and a day of payouts and stakes (15.5M gas since Task 65's
    // 2,000,000 reserve: four payouts of about 3.6M at two hotkeys, four stakes) fit up to about 5.5 gwei
    expect(SPEND_CAP_DEFAULT.bittensor).toBe(parseEther("0.4"));
    expect(DAY_OF_SENDS_GAS).toBe(15_500_000n);
    expect(claimFitProblem(SPEND_CAP_DEFAULT.bittensor, 55_000_000n, 5_500_000_000n)).toBeUndefined();
    expect(claimFitProblem(SPEND_CAP_DEFAULT.bittensor, 55_000_000n, 6n * 10n ** 9n)).toMatch(/need 0\.435 TAO/);
    // at today's 5 gwei: a 57M claim (0.285 TAO) and the day (0.0775 TAO) need 0.3625 TAO, inside 0.4 and over 0.35
    expect(claimFitProblem(SPEND_CAP_DEFAULT.bittensor, 55_000_000n, 5n * 10n ** 9n)).toBeUndefined();
    expect(claimFitProblem(parseEther("0.35"), 55_000_000n, 5n * 10n ** 9n)).toMatch(/need 0\.3625 TAO/);
    // Task 65, at the higher bound: claimGasRequired raised to the vault's top, 63.4M, is a 64.9M claim (the
    // per-transaction ceiling); with the day it needs 0.402 TAO at 5 gwei, over the 0.4 default, so claims wait and say so
    expect(claimFitProblem(SPEND_CAP_DEFAULT.bittensor, 63_400_000n, 5n * 10n ** 9n)).toBe(
      "Bittensor's 24 h spend cap (0.4 TAO) can't fit a claim: one claim's worst case at the fee cap now (a 64,900,000 gas limit at 5 gwei: 0.3245 TAO) and a day of payouts and stakes (15,500,000 gas: 0.0775 TAO) need 0.402 TAO; raise OPS_KEEPER_SPEND_CAP_BITTENSOR to at least 0.402 TAO",
    );
    // a cap that holds a claim but not the day beside it does not fit (at 1 gwei: 0.057 TAO and 0.0155 TAO)
    expect(claimFitProblem(parseEther("0.06"), 55_000_000n, 10n ** 9n)).toMatch(/need 0.0725 TAO; raise OPS_KEEPER_SPEND_CAP_BITTENSOR to at least 0.0725 TAO$/);
    expect(claimFitProblem(parseEther("0.0725"), 55_000_000n, 10n ** 9n)).toBeUndefined();
    // at 10 gwei it can't, and says so
    expect(claimFitProblem(parseEther("0.35"), 55_000_000n, 10n ** 10n)).toBe(
      "Bittensor's 24 h spend cap (0.35 TAO) can't fit a claim: one claim's worst case at the fee cap now (a 57,000,000 gas limit at 10 gwei: 0.57 TAO) and a day of payouts and stakes (15,500,000 gas: 0.155 TAO) need 0.725 TAO; raise OPS_KEEPER_SPEND_CAP_BITTENSOR to at least 0.725 TAO",
    );
    // in a round: said loudly once at readiness, the claim waits with the same words, and the keeper's other sends go on
    const w = quiet();
    dueOnStake(w);
    w.gasPrice = 10n ** 10n;
    const dep = deploymentFor({ spendCap: { base: 10n ** 18n, bittensor: parseEther("0.35") } });
    const r = await rounds(w, 3, {
      dep,
      between: (i) => {
        if (i === 1) {
          queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }], 9_900n);
          w.vault.balance = TAO + 10n ** 15n;
        }
      },
    });
    expect(r.lines.filter((l) => l.startsWith("CLAIMS CAN'T FIT: "))).toEqual([
      "CLAIMS CAN'T FIT: Bittensor's 24 h spend cap (0.35 TAO) can't fit a claim: one claim's worst case at the fee cap now (a 57,000,000 gas limit at 10 gwei: 0.57 TAO) and a day of payouts and stakes (15,500,000 gas: 0.155 TAO) need 0.725 TAO; raise OPS_KEEPER_SPEND_CAP_BITTENSOR to at least 0.725 TAO; until then no claim is sent",
    ]);
    expect(r.lines.filter((l) => l.startsWith("Rewards on hotkey 0x11111111…: a claim is due ("))).toEqual([expect.stringMatching(/, but it waits: Bittensor's 24 h spend cap \(0\.35 TAO\) can't fit a claim: .* need 0\.725 TAO; raise OPS_KEEPER_SPEND_CAP_BITTENSOR to at least 0\.725 TAO$/)]);
    expect(r.sent.flat().filter((f) => f.startsWith("claim"))).toEqual([]);
    expect(r.sent.flat()).toContain("processPayouts");
  });

  /** A journal with one landed Bittensor send today, of `costWei` */
  const spentToday = (costWei: bigint) => {
    const journal = journalOf();
    journal.rows.push({
      chain: "bittensor",
      from: KEY.address,
      nonce: 1,
      hashes: [`0x${"0d".repeat(32)}`],
      request: { chain: "bittensor", nonce: 1, label: "stake the vault's idle TAO", to: ADDR.vault, abi: [], functionName: "stakeIdle", args: [] },
      raw: "0x",
      status: "landed",
      at: T * 1000 - 3_600_000,
      receipt: { hash: `0x${"0d".repeat(32)}`, block: 1, gasUsed: 1n, costWei },
    });
    return journal;
  };

  it("M1: a claim whose worst case would bring the 24 h sum to the cap exactly waits (the cap reads at or over); a wei more of cap and it goes", async () => {
    // at 1 gwei: the fit needs 72.5M gas (Task 65's day of sends), 0.0725 TAO; a claim's worst case is 0.057 TAO; 0.0155 TAO
    // already spent today
    const run = async (cap: bigint) => {
      const w = quiet();
      dueOnStake(w);
      return (await rounds(w, 1, { journal: spentToday(parseEther("0.0155")), dep: deploymentFor({ spendCap: { base: 10n ** 18n, bittensor: cap } }) })).sent;
    };
    expect(await run(parseEther("0.0725"))).toEqual([[]]);
    expect(await run(parseEther("0.0725") + 1n)).toEqual([["claimRewards 0x11"]]);
  });

  it("the spend cap: a claim goes only with room under Bittensor's 24 h cap for its worst case (its 57M gas limit at the gas price), so a claim is never what stops the payouts", async () => {
    const run = async (cap: bigint, edit: (w: World) => void = () => undefined) => {
      const w = quiet();
      dueOnStake(w);
      edit(w);
      // a payout sent in the first round is paid out by the second
      const between = (i: number) => {
        if (i === 1) delete w.vault.batches[KEY_A.toLowerCase()];
      };
      return { w, r: await rounds(w, 2, { dep: deploymentFor({ spendCap: { base: 10n ** 18n, bittensor: cap } }), between, journal: spentToday(parseEther("0.02")) }) };
    };
    // the cap fits a claim (0.075 TAO, against the 0.0725 a claim and a day need at 1 gwei), but 0.02 TAO spent today and
    // the claim's 0.057 TAO worst case would reach it: the claim waits, said once; a payout due beside it still goes
    const a = await run(parseEther("0.075"), (w) => {
      queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }]);
      w.vault.balance = TAO + 10n ** 15n;
    });
    expect(a.r.sent).toEqual([["processPayouts"], []]);
    expect(a.r.lines.filter((l) => l.startsWith("Rewards on hotkey 0x11111111…: a claim is due ("))).toEqual([
      expect.stringMatching(
        /, but it waits: its worst case, 0\.057 TAO \(a 57,000,000 gas limit at the fee cap now\), would take Bittensor's 24 h spend over the keeper's 0\.075 TAO cap, which would stop the payouts: it waits until the cap has room for it \(OPS_KEEPER_SPEND_CAP_BITTENSOR\)$/,
      ),
    ]);
    // with room for it, it goes
    expect((await run(parseEther("0.08"))).r.sent).toEqual([["claimRewards 0x11"], []]);
  });

  it("the wallet must hold a claim's up-front fee (Bittensor takes the whole gas limit's, then refunds): else it waits, said once", async () => {
    const w = quiet();
    dueOnStake(w);
    w.balances[lower(KEY.address)] = 5n * 10n ** 16n;
    const r = await rounds(w, 2);
    expect(r.sent).toEqual([[], []]);
    expect(r.lines.filter((l) => l.includes("but it waits: a claim is sent with a 57,000,000 gas limit, so the wallet needs 0.057 TAO up front"))).toHaveLength(1);
  });
});

describe("a stuck claim is cancelled, never fee-bumped; a cancel of a stuck send goes through the spend cap, never through a hold (T51 re-review R1)", () => {
  /** A journal with one landed Bittensor send today, of `costWei` */
  const spent = (costWei: bigint) => {
    const journal = journalOf();
    journal.rows.push({
      chain: "bittensor",
      from: KEY.address,
      nonce: 1,
      hashes: [`0x${"0e".repeat(32)}`],
      request: { chain: "bittensor", nonce: 1, label: "stake the vault's idle TAO", to: ADDR.vault, abi: [], functionName: "stakeIdle", args: [] },
      raw: "0x",
      status: "landed",
      at: T * 1000 - 3_600_000,
      receipt: { hash: `0x${"0e".repeat(32)}`, block: 1, gasUsed: 1n, costWei },
    });
    return journal;
  };
  const capOf = (bittensor: bigint) => deploymentFor({ spendCap: { base: 10n ** 18n, bittensor } });
  /** The round that finds the watch due its replacement (REPLACE_AFTER_MS after the send), and the one after */
  const LATER = T + REPLACE_AFTER_MS / 1000 + 60;
  /** A claim due on the stake hotkey, sent, then stuck in the pool with no receipt (the claim's own fate: held) */
  async function stuckClaim(cap: bigint, journal = spent(0n)) {
    const w = quiet();
    dueOnStake(w);
    w.pooled = true;
    w.fate = (c) => (c.fn === "claimRewards" ? "hold" : "mine");
    const r = await rounds(w, 1, { journal, dep: capOf(cap) });
    expect(r.sent).toEqual([["claimRewards 0x11"]]);
    return { w, r, journal };
  }
  const cancels = (w: World) => w.sends.filter((s) => s.fn === "transfer");
  const signed = (journal: ReturnType<typeof journalOf>, chain = "bittensor") => {
    const row = journal.rows.find((x) => x.chain === chain && x.request.functionName !== "stakeIdle") as (typeof journal.rows)[number];
    return { row, tx: parseTransaction(row.raw) };
  };

  it("a stuck claim at the cap is cancelled, not bumped: a 21,000-gas transfer of nothing to the keeper at the same nonce, at the lowest replacement fee; once it lands, the chain's other sends resume", async () => {
    // 0.012 TAO spent today: the claim's 0.057 TAO worst case (57M gas at 1 gwei) has room under 0.075
    const { w, r, journal } = await stuckClaim(parseEther("0.075"), spent(parseEther("0.012")));
    // then the cap is lowered under what is counted (0.069): Bittensor is capped, and a payout due waits on it
    const capped = capOf(parseEther("0.06"));
    queue(w, KEY_A, [{ user: ALICE, shares: TAO, assets: TAO }], 9_900n);
    w.vault.balance = TAO + 10n ** 15n;
    const s = await rounds(w, 1, { saved: r.saved, journal, dep: capped, from: T + 60 });
    expect(s.sent).toEqual([[]]);
    const c = await rounds(w, 1, { saved: s.saved, journal, dep: capped, from: LATER });
    expect(c.sent).toEqual([["transfer"]]);
    const [cancel] = cancels(w);
    expect([lower(cancel.to), cancel.value, cancel.gas, cancel.chain]).toEqual([lower(KEY.address), 0n, 21_000n, "bittensor"]);
    const { row, tx } = signed(journal);
    // at the claim's nonce, 12.5% over its 1 gwei (the least a node takes as a replacement), its row now counted at the cancel
    expect([row.nonce, tx.nonce, tx.gasPrice, row.status]).toEqual([5, 5, 1_125_000_000n, "cancelled"]);
    expect(c.lines).toContainEqual(expect.stringMatching(/^CANCELLING transaction 0x[0-9a-f]{64} \(claiming the rewards on hotkey 0x11111111…, nonce 5\): no receipt .* a claim is never sent again at a higher fee/));
    expect(c.lines).toContainEqual(expect.stringMatching(/^Replaced: claiming the rewards on hotkey 0x11111111… was cancelled at nonce 5 \(transaction 0x[0-9a-f]{64}\); the next round decides again$/));
    // the cancel landed: the sum is back under the cap, and the payout goes
    const d = await rounds(w, 1, { saved: c.saved, journal, dep: capped, from: LATER + 60 });
    expect(d.sent).toEqual([["processPayouts"]]);
    expect(w.sends.filter((x) => x.fn === "claimRewards")).toHaveLength(1);
  });

  it("a claim is never replaced by a higher-fee claim: on a chain with room it is cancelled too, and a stuck cancel is cancelled again", async () => {
    const { w, r, journal } = await stuckClaim(100n * TAO);
    w.fate = () => "hold";
    const c = await rounds(w, 1, { saved: r.saved, journal, from: LATER });
    // twice as long for the next (both chains' clocks with the keeper's, so the monitor still sees)
    const next = LATER + (2 * REPLACE_AFTER_MS) / 1000 + 60;
    w.time.base = next;
    w.time.bittensor = next;
    const e = await rounds(w, 1, { saved: c.saved, journal, from: next });
    expect([...c.sent, ...e.sent]).toEqual([["transfer"], ["transfer"]]);
    expect(w.sends.filter((x) => x.fn === "claimRewards")).toHaveLength(1);
    expect([...c.lines, ...e.lines].filter((l) => l.startsWith("REPLACING"))).toEqual([]);
    // the second cancel 12.5% over the first
    expect(parseTransaction(signed(journal).row.raw).gasPrice).toBe(1_265_625_000n);
  });

  it("a cancel goes through on a capped chain (its worst case is 21,000 gas, and it can only lower the sum), and is counted; a bump is refused there", async () => {
    const w = quiet();
    w.vault.balance = 10n * TAO;
    w.pooled = true;
    w.fate = (c) => (c.fn === "stakeIdle" ? "hold" : "mine");
    const journal = journalOf();
    const r = await rounds(w, 1, { journal });
    expect(r.sent).toEqual([["stakeIdle"]]);
    // Bittensor capped under the stake's pending worst case: the stuck stake is cancelled, never bumped
    const capped = capOf(10n ** 14n);
    const c = await rounds(w, 1, { saved: r.saved, journal, dep: capped, from: LATER });
    expect(c.sent).toEqual([["transfer"]]);
    expect(c.lines).toContainEqual(expect.stringMatching(/^CANCELLING transaction 0x[0-9a-f]{64} \(staking, nonce 5\): .*Bittensor is at its 24 h spend cap, where only a cancel goes/));
    const row = journal.rows.find((x) => x.request.functionName === "stakeIdle") as (typeof journal.rows)[number];
    expect([row.status, spentOf(row)]).toEqual(["cancelled", 200_000n * 10n ** 9n]);
    // at the send path itself: a bump on the capped chain is refused, a cancel is not
    const v = quiet();
    v.vault.balance = 10n * TAO;
    v.pooled = true;
    v.fate = (c) => (c.fn === "stakeIdle" ? "hold" : "mine");
    const vj = journalOf();
    const vr = await rounds(v, 1, { journal: vj });
    const req = vj.rows[0].request;
    const { deps } = depsFor(v, loadMemory(vr.saved).memory, capped, () => undefined, { journal: vj });
    const bump = await deps.replace?.(req, vj.rows[0].hashes).catch((x: unknown) => x);
    expect((bump as SendRefused).reason).toBe("spend-cap");
    const cancel = await deps.replace?.(req, vj.rows[0].hashes, { cancel: true }).catch((x: unknown) => x);
    expect(cancel).toMatchObject({ replaced: true, cancelled: true });
    expect(v.sends.map((x) => x.fn)).toEqual(["stakeIdle", "transfer"]);
  });

  it("never through a hold: under a hold a stuck claim stays pending and watched, nothing sent", async () => {
    const { w, r, journal } = await stuckClaim(100n * TAO);
    w.monitor.hold = ["h-1"];
    const c = await rounds(w, 1, { saved: r.saved, journal, from: LATER });
    expect(c.sent).toEqual([[]]);
    expect(c.lines.filter((l) => l.startsWith("CANCELLING") || l.startsWith("REPLACING"))).toEqual([]);
    expect(loadMemory(c.saved).memory.unreceipted).toHaveLength(1);
  });

  it("r2-a (T51 round-2 re-review, carried to Task 53): a stuck claim gone from every pool, its nonce still free, is cancelled at that nonce all the same, so a capped chain can't jam on it; a bump is never sent", async () => {
    const w = quiet();
    dueOnStake(w);
    // held, and in no node's pool: eth_getTransactionByHash knows nothing of it, and the wallet's mined nonce stays 5
    w.pooled = false;
    w.fate = (c) => (c.fn === "claimRewards" ? "hold" : "mine");
    const journal = spent(0n);
    const r = await rounds(w, 1, { journal, dep: capOf(100n * TAO) });
    expect(r.sent).toEqual([["claimRewards 0x11"]]);
    const c = await rounds(w, 1, { saved: r.saved, journal, from: LATER, dep: capOf(100n * TAO) });
    expect(c.sent).toEqual([["transfer"]]);
    const { row, tx } = signed(journal);
    // at the claim's own nonce, 12.5% over the node's price (there is no pooled fee to go over), the row counted at it
    expect([row.nonce, tx.nonce, tx.gasPrice, tx.gas, row.status]).toEqual([5, 5, 1_125_000_000n, 21_000n, "cancelled"]);
    expect(c.lines).toContainEqual(
      expect.stringMatching(/^Bittensor: none of transaction 0x[0-9a-f]{64} is in the node's pool any more and nonce 5 is still the wallet's next: it is cancelled there, so nothing can wait on it$/),
    );
    // a replacement that isn't a cancel still waits for the wallet's nonce, as before (send.test.ts pins its words)
    const { deps } = depsFor(w, loadMemory(c.saved).memory, capOf(100n * TAO), () => undefined, { journal });
    w.nonce.bittensor.latest = 5;
    const bump = await deps.replace?.(row.request, [`0x${"77".repeat(32)}`]);
    expect(bump).toMatchObject({ replaced: false });
  });

  it("m1: the claim goes at the fee cap its room was checked at, or waits: a price that rose since the check refuses the send", async () => {
    const w = quiet();
    dueOnStake(w);
    // the claims' reading sees 1 gwei, the send 2 gwei
    w.gasPriceAt = (n) => (n === 1 ? 10n ** 9n : 2n * 10n ** 9n);
    const e = await claimV32(depsFor(w).deps, t, HK_STAKE, POLICY).catch((x: unknown) => x);
    expect((e as SendRefused).reason).toBe("fee");
    expect((e as Error).message).toBe("Bittensor: the fee cap now, 2 gwei, is above the 1 gwei the claim's room was checked at; claim the vault's rewards on hotkey 0x11111111… waits for the next reading; nothing sent");
    expect(classifyFailure(e).stop).toBe(false);
    expect(w.sends).toEqual([]);
    // steady: it goes, signed at the checked price
    const v = quiet();
    dueOnStake(v);
    const journal = journalOf();
    await claimV32(depsFor(v, freshMemory(), d, () => undefined, { journal }).deps, t, HK_STAKE, POLICY);
    expect(v.sends.map((x) => x.fn)).toEqual(["claimRewards"]);
    expect(journal.rows[0].request.maxFeeCap).toBe(10n ** 9n);
  });
});

describe("v3-launch's live keeper is unchanged: its run never claims", () => {
  it("v3LaunchNeverClaims: a claim due is reported, never sent, round after round; v3-launch's actions refuse a claim and an adoption", async () => {
    const rewards: RewardsRead = { hotkey: HK_STAKE, waitingWei: 2n * TAO, lastClaimAt: T - 86_400, now: T, taoPriceUsd: 400, claimGasRequired: 55_000_000n, gasPriceWei: 10n ** 10n, walletWei: TAO };
    const state: KeeperState = {
      now: T,
      frontDoor: { canClose: false, nDeposits: 0, nRedeems: 0, paused: false, openStart: T, batchInterval: 600, full: false, now: T },
      closeMaxWaitS: 0,
      alphaVault: { healthy: true },
      vault: { paused: false, available: 0n, minStakeWei: 2n * 10n ** 15n, rootStake: 0n, nominatorMinWei: 0n, batches: [], payoutDelay: 3600 },
      detail: { claimable: [] } as unknown as StatusDetail,
    };
    const lines: string[] = [];
    const sends: string[] = [];
    const deps = stubDeps({
      readState: async () => state,
      readRewards: async () => rewards,
      sendCall: async (r) => {
        sends.push(r.functionName);
        return SENT;
      },
      log: (l) => void lines.push(l),
    });
    const rec = v3Record();
    expect(launchTarget(rec).actions).toBeUndefined();
    let saved = encodeMemory(freshMemory());
    for (let i = 0; i < 5; i++) {
      const { memory } = loadMemory(saved);
      const r = await runRound(deps, launchTarget(rec), memory, { intervalMs: 60_000, policy: CLAIM_POLICY, rewardsEveryTicks: 1, now: () => (T + i * 60) * 1000 });
      expect(r.end).toBeUndefined();
      saved = encodeMemory(r.memory);
    }
    expect(sends).toEqual([]);
    expect(lines.filter((l) => l.startsWith("Rewards: a claim is due"))).toEqual([expect.stringMatching(/run never claims: claim by hand with pnpm ops claim$/)]);
    expect(loadMemory(saved).memory.reads).toEqual({});
    await expect(act(deps, rec, { kind: "claim", hotkey: HK_STAKE })).rejects.toThrow(/v3-launch's run never claims or adopts/);
    await expect(act(deps, rec, { kind: "adopt" })).rejects.toThrow(/v3-launch's run never claims or adopts/);
    expect(sends).toEqual([]);
  });
});

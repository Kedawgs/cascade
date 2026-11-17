import { reset } from "cloudflare:test";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type JournalRow } from "../../../ops/src/keeper/core/journal.ts";
import { fromJson } from "../../../ops/src/keeper/core/memory.ts";
import { HK_SECOND, HK_STAKE, RAO, TAO, type World } from "../../../ops/test/keeper-v32-world.ts";
import { chains, coordinator, keeperRun, started, testEnv } from "./harness.ts";

// Task 53 through the Worker: the hotkey watch and the buffer rule run from a cron round on the real core, their loud
// lines kept in the object's runs table (pnpm ops keeper status), and a swap's old hotkey freed by the Worker's own round,
// written ahead to its journal like every keeper send.

const quiet = { print: () => undefined };
const rows = async () => fromJson<JournalRow[]>(await coordinator().since({ sinceMs: 0 }));
const status = async () => fromJson<{ runs: { line: string }[] }>(await coordinator().status({ runs: 200 }));
const HK_NEW: Hex = `0x${"5e".repeat(32)}`;

/** A run's clock from `at` (ms): its waits move it */
const clockFrom = (at: number) => {
  let t = at;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

/** A validator's swap of the stake hotkey: its stake moves off the vault's list, and the vault reads stake missing. */
function swap(w: World) {
  const h = w.vault.hotkeys[0];
  w.vault.offList[HK_NEW.toLowerCase()] = h.stakeRao;
  w.vault.unlistedStakeRao = h.stakeRao;
  w.vault.visibleStakeRao -= h.stakeRao;
  h.stakeRao = 0n;
  w.vault.stakeMissing = true;
}

beforeEach(async () => {
  await reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Task 53's hotkey watch and buffer rule, from a Worker round", () => {
  it("stake missing, unlisted stake and the root hold's buffer rule are said, and kept in the runs table", async () => {
    chains((w) => {
      w.door.canClose = false;
      swap(w);
      w.rootHold = 7_200n;
    });
    await started();
    const r = await keeperRun(testEnv, { ...quiet, ...clockFrom(Date.now()) });
    expect(r.outcome, r.lines.join(" | ")).toBe("ran");
    const runs = (await status()).runs.map((x) => x.line);
    expect(runs.some((l) => l.startsWith("STAKE MISSING: 45 TAO of the vault's booked stake is not on its listed hotkeys"))).toBe(true);
    expect(runs.some((l) => l.startsWith("UNLISTED STAKE: 45 TAO of the vault's root stake"))).toBe(true);
    expect(runs.some((l) => l.startsWith("ROOT HOLD: Bittensor holds root stake 7200 blocks (about 24 hours)"))).toBe(true);
  });

  it("a swap's old hotkey is freed by the Worker's round once the owner's setStakeHotkey moved off it: removeHotkey(h, false), written ahead and landed", async () => {
    const c = chains((w) => {
      w.door.canClose = false;
    });
    await started();
    const t0 = Date.now();
    // run 1: nothing missing, the watch's baseline; run 2: the swap (missing, the old hotkey named); run 3: the new hotkey
    // listed and made the stake hotkey: the old one, empty with no credits, is freed
    const one = await keeperRun(testEnv, { ...quiet, ...clockFrom(t0) });
    expect(one.outcome, one.lines.join(" | ")).toBe("ran");
    swap(c.w);
    const two = await keeperRun(testEnv, { ...quiet, ...clockFrom(t0 + 120_000) });
    expect(two.lines).toContainEqual(expect.stringContaining(`it left hotkey ${HK_STAKE} (45 TAO before, 0 TAO now)`));
    c.w.vault.hotkeys.splice(c.w.vault.hotkeyCount, 0, { hotkey: HK_NEW, stakeRao: (45n * TAO) / RAO, credits: 0n, lastClaimAt: BigInt(c.w.time.bittensor) });
    c.w.vault.hotkeyCount++;
    c.w.vault.visibleStakeRao += (45n * TAO) / RAO;
    c.w.vault.unlistedStakeRao = 0n;
    c.w.vault.stakeMissing = false;
    c.w.vault.stakeHotkey = HK_NEW;
    const three = await keeperRun(testEnv, { ...quiet, ...clockFrom(t0 + 240_000) });
    expect(three.outcome, three.lines.join(" | ")).toBe("ran");
    expect(c.w.sends.map((x) => [x.fn, ...x.args.map(String)])).toEqual([["removeHotkey", HK_STAKE, "false"]]);
    expect((await rows()).map((x) => [x.request.functionName, x.status])).toEqual([["removeHotkey", "landed"]]);
    expect(c.w.vault.hotkeys.slice(0, c.w.vault.hotkeyCount).map((h) => h.hotkey).sort()).toEqual([HK_NEW, HK_SECOND].sort());
  });
});

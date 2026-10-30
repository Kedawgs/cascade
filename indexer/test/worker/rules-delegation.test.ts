import { type Hex, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { Finding } from "../../src/alerts.ts";
import { keysDelegated, roleWallets } from "../../src/rules/admin.ts";
import type { RuleCtx } from "../../src/rules/context.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import type { Snapshot } from "../../src/snapshot.ts";
import { baseState, bitState, reading, ruleCtx } from "./rule-ctx.ts";

// keys.delegated (critical, holds): a role wallet's code differs from the first code the monitor saw for it,
// on two readings in a row (one odd answer can't page): an account (no code) that shows an EIP-7702
// delegation designator (0xef0100 and 20 bytes), a delegation to another target, any code on an account, or a
// Safe whose code changed.

const OWNER = "0x00000000000000000000000000000000000000a1" as Hex;
const GUARDIAN = "0x00000000000000000000000000000000000000a2" as Hex;
const TREASURY = "0x00000000000000000000000000000000000000a4" as Hex;
const SAFE = "0x00000000000000000000000000000000005afe00" as Hex;
const delegation = (target: string) => `0xef0100${target.repeat(20)}` as Hex;
const SAFE_CODE = "0x608060405273ffffffffffffffffffffffffffffffffffffffff" as Hex;

/** Each tick's reading is at the next block. */
let block = 37_000_000n;

/** One tick's rule context: the role holders this reading names, and the code read for each. */
function ctx(codes: Record<Hex, Hex>, meta: Record<string, string> = {}): RuleCtx {
  block += 1n;
  const snap: Snapshot = {
    at: 1_800_000_000,
    nonces: { base: {}, bittensor: {} },
    safeNonces: {},
    messageStates: {},
    deliveredReads: [],
    base: reading(block, 1_800_000_000, baseState({ owner: SAFE, guardian: GUARDIAN, keeper: OWNER, stakerOwner: OWNER, stakerTreasury: TREASURY })),
    codes: { base: codes, bittensor: {} },
  };
  return ruleCtx({ snap, meta });
}

/** A finding's key, and its hold id: one per occurrence, by the codes before and after and the confirming block. */
const keyOf = (f: Finding, rule: string, address: Hex, before: Hex | null, now: Hex) =>
  `${rule}:base:${address}:${before === null ? "new" : keccak256(before).slice(0, 10)}:${keccak256(now).slice(0, 10)}:${f.facts.block}`;

/** Ticks of the rule, each reading `codes`, the meta each writes carried to the next: the last tick's findings. */
function ticks(reads: Record<Hex, Hex>[], meta: Record<string, string> = {}): { findings: Finding[]; meta: Record<string, string> } {
  let m = meta;
  let findings: Finding[] = [];
  for (const codes of reads) {
    const c = ctx(codes, m);
    findings = keysDelegated.run(c);
    m = { ...m, ...Object.fromEntries(c.writes.meta.map((w) => [w.k, w.v])) };
  }
  return { findings, meta: m };
}

describe("keys.delegated", () => {
  it("names every role wallet, the treasuries included", () => {
    expect(roleWallets(ctx({}).snap).map((w) => [w.chain, w.address, w.roles.join(",")])).toEqual([
      ["base", SAFE, "frontDoor.owner"],
      ["base", GUARDIAN, "frontDoor.guardian"],
      ["base", OWNER, "frontDoor.keeper,staker.owner"],
      ["base", TREASURY, "staker.treasury"],
    ]);
  });

  it("remembers the code it first sees, an account's or a Safe's, and finds nothing while it stays the same", () => {
    const all = { [OWNER]: "0x", [GUARDIAN]: "0x", [SAFE]: SAFE_CODE, [TREASURY]: "0x" } as Record<Hex, Hex>;
    const first = ctx(all);
    expect(keysDelegated.run(first)).toEqual([]);
    expect(first.writes.meta.map((w) => w.k).sort()).toEqual([`code_seen:base:${GUARDIAN}`, `code_seen:base:${OWNER}`, `code_seen:base:${SAFE}`, `code_seen:base:${TREASURY}`].sort());
    const later = ticks([all, all, all]);
    expect(later.findings).toEqual([]);
    // nothing written once the codes are known and unchanged
    const steady = ctx(all, later.meta);
    keysDelegated.run(steady);
    expect(steady.writes.meta).toEqual([]);
  });

  it("fires, with a hold, when an account shows a 7702 delegation on two readings, and again when its target changes", () => {
    const evil = delegation("ee");
    expect(ticks([{ [OWNER]: "0x" }, { [OWNER]: evil }]).findings).toEqual([]);
    const { findings, meta } = ticks([{ [OWNER]: "0x" }, { [OWNER]: evil }, { [OWNER]: evil }]);
    expect(findings).toHaveLength(1);
    const id = keyOf(findings[0], "keys.delegated", OWNER, "0x", evil);
    expect(findings[0]).toMatchObject({
      rule: "keys.delegated",
      key: id,
      hold: { id },
      facts: { address: OWNER, chain: "base", roles: "frontDoor.keeper, staker.owner", before: "no code (an account)", now: `an EIP-7702 delegation to 0x${"ee".repeat(20)}` },
    });
    expect(findings[0].facts.explorer).toBe(`https://basescan.org/address/${OWNER}`);
    // a hold id the owner's script takes (pnpm hold:clear --id)
    expect(id).toMatch(/^[a-z0-9_.:-]{1,200}$/);
    // found once: the new code is the baseline (the event alert stays open until acknowledged)
    expect(ticks([{ [OWNER]: evil }], meta).findings).toEqual([]);
    // a new target is a new critical
    const other = delegation("dd");
    const moved = ticks([{ [OWNER]: other }, { [OWNER]: other }], meta).findings;
    expect(moved.map((f) => [f.rule, f.key, f.facts.before])).toEqual([["keys.delegated", keyOf(moved[0], "keys.delegated", OWNER, evil, other), `an EIP-7702 delegation to 0x${"ee".repeat(20)}`]]);
  });

  it("makes a repeat of the same change a new occurrence: a fresh key and hold id each time", () => {
    const evil = delegation("ee");
    const first = ticks([{ [OWNER]: "0x" }, { [OWNER]: evil }, { [OWNER]: evil }]);
    const back = ticks([{ [OWNER]: "0x" }, { [OWNER]: "0x" }], first.meta);
    const again = ticks([{ [OWNER]: evil }, { [OWNER]: evil }], back.meta);
    expect(first.findings[0].key).not.toBe(again.findings[0].key);
    expect(first.findings[0].hold?.id).not.toBe(again.findings[0].hold?.id);
    expect(again.findings[0].key).toBe(keyOf(again.findings[0], "keys.delegated", OWNER, "0x", evil));
    // the warning in between has its own occurrence key too
    expect(back.findings[0].key).toBe(keyOf(back.findings[0], "keys.code_changed", OWNER, evil, "0x"));
  });

  it("confirms a delegation whose target switches every read, reporting the latest (a treasury isn't count-watched)", () => {
    const d1 = delegation("d1");
    const d2 = delegation("d2");
    const { findings } = ticks([{ [TREASURY]: "0x" }, { [TREASURY]: d1 }, { [TREASURY]: d2 }]);
    expect(findings.map((f) => [f.rule, f.key, f.facts.now])).toEqual([["keys.delegated", keyOf(findings[0], "keys.delegated", TREASURY, "0x", d2), `an EIP-7702 delegation to 0x${"d2".repeat(20)}`]]);
    // and when first seen switching too
    const fresh = ticks([{ [OWNER]: d1 }, { [OWNER]: d2 }]).findings;
    expect(fresh.map((f) => [f.rule, f.facts.before, f.facts.now])).toEqual([["keys.delegated", "not seen before", `an EIP-7702 delegation to 0x${"d2".repeat(20)}`]]);
  });

  it("ignores one odd read that the next contradicts", () => {
    expect(ticks([{ [SAFE]: SAFE_CODE }, { [SAFE]: "0x" }, { [SAFE]: SAFE_CODE }, { [SAFE]: SAFE_CODE }]).findings).toEqual([]);
  });

  it("is critical when a Safe's code changes to other contract code", () => {
    const { findings } = ticks([{ [SAFE]: SAFE_CODE }, { [SAFE]: "0x6080604052ff" }, { [SAFE]: "0x6080604052ff" }]);
    expect(findings.map((x) => [x.rule, x.facts.address, x.facts.before, x.facts.now, x.hold !== undefined])).toEqual([
      ["keys.delegated", SAFE, `contract code (26 bytes, hash ${keccak256(SAFE_CODE).slice(0, 10)}…)`, `contract code (6 bytes, hash ${keccak256("0x6080604052ff").slice(0, 10)}…)`, true],
    ]);
  });

  it("only warns when an account gains plain contract code (a counterfactual Safe deployed there; a key can't do that), and takes it as the baseline", () => {
    const { findings, meta } = ticks([{ [GUARDIAN]: "0x" }, { [GUARDIAN]: SAFE_CODE }, { [GUARDIAN]: SAFE_CODE }]);
    expect(findings).toEqual([
      expect.objectContaining({
        rule: "keys.code_changed",
        key: keyOf(findings[0], "keys.code_changed", GUARDIAN, "0x", SAFE_CODE),
        facts: expect.objectContaining({ before: "no code (an account)", now: `contract code (26 bytes, hash ${keccak256(SAFE_CODE).slice(0, 10)}…)` }),
      }),
    ]);
    expect(findings[0].hold).toBeUndefined();
    // now a contract: a later change of its code is critical
    expect(ticks([{ [GUARDIAN]: "0x6000" }, { [GUARDIAN]: "0x6000" }], meta).findings.map((f) => f.rule)).toEqual(["keys.delegated"]);
  });

  it("only warns when a delegation is removed, and a new delegation after is critical again", () => {
    const evil = delegation("ee");
    const delegated = ticks([{ [OWNER]: "0x" }, { [OWNER]: evil }, { [OWNER]: evil }]).meta;
    const removed = ticks([{ [OWNER]: "0x" }, { [OWNER]: "0x" }], delegated);
    expect(removed.findings.map((f) => [f.rule, f.facts.before, f.facts.now, f.hold])).toEqual([["keys.code_changed", `an EIP-7702 delegation to 0x${"ee".repeat(20)}`, "no code (an account)", undefined]]);
    expect(ticks([{ [OWNER]: evil }, { [OWNER]: evil }], removed.meta).findings.map((f) => f.rule)).toEqual(["keys.delegated"]);
  });

  it("fires for a role wallet already delegated when first seen (the monitor may start after the delegation)", () => {
    const evil = delegation("ee");
    const { findings } = ticks([{ [OWNER]: evil }, { [OWNER]: evil }]);
    expect(findings.map((x) => [x.key, x.facts.before])).toEqual([[keyOf(findings[0], "keys.delegated", OWNER, null, evil), "not seen before"]]);
  });

  it("judges nothing without a code read, and never the zero address", () => {
    expect(ticks([{}, {}]).findings).toEqual([]);
    const zero = { "0x0000000000000000000000000000000000000000": delegation("ee") } as Record<Hex, Hex>;
    expect(ticks([zero, zero]).findings).toEqual([]);
  });

  it("has the runbook lines asked for: first check whether it was your own smart-account upgrade, then pause and rotate", () => {
    const line = RUNBOOK["keys.delegated"]({});
    expect(line).toContain("A role wallet was delegated or its code changed.");
    const check = line.toLowerCase().indexOf("first check whether it was your own wallet's smart-account upgrade");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(line.indexOf("Guardian pauses; rotate the role."));
    expect(RUNBOOK["keys.code_changed"]({}).toLowerCase()).toContain("first check whether it was your own");
  });

  it("says a contract deployed at a role address by someone else is critical (as at Wintermute's Optimism address)", () => {
    const line = RUNBOOK["keys.code_changed"]({});
    expect(line).toContain("If you didn't deploy it, treat it as critical");
    expect(line).toContain("Wintermute");
  });
});

describe("the Bittensor side", () => {
  it("names the vault's role wallets and treasury", () => {
    const snap: Snapshot = {
      at: 1,
      nonces: { base: {}, bittensor: {} },
      safeNonces: {},
      messageStates: {},
      deliveredReads: [],
      bittensor: reading(1n, 1, bitState({ owner: OWNER, keeper: OWNER, treasury: TREASURY })),
    };
    expect(roleWallets(snap).map((w) => [w.chain, w.address, w.roles.join(",")])).toEqual([
      ["bittensor", OWNER, "vault.owner,vault.keeper"],
      ["bittensor", TREASURY, "vault.treasury"],
    ]);
  });
});

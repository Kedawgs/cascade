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

/** One tick's rule context: the role holders this reading names, and the code read for each. */
function ctx(codes: Record<Hex, Hex>, meta: Record<string, string> = {}): RuleCtx {
  const snap: Snapshot = {
    at: 1_800_000_000,
    nonces: { base: {}, bittensor: {} },
    safeNonces: {},
    messageStates: {},
    deliveredReads: [],
    base: reading(37_000_000n, 1_800_000_000, baseState({ owner: SAFE, guardian: GUARDIAN, keeper: OWNER, stakerOwner: OWNER, stakerTreasury: TREASURY })),
    codes: { base: codes, bittensor: {} },
  };
  return ruleCtx({ snap, meta });
}

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
    expect(findings[0]).toMatchObject({
      rule: "keys.delegated",
      key: `keys.delegated:base:${OWNER}:${keccak256(evil)}`,
      hold: { id: `keys.delegated:base:${OWNER}:${keccak256(evil)}` },
      facts: { address: OWNER, chain: "base", roles: "frontDoor.keeper, staker.owner", before: "no code (an account)", now: `an EIP-7702 delegation to 0x${"ee".repeat(20)}` },
    });
    expect(findings[0].facts.explorer).toBe(`https://basescan.org/address/${OWNER}`);
    // found every tick while it lasts (one alert), and a new target is a new alert
    expect(ticks([{ [OWNER]: evil }], meta).findings.map((f) => f.key)).toEqual([`keys.delegated:base:${OWNER}:${keccak256(evil)}`]);
    const other = delegation("dd");
    expect(ticks([{ [OWNER]: other }, { [OWNER]: other }], meta).findings.map((f) => f.key)).toEqual([`keys.delegated:base:${OWNER}:${keccak256(other)}`]);
  });

  it("ignores one odd read that the next contradicts", () => {
    expect(ticks([{ [SAFE]: SAFE_CODE }, { [SAFE]: "0x" }, { [SAFE]: SAFE_CODE }, { [SAFE]: SAFE_CODE }]).findings).toEqual([]);
  });

  it("fires when an account suddenly holds any code, and when a Safe's code changes", () => {
    const changed = { [GUARDIAN]: "0x6000", [SAFE]: "0x6080604052ff" } as Record<Hex, Hex>;
    const { findings } = ticks([{ [GUARDIAN]: "0x", [SAFE]: SAFE_CODE }, changed, changed]);
    expect(findings.map((x) => [x.facts.address, x.facts.before, x.facts.now])).toEqual([
      [SAFE, `contract code (26 bytes, hash ${keccak256(SAFE_CODE).slice(0, 10)}…)`, `contract code (6 bytes, hash ${keccak256("0x6080604052ff").slice(0, 10)}…)`],
      [GUARDIAN, "no code (an account)", `contract code (2 bytes, hash ${keccak256("0x6000").slice(0, 10)}…)`],
    ]);
  });

  it("fires for a role wallet already delegated when first seen (the monitor may start after the delegation)", () => {
    const evil = delegation("ee");
    const { findings } = ticks([{ [OWNER]: evil }, { [OWNER]: evil }]);
    expect(findings.map((x) => [x.key, x.facts.before])).toEqual([[`keys.delegated:base:${OWNER}:${keccak256(evil)}`, "not seen before"]]);
  });

  it("judges nothing without a code read, and never the zero address", () => {
    expect(ticks([{}, {}]).findings).toEqual([]);
    const zero = { "0x0000000000000000000000000000000000000000": delegation("ee") } as Record<Hex, Hex>;
    expect(ticks([zero, zero]).findings).toEqual([]);
  });

  it("has the runbook line asked for", () => {
    expect(RUNBOOK["keys.delegated"]({})).toContain("A role wallet was delegated or its code changed: assume its key is compromised. Guardian pauses; rotate the role.");
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

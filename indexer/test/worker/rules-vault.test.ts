import { type Hex, keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import type { StoredLog } from "../../src/logs.ts";
import { logQuery, type RuleCtx } from "../../src/rules/context.ts";
import { RULES } from "../../src/rules/ids.ts";
import { directUse, stakeMoved, VAULT_RULES } from "../../src/rules/vault.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import { TICK_RULES } from "../../src/tick.ts";
import { testConfig, tx } from "./fixtures.ts";
import { ruleCtx, slog } from "./rule-ctx.ts";

const h = (s: string) => keccak256(toBytes(s)) as Hex;
const cfg = testConfig();
const STAKE_HOTKEY = cfg.deployment.stakeHotkey;
const OTHER = h("another hotkey");
const OWNER = "0x00000000000000000000000000000000000000a1" as Hex;
const USER = "0x00000000000000000000000000000000000a11ce" as Hex;
const RAO = 10n ** 9n;
const E18 = 10n ** 18n;
/** after the fixture deployment's Bittensor baseline (6,900,040) */
const BLOCK = 6_900_100n;

/** Every log given is first stored by this tick, unless `stored` lists it as stored before. */
function ctx(o: { logs?: StoredLog[]; stored?: StoredLog[]; sender?: Hex; holdActive?: boolean; t?: Partial<typeof DEFAULTS> } = {}): RuleCtx {
  const txs = new Map((o.logs ?? []).map((l) => [`${l.chain}:${l.txHash}`, { chain: l.chain, hash: l.txHash, from: o.sender ?? OWNER }]));
  return ruleCtx({
    logs: logQuery([...(o.stored ?? []), ...(o.logs ?? [])]),
    newUids: new Set((o.logs ?? []).map((l) => l.uid)),
    txs: o.sender === undefined ? new Map() : txs,
    holdActive: o.holdActive ?? false,
    t: { ...DEFAULTS, ...o.t },
  });
}
const moved = (over: Partial<StoredLog["args"]> = {}, block = BLOCK) =>
  slog({ contract: "vault", event: "StakeMoved", block, txHash: tx(11), args: { from: OTHER, to: STAKE_HOTKEY, rao: String(5n * RAO), moved: String(5n * RAO - 1n), ...over } });

describe("vault.stake_moved", () => {
  it("is a warning for a move onto the configured stake hotkey, naming both hotkeys, the amounts and the sender", () => {
    const l = moved();
    const [f] = stakeMoved.run(ctx({ logs: [l], sender: OWNER }));
    expect(f).toMatchObject({ rule: "vault.stake_moved", key: `vault.stake_moved:${l.uid}` });
    expect(f.subject).toBe("The vault moved 5 TAO of stake onto its stake hotkey");
    expect(f.facts).toMatchObject({ from: OTHER, to: STAKE_HOTKEY, "configured stake hotkey": STAKE_HOTKEY, asked: "5000000000 rao", moved: "4999999999 rao", sender: OWNER, block: String(BLOCK) });
    expect(f.facts.transaction).toBe(`https://evm.taostats.io/tx/${tx(11)}`);
    expect(f.hold).toBeUndefined();
    expect(RULES["vault.stake_moved"]).toMatchObject({ tier: "warning", kind: "event" });
  });

  it("is critical when the stake went to a hotkey that isn't the configured stake hotkey", () => {
    const [f] = stakeMoved.run(ctx({ logs: [moved({ from: STAKE_HOTKEY, to: OTHER })] }));
    expect(f.rule).toBe("vault.stake_moved_unexpected");
    expect(f.subject).toBe("The vault moved 5 TAO of stake to a hotkey that isn't the configured stake hotkey");
    expect(f.facts.sender).toBe("not known yet");
    expect(RULES["vault.stake_moved_unexpected"]).toMatchObject({ tier: "critical", kind: "event" });
    expect(RUNBOOK["vault.stake_moved_unexpected"](f.facts)).toContain(OTHER);
  });

  it("is critical at or above stakeMoveCriticalRao (100 TAO by default), even onto the stake hotkey", () => {
    const big = moved({ rao: String(100n * RAO), moved: String(100n * RAO) });
    const [f] = stakeMoved.run(ctx({ logs: [big] }));
    expect(f.rule).toBe("vault.stake_moved_unexpected");
    expect(f.subject).toBe("The vault moved 100 TAO of stake, at or above the 100 TAO alert threshold");
    const under = moved({ rao: String(100n * RAO - 1n), moved: String(100n * RAO - 1n) });
    expect(stakeMoved.run(ctx({ logs: [under] }))[0].rule).toBe("vault.stake_moved");
    // the threshold follows THRESHOLDS
    expect(stakeMoved.run(ctx({ logs: [under], t: { stakeMoveCriticalRao: 5n * RAO } }))[0].rule).toBe("vault.stake_moved_unexpected");
  });

  it("reports each move once, on the tick it is first stored, and never the deployment's own setup", () => {
    expect(stakeMoved.run(ctx({ stored: [moved()] }))).toEqual([]);
    expect(stakeMoved.run(ctx({ logs: [moved({}, cfg.deployment.bittensor.baselineBlock)] }))).toEqual([]);
    expect(stakeMoved.run(ctx({ logs: [moved({}, cfg.deployment.bittensor.baselineBlock + 1n)] }))).toHaveLength(1);
  });
});

describe("vault.direct_use", () => {
  const deposit = (assets: bigint, block = BLOCK) => slog({ contract: "vault", event: "DepositedDirect", block, txHash: tx(12), args: { user: USER, assets: String(assets), shares: String(assets * 10n ** 6n) } });
  const redeem = (assets: bigint) => slog({ contract: "vault", event: "RedeemedDirect", block: BLOCK, txHash: tx(13), args: { user: USER, shares: String(assets * 10n ** 6n), assets: String(assets) } });
  const allowed = () => slog({ contract: "vault", event: "FrontDoorRedeemsAllowed", block: BLOCK, txHash: tx(14), args: { user: USER } });

  it("warns on a direct deposit, a direct redeem and an opt-in to front-door redeems (the launch expects none), naming the user", () => {
    const found = directUse.run(ctx({ logs: [deposit(E18), redeem(E18 / 2n), allowed()] }));
    expect(found.map((f) => [f.rule, f.subject])).toEqual([
      ["vault.direct_use", "A direct deposit of 1 TAO at the vault"],
      ["vault.direct_use", "A direct redeem of 0.5 TAO at the vault"],
      ["vault.direct_use", "A direct depositor opted back into front-door redeems"],
    ]);
    expect(found[0].facts).toMatchObject({ user: USER, assets: "1 TAO", shares: String(E18 * 10n ** 6n), hold: "off", block: String(BLOCK), transaction: `https://evm.taostats.io/tx/${tx(12)}` });
    expect(found[2].facts).toMatchObject({ user: USER });
    for (const f of found) expect(f.key).toBe(`vault.direct_use:${f.key.slice("vault.direct_use:".length)}`);
    expect(new Set(found.map((f) => f.key)).size).toBe(3);
    expect(RULES["vault.direct_use"]).toMatchObject({ tier: "warning", kind: "event", mutedByHold: false });
  });

  it("is critical at or above directCriticalWei (10 TAO by default), for a deposit and a redeem", () => {
    const [d, r] = directUse.run(ctx({ logs: [deposit(10n * E18), redeem(10n * E18)] }));
    expect([d.rule, d.subject]).toEqual(["vault.direct_use_large", "A direct deposit of 10 TAO at the vault, at or above the 10 TAO alert threshold"]);
    expect([r.rule, r.subject]).toEqual(["vault.direct_use_large", "A direct redeem of 10 TAO at the vault, at or above the 10 TAO alert threshold"]);
    expect(directUse.run(ctx({ logs: [deposit(10n * E18 - 1n)] }))[0].rule).toBe("vault.direct_use");
    expect(directUse.run(ctx({ logs: [deposit(E18)], t: { directCriticalWei: E18 } }))[0].rule).toBe("vault.direct_use_large");
    expect(RULES["vault.direct_use_large"]).toMatchObject({ tier: "critical", kind: "event", mutedByHold: false });
  });

  it("is critical for any direct deposit while a hold is on (the share price is in doubt), not for a redeem", () => {
    const found = directUse.run(ctx({ logs: [deposit(1n * RAO), redeem(E18)], holdActive: true }));
    expect(found.map((f) => [f.rule, f.subject, f.facts.hold])).toEqual([
      ["vault.direct_use_large", "A direct deposit of 0.000000001 TAO at the vault while a hold is on", "on"],
      ["vault.direct_use", "A direct redeem of 1 TAO at the vault", "on"],
    ]);
    expect(RUNBOOK["vault.direct_use_large"](found[0].facts)).toContain("pause()");
  });

  it("reports each event once, on the tick it is first stored, and never the deployment's own setup", () => {
    expect(directUse.run(ctx({ stored: [deposit(E18)] }))).toEqual([]);
    expect(directUse.run(ctx({ logs: [deposit(E18, cfg.deployment.bittensor.baselineBlock)] }))).toEqual([]);
  });
});

describe("the vault rules run in the tick", () => {
  it("are part of TICK_RULES, and each has a runbook line that names what to do", () => {
    for (const r of VAULT_RULES) expect(TICK_RULES).toContain(r);
    for (const id of ["vault.stake_moved", "vault.stake_moved_unexpected", "vault.direct_use", "vault.direct_use_large"] as const) {
      expect(RUNBOOK[id]({}).length).toBeGreaterThan(40);
    }
  });
});

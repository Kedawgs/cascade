import { type Hex, keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import type { StoredLog } from "../../src/logs.ts";
import { logQuery, type RuleCtx } from "../../src/rules/context.ts";
import { RULES } from "../../src/rules/ids.ts";
import { directUse, stakeMinRaised, stakeMissing, stakeMoved, stakeRemovalFee, stakeSurplusUnadopted, stakeUnstakeSkipped, VAULT_RULES, writeOffBoundOff, writeOffReadGas } from "../../src/rules/vault.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import { TICK_RULES } from "../../src/tick.ts";
import { testConfig, testConfigV32, tx } from "./fixtures.ts";
import { bitState, reading, ruleCtx, slog } from "./rule-ctx.ts";
import type { BitState } from "../../src/snapshot.ts";
import { utc } from "../../src/rules/context.ts";

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

  it("on v3.2 says what a direct deposit can't do any more: mint at a swap's depressed price (the stake guard refuses it); v3-launch's line is kept", () => {
    // v3-launch: a direct deposit at a depressed price mints shares cheaply
    const [v31] = directUse.run(ctx({ logs: [deposit(E18)] }));
    expect(v31.facts).not.toHaveProperty("contracts");
    expect(RUNBOOK["vault.direct_use"](v31.facts)).toContain("mints shares cheaply");
    // v3.2: refused while stake is missing, priced at the lower of the booked and visible stake
    const v32 = ruleCtx({ cfg: testConfigV32(), logs: logQuery([deposit(E18), deposit(20n * E18)]), newUids: new Set(), txs: new Map() });
    v32.newUids = new Set(v32.logs.all().map((l) => l.uid));
    const [small, large] = directUse.run(v32);
    expect(small.facts.contracts).toBe("v3.2");
    for (const [f, id] of [
      [small, "vault.direct_use"],
      [large, "vault.direct_use_large"],
    ] as const) {
      const line = RUNBOOK[id](f.facts);
      expect(line, id).not.toContain("mints shares cheaply");
      expect(line, id).toContain("refuses");
      expect(line, id).toContain("pause()");
    }
    expect(RUNBOOK["vault.direct_use"](small.facts)).not.toContain("allowFrontDoorRedeems");
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

// ---- v3.2 (Task 56): the stake guard, a surplus not adopted, repeated skips, the chain's minimum, the redeem origin ----

describe("v3.2's stake rules", () => {
  const cfg32 = testConfigV32();
  const HK = cfg32.deployment.stakeHotkey;
  const NEW = h("the swap's new hotkey");
  const SECOND = h("a second listed hotkey");
  const NOW = 1_800_000_000;
  const X = 49n * RAO;
  /** A v3.2 context: this tick's reading `s` (block 6,900,200), the stored ones `history` (newest first, older blocks). */
  function ctx32(o: { s?: Partial<BitState>; history?: Partial<BitState>[]; logs?: StoredLog[]; meta?: Record<string, string>; t?: Partial<typeof DEFAULTS>; noReading?: boolean; time?: number } = {}): RuleCtx {
    const base = ruleCtx({ cfg: cfg32 });
    const history = (o.history ?? []).map((x, i) => reading(6_900_195n - BigInt(i) * 5n, NOW - 60 * (i + 1), bitState(x)));
    return ruleCtx({
      cfg: cfg32,
      nowS: o.time ?? NOW,
      snap: { ...base.snap, at: NOW, bittensor: o.noReading ? undefined : reading(6_900_200n, o.time ?? NOW, bitState(o.s ?? {})) },
      history: { base: [], bittensor: history },
      previous: { bittensor: history[0] },
      logs: logQuery(o.logs ?? []),
      meta: o.meta ?? {},
      t: { ...DEFAULTS, ...o.t },
      blockTime: () => NOW - 600,
    });
  }
  const metaOf = (c: RuleCtx) => Object.fromEntries(c.writes.meta.map((w) => [w.k, w.v]));
  const marks = (c: RuleCtx) => c.unjudged.map((u) => u.key ?? u.rule);
  /** a healthy vault: HK and SECOND listed, all booked stake visible */
  const healthy: Partial<BitState> = { hotkeys: [HK, SECOND], stakes: { [HK]: X, [SECOND]: 2n * RAO }, rootStakeRao: X + 2n * RAO, bookedStake: X + 2n * RAO, stakeMissing: false, missingStakeRao: 0n };
  /** the swap: HK's stake moved to NEW, which the vault doesn't list */
  const swapped: Partial<BitState> = {
    ...healthy,
    stakes: { [HK]: 0n, [SECOND]: 2n * RAO, [NEW]: X },
    stakedHotkeys: [HK, SECOND, NEW],
    rootStakeRao: 2n * RAO,
    missingStakeRao: X,
    unlistedStakeRao: X,
    stakeMissing: true,
    minStakeRao: 2_000_000n,
  };

  describe("stake.missing", () => {
    it("is critical once two readings in a row read stakeMissing, naming the hotkey whose stake fell, by how much, and where stake now sits unlisted", () => {
      // one reading: not yet (one bad answer can't trip it), and that can't be told yet: unjudged
      const first = ctx32({ s: swapped, history: [healthy] });
      expect(stakeMissing.run(first)).toEqual([]);
      expect(marks(first)).toEqual([]);
      const unconfirmed = ctx32({ s: swapped, history: [] });
      expect(stakeMissing.run(unconfirmed)).toEqual([]);
      expect(marks(unconfirmed)).toEqual(["stake.missing"]);
      // the second: raised, the fall named from the last reading that wasn't missing, and remembered in meta
      const c = ctx32({ s: swapped, history: [swapped, healthy] });
      const [f] = stakeMissing.run(c);
      expect(RULES["stake.missing"]).toMatchObject({ tier: "critical", kind: "condition", canHold: false });
      expect(f).toMatchObject({ rule: "stake.missing", key: "stake.missing" });
      expect(f.subject).toBe(`Stake is missing: 49 TAO left hotkey ${HK.slice(0, 10)}…`);
      expect(f.facts).toMatchObject({
        missing: "49 TAO (49000000000 rao)",
        "the hotkey whose stake fell": `${HK}: 49 TAO before, 0 TAO now`,
        "stake on hotkeys the vault doesn't list": `${NEW}: 49 TAO (a stranger can list it: yes, if the vault never listed it)`,
        "booked stake": "51 TAO",
        "visible stake": "2 TAO",
        "hotkey set": "2 of 4",
        taostats: `https://taostats.io/hotkey/${HK}`,
      });
      expect(JSON.parse(metaOf(c).stake_missing_fell)).toEqual({ from: "6900190", fell: [{ hotkey: HK, before: String(X), after: "0" }] });
      // a later tick, every reading kept missing: the remembered fall still names it
      const later = ctx32({ s: swapped, history: [swapped, swapped], meta: metaOf(c) });
      expect(stakeMissing.run(later)[0].facts["the hotkey whose stake fell"]).toBe(`${HK}: 49 TAO before, 0 TAO now`);
      expect(metaOf(later)).toEqual({});
      const line = RUNBOOK["stake.missing"](f.facts);
      expect(line).toContain("addHotkey");
      expect(line).toContain("bridge.parked");
      // review Minor 2: the swap's own fall holds nothing, but a fall it doesn't explain still holds the keeper
      expect(line).toContain("stake.unexplained_drop");
    });

    it("says of each unlisted position whether a stranger can list it: yes if the vault never listed it, or no, below the chain's minimum (review Minor 4; T56 re-review Minor 1)", () => {
      const SMALL = h("a small position");
      const small = { ...swapped, stakes: { ...swapped.stakes, [SMALL]: 1_000_000n }, stakedHotkeys: [HK, SECOND, NEW, SMALL] };
      const [f] = stakeMissing.run(ctx32({ s: small, history: [small, healthy] }));
      expect(f.facts["stake on hotkeys the vault doesn't list"]).toBe(`${NEW}: 49 TAO (a stranger can list it: yes, if the vault never listed it); ${SMALL}: 0.001 TAO (a stranger can list it: no, below the chain's minimum of 0.002 TAO)`);
      const unread = { ...swapped, minStakeRao: undefined };
      const [g] = stakeMissing.run(ctx32({ s: unread, history: [unread, healthy] }));
      expect(g.facts["stake on hotkeys the vault doesn't list"]).toBe(`${NEW}: 49 TAO (a stranger can list it: not known, the chain's minimum isn't read)`);
    });

    it("clears on the first reading that isn't missing, and forgets the remembered fall", () => {
      const c = ctx32({ s: healthy, history: [swapped], meta: { stake_missing_fell: JSON.stringify({ from: "1", fell: [] }) } });
      expect(stakeMissing.run(c)).toEqual([]);
      expect(marks(c)).toEqual([]);
      expect(metaOf(c)).toEqual({ stake_missing_fell: "" });
    });

    it("says so when no reading kept shows the stake before it went missing", () => {
      const [f] = stakeMissing.run(ctx32({ s: swapped, history: [swapped] }));
      expect(f.facts["the hotkey whose stake fell"]).toBe("not known: stake was already missing in every reading kept");
      expect(f.subject).toBe("Stake is missing: 49 TAO of the vault's booked stake isn't on its hotkeys");
    });

    it("is unjudged, never quiet, without a reading or with stakeMissing unread", () => {
      for (const c of [ctx32({ noReading: true, history: [swapped] }), ctx32({ s: { ...swapped, stakeMissing: undefined }, history: [swapped] })]) {
        expect(stakeMissing.run(c)).toEqual([]);
        // stake.missing_small (R6) can't tell either
        expect(marks(c)).toEqual(["stake.missing_small", "stake.missing"]);
      }
    });

    it("R6 (ChatGPT R2 claim E): stake missing above dust but inside the vault's tolerance on two readings is the warning stake.missing_small: mints still run, at a price that leaves the gap out", () => {
      // 0.02 TAO of HK's stake swapped to NEW: under 0.1% of the 51 TAO booked, so stakeMissing() stays false
      const gap = 20_000_000n;
      const small: Partial<BitState> = { ...healthy, stakes: { [HK]: X - gap, [SECOND]: 2n * RAO, [NEW]: gap }, stakedHotkeys: [HK, SECOND, NEW], rootStakeRao: X + 2n * RAO - gap, missingStakeRao: gap, unlistedStakeRao: gap };
      expect(RULES["stake.missing_small"]).toMatchObject({ tier: "warning", kind: "condition", canHold: false });
      expect(stakeMissing.raises).toContain("stake.missing_small");
      // one reading: not yet
      expect(stakeMissing.run(ctx32({ s: small, history: [healthy] }))).toEqual([]);
      const [f] = stakeMissing.run(ctx32({ s: small, history: [small] }));
      expect(f).toMatchObject({ rule: "stake.missing_small", key: "stake.missing_small" });
      expect(f.subject).toBe("A little stake is missing: 0.02 TAO of the vault's booked stake isn't on its hotkeys");
      expect(f.facts).toMatchObject({
        missing: "0.02 TAO (20000000 rao)",
        "stake on hotkeys the vault doesn't list": `${NEW}: 0.02 TAO`,
        "booked stake": "51 TAO",
        "visible stake": "50.98 TAO",
      });
      const line = RUNBOOK["stake.missing_small"](f.facts);
      expect(line).toContain("addHotkey");
      expect(line).toMatch(/every deposit until then/);
      // R7 (L7): listing the hotkey closes the gap; adoptStake is only for a surplus above the booked
      expect(line).toContain("listing it closes the gap, since the stake there is the booked stake, seen again");
      expect(line).toContain("adoptStake has no part in it: it books only stake above the booked (a surplus)");
      expect(line).not.toContain("adoptStake books it");
      // dust (the chain's rounding) is quiet: at most stakeDustRao
      const dust = { ...healthy, missingStakeRao: DEFAULTS.stakeDustRao };
      expect(stakeMissing.run(ctx32({ s: dust, history: [dust] }))).toEqual([]);
      const over = { ...healthy, missingStakeRao: DEFAULTS.stakeDustRao + 1n };
      expect(stakeMissing.run(ctx32({ s: over, history: [over] })).map((x) => x.rule)).toEqual(["stake.missing_small"]);
      // past the tolerance it is stake.missing alone
      expect(stakeMissing.run(ctx32({ s: swapped, history: [swapped] })).map((x) => x.rule)).toEqual(["stake.missing"]);
      // missingStakeRao unread: unjudged, never quiet
      const unread = { ...healthy, missingStakeRao: undefined };
      const u = ctx32({ s: unread, history: [unread] });
      expect(stakeMissing.run(u)).toEqual([]);
      expect(marks(u)).toContain("stake.missing_small");
    });

    it("is v3.2's: on v3-launch it raises nothing (stake.divergence stays)", () => {
      const c = ruleCtx({ snap: { ...ruleCtx().snap, bittensor: reading(2n, NOW, bitState(swapped)) }, previous: { bittensor: reading(1n, NOW - 60, bitState(swapped)) } });
      expect(stakeMissing.run(c)).toEqual([]);
      expect(c.unjudged).toEqual([]);
    });
  });

  describe("stake.writeoff_read_gas (R6, ChatGPT R2 claim C)", () => {
    it("warns when the write-off's aggregate read costs more than writeOffReadGasWarn (10,000,000) on two readings in a row, saying how far the vault's 45,000,000 cap is", () => {
      expect(RULES["stake.writeoff_read_gas"]).toMatchObject({ tier: "warning", kind: "condition", canHold: false });
      expect(VAULT_RULES).toContain(writeOffReadGas);
      expect(DEFAULTS.writeOffReadGasWarn).toBe(10_000_000n);
      const costly: Partial<BitState> = { ...healthy, writeOffReadGas: 12_000_000n };
      expect(writeOffReadGas.run(ctx32({ s: costly, history: [healthy] }))).toEqual([]);
      const [f] = writeOffReadGas.run(ctx32({ s: costly, history: [costly] }));
      expect(f).toMatchObject({ rule: "stake.writeoff_read_gas", key: "stake.writeoff_read_gas" });
      expect(f.subject).toBe("The write-off's check of the unlisted stake costs 12,000,000 gas, of the vault's 45,000,000 cap");
      expect(f.facts).toMatchObject({ "the read's gas now": "12,000,000", "the vault's cap (WRITE_OFF_READ_GAS)": "45,000,000", "past the cap": "no", "warned above": "10,000,000" });
      const past = { ...healthy, writeOffReadGas: 46_000_000n };
      expect(writeOffReadGas.run(ctx32({ s: past, history: [past] }))[0].facts["past the cap"]).toBe("yes: a write-off's bound fails open; pnpm ops execute's check and the guardian's veto are what is left");
      const line = RUNBOOK["stake.writeoff_read_gas"](f.facts);
      expect(line).toContain("pnpm ops execute");
      expect(line).toMatch(/anyone can add/);
      // at the threshold or under: quiet; unread: unjudged
      const at = { ...healthy, writeOffReadGas: 10_000_000n };
      expect(writeOffReadGas.run(ctx32({ s: at, history: [at] }))).toEqual([]);
      const u = ctx32({ s: healthy, history: [healthy] });
      expect(writeOffReadGas.run(u)).toEqual([]);
      expect(marks(u)).toEqual(["stake.writeoff_read_gas"]);
    });
  });

  describe("stake.writeoff_bound_off (R11: ChatGPT r3, claim 1)", () => {
    const off: Partial<BitState> = { ...healthy, unlistedStakeFailed: true };
    const read: Partial<BitState> = { ...healthy, unlistedStakeRao: 0n, writeOffReadGas: 16_875n };
    it("pages when the lens's read of the unlisted stake, the write-off's bound, fails outright on two readings in a row: the vault's own capped read would read 0, so a write-off would run unbounded", () => {
      expect(RULES["stake.writeoff_bound_off"]).toMatchObject({ tier: "critical", kind: "condition", canHold: false });
      expect(VAULT_RULES).toContain(writeOffBoundOff);
      // one failed reading is not yet an alert
      expect(writeOffBoundOff.run(ctx32({ s: off, history: [read] }))).toEqual([]);
      const [f] = writeOffBoundOff.run(ctx32({ s: off, history: [off] }));
      expect(f).toMatchObject({ rule: "stake.writeoff_bound_off", key: "stake.writeoff_bound_off" });
      expect(f.subject).toBe("The vault's write-off bound can't be read: the lens's read of the unlisted stake fails");
      expect(f.facts).toMatchObject({
        "the lens read": "unlistedStakeRao() reverted (it totals the vault's coldkey with the staking precompile's getTotalColdkeyStakeOnSubnet, as the write-off's bound does)",
        "the read's gas estimate": "refused by the node too",
        "the vault's cap (WRITE_OFF_READ_GAS)": "45,000,000",
        block: "6900200",
      });
      // the estimate still answering is named
      expect(writeOffBoundOff.run(ctx32({ s: { ...off, writeOffReadGas: 1_234_567n }, history: [off] }))[0].facts["the read's gas estimate"]).toBe("1,234,567 gas");
      const line = RUNBOOK["stake.writeoff_bound_off"](f.facts);
      expect(line).toContain("pnpm ops pending --live");
      expect(line).toContain("pnpm ops cancel <id> --as guardian --for-wallet --live");
      expect(line).toMatch(/runtime/);
      expect(line).toMatch(/refuses/);
    });

    it("R12d (L-3): pages too when the read answers but costs more gas than the vault gives it (WRITE_OFF_READ_GAS) on two readings in a row: the vault's own capped read fails and reads 0 the same", () => {
      const costly: Partial<BitState> = { ...healthy, unlistedStakeRao: 0n, writeOffReadGas: 46_000_000n };
      // one reading over the cap is not yet an alert; two are
      expect(writeOffBoundOff.run(ctx32({ s: costly, history: [read] }))).toEqual([]);
      const [f] = writeOffBoundOff.run(ctx32({ s: costly, history: [costly] }));
      expect(f).toMatchObject({ rule: "stake.writeoff_bound_off", key: "stake.writeoff_bound_off" });
      expect(f.subject).toBe("The vault's write-off bound is off: its read of the unlisted stake costs 46,000,000 gas, over the vault's 45,000,000 cap");
      expect(f.facts).toMatchObject({
        "the lens read": "unlistedStakeRao() answers, but the read costs more gas than the vault gives it, so the vault's own capped read fails and reads 0",
        "the read's gas estimate": "46,000,000 gas",
        "the vault's cap (WRITE_OFF_READ_GAS)": "45,000,000",
      });
      const line = RUNBOOK["stake.writeoff_bound_off"](f.facts);
      expect(line).toContain("costs more gas than the 45,000,000 the vault gives it");
      expect(line).toContain("pnpm ops cancel <id> --as guardian --for-wallet --live");
      expect(line).not.toContain("unlistedStakeRao() reverts");
      // a failed reading and one over the cap: two readings the bound is off, an alert
      expect(writeOffBoundOff.run(ctx32({ s: costly, history: [off] }))).toHaveLength(1);
      // at the cap: quiet (the vault's call has exactly what it needs)
      const at = { ...healthy, unlistedStakeRao: 0n, writeOffReadGas: 45_000_000n };
      expect(writeOffBoundOff.run(ctx32({ s: at, history: [at] }))).toEqual([]);
    });

    it("quiet while the read answers; unjudged while it is unread (the lens unchecked or another vault's, no reading); nothing on v3-launch", () => {
      expect(writeOffBoundOff.run(ctx32({ s: read, history: [off] }))).toEqual([]);
      for (const s of [{ ...healthy, lensUnchecked: true }, healthy]) {
        const u = ctx32({ s, history: [off] });
        expect(writeOffBoundOff.run(u)).toEqual([]);
        expect(marks(u)).toEqual(["stake.writeoff_bound_off"]);
      }
      const none = ctx32({ noReading: true, history: [off] });
      expect(writeOffBoundOff.run(none)).toEqual([]);
      expect(marks(none)).toEqual(["stake.writeoff_bound_off"]);
      const launch = ruleCtx({ snap: { ...ruleCtx().snap, bittensor: reading(2n, NOW, bitState(off)) }, previous: { bittensor: reading(1n, NOW - 60, bitState(off)) } });
      expect(writeOffBoundOff.run(launch)).toEqual([]);
      expect(launch.unjudged).toEqual([]);
    });
  });

  describe("stake.surplus_unadopted", () => {
    const surplus = (over: Partial<BitState> = {}): Partial<BitState> => ({ ...healthy, surplusStakeRao: 2n * RAO, minStakeRao: 2_000_000n, lastAdoptAt: NOW - 3 * 86_400, paused: false, ...over });
    it("warns when a surplus of at least the chain's minimum has waited more than a day with adoption allowed, timed from its first sight", () => {
      expect(RULES["stake.surplus_unadopted"]).toMatchObject({ tier: "warning", kind: "condition" });
      const seen = ctx32({ s: surplus() });
      expect(stakeSurplusUnadopted.run(seen)).toEqual([]);
      expect(metaOf(seen)).toEqual({ surplus_since: String(NOW) });
      const day = ctx32({ s: surplus(), meta: { surplus_since: String(NOW - 86_400) } });
      expect(stakeSurplusUnadopted.run(day)).toEqual([]);
      const [f] = stakeSurplusUnadopted.run(ctx32({ s: surplus(), meta: { surplus_since: String(NOW - 86_401) } }));
      expect(f).toMatchObject({ rule: "stake.surplus_unadopted", key: "stake.surplus_unadopted", subject: "2 TAO of stake has waited more than a day to be adopted into the share price" });
      expect(f.facts).toMatchObject({ surplus: "2 TAO", "the chain's minimum": "0.002 TAO" });
      expect(RUNBOOK["stake.surplus_unadopted"](f.facts)).toContain("adoptStake");
    });

    it("waits while the vault's own daily bound holds adoption back, and an hour more for the keeper", () => {
      const m = { surplus_since: String(NOW - 2 * 86_400) };
      expect(stakeSurplusUnadopted.run(ctx32({ s: surplus({ lastAdoptAt: NOW - 86_400 - 3_600 }), meta: m }))).toEqual([]);
      expect(stakeSurplusUnadopted.run(ctx32({ s: surplus({ lastAdoptAt: NOW - 86_400 - 3_601 }), meta: m }))).toHaveLength(1);
    });

    it("forgets the surplus once it is below the minimum (adopted, or unstaked), and judges nothing while unread", () => {
      const gone = ctx32({ s: surplus({ surplusStakeRao: 1_999_999n }), meta: { surplus_since: String(NOW - 5 * 86_400) } });
      expect(stakeSurplusUnadopted.run(gone)).toEqual([]);
      expect(metaOf(gone)).toEqual({ surplus_since: "" });
      const unread = ctx32({ s: surplus({ surplusStakeRao: undefined }), meta: { surplus_since: String(NOW - 5 * 86_400) } });
      expect(stakeSurplusUnadopted.run(unread)).toEqual([]);
      expect(metaOf(unread)).toEqual({});
      expect(marks(unread)).toEqual(["stake.surplus_unadopted"]);
    });

    it("doesn't count the time the vault is paused (adoptStake is whenNotPaused; review Minor 7)", () => {
      const since = String(NOW - 2 * 86_400);
      // a pause first seen: its start remembered, nothing raised
      const first = ctx32({ s: surplus({ paused: true }), meta: { surplus_since: String(NOW - 43_200) } });
      expect(stakeSurplusUnadopted.run(first)).toEqual([]);
      expect(metaOf(first)).toEqual({ surplus_paused_at: String(NOW) });
      // seen two days ago, paused for the last day and a half: half a day counted, nothing raised
      const paused = ctx32({ s: surplus({ paused: true }), meta: { surplus_since: since, surplus_paused_at: String(NOW - 129_600) } });
      expect(stakeSurplusUnadopted.run(paused)).toEqual([]);
      expect(metaOf(paused)).toEqual({});
      // unpaused: the pause is added to the time not counted, still half a day counted
      const resumed = ctx32({ s: surplus(), meta: { surplus_since: since, surplus_paused_at: String(NOW - 129_600) } });
      expect(stakeSurplusUnadopted.run(resumed)).toEqual([]);
      expect(metaOf(resumed)).toEqual({ surplus_paused_s: "129600", surplus_paused_at: "" });
      // a day and a half counted since: raised, saying what wasn't counted
      const [f] = stakeSurplusUnadopted.run(ctx32({ s: surplus(), meta: { surplus_since: String(NOW - 3 * 86_400), surplus_paused_s: "129600" } }));
      expect(f).toMatchObject({ rule: "stake.surplus_unadopted", key: "stake.surplus_unadopted" });
      expect(f.facts["not counted"]).toBe("36 hours while the vault was paused");
      // forgotten together once the surplus is gone
      const gone = ctx32({ s: surplus({ surplusStakeRao: 0n }), meta: { surplus_since: since, surplus_paused_s: "129600", surplus_paused_at: String(NOW - 60) } });
      expect(stakeSurplusUnadopted.run(gone)).toEqual([]);
      expect(metaOf(gone)).toEqual({ surplus_since: "", surplus_paused_s: "", surplus_paused_at: "" });
      // the pause unread: unjudged, nothing written
      const unread = ctx32({ s: surplus({ paused: undefined }), meta: { surplus_since: since } });
      expect(stakeSurplusUnadopted.run(unread)).toEqual([]);
      expect(metaOf(unread)).toEqual({});
      expect(marks(unread)).toEqual(["stake.surplus_unadopted"]);
    });
  });

  describe("stake.unstake_skipped", () => {
    const skip = (hotkey: Hex, block: bigint) => slog({ contract: "vault", event: "UnstakeSkipped", block, args: { hotkey } });
    it("warns on a hotkey the walk skipped three times in a day, not on one skip", () => {
      expect(RULES["stake.unstake_skipped"]).toMatchObject({ tier: "warning", kind: "condition" });
      const one = ctx32({ logs: [skip(SECOND, BLOCK)] });
      expect(stakeUnstakeSkipped.run(one)).toEqual([]);
      expect(JSON.parse(metaOf(one).unstake_skips)).toEqual({ [SECOND]: [NOW - 600] });
      const m = { unstake_skips: JSON.stringify({ [SECOND]: [NOW - 7_200, NOW - 3_600] }) };
      const third = ctx32({ logs: [skip(SECOND, BLOCK)], meta: m, s: { rootUnlockInterval: 0n } });
      const [f] = stakeUnstakeSkipped.run(third);
      expect(f).toMatchObject({ rule: "stake.unstake_skipped", key: `stake.unstake_skipped:${SECOND}`, subject: `The vault's unstake skipped hotkey ${SECOND.slice(0, 10)}… 3 times in a day` });
      expect(f.facts).toMatchObject({ hotkey: SECOND, skips: "3 in the last 24 hours", "the last": utc(NOW - 600), taostats: `https://taostats.io/hotkey/${SECOND}` });
      expect(RUNBOOK["stake.unstake_skipped"](f.facts)).toContain("root.hold_interval");
    });

    it("lets skips older than a day age out, and clears then", () => {
      const m = { unstake_skips: JSON.stringify({ [SECOND]: [NOW - 90_000, NOW - 89_000, NOW - 600] }) };
      const c = ctx32({ meta: m });
      expect(stakeUnstakeSkipped.run(c)).toEqual([]);
      expect(JSON.parse(metaOf(c).unstake_skips)).toEqual({ [SECOND]: [NOW - 600] });
      // a skip stored before (not new) isn't counted again; the deployment's setup never is
      expect(stakeUnstakeSkipped.run(ruleCtx({ cfg: cfg32, logs: logQuery([skip(SECOND, BLOCK)]), newUids: new Set() }))).toEqual([]);
      const setup = ruleCtx({ cfg: cfg32, logs: logQuery([skip(SECOND, cfg32.deployment.bittensor.baselineBlock)]) });
      stakeUnstakeSkipped.run(setup);
      expect(setup.writes.meta).toEqual([]);
    });
  });

  describe("stake.min_raised", () => {
    it("warns once when the chain's minimum stake rises, naming the listed positions now below it", () => {
      expect(RULES["stake.min_raised"]).toMatchObject({ tier: "warning", kind: "event" });
      const c = ctx32({ s: { ...healthy, minStakeRao: 3n * RAO }, history: [{ ...healthy, minStakeRao: 2_000_000n }] });
      const [f] = stakeMinRaised.run(c);
      expect(f).toMatchObject({ rule: "stake.min_raised", key: `stake.min_raised:${3n * RAO}`, subject: "Bittensor's minimum stake rose from 0.002 TAO to 3 TAO" });
      expect(f.facts["listed positions below it"]).toBe(`${SECOND}: 2 TAO`);
      expect(RUNBOOK["stake.min_raised"](f.facts)).toContain("removeHotkey");
      // no rise, a fall, or either reading unread: nothing
      expect(stakeMinRaised.run(ctx32({ s: { ...healthy, minStakeRao: 2_000_000n }, history: [{ ...healthy, minStakeRao: 2_000_000n }] }))).toEqual([]);
      expect(stakeMinRaised.run(ctx32({ s: { ...healthy, minStakeRao: 1_000_000n }, history: [{ ...healthy, minStakeRao: 2_000_000n }] }))).toEqual([]);
      expect(stakeMinRaised.run(ctx32({ s: { ...healthy, minStakeRao: 3n * RAO }, history: [healthy] }))).toEqual([]);
      const none = stakeMinRaised.run(ctx32({ s: { ...healthy, minStakeRao: 3n * 10n ** 6n }, history: [{ ...healthy, minStakeRao: 2_000_000n }] }));
      expect(none[0].facts["listed positions below it"]).toBe("none");
    });

    it("compares with the last minimum known, kept in meta, so an unread reading next to the raise can't lose it (review Minor 3)", () => {
      // the first reading of it: remembered, nothing raised
      const seen = ctx32({ s: { ...healthy, minStakeRao: 2_000_000n } });
      expect(stakeMinRaised.run(seen)).toEqual([]);
      expect(JSON.parse(metaOf(seen).min_stake_known)).toEqual({ rao: "2000000", block: "6900200" });
      // unread: nothing raised, the known minimum kept
      const unread = ctx32({ s: { ...healthy, minStakeRao: undefined }, history: [{ ...healthy, minStakeRao: 2_000_000n }], meta: metaOf(seen) });
      expect(stakeMinRaised.run(unread)).toEqual([]);
      expect(metaOf(unread)).toEqual({});
      // the raise, next to the unread reading: still found, from the minimum known
      const known = { min_stake_known: JSON.stringify({ rao: "2000000", block: "6900190" }) };
      const raised = ctx32({ s: { ...healthy, minStakeRao: 3n * RAO }, history: [{ ...healthy, minStakeRao: undefined }], meta: known });
      const [f] = stakeMinRaised.run(raised);
      expect(f).toMatchObject({ key: `stake.min_raised:${3n * RAO}`, subject: "Bittensor's minimum stake rose from 0.002 TAO to 3 TAO" });
      expect(f.facts).toMatchObject({ before: "0.002 TAO", after: "3 TAO", from: "6900190", to: "6900200" });
      expect(JSON.parse(metaOf(raised).min_stake_known)).toEqual({ rao: String(3n * RAO), block: "6900200" });
      // the next tick: the new minimum known, nothing again
      const after = ctx32({ s: { ...healthy, minStakeRao: 3n * RAO }, history: [{ ...healthy, minStakeRao: 3n * RAO }], meta: metaOf(raised) });
      expect(stakeMinRaised.run(after)).toEqual([]);
      expect(metaOf(after)).toEqual({});
    });
  });

  describe("vault.direct_use on v3.2", () => {
    const at = (event: string, args: StoredLog["args"]) => slog({ contract: "vault", event, block: BLOCK, txHash: tx(15), args });
    it("warns on a RedeemOriginSet (setRedeemOrigin replaces allowFrontDoorRedeems), naming where the holder's shares can be redeemed", () => {
      const c = ctx32({ logs: [at("RedeemOriginSet", { user: USER, chain: "18446744073709551615" }), at("RedeemOriginSet", { user: USER, chain: "8453" })] });
      const found = directUse.run(c);
      expect(found.map((f) => [f.rule, f.subject])).toEqual([
        ["vault.direct_use", "A holder chose to redeem only directly on Bittensor"],
        ["vault.direct_use", "A holder chose to redeem through Base's front doors"],
      ]);
      expect(found[0].facts).toMatchObject({ user: USER, origin: "direct only (18446744073709551615)", event: "vault RedeemOriginSet", contracts: "v3.2" });
      expect(found[1].facts.origin).toBe("Base (8453)");
      expect(RUNBOOK["vault.direct_use"](found[0].facts)).toContain("setRedeemOrigin");
      expect(RUNBOOK["vault.direct_use"](found[0].facts)).toContain("RedeemSkipped");
    });

    it("says when a direct redeem accepted missing stake (paid at the lower of booked and visible stake)", () => {
      const [f] = directUse.run(ctx32({ logs: [at("RedeemedDirect", { user: USER, shares: "1", assets: String(E18), acceptedMissing: true })] }));
      expect(f.facts["accepted missing stake"]).toBe("yes: paid at the lower of the booked and visible stake (the leaver may be underpaid; the holders who stay never are)");
      const [g] = directUse.run(ctx32({ logs: [at("RedeemedDirect", { user: USER, shares: "1", assets: String(E18), acceptedMissing: false })] }));
      expect(g.facts["accepted missing stake"]).toBe("no");
    });
  });

  describe("stake.removal_fee: the chain charging a root removal fee (Task 36b, the leaver pays)", () => {
    const ROOT_TX = h("a payout round");
    const DIRECT_TX = h("a direct exit");
    const chunk = (unstakeCost: bigint, txHash = ROOT_TX) =>
      slog({ contract: "vault", event: "PayoutChunkSent", block: BLOCK, txHash, args: { key: h("payout key"), chunk: 0, taken: 3, gross: String(9n * E18), net: String(8n * E18), fee: String(10n ** 15n), charged: String(10n ** 15n), unstakeCost: String(unstakeCost) } });
    const unstaked = (wantRao: bigint, receivedWei: bigint, txHash = ROOT_TX) => slog({ contract: "vault", event: "Unstaked", block: BLOCK, txHash, args: { hotkey: HK, wantRao: String(wantRao), receivedWei: String(receivedWei) } });
    const absorbed = (amount: bigint, txHash = DIRECT_TX) => slog({ contract: "vault", event: "ShortfallAbsorbed", block: BLOCK, txHash, args: { amount: String(amount) } });

    it("is a warning event, in the tick, with a runbook line", () => {
      expect(RULES["stake.removal_fee"]).toMatchObject({ tier: "warning", kind: "event", canHold: false });
      expect(TICK_RULES).toContain(stakeRemovalFee);
      expect(RUNBOOK["stake.removal_fee"]({}).length).toBeGreaterThan(80);
    });

    it("reads a payout chunk's unstakeCost directly: any non-zero is the alert, the receipts named beside it", () => {
      expect(stakeRemovalFee.run(ctx32({ logs: [unstaked(5n * RAO, 5n * E18), chunk(0n)] }))).toEqual([]);
      const [f] = stakeRemovalFee.run(ctx32({ logs: [unstaked(5n * RAO, 5n * E18 - 7n * RAO), chunk(7n * RAO)] }));
      expect(f).toMatchObject({ rule: "stake.removal_fee", key: `stake.removal_fee:${ROOT_TX}`, facts: { "the chain kept": "0.000000007 TAO", "from": "a payout chunk's unstake (PayoutChunkSent.unstakeCost)", "the receipts show the chain kept": "0.000000007 TAO" } });
      expect(f.subject).toBe("The chain kept 0.000000007 TAO of an unstake: Bittensor may charge a root removal fee");
      expect(f.hold).toBeUndefined();
      // once: on the tick the logs are first stored
      expect(stakeRemovalFee.run(ctx32({ logs: [] }))).toEqual([]);
    });

    it("a direct exit within 1,000 rao of what was liquid (no unstake, no fee) raises nothing: its ShortfallAbsorbed is the untaken part", () => {
      // the walk needs more than SHORTFALL_TOLERANCE unmet to run (CascadeStakeLib.sol:77): no Unstaked, nothing kept
      expect(stakeRemovalFee.run(ctx32({ logs: [absorbed(1_000n * RAO)] }))).toEqual([]);
      expect(stakeRemovalFee.run(ctx32({ logs: [unstaked(2n * RAO, 2n * E18, DIRECT_TX), absorbed(500n * RAO)] }))).toEqual([]);
    });

    it("a short Unstaked raises (the chain kept part of what was asked), its ShortfallAbsorbed named beside it", () => {
      const [f] = stakeRemovalFee.run(ctx32({ logs: [unstaked(2n * RAO, 2n * E18 - 7n * RAO, DIRECT_TX), absorbed(7n * RAO)] }));
      expect(f).toMatchObject({
        rule: "stake.removal_fee",
        key: `stake.removal_fee:${DIRECT_TX}`,
        facts: { "the chain kept": "0.000000007 TAO", from: "a direct exit (ShortfallAbsorbed)", "the leaver bore": "0.000000007 TAO (at most 0.000001 TAO of it what the walk left untaken)", "the receipts show the chain kept": "0.000000007 TAO" },
      });
      expect(f.subject).toBe("The chain kept 0.000000007 TAO of an unstake: Bittensor may charge a root removal fee");
      // a short receipt alone, in a payout round, raises too
      const [g] = stakeRemovalFee.run(ctx32({ logs: [unstaked(5n * RAO, 4n * E18)] }));
      expect(g).toMatchObject({ key: `stake.removal_fee:${ROOT_TX}`, facts: { "the chain kept": "1 TAO", from: "an unstake's receipts (Unstaked)" } });
      expect(RUNBOOK["stake.removal_fee"](g.facts)).toContain("Bittensor kept part of a root unstake (1 TAO)");
    });

    it("a non-zero unstakeCost raises, though the receipts look whole (the position fell by more than was asked)", () => {
      const [f] = stakeRemovalFee.run(ctx32({ logs: [unstaked(5n * RAO, 5n * E18), chunk(3n * RAO)] }));
      expect(f).toMatchObject({ key: `stake.removal_fee:${ROOT_TX}`, facts: { "the chain kept": "0.000000003 TAO", "the receipts show the chain kept": "nothing" } });
    });

    it("a ShortfallAbsorbed above 1,000 rao raises: what the walk leaves untaken is at most that, so the rest is the chain's", () => {
      const [f] = stakeRemovalFee.run(ctx32({ logs: [unstaked(2n * RAO, 2n * E18, DIRECT_TX), absorbed(1_001n * RAO)] }));
      expect(f).toMatchObject({ key: `stake.removal_fee:${DIRECT_TX}`, facts: { "the chain kept": "at least 0.000000001 TAO", "the leaver bore": "0.000001001 TAO (at most 0.000001 TAO of it what the walk left untaken)", "the receipts show the chain kept": "nothing" } });
      expect(f.subject).toBe("A direct exit bore 0.000001001 TAO of its unstake's cost: Bittensor may charge a root removal fee");
    });

    it("never runs on v3-launch", () => {
      const l = chunk(7n * RAO);
      expect(stakeRemovalFee.run(ruleCtx({ logs: logQuery([l]), newUids: new Set([l.uid]) }))).toEqual([]);
    });
  });

  it("every new stake rule runs in the tick, with a runbook line", () => {
    for (const r of [stakeMissing, stakeSurplusUnadopted, stakeUnstakeSkipped, stakeMinRaised]) expect(TICK_RULES).toContain(r);
    for (const id of ["stake.missing", "stake.surplus_unadopted", "stake.unstake_skipped", "stake.min_raised"] as const) expect(RUNBOOK[id]({}).length).toBeGreaterThan(40);
  });
});

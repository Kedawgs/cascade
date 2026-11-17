import { encodeFunctionData, type Hex, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { SCHEDULABLE } from "../../src/abi.ts";
import type { Config } from "../../src/config.ts";
import { onset, type RuleCtx } from "../../src/rules/context.ts";
import { RULES } from "../../src/rules/ids.ts";
import { RAIL_RULES, railsIncoherent } from "../../src/rules/rails.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import { ITEMS_KEY, type TrackedItem } from "../../src/scheduler.ts";
import type { BaseState, BitState, Exits, RailHalf } from "../../src/snapshot.ts";
import { TICK_RULES } from "../../src/tick.ts";
import { testConfig, testConfigV32 } from "./fixtures.ts";
import { baseState, bitState, reading, ruleCtx } from "./rule-ctx.ts";

// rails.incoherent (Task 57c, from Task 39b's finding): each chain keeps its own bridges and primary, so the two can
// disagree while both read OPEN. The pairs: the front door's primary A (a Base adapter) and A's Bittensor peer A',
// which the vault must have enabled (its inbound check, CascadeBase._requireBridge); the vault's primary B and B's Base
// peer B', which the front door must know (its inbound check accepts any bridge it ever enabled, H-2 i). Either refused
// is incoherent; no launch door is not (other rules' findings). A primary disabled on its own side is moot only while
// that chain's exits read closed (admin.exits_state reports it), and only where nothing parks: the vault's disabled
// primary that the front door still sends through fires whatever the vault's exits, for the hold (Task 57c fix 1).

const NOW = 1_800_000_000;
const DAY = 86_400;
const cfg32 = testConfigV32();
const d = cfg32.deployment;
const BA = d.baseAdapter;
const TA = d.bitAdapter;
/** a second rail, N on Base and N' on Bittensor */
const N = "0x00000000000000000000000000000000000b2b2b" as Hex;
const N2 = "0x00000000000000000000000000000000000b1b1b" as Hex;
const STRANGER = "0x00000000000000000000000000000000000e7e7e" as Hex;
const BASE_ID = 8453n;
const BIT_ID = 964n;

/** A rail half: its peer on the other chain, that chain's id, and this chain's contract's enabled and known. */
/** The fields every half shares with the deploy's adapter on its chain (R4-O's fix round, Minor 8: ops' rail check's) */
const ROUTER = "0x00000000000000000000000000000000000c1c1c" as Hex;
const TOKEN = "0x00000000000000000000000000000000000c2c2c" as Hex;
/** the deploy's AlphaVault: the one the monitor's TOKENS names, whose migrationTarget() the snapshot reads (R4-O round 2) */
const ALPHA = cfg32.tokens.bittensor.alphaVault;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Hex;
const NEW_AV = "0x00000000000000000000000000000000000e1e1e" as Hex;
const OTHER = "0x00000000000000000000000000000000000c4c4c" as Hex;
const SETUP = { router: ROUTER, token: TOKEN, remoteSelector: 77n, alphaVault: ALPHA };
const half = (remote: Hex, remoteChainId: bigint, enabled: boolean, known = true): RailHalf => ({ remote, remoteChainId, enabled, known, ...SETUP });
const onBase = (remote: Hex, enabled: boolean, known = true) => half(remote, BIT_ID, enabled, known);
const onBit = (remote: Hex, enabled: boolean, known = true) => half(remote, BASE_ID, enabled, known);

/** A chain's exits as its lens reads them: OPEN (no hold, no clock moved; after a swap ended a guardian's hold, say), or
 * closed (the guardian disabled the primary a day ago). */
const OPEN: Exits = { open: true, ownerHold: false, guardianHold: false, primaryDisabledBy: 0, lastOwnerClose: 0, lastGuardianClose: 0 };
const CLOSED: Exits = { open: false, ownerHold: false, guardianHold: true, primaryDisabledBy: 2, lastOwnerClose: 0, lastGuardianClose: NOW - DAY };

/** Coherent rails: both sides on the launch rail (BA, TA), each half naming the other, both enabled, both chains OPEN. */
const base0 = (o: Partial<BaseState> = {}): Partial<BaseState> => ({ primaryBridge: BA, exits: OPEN, rails: { [BA]: onBase(TA, true) }, ...o });
const bit0 = (o: Partial<BitState> = {}): Partial<BitState> => ({ primaryBridge: TA, doorState: 1, exits: OPEN, rails: { [TA]: onBit(BA, true) }, deployAlpha: { vault: ALPHA, migrationTarget: ZERO_ADDR, migrationFinished: false }, ...o });

/** A pending activateBridge(bridge) on a chain's scheduler, as the record keeps it and the lens reads it (a Reopen for a
 * bridge the contract enabled before: kind 2), ready at NOW + 2 days. */
function pendingActivation(chain: "base" | "bittensor", bridge: Hex) {
  const role = chain === "base" ? "frontDoor" : "vault";
  const data = encodeFunctionData({ abi: SCHEDULABLE[role], functionName: "activateBridge", args: [bridge] } as never).toLowerCase() as Hex;
  const id = keccak256(data);
  const readyAt = NOW + 2 * DAY;
  const item: TrackedItem = { chain, role, id, kind: 2, selector: data.slice(0, 10) as Hex, readyAt, data, setter: "activateBridge", args: { bridge }, canonical: true, uid: id, block: "6900100", tx: id };
  const scheduled = { [id]: { scheduledAt: readyAt - 7 * DAY, readyAt, class: 1, kind: 2, selector: item.selector, readyBlock: 6_950_000n } };
  return { item, scheduled, meta: { [ITEMS_KEY]: JSON.stringify([item]) } };
}

/** A v3.2 context: both chains read now, on the tick before (the same state unless given; null for none) and, when
 * `before` is given, on the one before that (for onset). */
function ctx(o: {
  base?: Partial<BaseState> | null;
  bit?: Partial<BitState> | null;
  prevBase?: Partial<BaseState> | null;
  prevBit?: Partial<BitState> | null;
  before?: { base: Partial<BaseState>; bit: Partial<BitState> };
  meta?: Record<string, string>;
  cfg?: Config;
}): RuleCtx {
  const base = o.base === null ? undefined : baseState(o.base ?? base0());
  const bit = o.bit === null ? undefined : bitState(o.bit ?? bit0());
  const prevBase = o.prevBase === null ? undefined : o.prevBase ? baseState(o.prevBase) : base;
  const prevBit = o.prevBit === null ? undefined : o.prevBit ? bitState(o.prevBit) : bit;
  const history = {
    base: [...(prevBase ? [reading(37_000_299n, NOW - 2, prevBase)] : []), ...(o.before ? [reading(37_000_298n, NOW - 4, baseState(o.before.base))] : [])],
    bittensor: [...(prevBit ? [reading(6_900_299n, NOW - 12, prevBit)] : []), ...(o.before ? [reading(6_900_298n, NOW - 24, bitState(o.before.bit))] : [])],
  };
  return ruleCtx({
    cfg: o.cfg ?? cfg32,
    nowS: NOW,
    snap: {
      at: NOW,
      base: base ? reading(37_000_300n, NOW, base) : undefined,
      bittensor: bit ? reading(6_900_300n, NOW, bit) : undefined,
      nonces: { base: {}, bittensor: {} },
      safeNonces: { base: {}, bittensor: {} },
      messageStates: {},
      deliveredReads: [],
    },
    previous: { base: history.base[0], bittensor: history.bittensor[0] },
    history,
    meta: o.meta ?? {},
  });
}
const unjudgedOf = (c: RuleCtx) => c.unjudged.map((u) => (u.key ? `${u.rule} ${u.key}` : u.rule));
const run = (c: RuleCtx) => railsIncoherent.run(c);
const BATCHES = "rails.incoherent:batches";
const PAYOUTS = "rails.incoherent:payouts";

/** The vault switched its primary alone, to N' (activated beside N on the front door): the launch rail's Bittensor
 * half, TA, which the front door still sends through, is disabled on the vault (Task 39b's shrunk sequence). */
const vaultAlone = {
  base: base0({ rails: { [BA]: onBase(TA, true), [N]: onBase(N2, true) } }),
  bit: bit0({ primaryBridge: N2, rails: { [TA]: onBit(BA, false), [N2]: onBit(N, true) } }),
};

describe("rails.incoherent", () => {
  it("is a critical condition that can hold, runs every tick, and its runbook line says what to do in plain words", () => {
    expect(RULES["rails.incoherent"]).toEqual({ tier: "critical", kind: "condition", canHold: true, mutedByHold: false });
    expect(RAIL_RULES).toContain(railsIncoherent);
    expect(TICK_RULES).toContain(railsIncoherent);
    for (const direction of ["batches", "payouts", undefined]) {
      const line = RUNBOOK["rails.incoherent"](direction ? { direction } : {});
      expect(line).toContain("The two chains disagree on the bridge");
      expect(line).toContain("Finish the two-sided switch, or switch the other side back.");
      expect(line).toContain("A guardian can't fix it alone");
      expect(line).toContain("clear the hold");
    }
    expect(RUNBOOK["rails.incoherent"]({ direction: "batches" })).toContain("deposits from Base are refused and parked");
    expect(RUNBOOK["rails.incoherent"]({ direction: "payouts" })).toContain("payouts to Base are refused");
  });

  it("is quiet on coherent rails, and judges both pairs", () => {
    const c = ctx({});
    expect(run(c)).toEqual([]);
    expect(c.unjudged).toEqual([]);
    // each side on its own rail, each pair carried: the front door on N (N' enabled on the vault), the vault on TA (BA
    // known to the front door, though disabled there: it takes payouts from any bridge it ever enabled)
    const split = ctx({
      base: base0({ primaryBridge: N, rails: { [N]: onBase(N2, true), [BA]: onBase(TA, false) } }),
      bit: bit0({ rails: { [TA]: onBit(BA, true), [N2]: onBit(N, true) } }),
    });
    expect(run(split)).toEqual([]);
    expect(split.unjudged).toEqual([]);
  });

  it("fires when the front door's primary's Bittensor half isn't enabled on the vault (the vault switched alone), naming the pair, and holds", () => {
    const [f, ...rest] = run(ctx(vaultAlone));
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ rule: "rails.incoherent", key: BATCHES, subject: "The two chains disagree on the bridge: deposits from Base are refused and parked" });
    expect(f.facts).toMatchObject({
      direction: "batches",
      "the front door's primary bridge": BA,
      "its Bittensor half": TA,
      "on the vault": "disabled",
      "the vault's primary bridge": N2,
      "its Base half": N,
      "on the front door": "enabled",
      why: `the front door sends batches through ${BA}, and its Bittensor half ${TA} is disabled on the vault`,
      parked: `yes: each batch closed parks in ${TA}, refunded to Base after 14 days`,
      "pending to fix it": "none scheduled",
      "Base block": "37000300",
      "Bittensor block": "6900300",
    });
    // its first tick (the reading before last was coherent): the hold, keyed by the two readings before
    const first = run(ctx({ ...vaultAlone, before: { base: base0(), bit: bit0() } }))[0];
    expect(first.hold).toEqual({ id: `${BATCHES}:37000299:6900299`, summary: `the front door sends batches through ${BA}, which the vault refuses` });
  });

  it("fires when a guardian disables on the vault a non-primary bridge the front door still uses (a migration in progress)", () => {
    // the front door has moved to N, the vault is still on TA; the guardian disables N' on the vault (no hold, no stamp)
    const c = ctx({
      base: base0({ primaryBridge: N, rails: { [N]: onBase(N2, true), [BA]: onBase(TA, false) } }),
      bit: bit0({ rails: { [TA]: onBit(BA, true), [N2]: onBit(N, false) } }),
    });
    const out = run(c);
    expect(out.map((f) => f.key)).toEqual([BATCHES]);
    expect(out[0].facts.why).toBe(`the front door sends batches through ${N}, and its Bittensor half ${N2} is disabled on the vault`);
  });

  it("fires when the vault's primary's Base half was never enabled on the front door: payouts to Base are refused", () => {
    // the vault on N' (its Base half N never activated on the front door); the front door on the launch rail, whose
    // Bittensor half the vault re-enabled
    const base = base0({ rails: { [BA]: onBase(TA, true), [N]: onBase(N2, false, false) } });
    const bit = bit0({ primaryBridge: N2, rails: { [TA]: onBit(BA, true), [N2]: onBit(N, true) } });
    const out = run(ctx({ base, bit }));
    expect(out.map((f) => f.key)).toEqual([PAYOUTS]);
    expect(out[0]).toMatchObject({ subject: "The two chains disagree on the bridge: payouts to Base are refused" });
    expect(out[0].facts).toMatchObject({
      direction: "payouts",
      "the front door's primary bridge": BA,
      "its Bittensor half": TA,
      "on the vault": "enabled",
      "the vault's primary bridge": N2,
      "its Base half": N,
      "on the front door": "never enabled",
      why: `the vault sends payouts through ${N2}, and its Base half ${N} was never enabled on the front door`,
      "payouts sent": `fail in CCIP at ${N} until this is fixed (ccip.failure)`,
    });
    expect(out[0].facts).not.toHaveProperty("parked");
    expect(run(ctx({ base, bit, before: { base: base0(), bit: bit0() } }))[0].hold).toEqual({
      id: `${PAYOUTS}:37000299:6900299`,
      summary: `the vault sends payouts through ${N2}, which the front door refuses`,
    });
    // the vault switched alone to a rail the front door never knew: both pairs refused, each its own alert and hold
    const both = ctx({ base: base0({ rails: { [BA]: onBase(TA, true), [N]: onBase(N2, false, false) } }), bit: vaultAlone.bit });
    expect(run(both).map((f) => f.key)).toEqual([BATCHES, PAYOUTS]);
  });

  it("fires on a half that doesn't take its sender's messages, or a sender whose peer is on another chain", () => {
    // TA takes messages only from a stranger's adapter: every batch from BA fails at TA (WrongSender), nothing parks;
    // the payouts' Base half (the stranger's) isn't read on Base yet: can't see
    const back = ctx({ bit: bit0({ rails: { [TA]: onBit(STRANGER, true) } }) });
    const [b] = run(back);
    expect(b).toMatchObject({ key: BATCHES, subject: "The two chains disagree on the bridge: deposits from Base are refused" });
    expect(b.facts.why).toBe(`the front door sends batches through ${BA}, and its Bittensor half ${TA} takes messages only from ${STRANGER} on chain 8453`);
    expect(b.facts.parked).toBe(`no: each batch closed fails in CCIP at ${TA}`);
    expect(unjudgedOf(back)).toEqual([`rails.incoherent ${PAYOUTS}`]);
    // the same on the payouts' side: BA takes messages only from the stranger, so every payout from TA fails at BA
    const front = ctx({ base: base0({ rails: { [BA]: onBase(STRANGER, true) } }) });
    const [p] = run(front);
    expect(p.key).toBe(PAYOUTS);
    expect(p.facts.why).toBe(`the vault sends payouts through ${TA}, and its Base half ${BA} takes messages only from ${STRANGER} on chain 964`);
    expect(unjudgedOf(front)).toEqual([`rails.incoherent ${BATCHES}`]);
    // a half that names its sender on another chain: the receiving contract sees an unknown peer and refuses it
    const [c] = run(ctx({ bit: bit0({ rails: { [TA]: half(BA, 10n, true) } }) }));
    expect(c.facts.why).toBe(`the front door sends batches through ${BA}, and its Bittensor half ${TA} takes messages only from ${BA} on chain 10`);
    // BA sends to another chain: the front door's close reverts (WrongDestination), so no batch leaves
    const wrong = run(ctx({ base: base0({ rails: { [BA]: half(TA, 1n, true) } }) }));
    const w = wrong.find((f) => f.key === BATCHES)!;
    expect(w.facts.why).toBe(`the front door sends batches through ${BA}, which sends to chain 1, not the vault's (964)`);
    expect(w.facts.parked).toBe("no: every close reverts, so no batch leaves Base");
    expect(w.subject).toBe("The two chains disagree on the bridge: deposits from Base are refused");
    // what to do: the adapters' peers are immutables, so no switch back or activation fixes such a pair
    for (const f of [b, p, c, w]) {
      const line = RUNBOOK["rails.incoherent"](f.facts);
      expect(line, f.facts.why).toContain("The adapters' peers are fixed at deploy, so the only fix is to move both sides to a correct pair.");
      expect(line, f.facts.why).not.toContain("Finish the two-sided switch");
    }
  });

  it("doesn't fire on a primary disabled on its own side while that chain's exits read closed and nothing parks, nor with no launch door", () => {
    // the front door's primary disabled, its exits closed (admin.exits_state's): closes revert (PrimaryBridgeDisabled),
    // so no batch leaves and none parks; payouts still land (BA is known)
    const doorPrimary = ctx({ base: base0({ exits: CLOSED, rails: { [BA]: onBase(TA, false) } }) });
    expect(run(doorPrimary)).toEqual([]);
    expect(doorPrimary.unjudged).toEqual([]);
    // the vault's primary disabled, its exits closed, and the front door's primary disabled too (a switch, both disables
    // done): no payout leaves, and no batch leaves Base
    const vaultPrimary = ctx({
      base: base0({ exits: CLOSED, rails: { [BA]: onBase(TA, false), [N]: onBase(N2, true) } }),
      bit: bit0({ exits: CLOSED, rails: { [TA]: onBit(BA, false), [N2]: onBit(N, true) } }),
    });
    expect(run(vaultPrimary)).toEqual([]);
    expect(vaultPrimary.unjudged).toEqual([]);
    // no launch door (Removed, or never active): the vault refuses the door, and sends it no payout (other rules' finding)
    for (const doorState of [0, 2]) {
      const c = ctx({ base: vaultAlone.base, bit: { ...vaultAlone.bit, doorState } });
      expect(run(c), String(doorState)).toEqual([]);
      expect(c.unjudged).toEqual([]);
      // with no launch door, a primary disabled on an OPEN chain is no finding of this rule either
      for (const [side, o] of [
        ["the front door's", { base: base0({ rails: { [BA]: onBase(TA, false) } }), bit: bit0({ doorState }) }],
        ["the vault's", { bit: bit0({ doorState, rails: { [TA]: onBit(BA, false) } }) }],
      ] as const) {
        const d = ctx(o);
        expect(run(d), `${side} ${doorState}`).toEqual([]);
        expect(d.unjudged, `${side} ${doorState}`).toEqual([]);
      }
    }
  });

  it("doesn't fire through a two-sided switch done in order (runbook section 8): both new halves pending, both disables, the front door's first, then the vault's switch, then the front door's", () => {
    const steps: [string, Partial<BaseState>, Partial<BitState>][] = [
      // 1. activateBridge(N) and activateBridge(N') scheduled on both sides, pending (not yet enabled)
      ["both pending", base0({ rails: { [BA]: onBase(TA, true), [N]: onBase(N2, false, false) } }), bit0({ rails: { [TA]: onBit(BA, true), [N2]: onBit(N, false, false) } })],
      // 2. both executed
      ["both enabled", base0({ rails: { [BA]: onBase(TA, true), [N]: onBase(N2, true) } }), bit0({ rails: { [TA]: onBit(BA, true), [N2]: onBit(N, true) } })],
      // 3. the front door disables its primary (its exits close: admin.exits_state's)
      ["door disabled", base0({ exits: CLOSED, rails: { [BA]: onBase(TA, false), [N]: onBase(N2, true) } }), bit0({ rails: { [TA]: onBit(BA, true), [N2]: onBit(N, true) } })],
      // 4. the vault disables its primary (its exits close too: nothing crosses either way)
      ["vault disabled", base0({ exits: CLOSED, rails: { [BA]: onBase(TA, false), [N]: onBase(N2, true) } }), bit0({ exits: CLOSED, rails: { [TA]: onBit(BA, false), [N2]: onBit(N, true) } })],
      // 5. the vault switches to N' first (its exits open again); its payouts reach N, which the front door has enabled
      ["vault switched", base0({ exits: CLOSED, rails: { [BA]: onBase(TA, false), [N]: onBase(N2, true) } }), bit0({ primaryBridge: N2, rails: { [TA]: onBit(BA, false), [N2]: onBit(N, true) } })],
      // 6. then the front door switches to N
      ["door switched", base0({ primaryBridge: N, rails: { [BA]: onBase(TA, false), [N]: onBase(N2, true) } }), bit0({ primaryBridge: N2, rails: { [TA]: onBit(BA, false), [N2]: onBit(N, true) } })],
    ];
    for (const [name, base, bit] of steps) {
      const c = ctx({ base, bit });
      expect(run(c), name).toEqual([]);
      expect(c.unjudged, name).toEqual([]);
    }
  });

  it("R6 (ChatGPT R2 claim D): the front door's batches reaching a bridge the vault has enabled while the vault's own primary is disabled fire whatever the vault's exits, and hold: the vault has no payout rail, and defers every unstake they carry", () => {
    // the switch made the front door's side first: the front door on N, whose half N' the vault has enabled; the vault's
    // primary TA disabled, not yet switched
    const window = (exits: Exits) => ({
      base: base0({ primaryBridge: N, rails: { [N]: onBase(N2, true), [BA]: onBase(TA, false) } }),
      bit: bit0({ exits, rails: { [TA]: onBit(BA, false), [N2]: onBit(N, true) } }),
    });
    for (const exits of [CLOSED, OPEN]) {
      const name = exits.open ? "OPEN" : "closed";
      const b = run(ctx(window(exits))).find((f) => f.key === BATCHES);
      expect(b?.subject, name).toBe("The vault's primary bridge is disabled: unstakes from Base are deferred");
      expect(b?.facts, name).toMatchObject({
        why: `the front door sends batches through ${N}, and the vault's primary ${TA} is disabled, so the vault has no payout rail and defers every unstake those batches carry`,
        "disabled primary": `${TA} on the vault (Bittensor)`,
        parked: "no: each batch is delivered, but the vault defers its unstakes (no payout rail)",
      });
      const line = RUNBOOK["rails.incoherent"](b!.facts);
      expect(line, name).toContain("The vault's primary bridge is disabled, so unstakes from Base are deferred");
      expect(line, name).toContain("Switch the vault's primary first (runbook section 8)");
      expect(line, name).not.toContain("Reopen it");
    }
    expect(run(ctx({ ...window(CLOSED), before: { base: base0(), bit: bit0() } })).find((f) => f.key === BATCHES)?.hold).toEqual({
      id: `${BATCHES}:37000299:6900299`,
      summary: `the front door sends batches through ${N} while the vault's primary ${TA} is disabled`,
    });
    // the vault's primary's own half unread: the rule can't see
    const unread = ctx({ base: window(CLOSED).base, bit: bit0({ exits: CLOSED, rails: { [N2]: onBit(N, true) } }) });
    expect(run(unread)).toEqual([]);
    expect(unjudgedOf(unread)).toContain(`rails.incoherent ${BATCHES}`);
  });

  it("R4-O's fix round (Minor 8): a pair switched to halves not set up as the deploy's adapters (router, token, remote selector; on Bittensor the AlphaVault) is refused, as ops' rail check refuses it", () => {
    const switched = (over: { base?: Partial<RailHalf>; bit?: Partial<RailHalf> } = {}) => ({
      base: base0({ primaryBridge: N, rails: { [BA]: onBase(TA, false), [N]: { ...onBase(N2, true), ...over.base } } }),
      bit: bit0({ primaryBridge: N2, rails: { [TA]: onBit(BA, false), [N2]: { ...onBit(N, true), ...over.bit } } }),
    });
    const ok = ctx(switched());
    expect(run(ok)).toEqual([]);
    expect(ok.unjudged).toEqual([]);
    // the new Bittensor half's router another: batches through N reach N2, and payouts leave through N2: both refused
    const f = run(ctx(switched({ bit: { router: OTHER } })));
    expect(f.map((x) => x.key)).toEqual([BATCHES, PAYOUTS]);
    expect(f[0].facts.why).toBe(`the front door sends batches through ${N}, and its Bittensor half ${N2} is not set up as the deploy's adapter on Bittensor (its router() is ${OTHER}, not ${ROUTER} as the deploy's adapter's)`);
    expect(f[0].facts.parked).toBe("no: the pair's settings are fixed at deploy, so its messages can't arrive as the deploy's rail's would; move both sides to a correct pair (runbook section 8)");
    expect(f[1].facts.why).toBe(`the vault sends payouts through ${N2}, and ${N2} is not set up as the deploy's adapter on Bittensor (its router() is ${OTHER}, not ${ROUTER} as the deploy's adapter's)`);
    // the Base half's token, the remote selector, the AlphaVault on Bittensor
    expect(run(ctx(switched({ base: { token: OTHER } })))[0].facts.why).toBe(`the front door sends batches through ${N}, and ${N} is not set up as the deploy's adapter on Base (its token() is ${OTHER}, not ${TOKEN} as the deploy's adapter's)`);
    expect(run(ctx(switched({ base: { remoteSelector: 78n } })))[0].facts.why).toContain("(its remoteSelector() is 78, not 77 as the deploy's adapter's)");
    expect(run(ctx(switched({ bit: { alphaVault: OTHER } })))[0].facts.why).toContain(`(its alphaVault() is ${OTHER}, not ${ALPHA} as the deploy's adapter's, nor the announced migration target of ${ALPHA} (none announced))`);
    // the AlphaVault is a Bittensor field only: a Base half's is never compared
    expect(run(ctx(switched({ base: { alphaVault: OTHER } })))).toEqual([]);
    // a field unread: the rule can't see, never coherent
    const u = ctx(switched({ bit: { token: undefined } }));
    expect(run(u)).toEqual([]);
    expect(unjudgedOf(u)).toEqual([`rails.incoherent ${BATCHES}`, `rails.incoherent ${PAYOUTS}`]);
  });

  it("R4-O round 2: a switched pair whose Bittensor half names the deploy's AlphaVault's announced migration target is carried; any other AlphaVault is refused, the target named; the target unread is the rule's can't-see", () => {
    const pairOn = (half: Partial<RailHalf>, target: Hex | undefined) => ({
      base: base0({ primaryBridge: N, rails: { [BA]: onBase(TA, false), [N]: onBase(N2, true) } }),
      bit: bit0({ primaryBridge: N2, rails: { [TA]: onBit(BA, false), [N2]: { ...onBit(N, true), ...half } }, deployAlpha: target === undefined ? { vault: ALPHA } : { vault: ALPHA, migrationTarget: target, migrationFinished: false } }),
    });
    // the migration's announced target: carried, both pairs
    const ok = ctx(pairOn({ alphaVault: NEW_AV }, NEW_AV));
    expect(run(ok)).toEqual([]);
    expect(ok.unjudged).toEqual([]);
    // any other AlphaVault while a target is announced: refused, the target named
    const f = run(ctx(pairOn({ alphaVault: OTHER }, NEW_AV)));
    expect(f.map((x) => x.key)).toEqual([BATCHES, PAYOUTS]);
    expect(f[0].facts.why).toContain(`(its alphaVault() is ${OTHER}, not ${ALPHA} as the deploy's adapter's, nor the announced migration target of ${ALPHA} (${NEW_AV}))`);
    // no migration announced: the new vault is refused as before
    expect(run(ctx(pairOn({ alphaVault: NEW_AV }, ZERO_ADDR))).map((x) => x.key)).toEqual([BATCHES, PAYOUTS]);
    // the target names a vault, never a token: every other field as strict
    expect(run(ctx(pairOn({ alphaVault: NEW_AV, token: NEW_AV }, NEW_AV)))[0].facts.why).toContain(`(its token() is ${NEW_AV}, not ${TOKEN} as the deploy's adapter's)`);
    // the target unread: unjudged, never coherent
    const u = ctx(pairOn({ alphaVault: NEW_AV }, undefined));
    expect(run(u)).toEqual([]);
    expect(unjudgedOf(u)).toEqual([`rails.incoherent ${BATCHES}`, `rails.incoherent ${PAYOUTS}`]);
    // R4-O round 4: TOKENS moved to the new vault: still judged (the target is read at the deploy adapter's own vault)
    const moved: Config = { ...cfg32, tokens: { ...cfg32.tokens, bittensor: { ...cfg32.tokens.bittensor, alphaVault: NEW_AV } } };
    const tokensMoved = ctx({ ...pairOn({ alphaVault: NEW_AV }, NEW_AV), cfg: moved });
    expect(run(tokensMoved)).toEqual([]);
    expect(tokensMoved.unjudged).toEqual([]);
    expect(run(ctx({ ...pairOn({ alphaVault: OTHER }, NEW_AV), cfg: moved })).map((x) => x.key)).toEqual([BATCHES, PAYOUTS]);
    // a reading of another vault than the deploy adapter's own: whose target it is can't be told, so unjudged
    const elsewhere = ctx({
      base: pairOn({ alphaVault: NEW_AV }, NEW_AV).base,
      bit: { ...pairOn({ alphaVault: NEW_AV }, NEW_AV).bit, deployAlpha: { vault: "0x00000000000000000000000000000000000e2e2e" as Hex, migrationTarget: NEW_AV, migrationFinished: false } },
    });
    expect(run(elsewhere)).toEqual([]);
    expect(unjudgedOf(elsewhere)).toEqual([`rails.incoherent ${BATCHES}`, `rails.incoherent ${PAYOUTS}`]);
  });

  it("R4-O round 3: the monitor records the live target as it reads it; once the live target reads 0, the address it recorded is accepted, and only that one", () => {
    const KEY = `alpha_target_seen:${ALPHA}`;
    const pairOn = (half: Partial<RailHalf>, target: Hex, finished = target === ZERO_ADDR) => ({
      base: base0({ primaryBridge: N, rails: { [BA]: onBase(TA, false), [N]: onBase(N2, true) } }),
      bit: bit0({ primaryBridge: N2, rails: { [TA]: onBit(BA, false), [N2]: { ...onBit(N, true), ...half } }, deployAlpha: { vault: ALPHA, migrationTarget: target, migrationFinished: finished } }),
    });
    // read live: recorded in the rule's meta (once; not again while it is the same)
    const live = ctx(pairOn({ alphaVault: NEW_AV }, NEW_AV));
    expect(run(live)).toEqual([]);
    expect(live.writes.meta).toEqual([{ k: KEY, v: NEW_AV }]);
    const again = ctx({ ...pairOn({ alphaVault: NEW_AV }, NEW_AV), meta: { [KEY]: NEW_AV } });
    run(again);
    expect(again.writes.meta).toEqual([]);
    // the live target cleared (finishMigration): the recorded address is still accepted
    const kept = ctx({ ...pairOn({ alphaVault: NEW_AV }, ZERO_ADDR), meta: { [KEY]: NEW_AV } });
    expect(run(kept)).toEqual([]);
    expect(kept.unjudged).toEqual([]);
    expect(kept.writes.meta).toEqual([]);
    // a record the half's vault never matched: refused, both named
    const f = run(ctx({ ...pairOn({ alphaVault: NEW_AV }, ZERO_ADDR), meta: { [KEY]: OTHER } }));
    expect(f.map((x) => x.key)).toEqual([BATCHES, PAYOUTS]);
    expect(f[0].facts.why).toContain(`(its alphaVault() is ${NEW_AV}, not ${ALPHA} as the deploy's adapter's, nor the announced migration target of ${ALPHA} (none announced; the last it announced was ${OTHER}))`);
    // R4-O round 4 (Minor 1): the target cleared but no migration finished (ForeverMoney's cancelMigration): refused, said
    const cancelled = run(ctx({ ...pairOn({ alphaVault: NEW_AV }, ZERO_ADDR, false), meta: { [KEY]: NEW_AV } }));
    expect(cancelled.map((x) => x.key)).toEqual([BATCHES, PAYOUTS]);
    expect(cancelled[0].facts.why).toContain(`(none announced; the last it announced was ${NEW_AV}, but it reads no finished migration (a cancelled notice reads the same))`);
    // the finish unread: unjudged
    const unread = ctx({ ...pairOn({ alphaVault: NEW_AV }, ZERO_ADDR), meta: { [KEY]: NEW_AV } });
    (unread.snap.bittensor!.state.deployAlpha as { migrationFinished?: boolean }).migrationFinished = undefined;
    (unread.previous.bittensor!.state.deployAlpha as { migrationFinished?: boolean }).migrationFinished = undefined;
    expect(run(unread)).toEqual([]);
    expect(unjudgedOf(unread)).toEqual([`rails.incoherent ${BATCHES}`, `rails.incoherent ${PAYOUTS}`]);
    // nothing recorded: refused; any other vault with the record: refused
    expect(run(ctx(pairOn({ alphaVault: NEW_AV }, ZERO_ADDR))).map((x) => x.key)).toEqual([BATCHES, PAYOUTS]);
    expect(run(ctx({ ...pairOn({ alphaVault: OTHER }, ZERO_ADDR), meta: { [KEY]: NEW_AV } })).map((x) => x.key)).toEqual([BATCHES, PAYOUTS]);
  });

  it("a failed read is the rule's can't-see (its alert stays open), never coherent", () => {
    const cases: [string, Parameters<typeof ctx>[0], string[]][] = [
      ["no Base reading", { base: null }, [BATCHES, PAYOUTS]],
      ["no Bittensor reading", { bit: null }, [BATCHES, PAYOUTS]],
      ["the front door's primary unread", { base: base0({ primaryBridge: undefined }) }, [BATCHES]],
      ["the front door's rail halves unread (a lens mismatch, say)", { base: base0({ rails: undefined }) }, [BATCHES, PAYOUTS]],
      ["the front door's primary's enabled unread", { base: base0({ rails: { [BA]: { remote: TA, remoteChainId: BIT_ID, known: true } } }) }, [BATCHES]],
      // BA is also the vault's primary's Base half, so its peer and chain are what the payouts' back-check reads
      ["the front door's primary's peer unread", { base: base0({ rails: { [BA]: { remoteChainId: BIT_ID, enabled: true, known: true } } }) }, [BATCHES, PAYOUTS]],
      ["the front door's primary's chain unread", { base: base0({ rails: { [BA]: { remote: TA, enabled: true, known: true } } }) }, [BATCHES, PAYOUTS]],
      ["the launch door's state unread", { bit: bit0({ doorState: undefined }) }, [BATCHES, PAYOUTS]],
      ["the vault's primary unread", { bit: bit0({ primaryBridge: undefined }) }, [PAYOUTS]],
      ["the vault's halves unread", { bit: bit0({ rails: undefined }) }, [BATCHES, PAYOUTS]],
      ["the vault's half's enabled unread", { bit: bit0({ rails: { [TA]: { remote: BA, remoteChainId: BASE_ID, known: true } } }) }, [BATCHES, PAYOUTS]],
      ["the front door's known unread", { base: base0({ rails: { [BA]: { remote: TA, remoteChainId: BIT_ID, enabled: true } } }) }, [PAYOUTS]],
      // the peer the front door's primary names isn't among the halves read on Bittensor (read on the next tick)
      ["the peer not read on the other chain", { base: base0({ primaryBridge: N, rails: { [N]: onBase(N2, true), [BA]: onBase(TA, true) } }) }, [BATCHES]],
      // a sender's primary disabled, and whether its chain's exits read OPEN (this rule's) or closed (admin.exits_state's)
      // unread
      ["the front door's exits unread, its primary disabled", { base: base0({ exits: undefined, rails: { [BA]: onBase(TA, false) } }) }, [BATCHES]],
      ["the front door's exits open unread, its primary disabled", { base: base0({ exits: { lastOwnerClose: 0 }, rails: { [BA]: onBase(TA, false) } }) }, [BATCHES]],
      [
        "the vault's exits unread, its primary disabled (not the front door's half; the front door's own disabled, its exits closed)",
        { base: base0({ exits: CLOSED, rails: { [N]: onBase(N2, true), [BA]: onBase(TA, false) } }), bit: bit0({ exits: undefined, rails: { [TA]: onBit(BA, false), [N2]: onBit(N, true) } }) },
        [PAYOUTS],
      ],
    ];
    for (const [name, o, keys] of cases) {
      const c = ctx(o);
      expect(run(c), name).toEqual([]);
      expect(unjudgedOf(c), name).toEqual(keys.map((k) => `rails.incoherent ${k}`));
    }
    // a refusal already seen isn't hidden by another field unread: TA disabled on the vault (not its primary) is enough
    const seen = ctx({ base: vaultAlone.base, bit: { ...vaultAlone.bit, rails: { [TA]: { enabled: false, known: true }, [N2]: onBit(N, true) } } });
    expect(run(seen).map((f) => f.key)).toEqual([BATCHES]);
    // nor by the vault's primary unread (a half the front door sends through, disabled on the vault, is refused whoever's
    // primary it is), nor by the vault's exits unread beside its own disabled primary
    const primaryUnread = ctx({ bit: bit0({ primaryBridge: undefined, rails: { [TA]: onBit(BA, false) } }) });
    const [u] = run(primaryUnread);
    expect(u).toMatchObject({ key: BATCHES, subject: "The two chains disagree on the bridge: deposits from Base are refused and parked" });
    expect(u.facts.why).toBe(`the front door sends batches through ${BA}, and its Bittensor half ${TA} is disabled on the vault`);
    expect(unjudgedOf(primaryUnread)).toEqual([`rails.incoherent ${PAYOUTS}`]);
    const exitsUnread = ctx({ bit: bit0({ exits: undefined, rails: { [TA]: onBit(BA, false) } }) });
    const [x] = run(exitsUnread);
    expect(x.key).toBe(BATCHES);
    expect(x.facts["its exits"]).toBe("not read");
    expect(unjudgedOf(exitsUnread)).toEqual([`rails.incoherent ${PAYOUTS}`]);
  });

  it("waits for a second reading on both chains, and holds once an occurrence", () => {
    // the first incoherent reading after a coherent one: nothing yet
    expect(run(ctx({ ...vaultAlone, prevBase: base0(), prevBit: bit0() }))).toEqual([]);
    // no reading before on either chain: unjudged
    const fresh = ctx({ ...vaultAlone, prevBit: null });
    expect(run(fresh)).toEqual([]);
    expect(unjudgedOf(fresh)).toEqual([`rails.incoherent ${BATCHES}`]);
    // while it lasts (the reading before last incoherent too): the alert, no new hold
    const lasting = run(ctx({ ...vaultAlone, before: vaultAlone }));
    expect(lasting.map((f) => f.key)).toEqual([BATCHES]);
    expect(lasting[0].hold).toBeUndefined();
    // without a reading before last on a chain, the hold is raised (fail closed: one more to look at)
    expect(run(ctx(vaultAlone))[0].hold?.id).toBe(`${BATCHES}:37000299:6900299`);
  });

  it("onset over both chains: the condition on two readings, and not on the readings before last of both", () => {
    const incoherent = (r: { base?: BaseState; bittensor?: BitState }) => (r.base?.primaryBridge === undefined || r.bittensor?.primaryBridge === undefined ? undefined : r.bittensor.primaryBridge !== TA);
    expect(onset(ctx({ ...vaultAlone, before: { base: base0(), bit: bit0() } }), ["base", "bittensor"], incoherent)).toBe(true);
    expect(onset(ctx({ ...vaultAlone, before: vaultAlone }), ["base", "bittensor"], incoherent)).toBe(false);
    expect(onset(ctx({ ...vaultAlone, prevBit: bit0() }), ["base", "bittensor"], incoherent)).toBe(false);
    // one chain alone, as before
    expect(onset(ctx({ ...vaultAlone, before: { base: base0(), bit: bit0() } }), "bittensor", (r) => (r.bittensor?.primaryBridge === undefined ? undefined : r.bittensor.primaryBridge !== TA))).toBe(true);
  });

  it("names the refused half's pending activation, when the lens reads it pending", () => {
    // the front door switched to N before the vault's activateBridge(N') ran: batches refused until it does
    const data = encodeFunctionData({ abi: SCHEDULABLE.vault, functionName: "activateBridge", args: [N2] } as never).toLowerCase() as Hex;
    const id = keccak256(data);
    const readyAt = NOW + 2 * DAY;
    const item: TrackedItem = { chain: "bittensor", role: "vault", id, kind: 0, selector: data.slice(0, 10) as Hex, readyAt, data, setter: "activateBridge", args: { bridge: N2 }, canonical: true, uid: id, block: "6900100", tx: id };
    const exits = { open: true, ownerHold: false, guardianHold: false, pausedBy: 0, primaryDisabledBy: 0, launchDoorRemovedBy: 0, lastOwnerClose: 0, lastGuardianClose: 0, pendingSince: 0 };
    const bit = bit0({ rails: { [TA]: onBit(BA, true), [N2]: onBit(N, false, false) }, exits, scheduled: { [id]: { scheduledAt: readyAt - 7 * DAY, readyAt, class: 1, kind: 0, selector: item.selector, readyBlock: 6_950_000n } } });
    const base = base0({ primaryBridge: N, rails: { [BA]: onBase(TA, false), [N]: onBase(N2, true) } });
    const [f] = run(ctx({ base, bit, meta: { [ITEMS_KEY]: JSON.stringify([item]) } }));
    expect(f.key).toBe(BATCHES);
    expect(f.facts.why).toBe(`the front door sends batches through ${N}, and its Bittensor half ${N2} was never enabled on the vault`);
    expect(f.facts["pending to fix it"]).toBe(`activateBridge(${N2}) on the vault, ready at 2027-01-17 08:00 UTC`);
    // none pending, or a record that doesn't read: said so
    expect(run(ctx({ base, bit }))[0].facts["pending to fix it"]).toBe("none scheduled");
    expect(run(ctx({ base, bit, meta: { [ITEMS_KEY]: "not json" } }))[0].facts["pending to fix it"]).toBe("not known (the record of scheduled items doesn't read)");
  });

  it("judges nothing on a v3-launch deployment", () => {
    const c = ctx({ ...vaultAlone, cfg: testConfig() });
    expect(run(c)).toEqual([]);
    expect(c.unjudged).toEqual([]);
  });
});

/** The launch rail with the vault's primary TA disabled (by the guardian), the front door still sending through it. */
const vaultDisabled = (exits: Exits, o: Partial<BitState> = {}) => ({ base: base0(), bit: bit0({ exits, rails: { [TA]: onBit(BA, false) }, ...o }) });
/** The launch rail with the front door's primary BA disabled. */
const doorDisabled = (exits: Exits, o: Partial<BaseState> = {}) => ({ base: base0({ exits, rails: { [BA]: onBase(TA, false) }, ...o }), bit: bit0() });

describe("rails.incoherent: a primary disabled on its own side (Task 57c fix 1)", () => {
  it("fires when the vault reads OPEN with its primary disabled and no Reopen (a swap ended the guardian's hold): batches park, no payout leaves, and both hold", () => {
    const out = run(ctx(vaultDisabled(OPEN)));
    expect(out.map((f) => f.key)).toEqual([BATCHES, PAYOUTS]);
    const [b, p] = out;
    expect(b.subject).toBe("The vault's primary bridge is disabled: deposits from Base are refused and parked");
    expect(b.facts).toMatchObject({
      direction: "batches",
      "the front door's primary bridge": BA,
      "its Bittensor half": TA,
      "on the vault": "disabled",
      why: `the front door sends batches through ${BA}, and its Bittensor half ${TA}, the vault's primary, is disabled on the vault`,
      "disabled primary": `${TA} on the vault (Bittensor)`,
      "its exits": "OPEN",
      parked: `yes: each batch closed parks in ${TA}, refunded to Base after 14 days`,
      "pending to fix it": "none scheduled",
    });
    expect(p.subject).toBe("The vault's primary bridge is disabled: payouts to Base are refused");
    expect(p.facts).toMatchObject({
      direction: "payouts",
      "the vault's primary bridge": TA,
      why: `the vault sends payouts through ${TA}, which is disabled on the vault`,
      "disabled primary": `${TA} on the vault (Bittensor)`,
      "its exits": "OPEN",
      "payouts sent": "none: every payout send reverts, so none leaves Bittensor",
      "pending to fix it": "none scheduled",
    });
    // what to do: reopen it, or switch both sides
    for (const f of out) {
      const line = RUNBOOK["rails.incoherent"](f.facts);
      expect(line, f.key).toContain("The vault's primary bridge is disabled, so");
      expect(line, f.key).toContain(`: ${f.facts.why}.`);
      expect(line, f.key).toContain("Reopen it, or switch both sides to another pair.");
      expect(line, f.key).not.toContain("Finish the two-sided switch");
      expect(line, f.key).toContain("This alert holds the keeper: clear the hold once it clears.");
    }
    // its first tick: each pair raises its hold
    expect(run(ctx({ ...vaultDisabled(OPEN), before: { base: base0(), bit: bit0() } })).map((f) => f.hold)).toEqual([
      { id: `${BATCHES}:37000299:6900299`, summary: `the front door sends batches through ${BA}, which the vault refuses` },
      { id: `${PAYOUTS}:37000299:6900299`, summary: `the vault sends payouts through ${TA}, which is disabled on the vault` },
    ]);
    // each side on its own rail (the front door on N, whose half the vault has enabled): the payouts, and since R6 (claim
    // D) the batches too: the vault takes them with no payout rail, and defers their unstakes
    const split = ctx({
      base: base0({ primaryBridge: N, rails: { [N]: onBase(N2, true), [BA]: onBase(TA, false) } }),
      bit: bit0({ rails: { [TA]: onBit(BA, false), [N2]: onBit(N, true) } }),
    });
    expect(run(split).map((f) => f.key)).toEqual([BATCHES, PAYOUTS]);
    expect(run(split)[0].subject).toBe("The vault's primary bridge is disabled: unstakes from Base are deferred");
    expect(split.unjudged).toEqual([]);
  });

  it("names the vault's pending Reopen of its primary in both alerts", () => {
    const r = pendingActivation("bittensor", TA);
    const out = run(ctx({ ...vaultDisabled(OPEN, { scheduled: r.scheduled }), meta: r.meta }));
    expect(out.map((f) => [f.key, f.facts["pending to fix it"]])).toEqual([
      [BATCHES, `activateBridge(${TA}) on the vault, ready at 2027-01-17 08:00 UTC`],
      [PAYOUTS, `activateBridge(${TA}) on the vault, ready at 2027-01-17 08:00 UTC`],
    ]);
  });

  it("while the vault's exits read closed, its disabled primary that the front door still sends through fires and holds beside admin.exits_state (a hold rides only on an alert); its payouts are admin.exits_state's alone", () => {
    // the guardian disabled the vault's primary: the vault's exits close (admin.exits_state pages), but the front door is
    // OPEN and still closes batches into TA, which park; the keeper isn't held unless this rule holds it
    const out = run(ctx(vaultDisabled(CLOSED)));
    expect(out.map((f) => f.key)).toEqual([BATCHES]);
    expect(out[0].subject).toBe("The vault's primary bridge is disabled: deposits from Base are refused and parked");
    expect(out[0].facts).toMatchObject({
      "disabled primary": `${TA} on the vault (Bittensor)`,
      "its exits": "closed (admin.exits_state)",
      parked: `yes: each batch closed parks in ${TA}, refunded to Base after 14 days`,
    });
    expect(run(ctx({ ...vaultDisabled(CLOSED), before: { base: base0(), bit: bit0() } }))[0].hold).toEqual({
      id: `${BATCHES}:37000299:6900299`,
      summary: `the front door sends batches through ${BA}, which the vault refuses`,
    });
    // a Reopen scheduled since (it needs no gate): named
    const r = pendingActivation("bittensor", TA);
    expect(run(ctx({ ...vaultDisabled(CLOSED, { scheduled: r.scheduled }), meta: r.meta }))[0].facts["pending to fix it"]).toBe(
      `activateBridge(${TA}) on the vault, ready at 2027-01-17 08:00 UTC`,
    );
    // then the owner's setGuardian ends the guardian's hold (OPEN, the primary still disabled): the batches' alert goes
    // on with no new hold, and the payouts' joins on the next reading, with its own hold
    const swapped = run(ctx({ base: base0(), bit: vaultDisabled(OPEN).bit, prevBit: vaultDisabled(CLOSED).bit, before: vaultDisabled(CLOSED) }));
    expect(swapped.map((f) => [f.key, f.hold])).toEqual([[BATCHES, undefined]]);
    const next = run(ctx({ ...vaultDisabled(OPEN), before: vaultDisabled(CLOSED) }));
    expect(next.map((f) => [f.key, f.hold?.id])).toEqual([
      [BATCHES, undefined],
      [PAYOUTS, `${PAYOUTS}:37000299:6900299`],
    ]);
  });

  it("fires when the front door reads OPEN with its primary disabled: no batch can close, naming its Reopen; quiet while its exits read closed (nothing parks)", () => {
    const out = run(ctx(doorDisabled(OPEN)));
    expect(out.map((f) => f.key)).toEqual([BATCHES]);
    const [f] = out;
    expect(f.subject).toBe("The front door's primary bridge is disabled: deposits from Base are refused");
    expect(f.facts).toMatchObject({
      direction: "batches",
      "the front door's primary bridge": BA,
      why: `the front door sends batches through ${BA}, which is disabled on the front door`,
      "disabled primary": `${BA} on the front door (Base)`,
      "its exits": "OPEN",
      parked: "no: every close reverts, so no batch leaves Base",
      "pending to fix it": "none scheduled",
    });
    const line = RUNBOOK["rails.incoherent"](f.facts);
    expect(line).toContain(`The front door's primary bridge is disabled, so deposits from Base are refused: ${f.facts.why}.`);
    expect(line).toContain("Reopen it, or switch both sides to another pair.");
    expect(line).not.toContain("Finish the two-sided switch");
    expect(run(ctx({ ...doorDisabled(OPEN), before: { base: base0(), bit: bit0() } }))[0].hold).toEqual({
      id: `${BATCHES}:37000299:6900299`,
      summary: `the front door sends batches through ${BA}, which is disabled on the front door`,
    });
    // its Reopen pending on the front door's scheduler: named
    const r = pendingActivation("base", BA);
    expect(run(ctx({ ...doorDisabled(OPEN, { scheduled: r.scheduled }), meta: r.meta }))[0].facts["pending to fix it"]).toBe(
      `activateBridge(${BA}) on the front door, ready at 2027-01-17 08:00 UTC`,
    );
    // its exits closed: admin.exits_state's, and every close reverts, so nothing parks and nothing needs holding
    const closed = ctx(doorDisabled(CLOSED));
    expect(run(closed)).toEqual([]);
    expect(closed.unjudged).toEqual([]);
  });

  it("names every refusal of the front door's half: the vault's own disabled primary doesn't drop a back-check already seen, whatever the vault's exits", () => {
    for (const exits of [OPEN, CLOSED]) {
      const name = exits.open ? "OPEN" : "closed";
      const out = run(ctx({ bit: bit0({ exits, rails: { [TA]: onBit(STRANGER, false) } }) }));
      const b = out.find((f) => f.key === BATCHES);
      expect(b?.facts.why, name).toBe(
        `the front door sends batches through ${BA}, and its Bittensor half ${TA} takes messages only from ${STRANGER} on chain 8453, and its Bittensor half ${TA}, the vault's primary, is disabled on the vault`,
      );
      // the first a batch meets: CCIP refuses it at TA (WrongSender), so it doesn't park; no Reopen alone fixes it
      expect(b?.facts.parked, name).toBe(`no: each batch closed fails in CCIP at ${TA}`);
      expect(b?.subject, name).toBe("The vault's primary bridge is disabled: deposits from Base are refused");
      expect(RUNBOOK["rails.incoherent"](b!.facts), name).toContain("The adapters' peers are fixed at deploy, so the only fix is to move both sides to a correct pair.");
    }
  });
});

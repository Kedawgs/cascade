import { encodeFunctionData, getAddress, type Hex, keccak256 } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { type RailChange, type RailState, railCoherence, railsFindings } from "../../../ops/src/v32/rails.ts";
import { SCHEDULABLE } from "../../src/abi.ts";
import type { Config } from "../../src/config.ts";

// The rails judged alike by the monitor and ops (the v3.2-ops and v3.2-monitor merge, step 7a: T47b's and T57c's carry).
// One table of states, each read by both: the monitor's rails.incoherent (indexer/src/rules/rails.ts, the rule as a tick
// runs it, on two readings in a row) and ops' railCoherence as verify reads it "now" (ops/src/v32/rails.ts, with no
// pending item and no file counted). Each pair is compared on its own: the batches (the front door's primary and its
// Bittensor half) and the payouts (the vault's primary and its Base half). The monitor's "quiet" is coherent or moot; it
// fires where ops finds the pair refused. The two differ on purpose in two places only, the re-review's DELIBERATE 1 and
// 2, each asserted as a difference with its reason in the test's name.
//
// Why here: this project's node tests run in Node, where ops' rail module loads as ops' own tests load it (it reaches
// node:fs and node:child_process through ops' scheduler and send modules, which workerd has not), and vitest compiles
// both packages' TypeScript as it loads them, so neither needs a build. ops never loads indexer code (its rule:
// ops/test/monitor-directions.ts), and comparisons with the keeper's and the contracts' code are this project's node
// tests' job (vitest.config.ts). The monitor's rule and its readings' types reach D1's types (src/rules/context.ts,
// src/snapshot.ts through src/crosscheck/payouts.ts, src/store.ts), which this project's node typecheck
// (tsconfig.node.json, Node's types) does not have. So the rule and the scheduler's record key are loaded by a path the
// typecheck does not follow, and the readings are typed here by what the rule reads (a reading it can't use leaves a
// pair unjudged, which fails every test below); ops' module is imported and typechecked as usual.
//
// The chain ids: both judges are given the same ones here (the monitor's from its config, ops' from launchChain() and
// vaultChain()), so a deployment where they differ is outside this test; verify's own check of those reads catches it
// (merge 7a's review, M4).

/** The monitor's rule and its findings, as this test uses them (src/rules/rails.ts railsIncoherent). */
interface MonitorFinding {
  key: string;
  subject: string;
  facts: Record<string, string>;
}
interface MonitorCtx {
  unjudged: { rule: string; key?: string }[];
  writes: { meta: { k: string; v: string }[] };
}
let railsIncoherent: { run(ctx: MonitorCtx): MonitorFinding[] };
/** src/scheduler.ts ITEMS_KEY: where the monitor keeps its record of scheduled items */
let ITEMS_KEY: string;
const MONITOR: Record<"rule" | "scheduler", string> = { rule: "../../src/rules/rails.ts", scheduler: "../../src/scheduler.ts" };
beforeAll(async () => {
  ({ railsIncoherent } = (await import(MONITOR.rule)) as { railsIncoherent: typeof railsIncoherent });
  ({ ITEMS_KEY } = (await import(MONITOR.scheduler)) as { ITEMS_KEY: string });
});

/** A bridge as the monitor reads it on its chain (src/snapshot.ts RailHalf): its peer on the other chain (remoteAdapter),
 * the chain that peer is on (remoteChainId), whether its own chain's contract has it enabled now, and whether that
 * contract ever enabled it (bridgeKnown). */
interface RailHalf {
  remote: Hex;
  remoteChainId: bigint;
  enabled: boolean;
  known: boolean;
  /** its setup, which ops' rail check holds to the deploy's adapter on its chain (C-L4) and the monitor now too (R4-O's
   * fix round, Minor 8); on Bittensor its AlphaVault as well */
  router: Hex;
  token: Hex;
  remoteSelector: bigint;
  alphaVault: Hex;
}
/** A chain's exits as its lens reads them (src/snapshot.ts Exits). */
interface Exits {
  open: boolean;
  ownerHold: boolean;
  guardianHold: boolean;
  primaryDisabledBy: number;
  lastOwnerClose: number;
  lastGuardianClose: number;
}
/** scheduled(id) as a lens answers it (src/snapshot.ts ScheduledItem). */
interface ScheduledItem {
  scheduledAt: number;
  readyAt: number;
  class: number;
  kind: number;
  selector: Hex;
  readyBlock: bigint;
}

const NOW = 1_800_000_000;
const DAY = 86_400;
const BASE_ID = 8453n;
const BIT_ID = 964n;
/** The launch rail (BA on Base, TA on Bittensor), a second rail (N, N2), and a stranger's adapter on each chain. */
const BA = "0x0000000000000000000000000000000000ba5e01" as Hex;
const TA = "0x0000000000000000000000000000000000b17701" as Hex;
const N = "0x0000000000000000000000000000000000ba5e02" as Hex;
const N2 = "0x0000000000000000000000000000000000b17702" as Hex;
const XB = "0x0000000000000000000000000000000000e7e7e1" as Hex;
const XT = "0x0000000000000000000000000000000000e7e7e2" as Hex;

/** The monitor's configuration, as much of it as the rule reads: a v3.2 deployment and its two chains' ids. */
const CFG = {
  deployment: { version: "v3.2", baseAdapter: BA, bitAdapter: TA, base: { chainId: Number(BASE_ID) }, bittensor: { chainId: Number(BIT_ID) } },
  // the AlphaVault the monitor watches (whose migrationTarget() it reads): the deploy's
  tokens: { bittensor: { alphaVault: "0x00000000000000000000000000000000000c1c03" } },
} as unknown as Config;

/** The setup every half shares with the deploy's adapter on its chain unless a state says otherwise */
const SETUP = {
  router: "0x00000000000000000000000000000000000c1c01" as Hex,
  token: "0x00000000000000000000000000000000000c1c02" as Hex,
  remoteSelector: 77n,
  alphaVault: "0x00000000000000000000000000000000000c1c03" as Hex,
};
const ANOTHER = "0x00000000000000000000000000000000000c1c04" as Hex;
/** ForeverMoney's vault after a migration, and no migration announced (R4-O round 2) */
const NEW_AV = "0x00000000000000000000000000000000000c1c05" as Hex;
const NO_TARGET = "0x0000000000000000000000000000000000000000" as Hex;
/** A bridge on its chain (RailHalf); `known` is `enabled` unless given. */
const half = (remote: Hex, remoteChainId: bigint, enabled: boolean, known = enabled): RailHalf => ({ remote, remoteChainId, enabled, known, ...SETUP });
const onBase = (remote: Hex, enabled: boolean, known = enabled) => half(remote, BIT_ID, enabled, known);
const onBit = (remote: Hex, enabled: boolean, known = enabled) => half(remote, BASE_ID, enabled, known);

const OPEN: Exits = { open: true, ownerHold: false, guardianHold: false, primaryDisabledBy: 0, lastOwnerClose: 0, lastGuardianClose: 0 };
/** Closed: the owner's own disable of its primary (an owner's hold), or the guardian's (a guardian's hold). */
const CLOSED: Exits = { open: false, ownerHold: true, guardianHold: false, primaryDisabledBy: 1, lastOwnerClose: NOW - DAY, lastGuardianClose: 0 };

/** One state of both chains, every value either side reads. */
interface Rails {
  base: { primary: Hex; exits: Exits; rails: Record<Hex, RailHalf> };
  bit: { primary: Hex; doorState: number; exits: Exits; rails: Record<Hex, RailHalf>; alphaTarget?: Hex; alphaRecorded?: Hex; alphaFinished?: boolean };
  /** activations pending in a scheduler (the monitor's record of items, ops' pending items) */
  pending?: { chain: "base" | "bittensor"; bridge: Hex }[];
}
type Over = { base?: Partial<Rails["base"]>; bit?: Partial<Rails["bit"]>; pending?: Rails["pending"] };
/** The launch rail, coherent: each side's primary the other's half, both enabled, both chains OPEN, the launch door Active. */
const rails = (o: Over = {}): Rails => ({
  base: { primary: BA, exits: OPEN, rails: { [BA]: onBase(TA, true) }, ...o.base },
  bit: { primary: TA, doorState: 1, exits: OPEN, rails: { [TA]: onBit(BA, true) }, ...o.bit },
  ...(o.pending ? { pending: o.pending } : {}),
});

type Pair = "refused" | "carried";
type Verdict = { batches: Pair; payouts: Pair };
const DIRECTIONS = ["batches", "payouts"] as const;

/** A pending activateBridge(bridge) on a chain's scheduler, ready in two days: as the monitor's record of items keeps it
 * and its lens reads it, and as ops' pending items list it. */
function activation(chain: "base" | "bittensor", bridge: Hex) {
  const role = chain === "base" ? "frontDoor" : "vault";
  const data = encodeFunctionData({ abi: SCHEDULABLE[role], functionName: "activateBridge", args: [bridge] } as never).toLowerCase() as Hex;
  const id = keccak256(data);
  const readyAt = NOW + 2 * DAY;
  // the monitor's record of a scheduled item (src/scheduler.ts TrackedItem)
  const item = { chain, role, id, kind: 0, selector: data.slice(0, 10) as Hex, readyAt, data, setter: "activateBridge", args: { bridge }, canonical: true, uid: id, block: "1", tx: id };
  const scheduled: ScheduledItem = { scheduledAt: readyAt - 7 * DAY, readyAt, class: 1, kind: 0, selector: item.selector, readyBlock: 7_000_000n };
  const change: RailChange = { contract: role, fn: "activateBridge", bridge: getAddress(bridge), source: "pending", id, kind: "Ordinary" };
  return { item, scheduled, change };
}

/** The monitor's verdict: the rule run on this state read twice in a row on both chains (its two readings), each pair
 * fired or quiet; a pair it can't judge fails the test (every state here is read in full). */
function monitorOf(s: Rails): { verdict: Verdict; findings: MonitorFinding[] } {
  const acts = (s.pending ?? []).map((p) => ({ ...p, ...activation(p.chain, p.bridge) }));
  const scheduledOn = (chain: "base" | "bittensor") => Object.fromEntries(acts.filter((a) => a.chain === chain).map((a) => [a.item.id, a.scheduled]));
  // each chain's reading (src/snapshot.ts BaseState, BitState): the fields the rule reads, the rest empty
  const base = { taoWethPool: {}, wethUsdcPool: {}, claimable: {}, deliveryOf: {}, primaryBridge: s.base.primary, exits: s.base.exits, rails: s.base.rails, scheduled: scheduledOn("base") };
  const bit = {
    stakes: {},
    alpha: {},
    // the deploy adapter's own AlphaVault: its target and whether its migration finished (R4-O round 4)
    deployAlpha: { vault: SETUP.alphaVault, migrationTarget: s.bit.alphaTarget ?? NO_TARGET, migrationFinished: s.bit.alphaFinished ?? false },
    payoutBatches: {}, primaryBridge: s.bit.primary, doorState: s.bit.doorState, exits: s.bit.exits, rails: s.bit.rails, scheduled: scheduledOn("bittensor") };
  const at = <T>(block: bigint, time: number, state: T) => ({ block, time, state });
  const previous = { base: at(37_000_299n, NOW - 2, base), bittensor: at(6_900_299n, NOW - 12, bit) };
  const ctx = {
    cfg: CFG,
    nowS: NOW,
    snap: { at: NOW, base: at(37_000_300n, NOW, base), bittensor: at(6_900_300n, NOW, bit) },
    previous,
    history: { base: [previous.base], bittensor: [previous.bittensor] },
    meta: {
      ...(acts.length ? { [ITEMS_KEY]: JSON.stringify(acts.map((a) => a.item)) } : {}),
      // the target the monitor recorded while it read it live (R4-O round 3)
      ...(s.bit.alphaRecorded ? { [`alpha_target_seen:${SETUP.alphaVault}`]: s.bit.alphaRecorded } : {}),
    },
    unjudged: [] as MonitorCtx["unjudged"],
    writes: { meta: [] as MonitorCtx["writes"]["meta"] },
  };
  const findings = railsIncoherent.run(ctx);
  expect(ctx.unjudged, "the monitor can see every pair").toEqual([]);
  const fired = (d: string) => (findings.some((f) => f.key === `rails.incoherent:${d}`) ? "refused" : "carried");
  return { verdict: { batches: fired("batches"), payouts: fired("payouts") }, findings };
}

/** ops' state of the same rails, as readRails would read it: each side's primary, the chain its bridges send to (the
 * vault's launchChain, the front door's vaultChain), each bridge's peer and chain, enabled on its own side, and what the
 * front door has ever enabled (bridgeKnown). */
function opsState(s: Rails): RailState {
  const st: RailState = {
    heads: { vault: { block: 6_900_300, time: NOW }, frontDoor: { block: 37_000_300, time: NOW } },
    primary: { vault: getAddress(s.bit.primary), frontDoor: getAddress(s.base.primary) },
    sendsTo: { vault: BASE_ID, frontDoor: BIT_ID },
    peers: { vault: {}, frontDoor: {} },
    enabled: { vault: {}, frontDoor: {} },
    doorKnown: {},
    pending: (s.pending ?? []).map((p) => activation(p.chain, p.bridge).change),
    planned: [],
  };
  for (const [a, h] of Object.entries(s.base.rails)) {
    st.peers.frontDoor[a.toLowerCase()] = { peer: getAddress(h.remote), chain: h.remoteChainId };
    st.enabled.frontDoor[a.toLowerCase()] = h.enabled;
    st.doorKnown[a.toLowerCase()] = h.known;
  }
  for (const [a, h] of Object.entries(s.bit.rails)) {
    st.peers.vault[a.toLowerCase()] = { peer: getAddress(h.remote), chain: h.remoteChainId };
    st.enabled.vault[a.toLowerCase()] = h.enabled;
  }
  // each bridge's setup against the deploy's adapter on its chain, as readRails reads it (ops/src/v32/pairs.ts
  // pairFieldProblems: the router, token and remote selector, and on Bittensor the AlphaVault)
  const FIELDS = { frontDoor: ["router", "token", "remoteSelector"], vault: ["router", "token", "remoteSelector", "alphaVault"] } as const;
  const target = s.bit.alphaTarget ?? NO_TARGET;
  const problems = (c: "frontDoor" | "vault", all: Record<Hex, RailHalf>, ours: Hex) =>
    Object.fromEntries(
      Object.entries(all).map(([a, h]) => [
        a.toLowerCase(),
        a.toLowerCase() === ours.toLowerCase()
          ? []
          : FIELDS[c]
              .filter((f) => String(h[f]).toLowerCase() !== String(all[ours][f]).toLowerCase())
              // pairFieldProblems' one exception (R4-O round 2): the AlphaVault the deploy's AlphaVault announced as its migration's target
              .filter((f) => !(f === "alphaVault" && target !== NO_TARGET && String(h[f]).toLowerCase() === target.toLowerCase()))
              // the live target cleared: the address recorded from it (R4-O round 3)
              .filter((f) => !(f === "alphaVault" && target === NO_TARGET && s.bit.alphaFinished === true && s.bit.alphaRecorded !== undefined && String(h[f]).toLowerCase() === s.bit.alphaRecorded.toLowerCase()))
              .map((f) => `its ${f}() differs`),
      ]),
    );
  st.config = { frontDoor: problems("frontDoor", s.base.rails, BA), vault: problems("vault", s.bit.rails, TA) };
  return st;
}

/** ops' verdict "now", as verify reads the rails (railsFindings: railCoherence with no pending item and no file): a pair
 * is refused when its sender's primary is named among the pairs that disagree. */
function opsOf(s: Rails) {
  const state = opsState(s);
  const now = railCoherence({ ...state, pending: [], planned: [] });
  const from = { batches: "frontDoor", payouts: "vault" } as const;
  const verdict = Object.fromEntries(DIRECTIONS.map((d) => [d, now.incoherent.some((p) => p.from === from[d]) ? "refused" : "carried"])) as Verdict;
  return { verdict, now, state, report: railsFindings(state) };
}

/** A state both read alike, with what both make of it. */
interface Same {
  /** the parity table's row (task-47b-rereview.md, "Parity, re-checked") */
  row: string;
  name: string;
  rails: Rails;
  both: Verdict;
}
const same = (row: string, name: string, r: Rails, batches: Pair, payouts: Pair): Same => ({ row, name, rails: r, both: { batches, payouts } });

// one call at a time, both new halves activated first, as runbook section 8 makes it: both disables (the front door's
// first), then the vault's switch, then the front door's (spec §5: a rail switch is one two-sided operation; Task 57c's
// in-order switch; R6, ChatGPT R2 claim D: the vault's switch first, so no batch reaches a vault with no payout rail)
const PENDING_BOTH = { base: { rails: { [BA]: onBase(TA, true), [N]: onBase(N2, false) } }, bit: { rails: { [TA]: onBit(BA, true), [N2]: onBit(N, false) } } };
const ENABLED_BOTH = { base: { rails: { [BA]: onBase(TA, true), [N]: onBase(N2, true) } }, bit: { rails: { [TA]: onBit(BA, true), [N2]: onBit(N, true) } } };
const DOOR_ON_N = { primary: N, rails: { [BA]: onBase(TA, false, true), [N]: onBase(N2, true) } };
const VAULT_ON_N2 = { primary: N2, rails: { [TA]: onBit(BA, false, true), [N2]: onBit(N, true) } };
const DOOR_OFF = { exits: CLOSED, rails: { [BA]: onBase(TA, false, true), [N]: onBase(N2, true) } };
const VAULT_OFF = { exits: CLOSED, rails: { [TA]: onBit(BA, false, true), [N2]: onBit(N, true) } };

const SAME: Same[] = [
  same("coherent", "both sides on the launch rail", rails(), "carried", "carried"),
  same(
    "split rails",
    "each side on its own rail, each pair carried (the vault's Base half disabled on the front door, which still takes payouts from it)",
    rails({ base: DOOR_ON_N, bit: { rails: { [TA]: onBit(BA, true), [N2]: onBit(N, true) } } }),
    "carried",
    "carried",
  ),
  same("in-order steps", "step 1: activateBridge(N) and activateBridge(N2) both pending", rails({ ...PENDING_BOTH, pending: [{ chain: "base", bridge: N }, { chain: "bittensor", bridge: N2 }] }), "carried", "carried"),
  same("in-order steps", "step 2: both new halves enabled", rails(ENABLED_BOTH), "carried", "carried"),
  same("in-order steps", "step 3: the front door disables its primary (its exits close)", rails({ base: DOOR_OFF, bit: ENABLED_BOTH.bit }), "carried", "carried"),
  same("in-order steps", "step 4: the vault disables its primary (its exits close; nothing crosses either way)", rails({ base: DOOR_OFF, bit: VAULT_OFF }), "carried", "carried"),
  same("in-order steps", "step 5: the vault switches to N2 first (its exits open again)", rails({ base: DOOR_OFF, bit: VAULT_ON_N2 }), "carried", "carried"),
  same("in-order steps", "step 6: the front door switches to N (its exits open again)", rails({ base: DOOR_ON_N, bit: VAULT_ON_N2 }), "carried", "carried"),
  same(
    "the front door switched first",
    "the front door on N while the vault's primary TA is disabled, not yet switched (R6, claim D: the vault takes the batches through N2 with no payout rail, and defers their unstakes)",
    rails({ base: DOOR_ON_N, bit: VAULT_OFF }),
    "refused",
    "carried",
  ),
  same("vault-first", "the vault disables its primary first, while the front door still sends through it", rails({ base: ENABLED_BOTH.base, bit: { exits: CLOSED, rails: { [TA]: onBit(BA, false, true), [N2]: onBit(N, true) } } }), "refused", "carried"),
  same("vault-first", "then the vault switches to N2 before the front door moves", rails({ base: ENABLED_BOTH.base, bit: VAULT_ON_N2 }), "refused", "carried"),
  same("vault-first", "then the front door disables its primary (its exits close)", rails({ base: { exits: CLOSED, rails: { [BA]: onBase(TA, false, true), [N]: onBase(N2, true) } }, bit: VAULT_ON_N2 }), "carried", "carried"),
  same(
    "a guardian's non-primary disable mid-migration",
    "the front door on N, the vault still on TA, and the guardian disables N2 on the vault (no hold: the vault reads OPEN)",
    rails({ base: DOOR_ON_N, bit: { rails: { [TA]: onBit(BA, true), [N2]: onBit(N, false, true) } } }),
    "refused",
    "carried",
  ),
  same(
    "a payout half never known",
    "the vault on N2, whose Base half N the front door never enabled",
    rails({ base: { rails: { [BA]: onBase(TA, true), [N]: onBase(N2, false) } }, bit: { primary: N2, rails: { [TA]: onBit(BA, true), [N2]: onBit(N, true) } } }),
    "carried",
    "refused",
  ),
  same(
    "halves not naming each other",
    "the front door's half TA takes messages only from a stranger's Base adapter (and the vault's payouts go to it, never enabled on the front door)",
    rails({ base: { rails: { [BA]: onBase(TA, true), [XB]: onBase(TA, false) } }, bit: { rails: { [TA]: onBit(XB, true) } } }),
    "refused",
    "refused",
  ),
  same(
    "halves not naming each other",
    "the vault's half BA takes messages only from a stranger's Bittensor adapter (and the front door's batches go to it, never enabled on the vault)",
    rails({ base: { rails: { [BA]: onBase(XT, true) } }, bit: { rails: { [TA]: onBit(BA, true), [XT]: onBit(BA, false) } } }),
    "refused",
    "refused",
  ),
  same("halves not naming each other", "TA names BA, but on another chain (10)", rails({ bit: { rails: { [TA]: half(BA, 10n, true) } } }), "refused", "refused"),
  same("a wrong chain", "the front door's primary sends to chain 1, not the vault's", rails({ base: { rails: { [BA]: half(TA, 1n, true) } } }), "refused", "refused"),
  same(
    "the vault's own disabled primary while the front door sends through it",
    "the launch rail with TA disabled on the vault, its exits closed (the batches park: both refuse; no payout leaves: both quiet)",
    rails({ bit: { exits: CLOSED, rails: { [TA]: onBit(BA, false, true) } } }),
    "refused",
    "carried",
  ),
  same(
    "a pair not set up as the deploy's",
    "both sides switched to N and N2, and N2's router is another than the deploy's Bittensor adapter's (R4-O's fix round, Minor 8)",
    rails({ base: DOOR_ON_N, bit: { primary: N2, rails: { [TA]: onBit(BA, false, true), [N2]: { ...onBit(N, true), router: ANOTHER } } } }),
    "refused",
    "refused",
  ),
  same(
    "a pair not set up as the deploy's",
    "both sides switched to N and N2, and N's token is another than the deploy's Base adapter's",
    rails({ base: { ...DOOR_ON_N, rails: { [BA]: onBase(TA, false, true), [N]: { ...onBase(N2, true), token: ANOTHER } } }, bit: VAULT_ON_N2 }),
    "refused",
    "refused",
  ),
  same(
    "the migration's AlphaVault",
    "both sides switched to N and N2, and N2 names the deploy's AlphaVault's announced migration target (R4-O round 2)",
    rails({ base: DOOR_ON_N, bit: { primary: N2, alphaTarget: NEW_AV, rails: { [TA]: onBit(BA, false, true), [N2]: { ...onBit(N, true), alphaVault: NEW_AV } } } }),
    "carried",
    "carried",
  ),
  same(
    "the migration's AlphaVault",
    "the same, but N2 names another vault than the announced target",
    rails({ base: DOOR_ON_N, bit: { primary: N2, alphaTarget: NEW_AV, rails: { [TA]: onBit(BA, false, true), [N2]: { ...onBit(N, true), alphaVault: ANOTHER } } } }),
    "refused",
    "refused",
  ),
  same(
    "the migration's AlphaVault",
    "the live target cleared after the migration, the address recorded from it the vault N2 names (R4-O round 3)",
    rails({ base: DOOR_ON_N, bit: { primary: N2, alphaRecorded: NEW_AV, alphaFinished: true, rails: { [TA]: onBit(BA, false, true), [N2]: { ...onBit(N, true), alphaVault: NEW_AV } } } }),
    "carried",
    "carried",
  ),
  same(
    "the migration's AlphaVault",
    "the target cleared by a cancel (no migration finished), the address recorded from it the vault N2 names (R4-O round 4)",
    rails({ base: DOOR_ON_N, bit: { primary: N2, alphaRecorded: NEW_AV, alphaFinished: false, rails: { [TA]: onBit(BA, false, true), [N2]: { ...onBit(N, true), alphaVault: NEW_AV } } } }),
    "refused",
    "refused",
  ),
  same(
    "the migration's AlphaVault",
    "the live target cleared, the address recorded from it another than the vault N2 names",
    rails({ base: DOOR_ON_N, bit: { primary: N2, alphaRecorded: ANOTHER, rails: { [TA]: onBit(BA, false, true), [N2]: { ...onBit(N, true), alphaVault: NEW_AV } } } }),
    "refused",
    "refused",
  ),
  same(
    "the migration's AlphaVault",
    "N2 names the new vault with no migration announced",
    rails({ base: DOOR_ON_N, bit: { primary: N2, rails: { [TA]: onBit(BA, false, true), [N2]: { ...onBit(N, true), alphaVault: NEW_AV } } } }),
    "refused",
    "refused",
  ),
  same(
    "a needed activation pending",
    "the front door switched to N before the vault's activateBridge(N2) ran (ops' 'now' counts no pending item; the monitor takes none as enabled)",
    rails({ base: DOOR_ON_N, bit: { rails: { [TA]: onBit(BA, true), [N2]: onBit(N, false) } }, pending: [{ chain: "bittensor", bridge: N2 }] }),
    "refused",
    "carried",
  ),
];

/** The parity table's rows (the T47b re-review, task-47b-rereview.md): each has at least one state in this test. */
const TABLE = [
  "coherent",
  "split rails",
  "in-order steps",
  "the front door switched first",
  "vault-first",
  "a guardian's non-primary disable mid-migration",
  "a payout half never known",
  "halves not naming each other",
  "a wrong chain",
  "the vault's own disabled primary while the front door sends through it",
  "a needed activation pending",
  "a pair not set up as the deploy's",
  "the migration's AlphaVault",
  "DELIBERATE 1",
  "DELIBERATE 2",
];

describe("the rails judged alike by the monitor (rails.incoherent) and ops (railCoherence, now): one table of states", () => {
  it("covers every row of the parity table, the six in-order steps among them", () => {
    const rows = new Set([...SAME.map((s) => s.row), ...DELIBERATE.map((d) => d.row)]);
    expect([...rows].sort()).toEqual([...TABLE].sort());
    expect(SAME.filter((s) => s.row === "in-order steps")).toHaveLength(6);
  });

  for (const s of SAME) {
    it(`the same: ${s.row}: ${s.name}`, () => {
      const monitor = monitorOf(s.rails).verdict;
      const ops = opsOf(s.rails).verdict;
      expect({ monitor, ops }).toEqual({ monitor: s.both, ops: s.both });
    });
  }

  it("the needed activation's row: ops counts the pending item only once it runs, and the monitor names it as the fix", () => {
    const s = SAME.find((x) => x.row === "a needed activation pending")!;
    const { findings } = monitorOf(s.rails);
    expect(findings.map((f) => f.key)).toEqual(["rails.incoherent:batches"]);
    expect(findings[0].facts["pending to fix it"]).toMatch(new RegExp(`^activateBridge\\(${N2}\\) on the vault, ready at `));
    const o = opsOf(s.rails);
    expect(o.report.failures).toHaveLength(1);
    expect(railCoherence({ ...o.state, planned: [] }).coherent).toBe(true);
  });
});

/** A state the two judge differently on purpose, one pair at a time. */
interface Deliberate {
  row: "DELIBERATE 1" | "DELIBERATE 2";
  name: string;
  rails: Rails;
  monitor: Verdict;
  ops: Verdict;
  /** the pairs where they differ */
  differ: (typeof DIRECTIONS)[number][];
  /** DELIBERATE 2: the sender whose primary is disabled; ops' words "now" name it, sending nothing, where the rails agree */
  disabled?: { sender: "front door" | "vault"; bridge: Hex; opsAgrees: boolean };
}

const VAULT_ALONE = rails({ base: ENABLED_BOTH.base, bit: VAULT_ON_N2 });
const NO_PAYOUT_HALF = rails({ base: { rails: { [BA]: onBase(TA, true), [N]: onBase(N2, false) } }, bit: { primary: N2, rails: { [TA]: onBit(BA, true), [N2]: onBit(N, true) } } });
const withDoor = (r: Rails, doorState: number): Rails => ({ ...r, bit: { ...r.bit, doorState } });
/** The front door's own primary disabled (the front door's batches' sender), its chain OPEN or closed. */
const doorDisabled = (exits: Exits) => rails({ base: { exits, rails: { [BA]: onBase(TA, false, true) } } });
/** The vault's own primary disabled, the front door on its own rail N (so the vault's primary is only the payouts'
 * sender), the vault OPEN or closed. */
const vaultDisabled = (exits: Exits) => rails({ base: DOOR_ON_N, bit: { exits, rails: { [TA]: onBit(BA, false, true), [N2]: onBit(N, true) } } });

const DELIBERATE: Deliberate[] = [
  ...[0, 2].flatMap((door): Deliberate[] => [
    {
      row: "DELIBERATE 1",
      name: `the vault switched alone, the launch door ${door === 0 ? "never active" : "removed"} (state ${door}): the batches`,
      rails: withDoor(VAULT_ALONE, door),
      monitor: { batches: "carried", payouts: "carried" },
      ops: { batches: "refused", payouts: "carried" },
      differ: ["batches"],
    },
    {
      row: "DELIBERATE 1",
      name: `the vault's Base half never known, the launch door ${door === 0 ? "never active" : "removed"} (state ${door}): the payouts`,
      rails: withDoor(NO_PAYOUT_HALF, door),
      monitor: { batches: "carried", payouts: "carried" },
      ops: { batches: "carried", payouts: "refused" },
      differ: ["payouts"],
    },
  ]),
  {
    row: "DELIBERATE 2",
    name: "the front door's own primary disabled, Base OPEN (a guardian's swap ended its hold): the batches",
    rails: doorDisabled(OPEN),
    monitor: { batches: "refused", payouts: "carried" },
    ops: { batches: "carried", payouts: "carried" },
    differ: ["batches"],
    disabled: { sender: "front door", bridge: BA, opsAgrees: true },
  },
  {
    row: "DELIBERATE 2",
    name: "the vault's own primary disabled, the vault OPEN, the front door on its own rail: the payouts (the batches both refuse: no payout rail, R6)",
    rails: vaultDisabled(OPEN),
    monitor: { batches: "refused", payouts: "refused" },
    ops: { batches: "refused", payouts: "carried" },
    differ: ["payouts"],
    disabled: { sender: "vault", bridge: TA, opsAgrees: false },
  },
  {
    row: "DELIBERATE 2",
    name: "the launch rail's vault primary disabled, the vault OPEN: the payouts (the batches it still carries both refuse)",
    rails: rails({ bit: { rails: { [TA]: onBit(BA, false, true) } } }),
    monitor: { batches: "refused", payouts: "refused" },
    ops: { batches: "refused", payouts: "carried" },
    differ: ["payouts"],
    disabled: { sender: "vault", bridge: TA, opsAgrees: false },
  },
  {
    row: "DELIBERATE 2",
    name: "the front door's own primary disabled, Base closed: no difference (the monitor moot, ops agrees)",
    rails: doorDisabled(CLOSED),
    monitor: { batches: "carried", payouts: "carried" },
    ops: { batches: "carried", payouts: "carried" },
    differ: [],
    disabled: { sender: "front door", bridge: BA, opsAgrees: true },
  },
  {
    row: "DELIBERATE 2",
    name: "the vault's own primary disabled, the vault closed, the front door on its own rail: no difference (the payouts moot for the monitor; the batches both refuse: no payout rail, R6)",
    rails: vaultDisabled(CLOSED),
    monitor: { batches: "refused", payouts: "carried" },
    ops: { batches: "refused", payouts: "carried" },
    differ: [],
    disabled: { sender: "vault", bridge: TA, opsAgrees: false },
  },
];

/** Each deliberate difference's reason, for its test's name. */
const WHY: Record<Deliberate["row"], string> = {
  "DELIBERATE 1":
    "no launch door: the monitor is moot (the vault refuses the door itself, and admin.exits_state reports it), while ops judges the rails as usual (its rail check reads no door, and a door can come back)",
  "DELIBERATE 2":
    "a sender's own disabled primary: the monitor fires once that chain reads OPEN (no other rule sees it then) and is moot while it reads closed (admin.exits_state's), while ops agrees either way (a disabled primary sends nothing)",
};

describe("the rails judged differently on purpose: the parity table's two deliberate differences", () => {
  for (const d of DELIBERATE) {
    it(`${d.row}, ${WHY[d.row]}: ${d.name}`, () => {
      const monitor = monitorOf(d.rails);
      const ops = opsOf(d.rails);
      expect({ monitor: monitor.verdict, ops: ops.verdict }).toEqual({ monitor: d.monitor, ops: d.ops });
      // asserted as a difference where it is one, and as the same on the other pair
      for (const dir of DIRECTIONS) {
        if (d.differ.includes(dir)) expect(monitor.verdict[dir], dir).not.toBe(ops.verdict[dir]);
        else expect(monitor.verdict[dir], dir).toBe(ops.verdict[dir]);
      }
      if (d.disabled) {
        const { sender, bridge, opsAgrees } = d.disabled;
        // ops' words "now": the disabled primary sends nothing (verify's line where the rails agree on both pairs)
        if (opsAgrees) expect(ops.report.info.join(" | ")).toContain(`the ${sender}'s primary ${getAddress(bridge)} is disabled, so it sends nothing`);
        else expect(ops.now.primary[sender === "vault" ? "vault" : "frontDoor"].enabled).toBe(false);
        // the monitor's, where it fires on the sender's own pair: the subject names the sender's disabled primary
        for (const dir of d.differ) {
          const f = monitor.findings.find((x) => x.key === `rails.incoherent:${dir}`);
          expect(f?.subject, dir).toMatch(new RegExp(`^The ${sender}'s primary bridge is disabled: `));
        }
      }
    });
  }
});

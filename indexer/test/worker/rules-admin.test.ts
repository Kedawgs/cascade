import { encodeFunctionData, type Hex, keccak256, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { ADMIN_EVENTS, LIMIT_SETTERS, SCHEDULABLE } from "../../src/abi.ts";
import { ATTRIBUTABLE } from "../../src/attribute.ts";
import type { ChainName, Config } from "../../src/config.ts";
import type { StoredLog } from "../../src/logs.ts";
import { adminEvent, decodesOf, exitsState, hotkeySwitched, keys, ownerKind, ownerPending, schedulerItems, setFull, watchedRoles } from "../../src/rules/admin.ts";
import { monitorUnjudged } from "../../src/rules/ops.ts";
import { logQuery, type RuleCtx, utc } from "../../src/rules/context.ts";
import { RULES } from "../../src/rules/ids.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import { stakeAdopted } from "../../src/rules/vault.ts";
import { flowOf } from "../../src/flow.ts";
import {
  decodeItem,
  isEffectOf,
  ITEMS_KEY,
  MAX_FINISHED_ITEMS,
  MAX_LIVE_ITEMS,
  MAX_REFUSED_ITEMS,
  parseItems,
  parseRefused,
  REFUSED_KEY,
  scheduledIdsOf,
  type TrackedItem,
} from "../../src/scheduler.ts";
import type { BaseState, BitState, ScheduledItem, Snapshot } from "../../src/snapshot.ts";
import type { NonceRow, TxRow } from "../../src/store.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import deploymentV32 from "../fixtures/deployment-v3.2.json";
import { testConfig, testConfigV32, tx } from "./fixtures.ts";
import { baseState, bitState, reading, ruleCtx, slog } from "./rule-ctx.ts";

const NOW = 1_800_000_000;
// one address that is owner, guardian and keeper at once, as on v3-test
const ADMIN = "0x00000000000000000000000000000000000000a1" as Hex;
const OWNER = "0x00000000000000000000000000000000000000a2" as Hex;
const KEEPER = "0x00000000000000000000000000000000000000a3" as Hex;
const SAFE = "0x00000000000000000000000000000000000000a4" as Hex;
const SIGNER = "0x00000000000000000000000000000000000000a5" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
const FD = "0x8a825738d0287d0959957a0f6ec18ba1276d209d" as Hex;

/** Every log given is first stored by this tick, unless `stored` lists it as stored before. */
function ctx(o: {
  logs?: StoredLog[];
  stored?: StoredLog[];
  txs?: TxRow[];
  newTxs?: TxRow[];
  base?: Partial<BaseState>;
  bit?: Partial<BitState>;
  counts?: { base?: Record<Hex, bigint>; bittensor?: Record<Hex, bigint> };
  safeNonces?: { base?: Record<Hex, bigint>; bittensor?: Record<Hex, bigint> };
  nonces?: NonceRow[];
  nowS?: number;
  meta?: Record<string, string>;
}): RuleCtx {
  const c = ruleCtx({
    nowS: o.nowS ?? NOW,
    snap: {
      at: o.nowS ?? NOW,
      base: o.base ? reading(37_000_300n, NOW, baseState(o.base)) : undefined,
      bittensor: o.bit ? reading(6_900_300n, NOW, bitState(o.bit)) : undefined,
      nonces: { base: o.counts?.base ?? {}, bittensor: o.counts?.bittensor ?? {} },
      safeNonces: { base: o.safeNonces?.base ?? {}, bittensor: o.safeNonces?.bittensor ?? {} },
      messageStates: {},
      deliveredReads: [],
    },
    logs: logQuery([...(o.stored ?? []), ...(o.logs ?? [])]),
    newUids: new Set((o.logs ?? []).map((l) => l.uid)),
    txs: new Map((o.txs ?? []).map((t) => [`${t.chain}:${t.hash}`, t])),
    newTxs: o.newTxs ?? [],
    nonces: o.nonces ?? [],
    meta: o.meta ?? {},
  });
  return c;
}

describe("admin.event", () => {
  const limitSet = (block: bigint) =>
    slog({ contract: "frontDoor", event: "LimitSet", chain: "base", address: FD, block, txHash: tx(7), args: { name: "0x6d61784261746368", a: "5000000000000000000", b: "0" } });

  it("finds an admin event after the baseline, naming the event, its args and the sender", () => {
    const l = limitSet(37_000_150n);
    const found = adminEvent.run(ctx({ logs: [l], txs: [{ chain: "base", hash: tx(7), from: ADMIN, to: FD, selector: "0x12345678", nonce: 3 }] }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: "admin.event", key: `admin.event:${l.uid}` });
    expect(found[0].subject).toContain("LimitSet");
    expect(found[0].facts).toMatchObject({ event: "front door LimitSet", sender: ADMIN, a: "5000000000000000000", b: "0" });
    expect(found[0].facts.transaction).toBe(`https://basescan.org/tx/${tx(7)}`);
  });

  it("ignores the deployment's own setup (at or before the baseline block) and events stored on an earlier tick", () => {
    expect(adminEvent.run(ctx({ logs: [limitSet(37_000_050n)] }))).toEqual([]);
    expect(adminEvent.run(ctx({ stored: [limitSet(37_000_150n)] }))).toEqual([]);
  });

  it("finds an admin event a re-read found late, below the blocks settled before", () => {
    // stored for the first time this tick, though Base was settled far past its block long ago
    const late = limitSet(37_000_051n);
    expect(adminEvent.run(ctx({ logs: [late], stored: [limitSet(37_000_900n)] })).map((f) => f.key)).toEqual([`admin.event:${late.uid}`]);
  });

  it("finds vault Paused, with the sender unknown when its transaction isn't fetched yet", () => {
    const l = slog({ contract: "vault", event: "Paused", block: 6_900_120n, args: { account: ADMIN } });
    const [f] = adminEvent.run(ctx({ logs: [l] }));
    expect(f.facts).toMatchObject({ event: "vault Paused", account: ADMIN, sender: "not known yet" });
    expect(f.facts.transaction).toBe(`https://evm.taostats.io/tx/${l.txHash}`);
  });

  it("does not count other events", () => {
    expect(adminEvent.run(ctx({ logs: [slog({ contract: "frontDoor", event: "DepositRequested", block: 37_000_150n })] }))).toEqual([]);
  });
});

describe("watchedRoles", () => {
  it("lists each chain's role holders, the zero address left out", () => {
    const w = watchedRoles(
      ctx({
        base: { owner: ADMIN, guardian: ADMIN, keeper: ADMIN, pendingOwner: ZERO, stakerOwner: OWNER },
        bit: { owner: ADMIN, guardian: ADMIN, keeper: KEEPER, pendingGuardian: ZERO },
      }).snap,
    );
    expect(w).toEqual([
      { chain: "base", address: ADMIN, roles: ["frontDoor.owner", "frontDoor.guardian", "frontDoor.keeper"] },
      { chain: "base", address: OWNER, roles: ["staker.owner"] },
      { chain: "bittensor", address: ADMIN, roles: ["vault.owner", "vault.guardian"] },
      { chain: "bittensor", address: KEEPER, roles: ["vault.keeper"] },
    ]);
  });
});

describe("keys.unexplained_tx and keys.keeper_unexplained_tx", () => {
  const row = (o: Partial<NonceRow> & Pick<NonceRow, "address">): NonceRow => ({ chain: "base", roles: ["frontDoor.owner", "frontDoor.guardian", "frontDoor.keeper"], baseline: 50, seen: 0, nonce: 50, changedAt: NOW - 3600, ...o });
  const sent = (n: number, from: Hex, o: Partial<TxRow> = {}): TxRow[] => Array.from({ length: n }, (_, i) => ({ chain: "base", hash: tx(900 + i), from, ...o }));
  const admin = { owner: ADMIN, guardian: ADMIN, keeper: ADMIN };

  it("starts a newly watched address at its current count", () => {
    const c = ctx({ base: admin, counts: { base: { [ADMIN]: 57n } } });
    expect(keys.run(c)).toEqual([]);
    expect(c.writes.nonces).toEqual([row({ address: ADMIN, baseline: 57, nonce: 57, changedAt: NOW })]);
  });

  it("is quiet when every new transaction is seen in Cascade's logs, including ones known from an event's args", () => {
    const c = ctx({ base: admin, counts: { base: { [ADMIN]: 52n } }, nonces: [row({ address: ADMIN })], newTxs: [...sent(1, ADMIN, { nonce: 50 }), { chain: "base", hash: tx(5), from: ADMIN }] });
    expect(keys.run(c)).toEqual([]);
    expect(c.writes.nonces).toEqual([row({ address: ADMIN, seen: 2, nonce: 52 })]);
  });

  it("counts a transaction sent to an account as nothing: only a Safe's executions arrive that way", () => {
    // the account's own count didn't move for a transaction someone sent it
    const c = ctx({ base: admin, counts: { base: { [ADMIN]: 50n } }, nonces: [row({ address: ADMIN })], newTxs: sent(1, SIGNER, { to: ADMIN }) });
    expect(keys.run(c)).toEqual([]);
    expect(c.writes.nonces).toEqual([]);
  });

  it("finds one transaction more than seen only after 900 s, as a critical for an owner, then absorbs it", () => {
    const first = ctx({ base: admin, counts: { base: { [ADMIN]: 53n } }, nonces: [row({ address: ADMIN })], newTxs: sent(2, ADMIN) });
    expect(keys.run(first)).toEqual([]);
    const waiting = first.writes.nonces[0];
    expect(waiting).toEqual(row({ address: ADMIN, seen: 2, nonce: 53, changedAt: NOW }));
    // still one ahead 899 s later: nothing yet, and nothing to write
    const later = ctx({ base: admin, counts: { base: { [ADMIN]: 53n } }, nonces: [waiting], nowS: NOW + 899 });
    expect(keys.run(later)).toEqual([]);
    expect(later.writes.nonces).toEqual([]);
    const due = ctx({ base: admin, counts: { base: { [ADMIN]: 53n } }, nonces: [waiting], nowS: NOW + 900 });
    const [f] = keys.run(due);
    expect(f).toMatchObject({ rule: "keys.unexplained_tx", key: `keys.unexplained_tx:base:${ADMIN}:53` });
    expect(f.facts).toMatchObject({ address: ADMIN, explorer: `https://basescan.org/address/${ADMIN}`, unexplained: "1" });
    expect(f.facts.roles).toContain("frontDoor.keeper");
    // absorbed: the next tick is quiet
    const absorbed = due.writes.nonces[0];
    expect(absorbed.baseline).toBe(51);
    expect(keys.run(ctx({ base: admin, counts: { base: { [ADMIN]: 53n } }, nonces: [absorbed], nowS: NOW + 960 }))).toEqual([]);
  });

  it("is quiet when the transactions are seen before 900 s", () => {
    const behind = row({ address: ADMIN, nonce: 52, changedAt: NOW - 600 });
    const c = ctx({ base: admin, counts: { base: { [ADMIN]: 52n } }, nonces: [behind], newTxs: sent(2, ADMIN), nowS: NOW + 300 });
    expect(keys.run(c)).toEqual([]);
    expect(c.writes.nonces[0]).toMatchObject({ seen: 2, baseline: 50 });
  });

  it("gives a keeper-only address the warning, and an owner the critical", () => {
    const c = ctx({
      bit: { owner: OWNER, guardian: OWNER, keeper: KEEPER },
      counts: { bittensor: { [OWNER]: 11n, [KEEPER]: 31n } },
      nonces: [
        row({ chain: "bittensor", address: OWNER, roles: ["vault.owner", "vault.guardian"], baseline: 10, nonce: 11, changedAt: NOW - 1000 }),
        row({ chain: "bittensor", address: KEEPER, roles: ["vault.keeper"], baseline: 30, nonce: 31, changedAt: NOW - 1000 }),
      ],
    });
    const found = keys.run(c);
    expect(found.map((f) => [f.rule, f.facts.address])).toEqual([
      ["keys.unexplained_tx", OWNER],
      ["keys.keeper_unexplained_tx", KEEPER],
    ]);
    expect(found[1].facts.explorer).toBe(`https://evm.taostats.io/address/${KEEPER}`);
  });

  it("judges a Safe owner by its nonce() against the admin transactions it executed", () => {
    const safeRow = row({ address: SAFE, roles: ["frontDoor.owner"], baseline: 3, nonce: 3 });
    const executed = sent(2, SIGNER, { to: SAFE });
    const c = ctx({ base: { owner: SAFE }, safeNonces: { base: { [SAFE]: 5n } }, nonces: [safeRow], newTxs: executed });
    expect(keys.run(c)).toEqual([]);
    expect(c.writes.nonces[0]).toMatchObject({ seen: 2, nonce: 5 });
    const one = ctx({ base: { owner: SAFE }, safeNonces: { base: { [SAFE]: 5n } }, nonces: [{ ...safeRow, changedAt: NOW - 2000 }], newTxs: executed.slice(0, 1) });
    expect(keys.run(one)).toEqual([]);
    expect(one.writes.nonces[0]).toMatchObject({ changedAt: NOW });
  });

  it("remembers a Safe: a tick without its nonce() (its code misread) is skipped, never judged by its transaction count", () => {
    // first read as a Safe: the row is marked
    const first = ctx({ base: { owner: SAFE }, safeNonces: { base: { [SAFE]: 3n } }, counts: { base: { [SAFE]: 1n } } });
    keys.run(first);
    expect(first.writes.nonces).toEqual([expect.objectContaining({ address: SAFE, nonce: 3, safe: true })]);
    const safeRow = first.writes.nonces[0];
    // a tick where only its transaction count (1) answers: nothing judged, nothing written
    const misread = ctx({ base: { owner: SAFE }, counts: { base: { [SAFE]: 1n } }, nonces: [safeRow] });
    expect(keys.run(misread)).toEqual([]);
    expect(misread.writes.nonces).toEqual([]);
    // and its nonce() back, unchanged: still nothing (the baseline wasn't reset to the count)
    const back = ctx({ base: { owner: SAFE }, safeNonces: { base: { [SAFE]: 3n } }, counts: { base: { [SAFE]: 1n } }, nonces: [safeRow], nowS: NOW + 3600 });
    expect(keys.run(back)).toEqual([]);
  });

  it("warns when a watched Safe's nonce() hasn't answered for 30 ticks in a row (it isn't skipped silently forever)", () => {
    const k = `safe_unread:base:${SAFE}`;
    const safeRow: NonceRow = { ...row({ address: SAFE, roles: ["frontDoor.owner"], baseline: 3, nonce: 3 }), safe: true };
    const unread = (n: string | undefined) => ctx({ base: { owner: SAFE }, counts: { base: { [SAFE]: 1n } }, nonces: [safeRow], meta: n === undefined ? {} : { [k]: n } });
    const first = unread(undefined);
    expect(keys.run(first)).toEqual([]);
    expect(first.writes.meta).toEqual([{ k, v: "1" }]);
    const almost = unread("28");
    expect(keys.run(almost)).toEqual([]);
    expect(almost.writes.meta).toEqual([{ k, v: "29" }]);
    const thirty = unread("29");
    expect(keys.run(thirty).map((f) => [f.rule, f.key, f.facts.ticks])).toEqual([["keys.safe_unread", `keys.safe_unread:base:${SAFE}`, "30"]]);
    // its nonce() back: the count starts again (and the warning, a condition, clears)
    const back = ctx({ base: { owner: SAFE }, safeNonces: { base: { [SAFE]: 3n } }, nonces: [safeRow], meta: { [k]: "31" } });
    expect(keys.run(back)).toEqual([]);
    expect(back.writes.meta).toEqual([{ k, v: "" }]);
    expect(RUNBOOK["keys.safe_unread"]({})).toContain("nonce()");
  });

  it("keys.count_unread: warns once a chain's transaction counts have gone unread countUnreadTicks ticks in a row, not before, and clears on the next read", () => {
    expect(DEFAULTS.countUnreadTicks).toBe(15);
    expect(RULES["keys.count_unread"]).toEqual({ tier: "warning", kind: "condition", canHold: false, mutedByHold: false });
    expect(keys.raises).toContain("keys.count_unread");
    const k = "count_unread:base";
    const watched = [row({ address: OWNER, roles: ["frontDoor.owner"], baseline: 1, nonce: 1 })];
    const tick = (read: boolean, n?: string) => ctx({ base: { owner: OWNER }, counts: { base: read ? { [OWNER]: 1n } : {} }, nonces: watched, meta: n === undefined ? {} : { [k]: n } });
    // the first unread tick is counted
    const first = tick(false);
    expect(keys.run(first)).toEqual([]);
    expect(first.writes.meta).toEqual([{ k, v: "1" }]);
    // the 14th: still nothing
    const almost = tick(false, "13");
    expect(keys.run(almost)).toEqual([]);
    expect(almost.writes.meta).toEqual([{ k, v: "14" }]);
    // the 15th: the warning, naming the chain, the ticks and the keys it can't count
    const due = tick(false, "14");
    const [f, ...rest] = keys.run(due);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ rule: "keys.count_unread", key: "keys.count_unread:base", facts: { chain: "base", ticks: "15", addresses: OWNER } });
    expect(due.writes.meta).toEqual([{ k, v: "15" }]);
    // and on every unread tick after it, under the same key (a condition: one alert)
    expect(keys.run(tick(false, "40")).map((x) => x.key)).toEqual(["keys.count_unread:base"]);
    // a count read again: the mark cleared, nothing found (the warning resolves)
    const back = tick(true, "40");
    expect(keys.run(back)).toEqual([]);
    expect(back.writes.meta).toEqual([{ k, v: "" }]);
    // a count read with no mark: nothing written
    const steadyRead = tick(true);
    keys.run(steadyRead);
    expect(steadyRead.writes.meta).toEqual([]);
    expect(RUNBOOK["keys.count_unread"]({ chain: "base" })).toContain("BASE_RPC_URL");
    expect(RUNBOOK["keys.count_unread"]({ chain: "bittensor" })).toContain("BITTENSOR_RPC_URL");
  });

  it("keys.count_unread runs per chain: Base's counts unread doesn't count against Bittensor's, nor the other way round", () => {
    const watched = [row({ address: OWNER, roles: ["frontDoor.owner"], baseline: 1, nonce: 1 }), row({ chain: "bittensor", address: KEEPER, roles: ["vault.keeper"], baseline: 5, nonce: 5 })];
    const tick = (o: { base: boolean; bit: boolean; meta?: Record<string, string> }) =>
      ctx({ base: { owner: OWNER }, bit: { keeper: KEEPER }, counts: { base: o.base ? { [OWNER]: 1n } : {}, bittensor: o.bit ? { [KEEPER]: 5n } : {} }, nonces: watched, meta: o.meta ?? {} });
    const baseOut = tick({ base: false, bit: true, meta: { "count_unread:base": "14", "count_unread:bittensor": "3" } });
    expect(keys.run(baseOut).map((f) => [f.key, f.facts.chain])).toEqual([["keys.count_unread:base", "base"]]);
    expect(baseOut.writes.meta).toEqual([
      { k: "count_unread:base", v: "15" },
      { k: "count_unread:bittensor", v: "" },
    ]);
    const bitOut = tick({ base: true, bit: false, meta: { "count_unread:bittensor": "14" } });
    expect(keys.run(bitOut).map((f) => [f.key, f.facts.addresses])).toEqual([["keys.count_unread:bittensor", KEEPER]]);
    expect(bitOut.writes.meta).toEqual([{ k: "count_unread:bittensor", v: "15" }]);
    // a chain with no watched key yet (a fresh database, its first reading) asked for no count: nothing is counted
    const fresh = ctx({ base: { owner: OWNER } });
    expect(keys.run(fresh)).toEqual([]);
    expect(fresh.writes.meta).toEqual([]);
  });

  it("marks a watched account a Safe once its nonce() is read (a Safe deployed at it)", () => {
    const c = ctx({ base: { owner: SAFE }, safeNonces: { base: { [SAFE]: 0n } }, nonces: [row({ address: SAFE, roles: ["frontDoor.owner"], baseline: 0, nonce: 0 })] });
    keys.run(c);
    expect(c.writes.nonces).toEqual([expect.objectContaining({ address: SAFE, safe: true })]);
  });

  // The count is read at the head in a request of its own, so a load-balanced node can answer it from an older head
  // than the logs'. Only a count PROVABLY stale is tolerated: one below what is already known of it (the highest count
  // read; one past the nonce of each of the account's own settled transactions; for a Safe, one more for each execution
  // logged after the reading's block), for nonceBehindTicks readings in a row. A current count behind what the logs
  // explain (a transaction counted twice, a reorg) is a new start at once, so nothing unexplained can fill the gap.
  const OWNER_ROLES = ["frontDoor.owner", "frontDoor.guardian"] as const;
  const ownerKey = { owner: OWNER, guardian: OWNER };
  let owned = 0;
  /** one of the address's own transactions, settled this tick: fetched (its nonce known), or known from an event's args */
  const own = (from: Hex, nonce?: number, chain: ChainName = "base"): TxRow => ({ chain, hash: tx(7000 + ++owned), from, ...(nonce === undefined ? {} : { nonce }) });
  const at11 = (address: Hex, roles: readonly string[] = OWNER_ROLES, chain: ChainName = "base") => row({ chain, address, roles: [...roles], baseline: 11, seen: 0, nonce: 11 });
  /** a tick: the count read (none when the tick's count batch failed), and the transactions and logs settled on it */
  type Step = { count?: number; txs?: TxRow[]; logs?: StoredLog[] };
  const steady = (n: number, count: number): Step[] => Array.from({ length: n }, () => ({ count }));
  /** Ticks a minute apart through keys on `chain` (Base unless given), the rows and meta it writes kept as the tick
   * commits them: the findings as "t<tick>:<rule>(<unexplained>)", and the address's row and nonce_behind mark at the
   * end. `holder`: that chain's role readings. `safe`: each count is the address's nonce() (a Safe's), read at the
   * reading's block (Base 37,000,300; Bittensor 6,900,300). */
  function drive(o: { address: Hex; holder: Partial<BaseState> & Partial<BitState>; chain?: ChainName; start?: NonceRow; safe?: boolean; steps: Step[] }) {
    const chain = o.chain ?? "base";
    let rows = o.start ? [o.start] : [];
    const meta: Record<string, string> = {};
    const found: string[] = [];
    o.steps.forEach((s, i) => {
      const read = s.count === undefined ? {} : { [o.address]: BigInt(s.count) };
      const c = ctx({
        ...(chain === "base" ? { base: o.holder } : { bit: o.holder }),
        ...(o.safe ? { safeNonces: { [chain]: read } } : { counts: { [chain]: read } }),
        nonces: rows,
        newTxs: s.txs ?? [],
        logs: s.logs,
        meta: { ...meta },
        nowS: NOW + 60 * i,
      });
      for (const f of keys.run(c)) found.push(`t${i}:${f.rule}(${f.facts.unexplained})`);
      for (const w of c.writes.nonces) rows = [...rows.filter((r) => r.chain !== w.chain || r.address !== w.address), w];
      for (const w of c.writes.meta) meta[w.k] = w.v;
    });
    return { found, end: rows.find((r) => r.chain === chain && r.address === o.address), mark: meta[`nonce_behind:${chain}:${o.address}`] ?? "" };
  }

  // P1, the keeper on Base: its hourly roll counted at the head, then its log settling on a tick whose count a
  // load-balanced node answered from before it. Without the floor the rule would rebase, and report the true count as an
  // unexplained transaction after the grace; on an owner or guardian key the same race would page critical. (Taken at
  // first for the cause of 2026-10-31's alert; that was a count batch failing on the settle tick, below.)
  for (const [who, address, roles, holder] of [
    ["the keeper", KEEPER, ["frontDoor.keeper"], { keeper: KEEPER }],
    ["an owner and guardian key", OWNER, OWNER_ROLES, ownerKey],
  ] as const) {
    it(`P1: a roll counted at the head, then settling on a tick with a count from an older head, is never reported (${who})`, () => {
      const k = `nonce_behind:base:${address}`;
      const was = at11(address, roles);
      // the roll at the head: counted (12), its log not settled yet
      const fresh = ctx({ base: holder, counts: { base: { [address]: 12n } }, nonces: [was] });
      expect(keys.run(fresh)).toEqual([]);
      const ahead = fresh.writes.nonces[0];
      expect(ahead).toEqual({ ...was, nonce: 12, changedAt: NOW });
      // its log settles (nonce 11) while the count is from before it (11): judged by the 12 already read, and marked
      const stale = ctx({ base: holder, counts: { base: { [address]: 11n } }, nonces: [ahead], newTxs: [own(address, 11)], nowS: NOW + 60 });
      expect(keys.run(stale)).toEqual([]);
      expect(stale.writes.nonces).toEqual([{ ...ahead, seen: 1 }]);
      expect(stale.writes.meta).toEqual([{ k, v: "1" }]);
      // the count catches up: the mark cleared, the row as it was
      const caughtUp = ctx({ base: holder, counts: { base: { [address]: 12n } }, nonces: stale.writes.nonces, meta: { [k]: "1" }, nowS: NOW + 120 });
      expect(keys.run(caughtUp)).toEqual([]);
      expect(caughtUp.writes.meta).toEqual([{ k, v: "" }]);
      expect(caughtUp.writes.nonces).toEqual([]);
      // the whole sequence, run on past the grace: nothing, ever
      expect(drive({ address, holder, start: was, steps: [{ count: 12 }, { count: 11, txs: [own(address, 11)] }, ...steady(20, 12)] })).toMatchObject({
        found: [],
        end: { baseline: 11, seen: 1, nonce: 12 },
        mark: "",
      });
    });
  }

  it("P2 and P4: a settled transaction's own nonce proves a count stale with no fresher count read; a node a few readings behind is waited for", () => {
    // never counted at the head: its nonce (11) says the count is at least 12
    expect(drive({ address: OWNER, holder: ownerKey, start: at11(OWNER), steps: [{ count: 11, txs: [own(OWNER, 11)] }, ...steady(20, 12)] })).toMatchObject({
      found: [],
      end: { baseline: 11, seen: 1, nonce: 12 },
      mark: "",
    });
    // behind for 4 readings after the settle
    expect(drive({ address: OWNER, holder: ownerKey, start: at11(OWNER), steps: [{ count: 12 }, { count: 11, txs: [own(OWNER, 11)] }, ...steady(3, 11), ...steady(20, 12)] }).found).toEqual([]);
  });

  it("A2: a stale read after an unexplained transaction neither hides it nor restarts the grace: critical at 15 minutes", () => {
    const r = drive({ address: OWNER, holder: ownerKey, start: at11(OWNER), steps: [{ count: 12 }, ...steady(5, 12), { count: 11 }, ...steady(20, 12)] });
    expect(r.found).toEqual(["t15:keys.unexplained_tx(1)"]);
    expect(RULES["keys.unexplained_tx"].tier).toBe("critical");
    // A1: one sent while the count is stale is reported once the count catches up, as one
    expect(drive({ address: OWNER, holder: ownerKey, start: at11(OWNER), steps: [{ count: 12 }, { count: 11, txs: [own(OWNER, 11)] }, ...steady(20, 13)] }).found).toEqual([
      "t17:keys.unexplained_tx(1)",
    ]);
  });

  it("W1: a first watch whose count held a transaction not yet settled starts again at once when it settles: one sent 3 minutes later is reported", () => {
    // first watched at 12, which already holds nonce 11 (its log not settled); it settles, counted twice
    const watched = ctx({ base: ownerKey, counts: { base: { [OWNER]: 12n } } });
    keys.run(watched);
    const settles = ctx({ base: ownerKey, counts: { base: { [OWNER]: 12n } }, nonces: watched.writes.nonces, newTxs: [own(OWNER, 11)], nowS: NOW + 60 });
    expect(keys.run(settles)).toEqual([]);
    expect(settles.writes.nonces[0]).toMatchObject({ baseline: 11, seen: 1, nonce: 12 });
    expect(settles.writes.meta).toEqual([]);
    const r = drive({ address: OWNER, holder: ownerKey, steps: [{ count: 12 }, { count: 12, txs: [own(OWNER, 11)] }, { count: 12 }, { count: 13 }, ...steady(20, 13)] });
    expect(r.found).toEqual(["t18:keys.unexplained_tx(1)"]);
  });

  it("W3: a busy key's own transactions keep no gap open: one sent 40 minutes after a first watch's double count is reported", () => {
    const steps: Step[] = [{ count: 12 }, { count: 12, txs: [own(OWNER, 11)] }];
    let n = 12;
    // a transaction every 6 minutes, counted at the head and settled 2 minutes later
    for (let k = 0; k < 7; k++) {
      n++;
      steps.push({ count: n }, { count: n }, { count: n, txs: [own(OWNER, n - 1)] }, ...steady(3, n));
    }
    steps.push(...steady(20, n + 1));
    expect(drive({ address: OWNER, holder: ownerKey, steps }).found).toEqual(["t59:keys.unexplained_tx(1)"]);
  });

  it("R2: a reorg past the settle depth that drops a settled transaction is the new start after nonceBehindTicks readings: a later one is reported", () => {
    expect(DEFAULTS.nonceBehindTicks).toBe(10);
    const r = drive({ address: OWNER, holder: ownerKey, start: at11(OWNER), steps: [{ count: 12 }, { count: 12, txs: [own(OWNER, 11)] }, ...steady(12, 11), ...steady(20, 12)] });
    expect(r.found).toEqual(["t29:keys.unexplained_tx(1)"]);
  });

  it("takes back a count read one too high (a node on a fork) before it can page: nonceBehindTicks readings a minute apart end inside the grace", () => {
    expect(DEFAULTS.nonceBehindTicks * 60).toBeLessThan(DEFAULTS.unexplainedTxGraceS);
    expect(drive({ address: OWNER, holder: ownerKey, start: at11(OWNER), steps: [{ count: 12 }, ...steady(25, 11)] })).toMatchObject({ found: [], end: { baseline: 11, nonce: 11 }, mark: "" });
  });

  // Known residuals, pinned as documented (README, "When an email arrives")

  it("R1 (a gap): a reorg past the settle depth whose dropped transaction's nonce is reused within nonceBehindTicks readings isn't reported here", () => {
    // the settled nonce-11 transaction vanishes (indexer.reorg warns of its log); an attacker's reuses nonce 11 five minutes on
    expect(drive({ address: OWNER, holder: ownerKey, start: at11(OWNER), steps: [{ count: 12 }, { count: 12, txs: [own(OWNER, 11)] }, ...steady(5, 11), ...steady(20, 12)] })).toMatchObject({
      found: [],
      mark: "",
    });
  });

  it("P3 (errs safe): an own transaction known only from an event's args (no nonce), settling on a stale tick before any fresh count, is reported", () => {
    expect(drive({ address: OWNER, holder: ownerKey, start: at11(OWNER), steps: [{ count: 11, txs: [own(OWNER)] }, ...steady(20, 12)] }).found).toEqual(["t16:keys.unexplained_tx(1)"]);
  });

  it("P5 (errs safe): a node stuck behind past nonceBehindTicks readings ends the tolerance, and its catching up later is reported", () => {
    expect(drive({ address: OWNER, holder: ownerKey, start: at11(OWNER), steps: [{ count: 12 }, { count: 11, txs: [own(OWNER, 11)] }, ...steady(11, 11), ...steady(20, 12)] }).found).toEqual([
      "t28:keys.unexplained_tx(1)",
    ]);
  });

  it("works the same on Bittensor: the vault keeper's race is quiet, and a transaction no log explains after it is the keeper's warning", () => {
    const r = drive({
      chain: "bittensor",
      address: KEEPER,
      holder: { keeper: KEEPER },
      start: at11(KEEPER, ["vault.keeper"], "bittensor"),
      steps: [{ count: 12 }, { count: 11, txs: [own(KEEPER, 11, "bittensor")] }, ...steady(5, 12), ...steady(20, 13)],
    });
    expect(r.found).toEqual(["t22:keys.keeper_unexplained_tx(1)"]);
    expect(r.end).toMatchObject({ chain: "bittensor", baseline: 12, seen: 1, nonce: 13 });
  });

  // 2026-11-01, the keeper on Base (alerts 13 and 14): the roll's log settled, its transaction fetched, on a tick whose
  // count batch publicnode answered HTTP 429 (no count, no codes). The rule skipped the address before counting the
  // tick's own transactions, and a transaction is new on one tick only, so the roll was never counted: the true count
  // was one unexplained transaction, reported 15 minutes after the head first showed it.
  for (const [who, address, roles, holder, rule] of [
    ["the keeper", KEEPER, ["frontDoor.keeper"], { keeper: KEEPER }, "keys.keeper_unexplained_tx"],
    ["an owner and guardian key", OWNER, OWNER_ROLES, ownerKey, "keys.unexplained_tx"],
  ] as const) {
    it(`2026-11-01: counts the transactions settling on a tick whose count wasn't read, so the roll is never reported (${who})`, () => {
      const was = row({ address, roles: [...roles], baseline: 2, seen: 28, nonce: 30 });
      // production: 31 at the head (19:31:34), the roll settling with no count (19:32:33), no count (19:33:34), 31 (19:34:34), ...
      const unread = { txs: [own(address, 30)] };
      expect(drive({ address, holder, start: was, steps: [{ count: 31 }, unread, {}, { count: 31 }, {}, ...steady(20, 31)] })).toMatchObject({
        found: [],
        end: { baseline: 2, seen: 29, nonce: 31 },
        mark: "",
      });
      // never counted at the head: the roll's nonce, kept from the unread tick, still proves a lagging node's 30 stale
      expect(drive({ address, holder, start: was, steps: [{ count: 30 }, { txs: [own(address, 30)] }, { count: 30 }, ...steady(20, 31)] })).toMatchObject({
        found: [],
        end: { baseline: 2, seen: 29, nonce: 31 },
        mark: "",
      });
      // a transaction no log explains after it is still reported, once, after the grace from when it was first known
      expect(drive({ address, holder, start: was, steps: [{ count: 31 }, { txs: [own(address, 30)] }, ...steady(20, 32)] }).found).toEqual([`t17:${rule}(1)`]);
      // and one shown only by the nonce of a transaction settling on an unread tick (nonce 31 settled, 30 never explained)
      // starts the grace on that tick, not on an older one
      expect(drive({ address, holder, start: was, steps: [{ count: 30 }, { txs: [own(address, 31)] }, ...steady(20, 32)] }).found).toEqual([`t16:${rule}(1)`]);
    });
  }

  /** Safe's execTransaction, which moves nonce(); a module's execTransactionFromModule doesn't */
  const EXEC_TRANSACTION = "0x6a761202" as Hex;
  const FROM_MODULE = "0x468721a7" as Hex;
  /** a transaction to the Safe (execTransaction unless another selector is given), its Cascade log at `block` (the
   * readings are at Base 37,000,300 and Bittensor 6,900,300) */
  const toSafe = (block: bigint, selector: Hex = EXEC_TRANSACTION, chain: ChainName = "base") => {
    const t: TxRow = { ...own(SIGNER, 1, chain), to: SAFE, selector };
    return { txs: [t], logs: [slog({ contract: "frontDoor", event: "LimitSet", chain, address: FD, block, txHash: t.hash })] };
  };

  it("2026-11-01, for a Safe: counts an execution settling on a tick without its nonce() (the count batch failed), so it is never reported", () => {
    const safeRow: NonceRow = { ...row({ address: SAFE, roles: ["frontDoor.owner"], baseline: 3, nonce: 3 }), safe: true };
    expect(drive({ address: SAFE, holder: { owner: SAFE }, start: safeRow, safe: true, steps: [{ count: 4 }, toSafe(37_000_100n), {}, ...steady(20, 4)] })).toMatchObject({
      found: [],
      end: { baseline: 3, seen: 1, nonce: 4, safe: true },
    });
  });

  it("judges a Safe's nonce() the same way: a read below the last is stale, and so is one from a block before an execution just logged", () => {
    const k = `nonce_behind:base:${SAFE}`;
    const safeRow: NonceRow = { ...row({ address: SAFE, roles: ["frontDoor.owner"], baseline: 3, nonce: 3 }), safe: true };
    const owner = { owner: SAFE };
    const exec = (block: bigint) => toSafe(block);
    // read at 4, then the execution settling with a read from before it (3): judged by the 4 already read
    expect(drive({ address: SAFE, holder: owner, start: safeRow, safe: true, steps: [{ count: 4 }, { count: 3, ...exec(37_000_100n) }, ...steady(20, 4)] })).toMatchObject({
      found: [],
      end: { baseline: 3, seen: 1, nonce: 4, safe: true },
      mark: "",
    });
    // never read at 4: the reading's block (37,000,300) is before the execution's log (37,000,301), so its 3 can't hold it
    const later = exec(37_000_301n);
    const c = ctx({ base: owner, safeNonces: { base: { [SAFE]: 3n } }, nonces: [safeRow], newTxs: later.txs, logs: later.logs });
    expect(keys.run(c)).toEqual([]);
    expect(c.writes.nonces).toEqual([{ ...safeRow, seen: 1, nonce: 4 }]);
    expect(c.writes.meta).toEqual([{ k, v: "1" }]);
    expect(drive({ address: SAFE, holder: owner, start: safeRow, safe: true, steps: [{ count: 3, ...exec(37_000_301n) }, ...steady(20, 4)] }).found).toEqual([]);
    // an execution logged at the reading's block is in its nonce(): a read short of it is a new start at once (counted twice)
    const at = exec(37_000_300n);
    const current = ctx({ base: owner, safeNonces: { base: { [SAFE]: 3n } }, nonces: [safeRow], newTxs: at.txs, logs: at.logs });
    expect(keys.run(current)).toEqual([]);
    expect(current.writes.nonces[0]).toMatchObject({ baseline: 2, seen: 1, nonce: 3 });
    expect(current.writes.meta).toEqual([]);
    // an execution no log explains still pages critical after the grace
    expect(drive({ address: SAFE, holder: owner, start: safeRow, safe: true, steps: [{ count: 4 }, ...steady(20, 4)] }).found).toEqual(["t15:keys.unexplained_tx(1)"]);
  });

  it("S4: only execTransaction raises a Safe's floor: a module's call to it after a lagging reading can't hide an execution that follows", () => {
    expect(toFunctionSelector("execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)")).toBe(EXEC_TRANSACTION);
    expect(toFunctionSelector("execTransactionFromModule(address,uint256,bytes,uint8)")).toBe(FROM_MODULE);
    const safeRow: NonceRow = { ...row({ address: SAFE, roles: ["frontDoor.owner"], baseline: 3, nonce: 3 }), safe: true };
    // a module (an EOA) calls execTransactionFromModule, logged after a reading at 3: nonce() never moves for it, so a
    // floor of 4 would absorb the attacker's execTransaction three minutes on
    const module = toSafe(37_000_301n, FROM_MODULE);
    const first = ctx({ base: { owner: SAFE }, safeNonces: { base: { [SAFE]: 3n } }, nonces: [safeRow], newTxs: module.txs, logs: module.logs });
    expect(keys.run(first)).toEqual([]);
    // counted, not held: a new start at once
    expect(first.writes.nonces).toEqual([{ ...safeRow, baseline: 2, seen: 1 }]);
    expect(first.writes.meta).toEqual([]);
    const r = drive({ address: SAFE, holder: { owner: SAFE }, start: safeRow, safe: true, steps: [{ count: 3, ...toSafe(37_000_301n, FROM_MODULE) }, ...steady(3, 3), ...steady(20, 4)] });
    expect(r.found).toEqual(["t19:keys.unexplained_tx(1)"]);
  });

  it("judges one Safe address on both chains (Safe's same-address deploys) by each chain's own nonce() and reading block", () => {
    const rows = (["base", "bittensor"] as const).map((chain): NonceRow => ({ ...row({ chain, address: SAFE, roles: [chain === "base" ? "frontDoor.owner" : "vault.owner"], baseline: 3, nonce: 3 }), safe: true }));
    // Base's reading (37,000,300) holds its execution (logged at 37,000,200); Bittensor's (6,900,300) is from before its
    // own (logged at 6,900,301)
    const onBase = toSafe(37_000_200n);
    const onBit = toSafe(6_900_301n, EXEC_TRANSACTION, "bittensor");
    const c = ctx({
      base: { owner: SAFE },
      bit: { owner: SAFE },
      safeNonces: { base: { [SAFE]: 4n }, bittensor: { [SAFE]: 3n } },
      nonces: rows,
      newTxs: [...onBase.txs, ...onBit.txs],
      logs: [...onBase.logs, ...onBit.logs],
    });
    expect(keys.run(c)).toEqual([]);
    // Base: 4, its execution in it; Bittensor: 3, from before its execution, so at least 4 (and marked)
    expect(c.writes.nonces).toEqual([
      { ...rows[0], seen: 1, nonce: 4 },
      { ...rows[1], seen: 1, nonce: 4 },
    ]);
    expect(c.writes.meta).toEqual([{ k: `nonce_behind:bittensor:${SAFE}`, v: "1" }]);
  });

  it("stops watching an address that holds no role any more (its nonce_behind mark cleared), and waits for a count", () => {
    const gone = ctx({ base: { owner: OWNER }, counts: { base: { [OWNER]: 1n } }, nonces: [row({ address: ADMIN }), row({ address: OWNER, roles: ["frontDoor.owner"], baseline: 1, nonce: 1 })] });
    expect(keys.run(gone)).toEqual([]);
    expect(gone.writes.nonces).toEqual([row({ address: ADMIN, roles: [] })]);
    expect(gone.writes.meta).toEqual([]);
    const k = `nonce_behind:base:${ADMIN}`;
    const marked = ctx({ base: { owner: OWNER }, counts: { base: { [OWNER]: 1n } }, nonces: [row({ address: ADMIN }), row({ address: OWNER, roles: ["frontDoor.owner"], baseline: 1, nonce: 1 })], meta: { [k]: "3" } });
    expect(keys.run(marked)).toEqual([]);
    expect(marked.writes.meta).toEqual([{ k, v: "" }]);
    // a new role holder with no count read yet: nothing written until its count is read
    const noCount = ctx({ base: { keeper: KEEPER } });
    expect(keys.run(noCount)).toEqual([]);
    expect(noCount.writes.nonces).toEqual([]);
  });
});

// ---- v3.2: the scheduler, the exits machine and the owner (Task 55) ----

describe("v3.2's admin rules", () => {
  const cfg32 = testConfigV32();
  const d32 = cfg32.deployment;
  const E18 = 10n ** 18n;
  const DAY = 86_400;
  const G2 = "0x00000000000000000000000000000000000000b2" as Hex;
  const GUARD = "0x00000000000000000000000000000000000000a6" as Hex;
  const HK = (k: number) => `0x${k.toString(16).padStart(64, "0")}` as Hex;
  const STAKE_HK = d32.stakeHotkey;
  const exitsOpen = { open: true, ownerHold: false, guardianHold: false, pausedBy: 0, primaryDisabledBy: 0, launchDoorRemovedBy: 0, lastOwnerClose: 0, lastGuardianClose: 0, pendingSince: 0 };
  const bit32 = (o: Partial<BitState> = {}): Partial<BitState> => ({
    owner: OWNER,
    guardian: GUARD,
    keeper: KEEPER,
    pendingOwner: ZERO,
    exits: exitsOpen,
    scheduled: {},
    msPerBlock: 7_200,
    launchChain: 8453n,
    activeDoors: 1n,
    payoutDelay: DAY,
    maxDailyOutflowBps: 2000n,
    minDailyOutflow: 10n * E18,
    globalOutflowBps: 3000n,
    maxFeeBps: 100n,
    maxFeeAbs: 10n ** 16n,
    maxEntryValue: 10n * E18,
    maxMessageValue: 15n * E18,
    minChunk: 5,
    rewardCutBps: 1000,
    treasury: SIGNER,
    rewardVesting: 7 * DAY,
    maxTotalAssets: 44n * E18,
    idleBufferBps: 0,
    stakeMissing: false,
    stakeHotkey: STAKE_HK,
    hotkeys: [STAKE_HK],
    stakes: { [STAKE_HK]: 40n * 10n ** 9n },
    unclaimedBy: { [STAKE_HK]: 0n },
    hotkeyDustRao: 1000n,
    ...o,
  });
  const base32 = (o: Partial<BaseState> = {}): Partial<BaseState> => ({
    owner: OWNER,
    guardian: GUARD,
    pendingOwner: ZERO,
    exits: { open: true, ownerHold: false, guardianHold: false, primaryDisabledBy: 0, lastOwnerClose: 0, lastGuardianClose: 0, pendingSince: 0 },
    scheduled: {},
    msPerBlock: 120,
    depositCap: 40n * E18,
    batchInterval: 600,
    maxBatchValue: 10n * E18,
    maxDeliverySlippageBps: 150,
    minPoolLiquidity: { taoWeth: 10n ** 17n, wethUsdc: 10n ** 16n },
    ...o,
  });

  /** A v3.2 rule context: both chains read now and on the tick before (the same state unless `prevBit`/`prevBase` is
   * given; null for none), every log given new this tick unless `stored` lists it. */
  function ctx32(o: {
    logs?: StoredLog[];
    stored?: StoredLog[];
    bit?: Partial<BitState> | null;
    base?: Partial<BaseState> | null;
    prevBit?: Partial<BitState> | null;
    prevBase?: Partial<BaseState> | null;
    meta?: Record<string, string>;
    txs?: TxRow[];
    codes?: Snapshot["codes"];
    cfg?: Config;
    bitTime?: number;
    settledTime?: number;
    settledBlock?: bigint;
  }): RuleCtx {
    const bitTime = o.bitTime ?? NOW;
    const bit = o.bit === null ? undefined : bitState(o.bit ?? bit32());
    const base = o.base === null ? undefined : baseState(o.base ?? base32());
    const prevBit = o.prevBit === null ? undefined : o.prevBit ? bitState(o.prevBit) : bit;
    const prevBase = o.prevBase === null ? undefined : o.prevBase ? baseState(o.prevBase) : base;
    return ruleCtx({
      cfg: o.cfg ?? cfg32,
      nowS: NOW,
      snap: {
        at: NOW,
        bittensor: bit ? reading(6_900_300n, bitTime, bit) : undefined,
        base: base ? reading(37_000_300n, NOW, base) : undefined,
        nonces: { base: {}, bittensor: {} },
        safeNonces: { base: {}, bittensor: {} },
        messageStates: {},
        deliveredReads: [],
        codes: o.codes,
      },
      history: { bittensor: prevBit ? [reading(6_900_299n, bitTime - 12, prevBit)] : [], base: prevBase ? [reading(37_000_299n, NOW - 2, prevBase)] : [] },
      logs: logQuery([...(o.stored ?? []), ...(o.logs ?? [])]),
      newUids: new Set((o.logs ?? []).map((l) => l.uid)),
      txs: new Map((o.txs ?? []).map((t) => [`${t.chain}:${t.hash}`, t])),
      meta: o.meta ?? {},
      settled: { base: { block: o.settledBlock ?? 10n ** 9n, time: o.settledTime ?? NOW }, bittensor: { block: o.settledBlock ?? 10n ** 9n, time: o.settledTime ?? NOW } },
    });
  }
  const metaOf = (c: RuleCtx) => Object.fromEntries(c.writes.meta.map((w) => [w.k, w.v]));
  const itemsOf = (c: RuleCtx) => parseItems(metaOf(c)[ITEMS_KEY]);
  const unjudgedOf = (c: RuleCtx) => c.unjudged.map((u) => (u.key ? `${u.rule} ${u.key}` : u.rule));

  let seq = 0;
  /** A Scheduled log of `fn(args)` on `role`, its id and calldata. */
  function scheduled(role: "vault" | "frontDoor", fn: string, args: readonly unknown[], o: { kind?: number; readyAt?: number; block?: bigint; data?: Hex; txHash?: Hex } = {}) {
    seq++;
    const data = (o.data ?? encodeFunctionData({ abi: SCHEDULABLE[role], functionName: fn, args } as never)).toLowerCase() as Hex;
    const id = keccak256(data);
    const readyAt = o.readyAt ?? NOW + 2 * DAY;
    const log = slog({
      contract: role,
      event: "Scheduled",
      block: o.block ?? (role === "vault" ? 6_900_200n : 37_000_200n),
      txHash: o.txHash ?? tx(300_000 + seq),
      args: { id, kind: o.kind ?? 0, selector: data.slice(0, 10), readyAt: String(readyAt), data },
    });
    return { id, data, readyAt, log };
  }
  const closing = (role: "vault" | "frontDoor", event: "Executed" | "Cancelled" | "Lapsed", id: Hex, o: { by?: Hex; block?: bigint; txHash?: Hex; logIndex?: number } = {}) =>
    slog({
      contract: role,
      event,
      block: o.block ?? (role === "vault" ? 6_900_250n : 37_000_250n),
      txHash: o.txHash ?? tx(400_000 + ++seq),
      logIndex: o.logIndex ?? 5,
      args: { id, ...(event === "Cancelled" ? { by: o.by ?? GUARD } : {}) },
    });
  /** The lens's answer for an item still held (scheduled two days before it is ready). */
  const held = (s: { readyAt: number }, o: Partial<ScheduledItem> = {}): ScheduledItem => ({ scheduledAt: s.readyAt - 2 * DAY, readyAt: s.readyAt, class: 0, kind: 0, selector: "0x00000000", readyBlock: 6_914_700n, ...o });
  const GONE: ScheduledItem = { scheduledAt: 0, readyAt: 0, class: 0, kind: 0, selector: "0x00000000", readyBlock: 0n };

  /** The record admin.scheduled keeps of a Scheduled log. */
  function recordOf(s: ReturnType<typeof scheduled>, o: Partial<TrackedItem> = {}): TrackedItem {
    const role = s.log.contract as "vault" | "frontDoor";
    const dec = decodeItem(role, s.data);
    return {
      chain: s.log.chain,
      role,
      id: s.id,
      kind: Number(s.log.args.kind),
      selector: s.data.slice(0, 10) as Hex,
      readyAt: s.readyAt,
      data: s.data,
      ...(dec ? { setter: dec.setter, args: dec.args, canonical: dec.canonical } : {}),
      uid: s.log.uid,
      block: String(s.log.block),
      tx: s.log.txHash,
      ...o,
    };
  }
  const tracked = (...items: TrackedItem[]) => ({ [ITEMS_KEY]: JSON.stringify(items) });

  describe("ADMIN_EVENTS and admin.event", () => {
    it("leaves Scheduled, Executed, Cancelled and Lapsed to their own rules", () => {
      const s = scheduled("vault", "setGuardian", [G2]);
      const logs = [s.log, closing("vault", "Executed", s.id), closing("vault", "Cancelled", s.id), closing("vault", "Lapsed", s.id)];
      for (const l of logs) {
        expect(ADMIN_EVENTS.has(`vault:${l.event}`), l.event).toBe(true);
        expect(ADMIN_EVENTS.has(`frontDoor:${l.event}`), l.event).toBe(true);
      }
      expect(adminEvent.run(ctx32({ logs }))).toEqual([]);
    });

    it("emails one StampedBySig per asOf on each chain: a replay, or an older asOf, emails nothing new", () => {
      const stamp = (asOf: number, chain: ChainName = "bittensor") =>
        slog({ contract: chain === "bittensor" ? "vault" : "frontDoor", event: "StampedBySig", chain, block: chain === "bittensor" ? 6_900_210n : 37_000_210n, args: { asOf: String(asOf), relayer: SIGNER } });
      const c = ctx32({ logs: [stamp(NOW - 60), stamp(NOW - 60), stamp(NOW - 120), stamp(NOW - 60, "base")] });
      const found = adminEvent.run(c);
      expect(found.map((f) => f.key)).toEqual([`admin.event:stamp:bittensor:${NOW - 60}`, `admin.event:stamp:base:${NOW - 60}`]);
      expect(found[0].facts).toMatchObject({ event: "vault StampedBySig", "as of": utc(NOW - 60), relayer: SIGNER });
      // only what the contract does: lastOwnerClose = max(lastOwnerClose, asOf), so every item scheduled at or before asOf dies
      expect(found[0].facts["what it does"]).toBe("the owner's clock is now at least this time: no item scheduled at or before it can run");
      expect(found[0].facts).not.toHaveProperty("what it means");
      expect(metaOf(c)).toMatchObject({ "stamp_asof:bittensor": String(NOW - 60), "stamp_asof:base": String(NOW - 60) });
      // the next tick: the same stamp relayed again, an older one, and a newer one
      const next = ctx32({ logs: [stamp(NOW - 60), stamp(NOW - 300), stamp(NOW - 30)], meta: { "stamp_asof:bittensor": String(NOW - 60) } });
      expect(adminEvent.run(next).map((f) => f.key)).toEqual([`admin.event:stamp:bittensor:${NOW - 30}`]);
    });

    it("replays can't bury a Scheduled: a tick of many replays still raises the item's own critical", () => {
      const replays = Array.from({ length: 20 }, () => slog({ contract: "vault", event: "StampedBySig", block: 6_900_210n, args: { asOf: String(NOW - 60), relayer: SIGNER } }));
      const s = scheduled("vault", "setGuardian", [G2]);
      const c = ctx32({ logs: [...replays, s.log], meta: { "stamp_asof:bittensor": String(NOW - 60) } });
      expect(adminEvent.run(c)).toEqual([]);
      expect(schedulerItems.run(c).map((f) => f.rule)).toEqual(["admin.scheduled"]);
    });

    it("folds an executed item's own events into its admin.executed, and still emails events after the last Executed of the transaction", () => {
      const s = scheduled("vault", "setGuardian", [G2]);
      const t = tx(77);
      // a direct change batched before the execute (a Safe's MultiSend): not the item's, so emailed on its own
      const direct = slog({ contract: "vault", event: "KeeperSet", block: 6_900_250n, txHash: t, logIndex: 0, args: { keeper: KEEPER } });
      const effect = slog({ contract: "vault", event: "GuardianSet", block: 6_900_250n, txHash: t, logIndex: 1, args: { guardian: G2 } });
      const exec = closing("vault", "Executed", s.id, { txHash: t, logIndex: 2 });
      const after = slog({ contract: "vault", event: "Paused", block: 6_900_250n, txHash: t, logIndex: 3, args: { account: OWNER } });
      const c = ctx32({ logs: [direct, effect, exec, after], stored: [s.log], meta: tracked(recordOf(s)) });
      expect(adminEvent.run(c).map((f) => f.key)).toEqual([`admin.event:${direct.uid}`, `admin.event:${after.uid}`]);
      const [f] = schedulerItems.run(c);
      expect(f).toMatchObject({ rule: "admin.executed" });
      expect(f.facts.effects).toBe(`GuardianSet (guardian ${G2})`);
      // the same events before an Executed of an item the record doesn't hold: each emailed on its own
      const unknown = ctx32({ logs: [direct, effect, closing("vault", "Executed", keccak256("0x02"), { txHash: t, logIndex: 2 })] });
      expect(adminEvent.run(unknown).map((x) => x.key)).toEqual([`admin.event:${direct.uid}`, `admin.event:${effect.uid}`]);
      expect(schedulerItems.run(unknown)[0].facts).not.toHaveProperty("effects");
    });

    it("sends one critical for one pause, disable or removal: the instrument's own event is named in its ExitsClosed's email", () => {
      const t = tx(79);
      const paused = slog({ contract: "vault", event: "Paused", block: 6_900_240n, txHash: t, logIndex: 0, args: { account: GUARD } });
      const closed = slog({ contract: "vault", event: "ExitsClosed", block: 6_900_240n, txHash: t, logIndex: 1, args: { by: GUARD, instrument: toFunctionSelector("pause()") } });
      const found = adminEvent.run(ctx32({ logs: [paused, closed] }));
      expect(found.map((f) => f.key)).toEqual([`admin.event:${closed.uid}`]);
      expect(found[0].facts.with).toBe(`vault Paused (account ${GUARD})`);
      const u = tx(80);
      const disabled = slog({ contract: "frontDoor", event: "BridgeDisabled", block: 37_000_240n, txHash: u, logIndex: 0, args: { bridge: d32.baseAdapter } });
      const fdClosed = slog({ contract: "frontDoor", event: "ExitsClosed", block: 37_000_240n, txHash: u, logIndex: 1, args: { by: OWNER, instrument: toFunctionSelector("disableBridge(address)") } });
      expect(adminEvent.run(ctx32({ logs: [disabled, fdClosed] })).map((f) => f.key)).toEqual([`admin.event:${fdClosed.uid}`]);
      // a pause with no ExitsClosed in its transaction (none on v3.2, but never lost): emailed
      expect(adminEvent.run(ctx32({ logs: [paused] })).map((f) => f.key)).toEqual([`admin.event:${paused.uid}`]);
    });

    it("folds only an ExitsClosed's own cause (the log just before it): a batched disable or removal before it is emailed on its own", () => {
      const NON_PRIMARY = "0x00000000000000000000000000000000000000c7" as Hex;
      const sel = (f: string) => toFunctionSelector(f);
      const at = (t: Hex, i: number, o: Partial<StoredLog> & Pick<StoredLog, "contract" | "event">) => slog({ block: o.contract === "vault" ? 6_900_240n : 37_000_240n, txHash: t, logIndex: i, ...o });
      // a Safe batch: disableBridge(a non-primary bridge), then disableBridge(the primary), on the front door
      const t1 = tx(81);
      const other = at(t1, 4, { contract: "frontDoor", event: "BridgeDisabled", args: { bridge: NON_PRIMARY } });
      const primary = at(t1, 5, { contract: "frontDoor", event: "BridgeDisabled", args: { bridge: d32.baseAdapter } });
      const closed1 = at(t1, 6, { contract: "frontDoor", event: "ExitsClosed", args: { by: OWNER, instrument: sel("disableBridge(address)") } });
      const f1 = adminEvent.run(ctx32({ logs: [other, primary, closed1] }));
      expect(f1.map((f) => f.key)).toEqual([`admin.event:${other.uid}`, `admin.event:${closed1.uid}`]);
      expect(f1[0].facts.bridge).toBe(NON_PRIMARY);
      expect(f1[1].facts.with).toBe(`front door BridgeDisabled (bridge ${d32.baseAdapter})`);
      // a non-primary disable, then an unrelated pause on the vault: both emailed (the Paused is the pause's own)
      const t2 = tx(82);
      const off = at(t2, 0, { contract: "vault", event: "BridgeDisabled", args: { bridge: NON_PRIMARY } });
      const paused = at(t2, 1, { contract: "vault", event: "Paused", args: { account: GUARD } });
      const closed2 = at(t2, 2, { contract: "vault", event: "ExitsClosed", args: { by: GUARD, instrument: sel("pause()") } });
      const f2 = adminEvent.run(ctx32({ logs: [off, paused, closed2] }));
      expect(f2.map((f) => f.key)).toEqual([`admin.event:${off.uid}`, `admin.event:${closed2.uid}`]);
      expect(f2[1].facts.with).toBe(`vault Paused (account ${GUARD})`);
      // two doors removed in one transaction, the second the launch chain's last: both named, each once
      const t3 = tx(83);
      const DOOR2 = "0x00000000000000000000000000000000000000c8" as Hex;
      const first = at(t3, 0, { contract: "vault", event: "FrontDoorRemoved", args: { chain: "8453", addr: DOOR2 } });
      const last = at(t3, 1, { contract: "vault", event: "FrontDoorRemoved", args: { chain: "8453", addr: FD } });
      const closed3 = at(t3, 2, { contract: "vault", event: "ExitsClosed", args: { by: OWNER, instrument: sel("removeFrontDoor(uint64,address)") } });
      const f3 = adminEvent.run(ctx32({ logs: [first, last, closed3] }));
      expect(f3.map((f) => f.key)).toEqual([`admin.event:${first.uid}`, `admin.event:${closed3.uid}`]);
      expect(f3[0].facts.addr).toBe(DOOR2);
      expect(f3[1].facts.with).toBe(`vault FrontDoorRemoved (chain 8453, addr ${FD})`);
      // an ExitsClosed whose log just before it is not its instrument's own event names nothing, and folds nothing
      const t4 = tx(84);
      const early = at(t4, 0, { contract: "vault", event: "BridgeDisabled", args: { bridge: NON_PRIMARY } });
      const keeper = at(t4, 1, { contract: "vault", event: "KeeperSet", args: { keeper: KEEPER } });
      const closed4 = at(t4, 2, { contract: "vault", event: "ExitsClosed", args: { by: OWNER, instrument: sel("disableBridge(address)") } });
      const f4 = adminEvent.run(ctx32({ logs: [early, keeper, closed4] }));
      expect(f4.map((f) => f.key)).toEqual([`admin.event:${early.uid}`, `admin.event:${keeper.uid}`, `admin.event:${closed4.uid}`]);
      expect(f4[2].facts).not.toHaveProperty("with");
    });

    it("names the setter of a v3.2 vault LimitSet, the instrument of ExitsClosed and ExitsReopened, and an owner's forfeit", () => {
      const [selector, setter] = [...LIMIT_SETTERS][0];
      const pause = toFunctionSelector("pause()");
      const primary = toFunctionSelector("setPrimaryBridge(address)");
      const logs = [
        slog({ contract: "vault", event: "LimitSet", block: 6_900_210n, args: { selector, a: "1", b: "0" } }),
        slog({ contract: "vault", event: "ExitsClosed", block: 6_900_211n, args: { by: GUARD, instrument: pause } }),
        slog({ contract: "frontDoor", event: "ExitsReopened", block: 37_000_211n, args: { instrument: primary } }),
        slog({ contract: "vault", event: "HotkeyRemoved", block: 6_900_212n, args: { hotkey: HK(9), unclaimed: "5", forfeit: true } }),
      ];
      const found = adminEvent.run(ctx32({ logs }));
      expect(found).toHaveLength(4);
      expect(found[0].facts).toMatchObject({ setter });
      expect(found[1].facts).toMatchObject({ instrument: `pause (${pause})`, by: `${GUARD} (the guardian)` });
      // in log order: Bittensor's blocks, then Base's
      expect(found[2].facts["what it means"]).toBe("the owner removed it and gave up its unclaimed rewards");
      expect(found[3].facts).toMatchObject({ instrument: `setPrimaryBridge (${primary})` });
    });

    it("says what an owner's cancel gave back by its assets, not its shares (a re-mint at the cancel's price: Task 34c)", () => {
      const l = slog({ contract: "vault", event: "RedeemReversed", block: 6_900_212n, args: { key: tx(55), user: G2, shares: "123456789", assets: String(3n * E18) } });
      const [f] = adminEvent.run(ctx32({ logs: [l] }));
      expect(f.facts.returned).toBe("3 TAO of value, as 123456789 shares re-minted at the cancel's price (judge it by the TAO)");
      // v3-launch's email is as it was
      expect(adminEvent.run(ctx32({ logs: [l], cfg: testConfig() }))[0].facts).not.toHaveProperty("returned");
    });

    it("keeps OutflowLimitsSet, StakeWrittenOff and PotSwept critical; StakeAdopted is a warning and SurplusSwept the daily digest's; every one explained", () => {
      const logs = [
        slog({ contract: "vault", event: "OutflowLimitsSet", block: 6_900_210n, args: { bps: "2000", minDaily: "1", globalBps: "3000" } }),
        slog({ contract: "vault", event: "StakeWrittenOff", block: 6_900_211n, args: { rao: "5" } }),
        slog({ contract: "vault", event: "StakeAdopted", block: 6_900_212n, args: { rao: "5" } }),
        slog({ contract: "frontDoor", event: "PotSwept", block: 37_000_210n, args: { amount: "5" } }),
        slog({ contract: "baseAdapter", event: "SurplusSwept", block: 37_000_211n, args: { native: "1", tokens: "2" } }),
        slog({ contract: "bitAdapter", event: "SurplusSwept", block: 6_900_213n, args: { native: "1", tokens: "2" } }),
      ];
      const c = ctx32({ logs, txs: [{ chain: "bittensor", hash: logs[2].txHash, from: KEEPER }] });
      expect(adminEvent.run(c).map((f) => f.facts.event)).toEqual(["vault OutflowLimitsSet", "vault StakeWrittenOff", "front door PotSwept"]);
      expect(RULES["admin.event"].tier).toBe("critical");
      for (const k of ["vault:StakeAdopted", "baseAdapter:SurplusSwept", "bitAdapter:SurplusSwept"]) {
        expect(ADMIN_EVENTS.has(k as never), k).toBe(false);
        // their transactions are fetched: the keeper's adoptStake, anyone's sweep, never unexplained
        expect(ATTRIBUTABLE.has(k as never), k).toBe(true);
      }
      // StakeAdopted: a warning event, emailed once (never re-sent hourly)
      const found = stakeAdopted.run(c);
      expect(RULES["vault.stake_adopted"]).toMatchObject({ tier: "warning", kind: "event" });
      expect(found).toEqual([
        {
          rule: "vault.stake_adopted",
          key: `vault.stake_adopted:${logs[2].uid}`,
          subject: "The vault adopted 0.000000005 TAO of stake into the share price",
          facts: { adopted: "0.000000005 TAO (5 rao)", sender: `${KEEPER} (the keeper)`, block: "6900212", transaction: `https://evm.taostats.io/tx/${logs[2].txHash}` },
        },
      ]);
      // its runbook line: an adoption vests on its own drip and never restarts the claimed rewards' schedule (Revision
      // 27; its review, M-5), no longer "like a claim's reward"
      const line = RUNBOOK["vault.stake_adopted"]({});
      expect(line).toContain("on its own drip");
      expect(line).toContain("never restarts the claimed rewards' schedule");
      expect(line).not.toMatch(/like a claim/);
      // no tick rule raises a SurplusSwept: the daily digest lists the day's sweeps (test/worker/digest.test.ts)
      expect(Object.keys(RULES).filter((r) => /swept/i.test(r))).toEqual([]);
    });

    it("emails nothing for the constructors' own events at the deploy block (the baseline covers the start block)", () => {
      const at = (contract: "vault" | "frontDoor", event: string, args: Record<string, string | number | boolean>) =>
        slog({ contract, event, block: contract === "vault" ? d32.bittensor.startBlock : d32.base.startBlock, args });
      const logs = [
        at("vault", "GuardianSet", { guardian: GUARD }),
        at("vault", "PrimaryBridgeSet", { bridge: d32.bitAdapter }),
        at("vault", "BridgeActivated", { bridge: d32.bitAdapter }),
        at("vault", "StakeHotkeySet", { hotkey: STAKE_HK }),
        at("vault", "HotkeyAdded", { hotkey: STAKE_HK }),
        at("vault", "FrontDoorActivated", { chain: "8453", addr: d32.frontDoor }),
        at("vault", "OutflowLimitsSet", { bps: "2000", minDaily: "1", globalBps: "3000" }),
        at("vault", "RewardCutSet", { treasury: SIGNER, bps: 1000 }),
        at("frontDoor", "GuardianSet", { guardian: GUARD }),
        at("frontDoor", "LimitSet", { name: "0x00", a: "1", b: "0" }),
      ];
      const c = ctx32({ logs });
      expect([...adminEvent.run(c), ...hotkeySwitched.run(c), ...schedulerItems.run(c)]).toEqual([]);
    });
  });

  describe("admin.scheduled, admin.cancelled and admin.executed", () => {
    it("emails a Scheduled at once with its kind, setter, decoded arguments, readyAt and the lens's readyBlock, and records the item", () => {
      const s = scheduled("vault", "setGuardian", [G2], { kind: 1 });
      const c = ctx32({
        logs: [s.log],
        bit: bit32({ scheduled: { [s.id]: held(s, { kind: 1, class: 2, readyBlock: 6_960_000n }) } }),
        txs: [{ chain: "bittensor", hash: s.log.txHash, from: OWNER }],
      });
      const [f] = schedulerItems.run(c);
      expect(RULES["admin.scheduled"]).toMatchObject({ tier: "critical", kind: "event" });
      expect(f.rule).toBe("admin.scheduled");
      expect(f.key).toBe(`admin.scheduled:${s.log.uid}`);
      expect(f.subject).toBe(`An owner change was scheduled on the vault: setGuardian (ready ${utc(s.readyAt)})`);
      expect(f.facts).toMatchObject({
        contract: "vault",
        chain: "bittensor",
        change: "setGuardian",
        "argument newGuardian": G2,
        kind: "GuardianSwap (only the owner can cancel it)",
        "ready at": utc(s.readyAt),
        "ready from block": "6960000",
        // its window in blocks ends 42,000 calibrated blocks (7,200 ms) past its readyBlock, at block 7,002,000: 101,700
        // blocks past the reading's at Bittensor's 12 s, later than its window in time, so that clock is given
        "can run until": `about ${utc(NOW + 101_700 * 12)} (block 7002000: its blocks come slower than its time)`,
        calldata: s.data,
        id: s.id,
        sender: `${OWNER} (the owner)`,
        transaction: `https://evm.taostats.io/tx/${s.log.txHash}`,
      });
      expect(itemsOf(c)).toEqual([recordOf(s)]);
      expect(RUNBOOK["admin.scheduled"](f.facts)).toMatch(/stamp/);
      // its blocks on time (ready at block 6,905,000): its window in time ends later, and is given
      const t = scheduled("vault", "setGuardian", [G2], { kind: 1 });
      const [g] = schedulerItems.run(ctx32({ logs: [t.log], bit: bit32({ scheduled: { [t.id]: held(t, { kind: 1, readyBlock: 6_905_000n }) } }) }));
      expect(g.facts["can run until"]).toBe(utc(t.readyAt + 7 * DAY));
      // its MS_PER_BLOCK unread: both clocks, whichever is later
      const u = scheduled("vault", "setGuardian", [G2], { kind: 1 });
      const [h] = schedulerItems.run(ctx32({ logs: [u.log], bit: bit32({ msPerBlock: undefined, scheduled: { [u.id]: held(u, { kind: 1, readyBlock: 6_905_000n }) } }) }));
      expect(h.facts["can run until"]).toBe(`${utc(u.readyAt + 7 * DAY)}, or later while its blocks come slowly (its window in blocks unread)`);
    });

    it("decodes the arguments with units and says whether the item loosens a limit against its current value", () => {
      const s = scheduled("vault", "setPayoutDelay", [3600n]);
      const [f] = schedulerItems.run(ctx32({ logs: [s.log] }));
      expect(f.facts).toMatchObject({
        change: "setPayoutDelay",
        "argument delay": "3600 s (1 h)",
        kind: "Ordinary (the owner or the guardian can cancel it)",
        "ready from block": "not read yet",
        direction: "loosens",
        payoutDelay: "86400 s (24 h) now, 3600 s (1 h) at execute (loosens: down)",
      });
      const fd = scheduled("frontDoor", "setMinPoolLiquidity", [0, 10n ** 17n]);
      const [g] = schedulerItems.run(ctx32({ logs: [fd.log] }));
      expect(g.facts).toMatchObject({ contract: "front door", chain: "base", "argument index": "0", direction: "doesn't loosen", "minPoolLiquidity(0)": "100000000000000000 now, 100000000000000000 at execute" });
      const cap = scheduled("vault", "setMaxTotalAssets", [100n * E18]);
      const [h] = schedulerItems.run(ctx32({ logs: [cap.log] }));
      expect(h.facts).toMatchObject({ "argument amount": "100 TAO (100000000000000000000 wei)", direction: "loosens", maxTotalAssets: "44 TAO now, 100 TAO at execute (loosens: up)" });
      // a field unread: unknown, never "doesn't loosen"
      const [u] = schedulerItems.run(ctx32({ logs: [scheduled("vault", "setPayoutDelay", [7200n]).log], bit: bit32({ payoutDelay: undefined }) }));
      expect(u.facts.direction).toBe("unknown (payoutDelay is unread)");
    });

    it("says when the calldata isn't the canonical encoding of its arguments (dirty bits: it can't run), and emails an unknown selector too", () => {
      const clean = encodeFunctionData({ abi: SCHEDULABLE.vault, functionName: "setRewardCut", args: [SIGNER, 500] });
      // setRewardCut's uint16 with a bit above its 16 set
      const d = scheduled("vault", "setRewardCut", [], { data: `${clean.slice(0, 10 + 64)}${"0".repeat(58)}0101f4` as Hex });
      expect(d.data.length).toBe(clean.length);
      const [f] = schedulerItems.run(ctx32({ logs: [d.log] }));
      expect(f.facts.calldata).toBe(`${d.data} (not the canonical encoding of its arguments: it can't run)`);
      const odd = scheduled("vault", "setGuardian", [], { data: "0x1234567800000000000000000000000000000000000000000000000000000001" });
      const [g] = schedulerItems.run(ctx32({ logs: [odd.log] }));
      expect(g.subject).toContain("an unknown setter (0x12345678)");
      expect(g.facts.change).toBe("an unknown setter (0x12345678)");
    });

    it("emails an Executed and a Cancelled with the item they close, then forgets the item", () => {
      const s = scheduled("frontDoor", "setOracle", [SIGNER]);
      const ex = closing("frontDoor", "Executed", s.id);
      const c = ctx32({ logs: [ex], stored: [s.log], meta: tracked(recordOf(s)), txs: [{ chain: "base", hash: ex.txHash, from: OWNER }] });
      const [f] = schedulerItems.run(c);
      expect(RULES["admin.executed"]).toMatchObject({ tier: "critical", kind: "event" });
      expect(f).toMatchObject({ rule: "admin.executed", key: `admin.executed:${ex.uid}`, subject: "A scheduled owner change ran on the front door: setOracle" });
      expect(f.facts).toMatchObject({
        change: "setOracle",
        "argument newOracle": SIGNER,
        kind: "Ordinary (the owner or the guardian can cancel it)",
        "ready at": utc(s.readyAt),
        "scheduled in": `https://basescan.org/tx/${s.log.txHash}`,
        sender: `${OWNER} (the owner)`,
      });
      expect(itemsOf(c)).toEqual([]);
      const cx = closing("frontDoor", "Cancelled", s.id, { by: GUARD });
      const k = ctx32({ logs: [cx], meta: tracked(recordOf(s)) });
      const [g] = schedulerItems.run(k);
      expect(RULES["admin.cancelled"]).toMatchObject({ tier: "critical", kind: "event" });
      expect(g).toMatchObject({ rule: "admin.cancelled", key: `admin.cancelled:${cx.uid}`, subject: "A scheduled owner change was cancelled on the front door: setOracle" });
      expect(g.facts["cancelled by"]).toBe(`${GUARD} (the guardian)`);
      expect(itemsOf(k)).toEqual([]);
    });

    it("still emails an Executed or Cancelled of an item it never saw scheduled, saying so", () => {
      const id = keccak256("0x1234");
      const [f] = schedulerItems.run(ctx32({ logs: [closing("vault", "Executed", id)] }));
      expect(f.subject).toBe("A scheduled owner change ran on the vault: an item not seen scheduled");
      expect(f.facts).toMatchObject({ change: "not known (its Scheduled wasn't seen)", id });
    });

    it("re-scheduling the same calldata replaces the record (the delay restarts) and emails again", () => {
      const s = scheduled("vault", "setGuardian", [G2], { kind: 1 });
      const again = scheduled("vault", "setGuardian", [G2], { kind: 1, readyAt: s.readyAt + 3600 });
      const c = ctx32({ logs: [again.log], meta: tracked(recordOf(s)) });
      expect(schedulerItems.run(c).map((f) => f.key)).toEqual([`admin.scheduled:${again.log.uid}`]);
      expect(itemsOf(c)).toEqual([recordOf(again)]);
    });

    it("records a Scheduled at or before the baseline (the deployment's setup) without an email", () => {
      const s = scheduled("vault", "setPayoutDelay", [7200n], { block: d32.bittensor.baselineBlock });
      const c = ctx32({ logs: [s.log] });
      expect(schedulerItems.run(c)).toEqual([]);
      expect(itemsOf(c)).toEqual([recordOf(s, { loosens: true })]);
    });

    it("on v3-launch (v3.1) does nothing at all", () => {
      const c = ruleCtx({ logs: logQuery([]) });
      for (const r of [schedulerItems, exitsState, ownerPending, ownerKind, setFull, hotkeySwitched]) expect(r.run(c), r.name).toEqual([]);
      expect(c.unjudged).toEqual([]);
      expect(c.writes.meta).toEqual([]);
    });
  });

  /** A recorded item with no setter, for filling the record. */
  const synthetic = (k: number, o: Partial<TrackedItem> = {}): TrackedItem => ({
    chain: k % 2 ? "base" : "bittensor",
    role: k % 2 ? "frontDoor" : "vault",
    id: tx(700_000 + k),
    kind: 0,
    selector: "0x12345678",
    readyAt: NOW + 2 * DAY,
    data: "0x12345678",
    uid: tx(800_000 + k),
    block: "1",
    tx: tx(900_000 + k),
    ...o,
  });

  describe("the record of scheduled items", () => {
    it("reads this tick's new Scheduled first, then the record's newest first, each once, at most 64 across both chains, and never a finished item", () => {
      const items = Array.from({ length: 70 }, (_, k) => synthetic(k));
      items[69] = { ...items[69], lapsed: true };
      const a = scheduled("vault", "setPayoutDelay", [7200n]);
      const b = scheduled("frontDoor", "setBatchInterval", [300n]);
      // a fresh re-scheduling of a recorded id is read once, as fresh
      const again = { ...a.log, uid: tx(950_000), args: { ...a.log.args, id: items[68].id } } as StoredLog;
      const ids = scheduledIdsOf(JSON.stringify(items), [a.log, b.log, { ...again, chain: items[68].chain }]);
      expect(ids).toHaveLength(64);
      expect(ids.slice(0, 4)).toEqual([
        { chain: items[68].chain, id: items[68].id },
        { chain: "base", id: b.id },
        { chain: "bittensor", id: a.id },
        { chain: items[67].chain, id: items[67].id },
      ]);
      expect(ids.map((x) => x.id)).not.toContain(items[69].id);
      expect(new Set(ids.map((x) => `${x.chain}:${x.id}`)).size).toBe(64);
      // the oldest are left out past the 64th
      expect(ids.map((x) => x.id)).not.toContain(items[0].id);
      expect(scheduledIdsOf(undefined, [])).toEqual([]);
      expect(scheduledIdsOf("not json", [a.log])).toEqual([{ chain: "bittensor", id: a.id }]);
    });

    it("a finished item (past its window, or killed) is out of every unjudged check, and forgotten once the logs pass its window", () => {
      const s = scheduled("vault", "setPayoutDelay", [7200n]);
      const done = recordOf(s, { lapsed: true, loosens: true });
      // unread by the lens: no admin.item_loosens mark for a finished item
      const c = ctx32({ meta: tracked(done) });
      expect(schedulerItems.run(c)).toEqual([]);
      expect(unjudgedOf(c)).toEqual([]);
      expect(metaOf(c)[ITEMS_KEY]).toBeUndefined();
      // held by the lens and a direction field unread: still nothing
      const k = ctx32({ meta: tracked(done), bit: bit32({ payoutDelay: undefined, scheduled: { [s.id]: held(s) } }) });
      schedulerItems.run(k);
      expect(unjudgedOf(k)).toEqual([]);
      // the logs stored past its window in time, but not yet past the last block its window in blocks can end at (its
      // Scheduled's block, 6,900,200, plus half the longest delay and half the window in 7,200 ms blocks: 48,000 + 42,000):
      // kept (Revision 28)
      const early = ctx32({ meta: tracked(done), settledTime: s.readyAt + 7 * DAY + 1, settledBlock: 6_990_200n });
      expect(schedulerItems.run(early)).toEqual([]);
      expect(metaOf(early)[ITEMS_KEY]).toBeUndefined();
      // and with no MS_PER_BLOCK read, kept too
      const unread = ctx32({ meta: tracked(done), settledTime: s.readyAt + 7 * DAY + 1, bit: bit32({ msPerBlock: undefined }) });
      expect(schedulerItems.run(unread)).toEqual([]);
      expect(metaOf(unread)[ITEMS_KEY]).toBeUndefined();
      // the logs stored past both: forgotten, whatever the lens says
      const later = ctx32({ meta: tracked(done), settledTime: s.readyAt + 7 * DAY + 1, settledBlock: 6_990_201n });
      expect(schedulerItems.run(later)).toEqual([]);
      expect(itemsOf(later)).toEqual([]);
    });

    it("keeps at most MAX_LIVE_ITEMS live items: past it a Scheduled is still emailed and refused (kept apart), and the critical admin.record_full names the count", () => {
      expect(MAX_LIVE_ITEMS).toBeGreaterThanOrEqual(64);
      const full = Array.from({ length: MAX_LIVE_ITEMS }, (_, k) => synthetic(k));
      const s1 = scheduled("vault", "setGuardian", [G2], { kind: 1 });
      const s2 = scheduled("frontDoor", "setBatchInterval", [300n]);
      const c = ctx32({ logs: [s1.log, s2.log], meta: tracked(...full) });
      const found = schedulerItems.run(c);
      expect(found.map((f) => f.rule)).toEqual(["admin.scheduled", "admin.scheduled", "admin.record_full"]);
      expect(RULES["admin.record_full"]).toMatchObject({ tier: "critical", kind: "condition" });
      expect(found[2]).toMatchObject({ key: `admin.record_full:${NOW}`, subject: `Too many scheduled owner changes to track: 2 more beside the ${MAX_LIVE_ITEMS} tracked` });
      expect(found[2].facts).toMatchObject({ tracked: String(MAX_LIVE_ITEMS), "not tracked": "2", "the last can run until": utc(NOW + 9 * DAY) });
      // the record is left as it was (neither new item fits); both are kept apart, in full, oldest first
      expect(metaOf(c)[ITEMS_KEY]).toBeUndefined();
      expect(parseRefused(metaOf(c)[REFUSED_KEY])).toEqual({ items: [recordOf(s1), recordOf(s2, { loosens: true })], more: {} });
      expect(RUNBOOK["admin.record_full"](found[2].facts)).toMatch(/stamp/);
      // still full on the next tick: still raised, with the count
      const next = ctx32({ meta: { ...tracked(...full), ...metaOf(c) } });
      expect(schedulerItems.run(next).map((f) => f.subject)).toEqual([`Too many scheduled owner changes to track: 2 more beside the ${MAX_LIVE_ITEMS} tracked`]);
      // a re-scheduling of a recorded item takes no new slot
      const again = scheduled("vault", "setGuardian", [G2], { kind: 1 });
      const re = ctx32({ logs: [{ ...again.log, args: { ...again.log.args, id: full[0].id } } as StoredLog], meta: tracked(...full) });
      expect(schedulerItems.run(re).map((f) => f.rule)).toEqual(["admin.scheduled"]);
      // finished items don't take live slots; beyond MAX_FINISHED_ITEMS the soonest forgotten go first
      const finished = Array.from({ length: MAX_FINISHED_ITEMS + 3 }, (_, k) => synthetic(10_000 + k, { lapsed: true, readyAt: NOW + k }));
      const f = ctx32({ logs: [s1.log], meta: tracked(...full.slice(1), ...finished) });
      expect(schedulerItems.run(f).map((x) => x.rule)).toEqual(["admin.scheduled"]);
      const kept = itemsOf(f);
      expect(kept.filter((x) => !x.lapsed)).toHaveLength(MAX_LIVE_ITEMS);
      expect(kept.filter((x) => x.lapsed)).toHaveLength(MAX_FINISHED_ITEMS);
      expect(kept.map((x) => x.id)).not.toContain(finished[0].id);
    });

    it("a refusal followed by a slot freeing in the same tick still alerts; a later tick takes the item in, reads it and shows it like any other, and the alert clears", () => {
      const full = Array.from({ length: MAX_LIVE_ITEMS }, (_, k) => synthetic(k));
      const s = scheduled("vault", "setGuardian", [G2], { kind: 1 });
      // refused at the cap, then a slot frees later in the tick: a Cancelled after it in log order
      const c = ctx32({ logs: [s.log, closing("vault", "Cancelled", full[0].id)], meta: tracked(...full) });
      const found = schedulerItems.run(c);
      expect(found.map((f) => f.rule)).toEqual(["admin.scheduled", "admin.cancelled", "admin.record_full"]);
      expect(found[2].subject).toBe(`Too many scheduled owner changes to track: 1 more beside the ${MAX_LIVE_ITEMS - 1} tracked`);
      expect(itemsOf(c)).toHaveLength(MAX_LIVE_ITEMS - 1);
      expect(parseRefused(metaOf(c)[REFUSED_KEY]).items.map((x) => x.id)).toEqual([s.id]);
      // or a slot the judging frees (an item past its window, read by the lens): the same
      const old = synthetic(0, { readyAt: NOW - 8 * DAY });
      const j = ctx32({ logs: [s.log], meta: tracked(old, ...full.slice(1)), bit: bit32({ scheduled: { [old.id]: held(old, { readyBlock: 6_800_000n }) } }) });
      expect(schedulerItems.run(j).map((f) => f.rule)).toEqual(["admin.scheduled", "admin.lapsed", "admin.record_full"]);
      // the next tick, with room: taken in (last, so read first), the alert cleared, nothing kept apart
      const next = ctx32({ meta: { ...tracked(...full), ...metaOf(c) } });
      expect(schedulerItems.run(next)).toEqual([]);
      expect(itemsOf(next).at(-1)).toEqual(recordOf(s));
      expect(itemsOf(next).filter((x) => !x.lapsed)).toHaveLength(MAX_LIVE_ITEMS);
      expect(metaOf(next)[REFUSED_KEY]).toBe("");
      expect(scheduledIdsOf(metaOf(next)[ITEMS_KEY], [])[0]).toEqual({ chain: "bittensor", id: s.id });
      // read by the lens on the tick after, it is judged and shown on /v1/flow like any other
      const r = reading(6_900_300n, NOW, bitState(bit32({ scheduled: { [s.id]: held(s, { kind: 1 }) } })));
      const flow = flowOf({ base: null, bittensor: r, inFlight: { toBittensor: 0, toBase: 0 }, adminLogs: [], items: itemsOf(next), cfg: cfg32, nowS: NOW });
      expect(flow.notices.find((n) => n.item?.id === s.id)).toMatchObject({ kind: "itemScheduled", target: G2, item: { setter: "setGuardian" } });
      const cancelled = ctx32({ logs: [closing("vault", "Cancelled", s.id, { by: OWNER })], meta: { ...metaOf(next) } });
      expect(schedulerItems.run(cancelled)[0].facts).toMatchObject({ change: "setGuardian", "cancelled by": `${OWNER} (the owner)` });
    });

    it("keeps admin.record_full raised while a refused item may be pending, and clears it once each is finished: cancelled, executed or past its window", () => {
      const full = Array.from({ length: MAX_LIVE_ITEMS }, (_, k) => synthetic(k));
      const s = scheduled("vault", "setPayoutDelay", [7200n]);
      const c = ctx32({ logs: [s.log], meta: tracked(...full) });
      schedulerItems.run(c);
      const m = { ...tracked(...full), ...metaOf(c) };
      // full on later ticks: raised, the refused item not judged (no unjudged mark for it: it isn't read)
      const later = ctx32({ meta: m });
      expect(schedulerItems.run(later).map((f) => f.key)).toEqual([`admin.record_full:${NOW}`]);
      expect(metaOf(later)[REFUSED_KEY]).toBeUndefined();
      // cancelled: the email names the change, and nothing is kept apart
      const k = ctx32({ logs: [closing("vault", "Cancelled", s.id)], meta: m });
      const cx = schedulerItems.run(k);
      expect(cx.map((f) => f.rule)).toEqual(["admin.cancelled"]);
      expect(cx[0].facts.change).toBe("setPayoutDelay");
      expect(metaOf(k)[REFUSED_KEY]).toBe("");
      // executed: likewise
      const e = ctx32({ logs: [closing("vault", "Executed", s.id)], meta: m });
      expect(schedulerItems.run(e).map((f) => f.subject)).toEqual(["A scheduled owner change ran on the vault: setPayoutDelay"]);
      expect(metaOf(e)[REFUSED_KEY]).toBe("");
      // pruned past its window: a Lapsed warning naming it, and cleared
      const p = ctx32({ logs: [closing("vault", "Lapsed", s.id)], meta: m });
      expect(schedulerItems.run(p).map((f) => f.rule)).toEqual(["admin.lapsed"]);
      // the logs stored past its window: finished, cleared
      const done = ctx32({ meta: m, settledTime: s.readyAt + 7 * DAY + 1 });
      expect(schedulerItems.run(done)).toEqual([]);
      expect(metaOf(done)[REFUSED_KEY]).toBe("");
      // still inside its window: raised
      expect(schedulerItems.run(ctx32({ meta: m, settledTime: s.readyAt + 7 * DAY })).map((f) => f.key)).toEqual([`admin.record_full:${NOW}`]);
    });

    it("keeps at most MAX_REFUSED_ITEMS refused items in full; past it a count, the last window's end and the last block one was scheduled in per chain, which clear once the logs are past both", () => {
      const full = Array.from({ length: MAX_LIVE_ITEMS }, (_, k) => synthetic(k));
      const apart = Array.from({ length: MAX_REFUSED_ITEMS }, (_, k) => synthetic(20_000 + k));
      const s = scheduled("vault", "setGuardian", [G2], { kind: 1, readyAt: NOW + 3 * DAY });
      const c = ctx32({ logs: [s.log], meta: { ...tracked(...full), [REFUSED_KEY]: JSON.stringify({ items: apart, more: {} }) } });
      const found = schedulerItems.run(c);
      expect(found.map((f) => f.subject)).toContain(`Too many scheduled owner changes to track: ${MAX_REFUSED_ITEMS + 1} more beside the ${MAX_LIVE_ITEMS} tracked`);
      expect(found.at(-1)?.facts["the last can run until"]).toBe(utc(NOW + 10 * DAY));
      const kept = parseRefused(metaOf(c)[REFUSED_KEY]);
      expect(kept.items.map((x) => x.id)).toEqual(apart.map((x) => x.id));
      expect(kept.more).toEqual({ bittensor: { n: 1, until: NOW + 10 * DAY, lastBlock: "6900200" } });
      // room for every one kept in full: each taken in, the one past the cap still counted
      const room = ctx32({ meta: { [REFUSED_KEY]: metaOf(c)[REFUSED_KEY] } });
      expect(schedulerItems.run(room).map((f) => f.subject)).toEqual([`Too many scheduled owner changes to track: 1 more beside the ${MAX_REFUSED_ITEMS} tracked`]);
      expect(itemsOf(room).map((x) => x.id)).toEqual(apart.map((x) => x.id));
      // its window in time passed by the stored logs, but not the last block its window in blocks can end at (6,900,200 +
      // 48,000 + 42,000): still counted
      const counted = { [REFUSED_KEY]: JSON.stringify({ items: [], more: kept.more }) };
      const early = ctx32({ meta: counted, settledTime: NOW + 10 * DAY + 1, settledBlock: 6_990_200n });
      expect(schedulerItems.run(early).map((f) => f.rule)).toEqual(["admin.record_full"]);
      // past both: cleared
      const done = ctx32({ meta: counted, settledTime: NOW + 10 * DAY + 1, settledBlock: 6_990_201n });
      expect(schedulerItems.run(done)).toEqual([]);
      expect(metaOf(done)[REFUSED_KEY]).toBe("");
      // a count kept before Revision 28 (no block): by time alone
      const before = ctx32({ meta: { [REFUSED_KEY]: JSON.stringify({ items: [], more: { bittensor: { n: 1, until: NOW + 10 * DAY } } }) }, settledTime: NOW + 10 * DAY + 1, settledBlock: 0n });
      expect(schedulerItems.run(before)).toEqual([]);
      // a damaged list is never read as nothing refused: the tick goes on, writes nothing over it, and marks what it
      // can't judge (monitor.unjudged names it: the re-review's residual, below)
      const damaged = ctx32({ meta: { [REFUSED_KEY]: "[1]" } });
      expect(schedulerItems.run(damaged)).toEqual([]);
      expect(metaOf(damaged)[REFUSED_KEY]).toBeUndefined();
      expect(unjudgedOf(damaged)).toContain("admin.record_full");
    });

    it("in a catch-up tick with the record full, an untracked item's own effects are listed in its admin.executed, by the same items admin.event folds by", () => {
      const full = Array.from({ length: MAX_LIVE_ITEMS }, (_, k) => synthetic(k));
      const s = scheduled("vault", "setGuardian", [G2], { kind: 1 });
      const t = tx(91);
      const effect = slog({ contract: "vault", event: "GuardianSet", block: 6_900_250n, txHash: t, logIndex: 0, args: { guardian: G2 } });
      const ex = closing("vault", "Executed", s.id, { txHash: t, logIndex: 1 });
      // scheduled, refused and executed in one tick (after an outage longer than its delay)
      const c = ctx32({ logs: [s.log, effect, ex], meta: tracked(...full) });
      expect(adminEvent.run(c)).toEqual([]);
      const found = schedulerItems.run(c);
      expect(found.map((f) => f.rule)).toEqual(["admin.scheduled", "admin.executed"]);
      expect(found[1].facts).toMatchObject({ change: "setGuardian", effects: `GuardianSet (guardian ${G2})` });
      // past the refused list's cap too: the same
      const apart = Array.from({ length: MAX_REFUSED_ITEMS }, (_, k) => synthetic(20_000 + k));
      const over = ctx32({ logs: [s.log, effect, ex], meta: { ...tracked(...full), [REFUSED_KEY]: JSON.stringify({ items: apart, more: {} }) } });
      expect(adminEvent.run(over)).toEqual([]);
      expect(schedulerItems.run(over).find((f) => f.rule === "admin.executed")?.facts.effects).toBe(`GuardianSet (guardian ${G2})`);
      // refused on an earlier tick, executed now: the same
      const first = ctx32({ logs: [s.log], meta: tracked(...full) });
      schedulerItems.run(first);
      const now = ctx32({ logs: [effect, ex], stored: [s.log], meta: { ...tracked(...full), ...metaOf(first) } });
      expect(adminEvent.run(now)).toEqual([]);
      expect(schedulerItems.run(now).map((f) => [f.rule, f.facts.effects])).toEqual([["admin.executed", `GuardianSet (guardian ${G2})`]]);
    });

    it("judges setMinPoolLiquidity with an index above 1 once, as reverting at execute (a warning), and never again", () => {
      const s = scheduled("frontDoor", "setMinPoolLiquidity", [2, 5n]);
      const c = ctx32({ logs: [s.log] });
      const found = schedulerItems.run(c);
      expect(found.map((f) => f.rule)).toEqual(["admin.scheduled", "admin.lapsed"]);
      expect(found[0].facts.direction).toBe("it reverts at execute: index 2 names no pool");
      expect(found[1]).toMatchObject({ key: `admin.lapsed:base:${s.id}:${s.log.uid}` });
      expect(found[1].facts.why).toBe("it reverts at execute: index 2 names no pool");
      expect(unjudgedOf(c)).toEqual([]);
      expect(itemsOf(c)[0].lapsed).toBe(true);
      const next = ctx32({ meta: metaOf(c), base: base32({ scheduled: { [s.id]: held(s) } }) });
      expect(schedulerItems.run(next)).toEqual([]);
      expect(unjudgedOf(next)).toEqual([]);
    });
  });

  describe("admin.lapsed", () => {
    it("warns once when a pending item's windows both pass unexecuted, in time and in its calibrated blocks (CascadeBase._lapsed, Revision 28), at the chain's reading", () => {
      const s = scheduled("vault", "setGuardian", [G2], { kind: 1, readyAt: NOW - 7 * DAY - 60 });
      // past its window in time, but its blocks came slowly: the reading (block 6,900,300) is not past its readyBlock +
      // ceil(EXECUTE_WINDOW * 1000 / (2 * 7,200)) = 42,000, so the contract would still run it: no lapse, still pending
      const slow = bit32({ scheduled: { [s.id]: held(s, { kind: 1, readyBlock: 6_900_300n - 42_000n }) } });
      const notYet = ctx32({ stored: [s.log], meta: tracked(recordOf(s)), bit: slow });
      expect(schedulerItems.run(notYet)).toEqual([]);
      expect(metaOf(notYet)[ITEMS_KEY]).toBeUndefined();
      // its block window read with no MS_PER_BLOCK: unknown, never lapsed
      const unread = ctx32({ stored: [s.log], meta: tracked(recordOf(s)), bit: bit32({ msPerBlock: undefined, scheduled: { [s.id]: held(s, { kind: 1, readyBlock: 6_000_000n }) } }) });
      expect(schedulerItems.run(unread)).toEqual([]);
      // and said so: admin.lapsed can't be judged for it, marked unjudged (review M-4; the digest lists a warning rule's)
      expect(unjudgedOf(unread)).toEqual([`admin.lapsed admin.lapsed:bittensor:${s.id}:${s.log.uid}`]);
      // inside its window in time, MS_PER_BLOCK unread is nothing to judge yet: no mark
      const t = scheduled("vault", "setGuardian", [G2], { kind: 1 });
      const inside = ctx32({ meta: tracked(recordOf(t)), bit: bit32({ msPerBlock: undefined, scheduled: { [t.id]: held(t, { kind: 1 }) } }) });
      schedulerItems.run(inside);
      expect(unjudgedOf(inside)).toEqual([]);
      // the slow item still pending (its blocks to come): no mark either
      expect(unjudgedOf(notYet)).toEqual([]);
      // one block past it: lapsed
      const lens = bit32({ scheduled: { [s.id]: held(s, { kind: 1, readyBlock: 6_900_300n - 42_001n }) } });
      const c = ctx32({ stored: [s.log], meta: tracked(recordOf(s)), bit: lens });
      const [f] = schedulerItems.run(c);
      expect(RULES["admin.lapsed"]).toMatchObject({ tier: "warning", kind: "event" });
      expect(f).toMatchObject({ rule: "admin.lapsed", key: `admin.lapsed:bittensor:${s.id}:${s.log.uid}`, subject: "A scheduled owner change can no longer run on the vault: setGuardian" });
      expect(f.facts.why).toBe(`its window ended at ${utc(s.readyAt + 7 * DAY)}, and in blocks at block 6900299, without it running`);
      expect(itemsOf(c)).toEqual([recordOf(s, { lapsed: true })]);
      // the next tick: nothing new
      expect(schedulerItems.run(ctx32({ stored: [s.log], meta: metaOf(c), bit: lens }))).toEqual([]);
    });

    it("warns when a closure or a stamp since its scheduling killed it (dead: its clock reached scheduledAt)", () => {
      const s = scheduled("vault", "setPayoutDelay", [7200n]);
      const scheduledAt = s.readyAt - 2 * DAY;
      // an Ordinary item dies to the guardian's close as well as the owner's
      const c = ctx32({ meta: tracked(recordOf(s)), bit: bit32({ exits: { ...exitsOpen, lastGuardianClose: scheduledAt + 10 }, scheduled: { [s.id]: held(s) } }) });
      const [f] = schedulerItems.run(c);
      expect(f.rule).toBe("admin.lapsed");
      expect(f.facts.why).toBe(`a closure or an owner stamp at ${utc(scheduledAt + 10)} came after it was scheduled (${utc(scheduledAt)})`);
      // a GuardianSwap reads the owner's clock only
      const g = scheduled("vault", "setGuardian", [G2], { kind: 1 });
      const k = ctx32({ meta: tracked(recordOf(g)), bit: bit32({ exits: { ...exitsOpen, lastGuardianClose: NOW }, scheduled: { [g.id]: held(g, { kind: 1 }) } }) });
      expect(schedulerItems.run(k)).toEqual([]);
    });

    it("judges nothing while the lens hasn't read the item, or reads it gone (its closing event is on its way)", () => {
      const s = scheduled("vault", "setGuardian", [G2], { kind: 1, readyAt: NOW - 8 * DAY });
      const meta = tracked(recordOf(s));
      expect(schedulerItems.run(ctx32({ meta }))).toEqual([]);
      expect(schedulerItems.run(ctx32({ meta, bit: null }))).toEqual([]);
      const gone = ctx32({ meta, bit: bit32({ scheduled: { [s.id]: GONE } }), settledTime: s.readyAt });
      expect(schedulerItems.run(gone)).toEqual([]);
      expect(metaOf(gone)[ITEMS_KEY]).toBeUndefined();
      // once the logs are stored past its window and the lens still reads it gone, it is forgotten
      const later = ctx32({ meta, bit: bit32({ scheduled: { [s.id]: GONE } }), settledTime: s.readyAt + 7 * DAY + 1 });
      expect(schedulerItems.run(later)).toEqual([]);
      expect(itemsOf(later)).toEqual([]);
    });

    it("a Lapsed (prune) of an item not yet reported warns, and forgets it; of one reported, nothing", () => {
      const s = scheduled("vault", "setGuardian", [G2], { kind: 1, readyAt: NOW - 8 * DAY });
      const lapsed = closing("vault", "Lapsed", s.id);
      const c = ctx32({ logs: [lapsed], meta: tracked(recordOf(s)) });
      const [f] = schedulerItems.run(c);
      expect(f).toMatchObject({ rule: "admin.lapsed", key: `admin.lapsed:bittensor:${s.id}:${s.log.uid}` });
      expect(f.facts.why).toBe("it was pruned past its window (Lapsed)");
      expect(itemsOf(c)).toEqual([]);
      const k = ctx32({ logs: [lapsed], meta: tracked(recordOf(s, { lapsed: true })) });
      expect(schedulerItems.run(k)).toEqual([]);
      expect(itemsOf(k)).toEqual([]);
      // a prune of an item the record doesn't hold (forgotten past its window, or never tracked): nothing
      expect(schedulerItems.run(ctx32({ logs: [closing("vault", "Lapsed", keccak256("0x03"))] }))).toEqual([]);
    });
  });

  describe("admin.item_loosens (after a direct tightening, a pending item re-judged against the new value)", () => {
    it("raises a critical once when an equal-value item becomes a loosening, on two readings", () => {
      // scheduled at the current value: harmless when scheduled
      const s = scheduled("vault", "setPayoutDelay", [BigInt(DAY)]);
      const first = ctx32({ logs: [s.log] });
      expect(schedulerItems.run(first)[0].facts.direction).toBe("doesn't loosen");
      expect(itemsOf(first)[0].loosens).toBe(false);
      const meta = metaOf(first);
      const lens = { scheduled: { [s.id]: held(s) } };
      // a direct tightening to 2 days: the pending 1-day item now loosens, read on this reading only
      const once = ctx32({ meta, bit: bit32({ ...lens, payoutDelay: 2 * DAY }), prevBit: bit32({ ...lens }) });
      expect(schedulerItems.run(once)).toEqual([]);
      const twiceRead = ctx32({ meta, bit: bit32({ ...lens, payoutDelay: 2 * DAY }) });
      const [f] = schedulerItems.run(twiceRead);
      expect(RULES["admin.item_loosens"]).toMatchObject({ tier: "critical", kind: "event" });
      expect(f).toMatchObject({
        rule: "admin.item_loosens",
        key: `admin.item_loosens:bittensor:${s.id}:${s.log.uid}`,
        subject: "A pending owner change would now loosen a limit on the vault: setPayoutDelay",
      });
      expect(f.facts).toMatchObject({ payoutDelay: "172800 s (48 h) now, 86400 s (24 h) at execute (loosens: down)", "ready at": utc(s.readyAt) });
      expect(itemsOf(twiceRead)[0].loosens).toBe(true);
      expect(schedulerItems.run(ctx32({ meta: metaOf(twiceRead), bit: bit32({ ...lens, payoutDelay: 2 * DAY }) }))).toEqual([]);
    });

    it("an item that loosened when scheduled raises nothing more (its Scheduled email said so); an unread value is unjudged", () => {
      const s = scheduled("vault", "setFeeLimits", [200n, 10n ** 16n]);
      const first = ctx32({ logs: [s.log] });
      expect(schedulerItems.run(first)[0].facts.direction).toBe("loosens");
      const lens = { scheduled: { [s.id]: held(s) } };
      expect(schedulerItems.run(ctx32({ meta: metaOf(first), bit: bit32(lens) }))).toEqual([]);
      const u = ctx32({ meta: metaOf(first), bit: bit32({ ...lens, maxFeeBps: undefined }) });
      expect(schedulerItems.run(u)).toEqual([]);
      expect(unjudgedOf(u)).toContain("admin.item_loosens");
      // the item itself unread by the lens: unjudged too; an item with no direction (setGuardian) needs nothing
      const unread = ctx32({ meta: metaOf(first) });
      expect(schedulerItems.run(unread)).toEqual([]);
      expect(unjudgedOf(unread)).toEqual(["admin.item_loosens"]);
      const g = scheduled("vault", "setGuardian", [G2], { kind: 1 });
      const none = ctx32({ meta: tracked(recordOf(g)) });
      schedulerItems.run(none);
      expect(unjudgedOf(none)).toEqual([]);
    });
  });

  describe("admin.hotkey_switched", () => {
    it("is critical on every StakeHotkeySet not run by a scheduled item (an immediate switch: gifts count)", () => {
      const l = slog({ contract: "vault", event: "StakeHotkeySet", block: 6_900_220n, args: { hotkey: HK(7) } });
      const c = ctx32({ logs: [l], bit: bit32({ stakes: { [STAKE_HK]: 40n * 10n ** 9n, [HK(7)]: 41n * 10n ** 9n } }), txs: [{ chain: "bittensor", hash: l.txHash, from: OWNER }] });
      const [f] = hotkeySwitched.run(c);
      expect(RULES["admin.hotkey_switched"]).toMatchObject({ tier: "critical", kind: "event" });
      expect(f).toMatchObject({ rule: "admin.hotkey_switched", key: `admin.hotkey_switched:${l.uid}`, subject: "The vault's stake hotkey was switched at once, with no scheduled item" });
      expect(f.facts).toMatchObject({ hotkey: HK(7), "stake on it": "41 TAO", sender: `${OWNER} (the owner)` });
      // and admin.event leaves it to this rule
      expect(adminEvent.run(c)).toEqual([]);
    });

    it("an unrelated executed item in the same transaction leaves it raised (and the switch out of that item's effects)", () => {
      const t = tx(88);
      const other = scheduled("vault", "setPayoutDelay", [7200n]);
      const l = slog({ contract: "vault", event: "StakeHotkeySet", block: 6_900_220n, txHash: t, logIndex: 1, args: { hotkey: HK(7) } });
      const ex = closing("vault", "Executed", other.id, { txHash: t, logIndex: 3, block: 6_900_220n });
      const c = ctx32({ logs: [l, ex], meta: tracked(recordOf(other)) });
      expect(hotkeySwitched.run(c).map((f) => f.rule)).toEqual(["admin.hotkey_switched"]);
      expect(adminEvent.run(c)).toEqual([]);
      const [f] = schedulerItems.run(c);
      expect(f.rule).toBe("admin.executed");
      expect(f.facts).not.toHaveProperty("effects");
    });

    it("is quiet for the switch its own scheduled item ran (an Executed whose id is keccak256 of setStakeHotkey(hotkey)), which admin.executed emails", () => {
      const t = tx(89);
      const sw = scheduled("vault", "setStakeHotkey", [HK(7)]);
      expect(sw.id).toBe(keccak256(encodeFunctionData({ abi: SCHEDULABLE.vault, functionName: "setStakeHotkey", args: [HK(7)] })));
      const l = slog({ contract: "vault", event: "StakeHotkeySet", block: 6_900_220n, txHash: t, logIndex: 1, args: { hotkey: HK(7) } });
      const ex = closing("vault", "Executed", sw.id, { txHash: t, logIndex: 3, block: 6_900_220n });
      const c = ctx32({ logs: [l, ex], meta: tracked(recordOf(sw)) });
      expect(hotkeySwitched.run(c)).toEqual([]);
      expect(adminEvent.run(c)).toEqual([]);
      expect(schedulerItems.run(c)[0].facts.effects).toBe(`StakeHotkeySet (hotkey ${HK(7)})`);
      // setStakeHotkey never lists a hotkey (it needs one listed): a direct addHotkey batched before the item is emailed
      // on its own, and isn't among the item's effects
      const added = slog({ contract: "vault", event: "HotkeyAdded", block: 6_900_220n, txHash: t, logIndex: 0, args: { hotkey: HK(7) } });
      expect(isEffectOf(recordOf(sw), added)).toBe(false);
      const withAdd = ctx32({ logs: [added, l, ex], meta: tracked(recordOf(sw)) });
      expect(adminEvent.run(withAdd).map((f) => f.key)).toEqual([`admin.event:${added.uid}`]);
      expect(schedulerItems.run(withAdd)[0].facts.effects).toBe(`StakeHotkeySet (hotkey ${HK(7)})`);
      // the matching item, but not in the record: still no switch alert, and the switch is emailed on its own
      const bare = ctx32({ logs: [l, ex] });
      expect(hotkeySwitched.run(bare)).toEqual([]);
      expect(adminEvent.run(bare).map((f) => f.facts.event)).toEqual(["vault StakeHotkeySet"]);
      // another hotkey's item: raised
      const wrong = scheduled("vault", "setStakeHotkey", [HK(8)]);
      expect(hotkeySwitched.run(ctx32({ logs: [l, closing("vault", "Executed", wrong.id, { txHash: t, logIndex: 3, block: 6_900_220n })], meta: tracked(recordOf(wrong)) }))).toHaveLength(1);
    });
  });

  describe("admin.exits_state", () => {
    it("is critical while either chain is not OPEN, naming the holds and who closed last (on two readings)", () => {
      const closed = bit32({ exits: { ...exitsOpen, open: false, guardianHold: true, pausedBy: 2, lastGuardianClose: NOW - 100 } });
      const ec = slog({ contract: "vault", event: "ExitsClosed", block: 6_900_230n, args: { by: GUARD, instrument: toFunctionSelector("pause()") } });
      const c = ctx32({ logs: [ec], bit: closed });
      const [f] = exitsState.run(c);
      expect(RULES["admin.exits_state"]).toMatchObject({ tier: "critical", kind: "condition" });
      expect(f).toMatchObject({ rule: "admin.exits_state", key: "admin.exits_state:bittensor", subject: "Exits are closed on the vault: paused by the guardian" });
      expect(f.facts).toMatchObject({
        state: "G: the guardian's hold",
        "last closed by": `${GUARD} (the guardian)`,
        "last closed with": "pause",
        "last closed at block": "6900230",
        transaction: `https://evm.taostats.io/tx/${ec.txHash}`,
      });
      // the record of the last close outlives the log's window
      expect(JSON.parse(metaOf(c)["exits_closed:bittensor"])).toEqual({ by: GUARD, instrument: "pause", block: "6900230", tx: ec.txHash });
      const k = ctx32({ bit: closed, meta: metaOf(c) });
      expect(exitsState.run(k)[0].facts["last closed with"]).toBe("pause");
      // the front door's machine, read on Base
      const fdClosed = base32({ exits: { open: false, ownerHold: true, guardianHold: false, primaryDisabledBy: 1, lastOwnerClose: NOW, lastGuardianClose: 0, pendingSince: 0 } });
      const [g] = exitsState.run(ctx32({ base: fdClosed }));
      expect(g).toMatchObject({ key: "admin.exits_state:base", subject: "Exits are closed on the front door: the primary bridge disabled by the owner" });
      expect(g.facts.state).toBe("O: the owner's hold");
    });

    it("is quiet while OPEN, waits for a second reading, and is unjudged without a reading or the state", () => {
      expect(exitsState.run(ctx32({}))).toEqual([]);
      const closed = bit32({ exits: { ...exitsOpen, open: false, ownerHold: true, launchDoorRemovedBy: 1 } });
      expect(exitsState.run(ctx32({ bit: closed, prevBit: bit32() }))).toEqual([]);
      const none = ctx32({ bit: null, base: base32({ exits: undefined }) });
      expect(exitsState.run(none)).toEqual([]);
      expect(unjudgedOf(none)).toEqual(expect.arrayContaining(["admin.exits_state admin.exits_state:bittensor", "admin.exits_state admin.exits_state:base", "admin.exits_state admin.exits_state:doors"]));
    });

    it("is critical while the launch chain has no active front door, even with the vault OPEN; unknown when launchChain isn't Base", () => {
      const [f] = exitsState.run(ctx32({ bit: bit32({ activeDoors: 0n }) }));
      expect(f).toMatchObject({ key: "admin.exits_state:doors", subject: "The vault has no active front door on Base: only direct exits on Bittensor work" });
      const other = ctx32({ bit: bit32({ activeDoors: 0n, launchChain: 10n }) });
      expect(exitsState.run(other)).toEqual([]);
      expect(unjudgedOf(other)).toContain("admin.exits_state admin.exits_state:doors");
    });
  });

  describe("admin.owner_pending", () => {
    it("is critical while pendingOwner() isn't zero, with pendingSince from the lens and until when it can accept", () => {
      const c = ctx32({ bit: bit32({ pendingOwner: SAFE, exits: { ...exitsOpen, pendingSince: NOW - 3600 } }) });
      const [f] = ownerPending.run(c);
      expect(RULES["admin.owner_pending"]).toMatchObject({ tier: "critical", kind: "condition" });
      expect(f).toMatchObject({ key: "admin.owner_pending:bittensor", subject: `A new owner is pending on the vault: ${SAFE}` });
      expect(f.facts).toMatchObject({ "pending owner": SAFE, owner: OWNER, "transfer ran at": utc(NOW - 3600), "it can accept until": utc(NOW - 3600 + 7 * DAY) });
      // it clears once acceptance can't happen: the window passed, pendingSince 0, or a closure or stamp at or after it
      expect(ownerPending.run(ctx32({ bit: bit32({ pendingOwner: SAFE, exits: { ...exitsOpen, pendingSince: NOW - 7 * DAY - 1 } }) }))).toEqual([]);
      expect(ownerPending.run(ctx32({ bit: bit32({ pendingOwner: SAFE, exits: { ...exitsOpen, pendingSince: 0 } }) }))).toEqual([]);
      expect(ownerPending.run(ctx32({ bit: bit32({ pendingOwner: SAFE, exits: { ...exitsOpen, pendingSince: NOW - 3600, lastGuardianClose: NOW - 3600 } }) }))).toEqual([]);
      expect(ownerPending.run(ctx32({ bit: bit32({ pendingOwner: SAFE, exits: { ...exitsOpen, pendingSince: NOW - 3600, lastOwnerClose: NOW - 60 } }) }))).toEqual([]);
      // pendingSince unread: it can't be told it has expired, so it is raised
      expect(ownerPending.run(ctx32({ bit: bit32({ pendingOwner: SAFE, exits: undefined }) })).map((x) => x.key)).toEqual(["admin.owner_pending:bittensor"]);
      const un = ctx32({ bit: bit32({ pendingOwner: undefined }), base: null });
      expect(ownerPending.run(un)).toEqual([]);
      expect(unjudgedOf(un)).toEqual(["admin.owner_pending admin.owner_pending:base", "admin.owner_pending admin.owner_pending:bittensor"]);
    });
  });

  describe("admin.owner_kind", () => {
    const live = testConfigV32({ DEPLOYMENT: JSON.stringify({ ...deploymentV32, stage: "live" }) });
    const codes = (code: Hex) => ({ base: { [OWNER]: code }, bittensor: { [OWNER]: code } });

    it("warns on both chains while the stage is above early without a Safe as owner", () => {
      const found = ownerKind.run(ctx32({ cfg: live, codes: codes("0x") }));
      expect(RULES["admin.owner_kind"]).toMatchObject({ tier: "warning", kind: "condition" });
      expect(found.map((f) => f.key)).toEqual(["admin.owner_kind:base", "admin.owner_kind:bittensor"]);
      expect(found[1]).toMatchObject({ subject: "The vault's owner isn't a 2-of-3 Safe, and Cascade is past the founder level" });
      expect(found[1].facts).toMatchObject({ owner: OWNER, "owner is": "no code (an account)", stage: "live", "the founder level": "a deposit cap of 40 TAO and 44 TAO in the vault" });
      // a delegated EOA is an account
      expect(ownerKind.run(ctx32({ cfg: live, codes: codes(`0xef0100${"11".repeat(20)}`) }))).toHaveLength(2);
      // retired counts as past the founder level: a retiring deployment can still hold funds
      const retired = testConfigV32({ DEPLOYMENT: JSON.stringify({ ...deploymentV32, stage: "retired" }) });
      expect(ownerKind.run(ctx32({ cfg: retired, codes: codes("0x") }))).toHaveLength(2);
    });

    it("warns for a contract owner that doesn't answer as a Safe, on two readings, never unjudged for good", () => {
      const notSafe = { address: OWNER };
      const c = ctx32({ cfg: live, codes: codes("0x6080"), bit: bit32({ ownerSafe: notSafe }), base: base32({ ownerSafe: notSafe }) });
      const found = ownerKind.run(c);
      expect(found.map((f) => f.key)).toEqual(["admin.owner_kind:base", "admin.owner_kind:bittensor"]);
      expect(found[0].facts).toMatchObject({ threshold: "doesn't answer: a contract, not a Safe", signers: "doesn't answer" });
      expect(unjudgedOf(c)).toEqual([]);
      // the reading before didn't ask it yet (a new owner): unjudged this once
      const once = ctx32({ cfg: live, codes: codes("0x6080"), bit: bit32({ ownerSafe: notSafe }), prevBit: bit32({}), base: null });
      expect(ownerKind.run(once)).toEqual([]);
      expect(unjudgedOf(once)).toContain("admin.owner_kind admin.owner_kind:bittensor");
    });

    it("warns at the early stage once either cap is above the founder level, and not at it", () => {
      expect(ownerKind.run(ctx32({ codes: codes("0x") }))).toEqual([]);
      expect(ownerKind.run(ctx32({ codes: codes("0x"), base: base32({ depositCap: 41n * E18 }) })).map((f) => f.key)).toEqual(["admin.owner_kind:base", "admin.owner_kind:bittensor"]);
      expect(ownerKind.run(ctx32({ codes: codes("0x"), bit: bit32({ maxTotalAssets: 45n * E18 }) }))).toHaveLength(2);
    });

    it("a Safe with a threshold of 2 or more and 3 signers or more is enough; fewer is not", () => {
      const safe = (threshold: bigint, signers: number) => ({ address: OWNER, threshold, signers: Array.from({ length: signers }, (_, i) => `0x${String(i + 1).padStart(40, "0")}` as Hex) });
      const run = (s: ReturnType<typeof safe>) => ownerKind.run(ctx32({ cfg: live, codes: codes("0x6080"), bit: bit32({ ownerSafe: s }), base: base32({ ownerSafe: s }) }));
      expect(run(safe(2n, 3))).toEqual([]);
      expect(run(safe(1n, 3))).toHaveLength(2);
      expect(run(safe(2n, 2))).toHaveLength(2);
    });

    it("is unjudged while the owner's code, or a contract's threshold and signers, is unread", () => {
      const c = ctx32({ cfg: live });
      expect(ownerKind.run(c)).toEqual([]);
      expect(unjudgedOf(c)).toEqual(["admin.owner_kind admin.owner_kind:base", "admin.owner_kind admin.owner_kind:bittensor"]);
      const k = ctx32({ cfg: live, codes: codes("0x6080") });
      expect(ownerKind.run(k)).toEqual([]);
      expect(unjudgedOf(k)).toHaveLength(2);
    });
  });

  describe("stake.set_full (the owner must free a slot)", () => {
    const four = [STAKE_HK, HK(2), HK(3), HK(4)];
    const full = (o: { stakes?: Record<Hex, bigint | undefined>; credits?: Record<Hex, bigint> } = {}) =>
      bit32({
        stakeMissing: true,
        missingStakeRao: 5n * 10n ** 9n,
        hotkeys: four,
        stakes: Object.fromEntries(Object.entries({ [STAKE_HK]: 1n, [HK(2)]: 3n, [HK(3)]: 3n, [HK(4)]: 3n, ...o.stakes }).filter(([, v]) => v !== undefined)) as Record<Hex, bigint>,
        unclaimedBy: { [STAKE_HK]: 0n, [HK(2)]: 0n, [HK(3)]: 0n, [HK(4)]: 0n, ...o.credits },
      });

    it("is critical while stake is missing, the set is full and every other hotkey holds stake or credits a non-owner can't remove", () => {
      const [f] = setFull.run(ctx32({ bit: full() }));
      expect(RULES["stake.set_full"]).toMatchObject({ tier: "critical", kind: "condition" });
      expect(f).toMatchObject({ rule: "stake.set_full", key: "stake.set_full", subject: "Stake is missing and only the owner can free a hotkey slot" });
      expect(f.facts).toMatchObject({ "stake hotkey": STAKE_HK, [`hotkey ${HK(2)}`]: "0.000000003 TAO staked, 0 TAO unclaimed" });
      // credits above the dust allowance (1,000 rao, in wei) on an empty hotkey: still the owner's alone
      expect(setFull.run(ctx32({ bit: full({ stakes: { [HK(3)]: 0n }, credits: { [HK(3)]: 1001n * 10n ** 9n } }) }))).toHaveLength(1);
    });

    it("is quiet when a non-owner can free a slot (an empty hotkey within the dust allowance), with a slot free, or nothing missing", () => {
      expect(setFull.run(ctx32({ bit: full({ stakes: { [HK(3)]: 0n } }) }))).toEqual([]);
      expect(setFull.run(ctx32({ bit: full({ stakes: { [HK(3)]: 0n }, credits: { [HK(3)]: 1000n * 10n ** 9n } }) }))).toEqual([]);
      expect(setFull.run(ctx32({ bit: { ...full(), hotkeys: four.slice(0, 3) } }))).toEqual([]);
      expect(setFull.run(ctx32({ bit: { ...full(), stakeMissing: false } }))).toEqual([]);
    });

    it("is unjudged while a hotkey's stake or credits, or the guard, is unread", () => {
      const c = ctx32({ bit: full({ stakes: { [HK(3)]: undefined } }) });
      expect(setFull.run(c)).toEqual([]);
      expect(unjudgedOf(c)).toEqual(["stake.set_full"]);
      const k = ctx32({ bit: { ...full(), stakeMissing: undefined } });
      expect(setFull.run(k)).toEqual([]);
      expect(unjudgedOf(k)).toEqual(["stake.set_full"]);
    });
  });

  // ---- Task 56: Task 55's re-review 2 (its two optional Minors and the damaged-record residual) ----

  describe("the scheduler record, after Task 55's re-review", () => {
    const at = (c: RuleCtx, nowS: number) => {
      c.nowS = nowS;
      return c;
    };
    it("keys admin.record_full by episode: a fresh flood after a quiet hour is a new alert (an email even when the first was acknowledged), the earlier kept while the record stays full, and all clear together", () => {
      const full = Array.from({ length: MAX_LIVE_ITEMS }, (_, k) => synthetic(k));
      const s1 = scheduled("vault", "setPayoutDelay", [7200n]);
      const c1 = ctx32({ logs: [s1.log], meta: tracked(...full) });
      expect(schedulerItems.run(c1).filter((f) => f.rule === "admin.record_full").map((f) => f.key)).toEqual([`admin.record_full:${NOW}`]);
      const m1: Record<string, string> = { ...tracked(...full), ...metaOf(c1) };
      expect(JSON.parse(m1.record_full_episodes)).toEqual({ starts: [NOW], last: NOW });
      // another refusal within the hour: the same episode, its last refusal moved on
      const s2 = scheduled("vault", "setPayoutDelay", [7300n]);
      const c2 = at(ctx32({ logs: [s2.log], meta: m1 }), NOW + 1800);
      expect(schedulerItems.run(c2).filter((f) => f.rule === "admin.record_full").map((f) => f.key)).toEqual([`admin.record_full:${NOW}`]);
      const m2: Record<string, string> = { ...m1, ...metaOf(c2) };
      expect(JSON.parse(m2.record_full_episodes)).toEqual({ starts: [NOW], last: NOW + 1800 });
      // more than an hour after the last refusal, a new flood: a second alert beside the first
      const s3 = scheduled("vault", "setPayoutDelay", [7400n]);
      const c3 = at(ctx32({ logs: [s3.log], meta: m2 }), NOW + 1800 + 3601);
      const keys = schedulerItems.run(c3).filter((f) => f.rule === "admin.record_full").map((f) => f.key);
      expect(keys).toEqual([`admin.record_full:${NOW}`, `admin.record_full:${NOW + 5401}`]);
      const m3: Record<string, string> = { ...m2, ...metaOf(c3) };
      // a tick with no refusal: both still found
      expect(schedulerItems.run(at(ctx32({ meta: m3 }), NOW + 9000)).map((f) => f.key)).toEqual(keys);
      // every refused item cancelled: none found, the episodes forgotten
      const done = at(ctx32({ logs: [s1, s2, s3].map((s) => closing("vault", "Cancelled", s.id)), meta: m3 }), NOW + 9000);
      expect(schedulerItems.run(done).filter((f) => f.rule === "admin.record_full")).toEqual([]);
      expect(metaOf(done).record_full_episodes).toBe("");
    });

    it("never drops a flood's key while the record is full: nine floods keep the first eight keys, the ninth counted in the oldest (Task 56 review, Minor 6)", () => {
      const full = Array.from({ length: MAX_LIVE_ITEMS }, (_, k) => synthetic(k));
      let meta: Record<string, string> = tracked(...full);
      const starts: number[] = [];
      let keys: string[] = [];
      let found: ReturnType<typeof schedulerItems.run> = [];
      for (let k = 0; k < 9; k++) {
        const t = NOW + k * 3601;
        const c = at(ctx32({ logs: [scheduled("vault", "setPayoutDelay", [BigInt(8000 + k)]).log], meta }), t);
        found = schedulerItems.run(c).filter((f) => f.rule === "admin.record_full");
        keys = found.map((f) => f.key);
        meta = { ...meta, ...metaOf(c) };
        if (k < 8) starts.push(t);
        // every key found before is found still: none resolves while the record stays full
        expect(keys, `flood ${k + 1}`).toEqual(starts.map((s) => `admin.record_full:${s}`));
      }
      expect(keys).toHaveLength(8);
      expect(keys[0]).toBe(`admin.record_full:${NOW}`);
      expect(found[0].facts["later floods counted here"]).toBe("1 (the monitor keeps 8 floods' alerts apart)");
      expect(found[1].facts["later floods counted here"]).toBeUndefined();
      expect(JSON.parse(meta.record_full_episodes)).toEqual({ starts, last: NOW + 8 * 3601, folded: 1 });
      // a tick with no refusal: the same eight
      expect(schedulerItems.run(at(ctx32({ meta }), NOW + 9 * 3601)).filter((f) => f.rule === "admin.record_full").map((f) => f.key)).toEqual(keys);
    });

    it("decodes each new Scheduled once a tick, and admin.event decodes nothing on a tick with no Executed (a flood of Scheduled alone)", () => {
      const flood = Array.from({ length: 20 }, (_, k) => scheduled("vault", "setPayoutDelay", [BigInt(7200 + k)]));
      const c = ctx32({ logs: flood.map((s) => s.log) });
      expect(adminEvent.run(c)).toEqual([]);
      expect(decodesOf(c)).toBe(0);
      expect(schedulerItems.run(c).filter((f) => f.rule === "admin.scheduled")).toHaveLength(20);
      expect(decodesOf(c)).toBe(20);
      // an Executed in the same tick: admin.event builds the items it folds by, from the same decodes
      const t = tx(77);
      const g = scheduled("vault", "setGuardian", [G2], { kind: 1 });
      const effect = slog({ contract: "vault", event: "GuardianSet", block: 6_900_250n, txHash: t, logIndex: 0, args: { guardian: G2 } });
      const ex = closing("vault", "Executed", g.id, { txHash: t, logIndex: 1 });
      const e = ctx32({ logs: [...flood.map((s) => s.log), g.log, effect, ex] });
      schedulerItems.run(e);
      expect(adminEvent.run(e)).toEqual([]);
      expect(decodesOf(e)).toBe(21);
    });

    it("a damaged record or refused list still lets every Scheduled, Executed and Cancelled email go out, writes nothing over it, and monitor.unjudged names it at once", () => {
      const s = scheduled("vault", "setGuardian", [G2], { kind: 1 });
      for (const [key, bad] of [
        [ITEMS_KEY, "not json"],
        [REFUSED_KEY, "[1]"],
      ] as const) {
        const c = ctx32({ logs: [s.log, closing("vault", "Cancelled", s.id)], meta: { [key]: bad } });
        const found = schedulerItems.run(c);
        expect(found.map((f) => f.rule), key).toEqual(["admin.scheduled", "admin.cancelled"]);
        expect(found[1].facts.change, key).toBe("setGuardian");
        expect(metaOf(c)[key], key).toBeUndefined();
        expect(unjudgedOf(c), key).toEqual(["admin.item_loosens", "admin.record_full"]);
        const m = monitorUnjudged.run(c).filter((f) => f.key.startsWith("monitor.unjudged:record:"));
        expect(m.map((f) => [f.rule, f.key]), key).toEqual([["monitor.unjudged", `monitor.unjudged:record:${key}`]]);
        expect(m[0].subject).toBe("The monitor's record of scheduled owner changes is damaged: pending ones aren't judged");
        expect(m[0].facts).toMatchObject({ record: `meta ${key}`, "what still works": "every Scheduled, Executed and Cancelled is still emailed" });
        expect(RUNBOOK["monitor.unjudged"](m[0].facts)).toContain(key);
      }
      // a sound record raises nothing of the kind, and v3-launch has none
      expect(monitorUnjudged.run(ctx32({ meta: tracked(recordOf(s)) })).filter((f) => f.key.startsWith("monitor.unjudged:record:"))).toEqual([]);
      expect(monitorUnjudged.run(ctx32({ cfg: testConfig(), meta: { [ITEMS_KEY]: "not json" } })).filter((f) => f.key.startsWith("monitor.unjudged:record:"))).toEqual([]);
    });
  });
});

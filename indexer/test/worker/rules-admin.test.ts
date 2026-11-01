import { type Hex, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import type { ChainName } from "../../src/config.ts";
import type { StoredLog } from "../../src/logs.ts";
import { adminEvent, keys, watchedRoles } from "../../src/rules/admin.ts";
import { logQuery, type RuleCtx } from "../../src/rules/context.ts";
import { RULES } from "../../src/rules/ids.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import type { BaseState, BitState } from "../../src/snapshot.ts";
import type { NonceRow, TxRow } from "../../src/store.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import { tx } from "./fixtures.ts";
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

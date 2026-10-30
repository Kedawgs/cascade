import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { StoredLog } from "../../src/logs.ts";
import { adminEvent, keys, watchedRoles } from "../../src/rules/admin.ts";
import { logQuery, type RuleCtx } from "../../src/rules/context.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import type { BaseState, BitState } from "../../src/snapshot.ts";
import type { NonceRow, TxRow } from "../../src/store.ts";
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
  safeNonces?: Record<Hex, bigint>;
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
      safeNonces: o.safeNonces ?? {},
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
    const c = ctx({ base: { owner: SAFE }, safeNonces: { [SAFE]: 5n }, nonces: [safeRow], newTxs: executed });
    expect(keys.run(c)).toEqual([]);
    expect(c.writes.nonces[0]).toMatchObject({ seen: 2, nonce: 5 });
    const one = ctx({ base: { owner: SAFE }, safeNonces: { [SAFE]: 5n }, nonces: [{ ...safeRow, changedAt: NOW - 2000 }], newTxs: executed.slice(0, 1) });
    expect(keys.run(one)).toEqual([]);
    expect(one.writes.nonces[0]).toMatchObject({ changedAt: NOW });
  });

  it("remembers a Safe: a tick without its nonce() (its code misread) is skipped, never judged by its transaction count", () => {
    // first read as a Safe: the row is marked
    const first = ctx({ base: { owner: SAFE }, safeNonces: { [SAFE]: 3n }, counts: { base: { [SAFE]: 1n } } });
    keys.run(first);
    expect(first.writes.nonces).toEqual([expect.objectContaining({ address: SAFE, nonce: 3, safe: true })]);
    const safeRow = first.writes.nonces[0];
    // a tick where only its transaction count (1) answers: nothing judged, nothing written
    const misread = ctx({ base: { owner: SAFE }, counts: { base: { [SAFE]: 1n } }, nonces: [safeRow] });
    expect(keys.run(misread)).toEqual([]);
    expect(misread.writes.nonces).toEqual([]);
    // and its nonce() back, unchanged: still nothing (the baseline wasn't reset to the count)
    const back = ctx({ base: { owner: SAFE }, safeNonces: { [SAFE]: 3n }, counts: { base: { [SAFE]: 1n } }, nonces: [safeRow], nowS: NOW + 3600 });
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
    const back = ctx({ base: { owner: SAFE }, safeNonces: { [SAFE]: 3n }, nonces: [safeRow], meta: { [k]: "31" } });
    expect(keys.run(back)).toEqual([]);
    expect(back.writes.meta).toEqual([{ k, v: "" }]);
    expect(RUNBOOK["keys.safe_unread"]({})).toContain("nonce()");
  });

  it("marks a watched account a Safe once its nonce() is read (a Safe deployed at it)", () => {
    const c = ctx({ base: { owner: SAFE }, safeNonces: { [SAFE]: 0n }, nonces: [row({ address: SAFE, roles: ["frontDoor.owner"], baseline: 0, nonce: 0 })] });
    keys.run(c);
    expect(c.writes.nonces).toEqual([expect.objectContaining({ address: SAFE, safe: true })]);
  });

  it("starts again from the count when more is seen than the count explains", () => {
    const c = ctx({ base: admin, counts: { base: { [ADMIN]: 51n } }, nonces: [row({ address: ADMIN })], newTxs: sent(3, ADMIN) });
    expect(keys.run(c)).toEqual([]);
    expect(c.writes.nonces[0]).toMatchObject({ baseline: 48, seen: 3, nonce: 51 });
  });

  it("stops watching an address that holds no role any more, and waits for a count", () => {
    const gone = ctx({ base: { owner: OWNER }, counts: { base: { [OWNER]: 1n } }, nonces: [row({ address: ADMIN }), row({ address: OWNER, roles: ["frontDoor.owner"], baseline: 1, nonce: 1 })] });
    expect(keys.run(gone)).toEqual([]);
    expect(gone.writes.nonces).toEqual([row({ address: ADMIN, roles: [] })]);
    // a new role holder with no count read yet: nothing written until its count is read
    const noCount = ctx({ base: { keeper: KEEPER } });
    expect(keys.run(noCount)).toEqual([]);
    expect(noCount.writes.nonces).toEqual([]);
  });
});

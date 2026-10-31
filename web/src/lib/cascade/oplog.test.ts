import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClaimOp, type CloseOp, createOpLog, decodeOperations, type DepositOp, effectiveState, type Operation, type WithdrawalOp } from "./oplog";
import { dropSavedScans } from "./scan-store";

const FD = "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750" as const;
const ME = "0x000000000000000000000000000000000000A11c" as const;
const YOU = "0x000000000000000000000000000000000000b0B0" as const;

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), keys: () => [...m.keys()] };
}

/** Records are dated in 2026 (a record dated before Cascade existed is dropped on read: see below). */
const T0 = Date.UTC(2026, 9, 1);

const deposit = (id: string, account: `0x${string}`, createdAt: number): DepositOp => ({
  id,
  kind: "deposit",
  account,
  createdAt: T0 + createdAt,
  usdcIn: 20_000_000n,
  targetTao: 78_000_000_000_000_000n,
  priceUsd: 251.6,
  mode: "sequential",
  hashes: {},
  state: "running",
});

describe("operation log", () => {
  it("round-trips operations with exact amounts, newest first", () => {
    const s = memoryStorage();
    const log = createOpLog(s, FD);
    log.put(deposit("a", ME, 1));
    log.put(deposit("b", ME, 2));
    log.update(ME, "a", { hashes: { swap: `0x${"11".repeat(32)}` }, batchId: 3n });
    const again = createOpLog(s, FD);
    expect(again.list(ME).map((o) => o.id)).toEqual(["b", "a"]);
    const a = again.get(ME, "a") as DepositOp;
    expect(a.targetTao).toBe(78_000_000_000_000_000n);
    expect(a.batchId).toBe(3n);
    expect(a.hashes.swap).toBe(`0x${"11".repeat(32)}`);
  });

  it("removes an entry for good", () => {
    const s = memoryStorage();
    const log = createOpLog(s, FD);
    log.put(deposit("a", ME, 1));
    log.put(deposit("b", ME, 2));
    log.remove(ME, "a");
    expect(createOpLog(s, FD).list(ME).map((o) => o.id)).toEqual(["b"]);
  });

  it("removes only an entry that never sent anything and is not running in this tab", () => {
    const log = createOpLog(memoryStorage(), FD);
    log.put({ ...deposit("hashed", ME, 1), hashes: { approveUsdc: `0x${"11".repeat(32)}` } });
    log.put({ ...deposit("batched", ME, 2), callsId: "0xabc" });
    log.put(deposit("running", ME, 3));
    log.put(deposit("idle", ME, 4));
    log.markActive("running");
    expect(["hashed", "batched", "running", "idle"].map((id) => log.removeUnsent(ME, id))).toEqual([false, false, false, true]);
    expect(log.list(ME).map((o) => o.id).sort()).toEqual(["batched", "hashed", "running"]);
  });

  it("keeps each account's log apart, keyed by front door and lowercase account", () => {
    const s = memoryStorage();
    const log = createOpLog(s, FD);
    log.put(deposit("a", ME, 1));
    log.put(deposit("z", YOU, 1));
    expect(log.list(ME).map((o) => o.id)).toEqual(["a"]);
    expect(log.list(YOU).map((o) => o.id)).toEqual(["z"]);
    expect(s.keys()).toContain(`cascade.ops.${FD.toLowerCase()}.${ME.toLowerCase()}`);
  });

  it("still works in memory when the browser blocks storage", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const log = createOpLog(broken, FD);
    log.put(deposit("a", ME, 1));
    expect(log.get(ME, "a")?.id).toBe("a");
  });

  it("reads this tab's own writes once storage is full, not the older list still stored", () => {
    const s = memoryStorage();
    let full = false;
    const quota = {
      getItem: s.getItem,
      setItem: (k: string, v: string) => {
        if (full) throw new DOMException("quota", "QuotaExceededError");
        s.setItem(k, v);
      },
    };
    const log = createOpLog(quota, FD);
    log.put(deposit("a", ME, 1));
    full = true;
    log.put(deposit("b", ME, 2));
    expect(log.get(ME, "b")?.id).toBe("b");
    log.update(ME, "b", { state: "sent" });
    expect(log.get(ME, "b")?.state).toBe("sent");
    expect(log.list(ME).map((o) => o.id)).toEqual(["b", "a"]);
    // once a write gets through again, storage is the record (another tab may change it)
    full = false;
    log.put(deposit("c", ME, 3));
    s.setItem(`cascade.ops.${FD.toLowerCase()}.${ME.toLowerCase()}`, "[]");
    expect(log.list(ME)).toEqual([]);
  });
});

describe("the op log and saved history in one storage", () => {
  it("makes room by dropping the saved history when storage is full: the op log wins", () => {
    const m = new Map<string, string>();
    const QUOTA = 2_000;
    const used = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
    const storage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => {
        const before = m.get(k);
        m.set(k, v);
        if (used() > QUOTA) {
          if (before === undefined) m.delete(k);
          else m.set(k, before);
          throw new DOMException("quota", "QuotaExceededError");
        }
      },
      removeItem: (k: string) => void m.delete(k),
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    };
    storage.setItem("cascade.scan.0xfd.1", "x".repeat(1_800));
    storage.setItem("cascade.scan.0xfd.1.0xme", "x".repeat(100));
    storage.setItem("something.else", "kept");
    const log = createOpLog(storage, FD, () => dropSavedScans(storage));
    log.put(deposit("a", ME, 1));
    // stored for good, so another tab or a reload reads it
    expect(createOpLog(storage, FD).get(ME, "a")?.id).toBe("a");
    expect([...m.keys()].filter((k) => k.startsWith("cascade.scan."))).toEqual([]);
    expect(m.get("something.else")).toBe("kept");
  });
});

describe("what the op log reads back from storage is checked before it is believed", () => {
  const NOW = 1_800_000_000_000;
  const KEY = `cascade.ops.${FD.toLowerCase()}.${ME.toLowerCase()}`;
  const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
  /** A record as the log writes it: bigints as { $bigint }. */
  const stored = (ops: unknown[]) => JSON.stringify(ops, (_k, v) => (typeof v === "bigint" ? { $bigint: v.toString() } : v));
  const withStored = (ops: unknown[]) => {
    const s = memoryStorage();
    s.setItem(KEY, typeof ops[0] === "string" ? (ops[0] as string) : stored(ops));
    return createOpLog(s, FD, undefined, () => NOW);
  };
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  afterEach(() => warn.mockClear());

  const depositOp: DepositOp = {
    id: "dep1",
    kind: "deposit",
    account: ME,
    createdAt: NOW - 60_000,
    v: 3,
    usdcIn: 20_000_000n,
    targetTao: 78_000_000_000_000_000n,
    minTaoOut: 77_610_000_000_000_000n,
    priceUsd: 251.6,
    feesUsd: 0.12,
    mode: "sequential",
    hashes: { approveUsdc: H(1), stake: H(2) },
    callsId: "0xabc",
    batchId: 3n,
    cancelled: { hash: H(3), at: NOW - 30_000 },
    state: "sent",
    error: "none",
  };
  const withdrawalOp: WithdrawalOp = {
    id: "wd1",
    kind: "withdrawal",
    account: ME,
    createdAt: NOW - 120_000,
    shares: 5n * 10n ** 22n,
    taoEstimate: 5n * 10n ** 16n,
    usdcEstimate: 12_500_000n,
    fee: 10n ** 14n,
    delivery: { minUsdcPerTao: 245_000_000n, deadline: 1_800_600_000 },
    hash: H(4),
    sentAt: NOW - 110_000,
    nonce: 12,
    searchedTo: 53_000_000n,
    droppedAt: NOW - 100_000,
    batchId: 4n,
    state: "failed",
  };
  const claimOp: ClaimOp = {
    id: "cl1",
    kind: "claim",
    account: ME,
    createdAt: NOW - 1_000,
    amount: 10n ** 16n,
    keepTao: false,
    minUsdc: 2_400_000n,
    hashes: { claim: H(5), approveTao: H(6), swap: H(7) },
    withdrawalIds: ["wd1"],
    state: "running",
  };
  const closeOp: CloseOp = { id: "cls1", kind: "close", account: ME, createdAt: NOW - 500, batchId: 7n, value: 10n ** 15n, hashes: { close: H(8) }, state: "sent" };

  it("reads back every kind of record whole, with its exact amounts", () => {
    const log = withStored([depositOp, withdrawalOp, claimOp, closeOp]);
    expect(log.get(ME, "dep1")).toEqual(depositOp);
    expect(log.get(ME, "wd1")).toEqual(withdrawalOp);
    expect(log.get(ME, "cl1")).toEqual(claimOp);
    expect(log.get(ME, "cls1")).toEqual(closeOp);
    expect(log.list(ME).map((o) => o.id)).toEqual(["cls1", "cl1", "dep1", "wd1"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads back a record with only its required fields", () => {
    const bare: DepositOp = { id: "b", kind: "deposit", account: ME, createdAt: NOW - 1, usdcIn: 0n, targetTao: 10n ** 16n, hashes: {}, state: "running" };
    expect(withStored([bare]).get(ME, "b")).toEqual(bare);
  });

  const without = (o: object, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
  /** Each a record that must be dropped, with its name. */
  const bad: [string, unknown][] = [
    ["not an object", "dep1"],
    ["an unknown kind", { ...depositOp, kind: "withdraw" }],
    ["an unknown state", { ...depositOp, state: "done" }],
    ["an unknown mode", { ...depositOp, mode: "parallel" }],
    ["another account's record under this account's key", { ...depositOp, account: YOU }],
    ["an account that isn't an address", { ...depositOp, account: "me" }],
    ["createdAt as text", { ...depositOp, createdAt: "not-a-date" }],
    ["createdAt as NaN", { ...depositOp, createdAt: Number.NaN }],
    ["createdAt before Cascade existed", { ...depositOp, createdAt: 1_000 }],
    ["createdAt with a fraction", { ...depositOp, createdAt: NOW - 0.5 }],
    ["an id with markup", { ...depositOp, id: "<img src=x>" }],
    ["an empty id", { ...depositOp, id: "" }],
    ["an overlong error", { ...depositOp, error: "x".repeat(2_000) }],
    ["usdcIn as a plain number", { ...depositOp, usdcIn: 5 }],
    ["usdcIn as text", { ...depositOp, usdcIn: "1e30" }],
    ["a negative bigint", { ...depositOp, usdcIn: { $bigint: "-5" } }],
    ["a bigint that isn't decimal", { ...depositOp, usdcIn: { $bigint: "abc" } }],
    ["a bigint past 96 bits of USDC", { ...depositOp, usdcIn: { $bigint: (1n << 96n).toString() } }],
    ["a bigint past 128 bits of TAO", { ...depositOp, targetTao: { $bigint: (1n << 128n).toString() } }],
    ["a batch id past 64 bits", { ...depositOp, batchId: { $bigint: (1n << 64n).toString() } }],
    ["a version that isn't 3", { ...depositOp, v: 2 }],
    ["a price that isn't a number", { ...depositOp, priceUsd: "251" }],
    ["a negative price", { ...depositOp, priceUsd: -1 }],
    ["an infinite fee", { ...depositOp, feesUsd: Number.POSITIVE_INFINITY }],
    ["a hash that isn't one", { ...depositOp, hashes: { stake: "0xzz" } }],
    ["a hash under an unknown step", { ...depositOp, hashes: { evil: H(1) } }],
    ["a claim's hash under a deposit's steps", { ...depositOp, hashes: { claim: H(1) } }],
    ["hashes that aren't an object", { ...depositOp, hashes: [H(1)] }],
    ["no hashes at all", without(depositOp, "hashes")],
    ["a callsId that isn't text", { ...depositOp, callsId: 123 }],
    ["a cancel without a hash", { ...depositOp, cancelled: { at: NOW } }],
    ["a cancel dated as text", { ...depositOp, cancelled: { hash: H(3), at: "yesterday" } }],
    ["a withdrawal's nonce with a fraction", { ...withdrawalOp, nonce: 1.5 }],
    ["a withdrawal's hash that isn't one", { ...withdrawalOp, hash: "0x1234" }],
    ["a delivery without a deadline", { ...withdrawalOp, delivery: { minUsdcPerTao: 245_000_000n } }],
    ["a delivery deadline past 2106", { ...withdrawalOp, delivery: { minUsdcPerTao: 245_000_000n, deadline: 2 ** 32 } }],
    ["shares past 128 bits", { ...withdrawalOp, shares: { $bigint: (1n << 128n).toString() } }],
    ["a claim's keepTao as text", { ...claimOp, keepTao: "yes" }],
    ["a claim's withdrawal ids that aren't text", { ...claimOp, withdrawalIds: [1] }],
    ["a close's hash under another step", { ...closeOp, hashes: { stake: H(8) } }],
    ["a close without a value", without(closeOp, "value")],
  ];

  it.each(bad)("drops %s, with a warning, and keeps the records beside it", (_name, record) => {
    const log = withStored([depositOp, record, closeOp]);
    expect(log.list(ME).map((o) => o.id)).toEqual(["cls1", "dep1"]);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toMatch(/1 activity record/);
  });

  it("never lets a corrupt record reach the screens: nothing read back has a date or amount that can't be formatted", () => {
    const log = withStored([{ ...depositOp, createdAt: "not-a-date" }, { ...withdrawalOp, usdcEstimate: { $bigint: "1e9" } }, claimOp]);
    for (const o of log.list(ME)) {
      expect(Number.isFinite(new Date(o.createdAt).getTime())).toBe(true);
      expect(() => new Intl.DateTimeFormat("en-US").format(new Date(o.createdAt))).not.toThrow();
    }
    expect(log.list(ME).map((o) => o.id)).toEqual(["cl1"]);
  });

  it("keeps only the fields it knows: anything else planted on a record is left behind", () => {
    const log = withStored([{ ...depositOp, __proto__: { admin: true }, extra: "field", to: "0xattacker" }]);
    const op = log.get(ME, "dep1") as Operation & { extra?: unknown; to?: unknown };
    expect(op).toEqual(depositOp);
    expect("extra" in op).toBe(false);
    expect("to" in op).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats storage that doesn't hold a list, or isn't JSON, as holding nothing, without throwing", () => {
    for (const raw of ['{"id":"dep1"}', "null", "42", "not json", "[1,", '"dep1"']) {
      const s = memoryStorage();
      s.setItem(KEY, raw);
      const log = createOpLog(s, FD, undefined, () => NOW);
      expect(log.list(ME), raw).toEqual([]);
      expect(log.get(ME, "dep1"), raw).toBeNull();
    }
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it("warns once for what is stored, not on every read", () => {
    const log = withStored([depositOp, { ...depositOp, id: "bad", createdAt: "x" }]);
    log.list(ME);
    log.get(ME, "dep1");
    log.list(ME);
    expect(warn).toHaveBeenCalledOnce();
    // a write leaves only what was read: the next read has nothing to warn about
    log.put({ ...closeOp, id: "cls2" });
    log.list(ME);
    expect(warn).toHaveBeenCalledOnce();
    expect(log.list(ME).map((o) => o.id)).toEqual(["cls2", "dep1"]);
  });

  it("decodes a stored list on its own: the valid records, and how many were dropped or dated back", () => {
    expect(decodeOperations(stored([depositOp, "junk", closeOp]), ME, NOW)).toEqual({ ops: [depositOp, closeOp], dropped: 1, clamped: 0 });
    expect(decodeOperations("[]", ME, NOW)).toEqual({ ops: [], dropped: 0, clamped: 0 });
    expect(decodeOperations("{}", ME, NOW)).toBeNull();
    expect(decodeOperations("nope", ME, NOW)).toBeNull();
  });

  describe("a record from a device whose clock ran ahead when it was written", () => {
    const HOUR = 60 * 60_000;
    const DAY = 24 * HOUR;

    it("is read as it is when dated up to a day ahead (an ordinary skew)", () => {
      const ahead = { ...depositOp, createdAt: NOW + 2 * HOUR };
      expect(withStored([ahead]).get(ME, "dep1")).toEqual(ahead);
      const edge = { ...depositOp, createdAt: NOW + DAY };
      expect(withStored([edge]).get(ME, "dep1")).toEqual(edge);
      expect(warn).not.toHaveBeenCalled();
    });

    it("is kept, dated now, when dated further ahead than that: a clock correction never loses a real record", () => {
      const far = { ...depositOp, createdAt: NOW + DAY + 1, cancelled: { hash: H(3), at: NOW + 3 * DAY } };
      const log = withStored([far]);
      const op = log.get(ME, "dep1") as DepositOp;
      expect(op.createdAt).toBe(NOW);
      expect(op.cancelled).toEqual({ hash: H(3), at: NOW });
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toMatch(/dated ahead/);
      // the same for every date a record keeps
      const w = { ...withdrawalOp, sentAt: NOW + 2 * DAY, droppedAt: NOW + 2 * DAY };
      expect(withStored([w]).get(ME, "wd1")).toMatchObject({ createdAt: w.createdAt, sentAt: NOW, droppedAt: NOW });
    });

    it("still drops a date that isn't one, or one from before Cascade existed", () => {
      expect(withStored([{ ...depositOp, createdAt: "tomorrow" }]).list(ME)).toEqual([]);
      expect(withStored([{ ...depositOp, createdAt: Number.POSITIVE_INFINITY }]).list(ME)).toEqual([]);
      expect(withStored([{ ...depositOp, cancelled: { hash: H(3), at: 1_000 } }]).list(ME)).toEqual([]);
    });
  });

  it("keeps a wallet batch id as long as EIP-5792 allows (8,194 characters) on a deposit, a claim and a close, and no longer", () => {
    const longest = `0x${"ab".repeat(4_096)}`;
    expect(longest.length).toBe(8_194);
    const log = withStored([{ ...depositOp, callsId: longest }, { ...claimOp, callsId: longest }, { ...closeOp, callsId: longest }]);
    expect(log.list(ME).map((o) => (o as DepositOp).callsId)).toEqual([longest, longest, longest]);
    expect(warn).not.toHaveBeenCalled();
    const over = `${longest}c`;
    expect(withStored([{ ...depositOp, callsId: over }, { ...claimOp, callsId: over }, { ...closeOp, callsId: over }]).list(ME)).toEqual([]);
  });

  it("the resume path never sees a record whose amounts aren't exact bigints in range", () => {
    // the pen test's tampered record: a million-dollar usdcIn is in range, so it is read; its floor is a
    // matter for the resume path, which quotes afresh (flows.ts, planResumeStakeV3) and never sends it
    const planted = { id: "rec1", kind: "deposit", account: ME, createdAt: NOW - 60_000, state: "needs-you", v: 3, usdcIn: { $bigint: "1000000000000" }, targetTao: { $bigint: "1000000000000000000" }, minTaoOut: { $bigint: "0" }, hashes: {} };
    const op = withStored([planted]).get(ME, "rec1") as DepositOp;
    expect(op.usdcIn).toBe(1_000_000_000_000n);
    expect(typeof op.minTaoOut).toBe("bigint");
    // one that overflows what USDC can be is not
    expect(withStored([{ ...planted, usdcIn: { $bigint: "99999999999999999999999999999999999" } }]).get(ME, "rec1")).toBeNull();
  });
});

describe("effectiveState", () => {
  it("treats a flow left running by a closed or reloaded tab as waiting for the user", () => {
    const log = createOpLog(memoryStorage(), FD);
    const op = deposit("a", ME, 1);
    log.put(op);
    expect(effectiveState(op, log)).toBe("needs-you");
    log.markActive("a");
    expect(effectiveState(op, log)).toBe("running");
    log.markInactive("a");
    expect(effectiveState({ ...op, state: "sent" }, log)).toBe("sent");
  });
});

import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { Deployment } from "./config";
import { newScan, restartScan, type VaultScan } from "./facts";
import { createScanStore, dropSavedScans, SCAN_VERSION, scanState, seedHalves } from "./scan-store";

const D: Deployment = {
  frontDoor: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  baseAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  vault: "0x5Ab5c7E1d5D9C9e5b1F9b2d6C0dB0a4d8E5f3c21",
  bitAdapter: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  bitBlock: 1_000n,
  vaultSs58: "x",
  hotkeySs58: "y",
};
const ME = "0x000000000000000000000000000000000000A11c" as const;
const YOU = "0x000000000000000000000000000000000000b0B0" as const;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const GLOBAL_KEY = `cascade.scan.${D.frontDoor.toLowerCase()}.1000`;
const MY_KEY = `${GLOBAL_KEY}.${ME.toLowerCase()}`;

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

/** A scan that has read [1000, 5000): a delivery, a stake, two payout chunks, and the account's deposit and redeem. */
function scanned(): VaultScan {
  const s = newScan(D);
  s.next = 5_000n;
  s.delivered.set("3", { key: H(77), txHash: H(9), block: 1_500n });
  s.staked.push({ block: 1_600n, txHash: H(10) });
  s.payouts.set(H(77), [
    { txHash: H(11), block: 1_900n, chunk: 0, taken: 100 },
    { txHash: H(12), block: 1_950n, chunk: 1, taken: 3 },
  ]);
  s.deposited.push({ key: H(77), txHash: H(9), block: 1_500n, assets: 10n ** 16n });
  s.redeemed.push({ key: H(78), txHash: H(13), block: 4_000n, assets: 5n * 10n ** 15n });
  return s;
}

describe("scan store", () => {
  it("saves a scan and resumes it where it stopped, its events intact and its amounts waiting to be confirmed", () => {
    const storage = memoryStorage();
    createScanStore(storage, D).save(ME, scanned());
    const back = createScanStore(storage, D).load(ME);
    expect(back.next).toBe(4_990n);
    expect(back.delivered.get("3")).toEqual({ key: H(77), txHash: H(9), block: 1_500n, unconfirmed: true });
    // stakes and chunks this browser read itself come back as read: only the indexer's wait for their receipts
    expect(back.staked).toEqual([{ block: 1_600n, txHash: H(10) }]);
    expect(back.payouts.get(H(77))).toEqual(scanned().payouts.get(H(77)));
    expect(back.deposited).toEqual([{ key: H(77), txHash: H(9), block: 1_500n, assets: 10n ** 16n, unconfirmed: true }]);
    expect(back.redeemed).toEqual([{ key: H(78), txHash: H(13), block: 4_000n, assets: 5n * 10n ** 15n, unconfirmed: true }]);
  });

  it("saves only what has settled: progress short of the last blocks read, and no event in them", () => {
    const s = scanned();
    s.staked.push({ block: 4_995n, txHash: H(30) });
    const state = scanState(s);
    expect(state.next).toBe("4990");
    expect(state.staked).toEqual([{ block: "1600", txHash: H(10) }]);
    // in memory, the scan keeps them
    expect(s.staked).toHaveLength(2);
  });

  it("keeps each deployment and account apart", () => {
    const storage = memoryStorage();
    createScanStore(storage, D).save(ME, scanned());
    expect(createScanStore(storage, D).load(YOU).next).toBe(D.bitBlock);
    // the same front door, redeployed from a later block
    const again = { ...D, bitBlock: 9_000n };
    expect(createScanStore(storage, again).load(ME).next).toBe(9_000n);
    expect([...storage.m.keys()].sort()).toEqual([GLOBAL_KEY, MY_KEY]);
  });

  it("saves the deployment's own events once for every account, and each account's events apart", () => {
    const storage = memoryStorage();
    const store = createScanStore(storage, D);
    store.save(ME, scanned());
    const yours = scanned();
    yours.deposited = [{ key: H(79), txHash: H(14), block: 2_500n, assets: 3n }];
    yours.redeemed = [];
    store.save(YOU, yours);
    expect(storage.m.size).toBe(3);
    // the deliveries, stakes and chunks are in the deployment's entry only
    expect(storage.m.get(MY_KEY)).not.toContain(H(10).slice(2));
    expect(JSON.parse(storage.m.get(GLOBAL_KEY)!).deposited).toEqual([]);
    const back = store.load(YOU);
    expect(back.delivered.get("3")?.txHash).toBe(H(9));
    expect(back.staked).toHaveLength(1);
    expect(back.deposited).toEqual([{ key: H(79), txHash: H(14), block: 2_500n, assets: 3n, unconfirmed: true }]);
    expect(store.load(ME).redeemed).toHaveLength(1);
  });

  it("resumes from the earlier of the two saves when another account saved the deployment's events at another block", () => {
    const storage = memoryStorage();
    const store = createScanStore(storage, D);
    store.save(ME, scanned());
    const behind = newScan(D);
    behind.next = 3_000n;
    behind.delivered.set("3", { key: H(77), txHash: H(9), block: 1_500n });
    store.save(YOU, behind);
    const back = store.load(ME);
    expect(back.next).toBe(2_990n);
    // the redeem at block 4,000 is past that: it is read again, not taken from the save
    expect(back.redeemed).toEqual([]);
    expect(back.deposited).toHaveLength(1);
  });

  it("starts over when either half of a save is missing", () => {
    const storage = memoryStorage();
    createScanStore(storage, D).save(ME, scanned());
    const noAccount = memoryStorage();
    noAccount.setItem(GLOBAL_KEY, storage.m.get(GLOBAL_KEY)!);
    expect(createScanStore(noAccount, D).load(ME).next).toBe(D.bitBlock);
    const noDeployment = memoryStorage();
    noDeployment.setItem(MY_KEY, storage.m.get(MY_KEY)!);
    expect(createScanStore(noDeployment, D).load(ME).next).toBe(D.bitBlock);
  });

  it("discards an entry that is corrupt, of another version or for another vault, rather than half-trusting it", () => {
    const good = scanState(scanned());
    const bad: unknown[] = [
      "not json",
      { ...good, v: SCAN_VERSION + 1 },
      { ...good, vault: "0x0000000000000000000000000000000000000001" },
      { ...good, from: "999" },
      { ...good, next: "900" },
      { ...good, next: "-5" },
      // an event at or past where the scan says it stopped
      { ...good, staked: [{ block: "5000", txHash: H(10) }] },
      { ...good, delivered: [{ batchId: "3", key: "0x77", txHash: H(9), block: "1500" }] },
      { ...good, payouts: [{ key: H(77), chunk: -1, taken: 1, txHash: H(11), block: "1900" }] },
      { ...good, deposited: [{ key: H(77), txHash: H(9), block: "1500", assets: 1e16 }] },
      { ...good, redeemed: "none" },
    ];
    const loaded = (entry: unknown) => {
      const storage = memoryStorage();
      for (const k of [GLOBAL_KEY, MY_KEY]) storage.setItem(k, typeof entry === "string" ? entry : JSON.stringify(entry));
      return createScanStore(storage, D).load(ME);
    };
    expect(loaded(good).next).toBe(4_990n);
    for (const entry of bad) {
      const s = loaded(entry);
      expect(s.next).toBe(D.bitBlock);
      expect(s.delivered.size + s.staked.length + s.deposited.length).toBe(0);
    }
  });

  it("never lets one scan crowd the op log out of storage: past its share it stays in memory, and the earlier save stands", () => {
    const storage = memoryStorage();
    const store = createScanStore(storage, D);
    store.save(ME, scanned());
    const huge = scanned();
    huge.next = 9_000_000n;
    for (let i = 0; i < 12_000; i++) huge.staked.push({ block: 5_000n + BigInt(i), txHash: H(i) });
    store.save(ME, huge);
    expect(store.load(ME).next).toBe(4_990n);
  });

  it("saves no scan again this visit once the op log needed their room: storage doesn't fill straight back up", () => {
    const m = new Map<string, string>();
    const storage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    };
    const store = createScanStore(storage, D);
    store.save(ME, scanned());
    expect(dropSavedScans(storage)).toBe(true);
    store.save(ME, scanned());
    createScanStore(storage, D).save(YOU, scanned());
    expect(m.size).toBe(0);
    // another storage is unaffected
    const other = memoryStorage();
    createScanStore(other, D).save(ME, scanned());
    expect(other.m.size).toBe(2);
  });

  it("keeps the scan in memory when storage is full or blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };
    const store = createScanStore(blocked, D);
    expect(() => store.save(ME, scanned())).not.toThrow();
    expect(store.load(ME).next).toBe(D.bitBlock);
  });
});

describe("seedHalves", () => {
  /** The indexer's two halves of `scanned()`: the deployment's events in one, the account's in the other. */
  const halves = (s = scanned()) => {
    const state = scanState(s);
    return { shared: { ...state, deposited: [], redeemed: [] }, own: { ...state, delivered: [], staked: [], payouts: [] } };
  };

  it("adds the halves' events past where the scan stopped, every one unconfirmed, and resumes from their block, marking both halves as the indexer's up to there", () => {
    const scan = newScan(D);
    scan.next = 1_550n;
    scan.delivered.set("3", { key: H(77), txHash: H(9), block: 1_500n });
    scan.deposited.push({ key: H(77), txHash: H(9), block: 1_500n, assets: 10n ** 16n });
    const { shared, own } = halves();
    expect(seedHalves(scan, shared, own)).toBe(true);
    expect(scan.next).toBe(4_990n);
    expect(scan.sharedSeededTo).toBe(4_990n);
    expect(scan.accountSeededTo).toBe(4_990n);
    // what the scan read stays as it read it, once
    expect(scan.delivered.size).toBe(1);
    expect(scan.deposited).toEqual([{ key: H(77), txHash: H(9), block: 1_500n, assets: 10n ** 16n }]);
    // the rest comes in: stakes and chunks wait for their receipts too, like deliveries and amounts
    expect(scan.staked).toEqual([{ block: 1_600n, txHash: H(10), unconfirmed: true }]);
    expect(scan.payouts.get(H(77))).toEqual([
      { txHash: H(11), block: 1_900n, chunk: 0, taken: 100, unconfirmed: true },
      { txHash: H(12), block: 1_950n, chunk: 1, taken: 3, unconfirmed: true },
    ]);
    expect(scan.redeemed).toEqual([{ key: H(78), txHash: H(13), block: 4_000n, assets: 5n * 10n ** 15n, unconfirmed: true }]);
  });

  it("merges the halves at the earlier of their two blocks, as a load does, and marks both only up to there", () => {
    const { shared, own } = halves();
    const scan = newScan(D);
    // the account half from an earlier tick: it stops at 3,000 and so holds no redeem at 4,000
    expect(seedHalves(scan, shared, { ...own, next: "3000", redeemed: [] })).toBe(true);
    expect(scan.next).toBe(3_000n);
    expect(scan.sharedSeededTo).toBe(3_000n);
    expect(scan.accountSeededTo).toBe(3_000n);
    // the redeem at block 4,000 is past that: it is read, not taken from the seed
    expect(scan.redeemed).toEqual([]);
    expect(scan.deposited).toHaveLength(1);
  });

  it("changes nothing, and marks nothing, for halves that don't reach past the scan, or aren't both valid for its deployment", () => {
    const { shared, own } = halves();
    const ahead = newScan(D);
    ahead.next = 4_990n;
    expect(seedHalves(ahead, shared, own)).toBe(false);
    expect(ahead.next).toBe(4_990n);
    expect(ahead.sharedSeededTo).toBeUndefined();
    for (const [a, b] of [
      [{ ...shared, vault: D.frontDoor.toLowerCase() }, own],
      [shared, { ...own, from: "999" }],
      [shared, { ...own, v: SCAN_VERSION + 1 }],
      [null, own],
      [shared, "not an object"],
      // one half's events outside its own range
      [{ ...shared, staked: [{ block: "4990", txHash: H(10) }] }, own],
    ] as [unknown, unknown][]) {
      const fresh = newScan(D);
      expect(seedHalves(fresh, a, b)).toBe(false);
      expect(fresh.next).toBe(D.bitBlock);
      expect(fresh.delivered.size + fresh.staked.length + fresh.deposited.length + fresh.redeemed.length).toBe(0);
      expect(fresh.sharedSeededTo).toBeUndefined();
      expect(fresh.accountSeededTo).toBeUndefined();
    }
  });

  it("counts an account event listed twice once, and never adds one the scan already holds", () => {
    const { shared, own } = halves();
    const twice = { ...own, deposited: [...own.deposited, ...own.deposited], redeemed: [...own.redeemed, { ...own.redeemed[0], assets: "1" }] };
    const scan = newScan(D);
    seedHalves(scan, shared, twice);
    expect(scan.deposited).toHaveLength(1);
    expect(scan.redeemed).toHaveLength(1);
    const again = newScan(D);
    again.next = 4_500n;
    again.redeemed.push({ key: H(78), txHash: H(13), block: 4_000n, assets: 5n * 10n ** 15n });
    seedHalves(again, shared, { ...own, redeemed: [{ key: H(78), txHash: H(13), block: "4600", assets: "5000000000000000" }] });
    expect(again.redeemed).toHaveLength(1);
  });

  it("puts the halves' events in block order, whatever order they list them in", () => {
    const { shared, own } = halves();
    const scan = newScan(D);
    seedHalves(scan, { ...shared, staked: [{ block: "3000", txHash: H(21) }, { block: "2000", txHash: H(20) }] }, own);
    expect(scan.staked.map((s) => s.block)).toEqual([2_000n, 3_000n]);
  });

  it("keeps both marks through a save and a load, each on its own half, short of the unsettled blocks like the rest", () => {
    const storage = memoryStorage();
    const store = createScanStore(storage, D);
    const scan = newScan(D);
    const { shared, own } = halves();
    seedHalves(scan, shared, own);
    // the scan then read on, past the seed
    scan.next = 6_000n;
    store.save(ME, scan);
    expect(JSON.parse(storage.m.get(GLOBAL_KEY)!).seededTo).toBe("4990");
    expect(JSON.parse(storage.m.get(MY_KEY)!).seededTo).toBe("4990");
    const back = store.load(ME);
    expect(back.next).toBe(5_990n);
    expect(back.sharedSeededTo).toBe(4_990n);
    expect(back.accountSeededTo).toBe(4_990n);
    // a seed the scan hadn't read past is marked only as far as the save reached
    const fresh = newScan(D);
    seedHalves(fresh, shared, own);
    createScanStore(memoryStorage(), D);
    const s2 = memoryStorage();
    createScanStore(s2, D).save(ME, fresh);
    expect(JSON.parse(s2.m.get(GLOBAL_KEY)!).seededTo).toBe("4980");
    expect(createScanStore(s2, D).load(ME).sharedSeededTo).toBe(4_980n);
  });

  it("gives a second account of the same deployment the shared half's mark, while its own half, read by this browser, carries none", () => {
    const storage = memoryStorage();
    const store = createScanStore(storage, D);
    // an earlier visit of the other account read the chain itself
    const yours = newScan(D);
    yours.next = 5_000n;
    yours.deposited.push({ key: H(79), txHash: H(14), block: 2_500n, assets: 3n });
    store.save(YOU, yours);
    // then this account's visit seeded the deployment's half from the indexer
    const scan = newScan(D);
    const { shared, own } = halves();
    seedHalves(scan, shared, own);
    store.save(ME, scan);
    const back = store.load(YOU);
    expect(back.next).toBe(4_980n);
    expect(back.sharedSeededTo).toBe(4_980n);
    expect(back.accountSeededTo).toBeUndefined();
    expect(back.deposited).toEqual([{ key: H(79), txHash: H(14), block: 2_500n, assets: 3n, unconfirmed: true }]);
    // and once the other account's own read rewrites the deployment's half, the mark is gone
    const again = store.load(YOU);
    restartScan(again);
    again.next = 5_000n;
    store.save(YOU, again);
    expect(store.load(ME).sharedSeededTo).toBeUndefined();
  });

  it("loads older saves without the marks unseeded, and drops a save whose mark isn't a block within what it read", () => {
    const good = scanState(scanned());
    const load = (shared: unknown, own: unknown) => {
      const storage = memoryStorage();
      storage.setItem(GLOBAL_KEY, JSON.stringify(shared));
      storage.setItem(MY_KEY, JSON.stringify(own));
      return createScanStore(storage, D).load(ME);
    };
    const plain = load(good, good);
    expect(plain.next).toBe(4_990n);
    expect(plain.sharedSeededTo).toBeUndefined();
    expect(plain.accountSeededTo).toBeUndefined();
    // a marked half is the store's second version, with both ends of the mark
    const marked = { ...good, v: 2, seededFrom: "1000", seededTo: "3000" };
    expect(load(marked, good).sharedSeededTo).toBe(3_000n);
    expect(load(marked, good).sharedSeededFrom).toBe(1_000n);
    expect(load(good, marked).accountSeededTo).toBe(3_000n);
    // its stakes and chunks in the mark wait for their receipts; those outside it are the browser's own
    const half = load({ ...marked, seededTo: "1700" }, good);
    expect(half.staked).toEqual([{ block: 1_600n, txHash: H(10), unconfirmed: true }]);
    expect(half.payouts.get(H(77))?.every((p) => p.unconfirmed === undefined)).toBe(true);
    for (const bad of [
      { ...good, seededTo: "3000" },
      { ...good, v: 2 },
      { ...marked, seededTo: "4991" },
      { ...marked, seededFrom: "999" },
      { ...marked, seededFrom: "3001" },
      { ...marked, seededTo: -1 },
      { ...marked, seededTo: "" },
      { ...marked, seededTo: "abc" },
    ]) {
      expect(load(bad, good).next, JSON.stringify(bad.seededTo)).toBe(D.bitBlock);
    }
  });

  it("clears both marks when the scan starts over from the deploy block, so the browser's own read of that half isn't taken for the indexer's", () => {
    const scan = newScan(D);
    const { shared, own } = halves();
    seedHalves(scan, shared, own);
    restartScan(scan);
    expect(scan.next).toBe(D.bitBlock);
    expect(scan.sharedSeededTo).toBeUndefined();
    expect(scan.accountSeededTo).toBeUndefined();
    const storage = memoryStorage();
    createScanStore(storage, D).save(ME, scan);
    expect(storage.m.get(GLOBAL_KEY)).not.toContain("seededTo");
  });
});

describe("the background check's progress, kept inside each half (review 2, N1)", () => {
  const halves = (s = scanned()) => {
    const state = scanState(s);
    return { shared: { ...state, deposited: [], redeemed: [] }, own: { ...state, delivered: [], staked: [], payouts: [] } };
  };
  const seededScan = () => {
    const scan = newScan(D);
    const { shared, own } = halves();
    seedHalves(scan, shared, own);
    scan.next = 6_000n;
    return scan;
  };

  it("writes each half's progress in the one write with its events, and reads it back with that half only", () => {
    const storage = memoryStorage();
    const store = createScanStore(storage, D);
    const scan = seededScan();
    scan.sharedCheckedTo = 3_000n;
    scan.accountCheckedTo = 2_000n;
    store.save(ME, scan);
    expect(JSON.parse(storage.m.get(GLOBAL_KEY)!).checkedTo).toBe("3000");
    expect(JSON.parse(storage.m.get(MY_KEY)!).checkedTo).toBe("2000");
    const back = store.load(ME);
    expect(back.sharedCheckedTo).toBe(3_000n);
    expect(back.accountCheckedTo).toBe(2_000n);
    // no progress of its own: a half with none is unchecked from its first block
    const bare = seededScan();
    store.save(ME, bare);
    expect(JSON.parse(storage.m.get(GLOBAL_KEY)!)).not.toHaveProperty("checkedTo");
    expect(store.load(ME).sharedCheckedTo).toBeUndefined();
  });

  it("never lets one account's progress cover the deployment half another account's seed wrote over it", () => {
    const storage = memoryStorage();
    const store = createScanStore(storage, D);
    // this account checked the deployment half its own seed brought, to 4,000
    const mine = seededScan();
    mine.sharedCheckedTo = mine.accountCheckedTo = 4_000n;
    store.save(ME, mine);
    // another account's visit, seeded too, writes the deployment half with nothing checked
    const yours = seededScan();
    store.save(YOU, yours);
    const back = store.load(ME);
    expect(back.sharedSeededTo).toBe(4_990n);
    expect(back.sharedCheckedTo).toBeUndefined();
    // while this account's own half keeps its own progress
    expect(back.accountCheckedTo).toBe(4_000n);
  });

  it("refuses a half whose progress lies outside its own mark, or a first-version half (the indexer's form) that claims any", () => {
    const good = scanState(scanned());
    const marked = { ...good, v: 2, seededFrom: "1000", seededTo: "3000" };
    const load = (shared: unknown) => {
      const storage = memoryStorage();
      storage.setItem(GLOBAL_KEY, JSON.stringify(shared));
      storage.setItem(MY_KEY, JSON.stringify(good));
      return createScanStore(storage, D).load(ME);
    };
    expect(load({ ...marked, checkedTo: "2000" }).sharedCheckedTo).toBe(2_000n);
    for (const bad of [{ ...good, checkedTo: "2000" }, { ...marked, checkedTo: "3001" }, { ...marked, checkedTo: "999" }, { ...marked, checkedTo: "x" }]) {
      expect(load(bad).next, JSON.stringify(bad)).toBe(D.bitBlock);
    }
    // nor may the indexer's seed bring progress of its own
    const scan = newScan(D);
    const { shared, own } = halves();
    expect(seedHalves(scan, { ...shared, checkedTo: "2000" }, own)).toBe(false);
  });

  it("seeds no scan that still holds seeded blocks the browser hasn't finished reading: its marks would be overwritten, those blocks taken for read", () => {
    const scan = seededScan();
    scan.sharedCheckedTo = 2_000n;
    const later = scanned();
    later.next = 9_000n;
    const { shared, own } = halves(later);
    expect(seedHalves(scan, shared, own)).toBe(false);
    expect([scan.sharedSeededTo, scan.sharedCheckedTo, scan.next]).toEqual([4_990n, 2_000n, 6_000n]);
  });

  it("drops the progress when the scan starts over", () => {
    const scan = seededScan();
    scan.sharedCheckedTo = scan.accountCheckedTo = 3_000n;
    restartScan(scan);
    expect(scan.sharedCheckedTo).toBeUndefined();
    expect(scan.accountCheckedTo).toBeUndefined();
  });
});

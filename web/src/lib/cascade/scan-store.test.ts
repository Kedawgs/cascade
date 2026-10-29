import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { Deployment } from "./config";
import { newScan, type VaultScan } from "./facts";
import { createScanStore, SCAN_VERSION, scanState, seedScan } from "./scan-store";

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
    expect(back.delivered.get("3")).toEqual({ key: H(77), txHash: H(9), block: 1_500n });
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
    expect([...storage.m.keys()]).toEqual([`cascade.scan.${D.frontDoor.toLowerCase()}.1000.${ME.toLowerCase()}`]);
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
    for (const entry of bad) {
      const storage = memoryStorage();
      storage.setItem(`cascade.scan.${D.frontDoor.toLowerCase()}.1000.${ME.toLowerCase()}`, typeof entry === "string" ? entry : JSON.stringify(entry));
      const s = createScanStore(storage, D).load(ME);
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

describe("seedScan", () => {
  it("adds a starting point's events past where the scan stopped, and resumes from its block", () => {
    const scan = newScan(D);
    scan.next = 1_550n;
    scan.delivered.set("3", { key: H(77), txHash: H(9), block: 1_500n });
    scan.deposited.push({ key: H(77), txHash: H(9), block: 1_500n, assets: 10n ** 16n });
    expect(seedScan(scan, scanState(scanned()))).toBe(true);
    expect(scan.next).toBe(4_990n);
    // what the scan read stays as it read it, once
    expect(scan.delivered.size).toBe(1);
    expect(scan.deposited).toEqual([{ key: H(77), txHash: H(9), block: 1_500n, assets: 10n ** 16n }]);
    // the rest comes in, the account's amounts unconfirmed
    expect(scan.staked).toEqual([{ block: 1_600n, txHash: H(10) }]);
    expect(scan.payouts.get(H(77))?.map((p) => p.chunk)).toEqual([0, 1]);
    expect(scan.redeemed).toEqual([{ key: H(78), txHash: H(13), block: 4_000n, assets: 5n * 10n ** 15n, unconfirmed: true }]);
  });

  it("changes nothing for a starting point that doesn't reach past the scan, or isn't valid for its vault", () => {
    const ahead = newScan(D);
    ahead.next = 4_990n;
    expect(seedScan(ahead, scanState(scanned()))).toBe(false);
    expect(ahead.next).toBe(4_990n);
    const fresh = newScan(D);
    expect(seedScan(fresh, { ...scanState(scanned()), vault: D.frontDoor.toLowerCase() })).toBe(false);
    expect(seedScan(fresh, null)).toBe(false);
    expect(fresh.next).toBe(D.bitBlock);
  });

  it("counts an account event listed twice once", () => {
    const state = scanState(scanned());
    state.deposited = [...state.deposited, ...state.deposited];
    state.redeemed = [...state.redeemed, { ...state.redeemed[0], assets: "1" }];
    const scan = newScan(D);
    seedScan(scan, state);
    expect(scan.deposited).toHaveLength(1);
    expect(scan.redeemed).toHaveLength(1);
    // and one the scan already holds isn't added again
    const again = newScan(D);
    again.next = 4_500n;
    again.redeemed.push({ key: H(78), txHash: H(13), block: 4_000n, assets: 5n * 10n ** 15n });
    seedScan(again, { ...scanState(scanned()), redeemed: [{ key: H(78), txHash: H(13), block: "4600", assets: "5000000000000000" }] });
    expect(again.redeemed).toHaveLength(1);
  });

  it("puts a starting point's events in block order, whatever order it lists them in", () => {
    const state = scanState(scanned());
    state.staked = [
      { block: "3000", txHash: H(21) },
      { block: "2000", txHash: H(20) },
    ];
    const scan = newScan(D);
    seedScan(scan, state);
    expect(scan.staked.map((s) => s.block)).toEqual([2_000n, 3_000n]);
  });
});

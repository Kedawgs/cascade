import { decodeAbiParameters, encodeAbiParameters, type Hex, keccak256, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { WALLET } from "../src/config.ts";
import { BATCH_PARAMS, encodeBatch, openBatchId } from "../src/keeper/batch.ts";
import { decideNext, type State } from "../src/keeper/due.ts";
import { type PayoutLog, payoutsHash, rebuildPayouts } from "../src/keeper/payouts.ts";

const alice = "0x000000000000000000000000000000000000a11c" as const;
const KEY: Hex = `0x${"aa".repeat(32)}`;
const OTHER: Hex = `0x${"bb".repeat(32)}`;
const ZERO: Hex = `0x${"00".repeat(32)}`;

describe("batch encoding", () => {
  it("matches abi.encode(uint8 1, uint64 id, Entry[] deposits, Entry[] redeems)", () => {
    const deposits = [{ user: alice, amount: 10n ** 16n }];
    const encoded = encodeBatch(1n, deposits, []);
    expect(encoded).toBe(encodeAbiParameters(parseAbiParameters(BATCH_PARAMS), [1, 1n, deposits, []]));
    const [kind, id, d] = decodeAbiParameters(parseAbiParameters(BATCH_PARAMS), encoded);
    expect([kind, id, d[0].amount]).toEqual([1, 1n, 10n ** 16n]);
  });

  it("finds the open batch id from the closed ones", () => {
    expect(openBatchId([])).toBe(1n);
    expect(openBatchId([1n, 3n, 2n])).toBe(4n);
  });
});

describe("payout rebuild", () => {
  const log = (kind: PayoutLog["kind"], key: Hex, block: bigint, logIndex: number, assets: bigint): PayoutLog => ({
    kind,
    key,
    user: WALLET,
    shares: kind === "bounced" ? 0n : 5n,
    assets,
    blockNumber: block,
    logIndex,
  });

  it("puts bounced deposits first, then redeems, each in log order, for that key only", () => {
    const list = rebuildPayouts(
      [log("redeemed", KEY, 10n, 1, 1n), log("bounced", KEY, 10n, 3, 2n), log("redeemed", OTHER, 9n, 0, 9n), log("redeemed", KEY, 10n, 0, 3n)],
      KEY,
    );
    expect(list.map((p) => p.assets)).toEqual([2n, 3n, 1n]);
    expect(list[0].shares).toBe(0n);
  });

  it("hashes like the vault's running hash", () => {
    expect(payoutsHash([])).toBe(ZERO);
    const p = { user: WALLET, shares: 5n, assets: 7n };
    const one = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, address, uint256, uint256"), [ZERO, p.user, 5n, 7n]));
    expect(payoutsHash([p])).toBe(one);
    expect(payoutsHash([p, p])).toBe(
      keccak256(encodeAbiParameters(parseAbiParameters("bytes32, address, uint256, uint256"), [one, p.user, 5n, 7n])),
    );
  });
});

describe("decideNext", () => {
  const T = 1_800_000_000;
  const base: State = {
    now: T,
    frontDoor: { canClose: true, nDeposits: 1, nRedeems: 0, paused: false },
    alphaVault: { healthy: true },
    vault: { paused: false, available: 10n ** 16n, minStakeWei: 2n * 10n ** 15n, batches: [{ key: KEY, queuedAt: T - 3600, cursor: 0, count: 1 }], payoutDelay: 3600 },
  };
  const withVault = (v: Partial<State["vault"]>) => ({ ...base, vault: { ...base.vault, ...v } });

  it("puts a due payout before staking before closing", () => {
    expect(decideNext(base).action).toEqual({ kind: "payouts", key: KEY });
    expect(decideNext(withVault({ batches: [] })).action).toEqual({ kind: "stake" });
    expect(decideNext(withVault({ batches: [], available: 0n })).action).toEqual({ kind: "close" });
  });

  it("waits for the payout delay and says when", () => {
    const early = withVault({ batches: [{ key: KEY, queuedAt: T - 3599, cursor: 0, count: 1 }], available: 0n });
    expect(decideNext({ ...early, frontDoor: { ...base.frontDoor, canClose: false } })).toEqual({
      action: null,
      reason: `nothing due: next payout at ${new Date((T + 1) * 1000).toISOString().slice(11, 16)} UTC`,
    });
  });

  it("does not pay out or close while AlphaVault is unhealthy, but still stakes", () => {
    const sick = { ...base, alphaVault: { healthy: false } };
    expect(decideNext(sick).action).toEqual({ kind: "stake" });
    expect(decideNext({ ...sick, vault: { ...sick.vault, available: 0n } })).toEqual({
      action: null,
      reason: "AlphaVault is paused or migrating — not paying out or closing batches",
    });
  });

  it("does not close an empty batch", () => {
    const empty = { ...withVault({ batches: [], available: 0n }), frontDoor: { ...base.frontDoor, nDeposits: 0 } };
    expect(decideNext(empty)).toEqual({ action: null, reason: "nothing due: the open batch is empty" });
  });

  it("does not pay out or stake while the vault is paused", () => {
    const paused = withVault({ paused: true });
    expect(decideNext(paused).action).toEqual({ kind: "close" });
  });

  it("skips a finished batch", () => {
    expect(decideNext(withVault({ batches: [{ key: KEY, queuedAt: 0, cursor: 1, count: 1 }], available: 0n })).action).toEqual({ kind: "close" });
  });
});

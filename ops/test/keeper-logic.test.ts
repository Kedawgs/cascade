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
    // the test cadence: no max wait, the batch closes as soon as the front door allows
    frontDoor: { canClose: true, nDeposits: 1, nRedeems: 0, paused: false, openStart: T - 600, batchInterval: 600, full: false },
    closeMaxWaitS: 0,
    alphaVault: { healthy: true },
    vault: {
      paused: false,
      available: 10n ** 16n,
      minStakeWei: 2n * 10n ** 15n,
      rootStake: 0n,
      nominatorMinWei: 0n,
      batches: [{ key: KEY, queuedAt: T - 3600, cursor: 0, count: 1 }],
      payoutDelay: 3600,
    },
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

  it("waits to stake until the position would reach the nominator minimum", () => {
    const small = withVault({ batches: [], available: 10n ** 16n, rootStake: 0n, nominatorMinWei: 2n * 10n ** 16n });
    expect(decideNext(small).action).toEqual({ kind: "close" });
    expect(decideNext({ ...small, frontDoor: { ...base.frontDoor, nDeposits: 0 } })).toEqual({
      action: null,
      reason: "nothing due: 0.01 TAO of idle TAO waits until the stake would reach the 0.02 TAO nominator minimum",
    });
    expect(decideNext(withVault({ batches: [], available: 10n ** 16n, rootStake: 10n ** 16n, nominatorMinWei: 2n * 10n ** 16n })).action).toEqual({
      kind: "stake",
    });
  });

  it("skips a finished batch", () => {
    expect(decideNext(withVault({ batches: [{ key: KEY, queuedAt: 0, cursor: 1, count: 1 }], available: 0n })).action).toEqual({ kind: "close" });
  });
});

describe("the close rule", () => {
  const T = 1_800_000_000;
  const HOUR = 3600;
  const START = T - 2 * HOUR;
  const hhmm = (unix: number) => `${new Date(unix * 1000).toISOString().slice(11, 16)} UTC`;
  /** A launch batch the contract can close (its hour has passed), holding one deposit whose fees don't
   * cover the bridge fee yet. */
  const launch: State = {
    now: T,
    frontDoor: {
      canClose: true,
      nDeposits: 1,
      nRedeems: 0,
      paused: false,
      openStart: START,
      batchInterval: HOUR,
      full: false,
      closeEconomics: { feesUsdc: 310_000n, bridgeFeeUsdc: 1_420_000n },
    },
    closeMaxWaitS: 86_400,
    alphaVault: { healthy: true },
    vault: { paused: false, available: 0n, minStakeWei: 2n * 10n ** 15n, rootStake: 0n, nominatorMinWei: 0n, batches: [], payoutDelay: 86_400 },
  };
  const fd = (over: Partial<State["frontDoor"]>, s: State = launch): State => ({ ...s, frontDoor: { ...s.frontDoor, ...over } });
  const CLOSE = { action: { kind: "close" }, reason: "the open batch is ready to close" };

  it("test cadence (max wait 0): closes as soon as the contract allows", () => {
    const test: State = { ...fd({ batchInterval: 600, openStart: T - 600, closeEconomics: undefined }), closeMaxWaitS: 0 };
    expect(decideNext(test)).toEqual(CLOSE);
    // with the interval at 0 the batch may be seconds old on Base, while the keeper's `now`
    // (Bittensor's block time) trails Base's clock
    expect(decideNext(fd({ batchInterval: 0, openStart: T + 10 }, test))).toEqual(CLOSE);
    expect(decideNext(fd({ canClose: false }, test)).action).toBeNull();
  });

  it("a max wait no longer than the interval has passed once the batch can close", () => {
    // canClose and not full: the interval has passed on Base's clock, whatever `now` says
    expect(decideNext({ ...fd({ batchInterval: 600, openStart: T - 590, closeEconomics: undefined }), closeMaxWaitS: 600 })).toEqual(CLOSE);
    // an owner who raised the interval past the max wait: the batch closes as soon as it can
    expect(decideNext(fd({ batchInterval: 2 * 86_400, openStart: T - 2 * 86_400 + 5 }))).toEqual(CLOSE);
  });

  it("launch: a young batch whose fees don't cover the bridge fee waits, and says for what", () => {
    expect(decideNext(launch)).toEqual({
      action: null,
      reason: `nothing due: the open batch waits until ${hhmm(START + 86_400)} or until its fees cover the bridge fee ($0.31 of $1.42)`,
    });
    // fees not read: still no early close
    expect(decideNext(fd({ closeEconomics: undefined }))).toEqual({ action: null, reason: `nothing due: the open batch waits until ${hhmm(START + 86_400)}` });
  });

  it("launch: closes once its fees cover the bridge fee", () => {
    expect(decideNext(fd({ closeEconomics: { feesUsdc: 1_420_000n, bridgeFeeUsdc: 1_420_000n } }))).toEqual(CLOSE);
    expect(decideNext(fd({ closeEconomics: { feesUsdc: 1_419_999n, bridgeFeeUsdc: 1_420_000n } })).action).toBeNull();
  });

  it("launch: closes once the batch is 24 hours old, whatever its fees", () => {
    expect(decideNext({ ...launch, now: START + 86_400 })).toEqual(CLOSE);
    expect(decideNext({ ...launch, now: START + 86_399 }).action).toBeNull();
  });

  it("closes a full batch at once, whatever its age or fees", () => {
    expect(decideNext(fd({ full: true, openStart: T - 60 }))).toEqual(CLOSE);
    expect(decideNext(fd({ full: true, closeEconomics: null }))).toEqual(CLOSE);
  });

  it("never closes early when a price or fee could not be read, but still closes at 24 hours", () => {
    const unpriced = fd({ closeEconomics: null });
    expect(decideNext(unpriced)).toEqual({
      action: null,
      reason: `nothing due: the open batch waits until ${hhmm(START + 86_400)}: its fees or the bridge fee could not be priced, so it does not close early`,
    });
    expect(decideNext({ ...unpriced, now: START + 86_400 })).toEqual(CLOSE);
  });

  it("never closes an empty batch", () => {
    const covered = { feesUsdc: 10n ** 9n, bridgeFeeUsdc: 1n };
    const empty = { ...fd({ nDeposits: 0, closeEconomics: covered }), now: START + 7 * 86_400 };
    expect(decideNext(empty)).toEqual({ action: null, reason: "nothing due: the open batch is empty" });
    expect(decideNext({ ...empty, closeMaxWaitS: HOUR }).action).toBeNull();
  });

  it("names a waiting batch alongside the next payout", () => {
    const s: State = { ...launch, vault: { ...launch.vault, batches: [{ key: KEY, queuedAt: T - HOUR, cursor: 0, count: 1 }] } };
    expect(decideNext(s).reason).toBe(
      `nothing due: next payout at ${hhmm(T - HOUR + 86_400)}; the open batch waits until ${hhmm(START + 86_400)} or until its fees cover the bridge fee ($0.31 of $1.42)`,
    );
  });

  it("a held batch is not reported as blocked by a pause", () => {
    expect(decideNext(fd({ paused: true })).reason).toMatch(/^nothing due: the open batch waits until/);
    expect(decideNext({ ...launch, alphaVault: { healthy: false } }).reason).toMatch(/^nothing due: the open batch waits until/);
  });
});

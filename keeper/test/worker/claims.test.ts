import { reset } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { type Address, encodeFunctionData, type Hex, keccak256, parseEther, parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEEPER_CALLS_V32 } from "../../../ops/src/keeper/core/abi.ts";
import { encodeDeployment } from "../../../ops/src/keeper/core/deployment.ts";
import { type JournalRow, spentOf } from "../../../ops/src/keeper/core/journal.ts";
import { fromJson, toJson } from "../../../ops/src/keeper/core/memory.ts";
import { type Payout, payoutsHash } from "../../../ops/src/keeper/core/payouts.ts";
import { CLAIM_GAS_REQUIRED_MAX, claimGasLimit } from "../../../ops/src/keeper/core/rewards.ts";
import { REPLACE_AFTER_MS } from "../../../ops/src/keeper/core/round.ts";
import type { CallRequest } from "../../../ops/src/keeper/core/types.ts";
import { ADDR, deploymentFor, HK_STAKE, T, TAO, type World } from "../../../ops/test/keeper-v32-world.ts";
import type { KeeperEnv } from "../../src/config.ts";
import { chains, coordinator, KEY, keeperRun, ME, sleep, started, testEnv } from "./harness.ts";

// Task 51 through the Worker (the wiring task, 51w): a claim and an adoption go from a cron round; a stuck claim is
// cancelled, never sent again at a higher fee, the cancel passing Bittensor's spend cap (T51 re-review R1, which the
// Worker's replace wrapper must pass on); a claim's row, with its 57M gas limit (up to 64.9M, Bittensor's per-transaction ceiling), is proven, whether a hand
// run writes it over the control route or a cut-off run left it in the journal.

const quiet = { print: () => undefined };
const rows = async () => fromJson<JournalRow[]>(await coordinator().since({ sinceMs: 0 }));
const status = async () => fromJson<{ runs: { line: string }[] }>(await coordinator().status({ runs: 200 }));

/** A run's clock from `at` (ms): its waits move it, so a held send's 40 s for its receipt pass at once */
const clockFrom = (at: number) => {
  let t = at;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

/** The Worker with Bittensor's 24 h spend cap at `bittensor` (wei) */
const capped = (bittensor: bigint): KeeperEnv => ({ ...testEnv, DEPLOYMENT: encodeDeployment(deploymentFor({ keeper: ME, spendCap: { base: 10n ** 18n, bittensor } })) });

/** Nothing due but a claim: the batch can't close, no idle TAO, and 2 TAO of rewards wait on the stake hotkey (over 25
 * times a claim's 0.057 TAO) */
const claimDue = (w: World) => {
  w.door.canClose = false;
  w.vault.hotkeys[0].credits = 2n * TAO;
};

/** A payout batch due in the world, its list's logs and its queue (as ops' keeper-v32-claims.test.ts queue) */
function queue(w: World, key: Hex, list: Payout[], block: bigint) {
  list.forEach((p, i) => w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "Redeemed", args: { key, user: p.user, shares: p.shares, assets: p.assets }, block: block + BigInt(i) }));
  const total = list.reduce((x, p) => x + p.assets, 0n);
  w.logs.push({ chain: "bittensor", address: ADDR.vault, event: "PayoutBatchQueued", args: { key, sourceChain: 8453n, batchId: 7n, count: list.length, total, price: 10n ** 12n }, block: block + 50n });
  w.vault.batches[key.toLowerCase()] = { sourceChain: 8453n, frontDoor: ADDR.frontDoor, batchId: 7n, queuedAt: BigInt(T - 2 * 86_400), cursor: 0, count: list.length, chunk: 0, remaining: total, payoutsHash: payoutsHash(list) };
  w.vault.pending += total;
  w.vault.balance = total + 10n ** 15n;
}

/** The round after the stuck claim's watch is due its replacement (REPLACE_AFTER_MS after its receipt wait) */
const STUCK = REPLACE_AFTER_MS + 120_000;

beforeEach(async () => {
  await reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("Task 51's claims and adoption, from a Worker round", () => {
  it("a claim due goes from a cron round: claimRewards on the hotkey, with claimGasRequired plus the margin as its gas limit, written ahead and landed; the round after adopts a surplus", async () => {
    const c = chains((w) => {
      claimDue(w);
    });
    await started();
    const t0 = Date.now();
    const r = await keeperRun(testEnv, { ...quiet, ...clockFrom(t0) });
    expect(r.outcome, r.lines.join(" | ")).toBe("ran");
    expect(c.w.sends.map((x) => [x.fn, String(x.args[0]).slice(0, 4), x.gas])).toEqual([["claimRewards", "0x11", 57_000_000n]]);
    expect(r.lines).toContainEqual(expect.stringMatching(/^Rewards on hotkey 0x11111111…: a claim is due \(/));
    // Task 65: its gas used beside its limit, one line, kept in the runs table (pnpm ops keeper status)
    const runs = (await status()).runs.map((x) => x.line);
    expect(runs.filter((l) => l.startsWith("GAS USED: Bittensor: claim the vault's rewards on hotkey 0x11111111…: ") && l.includes(" of its 57,000,000 gas limit ("))).toHaveLength(1);
    expect((await rows()).map((x) => [x.request.functionName, x.status])).toEqual([["claimRewards", "landed"]]);
    // a claim's reads stay well inside the run's budget (KEEPER_SUBREQUEST_BUDGET 300): this first round reads Task 52's
    // scans from the start blocks too (the park events, both lanes' Sent: about 66 requests)
    expect(r.meter?.count ?? 0).toBeLessThan(220);
    // a surplus at least the chain's minimum, a STAKE_RAMP after the last adoption: adopted by the next round
    c.w.vault.surplusStakeRao = 5_000_000n;
    c.w.vault.lastAdoptAt = BigInt(T - 2 * 86_400);
    const a = await keeperRun(testEnv, { ...quiet, ...clockFrom(t0 + 120_000) });
    expect(a.outcome, a.lines.join(" | ")).toBe("ran");
    expect(c.w.sends.map((x) => x.fn)).toEqual(["claimRewards", "adoptStake"]);
  });

  it("a stuck claim at the cap is cancelled, not sent again at a higher fee: a 21,000-gas transfer of nothing to the keeper at its nonce, which passes the cap; once it lands, the chain's other sends resume", async () => {
    const c = chains((w) => {
      claimDue(w);
      w.fate = (x) => (x.fn === "claimRewards" ? "hold" : "mine");
    });
    await started();
    const t0 = Date.now();
    // a cap that fits a claim (0.0725 TAO a claim and a day need at 1 gwei, since Task 65's 2,000,000 reserve): the claim
    // goes, and stays in the pool
    const one = await keeperRun(capped(parseEther("0.075")), { ...quiet, ...clockFrom(t0) });
    expect(one.outcome, one.lines.join(" | ")).toBe("ran");
    expect(c.w.sends.map((x) => x.fn)).toEqual(["claimRewards"]);
    expect(fromJson<{ memory: { watching: unknown[] } }>(await coordinator().status()).memory.watching).toHaveLength(1);
    const claim = c.w.sends[0].hash;
    // then the cap is lowered under the pending claim's worst case (0.057 TAO): Bittensor is at its cap, and a payout due
    // waits on it
    queue(c.w, `0x${"ab".repeat(32)}`, [{ user: "0x00000000000000000000000000000000000a11ce" as Address, shares: TAO, assets: TAO }], 9_900n);
    const low = capped(parseEther("0.05"));
    const two = await keeperRun(low, { ...quiet, ...clockFrom(t0 + 120_000) });
    expect(c.w.sends).toHaveLength(1);
    expect(two.lines.some((l) => l.startsWith("SPEND CAP: Bittensor"))).toBe(true);
    // its watch is due a replacement: it is cancelled at its nonce, through the cap
    const three = await keeperRun(low, { ...quiet, ...clockFrom(t0 + STUCK) });
    expect(three.lines).toContainEqual(expect.stringMatching(/^CANCELLING transaction 0x[0-9a-f]{64} \(claiming the rewards on hotkey 0x11111111…, nonce 5\): .*a claim is never sent again at a higher fee/));
    expect(three.lines).toContainEqual(expect.stringMatching(/^Replaced: claiming the rewards on hotkey 0x11111111… was cancelled at nonce 5 \(transaction 0x[0-9a-f]{64}\); the next round decides again$/));
    expect(c.w.sends.map((x) => [x.fn, x.to.toLowerCase(), x.value, x.gas])).toEqual([
      ["claimRewards", ADDR.vault.toLowerCase(), 0n, 57_000_000n],
      ["transfer", ME.toLowerCase(), 0n, 21_000n],
    ]);
    const [row] = await rows();
    const cancel = parseTransaction(row.raw);
    // at the claim's own nonce, 12.5% over its 1 gwei (the least a node takes as a replacement); the row counted at it
    expect([row.nonce, cancel.nonce, cancel.gasPrice, row.status, row.hashes[0]]).toEqual([5, 5, 1_125_000_000n, "cancelled", claim]);
    expect(spentOf(row)).toBe(200_000n * 10n ** 9n);
    // the cancel landed: the sum is back under the cap, and the payout goes
    const four = await keeperRun(low, { ...quiet, ...clockFrom(t0 + STUCK + 120_000) });
    expect(four.outcome, four.lines.join(" | ")).toBe("ran");
    expect(c.w.sends.map((x) => x.fn)).toEqual(["claimRewards", "transfer", "processPayouts"]);
  });

  it("with room under the cap a stuck claim is cancelled too, never sent again at a higher fee; a stuck cancel is cancelled again, 12.5% over the first", async () => {
    const c = chains((w) => {
      claimDue(w);
      w.fate = () => "hold";
    });
    await started();
    const t0 = Date.now();
    await keeperRun(testEnv, { ...quiet, ...clockFrom(t0) });
    const r = await keeperRun(testEnv, { ...quiet, ...clockFrom(t0 + STUCK) });
    // the cancel waits in the pool in its turn: watched with the claim, and replaced (again by a cancel) twice as late
    const s = await keeperRun(testEnv, { ...quiet, ...clockFrom(t0 + STUCK + 2 * REPLACE_AFTER_MS + 120_000) });
    expect([...r.lines, ...s.lines].filter((l) => l.startsWith("REPLACING"))).toEqual([]);
    expect(c.w.sends.map((x) => [x.fn, x.gas])).toEqual([
      ["claimRewards", 57_000_000n],
      ["transfer", 21_000n],
      ["transfer", 21_000n],
    ]);
    const [row] = await rows();
    expect([row.hashes.length, row.status, parseTransaction(row.raw).gasPrice]).toEqual([3, "sent", 1_265_625_000n]);
  });

  it("a claim cut off after its broadcast (its 57M gas limit) is watched by the next run, never refused or dropped; it lands, and the next run records it", async () => {
    const c = chains((w) => {
      claimDue(w);
      w.fate = () => "hold";
    });
    await started();
    let cut = true;
    c.hold.when = (f) => cut && f.method === "eth_getTransactionReceipt";
    void keeperRun(testEnv, { ...quiet, leaseMs: 1_000 });
    for (let i = 0; i < 300 && (await rows())[0]?.status !== "sent"; i++) await sleep(10);
    expect((await rows()).map((x) => [x.request.functionName, x.status])).toEqual([["claimRewards", "sent"]]);
    cut = false;
    await sleep(1_100);
    const t0 = Date.now() + 120_000;
    const next = await keeperRun(testEnv, { ...quiet, ...clockFrom(t0) });
    expect(next.lines.some((l) => l.startsWith("JOURNAL ROW REFUSED"))).toBe(false);
    expect(next.lines).toContainEqual(expect.stringMatching(/^Settling: claim the vault's rewards on hotkey 0x11111111… \(nonce 5, transaction 0x[0-9a-f]{64}\) has no saved watch .*it is watched from now/));
    expect((await rows())[0].status).toBe("sent");
    // it lands: the run after records it, and nothing more is sent
    c.mine(c.w.sends[0].hash);
    const after = await keeperRun(testEnv, { ...quiet, ...clockFrom(t0 + 120_000) });
    expect(after.lines.some((l) => l.startsWith("Late receipt: claim the vault's rewards on hotkey 0x11111111… went through"))).toBe(true);
    expect((await rows()).map((x) => x.status)).toEqual(["landed"]);
    expect(c.w.sends).toHaveLength(1);
  });
});

describe("a hand run's claim row at the control route", () => {
  const call = (path: string, body: unknown) =>
    exports.default.fetch(`https://keeper.test${path}`, { method: "POST", headers: { authorization: `Bearer ${testEnv.TEST_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = async (r: Response) => fromJson<Record<string, unknown>>(await r.text());
  /** A claim on the stake hotkey at nonce 5, with `gas` as its gas limit, signed by the keeper (Bittensor's legacy fees) */
  async function claimRow(gas: bigint) {
    const req: CallRequest = { chain: "bittensor", nonce: 5, label: "claim the vault's rewards on hotkey 0x11111111…", to: ADDR.vault, abi: KEEPER_CALLS_V32, functionName: "claimRewards", args: [HK_STAKE], gasLimit: gas, replaceBy: "cancel", maxFeeCap: 10n ** 9n };
    const data = encodeFunctionData({ abi: req.abi, functionName: req.functionName, args: req.args } as never);
    const raw = await privateKeyToAccount(KEY).signTransaction({ type: "legacy", chainId: 964, nonce: 5, to: ADDR.vault, value: 0n, data, gas, gasPrice: 10n ** 9n });
    const row: JournalRow = { chain: "bittensor", from: ME, nonce: 5, hashes: [keccak256(raw)], request: req, raw, status: "signed", at: Date.now() };
    return row;
  }

  it("a hand claim's row is written: 57M gas, and the highest a claim is ever sent with, claimGasRequired's bound plus the margin held to Bittensor's per-transaction ceiling (64.9M); above that it is refused", async () => {
    chains();
    const l = await json(await call("/v1/lease", { action: "acquire", holder: "hand:pc:1" }));
    const lease = { holder: "hand:pc:1", token: l.token as number };
    const highest = claimGasLimit(CLAIM_GAS_REQUIRED_MAX);
    expect(highest).toBe(64_900_000n);
    for (const gas of [57_000_000n, highest]) {
      const r = await json(await call("/v1/journal", { action: "writeAhead", ...lease, row: toJson(await claimRow(gas)) }));
      expect(r, `a ${gas} gas claim`).toMatchObject({ ok: true });
    }
    const over = await call("/v1/journal", { action: "writeAhead", ...lease, row: toJson(await claimRow(highest + 1n)) });
    expect(over.status).toBe(400);
    expect(String((await json(over)).error)).toContain(`its gas limit ${highest + 1n} is above ${highest}`);
    expect((await rows()).map((x) => parseTransaction(x.raw).gas)).toEqual([57_000_000n, highest]);
  });
});

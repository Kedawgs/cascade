import { type Address, type Hex, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { WALLET } from "../src/config.ts";
import type { KeeperState } from "../src/keeper/actions.ts";
import type { PayoutLog } from "../src/keeper/payouts.ts";
import { KEEPER_READ_ABIS } from "../src/keeper/state.ts";
import { buildPlan, buildPlanV3 } from "../src/plan.ts";
import type { DeploymentRecord } from "../src/record.ts";
import { type Ctx, SendRefused } from "../src/send.ts";
import type { CallRequest } from "../src/types.ts";
import { ethSweepValue, sweep, sweepDestinations, sweepLegs, taoSweepValue, windDown, windDownBlockers } from "../src/winddown.ts";
import { COLDKEY, fakeChain, SENT, stubDeps, v3Record } from "./fake-keeper.ts";
import { ROLES } from "./launch-roles.ts";

const KEY = `0x${"aa".repeat(32)}` as const;
const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("wind-down", () => {
  const idle = {
    frontDoor: { nDeposits: 0, nRedeems: 0 },
    batches: [] as { key: `0x${string}`; cursor: number; count: number }[],
    claimable: [{ user: WALLET, amount: 0n }],
    inFlight: [] as { id: Hex; state: string }[],
  };

  it("lets a fully paid-out test wind down", () => {
    expect(windDownBlockers(idle)).toEqual([]);
  });

  it("refuses while a payout is queued, and lists what is outstanding", () => {
    const busy = { ...idle, batches: [{ key: KEY, cursor: 0, count: 1 }], claimable: [{ user: WALLET, amount: 5n * 10n ** 15n }] };
    const b = windDownBlockers(busy);
    expect(b).toHaveLength(2);
    expect(b[0]).toMatch(/payout batch 0xaaaaaaaa/);
    expect(b[1]).toMatch(/0\.005 TAO is still claimable/);
  });

  it("refuses while the open batch has entries", () => {
    expect(windDownBlockers({ ...idle, frontDoor: { nDeposits: 1, nRedeems: 0 } })[0]).toMatch(/open batch/);
  });

  /** A front door with nothing left to finish, open, with a deposit cap. */
  const quiet = (): KeeperState =>
    ({
      frontDoor: { nDeposits: 0, nRedeems: 0, paused: false },
      vault: { batches: [] },
      detail: { claimable: [{ user: WALLET, amount: 0n }], depositCap: 10n ** 21n },
    }) as unknown as KeeperState;

  it("sets the cap to 0 and keeps the front door's minimum deposit as it is now, not the plan's", async () => {
    const v2: DeploymentRecord = { ...v3Record(), plan: buildPlan(0, 0, `0x${"11".repeat(32)}`) };
    // the owner raised v3's minimum from 0.04 to 0.07 TAO since the deploy; v2's is still 0.01
    for (const [rec, minDeposit] of [
      [v3Record(), 7n * 10n ** 16n],
      [v2, 10n ** 16n],
    ] as const) {
      const sent: CallRequest[] = [];
      const deps = stubDeps({
        readState: async () => quiet(),
        payoutLogs: async () => [],
        readMinDeposit: async () => minDeposit,
        sendCall: async (req) => (sent.push(req), SENT),
      });
      await windDown(deps, rec);
      expect(sent.map((r) => r.functionName)).toEqual(["pause", "setCaps"]);
      expect(sent[1].args).toEqual([minDeposit, 0n]);
    }
  });

  it("refuses while a payout's bridge message to Base hasn't arrived, since its TAO isn't claimable yet", async () => {
    const at = "";
    const [A, B, C]: Hex[] = [`0x${"a1".repeat(32)}`, `0x${"b2".repeat(32)}`, `0x${"c3".repeat(32)}`];
    const rec: DeploymentRecord = {
      ...v3Record(),
      messages: [
        { id: A, direction: "Bittensor → Base", hash: A, at },
        { id: B, direction: "Bittensor → Base", hash: B, at },
        { id: C, direction: "Base → Bittensor", hash: C, at },
      ],
    };
    const run = (states: Record<string, string>) => {
      const sent: CallRequest[] = [];
      const asked: Hex[] = [];
      const deps = stubDeps({
        readState: async () => quiet(),
        payoutLogs: async () => [],
        readMinDeposit: async () => 4n * 10n ** 16n,
        messageState: async (m) => (asked.push(m.id), states[m.id]),
        sendCall: async (req) => (sent.push(req), SENT),
      });
      return { done: windDown(deps, rec), sent, asked };
    };
    // B was sent by processPayouts and is still on its way; C, a close's, carries nothing to claim on Base
    const flying = run({ [A]: "SUCCESS", [B]: "IN_PROGRESS", [C]: "UNTOUCHED" });
    const err = await flying.done.catch((e) => e);
    expect(err.message).toMatch(new RegExp(`the payout's bridge message ${B} to Base is IN_PROGRESS`));
    expect(err.message).not.toContain(C);
    expect(flying.sent).toEqual([]);
    expect(flying.asked).toEqual([A, B]);
    expect(windDownBlockers({ ...idle, inFlight: [{ id: B, state: "FAILURE" }] })).toEqual([
      `the payout's bridge message ${B} to Base is FAILURE, not delivered yet: its TAO can't be claimed until it is (pnpm ops track ${B})`,
    ]);
    const arrived = run({ [A]: "SUCCESS", [B]: "SUCCESS" });
    await arrived.done;
    expect(arrived.sent.map((r) => r.functionName)).toEqual(["pause", "setCaps"]);
  });

  it("checks every account the vault paid out to, not only the ones named with --user", async () => {
    const bob: Address = "0x000000000000000000000000000000000000b0b0";
    const carol: Address = "0x000000000000000000000000000000000000ca01";
    const paid = (kind: PayoutLog["kind"], user: Address, blockNumber: bigint): PayoutLog => ({ kind, key: KEY, user, shares: 0n, assets: 1n, blockNumber, logIndex: 0 });
    const logs = [paid("redeemed", bob, 5n), paid("bounced", carol, 6n), paid("redeemed", WALLET, 7n), paid("redeemed", bob, 8n)];
    const run = (owed: Record<string, bigint>) => {
      const sent: CallRequest[] = [];
      const asked: Address[] = [];
      const deps = stubDeps({
        readState: async () => quiet(),
        payoutLogs: async () => logs,
        readClaimable: async (user) => (asked.push(user), owed[user] ?? 0n),
        readMinDeposit: async () => 4n * 10n ** 16n,
        sendCall: async (req) => (sent.push(req), SENT),
      });
      return { done: windDown(deps, v3Record()), sent, asked };
    };
    // bob was never named, and still has TAO to claim or be delivered
    const owing = run({ [bob]: 5n * 10n ** 15n });
    await expect(owing.done).rejects.toThrow(new RegExp(`0\\.005 TAO is still claimable on Base for ${bob}`));
    expect(owing.sent).toEqual([]);
    // each account read once; the wallet's claim was already read with the state
    expect(owing.asked).toEqual([bob, carol]);
    const settled = run({});
    await settled.done;
    expect(settled.sent.map((r) => r.functionName)).toEqual(["pause", "setCaps"]);
  });
});

describe("sweep", () => {
  it("floors TAO to whole rao after gas and a 1e12-wei margin", () => {
    // 0.0123456789123 TAO − 30,000 × 5 gwei − 1e12 = 12,194,678,912,300,000 wei → floored to whole rao (1e9 wei)
    expect(taoSweepValue(12_345_678_912_300_000n, 30_000n, 5_000_000_000n)).toBe(12_194_678_000_000_000n);
    expect(taoSweepValue(10n ** 12n, 30_000n, 5_000_000_000n)).toBe(0n);
  });

  it("keeps three times the gas and an L1 allowance on Base", () => {
    expect(ethSweepValue(10n ** 15n, 26_250n, 6_000_000n)).toBe(10n ** 15n - 26_250n * 3n * 6_000_000n - 2n * 10n ** 13n);
    expect(ethSweepValue(10n ** 13n, 26_250n, 6_000_000n)).toBe(0n);
  });

  it("sweeps whichever legs still hold something, and only after the front door is paused", () => {
    expect(sweepLegs({ tao: 0n, eth: 5n, frontDoorPaused: true })).toEqual(["eth"]);
    expect(sweepLegs({ tao: 5n, eth: 5n, frontDoorPaused: true })).toEqual(["tao", "eth"]);
    expect(() => sweepLegs({ tao: 0n, eth: 0n, frontDoorPaused: true })).toThrow(/nothing left to sweep/);
    expect(() => sweepLegs({ tao: 5n, eth: 5n, frontDoorPaused: false })).toThrow(/wind-down first/);
  });

  it("refuses a non-checksummed Base address or a bad SS58", () => {
    expect(() => sweepDestinations("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", WALLET.toLowerCase())).toThrow(/checksummed/);
    expect(() => sweepDestinations("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQZ", WALLET)).toThrow(/checksum/);
    expect(sweepDestinations("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", WALLET)).toEqual({
      taoKey: "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
      ethTo: WALLET,
    });
  });

  /** A paused front door, 0.1 TAO left on Bittensor and no ETH on Base; the precompile transfer's
   * estimate is `estimate` gas. Returns the arguments of every cast send. */
  function swept(estimate: bigint) {
    const sends: string[][] = [];
    const f = fakeChain(Object.values(KEEPER_READ_ABIS), { paused: () => true }, {
      eth_getBalance: (chain) => (chain === "bittensor" ? numberToHex(10n ** 17n) : "0x0"),
      eth_gasPrice: () => numberToHex(10_000_000_000n),
      eth_chainId: (chain) => numberToHex(f.ctx.targets[chain].chainId),
      eth_getTransactionCount: () => "0x4",
      eth_estimateGas: () => numberToHex(estimate),
      eth_getTransactionReceipt: () => ({ status: "0x1", blockNumber: "0x10", gasUsed: "0x7530", effectiveGasPrice: "0x1", contractAddress: null, logs: [] }),
    });
    const ctx: Ctx = {
      ...f.ctx,
      pollMs: 1,
      runner: {
        run: async (_file, args) => {
          if (args[0] === "wallet") return { code: 0, stdout: WALLET, stderr: "" };
          sends.push(args);
          return { code: 0, stdout: `transactionHash 0x${"7e".repeat(32)}`, stderr: "" };
        },
      },
    };
    return { run: () => sweep(ctx, v3Record(), SS58, WALLET), sends };
  }
  const gasLimitOf = (args: string[]) => args[args.indexOf("--gas-limit") + 1];

  it("sends the TAO with the gas limit its value held back, and refuses an estimate above it", async () => {
    const ok = swept(30_000n);
    await ok.run();
    expect(ok.sends).toHaveLength(1);
    expect(gasLimitOf(ok.sends[0])).toBe("40000");
    // the value left room for 40,000 gas: a transfer that needs more would not fit beside it
    const over = swept(40_001n);
    const err = await over.run().catch((e) => e);
    expect(err).toBeInstanceOf(SendRefused);
    expect(err.message).toMatch(/needs 40,001 gas, more than the 40,000 it is sent with/);
    expect(over.sends).toEqual([]);
  });
});

describe("a launch record is not wound down or swept here", () => {
  const launch = v3Record("live", buildPlanV3(0, 0, COLDKEY, "launch", ROLES));

  it("wind-down refuses before reading anything: it acts as the test wallet, and a launch's contracts are its owners'", async () => {
    await expect(windDown(stubDeps({}), launch)).rejects.toThrow(
      /wind-down is for a test deployment: it pauses and caps as the test wallet, the owner only until a launch's hand-off.*pnpm ops pause.*nothing sent/,
    );
  });

  it("sweep refuses before reading anything", async () => {
    const f = fakeChain([], {});
    await expect(sweep(f.ctx, launch, "5FxSW9dM8DbAWUFtADJPX5Wb7DctrJHadkJ3TB1GpBGvxQH2", WALLET)).rejects.toThrow(
      /sweep is for a test deployment: it empties the test wallet.*nothing sent/,
    );
    expect(f.calls).toEqual([]);
  });
});


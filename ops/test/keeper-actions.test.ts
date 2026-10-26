import { encodeEventTopics, encodeAbiParameters, type Hex, parseAbi, parseAbiParameters } from "viem";
import { describe, expect, it, vi } from "vitest";
import { WALLET } from "../src/config.ts";
import { close, closeValue, type KeeperDeps, payouts, payoutsRequest, runLoop, stake } from "../src/keeper/actions.ts";
import type { State } from "../src/keeper/due.ts";
import { payoutsHash } from "../src/keeper/payouts.ts";
import { formatStatus, type StatusDetail } from "../src/keeper/status.ts";
import { buildPlan } from "../src/plan.ts";
import type { DeploymentRecord } from "../src/record.ts";
import { type Sent, SendRefused } from "../src/send.ts";
import type { CallRequest } from "../src/types.ts";
import { windDown } from "../src/winddown.ts";

const plan = buildPlan(0, 0, `0x${"44".repeat(32)}`);
const SENT = { hash: `0x${"cc".repeat(32)}` as Hex, block: 1, gasUsed: 1n, costWei: 1n };
/** A deployment with every step done and the read-back passed. */
const rec: DeploymentRecord = {
  target: "rehearsal",
  wallet: WALLET,
  createdAt: "",
  plan,
  done: Object.fromEntries(plan.steps.map((s) => [s.id, SENT])),
  verify: { ok: true, failures: [], checkedAt: "" },
};
const unverified: DeploymentRecord = { ...rec, verify: undefined };
const MESSAGE: Hex = `0x${"5a".repeat(32)}`;
const SENT_EVENT = parseAbi([
  "event Sent(bytes32 indexed messageId, uint64 destChain, address indexed sender, address indexed recipient, uint256 amount, uint256 fee, uint256 gasLimit)",
]);
const sentLog = {
  address: plan.addresses.baseAdapter,
  topics: encodeEventTopics({ abi: SENT_EVENT, args: { messageId: MESSAGE, sender: plan.addresses.frontDoor, recipient: plan.addresses.vault } }) as Hex[],
  data: encodeAbiParameters(parseAbiParameters("uint64, uint256, uint256, uint256"), [964n, 10n ** 16n, 1n, 1n]),
};
const KEY: Hex = `0x${"aa".repeat(32)}`;
const T = 1_800_000_000;

const detail: StatusDetail = {
  openDeposits: [{ user: WALLET, amount: 10n ** 16n }],
  openRedeems: [],
  canClose: true,
  depositCap: 15n * 10n ** 16n,
  vaultAssets: 2n * 10n ** 16n,
  rootStake: 10n ** 16n,
  pendingPayouts: 0n,
  batches: [{ key: KEY, queuedAt: T, cursor: 0, count: 1 }],
  payoutDelay: 3600,
  claimable: [{ user: WALLET, amount: 0n }],
  balances: { tao: 5n * 10n ** 16n, eth: 3n * 10n ** 15n },
  messages: [{ id: MESSAGE, direction: "Base → Bittensor", state: "IN_PROGRESS" }],
};

function state(over: Partial<State> = {}): State & { detail: StatusDetail } {
  return {
    now: T,
    frontDoor: { canClose: true, nDeposits: 1, nRedeems: 0, paused: false, openStart: T - 600, batchInterval: 600, full: false },
    closeMaxWaitS: 0,
    alphaVault: { healthy: true },
    vault: { paused: false, available: 0n, minStakeWei: 2n * 10n ** 15n, rootStake: 0n, nominatorMinWei: 2n * 10n ** 16n, batches: [], payoutDelay: 3600 },
    ...over,
    detail,
  };
}

function deps(
  s = state(),
  send = vi.fn(async (_req: CallRequest): Promise<Sent> => ({ hash: KEY, block: 1, gasUsed: 1n, costWei: 1n, logs: [sentLog] })),
): KeeperDeps & { send: typeof send; recorded: unknown[] } {
  const recorded: unknown[] = [];
  return {
    recorded,
    recordMessage: (m) => {
      recorded.push(m);
    },
    readState: async () => s,
    sendCall: send,
    nonce: async () => 4,
    quoteClose: async () => 619_000_000_000_000n,
    payoutLogs: async () => [],
    batchInfo: async () => ({ payoutsHash: payoutsHash([]), count: 0 }),
    // v2: no deliveries, and the rewards read is not part of these tests
    deliveryCandidates: async () => [],
    readDelivery: async () => {
      throw new Error("no deliveries in v2");
    },
    simulateDeliver: async () => {
      throw new Error("no deliveries in v2");
    },
    readRewards: async () => {
      throw new Error("not read in these tests");
    },
    log: () => undefined,
    send,
  };
}

describe("keeper actions", () => {
  it("close attaches three times the quote, at least 0.0015 ETH", async () => {
    expect(closeValue(619_000_000_000_000n)).toBe(1_857_000_000_000_000n);
    expect(closeValue(10n ** 14n)).toBe(1_500_000_000_000_000n);
    const d = deps();
    const done = await close(d, rec);
    expect(d.send).toHaveBeenCalledOnce();
    expect(done.messageId).toBe(MESSAGE);
    expect(d.recorded).toEqual([{ id: MESSAGE, direction: "Base → Bittensor", hash: KEY }]);
    expect(d.send.mock.calls[0][0]).toMatchObject({ chain: "base", to: plan.addresses.frontDoor, functionName: "closeBatch", value: 1_857_000_000_000_000n, nonce: 4 });
  });

  it("close, stake and payouts refuse before the deployment is complete and verified", async () => {
    const d = deps();
    await expect(close(d, unverified)).rejects.toThrow(/not complete and verified/);
    await expect(close(d, { ...rec, done: {} })).rejects.toThrow(/not complete and verified/);
    await expect(stake(d, unverified)).rejects.toThrow(/not complete and verified/);
    await expect(payouts(d, unverified, KEY)).rejects.toThrow(/not complete and verified/);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("wind-down skips what is already done, so it can be run again", async () => {
    const d = deps(state({ frontDoor: { canClose: false, nDeposits: 0, nRedeems: 0, paused: true, openStart: T, batchInterval: 600, full: false } }));
    await windDown(d, rec);
    expect(d.send.mock.calls.map((c) => c[0].functionName)).toEqual(["setCaps"]);
  });

  it("close refuses while AlphaVault is paused", async () => {
    const d = deps(state({ alphaVault: { healthy: false } }));
    await expect(close(d, rec)).rejects.toThrow(/AlphaVault/);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("payouts refuses a list whose hash does not match, and sends the full list otherwise", () => {
    const list = [{ user: WALLET, shares: 5n, assets: 10n ** 16n }];
    expect(() => payoutsRequest(rec, KEY, list, { payoutsHash: payoutsHash([]), count: 1 }, 4)).toThrow(/does not match/);
    expect(() => payoutsRequest(rec, KEY, list, { payoutsHash: payoutsHash(list), count: 2 }, 4)).toThrow(/does not match/);
    expect(payoutsRequest(rec, KEY, list, { payoutsHash: payoutsHash(list), count: 1 }, 4)).toMatchObject({
      chain: "bittensor",
      to: plan.addresses.vault,
      functionName: "processPayouts",
      args: [KEY, list, 100],
    });
  });

  it("run stops on a failed estimate", async () => {
    const lines: string[] = [];
    const send = vi.fn(async (_req: CallRequest): Promise<Sent> => {
      throw new SendRefused("estimate", "Bittensor: stake idle TAO would fail, nothing sent (NothingToStake())");
    });
    const d = { ...deps(state({ vault: { ...state().vault, available: 10n ** 16n } }), send), log: (l: string) => lines.push(l) };
    await runLoop(d, rec, { intervalMs: 0 });
    expect(send).toHaveBeenCalledOnce();
    expect(lines.at(-1)).toMatch(/^Stopped: .*nothing sent/);
  });

  it("formatStatus prints the open batch in TAO, when a payout is due and full message ids", () => {
    const text = formatStatus(detail, { now: T });
    expect(text.join("\n")).toContain(MESSAGE);
    expect(text.join("\n")).toContain("0.0100 TAO");
    expect(text.join("\n")).toContain(`${new Date((T + 3600) * 1000).toISOString().slice(11, 16)} UTC`);
  });
});

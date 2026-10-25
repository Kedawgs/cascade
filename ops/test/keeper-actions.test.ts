import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { WALLET } from "../src/config.ts";
import { close, closeValue, type KeeperDeps, payoutsRequest, runLoop } from "../src/keeper/actions.ts";
import type { State } from "../src/keeper/due.ts";
import { payoutsHash } from "../src/keeper/payouts.ts";
import { formatStatus, type StatusDetail } from "../src/keeper/status.ts";
import { buildPlan } from "../src/plan.ts";
import type { DeploymentRecord } from "../src/record.ts";
import { SendRefused } from "../src/send.ts";
import type { CallRequest } from "../src/types.ts";

const plan = buildPlan(0, 0, `0x${"44".repeat(32)}`);
const rec: DeploymentRecord = { target: "rehearsal", wallet: WALLET, createdAt: "", plan, done: {} };
const KEY: Hex = `0x${"aa".repeat(32)}`;
const T = 1_800_000_000;

const detail: StatusDetail = {
  openDeposits: [{ user: WALLET, amount: 10n ** 16n }],
  openRedeems: [],
  canClose: true,
  vaultAssets: 2n * 10n ** 16n,
  rootStake: 10n ** 16n,
  pendingPayouts: 0n,
  batches: [{ key: KEY, queuedAt: T, cursor: 0, count: 1 }],
  payoutDelay: 3600,
  claimable: [{ user: WALLET, amount: 0n }],
  balances: { tao: 5n * 10n ** 16n, eth: 3n * 10n ** 15n },
  messages: [],
};

function state(over: Partial<State> = {}): State & { detail: StatusDetail } {
  return {
    now: T,
    frontDoor: { canClose: true, nDeposits: 1, nRedeems: 0, paused: false },
    alphaVault: { healthy: true },
    vault: { paused: false, available: 0n, minStakeWei: 2n * 10n ** 15n, batches: [], payoutDelay: 3600 },
    ...over,
    detail,
  };
}

function deps(s = state(), send = vi.fn(async (_req: CallRequest) => ({ hash: KEY, block: 1, gasUsed: 1n, costWei: 1n }))): KeeperDeps & { send: typeof send } {
  return {
    readState: async () => s,
    sendCall: send,
    nonce: async () => 4,
    quoteClose: async () => 619_000_000_000_000n,
    payoutLogs: async () => [],
    batchInfo: async () => ({ payoutsHash: payoutsHash([]), count: 0 }),
    log: () => undefined,
    send,
  };
}

describe("keeper actions", () => {
  it("close attaches three times the quote, at least 0.0015 ETH", async () => {
    expect(closeValue(619_000_000_000_000n)).toBe(1_857_000_000_000_000n);
    expect(closeValue(10n ** 14n)).toBe(1_500_000_000_000_000n);
    const d = deps();
    await close(d, rec);
    expect(d.send).toHaveBeenCalledOnce();
    expect(d.send.mock.calls[0][0]).toMatchObject({ chain: "base", to: plan.addresses.frontDoor, functionName: "closeBatch", value: 1_857_000_000_000_000n, nonce: 4 });
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
    const send = vi.fn(async (_req: CallRequest): Promise<{ hash: Hex; block: number; gasUsed: bigint; costWei: bigint }> => {
      throw new SendRefused("estimate", "Bittensor: stake idle TAO would fail, nothing sent (NothingToStake())");
    });
    const d = { ...deps(state({ vault: { ...state().vault, available: 10n ** 16n } }), send), log: (l: string) => lines.push(l) };
    await runLoop(d, rec, { intervalMs: 0 });
    expect(send).toHaveBeenCalledOnce();
    expect(lines.at(-1)).toMatch(/^Stopped: .*nothing sent/);
  });

  it("formatStatus prints the open batch in TAO and when a payout is due", () => {
    const text = formatStatus(detail, { now: T });
    expect(text.join("\n")).toContain("0.0100 TAO");
    expect(text.join("\n")).toContain(`${new Date((T + 3600) * 1000).toISOString().slice(11, 16)} UTC`);
  });
});

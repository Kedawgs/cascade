import { type Address, formatEther, type Hex } from "viem";
import type { Entry } from "./batch.ts";

export interface StatusDetail {
  openDeposits: Entry[];
  openRedeems: Entry[];
  canClose: boolean;
  vaultAssets: bigint;
  rootStake: bigint;
  pendingPayouts: bigint;
  batches: { key: Hex; queuedAt: number; cursor: number; count: number }[];
  payoutDelay: number;
  claimable: { user: Address; amount: bigint }[];
  balances: { tao: bigint; eth: bigint };
  messages: { id: Hex; direction: string; state: string }[];
}

const amount = (wei: bigint, unit: string) => `${Number(formatEther(wei)).toFixed(4)} ${unit}`;
const hhmm = (unix: number) => `${new Date(unix * 1000).toISOString().slice(11, 16)} UTC`;

export function formatStatus(d: StatusDetail, opts: { now: number }): string[] {
  const total = d.openDeposits.reduce((s, e) => s + e.amount, 0n);
  const lines = [
    `Base front door: the open batch has ${d.openDeposits.length} deposit(s) totalling ${amount(total, "TAO")} and ${d.openRedeems.length} redeem request(s); ${d.canClose ? "it can close now" : "not ready to close yet"}`,
    `Bittensor vault: ${amount(d.vaultAssets, "TAO")} in total, ${amount(d.rootStake, "TAO")} staked, ${amount(d.pendingPayouts, "TAO")} queued for payouts`,
  ];
  for (const b of d.batches.filter((b) => b.cursor < b.count)) {
    const due = b.queuedAt + d.payoutDelay;
    lines.push(
      `Payout batch ${b.key.slice(0, 10)}…: ${b.count - b.cursor} of ${b.count} entries left, ${opts.now >= due ? "due now" : `due at ${hhmm(due)}`}`,
    );
  }
  for (const m of d.messages) lines.push(`Bridge message ${m.id.slice(0, 10)}… (${m.direction}): ${m.state}`);
  for (const c of d.claimable) lines.push(`Claimable on Base for ${c.user}: ${amount(c.amount, "TAO")}`);
  lines.push(`Test wallet: ${amount(d.balances.tao, "TAO")} on Bittensor, ${amount(d.balances.eth, "ETH")} on Base`);
  return lines;
}

import { formatEther, type Hex } from "viem";

export interface State {
  now: number;
  frontDoor: { canClose: boolean; nDeposits: number; nRedeems: number; paused: boolean };
  alphaVault: { healthy: boolean };
  vault: {
    paused: boolean;
    available: bigint;
    minStakeWei: bigint;
    /** Root stake already held, and the chain's nominator minimum for one position, in wei. */
    rootStake: bigint;
    nominatorMinWei: bigint;
    batches: { key: Hex; queuedAt: number; cursor: number; count: number }[];
    payoutDelay: number;
  };
}

export type Action = { kind: "payouts"; key: Hex } | { kind: "stake" } | { kind: "close" };

const hhmm = (unix: number) => `${new Date(unix * 1000).toISOString().slice(11, 16)} UTC`;

/** The next thing the keeper should do: a due payout, then staking, then closing the batch. */
export function decideNext(s: State): { action: Action | null; reason: string } {
  const open = s.vault.batches.filter((b) => b.cursor < b.count);
  const due = open.filter((b) => s.now >= b.queuedAt + s.vault.payoutDelay);
  const closable = s.frontDoor.canClose && s.frontDoor.nDeposits + s.frontDoor.nRedeems > 0;

  if (due.length && !s.vault.paused && s.alphaVault.healthy) {
    return { action: { kind: "payouts", key: due[0].key }, reason: "a payout batch is past its delay" };
  }
  const stakeable = s.vault.available >= s.vault.minStakeWei;
  const bigEnough = s.vault.rootStake + s.vault.available >= s.vault.nominatorMinWei;
  if (stakeable && bigEnough && !s.vault.paused) {
    return { action: { kind: "stake" }, reason: "the vault holds idle TAO above the staking floor" };
  }
  if (closable && !s.frontDoor.paused && s.alphaVault.healthy) {
    return { action: { kind: "close" }, reason: "the open batch is ready to close" };
  }

  if (!s.alphaVault.healthy && (due.length || closable)) {
    return { action: null, reason: "AlphaVault is paused or migrating — not paying out or closing batches" };
  }
  if (s.vault.paused && due.length) return { action: null, reason: "the vault is paused — not paying out" };
  if (s.frontDoor.paused && closable) return { action: null, reason: "the front door is paused — not closing the batch" };
  if (open.length) {
    const next = Math.min(...open.map((b) => b.queuedAt + s.vault.payoutDelay));
    return { action: null, reason: `nothing due: next payout at ${hhmm(next)}` };
  }
  if (stakeable && !bigEnough) {
    return {
      action: null,
      reason: `nothing due: ${formatEther(s.vault.available)} TAO of idle TAO waits until the stake would reach the ${formatEther(s.vault.nominatorMinWei)} TAO nominator minimum`,
    };
  }
  if (s.frontDoor.canClose) return { action: null, reason: "nothing due: the open batch is empty" };
  return { action: null, reason: "nothing due: the open batch is not ready to close yet" };
}

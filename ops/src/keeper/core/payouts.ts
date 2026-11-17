import { type Address, encodeAbiParameters, type Hex, keccak256, parseAbiParameters } from "viem";

export interface Payout {
  user: Address;
  shares: bigint;
  assets: bigint;
}

export interface PayoutLog extends Payout {
  kind: "bounced" | "redeemed";
  key: Hex;
  blockNumber: bigint;
  logIndex: number;
}

const byLogOrder = (a: PayoutLog, b: PayoutLog) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1;

/** A payout batch's full list as the vault queued it: its DepositBounced entries (0 shares) first,
 * then its Redeemed entries, each in log order (CascadeVault.onBridgeMessage: _creditDeposits, then
 * _burnRedeems). After the owner's cancel (v3.2's PayoutBatchCancelled, `cancel`), the batch's list is
 * the bounces it carried forward: the last `bouncesCarried` of its DepositBounced entries, in log order
 * (spec §3.10.15: the cancel re-mints the redeems left and carries the bounces left, which are the last
 * ones whenever the cursor stood inside the bounces), and none when it carried none. */
export function rebuildPayouts(logs: readonly PayoutLog[], key: Hex, cancel?: { bouncesCarried: number }): Payout[] {
  const mine = logs.filter((l) => l.key.toLowerCase() === key.toLowerCase());
  const pick = (kind: PayoutLog["kind"]) =>
    mine
      .filter((l) => l.kind === kind)
      .sort(byLogOrder)
      .map(({ user, shares, assets }) => ({ user, shares: kind === "bounced" ? 0n : shares, assets }));
  const bounced = pick("bounced");
  if (cancel) return cancel.bouncesCarried === 0 ? [] : bounced.slice(-cancel.bouncesCarried);
  return [...bounced, ...pick("redeemed")];
}

const STEP = parseAbiParameters("bytes32, address, uint256, uint256");

/** The vault's running hash: h = keccak256(abi.encode(h, user, shares, assets)) from h = 0 (CascadeVault._queuePayout,
 * checked by CascadePayoutLib.prepare, via CascadePayoutMath.verify). */
export const payoutsHash = (list: readonly Payout[]): Hex =>
  list.reduce<Hex>((h, p) => keccak256(encodeAbiParameters(STEP, [h, p.user, p.shares, p.assets])), `0x${"00".repeat(32)}`);

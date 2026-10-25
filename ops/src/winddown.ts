import { type Address, formatEther, type Hex, isAddress, parseAbi } from "viem";
import { PRECOMPILE, SETTINGS, WALLET } from "./config.ts";
import type { KeeperDeps } from "./keeper/actions.ts";
import type { DeploymentRecord } from "./record.ts";
import { balanceOf, gasPriceOf, nonceOf } from "./rpc.ts";
import { type Ctx, chainLabel, type Sent, sendCall, sendValue } from "./send.ts";
import { decodeSs58 } from "./ss58.ts";

const ABI = parseAbi([
  "function pause()",
  "function setCaps(uint256 minDeposit_, uint256 depositCap_)",
  "function transfer(bytes32 data) payable",
]);

/** What still has to finish before the front door can be paused for good. */
export function windDownBlockers(s: {
  frontDoor: { nDeposits: number; nRedeems: number };
  batches: { key: Hex; cursor: number; count: number }[];
  claimable: { user: Address; amount: bigint }[];
}): string[] {
  const out: string[] = [];
  if (s.frontDoor.nDeposits + s.frontDoor.nRedeems > 0) {
    out.push(`the open batch still has ${s.frontDoor.nDeposits} deposit(s) and ${s.frontDoor.nRedeems} redeem request(s)`);
  }
  for (const b of s.batches.filter((b) => b.cursor < b.count)) {
    out.push(`payout batch ${b.key.slice(0, 10)}… has ${b.count - b.cursor} entries left to pay out`);
  }
  for (const c of s.claimable.filter((c) => c.amount > 0n)) {
    out.push(`${formatEther(c.amount)} TAO is still claimable on Base for ${c.user}`);
  }
  return out;
}

/** Pauses the front door and sets its cap to 0, once everything is paid out and claimed. */
export async function windDown(deps: KeeperDeps, rec: DeploymentRecord): Promise<Sent[]> {
  const s = await deps.readState();
  const blockers = windDownBlockers({ frontDoor: s.frontDoor, batches: s.vault.batches, claimable: s.detail.claimable });
  if (blockers.length) throw new Error(`not yet — finish these first:\n  ${blockers.join("\n  ")}`);
  const fd = rec.plan.addresses.frontDoor;
  const base = { chain: "base" as const, to: fd, abi: ABI };
  return [
    await deps.sendCall({ ...base, nonce: await deps.nonce("base"), label: "pause the front door", functionName: "pause", args: [] }),
    await deps.sendCall({
      ...base,
      nonce: await deps.nonce("base"),
      label: "set the front door's deposit cap to 0",
      functionName: "setCaps",
      args: [SETTINGS.minDeposit, 0n],
    }),
  ];
}

const floorRao = (wei: bigint) => (wei / 10n ** 9n) * 10n ** 9n;
const pos = (x: bigint) => (x > 0n ? x : 0n);

/** The TAO left to send home: balance less gas and a 1e12-wei margin, in whole rao. */
export const taoSweepValue = (balance: bigint, gasLimit: bigint, gasPrice: bigint) =>
  floorRao(pos(balance - gasLimit * gasPrice - 10n ** 12n));

/** The ETH left to send home on Base: balance less three times the gas and an L1-fee allowance. */
export const ethSweepValue = (balance: bigint, gasLimit: bigint, gasPrice: bigint) =>
  pos(balance - gasLimit * 3n * gasPrice - 2n * 10n ** 13n);

export function sweepDestinations(taoTo: string, ethTo: string): { taoKey: Hex; ethTo: Address } {
  if (!isAddress(ethTo, { strict: true }) || ethTo === ethTo.toLowerCase()) {
    throw new Error(`${ethTo} is not a checksummed Base address: copy it exactly from your wallet`);
  }
  return { taoKey: decodeSs58(taoTo), ethTo };
}

/** Sends the test wallet's leftover TAO (through the transfer precompile) and ETH home. */
export async function sweep(ctx: Ctx, taoTo: string, ethToRaw: string): Promise<void> {
  const { taoKey, ethTo } = sweepDestinations(taoTo, ethToRaw);
  ctx.log(`Sending leftovers: TAO to Bittensor ${taoTo}, ETH to Base ${ethTo}`);
  const taoLimit = 40_000n;
  const tao = taoSweepValue(await balanceOf(ctx.rpc, "bittensor", WALLET), taoLimit, await gasPriceOf(ctx.rpc, "bittensor"));
  if (tao === 0n) throw new Error(`${chainLabel("bittensor")}: nothing to sweep`);
  await sendCall(ctx, {
    chain: "bittensor",
    nonce: await nonceOf(ctx.rpc, "bittensor", WALLET),
    label: `send ${formatEther(tao)} TAO home`,
    to: PRECOMPILE.balanceTransfer,
    abi: ABI,
    functionName: "transfer",
    args: [taoKey],
    value: tao,
  });
  const eth = ethSweepValue(await balanceOf(ctx.rpc, "base", WALLET), 26_250n, await gasPriceOf(ctx.rpc, "base"));
  if (eth === 0n) throw new Error(`${chainLabel("base")}: nothing to sweep`);
  await sendValue(ctx, { chain: "base", nonce: await nonceOf(ctx.rpc, "base", WALLET), label: `send ${formatEther(eth)} ETH home`, to: ethTo, value: eth });
}

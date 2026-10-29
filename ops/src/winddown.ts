import { type Address, formatEther, type Hex, isAddress, parseAbi } from "viem";
import { read } from "./rpc.ts";
import { PRECOMPILE, WALLET } from "./config.ts";
import type { KeeperDeps } from "./keeper/actions.ts";
import { uniqueUsers } from "./keeper/delivery.ts";
import { cadenceOf } from "./plan.ts";
import type { DeploymentRecord } from "./record.ts";
import { balanceOf, gasPriceOf, nonceOf } from "./rpc.ts";
import { type Ctx, type Sent, sendCall, sendValue } from "./send.ts";
import { decodeSs58 } from "./ss58.ts";

const ABI = parseAbi([
  "function pause()",
  "function setCaps(uint256 minDeposit_, uint256 depositCap_)",
  "function transfer(bytes32 data) payable",
  "function paused() view returns (bool)",
]);

/** What still has to finish before the front door can be paused for good. `inFlight`: payouts' bridge
 * messages to Base not yet delivered there. */
export function windDownBlockers(s: {
  frontDoor: { nDeposits: number; nRedeems: number };
  batches: { key: Hex; cursor: number; count: number }[];
  claimable: { user: Address; amount: bigint }[];
  inFlight: { id: Hex; state: string }[];
}): string[] {
  const out: string[] = [];
  if (s.frontDoor.nDeposits + s.frontDoor.nRedeems > 0) {
    out.push(`the open batch still has ${s.frontDoor.nDeposits} deposit(s) and ${s.frontDoor.nRedeems} redeem request(s)`);
  }
  for (const b of s.batches.filter((b) => b.cursor < b.count)) {
    out.push(`payout batch ${b.key.slice(0, 10)}… has ${b.count - b.cursor} entries left to pay out`);
  }
  for (const m of s.inFlight) {
    out.push(`the payout's bridge message ${m.id} to Base is ${m.state}, not delivered yet: its TAO can't be claimed until it is (pnpm ops track ${m.id})`);
  }
  for (const c of s.claimable.filter((c) => c.amount > 0n)) {
    out.push(`${formatEther(c.amount)} TAO is still claimable on Base for ${c.user}`);
  }
  return out;
}

/** The record's payout messages (Bittensor → Base, sent by processPayouts) not yet at SUCCESS on Base:
 * their TAO is not claimable until they are, so no claim check can see it. */
async function payoutsInFlight(deps: KeeperDeps, rec: DeploymentRecord): Promise<{ id: Hex; state: string }[]> {
  const out = [];
  for (const m of (rec.messages ?? []).filter((m) => m.direction === "Bittensor → Base")) {
    const state = await deps.messageState(m);
    if (state !== "SUCCESS") out.push({ id: m.id, state });
  }
  return out;
}

/** The named accounts' claims (the wallet and --user), with every other account the vault has paid out
 * to (its DepositBounced and Redeemed events): the front door credits claimable TAO only from those
 * payouts, so this is everyone who can still hold some. */
async function everyClaim(deps: KeeperDeps, named: readonly { user: Address; amount: bigint }[]) {
  const out = [...named];
  const seen = new Set(named.map((c) => c.user.toLowerCase()));
  for (const user of uniqueUsers((await deps.payoutLogs()).map((l) => l.user))) {
    if (!seen.has(user.toLowerCase())) out.push({ user, amount: await deps.readClaimable(user) });
  }
  return out;
}

/** Pauses the front door and sets its cap to 0, keeping its minimum deposit, once everything is paid
 * out, delivered to Base and claimed by everyone the vault paid out to. Skips whichever is already done,
 * so it can be run again after a stop. */
export async function windDown(deps: KeeperDeps, rec: DeploymentRecord): Promise<Sent[]> {
  if (cadenceOf(rec.plan) === "launch") {
    throw new Error(
      "wind-down is for a test deployment: it pauses and caps as the test wallet, the owner only until a launch's hand-off. A launch's contracts are its final owners': pause with pnpm ops pause, and change the caps through the owner's Safe or timelock; nothing sent",
    );
  }
  const s = await deps.readState();
  const claimable = await everyClaim(deps, s.detail.claimable);
  const inFlight = await payoutsInFlight(deps, rec);
  const blockers = windDownBlockers({ frontDoor: s.frontDoor, batches: s.vault.batches, claimable, inFlight });
  if (blockers.length) throw new Error(`not yet — finish these first:\n  ${blockers.join("\n  ")}`);
  const fd = rec.plan.addresses.frontDoor;
  const base = { chain: "base" as const, to: fd, abi: ABI };
  const out: Sent[] = [];
  if (!s.frontDoor.paused) {
    out.push(await deps.sendCall({ ...base, nonce: await deps.nonce("base"), label: "pause the front door", functionName: "pause", args: [] }));
  }
  if (s.detail.depositCap !== 0n) {
    out.push(
      await deps.sendCall({
        ...base,
        nonce: await deps.nonce("base"),
        label: "set the front door's deposit cap to 0",
        functionName: "setCaps",
        // setCaps sets both: the minimum deposit stays as it is now (the plan's, or the owner's since)
        args: [await deps.readMinDeposit(), 0n],
      }),
    );
  }
  return out;
}

/** Which leftovers to send: each non-empty one, and only once the front door is paused (the owner and
 * keeper need gas until then). */
export function sweepLegs(s: { tao: bigint; eth: bigint; frontDoorPaused: boolean }): ("tao" | "eth")[] {
  if (!s.frontDoorPaused) throw new Error("the front door is not paused yet: run wind-down first");
  const legs = [...(s.tao > 0n ? (["tao"] as const) : []), ...(s.eth > 0n ? (["eth"] as const) : [])];
  if (!legs.length) throw new Error("nothing left to sweep: both balances are already home");
  return legs;
}

/** The gas limit the TAO leg is sent with, and held back from its value. */
const TAO_SWEEP_GAS = 40_000n;

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

/** Sends the test wallet's leftover TAO (through the transfer precompile) and ETH home; a leg already
 * swept is skipped, so it can be run again after a stop. */
export async function sweep(ctx: Ctx, rec: DeploymentRecord, taoTo: string, ethToRaw: string): Promise<void> {
  if (cadenceOf(rec.plan) === "launch") {
    throw new Error(
      "sweep is for a test deployment: it empties the test wallet after a test's wind-down, and a launch's test wallet is its deployer and perhaps its keeper, still paying gas. Move its funds by hand; nothing sent",
    );
  }
  const { taoKey, ethTo } = sweepDestinations(taoTo, ethToRaw);
  const tao = taoSweepValue(await balanceOf(ctx.rpc, "bittensor", WALLET), TAO_SWEEP_GAS, await gasPriceOf(ctx.rpc, "bittensor"));
  const eth = ethSweepValue(await balanceOf(ctx.rpc, "base", WALLET), 26_250n, await gasPriceOf(ctx.rpc, "base"));
  const paused = (await read(ctx.rpc, "base", { address: rec.plan.addresses.frontDoor, abi: ABI, functionName: "paused" })) as boolean;
  const legs = sweepLegs({ tao, eth, frontDoorPaused: paused });
  ctx.log(`Sending leftovers: TAO to Bittensor ${taoTo}, ETH to Base ${ethTo}`);
  if (legs.includes("tao")) {
    await sendCall(ctx, {
    chain: "bittensor",
    nonce: await nonceOf(ctx.rpc, "bittensor", WALLET),
    label: `send ${formatEther(tao)} TAO home`,
    to: PRECOMPILE.balanceTransfer,
    abi: ABI,
    functionName: "transfer",
    args: [taoKey],
    value: tao,
    // the limit the value left room for: a transfer whose estimate is above it is refused, not sent short
    gasLimit: TAO_SWEEP_GAS,
    });
  }
  if (legs.includes("eth")) {
    await sendValue(ctx, { chain: "base", nonce: await nonceOf(ctx.rpc, "base", WALLET), label: `send ${formatEther(eth)} ETH home`, to: ethTo, value: eth });
  }
}

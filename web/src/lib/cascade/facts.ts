import { type Address, type Hex, parseEventLogs } from "viem";
import { ADAPTER, ERC20, FRONT_DOOR, OFFRAMP_ABI, VAULT } from "./abi";
import type { Clients } from "./chain";
import { type Deployment, explorer, OFFRAMP, TOKENS } from "./config";
import type { ClaimOp, DepositOp, WithdrawalOp } from "./oplog";
import type { FrontDoorState, VaultState } from "./reads";
import type { DepositFacts, WithdrawalFacts } from "./trail";

/** Bittensor's public node answers log queries of up to 1,000 blocks. Base logs are never read. */
const WINDOW = 1_000n;
const BASE_CHAIN_ID = 8453n;
const ED_RESERVE = 10n ** 12n;

type RawLog = { address: string; topics: readonly Hex[]; data: Hex; blockNumber: bigint | null; transactionHash: Hex | null; logIndex: number | null };
type Receipt = { status: string; blockNumber?: bigint; logs: RawLog[] };

/** What the vault has emitted since deployment, scanned once and then only forward. */
export interface VaultScan {
  next: bigint;
  /** BatchDelivered from our front door, by batch id. */
  delivered: Map<string, { key: Hex; txHash: Hex; block: bigint }>;
  staked: { block: bigint; txHash: Hex }[];
  /** PayoutChunkSent by batch key. */
  payouts: Map<Hex, { txHash: Hex; block: bigint }[]>;
  /** The account's own Deposited events (to show deposits made from another browser). */
  deposited: { key: Hex; txHash: Hex; block: bigint; assets: bigint }[];
  /** The account's own Redeemed events (TAO it took out). */
  redeemed: { key: Hex; block: bigint; assets: bigint }[];
  receipts: Map<Hex, Receipt>;
  blockTimes: Map<bigint, Date>;
}

export const newScan = (d: Deployment): VaultScan => ({
  next: d.bitBlock,
  delivered: new Map(),
  staked: [],
  payouts: new Map(),
  deposited: [],
  redeemed: [],
  receipts: new Map(),
  blockTimes: new Map(),
});

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function scanVault(c: Pick<Clients, "bittensor">, d: Deployment, scan: VaultScan, account?: Address): Promise<void> {
  const latest = await c.bittensor.getBlockNumber();
  for (let from = scan.next; from <= latest; from += WINDOW) {
    const to = from + WINDOW - 1n < latest ? from + WINDOW - 1n : latest;
    const raw = (await c.bittensor.getLogs({ address: d.vault, fromBlock: from, toBlock: to } as never)) as RawLog[];
    for (const l of parseEventLogs({ abi: VAULT, logs: raw as never, strict: false })) {
      const block = l.blockNumber as bigint;
      const txHash = l.transactionHash as Hex;
      if (l.eventName === "BatchDelivered" && l.args.sourceChain === BASE_CHAIN_ID && l.args.frontDoor && same(l.args.frontDoor, d.frontDoor)) {
        scan.delivered.set(String(l.args.batchId), { key: l.args.key as Hex, txHash, block });
      } else if (l.eventName === "Staked") {
        scan.staked.push({ block, txHash });
      } else if (l.eventName === "PayoutChunkSent") {
        const key = l.args.key as Hex;
        scan.payouts.set(key, [...(scan.payouts.get(key) ?? []), { txHash, block }]);
      } else if (l.eventName === "Deposited" && account && l.args.user && same(l.args.user, account)) {
        scan.deposited.push({ key: l.args.key as Hex, txHash, block, assets: l.args.assets as bigint });
      } else if (l.eventName === "Redeemed" && account && l.args.user && same(l.args.user, account)) {
        scan.redeemed.push({ key: l.args.key as Hex, block, assets: l.args.assets as bigint });
      }
    }
    scan.next = to + 1n;
  }
}

async function bitReceipt(c: Pick<Clients, "bittensor">, scan: VaultScan, hash: Hex): Promise<Receipt | null> {
  const cached = scan.receipts.get(hash);
  if (cached) return cached;
  const r = (await c.bittensor.getTransactionReceipt({ hash })) as unknown as Receipt | null;
  if (r) scan.receipts.set(hash, r);
  return r;
}

async function blockTime(c: Pick<Clients, "bittensor">, scan: VaultScan, block: bigint): Promise<Date> {
  const cached = scan.blockTimes.get(block);
  if (cached) return cached;
  const b = await c.bittensor.getBlock({ blockNumber: block });
  const at = new Date(Number(b.timestamp) * 1000);
  scan.blockTimes.set(block, at);
  return at;
}

/** A Base receipt, or null while it is not mined (Base is read by hash, never by logs). */
async function baseReceipt(c: Pick<Clients, "base">, hash: Hex | undefined): Promise<Receipt | null> {
  if (!hash) return null;
  try {
    return (await c.base.getTransactionReceipt({ hash })) as unknown as Receipt;
  } catch {
    return null;
  }
}

const mined = (r: Receipt | null) => r?.status === "success";

function batchIdFrom(r: Receipt | null, eventName: "DepositRequested" | "RedeemRequested", account: Address): bigint | undefined {
  if (!r) return undefined;
  const hit = parseEventLogs({ abi: FRONT_DOOR, logs: r.logs as never, eventName, strict: false }).find(
    (l) => l.args.user && same(l.args.user as string, account),
  );
  return hit?.args.batchId as bigint | undefined;
}

const closesAt = (fd: FrontDoorState) => new Date((fd.openStart + fd.batchInterval) * 1000);

export async function depositFacts(
  c: Pick<Clients, "base" | "bittensor">,
  d: Deployment,
  op: DepositOp,
  ctx: { fd: FrontDoorState; vault: VaultState; scan: VaultScan },
): Promise<{ batchId?: bigint; facts: DepositFacts }> {
  const swap = await baseReceipt(c, op.hashes.swap);
  const dep = await baseReceipt(c, op.hashes.deposit);
  // an exact-output swap spends at most the quoted USDC; the receipt says how much it really took
  const usdcSpent = mined(swap)
    ? parseEventLogs({ abi: ERC20, logs: swap!.logs as never, eventName: "Transfer", strict: false })
        .filter((l) => same(l.address, TOKENS.usdc) && same(l.args.from as string, op.account))
        .reduce((sum, l) => sum + (l.args.value as bigint), 0n)
    : 0n;
  const batchId = op.batchId ?? batchIdFrom(dep, "DepositRequested", op.account);
  const facts: DepositFacts = {
    // a deposit of TAO already in the wallet has no swap
    swapMined: op.usdcIn === 0n ? mined(dep) || !!op.hashes.deposit : mined(swap),
    depositMined: mined(dep),
    ...(usdcSpent > 0n ? { usdcSpent } : {}),
    cancelMined: op.cancelled ? mined(await baseReceipt(c, op.cancelled.hash)) : undefined,
    now: new Date(),
    depositedAt: new Date(op.createdAt),
    watchUrl: explorer.ccipAddress(d.baseAdapter),
    openBatchId: ctx.fd.openBatchId,
    closesAt: closesAt(ctx.fd),
    stillOpen: batchId === undefined || batchId === ctx.fd.openBatchId,
    waitingForMinimum: false,
    // the batch before the open one left Base when the open one started
    ...(batchId !== undefined && batchId === ctx.fd.openBatchId - 1n ? { sentAt: new Date(ctx.fd.openStart * 1000) } : {}),
  };
  const hit = batchId !== undefined ? ctx.scan.delivered.get(String(batchId)) : undefined;
  if (hit) {
    const r = await bitReceipt(c, ctx.scan, hit.txHash);
    const mine = parseEventLogs({ abi: VAULT, logs: (r?.logs ?? []) as never, strict: false }).filter(
      (l) => "user" in l.args && l.args.user && same(l.args.user as string, op.account),
    );
    const outcome = mine.some((l) => l.eventName === "DepositBounced")
      ? "bounced"
      : mine.some((l) => l.eventName === "DepositSkipped")
        ? "skipped"
        : "deposited";
    const message = parseEventLogs({ abi: ADAPTER, logs: (r?.logs ?? []) as never, eventName: "Delivered", strict: false }).find(
      (l) => same(l.address, d.bitAdapter),
    );
    facts.delivered = { at: await blockTime(c, ctx.scan, hit.block), txHash: hit.txHash, outcome, messageId: message?.args.messageId as Hex | undefined };
    const staked = ctx.scan.staked.find((s) => s.block > hit.block);
    if (staked) facts.staked = { at: await blockTime(c, ctx.scan, staked.block), txHash: staked.txHash };
    else {
      const idle = ctx.vault.balanceWei > ED_RESERVE + ctx.vault.pendingPayouts ? ctx.vault.balanceWei - ED_RESERVE - ctx.vault.pendingPayouts : 0n;
      facts.waitingForMinimum = outcome === "deposited" && ctx.vault.rootStakeWei + idle < ctx.vault.nominatorMinWei;
      facts.vaultWei = ctx.vault.rootStakeWei + idle;
      facts.minimumWei = ctx.vault.nominatorMinWei;
    }
  }
  return { batchId, facts };
}

export async function withdrawalFacts(
  c: Pick<Clients, "base" | "bittensor">,
  d: Deployment,
  op: WithdrawalOp,
  ctx: { fd: FrontDoorState; vault: VaultState; scan: VaultScan; claims: ClaimOp[] },
): Promise<{ batchId?: bigint; facts: WithdrawalFacts }> {
  const req = await baseReceipt(c, op.hash);
  const batchId = op.batchId ?? batchIdFrom(req, "RedeemRequested", op.account);
  const facts: WithdrawalFacts = {
    requestMined: mined(req),
    cancelMined: op.cancelled ? mined(await baseReceipt(c, op.cancelled.hash)) : undefined,
    now: new Date(),
    requestedAt: new Date(op.createdAt),
    watchUrl: explorer.ccipAddress(d.baseAdapter),
    ...(batchId !== undefined && batchId === ctx.fd.openBatchId - 1n ? { sentAt: new Date(ctx.fd.openStart * 1000) } : {}),
    openBatchId: ctx.fd.openBatchId,
    closesAt: closesAt(ctx.fd),
    stillOpen: batchId === undefined || batchId === ctx.fd.openBatchId,
    claimable: ctx.fd.claimable,
    payoutDelay: ctx.vault.payoutDelay,
  };
  const hit = batchId !== undefined ? ctx.scan.delivered.get(String(batchId)) : undefined;
  if (hit) {
    const r = await bitReceipt(c, ctx.scan, hit.txHash);
    const mine = parseEventLogs({ abi: VAULT, logs: (r?.logs ?? []) as never, strict: false }).filter(
      (l) => "user" in l.args && l.args.user && same(l.args.user as string, op.account),
    );
    const redeemed = mine.find((l) => l.eventName === "Redeemed");
    const at = await blockTime(c, ctx.scan, hit.block);
    if (redeemed) facts.delivered = { at, txHash: hit.txHash, outcome: "redeemed", taoWei: (redeemed.args as { assets: bigint }).assets };
    else if (mine.some((l) => l.eventName === "RedeemDeferred")) facts.delivered = { at, txHash: hit.txHash, outcome: "deferred" };
    else if (mine.some((l) => l.eventName === "RedeemSkipped")) facts.delivered = { at, txHash: hit.txHash, outcome: "skipped" };

    const sent = ctx.scan.payouts.get(hit.key)?.at(-1);
    if (redeemed && sent) {
      const pr = await bitReceipt(c, ctx.scan, sent.txHash);
      const msg = parseEventLogs({ abi: ADAPTER, logs: (pr?.logs ?? []) as never, eventName: "Sent", strict: false }).find((l) =>
        same(l.address, d.bitAdapter),
      );
      const messageId = msg?.args.messageId as Hex | undefined;
      const state = messageId
        ? Number(await c.base.readContract({ address: OFFRAMP.base, abi: OFFRAMP_ABI, functionName: "getExecutionState", args: [messageId] }))
        : 0;
      facts.payout = { txHash: sent.txHash, messageId, state: Math.min(3, Math.max(0, state)) as 0 | 1 | 2 | 3, at: await blockTime(c, ctx.scan, sent.block) };
    }
  }
  const claim = ctx.claims.find((k) => k.withdrawalIds?.includes(op.id) && k.hashes.claim);
  if (claim) facts.claimed = await claimResult(c, claim);
  return { batchId, facts };
}

/** What a claim really paid, from its receipts: the TAO claimed and, if it swapped, the USDC received.
 * Undefined while the claim (or its swap, still in flight) has not settled. */
async function claimResult(c: Pick<Clients, "base">, k: ClaimOp): Promise<WithdrawalFacts["claimed"]> {
  const claimReceipt = await baseReceipt(c, k.hashes.claim);
  if (!mined(claimReceipt)) return undefined;
  const claimedLog = parseEventLogs({ abi: FRONT_DOOR, logs: claimReceipt!.logs as never, eventName: "Claimed", strict: false }).find(
    (l) => same(l.args.user as string, k.account),
  );
  const taoClaimed = (claimedLog?.args.amount as bigint | undefined) ?? k.amount;
  const base = { hash: k.hashes.claim as Hex, at: new Date(k.createdAt), taoClaimed };
  if (k.keepTao) return { ...base, keptTao: true, swapFailed: false };
  const swapReceipt = await baseReceipt(c, k.hashes.swap);
  if (mined(swapReceipt)) {
    const usdcOut = parseEventLogs({ abi: ERC20, logs: swapReceipt!.logs as never, eventName: "Transfer", strict: false })
      .filter((l) => same(l.address, TOKENS.usdc) && same(l.args.to as string, k.account))
      .reduce((sum, l) => sum + (l.args.value as bigint), 0n);
    return { ...base, usdcOut, keptTao: false, swapFailed: false };
  }
  // the claim went through; a swap that stopped (not one still running) leaves the TAO in the wallet
  return k.state === "failed" || k.state === "needs-you" ? { ...base, keptTao: false, swapFailed: true } : undefined;
}

/** The account's deposits as the vault recorded them, with when they arrived and whether staking followed. */
export async function chainDeposits(c: Pick<Clients, "bittensor">, scan: VaultScan) {
  const out: { key: Hex; txHash: Hex; at: Date; assets: bigint; staked: boolean }[] = [];
  for (const e of scan.deposited) {
    out.push({ ...e, at: await blockTime(c, scan, e.block), staked: scan.staked.some((s) => s.block > e.block) });
  }
  return out;
}

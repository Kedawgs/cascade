import type { Deployment } from "./cascade/config";
import type { DepositQuote, WithdrawalQuote } from "./cascade/types";
import { toDisplay } from "./cascade/units";
import { waitText } from "./faq";
import { formatTao, formatUsdc, formatUsdcCents } from "./format";

/** A deposit or unstake that has just gone through, for the panel that confirms it: its amounts as its
 * quote gave them (an estimate until Activity reads the chain), and how often a batch can leave (the
 * front door's interval, when the quote read it). */
export type SentNotice =
  | {
      kind: "deposit";
      id: string;
      /** The USDC staked; none for a deposit of TAO already in the wallet, whose TAO is then exact. */
      usdc?: number;
      tao: number;
      batchIntervalS?: number;
    }
  | { kind: "unstake"; id: string; tao: number; usdc: number; batchIntervalS?: number };

export const depositNotice = (id: string, q: Pick<DepositQuote, "amountUsd" | "estTao" | "batchIntervalS">): SentNotice => ({
  kind: "deposit",
  id,
  usdc: q.amountUsd,
  tao: q.estTao,
  ...(q.batchIntervalS !== undefined ? { batchIntervalS: q.batchIntervalS } : {}),
});

export const walletTaoNotice = (id: string, taoWei: bigint): SentNotice => ({ kind: "deposit", id, tao: toDisplay(taoWei, 18) });

export const unstakeNotice = (id: string, q: Pick<WithdrawalQuote, "taoAmount" | "usdcAmount" | "batchIntervalS">): SentNotice => ({
  kind: "unstake",
  id,
  tao: q.taoAmount,
  usdc: q.usdcAmount,
  ...(q.batchIntervalS !== undefined ? { batchIntervalS: q.batchIntervalS } : {}),
});

/** The timing the panel describes: the deployment's pinned max wait and payout delay (deployments.json),
 * and whether its unstakes pay USDC automatically (v3). */
export interface SentTiming {
  v3: boolean;
  batchMaxWaitS?: number;
  payoutDelayS?: number;
}

export function sentTiming(d: Pick<Deployment, "batchMaxWaitS" | "payoutDelayS"> | null, v3: boolean): SentTiming {
  return {
    v3,
    ...(d?.batchMaxWaitS !== undefined ? { batchMaxWaitS: d.batchMaxWaitS } : {}),
    ...(d?.payoutDelayS !== undefined ? { payoutDelayS: d.payoutDelayS } : {}),
  };
}

export interface SentCopy {
  title: string;
  /** Label and value, as the receipt's rows show them. */
  rows: [string, string][];
  /** What happens next, true for the deployment's timing. */
  next: string;
  /** Its receipt trail on Activity. */
  href: string;
}

/** "hourly", "every 10 minutes": how often a batch can leave. */
function every(s: number): string {
  if (s === 3_600) return "hourly";
  return s === 60 ? "every minute" : `every ${waitText(s)}`;
}

/** How the batch carrying it leaves: by the front door's interval and the keeper's rule (a batch with
 * entries leaves once its fees cover the bridge fee, or at the deployment's max wait), naming only what is
 * known. Starts after "…to Bittensor in a batch". */
function batchText(interval: number | undefined, maxWaitS: number | undefined): string {
  if (maxWaitS) {
    const latest = `otherwise within ${waitText(maxWaitS)}`;
    return interval !== undefined
      ? `: batches leave ${every(interval)} once their fees cover the bridge fee, ${latest}.`
      : `, which leaves once its fees cover the bridge fee, ${latest}.`;
  }
  return interval !== undefined ? `: batches leave ${every(interval)}.` : ".";
}

/** What was sent, as the panel and an unconfirmed receipt show it: estimates are "about", a deposit of
 * wallet TAO's exact TAO isn't. */
export function sentRows(n: SentNotice): [string, string][] {
  if (n.kind === "unstake") {
    return [
      ["Unstaking", `about ${formatTao(n.tao, 4)} TAO`],
      ["You will receive", `about ${formatUsdcCents(n.usdc)} USDC`],
    ];
  }
  return n.usdc !== undefined
    ? [
        ["Amount", `${formatUsdc(n.usdc)} USDC`],
        ["TAO (estimate)", `about ${formatTao(n.tao, 4)} TAO`],
      ]
    : [["Amount", `${formatTao(n.tao, 4)} TAO`]];
}

export function sentCopy(n: SentNotice, t: SentTiming): SentCopy {
  const batch = batchText(n.batchIntervalS, t.batchMaxWaitS);
  if (n.kind === "deposit") {
    return {
      title: "Your deposit is on its way",
      rows: sentRows(n),
      next: `Next it crosses to Bittensor in a batch${batch} It's staked about 20 minutes after it leaves.`,
      href: `/activity?deposit=${n.id}`,
    };
  }
  const wait =
    t.payoutDelayS === undefined ? "After a safety wait it" : t.payoutDelayS > 0 ? `After the ${waitText(t.payoutDelayS, true)} safety wait it` : "Then it";
  const payout = t.v3 ? "it's sold at your minimum price or better and the USDC is sent to your wallet" : "you claim it as USDC from its receipt";
  return {
    title: "Your unstake is requested",
    rows: sentRows(n),
    next: `Next it goes to Bittensor in a batch${batch} ${wait} comes back to Base, where ${payout}.`,
    href: `/activity?withdrawal=${n.id}`,
  };
}

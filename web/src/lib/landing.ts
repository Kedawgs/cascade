import type { Deployment, Stage } from "./cascade/config";
import type { AuditStatus } from "./site";

const DAY_S = 86_400;

/** How soon a deposit is usually staked: within the hour on short batches; under a max wait (the launch
 * cadence: a batch may wait up to that long before it closes), within that many days. */
function stakedWithin(batchMaxWaitS?: number): string {
  if (!batchMaxWaitS) return "within the hour";
  const days = Math.ceil(batchMaxWaitS / DAY_S);
  return days <= 1 ? "within a day" : `within ${days} days`;
}

/** The landing page's three steps, worded for the deployment the site talks to. */
export function howItWorksSteps(d: Pick<Deployment, "batchMaxWaitS"> | null): { title: string; body: string }[] {
  return [
    {
      title: "Deposit USDC",
      body: "Straight from MetaMask, Coinbase Wallet, Rabby or any wallet on Base.",
    },
    {
      title: "We swap and stake",
      body: `Your USDC becomes TAO, crosses to Bittensor over Chainlink CCIP and is staked. Usually ${stakedWithin(d?.batchMaxWaitS)}.`,
    },
    {
      title: "Earn, then unstake",
      // the vault's daily outflow limit (and its cap on one unstake) can leave part of a large exit for a later day
      body: "Rewards are collected for everyone and added to your balance. Unstake back to USDC any time, within daily limits.",
    },
  ];
}

/** The three points beside the landing page's stake form. */
export const STAKE_POINTS: readonly { lead: string; body: string }[] = [
  { lead: "One balance.", body: "Your TAO and your rewards, in dollars and in TAO." },
  {
    lead: "Always visible.",
    body: "See exactly where your money is at every step, with a live on-chain check once it is staked.",
  },
  { lead: "Unstake any time, within daily limits.", body: "Back to USDC in the same wallet. The form shows how long it takes." },
];

/** The landing page's audit card: at the launch ("early") that there is no independent audit yet; otherwise,
 * while one is scheduled, that it comes before launch. An audit that is done is never "Not yet". */
export function auditCard(stage: Stage, audit: AuditStatus): { badge: string | null; body: string } {
  if (stage === "early" && audit !== "done") return { badge: "Not yet", body: "No independent audit yet. Only deposit what you could afford to lose." };
  return { badge: audit === "scheduled" ? "Scheduled" : null, body: "A third-party review before launch. The report will be linked here." };
}

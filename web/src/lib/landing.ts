import type { Deployment } from "./cascade/config";

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
      title: "Earn, and leave any time",
      body: "Rewards are collected for everyone and added to your balance. Unstake back to USDC whenever you like.",
    },
  ];
}

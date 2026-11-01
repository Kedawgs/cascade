import { type Deployment, explorer } from "./cascade/config";
import type { StepId } from "./security-view";

/** One contract the money passes through, as /security lists it. */
export interface ContractRow {
  chain: "Base" | "Bittensor";
  name: string;
  /** What it does, in a sentence a depositor understands. */
  does: string;
  address: string;
  href: string;
}

/** The deployment's contracts, Base first (where the money starts), in the order the money meets them. The
 * staker and the oracle exist only on a v3 deployment, so a row appears only for an address the deployment has. */
export function contractsOf(d: Deployment | null): ContractRow[] {
  if (!d) return [];
  const base = (name: string, does: string, address: string | undefined): ContractRow[] =>
    address ? [{ chain: "Base", name, does, address, href: explorer.baseAddress(address) }] : [];
  const bit = (name: string, does: string, address: string): ContractRow[] => [
    { chain: "Bittensor", name, does, address, href: explorer.bittensorAddress(address) },
  ];
  return [
    ...base("Swap contract", "Swaps your USDC for TAO, and TAO back to USDC, against the price check.", d.staker),
    ...base("Price check", "The 30-minute average price every swap is checked against.", d.oracle),
    ...base("Front door", "Takes deposits and unstake requests and groups them into batches.", d.frontDoor),
    ...base("Bridge adapter", "Sends the front door's batches over Chainlink and receives payouts.", d.baseAdapter),
    ...bit("Vault", "Stakes the TAO with the validator and keeps track of every share.", d.vault),
    ...bit("Bridge adapter", "Receives the batches from Base and sends payouts back.", d.bitAdapter),
  ];
}

/** A place Cascade can go wrong, said plainly, with where to watch it: a step of the live map, or a link. */
export interface Risk {
  title: string;
  body: string;
  watch: { kind: "step"; dir: "in" | "out"; id: StepId; label: string } | { kind: "link"; href: string; label: string };
}

export function risksFor(codeUrl: string): Risk[] {
  return [
    {
      title: "The contracts",
      body: "Cascade's contracts haven't had an independent audit yet. A bug could cost deposits, so only deposit what you could afford to lose.",
      watch: { kind: "link", href: codeUrl, label: "Read the code" },
    },
    {
      title: "The bridged TAO",
      body: "On Base you hold ForeverMoney's bridged TAO. If its backing fell short, it would be worth less than TAO.",
      watch: { kind: "step", dir: "in", id: "backing", label: "Watch the backing" },
    },
    {
      title: "The bridge",
      body: "Chainlink's bridge caps how much can cross at a time. When it's full, deposits and payouts wait until it refills.",
      watch: { kind: "step", dir: "in", id: "bridge", label: "Watch the bridge" },
    },
    {
      title: "The validator",
      body: "Rewards come from the validator the vault stakes with. If it went offline or raised its cut, rewards would fall until the stake moved.",
      watch: { kind: "step", dir: "in", id: "validator", label: "Watch the validator" },
    },
    {
      title: "Swap prices",
      body: "Swapping on Base moves the price a little, and more when the pool is thin. The cost of a $1,000 swap each way is shown live.",
      watch: { kind: "step", dir: "in", id: "swap", label: "Watch the swap" },
    },
  ];
}

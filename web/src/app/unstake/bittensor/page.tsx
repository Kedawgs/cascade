import type { Metadata } from "next";
import { BittensorExitScreen } from "@/components/app/BittensorExitScreen";
import { DEPLOYMENT, isV32 } from "@/lib/cascade/config";

// v3.2 only: on any other deployment the page has nothing at this address (BittensorExitScreen), and no title of its own
export const metadata: Metadata = isV32(DEPLOYMENT) ? { title: "Withdraw on Bittensor" } : {};

/** v3.2's emergency way out: a withdrawal straight from the vault on Bittensor (Task 59b). */
export default function WithdrawOnBittensorPage() {
  return <BittensorExitScreen />;
}

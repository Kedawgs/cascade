import type { Metadata } from "next";
import { Redirect } from "@/components/app/Redirect";

export const metadata: Metadata = { title: "Unstake" };

/** The old withdraw page lives on as a redirect to the Unstake tab. */
export default function WithdrawPage() {
  return <Redirect to="/unstake" />;
}

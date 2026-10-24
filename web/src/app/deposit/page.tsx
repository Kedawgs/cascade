import type { Metadata } from "next";
import { Redirect } from "@/components/app/Redirect";

export const metadata: Metadata = { title: "Stake" };

/** The old deposit page lives on as a redirect to the Stake tab. */
export default function DepositPage() {
  return <Redirect to="/stake" />;
}

import type { Metadata } from "next";
import { WithdrawScreen } from "@/components/WithdrawScreen";

export const metadata: Metadata = { title: "Withdraw" };

export default function WithdrawPage() {
  return <WithdrawScreen />;
}

import type { Metadata } from "next";
import { DepositScreen } from "@/components/DepositScreen";

export const metadata: Metadata = { title: "Deposit" };

export default function DepositPage() {
  return <DepositScreen />;
}

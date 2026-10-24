import type { Metadata } from "next";
import { StakeScreen } from "@/components/app/StakeScreen";

export const metadata: Metadata = { title: "Stake" };

export default function StakePage() {
  return <StakeScreen />;
}

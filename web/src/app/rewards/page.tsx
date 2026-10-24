import type { Metadata } from "next";
import { RewardsScreen } from "@/components/app/RewardsScreen";

export const metadata: Metadata = { title: "Rewards" };

export default function RewardsPage() {
  return <RewardsScreen />;
}

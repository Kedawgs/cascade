import type { Metadata } from "next";
import { UnstakeScreen } from "@/components/app/UnstakeScreen";

export const metadata: Metadata = { title: "Unstake" };

export default function UnstakePage() {
  return <UnstakeScreen />;
}

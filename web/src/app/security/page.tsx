import type { Metadata } from "next";
import { SecurityPage } from "@/components/security/SecurityPage";

export const metadata: Metadata = { title: "Security" };

export default function Security() {
  return <SecurityPage />;
}

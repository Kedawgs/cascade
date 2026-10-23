import type { Metadata } from "next";
import { DepositTrailScreen } from "@/components/TrailScreens";

export const metadata: Metadata = { title: "Deposit trail" };

export default async function DepositTrailPage({ params }: PageProps<"/deposits/[id]">) {
  const { id } = await params;
  return <DepositTrailScreen id={id} />;
}

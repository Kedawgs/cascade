import type { Metadata } from "next";
import { WithdrawalTrailScreen } from "@/components/TrailScreens";

export const metadata: Metadata = { title: "Withdrawal trail" };

export default async function WithdrawalTrailPage({ params }: PageProps<"/withdrawals/[id]">) {
  const { id } = await params;
  return <WithdrawalTrailScreen id={id} />;
}

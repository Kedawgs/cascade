import type { Metadata } from "next";
import { FaqPage } from "@/components/faq/FaqPage";

export const metadata: Metadata = { title: "FAQ" };

export default function Faq() {
  return <FaqPage />;
}

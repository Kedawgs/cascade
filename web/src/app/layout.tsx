import type { Metadata, Viewport } from "next";
import { Schibsted_Grotesk } from "next/font/google";
import { DemoBanner } from "@/components/DemoBanner";
import { Providers } from "@/components/Providers";
import "./globals.css";

const schibsted = Schibsted_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Cascade", template: "%s · Cascade" },
  description:
    "Deposit USDC from the wallet you already have and hold TAO staked on Bittensor, with proof that it stays staked.",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={schibsted.variable}>
      <body>
        <Providers>
          <DemoBanner />
          <main className="page">{children}</main>
        </Providers>
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import { DemoBanner } from "@/components/DemoBanner";
import { Providers } from "@/components/Providers";
import "./globals.css";

const manrope = Manrope({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Cascade", template: "%s · Cascade" },
  description:
    "Get exposure to TAO staking from the wallet you already have. Deposit USDC and Cascade swaps it to TAO and stakes it on Bittensor for you.",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={manrope.variable}>
      <body>
        <Providers>
          <DemoBanner />
          <main className="page">{children}</main>
        </Providers>
      </body>
    </html>
  );
}

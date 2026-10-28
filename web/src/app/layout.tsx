import type { Metadata, Viewport } from "next";
import { Manrope } from "next/font/google";
import { NotConnectedBanner } from "@/components/NotConnected";
import { Providers } from "@/components/Providers";
import { loadSnapshot } from "@/lib/cascade/snapshot";
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

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // the APY and protocol figures, read here so the first HTML has them (see snapshot.ts)
  const snapshot = await loadSnapshot();
  return (
    <html lang="en" className={manrope.variable}>
      <body>
        <Providers snapshot={snapshot}>
          <NotConnectedBanner />
          <main className="page">{children}</main>
        </Providers>
      </body>
    </html>
  );
}

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The site is plain static files: no server, no secrets to leak from a host.
  output: "export",
  // Folder-per-route output (stake/index.html) so any static host serves clean URLs without rules.
  trailingSlash: true,
  // The Base Account SDK is only loaded in the browser (the wagmi connector imports it
  // lazily). Its Node entry pulls in server wallet tooling with optional deps we don't
  // need, so keep it out of the server bundle.
  serverExternalPackages: ["@base-org/account"],
  // WalletConnect's provider has one import of Reown AppKit (its own QR window), which it runs only when asked for that
  // window. The site draws its own and never asks, and AppKit isn't installed (pnpm-workspace.yaml), so that import is
  // pointed at a file of the site's own that throws: nothing of AppKit can end up in a bundle or be fetched.
  turbopack: {
    resolveAlias: {
      "@reown/appkit/core": "./src/lib/walletconnect-no-appkit.ts",
    },
  },
  // Every page waits for the figures the first HTML carries (src/lib/cascade/snapshot.ts), and the yield among them may
  // take 90 s to read from Bittensor's archive node. Next's own limit for a static page is 60 s, after which it starts
  // the page again and, after three tries, fails the build: 150 s leaves that read a minute to spare.
  staticPageGenerationTimeout: 150,
};

export default nextConfig;

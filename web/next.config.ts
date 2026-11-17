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
  // Every page waits for the figures the first HTML carries (src/lib/cascade/snapshot.ts), and the yield among them may
  // take 90 s to read from Bittensor's archive node. Next's own limit for a static page is 60 s, after which it starts
  // the page again and, after three tries, fails the build: 150 s leaves that read a minute to spare.
  staticPageGenerationTimeout: 150,
};

export default nextConfig;

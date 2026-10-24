import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The site is plain static files: no server, no secrets to leak from a host.
  output: "export",
  // The Base Account SDK is only loaded in the browser (the wagmi connector imports it
  // lazily). Its Node entry pulls in server wallet tooling with optional deps we don't
  // need, so keep it out of the server bundle.
  serverExternalPackages: ["@base-org/account"],
};

export default nextConfig;

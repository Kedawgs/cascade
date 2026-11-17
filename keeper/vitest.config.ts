import { createHash } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { defineConfig } from "vitest/config";
import { encodeDeployment } from "../ops/src/keeper/core/deployment.ts";
import { deploymentFor } from "../ops/test/keeper-v32-world.ts";

// Two projects: `worker` runs src/ inside workerd (the plugin's Miniflare, a local Durable Object per test file);
// `node` runs what bundles, spawns or reads files (the scripts, the dry-run bundle, the lease client).
//
// The worker tests' key is a throwaway made here for this run only, and their RPC URLs carry keyed-looking paths, so a
// test can check that neither ever reaches a log line, a stored row or a response.

const KEY = generatePrivateKey();
const KEEPER = privateKeyToAccount(KEY).address;
export const TEST_TOKEN = "test-control-token-0123456789abcdef";

export default defineConfig({
  resolve: { dedupe: ["viem", "@noble/hashes"] },
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
            miniflare: {
              bindings: {
                DEPLOYMENT: encodeDeployment(deploymentFor({ keeper: KEEPER })),
                KEEPER_PRIVATE_KEY: KEY,
                CONTROL_TOKEN_SHA256: createHash("sha256").update(TEST_TOKEN).digest("hex"),
                TEST_TOKEN,
                BASE_RPC_URL: "https://base.rpc.test/v2/base-key-0123456789",
                BASE_LOGS_RPC_URL: "https://base-logs.rpc.test/rpc?apikey=logs-key-0123456789",
                BITTENSOR_RPC_URL: "https://bittensor.rpc.test/v1/bit-key-0123456789",
                RPC_SPACING_MS: JSON.stringify({ base: 0, bittensor: 0 }),
              },
              serviceBindings: { MONITOR: async () => new Response("{}", { status: 503 }) },
            },
          })),
        ],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
          setupFiles: ["test/worker/setup.ts"],
          // as the monitor's: the plugin at 1.4.2 can't load Vitest 5's on-disk module cache
          fsModuleCache: false,
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/node/**/*.test.ts"],
          testTimeout: 120_000,
        },
      },
    ],
  },
});

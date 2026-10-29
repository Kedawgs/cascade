import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Two projects: `worker` runs every src/ module inside workerd with a local Miniflare D1 (the plugin is
 * configured on this project only); `node` runs what touches files (scripts, grep tests, comparisons
 * with the contracts and the keeper), since workerd has no filesystem. */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: "./wrangler.jsonc", environment: "test" },
            miniflare: {
              bindings: {
                // the migrations, handed to the setup file, which applies them to each test file's D1
                TEST_MIGRATIONS: await readD1Migrations(here("./migrations")),
                // a fixed fake deployment in place of wrangler.jsonc's placeholder (plan Task 29 fills that)
                DEPLOYMENT: readFileSync(here("./test/fixtures/deployment.json"), "utf8"),
              },
            },
          })),
        ],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
          setupFiles: ["test/worker/setup.ts"],
          // Vitest 5 caches transformed modules on disk by default, and the plugin at 1.4.2 can't load
          // them (every worker test file fails with "File path must be a file: URL"; fixed in 1.4.3)
          fsModuleCache: false,
        },
      },
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/node/**/*.test.ts"],
        },
      },
    ],
  },
});

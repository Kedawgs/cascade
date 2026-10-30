import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// pnpm smoke: runs the smoke project (test/smoke, one tick against the live v3 test deployment, read-only)
// with INDEXER_SMOKE=1, on any shell. SMOKE_BUDGET caps the tick's requests (default 40).

const VITEST = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "vitest", "vitest.mjs");
// --silent=false: the point is to read what it prints (the tick's report, the checks and the digest)
const r = spawnSync(process.execPath, [VITEST, "run", "--project", "smoke", "--silent=false", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, INDEXER_SMOKE: "1" },
});
process.exit(r.status ?? 1);

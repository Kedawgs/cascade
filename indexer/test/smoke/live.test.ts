import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleScan } from "../../src/api.ts";
import { parseConfig, VAR_NAMES } from "../../src/config.ts";
import { buildDigest } from "../../src/digest.ts";
import { renderDigest } from "../../src/email.ts";
import { expandHour } from "../../src/snapshot.ts";
import { loadTickState } from "../../src/store.ts";
import { historyOf, runTick } from "../../src/tick.ts";
import { assertValidScanState } from "../worker/scan-state-rules.ts";

// pnpm smoke (INDEXER_SMOKE=1): one tick against the live v3 test deployment (wrangler.jsonc env.test, its
// public RPCs, read-only) into a throwaway local D1, emails in log mode, and the digest printed. Not part of
// pnpm test. SMOKE_BUDGET (default 40) caps the tick's requests: enough to scan the deployment's first
// Bittensor windows and Base's first few thousand blocks (batches 1 and 2), and to read both chains' state.

const vars = env as unknown as Record<string, unknown>;
const live = vars.INDEXER_SMOKE === "1";
/** the v3 test wallet (owner, guardian and keeper on v3-test; already public in ops/src/config.ts) */
const WALLET = "0x770932787dd3bce64f14e31f4746bce22e214fff";

describe.skipIf(!live)("live smoke: one tick against the v3 test deployment", () => {
  it("scans both chains, reads their state, serves both halves, and builds the digest", { timeout: 180_000 }, async () => {
    const cfg = parseConfig({
      ...Object.fromEntries(VAR_NAMES.map((n) => [n, vars[n]])),
      SUBREQUEST_BUDGET: String(vars.SMOKE_BUDGET || "40"),
      PRICE_SOURCES: "[]",
      ALERT_MODE: "log",
    });
    expect(cfg.rpc.baseLogs).not.toContain("mainnet.base.org");
    const db = env.DB;
    const r = await runTick({ env: { DB: db }, cfg, fetch: (i, init) => globalThis.fetch(i, init), now: () => Date.now(), scheduledMs: Date.now() });
    console.log(`tick: ${JSON.stringify(r)}`);
    expect(r.outcome).toBe("done");
    expect(r.subrequests).toBeLessThanOrEqual(cfg.budgets.subrequests);

    const state = await loadTickState(db, Math.floor(Date.now() / 1000));
    for (const c of ["base", "bittensor"] as const) {
      const cur = state.cursors[c];
      expect(cur?.scannedTo, c).toBeGreaterThan(cfg.deployment[c].startBlock);
      expect(cur?.settledTime, c).not.toBeNull();
    }
    const history = historyOf(state);
    const bit = history.bittensor[0];
    const base = history.base[0];
    expect(bit?.state.price).toBeGreaterThan(0n);
    expect(base?.state.openBatch).toBeDefined();
    // the live Owner read: the stake hotkey has an owner (32 bytes)
    expect(bit?.state.hotkeyOwner).toMatch(/^0x[0-9a-f]{64}$/);
    // the live StakingHotkeys read (the storage key is worked out offline): the chain lists the stake hotkey
    // among the hotkeys the vault's coldkey has stake on
    console.log(`StakingHotkeys(vault coldkey): ${JSON.stringify(bit?.state.stakedHotkeys)}`);
    expect(bit?.state.stakedHotkeys).toContain(cfg.deployment.stakeHotkey);
    // FM-TAO on Base within its lock on Bittensor
    console.log(`FM-TAO: ${base?.state.fmTaoSupply} on Base, ${bit?.state.lockPoolFmTao} locked on Bittensor`);
    expect(base!.state.fmTaoSupply! <= bit!.state.lockPoolFmTao!).toBe(true);

    const vault = cfg.deployment.vault;
    for (const path of [`/v1/scan/${vault}`, `/v1/scan/${vault}/${WALLET}`]) {
      const res = await handleScan(new Request(`https://x${path}`), env as never, cfg);
      expect(res.status, path).toBe(200);
      assertValidScanState(await res.json(), vault, cfg.deployment.bittensor.startBlock);
    }
    const checks = await db.prepare("SELECT batch_id, status FROM batch_checks ORDER BY batch_id").all<{ batch_id: number; status: string }>();
    console.log(`checks: ${JSON.stringify(checks.results)}${r.catchingUp?.length ? ` (catching up: ${r.catchingUp.join(", ")}; the cross-checks wait)` : ""}`);
    if (!r.catchingUp?.length) for (const c of checks.results.filter((x) => x.batch_id <= 2)) expect(c.status).toBe("ok");

    const digest = await buildDigest({
      db,
      nowS: Math.floor(Date.now() / 1000),
      base,
      bit,
      hours: state.hours.flatMap((h) => {
        const x = expandHour(h.json);
        return x ? [x] : [];
      }),
      cursors: state.cursors,
      openAlerts: state.openAlerts,
      activeHolds: state.activeHolds,
      meta: state.meta,
    });
    console.log(renderDigest(digest).text);
  });
});

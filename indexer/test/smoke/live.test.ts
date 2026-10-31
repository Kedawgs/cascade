import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleScan } from "../../src/api.ts";
import { hostDomain, parseConfig, VAR_NAMES } from "../../src/config.ts";
import { buildDigest } from "../../src/digest.ts";
import { renderDigest } from "../../src/email.ts";
import { runLogsCheck } from "../../src/logs-check.ts";
import { expandHour } from "../../src/snapshot.ts";
import { loadTickState, setMeta } from "../../src/store.ts";
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
    // what Cascade depends on (src/rules/deps.ts): every new reading answered, the storage keys worked out offline among them
    const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
    console.log(`rail: ${JSON.stringify({ alpha: bit?.state.alpha, wTaoSupply: bit?.state.wTaoSupply, lane: { bittensor: bit?.state.lane, base: base?.state.lane } }, big)}`);
    console.log(`validator: ${JSON.stringify(bit?.state.validator, big)}; RootStakeUnlockInterval: ${bit?.state.rootUnlockInterval}`);
    console.log(
      `claim: ${bit?.state.claimGasRequired} gas at ${bit?.state.baseFee} wei; payout fee: ${bit?.state.payoutFeeQuote} of maxFeeAbs ${bit?.state.maxFeeAbs}; oracle pools: ${base?.state.taoWethPool.cardinality}/${base?.state.taoWethPool.cardinalityNext} and ${base?.state.wethUsdcPool.cardinality} observations`,
    );
    expect(bit?.state.alpha.backing).toBeGreaterThan(0n);
    expect(bit?.state.validator?.take).toBeTypeOf("number");
    expect(bit?.state.validator?.rootUid).toBeTypeOf("number");
    expect(bit?.state.validator?.rootStake).toBeGreaterThan(0n);
    expect(bit?.state.rootUnlockInterval).toBeDefined();
    expect(bit?.state.lane?.outbound?.capacity).toBeGreaterThan(0n);
    expect(base?.state.lane?.inbound?.capacity).toBeGreaterThan(0n);
    expect(bit?.state.payoutFeeQuote).toBeGreaterThan(0n);

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

    // the hourly logs cross-check against each live second endpoint (BASE_LOGS_RPC_URL_2, BITTENSOR_RPC_URL_2), one at
    // a time: the job stops at the first that answers, so a fallback would otherwise go untried. Whether each answers
    // from here (not Cloudflare's egress, which public nodes rate-limit harder), and agrees with the primary over the
    // newest settled range. The other chain is marked catching up meanwhile, so each run asks one chain
    const nowS = Math.floor(Date.now() / 1000);
    for (const c of ["base", "bittensor"] as const) {
      const field = c === "base" ? "baseLogs2" : "bittensor2";
      for (const url of cfg.rpc[field]) {
        await db.batch([db.prepare("DELETE FROM meta WHERE k LIKE 'logs_check_%'"), setMeta(db, "catching_up", c === "base" ? "bittensor" : "base")]);
        const check = await runLogsCheck({ env: { DB: db }, cfg: { ...cfg, rpc: { ...cfg.rpc, [field]: [url] } }, nowS, fetch: (i, init) => globalThis.fetch(i, init) });
        const error = (await loadTickState(db, nowS)).meta[`logs_check_error:${c}`];
        console.log(`logs cross-check, ${c} via ${hostDomain(url)}: ${JSON.stringify(check[c], (_k, v) => (typeof v === "bigint" ? String(v) : v))}${error ? ` (${error})` : ""}`);
        expect(check[c], `${c}'s second endpoint ${hostDomain(url)}`).not.toBe("failed");
      }
    }
    await setMeta(db, "catching_up", "").run();
  });
});

import { env } from "cloudflare:workers";
import { type Hex, keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import { approveSql } from "../../scripts/sql.ts";
import { handleStatus } from "../../src/api.ts";
import { ownerApproved } from "../../src/rules/approvals.ts";
import { deploymentStatement, loadTickState, setCursor, setMeta, upsertBatchCheck } from "../../src/store.ts";
import { wipe } from "./d1-count.ts";
import { testConfig } from "./fixtures.ts";
import { ruleCtx } from "./rule-ctx.ts";

const cfg = testConfig();
const db = env.DB;
const h = (s: string) => keccak256(toBytes(s)) as Hex;
const NOW = 1_800_000_000;

describe("checks.owner_approved", () => {
  it("an approval by the script makes the key ok for the keeper, and the next tick emails it once", async () => {
    await wipe(db);
    const key = h("forged-looking but honest");
    await db.batch([
      deploymentStatement(db, cfg.deployment),
      setCursor(db, { chain: "bittensor", fromBlock: 1n, scannedTo: 10n, settledTo: 10n, settledTime: NOW - 60, headTime: NOW, nowS: NOW }),
      setCursor(db, { chain: "base", fromBlock: 1n, scannedTo: 10n, settledTo: 10n, settledTime: NOW - 60, headTime: NOW, nowS: NOW }),
      setMeta(db, "last_complete_tick", String(NOW)),
      upsertBatchCheck(db, { batchId: 43n, deliveredKey: key, deliveredUid: h("u"), deliveredTx: h("t"), status: "mismatch", detail: "5: the batch's key", queuedBlock: 6_900_500n }),
    ]);
    const okKeys = async () => ((await (await handleStatus(new Request("https://api.test/v1/status"), { DB: db }, cfg, NOW)).json()) as { payouts: { okKeys: string[] } }).payouts.okKeys;
    expect(await okKeys()).toEqual([]);

    // the owner runs pnpm checks:approve: its UPDATE, applied to the test D1 directly
    await db.prepare(approveSql(key, "verified by hand", NOW + 5)).run();
    expect(await okKeys()).toEqual([key]);

    const s = await loadTickState(db, NOW + 60);
    const c = ruleCtx({ approvals: s.approvals, meta: s.meta, nowS: NOW + 60 });
    const found = ownerApproved.run(c);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rule: "checks.owner_approved", facts: { key, batch: "43", note: "verified by hand" } });
    expect(c.writes.meta).toEqual([{ k: "approvals_seen", v: String(NOW + 5) }]);

    // committed: the next tick finds nothing new
    await setMeta(db, "approvals_seen", String(NOW + 5)).run();
    const next = await loadTickState(db, NOW + 120);
    expect(next.approvals).toEqual([]);
    expect(ownerApproved.run(ruleCtx({ approvals: next.approvals, meta: next.meta }))).toEqual([]);
  });
});

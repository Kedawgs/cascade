import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { wipe } from "./d1-count.ts";
import { rows, tickWorld } from "./tick-world.ts";

// Through the whole tick: a condition its rule can't judge (a view the reading asks reverting) stays open, with no
// "resolved" email, and the next reading that still shows it continues the same alert. The tick must hand the rules'
// unjudged marks to reconcile: without them this alert would resolve and reopen.

const db = env.DB;
const E18 = 10n ** 18n;

beforeEach(async () => {
  await wipe(db);
});

describe("a condition the tick couldn't judge", () => {
  it("vault.solvency stays one open alert while pendingPayouts() reverts, and resolves once a reading shows the vault covered", async () => {
    const w = tickWorld({ over: { ALERT_MODE: "send", ALERT_TO: "owner@example.com" } });
    const open = () => rows<{ alert_key: string; resolved_at: number | null }>("SELECT alert_key, resolved_at FROM alerts WHERE rule = 'vault.solvency' ORDER BY id");
    const resolvedEmails = () => w.sent.filter((m) => m.subject === "[Cascade resolved] The vault holds less TAO than it owes");
    // the vault owes more than it holds, on two readings: the critical opens
    w.state.bit.pendingPayouts = 1000n * E18;
    await w.tick();
    w.advance();
    await w.tick();
    expect(await open()).toEqual([{ alert_key: "vault.solvency", resolved_at: null }]);

    // pendingPayouts() reverts: the vault's side can't be read, two ticks running
    w.state.reverts.add("vault.pendingPayouts");
    for (let i = 0; i < 2; i++) {
      w.advance();
      expect((await w.tick()).outcome).toBe("done");
    }
    expect(await open()).toEqual([{ alert_key: "vault.solvency", resolved_at: null }]);
    expect(resolvedEmails()).toEqual([]);

    // read again, still short: the same alert, not a new one
    w.state.reverts.delete("vault.pendingPayouts");
    w.advance();
    await w.tick();
    expect(await open()).toEqual([{ alert_key: "vault.solvency", resolved_at: null }]);

    // covered: resolved, with one "resolved" email
    w.state.bit.pendingPayouts = 0n;
    w.advance();
    await w.tick();
    expect((await open())[0].resolved_at).not.toBeNull();
    expect(resolvedEmails()).toHaveLength(1);
  });
});

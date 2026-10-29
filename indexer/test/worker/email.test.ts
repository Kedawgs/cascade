import { describe, expect, it, vi } from "vitest";
import { type Due, type Finding, renderFacts } from "../../src/alerts.ts";
import { type Email, renderCritical, renderDbFailing, renderDigest, renderResolved, renderWarnings, sendAll } from "../../src/email.ts";
import { RULES } from "../../src/rules/ids.ts";
import { RUNBOOK } from "../../src/runbook.ts";
import { testConfig } from "./fixtures.ts";

const NOW = 1_800_000_000;
const KEY = `0x${"ab".repeat(32)}`;

const due = (f: Finding, o: Partial<Due> = {}): Due => ({
  key: f.key,
  rule: f.rule,
  tier: RULES[f.rule].tier,
  kind: RULES[f.rule].kind,
  subject: f.subject,
  body: renderFacts(f.facts),
  runbook: RUNBOOK[f.rule](f.facts),
  reason: "alert",
  openedAt: NOW,
  notifyCount: 0,
  ...o,
});

const mismatch: Finding = {
  rule: "bridge.batch_mismatch",
  key: `bridge.batch:43:${KEY}`,
  subject: "Batch 43's delivery failed the cross-check at step 5: the batch's key",
  facts: {
    side: "bittensor",
    step: "5: the batch's key",
    detail: `delivered key ${KEY}, the replayed batch's 0x01`,
    batch: "43",
    key: KEY,
    delivery: `https://evm.taostats.io/tx/0x${"01".repeat(32)}`,
    deadline: "2027-01-15 08:30 UTC",
  },
  hold: { id: `bridge.batch:43:${KEY}`, summary: "batch 43's delivery failed the cross-check" },
};
const warning: Finding = { rule: "keeper.low_eth", key: "keeper.low_eth", subject: "The keeper has 0.0019 ETH on Base", facts: { balance: "0.0019 ETH" } };

const ALLOWED = ["basescan.org", "evm.taostats.io", "taostats.io", "ccip.chain.link"];
function checkEmail(e: Email) {
  expect(e.text.length).toBeGreaterThan(0);
  expect(e.html.length).toBeGreaterThan(0);
  for (const body of [e.text, e.html]) {
    expect(body).toContain("Act from your own tools, never from a link in this email.");
    expect(body).not.toMatch(/http:\/\//);
  }
  const hosts = [...e.html.matchAll(/href="https:\/\/([^/"]+)/g)].map((m) => m[1]);
  for (const host of hosts) expect(ALLOWED).toContain(host);
  expect(e.html).not.toMatch(/<script/i);
}

describe("rendering", () => {
  it("a bridge.batch_mismatch email names the batch, the failing step, the cancel deadline and the guardian and owner steps", () => {
    const e = renderCritical({ due: due(mismatch), alertId: 17, hold: { publicId: "h_3f9a0c1e", summary: "batch 43's delivery failed the cross-check" } });
    expect(e.subject).toBe(`[CASCADE CRITICAL] ${mismatch.subject}`);
    for (const s of ["batch: 43", "5: the batch's key", "2027-01-15 08:30 UTC", "Guardian: pause() the vault", "Owner: cancelPayoutBatch", "h_3f9a0c1e", "pnpm alerts:ack -- --env <env> 17", "pnpm hold:clear"]) {
      expect(e.text).toContain(s);
    }
    expect(e.html).toContain('href="https://evm.taostats.io/tx/');
    checkEmail(e);
  });

  it("warnings go out as one email, the resolved and the database-failing emails render, and the digest", () => {
    const w = renderWarnings([{ due: due(warning), alertId: 3 }, { due: due({ ...warning, key: "keeper.low_tao", rule: "keeper.low_tao", subject: "The keeper has 0.09 TAO" }), alertId: 4 }]);
    expect(w.subject).toBe("[Cascade warning] 2 new: The keeper has 0.0019 ETH on Base");
    expect(w.text).toContain("The keeper has 0.09 TAO");
    checkEmail(w);
    const r = renderResolved(due({ ...mismatch, rule: "frontdoor.solvency", key: "frontdoor.solvency:tao", subject: "The front door holds less TAO than it owes" }, { reason: "resolved" }));
    expect(r.subject).toBe("[Cascade resolved] The front door holds less TAO than it owes");
    checkEmail(r);
    // the database is what failed: rendered from memory alone
    const db = renderDbFailing("D1_ERROR: too many requests", NOW);
    expect(db.subject).toBe("[CASCADE CRITICAL] The monitor can't write its database");
    expect(db.text).toContain("D1_ERROR: too many requests");
    expect(db.text).toContain("2027-01-15 08:00 UTC");
    checkEmail(db);
    const d = renderDigest({ date: "2027-01-15", status: "CRITICAL open", sections: [{ title: "Staked", lines: ["total: 1,000 TAO"] }] });
    expect(d.subject).toBe("[Cascade daily] 2027-01-15: CRITICAL open");
    checkEmail(d);
  });

  it("never links or names an http:// address, and links only to the explorers", () => {
    const odd: Finding = { ...warning, facts: { note: "see http://evil.example/x and https://evil.example/y", tx: "https://basescan.org/tx/0x01" } };
    const e = renderWarnings([{ due: due(odd) }]);
    checkEmail(e);
    expect(e.text).toContain("hxxp://evil.example/x");
    expect(e.text).toContain("hxxps://evil.example/y");
  });

  it("escapes what it puts in the HTML", () => {
    const e = renderWarnings([{ due: due({ ...warning, facts: { note: "<img src=x onerror=alert(1)>" } }) }]);
    expect(e.html).not.toContain("<img");
    expect(e.html).toContain("&lt;img");
  });
});

describe("sendAll", () => {
  const cfg = (mode: "send" | "log") => testConfig({ ALERT_MODE: mode, ALERT_TO: "owner@example.com,second@example.com" });
  const msgs = [
    { id: 1, ...renderWarnings([{ due: due(warning) }]) },
    { id: 2, ...renderCritical({ due: due(mismatch) }) },
  ];

  it("in log mode never calls the binding", async () => {
    const send = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await sendAll({ EMAIL: { send } as unknown as SendEmail }, cfg("log"), msgs)).toEqual({ sent: [1, 2], failed: [] });
    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("sends each to the recipients from ALERT_FROM, and a failure doesn't stop the next", async () => {
    const send = vi.fn(async () => ({ messageId: "m" }));
    send.mockImplementationOnce(async () => {
      throw Object.assign(new Error("rate limited"), { code: "E_RATE_LIMIT_EXCEEDED" });
    });
    expect(await sendAll({ EMAIL: { send } as unknown as SendEmail }, cfg("send"), msgs)).toEqual({ sent: [2], failed: [{ id: 1, code: "E_RATE_LIMIT_EXCEEDED" }] });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual([
      expect.objectContaining({ to: ["owner@example.com", "second@example.com"], from: { email: "monitor@cascade.fi", name: "Cascade monitor" }, subject: msgs[1].subject }),
    ]);
  });
});

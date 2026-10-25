import { describe, expect, it } from "vitest";
import { createClients } from "./chain";
import { readDeployment } from "./config";
import { newScan, scanVault } from "./facts";

/** Scans the live vault's history over the public RPC (LIVE=1): it must find the test run's events. */
const d = readDeployment(process.env);
describe.runIf(process.env.LIVE === "1" && d)("live scan", () => {
  it("finds every delivery and the stake since the deploy block", async () => {
    const scan = newScan(d!);
    await scanVault(createClients(), d!, scan);
    console.log({ next: scan.next, delivered: [...scan.delivered.keys()], staked: scan.staked.length });
    expect(scan.delivered.size).toBeGreaterThanOrEqual(2);
    expect(scan.staked.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

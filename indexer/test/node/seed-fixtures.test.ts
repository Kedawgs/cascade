import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURE_FILES, seedFixtures } from "../../scripts/write-seed-fixtures.ts";
import { assertValidScanState } from "../worker/scan-state-rules.ts";
import { pkg } from "./files.ts";

describe("the seed fixtures the site's tests use", () => {
  const made = seedFixtures();

  it("are exactly what the writer produces (run pnpm fixtures after changing it)", () => {
    expect(readFileSync(pkg(FIXTURE_FILES.shared), "utf8")).toBe(made.shared);
    expect(readFileSync(pkg(FIXTURE_FILES.account), "utf8")).toBe(made.account);
  });

  it("pass the site's rules, for the fixture deployment, and share next", () => {
    const deployment = JSON.parse(readFileSync(pkg("test/fixtures/deployment.json"), "utf8")) as { vault: string; bittensor: { startBlock: string } };
    const shared = JSON.parse(made.shared) as { next: string; delivered: unknown[]; deposited: unknown[] };
    const account = JSON.parse(made.account) as { next: string; delivered: unknown[]; deposited: unknown[] };
    assertValidScanState(shared, deployment.vault, BigInt(deployment.bittensor.startBlock));
    assertValidScanState(account, deployment.vault, BigInt(deployment.bittensor.startBlock));
    expect(shared.next).toBe(account.next);
    expect(shared.delivered.length).toBeGreaterThan(0);
    expect(account.deposited.length).toBeGreaterThan(0);
    expect([shared.deposited, account.delivered]).toEqual([[], []]);
  });
});

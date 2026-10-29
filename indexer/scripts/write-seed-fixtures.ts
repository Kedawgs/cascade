// Writes the two seed fixtures the site's tests use (test/fixtures/seed-shared-v1.json and
// seed-account-v1.json), from fixed rows through the same functions the API serves with. Run with
// `pnpm fixtures`; a test checks the committed files are what this produces.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Hex, keccak256, toBytes } from "viem";
import { type AccountEvent, accountHalf, type SeedEvent, sharedHalf } from "../src/seed.ts";

const here = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

export const FIXTURE_FILES = {
  shared: "test/fixtures/seed-shared-v1.json",
  account: "test/fixtures/seed-account-v1.json",
} as const;

/** The account the account half belongs to (a fixed fake address). */
export const FIXTURE_ACCOUNT = "0x00000000000000000000000000000000000a11ce" as Hex;

const h = (label: string) => keccak256(toBytes(`cascade seed fixture: ${label}`));

/** Both halves, as the JSON text written to the files. */
export function seedFixtures(): { shared: string; account: string } {
  // the fake deployment every indexer test uses: its vault and Bittensor start block
  const d = JSON.parse(readFileSync(here("test/fixtures/deployment.json"), "utf8")) as { vault: Hex; bittensor: { startBlock: string } };
  const from = BigInt(d.bittensor.startBlock);
  const next = from + 5001n;
  const at = (offset: number) => String(from + BigInt(offset));
  const batch1 = h("batch 1 key");
  const batch2 = h("batch 2 key");
  const events: SeedEvent[] = [
    { kind: "delivered", batchId: "1", key: batch1, txHash: h("batch 1 delivery"), block: at(100) },
    { kind: "staked", block: at(110), txHash: h("stake after batch 1") },
    { kind: "delivered", batchId: "2", key: batch2, txHash: h("batch 2 delivery"), block: at(1000) },
    { kind: "staked", block: at(1012), txHash: h("stake after batch 2") },
    { kind: "payout", key: batch2, chunk: 0, taken: 1, txHash: h("batch 2 chunk 0"), block: at(1300) },
  ];
  const deposited: AccountEvent[] = [{ key: batch1, txHash: h("batch 1 delivery"), block: at(100), assets: "40000000000000000" }];
  const redeemed: AccountEvent[] = [{ key: batch2, txHash: h("batch 2 delivery"), block: at(1000), assets: "39999999999999990" }];
  const text = (x: unknown) => `${JSON.stringify(x, null, 2)}\n`;
  return {
    shared: text(sharedHalf({ vault: d.vault, from, next, events })),
    account: text(accountHalf({ vault: d.vault, from, next, deposited, redeemed })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const f = seedFixtures();
  writeFileSync(here(FIXTURE_FILES.shared), f.shared);
  writeFileSync(here(FIXTURE_FILES.account), f.account);
  console.log(`wrote ${FIXTURE_FILES.shared} and ${FIXTURE_FILES.account}`);
}

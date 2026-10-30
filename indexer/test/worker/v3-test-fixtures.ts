import type { Hex } from "viem";
import { type Deployment, rolesOf } from "../../src/config.ts";
import { decode, identify, type RawLog, type StoredLog } from "../../src/logs.ts";
import batches from "../fixtures/v3-test-batches.json";
import chunk from "../fixtures/v3-test-chunk.json";
import reads from "../fixtures/v3-test-reads.json";

// The real bytes recorded from the live v3 test deployment (scripts/record-fixtures.ts), decoded as the
// scanner decodes them: receipts' logs from other contracts (the CCIP router, FM-TAO) are left out, as
// eth_getLogs on the deployment's addresses would leave them out.

export { batches, chunk, reads };

/** The v3 test deployment's DEPLOYMENT var (as wrangler.jsonc's env.test holds it). */
export const V3_DEPLOYMENT = JSON.stringify({
  base: { chainId: 8453, startBlock: "53119544", baselineBlock: "53119575" },
  bittensor: { chainId: 964, startBlock: "9368744", baselineBlock: "9368753" },
  frontDoor: "0xDBe6aDCac889adcbE4D4230a82C8d719FB3C1f8B",
  baseAdapter: "0x7c9Ceb476C50B4E4eCc1610d3cEe5d146c2bB9a0",
  staker: "0x5659c5929Dfe7993f3db521582B0201d6bf246B7",
  oracle: "0x45614AE84875EFA577F21F85cf8a6abAA6B2f217",
  vault: "0x32f4c98ACb181a80343CC0925b4202C35e0EB6e3",
  bitAdapter: "0x5659c5929Dfe7993f3db521582B0201d6bf246B7",
  vaultColdkey: "0x34680a431a7295c7df20c0482c37e06788390d7c8ad1f6abb7693394a269a0fa",
  stakeHotkey: "0x56a9aee6291bd03ab6d36d4d13e2bebae7cd403518066c72fba1b417d6ddd748",
  batchMaxWaitS: 0,
});

/** The v3 test deployment's contracts, lowercase. */
export const V3 = batches.deployment as { frontDoor: Hex; baseAdapter: Hex; staker: Hex; vault: Hex; bitAdapter: Hex };

const roleOf = rolesOf(V3 as unknown as Deployment);

/** Raw logs of one chain as the scanner stores them: identified, decoded, role-tagged, each once. */
export function stored(chain: "base" | "bittensor", raws: readonly unknown[]): StoredLog[] {
  const out = new Map<Hex, StoredLog>();
  for (const i of identify(chain, raws as RawLog[])) {
    const l = decode(chain, i, roleOf);
    if (l) out.set(l.uid, l);
  }
  return [...out.values()];
}

/** Every recorded log of the deployment on each chain: batches 1 and 2, and batch 2's chunk 0. */
export const v3Logs = () => ({
  base: stored("base", [...batches.base, ...chunk.base]),
  bittensor: stored("bittensor", [...batches.bittensor, ...chunk.bittensor]),
});

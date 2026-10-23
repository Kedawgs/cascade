import { createMockCascadeData } from "./mock";
import type { CascadeData } from "./types";

export type * from "./types";

/**
 * The one place that decides where Cascade's data comes from.
 *
 * Everything in the UI goes through `CascadeData` (see ./types.ts). To move off
 * the mock, return a real implementation here that reads the vault on Base,
 * the stake engine on Bittensor and an indexer for trail receipts. The demo
 * account can keep using `createMockCascadeData()`.
 */
export function createCascadeData(): CascadeData {
  return createMockCascadeData();
}

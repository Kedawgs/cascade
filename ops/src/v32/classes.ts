import type { ChainName } from "../config.ts";

// v3.2's fixed tables that verify (verify.ts) and the scheduler (scheduler.ts) both read: the block-time pins and the
// scheduler's class table. They live here, apart from both, so that verify can list the scheduler's pending items
// without the two modules importing each other (Task 47's review, concern 4; moved in Task 46b). verify.ts re-exports
// them under the same names.

/** Each chain's block time as the deploy calibrates it, in milliseconds, which the deploy pins each scheduler contract's
 * MS_PER_BLOCK to (Revision 28: twice as fast as the chain's blocks today, Bittensor 7,200 against its 12 s and Base 120
 * against its 0.2 s; spec §3.6, 3.10.17, Appendix B): verify compares each contract's with these, never with the plan's,
 * and the plan and the deploy refuse settings that differ (settings.ts msPerBlockProblems), so a block time in seconds
 * (the 12 and 2 before Revision 28) never reaches a constructor that reads milliseconds. */
export const MS_PER_BLOCK_PINS: Record<ChainName, bigint> = { bittensor: 7_200n, base: 120n };

/** Half of `secs` in blocks of `msPerBlock` milliseconds, rounded up: CascadeBase._halfInBlocks, ceil(secs * 1000 / (2 *
 * msPerBlock)). An item waits this many blocks as well as its delay (readyBlock = the scheduling block plus half its delay
 * in blocks), and keeps this many blocks of EXECUTE_WINDOW past its readyBlock before it can lapse (CascadeBase._lapsed). */
export function halfInBlocks(secs: number | bigint, msPerBlock: number | bigint): number {
  const two = 2n * BigInt(msPerBlock);
  return Number((BigInt(secs) * 1_000n + two - 1n) / two);
}

/** One schedulable function: its delay class and its kind (an activation is Ordinary for a target never active, or a
 * door the guardian removed, and a Reopen for one active before). */
export interface SchedulableV32 {
  fn: string;
  delay: "Param" | "Registry" | "Guardian";
  kind: "Ordinary" | "GuardianSwap" | "Ordinary or Reopen";
}

/** CascadeBase's own schedulable functions, which both scheduler contracts classify last. */
const BASE_SCHEDULED: readonly SchedulableV32[] = [
  { fn: "setGuardian", delay: "Guardian", kind: "GuardianSwap" },
  { fn: "transferOwnership", delay: "Guardian", kind: "Ordinary" },
  { fn: "activateBridge", delay: "Registry", kind: "Ordinary or Reopen" },
];

/** What each scheduler contract's `schedule` accepts (its _classify), each at its canonical length, one ABI word an
 * argument, with its delay class and kind (test/v32-verify.test.ts holds the names, the classes and the kinds to the
 * contracts' source). Task 47 describes an item from it before it is scheduled. */
export const SCHEDULED_V32: Record<"vault" | "frontDoor", readonly SchedulableV32[]> = {
  vault: [
    { fn: "activateFrontDoor", delay: "Registry", kind: "Ordinary or Reopen" },
    { fn: "writeOffMissingStake", delay: "Registry", kind: "Ordinary" },
    { fn: "setStakeHotkey", delay: "Param", kind: "Ordinary" },
    { fn: "setMaxTotalAssets", delay: "Param", kind: "Ordinary" },
    { fn: "setPayoutDelay", delay: "Param", kind: "Ordinary" },
    { fn: "setRewardVesting", delay: "Param", kind: "Ordinary" },
    { fn: "setIdleBuffer", delay: "Param", kind: "Ordinary" },
    { fn: "setFeeLimits", delay: "Param", kind: "Ordinary" },
    { fn: "setRewardCut", delay: "Param", kind: "Ordinary" },
    { fn: "moveStake", delay: "Param", kind: "Ordinary" },
    { fn: "setMessageLimits", delay: "Param", kind: "Ordinary" },
    { fn: "setOutflowLimits", delay: "Param", kind: "Ordinary" },
    ...BASE_SCHEDULED,
  ],
  frontDoor: [
    { fn: "setOracle", delay: "Param", kind: "Ordinary" },
    { fn: "setSwapper", delay: "Param", kind: "Ordinary" },
    { fn: "setMaxDeliverySlippage", delay: "Param", kind: "Ordinary" },
    { fn: "setBatchInterval", delay: "Param", kind: "Ordinary" },
    { fn: "setMaxBatchValue", delay: "Param", kind: "Ordinary" },
    { fn: "setMinPoolLiquidity", delay: "Param", kind: "Ordinary" },
    ...BASE_SCHEDULED,
  ],
};

/** The calls that change a chain's bridges (CascadeBase): an activation (scheduled, Registry class), a disable and the
 * switch of the primary (both at once). pnpm ops schedule writes each only through the rail check (rails.ts, Task 47b),
 * which reads both chains, since each chain keeps its own bridges and primary. */
export const RAIL_FNS = ["activateBridge", "disableBridge", "setPrimaryBridge"] as const;
export type RailFn = (typeof RAIL_FNS)[number];
export const isRailFn = (fn: string | undefined): fn is RailFn => (RAIL_FNS as readonly string[]).includes(fn ?? "");

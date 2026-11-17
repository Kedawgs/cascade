import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { encodeSs58 } from "../src/ss58.ts";
import { type WebRecordV32, webEnv } from "../src/webconfig.ts";
import { planV32, TAO_BOT } from "./v32-fixtures.ts";

// pnpm ops web-config for a v3.2 deployment (rulings DA8, T58's and T58b's carries): the site's env names both lenses
// (NEXT_PUBLIC_CASCADE_VAULT_LENS, _DOOR_LENS, as web/ reads them), takes the vault's coldkey and hotkey from its
// constructor's Params, and names the history indexer, without which a v3.2 site refuses to build.

const plan = planV32();
const sent = (block: number) => ({ hash: `0x${"ab".repeat(32)}` as Hex, block, gasUsed: 1n, costWei: 1n });
const rec: WebRecordV32 = { plan, done: { bitAdapter: sent(9_400_000), vault: sent(9_400_006) }, verify: { ok: true } };
const INDEXER = { OPS_INDEXER_URL: "https://api.cascadefi.xyz" };

describe("web-config for a v3.2 deployment", () => {
  it("writes both lenses, the staker and the oracle, the vault's coldkey and hotkey from its Params, its payout delay and the indexer", () => {
    const params = plan.steps.find((s) => s.id === "vault")!.args[0] as { expectedColdkey: Hex; hotkey: Hex; payoutDelay: bigint };
    expect(params.hotkey).toBe(TAO_BOT);
    const a = plan.addresses;
    expect(webEnv(rec, INDEXER).split("\n")).toEqual([
      "# Written by `pnpm ops web-config`: the live v3.2 deployment. Local only (git-ignored).",
      `NEXT_PUBLIC_CASCADE_FRONT_DOOR=${a.frontDoor}`,
      `NEXT_PUBLIC_CASCADE_BASE_ADAPTER=${a.baseAdapter}`,
      `NEXT_PUBLIC_CASCADE_STAKER=${a.staker}`,
      `NEXT_PUBLIC_CASCADE_ORACLE=${a.oracle}`,
      `NEXT_PUBLIC_CASCADE_VAULT=${a.vault}`,
      `NEXT_PUBLIC_CASCADE_BIT_ADAPTER=${a.bitAdapter}`,
      "NEXT_PUBLIC_CASCADE_BIT_BLOCK=9400000",
      `NEXT_PUBLIC_CASCADE_VAULT_SS58=${encodeSs58(params.expectedColdkey)}`,
      `NEXT_PUBLIC_CASCADE_HOTKEY_SS58=${encodeSs58(params.hotkey)}`,
      `NEXT_PUBLIC_CASCADE_VAULT_LENS=${a.vaultLens}`,
      `NEXT_PUBLIC_CASCADE_DOOR_LENS=${a.doorLens}`,
      "NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S=86400",
      "NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S=86400",
      "NEXT_PUBLIC_CASCADE_INDEXER_URL=https://api.cascadefi.xyz",
      "",
    ]);
    // the coldkey is the plan's (the vault's own address mapped), tao.bot's SS58 the hotkey
    expect(params.expectedColdkey).toBe(plan.vaultColdkey);
    expect(webEnv(rec, INDEXER)).toContain("\nNEXT_PUBLIC_CASCADE_HOTKEY_SS58=5E2LP6EnZ54m3wS8s1yPvD5c3xo71kQroBw7aUVK32TKeZ5u\n");
    // the site checks each address is checksummed: the plan's are
    for (const line of webEnv(rec, INDEXER).split("\n").filter((l) => /=0x/.test(l))) expect(line).not.toBe(line.toLowerCase());
  });

  it("refuses without the history indexer's https origin: a v3.2 site would refuse every stake and USDC unstake", () => {
    for (const bad of [undefined, "", "http://api.cascadefi.xyz", "https://api.cascadefi.xyz/", "https://api.cascadefi.xyz/v1", "api.cascadefi.xyz"]) {
      expect(() => webEnv(rec, { OPS_INDEXER_URL: bad }), String(bad)).toThrow(
        "a v3.2 site needs the history indexer: set OPS_INDEXER_URL to its https origin (no path); nothing written",
      );
    }
    expect(() => webEnv(rec, {})).toThrow(/OPS_INDEXER_URL/);
  });

  it("refuses a v3.2 deployment whose read-back has not passed, or without the Bittensor adapter's deploy block", () => {
    expect(() => webEnv({ ...rec, verify: undefined }, INDEXER)).toThrow("the deployment's read-back has not passed: run verify first");
    expect(() => webEnv({ ...rec, verify: { ok: false } }, INDEXER)).toThrow(/run verify first/);
    expect(() => webEnv({ ...rec, done: { vault: sent(1) } }, INDEXER)).toThrow("the Bittensor adapter's deploy block is not in the record");
    expect(() => webEnv({ ...rec, done: { bitAdapter: { recovered: true } } }, INDEXER)).toThrow(/deploy block is not in the record/);
    expect(webEnv({ ...rec, done: { bitAdapter: { recovered: true, block: 9_399_990 } } }, INDEXER)).toContain("\nNEXT_PUBLIC_CASCADE_BIT_BLOCK=9399990\n");
  });
});

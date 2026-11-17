import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blake2b } from "@noble/hashes/blake2";
import { bytesToHex, type Hex, hexToBytes, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { type ChainName, paths, targets } from "../src/config.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";
import { encodeSs58 } from "../src/ss58.ts";
import {
  DEFAULT_TAKE,
  delegatesKey,
  readValidator,
  STORAGE_QUERY,
  SUBTENSOR_PREFIXES,
  totalHotkeyAlphaKey,
  uidsKey,
  validatorFindings,
  validatorsCommandV32,
} from "../src/v32/validators.ts";
import { le, TAO_BOT, YUMA } from "./v32-fixtures.ts";

// The validators as validators (spec §7 step 3, ruling A8): each hotkey's take, root stake and root uid, read from
// Bittensor's storage through the storage-query precompile on a fake chain, printed and never compared.

/** A Bittensor that answers the storage-query precompile from `storage` (raw value by key; missing is no entry) and
 * eth_chainId; anything else fails the test. */
function storageChain(storage: Record<string, Hex | Error>, chainId = targets({}).rehearsal.bittensor.chainId) {
  const calls: { chain: ChainName; method: string; params: unknown[] }[] = [];
  const keys = Object.fromEntries(Object.entries(storage).map(([k, v]) => [k.toLowerCase(), v]));
  const rpc: Rpc = {
    async request(chain, method, params) {
      calls.push({ chain, method, params });
      if (method === "eth_chainId") return numberToHex(chainId);
      const [{ to, data }] = params as [{ to: string; data: Hex }];
      if (chain !== "bittensor" || method !== "eth_call" || to.toLowerCase() !== STORAGE_QUERY) throw new Error(`unexpected ${method} on ${chain}`);
      const v = keys[data.toLowerCase()];
      if (v instanceof Error) throw v;
      return v ?? "0x";
    },
  };
  return { calls, ctx: { rpc, targets: targets({}).rehearsal } };
}

/** tao.bot with a take of its own (9%), Yuma on the chain's default take; both registered on root. */
const honest = (): Record<string, Hex | Error> => ({
  [delegatesKey(TAO_BOT)]: le(5_898, 2),
  [totalHotkeyAlphaKey(TAO_BOT, 0)]: le(1_234_567_000_000_000n, 8),
  [uidsKey(0, TAO_BOT)]: le(3, 2),
  [totalHotkeyAlphaKey(YUMA, 0)]: le(987_650_000_000n, 8),
  [uidsKey(0, YUMA)]: le(7, 2),
});

describe("the validators (A8, the standby read-back)", () => {
  it("the storage keys are the indexer's, which it checked against the live runtime: prefixes, then Blake2_128Concat and the netuid", () => {
    const indexer = readFileSync(join(paths({}).contractsDir, "..", "indexer", "src", "subtensor.ts"), "utf8");
    const prefix = (name: string) => indexer.match(new RegExp(`export const ${name} = "(0x[0-9a-f]{64})"`))?.[1];
    expect(SUBTENSOR_PREFIXES).toEqual({ Delegates: prefix("DELEGATES_PREFIX"), TotalHotkeyAlpha: prefix("TOTAL_HOTKEY_ALPHA_PREFIX"), Uids: prefix("UIDS_PREFIX") });
    // each key, put together here independently: the map's prefix, blake2b-128 of the hotkey then the hotkey, and a
    // netuid as its u16 little-endian (before the hotkey for Uids, after it for TotalHotkeyAlpha)
    const concat = (k: Hex) => `${bytesToHex(blake2b(hexToBytes(k), { dkLen: 16 })).slice(2)}${k.slice(2)}`;
    expect(delegatesKey(TAO_BOT)).toBe(`${SUBTENSOR_PREFIXES.Delegates}${concat(TAO_BOT)}`);
    expect(totalHotkeyAlphaKey(TAO_BOT, 0)).toBe(`${SUBTENSOR_PREFIXES.TotalHotkeyAlpha}${concat(TAO_BOT)}0000`);
    expect(totalHotkeyAlphaKey(TAO_BOT, 0x1234)).toBe(`${SUBTENSOR_PREFIXES.TotalHotkeyAlpha}${concat(TAO_BOT)}3412`);
    expect(uidsKey(0, YUMA)).toBe(`${SUBTENSOR_PREFIXES.Uids}0000${concat(YUMA)}`);
    // the default take is the indexer's too (11,796 of 65,535, 18%)
    expect(indexer).toContain("11,796 (18%");
    expect(DEFAULT_TAKE).toBe(11_796);
  });

  it("reads each validator's take, root stake and root uid, and prints them; the chain's default take when it has none", async () => {
    const f = storageChain(honest());
    expect(await readValidator(f.ctx, TAO_BOT)).toEqual({ hotkey: TAO_BOT, take: 5_898, defaulted: false, rootStakeRao: 1_234_567_000_000_000n, rootUid: 3 });
    expect(await readValidator(f.ctx, YUMA)).toEqual({ hotkey: YUMA, take: DEFAULT_TAKE, defaulted: true, rootStakeRao: 987_650_000_000n, rootUid: 7 });
    const out = await validatorFindings(f.ctx, { primary: TAO_BOT, standby: YUMA });
    expect(out).toEqual({
      failures: [],
      warnings: [],
      info: [
        `Bittensor validator (the primary) ${encodeSs58(TAO_BOT)}: take 9.00% (5,898 of 65,535), root stake 1,234,567 TAO, root uid 3`,
        `Bittensor validator (the standby) ${encodeSs58(YUMA)}: take 18.00% (11,796 of 65,535, the chain's default), root stake 987.65 TAO, root uid 7`,
      ],
    });
  });

  it("a validator with no root uid warns; one whose storage cannot be read, or reads as something else, fails", async () => {
    const s = honest();
    delete s[uidsKey(0, YUMA)];
    delete s[totalHotkeyAlphaKey(YUMA, 0)];
    let out = await validatorFindings(storageChain(s).ctx, { primary: TAO_BOT, standby: YUMA });
    expect(out.failures).toEqual([]);
    expect(out.info[1]).toBe(`Bittensor validator (the standby) ${encodeSs58(YUMA)}: take 18.00% (11,796 of 65,535, the chain's default), root stake 0 TAO, no root uid`);
    expect(out.warnings).toEqual([`Bittensor validator (the standby) ${encodeSs58(YUMA)} has no uid on the root network: check it is still a root validator before staking with it`]);
    // a read that fails is a failure, never a pass
    out = await validatorFindings(storageChain({ ...honest(), [totalHotkeyAlphaKey(YUMA, 0)]: new RpcError("execution reverted", 3, "0x") }).ctx, { primary: TAO_BOT, standby: YUMA });
    expect(out.failures).toEqual([`Bittensor validator (the standby) ${encodeSs58(YUMA)}: its root stake could not be read (execution reverted)`]);
    expect(out.info).toHaveLength(1);
    // a value that is not the stored type (three bytes for a u16 take)
    out = await validatorFindings(storageChain({ ...honest(), [delegatesKey(TAO_BOT)]: "0x010203" }).ctx, { primary: TAO_BOT, standby: YUMA });
    expect(out.failures).toEqual([`Bittensor validator (the primary) ${encodeSs58(TAO_BOT)}: its take is not a stored u16`]);
  });

  it("verify --validators: the two hotkeys from the configuration, with no record; refused before reading when they are not set or the chain is another", async () => {
    const env = { OPS_V32_PRIMARY_HOTKEY: encodeSs58(TAO_BOT), OPS_V32_STANDBY_HOTKEY: YUMA };
    const f = storageChain(honest());
    const r = await validatorsCommandV32(f.ctx, env);
    expect(r.ok).toBe(true);
    expect(r.lines).toEqual([
      `Bittensor validator (the primary) ${encodeSs58(TAO_BOT)}: take 9.00% (5,898 of 65,535), root stake 1,234,567 TAO, root uid 3`,
      `Bittensor validator (the standby) ${encodeSs58(YUMA)}: take 18.00% (11,796 of 65,535, the chain's default), root stake 987.65 TAO, root uid 7`,
    ]);
    // reads only Bittensor's chain id and storage
    expect(new Set(f.calls.map((c) => `${c.chain} ${c.method}`))).toEqual(new Set(["bittensor eth_chainId", "bittensor eth_call"]));
    // a failed read: not ok, and said
    const bad = await validatorsCommandV32(storageChain({ ...honest(), [uidsKey(0, TAO_BOT)]: new RpcError("header not found", -32000) }).ctx, env);
    expect(bad.ok).toBe(false);
    expect(bad.lines.at(-1)).toBe(`FAILED:\n  Bittensor validator (the primary) ${encodeSs58(TAO_BOT)}: its root uid could not be read (header not found)`);
    // no standby configured: refused, nothing read
    const none = storageChain(honest());
    await expect(validatorsCommandV32(none.ctx, { OPS_V32_PRIMARY_HOTKEY: TAO_BOT })).rejects.toThrow(/OPS_V32_STANDBY_HOTKEY is not set/);
    expect(none.calls).toEqual([]);
    // another chain: refused once its id is read
    const other = storageChain(honest(), 945);
    await expect(validatorsCommandV32(other.ctx, env)).rejects.toThrow("Bittensor: the RPC reports chain id 945, not 31338; nothing read");
    expect(other.calls.map((c) => c.method)).toEqual(["eth_chainId"]);
  });
});

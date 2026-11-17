import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  type Hex,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
} from "viem";
import { describe, expect, it } from "vitest";
import { preauditArtifact } from "../src/builds.ts";
import type { ChainName } from "../src/config.ts";
import { buildPlan, buildPlanV3 } from "../src/plan.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";
import { doorLensAbi, frontDoorAbiV32, gettersNamed, REVERTING_STUBS, shapeOf, VAULT_ABI_V32, vaultLensAbi } from "../src/v32/abi.ts";
import {
  DOOR_READS,
  doorLens,
  doorRoute,
  type PlannedRecord,
  readDoor,
  readVault,
  routeOf,
  VAULT_READS,
  vaultLens,
  vaultRoute,
  writeOffMissingStakeRao,
} from "../src/v32/lens.ts";
import { ROLES } from "./launch-roles.ts";
import { planV32 } from "./v32-fixtures.ts";
import { artifact, specKept, specText } from "./v32-sources.ts";

// v3.2's reads (spec §8.1): a getter the contract kept is read from the contract, a moved one from its lens, and
// which is which comes from the ABIs alone. v3-launch's records (and v3-test's, and v2's) read everything from
// their contracts, as before (ruling DA11).

const v32: PlannedRecord = { plan: planV32() };
const COLDKEY: Hex = "0x9214633d20bb6247cb0475ea91ae10665a084404a04147ea48f673571263ad68";
const v3Launch: PlannedRecord = { plan: buildPlanV3(0, 40, COLDKEY, "launch", ROLES) };
const v2: PlannedRecord = { plan: buildPlan(0, 0, COLDKEY) };
const KEY = keccak256(toHex("a payout batch"));

/** v3-launch's vault and front door, as its frozen build has them: what ops read before v3.2. */
const V3_VAULT = preauditArtifact("CascadeVault").abi;
const V3_DOOR = preauditArtifact("CascadeFrontDoor").abi;

const one = (abi: Abi, name: string): AbiFunction => {
  const g = gettersNamed(abi, name);
  if (g.length !== 1) throw new Error(`${g.length} getters ${name}`);
  return g[0];
};

/** An eth_call fake: records each call and answers from `answers` (a value, encoded with the ABI whose selector the
 * call matches; or an Error, thrown), else with zero words (0, false, the zero address, an empty array). */
function fakeRpc(answers: Record<string, unknown> = {}) {
  const calls: { chain: ChainName; to: Address; data: Hex }[] = [];
  const abis = () => [VAULT_ABI_V32, vaultLensAbi(), frontDoorAbiV32(), doorLensAbi(), V3_VAULT, V3_DOOR];
  const rpc: Rpc = {
    async request(chain, method, params) {
      if (method !== "eth_call") throw new Error(`unexpected ${method}`);
      const [{ to, data }] = params as [{ to: Address; data: Hex }];
      calls.push({ chain, to: getAddress(to), data });
      for (const abi of abis()) {
        let fn: string;
        try {
          fn = decodeFunctionData({ abi, data }).functionName;
        } catch {
          continue;
        }
        const a = answers[fn];
        if (a instanceof Error) throw a;
        if (a !== undefined) return encodeFunctionResult({ abi, functionName: fn, result: a } as never);
        break;
      }
      return `0x${"00".repeat(32 * 16)}`;
    },
  };
  return { calls, ctx: { rpc } };
}

/** Arguments of the right types for `f` (zeros), so any getter can be called. */
const argsFor = (f: AbiFunction): unknown[] =>
  f.inputs.map((p: AbiParameter) => (p.type === "address" ? zeroAddress : p.type === "bool" ? false : p.type.startsWith("bytes") ? `0x${"00".repeat(32)}` : 0n));

/** "The limits": the vault constructor's numeric Params the lens serves under their own names (verify reads each back,
 * and the scheduler reads each before a change). */
const vaultParams = () =>
  ((VAULT_ABI_V32.find((x) => x.type === "constructor") as { inputs: readonly AbiParameter[] }).inputs[0] as { components: readonly AbiParameter[] }).components;
const LIMITS = [
  "rewardCutBps",
  "payoutDelay",
  "maxDailyOutflowBps",
  "minDailyOutflow",
  "maxEntryValue",
  "maxMessageValue",
  "minChunk",
  "maxFeeBps",
  "maxFeeAbs",
  "maxTotalAssets",
  "minDirectDeposit",
  "claimGasRequired",
  "hotkeyDustRao",
  "unstakeMarginRao",
  "rewardVesting",
  "globalOutflowBps",
  "idleBufferBps",
  "unstakeGas",
];

/** The shapes of the getters v3.2 added and ops reads by name (no older build has them): what Tasks 46 and 47 decode.
 * The door's state is an enum (uint8), the scheduler's item CascadeTypes.sol's Item. */
const NEW_IN_V32: Record<string, string> = {
  doorState: "doorState(bytes32) -> (uint8)",
  scheduled: "scheduled(bytes32) -> ((uint64 scheduledAt,uint64 readyAt,uint8 class,uint8 kind,bytes4 selector,uint64 readyBlock))",
};

describe("v3.2 reads through the lenses", () => {
  it("everyMovedGetterOpsReadsIsOnTheLens: the vault's moved getters, by the same name and with the same types, on the vault lens alone", () => {
    // the limits are exactly the constructor's numeric Params the lens serves by name: one the vault gains fails here
    const served = vaultParams().filter((p) => /^u?int\d*$/.test(p.type) && gettersNamed(vaultLensAbi(), p.name ?? "").length).map((p) => p.name);
    expect(served.sort()).toEqual([...LIMITS].sort());
    const moved = ["doorState", "hotkeyCount", ...LIMITS, "getPayoutBatch", "visibleStakeRao", "minStakeRao", "totalAssets", "lastClaimAt", "guardian", "keeper", "scheduled"];
    for (const name of moved) {
      expect(VAULT_READS, name).toContain(name);
      // moved: not on the vault, read from the lens
      expect(gettersNamed(VAULT_ABI_V32, name), name).toEqual([]);
      expect(vaultRoute(name), name).toBe("lens");
      const got = shapeOf(one(vaultLensAbi(), name));
      // the types v3-launch's vault read it with (ops's decoders read it alike), v3-launch's rootStakeRao renamed in
      // Task 12 (in rao, as before), a limit's own Params type, or the shape v3.2 gave a getter it added
      const field = vaultParams().find((p) => p.name === name);
      if (field && LIMITS.includes(name)) expect(got, name).toBe(`${name}() -> (${field.type})`);
      if (name === "visibleStakeRao") expect(got).toBe(shapeOf(one(V3_VAULT, "rootStakeRao")).replace("rootStakeRao", "visibleStakeRao"));
      else if (gettersNamed(V3_VAULT, name).length) expect(got, name).toBe(shapeOf(one(V3_VAULT, name)));
      else if (!LIMITS.includes(name)) expect(got, name).toBe(NEW_IN_V32[name]);
    }
    // the rename is whole: v3.2 has no rootStakeRao anywhere, and bookedStake (rao, Task 12) is the lens's
    expect(gettersNamed(VAULT_ABI_V32, "rootStakeRao")).toEqual([]);
    expect(gettersNamed(vaultLensAbi(), "rootStakeRao")).toEqual([]);
    expect(shapeOf(one(vaultLensAbi(), "bookedStake"))).toBe("bookedStake() -> (uint256)");
    expect(vaultRoute("bookedStake")).toBe("lens");
    // the front door's CascadeBase getters moved to the door lens, by the same name and types as v3-launch's door
    for (const name of ["guardian", "primaryBridge", "bridgeEnabled"]) {
      expect(DOOR_READS, name).toContain(name);
      expect(gettersNamed(frontDoorAbiV32(), name), name).toEqual([]);
      expect(doorRoute(name), name).toBe("lens");
      expect(shapeOf(one(doorLensAbi(), name)), name).toBe(shapeOf(one(V3_DOOR, name)));
    }
    // the scheduler's items read alike on both chains (CascadeBase's, through either lens)
    expect(DOOR_READS).toContain("scheduled");
    expect(doorRoute("scheduled")).toBe("lens");
    expect(shapeOf(one(doorLensAbi(), "scheduled"))).toBe(NEW_IN_V32.scheduled);
  });

  it("everyGetterOpsReadsIsOnTheContractOrItsLens: none on neither, none on both with different types, each routed by the ABIs", () => {
    for (const [reads, contract, lens, route] of [
      [VAULT_READS, VAULT_ABI_V32, vaultLensAbi(), vaultRoute],
      [DOOR_READS, frontDoorAbiV32(), doorLensAbi(), doorRoute],
    ] as const) {
      expect(new Set(reads).size).toBe(reads.length);
      for (const name of reads) {
        const onContract = gettersNamed(contract, name);
        const onLens = gettersNamed(lens, name);
        expect(onContract.length + onLens.length, `${name} is on neither`).toBeGreaterThan(0);
        if (onContract.length && onLens.length) expect(onContract.map(shapeOf), `${name} reads differently`).toEqual(onLens.map(shapeOf));
        expect(route(name), name).toBe(onContract.length ? "contract" : "lens");
      }
    }
    // the route refuses a getter on neither, and one on both with different types (or tuple fields)
    const contract = parseAbi(["function x() view returns (uint256)", "function y() view returns (uint64)", "function f() view returns ((uint64 a, uint64 b))", "function act()"]);
    const lens = parseAbi(["function x() view returns (uint256)", "function y() view returns (uint256)", "function z() view returns (bool)", "function f() view returns ((uint64 a, uint64 c))"]);
    expect(routeOf(contract, lens, "x")).toBe("contract");
    expect(routeOf(contract, lens, "z")).toBe("lens");
    expect(() => routeOf(contract, lens, "w", "vault")).toThrow("neither the vault nor its lens has a getter w: nothing read");
    expect(() => routeOf(contract, lens, "y", "vault")).toThrow("the vault and its lens read y differently (y() -> (uint64), and y() -> (uint256)): nothing read");
    expect(() => routeOf(contract, lens, "f")).toThrow(/read f differently/);
    // an entry point is no getter
    expect(() => routeOf(contract, lens, "act")).toThrow("neither the contract nor its lens has a getter act: nothing read");
    expect(() => vaultRoute("schedule")).toThrow("neither the vault nor its lens has a getter schedule: nothing read");
    expect(() => doorRoute("closeBatch")).toThrow("neither the front door nor its lens has a getter closeBatch: nothing read");
  });

  it("keptGettersGoToTheContract: §8.1's kept list reads from the contracts, and the vault keeps no other view", () => {
    const kept = specKept();
    expect(kept.vault).toEqual(["name", "symbol", "decimals", "balanceOf", "totalSupply", "owner", "pendingOwner", "paused", "launchChain", "MS_PER_BLOCK", "extsload"]);
    expect(kept.frontDoor).toEqual(["asset", "usdc", "oracle"]);
    for (const name of kept.vault) expect(vaultRoute(name), name).toBe("contract");
    for (const name of kept.frontDoor) expect(doorRoute(name), name).toBe("contract");
    // the vault kept exactly that: every other view or pure function is its lens's, but for the token's stubs §8.1
    // names (transfer, transferFrom and approve, which revert, and allowance, which answers 0) and the disabled
    // renounceOwnership (spec §3.6), all pure (Task 43a's review, M4)
    expect(specText()).toMatch(/plus `transfer`, `transferFrom` and `approve` that revert\s+and an `allowance` that returns 0/);
    const viewsAndPure = VAULT_ABI_V32.filter((x): x is AbiFunction => x.type === "function" && (x.stateMutability === "view" || x.stateMutability === "pure")).map((f) => f.name);
    expect(viewsAndPure.filter((v) => !kept.vault.includes(v)).sort()).toEqual(["allowance", "approve", "renounceOwnership", "transfer", "transferFrom"]);
    // the stubs that only revert are no getters: nothing reads them, on the vault or the front door
    expect(REVERTING_STUBS).toEqual(["renounceOwnership", "transfer", "transferFrom", "approve"]);
    for (const stub of REVERTING_STUBS) {
      expect(gettersNamed(VAULT_ABI_V32, stub), stub).toEqual([]);
      expect(() => vaultRoute(stub), stub).toThrow(`neither the vault nor its lens has a getter ${stub}: nothing read`);
    }
    expect(() => doorRoute("renounceOwnership")).toThrow("neither the front door nor its lens has a getter renounceOwnership: nothing read");
    // allowance answers 0 from the vault itself, a pure getter
    expect(vaultRoute("allowance")).toBe("contract");
    // what ops reads of it goes to the vault, the lens's copies (shares, supply, the block time) aside
    for (const name of VAULT_READS.filter((n) => kept.vault.includes(n))) expect(vaultRoute(name), name).toBe("contract");
    for (const name of ["balanceOf", "totalSupply", "MS_PER_BLOCK"]) expect(shapeOf(one(vaultLensAbi(), name))).toBe(shapeOf(one(VAULT_ABI_V32, name)));
    // the front door keeps its own getters (its keeper among them, which its lens serves too), while CascadeBase's
    // (CascadeBaseLens's views, the block time aside, which both keep) are the door lens's alone
    expect(doorRoute("keeper")).toBe("contract");
    expect(shapeOf(one(doorLensAbi(), "keeper"))).toBe(shapeOf(one(frontDoorAbiV32(), "keeper")));
    const base = artifact("CascadeBaseLens").abi.filter((x): x is AbiFunction => x.type === "function").map((f) => f.name);
    expect(base).toContain("guardian");
    for (const name of base.filter((n) => n !== "MS_PER_BLOCK" && n !== "target")) {
      expect(gettersNamed(frontDoorAbiV32(), name), name).toEqual([]);
      expect(doorRoute(name), name).toBe("lens");
    }
  });

  it("readVault and readDoor send each read where its route says, with that contract's ABI", async () => {
    const a = (v32.plan as ReturnType<typeof planV32>).addresses;
    for (const [reads, read, chain, contract, lens, contractAbi, lensAbi, route] of [
      [VAULT_READS, readVault, "bittensor", a.vault, a.vaultLens, VAULT_ABI_V32, vaultLensAbi(), vaultRoute],
      [DOOR_READS, readDoor, "base", a.frontDoor, a.doorLens, frontDoorAbiV32(), doorLensAbi(), doorRoute],
    ] as const) {
      for (const name of reads) {
        const f = fakeRpc();
        const toLens = route(name) === "lens";
        const abi = toLens ? lensAbi : contractAbi;
        await (read as (ctx: unknown, rec: PlannedRecord, fn: string, args: unknown[]) => Promise<unknown>)(f.ctx, v32, name, argsFor(one(abi, name)));
        expect(f.calls, name).toHaveLength(1);
        expect(f.calls[0].chain).toBe(chain);
        expect(f.calls[0].to, name).toBe(toLens ? lens : contract);
        expect(decodeFunctionData({ abi, data: f.calls[0].data }).functionName).toBe(name);
      }
    }
    // the answer is decoded with the same ABI
    const f = fakeRpc({ owner: ROLES.keeper, guardian: getAddress(`0x${"b0".repeat(20)}`), visibleStakeRao: 7_000_000_000n, keeper: getAddress(`0x${"c0".repeat(20)}`) });
    expect(await readVault(f.ctx, v32, "owner")).toBe(ROLES.keeper);
    expect(await readVault(f.ctx, v32, "guardian")).toBe(getAddress(`0x${"b0".repeat(20)}`));
    expect(await readVault(f.ctx, v32, "visibleStakeRao")).toBe(7_000_000_000n);
    expect(await readDoor(f.ctx, v32, "keeper")).toBe(getAddress(`0x${"c0".repeat(20)}`));
    expect(f.calls.map((c) => c.to)).toEqual([a.vault, a.vaultLens, a.vaultLens, a.frontDoor]);
    // the lenses are the plan's
    expect(vaultLens(v32)).toBe(a.vaultLens);
    expect(doorLens(v32)).toBe(a.doorLens);
  });

  it("aV3RecordReadsEverythingFromTheContract: v3-launch's (and v2's) reads go to its vault and front door with its build's ABI, and it has no lens", async () => {
    for (const rec of [v3Launch, v2]) {
      const { vault, frontDoor } = rec.plan.addresses;
      const f = fakeRpc({ guardian: ROLES.guardian.bittensor });
      expect(await readVault(f.ctx, rec, "guardian")).toBe(ROLES.guardian.bittensor);
      await readVault(f.ctx, rec, "keeper");
      await readVault(f.ctx, rec, "totalAssets");
      await readVault(f.ctx, rec, "getPayoutBatch", [KEY]);
      await readVault(f.ctx, rec, "lastClaimAt", [KEY]);
      await readDoor(f.ctx, rec, "guardian");
      await readDoor(f.ctx, rec, "primaryBridge");
      expect(f.calls.map((c) => [c.chain, c.to])).toEqual([
        ...Array(5).fill(["bittensor", vault]),
        ["base", frontDoor],
        ["base", frontDoor],
      ]);
      for (const [c, fn, abi] of [
        [f.calls[0], "guardian", V3_VAULT],
        [f.calls[3], "getPayoutBatch", V3_VAULT],
        [f.calls[5], "guardian", V3_DOOR],
      ] as const) {
        expect(decodeFunctionData({ abi, data: c.data }).functionName).toBe(fn);
      }
      // a getter only v3.2 has is refused, and nothing is read
      const g = fakeRpc();
      await expect(readVault(g.ctx, rec, "doorState", [KEY])).rejects.toThrow("this deployment's vault (a build before v3.2) has no getter doorState: nothing read");
      await expect(readDoor(g.ctx, rec, "scheduled", [KEY])).rejects.toThrow("this deployment's front door (a build before v3.2) has no getter scheduled: nothing read");
      expect(g.calls).toEqual([]);
      expect(() => vaultLens(rec)).toThrow("this deployment is not v3.2's: its contracts serve every getter themselves, and it has no lens");
      expect(() => doorLens(rec)).toThrow(/is not v3.2's/);
    }
  });

  it("writeOffMissingStakeRao: the missing stake less the unlisted, in rao, as read now through the lens (the T16 carry)", async () => {
    const plan = planV32();
    const at = (answers: Record<string, unknown>) => fakeRpc(answers);
    let f = at({ missingStakeRao: 5_000_000n, unlistedStakeRao: 2_000_000n });
    // the amount the vault's check passes with equality: w + unlisted = missing
    expect(await writeOffMissingStakeRao(f.ctx, { plan })).toBe(3_000_000n);
    expect(f.calls.map((c) => c.to)).toEqual([plan.addresses.vaultLens, plan.addresses.vaultLens]);
    expect(f.calls.map((c) => decodeFunctionData({ abi: vaultLensAbi(), data: c.data }).functionName)).toEqual(["missingStakeRao", "unlistedStakeRao"]);
    // all of it could come back by listing a hotkey (or nothing is missing): nothing to write off
    f = at({ missingStakeRao: 2_000_000n, unlistedStakeRao: 2_000_000n });
    expect(await writeOffMissingStakeRao(f.ctx, { plan })).toBe(0n);
    f = at({ missingStakeRao: 0n, unlistedStakeRao: 9n });
    expect(await writeOffMissingStakeRao(f.ctx, { plan })).toBe(0n);
    // the lens reverts when the precompile cannot total the coldkey's stake: refused, never read as 0
    f = at({ missingStakeRao: 5_000_000n, unlistedStakeRao: new RpcError("execution reverted", 3, "0x") });
    await expect(writeOffMissingStakeRao(f.ctx, { plan })).rejects.toThrow(/execution reverted/);
  });
});

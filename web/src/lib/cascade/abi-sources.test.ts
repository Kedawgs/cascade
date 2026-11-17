import { existsSync, readFileSync } from "node:fs";
import type { Abi, AbiEvent, AbiFunction, AbiParameter } from "viem";
import { formatAbiItem } from "viem/utils";
import { describe, expect, it } from "vitest";
import {
  ADAPTER,
  BIT_ADAPTER_V32,
  CANCEL_COOLDOWN_S,
  DOOR_LENS,
  FRONT_DOOR,
  FRONT_DOOR_V32,
  REFUND_CHUNK,
  STAKER,
  STAKER_V32,
  VAULT,
  VAULT_LENS,
  VAULT_V32,
} from "./abi";

// The ABIs the site encodes and decodes with, against the contracts' own (ruling A3): v3.2's against the
// published vault ABI (contracts/abi/CascadeVault.json, the one ops, the indexer and the web use) and the
// build output in contracts/out (the front door, the staker, the lenses and the Bittensor adapter); v3-launch's,
// which stay exactly as they are while it is live, against the build it was deployed from (ops/builds/preaudit).

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as unknown;
const abiOf = (j: unknown): Abi => (Array.isArray(j) ? j : (j as { abi: Abi }).abi) as Abi;
const out = (name: string) => abiOf(read(`../../../../contracts/out/${name}.sol/${name}.json`));
/** contracts/out is forge's build output, which git ignores: on a checkout without a build, the tests that compare
 * with it are skipped and say why (their titles name the missing build), never failing on a missing file. Everything
 * the trail decodes is also checked below against the committed sources (contracts/src, contracts/abi), build or not. */
const BUILT = ["CascadeFrontDoor", "CascadeStaker", "CascadeVaultLens", "CascadeDoorLens", "CcipBittensorAdapter", "CcipBaseAdapter"].every((name) =>
  existsSync(new URL(`../../../../contracts/out/${name}.sol/${name}.json`, import.meta.url)),
);
const withBuild = (title: string) => (BUILT ? title : `${title} [skipped: no forge build in contracts/out; run forge build in contracts/ to run it]`);
const itWithBuild = it.skipIf(!BUILT);

/** The enum types an event takes are uint8 in the ABI (contracts/src/CascadeTypes.sol). */
const ENUMS: Record<string, string> = { Kind: "uint8", BounceReason: "uint8" };
/** The events a committed source file under contracts/src declares, as `Name(type indexed name,...)`, comments
 * stripped: what each event's topic and fields are made from, read without a build. */
function sourceEvents(file: string): Set<string> {
  const text = readFileSync(new URL(`../../../../contracts/src/${file}`, import.meta.url), "utf8").replace(/\/\/[^\n]*/g, "");
  return new Set(
    [...text.matchAll(/\bevent\s+(\w+)\s*\(([^)]*)\)\s*;/g)].map(([, name, params]) => {
      const inputs = params
        .split(",")
        .map((p) => p.trim().split(/\s+/))
        .filter((p) => p[0] !== "")
        .map((p) => `${ENUMS[p[0]] ?? p[0]}${p[1] === "indexed" ? " indexed" : ""} ${p[p.length - 1]}`);
      return `${name}(${inputs.join(",")})`;
    }),
  );
}
const signature = (e: AbiEvent) => `${e.name}(${e.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`).join(",")})`;
const eventsOf = (abi: Abi) => abi.filter((x): x is AbiEvent => x.type === "event").map(signature);
const PUBLISHED_VAULT = abiOf(read("../../../../contracts/abi/CascadeVault.json"));
const PREAUDIT = (read("../../../../ops/builds/preaudit/build.json") as { contracts: Record<string, { abi: Abi }> }).contracts;

type Item = Abi[number];
/** An item's name and canonical input types, as its selector or topic is made from: `closeBatch(uint64,uint256)`. */
const id = (x: Item) => `${x.type} ${formatAbiItem(x as never)}`;
/** A list of parameters' canonical types, tuples spelled out. */
const types = (ps: readonly AbiParameter[] | undefined) => formatAbiItem({ type: "function", name: "", inputs: ps ?? [], outputs: [], stateMutability: "view" });
/** Each event parameter's name and whether it is indexed: the code reads decoded arguments by name. */
const named = (ps: readonly AbiParameter[]) => ps.map((p) => `${(p as { indexed?: boolean }).indexed ? "indexed " : ""}${p.name}`);

/** What of `site` doesn't match `source`: each item missing there by name and input types, a function whose
 * mutability or output types differ, an event whose parameters' names or indexing differ. Empty when all match. */
function mismatches(site: Abi, source: Abi): string[] {
  const byId = new Map(source.filter((x) => x.type === "function" || x.type === "event" || x.type === "error").map((x) => [id(x), x]));
  return site.flatMap((w): string[] => {
    const s = byId.get(id(w));
    if (!s) return [`${id(w)}: not in the contract's ABI`];
    if (w.type === "function") {
      const f = s as AbiFunction;
      const problems = [];
      if (w.stateMutability !== f.stateMutability) problems.push(`${id(w)}: ${w.stateMutability}, the contract's is ${f.stateMutability}`);
      if (types(w.outputs) !== types(f.outputs)) problems.push(`${id(w)}: returns ${types(w.outputs)}, the contract's ${types(f.outputs)}`);
      return problems;
    }
    if (w.type === "event") {
      const e = s as AbiEvent;
      return named(w.inputs).join(",") === named(e.inputs).join(",") ? [] : [`${id(w)}: (${named(w.inputs)}), the contract's (${named(e.inputs)})`];
    }
    return [];
  });
}

describe("v3.2's ABIs are the contracts' (ruling A3)", () => {
  it("the vault's: every item is the published ABI's, the token surface (balanceOf, totalSupply) still on the vault", () => {
    expect(mismatches(VAULT_V32, PUBLISHED_VAULT)).toEqual([]);
    const names = VAULT_V32.filter((x) => x.type === "function").map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["balanceOf", "totalSupply", "paused", "redeemDirect", "setRedeemOrigin"]));
    // the moved getters are the lens's now: none of them is asked of the vault
    for (const moved of ["totalAssets", "pendingPayouts", "stakeHotkey", "payoutDelay", "rewardCutBps", "maxEntryValue", "coldkey", "primaryBridge", "bridgeEnabled"]) {
      expect(names, moved).not.toContain(moved);
      expect(PUBLISHED_VAULT.some((x) => x.type === "function" && x.name === moved), moved).toBe(false);
    }
  });

  it("the vault's events: Task 36b's eight-field PayoutChunkSent, a bounce's reason, a direct exit's acceptedMissing", () => {
    const event = (name: string) => (VAULT_V32 as Abi).find((x): x is AbiEvent => x.type === "event" && x.name === name);
    expect(named(event("PayoutChunkSent")!.inputs)).toEqual(["indexed key", "chunk", "taken", "gross", "net", "fee", "charged", "unstakeCost"]);
    expect(named(event("DepositBounced")!.inputs)).toEqual(["indexed key", "indexed user", "assets", "reason"]);
    expect(named(event("RedeemedDirect")!.inputs)).toEqual(["indexed user", "shares", "assets", "acceptedMissing"]);
    // and the scheduler's events, StakeMissing and the rest the site reads (spec §7, "Website changes")
    for (const name of ["Scheduled", "Executed", "Cancelled", "Lapsed", "Deposited", "Redeemed", "BatchDelivered", "Staked"]) expect(event(name), name).toBeDefined();
    expect(VAULT_V32.some((x) => x.type === "error" && x.name === "StakeMissing")).toBe(true);
  });

  it("each of v3-launch's vault events is in v3.2's with every field under the same name, so one reader by name reads both", () => {
    const fields = (abi: Abi, name: string) => (abi.find((x): x is AbiEvent => x.type === "event" && x.name === name)?.inputs ?? []).map((i) => `${i.indexed ? "indexed " : ""}${i.type} ${i.name}`);
    for (const e of (VAULT as Abi).filter((x): x is AbiEvent => x.type === "event")) {
      const v32 = fields(VAULT_V32 as Abi, e.name);
      expect(v32.slice(0, e.inputs.length), e.name).toEqual(fields(VAULT as Abi, e.name));
    }
  });

  it("every vault event the site decodes, and every one the published ABI lists, is declared once at file level in CascadeEvents.sol (Transfer too), or inherited from OpenZeppelin", () => {
    const declared = sourceEvents("CascadeEvents.sol");
    const OPENZEPPELIN = new Set([
      "Paused(address account)",
      "Unpaused(address account)",
      "OwnershipTransferStarted(address indexed previousOwner,address indexed newOwner)",
      "OwnershipTransferred(address indexed previousOwner,address indexed newOwner)",
    ]);
    const events = eventsOf;
    // the share token's event is the file's own now, not OpenZeppelin's ERC20's (Task 5b)
    expect(declared).toContain("Transfer(address indexed from,address indexed to,uint256 value)");
    expect(declared.size).toBeGreaterThan(40);
    expect(events(VAULT_V32).filter((s) => !declared.has(s))).toEqual([]);
    expect(events(PUBLISHED_VAULT).filter((s) => !declared.has(s) && !OPENZEPPELIN.has(s))).toEqual([]);
  });

  itWithBuild(withBuild("the lenses': each served view is the lens's own, the vault lens with the door's state and the ledger in rao"), () => {
    expect(mismatches(VAULT_LENS, out("CascadeVaultLens"))).toEqual([]);
    expect(mismatches(DOOR_LENS, out("CascadeDoorLens"))).toEqual([]);
    const names = (abi: Abi) => abi.filter((x) => x.type === "function").map((x) => x.name);
    expect(names(VAULT_LENS)).toEqual(
      expect.arrayContaining(["target", "doorState", "primaryBridge", "bridgeEnabled", "visibleStakeRao", "bookedStake", "totalAssets", "pendingPayouts", "stakeHotkey"]),
    );
    // the vesting figures come from the lens, never rebuilt from events (they log nothing)
    expect(names(VAULT_LENS)).toEqual(expect.arrayContaining(["vestingAmount", "vestingStart", "vestingPeriod", "unvestedRewards", "rewardVesting"]));
    // and the adoption drip's, beside the claim schedule's (Revision 27): unvestedRewards is both drips' sum
    expect(names(VAULT_LENS)).toEqual(expect.arrayContaining(["adoptVestingAmount", "adoptVestingStart", "adoptVestingPeriod"]));
    expect(names(DOOR_LENS)).toEqual(["target", "primaryBridge", "bridgeEnabled"]);
  });

  itWithBuild(withBuild("the front door's: closeBatch by id, its two refusals, the seven-field BatchClosed; its bridge getters moved to the door lens"), () => {
    const door = out("CascadeFrontDoor");
    expect(mismatches(FRONT_DOOR_V32, door)).toEqual([]);
    expect(FRONT_DOOR_V32.filter((x) => x.type === "error").map((x) => x.name)).toEqual(expect.arrayContaining(["WrongBatch", "BatchTooSmall"]));
    expect((FRONT_DOOR_V32 as Abi).some((x) => x.type === "function" && (x.name === "primaryBridge" || x.name === "bridgeEnabled"))).toBe(false);
    expect(door.some((x) => x.type === "function" && (x.name === "primaryBridge" || x.name === "bridgeEnabled"))).toBe(false);
  });

  itWithBuild(withBuild("the staker's, with its buy floor's errors; the Bittensor adapter's park events and REFUND_CHUNK"), () => {
    // a stake passes back the front door errors its deposit can revert with, so the site lists those too
    const doorErrors = out("CascadeFrontDoor").filter((x) => x.type === "error");
    expect(mismatches(STAKER_V32, [...out("CascadeStaker"), ...doorErrors])).toEqual([]);
    expect(STAKER_V32.filter((x) => x.type === "error").map((x) => x.name)).toEqual(expect.arrayContaining(["BelowOracleFloor", "NoOracle"]));
    const bit = out("CcipBittensorAdapter");
    expect(mismatches(BIT_ADAPTER_V32, bit)).toEqual([]);
    expect(mismatches(ADAPTER, bit)).toEqual([]);
    expect(mismatches(ADAPTER.filter((x) => x.type === "function"), out("CcipBaseAdapter"))).toEqual([]);
    // and its events, which the trail reads on Base (a close's Sent) and on Bittensor (a run's Delivered)
    expect(mismatches(ADAPTER.filter((x) => x.type === "event"), out("CcipBaseAdapter"))).toEqual([]);
    const source = readFileSync(new URL("../../../../contracts/src/adapters/CcipBittensorAdapter.sol", import.meta.url), "utf8");
    expect(source).toMatch(/uint32 public constant REFUND_CHUNK = type\(uint32\)\.max;/);
    expect(REFUND_CHUNK).toBe(2 ** 32 - 1);
  });
});

describe("R11: the cancel cooldown as the committed sources declare it, with or without a build", () => {
  const src = (file: string) => readFileSync(new URL(`../../../../contracts/src/${file}`, import.meta.url), "utf8").replace(/\/\/[^\n]*/g, "");
  /** "function cancelableAt(address) view returns (uint256)", "error CancelTooSoon(uint256)": the item's kind, its
   * selector's signature, and a function's mutability and output types. */
  const sig = (abi: Abi, type: "function" | "error", name: string) => {
    const x = abi.find((i) => i.type === type && i.name === name);
    if (!x) return undefined;
    if (x.type !== "function") return `${x.type} ${formatAbiItem(x as never)}`;
    return `function ${formatAbiItem(x as never)} ${x.stateMutability} returns (${x.outputs.map((o) => o.type).join(",")})`;
  };

  it("cancelableAt(address) and CANCEL_COOLDOWN, five minutes, are the door's views; CancelTooSoon(uint256) its refusal, decoded by position", () => {
    const door = src("CascadeFrontDoor.sol");
    expect(door).toMatch(/function cancelableAt\(address user\) (external|public) view returns \(uint256\)/);
    expect(door).toMatch(/uint64 public constant CANCEL_COOLDOWN = 5 minutes;/);
    expect(src("CascadeErrors.sol")).toMatch(/error CancelTooSoon\(uint256 \w+\);/);
    expect(sig(FRONT_DOOR_V32, "function", "cancelableAt")).toBe("function cancelableAt(address) view returns (uint256)");
    expect(sig(FRONT_DOOR_V32, "function", "CANCEL_COOLDOWN")).toBe("function CANCEL_COOLDOWN() view returns (uint64)");
    expect(sig(FRONT_DOOR_V32, "error", "CancelTooSoon")).toBe("error CancelTooSoon(uint256)");
    expect(CANCEL_COOLDOWN_S).toBe(5 * 60);
    // v3-launch's front door has no cooldown, so its list stays as it was
    expect(sig(FRONT_DOOR, "function", "cancelableAt")).toBeUndefined();
  });

  it("what else a cancel can refuse is listed too, so its pre-send check names it: a cancel above the entry, one that would leave less than the minimum", () => {
    for (const name of ["InsufficientRequest", "BelowMinDeposit"]) expect(sig(FRONT_DOOR_V32, "error", name), name).toBe(`error ${name}()`);
    // and the redeem list's limit, which a request's own close of a full list depends on (ChatGPT r3, section 2)
    expect(sig(FRONT_DOOR_V32, "function", "maxRedeems")).toBe("function maxRedeems() view returns (uint32)");
    expect(src("CascadeFrontDoor.sol")).toMatch(/uint32 public maxRedeems;/);
  });
});

/** R12d (M3), the ship gate: the site's build-B words, pinned to what the front door's source does. Both FAIL on the R11
 * door (this branch's contracts/src until the build-B door merges) and pass once it is in: a site that says them must
 * never ship beside a door that doesn't. */
describe("R12d (M3) BUILD-B SHIP GATE, expected to fail until the build-B door merges: the semantics the site's words rely on, in the door's source", () => {
  const door = readFileSync(new URL("../../../../contracts/src/CascadeFrontDoor.sol", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  /** The body of the door's function `name`, braces matched, comments stripped: what runs. */
  const body = (name: string) => {
    const at = door.search(new RegExp(`\\bfunction ${name}\\(`));
    expect(at, name).toBeGreaterThan(0);
    const open = door.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < door.length; i++) {
      if (door[i] === "{") depth++;
      else if (door[i] === "}" && --depth === 0) return door.slice(open, i + 1);
    }
    throw new Error(`no end to ${name}`);
  };

  it("BUILD-B GATE (fails on the R11 door): cancelableAt reads 0 while the door is paused or its primary bridge is disabled, the FAQ's 'or at once while deposits are paused' and the receipt's CANCEL_AT_ONCE", () => {
    expect(body("cancelableAt")).toContain("if (paused() || !bridgeEnabled[primaryBridge]) return 0;");
  });

  it("BUILD-B GATE (fails on the R11 door): canClose finds the deposit list full at half its limit, units.ts's depositLimitsReached and closeFirstFloor", () => {
    expect(body("canClose")).toContain("2 * open.deposits.length >= maxDeposits");
  });
});

describe("the events the trail decodes are the committed sources' own, with or without a build (Task 58 review, Minors 1 and 6)", () => {
  it("v3.2's front door's: a v3.2 event whose signature changes fails here, so its logs are never read with a stale topic", () => {
    const door = sourceEvents("CascadeFrontDoor.sol");
    expect(door.size).toBeGreaterThan(15);
    expect(eventsOf(FRONT_DOOR_V32).filter((s) => !door.has(s))).toEqual([]);
    // it sees a change: v3-launch's six-field BatchClosed isn't the source's any more
    expect(eventsOf(FRONT_DOOR).filter((s) => !door.has(s))).toEqual([
      "BatchClosed(uint64 indexed id,uint256 totalDeposits,uint256 nDeposits,uint256 nRedeems,uint256 fee,uint256 potUsed)",
    ]);
  });

  it("both adapters': the Sent and Delivered every adapter emits, and the Bittensor adapter's park events", () => {
    const base = sourceEvents("adapters/CcipAdapterBase.sol");
    const bit = new Set([...base, ...sourceEvents("adapters/CcipBittensorAdapter.sol")]);
    expect(eventsOf(ADAPTER).filter((s) => !base.has(s))).toEqual([]);
    expect(eventsOf(BIT_ADAPTER_V32).filter((s) => !bit.has(s))).toEqual([]);
  });

  it("facts.ts decodes the front door's logs, and builds their topics, with the deployment's own ABI, never v3-launch's by name", () => {
    const facts = readFileSync(new URL("./facts.ts", import.meta.url), "utf8");
    expect(facts).not.toMatch(/\bFRONT_DOOR\b(?!_V32)/);
    expect(facts).toMatch(/frontDoorAbi\(d\)/);
  });
});

describe("v3-launch's ABIs are still the build it was deployed from", () => {
  it("the front door's, the vault's, the staker's and the adapters'", () => {
    expect(mismatches(FRONT_DOOR, PREAUDIT.CascadeFrontDoor.abi)).toEqual([]);
    expect(mismatches(VAULT, PREAUDIT.CascadeVault.abi)).toEqual([]);
    expect(mismatches(STAKER, [...PREAUDIT.CascadeStaker.abi, ...PREAUDIT.CascadeFrontDoor.abi.filter((x) => x.type === "error")])).toEqual([]);
    expect(mismatches(ADAPTER, PREAUDIT.CcipBittensorAdapter.abi)).toEqual([]);
    expect(mismatches(ADAPTER.filter((x) => x.type === "function"), PREAUDIT.CcipBaseAdapter.abi)).toEqual([]);
  });

  it("and the comparison sees a difference (it isn't reading nothing)", () => {
    expect(mismatches(FRONT_DOOR_V32.filter((x) => x.type === "function" && x.name === "closeBatch"), PREAUDIT.CascadeFrontDoor.abi)).toHaveLength(1);
    expect(mismatches(VAULT.filter((x) => x.type === "event" && x.name === "PayoutChunkSent"), PUBLISHED_VAULT)).toHaveLength(1);
    expect(mismatches(VAULT.filter((x) => x.type === "function" && x.name === "rootStakeRao"), PUBLISHED_VAULT)).toHaveLength(1);
  });
});

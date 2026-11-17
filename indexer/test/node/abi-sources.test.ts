import { readdirSync, readFileSync } from "node:fs";
import { type Abi, type AbiEvent, type AbiFunction, type AbiParameter, toEventSelector, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_PEER_VIEWS,
  ADMIN_EVENTS,
  ADMIN_EVENTS_V31,
  ADMIN_VIEWS,
  abiFor,
  EXECUTE_WINDOW_S,
  INSTRUMENTS,
  instrumentOf,
  MAX_HOTKEYS,
  SCHEDULABLE,
  SCHEDULER_EVENTS,
  schedulableOf,
  BIT_ADAPTER_V32_VIEWS,
  BIT_RAIL_VIEWS,
  BRIDGE_VIEWS,
  DOOR_LENS_VIEWS,
  FRONT_DOOR_V32_VIEWS,
  HALF_LAUNCH_SHARES_PER_WEI,
  LIMIT_SETTERS,
  limitSetterOf,
  ORACLE_V32,
  STAKE_RAMP_S,
  TREASURY,
  UNDERWATER_TOLERANCE_WEI,
  VAULT_LENS_VIEWS,
  VAULT_V32_VIEWS,
} from "../../src/abi.ts";
import type { OwnRole } from "../../src/config.ts";
import { BITTENSOR_BLOCK_S, PARK_TIMEOUT_S, REASON_SIGNATURES, REFUND_CHUNK } from "../../src/parks.ts";
import { DEFAULTS } from "../../src/thresholds.ts";
import { pkg } from "./files.ts";

/** The contract sources each role is built from (inherited OpenZeppelin events aside): v3-launch's, frozen in
 * ops/builds/preaudit, since contracts/ now holds v3.2. */
const SOURCES: Record<OwnRole, string[]> = {
  vault: ["CascadeVault.sol", "CascadeBase.sol"],
  frontDoor: ["CascadeFrontDoor.sol", "CascadeBase.sol"],
  staker: ["CascadeStaker.sol"],
  baseAdapter: ["adapters/CcipAdapterBase.sol", "adapters/CcipBaseAdapter.sol"],
  bitAdapter: ["adapters/CcipAdapterBase.sol", "adapters/CcipBittensorAdapter.sol"],
};

/** Events each role inherits from OpenZeppelin (ERC20, Pausable, Ownable2Step), not in contracts/src. */
const OWNABLE2STEP = [
  "OwnershipTransferStarted(address indexed previousOwner,address indexed newOwner)",
  "OwnershipTransferred(address indexed previousOwner,address indexed newOwner)",
];
const OPENZEPPELIN: Record<OwnRole, string[]> = {
  vault: ["Transfer(address indexed from,address indexed to,uint256 value)", "Paused(address account)", "Unpaused(address account)", ...OWNABLE2STEP],
  frontDoor: ["Paused(address account)", "Unpaused(address account)", ...OWNABLE2STEP],
  staker: OWNABLE2STEP,
  baseAdapter: [],
  bitAdapter: [],
};

/** Solidity types that are enums in the sources, encoded as uint8 in the ABI. */
const ENUMS: Record<string, string> = { RouterKind: "uint8", Kind: "uint8", BounceReason: "uint8" };

/** Every `event Name(...)` declared in a source, as "Name(type [indexed] name,...)": the parameter names
 * count, since the code reads decoded arguments by name. `root` is the source tree (v3-launch's frozen one by
 * default, or contracts/src for v3.2). */
function declared(file: string, root = "../ops/builds/preaudit/src"): string[] {
  const text = readFileSync(pkg(`${root}/${file}`), "utf8").replace(/\/\/[^\n]*/g, "");
  return [...text.matchAll(/\bevent\s+(\w+)\s*\(([^)]*)\)\s*;/g)].map(([, name, params]) => {
    const inputs = params
      .split(",")
      .map((p) => p.trim().split(/\s+/))
      .filter((p) => p[0] !== "")
      .map((p) => `${ENUMS[p[0]] ?? p[0]}${p[1] === "indexed" ? " indexed" : ""} ${p[p.length - 1]}`);
    return `${name}(${inputs.join(",")})`;
  });
}

const signature = (e: AbiEvent) => `${e.name}(${e.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`).join(",")})`;
const events = (role: OwnRole) => abiFor(role).filter((x): x is AbiEvent => x.type === "event");

describe("the ABIs match the contracts' sources", () => {
  for (const role of Object.keys(SOURCES) as OwnRole[]) {
    it(`${role}: every event in its ABI is declared in its sources (or inherited from OpenZeppelin)`, () => {
      const inSources = new Set([...SOURCES[role].flatMap((f) => declared(f)), ...OPENZEPPELIN[role]]);
      expect(events(role).map(signature).filter((s) => !inSources.has(s))).toEqual([]);
    });

    it(`${role}: every event declared in its sources is in its ABI`, () => {
      const inAbi = new Set(events(role).map(signature));
      const missing = [...SOURCES[role].flatMap((f) => declared(f)), ...OPENZEPPELIN[role]].filter((s) => !inAbi.has(s));
      expect(missing).toEqual([]);
    });
  }

  it("every v3-launch admin event is in its role's ABI, and is declared in its sources or inherited", () => {
    expect(ADMIN_EVENTS_V31.size).toBeGreaterThan(30);
    for (const key of ADMIN_EVENTS_V31) {
      const [role, name] = key.split(":") as [OwnRole, string];
      expect(events(role).map((e) => e.name), key).toContain(name);
      const names = [...SOURCES[role].flatMap((f) => declared(f)), ...OPENZEPPELIN[role]].map((s) => s.slice(0, s.indexOf("(")));
      expect(names, key).toContain(name);
    }
  });

  it("finds the sources' events at all (the parser isn't reading nothing)", () => {
    expect(declared("CascadeVault.sol").length).toBeGreaterThan(30);
    expect(declared("CascadeStaker.sol")).toContain("Staked(address indexed payer,address indexed beneficiary,uint256 usdcIn,uint256 fees,uint256 taoDeposited)");
  });

  it("a deployment with no version decodes with v3-launch's (v3.1's) events: its six-field PayoutChunkSent", () => {
    for (const role of Object.keys(SOURCES) as OwnRole[]) expect(abiFor(role)).toBe(abiFor(role, "v3.1"));
    expect(events("vault").map(signature)).toContain("PayoutChunkSent(bytes32 indexed key,uint32 chunk,uint32 taken,uint256 gross,uint256 net,uint256 fee)");
  });
});

// v3.2: the published vault ABI (the vault merged with its libraries' events and errors, script/merge-abi.mjs) and the
// build output in contracts/out, copied in from the same commit as contracts/src (never rebuilt here).

const V32_SRC = "../contracts/src";
const LIBRARIES = readdirSync(pkg(`${V32_SRC}/libraries`)).filter((f) => f.endsWith(".sol")).map((f) => `libraries/${f}`);

/** The ABI each v3.2 role decodes with: the merged vault ABI, the others' build output. */
const V32_ARTIFACTS: Record<OwnRole, string> = {
  vault: "abi/CascadeVault.json",
  frontDoor: "out/CascadeFrontDoor.sol/CascadeFrontDoor.json",
  staker: "out/CascadeStaker.sol/CascadeStaker.json",
  baseAdapter: "out/CcipBaseAdapter.sol/CcipBaseAdapter.json",
  bitAdapter: "out/CcipBittensorAdapter.sol/CcipBittensorAdapter.json",
};

/** The v3.2 sources each role's events are declared in: every event of CascadeBase, the vault, its share token and
 * its libraries is declared once at file level in CascadeEvents.sol (spec §8.1); the shares, base, vault and library
 * files are read too, so an event declared in one of them can't go unseen. */
const V32_SOURCES: Record<OwnRole, string[]> = {
  vault: ["CascadeEvents.sol", "CascadeShares.sol", "CascadeBase.sol", "CascadeVault.sol", ...LIBRARIES],
  frontDoor: ["CascadeEvents.sol", "CascadeBase.sol", "CascadeFrontDoor.sol"],
  staker: ["CascadeStaker.sol"],
  baseAdapter: ["adapters/CcipAdapterBase.sol", "adapters/CcipBaseAdapter.sol"],
  bitAdapter: ["adapters/CcipAdapterBase.sol", "adapters/CcipBittensorAdapter.sol"],
};

/** v3.2's OpenZeppelin events: Transfer left the list, CascadeEvents.sol declares it (the minimal share token). */
const OPENZEPPELIN_V32: Record<OwnRole, string[]> = {
  vault: ["Paused(address account)", "Unpaused(address account)", ...OWNABLE2STEP],
  frontDoor: ["Paused(address account)", "Unpaused(address account)", ...OWNABLE2STEP],
  staker: OWNABLE2STEP,
  baseAdapter: [],
  bitAdapter: [],
};

const artifact = (file: string): Abi => {
  const j = JSON.parse(readFileSync(pkg(`../contracts/${file}`), "utf8"));
  return (Array.isArray(j) ? j : j.abi) as Abi;
};
const artifactEvents = (role: OwnRole) => artifact(V32_ARTIFACTS[role]).filter((x): x is AbiEvent => x.type === "event");
const events32 = (role: OwnRole) => abiFor(role, "v3.2").filter((x): x is AbiEvent => x.type === "event");
const v32Declared = (role: OwnRole) => V32_SOURCES[role].flatMap((f) => declared(f, V32_SRC));

/** The events CascadeBase.sol imports from CascadeEvents.sol (the vault's and the front door's base events), as
 * CascadeEvents.sol declares them. */
function baseImports(): string[] {
  const base = readFileSync(pkg(`${V32_SRC}/CascadeBase.sol`), "utf8");
  const m = base.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/CascadeEvents\.sol"/);
  const names = (m?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const all = declared("CascadeEvents.sol", V32_SRC);
  return names.map((n) => {
    const s = all.find((x) => x.startsWith(`${n}(`));
    if (!s) throw new Error(`CascadeBase.sol imports ${n}, which CascadeEvents.sol doesn't declare`);
    return s;
  });
}

describe("the v3.2 ABIs match the published ABI, contracts/out and contracts/src", () => {
  for (const role of Object.keys(V32_ARTIFACTS) as OwnRole[]) {
    it(`${role}: its events are its ABI's, both ways, by signature and parameter names, so every topic 0 is the ABI's`, () => {
      expect(events32(role).map(signature).sort()).toEqual(artifactEvents(role).map(signature).sort());
      expect(new Set(events32(role).map((e) => toEventSelector(e)))).toEqual(new Set(artifactEvents(role).map((e) => toEventSelector(e))));
    });

    it(`${role}: each of its events is declared in its v3.2 sources (or inherited from OpenZeppelin)`, () => {
      const inSources = new Set([...v32Declared(role), ...OPENZEPPELIN_V32[role]]);
      expect(events32(role).map(signature).filter((s) => !inSources.has(s))).toEqual([]);
    });
  }

  // the reverse, as v3.1's tests have it: an event a v3.2 source declares can't go unseen behind a stale contracts/out.
  // The front door's base events are the ones CascadeBase.sol imports from CascadeEvents.sol (which also declares the
  // vault's); the vault's own reverse check is the one below.
  for (const role of ["frontDoor", "staker", "baseAdapter", "bitAdapter"] as const) {
    it(`${role}: every event its v3.2 sources declare (or it inherits from OpenZeppelin) is in its list`, () => {
      const inAbi = new Set(events32(role).map(signature));
      const own = V32_SOURCES[role].filter((f) => f !== "CascadeEvents.sol").flatMap((f) => declared(f, V32_SRC));
      const imported = role === "frontDoor" ? baseImports() : [];
      expect([...own, ...imported, ...OPENZEPPELIN_V32[role]].filter((s) => !inAbi.has(s))).toEqual([]);
      if (role === "frontDoor") expect(imported.length).toBeGreaterThanOrEqual(11);
    });
  }

  it("the vault: every event CascadeEvents.sol declares is in its ABI, the libraries' too (they log at the vault's address)", () => {
    const inAbi = new Set(events32("vault").map(signature));
    expect(declared("CascadeEvents.sol", V32_SRC).filter((s) => !inAbi.has(s))).toEqual([]);
    expect(declared("CascadeEvents.sol", V32_SRC).length).toBeGreaterThan(45);
    // no library, nor the share token, declares an event of its own: each is declared once, at file level
    for (const f of [...LIBRARIES, "CascadeShares.sol", "CascadeVault.sol", "CascadeBase.sol"]) expect(declared(f, V32_SRC), f).toEqual([]);
    expect(LIBRARIES.length).toBeGreaterThanOrEqual(4);
  });

  it("Transfer is CascadeEvents.sol's, not OpenZeppelin's (the minimal share token)", () => {
    expect(declared("CascadeEvents.sol", V32_SRC)).toContain("Transfer(address indexed from,address indexed to,uint256 value)");
    expect(OPENZEPPELIN_V32.vault.some((s) => s.startsWith("Transfer("))).toBe(false);
  });

  it("decodes every event v3.2 adds or changes, with its new fields", () => {
    const has = (role: OwnRole, sig: string) => expect(events32(role).map(signature), `${role} ${sig}`).toContain(sig);
    for (const sig of [
      "Scheduled(bytes32 indexed id,uint8 kind,bytes4 indexed selector,uint64 readyAt,bytes data)",
      "Executed(bytes32 indexed id)",
      "Cancelled(bytes32 indexed id,address indexed by)",
      "Lapsed(bytes32 indexed id)",
      "StampedBySig(uint64 asOf,address indexed relayer)",
      "ExitsClosed(address indexed by,bytes4 indexed instrument)",
      "ExitsReopened(bytes4 indexed instrument)",
    ]) {
      has("vault", sig);
      has("frontDoor", sig);
    }
    for (const sig of [
      "StakeAdopted(uint256 rao)",
      "StakeWrittenOff(uint256 rao)",
      "RedeemOriginSet(address indexed user,uint64 chain)",
      "UnstakeSkipped(bytes32 indexed hotkey)",
      "ShortfallAbsorbed(uint256 amount)",
      "DepositBounced(bytes32 indexed key,address indexed user,uint256 assets,uint8 reason)",
      "RedeemedDirect(address indexed user,uint256 shares,uint256 assets,bool acceptedMissing)",
      "PayoutBatchCancelled(bytes32 indexed key,uint256 reminted,uint32 bouncesCarried)",
      "PayoutChunkSent(bytes32 indexed key,uint32 chunk,uint32 taken,uint256 gross,uint256 net,uint256 fee,uint256 charged,uint256 unstakeCost)",
      "LimitSet(bytes4 indexed selector,uint256 a,uint256 b)",
      "OutflowLimitsSet(uint256 bps,uint256 minDaily,uint256 globalBps)",
    ]) {
      has("vault", sig);
    }
    has("frontDoor", "BatchClosed(uint64 indexed id,uint256 totalDeposits,uint256 nDeposits,uint256 nRedeems,uint256 fee,uint256 potUsed,uint256 potCarried)");
    has("frontDoor", "PotSwept(uint256 amount)");
    for (const sig of [
      "BatchParked(bytes32 indexed key,bytes32 indexed messageId,address recipient,address sender,uint256 amount,bool converted,bytes4 reason)",
      "ParkedConverted(bytes32 indexed key)",
      "ParkedDelivered(bytes32 indexed key)",
      "ParkedRefunded(bytes32 indexed key,bytes32 indexed messageId)",
      "ParkedDropped(bytes32 indexed key)",
      "ShortfallCovered(uint256 amount)",
    ]) {
      has("bitAdapter", sig);
    }
    has("bitAdapter", "SurplusSwept(uint256 native,uint256 tokens)");
    has("baseAdapter", "SurplusSwept(uint256 native,uint256 tokens)");
    // v3.1's shapes are gone from v3.2's lists (their topics changed)
    expect(events32("vault").map(signature)).not.toContain("LimitSet(bytes32 indexed name,uint256 a,uint256 b)");
    expect(events32("vault").map((e) => e.name)).not.toContain("FrontDoorRedeemsAllowed");
  });
});

/** A parameter's canonical type, tuples spelled out. */
const canon = (p: AbiParameter): string =>
  p.type.startsWith("tuple") ? `(${((p as { components: readonly AbiParameter[] }).components ?? []).map(canon).join(",")})${p.type.slice(5)}` : p.type;

/** Each view the readings call is the artifact's: one function of that name and inputs, a view (or pure), with the same
 * outputs (what it decodes). */
function expectViews(abi: Abi, file: string, only?: string[]) {
  const theirs = artifact(file).filter((x): x is AbiFunction => x.type === "function");
  const ours = abi.filter((x): x is AbiFunction => x.type === "function" && (!only || only.includes(x.name)));
  expect(ours.length, file).toBeGreaterThan(0);
  for (const f of ours) {
    const match = theirs.filter((t) => toFunctionSelector(t) === toFunctionSelector(f));
    expect(match, `${file}: ${f.name}`).toHaveLength(1);
    expect(["view", "pure"], `${file}: ${f.name}`).toContain(match[0].stateMutability);
    expect(f.outputs.map(canon), `${file}: ${f.name} outputs`).toEqual(match[0].outputs.map(canon));
  }
}

describe("the v3.2 views the readings call are the contracts' (contracts/out and the published vault ABI)", () => {
  it("the vault itself keeps only the token, ownership and pause surface and launchChain", () => {
    expectViews(VAULT_V32_VIEWS, "abi/CascadeVault.json");
    // a moved getter answers only through the lens
    const vaultFns = artifact("abi/CascadeVault.json").filter((x): x is AbiFunction => x.type === "function").map((f) => f.name);
    for (const moved of ["price", "totalAssets", "guardian", "keeper", "getPayoutBatch", "rootStakeRao", "visibleStakeRao", "pendingGuardian"]) expect(vaultFns).not.toContain(moved);
  });

  it("the vault lens serves every moved getter the readings use, the ledger views, the holds and clocks and the scheduler", () => {
    expectViews(VAULT_LENS_VIEWS, "out/CascadeVaultLens.sol/CascadeVaultLens.json");
    // the ramp's clock beside the ramp, and the lens's target (checked against DEPLOYMENT.vault on every reading)
    const names = (VAULT_LENS_VIEWS as Abi).filter((x): x is AbiFunction => x.type === "function").map((f) => f.name);
    for (const n of ["rampingStake", "lastStakeAt", "target"]) expect(names, n).toContain(n);
    // the adoption drip beside the claim schedule (Revision 27): its three raw fields, as the claim schedule's
    for (const n of ["vestingAmount", "vestingStart", "vestingPeriod", "adoptVestingAmount", "adoptVestingStart", "adoptVestingPeriod"]) expect(names, n).toContain(n);
  });

  it("the door lens serves the front door's base state, holds, clocks and scheduler, and its target", () => {
    expectViews(DOOR_LENS_VIEWS, "out/CascadeDoorLens.sol/CascadeDoorLens.json");
    expect((DOOR_LENS_VIEWS as Abi).filter((x): x is AbiFunction => x.type === "function").map((f) => f.name)).toContain("target");
  });

  it("the front door, the adapters, the oracle and the staker", () => {
    expectViews(FRONT_DOOR_V32_VIEWS, "out/CascadeFrontDoor.sol/CascadeFrontDoor.json");
    expectViews(BIT_ADAPTER_V32_VIEWS, "out/CcipBittensorAdapter.sol/CcipBittensorAdapter.json");
    expectViews(BRIDGE_VIEWS, "out/CcipBittensorAdapter.sol/CcipBittensorAdapter.json");
    expectViews(BRIDGE_VIEWS, "out/CcipBaseAdapter.sol/CcipBaseAdapter.json");
    expectViews(ADAPTER_PEER_VIEWS, "out/CcipBittensorAdapter.sol/CcipBittensorAdapter.json");
    expectViews(ADAPTER_PEER_VIEWS, "out/CcipBaseAdapter.sol/CcipBaseAdapter.json");
    // R4-O's fix round (Minor 8): each half's setup, and on Bittensor its AlphaVault
    expect(ADAPTER_PEER_VIEWS.map((x) => (x as { name: string }).name)).toEqual(["remoteAdapter", "remoteChainId", "router", "token", "remoteSelector"]);
    expectViews(BIT_RAIL_VIEWS, "out/CcipBittensorAdapter.sol/CcipBittensorAdapter.json");
    expect(BIT_RAIL_VIEWS.map((x) => (x as { name: string }).name)).toContain("alphaVault");
    expectViews(ORACLE_V32, "out/CascadeTwapOracle.sol/CascadeTwapOracle.json");
    expectViews([...ADMIN_VIEWS, ...TREASURY], "out/CascadeStaker.sol/CascadeStaker.json", ["owner", "pendingOwner", "treasury"]);
  });
});

describe("the v3.2 constants no ABI exposes are contracts/src's", () => {
  // the Worker can't read the sources, so each value is written once in src/abi.ts and read back from the source here:
  // any difference fails
  const source = (file: string) => readFileSync(pkg(`${V32_SRC}/${file}`), "utf8");
  const UNITS: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86_400 };

  it("STAKE_RAMP_S is CascadeVault.sol's STAKE_RAMP (CascadeConstants.sol's since R4, shared with the batch library)", () => {
    expect(source("CascadeVault.sol"), "the vault's STAKE_RAMP is CascadeConstants.sol's").toMatch(/uint256 internal constant STAKE_RAMP = Constants\.STAKE_RAMP;/);
    const m = source("CascadeConstants.sol").match(/^uint256 constant STAKE_RAMP = ([\d_]+)\s*(seconds|minutes|hours|days)?;/m);
    expect(m, "STAKE_RAMP's declaration changed shape: read it again").not.toBeNull();
    expect(STAKE_RAMP_S).toBe(Number(m![1].replaceAll("_", "")) * UNITS[m![2] ?? "seconds"]);
  });

  it("vault.deposits_refused's line is CascadeVault.sol's: below half the launch price, depositDirect and a delivery alike", () => {
    const vault = source("CascadeVault.sol");
    const direct = vault.match(/if \(assetsBefore \* ([\d_]+) < supply \|\|/);
    const delivery = vault.match(/insolvent: A \* ([\d_]+) < S,/);
    expect(direct && delivery, "the half-launch-price line changed shape: read it again").toBeTruthy();
    for (const m of [direct!, delivery!]) expect(HALF_LAUNCH_SHARES_PER_WEI).toBe(BigInt(m[1].replaceAll("_", "")));
  });

  it("oracle.cardinality's floor (1,801) is the oracle's own MIN_CARDINALITY, its 30-minute window (TWAP_WINDOW) at one observation a second plus one (Revision 28); v3.2 also reads its oracle's MIN_CARDINALITY live, so a raised one needs no change here", () => {
    const w = source("CascadeTwapOracle.sol").match(/uint32 public constant TWAP_WINDOW = ([\d_]+);/);
    expect(w, "TWAP_WINDOW's declaration changed shape: read it again").not.toBeNull();
    expect(source("CascadeTwapOracle.sol")).toMatch(/uint16 public constant MIN_CARDINALITY = uint16\(TWAP_WINDOW \+ 1\);/);
    expect(DEFAULTS.oracleMinCardinality).toBe(Number(w![1].replaceAll("_", "")) + 1);
    expect(DEFAULTS.oracleMinCardinality).toBe(1_801);
  });

  it("UNDERWATER_TOLERANCE_WEI is CascadeConstants.sol's UNDERWATER_TOLERANCE (in RAO)", () => {
    const text = source("CascadeConstants.sol");
    const rao = text.match(/uint256 constant RAO = 1e(\d+);/);
    const tol = text.match(/uint256 constant UNDERWATER_TOLERANCE = ([\d_]+) \* RAO;/);
    expect(rao && tol, "RAO or UNDERWATER_TOLERANCE changed shape: read them again").toBeTruthy();
    expect(UNDERWATER_TOLERANCE_WEI).toBe(BigInt(tol![1].replaceAll("_", "")) * 10n ** BigInt(rao![1]));
  });

  it("the rules that use them are the contracts' (CascadeFormulas.underwater and unspent, as the indexer rebuilds them)", () => {
    const f = source("libraries/CascadeFormulas.sol").replace(/\s+/g, " ");
    expect(f).toContain("function underwater(uint256 gross, uint256 pendingPayouts, uint256 unvested) internal pure returns (bool) { if (unvested != 0) return unvested > sub0(gross, pendingPayouts); return sub0(pendingPayouts, gross) > UNDERWATER_TOLERANCE; }");
    expect(f).toContain("uint256 elapsed = block.timestamp - start; return elapsed >= period ? 0 : amount * (period - elapsed) / period;");
    // the allowance base: the ramp is spent over STAKE_RAMP from lastStakeAt
    expect(source("CascadeVault.sol")).toContain("_unspent(ledger.ramping, lastStakeAt, STAKE_RAMP)");
    const vault = source("CascadeVault.sol").replace(/\s+/g, " ");
    // a deposit at a supply above 0 refuses at assets 0 (the half-launch line), so any shortfall counts there
    expect(vault).toContain("if (assetsBefore * 2_000_000 < supply || CascadeFormulas.underwater(grossBefore, ledger.pending, unvested)) {");
    // the unvested rewards are both drips' (Revision 27): the claim schedule and the adoption drip, on the vault and
    // on the lens the solvency rule reads
    expect(vault).toContain("function unvestedRewards() internal view returns (uint256) { return _claimUnvested() + _adoptionUnvested(); }");
    expect(source("lens/CascadeVaultLens.sol").replace(/\s+/g, " ")).toContain(
      "function unvestedRewards() public view returns (uint256) { return CascadeFormulas.unvestedRewards(vestingAmount(), vestingStart(), vestingPeriod()) + CascadeFormulas.unvestedRewards(adoptVestingAmount(), adoptVestingStart(), adoptVestingPeriod()); }",
    );
    // at a supply of 0 both drips are first written down, in all, to what the gross holds beyond the payouts, so only
    // the payouts count there; both mint paths read the unvested rewards through it before their underwater check
    expect(vault).toContain(
      "function _unvestedForMint(uint256 grossBefore, uint256 supply) internal returns (uint256 unvested) { uint256 own = _claimUnvested(); unvested = own + _adoptionUnvested(); if (supply == 0) { uint256 cover = _sub0(grossBefore, ledger.pending); if (unvested > cover) { _vestAdoption(_sub0(cover, own)); if (own > cover) _vest(cover); unvested = cover; } } }",
    );
    expect(vault).toContain("uint256 unvested = _unvestedForMint(grossBefore, supply);");
    expect(vault).toContain("uint256 unvested = _unvestedForMint(grossBefore, S);");
  });
});

describe("the v3.2 vault's LimitSet names its setter by selector", () => {
  /** Each `emit LimitSet(this.<setter>.selector, ...)` in the vault's source. */
  const emitted = [...readFileSync(pkg(`${V32_SRC}/CascadeVault.sol`), "utf8").matchAll(/emit\s+LimitSet\(\s*this\.(\w+)\.selector/g)].map(([, n]) => n);

  it("knows every setter the vault logs LimitSet for, and no other", () => {
    expect(emitted.length).toBeGreaterThanOrEqual(10);
    expect([...LIMIT_SETTERS.values()].sort()).toEqual([...new Set(emitted)].sort());
  });

  it("each selector is the published ABI's function's", () => {
    const fns = artifact("abi/CascadeVault.json").filter((x): x is AbiFunction => x.type === "function");
    for (const [selector, name] of LIMIT_SETTERS) {
      const f = fns.filter((x) => x.name === name);
      expect(f, name).toHaveLength(1);
      expect(toFunctionSelector(f[0]), name).toBe(selector);
    }
  });

  it("reads the setter from the decoded bytes4 or from the 32-byte topic it sits in", () => {
    const [selector, name] = [...LIMIT_SETTERS][0];
    expect(limitSetterOf(selector)).toBe(name);
    expect(limitSetterOf(`${selector}${"0".repeat(56)}`)).toBe(name);
    expect(limitSetterOf(selector.toUpperCase().replace("0X", "0x"))).toBe(name);
    expect(limitSetterOf("0x12345678")).toBeUndefined();
  });
});

describe("the v3.2 admin events and the scheduler's setters are the contracts'", () => {
  const source = (file: string) => readFileSync(pkg(`${V32_SRC}/${file}`), "utf8");
  const fnsOf = (file: string) => artifact(file).filter((x): x is AbiFunction => x.type === "function");
  const fnSig = (f: AbiFunction) => `${f.name}(${f.inputs.map((i) => `${canon(i)} ${i.name}`).join(",")})`;
  /** A function's closing brace at the contract's indentation (the first after its start ends its body). */
  const END_OF_FUNCTION = String.fromCharCode(10) + "    }" + String.fromCharCode(10);
  /** The selectors a contract's _classify names (`this.<fn>.selector`), its body only. */
  const classified = (file: string) => {
    const text = source(file);
    const start = text.indexOf("function _classify(");
    const body = text.slice(start, text.indexOf(END_OF_FUNCTION, start));
    return [...new Set([...body.matchAll(/this\.(\w+)\.selector/g)].map(([, n]) => n))].sort();
  };

  it("ADMIN_EVENTS holds v3-launch's set and v3.2's: every key is in its role's v3.1 or v3.2 ABI, and declared in that version's sources", () => {
    for (const key of ADMIN_EVENTS_V31) expect(ADMIN_EVENTS.has(key), key).toBe(true);
    const v32Only = [...ADMIN_EVENTS].filter((k) => !ADMIN_EVENTS_V31.has(k));
    for (const k of [
      ...["Scheduled", "Executed", "Cancelled", "Lapsed", "StampedBySig", "ExitsClosed", "ExitsReopened"].flatMap((n) => [`vault:${n}`, `frontDoor:${n}`]),
      "vault:OutflowLimitsSet",
      "vault:StakeWrittenOff",
      "frontDoor:PotSwept",
    ]) {
      expect(v32Only, k).toContain(k);
    }
    // routine, not admin: the keeper's adoptStake (a warning) and anyone's surplus sweep (the daily digest)
    for (const k of ["vault:StakeAdopted", "baseAdapter:SurplusSwept", "bitAdapter:SurplusSwept"]) expect(v32Only, k).not.toContain(k);
    for (const key of v32Only) {
      const [role, name] = key.split(":") as [OwnRole, string];
      expect(events32(role).map((e) => e.name), key).toContain(name);
      const names = [...v32Declared(role), ...OPENZEPPELIN_V32[role]].map((x) => x.slice(0, x.indexOf("(")));
      expect(names, key).toContain(name);
    }
    expect(SCHEDULER_EVENTS).toEqual(["Scheduled", "Executed", "Cancelled", "Lapsed"]);
  });

  it("knows every setter each contract's _classify schedules, with the published ABI's signature and parameter names", () => {
    const base = classified("CascadeBase.sol");
    expect(base).toEqual(["activateBridge", "setGuardian", "transferOwnership"]);
    for (const [role, file, artifactFile] of [
      ["vault", "CascadeVault.sol", "abi/CascadeVault.json"],
      ["frontDoor", "CascadeFrontDoor.sol", "out/CascadeFrontDoor.sol/CascadeFrontDoor.json"],
    ] as const) {
      const ours = SCHEDULABLE[role];
      expect(ours.map((f) => f.name).sort(), role).toEqual([...new Set([...classified(file), ...base])].sort());
      const theirs = fnsOf(artifactFile);
      for (const f of ours) {
        const match = theirs.filter((t) => t.name === f.name);
        expect(match, `${role} ${f.name}`).toHaveLength(1);
        expect(fnSig(f), `${role} ${f.name}`).toBe(fnSig(match[0]));
        expect(schedulableOf(role, toFunctionSelector(match[0]))?.name).toBe(f.name);
      }
    }
    expect(schedulableOf("vault", "0x12345678")).toBeUndefined();
    // the front door's setters aren't the vault's
    expect(schedulableOf("vault", toFunctionSelector("setOracle(address)"))).toBeUndefined();
  });

  it("names every instrument ExitsClosed and ExitsReopened carry, by the published ABIs' selectors", () => {
    const text = ["CascadeBase.sol", "CascadeVault.sol"].map(source).join(END_OF_FUNCTION);
    const named = new Set<string>();
    for (const [, n] of text.matchAll(/emit\s+Exits(?:Closed|Reopened)\([^;]*?this\.(\w+)\.selector/g)) named.add(n);
    for (const [, n] of text.matchAll(/_reopenPrimary\(this\.(\w+)\.selector\)/g)) named.add(n);
    expect([...named].sort()).toEqual(["activateBridge", "activateFrontDoor", "cancelPayoutBatch", "disableBridge", "pause", "removeFrontDoor", "setGuardian", "setPrimaryBridge", "unpause"]);
    expect([...INSTRUMENTS.values()].sort()).toEqual([...named].sort());
    const fns = fnsOf("abi/CascadeVault.json");
    for (const [selector, name] of INSTRUMENTS) {
      const f = fns.filter((x) => x.name === name);
      expect(f, name).toHaveLength(1);
      expect(toFunctionSelector(f[0]), name).toBe(selector);
    }
    expect(instrumentOf(`${toFunctionSelector("pause()")}${"0".repeat(56)}`)).toBe("pause");
    expect(instrumentOf("0x12345678")).toBeUndefined();
  });

  it("an item's id is keccak256 of its calldata in schedule and execute (CascadeBase.sol): admin.hotkey_switched matches a switch's Executed by it", () => {
    const base = source("CascadeBase.sol").replace(/\s+/g, " ");
    expect(base).toContain("function schedule(bytes calldata data) external onlyOwner returns (bytes32 id) { (Delay class_, Kind kind) = _classify(data); _gate(kind, uint64(block.timestamp)); id = keccak256(data);");
    expect(base).toContain("function execute(bytes calldata data) external onlyOwner { bytes32 id = keccak256(data);");
    expect(base).toContain("emit Executed(id);");
  });

  it("EXECUTE_WINDOW_S and MAX_HOTKEYS are CascadeConstants.sol's", () => {
    const text = source("CascadeConstants.sol");
    const w = text.match(/uint64 constant EXECUTE_WINDOW = (\d+) days;/);
    const m = text.match(/uint256 constant MAX_HOTKEYS = (\d+);/);
    expect(w && m, "EXECUTE_WINDOW or MAX_HOTKEYS changed shape: read them again").toBeTruthy();
    expect(EXECUTE_WINDOW_S).toBe(Number(w![1]) * 86_400);
    expect(MAX_HOTKEYS).toBe(Number(m![1]));
  });
});

describe("v3.2's parks: the constants and the refusals the park rules name are the contracts' (Task 56)", () => {
  const source = (file: string) => readFileSync(pkg(`${V32_SRC}/${file}`), "utf8");
  it("REFUND_CHUNK and PARK_TIMEOUT_S are CcipBittensorAdapter.sol's, and Bittensor's 12-second block the vault's", () => {
    const text = source("adapters/CcipBittensorAdapter.sol");
    expect(text).toContain("uint32 public constant REFUND_CHUNK = type(uint32).max;");
    expect(REFUND_CHUNK).toBe(2 ** 32 - 1);
    const t = text.match(/uint64 public constant PARK_TIMEOUT = (\d+) days;/);
    expect(t, "PARK_TIMEOUT changed shape: read it again").not.toBeNull();
    expect(PARK_TIMEOUT_S).toBe(Number(t![1]) * 86_400);
    // the park key the cross-checks rebuild, and the refund's message
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain("return keccak256(abi.encode(remoteChainId, sender, recipient, message));");
    expect(flat).toContain("payouts = CascadeMessages.encodePayouts(key, REFUND_CHUNK, deposits);");
    expect(BITTENSOR_BLOCK_S).toBe(12);
  });

  it("every refusal a BatchParked's reason is named by is an error the vault or the adapter declares", () => {
    const errors = (file: string) => artifact(file).filter((x): x is Extract<Abi[number], { type: "error" }> => x.type === "error").map((e) => `${e.name}(${e.inputs.map(canon).join(",")})`);
    const known = new Set([...errors("abi/CascadeVault.json"), ...errors("out/CcipBittensorAdapter.sol/CcipBittensorAdapter.json")]);
    for (const sig of REASON_SIGNATURES) expect(known.has(sig), sig).toBe(true);
  });
});

describe("rails.incoherent compares what each end really checks (Task 57c)", () => {
  const source = (file: string) => readFileSync(pkg(`${V32_SRC}/${file}`), "utf8").replace(/\s+/g, " ");
  it("the vault takes a message only from a bridge it has enabled; the front door from any bridge it ever enabled (H-2 i)", () => {
    const base = source("CascadeBase.sol");
    expect(base).toContain("function _requireBridge() internal view virtual { if (!bridgeEnabled[msg.sender]) revert NotBridge(); }");
    // the vault keeps the base's check: it overrides nothing of it
    expect(source("CascadeVault.sol")).not.toContain("function _requireBridge()");
    expect(source("CascadeFrontDoor.sol")).toContain("function _requireBridge() internal view override { if (!bridgeKnown[msg.sender]) revert NotBridge(); }");
    // bridgeKnown is set with every enable and never cleared
    expect(base).toContain("function _enableBridge(address bridge) internal { bridgeEnabled[bridge] = true; bridgeKnown[bridge] = true;");
    expect(base.match(/bridgeKnown\[[^\]]+\] = /g)).toEqual(["bridgeKnown[bridge] = "]);
  });

  it("an adapter sends only to its remoteChainId, takes messages only from its remoteAdapter, and names its remoteChainId as their source", () => {
    const a = source("adapters/CcipAdapterBase.sol");
    expect(a).toContain("if (destChain != remoteChainId) revert WrongDestination();");
    expect(a).toContain("if (message.sender.length != 32 || abi.decode(message.sender, (address)) != remoteAdapter) { revert WrongSender(); }");
    expect(source("adapters/CcipBaseAdapter.sol")).toContain("ICascadeReceiver(recipient).onBridgeMessage(remoteChainId, sender, message, amount);");
    expect(source("adapters/CcipBittensorAdapter.sol")).toContain("PARK_GAS_RESERVE)}( remoteChainId, sender, message, amount ) {");
    // so a half naming its sender on another chain is an unknown peer to the vault (parked) and to the front door
    expect(source("CascadeVault.sol")).toContain("bytes32 peer = peerId(sourceChain, sender); if (doorState[peer] != DoorState.Active) revert UnknownPeer();");
    expect(source("CascadeFrontDoor.sol")).toContain("if (sourceChain != vaultChain || sender != vault) revert UnknownPeer();");
    // and the primary sends nothing while it is disabled (a disabled primary is its own side's state, not a disagreement)
    expect(source("CascadeBase.sol")).toContain("if (!bridgeEnabled[p]) revert PrimaryBridgeDisabled();");
  });
});

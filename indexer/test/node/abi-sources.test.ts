import { readFileSync } from "node:fs";
import type { AbiEvent } from "viem";
import { describe, expect, it } from "vitest";
import { ADMIN_EVENTS, abiFor } from "../../src/abi.ts";
import type { Role } from "../../src/config.ts";
import { pkg } from "./files.ts";

/** The contract sources each role is built from (inherited OpenZeppelin events aside). */
const SOURCES: Record<Role, string[]> = {
  vault: ["CascadeVault.sol", "CascadeBase.sol"],
  frontDoor: ["CascadeFrontDoor.sol", "CascadeBase.sol"],
  staker: ["CascadeStaker.sol"],
  baseAdapter: ["adapters/CcipAdapterBase.sol", "adapters/CcipBaseAdapter.sol"],
  bitAdapter: ["adapters/CcipAdapterBase.sol", "adapters/CcipBittensorAdapter.sol"],
};

/** Events each role inherits from OpenZeppelin (ERC20, Pausable, Ownable2Step), not in contracts/src. */
const OPENZEPPELIN: Record<Role, string[]> = {
  vault: ["Transfer(address indexed,address indexed,uint256)", ...pausableOwnable()],
  frontDoor: pausableOwnable(),
  staker: ["OwnershipTransferStarted(address indexed,address indexed)", "OwnershipTransferred(address indexed,address indexed)"],
  baseAdapter: [],
  bitAdapter: [],
};
function pausableOwnable() {
  return ["Paused(address)", "Unpaused(address)", "OwnershipTransferStarted(address indexed,address indexed)", "OwnershipTransferred(address indexed,address indexed)"];
}

/** Solidity types that are enums in the sources, encoded as uint8 in the ABI. */
const ENUMS: Record<string, string> = { RouterKind: "uint8" };

/** Every `event Name(...)` declared in a source, as "Name(type [indexed],...)". */
function declared(file: string): string[] {
  const text = readFileSync(pkg(`../contracts/src/${file}`), "utf8").replace(/\/\/[^\n]*/g, "");
  return [...text.matchAll(/\bevent\s+(\w+)\s*\(([^)]*)\)\s*;/g)].map(([, name, params]) => {
    const types = params
      .split(",")
      .map((p) => p.trim().split(/\s+/))
      .filter((p) => p[0] !== "")
      .map((p) => `${ENUMS[p[0]] ?? p[0]}${p[1] === "indexed" ? " indexed" : ""}`);
    return `${name}(${types.join(",")})`;
  });
}

const signature = (e: AbiEvent) => `${e.name}(${e.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""}`).join(",")})`;
const events = (role: Role) => abiFor(role).filter((x): x is AbiEvent => x.type === "event");

describe("the ABIs match the contracts' sources", () => {
  for (const role of Object.keys(SOURCES) as Role[]) {
    it(`${role}: every event in its ABI is declared in its sources (or inherited from OpenZeppelin)`, () => {
      const inSources = new Set([...SOURCES[role].flatMap(declared), ...OPENZEPPELIN[role]]);
      expect(events(role).map(signature).filter((s) => !inSources.has(s))).toEqual([]);
    });

    it(`${role}: every event declared in its sources is in its ABI`, () => {
      const inAbi = new Set(events(role).map(signature));
      const missing = [...SOURCES[role].flatMap(declared), ...OPENZEPPELIN[role]].filter((s) => !inAbi.has(s));
      expect(missing).toEqual([]);
    });
  }

  it("every admin event is in its role's ABI, and is declared in its sources or inherited", () => {
    expect(ADMIN_EVENTS.size).toBeGreaterThan(30);
    for (const key of ADMIN_EVENTS) {
      const [role, name] = key.split(":") as [Role, string];
      expect(events(role).map((e) => e.name), key).toContain(name);
      const names = [...SOURCES[role].flatMap(declared), ...OPENZEPPELIN[role]].map((s) => s.slice(0, s.indexOf("(")));
      expect(names, key).toContain(name);
    }
  });

  it("finds the sources' events at all (the parser isn't reading nothing)", () => {
    expect(declared("CascadeVault.sol").length).toBeGreaterThan(30);
    expect(declared("CascadeStaker.sol")).toContain("Staked(address indexed,address indexed,uint256,uint256,uint256)");
  });
});

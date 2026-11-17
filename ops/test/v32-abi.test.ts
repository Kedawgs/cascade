import { readFileSync } from "node:fs";
import { type Abi, type AbiEvent, decodeEventLog, encodeAbiParameters, encodeEventTopics, getAddress, type Hex, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { preauditArtifact } from "../src/builds.ts";
import { libraryAbi, V32_LIBRARIES, VAULT_ABI_V32 } from "../src/v32/abi.ts";
import { artifact } from "./v32-sources.ts";

// The published vault ABI (spec §8.1): the vault artifact's ABI merged with its libraries' events and errors, which
// come from the vault's address. Ops reads it from contracts/abi/CascadeVault.json; the contracts' build check
// (contracts/script/merge-abi.mjs --check) keeps that file equal to a fresh merge of the build, and so does this test,
// with that script's own merge.

interface MergeAbi {
  DEFAULT_OUT: string;
  DEFAULT_ABI: string;
  mergedText(outDir: string): { text: string; merged: Abi; libraries: { name: string; path: string; abi: Abi }[] };
  missingFrom(merged: Abi, libraries: Abi[]): string[];
}

/** contracts/script/merge-abi.mjs, the build's own merge (imported, never re-implemented). */
const mergeAbi = async (): Promise<MergeAbi> => (await import(new URL("../../contracts/script/merge-abi.mjs", import.meta.url).href)) as MergeAbi;

const event = (abi: Abi, name: string): AbiEvent => {
  const hits = abi.filter((x): x is AbiEvent => x.type === "event" && x.name === name);
  if (hits.length !== 1) throw new Error(`${hits.length} events ${name}`);
  return hits[0];
};

/** A log as `abi`'s event `name` encodes it: its topics and its data. */
function logOf(abi: Abi, name: string, args: Record<string, unknown>): { topics: [Hex, ...Hex[]]; data: Hex } {
  const e = event(abi, name);
  const indexed = Object.fromEntries(e.inputs.filter((p) => p.indexed).map((p) => [p.name, args[p.name as string]]));
  const topics = encodeEventTopics({ abi: [e], eventName: name, args: indexed } as never) as [Hex, ...Hex[]];
  const rest = e.inputs.filter((p) => !p.indexed);
  return { topics, data: encodeAbiParameters(rest, rest.map((p) => args[p.name as string])) };
}

const KEY = keccak256(toHex("a batch's key"));
const USER = getAddress(`0x${"5e".repeat(20)}`);

describe("the published vault ABI", () => {
  it("abiFileMatchesAFreshMerge: contracts/abi/CascadeVault.json is merge-abi's merge of contracts/out, byte for byte", async () => {
    const m = await mergeAbi();
    const fresh = m.mergedText(m.DEFAULT_OUT);
    // exactly merge-abi --check's comparison: the committed text, line endings aside, equals a fresh merge's
    const committed = readFileSync(m.DEFAULT_ABI, "utf8").replace(/\r\n/g, "\n");
    expect(committed === fresh.text, "contracts/abi/CascadeVault.json is stale: the build's merge differs").toBe(true);
    // and ops's vault ABI is that file's
    expect(VAULT_ABI_V32).toEqual(JSON.parse(fresh.text));
    // the merge took every library the vault links, the ones ops reads, from the same artifacts
    expect(fresh.libraries.map((l) => l.name).sort()).toEqual([...V32_LIBRARIES].sort());
    for (const l of fresh.libraries) expect(libraryAbi(l.name as (typeof V32_LIBRARIES)[number]), l.name).toEqual(l.abi);
    // the file covers every event and error a library can emit (ruling DB14c), none of which the vault artifact has
    expect(m.missingFrom(VAULT_ABI_V32, V32_LIBRARIES.map(libraryAbi))).toEqual([]);
    const own = new Set(artifact("CascadeVault").abi.filter((x) => x.type === "event").map((x) => (x as AbiEvent).name));
    for (const name of ["Deposited", "DepositBounced", "Redeemed", "BatchDelivered", "PayoutChunkSent", "PayoutBatchCancelled", "Unstaked", "HotkeyAdded", "StakeMoved"]) {
      expect(own.has(name), `${name} is the vault artifact's own`).toBe(false);
      expect(event(VAULT_ABI_V32, name).name).toBe(name);
    }
  });

  it("mergedAbiDecodesALibraryEvent: a Deposited log L1 emits at the vault's address decodes with the published ABI, not the vault artifact's", () => {
    const deposited = logOf(libraryAbi("CascadeBatchLib"), "Deposited", { key: KEY, user: USER, assets: 4n * 10n ** 16n, shares: 4n * 10n ** 22n });
    expect(decodeEventLog({ abi: VAULT_ABI_V32, ...deposited })).toEqual({
      eventName: "Deposited",
      args: { key: KEY, user: USER, assets: 4n * 10n ** 16n, shares: 4n * 10n ** 22n },
    });
    // the vault's own artifact has no Deposited: only L1 emits it
    expect(() => decodeEventLog({ abi: artifact("CascadeVault").abi, ...deposited })).toThrow(/not found on ABI/);
  });

  it("mergedAbiDecodesALibraryEvent: L3's PayoutChunkSent has eight fields, charged and unstakeCost last, which v3-launch's six-field event never matches", () => {
    const fields = { key: KEY, chunk: 1, taken: 3, gross: 3n * 10n ** 17n, net: 2n * 10n ** 17n, fee: 9n * 10n ** 16n, charged: 8n * 10n ** 16n, unstakeCost: 10n ** 16n };
    const sent = logOf(libraryAbi("CascadePayoutLib"), "PayoutChunkSent", fields);
    expect(event(VAULT_ABI_V32, "PayoutChunkSent").inputs.map((p) => p.name)).toEqual(["key", "chunk", "taken", "gross", "net", "fee", "charged", "unstakeCost"]);
    expect(decodeEventLog({ abi: VAULT_ABI_V32, ...sent })).toEqual({ eventName: "PayoutChunkSent", args: fields });
    // v3-launch's (the frozen build's, which its rehearsal and keeper decode) has six: a v3.2 log is not that event,
    // so v3.2's paths decode with the published ABI (the T36b consumer list; v3.2's rehearsal is Task 61's)
    const v3 = event(preauditArtifact("CascadeVault").abi, "PayoutChunkSent");
    expect(v3.inputs.map((p) => p.name)).toEqual(["key", "chunk", "taken", "gross", "net", "fee"]);
    expect(() => decodeEventLog({ abi: [v3], ...sent })).toThrow(/not found on ABI/);
  });

  it("declares each event once, at file level: CascadeEvents.sol's, Transfer included, and OpenZeppelin's four", () => {
    const src = (p: string) => readFileSync(new URL(`../../contracts/src/${p}`, import.meta.url), "utf8").replace(/\/\/[^\n]*/g, "");
    // CascadeTypes.sol's enums are uint8 in an ABI
    const enums = new Set([...src("CascadeTypes.sol").matchAll(/\benum\s+(\w+)/g)].map((m) => m[1]));
    const declared = new Map<string, string>();
    for (const m of src("CascadeEvents.sol").matchAll(/^event\s+(\w+)\s*\(([^)]*)\)\s*;/gm)) {
      const params = m[2].split(",").map((p) => p.trim()).filter(Boolean).map((p) => p.split(/\s+/));
      const sig = params.map(([type, ...rest]) => `${enums.has(type) ? "uint8" : type}${rest.includes("indexed") ? " indexed" : ""}`).join(",");
      expect(declared.has(m[1]), `${m[1]} is declared twice`).toBe(false);
      declared.set(m[1], sig);
    }
    const OPENZEPPELIN = ["OwnershipTransferStarted", "OwnershipTransferred", "Paused", "Unpaused"];
    const events = VAULT_ABI_V32.filter((x): x is AbiEvent => x.type === "event");
    for (const e of events) {
      if (OPENZEPPELIN.includes(e.name)) continue;
      const sig = e.inputs.map((p) => `${p.type}${p.indexed ? " indexed" : ""}`).join(",");
      expect(declared.get(e.name), `${e.name} is not CascadeEvents.sol's`).toBe(sig);
    }
    expect(new Set(events.map((e) => e.name))).toEqual(new Set([...declared.keys(), ...OPENZEPPELIN]));
    // the share token's Transfer is the file-level one, not OpenZeppelin's ERC20's (the vault has no ERC20)
    expect(declared.get("Transfer")).toBe("address indexed,address indexed,uint256");
  });
});

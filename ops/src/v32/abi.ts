import { existsSync, readFileSync } from "node:fs";
import type { Abi, AbiFunction, AbiParameter } from "viem";

// v3.2's ABIs, each from one source in this checkout's contracts/ (spec §8.1), never retyped:
// - the vault's: the published ABI, contracts/abi/CascadeVault.json (committed). It is the vault artifact's ABI merged
//   with its linked libraries' events and errors (contracts/script/merge-abi.mjs), since a file-level event or error
//   that only a library emits comes from the vault's address but is in that library's ABI alone (Deposited, Redeemed,
//   PayoutChunkSent, …). Every read of the vault's calls, logs and reverts decodes with it.
// - the lenses', the front door's and the libraries': forge's build, contracts/out, read when first asked for, so a
//   command that never reads v3.2 (every v3-launch one, which reads ops/builds/preaudit) never needs contracts/out.

const contractsFile = (path: string) => new URL(`../../../contracts/${path}`, import.meta.url);

/** The published vault ABI (contracts/abi/CascadeVault.json): the vault's functions, events and errors and its
 * libraries' events and errors. test/v32-abi.test.ts holds it equal to a fresh merge of contracts/out. */
export const VAULT_ABI_V32: Abi = JSON.parse(readFileSync(contractsFile("abi/CascadeVault.json"), "utf8")) as Abi;

/** The libraries the v3.2 vault links, directly or through another library (spec §8.1's link graph). */
export const V32_LIBRARIES = ["CascadePayoutMath", "CascadeStakeLib", "CascadePayoutLib", "CascadeBatchLib", "CascadeHotkeyLib"] as const;
export type V32Library = (typeof V32_LIBRARIES)[number];

const built = new Map<string, Abi>();

/** `name`'s ABI as contracts/out has it (forge writes out/<name>.sol/<name>.json), read once. */
function builtAbi(name: string): Abi {
  let abi = built.get(name);
  if (!abi) {
    const path = contractsFile(`out/${name}.sol/${name}.json`);
    if (!existsSync(path)) throw new Error(`contracts/out has no ${name}: v3.2's ABIs come from forge's build of contracts/ (run forge build there); nothing read`);
    abi = (JSON.parse(readFileSync(path, "utf8")) as { abi: Abi }).abi;
    built.set(name, abi);
  }
  return abi;
}

/** CascadeVaultLens's ABI: every vault view the vault did not keep (spec §8.1). */
export const vaultLensAbi = (): Abi => builtAbi("CascadeVaultLens");
/** CascadeDoorLens's ABI: CascadeBase's views on the front door, which the front door no longer serves. */
export const doorLensAbi = (): Abi => builtAbi("CascadeDoorLens");
/** v3.2's CascadeFrontDoor: its own getters (kept), its entry points, events and errors. */
export const frontDoorAbiV32 = (): Abi => builtAbi("CascadeFrontDoor");
/** One of the vault's libraries' ABI: its events and errors (and, for CascadePayoutMath, its pure functions). */
export const libraryAbi = (name: V32Library): Abi => builtAbi(name);

/** The functions v3.2 declares pure only to revert, which read nothing (Task 43a's review, M4): OpenZeppelin's
 * renounceOwnership, which CascadeBase disables (spec §3.6), and the share token's transfer, transferFrom and approve
 * (spec §8.1: wallets handle a revert better than an unknown selector). The token's allowance, pure too, answers 0 and
 * stays a getter. */
export const REVERTING_STUBS: readonly string[] = ["renounceOwnership", "transfer", "transferFrom", "approve"];

/** A function's getters: the view and pure functions of `abi` named `name` that answer something (none, or one: no
 * getter is overloaded); a pure function that only reverts (REVERTING_STUBS) is no getter. */
export const gettersNamed = (abi: Abi, name: string): AbiFunction[] =>
  abi.filter(
    (x): x is AbiFunction =>
      x.type === "function" &&
      x.name === name &&
      (x.stateMutability === "view" || x.stateMutability === "pure") &&
      x.outputs.length > 0 &&
      !(x.stateMutability === "pure" && REVERTING_STUBS.includes(x.name)),
  );

/** A parameter's type as a decoder sees it: a tuple's components with their names, which name its fields. */
const shapeOfParam = (p: AbiParameter): string =>
  p.type.startsWith("tuple")
    ? `(${((p as { components?: readonly AbiParameter[] }).components ?? []).map((c) => `${shapeOfParam(c)} ${c.name ?? ""}`.trim()).join(",")})${p.type.slice("tuple".length)}`
    : p.type;

/** What a call to `f` sends and decodes: its name, its inputs' types and its outputs' types, tuple fields by name
 * ("getPayoutBatch(bytes32) -> ((uint64 sourceChain,…))"). Two getters with one shape read alike. */
export const shapeOf = (f: AbiFunction): string => `${f.name}(${f.inputs.map(shapeOfParam).join(",")}) -> (${f.outputs.map(shapeOfParam).join(",")})`;

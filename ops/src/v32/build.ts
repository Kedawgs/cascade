import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Abi, type AbiParameter, type Address, encodeDeployData, getAddress, type Hex, keccak256, stringToBytes } from "viem";
import { type ImmutableReferences, type ImmutableVariable, immutableVariables, type LinkReferences, maskImmutables } from "../artifacts.ts";
import { CONTRACTS_V32, type V32StepId } from "./plan.ts";

// v3.2's deployed build, frozen (the controller's ruling on Task 43a's review, M1). contracts/out is forge's build of
// whatever the checkout holds, and changes with it; the deployment's contracts never do. So the deploy writes, before
// its first CREATE, a copy of exactly the build it sends (each planned contract's ABI, creation code and runtime code
// with their link and immutable references and each immutable's variable, the link set, and the published vault ABI)
// to a folder of its own under ops/builds/, named by the copy's hash, and records that hash; every create is sent from
// the copy, and every later read of a v3.2 deployment (lens.ts) decodes with it, and Task 45's code read-back (code.ts)
// fills it in, never contracts/out. ops/builds/preaudit is v3-launch's.
//
// Linking (ruling C1, DB4): one link path. linkLibraries fills each library's planned address into the placeholders
// solc leaves (`__$` + 34 hex of keccak256("path:Name") + `$__`) at the offsets the artifact's linkReferences give,
// which differ between the creation code and the runtime code. The deploy sends exactly the creation code it links
// here (send.ts, a v3.2 create), Task 45's verify links the runtime code here too, and nothing else links anything: no
// forge script, no `forge create --libraries`, no implicit link.

export type { LinkReferences } from "../artifacts.ts";

/** One planned contract as the build compiled it. */
export interface FrozenContract {
  /** forge's path:Name, the plan's `contract`. */
  contract: string;
  abi: Abi;
  bytecode: { object: Hex; linkReferences: LinkReferences };
  deployedBytecode: { object: Hex; linkReferences: LinkReferences; immutableReferences: ImmutableReferences };
  /** The variable behind each key of `deployedBytecode.immutableReferences` (an AST id, or solc's own
   * library_deploy_address), named from forge's ASTs when the build is frozen (artifacts.ts immutableVariables; Task 44's
   * concern 4): the copy holds no AST, and Task 45's code read-back fills each immutable by this name, from here, never
   * from contracts/out. A copy frozen before Task 45 has none, and its code cannot be checked filled in. */
  immutables: Record<string, ImmutableVariable>;
  /** keccak256 of solc's metadata JSON for it (forge's rawMetadata), which names every source file by its hash. */
  metadataHash: Hex;
}

/** Where the build's source is: the checkout's commit and the paths under contracts/ that differ from it (none for a
 * live deploy, which refuses a tree that differs). */
export interface SourceV32 {
  commit: string;
  /** git's tree hash of contracts/ at the commit (git rev-parse HEAD:contracts): what a docs or ops commit leaves alone. */
  tree: string;
  dirty: string[];
}

/** What a live deploy must share with its rehearsal (the controller's ruling on fix round 1): everything that makes the
 * deployed code. That is contracts/' git tree and what differed from it, each contract's creation and runtime code with
 * their references, the link set, and the compiler with every setting. It leaves out the commit, which build.json still
 * records: a later docs or ops commit changes none of these, while any change under contracts/ does. */
export function buildIdentityV32(build: BuildV32): Hex {
  const contracts = Object.keys(build.contracts)
    .sort()
    .map((name) => [name, build.contracts[name].bytecode, build.contracts[name].deployedBytecode]);
  const links = Object.keys(build.links)
    .sort()
    .map((name) => [name, build.links[name]]);
  return keccak256(stringToBytes(JSON.stringify({ tree: build.source?.tree ?? null, dirty: build.source?.dirty ?? null, contracts, links, compiler: build.compiler })));
}

/** The compiler the plan's Global Constraints fix: solc 0.8.38, cancun, the IR pipeline, the optimizer at 200 runs. A
 * build of other settings is refused (freezeBuildV32 reads contracts/foundry.toml and each artifact's metadata). */
export const COMPILER_V32 = { version: "0.8.38", evmVersion: "cancun", viaIR: true, optimizer: { enabled: true, runs: 200 } } as const;

export interface BuildV32 {
  build: "v3.2";
  about: string;
  /** The checkout the build came from (git), when the deploy read it. */
  source?: SourceV32;
  /** The compiler and every setting that changes the code (solc's metadata settings, but the compilation target), the
   * same for every contract and COMPILER_V32's (checked when frozen). */
  compiler: { version: string; evmVersion: string; viaIR: boolean; optimizer: { enabled: boolean; runs: number }; settings: Record<string, unknown> };
  /** Every planned contract, by name. */
  contracts: Record<string, FrozenContract>;
  /** The published vault ABI (contracts/abi/CascadeVault.json): merge-abi's merge of this build's vault and libraries. */
  vaultAbi: Abi;
  /** The link set: the libraries each linking contract's creation code links, by path:Name. */
  links: Record<string, string[]>;
}

/** Where a deployment's frozen build is (a folder under ops/builds/) and the keccak256 of its build.json. */
export interface BuildRefV32 {
  dir: string;
  hash: Hex;
}

/** ops/builds/, where every frozen build lives. */
export const BUILDS_DIR = fileURLToPath(new URL("../../builds/", import.meta.url));

const ABOUT =
  "The build a v3.2 deployment sends (ops/src/v32/deploy.ts), frozen from forge's contracts/out before its first CREATE: each planned contract's ABI, creation code and runtime code with their link and immutable references, the variable each immutable is (named from forge's ASTs, which this copy leaves out), the link set, and the published vault ABI. Named by its hash, which the deployment's record holds; every v3.2 read of that deployment decodes with this copy.";

/** The placeholder solc leaves for library `fqn` (path:Name) in code that links it. */
export const placeholderOf = (fqn: string): string => `__$${keccak256(stringToBytes(fqn)).slice(2, 36)}$__`;

/** The libraries `refs` names, as path:Name. */
export const linkedLibraries = (refs: LinkReferences): string[] =>
  Object.entries(refs)
    .flatMap(([file, libs]) => Object.keys(libs).map((lib) => `${file}:${lib}`))
    .sort();

/** `code` with every library in `refs` linked at its address in `libraries` (path:Name -> address), checking each
 * offset holds that library's placeholder. Refuses a library `refs` names that `libraries` lacks, one `libraries` names
 * that `refs` does not (a library outside the code's link set), and any placeholder left after linking. */
export function linkLibraries(code: Hex, refs: LinkReferences, libraries: Record<string, Address>): Hex {
  const want = linkedLibraries(refs);
  const given = Object.keys(libraries).sort();
  const missing = want.filter((l) => !given.includes(l));
  const extra = given.filter((l) => !want.includes(l));
  if (missing.length || extra.length) {
    throw new Error(
      `the code links ${want.join(", ") || "no library"}, but the plan names ${given.join(", ") || "none"}${missing.length ? ` (missing ${missing.join(", ")})` : ""}${extra.length ? ` (not in the code's link set: ${extra.join(", ")})` : ""}; nothing linked`,
    );
  }
  let hex = code.slice(2);
  for (const [file, libs] of Object.entries(refs)) {
    for (const [lib, offsets] of Object.entries(libs)) {
      const fqn = `${file}:${lib}`;
      const address = getAddress(libraries[fqn]).slice(2).toLowerCase();
      for (const { start, length } of offsets) {
        const at = hex.slice(start * 2, (start + length) * 2);
        if (length !== 20 || at !== placeholderOf(fqn)) throw new Error(`byte ${start} of the code is not ${fqn}'s placeholder (${at}); nothing linked`);
        hex = hex.slice(0, start * 2) + address + hex.slice((start + length) * 2);
      }
    }
  }
  if (hex.includes("__$")) throw new Error("a library placeholder is left in the code after linking; nothing linked");
  return `0x${hex}`;
}

/** The step's contract as the build has it: refused when the build has none by that path:Name. */
export function frozenContract(build: BuildV32, step: { contract: string }): FrozenContract {
  const c = build.contracts[step.contract.split(":")[1]];
  if (!c || c.contract !== step.contract) throw new Error(`the frozen build has no ${step.contract}; nothing sent`);
  return c;
}

/** The step's creation code, linked with its planned libraries. */
export const creationCodeV32 = (build: BuildV32, step: { contract: string; libraries?: Record<string, Address> }): Hex => {
  const c = frozenContract(build, step);
  return linkLibraries(c.bytecode.object, c.bytecode.linkReferences, step.libraries ?? {});
};

/** What a step's CREATE sends: its linked creation code and its constructor's arguments, ABI-encoded. */
export const deployDataV32 = (build: BuildV32, step: { contract: string; args: unknown[]; libraries?: Record<string, Address> }): Hex =>
  encodeDeployData({ abi: frozenContract(build, step).abi, bytecode: creationCodeV32(build, step), args: step.args } as never);

/** The step's runtime code, linked with the planned libraries it calls (its immutables are left as the build has
 * them, zero). */
export function runtimeCodeV32(build: BuildV32, step: { contract: string; libraries?: Record<string, Address> }): Hex {
  const c = frozenContract(build, step);
  const refs = c.deployedBytecode.linkReferences;
  const wanted = linkedLibraries(refs);
  const libs = Object.fromEntries(Object.entries(step.libraries ?? {}).filter(([l]) => wanted.includes(l)));
  return linkLibraries(c.deployedBytecode.object, refs, libs);
}

/** Why the runtime code `onchain` is not the step's, as the build and the plan's links make it, or null when it is.
 * The immutables are compared masked (their values are the constructor's, which Task 45's verify fills in). */
export function codeProblemV32(build: BuildV32, step: { contract: string; libraries?: Record<string, Address> }, onchain: Hex): string | null {
  const ranges = Object.values(frozenContract(build, step).deployedBytecode.immutableReferences).flat();
  const want = maskImmutables(runtimeCodeV32(build, step), ranges).toLowerCase();
  return maskImmutables(onchain, ranges).toLowerCase() === want ? null : `its code is not the frozen build's ${step.contract}`;
}

/** Every custom error of the build, for naming a revert (send.ts describeRevert). */
export function buildErrorsV32(build: BuildV32): Abi {
  const seen = new Set<string>();
  const out: Abi[number][] = [];
  for (const abi of [build.vaultAbi, ...Object.values(build.contracts).map((c) => c.abi)]) {
    for (const item of abi) {
      if (item.type !== "error") continue;
      const sig = `${item.name}(${item.inputs.map((p: AbiParameter) => p.type).join(",")})`;
      if (!seen.has(sig)) seen.add(sig), out.push(item);
    }
  }
  return out;
}

interface MergeAbi {
  mergedText(outDir: string): { text: string };
}

/** contracts/script/merge-abi.mjs: the build's own merge of the published vault ABI, never re-implemented. */
const mergeAbi = async (): Promise<MergeAbi> => (await import(new URL("../../../contracts/script/merge-abi.mjs", import.meta.url).href)) as MergeAbi;

/** Line endings aside: git may check a file out with CRLF. */
const lf = (text: string) => text.replace(/\r\n/g, "\n");
const hashOf = (text: string): Hex => keccak256(stringToBytes(lf(text)));

/** contracts/foundry.toml's [profile.default] compiler settings, as COMPILER_V32 names them; refused when it does not
 * set each. */
export function foundryCompiler(contractsDir: string): { version: string; evmVersion: string; viaIR: boolean; optimizer: { enabled: boolean; runs: number } } {
  const file = join(contractsDir, "foundry.toml");
  if (!existsSync(file)) throw new Error("contracts/foundry.toml is missing; nothing frozen or sent");
  const text = lf(readFileSync(file, "utf8"));
  const start = text.indexOf("[profile.default]");
  const next = text.indexOf("\n[", start + 1);
  const section = start < 0 ? "" : text.slice(start, next < 0 ? undefined : next);
  const value = (key: string): string => {
    const m = section.match(new RegExp(`^${key}\\s*=\\s*("?)([^"\\n#]*?)\\1\\s*(?:#.*)?$`, "m"));
    if (!m) throw new Error(`contracts/foundry.toml's [profile.default] does not set ${key}; nothing frozen or sent`);
    return m[2].trim();
  };
  return {
    version: value("solc_version"),
    evmVersion: value("evm_version"),
    viaIR: value("via_ir") === "true",
    optimizer: { enabled: value("optimizer") === "true", runs: Number(value("optimizer_runs")) },
  };
}

/** The build of `contractsDir` (its forge output, contracts/out, and its published vault ABI), frozen, with `source`
 * recorded when given:
 * - every planned contract, each compiled for its own path:Name, with its metadata's hash;
 * - one compiler and one set of settings for all, and those COMPILER_V32's, as contracts/foundry.toml sets them too
 *   (Task 44's review, M6);
 * - the published vault ABI equal to a fresh merge of this build (else it is stale, and the indexer and the site would
 *   read another ABI).
 * Refuses, freezing nothing, a contract the build lacks and any of those disagreements. */
export async function freezeBuildV32(contractsDir: string, source?: SourceV32): Promise<{ build: BuildV32; text: string; hash: Hex }> {
  const pinned = JSON.stringify(COMPILER_V32);
  const toml = foundryCompiler(contractsDir);
  if (JSON.stringify(toml) !== pinned) {
    throw new Error(`contracts/foundry.toml compiles with ${JSON.stringify(toml)}, not the plan's ${pinned} (solc 0.8.38, cancun, via-IR, 200 runs); nothing frozen or sent`);
  }
  const contracts: Record<string, FrozenContract> = {};
  let compiler: BuildV32["compiler"] | undefined;
  for (const id of Object.keys(CONTRACTS_V32) as V32StepId[]) {
    const fqn = CONTRACTS_V32[id].contract;
    const [path, name] = fqn.split(":");
    const file = join(contractsDir, "out", basename(path), `${name}.json`);
    if (!existsSync(file)) throw new Error(`contracts/out has no ${name}: build contracts/ (forge build) first; nothing frozen or sent`);
    const j = JSON.parse(readFileSync(file, "utf8"));
    const target = j.metadata?.settings?.compilationTarget ?? {};
    if (Object.keys(target).length !== 1 || target[path] !== name) throw new Error(`contracts/out's ${name} was not compiled as ${fqn}; nothing frozen or sent`);
    const { compilationTarget: _, ...settings } = j.metadata.settings as Record<string, unknown>;
    const s = settings as { evmVersion?: string; viaIR?: boolean; optimizer?: { enabled?: boolean; runs?: number } };
    const version = String(j.metadata.compiler.version);
    const c: BuildV32["compiler"] = {
      version,
      evmVersion: String(s.evmVersion),
      viaIR: s.viaIR === true,
      optimizer: { enabled: s.optimizer?.enabled === true, runs: Number(s.optimizer?.runs) },
      settings,
    };
    const asPinned = JSON.stringify({ version: version.split("+")[0], evmVersion: c.evmVersion, viaIR: c.viaIR, optimizer: c.optimizer });
    if (asPinned !== pinned) throw new Error(`contracts/out's ${name} was compiled with ${asPinned}, not the plan's ${pinned}; nothing frozen or sent`);
    if (compiler && JSON.stringify(c) !== JSON.stringify(compiler)) {
      throw new Error(`contracts/out's ${name} was built with other compiler settings (${JSON.stringify(c)}, not ${JSON.stringify(compiler)}); nothing frozen or sent`);
    }
    compiler = c;
    if (typeof j.rawMetadata !== "string" || !j.rawMetadata) throw new Error(`contracts/out's ${name} has no metadata; nothing frozen or sent`);
    contracts[name] = {
      contract: fqn,
      abi: j.abi,
      bytecode: { object: j.bytecode.object, linkReferences: j.bytecode.linkReferences ?? {} },
      deployedBytecode: {
        object: j.deployedBytecode.object,
        linkReferences: j.deployedBytecode.linkReferences ?? {},
        immutableReferences: j.deployedBytecode.immutableReferences ?? {},
      },
      immutables: immutableVariables(join(contractsDir, "out"), fqn, j),
      metadataHash: keccak256(stringToBytes(j.rawMetadata)),
    };
  }
  const fresh = (await mergeAbi()).mergedText(join(contractsDir, "out")).text;
  const committed = join(contractsDir, "abi", "CascadeVault.json");
  if (!existsSync(committed) || lf(readFileSync(committed, "utf8")) !== fresh) {
    throw new Error("contracts/abi/CascadeVault.json is not this build's merge: run node script/merge-abi.mjs in contracts/ and commit it; nothing frozen or sent");
  }
  const links = Object.fromEntries(
    Object.entries(contracts)
      .filter(([, c]) => linkedLibraries(c.bytecode.linkReferences).length)
      .map(([name, c]) => [name, linkedLibraries(c.bytecode.linkReferences)]),
  );
  const build: BuildV32 = { build: "v3.2", about: ABOUT, ...(source ? { source } : {}), compiler: compiler!, contracts, vaultAbi: JSON.parse(fresh) as Abi, links };
  const text = `${JSON.stringify(build, null, 2)}\n`;
  return { build, text, hash: hashOf(text) };
}

/** Writes a frozen build to `root`/v32-<the first 12 hex of its hash>/build.json and returns where it is and its hash.
 * The same build again finds its folder already there; a different file in it is refused. */
export function writeBuildV32(root: string, frozen: { text: string; hash: Hex }): BuildRefV32 {
  const dir = `v32-${frozen.hash.slice(2, 14)}`;
  const path = join(root, dir, "build.json");
  if (existsSync(path)) {
    if (hashOf(readFileSync(path, "utf8")) !== frozen.hash) throw new Error(`ops/builds/${dir}/build.json is there and is another build: nothing frozen or sent`);
    return { dir, hash: frozen.hash };
  }
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(`${path}.tmp`, frozen.text);
  renameSync(`${path}.tmp`, path);
  return { dir, hash: frozen.hash };
}

const loaded = new Map<string, BuildV32>();

/** A deployment's frozen build, from `root` (ops/builds/ by default), read once: refused when it is missing or its
 * text is not the one whose hash the record holds. */
export function loadBuildV32(ref: BuildRefV32, root: string = BUILDS_DIR): BuildV32 {
  const path = resolve(root, ref.dir, "build.json");
  const key = `${path}\n${ref.hash}`;
  const hit = loaded.get(key);
  if (hit) return hit;
  if (!existsSync(path)) throw new Error(`the deployment's frozen build ops/builds/${ref.dir}/build.json is missing: it is the only copy of what was deployed; nothing read or sent`);
  const text = readFileSync(path, "utf8");
  if (hashOf(text) !== ref.hash.toLowerCase()) {
    throw new Error(`ops/builds/${ref.dir}/build.json is not the build the deployment's record names (its hash is ${hashOf(text)}, the record's ${ref.hash}); nothing read or sent`);
  }
  const build = JSON.parse(text) as BuildV32;
  loaded.set(key, build);
  return build;
}

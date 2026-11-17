import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Abi, Hex } from "viem";

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableRanges: { start: number; length: number }[];
}

/** Reads a contract's build output from contracts/out (run `forge build` first). */
export function loadArtifact(contractsDir: string, name: string): Artifact {
  const source = name.startsWith("Rehearsal") || name === "ForceSend" ? "RehearsalPrecompiles.sol" : `${name}.sol`;
  const json = JSON.parse(readFileSync(join(contractsDir, "out", source, `${name}.json`), "utf8"));
  const refs: Record<string, { start: number; length: number }[]> = json.deployedBytecode.immutableReferences ?? {};
  return {
    abi: json.abi,
    bytecode: json.bytecode.object,
    deployedBytecode: json.deployedBytecode.object,
    immutableRanges: Object.values(refs).flat(),
  };
}

/** Zeroes each byte range, so code with different immutables compares equal. */
export function maskImmutables(code: Hex, ranges: { start: number; length: number }[]): Hex {
  const bytes = code.slice(2).split("");
  for (const { start, length } of ranges) {
    for (let i = start * 2; i < (start + length) * 2 && i < bytes.length; i++) bytes[i] = "0";
  }
  return `0x${bytes.join("")}`;
}

// ---- link and immutable references (v3.2's code read-back, spec §7 step 3) ----

/** forge's link references: file, then library, then each 20-byte placeholder's offset. */
export type LinkReferences = Record<string, Record<string, { start: number; length: number }[]>>;

/** forge's immutable references: each immutable's 32-byte places in the runtime code, by the AST id of its variable (or
 * solc's own key, LIBRARY_DEPLOY_ADDRESS). */
export type ImmutableReferences = Record<string, { start: number; length: number }[]>;

/** One immutable as its source declares it: its name, its type as solc writes it ("address", "uint64", "contract
 * IERC20", "bytes32"), and the contract that declares it (path:Name, a base contract's for an inherited one). */
export interface ImmutableVariable {
  name: string;
  type: string;
  declaredIn: string;
}

/** solc's key for a library's own address under via-IR: its runtime code compares it with ADDRESS so that a
 * state-changing function refuses a direct call. No source declares it; it holds the address the library is deployed at. */
export const LIBRARY_DEPLOY_ADDRESS = "library_deploy_address";

interface AstNode {
  id?: number;
  nodeType?: string;
  name?: string;
  absolutePath?: string;
  /** An ImportDirective's: the id of the source unit it imports, in this compile. */
  sourceUnit?: number;
  nodes?: AstNode[];
  linearizedBaseContracts?: number[];
  mutability?: string;
  stateVariable?: boolean;
  scope?: number;
  typeDescriptions?: { typeString?: string };
}

/** The parts of a forge artifact the immutables' names come from. */
export interface ForgeArtifact {
  ast?: AstNode;
  metadata?: { compiler?: { version?: string }; sources?: Record<string, { keccak256?: string }> };
  deployedBytecode: { immutableReferences?: ImmutableReferences };
}

/** The variable behind each of `fqn`'s immutables, by the key its immutableReferences use (spec §7 step 3: the AST ids
 * are mapped to their variables through the artifacts' ASTs, which forge writes with `ast = true`). An id is looked up
 * in the contract's own source, then along its imports: a base contract's immutables (CascadeBase's DOMAIN_SEPARATOR,
 * the adapters' CcipAdapterBase, the lenses' target) are declared in another file, whose AST is that file's artifact's
 * (`outDir`/<file>/). AST ids are numbered per solc run, so each imported file's artifact must be of this very compile:
 * its source unit's id is the one the importing AST names (Task 45's review, M2), and a file holding a base must also
 * have the same text (its keccak256 in both metadatas) and compiler. A declaration counts only as a state variable marked
 * immutable, inside one of the contract's linearized bases. solc's own key is LIBRARY_DEPLOY_ADDRESS. Refused when the
 * artifact has no AST, an imported file's artifact is of another compile, or an id resolves to nothing. */
export function immutableVariables(outDir: string, fqn: string, json: ForgeArtifact): Record<string, ImmutableVariable> {
  const [path, name] = fqn.split(":");
  const refs = json.deployedBytecode.immutableReferences ?? {};
  const wanted = Object.keys(refs).filter((k) => k !== LIBRARY_DEPLOY_ADDRESS);
  const out: Record<string, ImmutableVariable> = {};
  if (LIBRARY_DEPLOY_ADDRESS in refs) out[LIBRARY_DEPLOY_ADDRESS] = { name: LIBRARY_DEPLOY_ADDRESS, type: "address", declaredIn: fqn };
  if (!wanted.length) return out;
  const own = json.ast;
  if (!own?.nodes || own.absolutePath !== path) throw new Error(`contracts/out's ${name} has no AST of ${path} (forge builds one with ast = true): its immutables cannot be named; nothing frozen or sent`);
  const def = own.nodes.find((n) => n.nodeType === "ContractDefinition" && n.name === name);
  if (!def?.linearizedBaseContracts) throw new Error(`contracts/out's ${name}: its AST declares no contract ${name}; nothing frozen or sent`);
  const bases = new Set(def.linearizedBaseContracts);
  const compiler = json.metadata?.compiler?.version;
  const sources = json.metadata?.sources ?? {};
  const left = new Set(wanted);
  /** The contract's bases `ast` declares (none in a file of interfaces, errors or constants only). */
  const basesIn = (ast: AstNode) => (ast.nodes ?? []).filter((c) => c.nodeType === "ContractDefinition" && c.id !== undefined && bases.has(c.id));
  const take = (defs: AstNode[], file: string) => {
    for (const c of defs) {
      for (const v of c.nodes ?? []) {
        const id = String(v.id);
        if (v.nodeType !== "VariableDeclaration" || !left.has(id) || v.mutability !== "immutable" || v.stateVariable !== true || v.scope !== c.id) continue;
        out[id] = { name: v.name ?? "", type: v.typeDescriptions?.typeString ?? "", declaredIn: `${file}:${c.name}` };
        left.delete(id);
      }
    }
  };
  take(basesIn(own), path);
  // the files this contract's source imports, then theirs: each tied to this compile by the source unit its importer names
  const queue: { file: string; unit: number; importer: string }[] = [];
  const seen = new Set<string>([path]);
  const follow = (ast: AstNode, importer: string) => {
    for (const n of ast.nodes ?? []) {
      if (n.nodeType !== "ImportDirective" || !n.absolutePath || n.sourceUnit === undefined || seen.has(n.absolutePath)) continue;
      seen.add(n.absolutePath);
      queue.push({ file: n.absolutePath, unit: n.sourceUnit, importer });
    }
  };
  follow(own, name);
  while (left.size && queue.length) {
    const { file, unit, importer } = queue.shift()!;
    const other = sourceArtifact(outDir, file);
    if (!other?.ast) continue;
    if (other.ast.id !== unit) {
      throw new Error(
        `contracts/out's ${basename(file)} is from another compile than ${name} (its source unit is ${other.ast.id}, and ${importer} imports ${unit}): rebuild with forge build --force; nothing frozen or sent`,
      );
    }
    const defs = basesIn(other.ast);
    if (defs.length && (other.metadata?.compiler?.version !== compiler || other.metadata?.sources?.[file]?.keccak256 !== sources[file]?.keccak256)) {
      throw new Error(
        `contracts/out's ${basename(file)} is not from the build of ${name} (another compiler or another text of ${file}): its immutables cannot be named: rebuild with forge build --force; nothing frozen or sent`,
      );
    }
    take(defs, file);
    follow(other.ast, basename(file));
  }
  if (left.size) {
    throw new Error(`contracts/out's ${name}: no source it was compiled with declares its immutable${left.size === 1 ? "" : "s"} of AST id ${[...left].join(", ")}; nothing frozen or sent`);
  }
  return out;
}

/** An artifact of source `file` in forge's output `outDir` (any contract of it: each holds the whole file's AST), or
 * undefined when the build wrote none there. */
function sourceArtifact(outDir: string, file: string): ForgeArtifact | undefined {
  const dir = join(outDir, basename(file));
  if (!existsSync(dir)) return undefined;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as ForgeArtifact;
    if (j.ast?.absolutePath === file) return j;
  }
  return undefined;
}

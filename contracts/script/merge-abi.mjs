// The published vault ABI, abi/CascadeVault.json: the vault artifact's ABI plus every event and
// error of each library the vault links, directly or through another library (followed through
// the artifacts' linkReferences). A file-level event or error that only a library emits is in that
// library's artifact, not the vault's, yet it comes from the vault's address (spec §8.1), so ops,
// the indexer and the web decode the vault's logs and reverts with this merged ABI.
// Entries are de-duplicated (each event and error is declared once, so a copy is identical) and
// sorted by type, then name, then signature, so moving code between the vault and a library leaves
// the file as it was. Two events or errors with one name and different inputs fail the merge.
// Usage: node script/merge-abi.mjs [--check] [--out <forge out dir>] [--abi <file>]
//   (no flag) writes the file; --check exits 1 when the file differs from a fresh merge.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT = join(ROOT, 'out');
export const DEFAULT_ABI = join(ROOT, 'abi', 'CascadeVault.json');

const isEventOrError = (x) => x.type === 'event' || x.type === 'error';

/** A parameter's type as a selector spells it: tuples written out. */
function canonicalType(p) {
  if (!p.type.startsWith('tuple')) return p.type;
  return `(${(p.components ?? []).map(canonicalType).join(',')})${p.type.slice('tuple'.length)}`;
}

/** "error Name(uint256)", "event Name(address indexed,uint256)", "function f(uint256)",
 * "constructor(address)", "receive", "fallback". */
export function signature(x) {
  if (x.type === 'receive' || x.type === 'fallback') return x.type;
  const types = (x.inputs ?? []).map((p) => `${canonicalType(p)}${x.type === 'event' && p.indexed ? ' indexed' : ''}`).join(',');
  if (x.type === 'constructor') return `constructor(${types})`;
  return `${x.type} ${x.name}(${types})${x.anonymous ? ' anonymous' : ''}`;
}

const ENTRY_KEYS = ['type', 'name', 'inputs', 'outputs', 'stateMutability', 'anonymous'];
const PARAM_KEYS = ['name', 'type', 'indexed', 'internalType', 'components'];

/** `o` with `first` keys in that order, then any others alphabetically. */
function ordered(o, first, inner) {
  const keys = [...first.filter((k) => k in o), ...Object.keys(o).filter((k) => !first.includes(k)).sort()];
  return Object.fromEntries(keys.map((k) => [k, inner(k, o[k])]));
}
const canonicalParam = (p) => ordered(p, PARAM_KEYS, (k, v) => (k === 'components' ? v.map(canonicalParam) : v));
const canonical = (x) => ordered(x, ENTRY_KEYS, (k, v) => (k === 'inputs' || k === 'outputs' ? v.map(canonicalParam) : v));

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byTypeNameSignature = (a, b) => cmp(a.type, b.type) || cmp(a.name ?? '', b.name ?? '') || cmp(signature(a), signature(b));

/** The vault's ABI and its libraries' events and errors, de-duplicated and sorted. Throws when two
 * events or two errors share a name but not their inputs (or indexing, or argument names). */
export function mergeAbi(vault, libraries) {
  const seen = new Map();
  const merged = [];
  for (const x of [...vault, ...libraries.flatMap((abi) => abi.filter(isEventOrError))].map(canonical)) {
    if (!isEventOrError(x)) {
      merged.push(x);
      continue;
    }
    const key = `${x.type} ${x.name}`;
    const text = JSON.stringify(x);
    const prior = seen.get(key);
    if (prior === undefined) {
      seen.set(key, text);
      merged.push(x);
    } else if (prior !== text) {
      throw new Error(`conflicting ${key}: ${prior} vs ${text}`);
    }
  }
  return merged.sort(byTypeNameSignature);
}

/** The signature of each library event or error the merged ABI lacks (empty when it covers them). */
export function missingFrom(merged, libraries) {
  const present = new Set(merged.filter(isEventOrError).map((x) => JSON.stringify(canonical(x))));
  const missing = [];
  for (const x of libraries.flatMap((abi) => abi.filter(isEventOrError))) {
    const s = signature(x);
    if (!present.has(JSON.stringify(canonical(x))) && !missing.includes(s)) missing.push(s);
  }
  return missing;
}

function readArtifact(outDir, sourcePath, name) {
  // forge writes out/<file name>/<contract>.json
  const path = join(outDir, basename(sourcePath), `${name}.json`);
  if (!existsSync(path)) throw new Error(`${path} is missing: run forge build first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** `name`'s artifact and every library it links, directly or through another library. */
export function linkedArtifacts(outDir, name, sourcePath = `src/${name}.sol`) {
  const root = { name, path: sourcePath, ...readArtifact(outDir, sourcePath, name) };
  const libraries = [];
  const seen = new Set();
  const visit = (artifact) => {
    for (const refs of [artifact.bytecode?.linkReferences, artifact.deployedBytecode?.linkReferences]) {
      for (const [path, libs] of Object.entries(refs ?? {})) {
        for (const lib of Object.keys(libs)) {
          if (seen.has(`${path}:${lib}`)) continue;
          seen.add(`${path}:${lib}`);
          const a = { name: lib, path, ...readArtifact(outDir, path, lib) };
          libraries.push(a);
          visit(a);
        }
      }
    }
  };
  visit(root);
  return { root, libraries };
}

/** The merged ABI as the file holds it: two-space JSON, LF, a final newline. */
export function mergedText(outDir) {
  const { root, libraries } = linkedArtifacts(outDir, 'CascadeVault');
  const libAbis = libraries.map((l) => l.abi);
  const merged = mergeAbi(root.abi, libAbis);
  const missing = missingFrom(merged, libAbis);
  if (missing.length) throw new Error(`the merged ABI lacks library entries: ${missing.join(', ')}`);
  return { text: `${JSON.stringify(merged, null, 2)}\n`, merged, libraries };
}

function arg(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  if (!argv[i + 1]) throw new Error(`${flag} needs a path`);
  return resolve(argv[i + 1]);
}

function main() {
  const argv = process.argv.slice(2);
  const outDir = arg(argv, '--out', DEFAULT_OUT);
  const abiPath = arg(argv, '--abi', DEFAULT_ABI);
  const shown = (relative(process.cwd(), abiPath) || abiPath).split(sep).join('/');
  let fresh;
  try {
    fresh = mergedText(outDir);
  } catch (e) {
    console.error(`merge-abi: ${e.message}`);
    process.exit(1);
  }
  const { text, merged, libraries } = fresh;
  const from = libraries.length ? libraries.map((l) => l.name).join(', ') : 'none';
  if (!argv.includes('--check')) {
    mkdirSync(dirname(abiPath), { recursive: true });
    writeFileSync(abiPath, text);
    console.log(`Wrote ${shown}: ${merged.length} entries (linked libraries: ${from}).`);
    return;
  }
  const regenerate = 'Run `node script/merge-abi.mjs` from contracts/ and commit the file.';
  if (!existsSync(abiPath)) {
    console.error(`${shown} is missing. ${regenerate}`);
    process.exit(1);
  }
  const committed = readFileSync(abiPath, 'utf8').replace(/\r\n/g, '\n');
  if (committed !== text) {
    let detail = '';
    try {
      const was = new Set(JSON.parse(committed).map(signature));
      const now = new Set(merged.map(signature));
      const added = [...now].filter((s) => !was.has(s));
      const removed = [...was].filter((s) => !now.has(s));
      detail = `${added.length ? `\n  not in the file: ${added.join(', ')}` : ''}${removed.length ? `\n  no longer in the build: ${removed.join(', ')}` : ''}`;
    } catch {
      detail = '\n  (the file is not valid JSON)';
    }
    console.error(`${shown} is stale: it differs from a fresh merge of the build.${detail}\n${regenerate}`);
    process.exit(1);
  }
  console.log(`${shown} matches the build: ${merged.length} entries (linked libraries: ${from}).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

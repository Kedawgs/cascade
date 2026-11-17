// The lenses' layout constants, src/lens/generated/{VaultLayout,DoorLayout}.sol: where the vault and
// the front door keep each state variable, and each member of the shared structs, so a lens reading
// its target through extsload cannot drift from the target's storage (spec §8.1). They are generated
// from the storage layout of the build in out/ (foundry.toml's extra_output = ["storageLayout"]),
// not from `forge inspect`, which can rebuild the project (ruling DB11).
//
// Per target, for every state variable in slot order: SLOT_<VAR>, OFFSET_<VAR> (the byte offset of
// its lowest byte within the slot) and SIZE_<VAR> (bytes). Then, for each struct in STRUCTS that the
// target's layout holds: <STRUCT>_<MEMBER>_SLOT (counted from the struct's first slot), _OFFSET and
// _SIZE. Names are the Solidity names in upper snake case, a leading underscore dropped. Only names,
// slots, offsets, sizes and type names are emitted, never an astId or a type id, which change on
// unrelated edits; the text is LF with one final newline, so it is canonical (ruling DB12).
// Usage: node script/gen-lens-layout.mjs [--check] [--out <forge out dir>] [--dir <generated dir>]
//   (no flag) writes both files; --check generates them into a temporary directory and exits 1 when
//   either committed file differs from it by any byte.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT = join(ROOT, 'out');
export const DEFAULT_DIR = join(ROOT, 'src', 'lens', 'generated');

/** The two lens targets: the artifact each is read from and the library each file declares. */
export const TARGETS = [
  { contract: 'CascadeVault', source: 'CascadeVault.sol', library: 'VaultLayout', file: 'VaultLayout.sol' },
  { contract: 'CascadeFrontDoor', source: 'CascadeFrontDoor.sol', library: 'DoorLayout', file: 'DoorLayout.sol' },
];

/** The shared structs of CascadeTypes.sol whose members a lens reads, in the order emitted. Ledger
 * (the vault's since Task 5f), Item (Task 7) and Holder (the vault's since R4: the redeem origin and the door hold's
 * fresh shares) are emitted once a
 * target's layout holds them; a struct
 * declared inside a contract (the front door's Batch and Delivery) is not one of them. */
export const STRUCTS = ['SharesData', 'PayoutBatch', 'Window', 'Ledger', 'Item', 'Holder'];

/** The structs of CascadeTypes.sol that only travel in memory, as a library call's arguments or results
 * (Task 5e's BatchIn for L1, Task 5f's WalkParams for L2, Task 5g's PayoutIn and PayoutPlan for L3): never in
 * a target's storage, so no lens reads them. A layout that holds one fails, since a lens would then need its
 * member constants. */
export const MEMORY_ONLY = ['BatchIn', 'WalkParams', 'PayoutIn', 'PayoutPlan'];

/** guardianProposedAt -> GUARDIAN_PROPOSED_AT, _pendingOwner -> PENDING_OWNER. */
export function upperSnake(name) {
  return name
    .replace(/^_+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

const bySlotThenOffset = (a, b) => {
  const da = BigInt(a.slot) - BigInt(b.slot);
  return da !== 0n ? (da < 0n ? -1 : 1) : a.offset - b.offset;
};

function typeOf(types, id, where) {
  const t = types[id];
  if (!t) throw new Error(`${where}: the storage layout has no type ${id}`);
  return t;
}

/** Each STRUCTS entry the layout holds, with its members in slot order. */
function sharedStructs(types, where) {
  const found = [];
  for (const name of STRUCTS) {
    let members;
    for (const t of Object.values(types)) {
      if (t.label !== `struct ${name}` || !t.members) continue;
      const these = [...t.members].sort(bySlotThenOffset).map((m) => ({
        label: m.label,
        slot: BigInt(m.slot).toString(),
        offset: m.offset,
        size: Number(typeOf(types, m.type, where).numberOfBytes),
        type: typeOf(types, m.type, where).label,
      }));
      if (members && JSON.stringify(members) !== JSON.stringify(these)) {
        throw new Error(`${where}: two different structs are named ${name}`);
      }
      members = these;
    }
    if (members) found.push({ name, members });
  }
  return found;
}

/** The generated file's text for one target's storage layout. `compiler` is the build's compiler
 * version ("0.8.38+commit.…"), whose release the file's pragma names. */
export function generate(layout, target, compiler) {
  const where = target.contract;
  if (!layout?.storage || !layout?.types) throw new Error(`${where}: no storage layout`);
  for (const t of Object.values(layout.types)) {
    const name = MEMORY_ONLY.find((m) => t.label === `struct ${m}`);
    if (name) throw new Error(`${where}: its storage holds ${name}, but ${name} only travels in memory (MEMORY_ONLY)`);
  }
  const pragma = String(compiler).split('+')[0];
  if (!/^\d+\.\d+\.\d+$/.test(pragma)) throw new Error(`${where}: unreadable compiler version ${compiler}`);

  const names = new Set();
  const body = [];
  const constant = (name, value) => {
    if (names.has(name)) throw new Error(`${where}: two constants would be named ${name}`);
    names.add(name);
    body.push(`    uint256 internal constant ${name} = ${value};`);
  };

  for (const v of [...layout.storage].sort(bySlotThenOffset)) {
    const t = typeOf(layout.types, v.type, where);
    const n = upperSnake(v.label);
    body.push(`    // ${v.label}: ${t.label}`);
    constant(`SLOT_${n}`, BigInt(v.slot).toString());
    constant(`OFFSET_${n}`, v.offset);
    constant(`SIZE_${n}`, Number(t.numberOfBytes));
    body.push('');
  }
  for (const { name, members } of sharedStructs(layout.types, where)) {
    const s = upperSnake(name);
    body.push(`    // struct ${name}`);
    for (const m of members) {
      const p = `${s}_${upperSnake(m.label)}`;
      body.push(`    // ${name}.${m.label}: ${m.type}`);
      constant(`${p}_SLOT`, m.slot);
      constant(`${p}_OFFSET`, m.offset);
      constant(`${p}_SIZE`, m.size);
    }
    body.push('');
  }
  while (body.at(-1) === '') body.pop();

  return [
    '// SPDX-License-Identifier: MIT',
    `pragma solidity ${pragma};`,
    '',
    `// GENERATED by script/gen-lens-layout.mjs from the storage layout of ${target.contract} in the build.`,
    `// Do not edit. After a change to ${target.contract}'s state, run \`forge build\` and then`,
    '// `node script/gen-lens-layout.mjs` from contracts/, and commit the result: the build checks fail',
    '// while this file differs from a fresh generation.',
    '',
    `/// Where ${target.contract} keeps its state. SLOT_<VAR> is a state variable's slot, OFFSET_<VAR> the`,
    '/// byte offset of its lowest byte within the slot, SIZE_<VAR> its size in bytes. For each shared',
    '/// struct of CascadeTypes.sol in this layout, <STRUCT>_<MEMBER>_SLOT is a member\'s slot counted from',
    '/// the struct\'s first slot, with its _OFFSET and _SIZE likewise.',
    `library ${target.library} {`,
    ...body,
    '}',
    '',
  ].join('\n');
}

function readArtifact(outDir, target) {
  // forge writes out/<file name>/<contract>.json
  const path = join(outDir, target.source, `${target.contract}.json`);
  if (!existsSync(path)) throw new Error(`${path} is missing: run forge build first`);
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  if (!artifact.storageLayout) {
    throw new Error(`${path} has no storageLayout: foundry.toml's [profile.default] needs extra_output = ["storageLayout"]; then forge build`);
  }
  const compiler = artifact.metadata?.compiler?.version;
  if (!compiler) throw new Error(`${path} has no compiler version in its metadata`);
  return { layout: artifact.storageLayout, compiler };
}

/** Both targets' files, freshly generated from the build in `outDir`. */
export function generateAll(outDir = DEFAULT_OUT) {
  return TARGETS.map((target) => {
    const { layout, compiler } = readArtifact(outDir, target);
    const text = generate(layout, target, compiler);
    const structs = sharedStructs(layout.types, target.contract).map((s) => s.name);
    return { target, text, variables: layout.storage.length, structs };
  });
}

function writeAll(files, dir) {
  mkdirSync(dir, { recursive: true });
  for (const { target, text } of files) writeFileSync(join(dir, target.file), text);
}

/** What the committed file lacks and what it has that a fresh generation does not, line by line. */
function describe(committed, fresh) {
  if (committed.replace(/\r\n/g, '\n') === fresh) return '\n  only its line endings differ (CRLF): the file must be LF';
  const was = new Set(committed.split('\n'));
  const now = new Set(fresh.split('\n'));
  const added = [...now].filter((l) => !was.has(l) && l.trim());
  const removed = [...was].filter((l) => !now.has(l) && l.trim());
  const show = (ls) => ls.map((l) => `\n    ${l.trim()}`).join('');
  return `${added.length ? `\n  not in the file:${show(added)}` : ''}${removed.length ? `\n  no longer in the build:${show(removed)}` : ''}`;
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
  const dir = arg(argv, '--dir', DEFAULT_DIR);
  const shown = (file) => (relative(process.cwd(), join(dir, file)) || file).split(sep).join('/');
  const summary = (f) => `${f.variables} variables; shared structs: ${f.structs.length ? f.structs.join(', ') : 'none'}`;
  let files;
  try {
    files = generateAll(outDir);
  } catch (e) {
    console.error(`gen-lens-layout: ${e.message}`);
    process.exit(1);
  }

  if (!argv.includes('--check')) {
    writeAll(files, dir);
    for (const f of files) console.log(`Wrote ${shown(f.target.file)}: ${summary(f)}.`);
    return;
  }

  // Generate into a temporary directory and compare bytes, so a check never touches the committed files.
  const tmp = mkdtempSync(join(tmpdir(), 'gen-lens-layout-'));
  let failed = false;
  try {
    writeAll(files, tmp);
    for (const f of files) {
      const fresh = readFileSync(join(tmp, f.target.file));
      const path = join(dir, f.target.file);
      const regenerate = 'Run `forge build`, then `node script/gen-lens-layout.mjs` from contracts/, and commit the files.';
      if (!existsSync(path)) {
        console.error(`${shown(f.target.file)} is missing. ${regenerate}`);
        failed = true;
      } else if (!readFileSync(path).equals(fresh)) {
        const detail = describe(readFileSync(path, 'utf8'), fresh.toString('utf8'));
        console.error(`${shown(f.target.file)} is stale: it differs from a fresh generation of the build.${detail}\n${regenerate}`);
        failed = true;
      } else {
        console.log(`${shown(f.target.file)} matches the build: ${summary(f)}.`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

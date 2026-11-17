// The library links' constants, test/utils/generated/LibraryLinks.sol (Task 34a, ruling DB9): where each linking
// artifact's runtime code names the libraries it links (solc's deployedBytecode.linkReferences), and where each
// linked library's runtime code holds its own address (the call guard's `library_deploy_address` immutable, a
// 32-byte word). The test suite reads them to check I-32's run-time half (test/utils/LinkedLibraries.sol): every
// reference names the library deployed at its linked address, and the code there is that library's deployed code.
// So no test needs fs_permissions to read the build. Generated from the build in out/, as the lens layout is.
//
// The linking artifacts are LINK_GRAPH's (script/library-rules.mjs: the vault and L3) and VaultInternals, the
// vault's test-only subclass the invariant campaigns deploy (its own code, so its own offsets). Per artifact a
// function in contract order returns each linked library, by name in name order, with its offsets ascending; then
// one function maps each linked library to its own-address words. Only names and offsets are emitted, never a
// hash or an AST id; the text is LF with one final newline, so it is canonical.
// Usage: node script/gen-library-links.mjs [--check] [--out <forge out dir>] [--file <generated file>]
//   (no flag) writes the file; --check generates it into a temporary directory and exits 1 when the committed
//   file differs from it by any byte.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINK_GRAPH } from './library-rules.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT = join(ROOT, 'out');
export const DEFAULT_FILE = join(ROOT, 'test', 'utils', 'generated', 'LibraryLinks.sol');

/** The linking artifacts, in the order emitted: LINK_GRAPH's, then the test-only subclass of the vault. */
export const LINKERS = [...Object.keys(LINK_GRAPH), 'VaultInternals'];

/** The immutable solc gives a library's runtime code for its own address (the call guard's). */
export const SELF = 'library_deploy_address';

/** CascadeVault -> cascadeVault: the function's name for an artifact. */
export const functionName = (contract) => contract[0].toLowerCase() + contract.slice(1);

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** CascadeVault -> CascadeVault's, VaultInternals -> VaultInternals'. */
const possessive = (name) => (name.endsWith('s') ? `${name}'` : `${name}'s`);

/** out/<file>.sol/<contract>.json for `contract`, wherever its source sits (forge names the directory after the
 * file). */
function findArtifact(outDir, contract) {
  const path = join(outDir, `${contract}.sol`, `${contract}.json`);
  if (!existsSync(path)) throw new Error(`${path} is missing: run forge build first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** [{ name, offsets }] of the libraries `linkReferences` names, by name, offsets ascending; each reference 20 bytes. */
export function linksOf(linkReferences, where) {
  const links = [];
  for (const libs of Object.values(linkReferences ?? {})) {
    for (const [name, refs] of Object.entries(libs)) {
      if (links.some((l) => l.name === name)) throw new Error(`${where}: two libraries are named ${name}`);
      for (const r of refs) if (r.length !== 20) throw new Error(`${where}: a reference to ${name} is ${r.length} bytes, not 20`);
      links.push({ name, offsets: refs.map((r) => r.start).sort((a, b) => a - b) });
    }
  }
  return links.sort((a, b) => byName(a.name, b.name));
}

/** The offsets of the 32-byte words a library's runtime code holds its own address in (none without a call guard). */
export function selfWordsOf(immutableReferences, where) {
  const refs = immutableReferences?.[SELF] ?? [];
  for (const r of refs) if (r.length !== 32) throw new Error(`${where}: its own address is a ${r.length}-byte word, not 32`);
  return refs.map((r) => r.start).sort((a, b) => a - b);
}

/** The model the file is generated from: each linking artifact's links, and each linked library's own-address words. */
export function model(outDir = DEFAULT_OUT) {
  const linkers = LINKERS.map((contract) => {
    const a = findArtifact(outDir, contract);
    const links = linksOf(a.deployedBytecode?.linkReferences, contract);
    if (!links.length) throw new Error(`${contract}'s runtime code links nothing: run forge build first, or drop it from LINKERS`);
    return { contract, links };
  });
  const names = [...new Set(linkers.flatMap((l) => l.links.map((x) => x.name)))].sort(byName);
  const libraries = names.map((name) => {
    const a = findArtifact(outDir, name);
    return { name, selfWords: selfWordsOf(a.deployedBytecode?.immutableReferences, name) };
  });
  const compiler = findArtifact(outDir, LINKERS[0]).metadata?.compiler?.version;
  if (!compiler) throw new Error(`${LINKERS[0]}'s artifact has no compiler version in its metadata`);
  return { linkers, libraries, compiler };
}

/** The generated file's text for `m` (model()). */
export function generate(m) {
  const pragma = String(m.compiler).split('+')[0];
  if (!/^\d+\.\d+\.\d+$/.test(pragma)) throw new Error(`unreadable compiler version ${m.compiler}`);
  const body = [];
  for (const { contract, links } of m.linkers) {
    body.push(`    /// ${possessive(contract)} runtime code links ${links.map((l) => l.name).join(', ')}.`);
    body.push(`    function ${functionName(contract)}() internal pure returns (LibraryLink[] memory links) {`);
    body.push(`        links = new LibraryLink[](${links.length});`);
    links.forEach(({ name, offsets }, i) => {
      body.push(`        links[${i}].name = "${name}";`);
      body.push(`        links[${i}].offsets = new uint256[](${offsets.length});`);
      offsets.forEach((o, j) => body.push(`        links[${i}].offsets[${j}] = ${o};`));
    });
    body.push('    }', '');
  }
  body.push(
    '    /// The byte offsets of the 32-byte words in library `name`\'s runtime code that hold its own address (its call',
    '    /// guard\'s library_deploy_address; none for a library without one), for each library a linking artifact links.',
    '    function selfAddressWords(string memory name) internal pure returns (uint256[] memory offsets) {',
    '        bytes32 h = keccak256(bytes(name));',
  );
  m.libraries.forEach(({ name, selfWords }, i) => {
    body.push(`        ${i ? '} else if' : 'if'} (h == keccak256("${name}")) {`);
    body.push(`            offsets = new uint256[](${selfWords.length});`);
    selfWords.forEach((o, j) => body.push(`            offsets[${j}] = ${o};`));
  });
  body.push('        } else {', '            revert("LibraryLinks: not a linked library");', '        }', '    }');

  return [
    '// SPDX-License-Identifier: MIT',
    `pragma solidity ${pragma};`,
    '',
    '// GENERATED by script/gen-library-links.mjs from the link references and immutables of the build\'s runtime code.',
    '// Do not edit. After a change to a linking contract\'s code or a library\'s, run `forge build` and then',
    '// `node script/gen-library-links.mjs` from contracts/, and commit the result: the build checks fail while this',
    '// file differs from a fresh generation.',
    '',
    '/// One library a runtime code links: its contract name and the byte offset of each 20-byte reference to its address.',
    'struct LibraryLink {',
    '    string name;',
    '    uint256[] offsets;',
    '}',
    '',
    '/// Where each linking artifact\'s runtime code names the libraries it links, and where each linked library\'s',
    '/// runtime code holds its own address (I-32\'s run-time half, test/utils/LinkedLibraries.sol).',
    'library LibraryLinks {',
    ...body,
    '}',
    '',
  ].join('\n');
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
  const file = arg(argv, '--file', DEFAULT_FILE);
  const shown = (relative(process.cwd(), file) || file).split(sep).join('/');
  let m;
  let text;
  try {
    m = model(outDir);
    text = generate(m);
  } catch (e) {
    console.error(`gen-library-links: ${e.message}`);
    process.exit(1);
  }
  const summary = m.linkers.map((l) => `${l.contract} links ${l.links.length}`).join(', ');

  if (!argv.includes('--check')) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`Wrote ${shown}: ${summary}.`);
    return;
  }

  // Generate into a temporary directory and compare bytes, so a check never touches the committed file.
  const tmp = mkdtempSync(join(tmpdir(), 'gen-library-links-'));
  let failed = false;
  try {
    const fresh = join(tmp, 'LibraryLinks.sol');
    writeFileSync(fresh, text);
    const regenerate = 'Run `forge build`, then `node script/gen-library-links.mjs` from contracts/, and commit the file.';
    if (!existsSync(file)) {
      console.error(`${shown} is missing. ${regenerate}`);
      failed = true;
    } else if (!readFileSync(file).equals(readFileSync(fresh))) {
      const crlf = readFileSync(file, 'utf8').replace(/\r\n/g, '\n') === text;
      const detail = crlf ? ' (only its line endings differ: the file must be LF)' : '';
      console.error(`${shown} is stale: it differs from a fresh generation of the build${detail}. ${regenerate}`);
      failed = true;
    } else {
      console.log(`${shown} matches the build: ${summary}.`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

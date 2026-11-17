import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS } from './build-checks.mjs';
import { DEFAULT_FILE, functionName, generate, LINKERS, linksOf, model, SELF, selfWordsOf } from './gen-library-links.mjs';
import { LINK_GRAPH } from './library-rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'gen-library-links.mjs');
const OUT = join(here, '..', 'out');

const artifact = (contract) => JSON.parse(readFileSync(join(OUT, `${contract}.sol`, `${contract}.json`), 'utf8'));

// ---- the real build (forge build first) ----

test('regenerationMatchesTheCommittedFile', () => {
  const committed = readFileSync(DEFAULT_FILE);
  assert.ok(committed.equals(Buffer.from(generate(model(OUT)))), 'LibraryLinks.sol differs from a fresh generation');
  const r = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LibraryLinks\.sol matches the build/);
});

test('theLinkersAreTheLinkGraphsAndTheVaultsSubclass', () => {
  assert.deepEqual(LINKERS, [...Object.keys(LINK_GRAPH), 'VaultInternals']);
  const m = model(OUT);
  const names = (contract) => m.linkers.find((l) => l.contract === contract).links.map((l) => l.name);
  for (const [contract, libs] of Object.entries(LINK_GRAPH)) assert.deepEqual(names(contract), [...libs].sort());
  // the test-only subclass links what the vault links, at its own offsets
  assert.deepEqual(names('VaultInternals'), names('CascadeVault'));
  const offsets = (contract) => m.linkers.find((l) => l.contract === contract).links.map((l) => l.offsets);
  assert.notDeepEqual(offsets('VaultInternals'), offsets('CascadeVault'));
});

test('eachOffsetIsALinkPlaceholderInTheUnlinkedCode', () => {
  // in the artifact's unlinked runtime code each reference is solc's 40-character __$<hash>$__ placeholder, and the
  // library's own address is a 32-byte word of zeros (the call guard's immutable, filled in at deploy)
  const m = model(OUT);
  for (const { contract, links } of m.linkers) {
    const hex = artifact(contract).deployedBytecode.object.replace(/^0x/, '');
    for (const { name, offsets } of links) {
      assert.ok(offsets.length > 0, `${contract} references ${name}`);
      for (const o of offsets) assert.match(hex.slice(2 * o, 2 * o + 40), /^__\$[0-9a-f]{34}\$__$/, `${contract}: ${name} at ${o}`);
    }
  }
  for (const { name, selfWords } of m.libraries) {
    const hex = artifact(name).deployedBytecode.object.replace(/^0x/, '');
    for (const o of selfWords) assert.equal(hex.slice(2 * o, 2 * o + 64), '0'.repeat(64), `${name}'s own address at ${o}`);
  }
  // every library with a non-view external function has a call guard, so an own-address word; the pure payout math
  // has none
  const self = Object.fromEntries(m.libraries.map((l) => [l.name, l.selfWords]));
  for (const name of ['CascadeBatchLib', 'CascadeStakeLib', 'CascadePayoutLib', 'CascadeHotkeyLib']) {
    assert.ok(self[name].length > 0, `${name} has its own address`);
  }
  assert.deepEqual(self.CascadePayoutMath, []);
});

test('theBuildChecksRunTheLinksCheck', () => {
  assert.ok(CHECKS.some((c) => c.script === 'gen-library-links.mjs' && c.args.includes('--check')));
});

// ---- the pieces ----

test('linksOf sorts by name and offset and refuses a reference that is not 20 bytes', () => {
  const refs = {
    'src/libraries/B.sol': { B: [{ start: 90, length: 20 }, { start: 7, length: 20 }] },
    'src/libraries/A.sol': { A: [{ start: 40, length: 20 }] },
  };
  assert.deepEqual(linksOf(refs, 'X'), [
    { name: 'A', offsets: [40] },
    { name: 'B', offsets: [7, 90] },
  ]);
  assert.deepEqual(linksOf(undefined, 'X'), []);
  assert.throws(() => linksOf({ 'a.sol': { A: [{ start: 1, length: 32 }] } }, 'X'), /32 bytes, not 20/);
  assert.throws(() => linksOf({ 'a.sol': { A: [] }, 'b.sol': { A: [] } }, 'X'), /two libraries are named A/);
});

test('selfWordsOf reads the call guard and refuses a word that is not 32 bytes', () => {
  assert.deepEqual(selfWordsOf({ [SELF]: [{ start: 39, length: 32 }, { start: 7, length: 32 }] }, 'L'), [7, 39]);
  assert.deepEqual(selfWordsOf({ 123: [{ start: 1, length: 32 }] }, 'L'), [], 'another immutable is not the address');
  assert.deepEqual(selfWordsOf(undefined, 'L'), []);
  assert.throws(() => selfWordsOf({ [SELF]: [{ start: 7, length: 20 }] }, 'L'), /20-byte word, not 32/);
});

test('the output is canonical: stable order, LF, one final newline, a function per linker', () => {
  const m = {
    compiler: '0.8.38+commit.abc',
    linkers: [
      { contract: 'CascadeVault', links: [{ name: 'A', offsets: [3, 9] }] },
      { contract: 'VaultInternals', links: [{ name: 'A', offsets: [5] }] },
    ],
    libraries: [{ name: 'A', selfWords: [7] }],
  };
  const text = generate(m);
  assert.equal(text, generate(m));
  assert.ok(text.endsWith('}\n') && !text.endsWith('\n\n'));
  assert.ok(!text.includes('\r'));
  assert.match(text, /^pragma solidity 0\.8\.38;$/m);
  assert.match(text, /function cascadeVault\(\) internal pure/);
  assert.match(text, /VaultInternals' runtime code links A\./);
  assert.match(text, /links\[0\]\.offsets\[1\] = 9;/);
  assert.match(text, /if \(h == keccak256\("A"\)\) \{\n {12}offsets = new uint256\[\]\(1\);\n {12}offsets\[0\] = 7;/);
  assert.equal(functionName('CascadePayoutLib'), 'cascadePayoutLib');
  assert.throws(() => generate({ ...m, compiler: 'nonsense' }), /unreadable compiler version/);
});

// ---- a fake build ----

/** A build with a vault, its subclass and L3 linking A and B, each library with a call guard but B. */
function fakeBuild({ vaultOffset = 100 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gen-library-links-test-'));
  const write = (contract, deployedBytecode, metadata) => {
    mkdirSync(join(dir, `${contract}.sol`), { recursive: true });
    writeFileSync(join(dir, `${contract}.sol`, `${contract}.json`), JSON.stringify({ deployedBytecode, metadata }));
  };
  const link = (lib, start) => ({ [`src/libraries/${lib}.sol`]: { [lib]: [{ start, length: 20 }] } });
  const meta = { compiler: { version: '0.8.38+commit.0' } };
  write('CascadeVault', { linkReferences: link('CascadeBatchLib', vaultOffset) }, meta);
  write('VaultInternals', { linkReferences: link('CascadeBatchLib', 200) }, meta);
  write('CascadePayoutLib', { linkReferences: link('CascadePayoutMath', 300), immutableReferences: { [SELF]: [{ start: 7, length: 32 }] } }, meta);
  write('CascadeBatchLib', { linkReferences: {}, immutableReferences: { [SELF]: [{ start: 39, length: 32 }] } }, meta);
  write('CascadePayoutMath', { linkReferences: {} }, meta);
  return dir;
}

const run = (dir, ...args) =>
  spawnSync(process.execPath, [SCRIPT, '--out', dir, '--file', join(dir, 'LibraryLinks.sol'), ...args], { encoding: 'utf8' });

test('anOffsetChangeFailsTheCheck', () => {
  const dir = fakeBuild();
  let r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /LibraryLinks\.sol is missing/);
  assert.equal(run(dir).status, 0);
  assert.equal(run(dir, '--check').status, 0, 'a fresh generation passes');
  const file = join(dir, 'LibraryLinks.sol');
  const before = readFileSync(file);
  assert.match(before.toString(), /links\[0\]\.offsets\[0\] = 100;/);

  // the vault's code moved: the check fails, says how to regenerate and leaves the file alone
  const moved = fakeBuild({ vaultOffset: 101 });
  r = spawnSync(process.execPath, [SCRIPT, '--out', moved, '--file', file, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /LibraryLinks\.sol is stale/);
  assert.match(r.stderr, /node script\/gen-library-links\.mjs/);
  assert.ok(readFileSync(file).equals(before), '--check generates elsewhere, never over the committed file');

  // any byte: a hand edit, CRLF line endings
  const good = before.toString('utf8');
  for (const [edit, why] of [
    [good.replace('= 100;', '= 99;'), /stale/],
    [good.replace(/\n/g, '\r\n'), /line endings/],
  ]) {
    writeFileSync(file, edit);
    r = run(dir, '--check');
    assert.equal(r.status, 1);
    assert.match(r.stderr, why);
  }
  writeFileSync(file, good);
  assert.equal(run(dir, '--check').status, 0);
});

test('aLinkerThatLinksNothingFails', () => {
  const dir = fakeBuild();
  writeFileSync(join(dir, 'VaultInternals.sol', 'VaultInternals.json'), JSON.stringify({ deployedBytecode: { linkReferences: {} } }));
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /VaultInternals's runtime code links nothing/);
});

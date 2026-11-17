import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS } from './build-checks.mjs';
import { importClosure, loadSources } from './library-rules.mjs';
import { solcProblems } from './warning-gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const SCRIPT = join(here, 'warning-gate.mjs');
const SRC = join(ROOT, 'src');
const VAULT_ARTIFACT = join(ROOT, 'out', 'CascadeVault.sol', 'CascadeVault.json');
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });

test('buildChecksRunTheWarningGate', () => {
  assert.ok(CHECKS.some((c) => c.script === 'warning-gate.mjs'));
});

test('theRealSourcesCompileWarningFree', () => {
  // the whole of src/, forced, with the project's settings, into a scratch directory: out/ is not touched
  const before = statSync(VAULT_ARTIFACT).mtimeMs;
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /src\/ compiles with no solc warning/);
  assert.equal(statSync(VAULT_ARTIFACT).mtimeMs, before, 'the gate builds into a scratch directory, never out/');
});

test('eachShadowingFailsTheGate', () => {
  // the reviewer's N1 to N4 (5f fix round 3): each rebinds a name the library rules trust, compiles, and
  // CALLs its own target; each is a solc warning, 2519 (shadows a declaration) or 2319 (shadows a builtin)
  const dir = mkdtempSync(join(tmpdir(), 'warning-gate-'));
  try {
    cpSync(SRC, join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'interfaces', 'IEvil.sol'),
      [
        '// SPDX-License-Identifier: MIT',
        'pragma solidity 0.8.38;',
        '',
        'interface IEvil {',
        '    function max(uint256 a, uint256 b) external returns (uint256);',
        '    function sub0(uint256 a, uint256 b) external returns (uint256);',
        '    function encode(uint256 a) external returns (bytes memory);',
        '}',
        '',
      ].join('\n'),
    );
    const file = join(dir, 'src', 'libraries', 'CascadeLedger.sol');
    const lines = readFileSync(file, 'utf8').split('\n');
    const imp = lines.findIndex((l) => l.startsWith('import {CascadeFormulas}'));
    lines.splice(imp + 1, 0, 'import {IEvil} from "../interfaces/IEvil.sol";', 'import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";');
    const lib = lines.findIndex((l) => l.startsWith('library CascadeLedger {'));
    const shapes = [
      ['N1: a local shadowing Math', '    function n1() internal { IEvil Math = IEvil(address(0xd1)); Math.max(1, 2); }', '2519'],
      ['N2: a local shadowing a library', '    function n2() internal { IEvil CascadeFormulas = IEvil(address(0xd2)); CascadeFormulas.sub0(1, 2); }', '2519'],
      ['N3: a local shadowing abi', '    function n3() internal { IEvil abi = IEvil(address(0xd3)); abi.encode(1); }', '2319'],
      ['N4: a parameter shadowing a library', '    function n4(IEvil CascadeFormulas) internal { CascadeFormulas.sub0(1, 2); }', '2519'],
    ];
    lines.splice(lib + 1, 0, ...shapes.map(([, code]) => code));
    writeFileSync(file, lines.join('\n'));
    const r = run('--src', join(dir, 'src'));
    assert.equal(r.status, 1, r.stdout);
    shapes.forEach(([what, , code], i) => {
      const line = lib + 2 + i;
      assert.match(r.stderr, new RegExp(`src/libraries/CascadeLedger\\.sol:${line}: warning ${code}: This declaration shadows`), what);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('theGateHoldsWhenFoundryIgnoresTheShadowingWarnings', () => {
  // A guard against a forge that filtered its JSON diagnostics by the project's ignore lists: with 2519 and
  // 2319 in ignored_error_codes and src/ in ignored_warnings_from (set through FOUNDRY_* variables, which forge
  // reads over foundry.toml), forge's own report hides both shadowings, and the gate must still fail.
  const dir = mkdtempSync(join(tmpdir(), 'warning-gate-ignored-'));
  try {
    // the ledger helper and the first-party files it imports: enough for a shadowing, and quick to compile
    const LEDGER = 'src/libraries/CascadeLedger.sol';
    for (const p of importClosure(loadSources(SRC), LEDGER)) cpSync(join(ROOT, p), join(dir, p));
    const file = join(dir, LEDGER);
    const lines = readFileSync(file, 'utf8').split('\n');
    const lib = lines.findIndex((l) => l.startsWith('library CascadeLedger {'));
    lines.splice(
      lib + 1,
      0,
      '    function n2() internal pure { uint256 CascadeFormulas = 1; CascadeFormulas; }',
      '    function n3() internal pure { uint256 abi = 1; abi; }',
    );
    writeFileSync(file, lines.join('\n'));
    const src = join(dir, 'src');
    const env = {
      ...process.env,
      FOUNDRY_IGNORED_ERROR_CODES: '[2519, 2319]',
      FOUNDRY_IGNORED_WARNINGS_FROM: JSON.stringify(['src', src.split(sep).join('/')]),
    };
    const forge = process.env.FORGE || 'forge';
    // the settings take: forge's config holds them, and its own report shows neither warning
    const config = JSON.parse(spawnSync(forge, ['config', '--json'], { cwd: ROOT, encoding: 'utf8', env }).stdout);
    assert.equal(config.ignored_error_codes.length, 2, JSON.stringify(config.ignored_error_codes));
    assert.ok(config.ignored_error_codes.includes(2319));
    assert.ok(config.ignored_warnings_from.includes('src'));
    const scratch = join(dir, 'build');
    const plain = spawnSync(forge, ['build', '--force', '--contracts', src, src, '--out', join(scratch, 'out'), '--cache-path', join(scratch, 'cache')], { cwd: ROOT, encoding: 'utf8', env });
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(`${plain.stdout}${plain.stderr}`, /Warning \((2519|2319)\)/);
    // the gate reads forge's JSON, which keeps both
    const r = spawnSync(process.execPath, [SCRIPT, '--src', src], { cwd: ROOT, encoding: 'utf8', env });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, new RegExp(`src/libraries/CascadeLedger\\.sol:${lib + 2}: warning 2519: This declaration shadows`));
    assert.match(r.stderr, new RegExp(`src/libraries/CascadeLedger\\.sol:${lib + 3}: warning 2319: This declaration shadows a builtin`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('solcProblemsReadsSolcsDiagnosticsInSrcOnly', () => {
  // solc's warnings and errors located in src/ count, and so does one with no location (fail closed);
  // those in lib/ or test/ do not; forge-lint's notes never reach this JSON
  const dir = mkdtempSync(join(tmpdir(), 'warning-gate-unit-'));
  try {
    const src = join(dir, 'src');
    cpSync(join(SRC, 'CascadeConstants.sol'), join(src, 'CascadeConstants.sol'));
    const text = readFileSync(join(src, 'CascadeConstants.sol'), 'utf8');
    const start = Buffer.byteLength(text.slice(0, text.indexOf('uint256 constant RAO')));
    const line = text.slice(0, text.indexOf('uint256 constant RAO')).split('\n').length;
    const at = (file, severity, code) => ({ severity, errorCode: code, message: `m${code}`, sourceLocation: { file, start, end: start + 1 } });
    const output = {
      errors: [
        at('src/CascadeConstants.sol', 'warning', '2519'),
        at(`${src.replace(/\\/g, '/')}/CascadeConstants.sol`, 'error', '7576'),
        at('lib/openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol', 'warning', '6335'),
        at('test/invariants/Handler.sol', 'warning', '5574'),
        { severity: 'warning', errorCode: '1878', message: 'no location' },
        at('src/CascadeConstants.sol', 'info', '0000'),
      ],
    };
    assert.deepEqual(solcProblems(output, src, dir), [
      `src/CascadeConstants.sol:${line}: warning 2519: m2519`,
      `src/CascadeConstants.sol:${line}: error 7576: m7576`,
      '(no location): warning 1878: no location',
    ]);
    assert.deepEqual(solcProblems({ errors: [] }, src, dir), []);
    assert.deepEqual(solcProblems({}, src, dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

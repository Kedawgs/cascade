import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS, KEPT, keeping } from './build-checks.mjs';
import {
  assemblyProblems,
  astClosure,
  astRoots,
  BOUNDARY_TESTS,
  boundaryCoverageProblems,
  boundCallProblems,
  bytecodeProblems,
  CALL_OPCODES,
  CALL_TARGETS,
  callProblems,
  callRuleRoots,
  compileAsts,
  delegatecallAstProblems,
  delegatecallBytecodeProblems,
  delegatecallSourceProblems,
  importClosure,
  importsOf,
  libraryRoots,
  LINK_GRAPH,
  linkProblems,
  loadArtifacts,
  loadSources,
  loadTests,
  NO_EXTERNAL_CALL,
  opcodesOf,
  PINNED,
  PRECOMPILE_FUNCTIONS,
  precompileFunctionProblems,
  sourceProblems,
  STATE_OPCODES,
  stripComments,
  VENDOR_IMPORTS,
  WRITE_SET_CALLER,
  WRITE_SETS,
  writeSetProblems,
  YUL_CALLS,
  yulCallProblems,
} from './library-rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'library-rules.mjs');
const SRC = join(here, '..', 'src');
const OUT = join(here, '..', 'out');

const L1 = 'src/libraries/CascadeBatchLib.sol';
const L2 = 'src/libraries/CascadeStakeLib.sol';
const MATH = 'src/libraries/CascadePayoutMath.sol';
const L3 = 'src/libraries/CascadePayoutLib.sol';
const L4 = 'src/libraries/CascadeHotkeyLib.sol';
const VAULT = 'src/CascadeVault.sol';
const FORMULAS = 'src/libraries/CascadeFormulas.sol';
const OZ_MATH = '@openzeppelin/contracts/utils/math/Math.sol';

/** The real sources and build (forge build first), read once; each test changes its own copy. */
const REAL = loadSources(SRC);
const ARTIFACTS = loadArtifacts(OUT);
const copy = () => new Map(REAL);
const clone = () => structuredClone(ARTIFACTS);

/** `sources` with `line` inserted on the line after the first one containing `anchor` in `path`;
 * returns the new line's number (1-based). */
function insertAfter(sources, path, anchor, line) {
  const lines = sources.get(path).split('\n');
  const i = lines.findIndex((l) => l.includes(anchor));
  assert.ok(i !== -1, `${anchor} is not in ${path}`);
  lines.splice(i + 1, 0, line);
  sources.set(path, lines.join('\n'));
  return i + 2;
}

/** The problems naming `path:line`. */
const at = (problems, path, line) => problems.filter((p) => p.startsWith(`${path}:${line}:`));

// ---- the real sources and build ----

test('theRealBuildPassesTheLibraryRules', () => {
  assert.deepEqual(sourceProblems(REAL), []);
  assert.deepEqual(linkProblems(ARTIFACTS), []);
  assert.deepEqual(bytecodeProblems(ARTIFACTS), []);
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CascadeBatchLib/);
  assert.match(r.stdout, /CascadeVault links exactly CascadeBatchLib, CascadeHotkeyLib, CascadePayoutLib, CascadeStakeLib\./);
  assert.match(r.stdout, /CascadePayoutLib links exactly CascadePayoutMath\./);
  assert.match(r.stdout, /No other part of src\/ links anything\./);
  assert.match(r.stdout, /CascadePayoutLib and everything it compiles in call only PayoutIn\.bridge\.quoteFee, PayoutIn\.bridge\.send, msg\.sender\.call\{value\}\(""\) last in finish .*the refund: value only, empty calldata, finish's last statement\) and, by DELEGATECALL, the linked CascadePayoutMath.*on solc's AST/);
  assert.match(r.stdout, /CascadeStakeLib and everything it compiles in call only IStaking\(ISTAKING_ADDRESS\) .*on solc's AST/);
  assert.match(r.stdout, /CascadeBatchLib's own code makes no external call, on solc's AST/);
  // L4 (step L4): the precompile only, and exactly its write set of the vault's storage
  assert.match(r.stdout, /CascadeHotkeyLib and everything it compiles in call only IStaking\(ISTAKING_ADDRESS\) .*on solc's AST/);
  assert.match(r.stdout, /CascadeHotkeyLib and everything it compiles in write only hotkeys, isHotkey, lastClaimAt of CascadeVault's storage, as its call sites bind them, on solc's AST\./);
  assert.match(r.stdout, /CascadeHotkeyLib's runtime code has no SELFDESTRUCT or CALLCODE, and calls only by CALL, STATICCALL\./);
  assert.match(r.stdout, /CascadeHotkeyLib's runtime code has no TSTORE\./);
  // Task 42a: the Yul call rule, the delegatecall rule and the boundary coverage
  assert.match(r.stdout, /No linked library reaches a function whose assembly calls out or creates \(call, callcode, create, create2, delegatecall, selfdestruct, staticcall\), vendored code included, on solc's AST\./);
  assert.match(r.stdout, /No first-party file in src\/ holds delegatecall or callcode in its code\./);
  assert.match(r.stdout, /CascadeVault's code \(its own, its bases' and every function it reaches\) DELEGATECALLs only CascadeBatchLib, CascadeHotkeyLib, CascadePayoutLib, CascadeStakeLib, on solc's AST\./);
  assert.match(r.stdout, /No first-party artifact's runtime or creation code has CALLCODE, and only CascadePayoutLib, CascadeVault have DELEGATECALL \(they link libraries\)\./);
  assert.match(r.stdout, /CascadeHotkeyLib\.add \(0x[0-9a-f]{8}, guarded\): test\/libraries\/LibraryBoundary\.t\.sol:test_everyNonViewLibraryFunctionStopsAtTheCallGuard/);
  assert.match(r.stdout, /CascadePayoutMath\.verify \(0x[0-9a-f]{8}, view\): test\/libraries\/LibraryBoundary\.t\.sol:test_everyPureLibraryFunctionKeepsTheValueAndTouchesNothing/);
  assert.match(r.stdout, /Every external function of the linked libraries in the build \(11\) has its direct-call test\./);
});

test('theRulesScanEveryLinkedLibraryAndItsFirstPartyImports', () => {
  // every *Lib.sol in src/libraries and the payout math, whatever later tasks add (L4 since step L4)
  assert.deepEqual(libraryRoots(REAL), [L1, L4, L3, MATH, L2].sort());
  const withL5 = copy();
  withL5.set('src/libraries/CascadeAdoptLib.sol', 'library CascadeAdoptLib {}\n');
  assert.deepEqual(libraryRoots(withL5), [L1, 'src/libraries/CascadeAdoptLib.sol', L4, L3, MATH, L2].sort());
  // L1's closure: the helpers compiled into it (ruling DB7a), never a vendored file
  const closure = importClosure(REAL, L1);
  for (const p of ['src/CascadeShares.sol', 'src/CascadeTypes.sol', 'src/libraries/CascadeMessages.sol', 'src/libraries/CascadeMath.sol']) {
    assert.ok(closure.includes(p), `${p} is not in L1's closure`);
  }
  assert.ok(closure.every((p) => p.startsWith('src/') && !p.startsWith('src/vendor/')));
  assert.ok(!closure.some((p) => p.includes('openzeppelin')));
});

test('buildChecksRunTheLibraryRules', () => {
  assert.ok(CHECKS.some((c) => c.script === 'library-rules.mjs'));
});

test('buildChecksKeepForgesSavedFailures', () => {
  // Task 42a's carry (from Task 10c): the checks' forced builds remove forge's saved failures from cache/; the checks
  // put them back as they were, whatever ran, a throw included, and leave a path that did not exist as the run left it
  assert.deepEqual(KEPT, ['cache/fuzz', 'cache/invariant', 'cache/test-failures']);
  const root = mkdtempSync(join(tmpdir(), 'build-checks-keep-'));
  try {
    const put = (p, text) => {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    };
    const read = (p) => readFileSync(join(root, p), 'utf8');
    put('cache/invariant/failures/CascadeInvariantTest/invariant_x', 'seed 0x6161');
    put('cache/test-failures', 'test_a');
    const wipe = () => {
      rmSync(join(root, 'cache'), { recursive: true, force: true });
      put('cache/solidity-files-cache.json', '{}');
      put('cache/fuzz/failures', 'new');
    };
    assert.equal(keeping(root, () => (wipe(), 7)), 7, 'the run returns what it returns');
    assert.equal(read('cache/invariant/failures/CascadeInvariantTest/invariant_x'), 'seed 0x6161');
    assert.equal(read('cache/test-failures'), 'test_a');
    assert.equal(read('cache/fuzz/failures'), 'new', 'a path absent before is left as the run left it');
    assert.equal(read('cache/solidity-files-cache.json'), '{}', "the rest of cache/ is the run's");
    // a throw still puts them back
    assert.throws(() => keeping(root, () => (wipe(), put('cache/test-failures', 'changed'), assert.fail('boom'))), /boom/);
    assert.equal(read('cache/invariant/failures/CascadeInvariantTest/invariant_x'), 'seed 0x6161');
    assert.equal(read('cache/test-failures'), 'test_a');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- the source rules (I-32's static half) ----

test('msgValueRefused', () => {
  const s = copy();
  const line = insertAfter(s, L1, ') external returns (PayoutBatch memory queued) {', '        uint256 v = msg.value;');
  const problems = sourceProblems(s);
  assert.equal(at(problems, L1, line).length, 1, problems.join('\n'));
  assert.match(at(problems, L1, line)[0], /msg\.value/);
  // in the payout math too, and in a helper compiled into a library (the shares' mint)
  const m = copy();
  const mLine = insertAfter(m, MATH, 'function verify(', '        uint256 v = msg.value;');
  assert.equal(at(sourceProblems(m), MATH, mLine).length, 1);
  const h = copy();
  const hLine = insertAfter(h, 'src/CascadeShares.sol', 'function mintShares(', '    amount += msg.value;');
  assert.match(at(sourceProblems(h), 'src/CascadeShares.sol', hLine)[0], /msg\.value/);
  // a comment or a string is not code
  const c = copy();
  insertAfter(c, L1, ') external returns (PayoutBatch memory queued) {', '        // msg.value and msg.sender are never read here; "msg.value"');
  assert.deepEqual(sourceProblems(c), []);
});

test('msgSenderRefusedOutsideTheRefund', () => {
  const s = copy();
  const line = insertAfter(s, L1, ') external returns (PayoutBatch memory queued) {', '        if (msg.sender == input.sender) revert();');
  assert.match(at(sourceProblems(s), L1, line)[0], /msg\.sender/);
  // L3 may pay msg.sender (the vault's caller) its refund, last, and use it for nothing else
  const l3 = copy();
  l3.set(
    L3,
    [
      'library CascadePayoutLib {',
      '    function process(uint256 refund) external {',
      '        (bool ok,) = payable(msg.sender).call{value: refund}("");',
      '        (ok,) = msg.sender.call{value: refund}("");',
      '        if (msg.sender == address(1)) revert();',
      '    }',
      '}',
      '',
    ].join('\n'),
  );
  const problems = sourceProblems(l3);
  assert.deepEqual(at(problems, L3, 3), []);
  assert.deepEqual(at(problems, L3, 4), []);
  assert.match(at(problems, L3, 5)[0], /msg\.sender/);
  // the refund form anywhere but L3 is still refused
  const m = copy();
  const mLine = insertAfter(m, MATH, 'function verify(', '        (bool ok,) = payable(msg.sender).call{value: 1}("");');
  assert.match(at(sourceProblems(m), MATH, mLine).join('\n'), /msg\.sender/);
});

test('externalCallRefusedInL1', () => {
  // L1's own file makes no external call, checked on solc's AST with the call rule (its shapes are in
  // everyBypassShapeFailsTheCallRule and internalCallsBuiltinsAndTheCastPassTheCallRule); the helpers it
  // compiles in are held by its bytecode, which has no call opcode at all
  assert.deepEqual(NO_EXTERNAL_CALL, [L1]);
  assert.deepEqual(callRuleRoots(REAL), [L1, L4, L3, L2]);
  const a = clone();
  a.CascadeBatchLib.deployed = `${a.CascadeBatchLib.deployed.slice(0, 2)}f1${a.CascadeBatchLib.deployed.slice(2)}`;
  assert.match(bytecodeProblems(a).join('\n'), /CascadeBatchLib's runtime code has CALL/);
});

test('storageAssemblyRefused', () => {
  const anchor = ') external returns (PayoutBatch memory queued) {';
  for (const code of [
    '        assembly { sstore(0, 1) }',
    '        assembly { let x := sload(0) }',
    '        assembly { tstore(0, 1) }',
    '        assembly { let x := tload(0) }',
    '        assembly { let x := shares.slot }',
  ]) {
    const s = copy();
    const line = insertAfter(s, L1, anchor, code);
    assert.match(at(sourceProblems(s), L1, line).join('\n'), /assembly touches storage/, code);
  }
  // also in deductFee, an external function of the payout math
  const m = copy();
  const mLine = insertAfter(m, MATH, 'kept = new CascadeMessages.Entry[](taken);', '        assembly ("memory-safe") { sstore(0, 1) }');
  assert.match(at(sourceProblems(m), MATH, mLine).join('\n'), /assembly touches storage/);
  // a call from assembly is refused in any library
  const c = copy();
  const cLine = insertAfter(c, MATH, 'function verify(', '        assembly { let ok := call(gas(), 1, 0, 0, 0, 0, 0) }');
  assert.match(at(sourceProblems(c), MATH, cLine).join('\n'), /assembly makes a call/);
  // memory-only assembly is refused too: no library may hold any
  const l = copy();
  const lLine = insertAfter(l, L1, anchor, '        assembly ("memory-safe") { mstore(0, 1) }');
  assert.match(at(sourceProblems(l), L1, lLine).join('\n'), /assembly in library code \(no library may hold any, R1-C F-1\)/);
});

test('selfdestructDelegatecallAndCallcodeRefused', () => {
  const anchor = ') external returns (PayoutBatch memory queued) {';
  for (const [word, code] of [
    ['selfdestruct', '        selfdestruct(payable(input.sender));'],
    ['delegatecall', '        (bool ok,) = address(1).delegatecall("");'],
    ['callcode', '        assembly { let ok := callcode(gas(), 1, 0, 0, 0, 0, 0) }'],
  ]) {
    const s = copy();
    const line = insertAfter(s, L1, anchor, code);
    assert.match(at(sourceProblems(s), L1, line).join('\n'), new RegExp(word), code);
  }
  // in the bytecode: no library's runtime code has SELFDESTRUCT or CALLCODE
  const a = clone();
  a.CascadePayoutMath.deployed = `${a.CascadePayoutMath.deployed.slice(0, 2)}ff${a.CascadePayoutMath.deployed.slice(2)}`;
  assert.match(bytecodeProblems(a).join('\n'), /CascadePayoutMath's runtime code has SELFDESTRUCT/);
});

test('stateVariableRefused', () => {
  const s = copy();
  const line = insertAfter(s, L1, 'library CascadeBatchLib {', '    uint256 internal counter;');
  assert.match(at(sourceProblems(s), L1, line)[0], /state variable/);
  // a constant is not state
  const c = copy();
  insertAfter(c, L1, 'library CascadeBatchLib {', '    uint256 internal constant LIMIT = 1;');
  assert.deepEqual(sourceProblems(c), []);
});

test('helperLibrariesKeepInternalFunctionsOnly', () => {
  // a public helper function would be a new linked DELEGATECALL target (ruling DB7c)
  const s = copy();
  const path = 'src/libraries/CascadeMessages.sol';
  s.set(path, s.get(path).replace('function kind(bytes memory message) internal pure', 'function kind(bytes memory message) public pure'));
  const line = s.get(path).split('\n').findIndex((l) => l.includes('function kind(')) + 1;
  assert.match(at(sourceProblems(s), path, line)[0], /CascadeMessages.*kind.*internal/);
});

test('theScriptExitsOneNamingTheFileAndLine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'library-rules-'));
  try {
    cpSync(SRC, join(dir, 'src'), { recursive: true });
    const file = join(dir, L1);
    const lines = readFileSync(file, 'utf8').split('\n');
    const i = lines.findIndex((l) => l.includes(') external returns (PayoutBatch memory queued) {'));
    lines.splice(i + 1, 0, '        uint256 v = msg.value;');
    writeFileSync(file, lines.join('\n'));
    const r = spawnSync(process.execPath, [SCRIPT, '--src', join(dir, 'src')], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`${L1.replace(/\./g, '\\.')}:${i + 2}: msg\\.value`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stripCommentsKeepsLinesAndOffsets', () => {
  const text = 'a // msg.value\nb /* msg.sender\n */ c "msg.value" \'x\'\n';
  const out = stripComments(text);
  assert.equal(out.length, text.length);
  assert.equal(out.split('\n').length, text.split('\n').length);
  assert.ok(!/msg/.test(out));
  assert.match(out, /^a +\nb +\n +c +/);
});

// ---- the link graph (ruling DB7b) ----

test('linkGraphIsExactlyTheExpectedSet', () => {
  // the vault links L1, L2, L3 and L4 (step L4), and L3 the payout math (the 5g ruling: L3 does not link L2)
  assert.deepEqual(LINK_GRAPH, {
    CascadeVault: ['CascadeBatchLib', 'CascadeHotkeyLib', 'CascadePayoutLib', 'CascadeStakeLib'],
    CascadePayoutLib: ['CascadePayoutMath'],
  });
  // the real build links exactly that, and nothing else in src/ links anything
  assert.deepEqual(linkProblems(ARTIFACTS), []);
  // a missing link
  const a = clone();
  delete a.CascadeVault.deployedLinks['src/libraries/CascadeBatchLib.sol'];
  assert.match(linkProblems(a).join('\n'), /CascadeVault's runtime code links CascadeHotkeyLib, CascadePayoutLib, CascadeStakeLib, expected CascadeBatchLib, CascadeHotkeyLib, CascadePayoutLib, CascadeStakeLib/);
  // an extra one
  const b = clone();
  b.CascadeVault.deployedLinks['src/libraries/CascadeFormulas.sol'] = { CascadeFormulas: [{ start: 1, length: 20 }] };
  assert.match(linkProblems(b).join('\n'), /CascadeVault's runtime code links CascadeBatchLib, CascadeFormulas, CascadeHotkeyLib, CascadePayoutLib, CascadeStakeLib/);
  // the vault linking the payout math again, or L3 linking L2
  const v = clone();
  v.CascadeVault.deployedLinks[MATH] = { CascadePayoutMath: [{ start: 1, length: 20 }] };
  assert.match(linkProblems(v).join('\n'), /CascadeVault's runtime code links CascadeBatchLib, CascadeHotkeyLib, CascadePayoutLib, CascadePayoutMath, CascadeStakeLib, expected CascadeBatchLib, CascadeHotkeyLib, CascadePayoutLib, CascadeStakeLib/);
  const w = clone();
  w.CascadePayoutLib.deployedLinks[L2] = { CascadeStakeLib: [{ start: 1, length: 20 }] };
  assert.match(linkProblems(w).join('\n'), /CascadePayoutLib's runtime code links CascadePayoutMath, CascadeStakeLib, expected CascadePayoutMath/);
  // L3's creation code too
  const x = clone();
  x.CascadePayoutLib.creationLinks = {};
  assert.match(linkProblems(x).join('\n'), /CascadePayoutLib's creation code links nothing, expected CascadePayoutMath/);
  // a link anywhere else: the front door, a lens, or a library linking another
  for (const name of ['CascadeFrontDoor', 'CascadeVaultLens', 'CascadeBatchLib', 'CascadeStakeLib', 'CascadeHotkeyLib']) {
    const c = clone();
    c[name].deployedLinks = { [MATH]: { CascadePayoutMath: [{ start: 1, length: 20 }] } };
    assert.match(linkProblems(c).join('\n'), new RegExp(`${name}'s runtime code links CascadePayoutMath, expected nothing`), name);
  }
  // the creation code is held to the same set
  const d = clone();
  d.CascadeVault.creationLinks = {};
  assert.match(linkProblems(d).join('\n'), /CascadeVault's creation code links nothing/);
});

test('everyLinkedLibraryIsScannedAndHasACallRule', () => {
  // a library the vault links but the source rules do not scan, or without a bytecode call rule, fails
  const a = clone();
  a.CascadeVault.deployedLinks['src/libraries/CascadeHotkeys.sol'] = { CascadeHotkeys: [{ start: 1, length: 20 }] };
  a.CascadeVault.creationLinks = structuredClone(a.CascadeVault.deployedLinks);
  a.CascadeHotkeys = { path: 'src/libraries/CascadeHotkeys.sol', deployed: '0x00', deployedLinks: {}, creationLinks: {} };
  const graph = { ...LINK_GRAPH, CascadeVault: [...LINK_GRAPH.CascadeVault, 'CascadeHotkeys'] };
  const problems = linkProblems(a, graph).join('\n');
  assert.match(problems, /CascadeHotkeys is linked but is not a \*Lib\.sol or CascadePayoutMath/);
  assert.match(bytecodeProblems(a, graph).join('\n'), /CascadeHotkeys is linked but has no entry in CALL_OPCODES/);
  assert.deepEqual(Object.keys(CALL_OPCODES).sort(), ['CascadeBatchLib', 'CascadeHotkeyLib', 'CascadePayoutLib', 'CascadePayoutMath', 'CascadeStakeLib']);
});

test('opcodesOfSkipsPushDataAndTheMetadata', () => {
  const sorted = (ops) => [...ops].sort((x, y) => x - y);
  // PUSH1 0xf1, PUSH2 0xf4ff, STOP, then a CBOR metadata trailer of 2 bytes (a map: 0xa1, then 0xf1) and
  // its length, 0x0002: none of the 0xf1 and 0xf4 bytes is an opcode
  assert.deepEqual(sorted(opcodesOf('0x60f161f4ff00a1f10002')), [0x00, 0x60, 0x61]);
  // without a CBOR map where the length points, the trailer is code
  assert.ok(opcodesOf('0x60f161f4ff00f1f10002').has(0xf1));
  // a link placeholder sits in PUSH20 data
  const placeholder = `__$${'a'.repeat(34)}$__`;
  assert.deepEqual(sorted(opcodesOf(`0x73${placeholder}f4a1000002`)), [0x73, 0xf4]);
});

// ---- the 5e review's hardening (Task 5f) ----

test('vendoredImportsNeedTheClosuresAllowList', () => {
  // (a) what a closure imports from outside first-party src/ is exactly its allow-list: OpenZeppelin's Math
  assert.deepEqual(VENDOR_IMPORTS[L1], [OZ_MATH]);
  assert.deepEqual(VENDOR_IMPORTS[MATH], [OZ_MATH]);
  for (const root of libraryRoots(REAL)) {
    const outside = importClosure(REAL, root).flatMap((p) =>
      importsOf(REAL, p)
        .filter((i) => !i.followed)
        .map((i) => i.resolved ?? i.target),
    );
    assert.deepEqual([...new Set(outside)], VENDOR_IMPORTS[root], root);
  }
  // in a helper compiled into L1: another OpenZeppelin file, a first-party file named by a non-relative
  // path (which the scan would not follow), and a relative path into src/vendor (not first-party)
  const anchor = 'import {Holder, SharesData} from "./CascadeTypes.sol";';
  for (const imp of [
    'import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";',
    'import {CascadeMath} from "src/libraries/CascadeMath.sol";',
    'import {Client} from "./vendor/ccip/Client.sol";',
  ]) {
    const s = copy();
    const line = insertAfter(s, 'src/CascadeShares.sol', anchor, imp);
    // once per closure that compiles the share token in: L1's and, since Task 5g, L3's
    const p = at(sourceProblems(s), 'src/CascadeShares.sol', line);
    assert.equal(p.length, 2, `${imp}: ${sourceProblems(s).join('\n')}`);
    assert.match(p[0], /CascadeBatchLib\.sol's closure imports .* not first-party .*allow-list/, imp);
    assert.match(p[1], /CascadePayoutLib\.sol's closure imports .* not first-party .*allow-list/, imp);
  }
  // the allow-list is per closure: a library with no entry may not import even Math
  const t = copy();
  t.set('src/libraries/CascadeTestLib.sol', `import {Math} from "${OZ_MATH}";\nlibrary CascadeTestLib {}\n`);
  assert.match(at(sourceProblems(t), 'src/libraries/CascadeTestLib.sol', 1).join('\n'), /allow-list/);
});

test('singleQuotedImportsAreFollowed', () => {
  // (d) a helper imported with single quotes is in the closure, and scanned
  const s = copy();
  const helper = 'src/libraries/CascadeQuoted.sol';
  s.set(helper, ['library CascadeQuoted {', '    function f() internal view returns (uint256) {', '        return msg.value;', '    }', '}', ''].join('\n'));
  insertAfter(s, L1, 'import {CascadeMath} from "./CascadeMath.sol";', "import {CascadeQuoted} from './CascadeQuoted.sol';");
  assert.ok(importClosure(s, L1).includes(helper), "the single-quoted import is in L1's closure");
  assert.match(at(sourceProblems(s), helper, 3).join('\n'), /msg\.value/);
  // and a single-quoted vendored import is held to the allow-list
  const v = copy();
  const line = insertAfter(v, L1, 'import {CascadeMath} from "./CascadeMath.sol";', "import {SafeCast} from '@openzeppelin/contracts/utils/math/SafeCast.sol';");
  assert.match(at(sourceProblems(v), L1, line).join('\n'), /SafeCast\.sol.*allow-list/);
});

/** `sources` with the first `from` in `path` replaced by `to`; returns the 1-based line where it was. */
function replaceIn(sources, path, from, to) {
  const text = sources.get(path);
  const i = text.indexOf(from);
  assert.ok(i !== -1, `${from} is not in ${path}`);
  sources.set(path, text.slice(0, i) + to + text.slice(i + from.length));
  return text.slice(0, i).split('\n').length;
}

test('assemblyReadingTheCallerTheValueOrTheOriginRefused', () => {
  // (c) named for what it reads, beside the refusal of any assembly
  for (const [op, what] of [
    ['caller()', 'msg\\.sender'],
    ['callvalue()', 'msg\\.value'],
    ['origin()', 'tx\\.origin'],
  ]) {
    const s = copy();
    const line = insertAfter(s, MATH, 'kept = new CascadeMessages.Entry[](taken);', `        assembly ("memory-safe") { let x := ${op} }`);
    const p = at(sourceProblems(s), MATH, line);
    assert.equal(p.length, 2, p.join('\n'));
    assert.match(p[0], /assembly in library code \(no library may hold any, R1-C F-1\)/, op);
    assert.match(p[1], new RegExp(`assembly reads .*${what}`), op);
  }
  // and tx.origin in Solidity: no library makes an access check
  const t = copy();
  const line = insertAfter(t, L1, ') external returns (PayoutBatch memory queued) {', '        if (tx.origin == input.sender) revert();');
  assert.match(at(sourceProblems(t), L1, line).join('\n'), /tx\.origin/);
});

test('loadArtifactsThrowsOnAMissingCompilationTarget', () => {
  // (e) an artifact it cannot name would be skipped, unseen by the link graph and the bytecode rules
  const dir = mkdtempSync(join(tmpdir(), 'library-rules-out-'));
  try {
    const put = (file, name, edit = (a) => a) => {
      mkdirSync(join(dir, file), { recursive: true });
      const a = JSON.parse(readFileSync(join(OUT, file, `${name}.json`), 'utf8'));
      writeFileSync(join(dir, file, `${name}.json`), JSON.stringify(edit(a)));
    };
    put('CascadeVault.sol', 'CascadeVault');
    put('CascadeBatchLib.sol', 'CascadeBatchLib');
    // a file of file-level declarations has no contract, so no metadata, code or ABI: skipped
    put('CascadeTypes.sol', 'CascadeTypes');
    assert.deepEqual(Object.keys(loadArtifacts(dir)).sort(), ['CascadeBatchLib', 'CascadeVault']);
    put('CascadeBatchLib.sol', 'CascadeBatchLib', (a) => {
      delete a.metadata;
      return a;
    });
    assert.throws(() => loadArtifacts(dir), /CascadeBatchLib\.sol\/CascadeBatchLib\.json has no metadata\.settings\.compilationTarget/);
    put('CascadeBatchLib.sol', 'CascadeBatchLib', (a) => {
      a.metadata = { settings: { compilationTarget: {} } };
      return a;
    });
    assert.throws(() => loadArtifacts(dir), /CascadeBatchLib\.json has no metadata\.settings\.compilationTarget/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aLibraryAllowedCallsHasItsTargetsPinned', () => {
  // a library whose bytecode may call must name its targets in CALL_TARGETS, or its calls go unchecked
  const a = clone();
  const path = 'src/libraries/CascadeHotkeysLib.sol';
  a.CascadeVault.deployedLinks[path] = { CascadeHotkeysLib: [{ start: 1, length: 20 }] };
  a.CascadeHotkeysLib = { path, deployed: '0xf100', deployedLinks: {}, creationLinks: {} };
  const graph = { ...LINK_GRAPH, CascadeVault: [...LINK_GRAPH.CascadeVault, 'CascadeHotkeysLib'] };
  const opcodes = { ...CALL_OPCODES, CascadeHotkeysLib: ['CALL'] };
  assert.match(bytecodeProblems(a, graph, opcodes).join('\n'), /CascadeHotkeysLib may call \(CALL\), but CALL_TARGETS names none of its targets/);
  // once named, the bytecode passes
  assert.deepEqual(bytecodeProblems(a, graph, opcodes, { ...CALL_TARGETS, [path]: ['IStaking(ISTAKING_ADDRESS)'] }), []);
});

// ---- L2, the unstake walk (Task 5f) ----

const LEDGER = 'src/libraries/CascadeLedger.sol';

test('theRealWalkCallsOnlyThePrecompile', () => {
  // the real L2 compiles in the ledger helper and the formulas, which reach the precompile through its interface
  const closure = importClosure(REAL, L2);
  for (const p of [LEDGER, FORMULAS, 'src/interfaces/IStaking.sol', 'src/CascadeTypes.sol']) assert.ok(closure.includes(p), p);
  assert.ok(!closure.includes('src/CascadeShares.sol'), 'L2 mints and burns nothing');
  assert.deepEqual(VENDOR_IMPORTS[L2], [OZ_MATH]);
  // (another call in the shared removal, in the walk itself or in the formulas fails, naming its file and
  // line: the call rule's shapes, in everyBypassShapeFailsTheCallRule)
  // L2 writes nothing: no state variable of its own
  const w = copy();
  const line = insertAfter(w, L2, 'library CascadeStakeLib {', '    uint256 internal walks;');
  assert.match(at(sourceProblems(w), L2, line)[0], /state variable/);
});

test('theWalksBytecodeCallsButNeverDelegates', () => {
  // L2 calls the precompile (CALL for a removal, STATICCALL for a read) and links nothing: no DELEGATECALL
  assert.deepEqual(CALL_OPCODES.CascadeStakeLib, ['CALL', 'STATICCALL']);
  const ops = opcodesOf(ARTIFACTS.CascadeStakeLib.deployed);
  assert.ok(ops.has(0xf1) && ops.has(0xfa), 'the real walk calls and reads');
  assert.deepEqual(ARTIFACTS.CascadeStakeLib.deployedLinks, {});
  for (const [op, name] of [
    ['f4', 'DELEGATECALL'],
    ['f0', 'CREATE'],
    ['ff', 'SELFDESTRUCT'],
    ['f2', 'CALLCODE'],
  ]) {
    const a = clone();
    a.CascadeStakeLib.deployed = `${a.CascadeStakeLib.deployed.slice(0, 2)}${op}${a.CascadeStakeLib.deployed.slice(2)}`;
    assert.match(bytecodeProblems(a).join('\n'), new RegExp(`CascadeStakeLib's runtime code has ${name}`), name);
  }
});

// ---- the call rule, on solc's AST (5f fix round 4) ----
//
// Where a linked library's code may call is read from solc's AST, not from the source text: each call's
// callee type (an external function, a low-level call, a creation, a library's DELEGATECALL, a precompile,
// or internal) and the declarations solc resolved its names to. Each case compiles a copy of src/ (forge,
// into a scratch directory), so every shape below is Solidity that solc accepts.

const IMPORT_FORMULAS = 'import {CascadeFormulas} from "./CascadeFormulas.sol";';
const L1_BODY = ') external returns (PayoutBatch memory queued) {';
const BODY = 'uint256 before = address(this).balance;';
const EVIL = 'src/interfaces/IEvil.sol';
const HOME = 'src/interfaces/IStaking.sol';

/** The call rule over `sources` (the real ones, or a changed copy): each changed file written over a copy of
 * src/ in a scratch directory (a file `sources` drops is removed there), the rule's roots compiled there
 * alone, and solc's AST checked with `options`. Returns { problems, compiled }. */
function checkCalls(sources, options) {
  const dir = mkdtempSync(join(tmpdir(), 'library-rules-ast-'));
  try {
    cpSync(SRC, join(dir, 'src'), { recursive: true });
    for (const p of REAL.keys()) if (!sources.has(p)) rmSync(join(dir, p));
    for (const [p, text] of sources) {
      if (REAL.get(p) === text) continue;
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    const compiled = compileAsts(join(dir, 'src'), callRuleRoots(sources));
    return { problems: callProblems(compiled, options), compiled };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Each `// <KIND>:<NAME>` marker in the files `sources` changed: NAME -> { kind, path, line }. */
function markers(sources, kinds = 'SHAPE|CONTROL|CAST') {
  const found = new Map();
  for (const [path, text] of sources) {
    if (REAL.get(path) === text) continue;
    text.split('\n').forEach((l, i) => {
      for (const m of l.matchAll(new RegExp(`// (${kinds}):(\\w+)`, 'g'))) found.set(m[2], { kind: m[1], path, line: i + 1 });
    });
  }
  return found;
}

/** The 1-based line of the first `needle` in `text`. */
const lineOf = (text, needle) => {
  assert.ok(text.includes(needle), needle);
  return text.slice(0, text.indexOf(needle)).split('\n').length;
};

test('theRealSourcesPassTheCallRule', () => {
  // L1's own file and L2's whole closure, compiled alone in one solc run: solc reads no external call but
  // through IStaking(ISTAKING_ADDRESS), and none in L1
  const compiled = compileAsts(SRC, callRuleRoots(REAL));
  assert.deepEqual(compiled.errors, []);
  for (const p of [L1, L2, LEDGER, FORMULAS, HOME, 'lib/openzeppelin-contracts/contracts/utils/math/Math.sol']) {
    assert.ok(compiled.units.has(p), `${p} is not in solc's output`);
  }
  assert.deepEqual(callProblems(compiled), []);
  // the allow-list is what lets the walk's precompile calls through: with no target, each one fails
  const none = callProblems(compiled, { callTargets: { [L2]: [] } });
  for (const [path, needle] of [
    [LEDGER, 'IStaking(ISTAKING_ADDRESS).removeStakeFull('],
    [LEDGER, 'IStaking(ISTAKING_ADDRESS).removeStake('],
    [FORMULAS, 'IStaking(ISTAKING_ADDRESS).getStake('],
    [FORMULAS, 'IStaking(ISTAKING_ADDRESS).getDefaultMinStake{'],
    [FORMULAS, 'IStaking(ISTAKING_ADDRESS).getNominatorMinRequiredStake{'],
    // the walk's own removals, each in a try with its gas share (Task 20)
    [L2, 'IStaking(ISTAKING_ADDRESS).removeStakeFull{gas: gas}('],
    [L2, 'IStaking(ISTAKING_ADDRESS).removeStake{gas: gas}('],
  ]) {
    const p = at(none, path, lineOf(REAL.get(path), needle));
    assert.equal(p.length, 1, `${needle}: ${none.join('\n')}`);
    assert.match(p[0], /: external call: .*(compiled into|in) CascadeStakeLib/);
  }
  assert.equal(none.length, 7, none.join('\n'));
  // a target PINNED does not fix is refused, and one that is not a cast cannot be read
  assert.match(callProblems(compiled, { callTargets: { [L2]: ['IStaking(OTHER_ADDRESS)'] } }).join('\n'), /PINNED does not fix OTHER_ADDRESS/);
  assert.throws(
    () => callProblems(compiled, { callTargets: { [L2]: ['msg.sender'] } }),
    /neither a cast Interface\(ADDRESS\), a vault-passed field Struct\.field\.function nor a refund msg\.sender\.call\{value\}\(""\) last in <function>/,
  );
});

test('everyBypassShapeFailsTheCallRule', () => {
  // Every shape the 5f reviews found (N1 to N5, P1 to P3, Q1 to Q3, the pin shapes) and the earlier rules'
  // shapes, each compiled by solc, in L2's closure (the ledger helper, L2 itself, the formulas, a new file it
  // imports) and in L1's own file. Each fails at its line, and nothing else does.
  const s = copy();
  const pad = ' '.repeat(70);
  s.set(
    EVIL,
    [
      '// SPDX-License-Identifier: MIT',
      'pragma solidity 0.8.38;',
      '',
      'interface IEvil {',
      '    function max(uint256 a, uint256 b) external returns (uint256);',
      '    function sub0(uint256 a, uint256 b) external returns (uint256);',
      '    function encode(uint256 a) external returns (bytes memory);',
      '    function hit(bytes32 h) external;',
      '}',
      '',
      "/// a lookalike of the precompile's interface, declared elsewhere",
      'interface IStaking {',
      '    function removeStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable;',
      '}',
      '',
      'struct Hold {',
      '    IEvil Math;',
      '    IEvil abi;',
      '    IEvil CascadeFormulas;',
      '}',
      '',
      'struct Box {',
      '    address ISTAKING_ADDRESS;',
      '}',
      '',
      'struct Hook {',
      '    function (bytes32) external f; // SHAPE:A_FUNCTION_TYPED_FIELD',
      '}',
      '',
      "/// a contract's body never reaches a library: its calls are not the rule's",
      'contract Sink {',
      '    function poke() external { (bool ok,) = address(1).call(""); IEvil(address(1)).hit(bytes32(0)); ok; }',
      '}',
      '',
      '/// N10: a using-for helper on address, whose own call is the bypass',
      'library Hop {',
      '    function go(address a) internal { (bool ok,) = a.call(""); ok; } // SHAPE:N10',
      '}',
      '',
    ].join('\n'),
  );
  replaceIn(
    s,
    LEDGER,
    IMPORT_FORMULAS,
    [
      IMPORT_FORMULAS,
      'import {IEvil, IStaking as IStakingTwin, Hold, Box, Sink, Hop} from "../interfaces/IEvil.sol";',
      `import {Math} from "${OZ_MATH}";`,
      'import {CascadePayoutMath} from "./CascadePayoutMath.sol";',
      'import {CascadeMessages} from "./CascadeMessages.sol";',
    ].join('\n'),
  );
  s.set(
    LEDGER,
    [
      s.get(LEDGER),
      '/// The bypass shapes: each compiles, and calls or names a target other than IStaking(ISTAKING_ADDRESS).',
      'library Bypass {',
      '    using Hop for address;',
      '',
      '    // N1 to N4: a name the textual rule trusted (Math, a library, abi), rebound; N5: a function-type variable',
      '    function n1() internal { IEvil Math = IEvil(address(0xd1)); Math.max(1, 2); } // SHAPE:N1',
      '    function n2() internal { IEvil CascadeFormulas = IEvil(address(0xd2)); CascadeFormulas.sub0(1, 2); } // SHAPE:N2',
      '    function n3() internal { IEvil abi = IEvil(address(0xd3)); abi.encode(1); } // SHAPE:N3',
      '    function n4(IEvil CascadeFormulas) internal { CascadeFormulas.sub0(1, 2); } // SHAPE:N4',
      '    function n5(bytes32 h) internal { function(bytes32) external fp = IEvil(address(0xd5)).hit; fp(h); } // SHAPE:N5',
      '',
      '    // P1: a member receiver padded past the textual look-behind, by spaces, a comment or newlines',
      '    function p1(Hold memory hold) internal {',
      `        hold.${pad}Math.max(1, 2); // SHAPE:P1a`,
      `        hold./*${pad}*/abi.encode(1); // SHAPE:P1b`,
      '        hold. // SHAPE:P1c',
      ...Array(70).fill(''),
      '        CascadeFormulas.sub0(1, 2);',
      '    }',
      '',
      '    // P2, P3, Q1 to Q3: an external function value called with no function type written',
      '    function p2(bytes32 h) internal { (IEvil(address(0xe2)).hit)(h); } // SHAPE:P2',
      '    function p3(bytes32 h) internal { (h == 0 ? IEvil(address(0xe4)).hit : IEvil(address(0xe5)).hit)(h); } // SHAPE:P3',
      '    function q1(bytes32 h) internal { [IEvil(address(0xe7)).hit][0](h); } // SHAPE:Q1',
      '    function q2(bytes32 h) internal { IEvil e = IEvil(address(0xe8)); (e.hit)(h); } // SHAPE:Q2',
      '    function q3(bytes32 h) internal { (IEvil(address(0xe9)).hit){gas: 50000}(h); } // SHAPE:Q3',
      '',
      "    // the pin shapes (5f fix round 2 and the re-review's N7, N11): the cast's text, a name in it bound elsewhere",
      '    function pinStakingParameter(bytes32 h, IStaking ISTAKING_ADDRESS) internal { IStaking(ISTAKING_ADDRESS).removeStake(h, 1, 0); } // SHAPE:PIN_STAKING_PARAMETER',
      '    function pinAddressParameter(bytes32 h, address ISTAKING_ADDRESS) internal { IStaking(ISTAKING_ADDRESS).removeStake(h, 1, 0); } // SHAPE:PIN_ADDRESS_PARAMETER',
      '    function pinStakingLocal(bytes32 h) internal { IStaking ISTAKING_ADDRESS = IStaking(address(0xdead)); IStaking(ISTAKING_ADDRESS).removeStake(h, 1, 0); } // SHAPE:PIN_STAKING_LOCAL',
      '    function pinAddressLocal(bytes32 h) internal { address ISTAKING_ADDRESS = address(0x806); IStaking(ISTAKING_ADDRESS).removeStake(h, 1, 0); } // SHAPE:PIN_ADDRESS_LOCAL',
      '    function pinField(bytes32 h, Box memory box) internal { IStaking(box.ISTAKING_ADDRESS).removeStake(h, 1, 0); } // SHAPE:PIN_STRUCT_FIELD',
      '    function pinDollar(bytes32 h) internal { address $ISTAKING_ADDRESS = address(0xdead); IStaking($ISTAKING_ADDRESS).removeStake(h, 1, 0); } // SHAPE:PIN_DOLLAR_NAME',
      '    function pinMember(bytes32 h) internal { PinFunction.IStaking(ISTAKING_ADDRESS).hit(h); } // SHAPE:PIN_MEMBER',
      '    function pinLookalike(bytes32 h) internal { IStakingTwin(ISTAKING_ADDRESS).removeStake(h, 1, 0); } // SHAPE:PIN_LOOKALIKE_INTERFACE',
      '',
      "    // the earlier rules' shapes",
      '    function others(bytes32 h) internal {',
      '        IStaking(address(0x806)).getStake(h, bytes32(0), 0); // SHAPE:ANOTHER_ADDRESS',
      '        IEvil(address(1)).hit(h); // SHAPE:ANOTHER_INTERFACE',
      '        IStaking staking = IStaking(ISTAKING_ADDRESS);',
      '        staking.removeStake(h, 1, 0); // SHAPE:A_VARIABLE',
      '        IEvil[] memory sinks = new IEvil[](1);',
      '        sinks[0].hit(h); // SHAPE:AN_ARRAY_ELEMENT',
      '        PinFunction.IStaking(address(1)).hit(h); // SHAPE:A_CALLS_RESULT',
      '        new Sink(); // SHAPE:A_CREATION',
      '        CascadePayoutMath.verify(new CascadeMessages.Payout[](0), 0, bytes32(0)); // SHAPE:A_LINKED_LIBRARY',
      "        address(0xdead).go(); // (an internal call: Hop's own call is N10)",
      '    }',
      '',
      '    function lowLevel() internal {',
      '        (bool ok,) = address(1).call(""); // SHAPE:A_CALL',
      '        (ok,) = address(ISTAKING_ADDRESS).staticcall(""); // SHAPE:A_STATICCALL',
      '        (ok,) = address(1).delegatecall(""); // SHAPE:A_DELEGATECALL',
      '        payable(address(1)).transfer(1); // SHAPE:A_TRANSFER',
      '        ok = payable(address(1)).send(1); // SHAPE:A_SEND',
      '        ecrecover(bytes32(0), 0, bytes32(0), bytes32(0)); // SHAPE:A_PRECOMPILE',
      '        selfdestruct(payable(address(0))); // SHAPE:A_SELFDESTRUCT',
      '    }',
      '',
      '    function returned() internal pure returns (function (bytes32) external g) { g = IEvil(address(1)).hit; } // SHAPE:A_RETURNED_FUNCTION',
      '}',
      '',
      'library PinStakingConstant {',
      '    IStaking internal constant ISTAKING_ADDRESS = IStaking(address(0xdead));',
      '',
      '    function f(bytes32 h) internal { IStaking(ISTAKING_ADDRESS).removeStake(h, 1, 0); } // SHAPE:PIN_STAKING_CONSTANT',
      '}',
      '',
      'library PinAddressConstant {',
      '    address internal constant ISTAKING_ADDRESS = address(0x806);',
      '',
      '    function f(bytes32 h) internal { IStaking(ISTAKING_ADDRESS).removeStake(h, 1, 0); } // SHAPE:PIN_ADDRESS_CONSTANT',
      '}',
      '',
      'library PinFunction {',
      '    function IStaking(address a) internal pure returns (IEvil) { return IEvil(a); }',
      '',
      '    function f(bytes32 h) internal { IStaking(ISTAKING_ADDRESS).hit(h); } // SHAPE:PIN_SHADOWING_FUNCTION',
      '}',
      '',
    ].join('\n'),
  );
  // in L2 itself, and in the formulas it shares with L1
  replaceIn(s, L2, 'import {CascadeLedger} from "./CascadeLedger.sol";', 'import {CascadeLedger} from "./CascadeLedger.sol";\nimport {IEvil} from "../interfaces/IEvil.sol";');
  insertAfter(s, L2, 'unmetWei = wantWei;', '        IEvil(address(0xd8)).hit(p.first); // SHAPE:IN_L2');
  insertAfter(s, FORMULAS, 'function stakeOf(', '        IStaking(address(0x806)).getStake(h, coldkey, NETUID_ROOT); // SHAPE:IN_THE_FORMULAS');
  // in L1's own file, which may call nothing, not even the precompile
  replaceIn(
    s,
    L1,
    'import {CascadePayoutMath} from "./CascadePayoutMath.sol";',
    'import {CascadePayoutMath} from "./CascadePayoutMath.sol";\nimport {ISTAKING_ADDRESS, IStaking} from "../interfaces/IStaking.sol";\nimport {IEvil, Hold, Sink} from "../interfaces/IEvil.sol";',
  );
  insertAfter(
    s,
    L1,
    L1_BODY,
    [
      '        IStaking(ISTAKING_ADDRESS).getStake(bytes32(0), bytes32(0), 0); // SHAPE:L1_THE_PRECOMPILE',
      '        IEvil(address(1)).hit(bytes32(0)); // SHAPE:L1_AN_INTERFACE',
      '        (bool sent,) = address(1).call(""); // SHAPE:L1_A_CALL',
      '        payable(address(1)).transfer(sent ? 1 : 0); // SHAPE:L1_A_TRANSFER',
      '        new Sink(); // SHAPE:L1_A_CREATION',
      '        CascadePayoutMath.verify(new CascadeMessages.Payout[](0), 0, bytes32(0)); // SHAPE:L1_A_LINKED_LIBRARY',
      '        Hold memory hold;',
      '        hold.Math.max(1, 2); // SHAPE:L1_A_MEMBER',
    ].join('\n'),
  );

  const { problems, compiled } = checkCalls(s);
  assert.deepEqual(compiled.errors, [], 'every shape compiles');
  const CALL = /: external call: /;
  const VALUE = /: an external function as a value: /;
  const expected = {
    N5: VALUE,
    A_FUNCTION_TYPED_FIELD: VALUE,
    A_RETURNED_FUNCTION: VALUE,
    N10: /: external call: .*a low-level call/,
    A_CALL: /a low-level call /,
    A_STATICCALL: /a low-level staticcall/,
    A_DELEGATECALL: /a low-level delegatecall/,
    A_TRANSFER: /a value transfer/,
    A_SEND: /a send/,
    A_PRECOMPILE: /a precompile call \(ecrecover\)/,
    A_SELFDESTRUCT: /selfdestruct/,
    A_CREATION: /a contract creation/,
    A_LINKED_LIBRARY: /a DELEGATECALL/,
    L1_A_LINKED_LIBRARY: /a DELEGATECALL/,
    L1_A_CREATION: /a contract creation/,
  };
  const shapes = markers(s);
  assert.equal(shapes.size, 50, [...shapes.keys()].join(', '));
  for (const [name, { path, line }] of shapes) {
    const p = at(problems, path, line);
    const scope = name.startsWith('L1_')
      ? /in CascadeBatchLib, which makes no external call$/
      : /(in CascadeStakeLib|compiled into CascadeStakeLib|compiled into CascadeHotkeyLib), whose only call target is IStaking\(ISTAKING_ADDRESS\)$/;
    assert.ok(p.length > 0, `${name} (${path}:${line}) passes the call rule`);
    assert.ok(p.some((x) => (expected[name] ?? CALL).test(x)), `${name}: ${p.join('\n')}`);
    assert.ok(p.every((x) => scope.test(x)), `${name}: ${p.join('\n')}`);
  }
  // nothing else fails: the real code in the same files, the internal using-for call, the conversions
  const marked = new Set([...shapes.values()].map(({ path, line }) => `${path}:${line}:`));
  assert.deepEqual(problems.filter((p) => ![...marked].some((m) => p.startsWith(m))), []);
  // the formulas are in L1's closure too, but only L1's own file is L1's rule (its bytecode holds the rest)
  assert.ok(!problems.some((p) => p.startsWith(`${FORMULAS}:`) && /CascadeBatchLib/.test(p)));
});

test('internalCallsBuiltinsAndTheCastPassTheCallRule', () => {
  // The positive controls: a first-party internal library call, abi.encode, OpenZeppelin's Math, and the
  // other internal calls and builtins solc types as internal or pure; the cast itself however it is written
  // (spaced, commented, its names renamed on import, with call options, in a try); and names that only look
  // like the pin's. With no target allowed, the casts fail and nothing else does, so the controls are read.
  const s = copy();
  replaceIn(
    s,
    LEDGER,
    IMPORT_FORMULAS,
    `${IMPORT_FORMULAS}\nimport {Math} from "${OZ_MATH}";\nimport {ISTAKING_ADDRESS as STAKING_AT, IStaking as Staking} from "../interfaces/IStaking.sol";`,
  );
  s.set(
    LEDGER,
    [
      s.get(LEDGER),
      '/// Not external calls, and the cast itself: each passes the call rule.',
      'library Controls {',
      '    using CascadeFormulas for uint256;',
      '',
      '    function internalCall() internal pure returns (uint256) { return CascadeFormulas.sub0(2, 1); } // CONTROL:A_FIRST_PARTY_INTERNAL_CALL',
      '    function encode() internal pure returns (bytes memory) { return abi.encode(uint256(1)); } // CONTROL:ABI_ENCODE',
      '    function math() internal pure returns (uint256) { return Math.max(1, 2); } // CONTROL:A_MATH_CALL',
      '    function own(Ledger storage ledger) internal { CascadeLedger.applyWalk(ledger, 0, 0); } // CONTROL:ITS_OWN_LIBRARY',
      '    function bound() internal pure returns (uint256) { return uint256(3).sub0(1); } // CONTROL:USING_FOR',
      '    function builtins() internal pure returns (bytes32, bytes memory, uint256[] memory) { return (keccak256(""), new bytes(1), new uint256[](2)); } // CONTROL:BUILTINS',
      '    function checks(uint256 x) internal pure { require(x != 0, "x"); assert(x != 1); } // CONTROL:REQUIRE_ASSERT',
      '    function selector() internal pure returns (bytes4, bytes memory) { return (IStaking.removeStake.selector, abi.encodeCall(IStaking.removeStake, (bytes32(0), 1, 0))); } // CONTROL:A_SELECTOR',
      '    function pointer(function (uint256) internal pure returns (uint256) f) internal pure returns (uint256) { return f(1); } // CONTROL:AN_INTERNAL_FUNCTION_TYPE',
      '    function usesPointer() internal pure returns (uint256) { return pointer(identity); } // CONTROL:AN_INTERNAL_POINTER',
      '    function identity(uint256 x) internal pure returns (uint256) { return x; }',
      '    function namedReturn() internal pure returns (address ISTAKING_ADDRESS) {} // CONTROL:A_NAME_LIKE_THE_PIN',
      '',
      '    function casts(bytes32 h) internal {',
      '        IStaking(ISTAKING_ADDRESS).removeStake(h, 1, 0); // CAST:PLAIN',
      '        IStaking( // CAST:SPACED_AND_COMMENTED',
      '            /* a comment */ ISTAKING_ADDRESS // and another',
      '        ).removeStake(h, 1, 0);',
      '        Staking(STAKING_AT).removeStake(h, 1, 0); // CAST:RENAMED_ON_IMPORT',
      '        IStaking(ISTAKING_ADDRESS).removeStake{gas: 50_000}(h, 1, 0); // CAST:WITH_CALL_OPTIONS',
      '        try IStaking(ISTAKING_ADDRESS).getDefaultMinStake{gas: 100_000}() returns (uint256 v) { v; } catch {} // CAST:IN_A_TRY',
      '        try IStaking(ISTAKING_ADDRESS).removeStake{gas: gasleft() / 2}(h, 1, 0) {} catch {} // CAST:A_REMOVAL_IN_A_TRY_WITH_GAS',
      '    }',
      '}',
      '',
    ].join('\n'),
  );
  insertAfter(
    s,
    L1,
    L1_BODY,
    [
      '        CascadeMath.sharesForDeposit(1, 1, 1); // CONTROL:L1_A_HELPER',
      '        Math.min(uint256(1), 2); // CONTROL:L1_MATH',
      '        CascadeMessages.Entry[] memory entries = new CascadeMessages.Entry[](1); // CONTROL:L1_A_MEMORY_ARRAY',
      '        abi.decode(message, (uint8)); // CONTROL:L1_ABI_DECODE',
      '        CascadePayoutMath.hashStep(bytes32(0), address(0), entries.length, 0); // CONTROL:L1_A_LINKED_LIBRARYS_INTERNAL_FUNCTION',
    ].join('\n'),
  );

  const { problems, compiled } = checkCalls(s);
  assert.deepEqual(compiled.errors, [], 'every control compiles');
  assert.deepEqual(problems, []);
  // with no target, each cast fails and no control does (so the walk reads the controls)
  const none = callProblems(compiled, { callTargets: { [L2]: [] } });
  const marks = markers(s);
  assert.equal(marks.size, 22, [...marks.keys()].join(', '));
  for (const [name, { kind, path, line }] of marks) {
    assert.equal(at(none, path, line).length, kind === 'CAST' ? 1 : 0, `${name}: ${at(none, path, line).join('\n')}`);
  }
});

test('theCallRuleFailsClosedWhenItsClosureDoesNotCompile', () => {
  // no AST, no check: a compile error in a closure is a problem, naming its file and line
  const s = copy();
  const line = insertAfter(s, LEDGER, BODY, '        ISTAKING_ADDRESS = address(0xdead);');
  const { problems, compiled } = checkCalls(s);
  assert.ok(compiled.errors.length > 0);
  assert.match(at(problems, LEDGER, line).join('\n'), /does not compile, so the call rule cannot read solc's AST: error \d+: /);
});

test('thePinnedAddressIsItsHomeFilesConstant', () => {
  // the cast's address is IStaking.sol's file-level constant, at the precompile's address
  assert.deepEqual(PINNED.ISTAKING_ADDRESS, { path: HOME, value: '0x0000000000000000000000000000000000000805' });
  const declared = lineOf(REAL.get(HOME), 'address constant ISTAKING_ADDRESS');
  // at another value: the one problem, at its declaration (the casts still resolve to it)
  const v = copy();
  v.set(HOME, v.get(HOME).replace('0x0000000000000000000000000000000000000805', '0x0000000000000000000000000000000000000806'));
  assert.deepEqual(checkCalls(v).problems, [
    `${HOME}:${declared}: ISTAKING_ADDRESS must be 0x0000000000000000000000000000000000000805, not 0x0000000000000000000000000000000000000806`,
  ]);
  // the constant and the interface under other names everywhere: the home file declares neither, and no
  // call has a target
  const r = copy();
  // (the interface's name, not its file's)
  for (const [p, text] of r) r.set(p, text.replaceAll('ISTAKING_ADDRESS', 'STAKING_AT').replace(/\bIStaking\b(?!\.sol)/g, 'IStakingV2'));
  const { problems, compiled } = checkCalls(r);
  assert.deepEqual(compiled.errors, []);
  assert.ok(problems.includes(`${HOME}: declares no ISTAKING_ADDRESS constant`), problems.join('\n'));
  assert.ok(problems.includes(`${HOME}: declares no interface IStaking`), problems.join('\n'));
  // L2's seven precompile calls (its helpers' five and its own two removals, Task 20), and L4's seven: the same five
  // helpers' and its own two
  assert.equal(problems.filter((p) => /: external call: /.test(p)).length, 14, problems.join('\n'));
  assert.equal(problems.filter((p) => /: external call: .*CascadeStakeLib, whose/.test(p)).length, 7, problems.join('\n'));
  assert.equal(problems.filter((p) => /: external call: .*CascadeHotkeyLib, whose/.test(p)).length, 7, problems.join('\n'));
});

test('aCallOfAKindTheRuleDoesNotKnowFailsClosed', () => {
  // A call kind solc may add (a new builtin), or a callee with no function type at all, is an external
  // call until the rule lists it: a hand-built AST of L1's file, one call per line
  const call = (id, line, typeIdentifier) => ({
    nodeType: 'ExpressionStatement',
    id,
    src: `${(line - 1) * 6}:5:0`,
    expression: {
      nodeType: 'FunctionCall',
      id: id + 1,
      kind: 'functionCall',
      src: `${(line - 1) * 6}:5:0`,
      arguments: [],
      expression: {
        nodeType: 'Identifier',
        id: id + 2,
        name: 'f',
        src: `${(line - 1) * 6}:1:0`,
        ...(typeIdentifier ? { typeDescriptions: { typeIdentifier, typeString: `a ${typeIdentifier}` } } : {}),
      },
    },
  });
  const library = {
    nodeType: 'ContractDefinition',
    contractKind: 'library',
    id: 2,
    name: 'CascadeBatchLib',
    src: '0:24:0',
    nodes: [
      {
        nodeType: 'FunctionDefinition',
        id: 3,
        src: '0:24:0',
        body: {
          nodeType: 'Block',
          id: 4,
          src: '0:24:0',
          statements: [
            call(10, 1, 't_function_internal_pure$__$returns$__$'),
            call(20, 2, 't_function_somenewbuiltin_pure$__$returns$__$'),
            call(30, 3, undefined),
            call(40, 4, 't_function_keccak256_pure$_t_bytes_memory_ptr_$returns$_t_bytes32_$'),
          ],
        },
      },
    ],
  };
  const compiled = {
    roots: [L1],
    units: new Map([[L1, { ast: { nodeType: 'SourceUnit', id: 1, src: '0:24:0', nodes: [library] }, bytes: Buffer.from('l1();\nl2();\nl3();\nl4();\n') }]]),
    errors: [],
  };
  const problems = callProblems(compiled);
  assert.deepEqual(
    problems.map((p) => p.slice(0, p.indexOf(': external call'))),
    [`${L1}:2`, `${L1}:3`],
    problems.join('\n'),
  );
  assert.match(problems[0], /a call solc types as a t_function_somenewbuiltin_pure/);
  assert.match(problems[1], /a call solc types as nothing/);
});

// ---- L3, the payout engine (Task 5g) ----
//
// L3 calls the bridge the vault passes in PayoutIn (quoteFee, send) and, by DELEGATECALL, the payout math it
// links; nothing else, and never L2: the vault runs the walk between L3's two halves (the 5g ruling). The call
// rule reads both target kinds on solc's AST: a field target `Struct.field.function` (a call of that function
// on that field of a PayoutIn parameter of one of L3's own external functions, the field never written in the
// closure), and the libraries LINK_GRAPH says it links (their external functions' bodies are their own code,
// checked as theirs, so the walk skips them).

const TYPES = 'src/CascadeTypes.sol';
const BRIDGE = 'src/interfaces/ICascadeBridge.sol';
const L3_CHECKS = 'if (!input.bridgeEnabled) revert PrimaryBridgeDisabled();';
const L3_EFFECTS = 'ledger.pending -= plan.sum;';
const L3_IMPORT = 'import {CascadePayoutMath} from "./CascadePayoutMath.sol";';
const MATH_IMPORT = 'import {FeeTooHigh, PayoutsMismatch} from "../CascadeErrors.sol";';
/** The scope every problem in L3's code names: its three targets and its linked payout math. */
const L3_RULE =
  /in CascadePayoutLib, whose only call targets are PayoutIn\.bridge\.quoteFee, PayoutIn\.bridge\.send, msg\.sender\.call\{value\}\(""\) last in finish, the linked CascadePayoutMath \(by DELEGATECALL\)$/;

/** The 1-based lines of each `needle` in `text`, in order. */
function linesOf(text, needle) {
  const lines = [];
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) lines.push(text.slice(0, i).split('\n').length);
  assert.ok(lines.length, needle);
  return lines;
}

/** The `path:line` each problem names. */
const placeOf = (p) => p.slice(0, p.indexOf(': '));

test('thePayoutEnginesBytecodeCallsTheBridgeAndDelegatesOnlyToItsMath', () => {
  assert.deepEqual(CALL_OPCODES.CascadePayoutLib, ['CALL', 'STATICCALL', 'DELEGATECALL']);
  assert.deepEqual(CALL_TARGETS[L3], ['PayoutIn.bridge.quoteFee', 'PayoutIn.bridge.send', 'msg.sender.call{value}("") last in finish']);
  assert.deepEqual(VENDOR_IMPORTS[L3], [OZ_MATH]);
  const ops = opcodesOf(ARTIFACTS.CascadePayoutLib.deployed);
  assert.ok(ops.has(0xf1) && ops.has(0xfa) && ops.has(0xf4), 'the real engine sends, quotes and delegates');
  // it links the payout math and nothing else, and the vault no longer links the payout math itself
  assert.deepEqual(Object.keys(ARTIFACTS.CascadePayoutLib.deployedLinks), [MATH]);
  assert.ok(!(MATH in ARTIFACTS.CascadeVault.deployedLinks), 'the vault reaches the payout math only through L3');
  assert.ok(!(L2 in ARTIFACTS.CascadePayoutLib.deployedLinks), 'L3 does not link L2');
  for (const [op, name] of [
    ['f0', 'CREATE'],
    ['f5', 'CREATE2'],
    ['ff', 'SELFDESTRUCT'],
    ['f2', 'CALLCODE'],
  ]) {
    const a = clone();
    a.CascadePayoutLib.deployed = `${a.CascadePayoutLib.deployed.slice(0, 2)}${op}${a.CascadePayoutLib.deployed.slice(2)}`;
    assert.match(bytecodeProblems(a).join('\n'), new RegExp(`CascadePayoutLib's runtime code has ${name}`), name);
  }
});

test('theRealPayoutEngineCallsOnlyTheBridgeAndItsLinkedMath', () => {
  const compiled = compileAsts(SRC, callRuleRoots(REAL));
  assert.deepEqual(compiled.errors, []);
  assert.deepEqual(callProblems(compiled), []);
  // L3's closure, as solc resolved it, holds no walk: not L2, the ledger helper, the formulas or the precompile
  const closure = astClosure(compiled, L3);
  for (const p of [TYPES, BRIDGE, MATH, 'src/CascadeShares.sol', 'src/libraries/CascadeMessages.sol']) assert.ok(closure.includes(p), p);
  for (const p of [L2, LEDGER, FORMULAS, HOME]) assert.ok(!closure.includes(p), `${p} is in L3's closure`);

  const l3 = REAL.get(L3);
  const quote = linesOf(l3, 'input.bridge.quoteFee(');
  const send = linesOf(l3, 'input.bridge.send{');
  const refund = linesOf(l3, 'payable(msg.sender).call{');
  assert.equal(quote.length + send.length + refund.length, 3, 'one quote, one send, one refund (Task 21)');
  // with no target, exactly the two bridge calls and the refund fail
  const none = callProblems(compiled, { callTargets: { ...CALL_TARGETS, [L3]: [] } });
  assert.deepEqual(none.map(placeOf), [...quote, ...send, ...refund].sort((x, y) => x - y).map((n) => `${L3}:${n}`), none.join('\n'));
  for (const p of none) {
    assert.match(
      p,
      /: external call: (input\.bridge\.(quoteFee|send).*an external function|payable\(msg\.sender\)\.call\{value: plan\.refund\}\(…\), a low-level call) in CascadePayoutLib, whose only call target is the linked CascadePayoutMath \(by DELEGATECALL\)$/,
    );
  }
  // send alone: the quote and the refund fail
  const sendOnly = callProblems(compiled, { callTargets: { ...CALL_TARGETS, [L3]: ['PayoutIn.bridge.send'] } });
  assert.deepEqual(sendOnly.map(placeOf), [...quote, ...refund].map((n) => `${L3}:${n}`), sendOnly.join('\n'));
  // the refund named for another function: the real one is not that function's last statement, and fails as a call to
  // msg.sender that is not the refund
  const elsewhere = callProblems(compiled, {
    callTargets: { ...CALL_TARGETS, [L3]: ['PayoutIn.bridge.quoteFee', 'PayoutIn.bridge.send', 'msg.sender.call{value}("") last in prepare'] },
  });
  assert.deepEqual(elsewhere.map(placeOf), refund.map((n) => `${L3}:${n}`), elsewhere.join('\n'));
  assert.match(elsewhere[0], /a low-level call to msg\.sender that is not msg\.sender\.call\{value\}\(""\) last in prepare: not the last statement of that function/);
  // and for a function L3 does not have
  assert.match(
    callProblems(compiled, { callTargets: { ...CALL_TARGETS, [L3]: ['msg.sender.call{value}("") last in settle'] } }).join('\n'),
    /CALL_TARGETS lists msg\.sender\.call\{value\}\(""\) last in settle, but CascadePayoutLib has no external function settle/,
  );
  // without L3's link, each of its five calls into the payout math fails as a DELEGATECALL (deductFee twice since Task
  // 36b: finish splits again when the walk cost anything)
  const maths = ['verify', 'takeChunk', 'deductFee'].flatMap((f) => linesOf(l3, `CascadePayoutMath.${f}(`)).sort((x, y) => x - y);
  assert.equal(maths.length, 5, 'verify twice, takeChunk, deductFee twice');
  const unlinked = callProblems(compiled, { linkGraph: { ...LINK_GRAPH, CascadePayoutLib: [] } });
  assert.deepEqual(unlinked.map(placeOf), maths.map((n) => `${L3}:${n}`), unlinked.join('\n'));
  for (const p of unlinked) assert.match(p, /a DELEGATECALL/);
});

test('everyPayoutEngineBypassShapeFailsTheCallRule', () => {
  // Each shape compiles, in L3's file, and calls something other than the vault-passed bridge's quoteFee and
  // send or the linked payout math, or writes the bridge field those calls go through. Each fails at its line,
  // and nothing else does: the real calls on input.bridge still pass. PayoutIn gains a second field of the
  // bridge's interface, so a call on the right parameter but the wrong field is one of the shapes.
  const s = copy();
  replaceIn(s, TYPES, '    uint256 maxFeeAbs;\n}', '    uint256 maxFeeAbs;\n    ICascadeBridge spare;\n}');
  replaceIn(s, L3, L3_IMPORT, `${L3_IMPORT}\nimport {ICascadeBridge} from "../interfaces/ICascadeBridge.sol";`);
  insertAfter(
    s,
    L3,
    L3_CHECKS,
    [
      '        input.bridge = ICascadeBridge(address(0xb1)); // SHAPE:A_WRITTEN_FIELD',
      '        PayoutIn memory other;',
      '        input = other; // SHAPE:A_REASSIGNED_PARAMETER',
      '        input.spare.send(1, address(1), "", 1); // SHAPE:ANOTHER_FIELD_OF_THE_PARAMETER',
      '        ICascadeBridge(address(0xb3)).quoteFee(1, address(1), "", 1); // SHAPE:ANOTHER_ADDRESS',
      '        (bool sent,) = address(input.bridge).call{value: 1}(""); // SHAPE:A_LOW_LEVEL_CALL_ON_THE_BRIDGE',
      '        bytes4 sel = input.bridge.send.selector; // SHAPE:THE_FIELD_AS_A_VALUE',
      '        Elsewhere.f(input); // SHAPE:AN_UNLINKED_LIBRARY',
      '        (input, sent) = (other, false); // SHAPE:A_TUPLE_REASSIGNMENT',
      '        (sent, sel);',
    ].join('\n'),
  );
  insertAfter(s, L3, L3_EFFECTS, '        delete input.bridge; // SHAPE:A_DELETED_FIELD\n        delete input; // SHAPE:A_DELETED_PARAMETER');
  insertAfter(s, L3, 'library CascadePayoutLib {', '    function hop(PayoutIn memory p) internal { p.bridge.send(1, address(1), "", 1); } // SHAPE:AN_INTERNAL_FUNCTIONS_PARAMETER');
  s.set(
    L3,
    [
      s.get(L3),
      '/// Another struct with a bridge field of the same interface.',
      'struct Other {',
      '    ICascadeBridge bridge;',
      '}',
      '',
      '/// The bypass shapes outside L3: each compiles, and calls or writes what the field target does not allow.',
      'library Bypass3 {',
      '    function fakeIn() internal { PayoutIn memory fake; fake.bridge.send(1, address(1), "", 1); } // SHAPE:A_LOCAL_PAYOUT_IN',
      '    function hop(PayoutIn memory p) internal { p.bridge.send(1, address(1), "", 1); } // SHAPE:A_HELPERS_PARAMETER',
      '    function otherField(Other memory o) internal { o.bridge.quoteFee(1, address(1), "", 1); } // SHAPE:ANOTHER_STRUCTS_FIELD',
      '    function aliased(PayoutIn memory input) internal { PayoutIn memory a = input; a.bridge = ICascadeBridge(address(0xb4)); } // SHAPE:AN_ALIAS_WRITE',
      '    function tupled(PayoutIn memory input) internal { (input.bridge, input.isKeeper) = (ICascadeBridge(address(0xb5)), true); } // SHAPE:A_TUPLE_WRITE',
      '}',
      '',
      '/// a library L3 does not link, with an external function and a PayoutIn parameter of its own',
      'library Elsewhere {',
      '    function f(PayoutIn memory input) external { input.bridge.send(1, address(1), "", 1); } // SHAPE:ANOTHER_LIBRARYS_PARAMETER',
      '}',
      '',
    ].join('\n'),
  );

  const { problems, compiled } = checkCalls(s);
  assert.deepEqual(compiled.errors, [], 'every shape compiles');
  const CALL = /: external call: /;
  const WRITE = /: writes PayoutIn\.bridge /;
  const expected = {
    A_WRITTEN_FIELD: WRITE,
    A_DELETED_FIELD: WRITE,
    AN_ALIAS_WRITE: WRITE,
    // (it writes input.isKeeper too, which the whole-PayoutIn rule names as well, R1-C N-1)
    A_TUPLE_WRITE: WRITE,
    A_REASSIGNED_PARAMETER: /: reassigns input, the PayoutIn the vault passes /,
    A_DELETED_PARAMETER: /: reassigns input, the PayoutIn the vault passes /,
    A_TUPLE_REASSIGNMENT: /: reassigns input, the PayoutIn the vault passes /,
    A_LOW_LEVEL_CALL_ON_THE_BRIDGE: /a low-level call/,
    THE_FIELD_AS_A_VALUE: /: an external function as a value: /,
    AN_UNLINKED_LIBRARY: /a DELEGATECALL/,
  };
  const shapes = markers(s);
  assert.equal(shapes.size, 17, [...shapes.keys()].join(', '));
  for (const [name, { path, line }] of shapes) {
    const p = at(problems, path, line);
    assert.ok(p.length > 0, `${name} (${path}:${line}) passes the call rule`);
    assert.ok(p.some((x) => (expected[name] ?? CALL).test(x)), `${name}: ${p.join('\n')}`);
    assert.ok(
      p.every((x) => L3_RULE.test(x)),
      `${name}: ${p.join('\n')}`,
    );
  }
  const marked = new Set([...shapes.values()].map(({ path, line }) => `${path}:${line}:`));
  assert.deepEqual(problems.filter((p) => ![...marked].some((m) => p.startsWith(m))), []);
});

test('N2_theRefundIsValueOnlyEmptyCalldataAndFinishsLastStatement', () => {
  // R1-C N-2, the refund kind (Task 21): L3 may pay msg.sender, the vault's caller, only as
  // `msg.sender.call{value: …}("")` (or payable(msg.sender)), the last statement of finish but its own success check.
  // Each shape below compiles in a copy of L3 and fails at its line; the real refund and the controls pass. The tail
  // shapes sit in extra external functions, each named as a refund target, so one solc run reads them all.
  const s = copy();
  const tails = {
    n2Calldata: '(bool ok,) = payable(msg.sender).call{value: v}("x"); // SHAPE:CALLDATA',
    n2Gas: '(bool ok,) = payable(msg.sender).call{value: v, gas: 50_000}(""); // SHAPE:A_GAS_OPTION',
    n2NoValue: '(bool ok,) = payable(msg.sender).call(""); // SHAPE:NO_VALUE_OPTION',
    n2Variable: 'bytes memory none;\n        (bool ok,) = payable(msg.sender).call{value: v}(none); // SHAPE:CALLDATA_AS_A_VARIABLE',
    n2OtherTarget: '(bool ok,) = payable(address(uint160(v))).call{value: v}(""); // SHAPE:ANOTHER_TARGET',
    n2NotLast: '(bool ok,) = payable(msg.sender).call{value: v}(""); // SHAPE:NOT_LAST\n        v += 1;',
    n2Plain: '(bool ok,) = msg.sender.call{value: v}(""); // CONTROL:WITHOUT_PAYABLE',
  };
  const fns = Object.entries(tails).map(([name, call]) => {
    const check = name === 'n2NotLast' ? '' : '\n        if (!ok) revert TransferFailed();';
    return `    function ${name}(uint256 v) external {\n        ${call}${check}\n    }`;
  });
  fns.push(
    '    function n2AfterCheck(uint256 v) external {\n        (bool ok,) = payable(msg.sender).call{value: v}(""); // SHAPE:A_STATEMENT_AFTER_THE_CHECK\n        if (!ok) revert TransferFailed();\n        v += 1;\n    }',
    '    function n2Else(uint256 v) external {\n        if (v != 0) {\n            (bool ok,) = payable(msg.sender).call{value: v}(""); // SHAPE:AN_ELSE\n            if (!ok) revert TransferFailed();\n        } else {\n            v += 1;\n        }\n    }',
    '    function n2Unchecked(uint256 v) external {\n        payable(msg.sender).call{value: v}(""); // CONTROL:UNCHECKED\n    }',
    // a modifier's code after `_` would run after the refund (fix round 1, M4)
    '    modifier thenMore() {\n        _;\n        uint256 x = 1;\n        x;\n    }',
    '    function n2Modified(uint256 v) external thenMore {\n        (bool ok,) = payable(msg.sender).call{value: v}(""); // SHAPE:A_MODIFIER\n        if (!ok) revert TransferFailed();\n    }',
    // a refund in a loop is not the last statement, even as the loop body's last
    '    function n2For(uint256 v) external {\n        for (uint256 i; i < 2; ++i) {\n            (bool ok,) = payable(msg.sender).call{value: v}(""); // SHAPE:IN_A_FOR_LOOP\n            if (!ok) revert TransferFailed();\n        }\n    }',
    '    function n2While(uint256 v) external {\n        while (v != 0) {\n            (bool ok,) = payable(msg.sender).call{value: v}(""); // SHAPE:IN_A_WHILE_LOOP\n            if (!ok) revert TransferFailed();\n            v = 0;\n        }\n    }',
    '    function _refund(uint256 v) private { (bool ok,) = payable(msg.sender).call{value: v}(""); if (!ok) revert TransferFailed(); } // SHAPE:IN_A_HELPER',
    '    function n2Transfer(uint256 v) external { payable(msg.sender).transfer(v); } // SHAPE:A_TRANSFER',
  );
  insertAfter(s, L3, 'library CascadePayoutLib {', fns.join('\n'));
  // a second refund earlier in finish, and one at the end of prepare (not a refund target)
  insertAfter(s, L3, L3_SEND, '        (bool early,) = payable(msg.sender).call{value: 1}(""); // SHAPE:A_SECOND_REFUND_IN_FINISH\n        early;');
  insertAfter(s, L3, 'if (net != 0) plan.message = CascadeMessages.encodePayouts(key, b.chunk, kept);', '        (bool late,) = payable(msg.sender).call{value: 1}(""); // SHAPE:LAST_IN_PREPARE\n        late;');
  const targets = [
    ...CALL_TARGETS[L3],
    ...[...Object.keys(tails), 'n2AfterCheck', 'n2Else', 'n2Unchecked', 'n2Modified', 'n2For', 'n2While'].map((f) => `msg.sender.call{value}("") last in ${f}`),
  ];
  const { problems, compiled } = checkCalls(s, { callTargets: { ...CALL_TARGETS, [L3]: targets } });
  assert.deepEqual(compiled.errors, [], 'every shape compiles');

  const NOT_LAST = /a low-level call to msg\.sender that is not .*: not the last statement of that function/;
  const expected = {
    CALLDATA: /a low-level call to msg\.sender that is not .*: calldata other than the empty string literal ""/,
    CALLDATA_AS_A_VARIABLE: /a low-level call to msg\.sender that is not .*: calldata other than the empty string literal ""/,
    A_GAS_OPTION: /a low-level call to msg\.sender that is not .*: the call options \{value, gas\}, where only \{value\} is allowed/,
    NO_VALUE_OPTION: /a low-level call to msg\.sender that is not .*: the call options \{\}, where only \{value\} is allowed/,
    ANOTHER_TARGET: /: external call: payable\(address\(uint160\(v\)\)\)\.call\{value: v\}\(…\), a low-level call in CascadePayoutLib/,
    NOT_LAST,
    A_STATEMENT_AFTER_THE_CHECK: NOT_LAST,
    AN_ELSE: NOT_LAST,
    IN_A_HELPER: NOT_LAST,
    A_SECOND_REFUND_IN_FINISH: NOT_LAST,
    LAST_IN_PREPARE: NOT_LAST,
    A_TRANSFER: /a value transfer in CascadePayoutLib/,
    A_MODIFIER: /a low-level call to msg\.sender that is not .*: n2Modified has a modifier \(thenMore\), whose code could run after it/,
    IN_A_FOR_LOOP: NOT_LAST,
    IN_A_WHILE_LOOP: NOT_LAST,
  };
  const marks = markers(s);
  const shapes = [...marks].filter(([, m]) => m.kind === 'SHAPE');
  assert.deepEqual(shapes.map(([n]) => n).sort(), Object.keys(expected).sort());
  for (const [name, { path, line }] of shapes) {
    const p = at(problems, path, line);
    assert.equal(p.length, 1, `${name} (${path}:${line}): ${problems.join('\n')}`);
    assert.match(p[0], expected[name], name);
  }
  // the controls (msg.sender.call without payable; an unchecked last call, which the warning gate refuses for its
  // unused result) and the real refund pass; nothing else fails
  for (const name of ['WITHOUT_PAYABLE', 'UNCHECKED']) assert.deepEqual(at(problems, L3, marks.get(name).line), [], name);
  const real = lineOf(s.get(L3), '(bool ok,) = payable(msg.sender).call{value: plan.refund}("");');
  assert.deepEqual(at(problems, L3, real), [], 'the real refund passes');
  const marked = new Set(shapes.map(([, { path, line }]) => `${path}:${line}:`));
  assert.deepEqual(problems.filter((p) => ![...marked].some((m) => p.startsWith(m))), []);
});

test('thePayoutEngineNeverRunsTheWalk', () => {
  // the 5g ruling: the vault runs the walk between L3's halves, so L3 neither links nor calls L2. A call into
  // L2 is a DELEGATECALL to a library L3 does not link; and once L2 is imported, the walk's precompile calls
  // are compiled into L3's closure and count against it
  const s = copy();
  replaceIn(s, L3, L3_IMPORT, `${L3_IMPORT}\nimport {CascadeStakeLib} from "./CascadeStakeLib.sol";\nimport {WalkParams} from "../CascadeTypes.sol";`);
  const line = insertAfter(s, L3, L3_CHECKS, '        WalkParams memory w;\n        CascadeStakeLib.unstake(w, 1);') + 1;
  const { problems, compiled } = checkCalls(s);
  assert.deepEqual(compiled.errors, []);
  assert.match(at(problems, L3, line).join('\n'), /: external call: CascadeStakeLib\.unstake\(…\), an external or public library function \(a DELEGATECALL\) in CascadePayoutLib/);
  assert.ok(problems.some((p) => p.startsWith(`${LEDGER}:`) && /compiled into CascadePayoutLib/.test(p)), problems.join('\n'));
});

test('aLinkedLibrarysExternalBodiesAreItsOwn', () => {
  // L3 links the payout math: its external functions run as the payout math's own code, held by its own
  // bytecode rule (no call opcode at all), so L3's walk skips their bodies; an internal function of it can be
  // compiled into L3, so it is walked like any closure code (used or not: the walk over-approximates)
  const s = copy();
  replaceIn(s, MATH, MATH_IMPORT, `${MATH_IMPORT}\nimport {ICascadeBridge} from "../interfaces/ICascadeBridge.sol";`);
  const internal =
    insertAfter(s, MATH, 'library CascadePayoutMath {', '    function probe() internal view returns (uint256) {\n        return ICascadeBridge(address(0xc2)).quoteFee(1, address(1), "", 1);\n    }\n') + 1;
  replaceIn(s, MATH, 'bytes32 payoutsHash) external pure {', 'bytes32 payoutsHash) external view {');
  const external = insertAfter(s, MATH, 'if (payouts.length != count) revert PayoutsMismatch();', '        ICascadeBridge(address(0xc1)).quoteFee(1, address(1), "", 1);');
  assert.match(s.get(MATH).split('\n')[external - 1], /0xc1/);
  assert.match(s.get(MATH).split('\n')[internal - 1], /0xc2/);
  const { problems, compiled } = checkCalls(s);
  assert.deepEqual(compiled.errors, []);
  assert.deepEqual(at(problems, MATH, external), [], "the linked library's external body is not L3's");
  assert.match(at(problems, MATH, internal).join('\n'), /in src\/libraries\/CascadePayoutMath\.sol, compiled into CascadePayoutLib/);
  // unlinked, the external body is walked as L3's
  const unlinked = callProblems(compiled, { linkGraph: { ...LINK_GRAPH, CascadePayoutLib: [] } });
  assert.match(at(unlinked, MATH, external).join('\n'), /compiled into CascadePayoutLib/);
  // the payout math's own code is held by its bytecode: no call opcode at all
  const a = clone();
  a.CascadePayoutMath.deployed = `${a.CascadePayoutMath.deployed.slice(0, 2)}fa${a.CascadePayoutMath.deployed.slice(2)}`;
  assert.match(bytecodeProblems(a).join('\n'), /CascadePayoutMath's runtime code has STATICCALL \(allowed: none\)/);
});

test('aLinkedLibrarysPublicBodyReachedInternallyIsCompiledIntoTheCaller', () => {
  // a public function of a linked library, called from L3 through an internal function, is compiled INTO L3
  // (an internal call, not a DELEGATECALL), so its body is walked; only external bodies are the library's own
  const s = copy();
  replaceIn(s, MATH, MATH_IMPORT, `${MATH_IMPORT}\nimport {ICascadeBridge} from "../interfaces/ICascadeBridge.sol";`);
  const pub =
    insertAfter(s, MATH, 'library CascadePayoutMath {', '    function pubProbe() public view returns (uint256) {\n        return ICascadeBridge(address(0xc3)).quoteFee(1, address(1), "", 1);\n    }\n    function viaInternal() internal view returns (uint256) {\n        return pubProbe();\n    }\n') + 1;
  assert.match(s.get(MATH).split('\n')[pub - 1], /0xc3/);
  const { problems, compiled } = checkCalls(s);
  assert.deepEqual(compiled.errors, []);
  assert.match(at(problems, MATH, pub).join('\n'), /in src\/libraries\/CascadePayoutMath\.sol, compiled into CascadePayoutLib/);
});

test('aFieldTargetIsPinnedToItsStructAndInterface', () => {
  // the field target's struct is CascadeTypes.sol's file-level PayoutIn, and its field holds ICascadeBridge.sol's
  // interface, whose functions the targets name
  assert.deepEqual(PINNED['PayoutIn.bridge'], { path: TYPES, type: 'ICascadeBridge', typePath: BRIDGE });
  const compiled = compileAsts(SRC, callRuleRoots(REAL));
  assert.match(callProblems(compiled, { callTargets: { [L3]: ['PayoutIn.keeper.send'] } }).join('\n'), /CALL_TARGETS lists PayoutIn\.keeper\.send, but PINNED does not fix PayoutIn\.keeper/);
  assert.match(callProblems(compiled, { callTargets: { [L3]: ['PayoutIn.bridge.refund'] } }).join('\n'), new RegExp(`${BRIDGE}: interface ICascadeBridge declares no function refund`));
  // the struct under another name everywhere: its home declares none, and both bridge calls fail
  const r = copy();
  for (const [p, text] of r) r.set(p, text.replace(/\bPayoutIn\b/g, 'PayoutInput'));
  const renamed = checkCalls(r);
  assert.deepEqual(renamed.compiled.errors, []);
  assert.ok(renamed.problems.includes(`${TYPES}: declares no struct PayoutIn`), renamed.problems.join('\n'));
  assert.equal(renamed.problems.filter((p) => /: external call: /.test(p)).length, 2, renamed.problems.join('\n'));
  // the field holding a lookalike interface declared elsewhere: refused at the field
  const t = copy();
  const twin = 'src/interfaces/IBridgeTwin.sol';
  t.set(twin, REAL.get(BRIDGE));
  replaceIn(t, TYPES, 'import {ICascadeBridge} from "./interfaces/ICascadeBridge.sol";', 'import {ICascadeBridge} from "./interfaces/IBridgeTwin.sol";');
  // (the real interface is compiled too, so the pin, not its absence, tells the two apart)
  replaceIn(t, L3, L3_IMPORT, `${L3_IMPORT}\nimport {ICascadeBridge as RealBridge} from "../interfaces/ICascadeBridge.sol";`);
  const field = lineOf(t.get(TYPES), '    ICascadeBridge bridge;');
  const lookalike = checkCalls(t);
  assert.deepEqual(lookalike.compiled.errors, []);
  assert.ok(lookalike.compiled.units.has(BRIDGE), 'the real interface is compiled');
  assert.match(at(lookalike.problems, TYPES, field).join('\n'), new RegExp(`PayoutIn\\.bridge must hold interface ICascadeBridge of ${BRIDGE}`));
  // the struct declared outside its home, and imported from there: the home declares none, and both calls fail
  const m = copy();
  const types = m.get(TYPES);
  const start = types.indexOf('struct PayoutIn {');
  const end = types.indexOf('}', start) + 1;
  const elsewhere = 'src/PayoutInElsewhere.sol';
  m.set(
    elsewhere,
    ['// SPDX-License-Identifier: MIT', 'pragma solidity 0.8.38;', '', 'import {ICascadeBridge} from "./interfaces/ICascadeBridge.sol";', 'import {PayoutBatch} from "./CascadeTypes.sol";', '', types.slice(start, end), ''].join('\n'),
  );
  m.set(TYPES, types.slice(0, start) + types.slice(end));
  replaceIn(m, L3, 'import {Ledger, PayoutBatch, PayoutIn, PayoutPlan, SharesData} from "../CascadeTypes.sol";', 'import {Ledger, PayoutBatch, PayoutPlan, SharesData} from "../CascadeTypes.sol";\nimport {PayoutIn} from "../PayoutInElsewhere.sol";');
  const moved = checkCalls(m);
  assert.deepEqual(moved.compiled.errors, []);
  assert.ok(moved.problems.includes(`${TYPES}: declares no struct PayoutIn`), moved.problems.join('\n'));
  assert.equal(moved.problems.filter((x) => /: external call: /.test(x)).length, 2, moved.problems.join('\n'));
});

// ---- R1-C F-1 and N-1: assembly in one memory-only function, the bytecode's backstops, the whole PayoutIn ----
//
// Reviewer C's PoCs (Checkpoint R1, scratchpad r1c/contracts/script/r1c-poc.test.mjs and r1c-args.test.mjs), each
// of which passed every rule at 261bdb3: an internal payout-math helper whose assembly rewrites L3's PayoutIn.bridge
// (F1a: L3 then pays an address of its choosing), assembly that logs a forged Transfer from the vault or returns
// from its frame (F1b), and a Solidity write to the destination L3's payout carries (N-1). Each now fails.

const DEDUCT = '        kept = new CascadeMessages.Entry[](taken);';
const MATH_OPEN = 'library CascadePayoutMath {';
const L3_SEND = '        // 5. send exactly net + fee';

/** Every rule that reads `sources`: the source rules on the text, and the call, assembly and write-set rules on
 * solc's AST of a scratch copy (as checkCalls, the vault compiled alongside: astRoots), with the assembly rule over
 * every linked library's closure. */
function checkAll(sources) {
  const dir = mkdtempSync(join(tmpdir(), 'library-rules-all-'));
  try {
    cpSync(SRC, join(dir, 'src'), { recursive: true });
    for (const [p, text] of sources) {
      if (REAL.get(p) === text) continue;
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    }
    const compiled = compileAsts(join(dir, 'src'), astRoots(sources));
    return {
      compiled,
      source: sourceProblems(sources),
      calls: callProblems(compiled),
      assembly: assemblyProblems(compiled, { roots: libraryRoots(sources) }),
      writes: writeSetProblems(compiled),
      precompile: precompileFunctionProblems(compiled),
      bound: boundCallProblems(compiled),
      yul: yulCallProblems(compiled, { roots: libraryRoots(sources) }),
      delegatecallText: delegatecallSourceProblems(sources),
      delegatecall: delegatecallAstProblems(compiled),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('theRealSourcesPassTheAssemblyRule', () => {
  // no first-party code compiled into a library holds assembly: deductFee shrinks its lists in Solidity
  const compiled = compileAsts(SRC, astRoots(REAL));
  assert.deepEqual(compiled.errors, []);
  assert.deepEqual(assemblyProblems(compiled, { roots: libraryRoots(REAL) }), []);
  // and the text rule agrees: no assembly in any library's code or anything it compiles in
  assert.deepEqual(sourceProblems(REAL), []);
  assert.doesNotMatch(stripComments(REAL.get(MATH)), /assembly/);
  // OpenZeppelin's Math (mulDiv's assembly) is compiled into every library, and skipped as vendored
  assert.ok([...compiled.units.keys()].some((p) => p.includes('openzeppelin') && p.endsWith('Math.sol')));
});

test('F1a_anAssemblyRewriteOfL3sBridgeFailsTheRules', () => {
  // the PoC: an internal helper of the payout math, compiled into L3, mstores over PayoutIn.bridge in L3's memory
  const s = copy();
  replaceIn(s, MATH, MATH_IMPORT, `${MATH_IMPORT}\nimport {PayoutIn} from "../CascadeTypes.sol";`);
  const fn = insertAfter(
    s,
    MATH,
    MATH_OPEN,
    [
      '    /// Normalises a payout input in place (memory only: no storage, no call).',
      '    function normalize(PayoutIn memory p, address to) internal pure {',
      '        assembly ("memory-safe") {',
      '            mstore(add(p, 0x40), to)',
      '        }',
      '    }',
      '',
    ].join('\n'),
  );
  replaceIn(s, L3, L3_SEND, `        CascadePayoutMath.normalize(input, address(0xBAD));\n${L3_SEND}`);
  const { compiled, source, calls, assembly } = checkAll(s);
  assert.deepEqual(compiled.errors, [], 'the shape compiles');
  const block = fn + 2;
  assert.deepEqual(assembly, [
    `${MATH}:${block}: assembly in CascadePayoutMath.normalize, compiled into a linked library: no library may hold any (R1-C F-1)`,
  ]);
  assert.match(at(source, MATH, block).join('\n'), /assembly in library code \(no library may hold any, R1-C F-1\)/);
  // the call rule alone still reads the send as the bridge the vault passed: the assembly rule closes it
  assert.deepEqual(calls, []);
  console.log(`F1a shapes:\n  ${[...assembly, ...source].join('\n  ')}`);
});

test('F1b_assemblyThatLogsOrReturnsFailsTheRules', () => {
  // the PoC: a forged csTAO Transfer logged from the vault's address through L1, and a frame-ending return
  const s = copy();
  const fn = insertAfter(
    s,
    MATH,
    MATH_OPEN,
    [
      '    function note(address to, uint256 amount) internal {',
      '        assembly ("memory-safe") {',
      '            mstore(0, amount)',
      '            log3(0, 0x20, 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef, 0, to)',
      '        }',
      '    }',
      '    function bail(uint256 w) internal pure {',
      '        assembly ("memory-safe") {',
      '            mstore(0, w)',
      '            return(0, 0x20)',
      '        }',
      '    }',
      '',
    ].join('\n'),
  );
  replaceIn(s, L1, '        emit BatchDelivered(', '        CascadePayoutMath.note(input.sender, 1e30);\n        CascadePayoutMath.bail(0);\n        emit BatchDelivered(');
  const { compiled, source, assembly } = checkAll(s);
  assert.deepEqual(compiled.errors, [], 'the shape compiles');
  const [noteBlock, bailBlock] = [fn + 1, fn + 7];
  assert.match(at(assembly, MATH, noteBlock).join('\n'), /assembly in CascadePayoutMath\.note, compiled into a linked library: no library may hold any/);
  assert.match(at(assembly, MATH, bailBlock).join('\n'), /assembly in CascadePayoutMath\.bail, compiled into a linked library: no library may hold any/);
  assert.equal(assembly.length, 2, assembly.join('\n'));
  assert.match(at(source, MATH, noteBlock).join('\n'), /assembly in library code/);
  assert.match(at(source, MATH, bailBlock).join('\n'), /assembly in library code/);
  console.log(`F1b shapes:\n  ${[...assembly, ...source].join('\n  ')}`);
});

test('N1_aWriteToThePayoutInTheVaultPassesFailsTheCallRule', () => {
  // the PoC: the destination of L3's send, input.batch.frontDoor, written through the memory alias `b`; and any
  // other field of the PayoutIn, directly or through a helper's parameter
  const s = copy();
  replaceIn(s, L3, L3_SEND, `        b.frontDoor = address(0xBAD);\n        input.pending = 0;\n        retarget(input.batch);\n${L3_SEND}`);
  const helper = insertAfter(s, L3, 'library CascadePayoutLib {', '    function retarget(PayoutBatch memory x) internal pure { x.sourceChain = 1; }');
  // a storage pointer's write stays the queue's own effect (finish's s.cursor and the rest)
  const { compiled, calls } = checkAll(s);
  assert.deepEqual(compiled.errors, [], 'the shape compiles');
  const text = s.get(L3);
  assert.match(at(calls, L3, lineOf(text, 'b.frontDoor = address(0xBAD);')).join('\n'), /writes PayoutBatch\.frontDoor in memory \(b\.frontDoor\), a field of what the PayoutIn the vault passes holds \(R1-C N-1\), in CascadePayoutLib, whose only call targets are/);
  assert.match(at(calls, L3, lineOf(text, 'input.pending = 0;')).join('\n'), /writes PayoutIn\.pending \(input\.pending\), a field of the PayoutIn the vault passes \(R1-C N-1\), in CascadePayoutLib, whose only call targets are/);
  assert.match(at(calls, L3, helper).join('\n'), /writes PayoutBatch\.sourceChain in memory \(x\.sourceChain\)/);
  assert.equal(calls.length, 3, calls.join('\n'));
  console.log(`N-1 shapes:\n  ${calls.join('\n  ')}`);
});

test('anyAssemblyFailsEvenAMemoryOnlyMstoreInDeductFee', () => {
  // the ruling: no library may hold assembly at all. A memory-only mstore through deductFee's own return variables,
  // in the external function that runs in its own frame, fails both rules; so does any block anywhere a library
  // compiles in
  for (const [anchor, code, owner, path] of [
    [DEDUCT, '        assembly ("memory-safe") { mstore(dust, net) mstore(kept, net) }', 'CascadePayoutMath\\.deductFee', MATH],
    [DEDUCT, '        assembly ("memory-safe") { mstore(kept, 0) }', 'CascadePayoutMath\\.deductFee', MATH],
    ['        if (payouts.length != count) revert PayoutsMismatch();', '        assembly ("memory-safe") { mstore(0, 1) }', 'CascadePayoutMath\\.verify', MATH],
    ['        return keccak256(abi.encode(h, user, shares, assets));', '        assembly ("memory-safe") { mstore(0, 1) }', 'CascadePayoutMath\\.hashStep', MATH],
    ['library CascadeFormulas {', '    function scratch() internal pure { assembly ("memory-safe") { mstore(0, 1) } }', 'CascadeFormulas\\.scratch', FORMULAS],
  ]) {
    const x = copy();
    const line = insertAfter(x, path, anchor, code);
    const r = checkAll(x);
    assert.deepEqual(r.compiled.errors, [], code);
    assert.match(at(r.assembly, path, line).join('\n'), new RegExp(`assembly in ${owner}, compiled into a linked library: no library may hold any \\(R1-C F-1\\)`), code);
    assert.match(at(r.source, path, line).join('\n'), /assembly in library code \(no library may hold any, R1-C F-1\)/, code);
  }
});

test('theBytecodeBackstopsRefuseStateOpcodes', () => {
  assert.deepEqual(STATE_OPCODES, {
    '*': ['TSTORE'],
    CascadeStakeLib: ['SSTORE'],
    CascadePayoutMath: ['SSTORE', 'LOG0', 'LOG1', 'LOG2', 'LOG3', 'LOG4'],
  });
  // the real libraries pass: L1 and L3 write the vault's storage and emit, L2 emits (Unstaked), none uses TSTORE
  assert.deepEqual(bytecodeProblems(ARTIFACTS), []);
  const prefixed = (a, name, op) => {
    a[name].deployed = `${a[name].deployed.slice(0, 2)}${op}${a[name].deployed.slice(2)}`;
    return a;
  };
  for (const name of ['CascadeBatchLib', 'CascadeHotkeyLib', 'CascadePayoutLib', 'CascadePayoutMath', 'CascadeStakeLib']) {
    assert.match(bytecodeProblems(prefixed(clone(), name, '5d')).join('\n'), new RegExp(`${name}'s runtime code has TSTORE, which STATE_OPCODES refuses it`), name);
  }
  for (const name of ['CascadeStakeLib', 'CascadePayoutMath']) {
    assert.match(bytecodeProblems(prefixed(clone(), name, '55')).join('\n'), new RegExp(`${name}'s runtime code has SSTORE`), name);
  }
  for (const [op, n] of [['a0', 0], ['a1', 1], ['a2', 2], ['a3', 3], ['a4', 4]]) {
    assert.match(bytecodeProblems(prefixed(clone(), 'CascadePayoutMath', op)).join('\n'), new RegExp(`CascadePayoutMath's runtime code has LOG${n}`));
  }
  // what the real code needs stays allowed: SSTORE and LOG in L1, L3 and L4
  for (const name of ['CascadeBatchLib', 'CascadePayoutLib', 'CascadeHotkeyLib']) {
    for (const op of ['55', 'a1']) assert.deepEqual(bytecodeProblems(prefixed(clone(), name, op)), [], `${name} ${op}`);
  }
});

test('theScriptRunsTheAssemblyRuleAndTheBackstops', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No linked library compiles in any inline assembly \(first-party code, on solc's AST; OpenZeppelin's Math is the vendored exception\)\./);
  assert.match(r.stdout, /CascadePayoutMath's runtime code has no TSTORE, SSTORE, LOG0, LOG1, LOG2, LOG3, LOG4\./);
  assert.match(r.stdout, /CascadeStakeLib's runtime code has no TSTORE, SSTORE\./);
  assert.match(r.stdout, /CascadeHotkeyLib's runtime code has no TSTORE\./);
  // fix round 1: the precompile rule and the using-for rule run too
  assert.match(r.stdout, /CascadeHotkeyLib's compiled code calls exactly getDefaultMinStake, getStake, getUnclaimedRootTaoByHotkey, moveStake, removeStake, removeStakeFull of the staking precompile, on solc's AST\./);
  assert.match(r.stdout, /CascadeStakeLib's compiled code calls exactly getDefaultMinStake, getNominatorMinRequiredStake, getStake, removeStake, removeStakeFull of the staking precompile, on solc's AST\./);
  assert.match(r.stdout, /No call into a linked library goes through using-for/);
});

// ---- R1-C F-2: no library call carries value to the precompile ----

test('F2_valueOnTheCastTargetFailsTheCallRule', () => {
  // the PoC: the ledger helper L2 compiles in sends the vault's whole balance with its removal; and a {value} on
  // L2's own cast, with or beside {gas}, fails the same way. {gas} alone stays allowed.
  const s = copy();
  replaceIn(
    s,
    LEDGER,
    'else IStaking(ISTAKING_ADDRESS).removeStake(h, want, NETUID_ROOT);',
    'else IStaking(ISTAKING_ADDRESS).removeStake{value: address(this).balance}(h, want, NETUID_ROOT);',
  );
  const { problems, compiled } = checkCalls(s);
  assert.deepEqual(compiled.errors, [], 'the shape compiles');
  const line = lineOf(s.get(LEDGER), 'removeStake{value: address(this).balance}');
  assert.match(
    at(problems, LEDGER, line).join('\n'),
    /a call option \{value: …\} on IStaking\(ISTAKING_ADDRESS\)\.removeStake in src\/libraries\/CascadeLedger\.sol, compiled into CascadeStakeLib: no library call carries value to a cast target \(R1-C F-2\); \{gas\} only/,
  );
  // the ledger helper is compiled into L4 too (the owner's direct removal, step L4): refused there as well
  assert.match(
    at(problems, LEDGER, line).join('\n'),
    /a call option \{value: …\} on IStaking\(ISTAKING_ADDRESS\)\.removeStake in src\/libraries\/CascadeLedger\.sol, compiled into CascadeHotkeyLib: no library call carries value to a cast target \(R1-C F-2\); \{gas\} only/,
  );
  assert.equal(problems.length, 2, problems.join('\n'));
  console.log(`F2 shape:\n  ${problems.join('\n  ')}`);

  // {gas} and {value} together: refused; {gas} alone: allowed
  const g = copy();
  const both = insertAfter(g, LEDGER, BODY, '        IStaking(ISTAKING_ADDRESS).removeStake{gas: 1, value: 1}(bytes32(0), 1, 0);');
  const gasOnly = insertAfter(g, LEDGER, BODY, '        IStaking(ISTAKING_ADDRESS).removeStake{gas: 1}(bytes32(0), 1, 0);');
  const r = checkCalls(g);
  assert.deepEqual(r.compiled.errors, []);
  assert.match(at(r.problems, LEDGER, both + 1).join('\n'), /a call option \{value: …\} on IStaking\(ISTAKING_ADDRESS\)\.removeStake in src\/libraries\/CascadeLedger\.sol, compiled into CascadeStakeLib/);
  assert.match(at(r.problems, LEDGER, both + 1).join('\n'), /a call option \{value: …\} on IStaking\(ISTAKING_ADDRESS\)\.removeStake in src\/libraries\/CascadeLedger\.sol, compiled into CascadeHotkeyLib/);
  assert.deepEqual(at(r.problems, LEDGER, gasOnly), [], 'gas alone is allowed');
  assert.equal(r.problems.length, 2, r.problems.join('\n'));

  // the walk's own removals (Task 20), in a try with their gas share: a {value} beside the {gas} is refused there too,
  // at its line, in L2 alone (L4 does not compile L2's file)
  const t = copy();
  replaceIn(t, L2, 'removeStake{gas: gas}(h, want, NETUID_ROOT)', 'removeStake{gas: gas, value: 1}(h, want, NETUID_ROOT)');
  const tr = checkCalls(t);
  assert.deepEqual(tr.compiled.errors, [], 'the shape compiles');
  const tline = lineOf(t.get(L2), 'removeStake{gas: gas, value: 1}');
  assert.match(
    at(tr.problems, L2, tline).join('\n'),
    /a call option \{value: …\} on IStaking\(ISTAKING_ADDRESS\)\.removeStake in CascadeStakeLib: no library call carries value to a cast target \(R1-C F-2\); \{gas\} only/,
  );
  assert.equal(tr.problems.length, 1, tr.problems.join('\n'));
});

// ---- L4, the hotkey library (step L4, the reserve lever) ----
//
// L4 runs addHotkey's, removeHotkey's and moveStake's rules in the vault's context: it calls only the staking
// precompile, holds no assembly, sets no transient flag, and writes exactly its set of the vault's storage, as the
// vault's call sites bind its storage parameters (the write-set rule, on solc's AST).

const L4_ADD = '        emit HotkeyAdded(h);';
const L4_REMOVED = '        emit HotkeyRemoved(h, unclaimed, forfeit);';
const L4_REMOVE = '        uint256 leftover = CascadeFormulas.stakeOf(h, coldkey);';
const L4_SET = ['hotkeys', 'isHotkey', 'lastClaimAt'];

test('theHotkeyLibIsALinkedLibraryHeldToItsRules', () => {
  // linked by the vault alone, linking nothing; scanned; its call target the precompile; its write set
  assert.ok(libraryRoots(REAL).includes(L4));
  assert.deepEqual(LINK_GRAPH.CascadeVault, ['CascadeBatchLib', 'CascadeHotkeyLib', 'CascadePayoutLib', 'CascadeStakeLib']);
  assert.deepEqual(CALL_TARGETS[L4], ['IStaking(ISTAKING_ADDRESS)']);
  assert.deepEqual(CALL_OPCODES.CascadeHotkeyLib, ['CALL', 'STATICCALL']);
  assert.deepEqual(VENDOR_IMPORTS[L4], [OZ_MATH]);
  assert.deepEqual(WRITE_SETS, { [L4]: L4_SET });
  assert.equal(WRITE_SET_CALLER, VAULT);
  assert.ok(astRoots(REAL).includes(VAULT), 'the write-set rule reads the vault in the same solc run');
  // its closure: the ledger helper (the owner's direct removal) and the formulas (the guard, the floors); no token
  const closure = importClosure(REAL, L4);
  for (const p of [LEDGER, FORMULAS, HOME, 'src/CascadeTypes.sol', 'src/CascadeErrors.sol', 'src/CascadeEvents.sol']) {
    assert.ok(closure.includes(p), `${p} is not in L4's closure`);
  }
  assert.ok(!closure.includes('src/CascadeShares.sol'), 'L4 mints and burns nothing');
  // the real bytecode: CALL (a removal, a move) and STATICCALL (the reads), SSTORE (its set) and LOG (its events),
  // and no DELEGATECALL (it links nothing) or TSTORE (the vault sets the unstake flag around its call)
  const ops = opcodesOf(ARTIFACTS.CascadeHotkeyLib.deployed);
  for (const [op, name] of [
    [0xf1, 'CALL'],
    [0xfa, 'STATICCALL'],
    [0x55, 'SSTORE'],
    [0xa2, 'LOG2'],
    [0xa3, 'LOG3'],
  ]) {
    assert.ok(ops.has(op), `the real L4 has no ${name}`);
  }
  assert.deepEqual(ARTIFACTS.CascadeHotkeyLib.deployedLinks, {});
  assert.deepEqual(bytecodeProblems(ARTIFACTS), []);
  for (const [op, name] of [
    ['5d', 'TSTORE, which STATE_OPCODES refuses it'],
    ['f4', 'DELEGATECALL'],
    ['f0', 'CREATE'],
    ['ff', 'SELFDESTRUCT'],
    ['f2', 'CALLCODE'],
  ]) {
    const a = clone();
    a.CascadeHotkeyLib.deployed = `${a.CascadeHotkeyLib.deployed.slice(0, 2)}${op}${a.CascadeHotkeyLib.deployed.slice(2)}`;
    assert.match(bytecodeProblems(a).join('\n'), new RegExp(`CascadeHotkeyLib's runtime code has ${name}`), name);
  }
  // what the real code needs stays allowed: SSTORE and LOG
  for (const op of ['55', 'a1', 'a4']) {
    const a = clone();
    a.CascadeHotkeyLib.deployed = `${a.CascadeHotkeyLib.deployed.slice(0, 2)}${op}${a.CascadeHotkeyLib.deployed.slice(2)}`;
    assert.deepEqual(bytecodeProblems(a), [], op);
  }
});

test('theRealHotkeyLibWritesExactlyItsSet', () => {
  // the real sources, with the vault in the same solc run: every write L4 runs is in its set (the list, isHotkey,
  // lastClaimAt; never the ledger, which the vault books from what remove returns), and each entry is needed
  const compiled = compileAsts(SRC, astRoots(REAL));
  assert.deepEqual(compiled.errors, []);
  assert.ok(compiled.units.has(VAULT));
  assert.deepEqual(writeSetProblems(compiled), []);
  // with no entry, each write fails at its line, named as the vault's storage it reaches
  const none = writeSetProblems(compiled, { writeSets: { [L4]: [] } });
  for (const [needle, what] of [
    ['hotkeys.push(h);', 'hotkeys'],
    ['isHotkey[h] = true;', 'isHotkey'],
    ['lastClaimAt[h] = uint64(block.timestamp);', 'lastClaimAt'],
    ['hotkeys[i] = hotkeys[last];', 'hotkeys'],
    ['hotkeys.pop();', 'hotkeys'],
    ['isHotkey[h] = false;', 'isHotkey'],
  ]) {
    const p = at(none, L4, lineOf(REAL.get(L4), needle));
    assert.equal(p.length, 1, `${needle}: ${none.join('\n')}`);
    assert.match(p[0], new RegExp(`: writes ${what} \\(.*\\) compiled into CascadeHotkeyLib, outside its write set \\(WRITE_SETS: nothing\\)$`));
  }
  assert.equal(none.length, 6, none.join('\n'));
  // each entry covers only itself
  const two = writeSetProblems(compiled, { writeSets: { [L4]: ['hotkeys', 'isHotkey'] } });
  assert.deepEqual(two.map((p) => p.replace(/:\d+:/, ':')), [
    `${L4}: writes lastClaimAt (lastClaimAt[h]) compiled into CascadeHotkeyLib, outside its write set (WRITE_SETS: hotkeys, isHotkey)`,
  ]);
  // the set is exact: an entry it never writes fails (the ledger's above all)
  assert.deepEqual(writeSetProblems(compiled, { writeSets: { [L4]: [...L4_SET, 'ledger.booked', 'stakeHotkey'] } }), [
    'WRITE_SETS lists ledger.booked for CascadeHotkeyLib, which it never writes: the set must be exactly what it writes',
    'WRITE_SETS lists stakeHotkey for CascadeHotkeyLib, which it never writes: the set must be exactly what it writes',
  ]);
  // L4 takes no ledger pointer at all: remove's storage parameters are the list and isHotkey
  const lib = compiled.units.get(L4).ast.nodes.find((n) => n.nodeType === 'ContractDefinition' && n.name === 'CascadeHotkeyLib');
  for (const fn of lib.nodes.filter((n) => n.nodeType === 'FunctionDefinition')) {
    for (const p of fn.parameters.parameters) assert.doesNotMatch(p.typeDescriptions.typeString, /Ledger/, `${fn.name}'s ${p.name}`);
  }
  // without the vault in solc's run, nothing binds L4's storage: the rule fails closed
  assert.match(
    writeSetProblems(compiled, { caller: 'src/NotThere.sol' }).join('\n'),
    /src\/NotThere\.sol: not in solc's output, so the write-set rule cannot read CascadeHotkeyLib's call sites/,
  );
});

test('aWriteOutsideL4sSetFailsTheWriteSetRule', () => {
  // The review's probe (fix round 1, I-1): remove given the ledger again, writing `ledger.booked += 1` itself and
  // booking through the shared helper; a private helper writing the reservation through its own parameter; and a
  // listing written into another mapping of the vault's because the vault binds add's isHotkey to it. Each is a
  // write outside L4's set (the list, isHotkey, lastClaimAt), refused at its line.
  const s = copy();
  replaceIn(s, L4, 'import {MAX_HOTKEYS, NETUID_ROOT, RAO} from "../CascadeConstants.sol";', 'import {MAX_HOTKEYS, NETUID_ROOT, RAO} from "../CascadeConstants.sol";\nimport {Ledger} from "../CascadeTypes.sol";');
  replaceIn(s, L4, '        bytes32 h,\n        bool forfeit,', '        Ledger storage ledger,\n        bytes32 h,\n        bool forfeit,');
  const direct = insertAfter(s, L4, L4_REMOVE, '        ledger.booked += 1;');
  insertAfter(s, L4, L4_REMOVED, '        CascadeLedger.applyWalk(ledger, receivedWei, debitRao);\n        _drain(ledger);');
  replaceIn(s, L4, '    function _move(', '    function _drain(Ledger storage l) private {\n        l.pending -= 1;\n    }\n\n    function _move(');
  replaceIn(s, VAULT, '            isHotkey,\n            h,\n            forfeit,', '            isHotkey,\n            ledger,\n            h,\n            forfeit,');
  replaceIn(s, VAULT, 'CascadeHotkeyLib.add(\n            hotkeys,\n            isHotkey,', 'CascadeHotkeyLib.add(\n            hotkeys,\n            processed,');
  const r = checkAll(s);
  assert.deepEqual(r.compiled.errors, [], 'every shape compiles');
  const outside = /compiled into CascadeHotkeyLib, outside its write set \(WRITE_SETS: hotkeys, isHotkey, lastClaimAt\)$/;
  for (const [path, line, what] of [
    [L4, direct, /: writes ledger\.booked \(ledger\.booked\) /],
    [LEDGER, lineOf(REAL.get(LEDGER), 'ledger.booked = '), /: writes ledger\.booked \(ledger\.booked\) /],
    [LEDGER, lineOf(REAL.get(LEDGER), 'ledger.ramping = '), /: writes ledger\.ramping \(ledger\.ramping\) /],
    [L4, lineOf(s.get(L4), 'l.pending -= 1;'), /: writes ledger\.pending \(l\.pending\) /],
    [L4, lineOf(s.get(L4), 'isHotkey[h] = true;'), /: writes processed \(isHotkey\[h\]\) /],
  ]) {
    const p = at(r.writes, path, line);
    assert.equal(p.length, 1, `${path}:${line}: ${r.writes.join('\n')}`);
    assert.match(p[0], what);
    assert.match(p[0], outside);
  }
  assert.equal(r.writes.length, 5, r.writes.join('\n'));
  // they are writes, not calls, assembly or a caller read: the other rules pass them
  assert.deepEqual([...r.source, ...r.calls, ...r.assembly], []);
});

test('aWriteTheRuleCannotTraceFailsClosed', () => {
  // a storage pointer local, a reassigned pointer, a storage argument to a function pointer, and a vault call site
  // passing a local pointer: the rule cannot name the storage they reach, so each fails
  const s = copy();
  insertAfter(s, L4, L4_REMOVED, '        bytes32[] storage l = hotkeys;\n        l.pop();');
  insertAfter(s, L4, L4_REMOVE, '        hotkeys = hotkeys;');
  insertAfter(
    s,
    L4,
    L4_REMOVE,
    '        function(bytes32[] storage, uint256, uint256, bytes32) internal view returns (bool) fp = _stakeMissing;\n        fp(hotkeys, 0, 0, coldkey);',
  );
  replaceIn(s, VAULT, '        bool byOwner = msg.sender == owner();\n', '        bool byOwner = msg.sender == owner();\n        bytes32[] storage l = hotkeys;\n');
  replaceIn(s, VAULT, 'CascadeHotkeyLib.remove(\n            hotkeys,', 'CascadeHotkeyLib.remove(\n            l,');
  const r = checkAll(s);
  assert.deepEqual(r.compiled.errors, [], 'every shape compiles');
  const local = lineOf(s.get(L4), 'bytes32[] storage l = hotkeys;');
  const reassigned = lineOf(s.get(L4), 'hotkeys = hotkeys;');
  const pointer = lineOf(s.get(L4), 'fp(hotkeys, 0, 0, coldkey);');
  assert.match(at(r.writes, L4, local).join('\n'), /a storage pointer local l compiled into CascadeHotkeyLib: the write-set rule traces parameters only/);
  assert.match(at(r.writes, L4, local + 1).join('\n'), /a storage write through l, not one of remove's parameters \(l\.pop\(\)\) compiled into CascadeHotkeyLib/);
  assert.match(at(r.writes, L4, reassigned).join('\n'), /reassigns the storage pointer hotkeys compiled into CascadeHotkeyLib: the write-set rule traces each pointer/);
  assert.match(at(r.writes, L4, pointer).join('\n'), /a storage argument to a call the rule cannot resolve \(fp\) compiled into CascadeHotkeyLib/);
  const site = lineOf(s.get(VAULT), '            l,\n            isHotkey,');
  assert.match(at(r.writes, VAULT, site).join('\n'), /passes CascadeHotkeyLib\.remove's hotkeys l, not a state variable by name: the write-set rule cannot name the storage it writes/);
  // so remove's writes through that parameter are bound to nothing, and fail too (the reassignment's included)
  for (const line of [reassigned, lineOf(s.get(L4), 'hotkeys[i] = hotkeys[last];'), lineOf(s.get(L4), '        hotkeys.pop();')]) {
    assert.match(at(r.writes, L4, line).join('\n'), /CascadeHotkeyLib\.remove writes through its hotkeys, which no call site binds to the caller's storage/, `${line}`);
  }
  assert.equal(r.writes.length, 8, r.writes.join('\n'));
});

test('assemblyInL4FailsTheRules', () => {
  // no assembly in L4, memory-only or not: the text rule and solc's AST both refuse it, at its line
  for (const [code, also] of [
    ['        assembly ("memory-safe") { mstore(0x40, mload(0x40)) }', null],
    ['        assembly { sstore(0, 1) }', /assembly touches storage \(sstore\)/],
    ['        assembly { tstore(0, 1) }', /assembly touches storage \(tstore\)/],
  ]) {
    const x = copy();
    const line = insertAfter(x, L4, L4_ADD, code);
    const r = checkAll(x);
    assert.deepEqual(r.compiled.errors, [], code);
    assert.match(at(r.assembly, L4, line).join('\n'), /assembly in CascadeHotkeyLib\.add, compiled into a linked library: no library may hold any \(R1-C F-1\)/, code);
    assert.match(at(r.source, L4, line).join('\n'), /assembly in library code \(no library may hold any, R1-C F-1\)/, code);
    if (also) assert.match(at(r.source, L4, line).join('\n'), also, code);
  }
});

test('aNonPrecompileCallInL4FailsTheCallRule', () => {
  // L4's only call target is the precompile: a low-level call, a transfer, an interface call on another address
  // and a value on the precompile's move each fail at their line; the reads and the move L4 makes pass
  const s = copy();
  const first = insertAfter(
    s,
    L4,
    L4_REMOVE,
    [
      '        (bool sent,) = address(1).call("");',
      '        payable(address(1)).transfer(sent ? 1 : 0);',
      '        IStaking(address(0x806)).getStake(h, coldkey, 0);',
      '        IStaking(ISTAKING_ADDRESS).moveStake{value: 1}(h, stakeHotkey, 0, 0, 1);',
    ].join('\n'),
  );
  const { problems, compiled } = checkCalls(s);
  assert.deepEqual(compiled.errors, [], 'every shape compiles');
  const scope = /in CascadeHotkeyLib, whose only call target is IStaking\(ISTAKING_ADDRESS\)$/;
  for (const [line, what] of [
    [first, /: external call: address\(1\)\.call\(…\), a low-level call in CascadeHotkeyLib/],
    [first + 1, /: external call: payable\(address\(1\)\)\.transfer\(…\), a value transfer in CascadeHotkeyLib/],
    [first + 2, /: external call: .*getStake\(…\), an external function on a cast solc does not resolve to the pinned declarations/],
  ]) {
    const p = at(problems, L4, line);
    assert.equal(p.length, 1, `${L4}:${line}: ${problems.join('\n')}`);
    assert.match(p[0], what);
    assert.match(p[0], scope);
  }
  assert.match(
    at(problems, L4, first + 3).join('\n'),
    /a call option \{value: …\} on IStaking\(ISTAKING_ADDRESS\)\.moveStake in CascadeHotkeyLib: no library call carries value to a cast target \(R1-C F-2\)/,
  );
  assert.equal(problems.length, 4, problems.join('\n'));
  // nor does L4 read the caller: the vault passes the roles
  const m = copy();
  const read = insertAfter(m, L4, L4_ADD, '        if (msg.sender == address(0)) revert ZeroHotkey();');
  assert.match(at(sourceProblems(m), L4, read).join('\n'), /msg\.sender in library code \(allowed only as L3's refund target\)/);
});
// ---- fix round 1: the precompile's functions, pinned per library (M-1), and no using-for library call (M-2) ----

test('thePrecompileFunctionsArePinnedPerLibrary', () => {
  // L2 and L4, the two libraries the call rule lets call the precompile, each call exactly their listed functions
  assert.deepEqual(PRECOMPILE_FUNCTIONS, {
    [L4]: ['getDefaultMinStake', 'getStake', 'getUnclaimedRootTaoByHotkey', 'moveStake', 'removeStake', 'removeStakeFull'],
    [L2]: ['getDefaultMinStake', 'getNominatorMinRequiredStake', 'getStake', 'removeStake', 'removeStakeFull'],
  });
  const compiled = compileAsts(SRC, astRoots(REAL));
  assert.deepEqual(compiled.errors, []);
  assert.deepEqual(precompileFunctionProblems(compiled), []);
  // each listed function is needed: dropped, its calls fail at their lines, in the library or a helper compiled in
  const noMove = precompileFunctionProblems(compiled, { precompileFunctions: { ...PRECOMPILE_FUNCTIONS, [L4]: PRECOMPILE_FUNCTIONS[L4].filter((f) => f !== 'moveStake') } });
  assert.deepEqual(noMove.map((p) => p.replace(/:\d+:/, ':')), [
    `${L4}: calls IStaking.moveStake (IStaking(ISTAKING_ADDRESS).moveStake(from, to, NETUID_ROOT, NET…) in CascadeHotkeyLib, which may call only getDefaultMinStake, getStake, getUnclaimedRootTaoByHotkey, removeStake, removeStakeFull of the precompile (PRECOMPILE_FUNCTIONS)`,
  ]);
  const noFloor = precompileFunctionProblems(compiled, { precompileFunctions: { ...PRECOMPILE_FUNCTIONS, [L2]: PRECOMPILE_FUNCTIONS[L2].filter((f) => f !== 'getNominatorMinRequiredStake') } });
  assert.equal(noFloor.length, 1, noFloor.join('\n'));
  assert.match(at(noFloor, FORMULAS, lineOf(REAL.get(FORMULAS), 'getNominatorMinRequiredStake{'))[0], /calls IStaking\.getNominatorMinRequiredStake .* in src\/libraries\/CascadeFormulas\.sol, compiled into CascadeStakeLib, which may call only/);
  // the list is exact: one never called fails (L4 never reads the nominator minimum: its closure holds the read, but
  // nothing L4 runs reaches it, so it is not compiled in)
  assert.deepEqual(precompileFunctionProblems(compiled, { precompileFunctions: { ...PRECOMPILE_FUNCTIONS, [L4]: [...PRECOMPILE_FUNCTIONS[L4], 'getNominatorMinRequiredStake', 'addStake'] } }), [
    'PRECOMPILE_FUNCTIONS lists getNominatorMinRequiredStake for CascadeHotkeyLib, which its code never calls: the list must be exactly what it calls',
    'PRECOMPILE_FUNCTIONS lists addStake for CascadeHotkeyLib, which its code never calls: the list must be exactly what it calls',
  ]);
  // a library the call rule lets call the precompile needs a list
  assert.match(
    precompileFunctionProblems(compiled, { precompileFunctions: { [L2]: PRECOMPILE_FUNCTIONS[L2] } }).join('\n'),
    /src\/libraries\/CascadeHotkeyLib\.sol: CALL_TARGETS lets CascadeHotkeyLib call the precompile, but PRECOMPILE_FUNCTIONS lists none of its functions/,
  );
});

test('L4CallingSetRejectStakingHotkeyGrowthIsRefused', () => {
  // The review's M-1: the cast admits every IStaking function, so the call rule alone let L4 (which strangers reach)
  // switch the vault's reject flag off, or L2 stake; the precompile rule refuses both at their lines. A forbidden call
  // in a shared helper counts only where it is compiled in: unreached, nothing; reached from L4, L4's problem alone.
  const s = copy();
  const flag = insertAfter(s, L4, L4_REMOVE, '        IStaking(ISTAKING_ADDRESS).setRejectStakingHotkeyGrowth(false);');
  replaceIn(s, L2, 'import {CascadeLedger} from "./CascadeLedger.sol";', 'import {CascadeLedger} from "./CascadeLedger.sol";\nimport {ISTAKING_ADDRESS, IStaking} from "../interfaces/IStaking.sol";');
  const stake = insertAfter(s, L2, 'unmetWei = wantWei;', '        IStaking(ISTAKING_ADDRESS).addStake(p.first, 1, 0);');
  replaceIn(s, LEDGER, '    function applyWalk(', '    function sneak(bytes32 h) internal {\n        IStaking(ISTAKING_ADDRESS).claimRootWithHotkey(h);\n    }\n\n    function unreached(bytes32 h) internal {\n        IStaking(ISTAKING_ADDRESS).addStake(h, 1, 0);\n    }\n\n    function applyWalk(');
  insertAfter(s, L4, '        if (rao != 0) _move(from, to, coldkey, rao);', '        CascadeLedger.sneak(from);');
  const r = checkAll(s);
  assert.deepEqual(r.compiled.errors, [], 'every shape compiles');
  assert.match(at(r.precompile, L4, flag).join('\n'), /calls IStaking\.setRejectStakingHotkeyGrowth \(.*\) in CascadeHotkeyLib, which may call only getDefaultMinStake, getStake, getUnclaimedRootTaoByHotkey, moveStake, removeStake, removeStakeFull of the precompile \(PRECOMPILE_FUNCTIONS\)$/);
  assert.match(at(r.precompile, L2, stake).join('\n'), /calls IStaking\.addStake \(.*\) in CascadeStakeLib, which may call only getDefaultMinStake, getNominatorMinRequiredStake, getStake, removeStake, removeStakeFull of the precompile/);
  const sneak = lineOf(s.get(LEDGER), 'claimRootWithHotkey(h);');
  assert.match(at(r.precompile, LEDGER, sneak).join('\n'), /calls IStaking\.claimRootWithHotkey \(.*\) in src\/libraries\/CascadeLedger\.sol, compiled into CascadeHotkeyLib, which may call only/);
  assert.equal(at(r.precompile, LEDGER, sneak).length, 1, 'L2 does not reach it');
  assert.deepEqual(at(r.precompile, LEDGER, lineOf(s.get(LEDGER), 'addStake(h, 1, 0);')), [], 'no library reaches it');
  assert.equal(r.precompile.length, 3, r.precompile.join('\n'));
  // the call rule passes them all (each is a call on the pinned cast): the precompile rule is what refuses them
  assert.deepEqual(r.calls, []);
});

test('aUsingForCallIntoALinkedLibraryIsRefused', () => {
  // The review's M-2: through `using CascadeHotkeyLib for bytes32[]` the receiver is add's first parameter, so the
  // write-set rule read the arguments one place off. Any such call into a linked library is refused, at its line.
  const s = copy();
  replaceIn(s, VAULT, 'contract CascadeVault is CascadeShares, CascadeBase, ICascadeReceiver {', 'contract CascadeVault is CascadeShares, CascadeBase, ICascadeReceiver {\n    using CascadeHotkeyLib for bytes32[];\n');
  replaceIn(s, VAULT, 'CascadeHotkeyLib.add(\n            hotkeys,\n            isHotkey,', 'hotkeys.add(\n            isHotkey,');
  const r = checkAll(s);
  assert.deepEqual(r.compiled.errors, [], 'the shape compiles');
  const site = lineOf(s.get(VAULT), 'hotkeys.add(');
  assert.deepEqual(r.bound.map((p) => p.replace(/\(hotkeys\.add.*\): /, '(…): ')), [
    `${VAULT}:${site}: calls the linked library function CascadeHotkeyLib.add through using-for (…): the library rules read a linked library's arguments only on a direct call (CascadeHotkeyLib.add(…)), so this form is refused`,
  ]);
  assert.deepEqual(r.writes, [
    `${VAULT}:${site}: calls CascadeHotkeyLib.add through using-for (hotkeys.add): the write-set rule binds its storage only on a direct call (CascadeHotkeyLib.add(…))`,
  ]);
  // the real sources make no such call
  assert.deepEqual(boundCallProblems(compileAsts(SRC, astRoots(REAL))), []);
});
test('F4_aFunctionInheritedByTheStakingInterfaceIsRefused', () => {
  // The re-review's F4 (fix round 2): `interface IStaking is IStakingAdmin`, a function declared in the parent and
  // called from L4 on the pinned cast. Every rule accepted it, since the lists name only IStaking's own
  // declarations. Now the interface may inherit nothing, and a call on it to a function it does not declare itself
  // is refused, each at its line.
  const s = copy();
  replaceIn(
    s,
    HOME,
    'interface IStaking {',
    'interface IStakingAdmin {\n    function setRejectStakingHotkeyGrowthAdmin(bool enabled) external;\n}\n\ninterface IStaking is IStakingAdmin {',
  );
  const call = insertAfter(s, L4, L4_REMOVE, '        IStaking(ISTAKING_ADDRESS).setRejectStakingHotkeyGrowthAdmin(false);');
  const r = checkAll(s);
  assert.deepEqual(r.compiled.errors, [], 'the shape compiles');
  const declared = lineOf(s.get(HOME), 'interface IStaking is IStakingAdmin {');
  assert.deepEqual(at(r.precompile, HOME, declared), [
    `${HOME}:${declared}: interface IStaking inherits IStakingAdmin: the precompile rule pins only the functions IStaking declares itself, so the staking interface may inherit nothing`,
  ]);
  assert.match(
    at(r.precompile, L4, call).join('\n'),
    /calls setRejectStakingHotkeyGrowthAdmin on the staking interface \(.*\) in CascadeHotkeyLib, a function IStaking does not declare itself: the precompile rule refuses it$/,
  );
  assert.equal(r.precompile.length, 2, r.precompile.join('\n'));
  // the other rules let it through (a call on the pinned cast, no write, no assembly): the precompile rule is the guard
  assert.deepEqual([...r.source, ...r.calls, ...r.assembly, ...r.writes, ...r.bound], []);
  // the real interface inherits nothing, and the real build passes
  const real = compileAsts(SRC, astRoots(REAL));
  const iface = real.units.get(HOME).ast.nodes.find((n) => n.nodeType === 'ContractDefinition' && n.name === 'IStaking');
  assert.deepEqual(iface.baseContracts, []);
  assert.deepEqual(precompileFunctionProblems(real), []);
});

// ---- Task 42a: the Yul call rule (the 5f carry: OpenZeppelin's Math.modExp) ----

const L2_BODY = 'unmetWei = wantWei;';
const FORMULAS_OPEN = 'library CascadeFormulas {';

test('theRealLibrariesReachNoYulCall', () => {
  // OpenZeppelin's Math is in every closure, and its tryModExp holds a STATICCALL to the 0x05 precompile in assembly,
  // which the assembly rule does not read (vendored): no linked library reaches it
  assert.deepEqual(YUL_CALLS, ['call', 'callcode', 'create', 'create2', 'delegatecall', 'selfdestruct', 'staticcall']);
  const compiled = compileAsts(SRC, astRoots(REAL));
  assert.deepEqual(compiled.errors, []);
  const ozMath = 'lib/openzeppelin-contracts/contracts/utils/math/Math.sol';
  assert.ok(compiled.units.has(ozMath));
  assert.match(compiled.units.get(ozMath).bytes.toString('utf8'), /success := staticcall\(gas\(\), 0x05,/);
  assert.deepEqual(yulCallProblems(compiled, { roots: libraryRoots(REAL) }), []);
  // the default roots are every linked library in the run
  assert.deepEqual(yulCallProblems(compiled), []);
});

test('aLibraryReachingMathModExpFailsTheYulCallRule', () => {
  // The 5f carry's shape: OpenZeppelin's Math.modExp (its tryModExp: `staticcall(gas(), 0x05, …)` in assembly) reached
  // from L2 directly, from L4 through a first-party helper (CascadeFormulas), and from L1 through the same helper taken
  // as an internal function value (Math.modExp itself is overloaded, so no typed pointer names it). Each is refused
  // where first-party code reaches it, named for the library it is compiled into; a helper that references it but is
  // never reached is not compiled in and passes. The other AST rules let all of it through (an internal call into
  // vendored code that holds no first-party assembly): the Yul call rule is the guard.
  const s = copy();
  const direct = insertAfter(s, L2, L2_BODY, '        unmetWei += Math.modExp(2, 3, 5);');
  replaceIn(
    s,
    FORMULAS,
    FORMULAS_OPEN,
    `${FORMULAS_OPEN}\n    function powMod(uint256 b) internal view returns (uint256) {\n        return Math.modExp(b, 3, 5);\n    }\n\n    function unreachedPowMod(uint256 b) internal view returns (uint256) {\n        return Math.modExp(b, 7, 5);\n    }\n`,
  );
  insertAfter(s, L4, L4_REMOVE, '        leftover += CascadeFormulas.powMod(leftover) * 0;');
  insertAfter(
    s,
    L1,
    L1_BODY,
    '        function(uint256) view returns (uint256) pow = CascadeFormulas.powMod;\n        if (pow(2) == 7) revert AmountMismatch();',
  );
  const r = checkAll(s);
  assert.deepEqual(r.compiled.errors, [], 'every shape compiles');
  const helper = lineOf(s.get(FORMULAS), 'return Math.modExp(b, 3, 5);');
  const unreached = lineOf(s.get(FORMULAS), 'return Math.modExp(b, 7, 5);');
  assert.match(
    at(r.yul, L2, direct).join('\n'),
    /CascadeStakeLib compiles in Math\.tryModExp \(lib\/openzeppelin-contracts\/contracts\/utils\/math\/Math\.sol:\d+\), whose assembly makes a staticcall/,
  );
  assert.match(at(r.yul, FORMULAS, helper).join('\n'), /CascadeHotkeyLib compiles in Math\.tryModExp .*whose assembly makes a staticcall/);
  assert.match(at(r.yul, FORMULAS, helper).join('\n'), /CascadeBatchLib compiles in Math\.tryModExp .*whose assembly makes a staticcall/, 'the value reaches it');
  assert.equal(at(r.yul, FORMULAS, helper).length, 2, 'one problem per library it is compiled into');
  assert.deepEqual(at(r.yul, FORMULAS, unreached), [], 'an unreached reference is not compiled in');
  assert.equal(r.yul.length, 3, r.yul.join('\n'));
  // the other AST rules pass them all: an internal call, vendored assembly, no precompile function, no write
  assert.deepEqual([...r.calls, ...r.assembly, ...r.writes, ...r.precompile, ...r.bound, ...r.delegatecall], []);
});

test('everyYulCallOrCreationReachedFromALibraryIsRefused', () => {
  // A vendored helper (src/vendor, which the assembly rule skips) whose functions each hold one of the builtins, each
  // reached from L2: one problem per builtin, at L2's call, naming it.
  const s = copy();
  const evil = 'src/vendor/EvilYul.sol';
  const bodies = {
    call: 'pop(call(gas(), 1, 0, 0, 0, 0, 0))',
    callcode: 'pop(callcode(gas(), 1, 0, 0, 0, 0, 0))',
    create: 'pop(create(0, 0, 0))',
    create2: 'pop(create2(0, 0, 0, 0))',
    delegatecall: 'pop(delegatecall(gas(), 1, 0, 0, 0, 0))',
    selfdestruct: 'selfdestruct(0)',
    staticcall: 'pop(staticcall(gas(), 1, 0, 0, 0, 0))',
  };
  s.set(
    evil,
    [
      '// SPDX-License-Identifier: MIT',
      'pragma solidity 0.8.38;',
      '',
      'library EvilYul {',
      ...Object.entries(bodies).map(([name, body]) => `    function do_${name}() internal {\n        assembly {\n            ${body}\n        }\n    }\n`),
      '}',
      '',
    ].join('\n'),
  );
  replaceIn(s, L2, 'import {CascadeLedger} from "./CascadeLedger.sol";', 'import {CascadeLedger} from "./CascadeLedger.sol";\nimport {EvilYul} from "../vendor/EvilYul.sol";');
  for (const name of Object.keys(bodies)) insertAfter(s, L2, L2_BODY, `        EvilYul.do_${name}();`);
  const r = checkAll(s);
  assert.deepEqual(r.compiled.errors, [], 'every builtin compiles');
  for (const name of Object.keys(bodies)) {
    const line = lineOf(s.get(L2), `EvilYul.do_${name}();`);
    assert.match(at(r.yul, L2, line).join('\n'), new RegExp(`CascadeStakeLib compiles in EvilYul\\.do_${name} \\(src/vendor/EvilYul\\.sol:\\d+\\), whose assembly makes a ${name}`), name);
  }
  assert.equal(r.yul.length, 7, r.yul.join('\n'));
  // the assembly rule does not read src/vendor: the Yul call rule is what refuses these
  assert.deepEqual(r.assembly, []);
});

test('theYulCallRuleFailsClosedWhenItsClosureDoesNotCompile', () => {
  const s = copy();
  insertAfter(s, L2, L2_BODY, '        unmetWei = Math.noSuchFunction(1);');
  const r = checkAll(s);
  assert.ok(r.compiled.errors.length > 0);
  assert.match(r.yul.join('\n'), /does not compile, so the Yul call rule cannot read solc's AST/);
  assert.match(r.delegatecall.join('\n'), /does not compile, so the delegatecall rule cannot read solc's AST/);
});

// ---- Task 42a: the delegatecall rule (the 5e review's minor 5) ----

const DOOR = 'src/CascadeFrontDoor.sol';
const DOOR_OPEN = 'contract CascadeFrontDoor is CascadeBase, ICascadeReceiver {';
const VAULT_OPEN = 'contract CascadeVault is CascadeShares, CascadeBase, ICascadeReceiver {';
const MULTICALL_OPEN = 'contract CascadeVault is CascadeShares, CascadeBase, ICascadeReceiver, Multicall {';

test('theRealSourcesAndBuildPassTheDelegatecallRule', () => {
  assert.deepEqual(delegatecallSourceProblems(REAL), []);
  const compiled = compileAsts(SRC, astRoots(REAL));
  assert.deepEqual(compiled.errors, []);
  assert.deepEqual(delegatecallAstProblems(compiled), []);
  assert.deepEqual(delegatecallBytecodeProblems(ARTIFACTS), []);
  // the rule reads the vault's real DELEGATECALLs: with no library linked, each of its library calls fails
  const unlinked = delegatecallAstProblems(compiled, { graph: { ...LINK_GRAPH, CascadeVault: [] } });
  for (const [lib, fn] of [
    ['CascadeBatchLib', 'deliver'],
    ['CascadeHotkeyLib', 'add'],
    ['CascadeHotkeyLib', 'move'],
    ['CascadeHotkeyLib', 'remove'],
    ['CascadePayoutLib', 'prepare'],
    ['CascadePayoutLib', 'finish'],
    ['CascadePayoutLib', 'cancel'],
    ['CascadeStakeLib', 'unstake'],
  ]) {
    assert.match(unlinked.join('\n'), new RegExp(`CascadeVault DELEGATECALLs ${lib}\\.${fn}, a library LINK_GRAPH does not say it links`), `${lib}.${fn}`);
  }
  // the constructor's add and addHotkey's, moveStake's, removeHotkey's, the delivery, the walk, the two payout halves
  // and the cancel
  assert.equal(unlinked.length, 9, unlinked.join('\n'));
  // and the bytecode: the vault's runtime code has DELEGATECALL, which only its links allow
  assert.deepEqual(delegatecallBytecodeProblems(ARTIFACTS, { ...LINK_GRAPH, CascadeVault: [] }), [
    "CascadeVault's runtime code has DELEGATECALL, but LINK_GRAPH says it links no library: no other DELEGATECALL is allowed in src/",
    // fix round 1: and its constructor's (it lists its first hotkey through L4's add)
    "CascadeVault's creation code has DELEGATECALL, but LINK_GRAPH says it links no library: no other DELEGATECALL is allowed in src/",
  ]);
});

test('aDelegatecallInAnyFirstPartyFileFailsTheDelegatecallRule', () => {
  // On the text of every first-party file, contracts included: Solidity's low-level delegatecall and callcode in Yul,
  // in the front door (which the AST run does not compile), an adapter and the vault; a comment or a string is not
  // code. The library source rules read only library code, so they miss the contracts' (the delegatecall rule is the
  // guard there).
  const s = copy();
  const door = insertAfter(s, DOOR, DOOR_OPEN, '    function sneak(address t) external { (bool ok,) = t.delegatecall(""); ok; }');
  const adapter = 'src/adapters/CcipBittensorAdapter.sol';
  const yul = insertAfter(s, adapter, 'contract CcipBittensorAdapter', '    function sneak() external { assembly { pop(callcode(gas(), 1, 0, 0, 0, 0, 0)) } }');
  insertAfter(s, VAULT, VAULT_OPEN, '    function sneak(address t) external onlyOwner { (bool ok,) = t.delegatecall(""); ok; }');
  insertAfter(s, VAULT, VAULT_OPEN, '    // a delegatecall in a comment, and "delegatecall" in a string, are not code');
  const vault = lineOf(s.get(VAULT), 't.delegatecall("")');
  const p = delegatecallSourceProblems(s);
  assert.match(at(p, DOOR, door).join('\n'), /delegatecall in src\/ code: the vault's only DELEGATECALLs are to its linked libraries \(I-32\), and nothing in src\/ makes one itself/);
  assert.match(at(p, adapter, yul).join('\n'), /callcode in src\/ code/);
  assert.equal(at(p, VAULT, vault).length, 1, p.join('\n'));
  assert.equal(p.length, 3, p.join('\n'));
  assert.deepEqual(sourceProblems(s), [], 'the library source rules read only library code');
});

test('aVendoredDelegatecallTheVaultReachesFailsTheDelegatecallRule', () => {
  // On solc's AST, what the text cannot see: vendored code compiled into the vault. OpenZeppelin's
  // Address.functionDelegateCall called from the vault, OpenZeppelin's Multicall inherited, and a DELEGATECALL into a
  // library the link graph does not say the vault links. Each fails at the vault's line; the text rule passes all of
  // them (no `delegatecall` token in first-party code).
  const s = copy();
  replaceIn(
    s,
    VAULT,
    'import {CascadeBase} from "./CascadeBase.sol";',
    'import {CascadeBase} from "./CascadeBase.sol";\nimport {Address} from "@openzeppelin/contracts/utils/Address.sol";\nimport {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";\nimport {CascadeSneakLib} from "./libraries/CascadeSneakLib.sol";',
  );
  replaceIn(s, VAULT, VAULT_OPEN, MULTICALL_OPEN);
  insertAfter(s, VAULT, MULTICALL_OPEN, '    function sneak(address t, bytes calldata d) external onlyOwner { Address.functionDelegateCall(t, d); }');
  insertAfter(s, VAULT, MULTICALL_OPEN, '    function sneakLib() external onlyOwner { CascadeSneakLib.f(); }');
  s.set('src/libraries/CascadeSneakLib.sol', '// SPDX-License-Identifier: MIT\npragma solidity 0.8.38;\n\nlibrary CascadeSneakLib {\n    function f() external {}\n}\n');
  const r = checkAll(s);
  assert.deepEqual(r.compiled.errors, [], 'every shape compiles');
  const inherits = lineOf(s.get(VAULT), MULTICALL_OPEN);
  const call = lineOf(s.get(VAULT), 'Address.functionDelegateCall(t, d);');
  assert.match(at(r.delegatecall, VAULT, call).join('\n'), /CascadeVault compiles in Address\.functionDelegateCall \(lib\/openzeppelin-contracts\/contracts\/utils\/Address\.sol:\d+\), which makes a low-level delegatecall/);
  assert.match(at(r.delegatecall, VAULT, inherits).join('\n'), /CascadeVault compiles in Address\.functionDelegateCall .*which makes a low-level delegatecall/, 'Multicall, inherited');
  assert.match(at(r.delegatecall, VAULT, lineOf(s.get(VAULT), 'CascadeSneakLib.f();')).join('\n'), /CascadeVault DELEGATECALLs CascadeSneakLib\.f, a library LINK_GRAPH does not say it links/);
  assert.equal(r.delegatecall.length, 3, r.delegatecall.join('\n'));
  assert.deepEqual(r.delegatecallText, [], 'no delegatecall token in first-party code');
});

test('assemblyDelegatecallInTheVaultFailsBothLayers', () => {
  const s = copy();
  const line = insertAfter(s, VAULT, VAULT_OPEN, '    function sneak(address t) external onlyOwner { assembly { pop(delegatecall(gas(), t, 0, 0, 0, 0)) } }');
  const r = checkAll(s);
  assert.deepEqual(r.compiled.errors, []);
  assert.match(at(r.delegatecallText, VAULT, line).join('\n'), /delegatecall in src\/ code/);
  assert.match(at(r.delegatecall, VAULT, line).join('\n'), /CascadeVault compiles in CascadeVault\.sneak \(src\/CascadeVault\.sol:\d+\), whose assembly makes a delegatecall/);
});

test('theBytecodeBackstopRefusesADelegatecallInAnyArtifactThatLinksNothing', () => {
  // DELEGATECALL in the front door, a lens, an adapter, the staker or a library that links nothing, CALLCODE anywhere,
  // the vault included: each refused; the vault's own DELEGATECALLs are its links'
  for (const [name, op, what] of [
    ['CascadeFrontDoor', 'f4', 'DELEGATECALL'],
    ['CascadeVaultLens', 'f4', 'DELEGATECALL'],
    ['CcipBittensorAdapter', 'f4', 'DELEGATECALL'],
    ['CascadeStaker', 'f4', 'DELEGATECALL'],
    ['CascadeHotkeyLib', 'f4', 'DELEGATECALL'],
    ['CascadeVault', 'f2', 'CALLCODE'],
    ['CascadePayoutLib', 'f2', 'CALLCODE'],
  ]) {
    const a = clone();
    assert.ok(a[name], `${name} is in the build`);
    // in the runtime code and in the runtime the creation code holds, as a rebuild would have it
    const runtime = a[name].deployed.replace(/^0x/, '');
    a[name].creation = a[name].creation.replace(runtime, `${op}${runtime}`);
    a[name].deployed = `0x${op}${runtime}`;
    const p = delegatecallBytecodeProblems(a);
    assert.equal(p.length, 1, `${name}: ${p.join('\n')}`);
    assert.match(p[0], new RegExp(`^${name}'s runtime code has ${what}`), name);
  }
});

// ---- Task 42a: every library function has its direct-call test, from the build ----

const BOUNDARY = 'test/libraries/LibraryBoundary.t.sol';
const GUARD_TEST = 'test_everyNonViewLibraryFunctionStopsAtTheCallGuard';

/** A copy of `tests` with `from` replaced by `to` in `path`. */
function testsWith(tests, path, from, to) {
  const t = new Map(tests);
  assert.ok(t.get(path)?.includes(from), `${from} is not in ${path}`);
  t.set(path, t.get(path).replace(from, to));
  return t;
}

test('everyLibraryFunctionInTheBuildHasItsDirectCallTest', () => {
  // the real build and the real tests: 11 functions (L1 1, L2 1, L3 3, L4 3, the payout math 3), each covered
  const tests = loadTests();
  assert.ok(tests.has(BOUNDARY), 'LibraryBoundary.t.sol is read');
  assert.deepEqual(boundaryCoverageProblems(ARTIFACTS, tests), []);
  assert.deepEqual(Object.keys(BOUNDARY_TESTS).sort(), [...new Set(Object.values(LINK_GRAPH).flat())].sort());
  for (const [lib, fns] of Object.entries(BOUNDARY_TESTS)) {
    const built = Object.keys(ARTIFACTS[lib].methodIdentifiers).map((s) => s.slice(0, s.indexOf('('))).sort();
    assert.deepEqual(Object.keys(fns).sort(), built, lib);
    assert.deepEqual(ARTIFACTS[lib].functions.map((f) => f.name).sort(), built, `${lib}'s AST declares the same`);
  }
  // why the list is methodIdentifiers and the AST: solc's JSON ABI lists only a library's view and pure functions
  for (const lib of ['CascadeBatchLib', 'CascadeStakeLib', 'CascadePayoutLib', 'CascadeHotkeyLib']) {
    assert.deepEqual(ARTIFACTS[lib].abi.filter((e) => e.type === 'function'), [], `${lib}'s ABI lists no function`);
  }
  assert.deepEqual(ARTIFACTS.CascadePayoutMath.abi.filter((e) => e.type === 'function').map((e) => e.name).sort(), ['deductFee', 'takeChunk', 'verify']);
});

test('aLibraryFunctionWithNoDirectCallTestFailsTheCoverage', () => {
  // The build is the list: a function added to L4 (sweep, non-view: in methodIdentifiers and its AST, never its ABI)
  // fails until BOUNDARY_TESTS covers it
  const tests = loadTests();
  const a = clone();
  a.CascadeHotkeyLib.methodIdentifiers['sweep()'] = '12345678';
  a.CascadeHotkeyLib.functions.push({ name: 'sweep', selector: '12345678', stateMutability: 'nonpayable' });
  assert.deepEqual(boundaryCoverageProblems(a, tests), [
    'CascadeHotkeyLib.sweep (0x12345678, nonpayable) is in the build but BOUNDARY_TESTS names no direct-call test for it: every library function is called directly by a test (spec §9.1)',
  ]);
  // so does a pure one added to the payout math
  const m = clone();
  m.CascadePayoutMath.methodIdentifiers['peek()'] = '87654321';
  m.CascadePayoutMath.functions.push({ name: 'peek', selector: '87654321', stateMutability: 'pure' });
  assert.match(boundaryCoverageProblems(m, tests).join('\n'), /CascadePayoutMath\.peek \(0x87654321, pure\) is in the build but BOUNDARY_TESTS names no direct-call test/);
  // an entry the build does not have
  const extra = { ...BOUNDARY_TESTS, CascadeStakeLib: { ...BOUNDARY_TESTS.CascadeStakeLib, walk: { kind: 'guarded', test: `LibraryBoundary.t.sol:${GUARD_TEST}` } } };
  assert.deepEqual(boundaryCoverageProblems(ARTIFACTS, tests, { coverage: extra }), [
    'BOUNDARY_TESTS covers CascadeStakeLib.walk, which is not a function of it in the build',
  ]);
  // a linked library with no entry at all
  const { CascadePayoutMath: _math, ...noMath } = BOUNDARY_TESTS;
  assert.deepEqual(boundaryCoverageProblems(ARTIFACTS, tests, { coverage: noMath }), [
    'CascadePayoutMath is linked but BOUNDARY_TESTS covers none of its functions',
  ]);
  // two functions of one name (an overload) cannot be told apart by name: refused
  const o = clone();
  o.CascadeStakeLib.methodIdentifiers['unstake()'] = 'aaaaaaaa';
  o.CascadeStakeLib.functions.push({ name: 'unstake', selector: 'aaaaaaaa', stateMutability: 'nonpayable' });
  assert.match(boundaryCoverageProblems(o, tests).join('\n'), /CascadeStakeLib has 2 functions named unstake: BOUNDARY_TESTS names each function once, so overloads are refused/);
  // fail closed on a build the rule cannot read: a selector no declaration has (no AST, so no kind), and a declaration
  // methodIdentifiers does not list
  const noAst = clone();
  noAst.CascadeHotkeyLib.functions = [];
  const p = boundaryCoverageProblems(noAst, tests);
  assert.match(p.join('\n'), /CascadeHotkeyLib\.add\(bytes32\[\] storage,.*\(0x46fcfa27\) is in methodIdentifiers but no external or public function of its AST has that selector/);
  // each of L4's three unread, and so not found, so each entry names a function the build does not have
  assert.equal(p.length, 6, p.join('\n'));
  const unlisted = clone();
  delete unlisted.CascadeStakeLib.methodIdentifiers['unstake(WalkParams,uint256)'];
  assert.match(boundaryCoverageProblems(unlisted, tests).join('\n'), /CascadeStakeLib\.unstake \(0x5086fc13\) is an external or public function of its AST that methodIdentifiers does not list/);
});

test('aDirectCallTestOfTheWrongKindOrMissingFailsTheCoverage', () => {
  const tests = loadTests();
  // the kind is the build's: verify turned non-view must be tested at the call guard, and deliver turned view with value
  const k = clone();
  k.CascadePayoutMath.functions.find((f) => f.name === 'verify').stateMutability = 'nonpayable';
  k.CascadeBatchLib.functions.find((f) => f.name === 'deliver').stateMutability = 'view';
  const kinds = boundaryCoverageProblems(k, tests);
  assert.match(kinds.join('\n'), /CascadePayoutMath\.verify is nonpayable in the build, but BOUNDARY_TESTS tests it as view/);
  assert.match(kinds.join('\n'), /CascadeBatchLib\.deliver is view in the build, but BOUNDARY_TESTS tests it as guarded/);
  assert.equal(kinds.length, 2, kinds.join('\n'));
  // the test must exist, be a test, and name the function's selector in its own body
  const noSelector = testsWith(tests, BOUNDARY, 'CascadeHotkeyLib.move.selector', 'CascadeHotkeyLib.add.selector');
  assert.deepEqual(boundaryCoverageProblems(ARTIFACTS, noSelector), [
    `BOUNDARY_TESTS says ${BOUNDARY}:${GUARD_TEST} calls CascadeHotkeyLib.move directly, but its body never names CascadeHotkeyLib.move.selector`,
  ]);
  const renamed = testsWith(tests, BOUNDARY, `function ${GUARD_TEST}(`, `function x${GUARD_TEST}(`);
  assert.match(boundaryCoverageProblems(ARTIFACTS, renamed).join('\n'), new RegExp(`${BOUNDARY}:${GUARD_TEST}, which BOUNDARY_TESTS names for CascadeBatchLib\\.deliver, is not a function there`));
  const helper = { ...BOUNDARY_TESTS, CascadeStakeLib: { unstake: { kind: 'guarded', test: 'LibraryBoundary.t.sol:assertGuarded' } } };
  assert.match(boundaryCoverageProblems(ARTIFACTS, tests, { coverage: helper }).join('\n'), /assertGuarded, which BOUNDARY_TESTS names for CascadeStakeLib\.unstake, is not a test \(test_…\): forge never runs it/);
  const elsewhere = { ...BOUNDARY_TESTS, CascadeStakeLib: { unstake: { kind: 'guarded', test: 'Missing.t.sol:test_x' } } };
  assert.match(boundaryCoverageProblems(ARTIFACTS, tests, { coverage: elsewhere }).join('\n'), /test\/libraries\/Missing\.t\.sol, which BOUNDARY_TESTS names for CascadeStakeLib\.unstake, is not in test\/libraries/);
  // a selector named only in a comment does not count
  const commented = testsWith(tests, BOUNDARY, 'CascadeHotkeyLib.move.selector', 'CascadeHotkeyLib.add.selector /* CascadeHotkeyLib.move.selector */');
  assert.match(boundaryCoverageProblems(ARTIFACTS, commented).join('\n'), /never names CascadeHotkeyLib\.move\.selector/);
});

// ---- Task 42a fix round 1 ----

/** `hex` with `bytes` (hex, no 0x) put in at byte `at` (0 first, -1 the end). */
const plant = (hex, bytes, at) => {
  const h = hex.replace(/^0x/, '');
  const i = at < 0 ? h.length : 2 * at;
  return `0x${h.slice(0, i)}${bytes}${h.slice(i)}`;
};

test('I1_aDelegatecallInCreationCodeOnlyIsRefused', () => {
  // The review's Important 1: code only a constructor runs is in the creation code, not the runtime code, so a
  // constructor-only DELEGATECALL in a contract that links nothing passed the bytecode layer. Creation code is the init
  // code, then the runtime code verbatim (its CBOR metadata at its end), then any data: the rule reads the init code
  // and the data as code and the runtime as runtime (its metadata skipped).
  for (const name of Object.keys(ARTIFACTS)) {
    const a = ARTIFACTS[name];
    if (!a.path.startsWith('src/') || a.path.startsWith('src/vendor/') || a.creation === '0x') continue;
    assert.ok(a.creation.includes(a.deployed.replace(/^0x/, '')), `${name}'s creation code holds its runtime code`);
  }
  // DELEGATECALL in the init code (as a constructor's call would be) or where the data after the runtime begins, of an
  // artifact that links nothing; CALLCODE in the init code of any, the vault's included: each refused, the runtime
  // untouched. ('tail': the first byte after the runtime; the front door's data is a 32-byte constant, which a linear
  // sweep reads as code too, so a byte appended after it could sit inside a PUSH's data.)
  for (const [name, op, at, what] of [
    ['CascadeFrontDoor', 'f4', 0, 'DELEGATECALL'],
    ['CascadeVaultLens', 'f4', 0, 'DELEGATECALL'],
    ['CascadeStaker', 'f4', 0, 'DELEGATECALL'],
    ['CcipBaseAdapter', 'f4', 0, 'DELEGATECALL'],
    ['CascadeHotkeyLib', 'f4', 0, 'DELEGATECALL'],
    ['CascadeFrontDoor', 'f4', 'tail', 'DELEGATECALL'],
    ['CascadeVault', 'f2', 0, 'CALLCODE'],
    ['CascadePayoutLib', 'f2', 0, 'CALLCODE'],
  ]) {
    const a = clone();
    const runtime = a[name].deployed.replace(/^0x/, '');
    const tail = (a[name].creation.indexOf(runtime) - 2 + runtime.length) / 2;
    a[name].creation = plant(a[name].creation, op, at === 'tail' ? tail : at);
    const p = delegatecallBytecodeProblems(a);
    assert.equal(p.length, 1, `${name}: ${p.join('\n')}`);
    assert.match(p[0], new RegExp(`^${name}'s creation code has ${what}`), name);
  }
  // the vault's own constructor DELEGATECALLs (L4's add): its links allow it, there as in its runtime
  const v = clone();
  v.CascadeVault.creation = plant(v.CascadeVault.creation, 'f4', 0);
  assert.deepEqual(delegatecallBytecodeProblems(v), []);
  // the embedded runtime's metadata is not read as code: an f4 inside its CBOR, in the runtime and the creation code
  // alike (as a rebuild's new hash could hold), is no opcode
  const m = clone();
  const runtime = m.CascadeFrontDoor.deployed.replace(/^0x/, '');
  const cbor = runtime.lastIndexOf('a264697066735822');
  assert.ok(cbor > 0, 'the front door runtime ends with its CBOR metadata');
  const changed = `${runtime.slice(0, cbor + 20)}f4f2${runtime.slice(cbor + 24)}`;
  m.CascadeFrontDoor.creation = m.CascadeFrontDoor.creation.replace(runtime, changed);
  m.CascadeFrontDoor.deployed = `0x${changed}`;
  assert.deepEqual(delegatecallBytecodeProblems(m), []);
  // creation code that does not hold its runtime verbatim cannot be split: refused, not guessed
  const n = clone();
  n.CascadeFrontDoor.creation = n.CascadeFrontDoor.creation.replace(runtime.slice(0, 40), '00'.repeat(20));
  assert.match(delegatecallBytecodeProblems(n).join('\n'), /CascadeFrontDoor's creation code does not hold its runtime code verbatim/);
  // and the real build passes
  assert.deepEqual(delegatecallBytecodeProblems(ARTIFACTS), []);
});

test('T42_aChildsCreationCodeInTheDataFailsClosed', () => {
  // the Task 42a re-review's Minor: a constructor that creates another contract embeds the child's creation code in
  // the data after its runtime, which the sweep reads as this artifact's code (initOpcodesOf's note). A child with no
  // DELEGATECALL of its own (the vault lens's creation code) appended to the front door's: the rule still reads the
  // front door's code alone as code it may refuse, never throws, and refuses nothing but the front door's creation code.
  const a = clone();
  const child = a.CascadeVaultLens.creation.replace(/^0x/, '');
  a.CascadeFrontDoor.creation = `${a.CascadeFrontDoor.creation}${child}`;
  const p = delegatecallBytecodeProblems(a);
  for (const line of p) assert.match(line, /^CascadeFrontDoor's creation code has /, line);
  // and a DELEGATECALL in the data, as the child's own code would hold one (planted where the data begins, as the
  // I1 probe plants it), with the child after it: refused as the front door's, which links nothing (fail closed)
  const b = clone();
  const runtime = b.CascadeFrontDoor.deployed.replace(/^0x/, '');
  const tail = (b.CascadeFrontDoor.creation.indexOf(runtime) - 2 + runtime.length) / 2;
  b.CascadeFrontDoor.creation = `${plant(b.CascadeFrontDoor.creation, 'f4', tail)}${child}`;
  assert.match(delegatecallBytecodeProblems(b).join('\n'), /CascadeFrontDoor's creation code has DELEGATECALL/);
});

test('M1a_aLibraryLinkedOutsideTheLinkGraphNeedsItsCoverage', () => {
  // rule 11 reads the libraries the build links (deployedLinks), not only LINK_GRAPH's: one linked but absent from
  // LINK_GRAPH fails, with its artifact (no entry) and without (not in the build)
  const tests = loadTests();
  const path = 'src/libraries/CascadeExtraLib.sol';
  const a = clone();
  a.CascadeVault.deployedLinks[path] = { CascadeExtraLib: [{ start: 1, length: 20 }] };
  assert.deepEqual(boundaryCoverageProblems(a, tests), ['CascadeExtraLib is linked but is not in the build, so its functions cannot be read']);
  a.CascadeExtraLib = {
    path,
    deployed: '0x00',
    creation: '0x00',
    deployedLinks: {},
    creationLinks: {},
    abi: [],
    methodIdentifiers: { 'sweep()': '11111111' },
    functions: [{ name: 'sweep', selector: '11111111', stateMutability: 'nonpayable' }],
  };
  assert.deepEqual(boundaryCoverageProblems(a, tests), ['CascadeExtraLib is linked but BOUNDARY_TESTS covers none of its functions']);
  assert.equal(LINK_GRAPH.CascadeExtraLib, undefined);
  assert.ok(!Object.values(LINK_GRAPH).flat().includes('CascadeExtraLib'), 'only the build names it');
});

test('M1b_aLinkGraphContractTheRunDoesNotCompileFailsClosed', () => {
  // rule 10's AST layer reads every LINK_GRAPH contract in solc's run; one the run does not compile is refused
  const compiled = compileAsts(SRC, astRoots(REAL));
  assert.deepEqual(delegatecallAstProblems(compiled, { graph: { ...LINK_GRAPH, CascadeFrontDoor: [] } }), [
    "CascadeFrontDoor: LINK_GRAPH lets it DELEGATECALL its libraries, but it is not in solc's run, so the delegatecall rule cannot read its code",
  ]);
});

test('M1c_aYulRootThatDeclaresNoLibraryFailsClosed', () => {
  // rule 9 reads each root's library; a root that declares none (or is not in the run) is refused
  const compiled = compileAsts(SRC, astRoots(REAL));
  assert.deepEqual(yulCallProblems(compiled, { roots: ['src/CascadeTypes.sol', 'src/libraries/CascadeMissingLib.sol'] }), [
    "src/CascadeTypes.sol: declares no library CascadeTypes in solc's output, so the Yul call rule cannot check it",
    "src/libraries/CascadeMissingLib.sol: declares no library CascadeMissingLib in solc's output, so the Yul call rule cannot check it",
  ]);
});

test('M1d_theWalkFollowsModifiersAndOperators', () => {
  // The code rules 9 and 10 walk is followed through a modifier (rule 9: a modifier on L2's unstake reaching vendored Yul)
  // and through a user-defined operator (rule 10: the vault adding two values of a type whose + is a free function that
  // DELEGATECALLs an unlinked library). An operator's function must be pure, and solc refuses every YUL_CALLS builtin in
  // pure code, so rule 9 cannot meet Yul calls through one; rule 10's library DELEGATECALL can be pure.
  const s = copy();
  s.set(
    'src/vendor/EvilYul.sol',
    '// SPDX-License-Identifier: MIT\npragma solidity 0.8.38;\n\nlibrary EvilYul {\n    function peek() internal view {\n        assembly {\n            pop(staticcall(gas(), 1, 0, 0, 0, 0))\n        }\n    }\n}\n',
  );
  replaceIn(s, L2, 'import {CascadeLedger} from "./CascadeLedger.sol";', 'import {CascadeLedger} from "./CascadeLedger.sol";\nimport {EvilYul} from "../vendor/EvilYul.sol";');
  replaceIn(s, L2, 'library CascadeStakeLib {', 'library CascadeStakeLib {\n    modifier peeking() {\n        EvilYul.peek();\n        _;\n    }\n');
  replaceIn(s, L2, '    function unstake(WalkParams memory p, uint256 wantWei)\n        external\n', '    function unstake(WalkParams memory p, uint256 wantWei)\n        external\n        peeking\n');
  s.set('src/libraries/CascadeSneakLib.sol', '// SPDX-License-Identifier: MIT\npragma solidity 0.8.38;\n\nlibrary CascadeSneakLib {\n    function one() external pure returns (uint256) {\n        return 1;\n    }\n}\n');
  s.set(
    'src/CascadeWad.sol',
    '// SPDX-License-Identifier: MIT\npragma solidity 0.8.38;\n\nimport {CascadeSneakLib} from "./libraries/CascadeSneakLib.sol";\n\ntype Wad is uint256;\n\nusing {plus as +} for Wad global;\n\nfunction plus(Wad a, Wad b) pure returns (Wad) {\n    return Wad.wrap(Wad.unwrap(a) + Wad.unwrap(b) + CascadeSneakLib.one());\n}\n',
  );
  replaceIn(s, VAULT, 'import {CascadeBase} from "./CascadeBase.sol";', 'import {CascadeBase} from "./CascadeBase.sol";\nimport {Wad} from "./CascadeWad.sol";');
  insertAfter(s, VAULT, VAULT_OPEN, '    function sneakOp() external pure returns (uint256) { return Wad.unwrap(Wad.wrap(1) + Wad.wrap(2)); }');
  const r = checkAll(s);
  assert.deepEqual(r.compiled.errors, [], 'every shape compiles');
  const modifier = lineOf(s.get(L2), 'EvilYul.peek();');
  assert.match(at(r.yul, L2, modifier).join('\n'), /CascadeStakeLib compiles in EvilYul\.peek \(src\/vendor\/EvilYul\.sol:\d+\), whose assembly makes a staticcall/);
  assert.equal(r.yul.length, 1, r.yul.join('\n'));
  const op = lineOf(s.get('src/CascadeWad.sol'), 'CascadeSneakLib.one()');
  assert.match(at(r.delegatecall, 'src/CascadeWad.sol', op).join('\n'), /CascadeVault DELEGATECALLs CascadeSneakLib\.one, a library LINK_GRAPH does not say it links/);
  assert.equal(r.delegatecall.length, 1, r.delegatecall.join('\n'));
  // the text layer sees neither (no delegatecall token), and the source rules refuse only the vendored import
  assert.deepEqual(r.delegatecallText, []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { linkedArtifacts, mergeAbi, missingFrom, signature } from './merge-abi.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'merge-abi.mjs');
const OUT = join(here, '..', 'out');

const param = (type, name = '', extra = {}) => ({ name, type, internalType: type, ...extra });
const err = (name, types = []) => ({ type: 'error', name, inputs: types.map((t, i) => param(t, `a${i}`)) });
const ev = (name, inputs = []) => ({ type: 'event', name, inputs, anonymous: false });
const fn = (name, types = []) => ({
  type: 'function',
  name,
  inputs: types.map((t, i) => param(t, `a${i}`)),
  outputs: [],
  stateMutability: 'nonpayable',
});
const named = (abi, type, name) => abi.filter((x) => x.type === type && x.name === name);

test('mergedAbiCoversEveryLibraryEventAndError', () => {
  // the real build: forge build first
  const { root, libraries } = linkedArtifacts(OUT, 'CascadeVault');
  assert.ok(libraries.some((l) => l.name === 'CascadePayoutMath'), 'the vault links CascadePayoutMath');
  const merged = mergeAbi(root.abi, libraries.map((l) => l.abi));
  // PayoutsMismatch is reverted only inside the library, so only the library's artifact has it
  assert.equal(named(root.abi, 'error', 'PayoutsMismatch').length, 0);
  assert.equal(named(merged, 'error', 'PayoutsMismatch').length, 1);
  assert.deepEqual(missingFrom(merged, libraries.map((l) => l.abi)), []);
  // and nothing of the vault's own ABI is lost
  const inMerged = new Set(merged.map(signature));
  assert.deepEqual(root.abi.map(signature).filter((s) => !inMerged.has(s)), []);
});

test('theBatchPathsEventsAndErrorsMergeBackFromL1', () => {
  // Task 5e: the batch path's events and errors are L1's alone, and the published ABI still has them
  const { root, libraries } = linkedArtifacts(OUT, 'CascadeVault');
  const l1 = libraries.find((l) => l.name === 'CascadeBatchLib');
  assert.ok(l1, 'the vault links CascadeBatchLib');
  const merged = mergeAbi(root.abi, libraries.map((l) => l.abi));
  for (const [type, name] of [
    ['event', 'BatchDelivered'],
    ['event', 'Deposited'],
    ['event', 'DepositBounced'],
    ['event', 'DepositSkipped'],
    ['event', 'Redeemed'],
    ['event', 'RedeemSkipped'],
    ['event', 'RedeemDeferred'],
    ['error', 'AmountMismatch'],
    ['error', 'WrongMessageKind'],
    ['error', 'TooManyEntries'],
  ]) {
    assert.equal(named(root.abi, type, name).length, 0, `${name} is still the vault's own`);
    assert.equal(named(l1.abi, type, name).length, 1, `${name} is not L1's`);
    assert.equal(named(merged, type, name).length, 1, `${name} is not in the merged ABI`);
  }
  // Transfer (the vault mints and burns too) and PayoutBatchQueued (the vault queues) stay the vault's
  assert.equal(named(root.abi, 'event', 'Transfer').length, 1);
  assert.equal(named(root.abi, 'event', 'PayoutBatchQueued').length, 1);
  // L1's function is not part of the published ABI
  assert.equal(named(merged, 'function', 'deliver').length, 0);
});

test('theWalksEventIsL2sAndL4s', () => {
  // Task 5f: L2 logs Unstaked for each removal of the walk, and, since step L4, L4 for the owner's direct
  // removal in removeHotkey (both through CascadeLedger.removalDebit; the vault itself no longer logs it): one
  // entry in the published ABI, and L2's function is not part of it
  const { root, libraries } = linkedArtifacts(OUT, 'CascadeVault');
  const l2 = libraries.find((l) => l.name === 'CascadeStakeLib');
  assert.ok(l2, 'the vault links CascadeStakeLib');
  const l4 = libraries.find((l) => l.name === 'CascadeHotkeyLib');
  assert.ok(l4, 'the vault links CascadeHotkeyLib');
  const merged = mergeAbi(root.abi, libraries.map((l) => l.abi));
  assert.equal(named(l2.abi, 'event', 'Unstaked').length, 1, "Unstaked is L2's");
  assert.equal(named(l4.abi, 'event', 'Unstaked').length, 1, "Unstaked is L4's too");
  assert.equal(named(root.abi, 'event', 'Unstaked').length, 0, "Unstaked is no longer the vault's own");
  assert.equal(named(merged, 'event', 'Unstaked').length, 1);
  assert.equal(named(merged, 'function', 'unstake').length, 0);
  // L2's one error is the floors' reads' gas check (CascadeFormulas.requireGasFor, Revision 28), the vault's own too
  assert.deepEqual(l2.abi.filter((e) => e.type === 'error').map((e) => e.name), ['InsufficientGas'], "L2's one error");
  assert.equal(named(root.abi, 'error', 'InsufficientGas').length, 1, "and the vault's own");
  assert.equal(named(merged, 'error', 'InsufficientGas').length, 1, 'once in the published ABI');
});

test('thePayoutEnginesEventsAndErrorsMergeBackFromL3', () => {
  // Task 5g: the payout engine's events and errors are L3's, and the payout math's PayoutsMismatch reaches the
  // published ABI through L3, which alone links it now; the published ABI holds each once, and not L3's functions
  const { root, libraries } = linkedArtifacts(OUT, 'CascadeVault');
  const l3 = libraries.find((l) => l.name === 'CascadePayoutLib');
  assert.ok(l3, 'the vault links CascadePayoutLib');
  const math = libraries.find((l) => l.name === 'CascadePayoutMath');
  assert.ok(math, 'the payout math is reached through L3');
  assert.deepEqual(Object.keys(root.deployedBytecode.linkReferences['src/libraries/CascadePayoutMath.sol'] ?? {}), [], 'the vault no longer links the payout math');
  assert.deepEqual(Object.keys(l3.deployedBytecode.linkReferences), ['src/libraries/CascadePayoutMath.sol']);
  const merged = mergeAbi(root.abi, libraries.map((l) => l.abi));
  for (const [type, name] of [
    ['event', 'PayoutDust'],
    ['event', 'PayoutChunkSent'],
    ['event', 'RedeemReversed'],
    ['event', 'PayoutBatchCancelled'],
    ['error', 'NotPending'],
    ['error', 'PayoutDelayed'],
    ['error', 'FrontDoorInactive'],
  ]) {
    assert.equal(named(root.abi, type, name).length, 0, `${name} is still the vault's own`);
    assert.equal(named(l3.abi, type, name).length, 1, `${name} is not L3's`);
    assert.equal(named(merged, type, name).length, 1, `${name} is not in the merged ABI`);
  }
  // L3 checks the primary bridge and the fee ceiling and re-mints on a cancel; the vault still mints, reverts
  // FeeTooHigh in setRewardCut and UnstakeShort around the walk
  for (const [type, name] of [
    ['error', 'PrimaryBridgeDisabled'],
    ['error', 'FeeTooHigh'],
    ['event', 'Transfer'],
  ]) {
    assert.equal(named(l3.abi, type, name).length, 1, `${name} is not L3's`);
    assert.equal(named(merged, type, name).length, 1, `${name} is not in the merged ABI`);
  }
  assert.equal(named(root.abi, 'error', 'UnstakeShort').length, 1);
  assert.equal(named(merged, 'error', 'PayoutsMismatch').length, 1);
  for (const fn of ['prepare', 'finish']) assert.equal(named(merged, 'function', fn).length, 0, fn);
  // the only cancel is the vault's own scheduler cancel(bytes32) (Task 7a), never L3's
  assert.deepEqual(named(merged, 'function', 'cancel').map(signature), ['function cancel(bytes32)']);
});

test('theHotkeyRulesEventsAndErrorsMergeBackFromL4', () => {
  // Step L4: the hotkey rules' events and errors are L4's alone (the vault reads only the roles), and the
  // published ABI still holds each once, with the vault's own entry points and none of L4's functions
  const { root, libraries } = linkedArtifacts(OUT, 'CascadeVault');
  const l4 = libraries.find((l) => l.name === 'CascadeHotkeyLib');
  assert.ok(l4, 'the vault links CascadeHotkeyLib');
  assert.deepEqual(l4.deployedBytecode.linkReferences, {}, 'L4 links nothing');
  const merged = mergeAbi(root.abi, libraries.map((l) => l.abi));
  for (const [type, name] of [
    ['event', 'HotkeyAdded'],
    ['event', 'HotkeyRemoved'],
    ['event', 'StakeMoved'],
    ['error', 'NotEligible'],
    ['error', 'SlotReserved'],
    ['error', 'ZeroHotkey'],
    ['error', 'HotkeyKnown'],
    ['error', 'TooManyHotkeys'],
    ['error', 'HotkeyHasRewards'],
    ['error', 'NotAuthorized'],
  ]) {
    assert.equal(named(root.abi, type, name).length, 0, `${name} is still the vault's own`);
    assert.equal(named(l4.abi, type, name).length, 1, `${name} is not L4's`);
    assert.equal(named(merged, type, name).length, 1, `${name} is not in the merged ABI`);
  }
  // the vault still reverts UnknownHotkey (claimRewards), InvalidParameter (its setters) and NotListed
  // (setStakeHotkey); L4 reverts the first two too (moveStake, removeHotkey)
  for (const name of ['UnknownHotkey', 'InvalidParameter']) {
    assert.equal(named(root.abi, 'error', name).length, 1, name);
    assert.equal(named(l4.abi, 'error', name).length, 1, name);
    assert.equal(named(merged, 'error', name).length, 1, name);
  }
  assert.equal(named(root.abi, 'error', 'NotListed').length, 1);
  // the entry points stay the vault's, with their selectors; L4's functions are not part of the published ABI
  for (const s of ['function addHotkey(bytes32)', 'function removeHotkey(bytes32,bool)', 'function moveStake(bytes32,bytes32,uint256)']) {
    assert.equal(root.abi.filter((x) => signature(x) === s).length, 1, s);
  }
  for (const f of ['add', 'remove', 'move']) assert.equal(named(merged, 'function', f).length, 0, f);
});

test('missingFrom names a library event or error the merged ABI lacks', () => {
  const lib = [err('Gone', ['uint256']), ev('Left', [param('address', 'who', { indexed: true })]), fn('helper')];
  assert.deepEqual(missingFrom([], [lib]), ['error Gone(uint256)', 'event Left(address indexed)']);
  assert.deepEqual(missingFrom(mergeAbi([], [lib]), [lib]), []);
});

test('conflictingDuplicateFails', () => {
  // one name, one shape: kept once
  const merged = mergeAbi([err('Same', ['uint256'])], [[err('Same', ['uint256'])], [err('Same', ['uint256'])]]);
  assert.equal(named(merged, 'error', 'Same').length, 1);
  // one name, different inputs: refused
  assert.throws(() => mergeAbi([err('Clash', ['uint256'])], [[err('Clash', ['address'])]]), /error Clash/);
  // an event whose indexing differs is a different event
  const a = ev('Moved', [param('uint256', 'amount', { indexed: true })]);
  const b = ev('Moved', [param('uint256', 'amount', { indexed: false })]);
  assert.throws(() => mergeAbi([a], [[b]]), /event Moved/);
  // so is one whose argument names differ, since consumers decode by name
  const c = ev('Moved', [param('uint256', 'value', { indexed: true })]);
  assert.throws(() => mergeAbi([a], [[c]]), /event Moved/);
  // overloaded functions are not entries of a library's event and error ABI: left alone
  assert.equal(mergeAbi([fn('f', ['uint256']), fn('f', ['address'])], []).length, 2);
});

test('the merged ABI is sorted by type, then name, then signature, whatever the input order', () => {
  const vault = [fn('b'), ev('Z'), err('B'), fn('a', ['uint256']), fn('a'), { type: 'receive', stateMutability: 'payable' }];
  const lib = [err('A'), ev('Y')];
  const merged = mergeAbi(vault, [lib]);
  assert.deepEqual(merged.map(signature), [
    'error A()',
    'error B()',
    'event Y()',
    'event Z()',
    'function a()',
    'function a(uint256)',
    'function b()',
    'receive',
  ]);
  assert.deepEqual(mergeAbi([...vault].reverse(), [[...lib].reverse()]), merged);
  // keys in a fixed order too, so the file does not depend on how forge orders them
  const shuffled = { stateMutability: 'nonpayable', outputs: [], inputs: [{ type: 'uint256', name: 'x', internalType: 'uint256' }], name: 'g', type: 'function' };
  assert.deepEqual(Object.keys(mergeAbi([shuffled], [])[0]), ['type', 'name', 'inputs', 'outputs', 'stateMutability']);
  assert.deepEqual(Object.keys(mergeAbi([shuffled], [])[0].inputs[0]), ['name', 'type', 'internalType']);
});

/** A forge out/ directory: a vault linking LibA, which links LibB. */
function fakeOut() {
  const dir = mkdtempSync(join(tmpdir(), 'merge-abi-'));
  const write = (file, name, abi, links = {}) => {
    mkdirSync(join(dir, 'out', file), { recursive: true });
    const linkReferences = Object.fromEntries(Object.entries(links).map(([path, lib]) => [path, { [lib]: [{ start: 1, length: 20 }] }]));
    const artifact = { abi, bytecode: { object: '0x', linkReferences }, deployedBytecode: { object: '0x', linkReferences } };
    writeFileSync(join(dir, 'out', file, `${name}.json`), JSON.stringify(artifact));
  };
  write('CascadeVault.sol', 'CascadeVault', [fn('deposit'), err('Own')], { 'src/libraries/LibA.sol': 'LibA' });
  write('LibA.sol', 'LibA', [fn('run'), err('FromA', ['uint256'])], { 'src/libraries/LibB.sol': 'LibB' });
  write('LibB.sol', 'LibB', [ev('FromB', [param('address', 'who', { indexed: true })])]);
  return dir;
}
const run = (dir, ...args) =>
  spawnSync(process.execPath, [SCRIPT, '--out', join(dir, 'out'), '--abi', join(dir, 'abi', 'CascadeVault.json'), ...args], { encoding: 'utf8' });

test('follows the links through another library', () => {
  const dir = fakeOut();
  const { libraries } = linkedArtifacts(join(dir, 'out'), 'CascadeVault');
  assert.deepEqual(libraries.map((l) => l.name).sort(), ['LibA', 'LibB']);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  const written = readFileSync(join(dir, 'abi', 'CascadeVault.json'), 'utf8');
  assert.ok(written.endsWith('}\n]\n') && !written.includes('\r'), 'LF, with a final newline');
  assert.deepEqual(JSON.parse(written).map(signature), ['error FromA(uint256)', 'error Own()', 'event FromB(address indexed)', 'function deposit()']);
});

test('staleCommittedAbiFails', () => {
  const dir = fakeOut();
  // nothing committed yet
  assert.equal(run(dir, '--check').status, 1);
  assert.equal(run(dir).status, 0);
  assert.equal(run(dir, '--check').status, 0);
  // a committed file that no longer matches the build
  const path = join(dir, 'abi', 'CascadeVault.json');
  const stale = JSON.parse(readFileSync(path, 'utf8')).filter((x) => x.name !== 'FromA');
  writeFileSync(path, `${JSON.stringify(stale, null, 2)}\n`);
  const r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stale/);
  assert.match(r.stderr, /node script\/merge-abi\.mjs/);
});

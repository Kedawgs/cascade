import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILD_PARTS, check, LIBRARY_LIMIT, LIMIT, limitOf, report } from './size-gate.mjs';

/** Every listed part at `size` bytes. */
const all = (size) => Object.fromEntries(BUILD_PARTS.map((name) => [name, { runtime_size: size }]));

test('vault over the limit is named with its size', () => {
  const out = check({ ...all(1), CascadeVault: { runtime_size: 23_077 } });
  assert.equal(out.length, 1);
  assert.match(out[0], /CascadeVault/);
  assert.match(out[0], /23,077/);
});

test('the vault and the front door at the limit pass', () => {
  assert.deepEqual(check({ ...all(1), CascadeVault: { runtime_size: 23_076 }, CascadeFrontDoor: { runtime_size: 23_076 } }), []);
});

test('missing front door is reported', () => {
  assert.deepEqual(check({ ...all(1), CascadeFrontDoor: undefined }), ['CascadeFrontDoor is not in the build']);
});

test('a library is held to EIP-170, not to the vault and front door limit', () => {
  assert.equal(limitOf('CascadeVault'), LIMIT);
  assert.equal(limitOf('CascadeFrontDoor'), LIMIT);
  assert.equal(limitOf('CascadePayoutMath'), LIBRARY_LIMIT);
  assert.deepEqual(check({ ...all(1), CascadePayoutMath: { runtime_size: 24_576 } }), []);
  const out = check({ ...all(1), CascadePayoutMath: { runtime_size: 24_577 } });
  assert.equal(out.length, 1);
  assert.match(out[0], /CascadePayoutMath is 24,577 bytes, limit 24,576/);
});

test('sizeGateReportsEveryListedPart', () => {
  assert.deepEqual(BUILD_PARTS.slice(0, 3), ['CascadeVault', 'CascadeFrontDoor', 'CascadePayoutMath']);
  const sizes = { ...all(1_000), CascadeVault: { runtime_size: 21_447 }, SomeTestHarness: { runtime_size: 30_000 } };
  const lines = report(sizes);
  assert.equal(lines.length, BUILD_PARTS.length);
  BUILD_PARTS.forEach((name, i) => {
    assert.match(lines[i], new RegExp(`\\b${name}\\b`));
    assert.match(lines[i], new RegExp(`limit ${limitOf(name).toLocaleString('en-US')}`));
  });
  assert.match(lines[0], /21,447 B/);
  assert.match(lines[0], /headroom +1,629 B/);
  // what is not a part (tests, mocks, harnesses) is not reported
  assert.ok(lines.every((l) => !l.includes('SomeTestHarness')));
});

test('bothLensesAreParts, held to EIP-170', () => {
  for (const lens of ['CascadeVaultLens', 'CascadeDoorLens']) {
    assert.ok(BUILD_PARTS.includes(lens), `${lens} is not a build part`);
    assert.equal(limitOf(lens), LIBRARY_LIMIT);
    assert.deepEqual(check({ ...all(1), [lens]: { runtime_size: 24_576 } }), []);
    assert.match(check({ ...all(1), [lens]: { runtime_size: 24_577 } })[0], new RegExp(`${lens} is 24,577 bytes, limit 24,576`));
    assert.deepEqual(check({ ...all(1), [lens]: undefined }), [`${lens} is not in the build`]);
  }
});

test('sizeGateFailsAMissingPart', () => {
  const sizes = all(1);
  delete sizes.CascadePayoutMath;
  assert.deepEqual(check(sizes), ['CascadePayoutMath is not in the build']);
  assert.match(report(sizes)[BUILD_PARTS.indexOf('CascadePayoutMath')], /CascadePayoutMath +missing/);
});

test('theBatchLibIsAPart, held to EIP-170', () => {
  // L1 CascadeBatchLib (Task 5e), reported after the payout math and before the lenses
  assert.ok(BUILD_PARTS.includes('CascadeBatchLib'), 'CascadeBatchLib is not a build part');
  assert.ok(BUILD_PARTS.indexOf('CascadeBatchLib') < BUILD_PARTS.indexOf('CascadeVaultLens'));
  assert.equal(limitOf('CascadeBatchLib'), LIBRARY_LIMIT);
  assert.deepEqual(check({ ...all(1), CascadeBatchLib: { runtime_size: 24_576 } }), []);
  assert.match(check({ ...all(1), CascadeBatchLib: { runtime_size: 24_577 } })[0], /CascadeBatchLib is 24,577 bytes, limit 24,576/);
  assert.deepEqual(check({ ...all(1), CascadeBatchLib: undefined }), ['CascadeBatchLib is not in the build']);
});

test('theStakeLibIsAPart, held to EIP-170', () => {
  // L2 CascadeStakeLib (Task 5f), reported after L1 and before the lenses
  assert.ok(BUILD_PARTS.includes('CascadeStakeLib'), 'CascadeStakeLib is not a build part');
  assert.ok(BUILD_PARTS.indexOf('CascadeBatchLib') < BUILD_PARTS.indexOf('CascadeStakeLib'));
  assert.ok(BUILD_PARTS.indexOf('CascadeStakeLib') < BUILD_PARTS.indexOf('CascadeVaultLens'));
  assert.equal(limitOf('CascadeStakeLib'), LIBRARY_LIMIT);
  assert.deepEqual(check({ ...all(1), CascadeStakeLib: { runtime_size: 24_576 } }), []);
  assert.match(check({ ...all(1), CascadeStakeLib: { runtime_size: 24_577 } })[0], /CascadeStakeLib is 24,577 bytes, limit 24,576/);
  assert.deepEqual(check({ ...all(1), CascadeStakeLib: undefined }), ['CascadeStakeLib is not in the build']);
});

test('thePayoutLibIsAPart, held to EIP-170', () => {
  // L3 CascadePayoutLib (Task 5g), reported after L2 and before the lenses
  assert.ok(BUILD_PARTS.includes('CascadePayoutLib'), 'CascadePayoutLib is not a build part');
  assert.ok(BUILD_PARTS.indexOf('CascadeStakeLib') < BUILD_PARTS.indexOf('CascadePayoutLib'));
  assert.ok(BUILD_PARTS.indexOf('CascadePayoutLib') < BUILD_PARTS.indexOf('CascadeVaultLens'));
  assert.equal(limitOf('CascadePayoutLib'), LIBRARY_LIMIT);
  assert.deepEqual(check({ ...all(1), CascadePayoutLib: { runtime_size: 24_576 } }), []);
  assert.match(check({ ...all(1), CascadePayoutLib: { runtime_size: 24_577 } })[0], /CascadePayoutLib is 24,577 bytes, limit 24,576/);
  assert.deepEqual(check({ ...all(1), CascadePayoutLib: undefined }), ['CascadePayoutLib is not in the build']);
});

test('theHotkeyLibIsAPart, held to EIP-170', () => {
  // L4 CascadeHotkeyLib (the reserve lever, step L4), reported after L3 and before the lenses
  assert.ok(BUILD_PARTS.includes('CascadeHotkeyLib'), 'CascadeHotkeyLib is not a build part');
  assert.ok(BUILD_PARTS.indexOf('CascadePayoutLib') < BUILD_PARTS.indexOf('CascadeHotkeyLib'));
  assert.ok(BUILD_PARTS.indexOf('CascadeHotkeyLib') < BUILD_PARTS.indexOf('CascadeVaultLens'));
  assert.equal(limitOf('CascadeHotkeyLib'), LIBRARY_LIMIT);
  assert.deepEqual(check({ ...all(1), CascadeHotkeyLib: { runtime_size: 24_576 } }), []);
  assert.match(check({ ...all(1), CascadeHotkeyLib: { runtime_size: 24_577 } })[0], /CascadeHotkeyLib is 24,577 bytes, limit 24,576/);
  assert.deepEqual(check({ ...all(1), CascadeHotkeyLib: undefined }), ['CascadeHotkeyLib is not in the build']);
});

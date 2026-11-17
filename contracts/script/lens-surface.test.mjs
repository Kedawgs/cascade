import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS } from './build-checks.mjs';
import {
  ARTIFACTS,
  BY_MEMBER,
  DOOR_LENS_VIEWS,
  ENTRY_POINTS_FILE,
  entryPointProblems,
  entryPointsOf,
  FORWARDED,
  INTERNAL_ONLY,
  KEPT_ON_TARGET,
  LENSES,
  loadBuild,
  NOT_SERVED,
  parseEntryPoints,
  parseViewLists,
  servedNames,
  surfaceProblems,
  VAULT_LENS_VIEWS,
} from './lens-surface.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'lens-surface.mjs');
const OUT = join(here, '..', 'out');

/** The real build (forge build first), read once; each test mutates its own copy. */
const REAL = loadBuild(OUT);
const copy = () => structuredClone(REAL);
const problemsOf = (build) => surfaceProblems(build).join('\n');
const fn = (abi, name) => abi.find((e) => e.type === 'function' && e.name === name);
const names = (abi) => abi.filter((e) => e.type === 'function').map((e) => e.name);

// ---- the real build ----

test('theLensesServeTheirWholeSurface', () => {
  assert.deepEqual(surfaceProblems(REAL), []);
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /CascadeVaultLens serves \d+ views/);
  assert.match(r.stdout, /CascadeDoorLens serves \d+ views/);
});

test('lensServesEveryStateVariable', () => {
  // every vault state variable is served under its name (or its aliases), unless it is OpenZeppelin's
  // own state the vault keeps a getter for, or internal-only and exposed by VaultInternals
  const vaultLens = names(REAL.abi.CascadeVaultLens);
  for (const v of REAL.layout.CascadeVault.storage) {
    if (NOT_SERVED.includes(v.label) || v.label in INTERNAL_ONLY) continue;
    // a struct variable served member by member (the ledger, Task 5f): theLedgersMembersAreServedOrInternal
    if (BY_MEMBER.includes(v.label)) continue;
    for (const name of servedNames(v.label)) assert.ok(vaultLens.includes(name), `${v.label} is not served as ${name}`);
  }
  // the front door's CascadeBase state is served by the door lens
  const doorLens = names(REAL.abi.CascadeDoorLens);
  for (const v of REAL.layout.CascadeBase.storage) {
    if (NOT_SERVED.includes(v.label)) continue;
    for (const name of servedNames(v.label)) assert.ok(doorLens.includes(name), `${v.label} is not served as ${name}`);
  }
  // a new vault variable without a lens view fails, naming it
  const b = copy();
  const like = b.layout.CascadeVault.storage.find((v) => v.label === 'maxFeeAbs');
  b.layout.CascadeVault.storage.push({ ...like, label: 'newLimit', slot: '99' });
  assert.match(problemsOf(b), /CascadeVaultLens does not serve newLimit/);
  // so does a new CascadeBase variable on the door side
  const d = copy();
  d.layout.CascadeBase.storage.push({ ...d.layout.CascadeBase.storage.at(-1), label: 'newRole', slot: '99' });
  assert.match(problemsOf(d), /CascadeDoorLens does not serve newRole/);
});

test('aMovedVaultGetterWithoutALensViewFails', () => {
  const b = copy();
  b.abi.CascadeVault.push({ ...structuredClone(fn(b.abi.CascadeVaultLens, 'keeper')), name: 'newView' });
  assert.match(problemsOf(b), /CascadeVaultLens does not serve newView/);
  // the vault's kept surface needs no lens view
  for (const kept of ['name', 'symbol', 'decimals', 'owner', 'pendingOwner', 'paused', 'extsload', 'allowance']) {
    assert.ok(KEPT_ON_TARGET.includes(kept), kept);
  }
});

test('aViewTheSpecMovesStaysRequiredOnceTheVaultGetterIsGone', () => {
  // Task 5d makes the vault's getters internal: the list keeps them required of the lens
  const b = copy();
  b.abi.CascadeVault = b.abi.CascadeVault.filter((e) => e.name !== 'price');
  b.abi.CascadeVaultLens = b.abi.CascadeVaultLens.filter((e) => e.name !== 'price');
  assert.match(problemsOf(b), /CascadeVaultLens does not serve price/);
  for (const v of ['price', 'totalAssets', 'grossAssets', 'unvestedRewards', 'coldkey', 'hotkeyCount', 'peerId', 'batchKey']) {
    assert.ok(VAULT_LENS_VIEWS.includes(v), v);
  }
  // getPayoutBatch is required as the state variable payoutBatches is
  assert.deepEqual(servedNames('payoutBatches'), ['getPayoutBatch']);
  assert.ok(DOOR_LENS_VIEWS.includes('keeper'));
});

test('aLensViewWithAnotherTypeThanItsTargetFails', () => {
  // the getters the targets keep: the vault's totalSupply, the front door's keeper
  const b = copy();
  fn(b.abi.CascadeVaultLens, 'totalSupply').outputs[0].type = 'uint128';
  assert.match(problemsOf(b), /CascadeVaultLens\.totalSupply\(\) returns \(uint128\), CascadeVault's returns \(uint256\)/);
  const k = copy();
  fn(k.abi.CascadeDoorLens, 'keeper').outputs[0].type = 'bytes32';
  assert.match(problemsOf(k), /CascadeDoorLens\.keeper\(\) returns \(bytes32\), CascadeFrontDoor's returns \(address\)/);
  // a moved getter is held to its state variable's declared type
  const l = copy();
  fn(l.abi.CascadeVaultLens, 'lastStakeAt').outputs[0].type = 'uint256';
  assert.match(problemsOf(l), /CascadeVaultLens\.lastStakeAt\(\) returns \(uint256\), the state variable lastStakeAt \(uint64\)'s getter returns \(uint64\)/);
  const d = copy();
  fn(d.abi.CascadeDoorLens, 'bridgeEnabled').inputs[0].type = 'bytes32';
  assert.match(problemsOf(d), /CascadeDoorLens\.bridgeEnabled\(bytes32\) takes other arguments than the state variable bridgeEnabled \(mapping\(address => bool\)\), whose getter takes \(address\)/);
  // a struct is compared member by member
  const s = copy();
  fn(s.abi.CascadeVaultLens, 'getPayoutBatch').outputs[0].components[4].type = 'uint64';
  assert.match(problemsOf(s), /getPayoutBatch\(bytes32\) returns/);
});

test('aLensViewWithoutAnExposureFails', () => {
  const b = copy();
  b.abi.VaultInternals = b.abi.VaultInternals.filter((e) => e.name !== 'exposed_treasury');
  assert.match(problemsOf(b), /VaultInternals has no exposed_treasury\(\)/);
  const d = copy();
  fn(d.abi.DoorInternals, 'exposed_keeper').outputs[0].type = 'bytes32';
  assert.match(problemsOf(d), /DoorInternals\.exposed_keeper\(\) returns \(bytes32\), CascadeDoorLens\.keeper\(\) returns \(address\)/);
});

test('theInternalsExposeTheUnservedState', () => {
  // Task 5f: v3.1's bookedStake and rampingStake are the Ledger struct's members now (the 5c-2 carry); since
  // Task 12 the lens serves the booked stake as bookedStake() (in rao, ruling A19) and since R2 F4 the ramp as
  // rampingStake() (in wei), as it serves pending as pendingPayouts, so nothing is internal-only. The unstake
  // flag is transient, in no storage layout, so in neither list
  assert.deepEqual(BY_MEMBER, ['ledger']);
  assert.deepEqual(INTERNAL_ONLY, {});
  assert.ok(!REAL.layout.CascadeVault.storage.some((v) => /unstaking/i.test(v.label)), 'the flag is not storage');
  assert.deepEqual(servedNames('ledger.pending'), ['pendingPayouts']);
  assert.deepEqual(servedNames('ledger.booked'), ['bookedStake']);
  assert.deepEqual(servedNames('ledger.ramping'), ['rampingStake']);
  // the ramp is a lens view now: one missing from the lens, or its exposure, fails as any served member's would
  const b = copy();
  b.abi.VaultInternals = b.abi.VaultInternals.filter((e) => e.name !== 'exposed_rampingStake');
  assert.match(problemsOf(b), /VaultInternals has no exposed_rampingStake\(\) for CascadeVaultLens\.rampingStake\(\)/);
  const c = copy();
  c.abi.CascadeVaultLens = c.abi.CascadeVaultLens.filter((e) => e.name !== 'bookedStake' && e.name !== 'rampingStake');
  assert.match(problemsOf(c), /CascadeVaultLens does not serve bookedStake/);
  assert.match(problemsOf(c), /CascadeVaultLens does not serve rampingStake \(the state variable ledger\.ramping\)/);
  // a member listed internal-only still needs its exposure (the list is empty today; the rule stays)
  const d = copy();
  INTERNAL_ONLY['ledger.ramping'] = { exposed: 'rampingStakeRaw', why: 'test' };
  try {
    const want = /VaultInternals has no exposed_rampingStakeRaw, for ledger\.ramping, which no lens serves/;
    assert.match(problemsOf(d), want);
  } finally {
    delete INTERNAL_ONLY['ledger.ramping'];
  }
});

/** The vault layout's Ledger struct type in `build`. */
const ledgerType = (build) => Object.values(build.layout.CascadeVault.types).find((t) => t.label === 'struct Ledger');

test('theLedgersMembersAreServedOrInternal', () => {
  // a member the ledger gains must be served by the lens or exposed as internal-only
  const b = copy();
  ledgerType(b).members.push({ label: 'parked', slot: '4', offset: 0, type: 't_uint256' });
  assert.match(problemsOf(b), /ledger\.parked, a member of ledger, is neither served \(SERVED_AS\) nor internal-only \(INTERNAL_ONLY\)/);
  // an internal-only or served member the layout no longer holds is stale: the lists follow a move
  const c = copy();
  ledgerType(c).members = ledgerType(c).members.filter((m) => m.label !== 'ramping');
  assert.match(problemsOf(c), /SERVED_AS names ledger\.ramping, which CascadeVault's storage does not hold/);
  INTERNAL_ONLY['ledger.parked'] = { exposed: 'parked', why: 'test' };
  try {
    assert.match(problemsOf(copy()), /INTERNAL_ONLY names ledger\.parked, which CascadeVault's storage does not hold/);
  } finally {
    delete INTERNAL_ONLY['ledger.parked'];
  }
  const d = copy();
  ledgerType(d).members = ledgerType(d).members.filter((m) => m.label !== 'pending');
  assert.match(problemsOf(d), /SERVED_AS names ledger\.pending, which CascadeVault's storage does not hold/);
  // the served member keeps its declared type
  const e = copy();
  fn(e.abi.CascadeVaultLens, 'pendingPayouts').outputs[0].type = 'uint128';
  assert.match(problemsOf(e), /CascadeVaultLens\.pendingPayouts\(\) returns \(uint128\), the state variable ledger\.pending \(uint256\)'s getter returns \(uint256\)/);
  // a struct the lens serves member by member must be one
  const f = copy();
  f.layout.CascadeVault.storage.find((v) => v.label === 'ledger').type = 't_uint256';
  assert.match(problemsOf(f), /ledger is in BY_MEMBER but is not a struct/);
});

test('theParityListsEqualTheLenses', () => {
  const b = copy();
  b.lists.vaultLensViews = b.lists.vaultLensViews.filter((v) => v !== 'treasury()');
  b.lists.doorLensViews.push('owner()');
  const p = problemsOf(b);
  assert.match(p, /vaultLensViews\(\) in test\/utils\/LensViews\.sol lacks treasury\(\)/);
  assert.match(p, /doorLensViews\(\) in test\/utils\/LensViews\.sol lists owner\(\), which CascadeDoorLens does not serve/);
});

test('eachLensTakesOnlyItsTarget', () => {
  for (const { lens } of LENSES) {
    const ctor = REAL.abi[lens].find((e) => e.type === 'constructor');
    assert.deepEqual(ctor.inputs.map((i) => i.type), ['address'], lens);
    assert.deepEqual(REAL.layout[lens].storage, [], `${lens} holds no state`);
    assert.ok(REAL.abi[lens].filter((e) => e.type === 'function').every((f) => ['view', 'pure'].includes(f.stateMutability)));
    assert.equal(fn(REAL.abi[lens], 'target').outputs[0].type, 'address');
  }
  const b = copy();
  b.abi.CascadeVaultLens.find((e) => e.type === 'constructor').inputs.push({ name: 'owner', type: 'address' });
  b.layout.CascadeDoorLens.storage.push({ label: 'cache', slot: '0', offset: 0, type: 't_uint256' });
  fn(b.abi.CascadeDoorLens, 'keeper').stateMutability = 'nonpayable';
  const p = problemsOf(b);
  assert.match(p, /CascadeVaultLens's constructor must take only its target's address, not \(address,address\)/);
  assert.match(p, /CascadeDoorLens must hold no state, but declares cache/);
  assert.match(p, /CascadeDoorLens\.keeper\(\) is nonpayable: a lens has only views/);
});

test('theViewListsParse', () => {
  const text = [
    'function vaultLensViews() pure returns (string[] memory views) {',
    '    string[2] memory v = [',
    '        // a comment',
    '        "RAO()",',
    '        "batchKey(uint64,address,bytes)"',
    '    ];',
    '}',
    'function doorLensViews() pure returns (string[] memory views) {',
    '    string[1] memory v = ["keeper()"];',
    '}',
  ].join('\n');
  assert.throws(() => parseViewLists(text), /baseLensViews/);
  const withBase = `${text}\nfunction baseLensViews() pure returns (string[] memory views) {\n    string[1] memory v = ["guardian()"];\n}`;
  assert.deepEqual(parseViewLists(withBase), {
    vaultLensViews: ['RAO()', 'batchKey(uint64,address,bytes)'],
    doorLensViews: ['keeper()'],
    baseLensViews: ['guardian()'],
  });
  assert.throws(() => parseViewLists('function vaultLensViews() pure {}'), /doorLensViews/);
});

// ---- Task 5d-1: CascadeBase's getters leave both targets ----

test('cascadeBaseGettersAreServedByTheLensesAlone', () => {
  // spec §8.1: neither target has a getter of CascadeBase's state or constants; CascadeBaseLens serves
  // them on both lenses
  const base = names(REAL.abi.CascadeBaseLens).filter((n) => n !== 'target');
  assert.deepEqual(base.sort(), [
    'DOMAIN_SEPARATOR',
    'EXECUTE_WINDOW',
    'GUARDIAN_DELAY',
    'MS_PER_BLOCK',
    'PARAM_DELAY',
    'REGISTRY_DELAY',
    'STAMP_MAX_TTL',
    'STAMP_TYPEHASH',
    'bridgeEnabled',
    'bridgeKnown',
    'exitsOpen',
    'guardian',
    'guardianHold',
    'lastGuardianClose',
    'lastOwnerClose',
    'ownerHold',
    'pendingSince',
    'primaryBridge',
    'primaryDisabledBy',
    'scheduled',
  ]);
  for (const target of ['CascadeVault', 'CascadeFrontDoor', 'CascadeBase']) {
    for (const name of base.filter((n) => !FORWARDED.includes(n))) {
      assert.ok(!names(REAL.abi[target]).includes(name), `${target} still has ${name}`);
    }
  }
  // a getter left on either target fails, naming it
  const d = copy();
  d.abi.CascadeFrontDoor.push(structuredClone(fn(d.abi.CascadeDoorLens, 'guardian')));
  assert.match(problemsOf(d), /CascadeFrontDoor has CascadeBase's getter guardian\(\), which only the lenses serve \(spec §8\.1\)/);
  const v = copy();
  v.abi.CascadeVault.push(structuredClone(fn(v.abi.CascadeVaultLens, 'GUARDIAN_DELAY')));
  assert.match(problemsOf(v), /CascadeVault has CascadeBase's getter GUARDIAN_DELAY\(\), which only the lenses serve/);
  // the parity tests' list of them equals CascadeBaseLens's views
  const l = copy();
  l.lists.baseLensViews = l.lists.baseLensViews.filter((x) => x !== 'primaryBridge()');
  l.lists.baseLensViews.push('keeper()');
  const p = problemsOf(l);
  assert.match(p, /baseLensViews\(\) in test\/utils\/LensViews\.sol lacks primaryBridge\(\), which CascadeBaseLens serves/);
  assert.match(p, /baseLensViews\(\) in test\/utils\/LensViews\.sol lists keeper\(\), which CascadeBaseLens does not serve/);
});

test('aStateVariablesViewKeepsItsDeclaredTypes', () => {
  // with its getter gone, a state variable's view is held to the getter its declared type would have
  const d = copy();
  fn(d.abi.CascadeDoorLens, 'guardian').outputs[0].type = 'uint160';
  assert.match(problemsOf(d), /CascadeDoorLens\.guardian\(\) returns \(uint160\), the state variable guardian \(address\)'s getter returns \(address\)/);
  const b = copy();
  fn(b.abi.CascadeVaultLens, 'lastClaimAt').outputs[0].type = 'uint256';
  assert.match(problemsOf(b), /CascadeVaultLens\.lastClaimAt\(bytes32\) returns \(uint256\), the state variable lastClaimAt \(mapping\(bytes32 => uint64\)\)'s getter returns \(uint64\)/);
  // an array is read by index, a mapping by key
  const h = copy();
  fn(h.abi.CascadeVaultLens, 'hotkeys').inputs[0].type = 'uint64';
  assert.match(problemsOf(h), /CascadeVaultLens\.hotkeys\(uint64\) takes other arguments than the state variable hotkeys \(bytes32\[\]\), whose getter takes \(uint256\)/);
});

// ---- Task 5d-2: the vault's own getters leave it ----

test('theVaultKeepsOnlyItsKeptViews', () => {
  // spec §8.1: the vault keeps its token surface, owner, pendingOwner, paused, launchChain and extsload;
  // every other view, price and hotkeyCount included, is the vault lens's alone
  const kept = REAL.abi.CascadeVault.filter((e) => e.type === 'function' && ['view', 'pure'].includes(e.stateMutability));
  for (const f of kept) assert.ok(KEPT_ON_TARGET.includes(f.name), `CascadeVault still has the view ${f.name}`);
  for (const name of ['price', 'hotkeyCount', 'totalAssets', 'keeper', 'getPayoutBatch', 'coldkey', 'RAO']) {
    assert.ok(!names(REAL.abi.CascadeVault).includes(name), `CascadeVault still has ${name}`);
    assert.ok(names(REAL.abi.CascadeVaultLens).includes(name), `CascadeVaultLens lacks ${name}`);
  }
  assert.ok(LENSES.find((L) => L.target === 'CascadeVault').keepsOnlyKept);
  // a view put back on the vault fails, naming it
  const b = copy();
  b.abi.CascadeVault.push(structuredClone(fn(b.abi.CascadeVaultLens, 'price')));
  assert.match(problemsOf(b), /CascadeVault has the view price\(\), which only CascadeVaultLens serves \(spec §8\.1\)/);
  const n = copy();
  n.abi.CascadeVault.push({ ...structuredClone(fn(n.abi.CascadeVaultLens, 'keeper')), name: 'newView' });
  assert.match(problemsOf(n), /CascadeVault has the view newView\(\), which only CascadeVaultLens serves/);
  // an entry point is not a view, and the front door keeps its own getters
  const e = copy();
  e.abi.CascadeVault.push({ ...structuredClone(fn(e.abi.CascadeVaultLens, 'keeper')), name: 'poke', stateMutability: 'nonpayable' });
  assert.doesNotMatch(problemsOf(e), /CascadeVault has the view poke/);
  assert.ok(!LENSES.find((L) => L.target === 'CascadeFrontDoor').keepsOnlyKept);
  assert.ok(names(REAL.abi.CascadeFrontDoor).includes('keeper'));
});

// ---- the Internals add no storage, and a missing layout is an error ----

test('theInternalsAddNoStorage', () => {
  // VaultInternals and DoorInternals have exactly their target's storage: label, slot, offset and type
  const shape = (layout) => layout.storage.map(({ label, slot, offset }) => ({ label, slot, offset }));
  assert.deepEqual(shape(REAL.layout.VaultInternals), shape(REAL.layout.CascadeVault));
  assert.deepEqual(shape(REAL.layout.DoorInternals), shape(REAL.layout.CascadeFrontDoor));
  // a variable added at the end
  const a = copy();
  const last = a.layout.VaultInternals.storage.at(-1);
  a.layout.VaultInternals.storage.push({ ...last, label: 'cache', slot: String(Number(last.slot) + 1) });
  assert.match(problemsOf(a), /VaultInternals' storage is not CascadeVault's: it adds cache at slot \d+/);
  // a variable moved, renamed or retyped
  const o = copy();
  o.layout.DoorInternals.storage.find((v) => v.label === 'keeper').offset = 12;
  assert.match(problemsOf(o), /DoorInternals' storage is not CascadeFrontDoor's: keeper at slot \d+ offset 12 \(address\), CascadeFrontDoor has keeper at slot \d+ offset 0 \(address\)/);
  const r = copy();
  r.layout.DoorInternals.storage.find((v) => v.label === 'swapper').label = 'swapper2';
  assert.match(problemsOf(r), /DoorInternals' storage is not CascadeFrontDoor's: swapper2 at slot/);
  const t = copy();
  t.layout.VaultInternals.storage.find((v) => v.label === 'keeper').type = 't_uint160';
  t.layout.VaultInternals.types.t_uint160 = { encoding: 'inplace', label: 'uint160', numberOfBytes: '20' };
  assert.match(problemsOf(t), /VaultInternals' storage is not CascadeVault's: keeper at slot \d+ offset 0 \(uint160\)/);
  // a variable dropped (the last: adoptVestingPeriod since Revision 27, the adoption drip; idleBufferBps from Task 20),
  // named in the problem
  const x = copy();
  const dropped = x.layout.VaultInternals.storage.pop().label;
  assert.equal(dropped, 'adoptVestingPeriod');
  assert.match(problemsOf(x), new RegExp(`VaultInternals' storage is not CascadeVault's: it lacks ${dropped} `));
  // a struct type with another member layout is another type, whatever its name
  const s = copy();
  const sharesType = s.layout.VaultInternals.storage.find((v) => v.label === '_shares').type;
  s.layout.VaultInternals.types[sharesType].members[1].slot = '2';
  assert.match(problemsOf(s), /VaultInternals' storage is not CascadeVault's: _shares at slot 0 offset 0/);
});

test('aMissingLayoutIsAnErrorNotAPass', () => {
  // a lens, a target or an Internals with no storage layout cannot be checked: surfaceProblems throws
  for (const name of ['CascadeDoorLens', 'CascadeVaultLens', 'VaultInternals', 'DoorInternals', 'CascadeVault', 'CascadeBase']) {
    const b = copy();
    delete b.layout[name];
    assert.throws(() => surfaceProblems(b), new RegExp(`${name} has no storage layout`), name);
  }
  // and loadBuild refuses an artifact without one (extra_output = ["storageLayout"] missing)
  const dir = mkdtempSync(join(tmpdir(), 'lens-surface-'));
  try {
    for (const [name, file] of Object.entries(ARTIFACTS)) {
      const artifact = JSON.parse(readFileSync(join(OUT, file, `${name}.json`), 'utf8'));
      if (name === 'CascadeDoorLens') delete artifact.storageLayout;
      mkdirSync(join(dir, file), { recursive: true });
      writeFileSync(join(dir, file, `${name}.json`), JSON.stringify(artifact));
    }
    assert.throws(() => loadBuild(dir), /CascadeDoorLens\.json has no storageLayout/);
    const r = spawnSync(process.execPath, [SCRIPT, '--out', dir], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /has no storageLayout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('theBuildChecksRunTheSurfaceCheck', () => {
  assert.ok(CHECKS.some((c) => c.script === 'lens-surface.mjs'));
});

// ---- R1-A L-3: the block time, an immutable each target keeps and each lens asks it for ----

test('aForwardedImmutableIsKeptByBothTargetsAndServedByBothLenses', () => {
  assert.deepEqual(FORWARDED, ['MS_PER_BLOCK']);
  for (const name of FORWARDED) {
    assert.ok(KEPT_ON_TARGET.includes(name), name);
    assert.ok(VAULT_LENS_VIEWS.includes(name) && DOOR_LENS_VIEWS.includes(name), name);
    for (const target of ['CascadeVault', 'CascadeFrontDoor', 'CascadeBase', 'CascadeBaseLens']) {
      assert.ok(names(REAL.abi[target]).includes(name), `${target} lacks ${name}`);
    }
  }
  // the real build passes; a target without it fails, naming it; any other CascadeBase getter still fails
  assert.equal(problemsOf(REAL), '');
  const gone = copy();
  gone.abi.CascadeFrontDoor = gone.abi.CascadeFrontDoor.filter((e) => e.name !== 'MS_PER_BLOCK');
  assert.match(problemsOf(gone), /CascadeFrontDoor has no MS_PER_BLOCK, which FORWARDED says it keeps and its lens asks it for/);
  const other = copy();
  other.abi.CascadeVault.push(structuredClone(fn(other.abi.CascadeVaultLens, 'EXECUTE_WINDOW')));
  assert.match(problemsOf(other), /CascadeVault has CascadeBase's getter EXECUTE_WINDOW\(\), which only the lenses serve/);
  // a lens without it fails
  const lens = copy();
  lens.abi.CascadeDoorLens = lens.abi.CascadeDoorLens.filter((e) => e.name !== 'MS_PER_BLOCK');
  assert.match(problemsOf(lens), /CascadeDoorLens does not serve MS_PER_BLOCK/);
});

// ---- Task 30's follow-up: the pause sweep's rows are the front door's whole non-view surface ----

test('theDoorsEntryPointsAreThePauseSweepsRows', () => {
  // the real build: the list is the door's ABI, 38 entry points today (Task 32's setMinPoolLiquidity the latest),
  // receive and the pure renounceOwnership among them, and no view
  assert.deepEqual(entryPointProblems(REAL.abi.CascadeFrontDoor, REAL.entryPoints), []);
  assert.equal(REAL.entryPoints.length, 38);
  assert.deepEqual([...REAL.entryPoints].sort(), entryPointsOf(REAL.abi.CascadeFrontDoor).sort());
  for (const s of [
    'receive()',
    'renounceOwnership()',
    'deliver(address,uint256)',
    'activateBridge(address)',
    'stampBySig(uint64,bytes)',
    'setMinPoolLiquidity(uint8,uint128)',
  ]) {
    assert.ok(REAL.entryPoints.includes(s), s);
  }
  assert.ok(!REAL.entryPoints.some((s) => /^(paused|openBatch|canClose|claimable)\(/.test(s)), 'no view is an entry point');
  // an entry point the door gains without a sweep row fails, naming it (a later task's setter, say); a view does not
  const gained = copy();
  gained.abi.CascadeFrontDoor.push({
    ...structuredClone(fn(gained.abi.CascadeFrontDoor, 'setKeeper')),
    name: 'setLaterLimit',
    inputs: [
      { name: 'index', type: 'uint8', internalType: 'uint8' },
      { name: 'value', type: 'uint128', internalType: 'uint128' },
    ],
  });
  assert.match(
    problemsOf(gained),
    /doorEntryPoints\(\) in test\/utils\/DoorEntryPoints\.sol lacks setLaterLimit\(uint8,uint128\), an entry point of CascadeFrontDoor/,
  );
  const view = copy();
  view.abi.CascadeFrontDoor.push({ ...structuredClone(fn(view.abi.CascadeFrontDoor, 'keeper')), name: 'newView' });
  assert.equal(problemsOf(view), '');
  // a row dropped from the list fails; so does one the door no longer has, one listed twice, and receive once gone
  const dropped = copy();
  dropped.entryPoints = dropped.entryPoints.filter((s) => s !== 'sweepPot(uint256)');
  assert.match(problemsOf(dropped), /lacks sweepPot\(uint256\), an entry point of CascadeFrontDoor/);
  const stale = copy();
  stale.entryPoints.push('setFloorFallbacks(uint256,uint256)');
  assert.match(problemsOf(stale), /lists setFloorFallbacks\(uint256,uint256\), which CascadeFrontDoor does not have/);
  const twice = copy();
  twice.entryPoints.push('claim()');
  assert.match(problemsOf(twice), /lists an entry point twice/);
  const noReceive = copy();
  noReceive.abi.CascadeFrontDoor = noReceive.abi.CascadeFrontDoor.filter((e) => e.type !== 'receive');
  assert.match(problemsOf(noReceive), /lists receive\(\), which CascadeFrontDoor does not have/);
  // a list never loaded is an error, never a pass
  const none = copy();
  delete none.entryPoints;
  assert.throws(() => surfaceProblems(none), /doorEntryPoints\(\) was not loaded/);
});

test('theEntryPointListParses', () => {
  const text = [
    'function doorEntryPoints() pure returns (string[] memory points) {',
    '    string[3] memory p = [',
    '        // a comment, "notThis()"',
    '        "deposit(uint256)",',
    '        "onBridgeMessage(uint64,address,bytes,uint256)",',
    '        "receive()"',
    '    ];',
    '    for (uint256 i; i < p.length; ++i) {',
    '        points[i] = p[i];',
    '    }',
    '}',
  ].join('\n');
  assert.deepEqual(parseEntryPoints(text), ['deposit(uint256)', 'onBridgeMessage(uint64,address,bytes,uint256)', 'receive()']);
  assert.throws(() => parseEntryPoints('function vaultLensViews() pure {}'), /has no doorEntryPoints\(\)/);
  // the check reads the real file, in its order
  assert.deepEqual(parseEntryPoints(readFileSync(join(here, '..', ENTRY_POINTS_FILE), 'utf8')), REAL.entryPoints);
  assert.equal(REAL.entryPoints[0], 'deposit(uint256)');
  assert.equal(REAL.entryPoints.at(-1), 'unpause()');
});

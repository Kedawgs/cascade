import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS } from './build-checks.mjs';
import { DEFAULT_DIR, generate, generateAll, MEMORY_ONLY, STRUCTS, TARGETS, upperSnake } from './gen-lens-layout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'gen-lens-layout.mjs');
const OUT = join(here, '..', 'out');

/** name => value of every `uint256 internal constant NAME = value;` in a generated file. */
function constants(text) {
  const map = new Map();
  for (const m of text.matchAll(/uint256 internal constant (\w+) = (\d+);/g)) map.set(m[1], Number(m[2]));
  return map;
}

/** The constants of one variable or one struct member, as [slot, offset, size]. */
const ofVar = (c, name) => [c.get(`SLOT_${name}`), c.get(`OFFSET_${name}`), c.get(`SIZE_${name}`)];
const ofMember = (c, prefix) => [c.get(`${prefix}_SLOT`), c.get(`${prefix}_OFFSET`), c.get(`${prefix}_SIZE`)];

// ---- the real build (forge build first) ----

test('regenerationMatchesTheCommittedFiles', () => {
  for (const { target, text } of generateAll(OUT)) {
    const committed = readFileSync(join(DEFAULT_DIR, target.file));
    assert.ok(committed.equals(Buffer.from(text)), `${target.file} differs from a fresh generation`);
  }
  const r = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /VaultLayout\.sol matches the build/);
  assert.match(r.stdout, /DoorLayout\.sol matches the build/);
});

test('structMembersAreGenerated', () => {
  const files = Object.fromEntries(generateAll(OUT).map(({ target, text }) => [target.library, constants(text)]));
  const vault = files.VaultLayout;
  const door = files.DoorLayout;
  // the token takes the vault's first slots; guardian sits at slot 5 in the vault, 3 in the front door (§8.1)
  assert.deepEqual(ofVar(vault, 'SHARES'), [0, 0, 64]);
  assert.deepEqual(ofVar(vault, 'GUARDIAN'), [5, 0, 20]);
  assert.deepEqual(ofVar(door, 'GUARDIAN'), [3, 0, 20]);
  // packed beside another variable: the offset and size say where in the slot
  assert.deepEqual(ofVar(vault, 'LAST_STAKE_AT'), [15, 20, 8]);
  assert.deepEqual(ofVar(door, 'MAX_REDEEMS'), [22, 12, 4]);
  // a leading underscore is dropped: _paused is PAUSED
  assert.deepEqual(ofVar(vault, 'PAUSED'), [3, 20, 1]);
  assert.equal(door.get('SLOT_KEEPER'), 28);
  // the scheduler's state (Task 7a) follows the bridges in CascadeBase, on both targets; the registries'
  // state is gone (Task 7b)
  assert.deepEqual(ofVar(vault, 'SCHEDULED'), [8, 0, 32]);
  assert.deepEqual(ofVar(vault, 'BRIDGE_KNOWN'), [9, 0, 32]);
  assert.deepEqual(ofVar(door, 'SCHEDULED'), [6, 0, 32]);
  assert.deepEqual(ofVar(door, 'BRIDGE_KNOWN'), [7, 0, 32]);
  // the exits machine's state (Task 8): one slot after bridgeKnown, the two clocks and the primary's hold
  for (const [lib, slot] of [[vault, 10], [door, 8]]) {
    assert.deepEqual(ofVar(lib, 'LAST_OWNER_CLOSE'), [slot, 0, 8]);
    assert.deepEqual(ofVar(lib, 'LAST_GUARDIAN_CLOSE'), [slot, 8, 8]);
    assert.deepEqual(ofVar(lib, 'PRIMARY_DISABLED_BY'), [slot, 16, 1]);
  }
  // the reward schedule's period (Task 15) packs beside its start, which moves the treasury and its cut to
  // the next slot; the owner's rewardVesting packs beside the payout delay
  assert.deepEqual(ofVar(vault, 'VESTING_START'), [20, 0, 8]);
  assert.deepEqual(ofVar(vault, 'VESTING_PERIOD'), [20, 8, 8]);
  // the last adoption's time (Task 16) takes a slot of its own after the variables before it. Task 23's staking
  // floors' fallbacks, constants now, gave up their two slots after claimGasRequired, so the unstake margin and the
  // last adoption's time each moved two slots down (42 -> 40, 43 -> 41), as did every variable after them
  assert.deepEqual(ofVar(vault, 'LAST_ADOPT_AT'), [41, 0, 8]);
  assert.deepEqual(ofVar(vault, 'UNSTAKE_MARGIN_RAO'), [40, 0, 32]);
  assert.deepEqual(ofVar(vault, 'CLAIM_GAS_REQUIRED'), [39, 0, 32]);
  for (const gone of ['FALLBACK_MIN_STAKE_RAO', 'FALLBACK_MIN_REMAIN_RAO']) {
    assert.equal(vault.get(`SLOT_${gone}`), undefined, gone);
  }
  assert.deepEqual(ofVar(vault, 'TREASURY'), [21, 0, 20]);
  assert.deepEqual(ofVar(vault, 'REWARD_CUT_BPS'), [21, 20, 2]);
  assert.deepEqual(ofVar(vault, 'PAYOUT_DELAY'), [29, 4, 8]);
  assert.deepEqual(ofVar(vault, 'REWARD_VESTING'), [29, 12, 8]);
  // the vault's own exits machine (Task 10): doorState takes frontDoorActive's slot, activeDoors follows,
  // then the vault's two holds share one slot; the front door has none of them
  assert.deepEqual(ofVar(vault, 'DOOR_STATE'), [22, 0, 32]);
  assert.deepEqual(ofVar(vault, 'ACTIVE_DOORS'), [23, 0, 32]);
  assert.deepEqual(ofVar(vault, 'PAUSED_BY'), [24, 0, 1]);
  assert.deepEqual(ofVar(vault, 'LAUNCH_DOOR_REMOVED_BY'), [24, 1, 1]);
  assert.equal(vault.get('SLOT_FRONT_DOOR_ACTIVE'), undefined, 'frontDoorActive is gone');
  for (const name of ['DOOR_STATE', 'ACTIVE_DOORS', 'PAUSED_BY', 'LAUNCH_DOOR_REMOVED_BY']) {
    assert.equal(door.get(`SLOT_${name}`), undefined, name);
  }
  for (const gone of ['PENDING_GUARDIAN', 'GUARDIAN_PROPOSED_AT', 'BRIDGE_PROPOSED_AT', 'FRONT_DOOR_PROPOSED_AT']) {
    assert.equal(vault.get(`SLOT_${gone}`), undefined, gone);
    assert.equal(door.get(`SLOT_${gone}`), undefined, gone);
  }

  // SharesData: Solidity's packing rules give these slots, offsets and sizes
  assert.deepEqual(ofMember(vault, 'SHARES_DATA_TOTAL_SUPPLY'), [0, 0, 32]);
  assert.deepEqual(ofMember(vault, 'SHARES_DATA_BALANCE_OF'), [1, 0, 32]);
  // PayoutBatch: uint64 + address share slot 0; uint64 + uint64 + 3 x uint32 share slot 1
  const batch = {
    SOURCE_CHAIN: [0, 0, 8],
    FRONT_DOOR: [0, 8, 20],
    BATCH_ID: [1, 0, 8],
    QUEUED_AT: [1, 8, 8],
    CURSOR: [1, 16, 4],
    COUNT: [1, 20, 4],
    CHUNK: [1, 24, 4],
    REMAINING: [2, 0, 32],
    PAYOUTS_HASH: [3, 0, 32],
  };
  for (const [member, at] of Object.entries(batch)) assert.deepEqual(ofMember(vault, `PAYOUT_BATCH_${member}`), at, member);
  assert.deepEqual(ofMember(vault, 'WINDOW_START'), [0, 0, 8]);
  assert.deepEqual(ofMember(vault, 'WINDOW_BURNED'), [1, 0, 32]);
  // Ledger (Task 5f): three words, 96 B. The unstake flag is transient, so in no storage layout: neither a
  // member nor a variable
  assert.equal(vault.get('SIZE_LEDGER'), 96);
  assert.equal(vault.get('OFFSET_LEDGER'), 0);
  const ledger = { PENDING: [0, 0, 32], BOOKED: [1, 0, 32], RAMPING: [2, 0, 32] };
  for (const [member, at] of Object.entries(ledger)) assert.deepEqual(ofMember(vault, `LEDGER_${member}`), at, member);
  assert.ok(![...vault.keys()].some((k) => k.includes('UNSTAKING')), 'no constant names the transient flag');
  // Item (Task 7a; readyBlock, R1-A L-3): one slot, two uint64, two one-byte enums, a bytes4 and a uint64, the
  // same in both targets; the transient execute flag is in no layout
  const item = {
    SCHEDULED_AT: [0, 0, 8],
    READY_AT: [0, 8, 8],
    CLASS: [0, 16, 1],
    KIND: [0, 17, 1],
    SELECTOR: [0, 18, 4],
    READY_BLOCK: [0, 22, 8],
  };
  for (const [member, at] of Object.entries(item)) {
    assert.deepEqual(ofMember(vault, `ITEM_${member}`), at, member);
    assert.deepEqual(ofMember(door, `ITEM_${member}`), at, member);
  }
  assert.ok(![...vault.keys(), ...door.keys()].some((k) => k.includes('EXECUTING')), 'no constant names the execute flag');
  // its fields are no longer variables of their own
  for (const gone of ['PENDING_PAYOUTS', 'BOOKED_STAKE', 'RAMPING_STAKE']) assert.equal(vault.get(`SLOT_${gone}`), undefined, gone);

  // only the shared structs of CascadeTypes.sol: the front door's own Batch and Delivery are not emitted
  // (a variable's constants start SLOT_, OFFSET_ or SIZE_; a member's end in them: depositSlot is SLOT_DEPOSIT_SLOT)
  const isVariable = (k) => /^(SLOT|OFFSET|SIZE)_/.test(k);
  assert.ok([...door.keys()].every((k) => isVariable(k) || k.startsWith('ITEM_')), 'the front door holds no shared struct but Item');
  assert.deepEqual(ofVar(door, 'DEPOSIT_SLOT'), [14, 0, 32]);
  assert.ok(![...vault.keys()].some((k) => k.startsWith('BATCH_') || k.startsWith('DELIVERY_')));
  // the list names the structs Tasks 5f and 7 add, so they are emitted as soon as they are in a layout
  assert.deepEqual([...STRUCTS].sort(), ['Holder', 'Item', 'Ledger', 'PayoutBatch', 'SharesData', 'Window']);
});

test('everyStructOfCascadeTypesIsGenerated', () => {
  // every struct declared in the shared layout file is in STRUCTS, so a struct a target's layout gains
  // gets its member constants; a struct STRUCTS names before its task declares it is one of those two
  const declared = [...readFileSync(join(here, '..', 'src', 'CascadeTypes.sol'), 'utf8').matchAll(/^struct (\w+) \{/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 3, 'CascadeTypes.sol declares structs');
  // (or, for a struct that only travels in memory as a library's argument, in MEMORY_ONLY)
  for (const name of declared) {
    assert.ok(STRUCTS.includes(name) || MEMORY_ONLY.includes(name), `${name} is declared in CascadeTypes.sol but not in STRUCTS or MEMORY_ONLY`);
  }
  for (const name of STRUCTS.filter((s) => !declared.includes(s))) assert.ok(['Ledger', 'Item'].includes(name), name);
  for (const name of MEMORY_ONLY) {
    assert.ok(declared.includes(name), `${name} is in MEMORY_ONLY but not declared`);
    assert.ok(!STRUCTS.includes(name), `${name} is in both lists`);
  }
  // and each one a target's layout holds is generated
  for (const { target, text, structs } of generateAll(OUT)) {
    for (const name of structs) assert.match(text, new RegExp(`// struct ${name}\\n`), `${target.file}: ${name}`);
  }
});

test('theBuildChecksRunTheLayoutCheck', () => {
  assert.ok(CHECKS.some((c) => c.script === 'gen-lens-layout.mjs' && c.args.includes('--check')));
});

// ---- a fake build ----

const valueType = (label, bytes) => ({ encoding: 'inplace', label, numberOfBytes: String(bytes) });
const entry = (astId, label, slot, offset, type, contract = 'src/X.sol:X') => ({ astId, contract, label, offset, slot: String(slot), type });

/** A storage layout shaped like solc's: a token struct, packed variables, a mapping to a shared
 * struct, a contract-level struct, and (with `ledger`) a Ledger struct. `ast` shifts every astId and
 * struct type id, as an unrelated edit to the sources does. */
function fakeLayout({ ast = 100, guardianSlot = 5, frontDoorOffset = 8, ledger = false, extra = [] } = {}) {
  const shares = `t_struct(SharesData)${ast + 1}_storage`;
  const batch = `t_struct(PayoutBatch)${ast + 2}_storage`;
  const own = `t_struct(Delivery)${ast + 3}_storage`;
  const led = `t_struct(Ledger)${ast + 4}_storage`;
  const types = {
    t_address: valueType('address', 20),
    t_bool: valueType('bool', 1),
    t_uint64: valueType('uint64', 8),
    t_uint256: valueType('uint256', 32),
    't_mapping(t_address,t_uint256)': { encoding: 'mapping', key: 't_address', label: 'mapping(address => uint256)', numberOfBytes: '32', value: 't_uint256' },
    [`t_mapping(t_bytes32,${batch})`]: { encoding: 'mapping', key: 't_bytes32', label: 'mapping(bytes32 => struct PayoutBatch)', numberOfBytes: '32', value: batch },
    [shares]: {
      encoding: 'inplace',
      label: 'struct SharesData',
      numberOfBytes: '64',
      members: [entry(ast + 10, 'totalSupply', 0, 0, 't_uint256'), entry(ast + 11, 'balanceOf', 1, 0, 't_mapping(t_address,t_uint256)')],
    },
    [batch]: {
      encoding: 'inplace',
      label: 'struct PayoutBatch',
      numberOfBytes: '64',
      members: [
        entry(ast + 12, 'sourceChain', 0, 0, 't_uint64'),
        entry(ast + 13, 'frontDoor', 0, frontDoorOffset, 't_address'),
        entry(ast + 14, 'remaining', 1, 0, 't_uint256'),
      ],
    },
    [own]: { encoding: 'inplace', label: 'struct X.Delivery', numberOfBytes: '32', members: [entry(ast + 15, 'deadline', 0, 0, 't_uint64')] },
  };
  const storage = [
    entry(ast + 20, '_shares', 0, 0, shares),
    entry(ast + 21, '_owner', 2, 0, 't_address'),
    entry(ast + 22, '_paused', 2, 20, 't_bool'),
    entry(ast + 23, 'guardian', guardianSlot, 0, 't_address'),
    entry(ast + 24, 'guardianProposedAt', guardianSlot, 20, 't_uint64'),
    entry(ast + 25, 'payoutBatches', 9, 0, `t_mapping(t_bytes32,${batch})`),
    entry(ast + 26, 'deliveryOf', 10, 0, own),
    ...extra.map((e, i) => entry(ast + 40 + i, ...e)),
  ];
  if (ledger) {
    types[led] = { encoding: 'inplace', label: 'struct Ledger', numberOfBytes: '32', members: [entry(ast + 16, 'pending', 0, 0, 't_uint64'), entry(ast + 17, 'booked', 0, 8, 't_uint64')] };
    storage.push(entry(ast + 27, 'ledger', 11, 0, led));
  }
  return { storage, types };
}

const vaultTarget = TARGETS.find((t) => t.contract === 'CascadeVault');
const COMPILER = '0.8.38+commit.1835d247';

/** A forge out/ directory holding both targets' artifacts, and an empty generated directory. */
function fakeBuild(opts = {}, doorOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gen-lens-layout-'));
  writeBuild(dir, opts, doorOpts);
  return dir;
}
function writeBuild(dir, opts = {}, doorOpts = {}) {
  for (const [target, layout] of [
    [vaultTarget, fakeLayout(opts)],
    [TARGETS.find((t) => t.contract === 'CascadeFrontDoor'), fakeLayout({ guardianSlot: 3, ...doorOpts })],
  ]) {
    mkdirSync(join(dir, 'out', target.source), { recursive: true });
    const artifact = { abi: [], metadata: { compiler: { version: COMPILER } }, storageLayout: layout };
    writeFileSync(join(dir, 'out', target.source, `${target.contract}.json`), JSON.stringify(artifact));
  }
}
const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, '--out', join(dir, 'out'), '--dir', join(dir, 'gen'), ...args], { encoding: 'utf8' });
const vaultFile = (dir) => join(dir, 'gen', vaultTarget.file);

test('aLayoutChangeFailsTheCheck', () => {
  const dir = fakeBuild();
  // nothing generated yet
  let r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /VaultLayout\.sol is missing/);
  assert.equal(run(dir).status, 0);
  assert.equal(run(dir, '--check').status, 0, 'a fresh generation passes');

  // a variable moved to another slot: the check fails, names the constant and leaves the file alone
  const before = readFileSync(vaultFile(dir));
  writeBuild(dir, { guardianSlot: 6 });
  r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /VaultLayout\.sol is stale/);
  assert.match(r.stderr, /SLOT_GUARDIAN = 6/);
  assert.match(r.stderr, /node script\/gen-lens-layout\.mjs/);
  assert.ok(readFileSync(vaultFile(dir)).equals(before), '--check regenerates elsewhere, never over the committed file');
  assert.match(r.stdout, /DoorLayout\.sol matches the build/, 'the unchanged target still passes');
  assert.equal(run(dir).status, 0);
  assert.equal(run(dir, '--check').status, 0);

  // a struct member moved inside its slot
  writeBuild(dir, { guardianSlot: 6, frontDoorOffset: 12 });
  r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /PAYOUT_BATCH_FRONT_DOOR_OFFSET = 12/);
  assert.equal(run(dir).status, 0);

  // a new variable
  writeBuild(dir, { guardianSlot: 6, frontDoorOffset: 12, extra: [['keeper', 12, 0, 't_address']] });
  r = run(dir, '--check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SLOT_KEEPER = 12/);
  assert.equal(run(dir).status, 0);

  // any byte: a hand edit, CRLF line endings, a lost final newline
  const good = readFileSync(vaultFile(dir), 'utf8');
  for (const [edit, why] of [
    [good.replace('library VaultLayout {', 'library VaultLayout  {'), /stale/],
    [good.replace(/\n/g, '\r\n'), /line endings/],
    [good.slice(0, -1), /stale/],
  ]) {
    writeFileSync(vaultFile(dir), edit);
    r = run(dir, '--check');
    assert.equal(r.status, 1);
    assert.match(r.stderr, why);
  }
  writeFileSync(vaultFile(dir), good);
  assert.equal(run(dir, '--check').status, 0);
});

test('a struct the list names is generated once it is in a layout (Ledger, Task 5f)', () => {
  const without = constants(generate(fakeLayout(), vaultTarget, COMPILER));
  assert.ok(![...without.keys()].some((k) => k.startsWith('LEDGER_')));
  const withLedger = constants(generate(fakeLayout({ ledger: true }), vaultTarget, COMPILER));
  assert.deepEqual(ofVar(withLedger, 'LEDGER'), [11, 0, 32]);
  assert.deepEqual(ofMember(withLedger, 'LEDGER_PENDING'), [0, 0, 8]);
  assert.deepEqual(ofMember(withLedger, 'LEDGER_BOOKED'), [0, 8, 8]);
  // a contract-level struct is not one of the shared structs
  assert.ok(![...withLedger.keys()].some((k) => k.startsWith('DELIVERY_')));
  assert.deepEqual(ofVar(withLedger, 'DELIVERY_OF'), [10, 0, 32]);
});

test('aMemoryOnlyStructInALayoutFails (BatchIn, Task 5e; WalkParams, Task 5f; PayoutIn and PayoutPlan, Task 5g)', () => {
  // BatchIn is L1's argument, WalkParams L2's, PayoutIn and PayoutPlan L3's, never storage: a target that stored
  // one would need its member constants
  assert.deepEqual(MEMORY_ONLY, ['BatchIn', 'WalkParams', 'PayoutIn', 'PayoutPlan']);
  const layout = fakeLayout();
  layout.storage.push({ label: 'lastBatch', slot: '20', offset: 0, type: 't_struct(BatchIn)99_storage' });
  layout.types['t_struct(BatchIn)99_storage'] = {
    encoding: 'inplace',
    label: 'struct BatchIn',
    numberOfBytes: '32',
    members: [{ label: 'key', slot: '0', offset: 0, type: 't_bytes32' }],
  };
  layout.types.t_bytes32 = valueType('bytes32', 32);
  assert.throws(() => generate(layout, vaultTarget, COMPILER), /BatchIn only travels in memory/);
  // and L3's plan
  const plan = fakeLayout();
  plan.storage.push({ label: 'lastPlan', slot: '20', offset: 0, type: 't_struct(PayoutPlan)98_storage' });
  plan.types['t_struct(PayoutPlan)98_storage'] = {
    encoding: 'inplace',
    label: 'struct PayoutPlan',
    numberOfBytes: '32',
    members: [{ label: 'sum', slot: '0', offset: 0, type: 't_uint256' }],
  };
  plan.types.t_uint256 = valueType('uint256', 32);
  assert.throws(() => generate(plan, vaultTarget, COMPILER), /PayoutPlan only travels in memory/);
});

test('astIds and type ids do not reach the output', () => {
  const a = generate(fakeLayout({ ast: 100 }), vaultTarget, COMPILER);
  const b = generate(fakeLayout({ ast: 54_000 }), vaultTarget, COMPILER);
  assert.equal(a, b);
  assert.ok(!/\d{3,}_storage|astId|t_struct|t_mapping/.test(a));
});

test('the output is canonical: stable order, LF, one final newline', () => {
  const layout = fakeLayout({ ledger: true });
  const text = generate(layout, vaultTarget, COMPILER);
  const shuffled = {
    storage: [...layout.storage].reverse(),
    types: Object.fromEntries(Object.entries(layout.types).reverse()),
  };
  assert.equal(generate(shuffled, vaultTarget, COMPILER), text);
  assert.ok(!text.includes('\r'));
  assert.ok(text.endsWith('}\n') && !text.endsWith('\n\n'));
  // variables in slot order, then offset; structs in the list's order
  const names = [...constants(text).keys()].filter((k) => k.startsWith('SLOT_'));
  assert.deepEqual(names, ['SLOT_SHARES', 'SLOT_OWNER', 'SLOT_PAUSED', 'SLOT_GUARDIAN', 'SLOT_GUARDIAN_PROPOSED_AT', 'SLOT_PAYOUT_BATCHES', 'SLOT_DELIVERY_OF', 'SLOT_LEDGER']);
  const structs = [...text.matchAll(/^ {4}\/\/ struct (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(structs, STRUCTS.filter((s) => ['SharesData', 'PayoutBatch', 'Ledger'].includes(s)));
  assert.match(text, /^\/\/ SPDX-License-Identifier: MIT\npragma solidity 0\.8\.38;\n/);
  assert.match(text, /\nlibrary VaultLayout \{\n/);
});

test('two variables whose constants would share a name fail', () => {
  const layout = fakeLayout({ extra: [['owner', 12, 0, 't_address']] });
  assert.throws(() => generate(layout, vaultTarget, COMPILER), /SLOT_OWNER/);
});

test('an artifact without a storage layout fails, naming the setting', () => {
  const dir = fakeBuild();
  const path = join(dir, 'out', vaultTarget.source, `${vaultTarget.contract}.json`);
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  delete artifact.storageLayout;
  writeFileSync(path, JSON.stringify(artifact));
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /extra_output/);
  assert.ok(!existsSync(vaultFile(dir)));
});

test('upperSnake', () => {
  assert.equal(upperSnake('guardian'), 'GUARDIAN');
  assert.equal(upperSnake('guardianProposedAt'), 'GUARDIAN_PROPOSED_AT');
  assert.equal(upperSnake('_shares'), 'SHARES');
  assert.equal(upperSnake('_pendingOwner'), 'PENDING_OWNER');
  assert.equal(upperSnake('maxDailyOutflowBps'), 'MAX_DAILY_OUTFLOW_BPS');
  assert.equal(upperSnake('minUsdcPerTAO'), 'MIN_USDC_PER_TAO');
  assert.equal(upperSnake('SharesData'), 'SHARES_DATA');
  assert.equal(upperSnake('v2Peer'), 'V2_PEER');
  assert.equal(upperSnake('DOMAIN_SEPARATOR'), 'DOMAIN_SEPARATOR');
});

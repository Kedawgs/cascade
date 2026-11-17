// The lenses' read surface (spec §8.1, ruling DB3): each lens serves what it must, as its target
// declares it, and the lens parity tests cover every view it serves. Read from the build in out/ and
// from the parity tests' view lists (test/utils/LensViews.sol). A lens must:
//   - take only its target's address, hold no state, and have only views (rev 12 L-1, rev 13 N-2);
//   - serve every state variable of its target (the vault's; the front door's CascadeBase state and
//     its keeper), under the variable's name or the names in SERVED_AS, except NOT_SERVED (OpenZeppelin's
//     own state, whose getters the targets keep) and, on the vault, INTERNAL_ONLY; a BY_MEMBER struct
//     variable (the vault's ledger, Task 5f) member by member, each member named in SERVED_AS or
//     INTERNAL_ONLY as `<variable>.<member>`, and neither list naming one the layout does not hold;
//   - serve every getter its target has (on the front door, CascadeBase's) except KEPT_ON_TARGET, and
//     every view of VAULT_LENS_VIEWS or DOOR_LENS_VIEWS, which stay required once Task 5d makes the
//     targets' getters internal;
//   - give each view the target getter's arguments and return types, when the target has one, and,
//     for a state variable's view, those of the getter its declared type gives (the anchor once the
//     target's getter is gone);
//   - have each view exposed by the target's test-only subclass (VaultInternals, DoorInternals) as
//     exposed_<name>, with the same arguments and return types, so the parity tests can compare;
//   - be listed, view for view, in the parity tests' list (vaultLensViews(), doorLensViews()).
// And:
//   - VaultInternals also exposes each INTERNAL_ONLY variable or member, under the name INTERNAL_ONLY gives;
//   - VaultInternals and DoorInternals have exactly their target's storage layout (label, slot,
//     offset and type, struct members included): they add, drop or move no storage;
//   - neither target, nor CascadeBase, has a getter of CascadeBase's state or constants, which
//     CascadeBaseLens serves on both lenses (Task 5d-1), and baseLensViews() lists exactly those;
//   - the vault has no view but KEPT_ON_TARGET's: every other one is the vault lens's alone (Task
//     5d-2), while the front door keeps its own getters;
//   - the front door's entry points, every function of its ABI that is not a view (its own and
//     CascadeBase's, pure ones included) and receive, are exactly doorEntryPoints() in
//     test/utils/DoorEntryPoints.sol, which the pause sweep runs row for row (spec §3.5, I-20; Task 30's
//     follow-up): an entry point the door gains or loses without a sweep row fails here.
// A missing artifact, storage layout, view list or entry-point list is an error, never a pass.
// Usage: node script/lens-surface.mjs [--out <forge out dir>]   (exit 1 on any problem)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT = join(ROOT, 'out');
/** The parity tests' view lists, relative to contracts/. */
export const LISTS_FILE = 'test/utils/LensViews.sol';
/** The front door's entry points for the pause sweep (doorEntryPoints()), relative to contracts/. */
export const ENTRY_POINTS_FILE = 'test/utils/DoorEntryPoints.sol';

/** What each target keeps for wallets, explorers, Safe tooling and verify, and its entry points that
 * the compiler marks pure (the reverting token stubs, renounceOwnership): no lens view required. */
export const KEPT_ON_TARGET = [
  'name',
  'symbol',
  'decimals',
  'balanceOf',
  'totalSupply',
  'allowance',
  'transfer',
  'transferFrom',
  'approve',
  'owner',
  'pendingOwner',
  'paused',
  'launchChain',
  'extsload',
  'renounceOwnership',
  'MS_PER_BLOCK',
];

/** CascadeBase's getters both targets keep and both lenses serve by asking the target (R1-A L-3): an
 * immutable, which extsload cannot read and no formula gives (MS_PER_BLOCK, the scheduler's block
 * floor). Each is in KEPT_ON_TARGET, required of both lenses, and the one exception to "CascadeBase's getters
 * are the lenses' alone". */
export const FORWARDED = ['MS_PER_BLOCK'];

/** State the lenses do not serve (ruling DB3c's deny-list): OpenZeppelin's own, whose getters
 * (owner, pendingOwner, paused) the targets keep, and the reentrancy lock. Transient variables are
 * not in a storage layout. */
export const NOT_SERVED = ['_owner', '_pendingOwner', '_paused', '_status'];

/** Vault state no lens serves: a state variable, or a BY_MEMBER struct variable's member as
 * `<variable>.<member>`, each exposed by VaultInternals as exposed_<exposed>. Empty since R2 F4: the booked
 * stake left the list in Task 12, when the lens began serving it (bookedStake(), in rao, ruling A19), and the
 * ramping stake in R2 F4 (rampingStake(), in wei, so off-chain code can compute the outflow base from the
 * lens alone). The unstake flag (v3.1's _unstaking) is transient since Task 5f's fix, in no storage layout,
 * so in no list here. */
export const INTERNAL_ONLY = {};

/** State served under other names than its own: a state variable, or a BY_MEMBER struct variable's
 * member as `<variable>.<member>`. */
export const SERVED_AS = {
  _shares: ['totalSupply', 'balanceOf'],
  payoutBatches: ['getPayoutBatch'],
  'ledger.pending': ['pendingPayouts'],
  'ledger.booked': ['bookedStake'],
  'ledger.ramping': ['rampingStake'],
  // R4: each holder's record, its redeem origin and its fresh shares (the door hold), served as two views
  holders: ['redeemOrigin', 'freshShares'],
};

/** Struct state variables a lens accounts for member by member (the vault's ledger, Task 5f): each member
 * is served (SERVED_AS) or internal-only (INTERNAL_ONLY), so a member the struct gains fails the check
 * until it is one or the other. */
export const BY_MEMBER = ['ledger'];

/** The vault lens's views that are not state variables (spec §8.1's computed views and constants, as
 * the vault has them today), required whether or not the vault still has a getter. Each task that
 * adds one (visibleStakeRao, missingStakeRao, exitsOpen, DOMAIN_SEPARATOR, …) adds it here. */
export const VAULT_LENS_VIEWS = [
  'ADDRESS_MAPPING',
  'ED_RESERVE',
  'EXECUTE_WINDOW',
  'EXIT_GAS_RESERVE',
  'FALLBACK_MIN_STAKE_RAO',
  'FALLBACK_MIN_REMAIN_RAO',
  'GUARDIAN_DELAY',
  'KEEPER_FALLBACK',
  'MAX_CLAIM_GAS',
  'MAX_REWARD_CUT_BPS',
  'MIN_CLAIM_GAS',
  'PARAM_DELAY',
  'RAO',
  'REGISTRY_DELAY',
  'STAKING',
  'coldkey',
  'batchKey',
  'peerId',
  'hotkeyCount',
  'visibleStakeRao',
  'missingStakeRao',
  'surplusStakeRao',
  'stakeMissing',
  'unlistedStakeRao',
  'grossAssets',
  'unvestedRewards',
  'totalAssets',
  'price',
  'minStakeRao',
  'minRemainRao',
  'ownerHold',
  'guardianHold',
  'exitsOpen',
  'STAMP_TYPEHASH',
  'STAMP_MAX_TTL',
  'DOMAIN_SEPARATOR',
  'MS_PER_BLOCK',
];

/** The door lens's views beyond CascadeBase's state: its constants, the front door's keeper, the exits
 * machine's computed views (spec §3.6: its holds, the primary's alone) and the stamp's constants and
 * recomputed domain separator. */
export const DOOR_LENS_VIEWS = [
  'EXECUTE_WINDOW',
  'GUARDIAN_DELAY',
  'PARAM_DELAY',
  'REGISTRY_DELAY',
  'keeper',
  'ownerHold',
  'guardianHold',
  'exitsOpen',
  'STAMP_TYPEHASH',
  'STAMP_MAX_TTL',
  'DOMAIN_SEPARATOR',
  'MS_PER_BLOCK',
];

/** Each lens: its target, whose getters fix its views' types; the target's test-only subclass; the
 * parity list; the state it must serve (the target's own, or only CascadeBase's plus `extra`); the
 * target whose ABI lists the getters it must serve; and whether the target keeps no view but
 * KEPT_ON_TARGET's (the vault, from Task 5d-2; the front door keeps its own getters). */
export const LENSES = [
  {
    lens: 'CascadeVaultLens',
    target: 'CascadeVault',
    internals: 'VaultInternals',
    list: 'vaultLensViews',
    state: 'CascadeVault',
    getters: 'CascadeVault',
    required: VAULT_LENS_VIEWS,
    internalOnly: INTERNAL_ONLY,
    keepsOnlyKept: true,
  },
  {
    lens: 'CascadeDoorLens',
    target: 'CascadeFrontDoor',
    internals: 'DoorInternals',
    list: 'doorLensViews',
    state: 'CascadeBase',
    getters: 'CascadeBase',
    required: DOOR_LENS_VIEWS,
    internalOnly: {},
    keepsOnlyKept: false,
  },
];

/** The lenses' shared part, which serves CascadeBase's getters on both. */
export const BASE_LENS = 'CascadeBaseLens';

/** The artifacts read, by contract name: out/<file>/<name>.json. */
export const ARTIFACTS = {
  CascadeVault: 'CascadeVault.sol',
  CascadeFrontDoor: 'CascadeFrontDoor.sol',
  CascadeBase: 'CascadeBase.sol',
  CascadeBaseLens: 'CascadeBaseLens.sol',
  CascadeVaultLens: 'CascadeVaultLens.sol',
  CascadeDoorLens: 'CascadeDoorLens.sol',
  VaultInternals: 'VaultInternals.sol',
  DoorInternals: 'DoorInternals.sol',
};

/** The parity tests' view lists in LISTS_FILE: one per lens, and CascadeBaseLens's. */
const LISTS = ['vaultLensViews', 'doorLensViews', 'baseLensViews'];

/** `_shares` -> its served names; `_paused` -> ['paused']; `ledger.pending` -> ['pendingPayouts']. */
export function servedNames(label) {
  return SERVED_AS[label] ?? [label.replace(/^_+/, '')];
}

/** A parameter's canonical type: tuples spelled out member by member. */
function typeOf(p) {
  if (!p.type.startsWith('tuple')) return p.type;
  return `(${p.components.map(typeOf).join(',')})${p.type.slice('tuple'.length)}`;
}
const types = (params) => `(${params.map(typeOf).join(',')})`;
const signature = (f) => `${f.name}${types(f.inputs)}`;
const functions = (abi) => abi.filter((e) => e.type === 'function');
const views = (abi) => functions(abi).filter((f) => f.stateMutability === 'view' || f.stateMutability === 'pure');

/** Each `"name(types)"` string of vaultLensViews(), doorLensViews() and baseLensViews() in the lists
 * file's text. */
export function parseViewLists(text) {
  const lists = {};
  for (const name of LISTS) {
    const start = text.indexOf(`function ${name}()`);
    if (start === -1) throw new Error(`${LISTS_FILE} has no ${name}()`);
    const end = text.indexOf('\n}', start);
    const body = text.slice(start, end === -1 ? undefined : end).replace(/\/\/.*$/gm, '');
    lists[name] = [...body.matchAll(/"([A-Za-z_]\w*\([\w,]*\))"/g)].map((m) => m[1]);
  }
  return lists;
}

/** Each `"name(types)"` string of doorEntryPoints() in the entry-point file's text, in order. */
export function parseEntryPoints(text) {
  const start = text.indexOf('function doorEntryPoints()');
  if (start === -1) throw new Error(`${ENTRY_POINTS_FILE} has no doorEntryPoints()`);
  const end = text.indexOf('\n}', start);
  const body = text.slice(start, end === -1 ? undefined : end).replace(/\/\/.*$/gm, '');
  return [...body.matchAll(/"([A-Za-z_]\w*\([\w,]*\))"/g)].map((m) => m[1]);
}

/** The entry points of a contract's ABI: each function that is not a view, as "name(types)", and
 * "receive()" and "fallback()" when it has them. A view changes nothing, so no pause can matter to it. */
export function entryPointsOf(abi) {
  const points = functions(abi).filter((f) => f.stateMutability !== 'view').map(signature);
  for (const kind of ['receive', 'fallback']) if (abi.some((e) => e.type === kind)) points.push(`${kind}()`);
  return points;
}

/** Each difference between doorEntryPoints() and the front door's ABI, as sentences; throws when the
 * list was not loaded. */
export function entryPointProblems(abi, listed) {
  if (!Array.isArray(listed)) throw new Error(`${ENTRY_POINTS_FILE}'s doorEntryPoints() was not loaded`);
  const has = new Set(entryPointsOf(abi));
  const problems = [];
  const where = `doorEntryPoints() in ${ENTRY_POINTS_FILE}`;
  for (const s of has) if (!listed.includes(s)) problems.push(`${where} lacks ${s}, an entry point of CascadeFrontDoor`);
  for (const s of listed) if (!has.has(s)) problems.push(`${where} lists ${s}, which CascadeFrontDoor does not have`);
  if (new Set(listed).size !== listed.length) problems.push(`${where} lists an entry point twice`);
  return problems;
}

/** Everything the check reads, from the build in `outDir`, the lists file and the entry-point file. */
export function loadBuild(outDir = DEFAULT_OUT, listsFile = join(ROOT, LISTS_FILE), entryPointsFile = join(ROOT, ENTRY_POINTS_FILE)) {
  const abi = {};
  const layout = {};
  for (const [name, file] of Object.entries(ARTIFACTS)) {
    const path = join(outDir, file, `${name}.json`);
    if (!existsSync(path)) throw new Error(`${path} is missing: run forge build first`);
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    if (!artifact.storageLayout) {
      throw new Error(`${path} has no storageLayout: foundry.toml's [profile.default] needs extra_output = ["storageLayout"]; then forge build`);
    }
    abi[name] = artifact.abi;
    layout[name] = artifact.storageLayout;
  }
  return {
    abi,
    layout,
    lists: parseViewLists(readFileSync(listsFile, 'utf8')),
    entryPoints: parseEntryPoints(readFileSync(entryPointsFile, 'utf8')),
  };
}

/** `name`'s storage layout in `build`; throws when the build has none (no layout proves nothing). */
function layoutOf(build, name) {
  const layout = build.layout[name];
  if (!layout || !Array.isArray(layout.storage)) throw new Error(`${name} has no storage layout in the build`);
  return layout;
}

/** A storage type as `types` declares it, without the AST ids in its identifier: its label, encoding
 * and size, a struct's members (each with its slot, offset and type), a mapping's key and value, an
 * array's base. Two layouts compiled apart can number one struct differently; this compares them. */
function canonicalType(types, id) {
  const t = types?.[id];
  if (!t) throw new Error(`the storage layout has no type ${id}`);
  let c = `${t.label}[${t.encoding},${t.numberOfBytes}]`;
  if (t.members) c += `{${t.members.map((m) => `${m.label}@${m.slot}+${m.offset}:${canonicalType(types, m.type)}`).join(';')}}`;
  if (t.key) c += `(${canonicalType(types, t.key)}=>${canonicalType(types, t.value)})`;
  if (t.base) c += `<${canonicalType(types, t.base)}>`;
  return c;
}

/** The ABI type of a value of storage type `t`, as a getter returns it; null for a struct. */
function abiTypeOf(t) {
  const label = t.label;
  if (label.startsWith('struct ')) return null;
  if (label.startsWith('contract ') || label.startsWith('interface ') || label === 'address payable') return 'address';
  if (label.startsWith('enum ')) return 'uint8';
  return label;
}

/** The arguments and return types of the compiler's getter of a state variable of storage type `id`:
 * a mapping is read by its key and an array by a uint256 index, down to a value; null when that
 * value is a struct (whose views have the lens's own shape, as getPayoutBatch and burnWindows do). */
function getterTypesOf(types, id) {
  const inputs = [];
  let t = types[id];
  for (;;) {
    if (t.encoding === 'mapping') {
      inputs.push(abiTypeOf(types[t.key]));
      t = types[t.value];
    } else if (t.base) {
      inputs.push('uint256');
      t = types[t.base];
    } else {
      break;
    }
  }
  const output = abiTypeOf(t);
  return output && !inputs.includes(null) ? { inputs: `(${inputs.join(',')})`, outputs: `(${output})` } : null;
}

/** The state a lens accounts for in `layout`: each state variable as { label, type }, and in place of a
 * BY_MEMBER struct variable each of its members as { label: '<variable>.<member>', type, member: '<variable>' }. */
function stateEntries(layout, problems) {
  const entries = [];
  for (const v of layout.storage) {
    if (!BY_MEMBER.includes(v.label)) {
      entries.push({ label: v.label, type: v.type });
      continue;
    }
    const t = layout.types?.[v.type];
    if (!t?.members) {
      problems.push(`${v.label} is in BY_MEMBER but is not a struct in the storage layout`);
      continue;
    }
    for (const m of t.members) entries.push({ label: `${v.label}.${m.label}`, type: m.type, member: v.label });
  }
  return entries;
}

/** Every difference between `internals`' storage layout and `target`'s, as sentences: a test-only
 * subclass must add, drop and move nothing, so the lens's slots read the same in both. */
function storageProblems(build, internals, target) {
  const want = layoutOf(build, target);
  const got = layoutOf(build, internals);
  const describe = (layout, v) => `${v.label} at slot ${v.slot} offset ${v.offset} (${layout.types?.[v.type]?.label ?? v.type})`;
  const head = `${internals}' storage is not ${target}'s:`;
  const problems = [];
  for (let i = 0; i < Math.max(want.storage.length, got.storage.length); i++) {
    const w = want.storage[i];
    const g = got.storage[i];
    if (!w) {
      problems.push(`${head} it adds ${describe(got, g)}`);
    } else if (!g) {
      problems.push(`${head} it lacks ${describe(want, w)}`);
    } else if (
      g.label !== w.label ||
      String(g.slot) !== String(w.slot) ||
      g.offset !== w.offset ||
      canonicalType(got.types, g.type) !== canonicalType(want.types, w.type)
    ) {
      const same = describe(got, g) === describe(want, w);
      problems.push(`${head} ${describe(got, g)}, ${target} has ${describe(want, w)}${same ? ', with another layout of that type' : ''}`);
    }
  }
  return problems;
}

/** Each difference between a parity list and the views it must equal, as sentences. */
function listProblems(list, listed, contract, served) {
  if (!listed) throw new Error(`${LISTS_FILE} has no ${list}()`);
  const problems = [];
  for (const s of served) if (!listed.includes(s)) problems.push(`${list}() in ${LISTS_FILE} lacks ${s}, which ${contract} serves`);
  for (const s of listed) if (!served.has(s)) problems.push(`${list}() in ${LISTS_FILE} lists ${s}, which ${contract} does not serve`);
  if (new Set(listed).size !== listed.length) problems.push(`${list}() in ${LISTS_FILE} lists a view twice`);
  return problems;
}

/** Every problem with the lenses' surface in `build` (loadBuild's shape), as sentences; [] is a pass. */
export function surfaceProblems(build) {
  const problems = [];
  for (const L of LENSES) {
    const lensAbi = build.abi[L.lens];
    const lensViews = functions(lensAbi).filter((f) => f.name !== 'target');
    const byName = new Map(lensViews.map((f) => [f.name, f]));

    // read-only, stateless, built on its target alone
    const ctor = lensAbi.find((e) => e.type === 'constructor');
    const ctorTypes = ctor ? types(ctor.inputs) : '()';
    if (ctorTypes !== '(address)') problems.push(`${L.lens}'s constructor must take only its target's address, not ${ctorTypes}`);
    for (const v of layoutOf(build, L.lens).storage) problems.push(`${L.lens} must hold no state, but declares ${v.label}`);
    for (const f of functions(lensAbi)) {
      if (f.stateMutability !== 'view' && f.stateMutability !== 'pure') {
        problems.push(`${L.lens}.${signature(f)} is ${f.stateMutability}: a lens has only views`);
      }
    }
    const target = functions(lensAbi).find((f) => f.name === 'target');
    if (!target || types(target.inputs) !== '()' || types(target.outputs) !== '(address)') {
      problems.push(`${L.lens} has no target() returning its target's address`);
    }

    // what it must serve
    const state = layoutOf(build, L.state);
    const entries = stateEntries(state, problems);
    const held = new Set(entries.map((e) => e.label));
    for (const label of Object.keys(L.internalOnly)) {
      if (!held.has(label)) problems.push(`INTERNAL_ONLY names ${label}, which ${L.state}'s storage does not hold`);
    }
    for (const label of Object.keys(SERVED_AS).filter((x) => x.includes('.'))) {
      const variable = label.slice(0, label.indexOf('.'));
      if (state.storage.some((v) => v.label === variable) && !held.has(label)) {
        problems.push(`SERVED_AS names ${label}, which ${L.state}'s storage does not hold`);
      }
    }
    const required = new Map();
    for (const e of entries) {
      if (NOT_SERVED.includes(e.label) || e.label in L.internalOnly) continue;
      if (e.member && !(e.label in SERVED_AS)) {
        problems.push(`${e.label}, a member of ${e.member}, is neither served (SERVED_AS) nor internal-only (INTERNAL_ONLY)`);
        continue;
      }
      for (const name of servedNames(e.label)) required.set(name, `the state variable ${e.label}`);
    }
    for (const f of views(build.abi[L.getters])) {
      if (!KEPT_ON_TARGET.includes(f.name)) required.set(f.name, `${L.getters}'s getter ${signature(f)}`);
    }
    for (const name of L.required) required.set(name, 'spec §8.1');
    for (const [name, why] of required) {
      if (!byName.has(name)) problems.push(`${L.lens} does not serve ${name} (${why})`);
    }

    // as the target's getter has it, as the state variable's declared type gives it, and exposed by
    // the target's test-only subclass
    const targetViews = new Map(views(build.abi[L.target]).map((f) => [f.name, f]));
    // (a member served under one name is held to its own type, as a variable is)
    const declared = new Map();
    for (const e of entries) {
      if (NOT_SERVED.includes(e.label) || e.label in L.internalOnly) continue;
      if (e.member ? servedNames(e.label).length !== 1 || !(e.label in SERVED_AS) : e.label in SERVED_AS) continue;
      const getter = getterTypesOf(state.types, e.type);
      if (getter) declared.set(servedNames(e.label)[0], { label: e.label, type: state.types[e.type].label, ...getter });
    }
    const exposed = new Map(functions(build.abi[L.internals]).map((f) => [f.name, f]));
    for (const f of lensViews) {
      const g = targetViews.get(f.name);
      if (g && types(g.inputs) !== types(f.inputs)) {
        problems.push(`${L.lens}.${signature(f)} takes other arguments than ${L.target}'s ${signature(g)}`);
      } else if (g && types(g.outputs) !== types(f.outputs)) {
        problems.push(`${L.lens}.${signature(f)} returns ${types(f.outputs)}, ${L.target}'s returns ${types(g.outputs)}`);
      }
      const d = declared.get(f.name);
      if (d && d.inputs !== types(f.inputs)) {
        problems.push(`${L.lens}.${signature(f)} takes other arguments than the state variable ${d.label} (${d.type}), whose getter takes ${d.inputs}`);
      } else if (d && d.outputs !== types(f.outputs)) {
        problems.push(`${L.lens}.${signature(f)} returns ${types(f.outputs)}, the state variable ${d.label} (${d.type})'s getter returns ${d.outputs}`);
      }
      const x = exposed.get(`exposed_${f.name}`);
      if (!x) {
        problems.push(`${L.internals} has no exposed_${signature(f)} for ${L.lens}.${signature(f)}`);
      } else if (types(x.inputs) !== types(f.inputs)) {
        problems.push(`${L.internals}.${signature(x)} takes other arguments than ${L.lens}.${signature(f)}`);
      } else if (types(x.outputs) !== types(f.outputs)) {
        problems.push(`${L.internals}.${signature(x)} returns ${types(x.outputs)}, ${L.lens}.${signature(f)} returns ${types(f.outputs)}`);
      }
    }
    for (const [label, { exposed: as }] of Object.entries(L.internalOnly)) {
      const name = `exposed_${as}`;
      if (!exposed.has(name)) problems.push(`${L.internals} has no ${name}, for ${label}, which no lens serves`);
    }

    // the test-only subclass adds no storage
    problems.push(...storageProblems(build, L.internals, L.target));

    // listed for the parity tests, view for view
    problems.push(...listProblems(L.list, build.lists[L.list], L.lens, new Set(lensViews.map(signature))));

    // the target's read surface is its lens's, but for what it keeps (Task 5d-2, on the vault)
    if (L.keepsOnlyKept) {
      for (const f of views(build.abi[L.target])) {
        if (!KEPT_ON_TARGET.includes(f.name)) {
          problems.push(`${L.target} has the view ${signature(f)}, which only ${L.lens} serves (spec §8.1)`);
        }
      }
    }
  }

  // CascadeBase's getters are the lenses' alone (Task 5d-1): CascadeBaseLens serves them on both; but a
  // FORWARDED immutable, which each target keeps and each lens asks it for (R1-A L-3)
  const baseViews = views(build.abi[BASE_LENS]).filter((f) => f.name !== 'target');
  for (const target of ['CascadeBase', ...new Set(LENSES.map((L) => L.target))]) {
    const has = new Set(functions(build.abi[target]).map((f) => f.name));
    for (const f of baseViews) {
      if (has.has(f.name) && !FORWARDED.includes(f.name)) {
        problems.push(`${target} has CascadeBase's getter ${signature(f)}, which only the lenses serve (spec §8.1)`);
      }
    }
    for (const name of FORWARDED) {
      if (!has.has(name)) problems.push(`${target} has no ${name}, which FORWARDED says it keeps and its lens asks it for`);
    }
  }
  problems.push(...listProblems('baseLensViews', build.lists.baseLensViews, BASE_LENS, new Set(baseViews.map(signature))));

  // the pause sweep's rows are the front door's whole non-view surface (Task 30's follow-up)
  problems.push(...entryPointProblems(build.abi.CascadeFrontDoor, build.entryPoints));
  return problems;
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  const outDir = i === -1 ? DEFAULT_OUT : resolve(argv[i + 1] ?? '');
  let build;
  try {
    build = loadBuild(outDir);
  } catch (e) {
    console.error(`lens-surface: ${e.message}`);
    process.exit(1);
  }
  const problems = surfaceProblems(build);
  if (problems.length) {
    console.error('The lenses do not serve their surface:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  for (const L of LENSES) {
    const n = functions(build.abi[L.lens]).filter((f) => f.name !== 'target').length;
    console.log(`${L.lens} serves ${n} views of ${L.target}, each exposed by ${L.internals} and listed in ${L.list}().`);
  }
  const base = views(build.abi[BASE_LENS]).filter((f) => f.name !== 'target').length;
  console.log(
    `${BASE_LENS} serves CascadeBase's ${base} getters, which neither target has but FORWARDED's (${FORWARDED.join(', ')}, kept by both); listed in baseLensViews().`,
  );
  for (const L of LENSES.filter((x) => x.keepsOnlyKept)) {
    const kept = views(build.abi[L.target]).map((f) => f.name);
    console.log(`${L.target} has no view or pure function beyond its kept list (${kept.join(', ')}); ${L.lens} serves the rest.`);
  }
  console.log(`VaultInternals and DoorInternals have exactly their target's storage layout.`);
  console.log(
    `CascadeFrontDoor's ${build.entryPoints.length} entry points (every non-view function and receive) are listed in doorEntryPoints(), which the pause sweep runs.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

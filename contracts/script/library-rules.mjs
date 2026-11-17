// The library rules (spec §8.1, I-32's static half; rulings DB7a to DB7c), one of the build checks:
//   1. The source rules, over each linked library (src/libraries/*Lib.sol and CascadePayoutMath.sol)
//      and its first-party import closure: the shared helpers compiled into it (the share token's mint
//      and burn, the message codec, the math, the formulas, the shared layout files). They scan what a
//      library can compile in: library bodies, free functions and file-level declarations; a contract's
//      or an interface's body never reaches a library.
//        - msg.value nowhere (L3 takes it as a parameter), and tx.origin nowhere (no access check);
//        - msg.sender only as L3's refund target: `payable(msg.sender).call{value: …}` or
//          `msg.sender.call{value: …}` in REFUND_TARGET's file;
//        - no selfdestruct, delegatecall or callcode;
//        - no state variable in a library (constants only);
//        - no assembly at all (R1-C F-1 and its ruling: no library may hold any, memory-only or not); one that
//          touches storage, calls out, or reads the caller, the value or the origin is also named for it.
//          Rule 4 holds it on solc's AST (this text rule was once per file and a deny-list);
//        - imports from outside first-party src/ (a remapping such as @openzeppelin/, a non-relative
//          path, a relative path into src/vendor) only from the closure's VENDOR_IMPORTS allow-list,
//          since the scan does not follow them; double- and single-quoted imports alike;
//        - every other library under src/ (a helper) has internal or private functions only, so none
//          can become a new link (ruling DB7c).
//      These rules strip comments and strings and track braces; they are not a compiler, and none of them
//      decides where a library calls: that is the call rule's, on the compiler's own reading.
//   2. The call rule, on solc's AST (5f fix round 4; Task 5g's target kinds). L1's own file
//      (NO_EXTERNAL_CALL) and each CALL_TARGETS library with its whole import closure (L2: the ledger helper,
//      the formulas, OpenZeppelin's Math, …; L3: the share token, the message codec, the payout math, …) are
//      compiled alone, in one solc run, into a scratch directory (compileAsts), and their library code
//      (library bodies, free functions, file-level declarations; never a contract's or an interface's body)
//      is walked node by node (callProblems):
//        - every call solc types as an external function call (with or without call options such as
//          `{gas: …}` or `{value: …}`), a low-level call, staticcall, delegatecall, transfer or send, a creation
//          (`new C`), an external or public library function (a DELEGATECALL), a precompile (ecrecover, sha256,
//          ripemd160), selfdestruct, or a kind it does not know, fails unless solc resolved it to one of the
//          library's targets:
//            - a cast CALL_TARGETS lists, `IStaking(ISTAKING_ADDRESS).f(…)` (L2, L4): a member of a type conversion
//              whose interface resolves to IStaking.sol's `interface IStaking` and whose one argument is an
//              identifier resolving to IStaking.sol's file-level `ISTAKING_ADDRESS` constant, at its PINNED
//              value (0x…0805); with no `{value: …}` call option (R1-C F-2: no library call carries value to a
//              cast target; `{gas: …}` stays allowed);
//            - a vault-passed field CALL_TARGETS lists, `PayoutIn.bridge.send` and `.quoteFee` (L3): that function
//              of ICascadeBridge.sol's interface, on CascadeTypes.sol's PayoutIn.bridge, on a PayoutIn parameter
//              of one of L3's own external functions (what the vault passes); and neither that field nor such a
//              parameter is written anywhere in the closure (an assignment, a tuple's component, a delete, a
//              write through another name for the same memory), so the call reaches the bridge the vault read;
//              nor is any other field of the struct, or, in memory, of the struct it holds (R1-C N-1: PayoutIn's
//              batch carries where the bridge delivers), so what the call carries is what the vault passed;
//            - a refund CALL_TARGETS lists, `msg.sender.call{value}("") last in finish` (L3's refund to the vault's
//              caller, Task 21; R1-C N-2's shape): a low-level call on `msg.sender` (or `payable(msg.sender)`, the
//              builtin as solc types it) with the call option `value` alone and one argument, the empty string
//              literal, that is the last statement of that external function of the library's own (or the last
//              but its own success check, `if (!ok) revert …;`, inside a trailing `if` with no else), a function
//              with no modifier (a modifier's code after `_` would run after it): no other target, no calldata, no
//              gas option, nothing after it;
//            - a DELEGATECALL into a library LINK_GRAPH says it links (L3: the payout math), whose external
//              functions' bodies are that library's own code, held by its own rules (its bytecode backstop, check 5:
//              no call opcode at all), and skipped here; its public and internal functions can be compiled
//              into this library (an internal call), so they are walked;
//          L1 has no target: it calls nothing;
//        - no value of an external function type anywhere (a variable, field, parameter, return, array
//          element, conditional, argument): only a call names an external function;
//        - internal calls (first-party internal library functions, OpenZeppelin's Math, using-for, internal
//          function pointers, whose targets are the closure's own code) and the builtins that call nothing
//          (abi.*, keccak256, require, revert, emit, new bytes(n), …) pass: solc types them as such.
//      So a shadowing, spacing, comments, parentheses, conditionals, arrays, call options or a renamed
//      import cannot point a call elsewhere: they do not change what solc resolved. A closure that does not
//      compile fails (no AST, no check).
//   3. The link graph (ruling DB7b): each first-party artifact's runtime and creation code links
//      exactly LINK_GRAPH's libraries (nothing, when unlisted), and each linked library is one the
//      source rules scan. Every artifact with code or an ABI must name its contract
//      (metadata.settings.compilationTarget), or it could not be checked.
//   4. The assembly rule, on the same solc run's ASTs (R1-C F-1 and its ruling): in the whole first-party
//      closure of every linked library (L1 to L4, the payout math: library code, free functions, file-level
//      declarations), no InlineAssembly node at all, a memory-only mstore in an external function included.
//      So no code compiled into a library can rewrite its caller's memory (L3's PayoutIn.bridge), log, return
//      or end the frame from assembly. OpenZeppelin's Math is vendored and skipped: the recorded exception
//      below.
//   5. The bytecode: no linked library's runtime code has SELFDESTRUCT or CALLCODE, nor a call or a
//      creation opcode beyond CALL_OPCODES' (L1: none at all, the exact form of "no external call", which
//      also covers the helpers it compiles in); a library allowed a call opcode has its targets in
//      CALL_TARGETS, the call rule the bytecode cannot express. And STATE_OPCODES' backstops (R1-C F-1): no
//      TSTORE in any library (the unstake flag is the vault's), no SSTORE in L2 (it walks a memory copy) or
//      the payout math (pure), and no LOG0 to LOG4 in the payout math (the vault and L3 emit). L4 writes and
//      logs (its write set, rule 6; its events, in v3.1's order), so it is held to no TSTORE only.
//   6. The write-set rule, on the same solc run's ASTs (step L4), for each WRITE_SETS library (L4): the vault
//      (WRITE_SET_CALLER) is compiled in the same run, each of the library's storage parameters is bound, at the
//      vault's call sites, to the vault state variable passed by name (anything else fails), and every storage
//      write the library's external functions run (theirs and their helpers', followed through internal calls,
//      a using-for receiver included: an assignment, a delete, an increment, a push or a pop) is traced to those
//      parameters and named as the vault's storage it reaches (`ledger.booked`). A write outside the set fails,
//      as does an entry never written (the set is exactly what the library writes) and a write the rule cannot
//      trace (a storage pointer local, a reassigned pointer, a returned pointer, a storage argument to a call it
//      cannot resolve, recursion, a modifier). With no state variable and no assembly in a library (rules 1 and
//      4), its storage pointers are its only way to write the vault's storage (writeSetProblems).
//   7. The precompile rule, on the same run's ASTs (fix round 1, M-1; Task 42a's per-function allow-list pulled
//      forward): each library the call rule lets call the staking precompile (L2, L4) has PRECOMPILE_FUNCTIONS'
//      list, and the code compiled into it (its external and public functions and everything they reference,
//      transitively) calls exactly those IStaking functions: another fails at its line, a listed one never called
//      fails too (precompileFunctionProblems). The staking interface inherits nothing (fix round 2: a base would
//      bring functions the lists cannot see), and a call on it to a function it does not declare itself fails.
//   8. The using-for rule (fix round 1, M-2): no call into a linked library's external or public function goes
//      through `using … for` (a receiver bound to the first parameter), since the rules read a linked library's
//      arguments positionally; every such call is a direct `Library.f(…)` (boundCallProblems).
//   9. The Yul call rule, on the same run's ASTs (Task 42a, the 5f carry): the code compiled into each linked library
//      (its external and public functions and every function or modifier they reference, transitively, vendored
//      code included) never reaches a function whose body holds Yul that calls out or creates (YUL_CALLS: call,
//      staticcall, delegatecall, callcode, create, create2, selfdestruct). The assembly rule (4) skips vendored files,
//      so OpenZeppelin's Math.modExp, a STATICCALL to the 0x05 precompile in assembly, is held here: no library may
//      reach it (yulCallProblems).
//  10. The delegatecall rule (Task 42a, the 5e review's minor 5): the vault's only DELEGATECALLs are to its linked
//      libraries, and nothing else in src/ makes one (delegatecallProblems):
//        - on the text of every first-party file in src/ (src/vendor aside), contracts and interfaces included: no
//          `delegatecall` or `callcode` in code (Solidity's low-level call and Yul's builtin alike);
//        - on the same run's ASTs, in the code compiled into each LINK_GRAPH contract (the vault: its own and its
//          bases' code and every function it reaches, vendored code included): no low-level or Yul delegatecall or
//          callcode, and every library DELEGATECALL into a library LINK_GRAPH says it links;
//        - in the build: no first-party artifact's runtime code or creation code (a constructor's code is only there;
//          fix round 1) has CALLCODE, nor DELEGATECALL unless LINK_GRAPH says it links a library (the vault, and L3 its
//          payout math).
//  11. The boundary coverage (Task 42a, spec §9.1): every external function of each linked library, as the build has
//      it (its artifact's methodIdentifiers, each function's kind from its artifact's AST: solc's JSON ABI lists only
//      a library's view and pure functions), is in BOUNDARY_TESTS with its kind (a non-view function, which the
//      compiler's call guard stops when called directly; a view or pure one, which runs with value on the library's
//      own empty storage) and its direct-call test, which exists in test/libraries/ and names the function's
//      selector; an entry the build does not have fails too. So a function added to a library fails the build checks
//      until a test calls it directly (boundaryCoverageProblems).
// OpenZeppelin's Math, compiled into L1 to L4 and the payout math, is vendored and audited, not
// first-party: its memory-only assembly (mulDiv) is the recorded exception to "no assembly in any
// library" (ruling DB7a; the assembly rule skips vendored files), and it is each closure's one
// allow-listed import. The call rule walks
// its Solidity like any closure file; the source rules' assembly rule does not read vendored files, and its
// modExp holds a STATICCALL to the 0x05 precompile in assembly, unused by every library today. In L1 and the
// payout math the bytecode rule (no call opcode at all) excludes it; L2's, L3's and L4's bytecode may STATICCALL.
// The call rule checks where L2 and L4 call; the precompile rule (7) which precompile functions they call. L3's
// refund to the caller (Task 21) is a target kind of its own (targetOf): value only, empty calldata, finish's last
// statement.
// Exits 1 on any problem, naming the file and line of each source problem. Runs forge (FORGE names it).
// Usage: node script/library-rules.mjs [--src <src dir>] [--out <forge out dir>] [--tests <test/libraries dir>]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeBuildJson } from './warning-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SRC = join(ROOT, 'src');
export const DEFAULT_OUT = join(ROOT, 'out');
/** Where the direct-call tests BOUNDARY_TESTS names live. */
export const DEFAULT_TESTS = join(ROOT, 'test', 'libraries');

/** The files whose own code makes no external call at all, held by the call rule: L1 (its bytecode, with no
 * call opcode, holds the helpers it compiles in). */
export const NO_EXTERNAL_CALL = ['src/libraries/CascadeBatchLib.sol'];

/** Where msg.sender may appear, and only as the target of a value call (L3's refund, Task 21). */
export const REFUND_TARGET = ['src/libraries/CascadePayoutLib.sol'];

/** Per linked library, what its closure may import from outside first-party src/, by path as written
 * (a remapping) or as resolved (a relative path): today only OpenZeppelin's Math. A library with no
 * entry may import nothing from outside. */
export const VENDOR_IMPORTS = {
  'src/libraries/CascadeBatchLib.sol': ['@openzeppelin/contracts/utils/math/Math.sol'],
  'src/libraries/CascadeHotkeyLib.sol': ['@openzeppelin/contracts/utils/math/Math.sol'],
  'src/libraries/CascadePayoutLib.sol': ['@openzeppelin/contracts/utils/math/Math.sol'],
  'src/libraries/CascadePayoutMath.sol': ['@openzeppelin/contracts/utils/math/Math.sol'],
  'src/libraries/CascadeStakeLib.sol': ['@openzeppelin/contracts/utils/math/Math.sol'],
};

/** Per library, the only external call targets its whole closure (itself and every helper it compiles
 * in) may call, held by the call rule on solc's AST, by kind (targetOf):
 *   - a cast `Interface(ADDRESS)`: any external function on it, both names resolved by solc to PINNED's home
 *     file. L2 and L4 call only the staking precompile (spec §8.1);
 *   - a vault-passed field `Struct.field.function`: that function on that field of a Struct parameter of one
 *     of the library's own external functions, which the vault passes, the field (and the parameter) never
 *     written in the closure; PINNED fixes the struct's home and the interface the field holds. L3 calls only
 *     the primary bridge the vault reads, PayoutIn.bridge: its fee quote and its send;
 *   - a refund `msg.sender.call{value}("") last in <function>`: a value-only, empty-calldata low-level call to
 *     msg.sender, the last statement of that external function of the library's own, which has no modifier
 *     (REFUND_TARGET's file only, by the source rules). L3 refunds the vault's caller its value less the top-up,
 *     last in finish (Task 21).
 * Its DELEGATECALLs are LINK_GRAPH's, not listed here. */
export const CALL_TARGETS = {
  'src/libraries/CascadeHotkeyLib.sol': ['IStaking(ISTAKING_ADDRESS)'],
  'src/libraries/CascadePayoutLib.sol': ['PayoutIn.bridge.quoteFee', 'PayoutIn.bridge.send', 'msg.sender.call{value}("") last in finish'],
  'src/libraries/CascadeStakeLib.sol': ['IStaking(ISTAKING_ADDRESS)'],
};

/** What CALL_TARGETS' names resolve to. A cast's address: its home file declares the cast's interface and,
 * at file level, `address constant <NAME> = <value>;`, and a cast counts only when solc resolves both of its
 * names to those two declarations. A field `Struct.field`: its home file declares the struct at file level,
 * the field holds interface `type`, declared at file level in `typePath`, and a call counts only when solc
 * resolves the field and the function to those declarations. */
export const PINNED = {
  ISTAKING_ADDRESS: { path: 'src/interfaces/IStaking.sol', value: '0x0000000000000000000000000000000000000805' },
  'PayoutIn.bridge': { path: 'src/CascadeTypes.sol', type: 'ICascadeBridge', typePath: 'src/interfaces/ICascadeBridge.sol' },
};

/** Per library that may call the staking precompile (a cast target in CALL_TARGETS), exactly the precompile functions
 * the code compiled into it calls (the precompile rule, precompileFunctionProblems; fix round 1's M-1, Task 42a's
 * per-function allow-list): the call rule fixes where a library calls, this which functions it calls there. L2's walk:
 * the stake and floor reads, the partial and full removals (its own, each in a `try` with a `{gas: …}` share, Task 20;
 * CascadeLedger.removalMeasured measures them). L4: the stake read, the
 * minimum-stake read (the eligibility, the last slot, the leftover's floor), the unclaimed rewards, the owner's move
 * and the direct removal; `removeStake` is compiled into L4 with the shared removalDebit, whose partial branch L4 never
 * takes (it passes `full`), so it is listed as code L4 holds. Never `addStake`, `claimRootWithHotkey`,
 * `setRejectStakingHotkeyGrowth` or anything else. */
export const PRECOMPILE_FUNCTIONS = {
  'src/libraries/CascadeHotkeyLib.sol': ['getDefaultMinStake', 'getStake', 'getUnclaimedRootTaoByHotkey', 'moveStake', 'removeStake', 'removeStakeFull'],
  'src/libraries/CascadeStakeLib.sol': ['getDefaultMinStake', 'getNominatorMinRequiredStake', 'getStake', 'removeStake', 'removeStakeFull'],
};

/** The link graph: the libraries each first-party artifact links. Every artifact not listed links
 * nothing. The vault links L1, L2, L3 and L4, and L3 the payout math (Task 5g; L3 does not link L2: the vault
 * runs the walk between L3's two halves; L4 links nothing). A library's calls into the libraries it links are its
 * only DELEGATECALLs, and the call rule skips their external functions' bodies, which are their own code. */
export const LINK_GRAPH = {
  CascadeVault: ['CascadeBatchLib', 'CascadeHotkeyLib', 'CascadePayoutLib', 'CascadeStakeLib'],
  CascadePayoutLib: ['CascadePayoutMath'],
};

/** The call and creation opcodes each linked library's runtime code may hold (SELFDESTRUCT and CALLCODE
 * never). L1 and the payout math call nothing. L2 and L4 call the staking precompile (CALL for a removal or a
 * move, STATICCALL for a read; CALL_TARGETS fixes the target). L3 calls the bridge (CALL to send, STATICCALL to
 * quote; CALL_TARGETS fixes it) and its linked payout math (DELEGATECALL; LINK_GRAPH fixes it). */
export const CALL_OPCODES = {
  CascadeBatchLib: [],
  CascadeHotkeyLib: ['CALL', 'STATICCALL'],
  CascadePayoutLib: ['CALL', 'STATICCALL', 'DELEGATECALL'],
  CascadePayoutMath: [],
  CascadeStakeLib: ['CALL', 'STATICCALL'],
};

/** Per library, the caller's storage its whole closure writes, exactly (the write-set rule, writeSetProblems, on
 * solc's AST): each entry a state variable of WRITE_SET_CALLER, or a member of one, as the caller's call sites bind
 * the library's storage parameters. L4 writes the hotkey list, `isHotkey` and `lastClaimAt` (its rules' writes),
 * and nothing else: never the ledger (the owner's direct removal returns its measurements and the vault books
 * them), the stake hotkey or anything else. The other libraries are held by their storage pointers' types (spec
 * §8.1) and, L2 and the payout math, by the bytecode's no SSTORE. */
export const WRITE_SETS = {
  'src/libraries/CascadeHotkeyLib.sol': ['hotkeys', 'isHotkey', 'lastClaimAt'],
};

/** The contract whose call sites bind a WRITE_SETS library's storage parameters to its state variables, compiled in
 * the same solc run as the libraries (astRoots): the vault, the only contract that links them. */
export const WRITE_SET_CALLER = 'src/CascadeVault.sol';

/** The state opcodes a linked library's runtime code must not hold (R1-C F-1's bytecode backstops): '*' for
 * every library, then per library. TSTORE nowhere (no library sets the vault's transient unstake flag: the vault
 * sets it around L2's walk and L4's removal call); no SSTORE in L2, which walks a memory copy, or in the payout
 * math, which is pure; no LOG in the payout math, whose results the vault and L3 emit. L4 writes storage (its
 * write set, WRITE_SETS) and logs (HotkeyAdded, HotkeyRemoved, StakeMoved, Unstaked, each in v3.1's order). */
export const STATE_OPCODES = {
  '*': ['TSTORE'],
  CascadeStakeLib: ['SSTORE'],
  CascadePayoutMath: ['SSTORE', 'LOG0', 'LOG1', 'LOG2', 'LOG3', 'LOG4'],
};

/** The Yul builtins that call out or create (the Yul call rule, yulCallProblems; the delegatecall rule reads two of
 * them): no code compiled into a library reaches a function whose assembly calls one. */
export const YUL_CALLS = ['call', 'callcode', 'create', 'create2', 'delegatecall', 'selfdestruct', 'staticcall'];

/** The tests that call each linked library's external functions directly (Task 42a, spec §9.1: a library is deployed
 * on its own, and anyone can call it), by library and function name, as the build names them (each library artifact's
 * methodIdentifiers; boundaryCoverageProblems): every function has an entry and every entry a function. `kind` is the
 * function's: 'guarded', a non-view function, which the compiler's call guard reverts when it is called directly
 * (with or without value: no data, no value kept, nothing touched); 'view', a view or pure function, which runs on the
 * library's own empty storage, keeps any value sent (a library's balance is informational, never a verify failure or
 * a keeper stop: spec rev 12 L-4), emits nothing and leaves the vault unchanged. `test` is
 * `<file in test/libraries>:<test function>`, whose body names `<Library>.<function>.selector`. */
export const BOUNDARY_TESTS = {
  CascadeBatchLib: {
    deliver: { kind: 'guarded', test: 'LibraryBoundary.t.sol:test_everyNonViewLibraryFunctionStopsAtTheCallGuard' },
  },
  CascadeHotkeyLib: {
    add: { kind: 'guarded', test: 'LibraryBoundary.t.sol:test_everyNonViewLibraryFunctionStopsAtTheCallGuard' },
    move: { kind: 'guarded', test: 'LibraryBoundary.t.sol:test_everyNonViewLibraryFunctionStopsAtTheCallGuard' },
    remove: { kind: 'guarded', test: 'LibraryBoundary.t.sol:test_everyNonViewLibraryFunctionStopsAtTheCallGuard' },
  },
  CascadePayoutLib: {
    cancel: { kind: 'guarded', test: 'LibraryBoundary.t.sol:test_everyNonViewLibraryFunctionStopsAtTheCallGuard' },
    finish: { kind: 'guarded', test: 'LibraryBoundary.t.sol:test_everyNonViewLibraryFunctionStopsAtTheCallGuard' },
    prepare: { kind: 'guarded', test: 'LibraryBoundary.t.sol:test_everyNonViewLibraryFunctionStopsAtTheCallGuard' },
  },
  CascadePayoutMath: {
    deductFee: { kind: 'view', test: 'LibraryBoundary.t.sol:test_everyPureLibraryFunctionKeepsTheValueAndTouchesNothing' },
    takeChunk: { kind: 'view', test: 'LibraryBoundary.t.sol:test_everyPureLibraryFunctionKeepsTheValueAndTouchesNothing' },
    verify: { kind: 'view', test: 'LibraryBoundary.t.sol:test_everyPureLibraryFunctionKeepsTheValueAndTouchesNothing' },
  },
  CascadeStakeLib: {
    unstake: { kind: 'guarded', test: 'LibraryBoundary.t.sol:test_everyNonViewLibraryFunctionStopsAtTheCallGuard' },
  },
};

const OPCODE = { CALL: 0xf1, STATICCALL: 0xfa, DELEGATECALL: 0xf4, CREATE: 0xf0, CREATE2: 0xf5 };
const NEVER = { SELFDESTRUCT: 0xff, CALLCODE: 0xf2 };
const STATE = { SSTORE: 0x55, TSTORE: 0x5d, LOG0: 0xa0, LOG1: 0xa1, LOG2: 0xa2, LOG3: 0xa3, LOG4: 0xa4 };

const ROOT_PATH = /^src\/libraries\/(\w+Lib|CascadePayoutMath)\.sol$/;
const isRootPath = (p) => ROOT_PATH.test(p);
const isFirstParty = (p) => p.startsWith('src/') && !p.startsWith('src/vendor/');

// ---- reading the sources ----

/** Every first-party .sol file under `srcDir` (src/vendor excluded), keyed by its path from
 * contracts/ ("src/libraries/CascadeBatchLib.sol"). */
export function loadSources(srcDir = DEFAULT_SRC) {
  const sources = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.sol')) {
        const key = posix.join('src', relative(srcDir, full).split(sep).join('/'));
        if (isFirstParty(key)) sources.set(key, readFileSync(full, 'utf8').replace(/\r\n/g, '\n'));
      }
    }
  };
  if (!existsSync(srcDir)) throw new Error(`${srcDir} does not exist`);
  walk(srcDir);
  return sources;
}

/** The linked libraries the source rules start from, sorted. */
export function libraryRoots(sources) {
  return [...sources.keys()].filter(isRootPath).sort();
}

/** `text` with every comment and string literal blanked to spaces, newlines kept, so offsets and line
 * numbers are the source's. */
export function stripComments(text) {
  const out = text.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; ++k) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      // the quotes stay, so `"x"` reads as an (empty) literal
      blank(i + 1, j);
      i = j + 1;
    } else {
      ++i;
    }
  }
  return out.join('');
}

/** The index of the brace that closes the one at `open`. */
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; ++i) {
    if (text[i] === '{') ++depth;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces');
}

/** The top-level definitions of a stripped file: { kind, name, start, open, end }. */
function definitions(code) {
  const defs = [];
  const head = /(abstract\s+contract|contract|interface|library)\s+(\w+)/y;
  let depth = 0;
  for (let i = 0; i < code.length; ++i) {
    if (code[i] === '{') ++depth;
    else if (code[i] === '}') --depth;
    else if (depth === 0 && (i === 0 || /\W/.test(code[i - 1]))) {
      head.lastIndex = i;
      const m = head.exec(code);
      if (!m) continue;
      const open = code.indexOf('{', i);
      const end = closing(code, open);
      defs.push({ kind: m[1].replace(/\s+/g, ' '), name: m[2], start: i, open, end });
      i = end;
    }
  }
  return defs;
}

/** What of a file can be compiled into a library: the stripped text with every contract's and
 * interface's body blanked. */
function libraryCode(text) {
  const code = stripComments(text).split('');
  for (const d of definitions(code.join(''))) {
    if (d.kind === 'library') continue;
    for (let k = d.start; k <= d.end; ++k) if (code[k] !== '\n') code[k] = ' ';
  }
  return code.join('');
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Each import of `path`, in order: { target } as written, { resolved } for a relative one (from
 * contracts/; null otherwise), whether the scan follows it (a first-party source) and the index of its
 * `import` keyword. Double- and single-quoted paths alike. */
export function importsOf(sources, path) {
  const raw = sources.get(path);
  const code = stripComments(raw);
  const found = [];
  // the import paths are string literals: read them from the source at the stripped text's offsets
  for (const m of code.matchAll(/\bimport\b[^;]*?(["'])\s*\1/g)) {
    const close = m.index + m[0].length - 1;
    const open = code.lastIndexOf(m[1], close - 1);
    const target = raw.slice(open + 1, close);
    const resolved = target.startsWith('.') ? posix.normalize(posix.join(posix.dirname(path), target)) : null;
    found.push({ target, resolved, followed: resolved !== null && isFirstParty(resolved) && sources.has(resolved), index: m.index });
  }
  return found;
}

/** The first-party files `path` imports, directly or not, `path` first. */
export function importClosure(sources, path) {
  const seen = [];
  const visit = (p) => {
    if (seen.includes(p)) return;
    seen.push(p);
    for (const i of importsOf(sources, p)) if (i.followed) visit(i.resolved);
  };
  if (!sources.has(path)) throw new Error(`${path} is not in the sources`);
  visit(path);
  return seen;
}

/** A CALL_TARGETS entry by its kind: a cast `IStaking(ISTAKING_ADDRESS)`, as { kind: 'cast', text, iface,
 * address }, a vault-passed field `PayoutIn.bridge.send`, as { kind: 'field', text, struct, field, fn }, or a
 * refund to the caller `msg.sender.call{value}("") last in finish`, as { kind: 'refund', text, fn }. Throws on any
 * other entry. */
export function targetOf(text) {
  let m = text.match(/^([A-Za-z_]\w*)\(([A-Za-z_]\w*)\)$/);
  if (m) return { kind: 'cast', text, iface: m[1], address: m[2] };
  m = text.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
  if (m) return { kind: 'field', text, struct: m[1], field: m[2], fn: m[3] };
  m = text.match(/^msg\.sender\.call\{value\}\(""\) last in ([A-Za-z_]\w*)$/);
  if (m) return { kind: 'refund', text, fn: m[1] };
  throw new Error(
    `CALL_TARGETS lists ${text}, which is neither a cast Interface(ADDRESS), a vault-passed field Struct.field.function nor a refund msg.sender.call{value}("") last in <function>`,
  );
}

/** The name a source file's path gives its library: src/libraries/CascadeStakeLib.sol -> CascadeStakeLib. */
const baseName = (path) => posix.basename(path, '.sol');

/** The source rules' problems, each "<file>:<line>: <what>", in file order. */
export function sourceProblems(sources) {
  const problems = [];
  const roots = libraryRoots(sources);
  const scanned = [...new Set(roots.flatMap((r) => importClosure(sources, r)))].sort();
  const say = (path, code, index, what) => problems.push(`${path}:${lineOf(code, index)}: ${what}`);

  for (const path of scanned) {
    const code = libraryCode(sources.get(path));

    for (const m of code.matchAll(/\bmsg\s*\.\s*value\b/g)) {
      say(path, code, m.index, 'msg.value in library code (no library reads it: L3 takes it as a parameter)');
    }
    for (const m of code.matchAll(/\bmsg\s*\.\s*sender\b/g)) {
      const after = code.slice(m.index + m[0].length);
      const before = code.slice(0, m.index);
      const wrapped = /payable\s*\(\s*$/.test(before);
      const refund = (wrapped ? /^\s*\)\s*\.\s*call\s*\{\s*value\s*:/ : /^\s*\.\s*call\s*\{\s*value\s*:/).test(after);
      if (!(REFUND_TARGET.includes(path) && refund)) {
        say(path, code, m.index, "msg.sender in library code (allowed only as L3's refund target)");
      }
    }
    for (const m of code.matchAll(/\btx\s*\.\s*origin\b/g)) {
      say(path, code, m.index, 'tx.origin in library code (no library makes an access check)');
    }
    for (const m of code.matchAll(/\b(selfdestruct|delegatecall|callcode)\b/g)) {
      say(path, code, m.index, `${m[1]} in library code`);
    }

    for (const m of code.matchAll(/\bassembly\b/g)) {
      const open = code.indexOf('{', m.index);
      const end = closing(code, open);
      const block = code.slice(open, end + 1);
      say(path, code, m.index, 'assembly in library code (no library may hold any, R1-C F-1)');
      for (const s of block.matchAll(/\b(sload|sstore|tload|tstore)\b|\.slot\b|\.offset\b/g)) {
        say(path, code, open + s.index, `assembly touches storage (${s[0]})`);
      }
      for (const s of block.matchAll(/\b(call|staticcall|delegatecall|callcode|create|create2|selfdestruct)\s*\(/g)) {
        say(path, code, open + s.index, `assembly makes a call (${s[1]})`);
      }
      const reads = { caller: 'msg.sender', callvalue: 'msg.value', origin: 'tx.origin' };
      for (const s of block.matchAll(/\b(caller|callvalue|origin)\s*\(/g)) {
        say(path, code, open + s.index, `assembly reads ${reads[s[1]]} (${s[1]}())`);
      }
    }

    for (const d of definitions(code).filter((x) => x.kind === 'library')) {
      // the library's own declarations: a statement ended by `;` at its top level is a variable
      let start = d.open + 1;
      for (let i = d.open + 1; i < d.end; ++i) {
        if (code[i] === '{') {
          i = closing(code, i);
          start = i + 1;
        } else if (code[i] === ';') {
          const stmt = code.slice(start, i);
          const at = start + stmt.search(/\S/);
          const text = stmt.trim();
          start = i + 1;
          if (/^(function|modifier|event|error|using|struct|enum|type)\b/.test(text)) continue;
          if (!/\bconstant\b/.test(text)) say(path, code, at, `state variable in library ${d.name} (libraries hold constants only): ${text}`);
        }
      }
      if (isRootPath(path)) continue;
      // a helper library: internal or private functions only (ruling DB7c)
      const body = code.slice(d.open, d.end);
      for (const f of body.matchAll(/\bfunction\s+(\w+)\s*\(/g)) {
        const header = body.slice(f.index, body.slice(f.index).search(/[{;]/) + f.index);
        const vis = header.match(/\b(external|public)\b/)?.[1];
        if (vis) say(path, code, d.open + f.index, `helper library ${d.name}'s ${f[1]} is ${vis}: helpers keep internal functions only, so none becomes a link`);
      }
    }
  }

  // what each closure imports from outside first-party src/, which the scan does not follow
  for (const root of roots) {
    const allowed = VENDOR_IMPORTS[root] ?? [];
    for (const path of importClosure(sources, root)) {
      const code = stripComments(sources.get(path));
      for (const i of importsOf(sources, path)) {
        const name = i.resolved ?? i.target;
        if (i.followed || allowed.includes(name)) continue;
        say(path, code, i.index, `${root}'s closure imports "${name}", which is not first-party and not in its allow-list (VENDOR_IMPORTS: ${allowed.join(', ') || 'none'}): the source rules do not scan it`);
      }
    }
  }

  return problems;
}

// ---- the call rule, on solc's AST (5f fix round 4) ----

/** The files the call rule compiles, sorted: each CALL_TARGETS library and each NO_EXTERNAL_CALL file in
 * `sources`. */
export function callRuleRoots(sources, callTargets = CALL_TARGETS, noExternalCall = NO_EXTERNAL_CALL) {
  return [...new Set([...Object.keys(callTargets), ...noExternalCall])].filter((p) => sources.has(p)).sort();
}

/** A compiled file's path as the rules name it: "src/…" under `srcDir`, else its path from contracts/
 * (lib/…), else as given. */
function rulePath(file, srcDir) {
  const under = (base) => {
    const r = relative(base, file);
    return r && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : null;
  };
  const inSrc = under(srcDir);
  return inSrc !== null ? `src/${inSrc}` : (under(ROOT) ?? file.split(sep).join('/'));
}

/** The 1-based line of byte `offset` in `bytes` (solc's offsets count bytes). */
function lineAt(bytes, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < bytes.length; ++i) if (bytes[i] === 0x0a) ++line;
  return line;
}

/** solc's reading of `roots` (paths from contracts/, "src/libraries/CascadeStakeLib.sol", under `srcDir`) and
 * of everything they import: compiled alone, forced, in one solc run, with the project's settings, into a
 * scratch directory (forgeBuildJson; out/ and the cache are never touched, and out/'s artifacts may come from
 * different runs, whose AST node ids do not compare). Returns { roots, units, errors }: `units` maps each
 * file's path to { ast, bytes }, its SourceUnit and the bytes solc read; `errors` holds solc's errors as
 * { where, code, message }. Throws when forge fails, prints no AST, or splits the roots across runs. */
export function compileAsts(srcDir = DEFAULT_SRC, roots = []) {
  const units = new Map();
  if (!roots.length) return { roots, units, errors: [] };
  const output = forgeBuildJson(srcDir, roots.map((r) => join(srcDir, posix.relative('src', r))), ['--ast']);
  const runs = new Set();
  for (const [file, entries] of Object.entries(output.sources ?? {})) {
    for (const e of entries) runs.add(e.build_id);
    const ast = entries[0]?.source_file?.ast;
    if (ast?.nodeType !== 'SourceUnit') throw new Error(`forge's output holds no AST for ${file}`);
    units.set(rulePath(file, srcDir), { ast, bytes: readFileSync(file) });
  }
  if (runs.size > 1) throw new Error(`forge compiled ${roots.join(', ')} in ${runs.size} solc runs, whose AST node ids do not compare`);
  const errors = (output.errors ?? [])
    .filter((d) => d.severity === 'error')
    .map((d) => {
      const file = d.sourceLocation?.file;
      let where = '(no location)';
      if (file) {
        const abs = isAbsolute(file) ? file : resolve(ROOT, file);
        const start = d.sourceLocation.start;
        where = rulePath(abs, srcDir);
        if (existsSync(abs) && Number.isInteger(start) && start >= 0) where += `:${lineAt(readFileSync(abs), start)}`;
      }
      return { where, code: d.errorCode ?? '?', message: d.message };
    });
  return { roots, units, errors };
}

/** solc's function kinds (its FunctionType::Kind, as type identifiers spell them) that call nothing outside the
 * code: internal functions and the builtins. Every other kind, and one not listed, is an external call. */
const CALLS_NOTHING = new Set([
  'internal',
  'abiencode',
  'abiencodepacked',
  'abiencodewithselector',
  'abiencodewithsignature',
  'abiencodecall',
  'abidecode',
  'keccak256',
  'require',
  'assert',
  'revert',
  'error',
  'event',
  'gasleft',
  'blockhash',
  'blobhash',
  'addmod',
  'mulmod',
  'arraypush',
  'arraypop',
  'bytesconcat',
  'stringconcat',
  'objectcreation',
  'wrap',
  'unwrap',
  'metatype',
]);

/** The function kinds a value may have: an internal function (a pointer into the same code) and a declaration
 * (`IStaking.removeStake`, for `.selector` or abi.encodeCall), which cannot be called. */
const VALUE_KINDS = new Set(['internal', 'declaration']);

/** How each external kind reads in a problem. */
const CALL_KIND = {
  external: 'an external function',
  delegatecall: 'an external or public library function (a DELEGATECALL)',
  barecall: 'a low-level call',
  barestaticcall: 'a low-level staticcall',
  baredelegatecall: 'a low-level delegatecall',
  barecallcode: 'a low-level callcode',
  transfer: 'a value transfer',
  send: 'a send',
  creation: 'a contract creation',
  ecrecover: 'a precompile call (ecrecover)',
  sha256: 'a precompile call (sha256)',
  ripemd160: 'a precompile call (ripemd160)',
  selfdestruct: 'selfdestruct',
};

/** Type names: their declarations carry their types. */
const TYPE_NAMES = new Set(['ElementaryTypeName', 'UserDefinedTypeName', 'FunctionTypeName', 'ArrayTypeName', 'Mapping']);

/** The function kinds a type identifier names, outermost first: "t_function_external_payable$…" -> external. */
const functionKinds = (typeIdentifier) => [...(typeIdentifier ?? '').matchAll(/t_function_([a-z0-9]+)_/g)].map((m) => m[1]);

/** Whether `core`, a call's callee less its call options, is a member of `cast` as solc resolved it:
 * `Interface(ADDRESS).f`, a type conversion whose interface is the cast's declaration and whose one argument
 * is an identifier of its pinned constant. */
function onCast(core, cast) {
  if (!Number.isInteger(cast.ifaceId) || !Number.isInteger(cast.addressId)) return false;
  const conversion = core?.nodeType === 'MemberAccess' ? core.expression : null;
  if (conversion?.nodeType !== 'FunctionCall' || conversion.kind !== 'typeConversion' || conversion.arguments?.length !== 1) return false;
  const [iface, address] = [conversion.expression, conversion.arguments[0]];
  return (
    iface?.nodeType === 'Identifier' &&
    iface.referencedDeclaration === cast.ifaceId &&
    address?.nodeType === 'Identifier' &&
    address.referencedDeclaration === cast.addressId
  );
}

/** Whether `core`, a call's callee less its call options, is `field`'s function on its field of a vault-passed
 * parameter as solc resolved them: `<param>.<field>.<fn>`, the function the interface's declaration, the field
 * the struct's member, and `<param>` an identifier of one of `bases`, the parameters of the struct's type of
 * the library's own external functions (the values the vault passes). */
function onField(core, field, bases) {
  if (!Number.isInteger(field.fnId) || !Number.isInteger(field.memberId)) return false;
  const member = core?.nodeType === 'MemberAccess' ? core.expression : null;
  const base = member?.nodeType === 'MemberAccess' ? member.expression : null;
  return (
    core.referencedDeclaration === field.fnId &&
    member.referencedDeclaration === field.memberId &&
    base?.nodeType === 'Identifier' &&
    bases.get(base.referencedDeclaration) === field.structId
  );
}

/** Whether `core`, a DELEGATECALL's callee, is an external function of one of `linked`, the libraries its
 * library links: `<Library>.f`, the identifier resolved by solc to the library declared in its own file. */
function onLinked(core, linked) {
  const library = core?.nodeType === 'MemberAccess' ? core.expression : null;
  return library?.nodeType === 'Identifier' && linked.some((l) => Number.isInteger(l.id) && l.id === library.referencedDeclaration);
}

/** Whether `e` is the builtin msg.sender, or `payable(msg.sender)`, as solc resolved them. */
function isSender(e) {
  if (e?.nodeType === 'FunctionCall' && e.kind === 'typeConversion' && e.arguments?.length === 1) {
    const type = e.expression?.nodeType === 'ElementaryTypeNameExpression' ? e.expression.typeName : null;
    return type?.name === 'address' && type.stateMutability === 'payable' && isSender(e.arguments[0]);
  }
  return (
    e?.nodeType === 'MemberAccess' &&
    e.memberName === 'sender' &&
    e.expression?.nodeType === 'Identifier' &&
    e.expression.name === 'msg' &&
    e.expression.typeDescriptions?.typeIdentifier === 't_magic_message'
  );
}

/** Why low-level call `call` is not a refund's shape (R1-C N-2): `msg.sender.call{value: …}("")`, the call option
 * `value` alone and the one argument the empty string literal; '' when it is. */
function refundFlaw(call) {
  const callee = call.expression;
  const core = callee?.nodeType === 'FunctionCallOptions' ? callee.expression : callee;
  if (!(core?.nodeType === 'MemberAccess' && core.memberName === 'call' && isSender(core.expression))) return 'not a call on msg.sender';
  const names = callee.nodeType === 'FunctionCallOptions' ? (callee.names ?? []) : [];
  if (names.length !== 1 || names[0] !== 'value') return `the call options {${names.join(', ')}}, where only {value} is allowed`;
  const args = call.arguments ?? [];
  const empty = args.length === 1 && args[0]?.nodeType === 'Literal' && args[0].kind === 'string' && args[0].value === '';
  return empty ? '' : 'calldata other than the empty string literal ""';
}

/** The declaration id of the variable `if (!ok) revert …;` checks, or null when statement `s` is not that check. */
function checkedVariable(s) {
  const c = s.condition;
  if (s.falseBody || c?.nodeType !== 'UnaryOperation' || c.operator !== '!' || c.subExpression?.nodeType !== 'Identifier') return null;
  const body = s.trueBody?.nodeType === 'Block' ? s.trueBody.statements : [s.trueBody];
  return body.length === 1 && body[0]?.nodeType === 'RevertStatement' ? c.subExpression.referencedDeclaration : null;
}

/** The call in the last place of `statements`, a function body (R1-C N-2's "last statement"): its last statement's
 * call (an expression statement, or a declaration's initial value); or, when it is `if (!ok) revert …;`, the call
 * that declares `ok` in the statement before it; or, when it is an `if` with no else, the call in the last place of
 * its body. Null when there is none. */
function lastCall(statements) {
  const last = statements.at(-1);
  const callIn = (e) => (e?.nodeType === 'FunctionCall' && e.kind === 'functionCall' ? e : null);
  if (!last) return null;
  if (last.nodeType === 'IfStatement' && !last.falseBody) {
    const ok = checkedVariable(last);
    if (ok === null) return lastCall(last.trueBody?.nodeType === 'Block' ? last.trueBody.statements : [last.trueBody]);
    const prev = statements.at(-2);
    return prev?.nodeType === 'VariableDeclarationStatement' && prev.declarations?.[0]?.id === ok ? callIn(prev.initialValue) : null;
  }
  if (last.nodeType === 'ExpressionStatement') return callIn(last.expression);
  if (last.nodeType === 'VariableDeclarationStatement') return callIn(last.initialValue);
  return null;
}

/** The expressions statement or expression `node` writes: an assignment's left-hand side (each component of a
 * tuple, nested), the operand of a delete, an increment or a decrement. */
function writtenBy(node) {
  const found = [];
  const add = (e) => {
    if (e?.nodeType === 'TupleExpression') for (const c of e.components ?? []) add(c);
    else if (e) found.push(e);
  };
  if (node.nodeType === 'Assignment') add(node.leftHandSide);
  else if (node.nodeType === 'UnaryOperation' && ['delete', '++', '--'].includes(node.operator)) add(node.subExpression);
  return found;
}

/** `root`'s closure in `compiled` (compileAsts), `root` first: its imports as solc resolved them, transitively.
 * Throws on an import that is not in solc's output. */
export function astClosure(compiled, root) {
  const { units } = compiled;
  const pathOfUnit = new Map([...units].map(([path, u]) => [u.ast.id, path]));
  const seen = [root];
  for (let i = 0; i < seen.length; ++i) {
    for (const n of units.get(seen[i]).ast.nodes) {
      if (n.nodeType !== 'ImportDirective') continue;
      const p = pathOfUnit.get(n.sourceUnit);
      if (p === undefined) throw new Error(`${seen[i]} imports ${n.absolutePath}, which is not in solc's output`);
      if (!seen.includes(p)) seen.push(p);
    }
  }
  return seen;
}

/** The call rule's problems over `compiled` (compileAsts), each "<file>:<line>: <what>". In each CALL_TARGETS
 * library's closure (as solc resolved its imports), every call solc types as external (an external function,
 * with or without call options, a low-level call, transfer or send, a creation, a library DELEGATECALL, a
 * precompile, selfdestruct, or a kind it does not know) is one of its targets as solc resolved it:
 *   - an external function call on one of its casts, both names resolved to PINNED's home file;
 *   - an external function call on one of its fields: the pinned interface's function, on the pinned struct's
 *     field, on a parameter of that struct's type of one of the library's own external functions (the value
 *     the vault passes); and no such field or parameter is ever written in the closure (an assignment, a
 *     delete, a tuple's component, a write through another name for the same memory), so the call reaches the
 *     address the vault passed;
 *   - a DELEGATECALL into one of the libraries `linkGraph` says it links, whose external functions' bodies run
 *     as that library's own code (held by its own rules) and are skipped here; their internal functions are
 *     compiled in and walked.
 * No expression or declaration has an external function type except a call's callee. In each NO_EXTERNAL_CALL
 * file, the same with no target at all. Library code only: a contract's or an interface's body never reaches a
 * library. A compile error is a problem: no AST, no check. Throws on a CALL_TARGETS entry of no kind targetOf
 * reads. */
export function callProblems(
  compiled,
  { callTargets = CALL_TARGETS, noExternalCall = NO_EXTERNAL_CALL, pinned = PINNED, linkGraph = LINK_GRAPH } = {},
) {
  if (compiled.errors.length) {
    return compiled.errors.map((e) => `${e.where}: does not compile, so the call rule cannot read solc's AST: error ${e.code}: ${e.message}`);
  }
  const { units } = compiled;
  const problems = [];
  const lineOfNode = (path, node) => lineAt(units.get(path).bytes, Number.parseInt(node.src, 10));
  const say = (path, node, what) => problems.push(`${path}:${lineOfNode(path, node)}: ${what}`);
  /** The source of `node`, on one line, shortened. */
  const snippet = (path, node) => {
    const [start, length] = node.src.split(':').map(Number);
    const text = units.get(path).bytes.subarray(start, start + length).toString('utf8').replace(/\s+/g, ' ').trim();
    return text.length > 64 ? `${text.slice(0, 63)}…` : text;
  };
  for (const root of compiled.roots) if (!units.has(root)) problems.push(`${root}: not in solc's output, so the call rule cannot check it`);

  /** A file-level declaration of `path`'s, by node type and name. */
  const fileLevel = (path, nodeType, name, also = () => true) =>
    units.get(path)?.ast.nodes.find((n) => n.nodeType === nodeType && n.name === name && also(n));
  /** The struct declared with AST id `id`, at file level or in a contract, in any compiled file. */
  const structById = (id) => {
    for (const u of units.values()) {
      for (const n of u.ast.nodes) {
        if (n.nodeType === 'StructDefinition' && n.id === id) return n;
        if (n.nodeType === 'ContractDefinition') {
          const inner = (n.nodes ?? []).find((x) => x.nodeType === 'StructDefinition' && x.id === id);
          if (inner) return inner;
        }
      }
    }
    return null;
  };

  // each target's names, resolved in their home files
  const targets = new Map();
  const targetFor = (text) => {
    if (targets.has(text)) return targets.get(text);
    const t = targetOf(text);
    targets.set(text, t);
    if (t.kind === 'cast') {
      // the interface, and the file-level constant at its value
      const pin = pinned[t.address];
      if (!pin) {
        problems.push(`CALL_TARGETS lists ${text}, but PINNED does not fix ${t.address}`);
        return t;
      }
      if (!units.has(pin.path)) return t;
      const constant = fileLevel(pin.path, 'VariableDeclaration', t.address);
      const iface = fileLevel(pin.path, 'ContractDefinition', t.iface, (n) => n.contractKind === 'interface');
      if (!constant) {
        problems.push(`${pin.path}: declares no ${t.address} constant`);
      } else {
        const literal = constant.constant && constant.typeDescriptions?.typeIdentifier === 't_address' && constant.value?.nodeType === 'Literal';
        if (!literal || constant.value.value.toLowerCase() !== pin.value) {
          say(pin.path, constant, `${t.address} must be ${pin.value}, not ${constant.value ? snippet(pin.path, constant.value) : 'unset'}`);
        }
        t.addressId = constant.id;
      }
      if (!iface) problems.push(`${pin.path}: declares no interface ${t.iface}`);
      else t.ifaceId = iface.id;
      return t;
    }
    // a refund: read per library, in its own function (refundsOf)
    if (t.kind === 'refund') return t;
    // a field: the file-level struct, its member holding the pinned interface, and the interface's function
    const key = `${t.struct}.${t.field}`;
    const pin = pinned[key];
    if (!pin) {
      problems.push(`CALL_TARGETS lists ${text}, but PINNED does not fix ${key}`);
      return t;
    }
    if (!units.has(pin.path)) return t;
    const struct = fileLevel(pin.path, 'StructDefinition', t.struct);
    if (!struct) {
      problems.push(`${pin.path}: declares no struct ${t.struct}`);
      return t;
    }
    t.structId = struct.id;
    const member = struct.members.find((m) => m.name === t.field);
    if (!member) {
      problems.push(`${pin.path}: struct ${t.struct} has no field ${t.field}`);
      return t;
    }
    t.memberId = member.id;
    // the whole struct is never written (R1-C N-1): each of its members, and each member of a struct it holds
    // (PayoutBatch: the destination the bridge sends to) when written in memory (a storage pointer's write is
    // the queue's own effect, not the value the vault passed)
    t.members = new Map(struct.members.map((m) => [m.id, `${t.struct}.${m.name}`]));
    t.nested = new Map();
    const held = (s, seen) => {
      for (const m of s.members) {
        const id = m.typeName?.nodeType === 'UserDefinedTypeName' ? m.typeName.referencedDeclaration : null;
        const inner = id === null ? null : structById(id);
        if (!inner || seen.has(inner.id)) continue;
        seen.add(inner.id);
        for (const x of inner.members) t.nested.set(x.id, `${inner.name}.${x.name}`);
        held(inner, seen);
      }
    };
    held(struct, new Set([struct.id]));
    const iface = fileLevel(pin.typePath, 'ContractDefinition', pin.type, (n) => n.contractKind === 'interface');
    if (!iface || member.typeName?.nodeType !== 'UserDefinedTypeName' || member.typeName.referencedDeclaration !== iface.id) {
      say(pin.path, member, `${key} must hold interface ${pin.type} of ${pin.typePath}, not ${snippet(pin.path, member.typeName ?? member)} as solc resolves it`);
      return t;
    }
    const fn = iface.nodes.find((n) => n.nodeType === 'FunctionDefinition' && n.name === t.fn);
    if (!fn) problems.push(`${pin.typePath}: interface ${pin.type} declares no function ${t.fn}`);
    else t.fnId = fn.id;
    return t;
  };

  /** Walks `path`'s library code for `scope`'s rule. */
  const walk = (path, scope) => {
    const { casts, fields, bases, linked, refunds, where, rule } = scope;
    const skipped = new Set(linked.map((l) => l.id).filter(Number.isInteger));
    const callees = new Set();
    const valueLines = new Set();
    const written = new Set();
    const visit = (node) => {
      if (Array.isArray(node)) {
        for (const n of node) visit(n);
        return;
      }
      if (!node || typeof node !== 'object') return;
      // a contract's or an interface's body never reaches a library
      if (node.nodeType === 'ContractDefinition' && node.contractKind !== 'library') return;
      // a linked library's external functions are its own code, run by DELEGATECALL and held by its own rules; its public and internal ones can be compiled into this library, so they are walked
      if (node.nodeType === 'ContractDefinition' && skipped.has(node.id)) {
        for (const n of node.nodes) if (!(n.nodeType === 'FunctionDefinition' && n.visibility === 'external')) visit(n);
        return;
      }
      if (node.nodeType === 'FunctionCall' && node.kind === 'functionCall') {
        const callee = node.expression;
        const core = callee.nodeType === 'FunctionCallOptions' ? callee.expression : callee;
        callees.add(callee).add(core);
        const type = callee.typeDescriptions?.typeIdentifier ?? '';
        const kind = type.startsWith('t_function_') ? functionKinds(type)[0] : undefined;
        const onACast = kind === 'external' && casts.some((c) => onCast(core, c));
        const allowed =
          CALLS_NOTHING.has(kind) ||
          (kind === 'external' && (onACast || fields.some((f) => onField(core, f, bases)))) ||
          (kind === 'barecall' && refunds.allowed.has(node.id)) ||
          (kind === 'delegatecall' && onLinked(core, linked));
        // a cast target's call carries no value (R1-C F-2): {gas} only
        if (onACast && callee.nodeType === 'FunctionCallOptions' && (callee.names ?? []).includes('value')) {
          say(path, node, `a call option {value: …} on ${snippet(path, core)} ${where(path)}: no library call carries value to a cast target (R1-C F-2); {gas} only`);
        }
        if (!allowed) {
          const member = kind === 'external' && core?.nodeType === 'MemberAccess' ? core.expression : null;
          let what = CALL_KIND[kind] ?? `a call solc types as ${callee.typeDescriptions?.typeString ?? 'nothing'}`;
          if (casts.length && member?.kind === 'typeConversion') what = 'an external function on a cast solc does not resolve to the pinned declarations';
          else if (fields.length && member?.nodeType === 'MemberAccess') what = 'an external function on a field solc does not resolve to a vault-passed target';
          else if (refunds.texts.length && kind === 'barecall' && core?.nodeType === 'MemberAccess' && isSender(core.expression)) {
            // a call to msg.sender that is not the refund: name why (R1-C N-2)
            const flaw = refundFlaw(node) || refunds.denied.get(node.id) || 'not the last statement of that function';
            what = `a low-level call to msg.sender that is not ${refunds.texts.join(' or ')}: ${flaw}`;
          }
          say(path, node, `external call: ${snippet(path, callee)}(…), ${what} ${where(path)}, ${rule}`);
        }
      }
      // a field target's field, or the parameter that holds it, written: an assignment's left-hand side (each
      // component of a tuple), a delete's or an increment's operand (solc's AST marks lValueRequested on a member
      // access, not on an identifier, so both are read from the statement)
      for (const target of [...writtenBy(node), ...(node.lValueRequested === true ? [node] : [])]) {
        if (written.has(target)) continue;
        written.add(target);
        const field = target.nodeType === 'MemberAccess' && fields.find((f) => f.memberId === target.referencedDeclaration);
        const whole = !field && target.nodeType === 'MemberAccess' && fields.find((f) => f.members?.has(target.referencedDeclaration));
        const inMemory = /_memory_ptr$/.test(target.expression?.typeDescriptions?.typeIdentifier ?? '');
        const nested =
          !field && !whole && target.nodeType === 'MemberAccess' && inMemory && fields.find((f) => f.nested?.has(target.referencedDeclaration));
        if (field) say(path, target, `writes ${field.struct}.${field.field} (${snippet(path, target)}) ${where(path)}, ${rule}`);
        if (whole) {
          say(path, target, `writes ${whole.members.get(target.referencedDeclaration)} (${snippet(path, target)}), a field of the ${whole.struct} the vault passes (R1-C N-1), ${where(path)}, ${rule}`);
        }
        if (nested) {
          say(path, target, `writes ${nested.nested.get(target.referencedDeclaration)} in memory (${snippet(path, target)}), a field of what the ${nested.struct} the vault passes holds (R1-C N-1), ${where(path)}, ${rule}`);
        }
        const struct =
          target.nodeType === 'Identifier' &&
          fields.find((f) => Number.isInteger(f.structId) && bases.get(target.referencedDeclaration) === f.structId)?.struct;
        if (struct) say(path, target, `reassigns ${target.name}, the ${struct} the vault passes (${snippet(path, target)}) ${where(path)}, ${rule}`);
      }
      if (node.typeDescriptions && !callees.has(node) && !TYPE_NAMES.has(node.nodeType)) {
        if (functionKinds(node.typeDescriptions.typeIdentifier).some((k) => !VALUE_KINDS.has(k))) {
          const line = lineOfNode(path, node);
          if (!valueLines.has(line)) {
            valueLines.add(line);
            say(path, node, `an external function as a value: ${snippet(path, node)} (${node.typeDescriptions.typeString}) ${where(path)}, ${rule}`);
          }
        }
      }
      for (const [key, value] of Object.entries(node)) if (key !== 'typeDescriptions' && value && typeof value === 'object') visit(value);
    };
    visit(units.get(path).ast.nodes);
  };

  /** The libraries `name` links, each with the id of its declaration in its own file (src/libraries/<Name>.sol). */
  const linkedOf = (name) =>
    (linkGraph[name] ?? []).map((lib) => ({
      name: lib,
      id: fileLevel(`src/libraries/${lib}.sol`, 'ContractDefinition', lib, (n) => n.contractKind === 'library')?.id,
    }));
  /** The rule's wording: its targets, then its linked libraries. */
  const ruleOf = (parts) =>
    parts.length === 0 ? 'which makes no external call' : `whose only call target${parts.length === 1 ? ' is' : 's are'} ${parts.join(', ')}`;

  for (const [root, texts] of Object.entries(callTargets)) {
    if (!units.has(root)) continue;
    const name = baseName(root);
    const resolved = texts.map(targetFor);
    const linked = linkedOf(name);
    // the parameters of the library's own external functions, each with its struct's declaration: what the vault
    // passes, the only bases a field target's calls may have
    const bases = new Map();
    const library = fileLevel(root, 'ContractDefinition', name, (n) => n.contractKind === 'library');
    for (const fn of library?.nodes ?? []) {
      if (fn.nodeType !== 'FunctionDefinition' || fn.visibility !== 'external') continue;
      for (const p of fn.parameters?.parameters ?? []) {
        if (p.typeName?.nodeType === 'UserDefinedTypeName' && p.storageLocation === 'memory') bases.set(p.id, p.typeName.referencedDeclaration);
      }
    }
    // each refund target: the one call in the last place of its external function of the library's own, when it has
    // the refund's shape (R1-C N-2) and the function no modifier, whose code after `_` would run after the refund;
    // any other call to msg.sender fails with the reason
    const refunds = { texts: [], allowed: new Set(), denied: new Map() };
    for (const t of resolved.filter((x) => x.kind === 'refund')) {
      refunds.texts.push(t.text);
      const fn = (library?.nodes ?? []).find((n) => n.nodeType === 'FunctionDefinition' && n.name === t.fn && n.visibility === 'external');
      if (!fn) {
        problems.push(`${root}: CALL_TARGETS lists ${t.text}, but ${name} has no external function ${t.fn}`);
        continue;
      }
      const call = lastCall(fn.body?.statements ?? []);
      if (!call || refundFlaw(call)) continue;
      const modifiers = (fn.modifiers ?? []).map((m) => m.modifierName?.name ?? snippet(root, m));
      if (modifiers.length) refunds.denied.set(call.id, `${t.fn} has a modifier (${modifiers.join(', ')}), whose code could run after it`);
      else refunds.allowed.add(call.id);
    }
    const scope = {
      casts: resolved.filter((t) => t.kind === 'cast'),
      fields: resolved.filter((t) => t.kind === 'field'),
      bases,
      linked,
      refunds,
      where: (path) => (path === root ? `in ${name}` : `in ${path}, compiled into ${name}`),
      rule: ruleOf([...texts, ...linked.map((l) => `the linked ${l.name} (by DELEGATECALL)`)]),
    };
    for (const path of astClosure(compiled, root)) walk(path, scope);
  }
  for (const path of noExternalCall) {
    if (!units.has(path)) continue;
    const linked = linkedOf(baseName(path));
    walk(path, {
      casts: [],
      fields: [],
      bases: new Map(),
      linked,
      refunds: { texts: [], allowed: new Set(), denied: new Map() },
      where: () => `in ${baseName(path)}`,
      rule: ruleOf(linked.map((l) => `the linked ${l.name} (by DELEGATECALL)`)),
    });
  }
  return problems;
}

// ---- the assembly rule, on solc's AST (R1-C F-1) ----

/** The files the AST rules compile, sorted: the call rule's (callRuleRoots), every linked library the source rules
 * start from (libraryRoots), whose closures the assembly rule walks, and, when a WRITE_SETS library is in `sources`,
 * WRITE_SET_CALLER, whose call sites the write-set rule reads in the same solc run. */
export function astRoots(sources, writeSets = WRITE_SETS, caller = WRITE_SET_CALLER) {
  const writers = Object.keys(writeSets).some((p) => sources.has(p)) && sources.has(caller) ? [caller] : [];
  return [...new Set([...callRuleRoots(sources), ...libraryRoots(sources), ...writers])].sort();
}

/** The assembly rule's problems over `compiled` (compileAsts), each "<file>:<line>: <what>". In the first-party
 * closure of each of `roots` (as solc resolved the imports; library code only: a contract's or an interface's body
 * never reaches a library; a vendored file, OpenZeppelin's Math, is the recorded exception), no InlineAssembly node
 * at all (R1-C F-1 and its ruling: no library may hold assembly, a memory-only mstore in an external function
 * included). `roots` defaults to the compiled linked libraries (a *Lib.sol or the payout math: not the vault, which
 * the write-set rule compiles alongside). A compile error is a problem: no AST, no check. */
export function assemblyProblems(compiled, { roots = compiled.roots.filter(isRootPath) } = {}) {
  if (compiled.errors.length) {
    return compiled.errors.map((e) => `${e.where}: does not compile, so the assembly rule cannot read solc's AST: error ${e.code}: ${e.message}`);
  }
  const { units } = compiled;
  const problems = [];
  const lineOfNode = (path, node) => lineAt(units.get(path).bytes, Number.parseInt(node.src, 10));
  const files = new Set();
  for (const root of roots) {
    if (!units.has(root)) {
      problems.push(`${root}: not in solc's output, so the assembly rule cannot check it`);
      continue;
    }
    for (const p of astClosure(compiled, root)) if (isFirstParty(p)) files.add(p);
  }
  for (const path of [...files].sort()) {
    const visit = (node, library, fn) => {
      if (Array.isArray(node)) {
        for (const n of node) visit(n, library, fn);
        return;
      }
      if (!node || typeof node !== 'object') return;
      if (node.nodeType === 'ContractDefinition') {
        if (node.contractKind !== 'library') return;
        library = node;
      }
      if (node.nodeType === 'FunctionDefinition') fn = node;
      if (node.nodeType === 'InlineAssembly') {
        const owner = fn?.name ? `${library?.name ?? '(file level)'}.${fn.name}` : (library?.name ?? '(file level)');
        problems.push(`${path}:${lineOfNode(path, node)}: assembly in ${owner}, compiled into a linked library: no library may hold any (R1-C F-1)`);
        return;
      }
      for (const [key, value] of Object.entries(node)) if (key !== 'typeDescriptions' && value && typeof value === 'object') visit(value, library, fn);
    };
    visit(units.get(path).ast.nodes, null, null);
  }
  return problems;
}

// ---- the write-set rule, on solc's AST (L4) ----

/** Whether a type identifier is a storage reference: a storage pointer or a mapping (which lives only there). */
const isStorageType = (typeIdentifier) => /_storage(_ptr)?$/.test(typeIdentifier ?? '') || (typeIdentifier ?? '').startsWith('t_mapping');

/** What `e` writes into as solc resolved it: { id, path, indexed }, its root declaration's AST id, the members named
 * from that root down to the first index (`ledger.booked` -> ['booked']; `isHotkey[h]` -> [], indexed; a member of
 * an element is its whole array's or mapping's), or null for an expression no root names (a call's result, a
 * conditional). A pushed element (`x.push() = …`) is its array's. */
function rootOf(e) {
  switch (e?.nodeType) {
    case 'Identifier':
      return { id: e.referencedDeclaration, path: [], indexed: false };
    case 'MemberAccess': {
      const r = rootOf(e.expression);
      return r && (r.indexed ? r : { ...r, path: [...r.path, e.memberName] });
    }
    case 'IndexAccess':
    case 'IndexRangeAccess': {
      const r = rootOf(e.baseExpression);
      return r && { ...r, indexed: true };
    }
    case 'TupleExpression':
      return !e.isInlineArray && e.components?.length === 1 ? rootOf(e.components[0]) : null;
    case 'FunctionCall': {
      const kind = functionKinds(e.expression?.typeDescriptions?.typeIdentifier)[0];
      if (kind !== 'arraypush' || e.expression.nodeType !== 'MemberAccess') return null;
      const r = rootOf(e.expression.expression);
      return r && { ...r, indexed: true };
    }
    default:
      return null;
  }
}

/** Whether `e`, or what it is read out of (a member's, an element's base), is a storage reference. */
function touchesStorage(e) {
  for (let x = e; x; x = x.expression ?? x.baseExpression) {
    if (isStorageType(x.typeDescriptions?.typeIdentifier)) return true;
    if (!['MemberAccess', 'IndexAccess', 'IndexRangeAccess'].includes(x.nodeType)) return false;
  }
  return false;
}

/** The write-set rule's problems over `compiled` (compileAsts, with WRITE_SET_CALLER among its roots), each
 * "<file>:<line>: <what>" or a line of its own. For each WRITE_SETS library, on solc's AST:
 *   - every storage write in the code its external and public functions run (theirs and, through internal calls,
 *     the helpers they compile in: an assignment, a compound assignment, a tuple's component, a delete, an
 *     increment, a push or a pop) is traced to the storage parameter it writes through, with the members it names
 *     (`ledger.booked`), across internal calls (each callee's writes through its parameters land on the caller's
 *     arguments, a using-for receiver included); a write the rule cannot trace fails closed: through a storage
 *     pointer local, through a returned storage pointer, a storage pointer reassigned, a storage argument to a call
 *     the rule cannot resolve (a function pointer, a DELEGATECALL), a recursive call or a modifier;
 *   - every call site of the library's external functions, in solc's run, is in `caller` and binds each storage
 *     parameter to one of its state variables by name (an identifier solc resolves to a state variable: not a
 *     local, a parameter or an expression), so each write names the vault's storage it reaches;
 *   - each write so named (`<state variable>[.<member>…]`) is one of the library's entries or under one (an entry
 *     `hotkeys` covers `hotkeys` and its elements; `ledger.booked` does not cover `ledger` whole), and each entry is
 *     written somewhere: the set is exactly what the library writes.
 * Libraries hold no state variable (the source rules) and no assembly (the assembly rule), so their storage
 * pointers are the only way they write the caller's storage, and those come only from the caller. A compile error
 * is a problem: no AST, no check. */
export function writeSetProblems(compiled, { writeSets = WRITE_SETS, caller = WRITE_SET_CALLER } = {}) {
  if (compiled.errors.length) {
    return compiled.errors.map((e) => `${e.where}: does not compile, so the write-set rule cannot read solc's AST: error ${e.code}: ${e.message}`);
  }
  const { units } = compiled;
  const problems = [];
  const say = (path, node, what) => {
    const p = `${path}:${lineAt(units.get(path).bytes, Number.parseInt(node.src, 10))}: ${what}`;
    if (!problems.includes(p)) problems.push(p);
  };
  const snippet = (path, node) => {
    const [start, length] = node.src.split(':').map(Number);
    const text = units.get(path).bytes.subarray(start, start + length).toString('utf8').replace(/\s+/g, ' ').trim();
    return text.length > 64 ? `${text.slice(0, 63)}…` : text;
  };

  // every function and variable declaration in solc's run, by AST id
  const fns = new Map();
  const vars = new Map();
  for (const [path, u] of units) {
    const index = (node, fn) => {
      if (Array.isArray(node)) {
        for (const n of node) index(n, fn);
        return;
      }
      if (!node || typeof node !== 'object') return;
      if (node.nodeType === 'FunctionDefinition') {
        fns.set(node.id, { node, path });
        (node.parameters?.parameters ?? []).forEach((p, i) => vars.set(p.id, { node: p, path, kind: 'param', fn: node.id, index: i }));
        for (const p of node.returnParameters?.parameters ?? []) vars.set(p.id, { node: p, path, kind: 'return', fn: node.id });
        index(node.body, node);
        index(node.modifiers, node);
        return;
      }
      if (node.nodeType === 'VariableDeclaration' && !vars.has(node.id)) {
        vars.set(node.id, { node, path, kind: node.stateVariable ? 'state' : fn ? 'local' : 'other' });
      }
      for (const [key, value] of Object.entries(node)) if (key !== 'typeDescriptions' && value && typeof value === 'object') index(value, fn);
    };
    index(u.ast.nodes, null);
  }

  /** The writes of function `id` through its own storage parameters, as { index, path, indexed, at: [path, node] }
   * (memoized); what it cannot trace is a problem, said once. */
  const summaries = new Map();
  const running = new Set();
  const summary = (id, where) => {
    if (summaries.has(id)) return summaries.get(id);
    const f = fns.get(id);
    if (running.has(id)) {
      say(f.path, f.node, `${f.node.name} calls itself (recursion) ${where}: the write-set rule does not trace it`);
      return [];
    }
    running.add(id);
    const writes = [];
    const path = f.path;
    if ((f.node.modifiers ?? []).length) say(path, f.node, `${f.node.name} has a modifier ${where}: the write-set rule does not trace it`);
    /** A write into `target` (or, for a callee's write, `extra` below it), recorded on this function's parameter. */
    const record = (target, node, extra = { path: [], indexed: false }, at = [path, node]) => {
      const r = rootOf(target);
      if (!r) {
        if (touchesStorage(target)) say(path, node, `a storage write the rule cannot trace (${snippet(path, node)}) ${where}`);
        return;
      }
      const v = vars.get(r.id);
      if (!v || v.node.storageLocation !== 'storage' && !(v.node.typeDescriptions?.typeIdentifier ?? '').startsWith('t_mapping')) {
        // memory, calldata or a value: not storage (a constant cannot be written)
        if (!v || v.kind === 'state' || v.kind === 'other') say(path, node, `a write the rule cannot trace (${snippet(path, node)}) ${where}`);
        return;
      }
      if (v.kind !== 'param' || v.fn !== id) {
        say(path, node, `a storage write through ${v.node.name}, not one of ${f.node.name}'s parameters (${snippet(path, node)}) ${where}: the write-set rule traces parameters only`);
        return;
      }
      const indexed = r.indexed || extra.indexed;
      writes.push({ index: v.index, path: r.indexed ? r.path : [...r.path, ...extra.path], indexed, at });
    };
    const visit = (node) => {
      if (Array.isArray(node)) {
        for (const n of node) visit(n);
        return;
      }
      if (!node || typeof node !== 'object') return;
      // a type name writes nothing (a function type's `Ledger storage` parameter is a declaration of no variable)
      if (TYPE_NAMES.has(node.nodeType)) return;
      if (node.nodeType === 'VariableDeclaration' && node.storageLocation === 'storage') {
        say(path, node, `a storage pointer local ${node.name} ${where}: the write-set rule traces parameters only`);
      }
      if (node.nodeType === 'Assignment' && node.operator === '=') {
        for (const t of writtenBy(node)) {
          if (t.nodeType === 'Identifier' && vars.get(t.referencedDeclaration)?.node.storageLocation === 'storage') {
            say(path, t, `reassigns the storage pointer ${t.name} ${where}: the write-set rule traces each pointer to the parameter it starts as`);
          }
        }
      }
      for (const t of writtenBy(node)) record(t, t);
      if (node.nodeType === 'FunctionCall' && node.kind === 'functionCall') {
        const callee = node.expression;
        const core = callee.nodeType === 'FunctionCallOptions' ? callee.expression : callee;
        const kind = functionKinds(callee.typeDescriptions?.typeIdentifier)[0];
        if ((kind === 'arraypush' || kind === 'arraypop') && core.nodeType === 'MemberAccess') {
          record(core.expression, node, { path: [], indexed: true });
        } else if (kind === 'internal') {
          const target = fns.get(core.referencedDeclaration);
          const bound = core.nodeType === 'MemberAccess' && !(core.expression.typeDescriptions?.typeString ?? '').startsWith('type(');
          const args = bound ? [core.expression, ...node.arguments] : node.arguments;
          if (!target) {
            if (args.some(touchesStorage)) say(path, node, `a storage argument to a call the rule cannot resolve (${snippet(path, callee)}) ${where}`);
          } else {
            for (const w of summary(target.node.id, where)) {
              const arg = args[w.index];
              if (arg) record(arg, node, w, w.at);
              else say(path, node, `a write through a parameter the call does not pass (${snippet(path, callee)}) ${where}`);
            }
          }
        } else if (node.arguments.some(touchesStorage) && !CALLS_NOTHING.has(kind)) {
          say(path, node, `a storage argument to ${CALL_KIND[kind] ?? 'a call'} (${snippet(path, callee)}) ${where}: the write-set rule does not trace it`);
        }
      }
      for (const [key, value] of Object.entries(node)) if (key !== 'typeDescriptions' && value && typeof value === 'object') visit(value);
    };
    visit(f.node.body);
    running.delete(id);
    summaries.set(id, writes);
    return writes;
  };

  for (const [root, entries] of Object.entries(writeSets)) {
    if (!units.has(root)) continue;
    if (!units.has(caller)) {
      problems.push(`${caller}: not in solc's output, so the write-set rule cannot read ${baseName(root)}'s call sites`);
      continue;
    }
    const name = baseName(root);
    const where = `compiled into ${name}`;
    const library = units.get(root).ast.nodes.find((n) => n.nodeType === 'ContractDefinition' && n.name === name && n.contractKind === 'library');
    if (!library) {
      problems.push(`${root}: declares no library ${name}`);
      continue;
    }
    const used = new Set();
    const written = new Map();
    for (const fn of library.nodes.filter((n) => n.nodeType === 'FunctionDefinition' && ['external', 'public'].includes(n.visibility))) {
      const writes = summary(fn.id, where);
      // the call sites: each storage parameter bound to one of the caller's state variables
      const bindings = new Map();
      for (const [path, u] of units) {
        const visit = (node) => {
          if (Array.isArray(node)) {
            for (const n of node) visit(n);
            return;
          }
          if (!node || typeof node !== 'object') return;
          if (node.nodeType === 'FunctionCall' && node.kind === 'functionCall') {
            const callee = node.expression.nodeType === 'FunctionCallOptions' ? node.expression.expression : node.expression;
            const kind = functionKinds(node.expression.typeDescriptions?.typeIdentifier)[0];
            if (callee.referencedDeclaration === fn.id && kind === 'delegatecall' && isBoundLibraryCall(node)) {
              // a using-for receiver is the first parameter, so the arguments do not line up with the parameters:
              // refused, never bound (fix round 1, M-2; boundCallProblems refuses it for every linked library)
              say(path, node, `calls ${name}.${fn.name} through using-for (${snippet(path, node.expression)}): the write-set rule binds its storage only on a direct call (${name}.${fn.name}(…))`);
            } else if (callee.referencedDeclaration === fn.id && kind === 'delegatecall') {
              if (path !== caller) say(path, node, `calls ${name}.${fn.name} (${snippet(path, node.expression)}), but only ${caller} may: the write-set rule binds its storage there`);
              fn.parameters.parameters.forEach((p, i) => {
                if (p.storageLocation !== 'storage') return;
                const arg = node.arguments[i];
                const v = arg?.nodeType === 'Identifier' ? vars.get(arg.referencedDeclaration) : null;
                if (v?.kind !== 'state') {
                  say(path, arg ?? node, `passes ${name}.${fn.name}'s ${p.name} ${arg ? snippet(path, arg) : 'nothing'}, not a state variable by name: the write-set rule cannot name the storage it writes`);
                  return;
                }
                if (!bindings.has(i)) bindings.set(i, new Set());
                bindings.get(i).add(v.node.name);
              });
            }
          }
          for (const [key, value] of Object.entries(node)) if (key !== 'typeDescriptions' && value && typeof value === 'object') visit(value);
        };
        visit(u.ast.nodes);
      }
      for (const w of writes) {
        const names = bindings.get(w.index);
        const [atPath, atNode] = w.at;
        if (!names) {
          say(atPath, atNode, `${name}.${fn.name} writes through its ${fn.parameters.parameters[w.index].name}, which no call site binds to the caller's storage (${snippet(atPath, atNode)})`);
          continue;
        }
        for (const v of names) {
          const full = [v, ...w.path].join('.');
          written.set(full, w.at);
          const entry = entries.find((e) => full === e || full.startsWith(`${e}.`));
          if (entry) used.add(entry);
          else {
            say(atPath, atNode, `writes ${full} (${snippet(atPath, atNode)}) ${where}, outside its write set (WRITE_SETS: ${entries.join(', ') || 'nothing'})`);
          }
        }
      }
    }
    for (const e of entries) {
      if (!used.has(e)) problems.push(`WRITE_SETS lists ${e} for ${name}, which it never writes: the set must be exactly what it writes`);
    }
  }
  return problems;
}

// ---- the precompile rule, on solc's AST (fix round 1, M-1: Task 42a's per-function allow-list) ----

/** The function definitions, modifier definitions and the contract each is declared in, across `compiled`'s run, by
 * AST id. */
function declarationsOf(compiled) {
  const fns = new Map();
  for (const [path, u] of compiled.units) {
    const visit = (node, contract) => {
      if (Array.isArray(node)) {
        for (const n of node) visit(n, contract);
        return;
      }
      if (!node || typeof node !== 'object') return;
      if (node.nodeType === 'ContractDefinition') contract = node;
      if (node.nodeType === 'FunctionDefinition' || node.nodeType === 'ModifierDefinition') fns.set(node.id, { node, path, contract });
      for (const [key, value] of Object.entries(node)) if (key !== 'typeDescriptions' && value && typeof value === 'object') visit(value, contract);
    };
    visit(u.ast.nodes, null);
  }
  return fns;
}

/** The precompile rule's problems over `compiled` (compileAsts), each "<file>:<line>: <what>" or a line of its own.
 * For each PRECOMPILE_FUNCTIONS library, every call of a function of the pinned interface (IStaking.sol's
 * `interface IStaking`, which the call rule's cast resolves to) in the code the library's external and public
 * functions reach (their bodies and modifiers, and every function or modifier they reference, through internal calls
 * and internal function values, transitively: the code compiled into the library) names one of its listed functions;
 * and each listed function is called there, so the list is exactly what it calls. Code a closure holds but no external
 * function reaches is not compiled into the library and is not its call. A library the call rule lets call the
 * precompile (a cast target in CALL_TARGETS) must have an entry. The interface inherits nothing (fix round 2: a base
 * interface's functions are not IStaking's own declarations, so the lists could not see them), and a call on a value
 * of its type to a function it does not declare itself is refused too, whatever the lists say. A compile error is a
 * problem: no AST, no check. */
export function precompileFunctionProblems(
  compiled,
  { precompileFunctions = PRECOMPILE_FUNCTIONS, callTargets = CALL_TARGETS, pinned = PINNED } = {},
) {
  if (compiled.errors.length) {
    return compiled.errors.map((e) => `${e.where}: does not compile, so the precompile rule cannot read solc's AST: error ${e.code}: ${e.message}`);
  }
  const { units } = compiled;
  const problems = [];
  const say = (path, node, what) => {
    const p = `${path}:${lineAt(units.get(path).bytes, Number.parseInt(node.src, 10))}: ${what}`;
    if (!problems.includes(p)) problems.push(p);
  };
  const snippet = (path, node) => {
    const [start, length] = node.src.split(':').map(Number);
    const text = units.get(path).bytes.subarray(start, start + length).toString('utf8').replace(/\s+/g, ' ').trim();
    return text.length > 64 ? `${text.slice(0, 63)}…` : text;
  };
  for (const [root, texts] of Object.entries(callTargets)) {
    if (units.has(root) && texts.some((t) => targetOf(t).kind === 'cast') && !precompileFunctions[root]) {
      problems.push(`${root}: CALL_TARGETS lets ${baseName(root)} call the precompile, but PRECOMPILE_FUNCTIONS lists none of its functions`);
    }
  }
  const home = pinned.ISTAKING_ADDRESS?.path;
  const iface = units.get(home)?.ast.nodes.find((n) => n.nodeType === 'ContractDefinition' && n.name === 'IStaking' && n.contractKind === 'interface');
  const roots = Object.keys(precompileFunctions).filter((r) => units.has(r));
  if (!iface) {
    if (roots.length) problems.push(`${home}: declares no interface IStaking, so the precompile rule cannot name its functions`);
    return problems;
  }
  // the interface inherits nothing (fix round 2): its functions are exactly the ones it declares, which the lists name
  if ((iface.baseContracts ?? []).length) {
    const bases = iface.baseContracts.map((b) => b.baseName?.name ?? snippet(home, b)).join(', ');
    say(home, iface, `interface IStaking inherits ${bases}: the precompile rule pins only the functions IStaking declares itself, so the staking interface may inherit nothing`);
  }
  const precompile = new Map(iface.nodes.filter((n) => n.nodeType === 'FunctionDefinition').map((n) => [n.id, n.name]));
  /** Whether `e` has the type of the pinned interface: the cast `IStaking(…)`, or any value solc types as it. */
  const onInterface = (e) => e?.typeDescriptions?.typeIdentifier === `t_contract$_IStaking_$${iface.id}`;
  const decls = declarationsOf(compiled);
  for (const root of roots) {
    const name = baseName(root);
    const allowed = precompileFunctions[root];
    const library = units.get(root).ast.nodes.find((n) => n.nodeType === 'ContractDefinition' && n.name === name && n.contractKind === 'library');
    if (!library) {
      problems.push(`${root}: declares no library ${name}`);
      continue;
    }
    // the code compiled into the library: its external and public functions and everything they reference
    const queue = library.nodes.filter((n) => n.nodeType === 'FunctionDefinition' && ['external', 'public'].includes(n.visibility)).map((n) => n.id);
    const reached = new Set(queue);
    const called = new Set();
    while (queue.length) {
      const d = decls.get(queue.shift());
      const visit = (node) => {
        if (Array.isArray(node)) {
          for (const n of node) visit(n);
          return;
        }
        if (!node || typeof node !== 'object') return;
        if (node.nodeType === 'FunctionCall' && node.kind === 'functionCall') {
          const core = node.expression.nodeType === 'FunctionCallOptions' ? node.expression.expression : node.expression;
          const fn = precompile.get(core.referencedDeclaration);
          // belt and braces (fix round 2): a function called on the interface that IStaking does not declare itself
          // (an inherited one) is refused, whatever the lists say
          if (fn === undefined && core.nodeType === 'MemberAccess' && onInterface(core.expression)) {
            say(d.path, node, `calls ${core.memberName} on the staking interface (${snippet(d.path, node)}) ${d.path === root ? `in ${name}` : `in ${d.path}, compiled into ${name}`}, a function IStaking does not declare itself: the precompile rule refuses it`);
          }
          if (fn !== undefined) {
            called.add(fn);
            if (!allowed.includes(fn)) {
              say(d.path, node, `calls IStaking.${fn} (${snippet(d.path, node)}) ${d.path === root ? `in ${name}` : `in ${d.path}, compiled into ${name}`}, which may call only ${allowed.join(', ')} of the precompile (PRECOMPILE_FUNCTIONS)`);
            }
          }
        }
        // a function or modifier it references (called, bound or taken as a value) is compiled in, unless it is
        // another contract's external function (a call, the call rule's) or the precompile's
        const ref = decls.get(node.referencedDeclaration ?? node.modifierName?.referencedDeclaration);
        if (ref && !reached.has(ref.node.id) && ref.node.body && !(ref.node.visibility === 'external' && ref.contract?.id !== library.id)) {
          reached.add(ref.node.id);
          queue.push(ref.node.id);
        }
        for (const [key, value] of Object.entries(node)) if (key !== 'typeDescriptions' && value && typeof value === 'object') visit(value);
      };
      visit(d.node.body);
      visit(d.node.modifiers);
    }
    for (const fn of allowed) {
      if (!called.has(fn)) problems.push(`PRECOMPILE_FUNCTIONS lists ${fn} for ${name}, which its code never calls: the list must be exactly what it calls`);
    }
  }
  return problems;
}

// ---- linked-library calls through using-for (fix round 1, M-2) ----

/** The problems of every call into a linked library's external or public function (a DELEGATECALL) made through
 * `using … for` (`x.f(…)` with `x` bound to the first parameter), anywhere in `compiled`: refused, since the library
 * rules (the write-set rule's binding above all) read a linked library's arguments positionally, on a direct call
 * `Library.f(…)`. The vault uses no such call. A compile error is a problem: no AST, no check. */
export function boundCallProblems(compiled) {
  if (compiled.errors.length) {
    return compiled.errors.map((e) => `${e.where}: does not compile, so the using-for rule cannot read solc's AST: error ${e.code}: ${e.message}`);
  }
  const { units } = compiled;
  const problems = [];
  const decls = declarationsOf(compiled);
  for (const [path, u] of units) {
    const visit = (node) => {
      if (Array.isArray(node)) {
        for (const n of node) visit(n);
        return;
      }
      if (!node || typeof node !== 'object') return;
      if (node.nodeType === 'FunctionCall' && node.kind === 'functionCall' && isBoundLibraryCall(node)) {
        const core = node.expression.nodeType === 'FunctionCallOptions' ? node.expression.expression : node.expression;
        const d = decls.get(core.referencedDeclaration);
        const fn = `${d?.contract?.name ?? '?'}.${core.memberName}`;
        const [start, length] = node.src.split(':').map(Number);
        const text = u.bytes.subarray(start, start + length).toString('utf8').replace(/\s+/g, ' ').trim();
        problems.push(
          `${path}:${lineAt(u.bytes, start)}: calls the linked library function ${fn} through using-for (${text.length > 64 ? `${text.slice(0, 63)}…` : text}): the library rules read a linked library's arguments only on a direct call (${fn}(…)), so this form is refused`,
        );
      }
      for (const [key, value] of Object.entries(node)) if (key !== 'typeDescriptions' && value && typeof value === 'object') visit(value);
    };
    visit(u.ast.nodes);
  }
  return problems;
}

/** Whether call `node` is a linked library's external or public function (a DELEGATECALL) on a using-for receiver:
 * `x.f(…)`, the callee a member of a value, not of the library's type. */
function isBoundLibraryCall(node) {
  const core = node.expression.nodeType === 'FunctionCallOptions' ? node.expression.expression : node.expression;
  const kind = functionKinds(node.expression.typeDescriptions?.typeIdentifier)[0];
  return kind === 'delegatecall' && core.nodeType === 'MemberAccess' && !(core.expression.typeDescriptions?.typeString ?? '').startsWith('type(');
}

// ---- Task 42a: the code compiled in, followed through solc's references ----

/** Walks the code `seeds` compile in (each { path, node, owner, site }: a function, a modifier or a whole contract, the
 * name of whose code it is, and the first-party place that brought it in), then every function or modifier that code
 * references (called, bound by using-for, taken as a value, invoked as a modifier, or a user-defined operator), as
 * solc resolved it, transitively, unless `skip(decl)` (another contract's external function: a call or a DELEGATECALL,
 * its own code). Calls `visit(path, node, owner, site)` on every node walked: `owner` names the function the node is
 * in ("Math.tryModExp"), `site` is [path, node] of the first-party place that brought the code in (a reference in a
 * first-party file; for code a vendored file holds, the first-party reference that reached it). */
function walkCompiledCode(decls, seeds, skip, visit) {
  const queue = [];
  const queued = new Set();
  // one walk per declaration and first-party place that reaches it, so each place is named
  const push = (item) => {
    const key = `${item.node.id}@${item.site[0]}:${item.site[1].id}`;
    if (queued.has(key)) return;
    queued.add(key);
    queue.push(item);
  };
  for (const s of seeds) push(s);
  while (queue.length) {
    const { path, node, owner, site } = queue.shift();
    const walk = (n, fnName) => {
      if (Array.isArray(n)) {
        for (const x of n) walk(x, fnName);
        return;
      }
      if (!n || typeof n !== 'object') return;
      const here = n.nodeType === 'FunctionDefinition' || n.nodeType === 'ModifierDefinition' ? `${owner.split('.')[0]}.${n.name || n.kind}` : fnName;
      visit(path, n, here, site);
      for (const id of [n.referencedDeclaration, n.function]) {
        const d = Number.isInteger(id) ? decls.get(id) : undefined;
        if (!d || !d.node.body || skip(d)) continue;
        const name = `${d.contract?.name ?? '(file level)'}.${d.node.name || d.node.kind}`;
        push({ path: d.path, node: d.node, owner: name, site: isFirstParty(path) ? [path, n] : site });
      }
      for (const [key, value] of Object.entries(n)) if (key !== 'typeDescriptions' && value && typeof value === 'object') walk(value, here);
    };
    walk(node, owner);
  }
}

/** The Yul builtins of `names` that inline assembly node `node` calls, each { name, node }. */
function yulCallsIn(node, names) {
  const found = [];
  const visit = (n) => {
    if (Array.isArray(n)) {
      for (const x of n) visit(x);
      return;
    }
    if (!n || typeof n !== 'object') return;
    if (n.nodeType === 'YulFunctionCall' && names.includes(n.functionName?.name)) found.push({ name: n.functionName.name, node: n });
    for (const [key, value] of Object.entries(n)) if (key !== 'typeDescriptions' && value && typeof value === 'object') visit(value);
  };
  visit(node);
  return found;
}

/** "<file>:<line>" of AST node `node` in `path` of `compiled`. */
const placeOf = (compiled, path, node) => `${path}:${lineAt(compiled.units.get(path).bytes, Number.parseInt(node.src, 10))}`;

// ---- the Yul call rule, on solc's AST (Task 42a, the 5f carry) ----

/** The Yul call rule's problems over `compiled` (compileAsts), each "<file>:<line>: <what>". For each of `roots` (the
 * compiled linked libraries by default), the code compiled into it (its external and public functions and every
 * function or modifier they reference, transitively, vendored code included; another library's external function is
 * its own code, held by its own rules) reaches no function whose inline assembly calls one of YUL_CALLS. A problem
 * names the first-party place that reaches it (in the library, or in a helper compiled into it). The assembly rule
 * refuses any first-party assembly; this one also reads the vendored files it skips (OpenZeppelin's Math, whose
 * modExp STATICCALLs the 0x05 precompile). A compile error is a problem: no AST, no check. */
export function yulCallProblems(compiled, { roots = compiled.roots.filter(isRootPath), calls = YUL_CALLS } = {}) {
  if (compiled.errors.length) {
    return compiled.errors.map((e) => `${e.where}: does not compile, so the Yul call rule cannot read solc's AST: error ${e.code}: ${e.message}`);
  }
  const { units } = compiled;
  const problems = [];
  const say = (p) => {
    if (!problems.includes(p)) problems.push(p);
  };
  const decls = declarationsOf(compiled);
  for (const root of roots) {
    const name = baseName(root);
    const library = units.get(root)?.ast.nodes.find((n) => n.nodeType === 'ContractDefinition' && n.name === name && n.contractKind === 'library');
    if (!library) {
      say(`${root}: declares no library ${name} in solc's output, so the Yul call rule cannot check it`);
      continue;
    }
    const seeds = library.nodes
      .filter((n) => n.nodeType === 'FunctionDefinition' && ['external', 'public'].includes(n.visibility))
      .map((n) => ({ path: root, node: n, owner: `${name}.${n.name}`, site: [root, n] }));
    const skip = (d) => d.node.visibility === 'external' && d.contract?.id !== library.id;
    walkCompiledCode(decls, seeds, skip, (path, node, owner, site) => {
      if (node.nodeType !== 'InlineAssembly') return;
      for (const y of yulCallsIn(node, calls)) {
        say(
          `${placeOf(compiled, site[0], site[1])}: ${name} compiles in ${owner} (${placeOf(compiled, path, y.node)}), whose assembly makes a ${y.name}: no code compiled into a library may call out or create from assembly (Task 42a; OpenZeppelin's Math.modExp is such a function, and no library may reach it)`,
        );
      }
    });
  }
  return problems;
}

// ---- the delegatecall rule (Task 42a, the 5e review's minor 5) ----

/** The delegatecall rule's text problems over `sources` (every first-party file of src/, src/vendor aside; loadSources),
 * each "<file>:<line>: <what>": no `delegatecall` or `callcode` in code (comments and strings blanked), contracts and
 * interfaces included, so neither Solidity's low-level call nor Yul's builtin appears in first-party code. */
export function delegatecallSourceProblems(sources) {
  const problems = [];
  for (const [path, text] of [...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!isFirstParty(path)) continue;
    const code = stripComments(text);
    for (const m of code.matchAll(/\b(delegatecall|callcode)\b/g)) {
      problems.push(`${path}:${lineOf(code, m.index)}: ${m[1]} in src/ code: the vault's only DELEGATECALLs are to its linked libraries (I-32), and nothing in src/ makes one itself`);
    }
  }
  return problems;
}

/** The delegatecall rule's AST problems over `compiled` (compileAsts), each "<file>:<line>: <what>" or a line of its
 * own. For each contract `graph` lists (the vault, and L3), the code compiled into it (its own and its bases' code,
 * whole, and every function or modifier it references, transitively, vendored code included; a linked library's
 * external function is that library's own code) makes no low-level delegatecall or callcode, no Yul delegatecall or
 * callcode, and DELEGATECALLs (an external or public library function) only the libraries `graph` says it links. So
 * the bytecode backstop, which cannot tell a library's DELEGATECALL from another, is held where it allows one. A
 * contract `graph` lists that is not in the run fails closed. A compile error is a problem: no AST, no check. */
export function delegatecallAstProblems(compiled, { graph = LINK_GRAPH } = {}) {
  if (compiled.errors.length) {
    return compiled.errors.map((e) => `${e.where}: does not compile, so the delegatecall rule cannot read solc's AST: error ${e.code}: ${e.message}`);
  }
  const { units } = compiled;
  const problems = [];
  const say = (p) => {
    if (!problems.includes(p)) problems.push(p);
  };
  const decls = declarationsOf(compiled);
  const contracts = new Map();
  for (const [path, u] of units) {
    for (const n of u.ast.nodes) if (n.nodeType === 'ContractDefinition') contracts.set(n.id, { path, node: n });
  }
  for (const [name, links] of Object.entries(graph)) {
    const own = [...contracts.values()].find((c) => c.node.name === name && isFirstParty(c.path));
    if (!own) {
      say(`${name}: LINK_GRAPH lets it DELEGATECALL its libraries, but it is not in solc's run, so the delegatecall rule cannot read its code`);
      continue;
    }
    const bases = (own.node.linearizedBaseContracts ?? [own.node.id]).map((id) => contracts.get(id)).filter(Boolean);
    const ids = new Set(bases.map((b) => b.node.id));
    // each base's code is compiled in whole; a vendored base is reached through the contract's own declaration
    const seeds = bases.map((b) => ({ path: b.path, node: b.node, owner: `${b.node.name}`, site: isFirstParty(b.path) ? [b.path, b.node] : [own.path, own.node] }));
    // its bases are walked whole; another contract's external function is a call (a linked library's, its own code)
    const skip = (d) => ids.has(d.contract?.id) || d.node.visibility === 'external';
    walkCompiledCode(decls, seeds, skip, (path, node, owner, site) => {
      const at = isFirstParty(path) ? [path, node] : site;
      const where = placeOf(compiled, at[0], at[1]);
      const what = isFirstParty(path) ? '' : `compiles in ${owner} (${placeOf(compiled, path, node)}), which `;
      if (node.nodeType === 'FunctionCall' && node.kind === 'functionCall') {
        const callee = node.expression.nodeType === 'FunctionCallOptions' ? node.expression.expression : node.expression;
        const kind = functionKinds(node.expression.typeDescriptions?.typeIdentifier)[0];
        if (kind === 'baredelegatecall' || kind === 'barecallcode') {
          const op = kind === 'baredelegatecall' ? 'delegatecall' : 'callcode';
          say(`${where}: ${name} ${what || `compiles in ${owner} (${placeOf(compiled, path, node)}), which `}makes a low-level ${op}: the vault's only DELEGATECALLs are to its linked libraries (I-32)`);
        } else if (kind === 'delegatecall') {
          const target = decls.get(callee.referencedDeclaration);
          const lib = target?.contract?.name ?? '?';
          if (!links.includes(lib)) {
            say(`${where}: ${name} DELEGATECALLs ${lib}.${callee.memberName ?? target?.node.name ?? '?'}, a library LINK_GRAPH does not say it links (${links.join(', ') || 'none'})`);
          }
        }
      }
      if (node.nodeType === 'InlineAssembly') {
        for (const y of yulCallsIn(node, ['delegatecall', 'callcode'])) {
          say(`${where}: ${name} compiles in ${owner} (${placeOf(compiled, path, y.node)}), whose assembly makes a ${y.name}: the vault's only DELEGATECALLs are to its linked libraries (I-32)`);
        }
      }
    });
  }
  return problems;
}

/** The opcodes of creation code `creation` outside the runtime code `runtime` it holds: solc's creation code is the init
 * code, then the runtime code verbatim (its CBOR metadata at its end, its immutables and link placeholders as in the
 * artifact's runtime code), then any data; the init code and the data are swept as code (no metadata to strip, PUSH data
 * skipped), and the runtime, which its own scan reads with its metadata stripped, is left out, so its metadata is never
 * read mid-stream as opcodes. Constructor arguments are appended at deployment and are in no artifact. Null when the
 * creation code does not hold the runtime code verbatim (it cannot be split).
 * The assumption (Task 42, the Task 42a re-review's Minor): what is not the runtime is the artifact's own init code and
 * data. A constructor that creates another contract (no first-party one does) would embed that contract's creation code
 * in the data, and the sweep would read it as this artifact's code: the child's DELEGATECALL or CALLCODE would count
 * against this artifact, and the child's CBOR metadata, read as opcodes, can only add a false refusal; so the sweep
 * fails closed there, and the child, an artifact of its own, is still scanned on its own. The probe
 * `test('T42_aChildsCreationCodeInTheDataFailsClosed')` pins both. Before a first-party constructor creates a contract,
 * split the child's creation code out of the data (it is that child artifact's `creation`). */
function initOpcodesOf(creation, runtime) {
  const c = creation.replace(/^0x/, '');
  const r = runtime.replace(/^0x/, '');
  if (!c) return new Set();
  const at = r ? c.indexOf(r) : -1;
  if (at === -1 || at % 2) return null;
  return new Set([...opcodesOf(c.slice(0, at), { metadata: false }), ...opcodesOf(c.slice(at + r.length), { metadata: false })]);
}

/** The delegatecall rule's bytecode problems over `artifacts` (loadArtifacts): no first-party artifact (src/, src/vendor
 * aside) has CALLCODE in its runtime code or its creation code (initOpcodesOf: the constructor's code and the data
 * around the runtime), and none has DELEGATECALL in either unless `graph` says it links a library (the vault, whose
 * constructor lists its first hotkey through L4; L3, its payout math). A creation code that cannot be split fails
 * closed. */
export function delegatecallBytecodeProblems(artifacts, graph = LINK_GRAPH) {
  const problems = [];
  for (const [name, a] of Object.entries(artifacts).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (!isFirstParty(a.path)) continue;
    const links = (graph[name] ?? []).length;
    const init = initOpcodesOf(a.creation ?? '0x', a.deployed);
    if (init === null) {
      problems.push(`${name}'s creation code does not hold its runtime code verbatim, so the rule cannot tell its init code from the runtime's metadata: refused`);
    }
    for (const [code, ops] of [['runtime', opcodesOf(a.deployed)], ['creation', init ?? new Set()]]) {
      if (ops.has(NEVER.CALLCODE)) problems.push(`${name}'s ${code} code has CALLCODE, which nothing in src/ may make`);
      if (ops.has(OPCODE.DELEGATECALL) && !links) {
        problems.push(`${name}'s ${code} code has DELEGATECALL, but LINK_GRAPH says it links no library: no other DELEGATECALL is allowed in src/`);
      }
    }
  }
  return problems;
}

// ---- the boundary coverage (Task 42a, spec §9.1) ----

/** Every test file in `dir` (test/libraries by default), keyed by its path from contracts/ ("test/libraries/…"), its
 * text with LF line ends. */
export function loadTests(dir = DEFAULT_TESTS) {
  const tests = new Map();
  if (!existsSync(dir)) throw new Error(`${dir} does not exist`);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.sol')) tests.set(`test/libraries/${e.name}`, readFileSync(join(dir, e.name), 'utf8').replace(/\r\n/g, '\n'));
  }
  return tests;
}

/** The body of function `fn` in Solidity text `text` (comments and strings blanked), or null when it declares none. The
 * first function of that name anywhere in the file is read, in whichever contract declares it: a test file that
 * declared one test name twice (two contracts) would be read at the first (none of test/libraries does). */
function functionBody(text, fn) {
  const code = stripComments(text);
  const m = new RegExp(`\\bfunction\\s+${fn}\\s*\\(`).exec(code);
  if (!m) return null;
  const open = code.indexOf('{', m.index);
  const semi = code.indexOf(';', m.index);
  if (open === -1 || (semi !== -1 && semi < open)) return null;
  return code.slice(open, closing(code, open) + 1);
}

/** The boundary coverage's problems over `artifacts` (loadArtifacts) and `tests` (loadTests), one line each. Every
 * library `graph` links (or an artifact links) has a `coverage` entry. Its functions are the build's: every entry of its
 * artifact's methodIdentifiers (solc's list of each externally callable function and its selector; its JSON ABI lists
 * only a library's view and pure functions, so it is not the list), each found by its selector among the external and
 * public functions of its artifact's AST, whose state mutability gives its kind ('guarded' for nonpayable, 'view' for
 * view or pure), and each of those in methodIdentifiers (either missing fails closed). Each function (by name, each
 * once: an overload is refused) has an entry of its kind, and each entry a function; each entry's test is a function
 * named `test…` in its file of test/libraries whose body names `<Library>.<function>.selector`, so it calls that
 * function directly. */
export function boundaryCoverageProblems(artifacts, tests, { coverage = BOUNDARY_TESTS, graph = LINK_GRAPH } = {}) {
  const problems = [];
  const libraries = new Set(Object.values(graph).flat());
  for (const a of Object.values(artifacts)) for (const l of linked(a.deployedLinks)) libraries.add(l.name);
  for (const lib of [...libraries].sort()) {
    const a = artifacts[lib];
    if (!a) {
      problems.push(`${lib} is linked but is not in the build, so its functions cannot be read`);
      continue;
    }
    const entries = coverage[lib];
    if (!entries) {
      problems.push(`${lib} is linked but BOUNDARY_TESTS covers none of its functions`);
      continue;
    }
    // the build's functions: methodIdentifiers, each with its AST declaration's mutability
    const declared = new Map((a.functions ?? []).map((f) => [f.selector, f]));
    const fns = [];
    for (const [signature, id] of Object.entries(a.methodIdentifiers ?? {})) {
      const name = signature.slice(0, signature.indexOf('('));
      const f = declared.get(id);
      if (!f) {
        problems.push(`${lib}.${signature} (0x${id}) is in methodIdentifiers but no external or public function of its AST has that selector, so its kind cannot be read`);
        continue;
      }
      fns.push({ name, selector: `0x${id}`, stateMutability: f.stateMutability });
    }
    for (const f of a.functions ?? []) {
      if (!Object.values(a.methodIdentifiers ?? {}).includes(f.selector)) {
        problems.push(`${lib}.${f.name} (0x${f.selector}) is an external or public function of its AST that methodIdentifiers does not list`);
      }
    }
    const byName = new Map();
    for (const f of fns) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
    for (const [fn, list] of byName) {
      if (list.length > 1) {
        problems.push(`${lib} has ${list.length} functions named ${fn}: BOUNDARY_TESTS names each function once, so overloads are refused`);
        continue;
      }
      const f = list[0];
      const selector = f.selector;
      const entry = entries[fn];
      if (!entry) {
        problems.push(`${lib}.${fn} (${selector}, ${f.stateMutability}) is in the build but BOUNDARY_TESTS names no direct-call test for it: every library function is called directly by a test (spec §9.1)`);
        continue;
      }
      const kind = ['view', 'pure'].includes(f.stateMutability) ? 'view' : f.stateMutability === 'nonpayable' ? 'guarded' : f.stateMutability;
      if (entry.kind !== kind) {
        problems.push(`${lib}.${fn} is ${f.stateMutability} in the build, but BOUNDARY_TESTS tests it as ${entry.kind}`);
      }
      const [file, test] = String(entry.test ?? '').split(':');
      const path = `test/libraries/${file}`;
      if (!tests.has(path)) {
        problems.push(`${path}, which BOUNDARY_TESTS names for ${lib}.${fn}, is not in test/libraries`);
        continue;
      }
      if (!/^test/.test(test ?? '')) {
        problems.push(`${path}:${test}, which BOUNDARY_TESTS names for ${lib}.${fn}, is not a test (test_…): forge never runs it`);
        continue;
      }
      const body = functionBody(tests.get(path), test);
      if (body === null) {
        problems.push(`${path}:${test}, which BOUNDARY_TESTS names for ${lib}.${fn}, is not a function there`);
        continue;
      }
      if (!new RegExp(`\\b${lib}\\s*\\.\\s*${fn}\\s*\\.\\s*selector\\b`).test(body)) {
        problems.push(`BOUNDARY_TESTS says ${path}:${test} calls ${lib}.${fn} directly, but its body never names ${lib}.${fn}.selector`);
      }
    }
    for (const fn of Object.keys(entries)) {
      if (!byName.has(fn)) problems.push(`BOUNDARY_TESTS covers ${lib}.${fn}, which is not a function of it in the build`);
    }
  }
  return problems;
}

// ---- reading the build ----

/** Whether artifact `a` is a file's own, for a file of file-level declarations only (CascadeTypes.sol,
 * CascadeErrors.sol): no contract, so no metadata, no code and no ABI, nothing to link or be linked. */
const declarationsOnly = (a) =>
  !a.metadata && !(a.abi ?? []).length && [a.bytecode?.object, a.deployedBytecode?.object].every((o) => !o || o === '0x');

/** The external and public functions contract `name` declares itself in `ast` (its artifact's, with `ast = true`), each
 * { name, selector, stateMutability }; [] without an AST. solc's JSON ABI leaves a library's non-view functions out,
 * so the boundary coverage reads their kinds here (a library inherits nothing, so its own declarations are all). */
function functionsOf(ast, name) {
  const contract = ast?.nodes?.find((n) => n.nodeType === 'ContractDefinition' && n.name === name);
  return (contract?.nodes ?? [])
    .filter((n) => n.nodeType === 'FunctionDefinition' && ['external', 'public'].includes(n.visibility) && n.functionSelector)
    .map((n) => ({ name: n.name, selector: n.functionSelector, stateMutability: n.stateMutability }));
}

/** Every first-party artifact in `outDir` by contract name: its source path, runtime code and the
 * link references of its runtime and creation code, and its functions (methodIdentifiers, its ABI and its declared
 * functions, functionsOf). Throws on an artifact with code or an ABI whose
 * metadata does not name its contract: skipped, it would go unchecked. */
export function loadArtifacts(outDir = DEFAULT_OUT) {
  if (!existsSync(outDir)) throw new Error(`${outDir} is missing: run forge build first`);
  const artifacts = {};
  for (const dir of readdirSync(outDir, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.endsWith('.sol')) continue;
    for (const file of readdirSync(join(outDir, dir.name))) {
      if (!file.endsWith('.json')) continue;
      const a = JSON.parse(readFileSync(join(outDir, dir.name, file), 'utf8'));
      const [path, name] = Object.entries(a.metadata?.settings?.compilationTarget ?? {})[0] ?? [];
      if (!path) {
        if (declarationsOnly(a)) continue;
        throw new Error(`${dir.name}/${file} has no metadata.settings.compilationTarget, so the rules cannot tell which contract it is: rebuild with forge build`);
      }
      if (!path.startsWith('src/')) continue;
      if (artifacts[name] && artifacts[name].path !== path) throw new Error(`two contracts are named ${name}: ${artifacts[name].path}, ${path}`);
      artifacts[name] = {
        path,
        deployed: a.deployedBytecode?.object ?? '0x',
        // the delegatecall rule reads the creation code too (Task 42a fix round 1: a constructor's code is only there)
        creation: a.bytecode?.object ?? '0x',
        deployedLinks: a.deployedBytecode?.linkReferences ?? {},
        creationLinks: a.bytecode?.linkReferences ?? {},
        // the boundary coverage reads each library's functions from the build (Task 42a)
        abi: a.abi ?? [],
        methodIdentifiers: a.methodIdentifiers ?? {},
        functions: functionsOf(a.ast, name),
      };
    }
  }
  if (!artifacts.CascadeVault) throw new Error(`${outDir} has no CascadeVault: run forge build first`);
  return artifacts;
}

/** [{ path, name }] of each library `links` names, sorted by name. */
const linked = (links) =>
  Object.entries(links ?? {})
    .flatMap(([path, libs]) => Object.keys(libs).map((name) => ({ path, name })))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/** The link graph's problems: each first-party artifact links exactly `graph`'s libraries. */
export function linkProblems(artifacts, graph = LINK_GRAPH) {
  const problems = [];
  for (const name of Object.keys(graph)) if (!artifacts[name]) problems.push(`${name} is not in the build`);
  const libraries = new Map();
  for (const [name, a] of Object.entries(artifacts).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    const expected = [...(graph[name] ?? [])].sort();
    for (const [code, links] of [['runtime', a.deployedLinks], ['creation', a.creationLinks]]) {
      const actual = [...new Set(linked(links).map((l) => l.name))];
      for (const l of linked(links)) libraries.set(l.name, l.path);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        problems.push(`${name}'s ${code} code links ${actual.join(', ') || 'nothing'}, expected ${expected.join(', ') || 'nothing'}`);
      }
    }
  }
  for (const [name, path] of [...libraries].sort()) {
    if (!isRootPath(path)) problems.push(`${name} is linked but is not a *Lib.sol or CascadePayoutMath in src/libraries, so the source rules do not scan it (${path})`);
  }
  return problems;
}

/** The opcodes of runtime code `hex`, PUSH data and the trailing CBOR metadata skipped (link
 * placeholders read as zeros); with `metadata: false`, no trailer is stripped (code that ends with none: a creation
 * code's init code or its data, initOpcodesOf). */
export function opcodesOf(hex, { metadata = true } = {}) {
  const clean = hex.replace(/^0x/, '').replace(/__\$[0-9a-fA-F]{34}\$__/g, '0'.repeat(40));
  const bytes = Buffer.from(clean, 'hex');
  let n = bytes.length;
  if (metadata && n >= 2) {
    const meta = bytes.readUInt16BE(n - 2);
    if (meta >= 1 && meta + 2 <= n && bytes[n - 2 - meta] >= 0xa0 && bytes[n - 2 - meta] <= 0xbf) n -= meta + 2;
  }
  const ops = new Set();
  for (let i = 0; i < n; ++i) {
    const op = bytes[i];
    ops.add(op);
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return ops;
}

/** The bytecode's problems: each linked library's runtime code holds no SELFDESTRUCT or CALLCODE and
 * no call or creation opcode beyond `callOpcodes`'; one allowed a call opcode names its targets in
 * `callTargets`, which the call rule checks; and none holds a state opcode `stateOpcodes` refuses it (R1-C
 * F-1: TSTORE in any; SSTORE in L2 and the payout math; LOG0 to LOG4 in the payout math). */
export function bytecodeProblems(
  artifacts,
  graph = LINK_GRAPH,
  callOpcodes = CALL_OPCODES,
  callTargets = CALL_TARGETS,
  stateOpcodes = STATE_OPCODES,
) {
  const problems = [];
  const libraries = new Set(Object.values(graph).flat());
  for (const a of Object.values(artifacts)) for (const l of linked(a.deployedLinks)) libraries.add(l.name);
  for (const name of [...libraries].sort()) {
    if (!(name in callOpcodes)) {
      problems.push(`${name} is linked but has no entry in CALL_OPCODES (the calls its runtime code may make)`);
      continue;
    }
    if (!artifacts[name]) {
      problems.push(`${name} is not in the build`);
      continue;
    }
    const ops = opcodesOf(artifacts[name].deployed);
    const allowed = callOpcodes[name];
    for (const [op, code] of Object.entries(NEVER)) if (ops.has(code)) problems.push(`${name}'s runtime code has ${op}`);
    for (const [op, code] of Object.entries(OPCODE)) {
      if (ops.has(code) && !allowed.includes(op)) problems.push(`${name}'s runtime code has ${op} (allowed: ${allowed.join(', ') || 'none'})`);
    }
    for (const op of [...(stateOpcodes['*'] ?? []), ...(stateOpcodes[name] ?? [])]) {
      if (ops.has(STATE[op])) problems.push(`${name}'s runtime code has ${op}, which STATE_OPCODES refuses it`);
    }
    const calls = allowed.filter((op) => ['CALL', 'STATICCALL', 'DELEGATECALL'].includes(op));
    if (calls.length && !(artifacts[name].path in callTargets)) {
      problems.push(`${name} may call (${calls.join(', ')}), but CALL_TARGETS names none of its targets, so no source rule checks where it calls`);
    }
  }
  return problems;
}

function arg(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  if (!argv[i + 1]) throw new Error(`${flag} needs a path`);
  return resolve(argv[i + 1]);
}

function main() {
  const argv = process.argv.slice(2);
  let sources;
  let artifacts;
  let compiled;
  let tests;
  try {
    const srcDir = arg(argv, '--src', DEFAULT_SRC);
    sources = loadSources(srcDir);
    artifacts = loadArtifacts(arg(argv, '--out', DEFAULT_OUT));
    tests = loadTests(arg(argv, '--tests', DEFAULT_TESTS));
    compiled = compileAsts(srcDir, astRoots(sources));
  } catch (e) {
    console.error(`library-rules: ${e.message}`);
    process.exit(1);
  }
  const problems = [
    ...sourceProblems(sources),
    ...callProblems(compiled),
    ...assemblyProblems(compiled, { roots: libraryRoots(sources) }),
    ...writeSetProblems(compiled),
    ...precompileFunctionProblems(compiled),
    ...boundCallProblems(compiled),
    ...yulCallProblems(compiled, { roots: libraryRoots(sources) }),
    ...delegatecallSourceProblems(sources),
    ...delegatecallAstProblems(compiled),
    ...linkProblems(artifacts),
    ...bytecodeProblems(artifacts),
    ...delegatecallBytecodeProblems(artifacts),
    ...boundaryCoverageProblems(artifacts, tests),
  ];
  if (problems.length) {
    console.error('The library rules fail:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  const roots = libraryRoots(sources);
  for (const r of roots) {
    const closure = importClosure(sources, r).slice(1);
    const vendored = VENDOR_IMPORTS[r]?.join(', ') || 'nothing';
    console.log(`${r} and its ${closure.length} first-party imports pass the source rules; from outside src/ they import only ${vendored}.`);
  }
  for (const f of NO_EXTERNAL_CALL.filter((x) => sources.has(x))) {
    console.log(`${baseName(f)}'s own code makes no external call, on solc's AST.`);
  }
  for (const [r, texts] of Object.entries(CALL_TARGETS).filter(([x]) => sources.has(x))) {
    const pins = [
      ...new Set(
        texts.map(targetOf).map((t) => {
          if (t.kind === 'cast') return `${t.address} = ${PINNED[t.address].value}`;
          if (t.kind === 'refund') return `the refund: value only, empty calldata, ${t.fn}'s last statement`;
          const pin = PINNED[`${t.struct}.${t.field}`];
          return `${t.struct}.${t.field}: the ${pin.type} the vault passes, never written`;
        }),
      ),
    ].join('; ');
    const linked = LINK_GRAPH[baseName(r)] ?? [];
    const via = linked.length ? ` and, by DELEGATECALL, the linked ${linked.join(', ')}` : '';
    console.log(`${baseName(r)} and everything it compiles in call only ${texts.join(', ')} (${pins})${via}, on solc's AST: no other call target and no external function as a value.`);
  }
  console.log("No linked library compiles in any inline assembly (first-party code, on solc's AST; OpenZeppelin's Math is the vendored exception).");
  for (const [r, entries] of Object.entries(WRITE_SETS).filter(([x]) => sources.has(x))) {
    console.log(`${baseName(r)} and everything it compiles in write only ${entries.join(', ')} of ${baseName(WRITE_SET_CALLER)}'s storage, as its call sites bind them, on solc's AST.`);
  }
  for (const [r, fns] of Object.entries(PRECOMPILE_FUNCTIONS).filter(([x]) => sources.has(x))) {
    console.log(`${baseName(r)}'s compiled code calls exactly ${fns.join(', ')} of the staking precompile, on solc's AST.`);
  }
  console.log('No call into a linked library goes through using-for: every one is a direct Library.f(…) call.');
  console.log(`No linked library reaches a function whose assembly calls out or creates (${YUL_CALLS.join(', ')}), vendored code included, on solc's AST.`);
  console.log('No first-party file in src/ holds delegatecall or callcode in its code.');
  for (const [name, libs] of Object.entries(LINK_GRAPH)) {
    console.log(`${name}'s code (its own, its bases' and every function it reaches) DELEGATECALLs only ${[...libs].sort().join(', ')}, on solc's AST.`);
  }
  const delegating = Object.entries(artifacts)
    .filter(([, a]) => isFirstParty(a.path) && (opcodesOf(a.deployed).has(OPCODE.DELEGATECALL) || initOpcodesOf(a.creation, a.deployed)?.has(OPCODE.DELEGATECALL)))
    .map(([name]) => name)
    .sort();
  console.log(`No first-party artifact's runtime or creation code has CALLCODE, and only ${delegating.join(', ')} have DELEGATECALL (they link libraries).`);
  let covered = 0;
  for (const [lib, fns] of Object.entries(BOUNDARY_TESTS)) {
    for (const [fn, { kind, test }] of Object.entries(fns)) {
      const ids = artifacts[lib]?.methodIdentifiers ?? {};
      const signature = Object.keys(ids).find((x) => x.startsWith(`${fn}(`));
      console.log(`  ${lib}.${fn} (0x${ids[signature]}, ${kind}): test/libraries/${test}`);
      ++covered;
    }
  }
  console.log(`Every external function of the linked libraries in the build (${covered}) has its direct-call test.`);
  for (const [name, libs] of Object.entries(LINK_GRAPH)) console.log(`${name} links exactly ${[...libs].sort().join(', ')}.`);
  console.log('No other part of src/ links anything.');
  for (const [name, ops] of Object.entries(CALL_OPCODES)) {
    console.log(`${name}'s runtime code has no SELFDESTRUCT or CALLCODE, and ${ops.length ? `calls only by ${ops.join(', ')}` : 'no call or creation opcode'}.`);
    const state = [...(STATE_OPCODES['*'] ?? []), ...(STATE_OPCODES[name] ?? [])];
    console.log(`${name}'s runtime code has no ${state.join(', ')}.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

// The build checks, run from contracts/ before every commit that touches contracts/src:
//   1. the size gate (script/size-gate.mjs, which builds): every part of the build within its limit;
//   2. the published vault ABI (script/merge-abi.mjs --check): abi/CascadeVault.json matches the build;
//   3. the lens layout (script/gen-lens-layout.mjs --check): src/lens/generated/VaultLayout.sol and
//      DoorLayout.sol match the build's storage layouts byte for byte;
//   4. the lens surface (script/lens-surface.mjs): each lens serves its target's state and getters with
//      their types, each view is exposed by the target's test-only subclass and listed for the parity
//      tests (ruling DB3), and the front door's pause sweep lists its every entry point (Task 30);
//   5. the library rules (script/library-rules.mjs): I-32's static half over each linked library and
//      the helpers it compiles in, the link graph each artifact must have, and no call or SELFDESTRUCT
//      opcode a library is not allowed (rulings DB7a to DB7c);
//   6. the warning gate (script/warning-gate.mjs): src/ compiles with no solc warning, so no declaration
//      shadows a name the library rules trust (5f fix round 3). It builds into a scratch directory, never
//      out/;
//   7. the library links (script/gen-library-links.mjs --check): test/utils/generated/LibraryLinks.sol, the
//      link offsets I-32's run-time check reads (Task 34a, ruling DB9), matches the build byte for byte.
// Every check runs; the exit code is 1 when any failed. They run on the default profile, the
// authority on EIP-170. Set FORGE when forge is not on PATH.
// The checks keep forge's persisted test failures (KEPT, Task 42a's carry from Task 10c): the warning gate's and the
// library rules' compiles are forced builds (into a scratch directory), and a forced build also removes the
// project's fuzz and invariant failure directories and its failed-test list, whatever its --cache-path. Each is
// copied aside first and put back as it was, whatever the checks did.
// Usage: node script/build-checks.mjs
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

/** What forge keeps in cache/ that a forced build removes and no build makes again: the fuzz and invariant failures
 * `forge test` replays (foundry.toml's default failure_persist_dir for each) and the last run's failed tests
 * (`forge test --rerun`'s list). */
export const KEPT = ['cache/fuzz', 'cache/invariant', 'cache/test-failures'];

/** Runs `run` and returns what it returns, with each of `kept` under `root` copied aside first and put back as it was
 * afterwards (removed and restored whole), whatever `run` did, a throw included. A path that did not exist is left as
 * `run` left it. The copies sit in a directory under the system temp directory named `build-checks-kept-` and a random
 * suffix, removed afterwards: if the checks are killed before they finish, the saved failures are still there, under
 * `<path in KEPT>` in the newest such directory. */
export function keeping(root, run, kept = KEPT) {
  const saved = mkdtempSync(join(tmpdir(), 'build-checks-kept-'));
  const had = [];
  try {
    for (const p of kept) {
      if (!existsSync(join(root, p))) continue;
      cpSync(join(root, p), join(saved, p), { recursive: true });
      had.push(p);
    }
    return run();
  } finally {
    for (const p of had) {
      rmSync(join(root, p), { recursive: true, force: true });
      cpSync(join(saved, p), join(root, p), { recursive: true });
    }
    rmSync(saved, { recursive: true, force: true });
  }
}

export const CHECKS = [
  { label: 'size gate', script: 'size-gate.mjs', args: [] },
  { label: 'published vault ABI', script: 'merge-abi.mjs', args: ['--check'] },
  { label: 'lens layout', script: 'gen-lens-layout.mjs', args: ['--check'] },
  { label: 'lens surface', script: 'lens-surface.mjs', args: [] },
  { label: 'library rules', script: 'library-rules.mjs', args: [] },
  { label: 'warning-free src', script: 'warning-gate.mjs', args: [] },
  { label: 'library links', script: 'gen-library-links.mjs', args: ['--check'] },
];

function main() {
  const failed = keeping(ROOT, () => {
    const f = [];
    for (const { label, script, args } of CHECKS) {
      console.log(`\n== ${label}`);
      const r = spawnSync(process.execPath, [join(here, script), ...args], { cwd: ROOT, stdio: 'inherit' });
      if (r.status !== 0) f.push(label);
    }
    return f;
  });
  if (failed.length) {
    console.error(`\nBUILD CHECKS FAILED: ${failed.join(', ')}`);
    process.exit(1);
  }
  console.log(`\nBuild checks passed: ${CHECKS.map((c) => c.label).join(', ')}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

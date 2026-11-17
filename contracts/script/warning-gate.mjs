// The warning gate, one of the build checks (5f fix round 3): src/ compiles with no solc warning.
//
// Why: a shadowing, 2519 ("This declaration shadows an existing declaration") or 2319 ("This declaration
// shadows a builtin symbol"), makes a name such as `Math`, `abi` or `ISTAKING_ADDRESS` mean something other
// than what a reader of the code sees, and any other warning is a decision nobody wrote down. The library
// rules no longer lean on this gate: since 5f fix round 4 their call rule reads where a library calls from
// solc's AST, each name as solc resolved it. The gate keeps src/ reading as it compiles. It reads forge's
// JSON, which keeps the diagnostics that foundry.toml's ignored_error_codes and ignored_warnings_from hide
// from forge's own report (a test pins that).
//
// How: it compiles src/ alone (its files and the library files they import; not test/ or script/), forced,
// with the project's compiler settings (foundry.toml), into a scratch directory, so out/ and the cache are
// never touched. Only solc's diagnostics count, never forge-lint's notes (a separate stream). A solc error
// in src/ counts too, and so does a warning or error with no location (fail closed); one located in lib/ is
// not src/'s.
// Usage: node script/warning-gate.mjs [--src <src dir>]   (exit 1 on any problem; FORGE names forge)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SRC = join(ROOT, 'src');

/** The solc diagnostics of forge's JSON build output `output` that are src/'s, as
 * "src/<file>:<line>: <severity> <code>: <message>": each warning or error located under `srcDir`, and each
 * with no location. A location may be relative to the project `root` or absolute. */
export function solcProblems(output, srcDir, root = ROOT) {
  const problems = [];
  for (const d of output?.errors ?? []) {
    if (d.severity !== 'warning' && d.severity !== 'error') continue;
    const what = `${d.severity} ${d.errorCode ?? '?'}: ${d.message}`;
    const file = d.sourceLocation?.file;
    if (!file) {
      problems.push(`(no location): ${what}`);
      continue;
    }
    const abs = isAbsolute(file) || /^[A-Za-z]:\//.test(file) ? resolve(file) : resolve(root, file);
    const rel = relative(srcDir, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    let line = '?';
    if (existsSync(abs) && Number.isInteger(d.sourceLocation.start) && d.sourceLocation.start >= 0) {
      // solc's offsets are bytes
      const bytes = readFileSync(abs).subarray(0, d.sourceLocation.start);
      line = bytes.toString('utf8').split('\n').length;
    }
    problems.push(`src/${rel.split(sep).join('/')}:${line}: ${what}`);
  }
  return problems;
}

/** Compiles `srcDir` alone, forced, into a scratch directory; returns forge's JSON output. */
export const compileSrc = (srcDir = DEFAULT_SRC) => forgeBuildJson(srcDir, [srcDir]);

/** Runs `forge build` on `paths` (and what they import) with `srcDir` as the contracts directory, forced, with
 * the project's settings (foundry.toml), into a scratch directory that is then removed, so out/ and the cache
 * are never touched; returns forge's JSON output (solc's diagnostics; each source's AST with `--ast`). Also
 * the library rules' compile (library-rules.mjs). */
export function forgeBuildJson(srcDir, paths, extraArgs = []) {
  if (!existsSync(srcDir)) throw new Error(`${srcDir} does not exist`);
  const scratch = mkdtempSync(join(tmpdir(), 'forge-build-'));
  try {
    const forge = process.env.FORGE || 'forge';
    const args = ['build', '--force', '--contracts', srcDir, ...paths, '--out', join(scratch, 'out'), '--cache-path', join(scratch, 'cache'), '--json', ...extraArgs];
    const r = spawnSync(forge, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    if (r.error) throw new Error(`forge could not run: ${r.error.message}`);
    const out = r.stdout ?? '';
    const at = out.indexOf('{');
    if (at === -1) {
      // forge-lint's notes are JSON lines on stderr; anything else there is forge's own failure
      const why = (r.stderr ?? '').split('\n').filter((l) => l && !l.startsWith('{"$message_type"')).join('\n');
      throw new Error(`forge build printed no JSON (exit ${r.status}): ${why || '(no message)'}`);
    }
    return JSON.parse(out.slice(at));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--src');
  const srcDir = i === -1 ? DEFAULT_SRC : resolve(argv[i + 1] ?? '');
  let problems;
  try {
    problems = solcProblems(compileSrc(srcDir), srcDir);
  } catch (e) {
    console.error(`warning-gate: ${e.message}`);
    process.exit(1);
  }
  if (problems.length) {
    console.error('src/ does not compile warning-free (a shadowing is a warning: it rebinds a name the code reads):');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('src/ compiles with no solc warning (forced, alone, with the project settings, into a scratch directory).');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

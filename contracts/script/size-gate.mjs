// Size gate: every part of the build (BUILD_PARTS) must be in it and keep its runtime bytecode
// within its limit: CascadeVault and CascadeFrontDoor 23,076 bytes (EIP-170's 24,576 minus 1,500
// bytes of headroom), every library and lens EIP-170's 24,576 bytes.
// Usage: node script/size-gate.mjs [--from <sizes.json>]
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LIMIT = 23_076;
export const LIBRARY_LIMIT = 24_576;
/** The two contracts held to LIMIT. */
export const GATED = ['CascadeVault', 'CascadeFrontDoor'];
/** What the gate reports and requires, in this order: the vault, the front door, then each library
 * and lens as its task adds it. */
export const BUILD_PARTS = [
  'CascadeVault',
  'CascadeFrontDoor',
  'CascadePayoutMath',
  'CascadeBatchLib',
  'CascadeStakeLib',
  'CascadePayoutLib',
  'CascadeHotkeyLib',
  'CascadeVaultLens',
  'CascadeDoorLens',
];
const fmt = (n) => n.toLocaleString('en-US');

export const limitOf = (name) => (GATED.includes(name) ? LIMIT : LIBRARY_LIMIT);

export function check(sizes) {
  const failures = [];
  for (const name of BUILD_PARTS) {
    const size = sizes[name]?.runtime_size;
    const limit = limitOf(name);
    if (typeof size !== 'number') failures.push(`${name} is not in the build`);
    else if (size > limit) {
      failures.push(`${name} is ${fmt(size)} bytes, limit ${fmt(limit)}: over by ${fmt(size - limit)} bytes`);
    }
  }
  return failures;
}

/** One line per part: its size, its limit and the headroom left. */
export function report(sizes) {
  return BUILD_PARTS.map((name) => {
    const size = sizes[name]?.runtime_size;
    const limit = limitOf(name);
    const label = name.padEnd(28);
    if (typeof size !== 'number') return `  ${label} missing from the build (limit ${fmt(limit)} B)`;
    return `  ${label} ${fmt(size).padStart(7)} B  limit ${fmt(limit)} B  headroom ${fmt(limit - size).padStart(7)} B`;
  });
}

function load(argv) {
  const i = argv.indexOf('--from');
  if (i !== -1) {
    if (!argv[i + 1]) throw new Error('--from needs a file path');
    return JSON.parse(readFileSync(argv[i + 1], 'utf8'));
  }
  const forge = process.env.FORGE || 'forge';
  // forge exits 1 when ANY contract (e.g. a test handler) is over EIP-170 but still prints the
  // JSON, so take stdout whatever the exit code; only a missing JSON body is a real failure.
  let out;
  try {
    out = execFileSync(forge, ['build', '--sizes', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = e.stdout?.toString() ?? '';
    if (!out.includes('{')) throw new Error(`forge build failed: ${e.stderr || e.message}`);
  }
  return JSON.parse(out.slice(out.indexOf('{')));
}

function main() {
  const sizes = load(process.argv.slice(2));
  for (const line of report(sizes)) console.log(line);
  const failures = check(sizes);
  if (failures.length) {
    console.error(`\nSIZE GATE FAILED:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`\nSize gate passed (the vault and the front door within ${fmt(LIMIT)} B, every other part within ${fmt(LIBRARY_LIMIT)} B).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

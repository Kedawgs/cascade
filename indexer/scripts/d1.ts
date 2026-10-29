import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENVS, type Env } from "./sql.ts";

// What the owner's D1 scripts share: their flags, and running `wrangler d1 execute` against the remote
// database. Wrangler is started as `node …/wrangler.js` with execFile: no shell, so nothing in an argument
// is ever interpreted.

export interface Deps {
  /** runs wrangler with these arguments and answers its standard output */
  wrangler: (args: string[]) => Promise<string>;
  print: (line: string) => void;
  /** the time to record, in seconds */
  now: () => number;
}

const WRANGLER = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "wrangler", "bin", "wrangler.js");

export const realDeps: Deps = {
  wrangler: (args) =>
    new Promise((resolve, reject) => {
      execFile(process.execPath, [WRANGLER, ...args], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`wrangler failed: ${stderr || err.message}`));
        else resolve(stdout);
      });
    }),
  print: (line) => console.log(line),
  now: () => Math.floor(Date.now() / 1000),
};

/** The arguments of `wrangler d1 execute` for one statement on an environment's remote database. */
export const d1Args = (env: Env, sql: string, json = false): string[] => [
  "d1",
  "execute",
  `cascade-indexer-${env}`,
  "--env",
  env,
  "--remote",
  ...(json ? ["--json"] : []),
  "--command",
  sql,
];

/** How a command reads, for a dry run (the statement quoted). */
export const shown = (args: string[]): string => `pnpm wrangler ${args.map((a) => (/^[\w./:-]+$/.test(a) ? a : `"${a}"`)).join(" ")}`;

/** The rows of a `--json` answer. */
export function rowsOf(stdout: string): Record<string, unknown>[] {
  const j = JSON.parse(stdout) as { results?: Record<string, unknown>[] }[];
  return j.flatMap((r) => r.results ?? []);
}

/** `--name value` and `--flag` options, and bare words; undefined (with a reason) for anything unknown. */
export function parseArgs(
  argv: readonly string[],
  values: readonly string[],
  flags: readonly string[],
): { opts: Record<string, string>; flags: Set<string>; words: string[] } | { error: string } {
  const opts: Record<string, string> = {};
  const set = new Set<string>();
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `pnpm hold:clear -- …` may pass the separator through
    if (a === "--") continue;
    if (!a.startsWith("--")) words.push(a);
    else if (values.includes(a.slice(2))) {
      const v = argv[++i];
      if (v === undefined) return { error: `${a} needs a value` };
      opts[a.slice(2)] = v;
    } else if (flags.includes(a.slice(2))) set.add(a.slice(2));
    else return { error: `unknown option ${a}` };
  }
  return { opts, flags: set, words };
}

export const isEnv = (x: string | undefined): x is Env => (ENVS as readonly string[]).includes(x ?? "");

/** Runs `main` when the file is the program Node started, and exits with its code. */
export function runIfMain(url: string, main: (argv: string[], deps: Deps) => Promise<number>): void {
  if (process.argv[1] && url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2), realDeps).then(
      (code) => process.exit(code),
      (e: unknown) => {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      },
    );
  }
}

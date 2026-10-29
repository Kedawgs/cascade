import { d1Args, type Deps, isEnv, parseArgs, rowsOf, runIfMain, shown } from "./d1.ts";
import { ACTIVE_HOLDS_SQL, clearHoldSql, HOLD_ID_RE, NOTE_RE } from "./sql.ts";

// pnpm hold:clear -- --env <test|production> (--id <hold id or public id> | --all) --note "<text>" [--dry-run]
//
// Clears the keeper's hold (spec 8) after you have checked what raised it. It prints the active holds first,
// then clears the one named (by its id, or the public id the status shows), or all of them. Needs Cloudflare
// account access (wrangler logged in); with --dry-run it only prints the commands.

const USAGE = 'usage: pnpm hold:clear -- --env <test|production> (--id <hold id or public id> | --all) --note "<text>" [--dry-run]';

export async function main(argv: string[], deps: Deps): Promise<number> {
  const a = parseArgs(argv, ["env", "id", "note"], ["all", "dry-run"]);
  const refuse = (why: string) => {
    deps.print(`${why}\n${USAGE}`);
    return 2;
  };
  if ("error" in a) return refuse(a.error);
  const env = a.opts.env;
  if (!isEnv(env)) return refuse("--env must be test or production");
  if ((a.opts.id === undefined) === !a.flags.has("all")) return refuse("give exactly one of --id and --all");
  if (a.opts.id !== undefined && !HOLD_ID_RE.test(a.opts.id)) return refuse("--id must be a hold id or public id (a-z, 0-9, _ . : -)");
  if (!NOTE_RE.test(a.opts.note ?? "")) return refuse("--note must be 1-200 letters, digits, spaces or . , : ; ( ) _ - (no quotes or backticks)");
  const select = d1Args(env, ACTIVE_HOLDS_SQL, true);
  const update = d1Args(env, clearHoldSql(a.opts.id !== undefined ? { id: a.opts.id } : { all: true }, a.opts.note as string, deps.now()));
  if (a.flags.has("dry-run")) {
    deps.print(`would read the active holds:\n  ${shown(select)}`);
    deps.print(`then clear:\n  ${shown(update)}`);
    return 0;
  }
  const holds = rowsOf(await deps.wrangler(select));
  deps.print(holds.length ? `active holds:\n${holds.map((h) => `  ${h.public_id}  ${h.id}  ${h.rule}  raised ${new Date(Number(h.raised_at) * 1000).toISOString()}  ${h.summary}`).join("\n")}` : "no hold is active");
  deps.print(await deps.wrangler(update));
  return 0;
}

runIfMain(import.meta.url, main);

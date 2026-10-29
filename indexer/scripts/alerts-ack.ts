import { d1Args, type Deps, isEnv, parseArgs, runIfMain, shown } from "./d1.ts";
import { ACK_USAGE, ackSql, ALERT_ID_RE } from "./sql.ts";

// pnpm alerts:ack -- --env <test|production> <alert id> [--dry-run]
//
// Acknowledges an alert (spec 7): a critical isn't re-sent once acknowledged, and an event alert closes. The
// id is in the alert's email. Needs Cloudflare account access; with --dry-run it only prints the command.

export async function main(argv: string[], deps: Deps): Promise<number> {
  const a = parseArgs(argv, ["env"], ["dry-run"]);
  const refuse = (why: string) => {
    deps.print(`${why}\n${ACK_USAGE}`);
    return 2;
  };
  if ("error" in a) return refuse(a.error);
  if (!isEnv(a.opts.env)) return refuse("--env must be test or production");
  if (a.words.length !== 1 || !ALERT_ID_RE.test(a.words[0])) return refuse("give one alert id (digits only)");
  const update = d1Args(a.opts.env, ackSql(a.words[0], deps.now()));
  if (a.flags.has("dry-run")) {
    deps.print(`would run:\n  ${shown(update)}`);
    return 0;
  }
  deps.print(await deps.wrangler(update));
  return 0;
}

runIfMain(import.meta.url, main);

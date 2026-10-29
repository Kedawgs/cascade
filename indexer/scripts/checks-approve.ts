import { d1Args, type Deps, isEnv, parseArgs, rowsOf, runIfMain, shown } from "./d1.ts";
import { approveSql, checksOfKeySql, KEY_RE, NOTE_RE } from "./sql.ts";

// pnpm checks:approve -- --env <test|production> --key <delivered key> --batch <batch id> --note "<text>" [--dry-run]
//
// Approves a delivery check by hand (spec 6.2, "Owner approval"): after you have verified the batch yourself,
// its key becomes ok for the keeper. It prints the check first: compare the delivered key with the key the
// front door's events rebuild (expected key) and read the failing step. It refuses a key with no check, or
// one already ok. The next tick emails the critical checks.owner_approved, so an approval nobody expected is
// noticed. Needs Cloudflare account access; with --dry-run it reads the check and prints the UPDATE only.

const USAGE = 'usage: pnpm checks:approve -- --env <test|production> --key <0x… delivered key> --batch <its batch id> --note "<text>" [--dry-run]';

export async function main(argv: string[], deps: Deps): Promise<number> {
  const a = parseArgs(argv, ["env", "key", "batch", "note"], ["dry-run"]);
  const refuse = (why: string) => {
    deps.print(`${why}\n${USAGE}`);
    return 2;
  };
  if ("error" in a) return refuse(a.error);
  const env = a.opts.env;
  if (!isEnv(env)) return refuse("--env must be test or production");
  if (!KEY_RE.test(a.opts.key ?? "")) return refuse("--key must be a delivered key: 0x and 64 lowercase hex digits");
  if (!NOTE_RE.test(a.opts.note ?? "")) return refuse("--note must be 1-200 letters, digits, spaces or . , : ; ( ) _ - (no quotes or backticks)");
  // retyped by hand from the alert, so a pasted key from the wrong email can't be approved by mistake
  if (!/^[0-9]{1,20}$/.test(a.opts.batch ?? "")) return refuse("--batch must be the check's batch id, as the alert names it (digits only)");
  const key = a.opts.key as string;
  const rows = rowsOf(await deps.wrangler(d1Args(env, checksOfKeySql(key), true)));
  if (rows.length === 0) {
    deps.print(`no delivery check has the key ${key}`);
    return 1;
  }
  for (const r of rows) {
    deps.print(
      [
        `batch ${r.batch_id}: ${r.status}`,
        `  delivered key ${r.delivered_key}`,
        `  expected key  ${r.expected_key ?? "(not rebuilt)"}`,
        `  failed at     ${r.detail ?? "-"}`,
        `  delivery tx   ${r.delivered_tx}`,
        `  close tx      ${r.closed_tx ?? "-"}`,
      ].join("\n"),
    );
  }
  if (rows.some((r) => r.status === "ok" || r.status === "ok_by_owner")) {
    deps.print("this key is already ok: nothing to approve");
    return 1;
  }
  if (!rows.every((r) => String(r.batch_id) === a.opts.batch)) {
    deps.print(`the key's check is for batch ${rows.map((r) => r.batch_id).join(", ")}, not ${a.opts.batch}: nothing approved`);
    return 1;
  }
  const update = d1Args(env, approveSql(key, a.opts.note as string));
  if (a.flags.has("dry-run")) {
    deps.print(`would approve:\n  ${shown(update)}`);
    return 0;
  }
  deps.print(await deps.wrangler(update));
  return 0;
}

runIfMain(import.meta.url, main);

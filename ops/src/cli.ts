import { join } from "node:path";
import { computeBudget, formatBudget, gatherBudgetInputs } from "./budget.ts";
import { paths, targets } from "./config.ts";
import { preflight } from "./preflight.ts";
import { loadRecord } from "./record.ts";
import { rehearse } from "./rehearse.ts";
import { createRpc } from "./rpc.ts";
import { type Ctx, execFileRunner } from "./send.ts";

const env = process.env;
const log = (l: string) => console.log(l);

function liveCtx(): Ctx {
  const t = targets(env).live;
  return { live: true, targets: t, rpc: createRpc(t), runner: execFileRunner, paths: paths(env), log, receiptTimeoutMs: 300_000 };
}

async function main(argv: string[]): Promise<number> {
  const [cmd] = argv;
  switch (cmd) {
    case "rehearse":
      await rehearse(env, log);
      return 0;
    case "preflight": {
      const dir = paths(env).deploymentsDir;
      const rehearsal = loadRecord(join(dir, "rehearsal.json"));
      const ctx = liveCtx();
      const budget = rehearsal ? computeBudget(await gatherBudgetInputs(ctx, rehearsal)) : undefined;
      const r = await preflight(ctx, loadRecord(join(dir, "test-2026-10.json")), budget);
      for (const line of r.lines) log(line);
      log(r.ok ? "Pre-flight: all clear" : "Pre-flight: fix the problems above before deploying");
      return r.ok ? 0 : 1;
    }
    case "budget": {
      const rec = loadRecord(join(paths(env).deploymentsDir, "rehearsal.json"));
      if (!rec) throw new Error("run `pnpm ops rehearse` first: the budget uses its measured gas");
      for (const line of formatBudget(computeBudget(await gatherBudgetInputs(liveCtx(), rec)))) log(line);
      return 0;
    }
    default:
      console.error("usage: pnpm ops <preflight|rehearse|budget>");
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);

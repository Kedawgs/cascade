import { join } from "node:path";
import { computeBudget, formatBudget, gatherBudgetInputs } from "./budget.ts";
import { paths, targets } from "./config.ts";
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
    case "budget": {
      const rec = loadRecord(join(paths(env).deploymentsDir, "rehearsal.json"));
      if (!rec) throw new Error("run `pnpm ops rehearse` first: the budget uses its measured gas");
      for (const line of formatBudget(computeBudget(await gatherBudgetInputs(liveCtx(), rec)))) log(line);
      return 0;
    }
    default:
      console.error("usage: pnpm ops <rehearse|budget>");
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

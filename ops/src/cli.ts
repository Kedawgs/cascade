import { join } from "node:path";
import type { Address, Hex } from "viem";
import { type Args, parseArgs, USAGE, UsageError } from "./args.ts";
import { computeBudget, formatBudget, gatherBudgetInputs } from "./budget.ts";
import { paths, targets } from "./config.ts";
import { deploy } from "./deploy.ts";
import { close, payouts, runLoop, stake } from "./keeper/actions.ts";
import { keeperDeps, trackMessage } from "./keeper/state.ts";
import { formatStatus } from "./keeper/status.ts";
import { preflight } from "./preflight.ts";
import { type DeploymentRecord, loadRecord, saveRecord } from "./record.ts";
import { rehearse } from "./rehearse.ts";
import { createRpc } from "./rpc.ts";
import { type Ctx, execFileRunner } from "./send.ts";
import { verify } from "./verify.ts";

const env = process.env;
const log = (l: string) => console.log(l);

function ctxFor(live: boolean): Ctx {
  const t = live ? targets(env).live : targets(env).rehearsal;
  const rpc = createRpc(t, live ? {} : { minIntervalMs: { bittensor: 0 } });
  return { live, targets: t, rpc, runner: execFileRunner, paths: paths(env), log, receiptTimeoutMs: 300_000 };
}

const recordPath = (live: boolean) => join(paths(env).deploymentsDir, live ? "test-2026-10.json" : "rehearsal.json");

function needRecord(live: boolean): DeploymentRecord {
  const rec = loadRecord(recordPath(live));
  if (!rec) throw new Error(`no ${live ? "live" : "rehearsal"} deployment record yet: run deploy${live ? " --live" : ""} first`);
  return rec;
}

async function checkAndSave(ctx: Ctx, path: string, rec: DeploymentRecord) {
  rec.verify = await verify(ctx, rec);
  saveRecord(path, rec);
  if (rec.verify.ok) log("Read-back check: everything matches the plan");
  else log(`Read-back check FAILED:\n  ${rec.verify.failures.join("\n  ")}`);
  return rec.verify.ok;
}

async function run(a: Args): Promise<number> {
  switch (a.cmd) {
    case "rehearse":
      await rehearse(env, log);
      return 0;
    case "preflight": {
      const ctx = ctxFor(true);
      const rehearsal = loadRecord(recordPath(false));
      const budget = rehearsal ? computeBudget(await gatherBudgetInputs(ctx, rehearsal)) : undefined;
      const r = await preflight(ctx, loadRecord(recordPath(true)), budget);
      for (const line of r.lines) log(line);
      log(r.ok ? "Pre-flight: all clear" : "Pre-flight: fix the problems above before deploying");
      return r.ok ? 0 : 1;
    }
    case "budget": {
      const rehearsal = loadRecord(recordPath(false));
      if (!rehearsal) throw new Error("run `pnpm ops rehearse` first: the budget uses its measured gas");
      for (const line of formatBudget(computeBudget(await gatherBudgetInputs(ctxFor(true), rehearsal)))) log(line);
      return 0;
    }
    case "deploy": {
      const ctx = ctxFor(a.live);
      const rec = await deploy(ctx, recordPath(a.live), { newPlan: a.newPlan ?? false });
      return (await checkAndSave(ctx, recordPath(a.live), rec)) ? 0 : 1;
    }
    case "verify":
      return (await checkAndSave(ctxFor(a.live), recordPath(a.live), needRecord(a.live))) ? 0 : 1;
    case "status": {
      const deps = keeperDeps(ctxFor(a.live), needRecord(a.live), a.users as Address[]);
      const s = await deps.readState();
      for (const line of formatStatus(s.detail, { now: s.now })) log(line);
      return 0;
    }
    case "close":
    case "stake": {
      const rec = needRecord(a.live);
      const deps = keeperDeps(ctxFor(a.live), rec, a.users as Address[]);
      const sent = await (a.cmd === "close" ? close(deps, rec) : stake(deps, rec));
      log(`Done (transaction ${sent.hash}, cost ${sent.costWei} wei)`);
      return 0;
    }
    case "payouts": {
      const rec = needRecord(a.live);
      const deps = keeperDeps(ctxFor(a.live), rec, a.users as Address[]);
      const s = await deps.readState();
      const due = s.vault.batches.filter((b) => b.cursor < b.count && s.now >= b.queuedAt + s.vault.payoutDelay);
      if (!due.length) log("No payout batch is due.");
      for (const b of due) log(`Done (transaction ${(await payouts(deps, rec, b.key)).hash})`);
      return 0;
    }
    case "track":
      return (await trackMessage(ctxFor(a.live), needRecord(a.live), a.messageId as Hex)) === "SUCCESS" ? 0 : 1;
    case "run": {
      const rec = needRecord(a.live);
      await runLoop(keeperDeps(ctxFor(a.live), rec, a.users as Address[]), rec, { intervalMs: 60_000 });
      return 1;
    }
    case "wind-down":
    case "sweep":
      throw new Error(`${a.cmd} is not built yet`);
  }
}

async function main(argv: string[]): Promise<number> {
  let a: Args;
  try {
    a = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  return run(a);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);

import { join } from "node:path";
import { type Address, formatEther, type Hex } from "viem";
import { type Args, parseArgs, USAGE, UsageError } from "./args.ts";
import { computeBudget, formatBudget, gatherBudgetInputs } from "./budget.ts";
import { cardinalityReport } from "./cardinality.ts";
import { baseLogsTarget, baseLogsWindow, cadenceFromEnv, claimPolicy, deploymentName, isV3Deployment, paths, recordPath as recordFor, targets } from "./config.ts";
import { deployAndVerify } from "./deploy.ts";
import { handoff, ownershipStatus } from "./handoff.ts";
import { pauseCommand, pauseSigner } from "./pause.ts";
import { claim, close, deliverCommand, deliveryPlan, payouts, runLoop, stake } from "./keeper/actions.ts";
import { closeHold } from "./keeper/due.ts";
import { formatRewards } from "./keeper/rewards.ts";
import { keeperSigner, requireKeeperKey } from "./keeper/signer.ts";
import { keeperDeps, trackMessage } from "./keeper/state.ts";
import { formatStatus } from "./keeper/status.ts";
import { preflight } from "./preflight.ts";
import { type DeploymentRecord, loadRecordFor, needRecord as needRecordAt, uncheckedLines } from "./record.ts";
import { verifyAllowFromEnv } from "./registry.ts";
import { rehearse } from "./rehearse.ts";
import { launchRolesFromEnv } from "./roles.ts";
import { createRpc, logsRpc } from "./rpc.ts";
import { baseLogsLine, type Ctx, execFileRunner, unit } from "./send.ts";
import { verifyAndSave } from "./verify.ts";
import { writeWebEnv } from "./webconfig.ts";
import { sweep, windDown } from "./winddown.ts";

const env = process.env;
const log = (l: string) => console.log(l);

function ctxFor(live: boolean): Ctx {
  const t = live ? targets(env).live : targets(env).rehearsal;
  const rpc = createRpc(t, live ? {} : { minIntervalMs: { bittensor: 0 } });
  // the live tools read Base's logs from their own server (mainnet.base.org refuses eth_getLogs); the
  // forks serve their own
  const logsAt = baseLogsTarget(env);
  const logs = live ? logsRpc(rpc, createRpc({ ...t, base: logsAt }), { announce: () => log(baseLogsLine(logsAt)) }) : undefined;
  return {
    live,
    targets: t,
    rpc,
    ...(logs ? { logs, logsWindow: { base: baseLogsWindow(env) } } : {}),
    runner: execFileRunner,
    paths: paths(env),
    log,
    receiptTimeoutMs: 300_000,
  };
}

/** The keeper commands' context: their sends sign as the record's keeper with OPS_KEEPER_KEYSTORE and
 * OPS_KEEPER_PASSWORD_FILE, else as the test wallet (keeperSigner); requireReady refuses a mismatch. */
const keeperCtx = (live: boolean, rec: DeploymentRecord): Ctx => ({ ...ctxFor(live), signer: keeperSigner(env, paths(env), rec.plan) });

/** The record of the deployment OPS_DEPLOYMENT names (without it, the v2 test deployment's). */
const recordPath = (live: boolean) => recordFor(env, live);

/** The record for a --live run or a rehearsal run; a record of the other kind is refused. */
const needRecord = (live: boolean) => needRecordAt(recordPath(live), live);

async function run(a: Args): Promise<number> {
  switch (a.cmd) {
    case "rehearse":
      return (await rehearse(env, log)) ? 0 : 1;
    case "preflight": {
      const ctx = ctxFor(true);
      const rehearsal = loadRecordFor(recordPath(false), false);
      const budget = rehearsal ? computeBudget(await gatherBudgetInputs(ctx, rehearsal, claimPolicy(env))) : undefined;
      const r = await preflight(ctx, loadRecordFor(recordPath(true), true), budget);
      for (const line of r.lines) log(line);
      log(r.ok ? "Pre-flight: all clear" : "Pre-flight: fix the problems above before deploying");
      return r.ok ? 0 : 1;
    }
    case "budget": {
      const rehearsal = loadRecordFor(recordPath(false), false);
      if (!rehearsal) throw new Error("run `pnpm ops rehearse` first: the budget uses its measured gas");
      for (const line of formatBudget(computeBudget(await gatherBudgetInputs(ctxFor(true), rehearsal, claimPolicy(env))))) log(line);
      return 0;
    }
    case "deploy":
      return (await deployAndVerify(ctxFor(a.live), recordPath(a.live), {
        newPlan: a.newPlan ?? false,
        v3: isV3Deployment(env),
        cadence: cadenceFromEnv(env),
        roles: () => launchRolesFromEnv(env),
        allow: verifyAllowFromEnv(env),
      }))
        ? 0
        : 1;
    case "verify":
      // refuses a v2 record before reading anything: its contracts no longer match the build
      return (await verifyAndSave(ctxFor(a.live), recordPath(a.live), needRecord(a.live), { allow: verifyAllowFromEnv(env) })) ? 0 : 1;
    case "status": {
      const rec = needRecord(a.live);
      const deps = keeperDeps(keeperCtx(a.live, rec), rec, recordPath(a.live), a.users as Address[]);
      const s = await deps.readState({ economics: true });
      for (const line of formatStatus(s.detail, { now: s.now, hold: closeHold(s) })) log(line);
      for (const line of uncheckedLines(rec)) log(line);
      return 0;
    }
    case "close":
    case "stake": {
      const rec = needRecord(a.live);
      const deps = keeperDeps(keeperCtx(a.live, rec), rec, recordPath(a.live), a.users as Address[]);
      const done = await (a.cmd === "close" ? close(deps, rec) : stake(deps, rec));
      log(`Done (transaction ${done.hash}, cost ${formatEther(done.costWei)} ${unit(a.cmd === "close" ? "base" : "bittensor")})`);
      if (done.messageId) log(`Bridge message ${done.messageId} sent. Follow it with: pnpm ops track ${done.messageId}${a.live ? " --live" : ""}`);
      return 0;
    }
    case "payouts": {
      const rec = needRecord(a.live);
      const deps = keeperDeps(keeperCtx(a.live, rec), rec, recordPath(a.live), a.users as Address[]);
      const s = await deps.readState();
      const due = s.vault.batches.filter((b) => b.cursor < b.count && s.now >= b.queuedAt + s.vault.payoutDelay);
      if (!due.length) log("No payout batch is due.");
      for (const b of due) {
        const done = await payouts(deps, rec, b.key);
        log(`Done (transaction ${done.hash}, cost ${formatEther(done.costWei)} TAO)`);
        if (done.messageId) log(`Bridge message ${done.messageId} sent. Follow it with: pnpm ops track ${done.messageId}${a.live ? " --live" : ""}`);
      }
      return 0;
    }
    case "rewards": {
      const rec = needRecord(a.live);
      const deps = keeperDeps(keeperCtx(a.live, rec), rec, recordPath(a.live));
      for (const line of formatRewards(await deps.readRewards(), claimPolicy(env))) log(line);
      return 0;
    }
    case "claim": {
      const rec = needRecord(a.live);
      const done = await claim(keeperDeps(keeperCtx(a.live, rec), rec, recordPath(a.live)), rec, claimPolicy(env));
      // Bittensor refunds the unused part of the large gas limit: this is what the claim cost
      log(`Done (transaction ${done.hash}, cost ${formatEther(done.costWei)} TAO). Set OPS_CLAIM_COST_TAO to that cost for the next decisions.`);
      return 0;
    }
    case "deliver": {
      const rec = needRecord(a.live);
      deliveryPlan(rec);
      // each result is printed as it happens; a failure then exits non-zero through main
      await deliverCommand(keeperDeps(keeperCtx(a.live, rec), rec, recordPath(a.live)), rec, a.users as Address[], log);
      return 0;
    }
    case "track":
      return (await trackMessage(ctxFor(a.live), needRecord(a.live), a.messageId as Hex)) === "SUCCESS" ? 0 : 1;
    case "run": {
      const rec = needRecord(a.live);
      const ctx = keeperCtx(a.live, rec);
      // a wrong key stops the loop now, not at its first send
      await requireKeeperKey(ctx);
      for (const line of uncheckedLines(rec)) log(line);
      await runLoop(keeperDeps(ctx, rec, recordPath(a.live), a.users as Address[]), rec, {
        intervalMs: 60_000,
        policy: claimPolicy(env),
        live: a.live,
      });
      return 1;
    }
    case "wind-down": {
      const rec = needRecord(a.live);
      for (const sent of await windDown(keeperDeps(ctxFor(a.live), rec, recordPath(a.live), a.users as Address[]), rec)) log(`Done (transaction ${sent.hash})`);
      log("The front door is paused with a deposit cap of 0. Next: sweep the test wallet's leftovers.");
      return 0;
    }
    case "web-config": {
      const path = writeWebEnv(needRecord(a.live), join(paths(env).contractsDir, ".."));
      log(`Wrote ${path}. Restart \`pnpm dev\` in web/ to pick it up.`);
      return 0;
    }
    case "sweep":
      await sweep(ctxFor(a.live), needRecord(a.live), a.taoTo as string, a.ethTo as string);
      log("Leftovers sent. You can now delete the password file.");
      return 0;
    case "handoff": {
      const out = await handoff(ctxFor(a.live), needRecord(a.live), {
        outDir: join(paths(env).deploymentsDir, "safe"),
        name: deploymentName(env),
        now: Date.now(),
      });
      for (const line of out.lines) log(line);
      return 0;
    }
    case "pause":
    case "unpause": {
      // an emergency command: always the live deployment; --live sends, otherwise a dry run that only reads
      const r = await pauseCommand({ ...ctxFor(true), live: a.live }, needRecord(true), {
        action: a.cmd,
        target: a.target ?? "both",
        send: a.live,
        signer: (role, address) => pauseSigner(env, paths(env), role, address),
        outDir: join(paths(env).deploymentsDir, "safe"),
        name: deploymentName(env),
        now: Date.now(),
      });
      for (const line of r.lines) log(line);
      return r.ok ? 0 : 1;
    }
    case "cardinality":
      // always the live Base pools: the transactions are for mainnet; reads only
      for (const line of await cardinalityReport(ctxFor(true))) log(line);
      return 0;
    case "ownership": {
      const r = await ownershipStatus(ctxFor(a.live), needRecord(a.live));
      for (const line of r.lines) log(line);
      return r.ok ? 0 : 1;
    }
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

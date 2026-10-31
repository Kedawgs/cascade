import { join, resolve } from "node:path";
import { type Address, formatEther, type Hex } from "viem";
import { type Args, parseArgs, USAGE, UsageError } from "./args.ts";
import { computeBudget, formatBudget, gatherBudgetInputs } from "./budget.ts";
import { cardinalityReport } from "./cardinality.ts";
import { baseLogsTarget, baseLogsWindow, cadenceFromEnv, type ChainName, claimPolicy, deploymentName, gasPriceCapFor, isV3Deployment, paths, recordPath as recordFor, targets } from "./config.ts";
import { deployAndVerify } from "./deploy.ts";
import { handoff, ownershipStatus } from "./handoff.ts";
import { pauseCommand, pauseSigner } from "./pause.ts";
import { claim, close, deliverCommand, deliveryPlan, payouts, runCommand, stake } from "./keeper/actions.ts";
import { closeHold } from "./keeper/due.ts";
import { formatRewards } from "./keeper/rewards.ts";
import { runLockPath, takeRunLock } from "./keeper/runlock.ts";
import { keeperSigner, requireKeeperKey, separateKeeper } from "./keeper/signer.ts";
import { keeperDeps, trackMessage } from "./keeper/state.ts";
import { formatStatus } from "./keeper/status.ts";
import { preflight } from "./preflight.ts";
import { type DeploymentRecord, loadRecordFor, needRecord as needRecordAt, uncheckedLines } from "./record.ts";
import { verifyAllowFromEnv } from "./registry.ts";
import { rehearse } from "./rehearse.ts";
import { launchRolesFromEnv } from "./roles.ts";
import { createRpc, logsRpc } from "./rpc.ts";
import { baseLogsLine, type Ctx, execFileRunner, unit } from "./send.ts";
import { printError, printLine } from "./output.ts";
import { liveRoles, prepareSign, servePage } from "./sign.ts";
import { verifyAndSave } from "./verify.ts";
import { writeWebEnv } from "./webconfig.ts";
import { sweep, windDown } from "./winddown.ts";

const env = process.env;
// every line printed, from any command, with any URL's secrets stripped (output.ts)
const log = printLine;

/** The gas price cap a command's sends go under (config.ts gasPriceCapFor): none for the hand-run
 * emergency and owner commands (pause, unpause, wind-down, sweep), which must go out in a gas spike
 * too, unless --max-gas-price names one; the environment's (or the defaults) for the rest. */
type GasCap = Record<ChainName, bigint> | undefined;

function ctxFor(live: boolean, maxGasPrice: GasCap): Ctx {
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
    ...(maxGasPrice ? { maxGasPrice } : {}),
    runner: execFileRunner,
    paths: paths(env),
    log,
    receiptTimeoutMs: 300_000,
  };
}

/** The keeper commands' context: their sends sign as the record's keeper with OPS_KEEPER_KEYSTORE and
 * OPS_KEEPER_PASSWORD_FILE, else as the test wallet (keeperSigner); requireReady refuses a mismatch. */
const keeperCtx = (live: boolean, rec: DeploymentRecord, cap: GasCap): Ctx => ({ ...ctxFor(live, cap), signer: keeperSigner(env, paths(env), rec.plan) });

/** A separate keeper key for budget and preflight to price and check (separateKeeper): the live record's
 * keeper, else a launch's from the environment. */
const budgetKeeper = () => separateKeeper(env, loadRecordFor(recordPath(true), true)?.plan);

/** The record of the deployment OPS_DEPLOYMENT names (without it, the v2 test deployment's). */
const recordPath = (live: boolean) => recordFor(env, live);

/** The record for a --live run or a rehearsal run; a record of the other kind is refused. */
const needRecord = (live: boolean) => needRecordAt(recordPath(live), live);

/** Where --for-wallet writes call files for `pnpm ops sign`. */
const walletDir = () => join(paths(env).deploymentsDir, "wallet");

async function run(a: Args): Promise<number> {
  // the gas price cap this command sends under: none for pause, unpause, wind-down and sweep
  const cap = gasPriceCapFor(a.cmd, env, a.maxGasPrice);
  switch (a.cmd) {
    case "rehearse":
      return (await rehearse(env, log)) ? 0 : 1;
    case "preflight": {
      const ctx = ctxFor(true, cap);
      const rehearsal = loadRecordFor(recordPath(false), false);
      const budget = rehearsal ? computeBudget(await gatherBudgetInputs(ctx, rehearsal, claimPolicy(env), budgetKeeper())) : undefined;
      const r = await preflight(ctx, loadRecordFor(recordPath(true), true), budget);
      for (const line of r.lines) log(line);
      log(r.ok ? "Pre-flight: all clear" : "Pre-flight: fix the problems above before deploying");
      return r.ok ? 0 : 1;
    }
    case "budget": {
      const rehearsal = loadRecordFor(recordPath(false), false);
      if (!rehearsal) throw new Error("run `pnpm ops rehearse` first: the budget uses its measured gas");
      for (const line of formatBudget(computeBudget(await gatherBudgetInputs(ctxFor(true, cap), rehearsal, claimPolicy(env), budgetKeeper())))) log(line);
      return 0;
    }
    case "deploy":
      return (await deployAndVerify(ctxFor(a.live, cap), recordPath(a.live), {
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
      return (await verifyAndSave(ctxFor(a.live, cap), recordPath(a.live), needRecord(a.live), { allow: verifyAllowFromEnv(env) })) ? 0 : 1;
    case "status": {
      const rec = needRecord(a.live);
      const deps = keeperDeps(keeperCtx(a.live, rec, cap), rec, recordPath(a.live), a.users as Address[]);
      const s = await deps.readState({ economics: true });
      for (const line of formatStatus(s.detail, { now: s.now, hold: closeHold(s) })) log(line);
      for (const line of uncheckedLines(rec)) log(line);
      return 0;
    }
    case "close":
    case "stake": {
      const rec = needRecord(a.live);
      const deps = keeperDeps(keeperCtx(a.live, rec, cap), rec, recordPath(a.live), a.users as Address[]);
      const done = await (a.cmd === "close" ? close(deps, rec) : stake(deps, rec));
      log(`Done (transaction ${done.hash}, cost ${formatEther(done.costWei)} ${unit(a.cmd === "close" ? "base" : "bittensor")})`);
      if (done.messageId) log(`Bridge message ${done.messageId} sent. Follow it with: pnpm ops track ${done.messageId}${a.live ? " --live" : ""}`);
      return 0;
    }
    case "payouts": {
      const rec = needRecord(a.live);
      const deps = keeperDeps(keeperCtx(a.live, rec, cap), rec, recordPath(a.live), a.users as Address[]);
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
      const deps = keeperDeps(keeperCtx(a.live, rec, cap), rec, recordPath(a.live));
      for (const line of formatRewards(await deps.readRewards(), claimPolicy(env))) log(line);
      return 0;
    }
    case "claim": {
      const rec = needRecord(a.live);
      const done = await claim(keeperDeps(keeperCtx(a.live, rec, cap), rec, recordPath(a.live)), rec, claimPolicy(env));
      // Bittensor refunds the unused part of the large gas limit: this is what the claim cost
      log(`Done (transaction ${done.hash}, cost ${formatEther(done.costWei)} TAO). Set OPS_CLAIM_COST_TAO to that cost for the next decisions.`);
      return 0;
    }
    case "deliver": {
      const rec = needRecord(a.live);
      deliveryPlan(rec);
      // each result is printed as it happens; a failure then exits non-zero through main
      await deliverCommand(keeperDeps(keeperCtx(a.live, rec, cap), rec, recordPath(a.live)), rec, a.users as Address[], log);
      return 0;
    }
    case "track":
      return (await trackMessage(ctxFor(a.live, cap), needRecord(a.live), a.messageId as Hex)) === "SUCCESS" ? 0 : 1;
    case "run":
      // exits KEEPER_STOPPED (3) when it stops itself or refuses to start (the supervisor never restarts
      // it then), 1 on a crash (the supervisor restarts it)
      return runCommand(
        async () => {
          const rec = needRecord(a.live);
          // one keeper per deployment: a second `run` (by hand beside the supervised one) refuses here
          const release = takeRunLock(runLockPath(recordPath(a.live)), { log });
          process.once("exit", release);
          const ctx = keeperCtx(a.live, rec, cap);
          const policy = claimPolicy(env);
          // a wrong key stops the loop now, not at its first send
          await requireKeeperKey(ctx, rec);
          for (const line of uncheckedLines(rec)) log(line);
          return { deps: keeperDeps(ctx, rec, recordPath(a.live), a.users as Address[]), rec, policy };
        },
        log,
        { intervalMs: 60_000, live: a.live },
      );
    case "wind-down": {
      const rec = needRecord(a.live);
      for (const sent of await windDown(keeperDeps(ctxFor(a.live, cap), rec, recordPath(a.live), a.users as Address[]), rec)) log(`Done (transaction ${sent.hash})`);
      log("The front door is paused with a deposit cap of 0. Next: sweep the test wallet's leftovers.");
      return 0;
    }
    case "web-config": {
      const path = writeWebEnv(needRecord(a.live), join(paths(env).contractsDir, ".."));
      log(`Wrote ${path}. Restart \`pnpm dev\` in web/ to pick it up.`);
      return 0;
    }
    case "sweep":
      await sweep(ctxFor(a.live, cap), needRecord(a.live), a.taoTo as string, a.ethTo as string);
      log("Leftovers sent. You can now delete the password file.");
      return 0;
    case "handoff": {
      const out = await handoff(ctxFor(a.live, cap), needRecord(a.live), {
        outDir: join(paths(env).deploymentsDir, "safe"),
        ...(a.forWallet ? { walletDir: walletDir() } : {}),
        name: deploymentName(env),
        now: Date.now(),
      });
      for (const line of out.lines) log(line);
      return 0;
    }
    case "pause":
    case "unpause": {
      // an emergency command: always the live deployment; --live sends, otherwise a dry run that only reads
      const r = await pauseCommand({ ...ctxFor(true, cap), live: a.live }, needRecord(true), {
        action: a.cmd,
        target: a.target ?? "both",
        send: a.live,
        signer: (role, address) => pauseSigner(env, paths(env), role, address),
        outDir: join(paths(env).deploymentsDir, "safe"),
        // --for-wallet: the plain account's call goes to a file for `sign`; parseArgs refuses it with --live
        ...(a.forWallet ? { walletDir: walletDir() } : {}),
        name: deploymentName(env),
        now: Date.now(),
      });
      for (const line of r.lines) log(line);
      return r.ok ? 0 : 1;
    }
    case "cardinality": {
      // always the live Base pools: the transactions are for mainnet; reads only
      const wallet = a.forWallet ? { from: a.from as Address, dir: walletDir(), now: Date.now() } : undefined;
      for (const line of await cardinalityReport(ctxFor(true, cap), wallet)) log(line);
      return 0;
    }
    case "sign": {
      // sends nothing: the page asks MetaMask to send, one click per call
      // the file must be for this run's deployment: OPS_DEPLOYMENT, or --deployment. pause and unpause
      // targets' guardian and owner are read from the live chains (reads only)
      const live = ctxFor(true, cap);
      const p = await prepareSign(resolve(a.file as string), {
        deployment: a.deployment ?? deploymentName(env),
        recordOf: (name) => loadRecordFor(recordFor({ ...env, OPS_DEPLOYMENT: name }, true), true),
        now: Date.now(),
        readRoles: (chain, address) => liveRoles(live, chain, address),
      });
      for (const line of p.lines) log(line);
      const server = await servePage(p.page);
      log(`Open ${server.url} in the browser where MetaMask is. Only this computer can reach it.`);
      log("When you're done: disconnect this site in MetaMask (Connected sites), then press Ctrl-C here.");
      await new Promise<void>((done) => process.once("SIGINT", () => done()));
      await server.close();
      return 0;
    }
    case "ownership": {
      const r = await ownershipStatus(ctxFor(a.live, cap), needRecord(a.live));
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
    // the usage text is fixed (its own example URLs stay whole); the message can quote what was typed
    printError(e.message);
    console.error(`\n${USAGE}`);
    return 2;
  }
  return run(a);
}

/** Exits once what was printed has been written out: on Windows, output to a pipe (a supervisor's log)
 * is written asynchronously, and process.exit would drop the last lines, such as why the keeper stopped. */
const exit = (code: number) => process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));

main(process.argv.slice(2)).then(exit, (e) => {
  printError(e instanceof Error ? e.message : String(e));
  exit(1);
});

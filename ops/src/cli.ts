import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Address, formatEther, type Hex, parseEther } from "viem";
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
import { deployV32FromEnv, type DeploymentRecordV32, loadRecordV32For } from "./v32/deploy.ts";
import { isPlanV32 } from "./v32/plan.ts";
import { isV32Deployment } from "./v32/settings.ts";
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

/** A record of a build before v3.2, or none: a v3.2 record is refused by every command this file runs for v3-launch
 * (the v3.2 read-backs and keeper are Tasks 45 to 53), so none of them reads or sends from it with v3-launch's ABIs. */
const notV32 = (rec: DeploymentRecord | null): DeploymentRecord | null => (rec && isPlanV32(rec.plan) ? null : rec);

/** A separate keeper key for budget and preflight to price and check (separateKeeper): the live record's
 * keeper, else a launch's from the environment. */
const budgetKeeper = () => separateKeeper(env, notV32(loadRecordFor(recordPath(true), true))?.plan);

/** The record of the deployment OPS_DEPLOYMENT names (without it, the v2 test deployment's). */
const recordPath = (live: boolean) => recordFor(env, live);

/** The record for a --live run or a rehearsal run; a record of the other kind is refused, and so is a v3.2 record:
 * these commands read and send for v3-launch, with its ABIs (v3.2's verify and keeper are Tasks 45 to 53). */
const needRecord = (live: boolean): DeploymentRecord => {
  const rec = needRecordAt(recordPath(live), live);
  if (isPlanV32(rec.plan)) {
    throw new Error(`${recordPath(live)} is a v3.2 deployment: this command does not read v3.2 yet (its read-backs and keeper are Tasks 45 to 53); nothing read or sent`);
  }
  return rec;
};

/** The record, of a build before v3.2 or of v3.2 (web-config writes either). */
const needAnyRecord = (live: boolean): DeploymentRecord | DeploymentRecordV32 => needRecordAt(recordPath(live), live) as DeploymentRecord | DeploymentRecordV32;

/** Where --for-wallet writes call files for `pnpm ops sign`. */
const walletDir = () => join(paths(env).deploymentsDir, "wallet");

/** A v3.2 hand run's own flags (keeper/lease-client.ts takeHandFlags), taken off before parseArgs. */
interface HandFlags {
  withoutLease?: string;
  ignoreMonitorOutageUntil?: string;
}

/** The keeper commands a v3.2 record runs by hand, under the Worker's lease (design-keeper-worker.md §3), and Task 53's
 * one-shots, which check first and take the lease only to send (--send). */
const V32_HAND: readonly string[] = ["run", "close", "stake", "payouts", "claim", "adopt", "add-hotkey", "remove-hotkey", "park"];
/** The commands a v3.2 record alone runs (Task 53): nothing of v3-launch's has them. */
const V32_ONLY: readonly string[] = ["adopt", "add-hotkey", "remove-hotkey", "set-stake-hotkey", "park", "set-redeem-origin", "set-keeper", "fund-reserve", "fund-cushion", "disable-bridge", "set-idle-buffer", "set-claim-gas", "add-pair", "set-caps", "set-batch-limits"];
/** A v3.2 hand command: those, and pnpm ops reexec (Task 52w, parsed on its own: reexecCommand) */
type HandCmd = import("./keeper/lease-client.ts").HandCmdV32;

/** The v3.2 record OPS_DEPLOYMENT names, when it is one (the v3-launch commands below never see it). A record that can't
 * be read at all (another kind, not JSON, a read error) is none: v3-launch's path reports it as it always has (run:
 * "Stopped: …", the banner, exit 3, which the supervisor never restarts). A v3.2 record its own check refuses
 * (loadRecordV32For: no frozen build, say) throws its own reason (the T50b re-review's N7). */
function v32RecordOf(live: boolean): DeploymentRecordV32 | null {
  let rec: DeploymentRecord | DeploymentRecordV32 | null;
  try {
    rec = loadRecordFor(recordPath(live), live) as DeploymentRecord | DeploymentRecordV32 | null;
  } catch {
    return null;
  }
  return rec && isPlanV32(rec.plan) ? loadRecordV32For(recordPath(live), live) : null;
}

async function run(a: Args, flags: HandFlags = {}): Promise<number> {
  // the gas price cap this command sends under: none for pause, unpause, wind-down and sweep
  const cap = gasPriceCapFor(a.cmd, env, a.maxGasPrice);
  // the owner's or the guardian's hotkey call, as a file for the sign page (Task 53), is no hand run
  if (V32_HAND.includes(a.cmd) && !a.forWallet) {
    let r32: DeploymentRecordV32 | null;
    try {
      r32 = v32RecordOf(a.live);
    } catch (e) {
      // a v3.2 record refused by its own check: its reason, as it is; `run` refuses to start as the keeper does (the
      // banner and exit 3, which a supervisor never restarts), a one-shot command fails with it
      if (a.cmd !== "run") throw e;
      return runCommand(
        async () => {
          throw e;
        },
        log,
        { intervalMs: 60_000, live: a.live },
      );
    }
    if (r32) {
      const oneShot = { ...(a.hotkey ? { hotkey: a.hotkey } : {}), ...(a.parkKey ? { key: a.parkKey } : {}), send: a.send === true };
      return handV32({ cmd: a.cmd as HandCmd, live: a.live }, r32, flags, cap, undefined, oneShot);
    }
    if (V32_ONLY.includes(a.cmd)) throw new Error(`pnpm ops ${a.cmd} is for a v3.2 deployment: OPS_DEPLOYMENT names no v3.2 ${a.live ? "live" : "rehearsal"} record here; nothing read or sent`);
    if (a.cmd === "claim" && (a.send || a.hotkey)) throw new Error("a hotkey and --send are for a v3.2 deployment's claim; v3-launch's claim sends when the claim policy says so; nothing read or sent");
  }
  if (flags.withoutLease !== undefined || flags.ignoreMonitorOutageUntil !== undefined) {
    throw new Error("--without-lease and --ignore-monitor-outage are for v3.2 hand runs only (v3-launch's keeper keeps its file lock); nothing sent");
  }
  switch (a.cmd) {
    case "rehearse":
      if (a.v32) {
        // v3.2 (Task 61 step 3): the deployment as deploy --v32 sends it, verify, the negatives, the founder's steps
        const { rehearseV32 } = await import("./v32/rehearse.ts");
        return (await rehearseV32(env, log, { noBuild: a.noBuild ?? false })) ? 0 : 1;
      }
      return (await rehearse(env, log)) ? 0 : 1;
    case "preflight": {
      const ctx = ctxFor(true, cap);
      // v3-launch's budget reads its rehearsal's measured gas; a v3.2 rehearsal has its own (Task 61)
      const rehearsal = notV32(loadRecordFor(recordPath(false), false));
      const budget = rehearsal ? computeBudget(await gatherBudgetInputs(ctx, rehearsal, claimPolicy(env), budgetKeeper())) : undefined;
      const r = await preflight(ctx, loadRecordFor(recordPath(true), true) as DeploymentRecord | DeploymentRecordV32 | null, budget, { v32: isV32Deployment(env) });
      for (const line of r.lines) log(line);
      log(r.ok ? "Pre-flight: all clear" : "Pre-flight: fix the problems above before deploying");
      return r.ok ? 0 : 1;
    }
    case "budget": {
      // v3.2 (the off-chain report's concern 6): from its rehearsal record's measured gas, the founder's steps, the pools'
      // cardinality and today's gas prices read from public RPCs (v32/budget.ts), and (R12a) the keeper's ETH on Base by its
      // spend cap as the Worker gets it (OPS_KEEPER_SPEND_CAP_BASE); v3-launch's below, as before
      if (isV32Deployment(env)) {
        const { budgetCommandV32, publicRpcV32 } = await import("./v32/budget.ts");
        const { spendCapOf } = await import("./keeper/deployment-v32.ts");
        for (const line of await budgetCommandV32(publicRpcV32(), { path: recordPath(false), contractsDir: paths(env).contractsDir, spendCap: spendCapOf(env).base })) log(line);
        return 0;
      }
      const rehearsal = notV32(loadRecordFor(recordPath(false), false));
      if (!rehearsal) throw new Error("run `pnpm ops rehearse` first: the budget uses its measured gas");
      for (const line of formatBudget(computeBudget(await gatherBudgetInputs(ctxFor(true, cap), rehearsal, claimPolicy(env), budgetKeeper())))) log(line);
      return 0;
    }
    case "deploy":
      if (a.v32) {
        await deployV32FromEnv(ctxFor(a.live, cap), env, recordPath(a.live), { newPlan: a.newPlan ?? false });
        return 0;
      }
      if (isV32Deployment(env)) throw new Error(`OPS_DEPLOYMENT ${deploymentName(env)} is a v3.2 deployment: deploy it with deploy --v32; nothing read or sent`);
      return (await deployAndVerify(ctxFor(a.live, cap), recordPath(a.live), {
        newPlan: a.newPlan ?? false,
        v3: isV3Deployment(env),
        cadence: cadenceFromEnv(env),
        roles: () => launchRolesFromEnv(env),
        allow: verifyAllowFromEnv(env),
      }))
        ? 0
        : 1;
    case "verify": {
      // the v3.2 validators from the configuration, with no record (ruling A8)
      // (the v3.2 modules load only here: no v3-launch command reads them)
      if (a.validators) {
        const { validatorsCommandV32 } = await import("./v32/validators.ts");
        const v = await validatorsCommandV32(ctxFor(a.live, cap), env);
        for (const line of v.lines) log(line);
        return v.ok ? 0 : 1;
      }
      // a v3.2 record: its code and state read-backs (v32/verify.ts); any other, v3-launch's verify, as before
      if (isPlanV32(needAnyRecord(a.live).plan)) {
        const { verifyV32AndSave } = await import("./v32/verify.ts");
        return (await verifyV32AndSave(ctxFor(a.live, cap), recordPath(a.live))) ? 0 : 1;
      }
      // refuses a v2 record before reading anything: its contracts no longer match the build
      return (await verifyAndSave(ctxFor(a.live, cap), recordPath(a.live), needRecord(a.live), { allow: verifyAllowFromEnv(env) })) ? 0 : 1;
    }
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
      const path = writeWebEnv(needAnyRecord(a.live), join(paths(env).contractsDir, ".."), env);
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
      // v3.2 (Task 53): the guardian's (or --as owner) pause, the owner's unpause, as a call file for the sign page
      if (v32RecordOf(true)) {
        if (!a.forWallet) throw new Error(`a v3.2 deployment's ${a.cmd} is the Ledger's, from the sign page: pnpm ops ${a.cmd} ${a.target ?? "both"} --for-wallet; nothing sent`);
        const { pauseFileCommand } = await import("./v32/hotkey-files.ts");
        const r = await pauseFileCommand(ctxFor(true, cap), needRecordV32(true), {
          dir: walletDir(),
          name: deploymentName(env),
          now: Date.now(),
          action: a.cmd,
          target: a.target ?? "both",
          as: a.cmd === "unpause" ? "owner" : (a.as ?? "guardian"),
          ...(a.offline ? { offline: true } : {}),
        });
        for (const line of r.lines) log(line);
        return r.ok ? 0 : 1;
      }
      if (a.as) throw new Error("--as is for a v3.2 deployment's pause; v3-launch's pause is the guardian's; nothing sent");
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
    case "pool-floors": {
      // v3.2 (Task 61 step 4): reads only, from Base's public RPC, which serves state 30 days back (no key to print)
      const { readPoolFloors, floorLines, PUBLIC_BASE_ARCHIVE } = await import("./v32/floors.ts");
      log(`Reading Base's history from ${new URL(PUBLIC_BASE_ARCHIVE).host} (one block a day for 30 days, both of the oracle's pools)`);
      const rpc = createRpc({ base: { rpcUrl: PUBLIC_BASE_ARCHIVE }, bittensor: { rpcUrl: PUBLIC_BASE_ARCHIVE } });
      for (const line of floorLines(await readPoolFloors(rpc))) log(line);
      return 0;
    }
    case "cardinality": {
      // always the live Base pools: the transactions are for mainnet; reads only
      const wallet = a.forWallet ? { from: a.from as Address, dir: walletDir(), now: Date.now() } : undefined;
      for (const line of await cardinalityReport(ctxFor(true, cap), paths(env).contractsDir, wallet)) log(line);
      return 0;
    }
    case "sign": {
      // sends nothing itself: the page asks MetaMask to send, one click per call
      // the file must be for this run's deployment: OPS_DEPLOYMENT, or --deployment. pause and unpause
      // targets' guardian and owner are read from the live chains (reads only)
      const live = ctxFor(true, cap);
      const deployment = a.deployment ?? deploymentName(env);
      const stampsDir = join(paths(env).deploymentsDir, "..", "stamps");
      const pageStamps = async () =>
        (await import("./v32/stamp.ts")).signPageStamps(ctxFor(true, gasPriceCapFor("stamp", env, a.maxGasPrice)), env, { dir: stampsDir, name: deployment });
      const p = await prepareSign(resolve(a.file as string), {
        deployment,
        recordOf: (name) => loadRecordFor(recordFor({ ...env, OPS_DEPLOYMENT: name }, true), true),
        now: Date.now(),
        readRoles: (chain, address) => liveRoles(live, chain, address),
        // a v3.2 file (v32/sign.ts): checked against the live chains when served and, for a door removal, again just
        // before it is sent; a stamp the owner's Ledger signs on the page is handed to pnpm ops stamp's relay, which
        // sends it from the relayer's keystore (OPS_RELAYER_KEYSTORE, named before the page is served) under no gas
        // price cap, or to its --to-stack. The v3.2 modules load only for such a file.
        v32: {
          ctx: live,
          // v32/stamp.ts's signPageStamps (tested there), loaded only when a v3.2 file asks
          stamps: {
            dir: stampsDir,
            ready: async (mode) => (await pageStamps()).ready(mode),
            submit: async (rec, s) => (await pageStamps()).submit(rec, s),
          },
        },
      });
      for (const line of p.lines) log(line);
      const server = await servePage(p.page, p.api);
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
    case "schedule":
    case "pending":
    case "execute":
    case "cancel":
    case "cancel-payouts": {
      // v3.2's scheduler and the owner's payout-batch cancel: reads only; all but pending write a call file for the sign
      // page, which the founder sends from MetaMask. Which command runs, the rail checks among them (Task 47b and its fix
      // round), is v32/commands.ts's, where it is tested. The v3.2 modules load only here.
      const { schedulerFileCommand } = await import("./v32/commands.ts");
      const rec = needRecordV32(a.live);
      // the relayer's stamp stacks (ops/stamps/), which schedule warns of when one reaches an item's schedule time
      const r = await schedulerFileCommand(a, ctxFor(a.live, cap), rec, { dir: walletDir(), name: deploymentName(env), now: Date.now(), stampsDir: join(paths(env).deploymentsDir, "..", "stamps") });
      for (const line of r.lines) log(line);
      return r.ok ? 0 : 1;
    }
    case "add-pair": {
      // v3.2 (R4, D-M2): a new adapter pair written into the record, checked first (v32/pairs.ts); it sends nothing
      const { addPairCommand } = await import("./v32/pairs.ts");
      const { saveRecord } = await import("./record.ts");
      const path = recordPath(a.live);
      const [bitAdapter, baseAdapter] = a.pair as Address[];
      const r = await addPairCommand(ctxFor(a.live, cap), needRecordV32(a.live), {
        bitAdapter,
        baseAdapter,
        now: Date.now(),
        save: (rec) => saveRecord(path, rec),
        ...(a.targetBlock !== undefined ? { targetBlock: a.targetBlock } : {}),
      });
      for (const line of r.lines) log(line);
      return r.ok ? 0 : 1;
    }
    case "retire-pair":
    case "remove-door": {
      // v3.2's retirement files (v32/retire.ts), each refused while what it retires still holds funds (spec §3.2's ops
      // rule): reads only, then a call file for the sign page. The v3.2 modules load only here.
      const ret = await import("./v32/retire.ts");
      const rec = needRecordV32(a.live);
      const ctx = ctxFor(a.live, cap);
      const files = { dir: walletDir(), name: deploymentName(env), now: Date.now(), as: a.as as "owner" | "guardian" };
      const r =
        a.cmd === "retire-pair"
          ? await ret.retirePairCommand(ctx, rec, files)
          : await ret.removeDoorCommand(ctx, rec, { ...files, chain: BigInt(a.doorChain as string), door: a.door as Address });
      for (const line of r.lines) log(line);
      return r.ok ? 0 : 1;
    }
    case "add-hotkey":
    case "remove-hotkey":
    case "set-stake-hotkey": {
      // v3.2's owner's or guardian's hotkey call (v32/hotkey-files.ts, Task 53): reads only, then a call file for the sign
      // page. The v3.2 modules load only here.
      const { hotkeyFileCommand } = await import("./v32/hotkey-files.ts");
      const rec = needRecordV32(a.live);
      const fn = a.cmd === "add-hotkey" ? "addHotkey" : a.cmd === "remove-hotkey" ? "removeHotkey" : "setStakeHotkey";
      const r = await hotkeyFileCommand(ctxFor(a.live, cap), rec, {
        dir: walletDir(),
        name: deploymentName(env),
        now: Date.now(),
        fn,
        hotkey: a.hotkey as Hex,
        as: a.cmd === "set-stake-hotkey" ? "owner" : (a.as as "owner" | "guardian"),
        forfeit: a.forfeit === true,
      });
      for (const line of r.lines) log(line);
      return r.ok ? 0 : 1;
    }
    case "set-keeper":
    case "fund-reserve":
    case "fund-cushion":
    case "disable-bridge":
    case "set-caps":
    case "set-batch-limits":
    case "set-claim-gas":
    case "set-idle-buffer": {
      // v3.2 (Task 53's fix round): the sign page's four missing calls, each as a call file (v32/hotkey-files.ts); merge
      // 7b: the token cushion's approve and fundCushion
      const hf = await import("./v32/hotkey-files.ts");
      const rec = needRecordV32(a.live);
      const ctx = ctxFor(a.live, cap);
      const files = { dir: walletDir(), name: deploymentName(env), now: Date.now() };
      const r =
        a.cmd === "set-keeper"
          ? await hf.setKeeperFileCommand(ctx, rec, { ...files, keeper: a.newKeeper as Address })
          : a.cmd === "fund-reserve" || a.cmd === "fund-cushion"
            ? await (a.cmd === "fund-reserve" ? hf.fundReserveFileCommand : hf.fundCushionFileCommand)(ctx, rec, { ...files, from: a.from as Address })
            : a.cmd === "disable-bridge"
              ? await hf.disableBridgeFileCommand(ctx, rec, { ...files, target: a.target ?? "both", bridges: (a.bridges ?? []) as Address[], as: a.as as "owner" | "guardian" })
              : a.cmd === "set-caps"
                ? await hf.capsFileCommand(ctx, rec, { ...files, minDeposit: parseEther((a.caps as string[])[0]), depositCap: parseEther((a.caps as string[])[1]) })
                : a.cmd === "set-batch-limits"
                  ? await hf.batchLimitsFileCommand(ctx, rec, { ...files, maxDeposits: Number((a.batchLimits as string[])[0]), maxRedeems: Number((a.batchLimits as string[])[1]) })
                : a.cmd === "set-claim-gas"
                  ? await hf.claimGasFileCommand(ctx, rec, { ...files, gas: BigInt(a.claimGas as string) })
                  : await hf.idleBufferFileCommand(ctx, rec, { ...files, bps: BigInt(a.bps as string) });
      for (const line of r.lines) log(line);
      return r.ok ? 0 : 1;
    }
    case "set-redeem-origin": {
      // v3.2: the treasury's own setRedeemOrigin(DIRECT_ORIGIN) (v32/hotkey-files.ts, Task 53), as a call file
      const { redeemOriginFileCommand } = await import("./v32/hotkey-files.ts");
      const r = await redeemOriginFileCommand(ctxFor(a.live, cap), needRecordV32(a.live), { dir: walletDir(), name: deploymentName(env), now: Date.now() });
      for (const line of r.lines) log(line);
      return r.ok ? 0 : 1;
    }
    case "adopt":
    case "park":
      // a v3.2 record's one-shot ran above: neither has a v3-launch form (refused above too)
      throw new Error(`pnpm ops ${a.cmd} is for a v3.2 deployment; nothing read or sent`);
    case "stamp": {
      // v3.2's owner-signed stamp (v32/stamp.ts): what the owner signs, a signed stamp relayed now, the stack and its
      // due relays (for a bot). Only a relay sends, from the relayer's keystore (OPS_RELAYER_KEYSTORE, by path), under
      // no gas price cap. The v3.2 modules load only here.
      const st = await import("./v32/stamp.ts");
      const rec = needRecordV32(a.live);
      const relays = a.relayDue === true || (a.sig !== undefined && !a.toStack);
      const r = await st.stampCommand(ctxFor(a.live, cap), rec, {
        mode: a.relayDue ? "relayDue" : a.stack !== undefined ? "stack" : a.sig !== undefined ? (a.toStack ? "toStack" : "relay") : "prepare",
        targets: a.target === "vault" ? ["vault"] : a.target === "front-door" ? ["frontDoor"] : ["vault", "frontDoor"],
        ...(a.asOf !== undefined ? { asOf: BigInt(a.asOf) } : {}),
        ...(a.sig !== undefined ? { sig: a.sig } : {}),
        ...(a.stack !== undefined ? { days: Number(a.stack) } : {}),
        ...(a.every !== undefined ? { everyHours: Number(a.every) } : {}),
        ...(a.acceptGapRisk !== undefined ? { acceptGapRisk: a.acceptGapRisk } : {}),
        ...(a.tip !== undefined ? { tipGwei: BigInt(a.tip) } : {}),
        ...(relays ? { relayer: st.relayerFromEnv(env) } : {}),
        dir: join(paths(env).deploymentsDir, "..", "stamps"),
        name: deploymentName(env),
        // what the owner signs, also as a file for the sign page (Task 49)
        walletDir: walletDir(),
        now: Date.now(),
      });
      for (const line of r.lines) log(line);
      return r.ok ? 0 : 1;
    }
  }
}

/** A v3.2 keeper command by hand (design-keeper-worker.md §3; the founder's 2026-11-07 decisions): the Worker's key
 * from its keystore (OPS_V32_KEEPER_KEYSTORE and OPS_V32_KEEPER_PASSWORD_FILE, through cast), under the Worker's lease
 * (OPS_KEEPER_URL and OPS_KEEPER_CONTROL_TOKEN: taken, renewed before every send, released on exit or Ctrl-C) and its
 * journal, or for a one-shot command --without-lease "<reason>", said loudly. The rails (Task 50a) from OPS_HOLD_URL
 * and ops/hold.json. `run` loops on the core's rounds; a one-shot command first checks the live readiness (T50 M6)
 * and the rails, as a round does. On the local forks the lease is taken only when OPS_KEEPER_URL names a Worker. The
 * v3.2 modules load only here. */
async function handV32(
  a: { cmd: HandCmd; live: boolean },
  rec: DeploymentRecordV32,
  flags: HandFlags,
  cap: GasCap,
  reexec?: { id: Hex; fromTx?: Hex; proof?: import("./keeper/core/v32/reexec.ts").GivenProof; gas?: number; send: boolean; emptyProof?: true; executionInputs?: (id: Hex) => Promise<import("./keeper/core/v32/ccip-api.ts").ExecutionInputsAnswer> },
  oneShot?: { hotkey?: Hex; key?: Hex; send: boolean },
): Promise<number> {
  const [lease, deploymentV32, castSign, railsHost] = await Promise.all([
    import("./keeper/lease-client.ts"),
    import("./keeper/deployment-v32.ts"),
    import("./keeper/cast-signer.ts"),
    import("./keeper/rails-host.ts"),
  ]);
  const ctx = ctxFor(a.live, cap);
  const t = ctx.targets;
  const keystore = env.OPS_V32_KEEPER_KEYSTORE?.trim();
  const passwordFile = env.OPS_V32_KEEPER_PASSWORD_FILE?.trim();
  if (!keystore || !passwordFile) {
    throw new Error(
      "set OPS_V32_KEEPER_KEYSTORE (the keystore pnpm keeper:new-key wrote) and OPS_V32_KEEPER_PASSWORD_FILE (a file holding its password) in ops/.env: a v3.2 hand run signs with the Worker's key; nothing sent",
    );
  }
  // the Bittensor RPC must keep the vault's history: the scans read it from the start blocks (as config-from-record)
  const vaultBlock = rec.done.vault?.block;
  const pruned = vaultBlock === undefined ? undefined : await lease.historyProblem(ctx.logs ?? ctx.rpc, rec.plan.addresses.vault, vaultBlock);
  if (pruned) throw new Error(pruned);
  const deployment = deploymentV32.deploymentFromRecordV32(rec, {
    name: deploymentName(env),
    chainIds: { base: t.base.chainId, bittensor: t.bittensor.chainId },
    vaultCreatedAt: await deploymentV32.vaultCreatedAtOf(ctx.rpc, rec),
    env,
  });
  return lease.handCommandV32({
    cmd: a.cmd,
    ...(reexec ? { reexec } : {}),
    ...(oneShot ? { oneShot } : {}),
    live: a.live,
    name: deploymentName(env),
    deployment,
    // the keystore's own account (R4, D-M1): after a rotation the record's keeper is the old one, and readiness holds the
    // key to keeper() on both contracts
    signer: await castSign.keeperSignerV32({ runner: ctx.runner, paths: ctx.paths, targets: t }, { keystore, passwordFile }),
    rpc: ctx.rpc,
    ...(ctx.logs ? { logs: ctx.logs } : {}),
    ...(ctx.logsWindow ? { logsWindow: ctx.logsWindow } : {}),
    chains: { base: { chainId: t.base.chainId, legacy: t.base.legacy }, bittensor: { chainId: t.bittensor.chainId, legacy: t.bittensor.legacy } },
    ...(cap ? { maxGasPrice: cap } : {}),
    receiptTimeoutMs: ctx.receiptTimeoutMs,
    rails: (deliveriesOn) =>
      railsHost.handRails(env, { nowMs: Date.now(), deliveriesOn, ...(flags.ignoreMonitorOutageUntil !== undefined ? { ignoreMonitorOutageUntil: flags.ignoreMonitorOutageUntil } : {}) }),
    control: lease.controlFromEnv(env, log),
    ...(flags.withoutLease !== undefined ? { withoutLease: flags.withoutLease } : {}),
    policy: claimPolicy(env),
    log,
    onInterrupt: (release) => {
      const on = () => void release().finally(() => process.exit(130));
      process.once("SIGINT", on);
      return () => process.off("SIGINT", on);
    },
  });
}

/** pnpm ops reexec <messageId> [--from-tx <hash> | --proof <file>] [--gas <limit>] [--live] [--send] [--without-lease
 * "<reason>"] [--ignore-monitor-outage --until <time>] (Task 52; registered by Task 52w): one of Cascade's CCIP FAILUREs
 * re-executed by hand, on a v3.2 record only, as a one-shot command of handV32's (the live readiness, then with --send the
 * Worker's lease or --without-lease; the hand run's flags taken as the other one-shots take them). --live names the live
 * record, as in every command; only --send sends (without it the command checks, simulates and prints). */
async function reexecCommand(argv: string[]): Promise<number> {
  const [{ parseProofFile, parseReexecArgs, REEXEC_USAGE, reexecHandInput }, { takeHandFlags }] = await Promise.all([import("./keeper/core/v32/reexec-hand.ts"), import("./keeper/lease-client.ts")]);
  let r: ReturnType<typeof parseReexecArgs>;
  let flags: HandFlags;
  try {
    const taken = takeHandFlags(["reexec", ...argv]);
    flags = { ...(taken.withoutLease !== undefined ? { withoutLease: taken.withoutLease } : {}), ...(taken.ignoreMonitorOutageUntil !== undefined ? { ignoreMonitorOutageUntil: taken.ignoreMonitorOutageUntil } : {}) };
    r = parseReexecArgs(taken.argv.slice(1));
  } catch (e) {
    printError((e as Error).message.replace(` ${REEXEC_USAGE}`, ""));
    console.error(`\nusage: ${REEXEC_USAGE}`);
    return 2;
  }
  let proof: ReturnType<typeof parseProofFile> | undefined;
  if (r.proofFile) {
    let text: string;
    try {
      text = readFileSync(resolve(r.proofFile), "utf8");
    } catch (e) {
      throw new Error(`the proof file ${r.proofFile} can't be read (${(e as Error).message.split("\n")[0]}); nothing sent`);
    }
    proof = parseProofFile(text, r.proofFile);
  }
  // Task 65: another execute's calldata, given inline
  if (r.proofHex) proof = parseProofFile(r.proofHex, r.proofHex);
  const rec = v32RecordOf(r.live);
  if (!rec) throw new Error(`pnpm ops reexec is for a v3.2 deployment: OPS_DEPLOYMENT names no v3.2 ${r.live ? "live" : "rehearsal"} record here; nothing read or sent`);
  // the parsed arguments as the hand command takes them (reexec-hand.ts reexecHandInput, tested there): send only from --send
  const input = reexecHandInput(r, proof);
  // Task 65: Chainlink's CCIP API, where the committee's results are read when no attempt on chain carries them
  const { fetchExecutionInputs } = await import("./keeper/core/v32/ccip-api.ts");
  return handV32({ cmd: "reexec", live: input.live }, rec, flags, gasPriceCapFor("reexec", env), { ...input.reexec, executionInputs: (id) => fetchExecutionInputs(id) });
}

/** The v3.2 record for a --live run or a rehearsal run (loadRecordV32For refuses one of another version or kind). */
function needRecordV32(live: boolean): DeploymentRecordV32 {
  const rec = loadRecordV32For(recordPath(live), live);
  if (!rec) throw new Error(`no ${live ? "live" : "rehearsal"} v3.2 deployment record at ${recordPath(live)}: set OPS_DEPLOYMENT to the v3.2 deployment's name; nothing read`);
  return rec;
}

async function main(argv: string[]): Promise<number> {
  // pnpm ops reexec <messageId> …: one of Cascade's CCIP FAILUREs re-executed by hand (Task 52; v3.2 only)
  if (argv[0] === "reexec") return reexecCommand(argv.slice(1));
  // pnpm ops keeper status | stop | start | lease --break | deliveries | retry: the keeper Worker's control routes
  if (argv[0] === "keeper") {
    const { keeperCommand, KEEPER_USAGE } = await import("./keeper/lease-client.ts");
    try {
      return await keeperCommand(argv.slice(1), env, log);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("pnpm ops keeper ")) throw e;
      printError(e.message.replace(`: ${KEEPER_USAGE}`, ""));
      console.error(`\n${KEEPER_USAGE}`);
      return 2;
    }
  }
  let a: Args;
  let flags: HandFlags;
  try {
    // a v3.2 hand run's own flags, which ops' parser doesn't know
    const { takeHandFlags } = await import("./keeper/lease-client.ts");
    const taken = takeHandFlags(argv);
    flags = { ...(taken.withoutLease !== undefined ? { withoutLease: taken.withoutLease } : {}), ...(taken.ignoreMonitorOutageUntil !== undefined ? { ignoreMonitorOutageUntil: taken.ignoreMonitorOutageUntil } : {}) };
    a = parseArgs(taken.argv);
  } catch (e) {
    if (!(e instanceof UsageError) && !(e instanceof Error && /^--(without-lease|ignore-monitor-outage|until) /.test(e.message))) throw e;
    // the usage text is fixed (its own example URLs stay whole); the message can quote what was typed
    printError(e.message);
    console.error(`\n${USAGE}`);
    return 2;
  }
  return run(a, flags);
}

/** Exits once what was printed has been written out: on Windows, output to a pipe (a supervisor's log)
 * is written asynchronously, and process.exit would drop the last lines, such as why the keeper stopped. */
const exit = (code: number) => process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));

main(process.argv.slice(2)).then(exit, (e) => {
  printError(e instanceof Error ? e.message : String(e));
  exit(1);
});

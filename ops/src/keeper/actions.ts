import type { Address, Hex } from "viem";
import { CLAIM_POLICY, type ClaimPolicy, WALLET } from "../config.ts";
import { isPlanV3, type PlanV3, rolesOf } from "../plan.ts";
import { type DeploymentRecord, requireHandoff } from "../record.ts";
import * as core from "./core/actions.ts";
import type { Delivery, Done, KeeperDeps, KeeperTarget, Rolled } from "./core/actions.ts";
import type { Action } from "./core/due.ts";
import { KeeperNotReady } from "./core/failures.ts";
import type { KeeperMemory } from "./core/memory.ts";
import * as round from "./core/round.ts";
import type { LoopEnd, RunOptions } from "./core/round.ts";
import { keeperMismatch } from "./signer.ts";

// The PC's v3-launch host of the keeper's portable core (core/actions.ts): the core acts on a KeeperTarget, and this
// file builds one from the deployment record (launchTarget), with the record's two decisions, readiness and the USDC
// delivery plan, as they always were. Every action takes the record, as it always has.

export * from "./core/actions.ts";
export * from "./core/round.ts";

/** Keeper sends need the whole deployment in place and its read-back passed; a launch, its hand-off
 * accepted by the final owners too; and `signer`, who the keeper commands sign as (keeperSigner), must be
 * the record's keeper. Refuses with KeeperNotReady, which stops `run`. */
export function requireReady(rec: DeploymentRecord, signer: Address = WALLET): void {
  const missing = rec.plan.steps.filter((s) => !rec.done[s.id]);
  if (missing.length || !rec.verify?.ok) {
    throw new KeeperNotReady(
      `the deployment is not complete and verified yet (${missing.length ? `${missing.length} step(s) to go` : "the read-back has not passed"}): run deploy, then verify`,
    );
  }
  try {
    requireHandoff(rec);
  } catch (e) {
    throw new KeeperNotReady((e as Error).message);
  }
  const keeper = rolesOf(rec.plan).keeper;
  if (keeper.toLowerCase() !== signer.toLowerCase()) throw new KeeperNotReady(keeperMismatch(keeper, signer));
}

/** The record's v3 plan; a v2 deployment has no USDC delivery. */
export function deliveryPlan(rec: DeploymentRecord): PlanV3 {
  if (!isPlanV3(rec.plan)) throw new Error("USDC delivery needs a v3 deployment (OPS_DEPLOYMENT=v3-…); this record's front door has none");
  return rec.plan;
}

/** The record as the core's target: its contracts, read through the record (refresh updates it in place), its
 * readiness (requireReady) and its delivery plan (deliveryPlan). */
export function launchTarget(rec: DeploymentRecord): KeeperTarget {
  return {
    get plan() {
      return rec.plan;
    },
    requireReady: (signer) => requireReady(rec, signer),
    deliveryPlan: () => deliveryPlan(rec),
  };
}

export const close = (deps: KeeperDeps, rec: DeploymentRecord): Promise<Done> => core.close(deps, launchTarget(rec));
export const roll = (deps: KeeperDeps, rec: DeploymentRecord): Promise<Rolled> => core.roll(deps, launchTarget(rec));
export const stake = (deps: KeeperDeps, rec: DeploymentRecord): Promise<Done> => core.stake(deps, launchTarget(rec));
export const payouts = (deps: KeeperDeps, rec: DeploymentRecord, key: Hex, o: { rescanned?: boolean } = {}): Promise<Done> =>
  core.payouts(deps, launchTarget(rec), key, o);
export const claim = (deps: KeeperDeps, rec: DeploymentRecord, policy: ClaimPolicy): Promise<Done> => core.claim(deps, launchTarget(rec), policy);
export const deliver = (deps: KeeperDeps, rec: DeploymentRecord, user: Address): Promise<Delivery> => core.deliver(deps, launchTarget(rec), user);
export const deliverAll = (deps: KeeperDeps, rec: DeploymentRecord, users: readonly Address[], report?: (d: Delivery) => void): Promise<Delivery[]> =>
  core.deliverAll(deps, launchTarget(rec), users, report);
export const deliverCommand = (deps: KeeperDeps, rec: DeploymentRecord, users: readonly Address[], log: (line: string) => void): Promise<Delivery[]> =>
  core.deliverCommand(deps, launchTarget(rec), users, log);
export const act = (deps: KeeperDeps, rec: DeploymentRecord, a: Exclude<Action, { kind: "deliver" } | { kind: "roll" }>, o: { rescanned?: boolean } = {}): Promise<Done> =>
  core.act(deps, launchTarget(rec), a, o);

/** `run`'s loop on the record (core/round.ts runLoop), reporting claims by config.ts's CLAIM_POLICY unless `opts` names one;
 * from `memory` when given (a fresh one otherwise). */
export const runLoop = (deps: KeeperDeps, rec: DeploymentRecord, opts: RunOptions, memory?: KeeperMemory): Promise<LoopEnd> =>
  round.runLoop(deps, launchTarget(rec), { ...opts, policy: opts.policy ?? CLAIM_POLICY }, memory);

/** `pnpm ops run` (core/round.ts runCommand) on the record `start` loads. */
export const runCommand = (
  start: () => Promise<{ deps: KeeperDeps; rec: DeploymentRecord; policy?: ClaimPolicy }>,
  log: (line: string) => void,
  opts: RunOptions,
): Promise<number> =>
  round.runCommand(
    async () => {
      const s = await start();
      return { ...s, rec: launchTarget(s.rec) };
    },
    log,
    { ...opts, policy: opts.policy ?? CLAIM_POLICY },
  );

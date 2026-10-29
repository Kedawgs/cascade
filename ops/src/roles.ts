import { type Address, getAddress, isAddress, zeroAddress } from "viem";
import { type ChainName, type Env, SETTINGS_V3, WALLET } from "./config.ts";

/** Who holds each role. The owner and the guardian are per chain: a Safe or a timelock is a contract
 * on one chain, and the same address on the other chain may hold nothing (or be someone else's), so
 * each chain names its own. The keeper is one key the ops keeper uses on both chains. The treasury
 * must be one plain account, the same owner on both chains (verify checks it has no code). */
export interface Roles {
  owner: Record<ChainName, Address>;
  guardian: Record<ChainName, Address>;
  keeper: Address;
  treasury: Address;
}

/** The test plan's roles: the test wallet in every one (the treasury is SETTINGS_V3's, also the test wallet). */
export const TEST_ROLES: Roles = {
  owner: { base: WALLET, bittensor: WALLET },
  guardian: { base: WALLET, bittensor: WALLET },
  keeper: WALLET,
  treasury: SETTINGS_V3.treasury,
};

/** Where a launch reads each role from (ops/.env, which the CLI loads, or the shell). */
export const ROLE_ENV = {
  ownerBase: "OPS_LAUNCH_OWNER_BASE",
  ownerBittensor: "OPS_LAUNCH_OWNER_BITTENSOR",
  guardianBase: "OPS_LAUNCH_GUARDIAN_BASE",
  guardianBittensor: "OPS_LAUNCH_GUARDIAN_BITTENSOR",
  keeper: "OPS_LAUNCH_KEEPER",
  treasury: "OPS_LAUNCH_TREASURY",
} as const;

const label = (chain: ChainName) => (chain === "base" ? "Base" : "Bittensor");
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

/** What is wrong with a set of roles, or nothing: the guardian is never an owner or the keeper, and the
 * keeper never an owner, on either chain; neither the owner nor the guardian is the test wallet (the
 * deployer's hot key, which the launch hands ownership away from). The keeper and the treasury may be
 * the test wallet. */
export function roleProblems(r: Roles): string[] {
  const out: string[] = [];
  const chains = ["base", "bittensor"] as const;
  for (const g of chains) {
    for (const o of chains) {
      if (same(r.guardian[g], r.owner[o])) out.push(`the guardian on ${label(g)} (${r.guardian[g]}) is also the owner on ${label(o)}`);
    }
  }
  for (const o of chains) if (same(r.keeper, r.owner[o])) out.push(`the keeper (${r.keeper}) is also the owner on ${label(o)}`);
  for (const g of chains) if (same(r.keeper, r.guardian[g])) out.push(`the keeper (${r.keeper}) is also the guardian on ${label(g)}`);
  for (const c of chains) {
    if (same(r.owner[c], WALLET)) out.push(`the owner on ${label(c)} is the test wallet ${WALLET}: a launch hands ownership away from the deployer's hot key`);
    if (same(r.guardian[c], WALLET)) out.push(`the guardian on ${label(c)} is the test wallet ${WALLET}: give the guardian its own key`);
  }
  return out;
}

/** A launch's roles from OPS_LAUNCH_OWNER_BASE, OPS_LAUNCH_OWNER_BITTENSOR, OPS_LAUNCH_GUARDIAN_BASE,
 * OPS_LAUNCH_GUARDIAN_BITTENSOR, OPS_LAUNCH_KEEPER and OPS_LAUNCH_TREASURY. Nothing defaults: every one
 * must be set to an address (checksummed, or all lower case), not the zero address, and the roles must
 * pass roleProblems. Throws naming every problem. */
export function launchRolesFromEnv(env: Env): Roles {
  const problems: string[] = [];
  const get = (name: string): Address => {
    const v = env[name]?.trim() ?? "";
    if (!v) problems.push(`${name} is not set`);
    else if (!isAddress(v, { strict: true })) problems.push(`${name} "${v}" is not an address (or its checksum is wrong)`);
    else if (getAddress(v) === zeroAddress) problems.push(`${name} is the zero address`);
    else return getAddress(v);
    return zeroAddress;
  };
  const roles: Roles = {
    owner: { base: get(ROLE_ENV.ownerBase), bittensor: get(ROLE_ENV.ownerBittensor) },
    guardian: { base: get(ROLE_ENV.guardianBase), bittensor: get(ROLE_ENV.guardianBittensor) },
    keeper: get(ROLE_ENV.keeper),
    treasury: get(ROLE_ENV.treasury),
  };
  if (!problems.length) problems.push(...roleProblems(roles));
  if (problems.length) throw new Error(`the launch's roles are not ready:\n  ${problems.join("\n  ")}\nnothing read or sent`);
  return roles;
}

/** Whether two sets of roles name the same accounts; the first difference, or null. */
export function rolesDiffer(a: Roles, b: Roles): string | null {
  for (const c of ["base", "bittensor"] as const) {
    if (!same(a.owner[c], b.owner[c])) return `the owner on ${label(c)} as ${a.owner[c]}, but the environment now says ${b.owner[c]}`;
    if (!same(a.guardian[c], b.guardian[c])) return `the guardian on ${label(c)} as ${a.guardian[c]}, but the environment now says ${b.guardian[c]}`;
  }
  if (!same(a.keeper, b.keeper)) return `the keeper as ${a.keeper}, but the environment now says ${b.keeper}`;
  if (!same(a.treasury, b.treasury)) return `the treasury as ${a.treasury}, but the environment now says ${b.treasury}`;
  return null;
}

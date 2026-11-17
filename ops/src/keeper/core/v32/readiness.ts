import { blake2b } from "@noble/hashes/blake2";
import { type Abi, type Address, bytesToHex, concat, getAddress, type Hex, hexToBytes, keccak256, parseAbi, stringToBytes } from "viem";
import { BIT_ADAPTER, ORACLE, POOL, STAKING, VAULT_LENS } from "../abi.ts";
import { chainLabel } from "../errors.ts";
import { adapterPairs } from "../deployment.ts";
import { KeeperNotReady } from "../failures.ts";
import type { KeeperMemory } from "../memory.ts";
import { vestingGapProblem } from "../rewards.ts";
import { claimFitNow } from "./claims.ts";
import type { KeeperDepsV32 } from "./reads.ts";

// The v3.2 keeper's readiness (design-keeper-worker.md §6, Task 46b's report §6): never the stored verify.ok, which a
// legitimate owner change can fail. Every round it checks, live, what must be true for it to send at all: keeper() names
// its key on the vault (through its lens) and on the front door, and each RPC is on the deployment's chain. The chain is
// the authority on who the keeper is (R4, D-M1): the owner's setKeeper on both contracts is the rotation (runbook 2.6, and
// 7.4 for a stolen key), so the key keeps running after one with no hand-edit of the record or of DEPLOYMENT, whose
// keeper stays the plan's first (shown by pnpm ops keeper status, never a gate). Once an hour it checks what holds for life (list B: the code of every contract, library
// and lens; every immutable and constant; the deployment's coldkey the vault's own; the staking flag the vault's
// constructor set; each oracle pool's fee and its observation slots; lastStakeAt within the vault's life; the adapter
// holding what its parks owe). A wrong value stops the keeper; a read that fails only fails the round ("try again",
// never "wrong"). A library's or a lens's balance is never checked: a forced balance changes nothing.

/** How often the for-life list is read again (an hour). */
export const FOR_LIFE_EVERY_MS = 3_600_000;


/** The substrate account Bittensor's EVM mirrors `address` to (the ADDRESS_MAPPING precompile's answer): blake2b-256 of
 * "evm:" and the address's 20 bytes, as plan.ts computes it (a test holds them equal). The vault's coldkey is its own
 * address's. */
export function addressMapping(address: Address): Hex {
  return bytesToHex(blake2b(concat([stringToBytes("evm:"), hexToBytes(getAddress(address))]), { dkLen: 32 }));
}

interface ReadinessMemory {
  /** When the for-life list last passed (ms) */
  forLifeAt?: number;
  /** What was last said of whether Bittensor's cap fits a claim (claims.ts claimFitNow) */
  claimFit?: string;
  /** R4: what was last said of whether rewards vest as slowly as the keeper claims (rewards.ts vestingGapProblem) */
  vesting?: string;
}

/** solc's CBOR metadata tail off `code` (its last two bytes are its length): what the for-life code hash is over, so
 * a metadata-only difference never fails. Undefined when there is no such tail. */
export function stripMetadata(code: Hex): Hex | undefined {
  const hex = code.slice(2).toLowerCase();
  const len = hex.length >= 4 ? Number.parseInt(hex.slice(-4), 16) : 0;
  const tail = (len + 2) * 2;
  const first = Number.parseInt(hex.slice(hex.length - tail, hex.length - tail + 2), 16);
  if (!len || tail > hex.length || (first & 0xe0) !== 0xa0) return undefined;
  return `0x${hex.slice(0, hex.length - tail)}`;
}

/** The code hash the for-life list holds a contract to: keccak256 of its runtime code without the metadata tail. */
export const codeHashOf = (code: Hex): Hex | undefined => {
  const c = stripMetadata(code);
  return c === undefined ? undefined : keccak256(c);
};

const same = (got: unknown, want: string, returns: string): boolean => {
  if (returns === "address" || returns === "bytes32") return String(got).toLowerCase() === want.toLowerCase();
  if (returns === "bool") return String(got) === want;
  return BigInt(got as bigint) === BigInt(want);
};

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** What must hold every round, read live: each problem (none: ready). */
export async function everyRoundProblems(deps: KeeperDepsV32): Promise<string[]> {
  const d = deps.deployment;
  const out: string[] = [];
  const ids = await deps.chainIds();
  for (const c of ["base", "bittensor"] as const) if (ids[c] !== d.chainIds[c]) out.push(`the ${chainLabel(c)} RPC reports chain id ${ids[c]}, not ${d.chainIds[c]}`);
  const k = await deps.readKeepers();
  if (k.vault.toLowerCase() !== deps.signer.toLowerCase()) out.push(`the vault's keeper() is ${k.vault}, not the keeper's key ${deps.signer} (a rotation not yet signed, or the key revoked)`);
  if (k.frontDoor.toLowerCase() !== deps.signer.toLowerCase()) out.push(`the front door's keeper() is ${k.frontDoor}, not the keeper's key ${deps.signer} (a rotation not yet signed, or the key revoked)`);
  return out;
}

/** Task 46b's list B, read live: each problem (none: all holds). Each check that fails has its own line. */
export async function forLifeProblems(deps: KeeperDepsV32): Promise<string[]> {
  const d = deps.deployment;
  const out: string[] = [];
  for (const v of d.forLife.values) {
    const abi = parseAbi([`function ${v.fn}() view returns (${v.returns})`]) as Abi;
    const got = await deps.readValue(v.chain, v.address, abi, v.fn);
    if (!same(got, v.want, v.returns)) out.push(`${chainLabel(v.chain)} ${v.contract}'s ${v.fn}() is ${String(got)}, not ${v.want}`);
  }
  for (const c of d.forLife.code) {
    const code = await deps.code(c.chain, c.address);
    const hash = code === "0x" ? undefined : codeHashOf(code);
    if (hash === undefined) out.push(`${chainLabel(c.chain)} ${c.contract} at ${c.address}: ${code === "0x" ? "no code" : "its code ends in no metadata tail"}`);
    else if (hash.toLowerCase() !== c.codeHash.toLowerCase()) out.push(`${chainLabel(c.chain)} ${c.contract} at ${c.address}: its code is not the frozen build's`);
  }
  // I-7: each Bittensor adapter (every pair the deployment lists, R4) holds at least what its parks owe, native and tokens
  for (const [i, pair] of adapterPairs(d).entries()) {
    const adapter = pair.bitAdapter;
    const named = i === 0 ? "the Bittensor adapter" : `the Bittensor adapter ${adapter}`;
    const parkedNative = (await deps.readValue("bittensor", adapter, BIT_ADAPTER, "parkedNative")) as bigint;
    const parkedTokens = (await deps.readValue("bittensor", adapter, BIT_ADAPTER, "parkedTokens")) as bigint;
    const native = await deps.balance("bittensor", adapter);
    if (native < parkedNative) out.push(`${named} holds ${native} wei of TAO, less than the ${parkedNative} its parks owe`);
    if (parkedTokens > 0n) {
      const token = (await deps.readValue("bittensor", adapter, BIT_ADAPTER, "token")) as Address;
      const held = (await deps.readValue("bittensor", token, ERC20, "balanceOf", [adapter])) as bigint;
      if (held < parkedTokens) out.push(`${named} holds ${held} of its token, less than the ${parkedTokens} its parks owe`);
    }
  }
  // the vault's coldkey is its address's mapping (the one its code holds), never only the deployment's word for it
  const coldkey = addressMapping(d.addresses.vault);
  if (d.vaultColdkey.toLowerCase() !== coldkey.toLowerCase()) {
    out.push(`the deployment's vaultColdkey ${d.vaultColdkey} is not the vault's coldkey ${coldkey}, the address mapping of ${d.addresses.vault}: the deployment was changed after it was built`);
  }
  // the vault's constructor sets it on its coldkey, and no contract code unsets it
  const rejects = await deps.readValue("bittensor", d.stakingPrecompile, STAKING, "getRejectStakingHotkeyGrowth", [coldkey]);
  if (rejects !== true) {
    out.push(`the staking precompile's getRejectStakingHotkeyGrowth(the vault's coldkey ${coldkey}) is ${String(rejects)}, not true: the vault's coldkey takes stake on hotkeys it never listed`);
  }
  // each oracle pool: its fee tier (immutable) as planned, and its observation slots in use (they only grow), at least the
  // oracle's own MIN_CARDINALITY (its constructor's precondition), read from the deployed oracle, never worked out from a
  // block time (Base's went from 2 s to 200 ms after the first oracle was built)
  let min: number | undefined;
  for (const p of d.forLife.pools) {
    min ??= Number(await deps.readValue("base", d.addresses.oracle, ORACLE, "MIN_CARDINALITY"));
    const fee = Number(await deps.readValue("base", p.address, POOL, "fee"));
    if (fee !== p.fee) out.push(`Base: the oracle's ${p.pair} pool ${p.address}'s fee() is ${fee}, not ${p.fee} as planned`);
    const slots = Number(((await deps.readValue("base", p.address, POOL, "slot0")) as readonly unknown[])[3]);
    if (!(slots >= min)) out.push(`Base: the oracle's ${p.pair} pool ${p.address} has ${slots} observation slots in use, fewer than the oracle's MIN_CARDINALITY ${min}`);
  }
  // lastStakeAt: the vault's creation time until its first stake, then a later stake's; never after the head
  const clock = await deps.stakeClock();
  if (clock.lastStakeAt < d.vaultCreatedAt) out.push(`Bittensor CascadeVaultLens's lastStakeAt() is ${clock.lastStakeAt}, before the vault's creation at ${d.vaultCreatedAt}`);
  else if (clock.lastStakeAt > clock.time) out.push(`Bittensor CascadeVaultLens's lastStakeAt() is ${clock.lastStakeAt}, after the head's time ${clock.time} (block ${clock.block})`);
  return out;
}

/** The round's readiness: the every-round checks, and the for-life list when an hour has passed since it last passed
 * (`now`, ms). Throws KeeperNotReady naming every problem (which stops the keeper); a read that fails is thrown as it
 * is (the round fails, and the next one reads again). */
export async function checkReadyV32(deps: KeeperDepsV32, memory: KeeperMemory, now: number): Promise<void> {
  const m = (memory.reads.readiness ??= {}) as ReadinessMemory;
  const problems = await everyRoundProblems(deps);
  const due = m.forLifeAt === undefined || now - m.forLifeAt >= FOR_LIFE_EVERY_MS;
  if (due && !problems.length) problems.push(...(await forLifeProblems(deps)));
  if (problems.length) throw new KeeperNotReady(`the v3.2 deployment ${deps.deployment.name} is not as it must be: ${problems.join("; ")}; nothing sent`);
  if (due) {
    // whether Bittensor's spend cap fits a claim (the founder's sizing): never a stop, said loudly when it changes; each
    // claim checks it again before it goes (claims.ts claimRoom)
    const fit = await claimFitNow(deps);
    if (fit !== m.claimFit) {
      if (fit) deps.log(`CLAIMS CAN'T FIT: ${fit}; until then no claim is sent`);
      else if (m.claimFit) deps.log("Claims fit again: Bittensor's 24 h spend cap holds a claim and a day of payouts and stakes");
      m.claimFit = fit;
    }
    // R4 (the vault-favour review's Medium 1): rewards vesting faster than the keeper claims them, never a stop, said once
    // while it lasts
    const vesting = vestingGapProblem(BigInt((await deps.readValue("bittensor", deps.deployment.addresses.vaultLens, VAULT_LENS, "rewardVesting")) as bigint));
    if (vesting !== m.vesting) {
      if (vesting) deps.log(`REWARDS VEST TOO FAST: ${vesting}`);
      m.vesting = vesting;
    }
    m.forLifeAt = now;
  }
}

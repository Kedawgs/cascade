import { type Address, encodeAbiParameters, formatEther, getAddress, type Hex, hashDomain } from "viem";
import { type ImmutableReferences, LIBRARY_DEPLOY_ADDRESS } from "../artifacts.ts";
import type { ChainName } from "../config.ts";
import { balanceOf, codeAt } from "../rpc.ts";
import { type Ctx, chainLabel, unit } from "../send.ts";
import { BUILDS_DIR, type BuildRefV32, type BuildV32, type FrozenContract, frozenContract, linkedLibraries, linkLibraries, loadBuildV32 } from "./build.ts";
import { addressMapping, CONTRACTS_V32, NONCE_PLAN, type PlannedStepV32, type PlanV32, plannedAddressesV32, type V32StepId } from "./plan.ts";

// v3.2's code read-back (spec §7 step 3, rev 12 M-1 and rev 13; plan Task 45): each contract's, library's and lens's
// runtime code on chain (eth_getCode) must be the frozen build's (build.ts, the copy the deploy sent its creates from),
// with every library link and every immutable filled in from the plan, never blanked. v3-launch's verify (verify.ts)
// blanks the immutables, so it would pass a contract wired to the wrong address; this one does not:
// - each immutable is filled, by the variable the frozen copy names for its AST id, as a 32-byte word in every one of
//   its places (the vault's coldkey has 8): the vault's coldkey is the ADDRESS_MAPPING of its planned address (plan.ts,
//   Task 43's derivation), each library's library_deploy_address its own planned address, each lens's target its
//   target's, every other one that holds a planned contract (the door's vault, the staker's front door, each adapter's
//   peer) that contract's planned address, each DOMAIN_SEPARATOR viem's hashDomain for its chain and its own address
//   (ruling DA13), and the rest the plan's constructor arguments;
// - the link set is the artifact's: a library it links that the plan does not name, or one the plan names that it does
//   not link, fails; every reference names the address the plan deploys that library at, and no library is named at
//   two addresses anywhere in the plan;
// - the comparison is byte for byte with the CBOR metadata stripped from both, so a metadata-only difference passes and
//   any other names the contract, the chain and the first differing byte;
// - every create of the plan is read, however its create settled (Task 44's review, M9), and each planned address is
//   re-derived from its deployer and nonce (plan.ts plannedAddressesV32), so a record edited to other addresses fails;
// - a library's or a lens's balance is information only (rev 12 L-4).

/** What the read-back reads of one contract: its frozen runtime code with its link and immutable references, the
 * variable each immutable is, and the libraries its creation code links. */
export type RuntimeArtifact = Pick<FrozenContract, "contract" | "bytecode" | "deployedBytecode" | "immutables">;

const nameOf = (fqn: string) => fqn.split(":")[1] ?? fqn;
const hexOf = (code: Hex) => code.slice(2).toLowerCase();

/** `code` without solc's CBOR metadata: the tail whose length is the code's last two bytes, which must be a CBOR map.
 * Refused when there is no such tail. */
export function stripMetadata(code: Hex): Hex {
  const hex = hexOf(code);
  const len = hex.length >= 4 ? Number.parseInt(hex.slice(-4), 16) : 0;
  const tail = (len + 2) * 2;
  const first = Number.parseInt(hex.slice(hex.length - tail, hex.length - tail + 2), 16);
  if (!len || tail > hex.length || (first & 0xe0) !== 0xa0) throw new Error("the code ends in no CBOR metadata tail");
  return `0x${hex.slice(0, hex.length - tail)}`;
}

/** `code` with each immutable in `refs` filled in: the key's variable (`names`), its planned 32-byte word (`values`, by
 * variable) in every one of its places, each of which must hold the build's zeros. Refused, never blanked, for a key
 * with no variable, a variable with no planned word, and a place that is not 32 zero bytes. */
export function fillImmutables(code: Hex, refs: ImmutableReferences, names: Record<string, string>, values: Record<string, Hex>): Hex {
  let hex = hexOf(code);
  for (const [key, ranges] of Object.entries(refs)) {
    const name = names[key];
    if (!name) throw new Error(`the code's immutable ${key} has no variable name; nothing filled (never blanked)`);
    const value = values[name];
    if (value === undefined) throw new Error(`no planned value for the immutable ${name}; nothing filled (never blanked)`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`the planned value of ${name} is not a 32-byte word (${value}); nothing filled`);
    for (const { start, length } of ranges) {
      const at = hex.slice(start * 2, (start + length) * 2);
      if (length !== 32 || !/^0{64}$/.test(at)) throw new Error(`byte ${start} of the code is not ${name}'s unfilled place (it holds ${at || "nothing"}); nothing filled`);
      hex = hex.slice(0, start * 2) + value.slice(2).toLowerCase() + hex.slice((start + length) * 2);
    }
  }
  return `0x${hex}`;
}

/** The variable each of `artifact`'s immutables is, by key, as its frozen copy names it (never contracts/out's).
 * Refused for a key it names no variable for: a copy frozen before Task 45 names none. */
export function immutableNamesOf(artifact: RuntimeArtifact): Record<string, string> {
  const names: Record<string, string> = {};
  for (const key of Object.keys(artifact.deployedBytecode.immutableReferences)) {
    const v = artifact.immutables?.[key];
    if (!v?.name) {
      throw new Error(
        `the frozen build names no variable for ${nameOf(artifact.contract)}'s immutable ${key} (a copy frozen before Task 45 names none): its code cannot be checked filled in; nothing read`,
      );
    }
    names[key] = v.name;
  }
  return names;
}

const fmt = (hex20: string) => (/^[0-9a-f]{40}$/.test(hex20) ? getAddress(`0x${hex20}`) : `"${hex20}"`);

/** What is wrong with `onchain`'s library links, as `planned` (path:Name -> address, the plan's links for this contract)
 * says they should be, each named: the link set is the artifact's (its runtime code's references, or for a library
 * only its constructor calls, its creation code's), so a library it links with no planned address is missing and a
 * planned one it does not link is unexpected; and each reference in the runtime code must name the planned address. */
export function linkFailures(artifact: RuntimeArtifact, onchain: Hex, planned: Record<string, Address>): string[] {
  const name = nameOf(artifact.contract);
  const runtime = artifact.deployedBytecode.linkReferences;
  const linked = new Set([...linkedLibraries(runtime), ...linkedLibraries(artifact.bytecode.linkReferences)]);
  const out: string[] = [];
  for (const lib of linkedLibraries(runtime)) if (!(lib in planned)) out.push(`${name} links ${nameOf(lib)}, but the plan names no address for it`);
  for (const lib of Object.keys(planned).sort()) if (!linked.has(lib)) out.push(`${name}: the plan links ${nameOf(lib)} into it, but its build has no reference to it`);
  const hex = hexOf(onchain);
  for (const [file, libs] of Object.entries(runtime)) {
    for (const [lib, offsets] of Object.entries(libs)) {
      const want = planned[`${file}:${lib}`];
      if (!want) continue;
      for (const { start, length } of offsets) {
        const at = hex.slice(start * 2, (start + length) * 2);
        if (at.length !== 40) out.push(`${name}'s code ends before its reference to ${lib} at byte ${start}`);
        else if (at !== getAddress(want).slice(2).toLowerCase()) out.push(`${name}'s reference to ${lib} at byte ${start} names ${fmt(at)}, not the plan's ${getAddress(want)}`);
      }
    }
  }
  return out;
}

/** The runtime code `artifact` leaves when deployed as planned: its frozen runtime code with its libraries linked at
 * `libs` (path:Name -> address; those its creation code alone links are left out) and its immutables filled with
 * `immutables` (a 32-byte word by variable). Refused, never blanked or left unlinked, when one is missing. */
export function expectedRuntime(artifact: RuntimeArtifact, libs: Record<string, Address>, immutables: Record<string, Hex>): Hex {
  const d = artifact.deployedBytecode;
  const wanted = linkedLibraries(d.linkReferences);
  const linked = linkLibraries(d.object, d.linkReferences, Object.fromEntries(Object.entries(libs).filter(([l]) => wanted.includes(l))));
  return fillImmutables(linked, d.immutableReferences, immutableNamesOf(artifact), immutables);
}

/** What byte `at` of `about`'s runtime code is, when it is an immutable's place or a link: " (the immutable coldkey)". */
function placeOf(about: RuntimeArtifact, at: number): string {
  const inside = (r: { start: number; length: number }) => at >= r.start && at < r.start + r.length;
  for (const [key, ranges] of Object.entries(about.deployedBytecode.immutableReferences)) {
    if (ranges.some(inside)) return ` (the immutable ${about.immutables?.[key]?.name ?? key})`;
  }
  for (const libs of Object.values(about.deployedBytecode.linkReferences)) {
    for (const [lib, offsets] of Object.entries(libs)) if (offsets.some(inside)) return ` (the reference to ${lib})`;
  }
  return "";
}

/** Why `onchain` is not `expected` (the frozen build's runtime code, filled in from the plan), compared byte for byte
 * with the CBOR metadata stripped from both: none for a metadata-only difference; otherwise the chain, the contract
 * and the first differing byte (with what is there, given `about`, the contract's artifact). */
export function codeFailures(chain: ChainName, contract: string, onchain: Hex, expected: Hex, about?: RuntimeArtifact): string[] {
  const who = `${chainLabel(chain)} ${contract}`;
  if (!onchain || onchain === "0x") return [`${who}: no code`];
  const want = hexOf(stripMetadata(expected));
  let got: string;
  try {
    got = hexOf(stripMetadata(onchain));
  } catch {
    return [`${who}: its runtime code ends in no CBOR metadata tail, so it is not this build's`];
  }
  if (got === want) return [];
  let i = 0;
  while (i < got.length && i < want.length && got[i] === want[i]) i++;
  const at = Math.floor(i / 2);
  const sizes = got.length === want.length ? "" : `; it is ${got.length / 2} bytes before its metadata, the build's ${want.length / 2}`;
  return [`${who}: its runtime code is not the frozen build's, filled in from the plan: they first differ at byte ${at}${about ? placeOf(about, at) : ""}${sizes}`];
}

// ---- the plan's values ----

const DOMAIN_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
} as const;

/** The owner stamp's EIP-712 domain separator of a scheduler contract (the vault, the front door) at `verifyingContract`
 * on chain `chainId`: viem's hashDomain over name "Cascade" and version "3.2", CascadeFormulas.domainSeparator's
 * (ruling DA13). */
export const domainSeparatorV32 = (chainId: number, verifyingContract: Address): Hex =>
  hashDomain({ domain: { name: "Cascade", version: "3.2", chainId: BigInt(chainId), verifyingContract }, types: DOMAIN_TYPES });

const stepOf = (plan: PlanV32, id: V32StepId): PlannedStepV32 => {
  const s = plan.steps.find((x) => x.id === id);
  if (!s) throw new Error(`the plan has no ${id}; nothing compared`);
  return s;
};

/** The step that deploys library (or contract) `fqn`, path:Name. */
const stepIdOf = (fqn: string): V32StepId | undefined => (Object.keys(CONTRACTS_V32) as V32StepId[]).find((id) => CONTRACTS_V32[id].contract === fqn);

/** Each immutable's planned value for step `id`, by variable, as its constructor sets it: the planned addresses of the
 * plan's own contracts (the vault, the front door, the adapters' peers, each lens's target, a library's own address),
 * the ADDRESS_MAPPING of the vault's planned address for both coldkeys, the stamp's domain separators for the step's
 * chain (`chainIds`, the chain the code runs on), and the plan's constructor arguments for the rest. */
export function immutableValuesV32(plan: PlanV32, id: V32StepId, chainIds: Record<ChainName, number>): Record<string, unknown> {
  const a = plan.addresses;
  const s = stepOf(plan, id);
  const p = (s.args[0] ?? {}) as Record<string, unknown>;
  const adapter = (remoteAdapter: Address) => ({
    router: p.router,
    token: p.token,
    localChainId: p.localChainId,
    remoteChainId: p.remoteChainId,
    remoteSelector: p.remoteSelector,
    remoteAdapter,
    gasBase: p.gasBase,
    gasPerEntry: p.gasPerEntry,
    maxMessageValue: p.maxMessageValue,
    treasury: p.treasury,
  });
  switch (id) {
    case "payoutMath":
    case "stakeLib":
    case "payoutLib":
    case "batchLib":
    case "hotkeyLib":
      return { [LIBRARY_DEPLOY_ADDRESS]: a[id] };
    case "vault":
      return { DOMAIN_SEPARATOR: domainSeparatorV32(chainIds[s.chain], a.vault), MS_PER_BLOCK: p.msPerBlock, coldkey: addressMapping(a.vault), launchChain: p.launchChain };
    case "vaultLens":
      return { target: a.vault, coldkey: addressMapping(a.vault) };
    case "doorLens":
      return { target: a.frontDoor };
    case "bitAdapter":
      return { ...adapter(a.baseAdapter), alphaVault: s.args[1], inboundGasBase: s.args[2], inboundGasPerEntry: s.args[3] };
    case "baseAdapter":
      return { ...adapter(a.bitAdapter), minSendAmount: s.args[1] };
    case "oracle": {
      const [taoWethPool, wethUsdcPool, tao, weth, usdc] = s.args;
      return { taoWethPool, wethUsdcPool, tao, weth, usdc };
    }
    case "frontDoor":
      return {
        DOMAIN_SEPARATOR: domainSeparatorV32(chainIds[s.chain], a.frontDoor),
        MS_PER_BLOCK: p.msPerBlock,
        asset: p.asset,
        vaultChain: p.vaultChain,
        vault: a.vault,
        usdc: p.usdc,
        treasury: p.treasury,
      };
    case "staker":
      return { usdc: p.usdc, tao: p.tao, frontDoor: a.frontDoor };
  }
}

/** The ABI type a 32-byte immutable word of solc's type `type` encodes as: a contract type is its address. */
function wordType(type: string): string {
  const t = type.startsWith("contract ") || type === "address payable" ? "address" : type;
  if (!/^(address|bool|bytes32|u?int(8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256))$/.test(t)) {
    throw new Error(`an immutable of type ${type}, which the code read-back cannot encode; nothing compared`);
  }
  return t;
}

/** The 32-byte word of each of `artifact`'s immutables, by variable, from `values` (immutableValuesV32), each encoded as
 * its declared type (an out-of-range value refused). Refused, never blanked, for an immutable the plan gives no value. */
export function immutableWordsV32(artifact: RuntimeArtifact, values: Record<string, unknown>): Record<string, Hex> {
  const names = immutableNamesOf(artifact);
  const out: Record<string, Hex> = {};
  for (const key of Object.keys(names)) {
    const v = artifact.immutables[key];
    const value = values[v.name];
    if (value === undefined || value === null) throw new Error(`the plan gives no value for ${nameOf(artifact.contract)}'s immutable ${v.name}; nothing compared (never blanked)`);
    out[v.name] = encodeAbiParameters([{ type: wordType(v.type) }], [value as never]);
  }
  return out;
}

/** Every library `artifact` links (its creation or runtime code), at the address the plan deploys it at. */
export function plannedLibrariesV32(plan: PlanV32, artifact: RuntimeArtifact): Record<string, Address> {
  const libs = new Set([...linkedLibraries(artifact.deployedBytecode.linkReferences), ...linkedLibraries(artifact.bytecode.linkReferences)]);
  const out: Record<string, Address> = {};
  for (const lib of [...libs].sort()) {
    const id = stepIdOf(lib);
    if (!id) throw new Error(`${nameOf(artifact.contract)} links ${lib}, which the plan does not deploy; nothing compared`);
    out[lib] = plan.addresses[id];
  }
  return out;
}

/** Each library the plan names at more than one address: where it deploys it, and every contract that links it (each
 * step's `libraries`). The build's own graph shares no library between two linkers (the vault links L1 to L4, L3 the
 * payout math), so this is the plan's "the vault's and L3's references to L2 name one address" as the build needs it:
 * every reference to one library, anywhere, names the one address it is deployed at. */
export function linkAgreementFailures(plan: PlanV32): string[] {
  const named = new Map<string, { who: string; at: Address }[]>();
  for (const s of plan.steps) {
    for (const [lib, at] of Object.entries(s.libraries ?? {})) {
      if (!named.has(lib)) {
        const id = stepIdOf(lib);
        named.set(lib, id ? [{ who: "the plan deploys it", at: plan.addresses[id] }] : []);
      }
      named.get(lib)!.push({ who: `${nameOf(s.contract)} links it`, at });
    }
  }
  const out: string[] = [];
  for (const [lib, names] of named) {
    if (!stepIdOf(lib)) {
      out.push(`${nameOf(lib)} is linked (${names.map((n) => n.who.replace(" links it", "")).join(", ")}), but the plan deploys no ${nameOf(lib)}`);
      continue;
    }
    if (new Set(names.map((n) => n.at.toLowerCase())).size === 1) continue;
    const parts = names.map((n) => `${n.who} at ${getAddress(n.at)}`);
    out.push(`${nameOf(lib)} is named at more than one address: ${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`);
  }
  return out;
}

/** Step `id`'s runtime code as the plan deploys it from the frozen `build`, on chains of `chainIds`: linked with each
 * library at its planned address, every immutable filled in (immutableValuesV32), by the names the frozen copy holds. */
export function expectedRuntimeV32(build: BuildV32, plan: PlanV32, id: V32StepId, chainIds: Record<ChainName, number>): Hex {
  const c = frozenContract(build, stepOf(plan, id));
  return expectedRuntime(c, plannedLibrariesV32(plan, c), immutableWordsV32(c, immutableValuesV32(plan, id, chainIds)));
}

const HOLDS_NOTHING: readonly V32StepId[] = ["payoutMath", "stakeLib", "payoutLib", "batchLib", "hotkeyLib", "vaultLens", "doorLens"];

const CHAINS = ["bittensor", "base"] as const;

/** Whether `s` is a step of the nonce plan on its chain: the read-back reads only those. */
const inNoncePlan = (s: PlannedStepV32): boolean => CHAINS.some((c) => c === s.chain && (NONCE_PLAN[c] as readonly string[]).includes(s.id));

/** The record's steps against NONCE_PLAN (Task 45's re-review, N2): each chain's steps are exactly the nonce plan's,
 * once each. A step deleted from the record (its contract then never read), a second step for one contract, and a step
 * on a chain the nonce plan does not put it on each fail, naming the contract. */
export function stepSetFailures(plan: PlanV32): string[] {
  const out: string[] = [];
  const contractName = (id: string) => (id in CONTRACTS_V32 ? nameOf(CONTRACTS_V32[id as V32StepId].contract) : `the step "${id}"`);
  for (const chain of CHAINS) {
    const planned = NONCE_PLAN[chain] as readonly string[];
    const ids = plan.steps.filter((s) => s.chain === chain).map((s) => s.id as string);
    for (const id of [...new Set(ids)]) {
      if (!planned.includes(id)) out.push(`${chainLabel(chain)} ${contractName(id)}: the record has a step for it on ${chainLabel(chain)}, which the nonce plan does not, so its code is not read there`);
      else {
        const n = ids.filter((x) => x === id).length;
        if (n > 1) out.push(`${chainLabel(chain)} ${contractName(id)}: the record has ${n} steps for it; the nonce plan has one`);
      }
    }
    planned.forEach((id, nonce) => {
      if (!ids.includes(id)) out.push(`${chainLabel(chain)} ${contractName(id)}: the record has no step for it (the nonce plan's nonce ${nonce}), so its code is not read`);
    });
  }
  return out;
}

/** Spec §7 step 3's code read-back of a v3.2 deployment (`pnpm ops verify` runs it, Task 46): every create of the nonce
 * plan, whatever the record says of it (done, settled from pending, or not recorded: Task 44's review, M9), and a step
 * the record lacks, doubles or moves fails (N2); its address re-derived from its deployer and nonce, read at its
 * planned address and compared with the record's frozen build (`buildsDir`, ops/builds/), linked and filled in from
 * the plan for the chains `ctx` reads (their ids make the domain separators), never contracts/out. The failures name
 * the chain, the contract and what differs; `info` holds what is reported only (a library's or a lens's balance).
 * Refused, nothing read, when the frozen build is missing, is not the record's, or names no variable for an immutable,
 * and when the plan gives an immutable no value. */
export async function codeReadBacksV32(
  ctx: Pick<Ctx, "rpc" | "targets">,
  rec: { plan: PlanV32; build: BuildRefV32 },
  buildsDir: string = BUILDS_DIR,
): Promise<{ failures: string[]; info: string[] }> {
  const plan = rec.plan;
  const build = loadBuildV32(rec.build, buildsDir);
  const chainIds = { base: ctx.targets.base.chainId, bittensor: ctx.targets.bittensor.chainId };
  // everything the comparison needs, before anything is read (each expected code's metadata tail included), for each
  // step of the nonce plan once; stepSetFailures names a step missing, doubled or out of the plan (N2)
  const steps = plan.steps.filter((s, i) => inNoncePlan(s) && plan.steps.findIndex((x) => x.id === s.id && x.chain === s.chain) === i);
  const checks = steps.map((s) => {
    const c = frozenContract(build, s);
    const expected = expectedRuntimeV32(build, plan, s.id, chainIds);
    try {
      stripMetadata(expected);
    } catch {
      throw new Error(`the frozen build's ${nameOf(c.contract)} ends in no CBOR metadata tail, so it cannot be compared with its metadata stripped; nothing read`);
    }
    return { s, c, expected };
  });
  const failures = [...linkAgreementFailures(plan), ...stepSetFailures(plan)];
  const info: string[] = [];
  // Task 45's review, M4: the record's addresses are the nonce plan's, from its deployers (Task 43's derivation)
  const derived = plannedAddressesV32(plan.deployers);
  for (const { s, c, expected } of checks) {
    const at = plan.addresses[s.id];
    const name = nameOf(c.contract);
    const nonce = (NONCE_PLAN[s.chain] as readonly V32StepId[]).indexOf(s.id);
    if (s.nonce !== nonce) failures.push(`${chainLabel(s.chain)} ${name}: the record plans it at nonce ${s.nonce}, not the nonce plan's ${nonce}`);
    if (at.toLowerCase() !== derived[s.id].toLowerCase()) {
      failures.push(`${chainLabel(s.chain)} ${name}: the record puts it at ${at}, but the ${chainLabel(s.chain)} deployer ${getAddress(plan.deployers[s.chain])} creates ${derived[s.id]} at its nonce ${nonce}`);
    }
    const onchain = await codeAt(ctx.rpc, s.chain, at);
    if (!onchain || onchain === "0x") {
      failures.push(`${chainLabel(s.chain)} ${name}: no code at ${at}, where the plan puts it`);
    } else {
      failures.push(...linkFailures(c, onchain, s.libraries ?? {}).map((f) => `${chainLabel(s.chain)} ${f}`));
      failures.push(...codeFailures(s.chain, name, onchain, expected, c));
    }
    if (HOLDS_NOTHING.includes(s.id)) {
      const held = await balanceOf(ctx.rpc, s.chain, at);
      if (held > 0n) {
        info.push(`${chainLabel(s.chain)} ${name} at ${at} holds ${formatEther(held)} ${unit(s.chain)}: information only (a library or a lens holds nothing by design; a forced balance changes nothing)`);
      }
    }
  }
  return { failures, info };
}

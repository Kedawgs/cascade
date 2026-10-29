import { basename } from "node:path";
import { type Abi, type Address, decodeEventLog, type Hex, isAddress, parseAbi, zeroAddress } from "viem";
import { type Artifact, loadArtifact, maskImmutables } from "./artifacts.ts";
import { codeFor } from "./builds.ts";
import { cardinalityChecks } from "./cardinality.ts";
import { BASE_V3, type ChainName, FRONT_DOOR_DEFAULTS, LIVE, PRECOMPILE, SETTINGS, V2_DEPLOYMENT, WALLET } from "./config.ts";
import { buildOf, cadenceOf, isPlanV3, type Plan, type PlanV3, ROUTE_0, rolesOf, settingsOf, settingsV3Of, vaultLimitsOf } from "./plan.ts";
import {
  type Findings,
  guardianChecks,
  NO_ALLOW,
  type RegistryScan,
  registryChecks,
  scanRegistry,
  stateWarnings,
  type VerifyAllow,
} from "./registry.ts";
import { type DeploymentRecord, loadRecord, sameDeployment, saveRecord, type VerifyResult } from "./record.ts";
import { balanceOf, codeAt, read } from "./rpc.ts";
import { scanLogs, startBlock } from "./keeper/state.ts";
import { type Ctx, chainLabel } from "./send.ts";

export type { VerifyResult } from "./record.ts";

export interface Expectation {
  chain: ChainName;
  contract: string;
  address: Address;
  /** The name failures use, e.g. "routes(0).buyPath". */
  field: string;
  /** The view to call, when it is not `field`. */
  fn?: string;
  args?: readonly unknown[];
  /** The position of the value in a view that returns several. */
  pick?: number;
  expected: unknown;
}

export const keyOf = (e: Pick<Expectation, "chain" | "contract" | "field">) => `${e.chain}:${e.contract}.${e.field}`;

const whole = (x: unknown): x is bigint | number => typeof x === "bigint" || (typeof x === "number" && Number.isInteger(x));

/** Addresses and bytes without regard to case; integers by value (viem reads small uints as numbers). */
const same = (a: unknown, b: unknown) => {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (whole(a) && whole(b)) return BigInt(a) === BigInt(b);
  return a === b;
};

const ROUTE_FIELDS = ["kind", "router", "buyPath", "sellPath", "active"] as const;

/** Every setting the spec's read-back lists, from the plan; a v3 plan adds the staker, the oracle, the
 * front door's delivery settings and the vault's reward cut. The guardians, keepers and treasury are the
 * plan's roles (the test wallet in a test plan). A launch plan's owners are left to ownershipChecks: the
 * test wallet until the final owner accepts, then the final owner. */
export function expectations(plan: Plan | PlanV3): Expectation[] {
  const a = plan.addresses;
  const s = settingsOf(plan);
  const roles = rolesOf(plan);
  const launch = cadenceOf(plan) === "launch";
  const owner = (chain: ChainName) => (launch ? {} : { owner: roles.owner[chain] });
  const out: Expectation[] = [];
  const add = (chain: ChainName, contract: string, address: Address, fields: Record<string, unknown>) => {
    for (const [field, expected] of Object.entries(fields)) out.push({ chain, contract, address, field, expected });
  };
  const adapter = (local: "base" | "bittensor", remoteAdapter: Address, gas: { base: bigint; perEntry: bigint }) => {
    const remote = local === "base" ? LIVE.bittensor : LIVE.base;
    return {
      router: LIVE[local].ROUTER,
      token: LIVE[local].TOKEN,
      localChainId: BigInt(LIVE[local].CHAIN_ID),
      remoteChainId: BigInt(remote.CHAIN_ID),
      remoteSelector: remote.SELECTOR,
      remoteAdapter,
      gasBase: gas.base,
      gasPerEntry: gas.perEntry,
    };
  };
  add("base", "CcipBaseAdapter", a.baseAdapter, {
    ...adapter("base", a.bitAdapter, s.baseGas),
    minSendAmount: s.minSendAmount,
  });
  add("bittensor", "CcipBittensorAdapter", a.bitAdapter, {
    ...adapter("bittensor", a.baseAdapter, s.bitGas),
    alphaVault: LIVE.ALPHA_VAULT,
  });
  add("base", "CascadeFrontDoor", a.frontDoor, {
    vault: a.vault,
    vaultChain: BigInt(LIVE.bittensor.CHAIN_ID),
    primaryBridge: a.baseAdapter,
    asset: LIVE.base.TOKEN,
    ...owner("base"),
    guardian: roles.guardian.base,
    batchInterval: BigInt(s.batchInterval),
    minDeposit: s.minDeposit,
    depositCap: s.depositCap,
    redeemRequestFee: s.redeemRequestFee,
  });
  add("bittensor", "CascadeVault", a.vault, {
    stakeHotkey: s.hotkey,
    primaryBridge: a.bitAdapter,
    ...owner("bittensor"),
    guardian: roles.guardian.bittensor,
    keeper: roles.keeper,
    payoutDelay: BigInt(s.payoutDelay),
  });
  if (!isPlanV3(plan)) return out;

  const v = settingsV3Of(plan);
  const a3 = plan.addresses;
  add("base", "CascadeFrontDoor", a3.frontDoor, {
    usdc: BASE_V3.USDC,
    keeper: roles.keeper,
    swapper: a3.staker,
    oracle: a3.oracle,
    maxDeliverySlippageBps: v.maxDeliverySlippageBps,
    maxBatchValue: v.maxBatchValue,
  });
  add("base", "CascadeStaker", a3.staker, {
    usdc: BASE_V3.USDC,
    tao: LIVE.base.TOKEN,
    frontDoor: a3.frontDoor,
    ...owner("base"),
    treasury: roles.treasury,
    swapFeeBps: v.swapFeeBps,
    depositFeeUsdc: v.depositFeeUsdc,
  });
  ROUTE_FIELDS.forEach((name, pick) =>
    out.push({ chain: "base", contract: "CascadeStaker", address: a3.staker, field: `routes(0).${name}`, fn: "routes", args: [0], pick, expected: ROUTE_0[name] }),
  );
  add("base", "CascadeStaker", a3.staker, { deliveryRouteId: v.deliveryRouteId });
  add("base", "CascadeTwapOracle", a3.oracle, {
    taoWethPool: BASE_V3.TAO_WETH_POOL,
    wethUsdcPool: BASE_V3.WETH_USDC_POOL,
    tao: LIVE.base.TOKEN,
    weth: BASE_V3.WETH,
    usdc: BASE_V3.USDC,
  });
  add("bittensor", "CascadeVault", a3.vault, { treasury: roles.treasury, rewardCutBps: v.rewardCutBps });
  return out;
}

/** The limits in force on a v3 deployment: every vault limit (the contract's defaults, unless the plan
 * sets them), the direct-deposit minimum, and the front door's batch limits. Beyond `expectations`, which
 * holds the wiring and the settings the spec's read-back lists. */
export function limitExpectations(plan: Plan | PlanV3): Expectation[] {
  if (!isPlanV3(plan)) return [];
  const a = plan.addresses;
  const out: Expectation[] = [];
  const add = (chain: ChainName, contract: string, address: Address, fields: Record<string, unknown>) => {
    for (const [field, expected] of Object.entries(fields)) out.push({ chain, contract, address, field, expected });
  };
  add("bittensor", "CascadeVault", a.vault, { ...vaultLimitsOf(plan), minDirectDeposit: settingsV3Of(plan).minDirectDeposit });
  add("base", "CascadeFrontDoor", a.frontDoor, { ...FRONT_DOOR_DEFAULTS });
  return out;
}

const OWNABLE = parseAbi(["function owner() view returns (address)", "function pendingOwner() view returns (address)"]);

/** The contracts with an owner (Ownable2Step): the front door, the staker and the vault. The oracle and
 * the adapters have none. */
export const ownedContracts = (plan: PlanV3): [ChainName, string, Address][] => [
  ["base", "CascadeFrontDoor", plan.addresses.frontDoor],
  ["base", "CascadeStaker", plan.addresses.staker],
  ["bittensor", "CascadeVault", plan.addresses.vault],
];

/** A launch's owners: each contract's ownership either accepted by its chain's final owner (nothing
 * pending), or offered to it and not yet accepted (the test wallet still the owner): a warning, since
 * the final owner accepts in its own time. Anything else fails. The final owner may be a contract (a
 * Safe or a timelock): no code is read. A test plan's owners are in its expectations; here it must have
 * no pending owner. */
export async function ownershipChecks(ctx: Pick<Ctx, "rpc">, plan: PlanV3): Promise<{ failures: string[]; warnings: string[] }> {
  const failures: string[] = [];
  const warnings: string[] = [];
  if (cadenceOf(plan) !== "launch") {
    for (const [chain, name, address] of ownedContracts(plan)) {
      const pending = (await read(ctx.rpc, chain, { address, abi: OWNABLE, functionName: "pendingOwner" })) as Address;
      if (!same(pending, zeroAddress)) failures.push(`${chainLabel(chain)} ${name}: pendingOwner is ${pending}: an ownership transfer the plan doesn't make`);
    }
    return { failures, warnings };
  }
  const roles = rolesOf(plan);
  for (const [chain, name, address] of ownedContracts(plan)) {
    const final = roles.owner[chain];
    const owner = (await read(ctx.rpc, chain, { address, abi: OWNABLE, functionName: "owner" })) as Address;
    const pending = (await read(ctx.rpc, chain, { address, abi: OWNABLE, functionName: "pendingOwner" })) as Address;
    const where = `${chainLabel(chain)} ${name}`;
    if (same(owner, final) && same(pending, zeroAddress)) continue;
    if (same(owner, WALLET) && same(pending, final)) {
      warnings.push(`${where}: ownership offered to ${final} and not accepted yet (the owner is still the deployer ${WALLET}): accept it with the files from pnpm ops handoff`);
      continue;
    }
    failures.push(`${where}: owner ${owner}, pendingOwner ${pending}; the plan hands it to ${final}`);
  }
  return { failures, warnings };
}

/** Reads each expectation's view into a map by `keyOf`, calling a view once per address and arguments.
 * A failed read is kept as "unreadable (…)", so it shows as a mismatch instead of stopping the check. */
export async function readBack(
  ctx: Pick<Ctx, "rpc">,
  exp: Expectation[],
  abiOf: (contract: string) => { abi: Abi },
): Promise<Map<string, unknown>> {
  const calls = new Map<string, Promise<unknown>>();
  const actual = new Map<string, unknown>();
  for (const e of exp) {
    const fn = e.fn ?? e.field;
    const id = `${e.chain}:${e.address}:${fn}(${(e.args ?? []).map(String).join(",")})`;
    try {
      let call = calls.get(id);
      if (!call) {
        call = read(ctx.rpc, e.chain, { address: e.address, abi: abiOf(e.contract).abi, functionName: fn, args: e.args });
        calls.set(id, call);
      }
      const value = await call;
      actual.set(keyOf(e), e.pick === undefined ? value : (value as readonly unknown[])[e.pick]);
    } catch (err) {
      actual.set(keyOf(e), `unreadable (${(err as Error).message.split("\n")[0]})`);
    }
  }
  return actual;
}

/** The treasury holds csTAO on Bittensor and redeems it through the front door on Base, so its address
 * must be the same owner on both chains: a plain account, never a contract (whose address on the other
 * chain could belong to someone else). */
export function treasuryCodeFailures(treasury: Address, code: Record<ChainName, Hex>): string[] {
  return (["base", "bittensor"] as const)
    .filter((c) => code[c] !== "0x")
    .map((c) => `${chainLabel(c)} treasury ${treasury}: has contract code; the treasury must be a plain account, the same owner on Base and Bittensor`);
}

const readAt = (actual: Map<string, unknown>, chain: ChainName, contract: string, field: string) => actual.get(keyOf({ chain, contract, field }));
const anAddress = (x: unknown): x is Address => typeof x === "string" && isAddress(x, { strict: false });

/** v3's cross-checks on the read-back: the front door's USDC is not its asset, and no treasury is one of
 * Cascade's own contracts. */
export function v3AddressFailures(plan: PlanV3, actual: Map<string, unknown>): string[] {
  const a = plan.addresses;
  const out: string[] = [];
  const usdc = readAt(actual, "base", "CascadeFrontDoor", "usdc");
  if (anAddress(usdc) && same(usdc, readAt(actual, "base", "CascadeFrontDoor", "asset"))) {
    out.push(`Base CascadeFrontDoor.usdc: ${usdc} is the same as its asset`);
  }
  const staker = readAt(actual, "base", "CascadeStaker", "treasury");
  if (anAddress(staker) && [a.staker, a.frontDoor].some((c) => same(c, staker))) {
    out.push(`Base CascadeStaker.treasury: ${staker} is the staker or the front door; the treasury must be an account, not a Cascade contract`);
  }
  const vault = readAt(actual, "bittensor", "CascadeVault", "treasury");
  if (anAddress(vault) && [a.vault, a.frontDoor, a.staker].some((c) => same(c, vault))) {
    out.push(`Bittensor CascadeVault.treasury: ${vault} is the vault, the front door or the staker; the treasury must be an account, not a Cascade contract`);
  }
  return out;
}

export function compare(expected: Expectation[], actual: Map<string, unknown>): string[] {
  return expected
    .filter((e) => !same(e.expected, actual.get(keyOf(e))))
    .map((e) => `${chainLabel(e.chain)} ${e.contract}.${e.field}: expected ${e.expected}, found ${actual.get(keyOf(e))}`);
}

export function codeMismatch(
  chain: ChainName,
  contract: string,
  onchain: Hex,
  artifact: Pick<Artifact, "deployedBytecode" | "immutableRanges">,
): string | null {
  const want = maskImmutables(artifact.deployedBytecode, artifact.immutableRanges).toLowerCase();
  const got = maskImmutables(onchain, artifact.immutableRanges).toLowerCase();
  return want === got ? null : `${chainLabel(chain)} ${contract}: deployed code differs from the build`;
}

const ACTIVATED = parseAbi(["event FrontDoorActivated(uint64 indexed chain, address indexed addr)"]);

export function frontDoorActivationFailures(logs: { address: Address; topics: Hex[]; data: Hex }[], plan: Plan | PlanV3): string[] {
  const hits = logs
    .filter((l) => same(l.address, plan.addresses.vault))
    .flatMap((l) => {
      try {
        return [decodeEventLog({ abi: ACTIVATED, topics: l.topics as [Hex, ...Hex[]], data: l.data }).args];
      } catch {
        return [];
      }
    });
  const ok = hits.length === 1 && hits[0].chain === BigInt(LIVE.base.CHAIN_ID) && same(hits[0].addr, plan.addresses.frontDoor);
  return ok ? [] : [`Bittensor CascadeVault: expected exactly one FrontDoorActivated(8453, front door) at deploy, found ${hits.length}`];
}

/** The vault's FrontDoorActivated logs: from its creation receipt, or (a recovered creation, whose
 * transaction was never recorded) from its logs, which only its constructor can have emitted. */
export async function activationLogs(ctx: Ctx, rec: DeploymentRecord): Promise<{ address: Address; topics: Hex[]; data: Hex }[]> {
  const created = rec.done.vault;
  if (created && "hash" in created) {
    const r = (await ctx.rpc.request("bittensor", "eth_getTransactionReceipt", [created.hash])) as {
      logs: { address: Address; topics: Hex[]; data: Hex }[];
    };
    return r.logs;
  }
  const ev = ACTIVATED[0];
  const logs = await scanLogs(ctx, "bittensor", rec.plan.addresses.vault, ev, startBlock(rec));
  return logs.map((l) => l.raw);
}

/** Balances read 500 rao (5e11 wei) below what was sent. */
export function reserveFailures(adapterBalance: bigint, vaultBalance: bigint): string[] {
  const out: string[] = [];
  const ed = 5n * 10n ** 11n;
  if (adapterBalance < SETTINGS.adapterReserve - ed) out.push(`Bittensor CcipBittensorAdapter: reserve reads ${adapterBalance} wei, expected at least ${SETTINGS.adapterReserve - ed}`);
  if (vaultBalance < SETTINGS.vaultReserve - ed) out.push(`Bittensor CascadeVault: reserve reads ${vaultBalance} wei, expected at least ${SETTINGS.vaultReserve - ed}`);
  return out;
}

const VAULT_EXTRA = parseAbi([
  "function coldkey() view returns (bytes32)",
  "function peerId(uint64 chain, address addr) pure returns (bytes32)",
  "function frontDoorActive(bytes32) view returns (bool)",
  "function addressMapping(address addr) view returns (bytes32)",
]);

export const V2_VERIFY_REFUSED = "v2 contracts were verified at deploy; the build has since moved to v3";

/** A v2 record (its plan, or the v2 record's file) is never read back again: its contracts no longer
 * match the build, so the code comparison would fail, and a failed read-back saved into the record
 * would stop v2's keeper close, stake and payouts during the wind-down. */
export function refuseV2Verify(path: string, rec: DeploymentRecord): void {
  if (!isPlanV3(rec.plan) || basename(path) === `${V2_DEPLOYMENT}.json`) throw new Error(V2_VERIFY_REFUSED);
}

/** Reads everything back on both chains and compares it with the plan; saves nothing itself. Each
 * contract's code is compared with the build the plan was deployed from (see builds.ts). Refuses a v2
 * plan, or a plan from a build this tool does not know, before reading anything. */
export async function verify(ctx: Ctx, rec: DeploymentRecord, opts: { allow?: VerifyAllow } = {}): Promise<VerifyResult> {
  const plan = rec.plan;
  if (!isPlanV3(plan)) throw new Error(V2_VERIFY_REFUSED);
  buildOf(plan);
  const exp = [...expectations(plan), ...limitExpectations(plan)];
  const artifacts = new Map<string, Artifact>();
  const art = (name: string) => artifacts.get(name) ?? artifacts.set(name, loadArtifact(ctx.paths.contractsDir, name)).get(name)!;
  const actual = await readBack(ctx, exp, art);
  const failures = compare(exp, actual);

  const warnings: string[] = [];
  /** A check whose reads fail is a failure that says so, as an unreadable expectation is. */
  const findings = async (label: string, check: () => Promise<Findings>) => {
    try {
      const f = await check();
      failures.push(...f.failures);
      warnings.push(...f.warnings);
    } catch (e) {
      failures.push(`${label}: could not be read (${(e as Error).message.split("\n")[0]})`);
    }
  };
  let registryScan: RegistryScan | undefined;
  if (isPlanV3(plan)) {
    failures.push(...v3AddressFailures(plan, actual));
    const allow = opts.allow ?? NO_ALLOW;
    await findings("the owners", () => ownershipChecks(ctx, plan));
    await findings("the guardian proposals", () => guardianChecks(ctx, plan, allow));
    await findings("the bridge, front-door and route registries", async () => {
      registryScan = await scanRegistry(ctx, rec, rec.verify?.registryScan);
      return registryChecks(ctx, plan, registryScan, allow);
    });
    await findings("the pause and hotkey state", async () => ({ failures: [], warnings: await stateWarnings(ctx, plan) }));
    await findings("the oracle's pools", () => cardinalityChecks(ctx, plan));
    const treasuries = new Map<string, Address>();
    for (const t of [rolesOf(plan).treasury, readAt(actual, "base", "CascadeStaker", "treasury"), readAt(actual, "bittensor", "CascadeVault", "treasury")]) {
      if (anAddress(t)) treasuries.set(t.toLowerCase(), t);
    }
    for (const t of treasuries.values()) {
      failures.push(...treasuryCodeFailures(t, { base: await codeAt(ctx.rpc, "base", t), bittensor: await codeAt(ctx.rpc, "bittensor", t) }));
    }
  }

  const v = plan.addresses.vault;
  const coldkey = await read(ctx.rpc, "bittensor", { address: v, abi: VAULT_EXTRA, functionName: "coldkey" });
  const mapped = await read(ctx.rpc, "bittensor", { address: PRECOMPILE.addressMapping, abi: VAULT_EXTRA, functionName: "addressMapping", args: [v] });
  if (!same(coldkey, mapped)) failures.push(`Bittensor CascadeVault.coldkey: expected ${mapped}, found ${coldkey}`);
  const chain = actual.get(keyOf({ chain: "bittensor", contract: "CcipBittensorAdapter", field: "remoteChainId" }));
  const peer = await read(ctx.rpc, "bittensor", { address: v, abi: VAULT_EXTRA, functionName: "peerId", args: [chain, plan.addresses.frontDoor] });
  if ((await read(ctx.rpc, "bittensor", { address: v, abi: VAULT_EXTRA, functionName: "frontDoorActive", args: [peer] })) !== true) {
    failures.push("Bittensor CascadeVault: the front door is not active under the adapter's remote chain id");
  }

  failures.push(...frontDoorActivationFailures(await activationLogs(ctx, rec), plan));

  failures.push(
    ...reserveFailures(await balanceOf(ctx.rpc, "bittensor", plan.addresses.bitAdapter), await balanceOf(ctx.rpc, "bittensor", v)),
  );

  const contracts: [ChainName, string, Address][] = [
    ["base", "CcipBaseAdapter", plan.addresses.baseAdapter],
    ["base", "CascadeFrontDoor", plan.addresses.frontDoor],
    ["bittensor", "CcipBittensorAdapter", plan.addresses.bitAdapter],
    ["bittensor", "CascadeVault", v],
    ...(isPlanV3(plan)
      ? ([
          ["base", "CascadeTwapOracle", plan.addresses.oracle],
          ["base", "CascadeStaker", plan.addresses.staker],
        ] as [ChainName, string, Address][])
      : []),
  ];
  for (const [c, name, addr] of contracts) {
    const m = codeMismatch(c, name, await codeAt(ctx.rpc, c, addr), codeFor(plan, name, art));
    if (m) failures.push(m);
  }
  return {
    ok: failures.length === 0,
    failures,
    ...(warnings.length ? { warnings } : {}),
    checkedAt: new Date().toISOString(),
    ...(registryScan ? { registryScan } : {}),
  };
}

/** Reads everything back and saves the result into the record at `path`; a v2 record is refused before
 * anything is read or written. The read-back is slow, and a running keeper may save the record meanwhile,
 * so only `verify` is set in the record as it is on disk after it, and never in another deployment's. */
export async function verifyAndSave(ctx: Ctx, path: string, rec: DeploymentRecord, opts: { allow?: VerifyAllow } = {}): Promise<boolean> {
  refuseV2Verify(path, rec);
  rec.verify = await verify(ctx, rec, opts);
  const now = loadRecord(path);
  if (now && !sameDeployment(now, rec)) throw new Error(`${path} now holds another deployment; the read-back was not saved`);
  saveRecord(path, now ? { ...now, verify: rec.verify } : rec);
  if (rec.verify.ok) ctx.log("Read-back check: everything matches the plan");
  else ctx.log(`Read-back check FAILED:\n  ${rec.verify.failures.join("\n  ")}`);
  if (rec.verify.warnings?.length) ctx.log(`Warnings (not failures):\n  ${rec.verify.warnings.join("\n  ")}`);
  return rec.verify.ok;
}

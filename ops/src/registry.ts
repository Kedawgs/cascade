import { type Address, encodeAbiParameters, encodeEventTopics, getAddress, type Hex, hexToBigInt, isAddress, keccak256, numberToHex, parseAbi } from "viem";
import { type ChainName, type Env, LIVE } from "./config.ts";
import { startBlock, windowOf } from "./keeper/state.ts";
import type { PlanV3 } from "./plan.ts";
import type { DeploymentRecord } from "./record.ts";
import { firstBlockWithCode, read } from "./rpc.ts";
import { type Ctx, chainLabel, logsOf } from "./send.ts";

/** What verify may find beyond the plan without failing: addresses (a bridge, a front door, a guardian
 * the owner proposed or enabled on purpose) and staker routes by id. From OPS_VERIFY_ALLOW, e.g.
 * "0xStandbyAdapter, route:1". Pending proposals stay warnings either way. */
export interface VerifyAllow {
  addresses: Set<string>;
  routes: Set<number>;
}

export const NO_ALLOW: VerifyAllow = { addresses: new Set(), routes: new Set() };

export function verifyAllowFromEnv(env: Env): VerifyAllow {
  const out: VerifyAllow = { addresses: new Set(), routes: new Set() };
  for (const token of (env.OPS_VERIFY_ALLOW ?? "").split(/[\s,]+/).filter(Boolean)) {
    const route = token.match(/^route:(\d+)$/);
    if (route && Number(route[1]) <= 255) out.routes.add(Number(route[1]));
    else if (isAddress(token, { strict: false })) out.addresses.add(token.toLowerCase());
    else throw new Error(`OPS_VERIFY_ALLOW: "${token}" is neither an address nor route:<id> (0-255)`);
  }
  return out;
}

/** The events that change a registry: bridges (CascadeBase, on the front door and the vault), the vault's
 * front doors, and the staker's routes. */
export const REGISTRY_EVENTS = [
  "event BridgeProposed(address indexed bridge, uint64 readyAt)",
  "event BridgeActivated(address indexed bridge)",
  "event BridgeProposalCancelled(address indexed bridge)",
  "event BridgeDisabled(address indexed bridge)",
  "event FrontDoorProposed(uint64 indexed chain, address indexed addr, uint64 readyAt)",
  "event FrontDoorActivated(uint64 indexed chain, address indexed addr)",
  "event FrontDoorProposalCancelled(uint64 indexed chain, address indexed addr)",
  "event FrontDoorRemoved(uint64 indexed chain, address indexed addr)",
  "event RouteSet(uint8 indexed id, uint8 kind, address router, bytes buyPath, bytes sellPath, bool active)",
] as const;
const EVENTS = parseAbi(REGISTRY_EVENTS);
const topic = (name: string) => encodeEventTopics({ abi: EVENTS, eventName: name } as never)[0] as Hex;
const BRIDGE_TOPICS = ["BridgeProposed", "BridgeActivated", "BridgeProposalCancelled", "BridgeDisabled"].map(topic);
const FRONT_DOOR_TOPICS = ["FrontDoorProposed", "FrontDoorActivated", "FrontDoorProposalCancelled", "FrontDoorRemoved"].map(topic);
const ROUTE_TOPIC = topic("RouteSet");

/** Every bridge, front door and route the deployment's contracts have ever logged, up to `to` on each
 * chain: the candidates whose state verify reads (the mappings themselves can't be listed). Kept in the
 * saved read-back, so each verify scans only the blocks since the last. */
export interface RegistryScan {
  base: { to: number; bridges: Address[]; routes: number[] };
  bittensor: { to: number; bridges: Address[]; frontDoors: string[] };
}

/** Logs this close to the head are read again by the next scan, so one a lagging node or a reorg hid is
 * found then (the keeper's margins). */
const SETTLE: Record<ChainName, number> = { base: 30, bittensor: 10 };

/** The first block of the deployment on Base: its earliest Base step with a recorded block, else (every
 * Base step recovered) the block the Base adapter's code first appears in. */
export function baseStartBlock(rec: DeploymentRecord): number | undefined {
  const blocks = rec.plan.steps
    .filter((s) => s.chain === "base")
    .map((s) => rec.done[s.id])
    .flatMap((d) => (d && "block" in d && d.block !== undefined ? [d.block] : []));
  return blocks.length ? Math.min(...blocks) : undefined;
}

type RawLog = { address: Address; topics: Hex[] };

const firstLine = (e: unknown) => (e as Error).message.split("\n")[0];

/** `addresses`' logs with any of `topics` as topic0, from `from` to the head, in the logs server's windows
 * (Base: OPS_BASE_LOGS_RPC and its window); the head from the same server. A query that fails stops the
 * scan there: what came before it is kept, `to` stops short of it, and `error` says where and why, so the
 * next scan resumes from it. */
async function scan(
  ctx: Pick<Ctx, "rpc" | "logs" | "logsWindow">,
  chain: ChainName,
  addresses: Address[],
  topics: Hex[],
  from: number,
): Promise<{ logs: RawLog[]; to: number; error?: string; errorFrom?: number }> {
  const rpc = logsOf(ctx);
  const logs: RawLog[] = [];
  let head: number;
  try {
    head = Number(hexToBigInt((await rpc.request(chain, "eth_blockNumber", [])) as Hex));
  } catch (e) {
    return { logs, to: from - 1, error: `from block ${from} (${firstLine(e)})`, errorFrom: from };
  }
  const settled = head - SETTLE[chain];
  const step = Number(windowOf(ctx, chain));
  for (let start = from; start <= head; start += step) {
    const end = Math.min(start + step - 1, head);
    try {
      logs.push(...((await rpc.request(chain, "eth_getLogs", [{ address: addresses, fromBlock: numberToHex(start), toBlock: numberToHex(end), topics: [topics] }])) as RawLog[]));
    } catch (e) {
      return { logs, to: Math.max(from - 1, Math.min(start - 1, settled)), error: `from block ${start} (${firstLine(e)})`, errorFrom: start };
    }
  }
  return { logs, to: Math.max(from - 1, settled) };
}

const addressTopic = (t: Hex): Address => getAddress(`0x${t.slice(-40)}`);
const union = <T>(a: readonly T[], b: readonly T[]) => [...new Set([...a, ...b])];

/** A stretch of a chain's registry events the scan couldn't read, from block `from` (unknown when even
 * the deployment's first block couldn't be found), and what to say of it. */
export interface Gap {
  chain: ChainName;
  from?: number;
  line: string;
}

/** A gap younger than the registry delay stays unchecked: nothing proposed in it can be active yet. Once
 * it began more than REGISTRY_DELAY ago (dated by its first block, else by the record's creation), a
 * bridge or front door proposed in it could be active now, unseen: a failure. One that can't be dated
 * stays unchecked. */
export async function gapFindings(ctx: Pick<Ctx, "rpc">, rec: DeploymentRecord, gaps: Gap[]): Promise<{ failures: string[]; unchecked: string[] }> {
  const out = { failures: [] as string[], unchecked: [] as string[] };
  const time = async (chain: ChainName, block: number | "latest") =>
    Number(hexToBigInt(((await ctx.rpc.request(chain, "eth_getBlockByNumber", [block === "latest" ? block : numberToHex(block), false])) as { timestamp: Hex }).timestamp));
  for (const g of gaps) {
    let age: number;
    try {
      const now = await time(g.chain, "latest");
      age = now - (g.from === undefined ? Math.floor(Date.parse(rec.createdAt) / 1000) : await time(g.chain, g.from));
    } catch {
      out.unchecked.push(g.line);
      continue;
    }
    if (!Number.isFinite(age) || age <= Number(REGISTRY_DELAY)) {
      out.unchecked.push(g.line);
      continue;
    }
    const logs = g.chain === "base" ? "OPS_BASE_LOGS_RPC" : "OPS_BITTENSOR_RPC";
    out.failures.push(
      `${g.line}; the gap began ${Math.floor(age / 86_400)} days ago, beyond the 7-day registry delay, so a bridge or front door proposed in it could be active now: point ${logs} at a server that serves those logs and run verify again`,
    );
  }
  return out;
}

/** No candidates beyond the plan's own: what the registry checks read when no scan has ever finished. */
export const NO_CANDIDATES: RegistryScan = { base: { to: -1, bridges: [], routes: [] }, bittensor: { to: -1, bridges: [], frontDoors: [] } };

/** Scans the front door's and the staker's registry events on Base, and the vault's on Bittensor, from
 * where `prev` settled (else the deployment's first block on each chain; `to` -1 means not started).
 * What it could not read is in `unchecked`, never thrown: the scan keeps what came before and the next
 * one resumes from the gap. */
export async function scanRegistry(
  ctx: Pick<Ctx, "rpc" | "logs" | "logsWindow">,
  rec: DeploymentRecord,
  prev?: RegistryScan,
): Promise<{ scan: RegistryScan; unchecked: Gap[] }> {
  const plan = rec.plan as PlanV3;
  const a = plan.addresses;
  const was = prev ?? NO_CANDIDATES;
  const unchecked: Gap[] = [];
  const empty = (to: number) => ({ logs: [] as RawLog[], to });

  let base = empty(was.base.to);
  try {
    const from = was.base.to >= 0 ? was.base.to + 1 : (baseStartBlock(rec) ?? (await firstBlockWithCode(ctx.rpc, "base", a.baseAdapter)));
    const s = await scan(ctx, "base", [a.frontDoor, a.staker], [...BRIDGE_TOPICS, ROUTE_TOPIC], from);
    base = s;
    if (s.error) {
      unchecked.push({
        chain: "base",
        from: s.errorFrom,
        line: `Base: the front door's and the staker's registry events ${s.error} couldn't be read, so bridges and routes proposed or enabled since then are NOT checked; the next verify resumes there. OPS_BASE_LOGS_RPC must serve eth_getLogs that far back`,
      });
    }
  } catch (e) {
    unchecked.push({ chain: "base", line: `Base: where the deployment starts couldn't be found (${firstLine(e)}), so its bridges and routes beyond the plan's are NOT checked` });
  }

  let bit = empty(was.bittensor.to);
  try {
    const from = was.bittensor.to >= 0 ? was.bittensor.to + 1 : Number(startBlock(rec));
    const s = await scan(ctx, "bittensor", [a.vault], [...BRIDGE_TOPICS, ...FRONT_DOOR_TOPICS], from);
    bit = s;
    if (s.error) {
      unchecked.push({
        chain: "bittensor",
        from: s.errorFrom,
        line: `Bittensor: the vault's registry events ${s.error} couldn't be read, so bridges and front doors proposed or enabled since then are NOT checked; the next verify resumes there`,
      });
    }
  } catch (e) {
    unchecked.push({ chain: "bittensor", line: `Bittensor: where the deployment starts couldn't be found (${firstLine(e)}), so its bridges and front doors beyond the plan's are NOT checked` });
  }

  const ours = (l: RawLog, x: Address) => l.address.toLowerCase() === x.toLowerCase();
  const bridgesIn = (logs: RawLog[], at: Address) => logs.filter((l) => ours(l, at) && BRIDGE_TOPICS.includes(l.topics[0])).map((l) => addressTopic(l.topics[1]));
  return {
    scan: {
      base: {
        to: base.to,
        bridges: union(was.base.bridges, bridgesIn(base.logs, a.frontDoor)),
        routes: union(was.base.routes, base.logs.filter((l) => ours(l, a.staker) && l.topics[0] === ROUTE_TOPIC).map((l) => Number(hexToBigInt(l.topics[1])))).sort((x, y) => x - y),
      },
      bittensor: {
        to: bit.to,
        bridges: union(was.bittensor.bridges, bridgesIn(bit.logs, a.vault)),
        frontDoors: union(
          was.bittensor.frontDoors,
          bit.logs.filter((l) => ours(l, a.vault) && FRONT_DOOR_TOPICS.includes(l.topics[0])).map((l) => `${hexToBigInt(l.topics[1])}:${addressTopic(l.topics[2])}`),
        ),
      },
    },
    unchecked,
  };
}

export type Findings = { failures: string[]; warnings: string[] };

const VIEWS = parseAbi([
  "function bridgeEnabled(address) view returns (bool)",
  "function bridgeProposedAt(address) view returns (uint64)",
  "function frontDoorActive(bytes32) view returns (bool)",
  "function frontDoorProposedAt(bytes32) view returns (uint64)",
  "function routes(uint8 id) view returns (uint8 kind, address router, bytes buyPath, bytes sellPath, bool active)",
  "function pendingGuardian() view returns (address)",
  "function guardianProposedAt() view returns (uint64)",
  "function paused() view returns (bool)",
  "function hotkeyCount() view returns (uint256)",
]);
/** CascadeBase's REGISTRY_DELAY and GUARDIAN_DELAY. */
const REGISTRY_DELAY = 7n * 86_400n;
const GUARDIAN_DELAY = 8n * 86_400n;
const iso = (s: bigint) => new Date(Number(s) * 1000).toISOString();
const NOT_EXPECTED = ", and nobody expects it (if meant, add it to OPS_VERIFY_ALLOW)";

const peerId = (chain: bigint, addr: Address) => keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [chain, addr]));

/** The registries against the plan: each contract's own bridge still enabled; any other bridge, front
 * door or staker route that is enabled or active fails unless allowed (then a warning); any pending
 * proposal is a warning, and a failure too unless allowed. Reads the current state of every candidate
 * the scan found. */
export async function registryChecks(
  ctx: Pick<Ctx, "rpc">,
  plan: PlanV3,
  scan: RegistryScan,
  allow: VerifyAllow,
): Promise<Findings & { unchecked: string[] }> {
  const a = plan.addresses;
  const out = { failures: [] as string[], warnings: [] as string[], unchecked: [] as string[] };
  const v = (chain: ChainName, address: Address, functionName: string, args: unknown[] = []) => read(ctx.rpc, chain, { address, abi: VIEWS, functionName, args });
  const allowed = (x: string) => allow.addresses.has(x.toLowerCase());
  const pending = (what: string, x: string, at: string) => {
    out.warnings.push(`${what} is proposed, ready to activate from ${at}`);
    if (!allowed(x)) out.failures.push(`${what} is proposed, ready to activate from ${at}${NOT_EXPECTED}`);
  };
  /** Each candidate is read on its own: an extra one found before whose state can't be read fails (it was
   * there, and nothing says it's gone); the plan's own bridge, unread, is unchecked. */
  const each = async (extra: boolean, what: string, check: () => Promise<void>) => {
    try {
      await check();
    } catch (e) {
      (extra ? out.failures : out.unchecked).push(`${what} (${firstLine(e)})`);
    }
  };

  for (const [chain, name, at, own, found] of [
    ["base", "CascadeFrontDoor", a.frontDoor, a.baseAdapter, scan.base.bridges],
    ["bittensor", "CascadeVault", a.vault, a.bitAdapter, scan.bittensor.bridges],
  ] as const) {
    const where = `${chainLabel(chain)} ${name}`;
    for (const bridge of union([own as Address], found).filter((x, i, all) => all.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i)) {
      const mine = bridge.toLowerCase() === own.toLowerCase();
      const unread = mine ? `${where}: couldn't read the state of the plan's bridge ${bridge}` : `${where}: couldn't read the state of the extra bridge ${bridge} it found before`;
      await each(!mine, unread, async () => {
        const enabled = (await v(chain, at, "bridgeEnabled", [bridge])) as boolean;
        const proposedAt = (await v(chain, at, "bridgeProposedAt", [bridge])) as bigint;
        if (mine && !enabled) out.failures.push(`${where}: the plan's bridge ${bridge} is disabled`);
        if (!mine && enabled) {
          if (allowed(bridge)) out.warnings.push(`${where}: an extra bridge ${bridge} is enabled (allowed by OPS_VERIFY_ALLOW)`);
          else out.failures.push(`${where}: an extra bridge ${bridge} is enabled, beyond the plan's (if meant, add it to OPS_VERIFY_ALLOW)`);
        }
        if (proposedAt !== 0n) pending(`${where}: bridge ${bridge}`, bridge, iso(proposedAt + REGISTRY_DELAY));
      });
    }
  }

  const planned = `${LIVE.base.CHAIN_ID}:${a.frontDoor}`.toLowerCase();
  for (const fd of scan.bittensor.frontDoors) {
    if (fd.toLowerCase() === planned) continue;
    const [c, addr] = fd.split(":") as [string, Address];
    const id = peerId(BigInt(c), addr);
    const what = `Bittensor CascadeVault: front door (chain ${c}, ${addr})`;
    await each(true, `${what}: couldn't read the state of this front door it found before`, async () => {
      const active = (await v("bittensor", a.vault, "frontDoorActive", [id])) as boolean;
      const proposedAt = (await v("bittensor", a.vault, "frontDoorProposedAt", [id])) as bigint;
      if (active) {
        if (allowed(addr)) out.warnings.push(`Bittensor CascadeVault: another front door (chain ${c}, ${addr}) is active (allowed by OPS_VERIFY_ALLOW)`);
        else out.failures.push(`Bittensor CascadeVault: another front door (chain ${c}, ${addr}) is active, beyond the plan's (if meant, add it to OPS_VERIFY_ALLOW)`);
      }
      if (proposedAt !== 0n) pending(what, addr, iso(proposedAt + REGISTRY_DELAY));
    });
  }

  for (const id of scan.base.routes.filter((r) => r !== 0)) {
    await each(true, `Base CascadeStaker: couldn't read the state of route ${id} it found before`, async () => {
      const active = ((await v("base", a.staker, "routes", [id])) as readonly unknown[])[4] as boolean;
      if (!active) return;
      if (allow.routes.has(id)) out.warnings.push(`Base CascadeStaker: route ${id} is active (allowed by OPS_VERIFY_ALLOW)`);
      else out.failures.push(`Base CascadeStaker: route ${id} is active beyond the plan's route 0 (if meant, add route:${id} to OPS_VERIFY_ALLOW)`);
    });
  }
  return out;
}

/** A guardian proposal on the front door or the vault: a warning, and a failure unless the proposed
 * guardian is allowed. (The current guardians are in the expectations.) */
export async function guardianChecks(ctx: Pick<Ctx, "rpc">, plan: PlanV3, allow: VerifyAllow): Promise<Findings> {
  const out: Findings = { failures: [], warnings: [] };
  for (const [chain, name, address] of [
    ["base", "CascadeFrontDoor", plan.addresses.frontDoor],
    ["bittensor", "CascadeVault", plan.addresses.vault],
  ] as const) {
    const proposedAt = (await read(ctx.rpc, chain, { address, abi: VIEWS, functionName: "guardianProposedAt" })) as bigint;
    if (proposedAt === 0n) continue;
    const g = (await read(ctx.rpc, chain, { address, abi: VIEWS, functionName: "pendingGuardian" })) as Address;
    const line = `${chainLabel(chain)} ${name}: guardian ${g} is proposed, acceptable from ${iso(proposedAt + GUARDIAN_DELAY)}`;
    out.warnings.push(line);
    if (!allow.addresses.has(g.toLowerCase())) out.failures.push(`${line}${NOT_EXPECTED}`);
  }
  return out;
}

/** Worth knowing, never a failure: a paused front door or vault (the guardian's call), and a hotkey set
 * beyond the plan's one (an addHotkey, which only widens what the price reads). */
export async function stateWarnings(ctx: Pick<Ctx, "rpc">, plan: PlanV3): Promise<string[]> {
  const out: string[] = [];
  const a = plan.addresses;
  if ((await read(ctx.rpc, "base", { address: a.frontDoor, abi: VIEWS, functionName: "paused" })) as boolean) out.push("Base CascadeFrontDoor is paused");
  if ((await read(ctx.rpc, "bittensor", { address: a.vault, abi: VIEWS, functionName: "paused" })) as boolean) out.push("Bittensor CascadeVault is paused");
  const hotkeys = (await read(ctx.rpc, "bittensor", { address: a.vault, abi: VIEWS, functionName: "hotkeyCount" })) as bigint;
  if (hotkeys !== 1n) out.push(`Bittensor CascadeVault reads ${hotkeys} hotkeys (the plan stakes with one)`);
  return out;
}

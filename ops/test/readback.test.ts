import { readFileSync } from "node:fs";
import { type Address, encodeAbiParameters, encodeEventTopics, getAddress, type Hex, keccak256, numberToHex, parseAbi, parseUnits, toFunctionSelector, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { loadArtifact } from "../src/artifacts.ts";
import { type ChainName, FRONT_DOOR_DEFAULTS, paths, SETTINGS_V3, VAULT_DEFAULTS } from "../src/config.ts";
import { buildPlan, buildPlanV3, type PlanV3 } from "../src/plan.ts";
import { type DeploymentRecord, uncheckedLines } from "../src/record.ts";
import {
  baseStartBlock,
  gapFindings,
  guardianChecks,
  REGISTRY_EVENTS,
  type RegistryScan,
  registryChecks,
  scanRegistry,
  stateWarnings,
  verifyAllowFromEnv,
} from "../src/registry.ts";
import { limitExpectations, ownershipChecks } from "../src/verify.ts";
import { COLDKEY, fakeChain, v3Record } from "./fake-keeper.ts";

const E18 = 10n ** 18n;
const vaultSource = readFileSync(new URL("../../contracts/src/CascadeVault.sol", import.meta.url), "utf8");
const frontDoorSource = readFileSync(new URL("../../contracts/src/CascadeFrontDoor.sol", import.meta.url), "utf8");
/** A Solidity literal's value: 2_000e18, 0.02e18, 1_000_000. */
const literal = (s: string) => {
  const t = s.replaceAll("_", "");
  const m = t.match(/^([\d.]+)e(\d+)$/);
  return m ? parseUnits(m[1], Number(m[2])) : BigInt(t);
};
const solDefault = (name: string) => {
  const m = vaultSource.match(new RegExp(`public ${name} = ([\\d_.e]+);`));
  if (!m) throw new Error(`no default for ${name}`);
  return literal(m[1]);
};

describe("the read-back's limits", () => {
  it("copies the vault's and the front door's defaults from their source", () => {
    for (const [name, value] of Object.entries(VAULT_DEFAULTS)) {
      if (name === "unstakeMarginRao") {
        expect(vaultSource).toMatch(/uint256 public unstakeMarginRao;/);
        expect(value).toBe(0n);
        continue;
      }
      expect(BigInt(value), name).toBe(solDefault(name));
    }
    expect(frontDoorSource).toMatch(new RegExp(`maxDeposits = ${FRONT_DOOR_DEFAULTS.maxDeposits};`));
    expect(frontDoorSource).toMatch(new RegExp(`maxRedeems = ${FRONT_DOOR_DEFAULTS.maxRedeems};`));
  });

  it("reads back every vault limit, the direct-deposit minimum and the front door's batch limits", () => {
    const plan = buildPlanV3(0, 40, COLDKEY);
    const exp = limitExpectations(plan);
    const at = (c: string, f: string) => exp.find((e) => e.contract === c && e.field === f)?.expected;
    expect(exp.map((e) => `${e.contract}.${e.field}`)).toEqual([
      ...Object.keys(VAULT_DEFAULTS).map((k) => `CascadeVault.${k}`),
      "CascadeVault.minDirectDeposit",
      "CascadeFrontDoor.maxDeposits",
      "CascadeFrontDoor.maxRedeems",
    ]);
    expect(at("CascadeVault", "minDailyOutflow")).toBe(100n * E18);
    expect(at("CascadeVault", "maxMessageValue")).toBe(4_000n * E18);
    expect(at("CascadeVault", "minDirectDeposit")).toBe(SETTINGS_V3.minDirectDeposit);
    expect(at("CascadeFrontDoor", "maxDeposits")).toBe(50);
    // every field is a view of the build
    const views = (n: string) => loadArtifact(paths({}).contractsDir, n).abi.filter((i) => i.type === "function").map((i) => (i as { name: string }).name);
    for (const e of exp) expect(views(e.contract), e.field).toContain(e.field);
    expect(limitExpectations(buildPlan(0, 0, COLDKEY))).toEqual([]);
  });
});

describe("OPS_VERIFY_ALLOW", () => {
  const ADDR = getAddress("0x00000000000000000000000000000000000000e1");
  it("names addresses (bridges, front doors, guardians) and staker routes verify may find beyond the plan", () => {
    const allow = verifyAllowFromEnv({ OPS_VERIFY_ALLOW: ` ${ADDR.toLowerCase()}, route:3 ` });
    expect([...allow.addresses]).toEqual([ADDR.toLowerCase()]);
    expect([...allow.routes]).toEqual([3]);
    expect(verifyAllowFromEnv({})).toEqual({ addresses: new Set(), routes: new Set() });
  });

  it("refuses anything else", () => {
    for (const bad of ["0x12", "route:x", "route:256", "bridge"]) {
      expect(() => verifyAllowFromEnv({ OPS_VERIFY_ALLOW: bad }), bad).toThrow(/OPS_VERIFY_ALLOW/);
    }
  });
});

const plan = buildPlanV3(4, 9, COLDKEY);
const a = plan.addresses;
const OTHER = getAddress("0x00000000000000000000000000000000000000e1");
const OTHER2 = getAddress("0x00000000000000000000000000000000000000e2");
const EVENTS = parseAbi(REGISTRY_EVENTS);
type Log = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash: Hex };
const log = (address: Address, block: number, eventName: string, args: Record<string, unknown>): Log => ({
  address,
  topics: encodeEventTopics({ abi: EVENTS, eventName, args } as never) as Hex[],
  data: "0x",
  blockNumber: numberToHex(block),
  logIndex: "0x0",
  transactionHash: `0x${"ab".repeat(32)}`,
});

/** Chains holding `logs`, at `head`; each eth_getLogs query is kept. */
function logChain(logs: Partial<Record<ChainName, Log[]>>, head: Record<ChainName, number>) {
  const queries: { chain: ChainName; from: number; to: number; address: Address[] }[] = [];
  const f = fakeChain([], {}, {
    eth_blockNumber: (chain) => numberToHex(head[chain]),
    eth_getLogs: (chain, p) => {
      const q = p[0] as { address: Address[]; fromBlock: Hex; toBlock: Hex; topics: [Hex[]] };
      const from = Number(q.fromBlock);
      const to = Number(q.toBlock);
      queries.push({ chain, from, to, address: q.address });
      return (logs[chain] ?? []).filter(
        (l) => q.address.some((x) => x.toLowerCase() === l.address.toLowerCase()) && q.topics[0].includes(l.topics[0]) && Number(l.blockNumber) >= from && Number(l.blockNumber) <= to,
      );
    },
  });
  return { ctx: f.ctx, queries };
}

/** A record with Base steps at blocks 1000.. and the Bittensor adapter at 500. */
const rec: DeploymentRecord = {
  ...v3Record("live", plan),
  done: Object.fromEntries(plan.steps.map((s, i) => [s.id, { hash: `0x${"cd".repeat(32)}` as Hex, block: s.chain === "base" ? 1_000 + i : 500 + i, gasUsed: 1n, costWei: 1n }])),
};

describe("the registry scan finds every bridge, front door and route the contracts ever logged", () => {
  it("scans Base from the deployment's first Base block and Bittensor from the adapter's, in the RPCs' windows", async () => {
    const c = logChain(
      {
        base: [
          log(a.frontDoor, 1_050, "BridgeProposed", { bridge: OTHER }),
          log(a.frontDoor, 1_150, "BridgeActivated", { bridge: OTHER }),
          log(a.staker, 1_160, "RouteSet", { id: 2 }),
          log(a.staker, 1_005, "RouteSet", { id: 0 }),
          // another contract's events are not the deployment's
          log(OTHER2, 1_100, "BridgeProposed", { bridge: OTHER2 }),
        ],
        bittensor: [
          log(a.vault, 900, "BridgeDisabled", { bridge: a.bitAdapter }),
          log(a.vault, 1_200, "FrontDoorProposed", { chain: 8453n, addr: OTHER2 }),
        ],
      },
      { base: 1_250, bittensor: 2_100 },
    );
    expect(baseStartBlock(rec)).toBe(1_000);
    const { scan, unchecked } = await scanRegistry(c.ctx, rec);
    expect(unchecked).toEqual([]);
    expect(scan).toEqual({
      base: { to: 1_220, bridges: [OTHER], routes: [0, 2] },
      bittensor: { to: 2_090, bridges: [a.bitAdapter], frontDoors: [`8453:${OTHER2}`] },
    });
    const base = c.queries.filter((q) => q.chain === "base");
    expect(base.map((q) => [q.from, q.to])).toEqual([
      [1_000, 1_099],
      [1_100, 1_199],
      [1_200, 1_250],
    ]);
    expect(base[0].address).toEqual([a.frontDoor, a.staker]);
    // the Bittensor adapter is the plan's 12th step: block 511
    expect(c.queries.filter((q) => q.chain === "bittensor").map((q) => [q.from, q.to])).toEqual([
      [511, 1_510],
      [1_511, 2_100],
    ]);
  });

  it("a later scan starts where the last one settled and keeps what it found", async () => {
    const c = logChain({ base: [log(a.frontDoor, 1_230, "BridgeProposed", { bridge: OTHER2 })] }, { base: 1_300, bittensor: 2_100 });
    const prev: RegistryScan = { base: { to: 1_220, bridges: [OTHER], routes: [0] }, bittensor: { to: 2_090, bridges: [], frontDoors: [] } };
    const { scan } = await scanRegistry(c.ctx, rec, prev);
    expect(scan.base).toEqual({ to: 1_270, bridges: [OTHER, OTHER2], routes: [0] });
    expect(c.queries.map((q) => [q.chain, q.from, q.to])).toEqual([
      ["base", 1_221, 1_300],
      ["bittensor", 2_091, 2_100],
    ]);
  });

  it("a query the logs server refuses stops the scan there: what came before is kept, and it says what isn't checked", async () => {
    const c = logChain({ base: [log(a.frontDoor, 1_050, "BridgeProposed", { bridge: OTHER })] }, { base: 1_250, bittensor: 2_100 });
    const request = c.ctx.rpc.request;
    const refusing = {
      request: (chain: ChainName, m: string, p: unknown[]) =>
        chain === "base" && m === "eth_getLogs" && Number((p[0] as { fromBlock: Hex }).fromBlock) >= 1_100 ? Promise.reject(new Error("archive requests need a token")) : request(chain, m, p),
    };
    const { scan, unchecked } = await scanRegistry({ ...c.ctx, rpc: refusing }, rec);
    // the first window's bridge is kept; the next scan resumes at the refused window
    expect(scan.base).toEqual({ to: 1_099, bridges: [OTHER], routes: [] });
    expect(unchecked).toEqual([
      {
        chain: "base",
        from: 1_100,
        line: "Base: the front door's and the staker's registry events from block 1100 (archive requests need a token) couldn't be read, so bridges and routes proposed or enabled since then are NOT checked; the next verify resumes there. OPS_BASE_LOGS_RPC must serve eth_getLogs that far back",
      },
    ]);
    // Bittensor still scanned in full
    expect(scan.bittensor.to).toBe(2_090);
  });

  it("asks the logs server for its own window: one query where the public window takes three", async () => {
    const c = logChain({}, { base: 1_250, bittensor: 2_100 });
    await scanRegistry({ ...c.ctx, logsWindow: { base: 10_000n } }, rec);
    expect(c.queries.filter((q) => q.chain === "base").map((q) => [q.from, q.to])).toEqual([[1_000, 1_250]]);
  });

  it("the topics are the build's own events", () => {
    const dir = paths({}).contractsDir;
    const built = (n: string) => loadArtifact(dir, n).abi.filter((i) => i.type === "event");
    for (const e of EVENTS) {
      const owner = e.name.startsWith("Route") ? "CascadeStaker" : e.name.startsWith("FrontDoor") ? "CascadeVault" : "CascadeFrontDoor";
      const match = built(owner).find((b) => (b as { name: string }).name === e.name);
      expect(match, e.name).toBeDefined();
      expect(encodeEventTopics({ abi: [match!] as never, eventName: e.name } as never)[0], e.name).toBe(encodeEventTopics({ abi: [e], eventName: e.name } as never)[0]);
    }
  });
});

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
  "function pendingOwner() view returns (address)",
]);

interface World {
  enabled?: Record<string, boolean>;
  proposed?: Record<string, bigint>;
  peersActive?: string[];
  peersProposed?: string[];
  activeRoutes?: number[];
  guardian?: Partial<Record<ChainName, Address>>;
  paused?: Partial<Record<ChainName, boolean>>;
  hotkeys?: bigint;
  pendingOwner?: Address;
}
/** Contract state for the checks; `k(chain, address)` keys. */
const k = (chain: ChainName, x: string) => `${chain}:${x.toLowerCase()}`;
const peerKey = (chain: bigint, addr: Address) => `${chain}:${addr.toLowerCase()}`;
function stateChain(w: World) {
  // the vault's peer ids, from (chain, address) pairs the tests name
  const peer = (s: string) => {
    const [c, addr] = s.split(":");
    return keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [BigInt(c), addr as Address]));
  };
  const active = new Set((w.peersActive ?? []).map(peer));
  const proposed = new Set((w.peersProposed ?? []).map(peer));
  const chainOf = (to: string) => (to.toLowerCase() === a.vault.toLowerCase() ? "bittensor" : "base");
  return fakeChain([VIEWS], {
    bridgeEnabled: ([x], c) => w.enabled?.[k(c.chain, x as string)] ?? (x as string).toLowerCase() === (c.chain === "base" ? a.baseAdapter : a.bitAdapter).toLowerCase(),
    bridgeProposedAt: ([x], c) => w.proposed?.[k(c.chain, x as string)] ?? 0n,
    frontDoorActive: ([id]) => active.has(id as Hex),
    frontDoorProposedAt: ([id]) => (proposed.has(id as Hex) ? 1_800_000_000n : 0n),
    routes: ([id]) => [0, OTHER, "0x", "0x", (w.activeRoutes ?? []).includes(Number(id))],
    pendingGuardian: (_x, c) => w.guardian?.[chainOf(c.to)] ?? zeroAddress,
    guardianProposedAt: (_x, c) => (w.guardian?.[chainOf(c.to)] ? 1_800_000_000n : 0n),
    paused: (_x, c) => w.paused?.[chainOf(c.to)] ?? false,
    hotkeyCount: () => w.hotkeys ?? 1n,
    pendingOwner: () => w.pendingOwner ?? zeroAddress,
  }).ctx;
}
const scanOf = (over: Partial<RegistryScan["base"]> & { bitBridges?: Address[]; frontDoors?: string[] } = {}): RegistryScan => ({
  base: { to: 1, bridges: over.bridges ?? [], routes: over.routes ?? [0] },
  bittensor: { to: 1, bridges: over.bitBridges ?? [], frontDoors: over.frontDoors ?? [] },
});
const NONE = verifyAllowFromEnv({});
const allowing = (v: string) => verifyAllowFromEnv({ OPS_VERIFY_ALLOW: v });

describe("registry checks", () => {
  it("passes the plan's own bridges, front door and route 0", async () => {
    expect(await registryChecks(stateChain({}), plan, scanOf({ frontDoors: [`8453:${a.frontDoor}`] }), NONE)).toEqual({ failures: [], warnings: [], unchecked: [] });
  });

  it("fails when a plan's bridge is disabled", async () => {
    const r = await registryChecks(stateChain({ enabled: { [k("bittensor", a.bitAdapter)]: false } }), plan, scanOf(), NONE);
    expect(r.failures).toEqual([`Bittensor CascadeVault: the plan's bridge ${a.bitAdapter} is disabled`]);
  });

  it("an extra enabled bridge fails unless allowed, when it is a warning", async () => {
    const w = stateChain({ enabled: { [k("base", OTHER)]: true } });
    expect(await registryChecks(w, plan, scanOf({ bridges: [OTHER] }), NONE)).toEqual({
      failures: [`Base CascadeFrontDoor: an extra bridge ${OTHER} is enabled, beyond the plan's (if meant, add it to OPS_VERIFY_ALLOW)`],
      warnings: [],
      unchecked: [],
    });
    expect(await registryChecks(w, plan, scanOf({ bridges: [OTHER] }), allowing(OTHER))).toEqual({
      failures: [],
      warnings: [`Base CascadeFrontDoor: an extra bridge ${OTHER} is enabled (allowed by OPS_VERIFY_ALLOW)`],
      unchecked: [],
    });
  });

  it("a pending bridge proposal is always a warning, and a failure too unless allowed", async () => {
    const w = stateChain({ proposed: { [k("bittensor", OTHER)]: 1_800_000_000n } });
    const pending = `Bittensor CascadeVault: bridge ${OTHER} is proposed, ready to activate from 2027-01-22T08:00:00.000Z`;
    expect(await registryChecks(w, plan, scanOf({ bitBridges: [OTHER] }), NONE)).toEqual({
      failures: [`${pending}, and nobody expects it (if meant, add it to OPS_VERIFY_ALLOW)`],
      warnings: [pending],
      unchecked: [],
    });
    expect(await registryChecks(w, plan, scanOf({ bitBridges: [OTHER] }), allowing(OTHER))).toEqual({ failures: [], warnings: [pending], unchecked: [] });
  });

  it("checks every front door the vault ever logged: another active one fails, a proposed one warns", async () => {
    const w = stateChain({ peersActive: [peerKey(8453n, a.frontDoor), peerKey(1n, OTHER)], peersProposed: [peerKey(8453n, OTHER2)] });
    const r = await registryChecks(w, plan, scanOf({ frontDoors: [`8453:${a.frontDoor}`, `1:${OTHER}`, `8453:${OTHER2}`] }), NONE);
    expect(r.failures).toEqual([
      `Bittensor CascadeVault: another front door (chain 1, ${OTHER}) is active, beyond the plan's (if meant, add it to OPS_VERIFY_ALLOW)`,
      `Bittensor CascadeVault: front door (chain 8453, ${OTHER2}) is proposed, ready to activate from 2027-01-22T08:00:00.000Z, and nobody expects it (if meant, add it to OPS_VERIFY_ALLOW)`,
    ]);
    expect(r.warnings).toEqual([`Bittensor CascadeVault: front door (chain 8453, ${OTHER2}) is proposed, ready to activate from 2027-01-22T08:00:00.000Z`]);
  });

  it("an active staker route beyond route 0 fails unless allowed; an inactive one is nothing", async () => {
    const w = stateChain({ activeRoutes: [0, 2] });
    expect((await registryChecks(w, plan, scanOf({ routes: [0, 2, 3] }), NONE)).failures).toEqual([
      "Base CascadeStaker: route 2 is active beyond the plan's route 0 (if meant, add route:2 to OPS_VERIFY_ALLOW)",
    ]);
    expect(await registryChecks(w, plan, scanOf({ routes: [0, 2, 3] }), allowing("route:2"))).toEqual({
      failures: [],
      warnings: ["Base CascadeStaker: route 2 is active (allowed by OPS_VERIFY_ALLOW)"],
      unchecked: [],
    });
  });
});

describe("what the scan couldn't read", () => {
  const DAY = 86_400;
  const T = 1_800_000_000;
  /** Chains whose block `n` was mined `age(n)` seconds before the head. */
  const aged = (age: (block: number) => number, fail = false) =>
    fakeChain([], {}, {
      eth_getBlockByNumber: (_c, p) => {
        if (fail) throw new Error("no such block");
        return { timestamp: numberToHex(p[0] === "latest" ? T : T - age(Number(p[0]))) };
      },
    }).ctx;
  const gap = (from?: number) => ({ chain: "base" as const, ...(from === undefined ? {} : { from }), line: "Base: a gap" });

  it("stays unchecked while it is younger than the 7-day registry delay", async () => {
    expect(await gapFindings(aged(() => 6 * DAY), rec, [gap(1_000)])).toEqual({ failures: [], unchecked: ["Base: a gap"] });
  });

  it("fails once it began more than 7 days ago: a proposal made in it could be active by now", async () => {
    expect(await gapFindings(aged(() => 8 * DAY), rec, [gap(1_000)])).toEqual({
      failures: [
        "Base: a gap; the gap began 8 days ago, beyond the 7-day registry delay, so a bridge or front door proposed in it could be active now: point OPS_BASE_LOGS_RPC at a server that serves those logs and run verify again",
      ],
      unchecked: [],
    });
  });

  it("dates a gap with no block from the record's creation, and leaves one it can't date unchecked", async () => {
    const old = { ...rec, createdAt: new Date((T - 9 * DAY) * 1000).toISOString() };
    expect((await gapFindings(aged(() => 0), old, [gap()])).failures).toHaveLength(1);
    expect(await gapFindings(aged(() => 0, true), rec, [gap(1_000)])).toEqual({ failures: [], unchecked: ["Base: a gap"] });
  });

  it("an extra candidate already found whose state can't be read stays a failure; the plan's own bridge is unchecked", async () => {
    const w = stateChain({});
    const request = w.rpc.request;
    const enabledOf = toFunctionSelector("bridgeEnabled(address)");
    const failing = (who: Address) => ({
      ...w,
      rpc: {
        request: (c: ChainName, m: string, p: unknown[]) => {
          const data = (p[0] as { data?: Hex })?.data;
          if (m === "eth_call" && data?.startsWith(enabledOf) && data.toLowerCase().endsWith(who.slice(2).toLowerCase())) return Promise.reject(new Error("node down"));
          return request(c, m, p);
        },
      },
    });
    const extra = await registryChecks(failing(OTHER), plan, scanOf({ bridges: [OTHER] }), NONE);
    expect(extra.failures).toEqual([`Base CascadeFrontDoor: couldn't read the state of the extra bridge ${OTHER} it found before (node down)`]);
    expect(extra.unchecked).toEqual([]);
    const own = await registryChecks(failing(a.baseAdapter), plan, scanOf(), NONE);
    expect(own.failures).toEqual([]);
    expect(own.unchecked).toEqual([`Base CascadeFrontDoor: couldn't read the state of the plan's bridge ${a.baseAdapter} (node down)`]);
  });

  it("status and run say what the last verify couldn't check", () => {
    expect(uncheckedLines(rec)).toEqual([]);
    expect(uncheckedLines({ ...rec, verify: { ok: true, failures: [], checkedAt: "2026-10-29T00:00:00Z", unchecked: ["Base: a gap"] } })).toEqual([
      "NOT CHECKED at the last verify (2026-10-29T00:00:00Z):",
      "  Base: a gap",
    ]);
  });
});

describe("guardian proposals, pauses and the hotkey set", () => {
  it("a pending guardian is a warning, and a failure unless allowed", async () => {
    const w = stateChain({ guardian: { base: OTHER } });
    const pending = `Base CascadeFrontDoor: guardian ${OTHER} is proposed, acceptable from 2027-01-23T08:00:00.000Z`;
    expect(await guardianChecks(w, plan, NONE)).toEqual({ failures: [`${pending}, and nobody expects it (if meant, add it to OPS_VERIFY_ALLOW)`], warnings: [pending] });
    expect(await guardianChecks(w, plan, allowing(OTHER))).toEqual({ failures: [], warnings: [pending] });
    expect(await guardianChecks(stateChain({}), plan, NONE)).toEqual({ failures: [], warnings: [] });
  });

  it("warns of a pause and of more than one hotkey", async () => {
    expect(await stateWarnings(stateChain({}), plan)).toEqual([]);
    expect(await stateWarnings(stateChain({ paused: { base: true, bittensor: true }, hotkeys: 2n }), plan)).toEqual([
      "Base CascadeFrontDoor is paused",
      "Bittensor CascadeVault is paused",
      "Bittensor CascadeVault reads 2 hotkeys (the plan stakes with one)",
    ]);
  });

  it("a test plan's contracts must have no pending owner", async () => {
    expect(await ownershipChecks(stateChain({}), plan)).toEqual({ failures: [], warnings: [] });
    const r = await ownershipChecks(stateChain({ pendingOwner: OTHER }), plan as PlanV3);
    expect(r.failures).toEqual([
      `Base CascadeFrontDoor: pendingOwner is ${OTHER}: an ownership transfer the plan doesn't make`,
      `Base CascadeStaker: pendingOwner is ${OTHER}: an ownership transfer the plan doesn't make`,
      `Bittensor CascadeVault: pendingOwner is ${OTHER}: an ownership transfer the plan doesn't make`,
    ]);
  });
});

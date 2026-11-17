import { type Address, decodeFunctionData, encodeFunctionResult, getAddress, type Hex, hexToBigInt, numberToHex, parseAbi } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { parseArgs, USAGE } from "../src/args.ts";
import { paths, targets } from "../src/config.ts";
import { decodeDeployment, deploymentProblems, encodeDeployment } from "../src/keeper/core/deployment.ts";
import { deploymentFromRecordV32 } from "../src/keeper/deployment-v32.ts";
import type { Rpc } from "../src/rpc.ts";
import { type BuildV32, freezeBuildV32, type SourceV32 } from "../src/v32/build.ts";
import type { DeploymentRecordV32 } from "../src/v32/deploy.ts";
import { addPairCommand, pairFieldProblems } from "../src/v32/pairs.ts";
import { planV32 } from "./v32-fixtures.ts";

// R4 (D-M2, C-M2, C-L4): a second adapter pair written into the record by pnpm ops add-pair, after its checks (each half
// names the other on the other's chain; each shares the deploy's adapter's router, token and remote selector, the
// Bittensor half its AlphaVault), and the keeper's deployment built from the record lists it with its creation blocks.

const at = (n: string): Address => getAddress(`0x${n.padStart(40, "0")}`);
const lower = (a: string) => a.toLowerCase();
const SOURCE: SourceV32 = { commit: "c0ffee".padEnd(40, "0"), tree: "7ee".padEnd(40, "0"), dirty: [] };
let build: BuildV32;
beforeAll(async () => {
  build = (await freezeBuildV32(paths({}).contractsDir, SOURCE)).build;
});

const BIT2 = at("ad11");
const BASE2 = at("ad12");
const ABI = parseAbi([
  "function remoteAdapter() view returns (address)",
  "function remoteChainId() view returns (uint64)",
  "function remoteSelector() view returns (uint64)",
  "function router() view returns (address)",
  "function token() view returns (address)",
  "function alphaVault() view returns (address)",
  // ForeverMoney's AlphaVault: the target of a migration it announced (R4-O round 2)
  "function migrationTarget() view returns (address)",
  "function migrationFinished() view returns (bool)",
  // merge 7b (R4): the lane's inbound gas model, the Bittensor adapter's copy and its Base adapter's own pair
  "function inboundGasBase() view returns (uint256)",
  "function inboundGasPerEntry() view returns (uint256)",
  "function gasBase() view returns (uint256)",
  "function gasPerEntry() view returns (uint256)",
]);
const OLD_AV = at("a1fa");
const NEW_AV = at("a2fa");
const ZERO = at("0");

function record(): DeploymentRecordV32 {
  const plan = planV32();
  const sent = (block: number) => ({ hash: `0x${"11".repeat(32)}` as Hex, block, gasUsed: 1n, costWei: 1n });
  return { target: "live", createdAt: "", plan, build: { dir: "v32-test", hash: `0x${"00".repeat(32)}` }, done: Object.fromEntries(plan.steps.map((s) => [s.id, sent(s.chain === "base" ? 30_000_000 : 6_000_000)])) };
}

/** Two chains holding the record's pair and a second one: each adapter's getters (a test changes one), its code from a
 * block on (its creation), and the heads. */
function chains(rec: DeploymentRecordV32) {
  const a = rec.plan.addresses;
  const fields = (remote: Address, chain: bigint, selector: bigint, o: Record<string, unknown> = {}) => ({ remoteAdapter: remote, remoteChainId: chain, remoteSelector: selector, router: at("0e0e"), token: at("70c1"), alphaVault: at("a1fa"), ...o });
  const c = {
    head: { base: 40_000_000, bittensor: 7_000_000 },
    created: { [lower(BIT2)]: 6_500_123, [lower(BASE2)]: 39_000_456 } as Record<string, number>,
    getters: {
      // the new pair's inbound model in both copies: a recalibrated pair of its own, the same on each side
      bittensor: {
        [lower(a.bitAdapter)]: fields(a.baseAdapter, 8453n, 1n),
        [lower(BIT2)]: fields(BASE2, 8453n, 1n, { inboundGasBase: 1_400_000n, inboundGasPerEntry: 55_000n }),
        [lower(OLD_AV)]: { migrationTarget: ZERO, migrationFinished: false },
      },
      base: { [lower(a.baseAdapter)]: fields(a.bitAdapter, 964n, 2n), [lower(BASE2)]: fields(BIT2, 964n, 2n, { gasBase: 1_400_000n, gasPerEntry: 55_000n }) },
    } as Record<"base" | "bittensor", Record<string, Record<string, unknown>>>,
  };
  const rpc: Rpc = {
    async request(chain, method, params) {
      if (method === "eth_chainId") return numberToHex(chain === "base" ? 8453 : 964);
      if (method === "eth_blockNumber") return numberToHex(c.head[chain]);
      if (method === "eth_getCode") {
        const addr = lower(params[0] as string);
        const tag = params[1] as string;
        const block = tag === "latest" ? c.head[chain] : Number(hexToBigInt(tag as Hex));
        const from = c.created[addr] ?? (c.getters[chain][addr] ? 0 : Number.POSITIVE_INFINITY);
        return block >= from ? "0x6001" : "0x";
      }
      if (method === "eth_call") {
        const tx = params[0] as { to: Address; data: Hex };
        const { functionName } = decodeFunctionData({ abi: ABI, data: tx.data });
        const g = c.getters[chain][lower(tx.to)];
        if (!g) throw new Error(`no adapter ${tx.to} on ${chain}`);
        const v = g[functionName];
        const tag = (params as unknown[])[1];
        return encodeFunctionResult({ abi: ABI, functionName, result: typeof v === "function" ? (v as (t: unknown) => unknown)(tag) : v } as never);
      }
      throw new Error(`no ${method}`);
    },
  };
  const ctx = { rpc, targets: targets({}).live };
  return { c, ctx };
}

describe("pnpm ops add-pair (R4, D-M2): the new pair checked, then written into the record", () => {
  it("R4-O's fix round (Minor 1): the usage lists add-pair after retire-pair's two lines, never inside them", () => {
    const lines = USAGE.split("\n");
    const retire = lines.findIndex((l) => l.startsWith("  retire-pair "));
    expect(lines[retire + 1].trim()).toBe("(disableBridge), as one call file; refused while the Bittensor adapter holds a park");
    expect(lines[retire + 2].startsWith("  add-pair <bridge> <bridge> [--live]")).toBe(true);
    expect(lines.slice(retire + 3, retire + 5).every((l) => l.startsWith("                             "))).toBe(true);
  });

  it("parses: the Bittensor adapter, then the Base adapter", () => {
    expect(parseArgs(["add-pair", BIT2, BASE2, "--live"])).toMatchObject({ cmd: "add-pair", pair: [BIT2, BASE2], live: true });
    expect(() => parseArgs(["add-pair", BIT2, "--live"])).toThrow(/add-pair needs the new pair's two adapters/);
    expect(() => parseArgs(["add-pair", BIT2, "0x12", "--live"])).toThrow(/0x12 is not an address/);
  });

  it("a pair of Cascade's lane is written with each adapter's creation block, and the keeper's deployment lists it", async () => {
    const rec = record();
    const { ctx } = chains(rec);
    let saved: DeploymentRecordV32 | undefined;
    const r = await addPairCommand(ctx, rec, { bitAdapter: BIT2, baseAdapter: BASE2, now: Date.parse("2027-01-18T14:05:00Z"), save: (x) => (saved = x) });
    expect(r.ok, r.lines.join("\n")).toBe(true);
    expect(saved?.pairs).toEqual([{ bitAdapter: BIT2, baseAdapter: BASE2, blocks: { bittensor: 6_500_123, base: 39_000_456 }, addedAt: "2027-01-18T14:05:00.000Z" }]);
    expect(r.lines[0]).toBe(
      `Added the pair ${BIT2} (Bittensor, created at block 6500123) and ${BASE2} (Base, created at block 39000456) to the record. Its halves name each other and share the deploy's router, token and selectors.`,
    );
    const d = deploymentFromRecordV32(saved as DeploymentRecordV32, { name: "v3.2-launch", chainIds: { base: 8453, bittensor: 964 }, env: {}, build, web: null, vaultCreatedAt: 1_700_000_000 });
    expect(d.pairs).toEqual([{ baseAdapter: BASE2, bitAdapter: BIT2, startBlocks: { base: 39_000_456n, bittensor: 6_500_123n } }]);
    // through the Worker's DEPLOYMENT var and back
    expect(decodeDeployment(encodeDeployment(d)).pairs).toEqual(d.pairs);
  });

  for (const [what, edit, why] of [
    ["a Bittensor half that names another peer", (c: ReturnType<typeof chains>["c"]) => (c.getters.bittensor[lower(BIT2)].remoteAdapter = at("ba0d")), /the Bittensor adapter .* names 0x000000000000000000000000000000000000ba0d on chain 8453 as its peer/i],
    ["a Base half on another chain", (c: ReturnType<typeof chains>["c"]) => (c.getters.base[lower(BASE2)].remoteChainId = 1n), /the Base adapter .* names .* on chain 1 as its peer/],
    ["another remote selector (C-L4: the selector routes)", (c: ReturnType<typeof chains>["c"]) => (c.getters.base[lower(BASE2)].remoteSelector = 99n), /Base adapter .*: its remoteSelector\(\) is 99, not 2 as the deploy's adapter's on Base/],
    ["another router", (c: ReturnType<typeof chains>["c"]) => (c.getters.bittensor[lower(BIT2)].router = at("bad1")), /Bittensor adapter .*: its router\(\) is 0x000000000000000000000000000000000000bad1/i],
    ["another token", (c: ReturnType<typeof chains>["c"]) => (c.getters.base[lower(BASE2)].token = at("bad2")), /its token\(\) is/],
    ["another AlphaVault", (c: ReturnType<typeof chains>["c"]) => (c.getters.bittensor[lower(BIT2)].alphaVault = at("bad3")), /its alphaVault\(\) is/],
    // merge 7b (phase 1 concern 3): the new pair's inbound figures held to its own Base adapter's (one model, two copies)
    [
      "a Bittensor half whose inbound gas base isn't its Base adapter's gasBase",
      (c: ReturnType<typeof chains>["c"]) => (c.getters.bittensor[lower(BIT2)].inboundGasBase = 1_300_000n),
      new RegExp(
        `the Bittensor adapter ${BIT2}'s inboundGasBase\\(\\) is 1300000, not its Base adapter ${BASE2}'s gasBase\\(\\), 1400000: the lane's inbound gas model is one model in two copies, and deliverParked's gas requirement would not be what CCIP gives a delivery`,
      ),
    ],
    [
      "a Bittensor half whose inbound gas per entry isn't its Base adapter's gasPerEntry",
      (c: ReturnType<typeof chains>["c"]) => (c.getters.base[lower(BASE2)].gasPerEntry = 57_000n),
      new RegExp(`the Bittensor adapter ${BIT2}'s inboundGasPerEntry\\(\\) is 55000, not its Base adapter ${BASE2}'s gasPerEntry\\(\\), 57000`),
    ],
  ] as const) {
    it(`refuses ${what}: nothing written`, async () => {
      const rec = record();
      const { c, ctx } = chains(rec);
      edit(c);
      let saved = false;
      const r = await addPairCommand(ctx, rec, { bitAdapter: BIT2, baseAdapter: BASE2, now: 0, save: () => (saved = true) });
      expect(r.ok).toBe(false);
      expect(saved).toBe(false);
      expect(r.lines[0]).toMatch(/^Not a pair of Cascade's lane: /);
      expect(r.lines[0]).toMatch(why);
      expect(r.lines[0]).toMatch(/Nothing written\.$/);
    });
  }

  it("R4-O round 2: a replacement pair naming ForeverMoney's new AlphaVault is added when that address is the deploy's AlphaVault's announced migration target (read live), and refused when it names any other", async () => {
    const rec = record();
    const { c, ctx } = chains(rec);
    c.getters.bittensor[lower(BIT2)].alphaVault = NEW_AV;
    // no migration announced: refused, as before
    const none = await addPairCommand(ctx, rec, { bitAdapter: BIT2, baseAdapter: BASE2, now: 0, save: () => undefined });
    expect(none.ok).toBe(false);
    expect(none.lines[0]).toContain(`its alphaVault() is ${NEW_AV}, not ${OLD_AV} as the deploy's adapter's on Bittensor, nor the announced migration target of ${OLD_AV} (none announced)`);
    // the migration's announced target: added, and said
    c.getters.bittensor[lower(OLD_AV)].migrationTarget = NEW_AV;
    let saved: DeploymentRecordV32 | undefined;
    const ok = await addPairCommand(ctx, rec, { bitAdapter: BIT2, baseAdapter: BASE2, now: 0, save: (x) => (saved = x) });
    expect(ok.ok, ok.lines.join("\n")).toBe(true);
    expect(saved?.pairs?.map((p) => p.bitAdapter)).toEqual([BIT2]);
    expect(ok.lines).toContain(`Bittensor adapter ${BIT2}: its alphaVault() is ${NEW_AV}, the announced migration target of the deploy's AlphaVault ${OLD_AV} (its migrationTarget(), read now): ForeverMoney's vault after the migration.`);
    // a target announced, but the pair names another vault: refused, the target named
    c.getters.bittensor[lower(BIT2)].alphaVault = at("bad3");
    const other = await addPairCommand(ctx, rec, { bitAdapter: BIT2, baseAdapter: BASE2, now: 0, save: () => undefined });
    expect(other.ok).toBe(false);
    expect(other.lines[0]).toContain(`its alphaVault() is ${at("bad3")}, not ${OLD_AV} as the deploy's adapter's on Bittensor, nor the announced migration target of ${OLD_AV} (${NEW_AV})`);
  });

  it("R4-O round 3: add-pair records the live target beside the pair, with the Bittensor block it read it at", async () => {
    const rec = record();
    const { c, ctx } = chains(rec);
    c.getters.bittensor[lower(BIT2)].alphaVault = NEW_AV;
    c.getters.bittensor[lower(OLD_AV)].migrationTarget = NEW_AV;
    let saved: DeploymentRecordV32 | undefined;
    const r = await addPairCommand(ctx, rec, { bitAdapter: BIT2, baseAdapter: BASE2, now: 0, save: (x) => (saved = x) });
    expect(r.ok, r.lines.join("\n")).toBe(true);
    expect(saved?.pairs?.[0].alphaTarget).toEqual({ vault: OLD_AV, target: NEW_AV, block: 7_000_000 });
    // a pair naming the deploy's own AlphaVault records none
    const { ctx: ctx2 } = chains(rec);
    let plain: DeploymentRecordV32 | undefined;
    await addPairCommand(ctx2, rec, { bitAdapter: BIT2, baseAdapter: BASE2, now: 0, save: (x) => (plain = x) });
    expect(plain?.pairs?.[0]).not.toHaveProperty("alphaTarget");
  });

  it("R4-O round 3: once the live target reads 0 (finishMigration cleared it), the address recorded from it is accepted, after the target is read again at the recorded block; a record it never matched, and any other vault, are refused", async () => {
    const base = record();
    const { c, ctx } = chains(base);
    c.getters.bittensor[lower(BIT2)].alphaVault = NEW_AV;
    // the target was NEW_AV at block 6,900,000 (when add-pair recorded it), and reads 0 now
    const AT = 6_900_000;
    c.getters.bittensor[lower(OLD_AV)].migrationTarget = (tag: unknown) => (tag === numberToHex(AT) ? NEW_AV : ZERO);
    c.getters.bittensor[lower(OLD_AV)].migrationFinished = true;
    const pair = (alphaTarget: { vault: Address; target: Address; block: number }) => ({ bitAdapter: BIT2, baseAdapter: BASE2, blocks: { base: 1, bittensor: 1 }, addedAt: "", alphaTarget });
    const rec = { ...base, pairs: [pair({ vault: OLD_AV, target: NEW_AV, block: AT })] };
    expect(await pairFieldProblems(ctx, rec, "bittensor", BIT2)).toEqual([]);
    const notes: string[] = [];
    await pairFieldProblems(ctx, rec, "bittensor", BIT2, undefined, notes);
    expect(notes).toEqual([`its alphaVault() is ${NEW_AV}, the migration target the deploy's AlphaVault ${OLD_AV} announced, recorded at block ${AT} (its migrationTarget() then; it reads none now, its migration finished).`]);
    // a recorded address the target never was at its block: refused, said
    const forged = { ...base, pairs: [pair({ vault: OLD_AV, target: NEW_AV, block: AT + 1 })] };
    expect(await pairFieldProblems(ctx, forged, "bittensor", BIT2)).toEqual([
      `its alphaVault() is ${NEW_AV}, not ${OLD_AV} as the deploy's adapter's on Bittensor, nor the announced migration target of ${OLD_AV} (none announced); the address recorded for it at block ${AT + 1} was not its migration target then (${ZERO})`,
    ]);
    // the record names another vault than the pair's: refused as any other
    c.getters.bittensor[lower(BIT2)].alphaVault = at("bad3");
    expect((await pairFieldProblems(ctx, rec, "bittensor", BIT2))[0]).toContain(`its alphaVault() is ${at("bad3")}, not ${OLD_AV} as the deploy's adapter's on Bittensor, nor the announced migration target of ${OLD_AV} (none announced)`);
    // a record beside another pair never accepts this one
    c.getters.bittensor[lower(BIT2)].alphaVault = NEW_AV;
    const elsewhere = { ...base, pairs: [{ ...pair({ vault: OLD_AV, target: NEW_AV, block: AT }), bitAdapter: at("ad21") }] };
    expect(await pairFieldProblems(ctx, elsewhere, "bittensor", BIT2)).toHaveLength(1);
  });

  it("R4-O round 4 (Minor 1): a cleared target counts only when the old vault reads its migration finished: a cancelled notice (cleared, not finished) refuses the recorded address", async () => {
    const base = record();
    const { c, ctx } = chains(base);
    c.getters.bittensor[lower(BIT2)].alphaVault = NEW_AV;
    const AT = 6_900_000;
    c.getters.bittensor[lower(OLD_AV)].migrationTarget = (tag: unknown) => (tag === numberToHex(AT) ? NEW_AV : ZERO);
    const rec = { ...base, pairs: [{ bitAdapter: BIT2, baseAdapter: BASE2, blocks: { base: 1, bittensor: 1 }, addedAt: "", alphaTarget: { vault: OLD_AV, target: NEW_AV, block: AT } }] };
    // cancelled: the target cleared, the migration not finished
    c.getters.bittensor[lower(OLD_AV)].migrationFinished = false;
    expect(await pairFieldProblems(ctx, rec, "bittensor", BIT2)).toEqual([
      `its alphaVault() is ${NEW_AV}, not ${OLD_AV} as the deploy's adapter's on Bittensor, nor the announced migration target of ${OLD_AV} (none announced); the address recorded for it at block ${AT} counts only once ${OLD_AV}'s migration has finished, and it reads none finished (a cancelled notice reads the same)`,
    ]);
    // finished: accepted
    c.getters.bittensor[lower(OLD_AV)].migrationFinished = true;
    expect(await pairFieldProblems(ctx, rec, "bittensor", BIT2)).toEqual([]);
  });

  it("R4-O round 4 (Minor 2): add-pair --target-block <n>, the recovery for an add-pair missed during the notice: the target read at that past block (the archive node) is recorded, under the same rules", async () => {
    expect(parseArgs(["add-pair", BIT2, BASE2, "--target-block", "6900000", "--live"])).toMatchObject({ cmd: "add-pair", pair: [BIT2, BASE2], targetBlock: 6_900_000 });
    expect(() => parseArgs(["add-pair", BIT2, BASE2, "--target-block", "soon", "--live"])).toThrow(/--target-block needs a block number/);
    expect(() => parseArgs(["status", "--target-block", "1"])).toThrow(/unknown|not an option|--target-block/);
    const rec = record();
    const { c, ctx } = chains(rec);
    c.getters.bittensor[lower(BIT2)].alphaVault = NEW_AV;
    const AT = 6_900_000;
    c.getters.bittensor[lower(OLD_AV)].migrationTarget = (tag: unknown) => (tag === numberToHex(AT) ? NEW_AV : ZERO);
    c.getters.bittensor[lower(OLD_AV)].migrationFinished = true;
    // without it, the cleared target refuses (nothing recorded to fall back on)
    const missed = await addPairCommand(ctx, rec, { bitAdapter: BIT2, baseAdapter: BASE2, now: 0, save: () => undefined });
    expect(missed.ok).toBe(false);
    // with the block it was announced at: recorded with that block
    let saved: DeploymentRecordV32 | undefined;
    const r = await addPairCommand(ctx, rec, { bitAdapter: BIT2, baseAdapter: BASE2, now: 0, targetBlock: AT, save: (x) => (saved = x) });
    expect(r.ok, r.lines.join("\n")).toBe(true);
    expect(saved?.pairs?.[0].alphaTarget).toEqual({ vault: OLD_AV, target: NEW_AV, block: AT });
    // a block where the target was not the pair's vault: refused, nothing written
    let wrote = false;
    const wrong = await addPairCommand(ctx, rec, { bitAdapter: BIT2, baseAdapter: BASE2, now: 0, targetBlock: AT + 5, save: () => (wrote = true) });
    expect([wrong.ok, wrote]).toEqual([false, false]);
    expect(wrong.lines[0]).toContain(`at block ${AT + 5} was not its migration target then`);
    // the migration not finished (a cancel): refused
    c.getters.bittensor[lower(OLD_AV)].migrationFinished = false;
    const cancelled = await addPairCommand(ctx, rec, { bitAdapter: BIT2, baseAdapter: BASE2, now: 0, targetBlock: AT, save: () => (wrote = true) });
    expect([cancelled.ok, wrote]).toEqual([false, false]);
  });

  it("R4-O round 2: the target accepts the AlphaVault alone; every other field stays as strict", async () => {
    const rec = record();
    const { c, ctx } = chains(rec);
    c.getters.bittensor[lower(OLD_AV)].migrationTarget = NEW_AV;
    c.getters.bittensor[lower(BIT2)].alphaVault = NEW_AV;
    expect(await pairFieldProblems(ctx, rec, "bittensor", BIT2)).toEqual([]);
    c.getters.bittensor[lower(BIT2)].router = at("bad1");
    expect(await pairFieldProblems(ctx, rec, "bittensor", BIT2)).toEqual([`its router() is ${at("bad1")}, not ${at("0e0e")} as the deploy's adapter's on Bittensor`]);
    // the target names a vault, never a router or a token
    c.getters.bittensor[lower(BIT2)].router = at("0e0e");
    c.getters.bittensor[lower(BIT2)].token = NEW_AV;
    expect(await pairFieldProblems(ctx, rec, "bittensor", BIT2)).toEqual([`its token() is ${NEW_AV}, not ${at("70c1")} as the deploy's adapter's on Bittensor`]);
  });

  it("refuses an adapter the record lists already, and one with no code", async () => {
    const rec = record();
    const { c, ctx } = chains(rec);
    const again = await addPairCommand(ctx, rec, { bitAdapter: rec.plan.addresses.bitAdapter, baseAdapter: BASE2, now: 0, save: () => undefined });
    expect([again.ok, again.lines[0]]).toEqual([false, expect.stringMatching(/^The record lists .* already, in the pair .*; nothing written\.$/)]);
    c.created[lower(BASE2)] = Number.POSITIVE_INFINITY;
    const none = await addPairCommand(ctx, rec, { bitAdapter: BIT2, baseAdapter: BASE2, now: 0, save: () => undefined });
    expect(none.lines[0]).toMatch(new RegExp(`Base: ${BASE2} has no code`));
  });

  it("pairFieldProblems: none for the deploy's own adapter; each field that differs, named", async () => {
    const rec = record();
    const { c, ctx } = chains(rec);
    expect(await pairFieldProblems(ctx, rec, "bittensor", rec.plan.addresses.bitAdapter)).toEqual([]);
    expect(await pairFieldProblems(ctx, rec, "bittensor", BIT2)).toEqual([]);
    c.getters.bittensor[lower(BIT2)].remoteSelector = 7n;
    expect(await pairFieldProblems(ctx, rec, "bittensor", BIT2)).toEqual(["its remoteSelector() is 7, not 1 as the deploy's adapter's on Bittensor"]);
  });

  it("the deployment's pairs are checked as it is decoded: addresses, start blocks, none listed twice", () => {
    const rec = record();
    const d = deploymentFromRecordV32(rec, { name: "v3.2-launch", chainIds: { base: 8453, bittensor: 964 }, env: {}, build, web: null, vaultCreatedAt: 1_700_000_000 });
    expect(deploymentProblems({ ...d, pairs: [{ baseAdapter: BASE2, bitAdapter: BIT2, startBlocks: { base: 1n, bittensor: 1n } }] })).toEqual([]);
    expect(deploymentProblems({ ...d, pairs: [{ baseAdapter: d.addresses.baseAdapter, bitAdapter: BIT2, startBlocks: { base: 1n, bittensor: -1n } }] })).toEqual([
      "its adapter pair 2's bittensor start block is not a block",
      `its adapter pair 2 lists ${d.addresses.baseAdapter}, an adapter it lists already`,
    ]);
  });
});

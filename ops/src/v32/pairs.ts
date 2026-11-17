import { type Address, getAddress, type Hex, hexToBigInt, parseAbi } from "viem";
import type { ChainName } from "../config.ts";
import { firstBlockWithCode, read } from "../rpc.ts";
import { chainLabel } from "../send.ts";
import type { DeploymentRecordV32 } from "./deploy.ts";
import { checkChains, type RecordV32, readNow, type SchedulerCtx } from "./scheduler.ts";

// The adapter pairs a v3.2 deployment runs on (R4: D-M2, C-M2, C-L4). The deploy makes one pair (the record's plan:
// baseAdapter on Base, bitAdapter on Bittensor). Runbook section 8's switch adds another, which the keeper must watch too
// (its parks, its conversions, its CCIP FAILUREs), so `pnpm ops add-pair` writes it into the record, after checking it
// is a pair of Cascade's lane: each half names the other, on the other's chain, and holds the same router, token and
// remote selector as the deploy's adapter on its chain (and the Bittensor half the same ForeverMoney AlphaVault). The rail
// checks (rails.ts readRails) hold any other bridge to the same fields.

/** Each CCIP adapter's own immutables the pair checks read (CcipAdapterBase, and CcipBittensorAdapter's alphaVault). */
const PAIR_ABI = parseAbi([
  "function remoteAdapter() view returns (address)",
  "function remoteChainId() view returns (uint64)",
  "function remoteSelector() view returns (uint64)",
  "function router() view returns (address)",
  "function token() view returns (address)",
  "function alphaVault() view returns (address)",
  // ForeverMoney's AlphaVault: the target of the migration it announced (0 while none is; R4-O round 2)
  "function migrationTarget() view returns (address)",
  // whether its migration finished (R4-O round 4: a cleared target counts only then; a cancelled notice reads false)
  "function migrationFinished() view returns (bool)",
  // merge 7b (R4): the lane's inbound gas model, one model in two copies: the Bittensor adapter's (deliverParked's
  // requirement, immutable) and its Base adapter's own pair (what CCIP gives a delivery toward Bittensor)
  "function inboundGasBase() view returns (uint256)",
  "function inboundGasPerEntry() view returns (uint256)",
  "function gasBase() view returns (uint256)",
  "function gasPerEntry() view returns (uint256)",
]);
const ZERO = "0x0000000000000000000000000000000000000000";

/** The fields a bridge must share with the deploy's adapter on its chain: the CCIP router and token it uses, the remote
 * chain's selector it sends to (the chain id is only a label; the selector routes), and on Bittensor the AlphaVault that
 * converts its tokens. */
const FIELDS: Record<ChainName, readonly ("router" | "token" | "remoteSelector" | "alphaVault")[]> = {
  base: ["router", "token", "remoteSelector"],
  bittensor: ["router", "token", "remoteSelector", "alphaVault"],
};

const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

/** Why `bridge` on `chain` is not set up as the deploy's adapter there is (C-L4): each of its fields (FIELDS) that differs
 * from the deploy's adapter's on that chain, read at `block` (a pinned head) or the latest. The deploy's adapter itself
 * has none. A read that fails throws: a field unread is never taken as the same.
 *
 * One exception (R4-O round 2, the coordinator's ruling): a Bittensor bridge may name another AlphaVault than the
 * deploy's adapter's only when it is the deploy's AlphaVault's announced migration target (its migrationTarget(), read
 * live at the same block, not 0): ForeverMoney's vault after the migration, which runbook 7.7's replacement pair names.
 * Any other address is refused as before, naming the target (or none); every other field stays as strict. `notes` gets a
 * line when the exception accepts one; `live` gets the target it accepted live (add-pair records it).
 *
 * Once the live target reads 0 (ForeverMoney's finishMigration may clear it; R4-O round 3, the coordinator's ruling), the
 * address add-pair recorded beside this pair (DeploymentRecordV32.pairs[].alphaTarget) is accepted instead, and only
 * after migrationTarget() is read again at the recorded block (Bittensor's archive node) and found equal: an address that
 * was not the live target when it was recorded is never accepted, a hand-edited record included. And only while the old
 * vault reads its migration finished (R4-O round 4, Minor 1): ForeverMoney's cancelMigration also clears the notice,
 * and then nothing moved, so a cleared target with no finish refuses. */
export async function pairFieldProblems(
  ctx: Pick<SchedulerCtx, "rpc">,
  rec: RecordV32,
  chain: ChainName,
  bridge: Address,
  block?: bigint,
  notes?: string[],
  live?: { vault?: Address; target?: Address; block?: number },
): Promise<string[]> {
  const ours = getAddress(chain === "base" ? rec.plan.addresses.baseAdapter : rec.plan.addresses.bitAdapter);
  if (same(ours, bridge)) return [];
  const out: string[] = [];
  for (const fn of FIELDS[chain]) {
    const get = (address: Address) => read(ctx.rpc, chain, { address, abi: PAIR_ABI, functionName: fn }, block);
    const want = await get(ours);
    const got = await get(getAddress(bridge));
    if (same(got, want)) continue;
    const said = `its ${fn}() is ${String(got)}, not ${String(want)} as the deploy's adapter's on ${chainLabel(chain)}`;
    if (fn !== "alphaVault") {
      out.push(said);
      continue;
    }
    const vault = getAddress(want as Address);
    const targetAt = async (at?: bigint) => String(await read(ctx.rpc, chain, { address: vault, abi: PAIR_ABI, functionName: "migrationTarget" }, at));
    const target = await targetAt(block);
    if (!same(target, ZERO) && same(got, target)) {
      notes?.push(`its alphaVault() is ${String(got)}, the announced migration target of the deploy's AlphaVault ${String(want)} (its migrationTarget(), read now): ForeverMoney's vault after the migration.`);
      if (live) Object.assign(live, { vault, target: getAddress(target as Address) });
      continue;
    }
    const nor = `${said}, nor the announced migration target of ${String(want)} (${same(target, ZERO) ? "none announced" : target})`;
    // the live target cleared: the address recorded beside this pair, read again at its block
    const kept = same(target, ZERO) ? (rec.pairs ?? []).find((p) => same(p.bitAdapter, bridge))?.alphaTarget : undefined;
    if (kept && same(kept.vault, vault) && same(kept.target, got)) {
      const then = await targetAt(BigInt(kept.block));
      if (!same(then, got)) {
        out.push(`${nor}; the address recorded for it at block ${kept.block} was not its migration target then (${then})`);
        continue;
      }
      const finished = (await read(ctx.rpc, chain, { address: vault, abi: PAIR_ABI, functionName: "migrationFinished" }, block)) as boolean;
      if (!finished) {
        out.push(`${nor}; the address recorded for it at block ${kept.block} counts only once ${String(want)}'s migration has finished, and it reads none finished (a cancelled notice reads the same)`);
        continue;
      }
      notes?.push(`its alphaVault() is ${String(got)}, the migration target the deploy's AlphaVault ${String(want)} announced, recorded at block ${kept.block} (its migrationTarget() then; it reads none now, its migration finished).`);
      if (live) Object.assign(live, { vault, target: getAddress(got as Address), block: kept.block });
      continue;
    }
    out.push(nor);
  }
  return out;
}

/** A pair the record lists beyond the deploy's (DeploymentRecordV32.pairs): its two adapters and the blocks they were
 * created at, where the keeper's scans of them start. */
export interface RecordPair {
  bitAdapter: Address;
  baseAdapter: Address;
  blocks: { base: number; bittensor: number };
  addedAt: string;
  /** R4-O round 3: the deploy's AlphaVault's live migration target this pair names, and the Bittensor block add-pair read
   * it at (pairFieldProblems accepts it once the live target is cleared, read again at that block) */
  alphaTarget?: { vault: Address; target: Address; block: number };
}

/** `pnpm ops add-pair <bitAdapter> <baseAdapter> [--live]` (R4, D-M2 and C-M2; runbook section 8, beside the monitor's
 * BRIDGES step): the new pair written into the deployment record, so the keeper (once its DEPLOYMENT is printed again
 * from the record and deployed, pnpm config:from-record) and every hand command work its parks, its conversions and its
 * CCIP FAILUREs as they work the deploy's. Before it writes, it checks, read now: both chains' ids; each adapter has code;
 * the pair names each other, each on the other's chain; each holds the deploy's adapter's router, token and remote
 * selector on its chain, and the Bittensor half its AlphaVault (pairFieldProblems); neither is listed already. Then each
 * adapter's creation block (its first block with code: an archive node on Bittensor). It sends nothing; `save` writes the
 * record. */
export async function addPairCommand(
  ctx: SchedulerCtx,
  rec: DeploymentRecordV32,
  o: {
    bitAdapter: Address;
    baseAdapter: Address;
    now: number;
    save(rec: DeploymentRecordV32): void;
    /** R4-O round 4 (Minor 2): the Bittensor block to read the deploy's AlphaVault's migration target at, when add-pair
     * was missed during the notice: recorded as add-pair would have, then held to the same re-read and finish rules */
    targetBlock?: number;
  },
): Promise<{ ok: boolean; lines: string[] }> {
  await checkChains(ctx);
  const bit = getAddress(o.bitAdapter);
  const base = getAddress(o.baseAdapter);
  const listed = [
    { bitAdapter: rec.plan.addresses.bitAdapter, baseAdapter: rec.plan.addresses.baseAdapter },
    ...(rec.pairs ?? []),
  ];
  for (const p of listed) {
    if (same(p.bitAdapter, bit) || same(p.baseAdapter, base)) {
      return { ok: false, lines: [`The record lists ${same(p.bitAdapter, bit) ? bit : base} already, in the pair ${getAddress(p.bitAdapter)} (Bittensor) and ${getAddress(p.baseAdapter)} (Base); nothing written.`] };
    }
  }
  const problems: string[] = [];
  const notes: string[] = [];
  const liveTarget: { vault?: Address; target?: Address; block?: number } = {};
  let bitHead: bigint | undefined;
  // --target-block: the record add-pair would have written then (the target read at that block), for the checks to judge
  const withTargetAt = async (n: number): Promise<RecordV32> => {
    const vault = getAddress((await readNow("the deploy's Bittensor adapter's alphaVault()", () => read(ctx.rpc, "bittensor", { address: getAddress(rec.plan.addresses.bitAdapter), abi: PAIR_ABI, functionName: "alphaVault" }))) as Address);
    // the pair's own AlphaVault, as the record at block n: the recorded branch reads the target again at n and decides
    const target = getAddress((await readNow(`the Bittensor adapter ${bit}'s alphaVault()`, () => read(ctx.rpc, "bittensor", { address: bit, abi: PAIR_ABI, functionName: "alphaVault" }))) as Address);
    const entry: RecordPair = { bitAdapter: bit, baseAdapter: base, blocks: { base: 0, bittensor: 0 }, addedAt: "", alphaTarget: { vault, target, block: n } };
    return { ...rec, pairs: [...(rec.pairs ?? []), entry] };
  };
  const peer = async (chain: ChainName, a: Address) => ({
    remote: getAddress((await readNow(`${chainLabel(chain)} adapter ${a}'s remoteAdapter()`, () => read(ctx.rpc, chain, { address: a, abi: PAIR_ABI, functionName: "remoteAdapter" }))) as Address),
    chain: BigInt((await readNow(`${chainLabel(chain)} adapter ${a}'s remoteChainId()`, () => read(ctx.rpc, chain, { address: a, abi: PAIR_ABI, functionName: "remoteChainId" }))) as bigint),
  });
  for (const [chain, a] of [
    ["bittensor", bit],
    ["base", base],
  ] as const) {
    const code = (await readNow(`${chainLabel(chain)}'s code at ${a}`, () => ctx.rpc.request(chain, "eth_getCode", [a, "latest"]))) as string;
    if (code === "0x") problems.push(`${chainLabel(chain)}: ${a} has no code`);
  }
  if (!problems.length) {
    const b = await peer("bittensor", bit);
    const s = await peer("base", base);
    if (!same(b.remote, base) || b.chain !== BigInt(ctx.targets.base.chainId)) problems.push(`the Bittensor adapter ${bit} names ${b.remote} on chain ${b.chain} as its peer, not ${base} on ${ctx.targets.base.chainId}`);
    if (!same(s.remote, bit) || s.chain !== BigInt(ctx.targets.bittensor.chainId)) problems.push(`the Base adapter ${base} names ${s.remote} on chain ${s.chain} as its peer, not ${bit} on ${ctx.targets.bittensor.chainId}`);
    for (const [chain, a] of [
      ["bittensor", bit],
      ["base", base],
    ] as const) {
      const said: string[] = [];
      // on Bittensor at one block, the one the AlphaVault's live target is recorded at (R4-O round 3)
      const at = chain === "bittensor" ? (bitHead = hexToBigInt((await readNow("Bittensor's head", () => ctx.rpc.request("bittensor", "eth_blockNumber", []))) as Hex)) : undefined;
      const checked = chain === "bittensor" && o.targetBlock !== undefined ? await withTargetAt(o.targetBlock) : rec;
      const f = await readNow(`${chainLabel(chain)} adapter ${a}'s settings`, () => pairFieldProblems(ctx, checked, chain, a, at, said, chain === "bittensor" ? liveTarget : undefined));
      for (const x of f) problems.push(`${chainLabel(chain)} adapter ${a}: ${x}`);
      for (const x of said) notes.push(`${chainLabel(chain)} adapter ${a}: ${x}`);
    }
    // merge 7b (phase 1 concern 3): the new pair's inbound model, held to its own Base adapter's pair (a new pair may
    // carry recalibrated figures; its two copies must still be one model, as verify holds the deploy's)
    for (const [inbound, own] of [
      ["inboundGasBase", "gasBase"],
      ["inboundGasPerEntry", "gasPerEntry"],
    ] as const) {
      const got = (await readNow(`the Bittensor adapter ${bit}'s ${inbound}()`, () => read(ctx.rpc, "bittensor", { address: bit, abi: PAIR_ABI, functionName: inbound }))) as bigint;
      const want = (await readNow(`the Base adapter ${base}'s ${own}()`, () => read(ctx.rpc, "base", { address: base, abi: PAIR_ABI, functionName: own }))) as bigint;
      if (got !== want) {
        problems.push(
          `the Bittensor adapter ${bit}'s ${inbound}() is ${got}, not its Base adapter ${base}'s ${own}(), ${want}: the lane's inbound gas model is one model in two copies, and deliverParked's gas requirement would not be what CCIP gives a delivery`,
        );
      }
    }
  }
  if (problems.length) return { ok: false, lines: [`Not a pair of Cascade's lane: ${problems.join("; ")}. Nothing written.`] };
  const blocks = {
    bittensor: await readNow(`the Bittensor adapter ${bit}'s creation block (an archive node)`, () => firstBlockWithCode(ctx.rpc, "bittensor", bit)),
    base: await readNow(`the Base adapter ${base}'s creation block`, () => firstBlockWithCode(ctx.rpc, "base", base)),
  };
  const pair: RecordPair = {
    bitAdapter: bit,
    baseAdapter: base,
    blocks,
    addedAt: new Date(o.now).toISOString(),
    ...(liveTarget.vault && liveTarget.target && bitHead !== undefined
      ? { alphaTarget: { vault: liveTarget.vault, target: liveTarget.target, block: liveTarget.block ?? Number(bitHead) } }
      : {}),
  };
  o.save({ ...rec, pairs: [...(rec.pairs ?? []), pair] });
  return {
    ok: true,
    lines: [
      `Added the pair ${bit} (Bittensor, created at block ${blocks.bittensor}) and ${base} (Base, created at block ${blocks.base}) to the record. Its halves name each other and share the deploy's router, token and selectors.`,
      ...notes,
      "Next: print the keeper's DEPLOYMENT again (pnpm config:from-record, from keeper/), paste it into wrangler.jsonc, and deploy the keeper. Until then the Worker doesn't watch this pair's parks or CCIP FAILUREs; hand commands do from now.",
    ],
  };
}

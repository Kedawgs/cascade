import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Address, encodeAbiParameters, getAddress, type Hex, keccak256, numberToHex, stringToBytes } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { type ForgeArtifact, immutableVariables, LIBRARY_DEPLOY_ADDRESS } from "../src/artifacts.ts";
import { preauditArtifact } from "../src/builds.ts";
import { BASE_V3, type ChainName, LIVE, paths, targets } from "../src/config.ts";
import { loadRecord } from "../src/record.ts";
import type { Rpc } from "../src/rpc.ts";
import { type BuildRefV32, type BuildV32, deployDataV32, freezeBuildV32, loadBuildV32, type SourceV32, writeBuildV32 } from "../src/v32/build.ts";
import {
  codeFailures,
  codeReadBacksV32,
  domainSeparatorV32,
  expectedRuntime,
  expectedRuntimeV32,
  fillImmutables,
  immutableNamesOf,
  immutableValuesV32,
  immutableWordsV32,
  linkAgreementFailures,
  linkFailures,
  plannedLibrariesV32,
  stripMetadata,
} from "../src/v32/code.ts";
import { type DeploymentRecordV32, deployV32, realDepsV32 } from "../src/v32/deploy.ts";
import { addressMapping, CONTRACTS_V32, type PlannedStepV32, type PlanV32, type V32StepId } from "../src/v32/plan.ts";
import { SETTINGS_V32_LAUNCH } from "../src/v32/settings.ts";
import { fakeChains, SIGNERS, tempDir, testPlan } from "./v32-chains.ts";
import { planV32 } from "./v32-fixtures.ts";

// Task 45: v3.2's code read-back (spec §7 step 3, rev 12 M-1, rev 13). Each contract's, library's and lens's runtime
// code on chain must be the frozen build's, byte for byte with the CBOR metadata stripped, with every library link and
// every immutable filled in from the plan, never blanked. Every test reads the real build (contracts/out, read only,
// frozen here as a deploy freezes it) and fake chains: nothing is sent, and no key, network or forge is used.

const CONTRACTS = paths({}).contractsDir;
const OUT = join(CONTRACTS, "out");
const SOURCE: SourceV32 = { commit: "c0ffee".padEnd(40, "0"), tree: "7ee".padEnd(40, "0"), dirty: [] };
const IDS = { rehearsal: chainIds("rehearsal"), live: chainIds("live") };

let build: BuildV32;
let plan: PlanV32;
/** Each planned contract's runtime code as an honest deploy of the plan leaves it on the forks (the expected code). */
let honest: Record<V32StepId, Hex>;

function chainIds(kind: "live" | "rehearsal"): Record<ChainName, number> {
  const t = targets({})[kind];
  return { base: t.base.chainId, bittensor: t.bittensor.chainId };
}

beforeAll(async () => {
  build = (await freezeBuildV32(CONTRACTS, SOURCE)).build;
  plan = planV32();
  honest = Object.fromEntries(plan.steps.map((s) => [s.id, expectedRuntimeV32(build, plan, s.id, IDS.rehearsal)])) as Record<V32StepId, Hex>;
});

const step = (p: PlanV32, id: V32StepId): PlannedStepV32 => p.steps.find((s) => s.id === id)!;
const nameOf = (id: V32StepId) => CONTRACTS_V32[id].contract.split(":")[1];
const contractOf = (id: V32StepId) => build.contracts[nameOf(id)];
const forge = (id: V32StepId): ForgeArtifact & { deployedBytecode: { object: Hex } } => {
  const [path, name] = CONTRACTS_V32[id].contract.split(":");
  return JSON.parse(readFileSync(join(OUT, basename(path), `${name}.json`), "utf8"));
};
/** The AST id of `id`'s immutable `name`, as the frozen copy names it. */
const idOf = (id: V32StepId, name: string): string => {
  const hit = Object.entries(contractOf(id).immutables).find(([, v]) => v.name === name);
  if (!hit) throw new Error(`${nameOf(id)} has no immutable ${name}`);
  return hit[0];
};
const rangesOf = (id: V32StepId, name: string) => contractOf(id).deployedBytecode.immutableReferences[idOf(id, name)];
/** The 32 bytes of `code` at byte `start`, as hex. */
const word = (code: Hex, start: number): Hex => `0x${code.slice(2 + start * 2, 2 + start * 2 + 64)}`;
/** `code` with the bytes at `start` replaced by `hex`. */
const put = (code: Hex, start: number, hex: Hex): Hex => `0x${code.slice(2, 2 + start * 2)}${hex.slice(2)}${code.slice(2 + start * 2 + (hex.length - 2))}` as Hex;
/** `code` with every place of `id`'s immutable `name` holding `value` (a 32-byte word), as a constructor given it would. */
const withImmutable = (id: V32StepId, code: Hex, name: string, value: Hex): Hex => rangesOf(id, name).reduce((c, r) => put(c, r.start, value), code);
const addressWord = (a: Address): Hex => encodeAbiParameters([{ type: "address" }], [a]);
const other = getAddress(`0x${"5e".repeat(20)}`);
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
const ZERO20 = `0x${"00".repeat(20)}` as Hex;

/** `code` with every immutable place and every link of `id`'s contract zeroed: what the plan fills in, left out. */
function blanked(id: V32StepId, code: Hex): Hex {
  const d = contractOf(id).deployedBytecode;
  let out = code.toLowerCase() as Hex;
  for (const r of Object.values(d.immutableReferences).flat()) out = put(out, r.start, ZERO32);
  for (const libs of Object.values(d.linkReferences)) for (const at of Object.values(libs)) for (const r of at) out = put(out, r.start, ZERO20);
  return out;
}

/** The single failure in `failures` is `who`'s code comparison, first differing inside one of `ranges` and naming `what`
 * there ("the immutable coldkey", "the reference to CascadeStakeLib"). */
function failsInside(failures: string[], who: string, what: string, ranges: { start: number; length: number }[]) {
  expect(failures, who).toHaveLength(1);
  const m = failures[0].match(new RegExp(`^${who}: its runtime code is not the frozen build's, filled in from the plan: they first differ at byte (\\d+) \\(${what}\\)$`));
  expect(m, failures[0]).not.toBeNull();
  const at = Number(m![1]);
  expect(ranges.some((r) => at >= r.start && at < r.start + r.length), `${who}: byte ${at}`).toBe(true);
}

/** A byte of `id`'s code from `from` on that is no immutable place and no link. */
function plainByte(id: V32StepId, from: number): number {
  const d = contractOf(id).deployedBytecode;
  const taken = [...Object.values(d.immutableReferences).flat(), ...Object.values(d.linkReferences).flatMap((l) => Object.values(l).flat())];
  for (let at = from; ; at++) if (!taken.some((r) => at >= r.start && at < r.start + r.length)) return at;
}

/** The stamp's domain separator by CascadeFormulas.domainSeparator's own formula (abi.encode, then keccak256), not viem's
 * hashDomain: the typehash, the name "Cascade", the version "3.2", the chain id and the verifying contract. */
const solidityDomainSeparator = (chainId: number, at: Address): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [keccak256(stringToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak256(stringToBytes("Cascade")), keccak256(stringToBytes("3.2")), BigInt(chainId), at],
    ),
  );

/** Every planned contract's immutables as its constructor sets them, written out by hand, independently of code.ts's
 * immutableValuesV32 (Task 45's review, I-1): from the plan's addresses and treasury, the chain ids the code runs on,
 * the config constants (LIVE, BASE_V3) and the launch settings, never from the plan's recorded arguments. Each value is
 * a 32-byte word (a uint64 and an address are left-padded like a uint256), with the constructor argument it fills. */
function expectedImmutables(p: PlanV32, ids: Record<ChainName, number>): Record<V32StepId, Record<string, Hex>> {
  const a = p.addresses;
  const s = SETTINGS_V32_LAUNCH;
  const addr = (x: Address) => encodeAbiParameters([{ type: "address" }], [x]);
  const uint = (x: bigint | number) => encodeAbiParameters([{ type: "uint256" }], [BigInt(x)]);
  const own = (id: V32StepId) => ({ [LIBRARY_DEPLOY_ADDRESS]: addr(a[id]) }); // under via-IR, the library's own address
  return {
    // CcipBittensorAdapter(Config c, IAlphaVault alphaVault_, uint256 inboundGasBase_, uint256 inboundGasPerEntry_):
    // CcipAdapterBase(c) on the Bittensor side
    bitAdapter: {
      router: addr(LIVE.bittensor.ROUTER), // c.router: CCIP's router on Bittensor
      token: addr(LIVE.bittensor.TOKEN), // c.token: FM-TAO on Bittensor
      localChainId: uint(LIVE.bittensor.CHAIN_ID), // c.localChainId: 964
      remoteChainId: uint(LIVE.base.CHAIN_ID), // c.remoteChainId: 8453
      remoteSelector: uint(LIVE.base.SELECTOR), // c.remoteSelector: CCIP's selector for Base
      remoteAdapter: addr(a.baseAdapter), // c.remoteAdapter: its peer, the Base adapter
      gasBase: uint(s.gas.towardBase.base), // c.gasBase: its gas model toward Base
      gasPerEntry: uint(s.gas.towardBase.perEntry), // c.gasPerEntry
      maxMessageValue: uint(s.adapters.maxMessageValue.bittensor), // c.maxMessageValue
      treasury: addr(p.roles.treasury), // c.treasury
      alphaVault: addr(LIVE.ALPHA_VAULT), // alphaVault_
      inboundGasBase: uint(s.gas.towardBittensor.base), // inboundGasBase_: the lane's inbound model, the Base adapter's own (R4)
      inboundGasPerEntry: uint(s.gas.towardBittensor.perEntry), // inboundGasPerEntry_
    },
    // CcipBaseAdapter(Config c, uint256 minSendAmount_): CcipAdapterBase(c) on the Base side
    baseAdapter: {
      router: addr(LIVE.base.ROUTER), // c.router: CCIP's router on Base
      token: addr(LIVE.base.TOKEN), // c.token: FM-TAO on Base
      localChainId: uint(LIVE.base.CHAIN_ID), // c.localChainId: 8453
      remoteChainId: uint(LIVE.bittensor.CHAIN_ID), // c.remoteChainId: 964
      remoteSelector: uint(LIVE.bittensor.SELECTOR), // c.remoteSelector: CCIP's selector for Bittensor
      remoteAdapter: addr(a.bitAdapter), // c.remoteAdapter: its peer, the Bittensor adapter
      gasBase: uint(s.gas.towardBittensor.base), // c.gasBase: its gas model toward Bittensor
      gasPerEntry: uint(s.gas.towardBittensor.perEntry), // c.gasPerEntry
      maxMessageValue: uint(s.adapters.maxMessageValue.base), // c.maxMessageValue
      treasury: addr(p.roles.treasury), // c.treasury
      minSendAmount: uint(s.adapters.minSendAmount), // minSendAmount_
    },
    payoutMath: {}, // all pure: no immutable
    stakeLib: own("stakeLib"),
    payoutLib: own("payoutLib"),
    batchLib: own("batchLib"),
    hotkeyLib: own("hotkeyLib"),
    // CascadeVault(Params p): CascadeBase(p.owner, p.guardian, p.bridge, p.msPerBlock), then its own two
    vault: {
      DOMAIN_SEPARATOR: solidityDomainSeparator(ids.bittensor, a.vault), // CascadeFormulas.domainSeparator(address(this))
      MS_PER_BLOCK: uint(s.vault.msPerBlock), // p.msPerBlock: Bittensor's 7,200 ms, calibrated twice as fast as its 12 s (Revision 28)
      coldkey: addressMapping(a.vault), // ADDRESS_MAPPING of address(this), checked equal to p.expectedColdkey
      launchChain: uint(s.vault.launchChain), // p.launchChain: Base
    },
    // CascadeVaultLens(address vault): CascadeBaseLens(vault), then the vault's coldkey
    vaultLens: { target: addr(a.vault), coldkey: addressMapping(a.vault) },
    // CascadeTwapOracle(taoWethPool_, wethUsdcPool_, tao_, weth_, usdc_)
    oracle: {
      taoWethPool: addr(BASE_V3.TAO_WETH_POOL),
      wethUsdcPool: addr(BASE_V3.WETH_USDC_POOL),
      tao: addr(LIVE.base.TOKEN),
      weth: addr(BASE_V3.WETH),
      usdc: addr(BASE_V3.USDC),
    },
    // CascadeFrontDoor(Params p): CascadeBase(p.owner, p.guardian, p.bridge, p.msPerBlock), then its own five
    frontDoor: {
      DOMAIN_SEPARATOR: solidityDomainSeparator(ids.base, a.frontDoor), // CascadeFormulas.domainSeparator(address(this))
      MS_PER_BLOCK: uint(s.frontDoor.msPerBlock), // p.msPerBlock: Base's 120 ms, calibrated twice as fast as its 0.2 s (Revision 28)
      asset: addr(LIVE.base.TOKEN), // p.asset: FM-TAO on Base
      vaultChain: uint(LIVE.bittensor.CHAIN_ID), // p.vaultChain: 964
      vault: addr(a.vault), // p.vault: the planned vault
      usdc: addr(BASE_V3.USDC), // p.usdc
      treasury: addr(p.roles.treasury), // p.treasury
    },
    // CascadeStaker(Params p)
    staker: { usdc: addr(BASE_V3.USDC), tao: addr(LIVE.base.TOKEN), frontDoor: addr(a.frontDoor) }, // p.usdc, p.tao, p.frontDoor
    // CascadeDoorLens(address frontDoor): CascadeBaseLens(frontDoor)
    doorLens: { target: addr(a.frontDoor) },
  };
}

/** A chain that answers eth_getCode from `codes` (by chain and address) and eth_getBalance from `balances`. */
function chainsWith(codes: Partial<Record<ChainName, Record<string, Hex>>>, balances: Partial<Record<ChainName, Record<string, bigint>>> = {}) {
  const calls: { chain: ChainName; method: string; params: unknown[] }[] = [];
  const lower = (m: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const code = { base: lower(codes.base), bittensor: lower(codes.bittensor) } as Record<ChainName, Record<string, Hex>>;
  const bal = { base: lower(balances.base), bittensor: lower(balances.bittensor) } as Record<ChainName, Record<string, bigint>>;
  const rpc: Rpc = {
    async request(chain, method, params) {
      calls.push({ chain, method, params });
      const a = String(params[0]).toLowerCase();
      if (method === "eth_getCode") return code[chain][a] ?? "0x";
      if (method === "eth_getBalance") return numberToHex(bal[chain][a] ?? 0n);
      throw new Error(`unexpected ${method} on ${chain}`);
    },
  };
  return { ctx: { rpc, targets: targets({}).rehearsal }, calls };
}

/** The honest deployment of `p` on the forks, with the code at `changed` replaced. */
function deployed(p: PlanV32, changed: Partial<Record<V32StepId, Hex>> = {}, codes: Record<V32StepId, Hex> = honest) {
  const out: Partial<Record<ChainName, Record<string, Hex>>> = { base: {}, bittensor: {} };
  for (const s of p.steps) out[s.chain]![p.addresses[s.id]] = changed[s.id] ?? codes[s.id];
  return out;
}

/** A frozen build written to a builds folder of its own, and its record's reference. */
function frozenAt(b: BuildV32): { buildsDir: string; ref: BuildRefV32 } {
  const buildsDir = tempDir("code-builds");
  const text = `${JSON.stringify(b, null, 2)}\n`;
  return { buildsDir, ref: writeBuildV32(buildsDir, { text, hash: keccak256(stringToBytes(text)) }) };
}

const readBack = async (codes: Partial<Record<ChainName, Record<string, Hex>>>, p: PlanV32 = plan, b: BuildV32 = build) => {
  const { buildsDir, ref } = frozenAt(b);
  const w = chainsWith(codes);
  return { ...(await codeReadBacksV32(w.ctx, { plan: p, build: ref }, buildsDir)), calls: w.calls };
};

describe("the frozen copy names each immutable (Task 44's concern 4)", () => {
  it("namesEveryImmutableFromTheAst: every key of every planned contract's immutable references, a base contract's too", () => {
    for (const id of Object.keys(CONTRACTS_V32) as V32StepId[]) {
      const c = contractOf(id);
      expect(Object.keys(c.immutables).sort(), nameOf(id)).toEqual(Object.keys(c.deployedBytecode.immutableReferences).sort());
    }
    const names = (id: V32StepId) => Object.values(contractOf(id).immutables).map((v) => `${v.declaredIn.split(":")[1]}.${v.name}: ${v.type}`).sort();
    expect(names("vault")).toEqual(["CascadeBase.DOMAIN_SEPARATOR: bytes32", "CascadeBase.MS_PER_BLOCK: uint64", "CascadeVault.coldkey: bytes32", "CascadeVault.launchChain: uint64"]);
    expect(names("frontDoor")).toEqual([
      "CascadeBase.DOMAIN_SEPARATOR: bytes32",
      "CascadeBase.MS_PER_BLOCK: uint64",
      "CascadeFrontDoor.asset: contract IERC20Metadata",
      "CascadeFrontDoor.treasury: address",
      "CascadeFrontDoor.usdc: contract IERC20",
      "CascadeFrontDoor.vault: address",
      "CascadeFrontDoor.vaultChain: uint64",
    ]);
    expect(names("vaultLens")).toEqual(["CascadeBaseLens.target: address", "CascadeVaultLens.coldkey: bytes32"]);
    expect(names("doorLens")).toEqual(["CascadeBaseLens.target: address"]);
    const adapterBase = ["gasBase", "gasPerEntry", "localChainId", "maxMessageValue", "remoteAdapter", "remoteChainId", "remoteSelector", "router", "token", "treasury"];
    const bare = (id: V32StepId) => Object.values(contractOf(id).immutables).map((v) => v.name).sort();
    // R4: the lane's inbound gas model, deliverParked's requirement
    expect(bare("bitAdapter")).toEqual(["alphaVault", "inboundGasBase", "inboundGasPerEntry", ...adapterBase].sort());
    expect(bare("baseAdapter")).toEqual([...adapterBase, "minSendAmount"].sort());
    expect(bare("oracle")).toEqual(["tao", "taoWethPool", "usdc", "weth", "wethUsdcPool"]);
    expect(bare("staker")).toEqual(["frontDoor", "tao", "usdc"]);
    // under via-IR, a library with a state-changing function guards it with its own address, solc's key; the payout
    // math, all pure, has none
    for (const id of ["stakeLib", "payoutLib", "batchLib", "hotkeyLib"] as const) expect(bare(id), id).toEqual([LIBRARY_DEPLOY_ADDRESS]);
    expect(bare("payoutMath")).toEqual([]);
    // each id is the declaration's, read independently: a walk of the declaring file's own artifact
    for (const id of Object.keys(CONTRACTS_V32) as V32StepId[]) {
      for (const [key, v] of Object.entries(contractOf(id).immutables)) {
        if (key === LIBRARY_DEPLOY_ADDRESS) continue;
        const file = v.declaredIn.split(":")[0];
        const dir = join(OUT, basename(file));
        const ast = JSON.parse(readFileSync(join(dir, readdirSync(dir)[0]), "utf8")).ast;
        const found: string[] = [];
        const walk = (n: unknown): void => {
          if (!n || typeof n !== "object") return;
          if (Array.isArray(n)) return n.forEach(walk);
          const o = n as Record<string, unknown>;
          if (o.nodeType === "VariableDeclaration" && String(o.id) === key) found.push(String(o.name));
          Object.values(o).forEach(walk);
        };
        walk(ast);
        expect(found, `${nameOf(id)} ${key}`).toEqual([v.name]);
      }
    }
  });

  it("refuses an artifact without its AST, an id no source declares, and a base's artifact from another build", () => {
    const j = forge("vault");
    expect(() => immutableVariables(OUT, CONTRACTS_V32.vault.contract, { ...j, ast: undefined })).toThrow(/has no AST of src\/CascadeVault.sol \(forge builds one with ast = true\)/);
    // the ids no source declares are asked of a copy of one compile's artifacts (the vault's, its base's, the staker's and
    // the front door's): after an incremental build contracts/out keeps an unchanged file's artifact from an older
    // compile (its AST ids another run's), which the walk refuses first whatever id is asked (below, M2), and rightly
    const one = tempDir("one-compile");
    for (const d of ["CascadeVault.sol", "CascadeBase.sol", "CascadeStaker.sol", "CascadeFrontDoor.sol"]) {
      mkdirSync(join(one, d));
      for (const f of readdirSync(join(OUT, d))) copyFileSync(join(OUT, d, f), join(one, d, f));
    }
    const refs = { ...j.deployedBytecode.immutableReferences, "999999": [{ start: 0, length: 32 }] };
    expect(() => immutableVariables(one, CONTRACTS_V32.vault.contract, { ...j, deployedBytecode: { ...j.deployedBytecode, immutableReferences: refs } })).toThrow(
      /no source it was compiled with declares its immutable of AST id 999999/,
    );
    // an immutable of a contract the staker was compiled with but does not inherit (the front door's asset): not its
    const staker = forge("staker");
    const assetId = idOf("frontDoor", "asset");
    expect(Object.keys(staker.metadata?.sources ?? {})).toContain("src/CascadeFrontDoor.sol");
    // the walk reads the front door's artifact (the staker imports it), finds `asset` declared there, and leaves it
    expect(immutableVariables(one, CONTRACTS_V32.staker.contract, staker)).toEqual(contractOf("staker").immutables);
    const foreign = { ...staker.deployedBytecode.immutableReferences, [assetId]: [{ start: 0, length: 32 }] };
    expect(() => immutableVariables(one, CONTRACTS_V32.staker.contract, { ...staker, deployedBytecode: { ...staker.deployedBytecode, immutableReferences: foreign } })).toThrow(
      new RegExp(`no source it was compiled with declares its immutable of AST id ${assetId}`),
    );
    // CascadeBase's artifact from another text of CascadeBase.sol: its ids mean nothing here
    const out = tempDir("out");
    for (const d of ["CascadeVault.sol", "CascadeBase.sol"]) {
      mkdirSync(join(out, d));
      for (const f of readdirSync(join(OUT, d))) copyFileSync(join(OUT, d, f), join(out, d, f));
    }
    const base = join(out, "CascadeBase.sol", "CascadeBase.json");
    const b = JSON.parse(readFileSync(base, "utf8"));
    b.metadata.sources["src/CascadeBase.sol"].keccak256 = `0x${"00".repeat(32)}`;
    writeFileSync(base, JSON.stringify(b));
    expect(() => immutableVariables(out, CONTRACTS_V32.vault.contract, j)).toThrow(/CascadeBase.sol is not from the build of CascadeVault/);
    // Task 45's review, M2: CascadeBase's artifact from another compile of the same text by the same compiler (an
    // incremental build that kept it): its source unit is not the one the vault's own import names, so its ids are not
    // the vault's
    const vaultImport = (j.ast?.nodes ?? []).find((n) => n.nodeType === "ImportDirective" && n.absolutePath === "src/CascadeBase.sol") as { sourceUnit?: number } | undefined;
    expect(vaultImport?.sourceUnit).toBe(JSON.parse(readFileSync(join(OUT, "CascadeBase.sol", "CascadeBase.json"), "utf8")).ast.id);
    const again = JSON.parse(readFileSync(join(OUT, "CascadeBase.sol", "CascadeBase.json"), "utf8"));
    again.ast.id += 7;
    writeFileSync(base, JSON.stringify(again));
    expect(() => immutableVariables(out, CONTRACTS_V32.vault.contract, j)).toThrow(
      new RegExp(`CascadeBase.sol is from another compile than CascadeVault \\(its source unit is ${again.ast.id}, and CascadeVault imports ${vaultImport!.sourceUnit}\\): rebuild with forge build --force; nothing frozen or sent`),
    );
    // and with the right one back, the vault's names resolve as before
    again.ast.id -= 7;
    writeFileSync(base, JSON.stringify(again));
    expect(immutableVariables(out, CONTRACTS_V32.vault.contract, j)).toEqual(contractOf("vault").immutables);
  });

  it("aFrozenCopysImmutableNamesAreWhatTheCheckReads: the copy's names fill the code, never contracts/out's; a copy without them is refused", async () => {
    // an honest deployment passes with the honest copy
    expect((await readBack(deployed(plan))).failures).toEqual([]);
    // the same deployment, read with a copy whose vault names its coldkey's places as the launch chain's and the
    // launch chain's as the coldkey's: contracts/out names them right, and the check reads the copy, so it fails
    const swapped = structuredClone(build);
    const im = swapped.contracts.CascadeVault.immutables;
    const [k, l] = [idOf("vault", "coldkey"), idOf("vault", "launchChain")];
    [im[k], im[l]] = [im[l], im[k]];
    const r = await readBack(deployed(plan), plan, swapped);
    const first = rangesOf("vault", "coldkey").reduce((a, b) => (b.start < a.start ? b : a));
    // the copy calls the coldkey's places the launch chain's, and the comparison says so
    failsInside(r.failures, "Bittensor CascadeVault", "the immutable launchChain", [first]);
    // a copy frozen before Task 45 (no names) cannot be checked filled in, and nothing is read
    const bare = structuredClone(build) as unknown as { contracts: Record<string, { immutables?: unknown }> };
    delete bare.contracts.CascadeFrontDoor.immutables;
    const { buildsDir, ref } = frozenAt(bare as unknown as BuildV32);
    const w = chainsWith(deployed(plan));
    await expect(codeReadBacksV32(w.ctx, { plan, build: ref }, buildsDir)).rejects.toThrow(
      /the frozen build names no variable for CascadeFrontDoor's immutable \d+ \(a copy frozen before Task 45 names none\): its code cannot be checked filled in; nothing read/,
    );
    expect(w.calls).toEqual([]);
    // Task 45's review, M5: a frozen code with no metadata tail is refused before anything is read too
    const tailless = structuredClone(build);
    const lens = tailless.contracts.CascadeDoorLens.deployedBytecode;
    lens.object = stripMetadata(lens.object);
    const t = frozenAt(tailless);
    const w2 = chainsWith(deployed(plan));
    await expect(codeReadBacksV32(w2.ctx, { plan, build: t.ref }, t.buildsDir)).rejects.toThrow(
      /the frozen build's CascadeDoorLens ends in no CBOR metadata tail, so it cannot be compared with its metadata stripped; nothing read/,
    );
    expect(w2.calls).toEqual([]);
  });
});

describe("Task 45: each contract's runtime code, filled in from the plan, never blanked", () => {
  it("stripRemovesExactlyTheCborTail: the tail whose length is the code's last two bytes, and nothing else", () => {
    for (const id of Object.keys(CONTRACTS_V32) as V32StepId[]) {
      const code = contractOf(id).deployedBytecode.object.toLowerCase() as Hex;
      const len = Number.parseInt(code.slice(-4), 16);
      const stripped = stripMetadata(code);
      expect((stripped.length - 2) / 2, nameOf(id)).toBe((code.length - 2) / 2 - len - 2);
      expect(code.startsWith(stripped)).toBe(true);
      // the tail is solc's CBOR map: its IPFS hash, then solc's version, 0.8.38
      const tail = code.slice(stripped.length);
      expect(tail.startsWith("a2646970667358221220")).toBe(true);
      expect(tail.endsWith(`64736f6c6343000826${len.toString(16).padStart(4, "0")}`)).toBe(true);
    }
    expect(() => stripMetadata("0x")).toThrow(/no CBOR metadata tail/);
    expect(() => stripMetadata("0x6080604052")).toThrow(/no CBOR metadata tail/);
    // a length longer than the code, and a tail that is not a CBOR map
    expect(() => stripMetadata("0x60806040ffff")).toThrow(/no CBOR metadata tail/);
    expect(() => stripMetadata("0x6080604060010001")).toThrow(/no CBOR metadata tail/);
  });

  it("fillsEveryRangeOfEachImmutableByAstId: the vault's first immutable's 8 places and every other, each a 32-byte word; nothing else changes", () => {
    const vault = plan.addresses.vault;
    const v = honest.vault;
    expect(rangesOf("vault", "coldkey")).toHaveLength(8);
    for (const r of rangesOf("vault", "coldkey")) expect(word(v, r.start)).toBe(plan.vaultColdkey);
    for (const r of rangesOf("vault", "launchChain")) expect(word(v, r.start)).toBe(encodeAbiParameters([{ type: "uint64" }], [8_453n]));
    for (const r of rangesOf("vault", "MS_PER_BLOCK")) expect(word(v, r.start)).toBe(encodeAbiParameters([{ type: "uint64" }], [7_200n]));
    for (const r of rangesOf("vault", "DOMAIN_SEPARATOR")) expect(word(v, r.start)).toBe(domainSeparatorV32(IDS.rehearsal.bittensor, vault));
    // never blanked: no place of any immutable of any planned contract is left as the build has it (zero), and every
    // other byte, the links aside, is the build's
    for (const id of Object.keys(CONTRACTS_V32) as V32StepId[]) {
      const c = contractOf(id);
      for (const [key, ranges] of Object.entries(c.deployedBytecode.immutableReferences)) {
        for (const r of ranges) {
          expect(r.length).toBe(32);
          expect(word(c.deployedBytecode.object, r.start), `${nameOf(id)} ${key} unfilled in the build`).toBe(ZERO32);
          expect(word(honest[id], r.start), `${nameOf(id)} ${c.immutables[key].name} at ${r.start}`).not.toBe(ZERO32);
        }
      }
      expect(blanked(id, honest[id]), nameOf(id)).toBe(blanked(id, c.deployedBytecode.object));
    }
    // every filled word is the independent table's, on the forks' chain ids and on mainnet's (Task 45's review, I-1)
    for (const kind of ["rehearsal", "live"] as const) {
      const table = expectedImmutables(plan, IDS[kind]);
      for (const id of Object.keys(CONTRACTS_V32) as V32StepId[]) {
        const c = contractOf(id);
        const code = kind === "rehearsal" ? honest[id] : expectedRuntimeV32(build, plan, id, IDS.live);
        expect(Object.keys(table[id]).sort(), `${nameOf(id)}: the table names every immutable`).toEqual(Object.values(c.immutables).map((v) => v.name).sort());
        for (const [key, ranges] of Object.entries(c.deployedBytecode.immutableReferences)) {
          const name = c.immutables[key].name;
          for (const r of ranges) expect(word(code, r.start), `${kind} ${nameOf(id)}.${name} at ${r.start}`).toBe(table[id][name]);
        }
      }
    }
    // fillImmutables itself: every place of each key gets its variable's word; a key with no name, a variable with no
    // planned value and a value that is not a 32-byte word are refused (never blanked); so is a place that is not zero
    const c = contractOf("vault");
    const refs = c.deployedBytecode.immutableReferences;
    const names = immutableNamesOf(c);
    const words = immutableWordsV32(c, immutableValuesV32(plan, "vault", IDS.rehearsal));
    const filled = fillImmutables(c.deployedBytecode.object, refs, names, words);
    for (const [key, ranges] of Object.entries(refs)) for (const r of ranges) expect(word(filled, r.start)).toBe(words[names[key]]);
    expect(() => fillImmutables(c.deployedBytecode.object, refs, { ...names, [k0(refs)]: "" }, words)).toThrow(/has no variable name; nothing filled \(never blanked\)/);
    const { coldkey: _, ...noColdkey } = words;
    expect(() => fillImmutables(c.deployedBytecode.object, refs, names, noColdkey)).toThrow(/no planned value for the immutable coldkey; nothing filled \(never blanked\)/);
    expect(() => fillImmutables(c.deployedBytecode.object, refs, names, { ...words, coldkey: "0x01" })).toThrow(/the planned value of coldkey is not a 32-byte word/);
    expect(() => fillImmutables(filled, refs, names, words)).toThrow(/is not .*'s unfilled place/);
    // expectedRuntimeV32 refuses a plan that gives an immutable no value
    expect(() => immutableWordsV32(c, { ...immutableValuesV32(plan, "vault", IDS.rehearsal), launchChain: undefined })).toThrow(
      /the plan gives no value for CascadeVault's immutable launchChain; nothing compared \(never blanked\)/,
    );
  });

  it("coldkeyFromThePlannedAddress: the vault's and its lens's coldkey are the ADDRESS_MAPPING of the vault's planned address", async () => {
    const mapped = addressMapping(plan.addresses.vault);
    expect(mapped).toBe(plan.vaultColdkey);
    for (const id of ["vault", "vaultLens"] as const) for (const r of rangesOf(id, "coldkey")) expect(word(honest[id], r.start)).toBe(mapped);
    // a vault (or a lens) holding the mapping of another address fails, at the coldkey's first place
    const wrong = addressMapping(other);
    for (const id of ["vault", "vaultLens"] as const) {
      const r = await readBack(deployed(plan, { [id]: withImmutable(id, honest[id], "coldkey", wrong) }));
      const first = rangesOf(id, "coldkey").reduce((a, b) => (b.start < a.start ? b : a));
      failsInside(r.failures, `Bittensor ${nameOf(id)}`, "the immutable coldkey", [first]);
    }
  });

  it("libraryDeployAddressIsItsOwn: each library's library_deploy_address is the address the plan deploys it at", async () => {
    for (const id of ["stakeLib", "payoutLib", "batchLib", "hotkeyLib"] as const) {
      const [r0] = contractOf(id).deployedBytecode.immutableReferences[LIBRARY_DEPLOY_ADDRESS];
      expect(word(honest[id], r0.start), id).toBe(addressWord(plan.addresses[id]));
      // the right library's code, deployed elsewhere (its own address another), at the planned address: it fails
      const elsewhere = put(honest[id], r0.start, addressWord(other));
      const r = await readBack(deployed(plan, { [id]: elsewhere }));
      failsInside(r.failures, `Bittensor ${nameOf(id)}`, "the immutable library_deploy_address", [{ start: r0.start + 12, length: 20 }]);
    }
  });

  it("aMissingOrUnexpectedLinkFails: the link set is the artifact's; a library missing from the plan's links, or one the build does not link, fails", async () => {
    const vault = contractOf("vault");
    const links = step(plan, "vault").libraries!;
    expect(linkFailures(vault, honest.vault, links)).toEqual([]);
    const stakeLib = CONTRACTS_V32.stakeLib.contract;
    const math = CONTRACTS_V32.payoutMath.contract;
    const { [stakeLib]: _, ...missing } = links;
    expect(linkFailures(vault, honest.vault, missing)).toEqual(["CascadeVault links CascadeStakeLib, but the plan names no address for it"]);
    expect(linkFailures(vault, honest.vault, { ...links, [math]: plan.addresses.payoutMath })).toEqual(["CascadeVault: the plan links CascadePayoutMath into it, but its build has no reference to it"]);
    // a contract that links nothing, given a library
    expect(linkFailures(contractOf("vaultLens"), honest.vaultLens, { [math]: plan.addresses.payoutMath })).toEqual([
      "CascadeVaultLens: the plan links CascadePayoutMath into it, but its build has no reference to it",
    ]);
    // from a record: a plan whose vault step lost a library fails, and so does one whose lens step gained one
    const p = structuredClone(plan);
    delete step(p, "vault").libraries![stakeLib];
    step(p, "vaultLens").libraries = { [math]: p.addresses.payoutMath };
    const r = await readBack(deployed(p), p);
    expect(r.failures).toEqual(
      expect.arrayContaining([
        "Bittensor CascadeVault links CascadeStakeLib, but the plan names no address for it",
        "Bittensor CascadeVaultLens: the plan links CascadePayoutMath into it, but its build has no reference to it",
      ]),
    );
  });

  it("aLibraryNamedTwoWaysFails (was vaultAndL3DisagreeingOnL2Fails: L3 links CascadePayoutMath only, no L2)", async () => {
    // the build's graph: L3 links the math alone; the vault links L1 to L4; no library is linked by two contracts
    expect(Object.keys(step(plan, "payoutLib").libraries!)).toEqual([CONTRACTS_V32.payoutMath.contract]);
    expect(Object.keys(build.links).sort()).toEqual(["CascadePayoutLib", "CascadeVault"]);
    // the check the build needs: every reference to one library, in every contract that links it, names the one
    // address the plan deploys it at
    expect(linkAgreementFailures(plan)).toEqual([]);
    for (const s of plan.steps) for (const [lib, at] of Object.entries(s.libraries ?? {})) expect(at, `${s.id} -> ${lib}`).toBe(plan.addresses[idOfContract(lib)]);
    const stakeLib = CONTRACTS_V32.stakeLib.contract;
    const math = CONTRACTS_V32.payoutMath.contract;
    const p = structuredClone(plan);
    step(p, "vault").libraries![stakeLib] = other;
    expect(linkAgreementFailures(p)).toEqual([`CascadeStakeLib is named at more than one address: the plan deploys it at ${p.addresses.stakeLib}, and CascadeVault links it at ${other}`]);
    // two contracts naming one library at two addresses: L3's math and (as if it linked it) the vault's
    const q = structuredClone(plan);
    step(q, "vault").libraries![math] = other;
    expect(linkAgreementFailures(q)).toEqual([`CascadePayoutMath is named at more than one address: the plan deploys it at ${q.addresses.payoutMath}, CascadePayoutLib links it at ${q.addresses.payoutMath}, and CascadeVault links it at ${other}`]);
    // a record whose vault step names L2 at another address, and a vault deployed linked as that record says: the read
    // reports the disagreement, and the vault's code is compared with the L2 the plan deploys, so it fails too
    const [l2] = contractOf("vault").deployedBytecode.linkReferences["src/libraries/CascadeStakeLib.sol"].CascadeStakeLib;
    const asRecorded = await readBack(deployed(p, { vault: put(honest.vault, l2.start, other) }), p);
    expect(asRecorded.failures[0]).toBe(linkAgreementFailures(p)[0]);
    failsInside(asRecorded.failures.slice(1), "Bittensor CascadeVault", "the reference to CascadeStakeLib", [l2]);
    // and on chain: a vault whose L2 reference names another address than the L2 the plan deployed
    const [ref] = contractOf("vault").deployedBytecode.linkReferences["src/libraries/CascadeStakeLib.sol"].CascadeStakeLib;
    const r = await readBack(deployed(plan, { vault: put(honest.vault, ref.start, other) }));
    expect(r.failures).toEqual([
      `Bittensor CascadeVault's reference to CascadeStakeLib at byte ${ref.start} names ${other}, not the plan's ${plan.addresses.stakeLib}`,
      expect.stringMatching(/^Bittensor CascadeVault: .* \(the reference to CascadeStakeLib\)$/),
    ]);
    failsInside(r.failures.slice(1), "Bittensor CascadeVault", "the reference to CascadeStakeLib", [ref]);
  });

  it("aWrongLibraryAddressFails: a link to another address, the vault's or L3's, fails, naming the reference", async () => {
    for (const [id, file, lib] of [
      ["vault", "src/libraries/CascadeBatchLib.sol", "CascadeBatchLib"],
      ["vault", "src/libraries/CascadeHotkeyLib.sol", "CascadeHotkeyLib"],
      ["payoutLib", "src/libraries/CascadePayoutMath.sol", "CascadePayoutMath"],
    ] as const) {
      const refs = contractOf(id).deployedBytecode.linkReferences[file][lib];
      const last = refs[refs.length - 1];
      const r = await readBack(deployed(plan, { [id]: put(honest[id], last.start, other) }));
      const planned = plan.addresses[idOfContract(`${file}:${lib}`)];
      expect(r.failures, `${id} ${lib}`).toHaveLength(2);
      expect(r.failures[0]).toBe(`Bittensor ${nameOf(id)}'s reference to ${lib} at byte ${last.start} names ${other}, not the plan's ${planned}`);
      failsInside(r.failures.slice(1), `Bittensor ${nameOf(id)}`, `the reference to ${lib}`, [last]);
    }
  });

  it("aWrongImmutableFails: any immutable filled with another value than the plan's fails, naming it", async () => {
    const cases: [V32StepId, string, Hex][] = [
      ["frontDoor", "vault", addressWord(other)],
      ["frontDoor", "vaultChain", encodeAbiParameters([{ type: "uint64" }], [965n])],
      ["staker", "frontDoor", addressWord(other)],
      ["bitAdapter", "remoteAdapter", addressWord(other)],
      ["baseAdapter", "minSendAmount", encodeAbiParameters([{ type: "uint256" }], [1n])],
      ["oracle", "taoWethPool", addressWord(other)],
      ["vault", "launchChain", encodeAbiParameters([{ type: "uint64" }], [964n])],
    ];
    for (const [id, name, value] of cases) {
      const chain = step(plan, id).chain === "base" ? "Base" : "Bittensor";
      const r = await readBack(deployed(plan, { [id]: withImmutable(id, honest[id], name, value) }));
      const first = rangesOf(id, name).reduce((a, b) => (b.start < a.start ? b : a));
      failsInside(r.failures, `${chain} ${nameOf(id)}`, `the immutable ${name}`, [first]);
    }
  });

  it("each immutable that names a planned contract holds its planned address, even where the plan's argument says another", async () => {
    // a plan whose constructor arguments name another address than the plan's own contracts: the contracts deployed
    // from those arguments are wired wrong, and each fails, though it holds exactly what its argument said
    const p = structuredClone(plan);
    (step(p, "frontDoor").args[0] as { vault: Address }).vault = other;
    (step(p, "staker").args[0] as { frontDoor: Address }).frontDoor = other;
    (step(p, "bitAdapter").args[0] as { remoteAdapter: Address }).remoteAdapter = other;
    step(p, "vaultLens").args[0] = other;
    step(p, "doorLens").args[0] = other;
    const asArgued: [V32StepId, string][] = [
      ["frontDoor", "vault"],
      ["staker", "frontDoor"],
      ["bitAdapter", "remoteAdapter"],
      ["vaultLens", "target"],
      ["doorLens", "target"],
    ];
    const changed = Object.fromEntries(asArgued.map(([id, name]) => [id, withImmutable(id, honest[id], name, addressWord(other))]));
    const r = await readBack(deployed(p, changed), p);
    expect(r.failures).toHaveLength(asArgued.length);
    for (const [id, name] of asArgued) expect(r.failures.some((f) => f.startsWith(`${step(p, id).chain === "base" ? "Base" : "Bittensor"} ${nameOf(id)}: `) && f.endsWith(`(the immutable ${name})`)), `${id}.${name}`).toBe(true);
  });

  it("aLensBoundToAnotherTargetFails: each lens's target is its target's planned address", async () => {
    expect(word(honest.vaultLens, rangesOf("vaultLens", "target")[0].start)).toBe(addressWord(plan.addresses.vault));
    expect(word(honest.doorLens, rangesOf("doorLens", "target")[0].start)).toBe(addressWord(plan.addresses.frontDoor));
    for (const [id, target] of [
      ["vaultLens", plan.addresses.frontDoor],
      ["doorLens", plan.addresses.vault],
    ] as const) {
      const r = await readBack(deployed(plan, { [id]: withImmutable(id, honest[id], "target", addressWord(target)) }));
      const first = rangesOf(id, "target").reduce((a, b) => (b.start < a.start ? b : a));
      failsInside(r.failures, `${id === "vaultLens" ? "Bittensor" : "Base"} ${nameOf(id)}`, "the immutable target", [first]);
    }
  });

  it("otherCompilerOutputFails: another build's oracle, or one changed opcode, fails at its first differing byte", async () => {
    // v3-launch's oracle, compiled by solc 0.8.24 (its frozen build): another compiler's output
    const v3 = preauditArtifact("CascadeTwapOracle").deployedBytecode;
    expect(v3.slice(-10)).toBe("0008180033");
    const fails = codeFailures("base", "CascadeTwapOracle", v3, honest.oracle);
    expect(fails).toEqual([expect.stringMatching(/^Base CascadeTwapOracle: its runtime code is not the frozen build's, filled in from the plan: they first differ at byte \d+; it is \d+ bytes before its metadata, the build's \d+$/)]);
    // one byte changed, in the middle of the code (no immutable place, no link)
    const at = plainByte("oracle", 1_000);
    const b = honest.oracle.slice(2 + at * 2, 4 + at * 2);
    const flipped = put(honest.oracle, at, `0x${b === "00" ? "01" : "00"}`);
    expect(codeFailures("base", "CascadeTwapOracle", flipped, honest.oracle)).toEqual([
      `Base CascadeTwapOracle: its runtime code is not the frozen build's, filled in from the plan: they first differ at byte ${at}`,
    ]);
    const r = await readBack(deployed(plan, { oracle: flipped }));
    expect(r.failures).toEqual([`Base CascadeTwapOracle: its runtime code is not the frozen build's, filled in from the plan: they first differ at byte ${at}`]);
    // code without solc's metadata tail is not this build's
    expect(codeFailures("base", "CascadeTwapOracle", stripMetadata(honest.oracle), honest.oracle)).toEqual([
      "Base CascadeTwapOracle: its runtime code ends in no CBOR metadata tail, so it is not this build's",
    ]);
  });

  it("aMetadataOnlyDifferencePasses: only the CBOR tail differs (another IPFS hash, another length), and it passes", async () => {
    const stripped = stripMetadata(honest.vault);
    const tail = honest.vault.slice(stripped.length);
    const otherHash = `${tail.slice(0, 20)}${"ab".repeat(32)}${tail.slice(20 + 64)}`;
    expect(otherHash.length).toBe(tail.length);
    const a = `${stripped}${otherHash}` as Hex;
    expect(a).not.toBe(honest.vault);
    expect(codeFailures("bittensor", "CascadeVault", a, honest.vault)).toEqual([]);
    // a longer map: a third entry ("x": 0), its length in its last two bytes
    const longer = `a3${tail.slice(2, -4)}617800`;
    const b = `${stripped}${longer}${(longer.length / 2).toString(16).padStart(4, "0")}` as Hex;
    expect(codeFailures("bittensor", "CascadeVault", b, honest.vault)).toEqual([]);
    const r = await readBack(deployed(plan, { vault: a, oracle: `${stripMetadata(honest.oracle)}${otherHash}` as Hex }));
    expect(r.failures).toEqual([]);
  });

  it("aWrongDomainSeparatorFails (ruling DA13): each DOMAIN_SEPARATOR is viem's hashDomain for its chain and its own address", async () => {
    // viem's hashDomain is CascadeFormulas.domainSeparator's formula, with the name and version its source holds
    const src = readFileSync(join(CONTRACTS, "src", "libraries", "CascadeFormulas.sol"), "utf8");
    expect(src).toMatch(/keccak256\("Cascade"\),\s*keccak256\("3\.2"\),\s*block\.chainid,\s*verifyingContract/);
    const solidity = solidityDomainSeparator;
    for (const [id, chain] of [
      ["vault", "bittensor"],
      ["frontDoor", "base"],
    ] as const) {
      for (const kind of ["rehearsal", "live"] as const) {
        const want = solidity(IDS[kind][chain], plan.addresses[id]);
        expect(domainSeparatorV32(IDS[kind][chain], plan.addresses[id])).toBe(want);
        expect(word(expectedRuntimeV32(build, plan, id, IDS[kind]), rangesOf(id, "DOMAIN_SEPARATOR")[0].start), `${id} ${kind}`).toBe(want);
      }
      // a separator of another chain (mainnet's, read on the forks), or of another verifying contract, fails
      for (const wrong of [solidity(IDS.live[chain], plan.addresses[id]), solidity(IDS.rehearsal[chain], other)]) {
        const r = await readBack(deployed(plan, { [id]: withImmutable(id, honest[id], "DOMAIN_SEPARATOR", wrong) }));
        failsInside(r.failures, `${chain === "base" ? "Base" : "Bittensor"} ${nameOf(id)}`, "the immutable DOMAIN_SEPARATOR", rangesOf(id, "DOMAIN_SEPARATOR"));
      }
    }
  });

  it("an honest deployment passes on every chain id; a missing contract fails; library and lens balances are information only", async () => {
    // the forks
    const r = await readBack(deployed(plan));
    expect(r.failures).toEqual([]);
    expect(r.info).toEqual([]);
    // every planned address is read, each once
    expect(r.calls.filter((c) => c.method === "eth_getCode").map((c) => (c.params[0] as string).toLowerCase()).sort()).toEqual(plan.steps.map((s) => plan.addresses[s.id].toLowerCase()).sort());
    // live chain ids: the separators are mainnet's
    const live = Object.fromEntries(plan.steps.map((s) => [s.id, expectedRuntimeV32(build, plan, s.id, IDS.live)])) as Record<V32StepId, Hex>;
    const { buildsDir, ref } = frozenAt(build);
    const w = chainsWith(deployed(plan, {}, live));
    const liveCtx = { ...w.ctx, targets: targets({}).live };
    expect((await codeReadBacksV32(liveCtx, { plan, build: ref }, buildsDir)).failures).toEqual([]);
    // read with the forks' ids, mainnet's code fails at both separators
    expect((await codeReadBacksV32(w.ctx, { plan, build: ref }, buildsDir)).failures).toEqual([
      expect.stringMatching(/^Bittensor CascadeVault: .*\(the immutable DOMAIN_SEPARATOR\)$/),
      expect.stringMatching(/^Base CascadeFrontDoor: .*\(the immutable DOMAIN_SEPARATOR\)$/),
    ]);
    // no code at a planned address
    const codes = deployed(plan);
    delete codes.base![plan.addresses.doorLens];
    expect((await readBack(codes)).failures).toEqual([`Base CascadeDoorLens: no code at ${plan.addresses.doorLens}, where the plan puts it`]);
    // a forced balance on a library or a lens is reported, never a failure (rev 12 L-4)
    const b = chainsWith(deployed(plan), { bittensor: { [plan.addresses.stakeLib]: 10n ** 15n }, base: { [plan.addresses.doorLens]: 1n } });
    const withBalances = await codeReadBacksV32(b.ctx, { plan, build: ref }, buildsDir);
    expect(withBalances.failures).toEqual([]);
    expect(withBalances.info).toEqual([
      `Bittensor CascadeStakeLib at ${plan.addresses.stakeLib} holds 0.001 TAO: information only (a library or a lens holds nothing by design; a forced balance changes nothing)`,
      `Base CascadeDoorLens at ${plan.addresses.doorLens} holds 0.000000000000000001 ETH: information only (a library or a lens holds nothing by design; a forced balance changes nothing)`,
    ]);
  });

  it("every contract's comparison runs: one plain byte changed fails that contract alone, the payout math too (Task 45's review, M3)", async () => {
    for (const s of plan.steps) {
      const at = plainByte(s.id, 100);
      const b = honest[s.id].slice(2 + at * 2, 4 + at * 2);
      const r = await readBack(deployed(plan, { [s.id]: put(honest[s.id], at, `0x${b === "00" ? "01" : "00"}`) }));
      expect(r.failures, s.id).toEqual([`${s.chain === "base" ? "Base" : "Bittensor"} ${nameOf(s.id)}: its runtime code is not the frozen build's, filled in from the plan: they first differ at byte ${at}`]);
    }
  });

  it("each planned address is re-derived from its deployer and nonce; a record that disagrees fails (Task 45's review, M4)", async () => {
    // a record whose door lens was moved, its code there too: the code is right, the address is not the nonce plan's
    const p = structuredClone(plan);
    p.addresses.doorLens = other;
    const r = await readBack(deployed(p), p);
    expect(r.failures).toEqual([`Base CascadeDoorLens: the record puts it at ${other}, but the Base deployer ${p.deployers.base} creates ${plan.addresses.doorLens} at its nonce 4`]);
    // a record whose step names another nonce
    const q = structuredClone(plan);
    step(q, "oracle").nonce = 3;
    expect((await readBack(deployed(q), q)).failures).toEqual(["Base CascadeTwapOracle: the record plans it at nonce 3, not the nonce plan's 1"]);
    // a record whose deployer was changed, every address with it: each of that chain's contracts fails
    const d = structuredClone(plan);
    d.deployers.bittensor = other;
    const f = (await readBack(deployed(d), d)).failures;
    expect(f).toHaveLength(8);
    for (const x of f) expect(x).toMatch(new RegExp(`^Bittensor \\w+: the record puts it at 0x[0-9a-fA-F]{40}, but the Bittensor deployer ${other} creates 0x[0-9a-fA-F]{40} at its nonce \\d$`));
  });

  it("every step of the nonce plan is read back: a step deleted from the record, moved or added fails (Task 45's re-review, N2)", async () => {
    // a record whose door lens step was deleted: its code is not read, and that is a failure, never a silent pass
    const p = structuredClone(plan);
    p.steps = p.steps.filter((s) => s.id !== "doorLens");
    const r = await readBack(deployed(plan), p);
    expect(r.failures).toEqual(["Base CascadeDoorLens: the record has no step for it (the nonce plan's nonce 4), so its code is not read"]);
    expect(r.calls.filter((c) => c.method === "eth_getCode")).toHaveLength(12);
    // the vault's step deleted, on Bittensor
    const q = structuredClone(plan);
    q.steps = q.steps.filter((s) => s.id !== "vault");
    expect((await readBack(deployed(plan), q)).failures).toEqual(["Bittensor CascadeVault: the record has no step for it (the nonce plan's nonce 6), so its code is not read"]);
    // a step twice: it is read once, and the record fails
    const d = structuredClone(plan);
    d.steps.push(structuredClone(step(d, "oracle")));
    const twice = await readBack(deployed(plan), d);
    expect(twice.failures).toEqual(["Base CascadeTwapOracle: the record has 2 steps for it; the nonce plan has one"]);
    expect(twice.calls.filter((c) => c.method === "eth_getCode")).toHaveLength(13);
    // a step on the other chain: missing where the nonce plan puts it, and out of the plan where the record does
    const m = structuredClone(plan);
    step(m, "oracle").chain = "bittensor";
    expect((await readBack(deployed(plan), m)).failures).toEqual([
      "Bittensor CascadeTwapOracle: the record has a step for it on Bittensor, which the nonce plan does not, so its code is not read there",
      "Base CascadeTwapOracle: the record has no step for it (the nonce plan's nonce 1), so its code is not read",
    ]);
  });

  it("expectedRuntime and codeFailures, alone: the plan's links and words in, byte for byte with the metadata out", () => {
    const c = contractOf("payoutLib");
    const libs = plannedLibrariesV32(plan, c);
    expect(libs).toEqual({ [CONTRACTS_V32.payoutMath.contract]: plan.addresses.payoutMath });
    const words = immutableWordsV32(c, immutableValuesV32(plan, "payoutLib", IDS.rehearsal));
    expect(words).toEqual({ [LIBRARY_DEPLOY_ADDRESS]: addressWord(plan.addresses.payoutLib) });
    const code = expectedRuntime(c, libs, words);
    expect(code).toBe(honest.payoutLib);
    expect(code).not.toContain("__$");
    expect(codeFailures("bittensor", "CascadePayoutLib", code, code)).toEqual([]);
    expect(codeFailures("bittensor", "CascadePayoutLib", "0x", code)).toEqual(["Bittensor CascadePayoutLib: no code"]);
    // a library the code links, left out, is refused rather than compared unlinked
    expect(() => expectedRuntime(c, {}, words)).toThrow(/missing src\/libraries\/CascadePayoutMath.sol:CascadePayoutMath/);
  });
});

describe("Task 44's review, M9: every create is checked, however it settled", () => {
  it("everyCreateIsCheckedHoweverItSettled: a last create settled from pending on the next run is read back like every other", async () => {
    const p = testPlan();
    const codes = Object.fromEntries(p.steps.map((s) => [deployDataV32(build, s), expectedRuntimeV32(build, p, s.id, IDS.rehearsal)]));
    let held = false;
    const f = fakeChains({
      codeFor: (_chain, data) => codes[data] ?? "0x60dead",
      // the last create (the door lens) waits in the pool past the first run
      fate: (t) => (t.chain === "base" && t.nonce === 4 && !held ? ((held = true), "hold") : "mine"),
    });
    const dir = tempDir("m9");
    const path = join(dir, "rehearsal-v3.2-launch.json");
    const deps = { ...realDepsV32, buildsDir: join(dir, "builds"), source: async () => SOURCE, buildContracts: async () => {} };
    await expect(deployV32(f.ctx, path, p, deps, { signers: SIGNERS })).rejects.toThrow(/The record keeps its hash/);
    const pending = loadRecord(path) as unknown as DeploymentRecordV32;
    expect(pending.pending?.step).toBe("doorLens");
    expect(pending.done.doorLens).toBeUndefined();
    f.mineHeld();
    await deployV32(f.ctx, path, p, deps, { signers: SIGNERS });
    const rec = loadRecord(path) as unknown as DeploymentRecordV32;
    expect(f.logs.some((l) => /the front door's lens \(nonce 4\): mined after the last run stopped/.test(l))).toBe(true);
    expect(Object.keys(rec.done)).toHaveLength(13);
    // the build.json the deploy wrote holds every immutable's name, which is what the read-back reads
    const written = loadBuildV32(rec.build, deps.buildsDir);
    for (const [name, c] of Object.entries(build.contracts)) expect(written.contracts[name].immutables, name).toEqual(c.immutables);
    expect((await codeReadBacksV32(f.ctx, rec, deps.buildsDir)).failures).toEqual([]);
    // the check reads the plan, not the record's done steps: every planned address, and the same failure for a wrong
    // door lens whether its create is recorded done, settled from pending or not recorded at all
    f.code.base.set(p.addresses.doorLens.toLowerCase(), withImmutable("doorLens", codes[deployDataV32(build, step(p, "doorLens"))], "target", addressWord(other)));
    const want = [expect.stringMatching(/^Base CascadeDoorLens: .*\(the immutable target\)$/)];
    for (const r of [rec, { ...rec, done: {} }, { ...rec, done: {}, pending: { step: "doorLens" as const, chain: "base" as const, nonce: 4, hashes: [] } }]) {
      const before = f.calls.length;
      expect((await codeReadBacksV32(f.ctx, r, deps.buildsDir)).failures).toEqual(want);
      const read = f.calls.slice(before).filter((c) => c.method === "eth_getCode").map((c) => (c.params[0] as string).toLowerCase());
      expect(read.sort()).toEqual(p.steps.map((s) => p.addresses[s.id].toLowerCase()).sort());
    }
  });
});

/** The step whose contract is `fqn` (path:Name). */
function idOfContract(fqn: string): V32StepId {
  return (Object.keys(CONTRACTS_V32) as V32StepId[]).find((id) => CONTRACTS_V32[id].contract === fqn)!;
}

/** The first key of `refs`. */
function k0(refs: Record<string, unknown>): string {
  return Object.keys(refs)[0];
}

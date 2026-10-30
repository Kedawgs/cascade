import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, getAddress, type Hex, numberToHex, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../src/args.ts";
import { cardinalityReport, cardinalityTxs, POOL_ABI } from "../src/cardinality.ts";
import { BASE_V3, WALLET } from "../src/config.ts";
import { handoff } from "../src/handoff.ts";
import { PAUSE_ABI, pauseCommand } from "../src/pause.ts";
import { buildPlanV3 } from "../src/plan.ts";
import { SAFE_PROBE_ABI, TIMELOCK_ABI } from "../src/safe.ts";
import { knownContracts } from "../src/sign.ts";
import { checkCalls, decodeKnownCall, describeCalls, KNOWN_ABI, parseWalletFile, type WalletFile, walletFile, writeWalletFile } from "../src/wallet.ts";
import { COLDKEY, fakeChain, revert, v3Record } from "./fake-keeper.ts";
import { ROLES } from "./launch-roles.ts";

const launch = v3Record("live", buildPlanV3(4, 9, COLDKEY, "launch", ROLES));
const a = launch.plan.addresses as ReturnType<typeof buildPlanV3>["addresses"];
const enc = (functionName: string, args?: readonly unknown[]) => encodeFunctionData({ abi: KNOWN_ABI, functionName, args } as never) as Hex;
const ACCEPT = enc("acceptOwnership");
const NEW_OWNER = getAddress("0x00000000000000000000000000000000000a0b99");
const tmp = () => mkdtempSync(join(tmpdir(), "ops-wallet-"));
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("the known functions: what the signing page can show", () => {
  it("decodes each one, with its arguments", () => {
    expect(decodeKnownCall(ACCEPT)).toEqual({ name: "acceptOwnership", signature: "acceptOwnership()", args: [] });
    expect(decodeKnownCall(enc("pause"))).toEqual({ name: "pause", signature: "pause()", args: [] });
    expect(decodeKnownCall(enc("unpause"))).toEqual({ name: "unpause", signature: "unpause()", args: [] });
    expect(decodeKnownCall(enc("increaseObservationCardinalityNext", [1_200]))).toEqual({
      name: "increaseObservationCardinalityNext",
      signature: "increaseObservationCardinalityNext(uint16)",
      args: [{ name: "observationCardinalityNext", type: "uint16", value: "1200" }],
    });
    expect(decodeKnownCall(enc("transferOwnership", [NEW_OWNER.toLowerCase()]))).toEqual({
      name: "transferOwnership",
      signature: "transferOwnership(address)",
      args: [{ name: "newOwner", type: "address", value: NEW_OWNER }],
    });
  });

  it("has the selectors every other tool uses", () => {
    expect([ACCEPT, enc("pause"), enc("unpause"), enc("transferOwnership", [NEW_OWNER]).slice(0, 10), enc("increaseObservationCardinalityNext", [1]).slice(0, 10)]).toEqual([
      "0x79ba5097",
      "0x8456cb59",
      "0x3f4ba83a",
      "0xf2fde38b",
      "0x32148f67",
    ]);
  });

  it("refuses an unknown function, extra bytes, a missing argument, or an argument out of its type's range", () => {
    const transfer = encodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount)"]), functionName: "transfer", args: [NEW_OWNER, 1n] });
    expect(() => decodeKnownCall(transfer)).toThrow(/0xa9059cbb is not one of the known functions/);
    expect(() => decodeKnownCall(`${enc("pause")}00`)).toThrow(/not the exact encoding/);
    expect(() => decodeKnownCall(`${enc("increaseObservationCardinalityNext", [1_200])}${"00".repeat(32)}`)).toThrow(/not the exact encoding/);
    expect(() => decodeKnownCall("0x32148f67")).toThrow(/increaseObservationCardinalityNext|not one of/);
    // 65,536 + 1,200 in the uint16's word: a pool's decoder would keep only the low 16 bits
    expect(() => decodeKnownCall(`0x32148f67${(65_536 + 1_200).toString(16).padStart(64, "0")}`)).toThrow();
    expect(() => decodeKnownCall("0x")).toThrow(/not one of the known functions/);
  });
});

describe("the call file", () => {
  const call = { chainId: 964, to: a.vault, data: ACCEPT, label: "acceptOwnership() on the vault", from: ROLES.owner.bittensor, sender: "the owner" };

  it("holds each call's chain id, to, data, value (always 0), label and expected sender", () => {
    expect(walletFile({ title: "Cascade v3-launch: accept ownership", deployment: "v3-launch", now: 1_800_000_000_000, calls: [call] })).toEqual({
      format: "cascade-wallet-calls",
      version: 1,
      title: "Cascade v3-launch: accept ownership",
      createdAt: 1_800_000_000_000,
      deployment: "v3-launch",
      ordered: false,
      calls: [{ ...call, value: "0" }],
    });
    const stepped = walletFile({ title: "t", now: 1, ordered: true, calls: [{ ...call, chainId: 8453, gas: 15_100_000 }] });
    expect(stepped).not.toHaveProperty("deployment");
    expect(stepped.ordered).toBe(true);
    expect(stepped.calls[0].gas).toBe("15100000");
  });

  it("is only for Base and Bittensor EVM: a call on the local forks is refused", () => {
    expect(() => walletFile({ title: "t", now: 1, calls: [{ ...call, chainId: 31338 }] })).toThrow(/only on Base \(8453\) and Bittensor EVM \(964\), not chain 31338/);
  });

  it("is written as JSON that reads back the same", () => {
    const f = walletFile({ title: "t", deployment: "v3-launch", now: 1, calls: [call] });
    const path = writeWalletFile(join(tmp(), "wallet"), "v3-launch-accept-ownership", f);
    expect(path).toMatch(/[\\/]wallet[\\/]v3-launch-accept-ownership\.json$/);
    expect(parseWalletFile(readJson(path))).toEqual(f);
  });

  it("refuses anything but a well-formed file", () => {
    const good = walletFile({ title: "t", deployment: "v3-launch", now: 1, calls: [call] });
    const bad = (change: (f: WalletFile & Record<string, unknown>) => unknown) => {
      const f = structuredClone(good) as WalletFile & Record<string, unknown>;
      change(f);
      return () => parseWalletFile(f);
    };
    expect(() => parseWalletFile(null)).toThrow(/not a call file/);
    expect(bad((f) => (f.format = "safe" as never))).toThrow(/not a call file/);
    expect(bad((f) => (f.version = 2 as never))).toThrow(/version/);
    expect(bad((f) => (f.calls = []))).toThrow(/no calls/);
    expect(bad((f) => (f.calls[0].value = "1"))).toThrow(/call 1: value must be 0/);
    expect(bad((f) => (f.calls[0].to = "0x1234" as never))).toThrow(/call 1: to/);
    // the pool's checksummed address with one letter's case flipped: a mistyped address
    expect(bad((f) => (f.calls[0].from = "0x82Dd34C6631C286cDD1dB16f2c232f60E402Dd5A" as never))).toThrow(/call 1: from/);
    expect(bad((f) => (f.calls[0].data = "0xzz" as never))).toThrow(/call 1: data/);
    expect(bad((f) => (f.calls[0].gas = "-5"))).toThrow(/call 1: gas/);
    expect(bad((f) => (f.calls[0].gas = "20000000"))).toThrow(/call 1: gas/);
    expect(bad((f) => (f.calls[0].label = 5 as never))).toThrow(/call 1: label/);
    expect(bad((f) => (f.deployment = "../etc"))).toThrow(/deployment/);
    expect(bad((f) => (f.ordered = "yes" as never))).toThrow(/ordered/);
  });
});

describe("checking each call against the contracts it may call", () => {
  const known = knownContracts(launch);
  const file = (calls: Parameters<typeof walletFile>[0]["calls"]) => walletFile({ title: "t", deployment: "v3-launch", now: 1_800_000_000_000, calls });
  const accept = (chainId: number, to: `0x${string}`, from = ROLES.owner.base) => ({ chainId, to, data: ACCEPT, label: "accept", from, sender: "the owner" });

  it("names each contract by its role and network, and decodes its function", () => {
    const v = checkCalls(file([accept(8453, a.frontDoor), accept(8453, a.staker), accept(964, a.vault, ROLES.owner.bittensor)]), known);
    expect(v.calls.map((c) => [c.network, c.contract, c.fn.signature, c.valueText])).toEqual([
      ["Base", "Front door on Base", "acceptOwnership()", "0 ETH"],
      ["Base", "Staker on Base", "acceptOwnership()", "0 ETH"],
      ["Bittensor EVM", "Vault on Bittensor", "acceptOwnership()", "0 TAO"],
    ]);
    const pool = checkCalls(
      file([{ chainId: 8453, to: BASE_V3.TAO_WETH_POOL, data: enc("increaseObservationCardinalityNext", [1_200]), gas: 15_100_000, label: "step 1", from: NEW_OWNER, sender: "you" }]),
      knownContracts(null),
    );
    expect(pool.calls[0].contract).toBe("TAO/WETH 0.3% pool on Base");
    expect(pool.calls[0].fn.args).toEqual([{ name: "observationCardinalityNext", type: "uint16", value: "1200" }]);
  });

  it("refuses an address that is none of the deployment's contracts nor an oracle pool, or one on the wrong chain", () => {
    const stranger = getAddress("0x00000000000000000000000000000000000bad01");
    expect(() => checkCalls(file([accept(8453, stranger)]), known)).toThrow(/call 1: .* on Base is not one of this deployment's contracts nor an oracle pool/);
    expect(() => checkCalls(file([accept(8453, a.vault)]), known)).toThrow(/call 1: .* on Base is not one of/);
    // without the deployment's record only the pools are known
    expect(() => checkCalls(file([accept(8453, a.frontDoor)]), knownContracts(null))).toThrow(/not one of/);
  });

  it("refuses a function the contract isn't called with", () => {
    expect(() => checkCalls(file([{ ...accept(8453, a.staker), data: enc("pause") }]), known)).toThrow(/call 1: pause\(\) is not a call this tool makes to the Staker on Base/);
    expect(() => checkCalls(file([{ ...accept(964, a.vault), data: enc("increaseObservationCardinalityNext", [5]) }]), known)).toThrow(/not a call this tool makes to the Vault/);
    expect(() => checkCalls(file([accept(8453, BASE_V3.TAO_WETH_POOL)]), known)).toThrow(/acceptOwnership\(\) is not a call this tool makes to the TAO\/WETH 0\.3% pool/);
  });

  it("describes the calls in the terminal too, to compare with the page and the Ledger", () => {
    const v = checkCalls(file([accept(964, a.vault, ROLES.owner.bittensor)]), known);
    expect(describeCalls(v)).toEqual([
      "t (prepared 2027-01-15T08:00:00.000Z, deployment v3-launch): 1 call",
      `  1. Bittensor EVM (chain id 964): Vault on Bittensor ${a.vault}`,
      `     acceptOwnership(), value 0 TAO, from ${ROLES.owner.bittensor} (the owner): accept`,
    ]);
  });
});

// ---- the commands that write the file ----

const OWNABLE = parseAbi(["function owner() view returns (address)", "function pendingOwner() view returns (address)", "function acceptOwnership()"]);
const offered = {
  [a.frontDoor.toLowerCase()]: { owner: WALLET, pendingOwner: ROLES.owner.base },
  [a.staker.toLowerCase()]: { owner: WALLET, pendingOwner: ROLES.owner.base },
  [a.vault.toLowerCase()]: { owner: WALLET, pendingOwner: ROLES.owner.bittensor },
};
const ownerChain = (safes: string[] = []) =>
  fakeChain(
    [OWNABLE, SAFE_PROBE_ABI, TIMELOCK_ABI],
    {
      owner: (_x, c) => offered[c.to.toLowerCase()].owner,
      pendingOwner: (_x, c) => offered[c.to.toLowerCase()].pendingOwner,
      getMinDelay: () => {
        throw revert("no");
      },
      getThreshold: (_x, c) => {
        if (!safes.includes(c.to.toLowerCase())) throw revert("no");
        return 2n;
      },
    },
    { eth_getCode: (_c, p) => (safes.includes((p[0] as string).toLowerCase()) ? "0x6080" : "0x") },
  );

describe("handoff --for-wallet", () => {
  it("writes the plain-account owner's acceptOwnership calls, both chains, for pnpm ops sign", async () => {
    const dir = tmp();
    const out = await handoff(ownerChain().ctx, launch, { outDir: join(dir, "safe"), walletDir: join(dir, "wallet"), name: "v3-launch", now: 1_800_000_000_000 });
    const path = join(dir, "wallet", "v3-launch-accept-ownership.json");
    expect(readdirSync(join(dir, "wallet"))).toEqual(["v3-launch-accept-ownership.json"]);
    const f = parseWalletFile(readJson(path));
    expect(f).toMatchObject({ deployment: "v3-launch", ordered: false, createdAt: 1_800_000_000_000 });
    expect(f.calls).toEqual([
      { chainId: 8453, to: a.frontDoor, data: ACCEPT, value: "0", label: "acceptOwnership() on the front door", from: ROLES.owner.base, sender: "the owner" },
      { chainId: 8453, to: a.staker, data: ACCEPT, value: "0", label: "acceptOwnership() on the staker", from: ROLES.owner.base, sender: "the owner" },
      { chainId: 964, to: a.vault, data: ACCEPT, value: "0", label: "acceptOwnership() on the vault", from: ROLES.owner.bittensor, sender: "the owner" },
    ]);
    // what it wrote passes the page's own checks
    expect(checkCalls(f, knownContracts(launch)).calls).toHaveLength(3);
    expect(out.files).toContain(path);
    expect(out.lines).toContain(`Wrote ${path} (3 calls): send them from MetaMask with: pnpm ops sign ${path}`);
    expect(readdirSync(join(dir))).not.toContain("safe");
  });

  it("leaves a Safe owner's calls in its Transaction Builder file, out of the wallet file", async () => {
    const dir = tmp();
    const out = await handoff(ownerChain([ROLES.owner.base.toLowerCase()]).ctx, launch, { outDir: join(dir, "safe"), walletDir: join(dir, "wallet"), name: "v3-launch", now: 1 });
    expect(readdirSync(join(dir, "safe"))).toEqual(["v3-launch-accept-ownership-base.json"]);
    const f = parseWalletFile(readJson(join(dir, "wallet", "v3-launch-accept-ownership.json")));
    expect(f.calls.map((c) => c.to)).toEqual([a.vault]);
    expect(out.lines.join("\n")).toMatch(/\(1 call\)/);
  });

  it("writes no wallet file without --for-wallet, or with no plain-account owner", async () => {
    const dir = tmp();
    await handoff(ownerChain().ctx, launch, { outDir: join(dir, "safe"), name: "v3-launch", now: 1 });
    expect(readdirSync(dir)).toEqual([]);
    const all = [ROLES.owner.base.toLowerCase(), ROLES.owner.bittensor.toLowerCase()];
    const out = await handoff(ownerChain(all).ctx, launch, { outDir: join(dir, "safe"), walletDir: join(dir, "wallet"), name: "v3-launch", now: 1 });
    expect(readdirSync(dir)).toEqual(["safe"]);
    expect(out.lines).toContain("There is nothing for the wallet page to send: no plain-account owner has a contract waiting to accept.");
  });
});

/** The launch's front door and vault: running, the guardians and the test wallet (the owner before the
 * hand-off) plain accounts; the estimate fails on `estimateFails`. */
function pauseWorld(o: { estimateFails?: "base" | "bittensor"; paused?: boolean } = {}) {
  const runs: string[][] = [];
  const f = fakeChain(
    [PAUSE_ABI, SAFE_PROBE_ABI, TIMELOCK_ABI],
    {
      paused: () => o.paused ?? false,
      guardian: (_x, c) => ROLES.guardian[c.chain],
      owner: () => WALLET,
      getMinDelay: () => {
        throw revert("no");
      },
      getThreshold: () => {
        throw revert("no");
      },
    },
    {
      eth_getCode: () => "0x",
      eth_estimateGas: (chain) => {
        if (o.estimateFails === chain) throw revert("NotGuardian", chain);
        return numberToHex(30_000n);
      },
      eth_gasPrice: () => numberToHex(10n ** 9n),
      eth_getBalance: () => numberToHex(10n ** 18n),
    },
  );
  const ctx = { ...f.ctx, runner: { run: async (_f: string, args: string[]) => (runs.push(args), { code: 0, stdout: "", stderr: "" }) } };
  const sends: unknown[] = [];
  const deps = { sendCall: async (_c: unknown, req: unknown) => (sends.push(req), { hash: `0x${"ee".repeat(32)}` as Hex, block: 1, gasUsed: 1n, costWei: 1n }) };
  return { ctx, deps, runs, sends, calls: f.calls };
}
const pauseOpts = (dir: string, action: "pause" | "unpause" = "pause") => ({
  action,
  target: "both" as const,
  send: false,
  signer: () => {
    throw new Error("no keystore is used for the wallet page");
  },
  outDir: join(dir, "safe"),
  walletDir: join(dir, "wallet"),
  name: "v3-launch",
  now: 1_800_000_000_000,
});

describe("pause and unpause --for-wallet", () => {
  it("checks each call and writes it for the plain-account guardian; no keystore is opened and nothing is sent", async () => {
    const dir = tmp();
    const w = pauseWorld();
    const r = await pauseCommand(w.ctx, launch, pauseOpts(dir), w.deps);
    const path = join(dir, "wallet", "v3-launch-pause.json");
    const f = parseWalletFile(readJson(path));
    const PAUSE = enc("pause");
    expect(f.calls).toEqual([
      { chainId: 8453, to: a.frontDoor, data: PAUSE, value: "0", label: "pause() on the front door", from: ROLES.guardian.base, sender: "the guardian" },
      { chainId: 964, to: a.vault, data: PAUSE, value: "0", label: "pause() on the vault", from: ROLES.guardian.bittensor, sender: "the guardian" },
    ]);
    expect(f.ordered).toBe(false);
    expect(checkCalls(f, knownContracts(launch)).calls).toHaveLength(2);
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toBe(`Base front door ${a.frontDoor}: pause() from the guardian ${ROLES.guardian.base} would succeed (about 30,000 gas): added to the wallet file.`);
    expect(r.lines.at(-1)).toBe(`Wrote ${path} (2 calls): send them from MetaMask with: pnpm ops sign ${path}`);
    expect(r.files).toEqual([path]);
    expect(w.runs).toEqual([]);
    expect(w.sends).toEqual([]);
    expect(w.calls.filter((c) => c.method === "eth_estimateGas")).toHaveLength(2);
  });

  it("unpause is the owner's", async () => {
    const dir = tmp();
    const w = pauseWorld({ paused: true });
    await pauseCommand(w.ctx, launch, pauseOpts(dir, "unpause"), w.deps);
    const f = parseWalletFile(readJson(join(dir, "wallet", "v3-launch-unpause.json")));
    expect(f.calls.map((c) => [c.chainId, c.data, c.from, c.sender])).toEqual([
      [8453, enc("unpause"), WALLET, "the owner"],
      [964, enc("unpause"), WALLET, "the owner"],
    ]);
  });

  it("leaves out a call that would fail, as a problem, and still writes the other", async () => {
    const dir = tmp();
    const w = pauseWorld({ estimateFails: "base" });
    const r = await pauseCommand(w.ctx, launch, pauseOpts(dir), w.deps);
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/^PROBLEM — Base front door .*: pause\(\) from the guardian .* would fail/);
    expect(parseWalletFile(readJson(join(dir, "wallet", "v3-launch-pause.json"))).calls.map((c) => c.to)).toEqual([a.vault]);
  });

  it("writes nothing when nothing needs sending", async () => {
    const dir = tmp();
    const w = pauseWorld({ paused: true });
    const r = await pauseCommand(w.ctx, launch, pauseOpts(dir), w.deps);
    expect(readdirSync(dir)).toEqual([]);
    expect(r.files).toEqual([]);
  });
});

describe("cardinality --for-wallet", () => {
  const pools = (taoWeth: { cardinality: number; next: number }) =>
    fakeChain([POOL_ABI], {
      slot0: (_a, c) => {
        const s = c.to.toLowerCase() === BASE_V3.TAO_WETH_POOL.toLowerCase() ? taoWeth : { cardinality: 5_000, next: 5_000 };
        return [2n ** 96n, 0, 0, s.cardinality, s.next, 0, true];
      },
    });

  it("writes the steps in order, each with its gas limit, for the account given", async () => {
    const dir = tmp();
    const lines = await cardinalityReport(pools({ cardinality: 600, next: 600 }).ctx, { from: NEW_OWNER, dir, now: 1_800_000_000_000 });
    const path = join(dir, "cardinality.json");
    const f = parseWalletFile(readJson(path));
    const txs = cardinalityTxs(BASE_V3.TAO_WETH_POOL, [1_200, 1_800, 2_000]);
    expect(f).toMatchObject({ ordered: true, createdAt: 1_800_000_000_000 });
    expect(f).not.toHaveProperty("deployment");
    expect(f.calls).toEqual([
      { chainId: 8453, to: txs[0].to, data: txs[0].data, value: "0", gas: "15100000", label: "increaseObservationCardinalityNext(1200) on the TAO/WETH 0.3% pool, step 1 of 3", from: NEW_OWNER, sender: "the account you chose with --from" },
      { chainId: 8453, to: txs[1].to, data: txs[1].data, value: "0", gas: "15100000", label: "increaseObservationCardinalityNext(1800) on the TAO/WETH 0.3% pool, step 2 of 3", from: NEW_OWNER, sender: "the account you chose with --from" },
      { chainId: 8453, to: txs[2].to, data: txs[2].data, value: "0", gas: "5100000", label: "increaseObservationCardinalityNext(2000) on the TAO/WETH 0.3% pool, step 3 of 3", from: NEW_OWNER, sender: "the account you chose with --from" },
    ]);
    expect(checkCalls(f, knownContracts(null)).calls).toHaveLength(3);
    expect(lines.at(-1)).toBe(`Wrote ${path} (3 calls): send them from MetaMask with: pnpm ops sign ${path}`);
  });

  it("writes nothing when the pools have enough", async () => {
    const dir = tmp();
    const lines = await cardinalityReport(pools({ cardinality: 2_000, next: 2_000 }).ctx, { from: NEW_OWNER, dir, now: 1 });
    expect(readdirSync(dir)).toEqual([]);
    expect(lines.at(-1)).toBe("Both pools have enough slots: there is nothing for the wallet page to send.");
  });
});

describe("arguments: sign and --for-wallet", () => {
  const F = "deployments/wallet/x.json";

  it("sign takes the call file, and nothing else", () => {
    expect(parseArgs(["sign", F])).toEqual({ cmd: "sign", live: false, users: [], file: F });
    expect(() => parseArgs(["sign"])).toThrow(/sign needs the call file/);
    expect(() => parseArgs(["sign", F, "--live"])).toThrow(/sign sends nothing itself/);
    expect(() => parseArgs(["sign", F, "other.json"])).toThrow(UsageError);
  });

  it("handoff, pause, unpause and cardinality take --for-wallet", () => {
    expect(parseArgs(["handoff", "--live", "--for-wallet"])).toEqual({ cmd: "handoff", live: true, users: [], forWallet: true });
    expect(parseArgs(["pause", "--for-wallet"])).toEqual({ cmd: "pause", live: false, users: [], target: "both", forWallet: true });
    expect(parseArgs(["unpause", "vault", "--for-wallet"])).toEqual({ cmd: "unpause", live: false, users: [], target: "vault", forWallet: true });
    expect(parseArgs(["cardinality", "--for-wallet", "--from", NEW_OWNER])).toEqual({ cmd: "cardinality", live: false, users: [], forWallet: true, from: NEW_OWNER });
    expect(() => parseArgs(["status", "--for-wallet"])).toThrow(UsageError);
  });

  it("refuses the combinations that would be ambiguous", () => {
    // handoff reads only; without --live it would read the forks, which the page can't send on
    expect(() => parseArgs(["handoff", "--for-wallet"])).toThrow(/handoff --for-wallet .* add --live/);
    // --live sends with the keystore; --for-wallet writes the call for MetaMask
    expect(() => parseArgs(["pause", "--for-wallet", "--live"])).toThrow(/--for-wallet .* drop --live/);
    expect(() => parseArgs(["cardinality", "--for-wallet"])).toThrow(/needs --from/);
    expect(() => parseArgs(["cardinality", "--from", NEW_OWNER])).toThrow(/--from goes with --for-wallet/);
    expect(() => parseArgs(["cardinality", "--for-wallet", "--from", "0x1234"])).toThrow(/not an address/);
  });
});

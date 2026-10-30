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
/** transferOwnership(NEW_OWNER): the one call that would hand a contract away. Nothing here may send it. */
const TRANSFER_OWNERSHIP = encodeFunctionData({ abi: parseAbi(["function transferOwnership(address newOwner)"]), functionName: "transferOwnership", args: [NEW_OWNER] });
const tmp = () => mkdtempSync(join(tmpdir(), "ops-wallet-"));
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const char = (code: number) => String.fromCharCode(code);
/** 2027-01-15T08:00:00.000Z */
const NOW = 1_800_000_000_000;

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
  });

  it("has the selectors every other tool uses", () => {
    expect([ACCEPT, enc("pause"), enc("unpause"), enc("increaseObservationCardinalityNext", [1]).slice(0, 10)]).toEqual(["0x79ba5097", "0x8456cb59", "0x3f4ba83a", "0x32148f67"]);
  });

  it("doesn't know transferOwnership, the one call that could hand a contract away", () => {
    expect(KNOWN_ABI.map((f) => f.name)).toEqual(["acceptOwnership", "pause", "unpause", "increaseObservationCardinalityNext"]);
    expect(() => decodeKnownCall(TRANSFER_OWNERSHIP)).toThrow(/0xf2fde38b is not one of the known functions/);
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
  const call = { chainId: 964, to: a.vault, data: ACCEPT, label: "acceptOwnership() on the vault", from: ROLES.owner.bittensor };
  const good = () => walletFile({ title: "Cascade v3-launch: accept ownership", deployment: "v3-launch", now: NOW, calls: [call] });
  const bad = (change: (f: WalletFile & Record<string, unknown>) => unknown) => {
    const f = structuredClone(good()) as WalletFile & Record<string, unknown>;
    change(f);
    return () => parseWalletFile(f);
  };

  it("holds each call's chain id, to, data, value (always 0), the account that must send it, and a note", () => {
    expect(good()).toEqual({
      format: "cascade-wallet-calls",
      version: 1,
      title: "Cascade v3-launch: accept ownership",
      createdAt: NOW,
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
    const path = writeWalletFile(join(tmp(), "wallet"), "v3-launch-accept-ownership", good());
    expect(path).toMatch(/[\\/]wallet[\\/]v3-launch-accept-ownership\.json$/);
    expect(parseWalletFile(readJson(path))).toEqual(good());
  });

  it("refuses anything but a well-formed file", () => {
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

  it("takes calldata in lower-case hex only, as the tools write it", () => {
    expect(bad((f) => (f.calls[0].data = "0x79BA5097"))).toThrow(/call 1: data must be lower-case hex/);
  });

  it("refuses fields it doesn't know, so nothing unchecked rides along", () => {
    expect(bad((f) => (f.note = "trust me"))).toThrow(/the call file has fields this tool doesn't know: note/);
    expect(bad((f) => ((f.calls[0] as unknown as Record<string, unknown>).sender = "the owner"))).toThrow(/call 1 has fields this tool doesn't know: sender/);
  });

  it("allows only printable ASCII in its text: no direction overrides, zero-width or C1 control characters", () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE, U+200B ZERO WIDTH SPACE, U+0085 NEXT LINE
    for (const code of [0x202e, 0x200b, 0x85]) {
      expect(bad((f) => (f.calls[0].label = `acceptOwnership() on the vault${char(code)}`))).toThrow(/call 1: label .*printable ASCII/);
      expect(bad((f) => (f.title = `Cascade${char(code)} accept ownership`))).toThrow(/title .*printable ASCII/);
    }
    expect(bad((f) => (f.calls[0].label = "acceptOwnership()\ton the vault"))).toThrow(/printable ASCII/);
  });
});

describe("checking each call against the deployment record", () => {
  const known = knownContracts(launch);
  const file = (calls: Parameters<typeof walletFile>[0]["calls"], deployment: string | null = "v3-launch") => walletFile({ title: "t", deployment: deployment ?? undefined, now: NOW, calls });
  const accept = (chainId: number, to: `0x${string}`, from = ROLES.owner.base) => ({ chainId, to, data: ACCEPT, label: "acceptOwnership()", from });
  const at = (fn: "pause" | "unpause", from: `0x${string}`, to = a.frontDoor, chainId = 8453) => ({ chainId, to, data: enc(fn), label: `${fn}()`, from });
  const step = (n: number, from: `0x${string}`) => ({
    chainId: 8453,
    to: BASE_V3.TAO_WETH_POOL,
    data: enc("increaseObservationCardinalityNext", [n]),
    gas: 15_100_000,
    label: `increaseObservationCardinalityNext(${n})`,
    from,
  });

  it("builds what is shown from the decoded call and the record: the heading, the sender's role, the effect", () => {
    const v = checkCalls(file([accept(8453, a.frontDoor), accept(8453, a.staker), accept(964, a.vault, ROLES.owner.bittensor)]), known, NOW);
    expect(v.heading).toBe("Cascade v3-launch: 3 calls to send from MetaMask");
    expect(v.calls.map((c) => [c.heading, c.network, c.contract, c.senderRole, c.valueText])).toEqual([
      ["acceptOwnership() on the Front door (Base)", "Base", "Front door on Base", "the owner on Base, from the deployment record", "0 ETH"],
      ["acceptOwnership() on the Staker (Base)", "Base", "Staker on Base", "the owner on Base, from the deployment record", "0 ETH"],
      ["acceptOwnership() on the Vault (Bittensor)", "Bittensor EVM", "Vault on Bittensor", "the owner on Bittensor, from the deployment record", "0 TAO"],
    ]);
    expect(v.calls[2].effect).toBe(`acceptOwnership(): makes ${ROLES.owner.bittensor} the owner of the Vault on Bittensor`);
    expect(v.warnings).toEqual([]);
  });

  it("gives each function a one-line effect, and the selector and 32-byte words a Ledger's debug screens show", () => {
    const v = checkCalls(file([at("pause", ROLES.guardian.base), at("pause", ROLES.guardian.bittensor, a.vault, 964), at("unpause", ROLES.owner.bittensor, a.vault, 964)]), known, NOW);
    expect(v.calls.map((c) => c.effect)).toEqual([
      "pause(): stops deposits, redeem requests, batch closes and USDC deliveries on the Front door until the owner unpauses (claims stay open)",
      "pause(): stops staking, direct deposits and redeems, incoming batches and payouts on the Vault until the owner unpauses",
      "unpause(): lets the Vault on Bittensor run again (undoes pause())",
    ]);
    expect(v.calls.map((c) => [c.selector, c.words])).toEqual([
      ["0x8456cb59", []],
      ["0x8456cb59", []],
      ["0x3f4ba83a", []],
    ]);
    const pool = checkCalls(file([step(1_200, NEW_OWNER)], null), knownContracts(null), NOW).calls[0];
    expect(pool.heading).toBe("increaseObservationCardinalityNext(1200) on the TAO/WETH 0.3% pool (Base)");
    expect(pool.effect).toBe("increaseObservationCardinalityNext(1200): pays gas to let the price pool remember more history (room for 1200 observations); changes no money");
    expect(pool.selector).toBe("0x32148f67");
    expect(pool.words).toEqual([`${"0".repeat(61)}4b0`]);
  });

  it("refuses transferOwnership whatever its label says", () => {
    const disguised = { ...accept(964, a.vault, ROLES.owner.bittensor), data: TRANSFER_OWNERSHIP, label: "acceptOwnership() on the vault" };
    expect(() => checkCalls(file([disguised]), known)).toThrow(/call 1: calldata 0xf2fde38b is not one of the known functions/);
  });

  it("shows the file's label only as a note, and refuses one that doesn't start with the decoded function", () => {
    const pause = { ...at("pause", ROLES.guardian.base), label: "pause() is harmless: it only refreshes the page" };
    const c = checkCalls(file([pause]), known).calls[0];
    expect(c.heading).toBe("pause() on the Front door (Base)");
    expect(c.label).toBe("pause() is harmless: it only refreshes the page");
    expect(() => checkCalls(file([{ ...pause, label: "acceptOwnership() on the vault" }]), known)).toThrow(/call 1: its label "acceptOwnership\(\) on the vault" doesn't start with pause\(/);
    expect(() => checkCalls(file([{ ...pause, label: "pauseAll()" }]), known)).toThrow(/doesn't start with pause\(/);
  });

  it("refuses a sender that isn't the record's role for that function", () => {
    // acceptOwnership: only the chain's owner, whom the deployer offered it to
    expect(() => checkCalls(file([accept(964, a.vault, ROLES.guardian.bittensor)]), known)).toThrow(
      new RegExp(`call 1: ${ROLES.guardian.bittensor} is not a role in the deployment record that may send acceptOwnership\\(\\) to the Vault on Bittensor \\(the owner on Bittensor, ${ROLES.owner.bittensor}\\)`),
    );
    expect(() => checkCalls(file([accept(964, a.vault, ROLES.owner.base)]), known)).toThrow(/not a role in the deployment record/);
    // pause: the guardian or the owner; unpause: the owner only
    expect(checkCalls(file([at("pause", ROLES.guardian.base), at("pause", ROLES.owner.base)]), known).calls.map((c) => c.senderRole)).toEqual([
      "the guardian on Base, from the deployment record",
      "the owner on Base, from the deployment record",
    ]);
    expect(() => checkCalls(file([at("unpause", ROLES.guardian.base)]), known)).toThrow(/not a role in the deployment record that may send unpause\(\)/);
    // the deployer still owns everything until the hand-off is accepted, but it isn't the record's owner
    expect(() => checkCalls(file([at("unpause", WALLET)]), known)).toThrow(/not a role in the deployment record/);
  });

  it("takes the pool steps from anyone, but all from the one account written with --from", () => {
    expect(checkCalls(file([step(1_200, NEW_OWNER)], null), knownContracts(null)).calls[0].senderRole).toBe("the account given with --from; anyone may send this");
    expect(() => checkCalls(file([step(1_200, NEW_OWNER), step(1_800, ROLES.owner.base)], null), knownContracts(null))).toThrow(
      /call 2: comes from .*, but the file's other pool steps come from .*: they all come from the one --from account/,
    );
  });

  it("sets a gas limit only on the pool steps", () => {
    expect(() => checkCalls(file([{ ...accept(8453, a.frontDoor), gas: 100_000 }]), known)).toThrow(/call 1: a gas limit is set only on the pool steps; acceptOwnership\(\) takes MetaMask's estimate/);
  });

  it("refuses an address that is none of the deployment's contracts nor an oracle pool, or one on the wrong chain", () => {
    const stranger = getAddress("0x00000000000000000000000000000000000bad01");
    expect(() => checkCalls(file([accept(8453, stranger)]), known)).toThrow(/call 1: .* on Base is not one of this deployment's contracts nor an oracle pool/);
    expect(() => checkCalls(file([accept(8453, a.vault)]), known)).toThrow(/call 1: .* on Base is not one of/);
    // without the deployment's record only the pools are known
    expect(() => checkCalls(file([accept(8453, a.frontDoor)]), knownContracts(null))).toThrow(/not one of/);
  });

  it("refuses a function the contract isn't called with", () => {
    expect(() => checkCalls(file([{ ...accept(8453, a.staker), data: enc("pause"), label: "pause()" }]), known)).toThrow(/call 1: pause\(\) is not a call this tool makes to the Staker on Base/);
    expect(() => checkCalls(file([{ ...accept(964, a.vault), data: enc("increaseObservationCardinalityNext", [5]), label: "increaseObservationCardinalityNext(5)" }]), known)).toThrow(
      /not a call this tool makes to the Vault/,
    );
    expect(() => checkCalls(file([accept(8453, BASE_V3.TAO_WETH_POOL)]), known)).toThrow(/acceptOwnership\(\) is not a call this tool makes to the TAO\/WETH 0\.3% pool/);
  });

  it("refuses a v2 record, which has no owner or guardian roles", () => {
    const v2 = { ...launch, plan: { ...launch.plan, version: undefined } } as never;
    expect(() => knownContracts(v2)).toThrow(/v2 plan, which has no owner or guardian roles/);
  });

  it("warns when the file is more than a day old", () => {
    const f = file([accept(8453, a.frontDoor)]);
    expect(checkCalls(f, known, NOW + 23 * 3_600_000).warnings).toEqual([]);
    expect(checkCalls(f, known, NOW + 25 * 3_600_000).warnings).toEqual([
      "This file was prepared 25 hours ago (2027-01-15T08:00:00.000Z): make it again with --for-wallet unless you know it is still right.",
    ]);
  });

  it("describes the calls in the terminal too, to compare with the page and the Ledger", () => {
    const f = file([{ ...accept(964, a.vault, ROLES.owner.bittensor), label: "acceptOwnership() on the vault" }]);
    expect(describeCalls(checkCalls(f, known, NOW))).toEqual([
      "Cascade v3-launch: 1 call to send from MetaMask (file prepared 2027-01-15T08:00:00.000Z)",
      `  1. acceptOwnership() on the Vault (Bittensor) ${a.vault}`,
      `     Bittensor EVM (chain id 964), value 0 TAO, from ${ROLES.owner.bittensor} (the owner on Bittensor, from the deployment record)`,
      `     acceptOwnership(): makes ${ROLES.owner.bittensor} the owner of the Vault on Bittensor`,
      "     Selector 0x79ba5097, no parameters",
      "     The file's note: acceptOwnership() on the vault",
    ]);
    const pool = describeCalls(checkCalls(file([step(1_200, NEW_OWNER)], null), knownContracts(null), NOW + 30 * 3_600_000));
    expect(pool[0]).toBe("Cascade: 1 call to send from MetaMask (file prepared 2027-01-15T08:00:00.000Z)");
    expect(pool[1]).toMatch(/^WARNING: This file was prepared 30 hours ago/);
    expect(pool).toContain(`     Selector 0x32148f67, parameter 1: ${"0".repeat(61)}4b0`);
    expect(pool).toContain("     Gas limit 15,100,000, set by the file");
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
      { chainId: 8453, to: a.frontDoor, data: ACCEPT, value: "0", label: "acceptOwnership() on the front door", from: ROLES.owner.base },
      { chainId: 8453, to: a.staker, data: ACCEPT, value: "0", label: "acceptOwnership() on the staker", from: ROLES.owner.base },
      { chainId: 964, to: a.vault, data: ACCEPT, value: "0", label: "acceptOwnership() on the vault", from: ROLES.owner.bittensor },
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
      { chainId: 8453, to: a.frontDoor, data: PAUSE, value: "0", label: "pause() on the front door", from: ROLES.guardian.base },
      { chainId: 964, to: a.vault, data: PAUSE, value: "0", label: "pause() on the vault", from: ROLES.guardian.bittensor },
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
    // owner() as the contracts answer it: the deployer still, until the hand-off is accepted (sign then
    // refuses it: the deployer isn't the record's owner)
    expect(f.calls.map((c) => [c.chainId, c.data, c.from, c.label])).toEqual([
      [8453, enc("unpause"), WALLET, "unpause() on the front door"],
      [964, enc("unpause"), WALLET, "unpause() on the vault"],
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
      { chainId: 8453, to: txs[0].to, data: txs[0].data, value: "0", gas: "15100000", label: "increaseObservationCardinalityNext(1200) on the TAO/WETH 0.3% pool, step 1 of 3", from: NEW_OWNER },
      { chainId: 8453, to: txs[1].to, data: txs[1].data, value: "0", gas: "15100000", label: "increaseObservationCardinalityNext(1800) on the TAO/WETH 0.3% pool, step 2 of 3", from: NEW_OWNER },
      { chainId: 8453, to: txs[2].to, data: txs[2].data, value: "0", gas: "5100000", label: "increaseObservationCardinalityNext(2000) on the TAO/WETH 0.3% pool, step 3 of 3", from: NEW_OWNER },
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

  it("sign takes --deployment, a plain name, in place of OPS_DEPLOYMENT", () => {
    expect(parseArgs(["sign", F, "--deployment", "v3-launch"])).toEqual({ cmd: "sign", live: false, users: [], file: F, deployment: "v3-launch" });
    expect(() => parseArgs(["sign", F, "--deployment", "../etc"])).toThrow(/--deployment .* is not a plain name/);
    expect(() => parseArgs(["pause", "--deployment", "v3-launch"])).toThrow(UsageError);
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

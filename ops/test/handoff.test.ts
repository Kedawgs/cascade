import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, decodeFunctionData, encodeFunctionData, getAddress, type Hex, keccak256, parseAbi, stringToBytes, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { WALLET } from "../src/config.ts";
import { handoff, ownershipStatus } from "../src/handoff.ts";
import { buildPlanV3 } from "../src/plan.ts";
import { accountKind, checksumSerialize, SAFE_PROBE_ABI, safeBatch, safeChecksum, TIMELOCK_ABI, timelockCalls } from "../src/safe.ts";
import { COLDKEY, fakeChain, revert, v3Record } from "./fake-keeper.ts";
import { ROLES } from "./launch-roles.ts";

const OWNABLE = parseAbi(["function owner() view returns (address)", "function pendingOwner() view returns (address)", "function acceptOwnership()"]);
const ACCEPT = encodeFunctionData({ abi: OWNABLE, functionName: "acceptOwnership" });
const CODE: Hex = "0x6080";

describe("Safe Transaction Builder batch files", () => {
  const calls = [
    { to: getAddress("0x00000000000000000000000000000000000000f1"), data: ACCEPT, description: "accept the front door" },
    { to: getAddress("0x00000000000000000000000000000000000000f2"), data: ACCEPT, description: "accept the staker" },
  ];
  const file = safeBatch({ chainId: 8453, name: "Cascade: accept ownership on Base", safe: ROLES.owner.base, calls, createdAt: 1_800_000_000_000 });

  it("has the tx-builder's shape: version, chainId as a string, createdAt, meta and raw transactions", () => {
    expect(file).toEqual({
      version: "1.0",
      chainId: "8453",
      createdAt: 1_800_000_000_000,
      meta: {
        name: "Cascade: accept ownership on Base",
        description: "1. accept the front door\n2. accept the staker",
        createdFromSafeAddress: ROLES.owner.base,
        checksum: safeChecksum({ ...file, meta: { ...file.meta, checksum: undefined } }),
      },
      transactions: [
        { to: calls[0].to, value: "0", data: ACCEPT },
        { to: calls[1].to, value: "0", data: ACCEPT },
      ],
    });
    expect(safeBatch({ chainId: 964, name: "x", calls, createdAt: 1 }).meta).not.toHaveProperty("createdFromSafeAddress");
  });

  it("serializes for the checksum as the tx-builder does: sorted key list, then each value and a comma", () => {
    expect(checksumSerialize({ b: 1, a: [1, "x"], c: null, d: undefined })).toBe('{["a","b","c","d"][1,"x"],1,null,null,}');
    expect(checksumSerialize([])).toBe("[]");
    expect(checksumSerialize("a")).toBe('"a"');
  });

  it("checksums everything but the batch's name, without its own checksum", () => {
    const { checksum, ...meta } = file.meta;
    const bare = { ...file, meta };
    expect(checksum).toBe(keccak256(stringToBytes(checksumSerialize({ ...bare, meta: { ...meta, name: null } }))));
    expect(safeChecksum({ ...bare, meta: { ...meta, name: "renamed" } })).toBe(checksum);
    expect(safeChecksum({ ...bare, transactions: [{ ...bare.transactions[0], data: "0x00" }] })).not.toBe(checksum);
  });

  it("wraps calls for an OpenZeppelin timelock: scheduleBatch with its delay, then executeBatch", () => {
    const timelock = ROLES.owner.base;
    const salt = keccak256(stringToBytes("cascade:v3-launch:accept-ownership:base"));
    const { schedule, execute } = timelockCalls(timelock, calls, salt, 172_800n);
    expect(schedule.to).toBe(timelock);
    expect(decodeFunctionData({ abi: TIMELOCK_ABI, data: schedule.data })).toEqual({
      functionName: "scheduleBatch",
      args: [calls.map((c) => c.to), [0n, 0n], [ACCEPT, ACCEPT], `0x${"00".repeat(32)}`, salt, 172_800n],
    });
    expect(decodeFunctionData({ abi: TIMELOCK_ABI, data: execute.data })).toEqual({
      functionName: "executeBatch",
      args: [calls.map((c) => c.to), [0n, 0n], [ACCEPT, ACCEPT], `0x${"00".repeat(32)}`, salt],
    });
  });
});

describe("what kind of account an owner or guardian is", () => {
  const probe = (code: Hex, answers: Partial<Record<"getMinDelay" | "getThreshold", () => unknown>>) =>
    fakeChain([SAFE_PROBE_ABI, TIMELOCK_ABI], {
      getMinDelay: answers.getMinDelay ?? (() => { throw revert("no"); }),
      getThreshold: answers.getThreshold ?? (() => { throw revert("no"); }),
    }, { eth_getCode: () => code }).ctx;

  it("tells a plain account, a timelock, a Safe and another contract apart", async () => {
    expect(await accountKind(probe("0x", {}), "base", ROLES.owner.base)).toEqual({ kind: "account" });
    expect(await accountKind(probe(CODE, { getMinDelay: () => 172_800n }), "base", ROLES.owner.base)).toEqual({ kind: "timelock", minDelay: 172_800n });
    expect(await accountKind(probe(CODE, { getThreshold: () => 2n }), "base", ROLES.owner.base)).toEqual({ kind: "safe" });
    expect(await accountKind(probe(CODE, {}), "base", ROLES.owner.base)).toEqual({ kind: "contract" });
  });
});

const launch = v3Record("live", buildPlanV3(4, 9, COLDKEY, "launch", ROLES));
const a = launch.plan.addresses as ReturnType<typeof buildPlanV3>["addresses"];

/** Chains where each owned contract has `state` and each owner address is of `kinds`' kind. */
function chains(state: Record<string, { owner: Address; pendingOwner: Address }>, kinds: Record<string, "account" | "safe" | "timelock">) {
  const kindAt = (chain: string, to: string) => kinds[`${chain}:${to.toLowerCase()}`] ?? "account";
  return fakeChain([OWNABLE, SAFE_PROBE_ABI, TIMELOCK_ABI], {
    owner: (_x, c) => state[c.to.toLowerCase()].owner,
    pendingOwner: (_x, c) => state[c.to.toLowerCase()].pendingOwner,
    getMinDelay: (_x, c) => {
      if (kindAt(c.chain, c.to) !== "timelock") throw revert("no");
      return 172_800n;
    },
    getThreshold: (_x, c) => {
      if (kindAt(c.chain, c.to) !== "safe") throw revert("no");
      return 2n;
    },
  }, { eth_getCode: (chain, p) => (kindAt(chain, p[0] as string) === "account" ? "0x" : CODE) });
}
const offered = {
  [a.frontDoor.toLowerCase()]: { owner: WALLET, pendingOwner: ROLES.owner.base },
  [a.staker.toLowerCase()]: { owner: WALLET, pendingOwner: ROLES.owner.base },
  [a.vault.toLowerCase()]: { owner: WALLET, pendingOwner: ROLES.owner.bittensor },
};
const safes = { [`base:${ROLES.owner.base.toLowerCase()}`]: "safe", [`bittensor:${ROLES.owner.bittensor.toLowerCase()}`]: "safe" } as const;
const outDir = () => mkdtempSync(join(tmpdir(), "ops-handoff-"));
const readJson = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));

describe("handoff", () => {
  it("writes one batch per chain for Safe owners: acceptOwnership on each contract offered to it", async () => {
    const dir = outDir();
    const out = await handoff(chains(offered, safes).ctx, launch, { outDir: dir, name: "v3-launch", now: 1_800_000_000_000 });
    expect(readdirSync(dir).sort()).toEqual(["v3-launch-accept-ownership-base.json", "v3-launch-accept-ownership-bittensor.json"]);
    const base = readJson(dir, "v3-launch-accept-ownership-base.json");
    expect(base).toMatchObject({ version: "1.0", chainId: "8453", meta: { createdFromSafeAddress: ROLES.owner.base } });
    expect(base.transactions).toEqual([
      { to: a.frontDoor, value: "0", data: ACCEPT },
      { to: a.staker, value: "0", data: ACCEPT },
    ]);
    const bit = readJson(dir, "v3-launch-accept-ownership-bittensor.json");
    expect(bit).toMatchObject({ chainId: "964", meta: { createdFromSafeAddress: ROLES.owner.bittensor } });
    expect(bit.transactions).toEqual([{ to: a.vault, value: "0", data: ACCEPT }]);
    expect(base.meta.checksum).toBe(safeChecksum({ ...base, meta: { ...base.meta, checksum: undefined } }));
    expect(out.files).toEqual([join(dir, "v3-launch-accept-ownership-base.json"), join(dir, "v3-launch-accept-ownership-bittensor.json")]);
  });

  it("for a timelock owner, writes the schedule and execute batches its proposer and executor submit", async () => {
    const dir = outDir();
    const out = await handoff(chains(offered, { ...safes, [`base:${ROLES.owner.base.toLowerCase()}`]: "timelock" }).ctx, launch, { outDir: dir, name: "v3-launch", now: 1 });
    expect(readdirSync(dir).sort()).toEqual([
      "v3-launch-accept-ownership-base-1-schedule.json",
      "v3-launch-accept-ownership-base-2-execute.json",
      "v3-launch-accept-ownership-bittensor.json",
    ]);
    const schedule = readJson(dir, "v3-launch-accept-ownership-base-1-schedule.json");
    expect(schedule.transactions).toHaveLength(1);
    expect(schedule.transactions[0].to).toBe(ROLES.owner.base);
    const { functionName, args } = decodeFunctionData({ abi: TIMELOCK_ABI, data: schedule.transactions[0].data });
    expect(functionName).toBe("scheduleBatch");
    expect(args?.[0]).toEqual([a.frontDoor, a.staker]);
    expect(args?.[5]).toBe(172_800n);
    expect(out.lines.join("\n")).toMatch(/timelock .*172800 s/);
  });

  it("for a plain-account owner, writes no file and prints the transactions to send from it", async () => {
    const dir = outDir();
    const out = await handoff(chains(offered, {}).ctx, launch, { outDir: dir, name: "v3-launch", now: 1 });
    expect(readdirSync(dir)).toEqual([]);
    expect(out.lines).toContain(`  to ${a.frontDoor} data ${ACCEPT}  (acceptOwnership() on the front door)`);
    expect(out.lines).toContain(`  to ${a.vault} data ${ACCEPT}  (acceptOwnership() on the vault)`);
  });

  it("skips a contract already accepted, and reports one not offered to the final owner", async () => {
    const dir = outDir();
    const out = await handoff(
      chains(
        {
          ...offered,
          [a.frontDoor.toLowerCase()]: { owner: ROLES.owner.base, pendingOwner: zeroAddress },
          [a.vault.toLowerCase()]: { owner: WALLET, pendingOwner: zeroAddress },
        },
        safes,
      ).ctx,
      launch,
      { outDir: dir, name: "v3-launch", now: 1 },
    );
    expect(readdirSync(dir)).toEqual(["v3-launch-accept-ownership-base.json"]);
    expect(readJson(dir, "v3-launch-accept-ownership-base.json").transactions).toEqual([{ to: a.staker, value: "0", data: ACCEPT }]);
    expect(out.lines.join("\n")).toMatch(/Bittensor CascadeVault: not offered to .* yet \(owner .*, pendingOwner 0x0{40}\): run deploy to finish the plan/);
  });

  it("has nothing to hand off for a test plan, and reads nothing", async () => {
    const c = chains(offered, safes);
    await expect(handoff(c.ctx, v3Record(), { outDir: outDir(), name: "v3-test", now: 1 })).rejects.toThrow(/the test plan keeps the test wallet as owner: nothing to hand off/);
    expect(c.calls).toEqual([]);
  });
});

describe("ownership status", () => {
  it("reports each contract's owner and pending owner against the plan", async () => {
    const r = await ownershipStatus(
      chains({ ...offered, [a.frontDoor.toLowerCase()]: { owner: ROLES.owner.base, pendingOwner: zeroAddress }, [a.vault.toLowerCase()]: { owner: WALLET, pendingOwner: ROLES.keeper } }, safes).ctx,
      launch,
    );
    expect(r.ok).toBe(false);
    expect(r.lines).toEqual([
      `Base CascadeFrontDoor ${a.frontDoor}: owner ${ROLES.owner.base}, pendingOwner ${zeroAddress} — accepted by the final owner`,
      `Base CascadeStaker ${a.staker}: owner ${WALLET}, pendingOwner ${ROLES.owner.base} — offered, waiting for ${ROLES.owner.base} to accept`,
      `Bittensor CascadeVault ${a.vault}: owner ${WALLET}, pendingOwner ${ROLES.keeper} — UNEXPECTED: the plan hands it to ${ROLES.owner.bittensor}`,
      "The oracle and both adapters have no owner.",
    ]);
  });

  it("a test plan's contracts stay with the test wallet", async () => {
    const t = v3Record();
    const ta = t.plan.addresses as ReturnType<typeof buildPlanV3>["addresses"];
    const state = Object.fromEntries([ta.frontDoor, ta.staker, ta.vault].map((x) => [x.toLowerCase(), { owner: WALLET, pendingOwner: zeroAddress }]));
    const r = await ownershipStatus(chains(state, {}).ctx, t);
    expect(r.ok).toBe(true);
    expect(r.lines[0]).toBe(`Base CascadeFrontDoor ${ta.frontDoor}: owner ${WALLET}, pendingOwner ${zeroAddress} — the test plan keeps the test wallet as owner`);
  });
});

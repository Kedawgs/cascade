import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AbiFunction, type Address, encodeFunctionData, getAddress, type Hex, numberToHex, parseAbi, toFunctionSignature, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { loadArtifact } from "../src/artifacts.ts";
import { paths, SETTINGS_V3, targets, WALLET } from "../src/config.ts";
import { type DeployDeps, deploy, effectPresent } from "../src/deploy.ts";
import { buildPlanV3, type PlanV3, rolesOf } from "../src/plan.ts";
import { requireReady } from "../src/keeper/actions.ts";
import { type DeploymentRecord, loadRecord } from "../src/record.ts";
import { webEnv } from "../src/webconfig.ts";
import { launchRolesFromEnv, roleProblems, type Roles, TEST_ROLES } from "../src/roles.ts";
import type { Rpc } from "../src/rpc.ts";
import type { Ctx, Sent } from "../src/send.ts";
import type { PlannedStep } from "../src/types.ts";
import { expectations, ownershipChecks } from "../src/verify.ts";
import { fakeChain, v3Record } from "./fake-keeper.ts";
import { ROLES, ROLES_ENV } from "./launch-roles.ts";

const COLDKEY: Hex = `0x${"22".repeat(32)}`;
const launch = buildPlanV3(4, 9, COLDKEY, "launch", ROLES);
const test = buildPlanV3(4, 9, COLDKEY);
const step = (plan: PlanV3, id: string) => plan.steps.find((s) => s.id === id)!;

describe("launch roles come from the environment, never from the test wallet", () => {
  it("reads all six, per chain for the owner and the guardian", () => {
    expect(launchRolesFromEnv(ROLES_ENV)).toEqual(ROLES);
    // lower case is accepted and checksummed
    const lower = Object.fromEntries(Object.entries(ROLES_ENV).map(([k, v]) => [k, v.toLowerCase()]));
    expect(launchRolesFromEnv(lower)).toEqual(ROLES);
  });

  it("refuses when any is missing, naming every one, and never falls back to the test wallet", () => {
    expect(() => launchRolesFromEnv({})).toThrow(
      /OPS_LAUNCH_OWNER_BASE is not set.*OPS_LAUNCH_OWNER_BITTENSOR is not set.*OPS_LAUNCH_GUARDIAN_BASE is not set.*OPS_LAUNCH_GUARDIAN_BITTENSOR is not set.*OPS_LAUNCH_KEEPER is not set.*OPS_LAUNCH_TREASURY is not set/s,
    );
    for (const name of Object.keys(ROLES_ENV)) {
      const env: Record<string, string | undefined> = { ...ROLES_ENV, [name]: " " };
      expect(() => launchRolesFromEnv(env), name).toThrow(`${name} is not set`);
    }
  });

  it("refuses something that is not an address, a bad checksum and the zero address", () => {
    expect(() => launchRolesFromEnv({ ...ROLES_ENV, OPS_LAUNCH_KEEPER: "0x1234" })).toThrow(/OPS_LAUNCH_KEEPER "0x1234" is not an address/);
    // mixed case with one letter's case flipped: a mistyped checksum
    const good = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
    const flipped = `0x${good[2] === good[2].toUpperCase() ? good[2].toLowerCase() : good[2].toUpperCase()}${good.slice(3)}`;
    expect(() => launchRolesFromEnv({ ...ROLES_ENV, OPS_LAUNCH_OWNER_BASE: flipped })).toThrow(/OPS_LAUNCH_OWNER_BASE ".*" is not an address/);
    expect(() => launchRolesFromEnv({ ...ROLES_ENV, OPS_LAUNCH_TREASURY: zeroAddress })).toThrow(/OPS_LAUNCH_TREASURY is the zero address/);
  });

  it("keeps the guardian apart from the owner and the keeper, and the keeper from the owner, on either chain", () => {
    expect(roleProblems(ROLES)).toEqual([]);
    const cases: [Partial<Roles>, RegExp][] = [
      [{ guardian: { ...ROLES.guardian, base: ROLES.owner.base } }, /the guardian on Base .* is also the owner on Base/],
      [{ guardian: { ...ROLES.guardian, bittensor: ROLES.owner.base } }, /the guardian on Bittensor .* is also the owner on Base/],
      [{ keeper: ROLES.owner.bittensor }, /the keeper .* is also the owner on Bittensor/],
      [{ keeper: ROLES.guardian.base }, /the keeper .* is also the guardian on Base/],
    ];
    for (const [over, problem] of cases) {
      const r = { ...ROLES, ...over };
      expect(roleProblems(r)).toEqual([expect.stringMatching(problem)]);
      expect(() => buildPlanV3(4, 9, COLDKEY, "launch", r)).toThrow(problem);
    }
  });

  it("refuses the test wallet as owner or guardian: the launch hands those away from the deployer's hot key", () => {
    expect(roleProblems({ ...ROLES, owner: { ...ROLES.owner, bittensor: WALLET } })).toEqual([
      expect.stringMatching(/the owner on Bittensor is the test wallet/),
    ]);
    expect(roleProblems({ ...ROLES, guardian: { ...ROLES.guardian, base: WALLET } })).toEqual([
      expect.stringMatching(/the guardian on Base is the test wallet/),
    ]);
    // the keeper and the treasury may be the test wallet
    expect(roleProblems({ ...ROLES, keeper: WALLET, treasury: WALLET })).toEqual([]);
  });

  it("a launch plan needs its roles, and a test plan takes none", () => {
    expect(() => buildPlanV3(4, 9, COLDKEY, "launch")).toThrow(/a launch plan needs its roles/);
    expect(() => buildPlanV3(4, 9, COLDKEY, "test", ROLES)).toThrow(/the test plan keeps the test wallet in every role/);
  });
});

describe("a launch plan separates the roles", () => {
  it("stores its roles; a test plan has none and keeps the test wallet everywhere", () => {
    expect(launch.roles).toEqual(ROLES);
    expect(rolesOf(launch)).toEqual(ROLES);
    expect("roles" in test).toBe(false);
    expect(rolesOf(test)).toEqual(TEST_ROLES);
    expect(TEST_ROLES).toEqual({ owner: { base: WALLET, bittensor: WALLET }, guardian: { base: WALLET, bittensor: WALLET }, keeper: WALLET, treasury: SETTINGS_V3.treasury });
  });

  it("deploys with the test wallet as the temporary owner and the final guardians from the constructors", () => {
    expect(step(launch, "frontDoor").args.slice(4, 6)).toEqual([WALLET, ROLES.guardian.base]);
    expect(step(launch, "vault").args.slice(3, 5)).toEqual([WALLET, ROLES.guardian.bittensor]);
    expect(step(launch, "staker").args.slice(3, 5)).toEqual([WALLET, ROLES.treasury]);
  });

  it("sets the keeper and the treasury from the roles", () => {
    expect(step(launch, "fdSetKeeper").args).toEqual([ROLES.keeper]);
    expect(step(launch, "setKeeper").args).toEqual([ROLES.keeper]);
    expect(step(launch, "setRewardCut").args).toEqual([ROLES.treasury, 1_000]);
    expect(step(launch, "fdSetKeeper").label).toBe(`make ${ROLES.keeper} the front door's keeper`);
    expect(step(launch, "setKeeper").label).toBe(`make ${ROLES.keeper} the vault's keeper`);
  });

  it("ends each chain by offering ownership to that chain's final owner", () => {
    const calls = ["fdTransferOwnership", "stakerTransferOwnership", "vaultTransferOwnership"].map((id) => {
      const s = step(launch, id);
      return s.kind === "call" && [s.chain, s.to, s.functionName, s.args];
    });
    expect(calls).toEqual([
      ["base", launch.addresses.frontDoor, "transferOwnership", [ROLES.owner.base]],
      ["base", launch.addresses.staker, "transferOwnership", [ROLES.owner.base]],
      ["bittensor", launch.addresses.vault, "transferOwnership", [ROLES.owner.bittensor]],
    ]);
    for (const chain of ["base", "bittensor"] as const) {
      const ids = launch.steps.filter((s) => s.chain === chain).map((s) => s.id);
      const firstTransfer = ids.findIndex((id) => id.endsWith("TransferOwnership"));
      expect(ids.slice(firstTransfer).every((id) => id.endsWith("TransferOwnership")), chain).toBe(true);
    }
  });

  it("hands off every contract that has an owner: the front door, the staker and the vault; the oracle and the adapters have none", () => {
    const dir = paths({}).contractsDir;
    const owned = ["CcipBaseAdapter", "CcipBittensorAdapter", "CascadeTwapOracle", "CascadeFrontDoor", "CascadeStaker", "CascadeVault"].filter((n) =>
      loadArtifact(dir, n).abi.some((i) => i.type === "function" && ["owner", "transferOwnership", "acceptOwnership"].includes(i.name)),
    );
    expect(owned).toEqual(["CascadeFrontDoor", "CascadeStaker", "CascadeVault"]);
    const at = { CascadeFrontDoor: launch.addresses.frontDoor, CascadeStaker: launch.addresses.staker, CascadeVault: launch.addresses.vault };
    const handed = launch.steps.filter((s) => s.kind === "call" && s.functionName === "transferOwnership").map((s) => (s as { to: Address }).to);
    expect(handed).toEqual(owned.map((n) => at[n as keyof typeof at]));
    // each is Ownable2Step: it has pendingOwner and acceptOwnership, so the transfer only offers
    for (const n of owned) {
      const sigs = loadArtifact(dir, n).abi.filter((i): i is AbiFunction => i.type === "function").map((i) => toFunctionSignature(i));
      expect(sigs, n).toEqual(expect.arrayContaining(["pendingOwner()", "acceptOwnership()", "transferOwnership(address)"]));
    }
  });

  it("leaves the test plan's steps as they were: no hand-off", () => {
    expect(test.steps.some((s) => s.id.endsWith("TransferOwnership"))).toBe(false);
    expect(step(test, "fdSetKeeper").label).toBe("make the test wallet the front door's keeper");
    expect(step(test, "setKeeper").label).toBe("make the test wallet the vault's keeper");
  });
});

const VIEWS = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function keeper() view returns (address)",
  "function treasury() view returns (address)",
  "function rewardCutBps() view returns (uint16)",
]);

describe("deploy finds a launch step already done from the roles", () => {
  const withState = (state: { owner?: Address; pendingOwner?: Address; keeper?: Address; treasury?: Address }) =>
    fakeChain([VIEWS], {
      owner: () => state.owner ?? WALLET,
      pendingOwner: () => state.pendingOwner ?? zeroAddress,
      keeper: () => state.keeper ?? zeroAddress,
      treasury: () => state.treasury ?? zeroAddress,
      rewardCutBps: () => 1_000,
    }, { eth_getCode: () => "0x6080" }).ctx;

  it("a transfer is done once the final owner is pending or has accepted", async () => {
    for (const id of ["fdTransferOwnership", "stakerTransferOwnership", "vaultTransferOwnership"]) {
      const final = id === "vaultTransferOwnership" ? ROLES.owner.bittensor : ROLES.owner.base;
      expect(await effectPresent(withState({}), launch, step(launch, id)), id).toBe(false);
      expect(await effectPresent(withState({ pendingOwner: final }), launch, step(launch, id)), id).toBe(true);
      expect(await effectPresent(withState({ owner: final }), launch, step(launch, id)), id).toBe(true);
      expect(await effectPresent(withState({ pendingOwner: ROLES.keeper }), launch, step(launch, id)), id).toBe(false);
    }
  });

  it("the keepers and the reward cut compare with the plan's keeper and treasury, not the test wallet", async () => {
    for (const id of ["fdSetKeeper", "setKeeper"]) {
      expect(await effectPresent(withState({ keeper: WALLET }), launch, step(launch, id)), id).toBe(false);
      expect(await effectPresent(withState({ keeper: ROLES.keeper }), launch, step(launch, id)), id).toBe(true);
      // the test plan still wants the test wallet
      expect(await effectPresent(withState({ keeper: WALLET }), test, step(test, id)), id).toBe(true);
    }
    expect(await effectPresent(withState({ treasury: WALLET }), launch, step(launch, "setRewardCut"))).toBe(false);
    expect(await effectPresent(withState({ treasury: ROLES.treasury }), launch, step(launch, "setRewardCut"))).toBe(true);
  });
});

/** A deploy world on fake chains: every step lands; code reads answer from `code`. */
function world(code: Record<string, Hex> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ops-launch-"));
  const recordPath = join(dir, "v3-launch.json");
  const asked: string[] = [];
  const nonce = { base: 4, bittensor: 9 };
  const sent: string[] = [];
  const rpc: Rpc = {
    async request(chain, method, params) {
      asked.push(method);
      if (method === "eth_getTransactionCount") return numberToHex(nonce[chain]);
      if (method === "eth_getCode") return code[`${chain}:${(params[0] as string).toLowerCase()}`] ?? "0x";
      throw new Error(`unexpected ${method}`);
    },
  };
  const ctx: Ctx = { live: false, targets: targets({}).rehearsal, rpc, runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) }, paths: paths({}), log: () => undefined, receiptTimeoutMs: 10, pollMs: 1 };
  const land = async (s: PlannedStep): Promise<Sent> => {
    sent.push(s.id);
    nonce[s.chain]++;
    return { hash: `0x${"cd".repeat(32)}`, block: 1, gasUsed: 1n, costWei: 1n };
  };
  const deps: DeployDeps = {
    sendCreate: (_c, req) => land(req as PlannedStep),
    sendCall: (_c, req) => land(req as PlannedStep),
    effectPresent: async () => false,
    readColdkey: async () => COLDKEY,
    deployBlock: async () => 1,
  };
  return { ctx, deps, recordPath, asked, sent };
}

describe("deploy plans a launch only with every role in place", () => {
  it("refuses a new launch plan without its roles before reading anything", async () => {
    const w = world();
    const refuse = () => {
      throw new Error("OPS_LAUNCH_OWNER_BASE is not set");
    };
    await expect(deploy(w.ctx, w.recordPath, { newPlan: false, v3: true, cadence: "launch", roles: refuse }, w.deps)).rejects.toThrow(/OPS_LAUNCH_OWNER_BASE is not set/);
    await expect(deploy(w.ctx, w.recordPath, { newPlan: false, v3: true, cadence: "launch" }, w.deps)).rejects.toThrow(/a launch plan needs its roles/);
    expect(w.asked).toEqual([]);
    expect(loadRecord(w.recordPath)).toBeNull();
  });

  it("deploy --new-plan without the roles refuses before archiving the old plan", async () => {
    const w = world();
    await deploy(w.ctx, w.recordPath, { newPlan: false, v3: true }, w.deps);
    const before = readFileSync(w.recordPath, "utf8");
    const refuse = () => {
      throw new Error("OPS_LAUNCH_TREASURY is not set");
    };
    await expect(deploy(w.ctx, w.recordPath, { newPlan: true, v3: true, cadence: "launch", roles: refuse }, w.deps)).rejects.toThrow(/OPS_LAUNCH_TREASURY/);
    expect(readFileSync(w.recordPath, "utf8")).toBe(before);
    expect(readdirSync(dirname(w.recordPath)).filter((n) => n.includes("abandoned"))).toEqual([]);
  });

  it("refuses a treasury with contract code on either chain before planning", async () => {
    for (const chain of ["base", "bittensor"]) {
      const w = world({ [`${chain}:${ROLES.treasury.toLowerCase()}`]: "0x6080" });
      await expect(deploy(w.ctx, w.recordPath, { newPlan: false, v3: true, cadence: "launch", roles: () => ROLES }, w.deps)).rejects.toThrow(
        /the treasury .* has contract code on (Base|Bittensor).*plain account/,
      );
      expect(w.sent).toEqual([]);
      expect(loadRecord(w.recordPath)).toBeNull();
    }
  });

  it("plans and deploys a launch with its roles, ending with the hand-offs", async () => {
    const w = world();
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: false, v3: true, cadence: "launch", roles: () => ROLES }, w.deps);
    expect((rec.plan as PlanV3).roles).toEqual(ROLES);
    expect(w.sent.filter((id) => id.endsWith("TransferOwnership"))).toEqual(["fdTransferOwnership", "stakerTransferOwnership", "vaultTransferOwnership"]);
    expect(w.sent.at(-1)).toBe("vaultTransferOwnership");
  });

  it("a resumed launch keeps the record's roles, and refuses when the environment now names others", async () => {
    const w = world();
    await deploy(w.ctx, w.recordPath, { newPlan: false, v3: true, cadence: "launch", roles: () => ROLES }, w.deps);
    const moved = { ...ROLES, owner: { ...ROLES.owner, base: ROLES.treasury } };
    await expect(deploy(w.ctx, w.recordPath, { newPlan: false, v3: true, cadence: "launch", roles: () => moved }, w.deps)).rejects.toThrow(
      /plans the owner on Base as .*, but the environment now says .*: deploy follows the record; .*--new-plan.*nothing sent/,
    );
    // roles the environment can't give (unset) leave the record's in force
    const unset = () => {
      throw new Error("OPS_LAUNCH_KEEPER is not set");
    };
    await expect(deploy(w.ctx, w.recordPath, { newPlan: false, v3: true, cadence: "launch", roles: unset }, w.deps)).resolves.toBeTruthy();
  });

  it("a test plan asks for no roles", async () => {
    const w = world();
    const never = () => {
      throw new Error("asked");
    };
    const rec = await deploy(w.ctx, w.recordPath, { newPlan: false, v3: true, roles: never }, w.deps);
    expect("roles" in rec.plan).toBe(false);
    expect(w.asked).not.toContain("eth_getCode");
  });
});

describe("verify checks a launch against its roles", () => {
  const exp = (contract: string, field: string) => expectations(launch).find((e) => e.contract === contract && e.field === field);

  it("expects the plan's guardians, keeper and treasury, and leaves the owner to the ownership check", () => {
    expect(exp("CascadeFrontDoor", "guardian")?.expected).toBe(ROLES.guardian.base);
    expect(exp("CascadeVault", "guardian")?.expected).toBe(ROLES.guardian.bittensor);
    expect(exp("CascadeFrontDoor", "keeper")?.expected).toBe(ROLES.keeper);
    expect(exp("CascadeVault", "keeper")?.expected).toBe(ROLES.keeper);
    expect(exp("CascadeStaker", "treasury")?.expected).toBe(ROLES.treasury);
    expect(exp("CascadeVault", "treasury")?.expected).toBe(ROLES.treasury);
    for (const c of ["CascadeFrontDoor", "CascadeStaker", "CascadeVault"]) expect(exp(c, "owner"), c).toBeUndefined();
    // the test plan still expects the test wallet as owner
    expect(expectations(test).find((e) => e.contract === "CascadeVault" && e.field === "owner")?.expected).toBe(WALLET);
  });

  const owners = (state: Record<string, { owner: Address; pendingOwner: Address }>) =>
    fakeChain([VIEWS], {
      owner: (_a, c) => state[c.to.toLowerCase()].owner,
      pendingOwner: (_a, c) => state[c.to.toLowerCase()].pendingOwner,
    }).ctx;
  const a = launch.addresses;
  const each = (f: (chain: "base" | "bittensor") => { owner: Address; pendingOwner: Address }) => ({
    [a.frontDoor.toLowerCase()]: f("base"),
    [a.staker.toLowerCase()]: f("base"),
    [a.vault.toLowerCase()]: f("bittensor"),
  });

  it("an offered hand-off is reported as pending acceptance, a warning and not a failure", async () => {
    const r = await ownershipChecks(owners(each((c) => ({ owner: WALLET, pendingOwner: ROLES.owner[c] }))), launch);
    expect(r.failures).toEqual([]);
    expect(r.warnings).toEqual([
      `Base CascadeFrontDoor: ownership offered to ${ROLES.owner.base} and not accepted yet (the owner is still the deployer ${WALLET}): accept it with the files from pnpm ops handoff`,
      `Base CascadeStaker: ownership offered to ${ROLES.owner.base} and not accepted yet (the owner is still the deployer ${WALLET}): accept it with the files from pnpm ops handoff`,
      `Bittensor CascadeVault: ownership offered to ${ROLES.owner.bittensor} and not accepted yet (the owner is still the deployer ${WALLET}): accept it with the files from pnpm ops handoff`,
    ]);
  });

  it("an accepted hand-off passes quietly; the owner may be a contract (verify reads no code)", async () => {
    expect(await ownershipChecks(owners(each((c) => ({ owner: ROLES.owner[c], pendingOwner: zeroAddress }))), launch)).toEqual({ failures: [], warnings: [], accepted: true });
  });

  it("anything else fails: no offer, an offer to someone else, or a new offer after acceptance", async () => {
    const r = await ownershipChecks(
      owners({
        [a.frontDoor.toLowerCase()]: { owner: WALLET, pendingOwner: zeroAddress },
        [a.staker.toLowerCase()]: { owner: WALLET, pendingOwner: ROLES.keeper },
        [a.vault.toLowerCase()]: { owner: ROLES.owner.bittensor, pendingOwner: ROLES.keeper },
      }),
      launch,
    );
    expect(r.warnings).toEqual([]);
    expect(r.failures).toEqual([
      `Base CascadeFrontDoor: owner ${WALLET}, pendingOwner ${zeroAddress}; the plan hands it to ${ROLES.owner.base}`,
      `Base CascadeStaker: owner ${WALLET}, pendingOwner ${ROLES.keeper}; the plan hands it to ${ROLES.owner.base}`,
      `Bittensor CascadeVault: owner ${ROLES.owner.bittensor}, pendingOwner ${ROLES.keeper}; the plan hands it to ${ROLES.owner.bittensor}`,
    ]);
  });

  it("encodes the hand-off as Ownable2Step's transferOwnership", () => {
    const s = step(launch, "fdTransferOwnership");
    if (s.kind !== "call") throw new Error("not a call");
    expect(encodeFunctionData({ abi: s.abi, functionName: s.functionName, args: s.args } as never)).toBe(
      encodeFunctionData({ abi: parseAbi(["function transferOwnership(address newOwner)"]), functionName: "transferOwnership", args: [ROLES.owner.base] }),
    );
  });
});

describe("a launch goes public, and its keeper runs, only once the final owners have accepted", () => {
  // the keeper is the test wallet here, as the ops keeper signs by default
  const plan = buildPlanV3(4, 9, COLDKEY, "launch", { ...ROLES, keeper: WALLET });
  const done = Object.fromEntries(plan.steps.map((s) => [s.id, { hash: `0x${"cd".repeat(32)}` as Hex, block: 5, gasUsed: 1n, costWei: 1n }]));
  const rec = (handoff?: "accepted" | "pending"): DeploymentRecord => ({
    target: "live",
    wallet: WALLET,
    createdAt: "",
    plan,
    done,
    verify: { ok: true, failures: [], checkedAt: "", ...(handoff ? { handoff } : {}) },
  });
  const NOT_YET = /the final owners haven't accepted ownership yet.*pnpm ops handoff.*pnpm ops ownership.*pnpm ops verify/;

  it("verify records the hand-off: pending while offered, accepted once every owner has taken it", async () => {
    const a = plan.addresses;
    const chainOf = (to: string) => (to.toLowerCase() === a.vault.toLowerCase() ? "bittensor" : "base");
    const state = (owner: (c: "base" | "bittensor") => Address, pending: (c: "base" | "bittensor") => Address) =>
      fakeChain([VIEWS], { owner: (_x, c) => owner(chainOf(c.to)), pendingOwner: (_x, c) => pending(chainOf(c.to)) }).ctx;
    expect((await ownershipChecks(state(() => WALLET, (c) => ROLES.owner[c]), plan)).accepted).toBe(false);
    expect((await ownershipChecks(state((c) => ROLES.owner[c], () => zeroAddress), plan)).accepted).toBe(true);
    expect((await ownershipChecks(state(() => WALLET, () => zeroAddress), buildPlanV3(4, 9, COLDKEY))).accepted).toBeUndefined();
  });

  it("the keeper refuses a launch whose hand-off isn't accepted, naming handoff and ownership", () => {
    expect(() => requireReady(rec())).toThrow(NOT_YET);
    expect(() => requireReady(rec("pending"))).toThrow(NOT_YET);
    expect(() => requireReady(rec("accepted"))).not.toThrow();
    // a test record has no hand-off
    expect(() => requireReady(v3Record())).not.toThrow();
  });

  it("web-config refuses it too", () => {
    expect(() => webEnv(rec("pending"))).toThrow(NOT_YET);
    expect(webEnv(rec("accepted"))).toContain(`NEXT_PUBLIC_CASCADE_FRONT_DOOR=${plan.addresses.frontDoor}`);
  });
});

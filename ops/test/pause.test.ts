import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, type Hex, keccak256, numberToHex, parseAbi, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../src/args.ts";
import { type ChainName, paths, WALLET } from "../src/config.ts";
import { buildPlanV3 } from "../src/plan.ts";
import { PAUSE_ABI, type PauseOpts, pauseCommand, pauseSigner } from "../src/pause.ts";
import { SAFE_PROBE_ABI, TIMELOCK_ABI } from "../src/safe.ts";
import type { CallRequest } from "../src/types.ts";
import type { Ctx, Sent } from "../src/send.ts";
import { COLDKEY, fakeChain, revert, v3Record } from "./fake-keeper.ts";
import { ROLES } from "./launch-roles.ts";

const rec = v3Record("live", buildPlanV3(4, 9, COLDKEY, "launch", ROLES));
const fd = rec.plan.addresses.frontDoor;
const vault = rec.plan.addresses.vault;
const PAUSE = encodeFunctionData({ abi: PAUSE_ABI, functionName: "pause" });
const SENT: Sent = { hash: `0x${"ee".repeat(32)}`, block: 1, gasUsed: 30_000n, costWei: 1n };

interface World {
  paused?: Partial<Record<ChainName, boolean>>;
  /** what kind of account each address is (default: a plain account) */
  kinds?: Record<string, "safe" | "timelock">;
  /** the account the keystore signs as */
  keystoreSigns?: Address;
  estimateFails?: ChainName;
  /** each signer's balance (default 1 ETH or TAO, plenty) */
  balance?: bigint;
}

function world(w: World = {}) {
  const chainOf = (to: string): ChainName => (to.toLowerCase() === vault.toLowerCase() ? "bittensor" : "base");
  const kindOf = (a: string) => w.kinds?.[a.toLowerCase()];
  const f = fakeChain(
    [PAUSE_ABI, SAFE_PROBE_ABI, TIMELOCK_ABI],
    {
      paused: (_x, c) => w.paused?.[chainOf(c.to)] ?? false,
      guardian: (_x, c) => ROLES.guardian[chainOf(c.to)],
      // before the hand-off is accepted, the test wallet is still the owner
      owner: () => WALLET,
      getMinDelay: (_x, c) => {
        if (kindOf(c.to) !== "timelock") throw revert("no");
        return 172_800n;
      },
      getThreshold: (_x, c) => {
        if (kindOf(c.to) !== "safe") throw revert("no");
        return 2n;
      },
    },
    {
      eth_getCode: (_c, p) => (kindOf(p[0] as string) ? "0x6080" : "0x"),
      eth_estimateGas: (chain) => {
        if (w.estimateFails === chain) throw revert("NotGuardian", chain);
        return numberToHex(30_000n);
      },
      eth_getTransactionCount: () => numberToHex(7),
      eth_gasPrice: () => numberToHex(10n ** 9n),
      eth_getBalance: () => numberToHex(w.balance ?? 10n ** 18n),
    },
  );
  const runs: string[][] = [];
  const ctx: Ctx = {
    ...f.ctx,
    runner: {
      run: async (_file, args) => {
        runs.push(args);
        return { code: 0, stdout: `${w.keystoreSigns ?? ROLES.guardian.base}\n`, stderr: "" };
      },
    },
  };
  const sends: { ctx: Ctx; req: CallRequest }[] = [];
  const deps = {
    sendCall: async (c: Ctx, req: CallRequest) => {
      sends.push({ ctx: c, req });
      return SENT;
    },
  };
  return { ctx, deps, sends, runs, calls: f.calls };
}

const outDir = () => mkdtempSync(join(tmpdir(), "ops-pause-"));
const opts = (o: Partial<PauseOpts> = {}): PauseOpts => ({
  action: "pause",
  target: "both",
  send: false,
  signer: (role, address) => ({ address, keystore: `/keys/${role}.json`, passwordFile: `/keys/${role}.pw`, name: `the ${role}` }),
  outDir: outDir(),
  name: "v3-launch",
  now: 1,
  ...o,
});

describe("pnpm ops pause and unpause: arguments", () => {
  it("pauses both by default, or the vault or the front door; a dry run unless --live", () => {
    expect(parseArgs(["pause"])).toEqual({ cmd: "pause", live: false, users: [], target: "both" });
    expect(parseArgs(["pause", "vault", "--live"])).toEqual({ cmd: "pause", live: true, users: [], target: "vault" });
    expect(parseArgs(["unpause", "front-door"])).toEqual({ cmd: "unpause", live: false, users: [], target: "front-door" });
    expect(() => parseArgs(["pause", "staker"])).toThrow(UsageError);
    expect(() => parseArgs(["pause", "vault", "both"])).toThrow(UsageError);
  });

  it("signs with the guardian's or the owner's own keystore, else the default one", () => {
    const p = paths({});
    const env = { OPS_GUARDIAN_KEYSTORE: "/g.json", OPS_GUARDIAN_PASSWORD_FILE: "/g.pw", OPS_OWNER_KEYSTORE: "/o.json", OPS_OWNER_PASSWORD_FILE: "/o.pw" };
    expect(pauseSigner(env, p, "guardian", ROLES.guardian.base)).toEqual({ address: ROLES.guardian.base, keystore: "/g.json", passwordFile: "/g.pw", name: "the guardian" });
    expect(pauseSigner(env, p, "owner", WALLET)).toEqual({ address: WALLET, keystore: "/o.json", passwordFile: "/o.pw", name: "the owner" });
    expect(pauseSigner({}, p, "guardian", WALLET)).toEqual({ address: WALLET, keystore: p.keystore, passwordFile: p.passwordFile, name: "the guardian" });
  });
});

describe("pause, the guardian a plain account", () => {
  it("a dry run checks the call and the keystore on both, and sends nothing", async () => {
    const w = world();
    // the Bittensor guardian is another address: the keystore given signs as the Base one only
    const r = await pauseCommand(w.ctx, rec, opts(), w.deps);
    expect(w.sends).toEqual([]);
    expect(r.lines[0]).toBe(
      `Base front door ${fd}: dry run: pause() from the guardian ${ROLES.guardian.base} would succeed (about 30,000 gas), and /keys/guardian.json signs as it. Add --live to send it.`,
    );
    expect(r.lines[1]).toBe(
      `PROBLEM — Bittensor vault ${vault}: the keystore /keys/guardian.json signs as ${ROLES.guardian.base}, not the guardian ${ROLES.guardian.bittensor}: set OPS_GUARDIAN_KEYSTORE and OPS_GUARDIAN_PASSWORD_FILE to its key`,
    );
    expect(r.ok).toBe(false);
    expect(w.calls.filter((c) => c.method === "eth_estimateGas")).toHaveLength(2);
  });

  it("a dry run warns when the key can't pay the gas: its balance below the gas limit at today's price", async () => {
    // 30,000 estimated, sent with 37,500 at 1 gwei: 0.0000375 a chain
    const short = world({ balance: 37_499n * 10n ** 9n, keystoreSigns: ROLES.guardian.base });
    const r = await pauseCommand(short.ctx, rec, opts({ target: "front-door" }), short.deps);
    expect(r.lines).toEqual([
      `Base front door ${fd}: dry run: pause() from the guardian ${ROLES.guardian.base} would succeed (about 30,000 gas), and /keys/guardian.json signs as it. Add --live to send it.`,
      `WARNING — Base front door ${fd}: the guardian ${ROLES.guardian.base} holds 0.000037499 ETH, but pause() needs about 0.0000375 ETH of gas (its 37,500 gas limit at today's price): fund it now, before you need it`,
    ]);
    const enough = world({ balance: 37_500n * 10n ** 9n, keystoreSigns: ROLES.guardian.base });
    expect((await pauseCommand(enough.ctx, rec, opts({ target: "front-door" }), enough.deps)).lines).toHaveLength(1);
  });

  it("--live sends pause() as the guardian, with its keystore and nonce, on each chain", async () => {
    const w = world();
    const r = await pauseCommand(w.ctx, rec, opts({ send: true }), w.deps);
    expect(w.sends.map((s) => [s.req.chain, s.req.to, s.req.functionName, s.req.nonce, s.ctx.signer?.address, s.ctx.signer?.keystore])).toEqual([
      ["base", fd, "pause", 7, ROLES.guardian.base, "/keys/guardian.json"],
      ["bittensor", vault, "pause", 7, ROLES.guardian.bittensor, "/keys/guardian.json"],
    ]);
    expect(r.lines).toEqual([`Base front door ${fd}: paused (transaction ${SENT.hash})`, `Bittensor vault ${vault}: paused (transaction ${SENT.hash})`]);
    expect(r.ok).toBe(true);
  });

  it("pauses only the target, and skips one already paused", async () => {
    const w = world({ paused: { base: true } });
    const r = await pauseCommand(w.ctx, rec, opts({ send: true }), w.deps);
    expect(r.lines[0]).toBe(`Base front door ${fd}: already paused`);
    expect(w.sends.map((s) => s.req.chain)).toEqual(["bittensor"]);
    const v = world();
    await pauseCommand(v.ctx, rec, opts({ send: true, target: "front-door" }), v.deps);
    expect(v.sends.map((s) => s.req.to)).toEqual([fd]);
  });

  it("a call that would fail is a problem on its own chain; the other chain still pauses", async () => {
    const w = world({ estimateFails: "base" });
    const r = await pauseCommand(w.ctx, rec, opts({ send: true }), w.deps);
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(new RegExp(`^PROBLEM — Base front door ${fd}: pause\\(\\) from the guardian ${ROLES.guardian.base} would fail \\(.*NotGuardian.*\\); nothing sent$`));
    expect(w.sends.map((s) => s.req.chain)).toEqual(["bittensor"]);
  });
});

describe("pause with a Safe guardian, unpause by the owner", () => {
  it("a Safe guardian gets a Transaction Builder file with pause(), even with --live; nothing is sent", async () => {
    const w = world({ kinds: { [ROLES.guardian.base.toLowerCase()]: "safe" } });
    const o = opts({ send: true, target: "front-door" });
    const r = await pauseCommand(w.ctx, rec, o, w.deps);
    expect(w.sends).toEqual([]);
    expect(readdirSync(o.outDir)).toEqual(["v3-launch-pause-base.json"]);
    const file = JSON.parse(readFileSync(join(o.outDir, "v3-launch-pause-base.json"), "utf8"));
    expect(file).toMatchObject({ chainId: "8453", meta: { createdFromSafeAddress: ROLES.guardian.base } });
    expect(file.transactions).toEqual([{ to: fd, value: "0", data: PAUSE }]);
    expect(r.files).toEqual([join(o.outDir, "v3-launch-pause-base.json")]);
    expect(r.lines.join("\n")).toMatch(/is a Safe: load .*v3-launch-pause-base\.json/);
  });

  it("unpause is the owner's: while the deployer still owns it, a dry run checks the owner's keystore", async () => {
    const w = world({ paused: { base: true, bittensor: true }, keystoreSigns: WALLET });
    const r = await pauseCommand(w.ctx, rec, opts({ action: "unpause" }), w.deps);
    expect(r.lines[0]).toBe(
      `Base front door ${fd}: dry run: unpause() from the owner ${WALLET} would succeed (about 30,000 gas), and /keys/owner.json signs as it. Add --live to send it.`,
    );
    expect(r.ok).toBe(true);
  });

  it("an owner behind a timelock gets the schedule and execute files", async () => {
    const owner = getAddress(ROLES.owner.base);
    const w = world({ paused: { base: true } });
    const withOwner = { ...w.ctx };
    const f = fakeChain(
      [PAUSE_ABI, SAFE_PROBE_ABI, TIMELOCK_ABI],
      { paused: () => true, owner: () => owner, getMinDelay: () => 172_800n, getThreshold: () => 2n, guardian: () => ROLES.guardian.base },
      { eth_getCode: () => "0x6080" },
    );
    const o = opts({ action: "unpause", target: "front-door" });
    const r = await pauseCommand({ ...withOwner, rpc: f.ctx.rpc }, rec, o, w.deps);
    expect(readdirSync(o.outDir).sort()).toEqual(["v3-launch-unpause-base-1-schedule.json", "v3-launch-unpause-base-2-execute.json"]);
    const schedule = JSON.parse(readFileSync(join(o.outDir, "v3-launch-unpause-base-1-schedule.json"), "utf8"));
    const { functionName, args } = decodeFunctionData({ abi: TIMELOCK_ABI, data: schedule.transactions[0].data as Hex });
    expect(functionName).toBe("scheduleBatch");
    expect(args?.[0]).toEqual([fd]);
    expect(args?.[2]).toEqual([encodeFunctionData({ abi: parseAbi(["function unpause()"]), functionName: "unpause" })]);
    expect(r.lines.join("\n")).toMatch(/timelock/);
    expect(w.sends).toEqual([]);
  });

  it("each unpause through a timelock is a new operation: the timelock refuses an id it has seen, even an executed one", async () => {
    const owner = getAddress(ROLES.owner.base);
    const w = world({ paused: { base: true } });
    const f = fakeChain(
      [PAUSE_ABI, SAFE_PROBE_ABI, TIMELOCK_ABI],
      { paused: () => true, owner: () => owner, getMinDelay: () => 172_800n, guardian: () => ROLES.guardian.base },
      { eth_getCode: () => "0x6080" },
    );
    /** The operation id OpenZeppelin's TimelockController gives a batch: hashOperationBatch. */
    const idOf = (file: string) => {
      const data = JSON.parse(readFileSync(file, "utf8")).transactions[0].data as Hex;
      const { args } = decodeFunctionData({ abi: TIMELOCK_ABI, data });
      const [targets, values, payloads, predecessor, salt] = args as [Address[], bigint[], Hex[], Hex, Hex];
      return {
        salt,
        id: keccak256(encodeAbiParameters(parseAbiParameters("address[], uint256[], bytes[], bytes32, bytes32"), [targets, values, payloads, predecessor, salt])),
      };
    };
    const ops = [];
    for (const now of [1_800_000_000_000, 1_800_000_060_000]) {
      const o = opts({ action: "unpause", target: "front-door", now });
      const r = await pauseCommand({ ...w.ctx, rpc: f.ctx.rpc }, rec, o, w.deps);
      const op = idOf(join(o.outDir, "v3-launch-unpause-base-1-schedule.json"));
      expect(idOf(join(o.outDir, "v3-launch-unpause-base-2-execute.json"))).toEqual(op);
      // printed, so the operator can find the operation on the timelock
      expect(r.lines.join("\n")).toContain(`salt ${op.salt}, operation id ${op.id}`);
      ops.push(op);
    }
    expect(ops[0].id).not.toBe(ops[1].id);
  });

  it("a test deployment pauses the same way, the test wallet being its guardian", async () => {
    const test = v3Record();
    const f = fakeChain([PAUSE_ABI], { paused: () => false, guardian: () => WALLET }, { eth_getCode: () => "0x", eth_estimateGas: () => numberToHex(30_000n), eth_getTransactionCount: () => numberToHex(3) });
    const sends: CallRequest[] = [];
    const r = await pauseCommand(f.ctx, test, opts({ send: true, target: "vault" }), { sendCall: async (_c, req) => (sends.push(req), SENT) });
    expect(sends.map((s) => [s.to, s.functionName])).toEqual([[test.plan.addresses.vault, "pause"]]);
    expect(r.ok).toBe(true);
  });
});

import { encodeFunctionResult, type Hex, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { type AlphaTargetDeps, main } from "../../scripts/alpha-target.ts";

// pnpm alpha-target (R4-O round 4, the re-review's Minor 3): the monitor's own record of the deploy's AlphaVault's
// migration target (rails.incoherent, alpha_target_seen:<vault> in meta), shown, or restored from a read of the chain:
// live while the target still reads, or at a past block through Bittensor's archive node. It never writes an address it
// didn't read as the vault's target.

const VAULT = "0x11837459896d96f821a8d88ec93a3c8d152033d4";
const NEW = "0x00000000000000000000000000000000000a2fa0";
const ZERO = "0x0000000000000000000000000000000000000000";
const ABI = parseAbi(["function migrationTarget() view returns (address)"]);
const KEY = `alpha_target_seen:${VAULT}`;

/** A fake wrangler (answers a --json SELECT with `rows`) and a fake Bittensor RPC (the target by block tag). */
function fake(o: { rows?: Record<string, unknown>[]; targetAt?: (tag: string) => string; chainId?: number } = {}) {
  const calls: string[][] = [];
  const asked: { rpc: string; to: string; tag: string }[] = [];
  const out: string[] = [];
  const deps: AlphaTargetDeps = {
    wrangler: async (args) => {
      calls.push(args);
      return args.includes("--json") ? JSON.stringify([{ results: o.rows ?? [], success: true }]) : "ok";
    },
    print: (line) => out.push(line),
    now: () => 1_800_000_000,
    chainId: async (rpc) => {
      asked.push({ rpc, to: "eth_chainId", tag: "" });
      return o.chainId ?? 964;
    },
    ethCall: async (rpc, to, _data, tag) => {
      asked.push({ rpc, to, tag });
      return encodeFunctionResult({ abi: ABI, functionName: "migrationTarget", result: (o.targetAt ?? (() => NEW))(tag) as Hex });
    },
  };
  return { deps, calls, asked, text: () => out.join("\n") };
}
const sqlOf = (args: string[]) => args[args.indexOf("--command") + 1];

describe("pnpm alpha-target", () => {
  it("--show prints the monitor's record of the vault's target, or that it has none", async () => {
    const f = fake({ rows: [{ k: KEY, v: NEW }] });
    expect(await main(["--env", "production", "--vault", VAULT, "--show"], f.deps)).toBe(0);
    expect(sqlOf(f.calls[0])).toBe(`SELECT k, v FROM meta WHERE k = '${KEY}'`);
    expect(f.text()).toContain(`the monitor's record of ${VAULT}'s migration target: ${NEW}`);
    const g = fake();
    await main(["--env", "production", "--vault", VAULT, "--show"], g.deps);
    expect(g.text()).toContain("the monitor has no record of its migration target");
    expect(g.asked).toEqual([]);
  });

  it("restores the record from the target read at a past block (Bittensor's archive node), and writes nothing else", async () => {
    const f = fake({ targetAt: (tag) => (tag === "0x694c00" ? NEW : ZERO) });
    expect(await main(["--env", "production", "--vault", VAULT, "--block", "6900736"], f.deps)).toBe(0);
    expect(f.asked).toEqual([
      { rpc: "https://archive.chain.opentensor.ai", to: "eth_chainId", tag: "" },
      { rpc: "https://archive.chain.opentensor.ai", to: VAULT, tag: "0x694c00" },
    ]);
    expect(f.calls.map(sqlOf)).toEqual([`INSERT INTO meta (k, v) VALUES ('${KEY}', '${NEW}') ON CONFLICT (k) DO UPDATE SET v = excluded.v`]);
    expect(f.text()).toContain(`${VAULT}'s migrationTarget() at block 6900736: ${NEW}`);
    // live (the latest block), and another RPC
    const g = fake();
    expect(await main(["--env", "test", "--vault", VAULT, "--block", "latest", "--rpc", "https://other.example"], g.deps)).toBe(0);
    expect(g.asked).toEqual([
      { rpc: "https://other.example", to: "eth_chainId", tag: "" },
      { rpc: "https://other.example", to: VAULT, tag: "latest" },
    ]);
  });

  it("refuses an RPC of another chain than Bittensor's (964) before it reads the vault or writes anything", async () => {
    const f = fake({ chainId: 8453 });
    expect(await main(["--env", "production", "--vault", VAULT, "--block", "6900736", "--rpc", "https://base.example"], f.deps)).toBe(2);
    expect(f.asked).toEqual([{ rpc: "https://base.example", to: "eth_chainId", tag: "" }]);
    expect(f.calls).toEqual([]);
    expect(f.text()).toContain("https://base.example is chain 8453, not Bittensor's (964): nothing read or written");
  });

  it("refuses a block where the vault announced no target: nothing written", async () => {
    const f = fake({ targetAt: () => ZERO });
    expect(await main(["--env", "production", "--vault", VAULT, "--block", "6900000"], f.deps)).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.text()).toContain("announced no migration target at block 6900000: nothing written");
  });

  it("with --dry-run reads the chain and prints the statement, running nothing on D1", async () => {
    const f = fake();
    expect(await main(["--env", "production", "--vault", VAULT, "--block", "6900736", "--dry-run"], f.deps)).toBe(0);
    expect(f.calls).toEqual([]);
    expect(f.text()).toContain(`INSERT INTO meta (k, v) VALUES ('${KEY}', '${NEW}')`);
  });

  it("refuses what it can't use: no env, a bad vault, neither or both of --show and --block, a bad block", async () => {
    for (const argv of [
      ["--vault", VAULT, "--show"],
      ["--env", "production", "--vault", "0x12", "--show"],
      ["--env", "production", "--vault", VAULT],
      ["--env", "production", "--vault", VAULT, "--show", "--block", "1"],
      ["--env", "production", "--vault", VAULT, "--block", "soon"],
    ]) {
      const f = fake();
      expect(await main(argv, f.deps), argv.join(" ")).toBe(2);
      expect(f.calls).toEqual([]);
      expect(f.asked).toEqual([]);
    }
  });
});

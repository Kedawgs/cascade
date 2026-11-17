import { type Hex, numberToHex, parseEther } from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { paths } from "../../../ops/src/config.ts";
import { decodeDeployment } from "../../../ops/src/keeper/core/deployment.ts";
import type { Rpc } from "../../../ops/src/keeper/core/rpc.ts";
import { type BuildV32, freezeBuildV32, type SourceV32 } from "../../../ops/src/v32/build.ts";
import type { DeploymentRecordV32 } from "../../../ops/src/v32/deploy.ts";
import { LIVE } from "../../../ops/src/config.ts";
import { planV32 } from "../../../ops/test/v32-fixtures.ts";
import { SPEND_CAP_DEFAULT } from "../../../ops/src/keeper/deployment-v32.ts";
import { configFromRecord } from "../../scripts/config-from-record.ts";
import { joinDeploymentVars, VAR_MAX_BYTES, varBytes } from "../../src/deployment-vars.ts";

// pnpm config:from-record: the Worker's DEPLOYMENT var from the v3.2 record (Task 50's deploymentFromRecordV32), with
// the vault's creation time read once from Bittensor (vaultCreatedAtOf, T50's carry), refusing an RPC that doesn't
// keep history (a pruned node: it has no old block, or no logs at it).

const SOURCE: SourceV32 = { commit: "c0ffee".padEnd(40, "0"), tree: "7ee".padEnd(40, "0"), dirty: [] };
let build: BuildV32;
beforeAll(async () => {
  build = (await freezeBuildV32(paths({}).contractsDir, SOURCE)).build;
});

const CREATED = 1_790_000_000;
function record(): DeploymentRecordV32 {
  const plan = planV32();
  const sent = (block: number) => ({ hash: `0x${"11".repeat(32)}` as Hex, block, gasUsed: 1n, costWei: 1n });
  return { target: "live", createdAt: "", plan, build: { dir: "v32-test", hash: `0x${"00".repeat(32)}` }, done: Object.fromEntries(plan.steps.map((s) => [s.id, sent(s.chain === "base" ? 30_000_000 : 6_000_000)])) } as DeploymentRecordV32;
}

function rpc(o: { ids?: { base: number; bittensor: number }; block?: boolean; logs?: boolean } = {}): Rpc & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async request(chain, method, params) {
      asked.push(`${chain} ${method}`);
      if (method === "eth_chainId") return numberToHex((o.ids ?? { base: 8453, bittensor: 964 })[chain]);
      if (method === "eth_getBlockByNumber") return o.block === false ? null : { timestamp: numberToHex(CREATED) };
      if (method === "eth_getLogs") {
        const f = params[0] as { fromBlock: Hex; toBlock: Hex };
        expect([f.fromBlock, f.toBlock]).toEqual([numberToHex(6_000_000), numberToHex(6_000_000)]);
        return o.logs === false ? [] : [{ address: "0x00", topics: [], data: "0x" }];
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

describe("pnpm config:from-record", () => {
  it("prints the DEPLOYMENT var: the record's deployment, the chains' ids, the vault's creation time", async () => {
    const r = rpc();
    const out = await configFromRecord({ rec: record(), name: "v3.2-launch", rpc: r, env: {}, build, web: null });
    const d = decodeDeployment(out.text);
    expect(d).toMatchObject({ name: "v3.2-launch", version: "v3.2", chainIds: { base: 8453, bittensor: 964 }, vaultCreatedAt: CREATED, startBlocks: { bittensor: 6_000_000n, base: 30_000_000n } });
    expect(d.keeper).toBe(record().plan.roles.keeper);
    // Task 50a: the 24 h spend cap reaches the Worker (OPS_KEEPER_SPEND_CAP_*, else the core's defaults: R12a's 0.01 ETH)
    expect(d.spendCap).toEqual(SPEND_CAP_DEFAULT);
    const capped = await configFromRecord({ rec: record(), name: "v3.2-launch", rpc: rpc(), env: { OPS_KEEPER_SPEND_CAP_BASE: "0.001" }, build, web: null });
    expect(decodeDeployment(capped.text).spendCap.base).toBe(10n ** 15n);
    expect(JSON.parse(out.text)).toMatchObject({ name: "v3.2-launch" });
    // what it prints (R13, the first live deploy: Cloudflare takes 5 kB in a var, a real record is 10): DEPLOYMENT and the
    // for-life list's numbered parts, each var under the limit, which join back to the same deployment
    expect(varBytes(JSON.parse(out.text))).toBeGreaterThan(VAR_MAX_BYTES);
    const names = Object.keys(out.vars);
    expect(names[0]).toBe("DEPLOYMENT");
    expect(names.length).toBeGreaterThan(1);
    expect(names.slice(1)).toEqual(names.slice(1).map((_, i) => `DEPLOYMENT_FOR_LIFE_${i + 1}`));
    for (const [n, v] of Object.entries(out.vars)) expect(varBytes(v), n).toBeLessThanOrEqual(VAR_MAX_BYTES);
    const joined = joinDeploymentVars(out.vars);
    expect(joined.problems).toEqual([]);
    expect(decodeDeployment(joined.text!)).toEqual(d);
    // the printed lines are those vars, as wrangler.jsonc's members
    expect(JSON.parse(`{${out.varsText.replace(/,$/, "")}}`)).toEqual(out.vars);
    expect(r.asked).toEqual(["base eth_chainId", "bittensor eth_chainId", "bittensor eth_getBlockByNumber", "bittensor eth_getLogs"]);
  });

  it("Bittensor's 24 h spend cap defaults to the core's 0.4 TAO (one claim's worst case and a day of payouts and stakes, Task 51), unless OPS_KEEPER_SPEND_CAP_BITTENSOR says otherwise", async () => {
    const d = decodeDeployment((await configFromRecord({ rec: record(), name: "v3.2-launch", rpc: rpc(), env: {}, build, web: null })).text);
    expect(d.spendCap.bittensor).toBe(SPEND_CAP_DEFAULT.bittensor);
    expect(SPEND_CAP_DEFAULT.bittensor).toBe(parseEther("0.4"));
    // R12a: Base's is 0.01 ETH, a day's closes (a full batch's twice over)
    expect(d.spendCap.base).toBe(parseEther("0.01"));
    const set = await configFromRecord({ rec: record(), name: "v3.2-launch", rpc: rpc(), env: { OPS_KEEPER_SPEND_CAP_BITTENSOR: "0.7" }, build, web: null });
    expect(decodeDeployment(set.text).spendCap).toEqual({ base: parseEther("0.01"), bittensor: parseEther("0.7") });
    // the line config-from-record prints beside the var says the caps it carries
    expect(set.caps).toBe("24 h spend caps: 0.01 ETH on Base, 0.7 TAO on Bittensor");
  });

  it("Task 52's settings reach the Worker: each lane's OnRamp and selector, the park refund's fee cap; the automatic re-execution setting is never baked in (the Worker's own OPS_REEXEC_AUTO var decides, off)", async () => {
    const plain = await configFromRecord({ rec: record(), name: "v3.2-launch", rpc: rpc(), env: {}, build, web: null });
    const d = decodeDeployment(plain.text);
    expect(d.onRamps).toEqual({ base: LIVE.base.ONRAMP, bittensor: LIVE.bittensor.ONRAMP });
    expect(d.selectors).toEqual({ base: LIVE.base.SELECTOR, bittensor: LIVE.bittensor.SELECTOR });
    expect(d.offRamps).toEqual({ base: LIVE.base.OFFRAMP, bittensor: LIVE.bittensor.OFFRAMP });
    // none named: the core's 0.05 TAO applies in the Worker
    expect(d.parkRefundFeeMax).toBeUndefined();
    expect(plain.reexec).toBe("Automatic re-execution of CCIP FAILUREs: the Worker's OPS_REEXEC_AUTO var decides (off in wrangler.jsonc; on only after the rehearsals)");
    const set = await configFromRecord({ rec: record(), name: "v3.2-launch", rpc: rpc(), env: { OPS_PARK_REFUND_FEE_MAX: "0.08", OPS_REEXEC_AUTO: "on" }, build, web: null });
    const e = decodeDeployment(set.text);
    expect(e.parkRefundFeeMax).toBe(parseEther("0.08"));
    // the shell's OPS_REEXEC_AUTO is not the Worker's: nothing of it in the var, and said
    expect("reexecAuto" in e).toBe(false);
    expect(JSON.parse(set.text)).not.toHaveProperty("reexecAuto");
    expect(set.reexec).toBe(
      "Automatic re-execution of CCIP FAILUREs: OPS_REEXEC_AUTO is on in this shell, but the Worker reads its own OPS_REEXEC_AUTO var (off in wrangler.jsonc; on only after the rehearsals); nothing of it is in DEPLOYMENT",
    );
  });

  it("refuses an RPC that doesn't keep history: no block at the vault's creation, or no logs there", async () => {
    await expect(configFromRecord({ rec: record(), name: "v3.2-launch", rpc: rpc({ block: false }), env: {}, build, web: null })).rejects.toThrow(
      "Bittensor has no block 6000000 (the vault's creation): use an RPC that keeps history (archive.chain.opentensor.ai); nothing built",
    );
    await expect(configFromRecord({ rec: record(), name: "v3.2-launch", rpc: rpc({ logs: false }), env: {}, build, web: null })).rejects.toThrow(
      "this Bittensor RPC has no logs at block 6000000, where the vault was created: it doesn't keep history (a pruned node); use an archive node (archive.chain.opentensor.ai); nothing built",
    );
  });

  it("refuses a live record read through RPCs on other chains", async () => {
    await expect(configFromRecord({ rec: record(), name: "v3.2-launch", rpc: rpc({ ids: { base: 84532, bittensor: 964 } }), env: {}, build, web: null })).rejects.toThrow(
      "the record is live, but the RPCs answer chain ids 84532 (Base) and 964 (Bittensor), not 8453 and 964; nothing built",
    );
  });
});

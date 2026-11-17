import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAIM_POLICY as OPS_CLAIM_POLICY, maxGasPrices } from "../../../ops/src/config.ts";
import { CLAIM_GAS_MARGIN, CLAIM_GAS_REQUIRED_MAX, claimGasLimit } from "../../../ops/src/keeper/core/rewards.ts";
import { BITTENSOR_TX_GAS_CEILING } from "../../../ops/src/keeper/core/ceiling.ts";
import { BOUNDS_V32 } from "../../../ops/src/v32/settings.ts";
import { CLAIM_POLICY, CRON_LEASE_MS, HAND_LEASE_MS, HAND_WAIT_MS, RECEIPT_WAIT_MS, readConfig, RUNS_KEPT_MS, SEND_WINDOW_MS } from "../../src/config.ts";
import { VAR_MAX_BYTES, varBytes } from "../../src/deployment-vars.ts";
import { MAX_PROOF_GAS } from "../../src/proof.ts";
import { encodeDeployment } from "../../../ops/src/keeper/core/deployment.ts";
import { deploymentFor } from "../../../ops/test/keeper-v32-world.ts";

// What the keeper Worker shares with ops and with the design note, held equal (design-keeper-worker.md §3 to §5).

/** wrangler.jsonc as JSON: its // comments dropped (outside strings: its URLs keep theirs) */
function wranglerConfig(): Record<string, unknown> {
  const text = readFileSync(join(import.meta.dirname, "..", "..", "wrangler.jsonc"), "utf8");
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else out += c;
  }
  return JSON.parse(out) as Record<string, unknown>;
}

describe("the Worker's settings", () => {
  it("reports by ops' claim policy, and caps gas prices at ops' defaults", () => {
    expect(CLAIM_POLICY).toEqual(OPS_CLAIM_POLICY);
    const c = wranglerConfig();
    const envs = c.env as Record<string, { vars: Record<string, string> }>;
    for (const name of ["test", "production"]) {
      const v = envs[name].vars;
      const caps = { base: BigInt(v.MAX_GAS_PRICE_BASE_GWEI) * 10n ** 9n, bittensor: BigInt(v.MAX_GAS_PRICE_BITTENSOR_GWEI) * 10n ** 9n };
      expect(caps, name).toEqual(maxGasPrices({}));
    }
  });

  it("a journal row's gas bound is the most a claim is ever sent with: the vault's highest claimGasRequired (MAX_CLAIM_GAS, read from the source) plus the claim's margin, held to Bittensor's per-transaction ceiling, all the core's", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "..", "..", "contracts", "src", "CascadeConstants.sol"), "utf8");
    expect(src).toMatch(/uint256 constant MAX_CLAIM_GAS = 63_400_000;/);
    expect(CLAIM_GAS_REQUIRED_MAX).toBe(63_400_000n);
    expect(BOUNDS_V32.maxClaimGas).toBe(CLAIM_GAS_REQUIRED_MAX);
    expect(MAX_PROOF_GAS).toBe(claimGasLimit(CLAIM_GAS_REQUIRED_MAX));
    // the margin would take it to 65,400,000, over what Bittensor's pool takes in one transaction: the ceiling holds it
    expect(CLAIM_GAS_REQUIRED_MAX + CLAIM_GAS_MARGIN).toBe(65_400_000n);
    expect(MAX_PROOF_GAS).toBe(BITTENSOR_TX_GAS_CEILING);
    expect(MAX_PROOF_GAS).toBe(64_900_000n);
  });

  it("the design's times: a cron lease of 120 s, no send after 45 s, 40 s for a receipt, a hand lease of 10 min, a 3-minute wait, a week of runs", () => {
    expect([CRON_LEASE_MS, SEND_WINDOW_MS, RECEIPT_WAIT_MS, HAND_LEASE_MS, HAND_WAIT_MS, RUNS_KEPT_MS]).toEqual([120_000, 45_000, 40_000, 600_000, 180_000, 7 * 86_400_000]);
    // a healthy run (45 s, then at most 40 s for the receipt) ends inside its lease
    expect(SEND_WINDOW_MS + RECEIPT_WAIT_MS).toBeLessThan(CRON_LEASE_MS);
  });

  it("wrangler.jsonc: one cron a minute, workers.dev off, the object declared once as SQLite in both environments, no secret among the vars; no deployment for test, the v3.2-launch deployment for production", () => {
    const c = wranglerConfig();
    expect(c.name).toBe("cascade-keeper");
    expect(c.main).toBe("src/index.ts");
    // the cron in each environment only: a deploy without --env makes no cron
    expect(c.triggers).toBeUndefined();
    expect(c.workers_dev).toBe(false);
    expect(c.send_metrics).toBe(false);
    expect(c.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["KeeperCoordinator"] }]);
    const envs = c.env as Record<string, { durable_objects: unknown; triggers: unknown; vars: Record<string, unknown> }>;
    expect(Object.keys(envs)).toEqual(["test", "production"]);
    for (const e of Object.values(envs)) {
      expect(e.triggers).toEqual({ crons: ["* * * * *"] });
      expect(e.durable_objects).toEqual({ bindings: [{ name: "COORDINATOR", class_name: "KeeperCoordinator" }] });
      // the same vars in both, but for the deployment's for-life parts: only an environment with a real record has them
      const named = (vars: Record<string, unknown>) => Object.keys(vars).filter((k) => !/^DEPLOYMENT_FOR_LIFE_\d+$/.test(k)).sort();
      expect(named(e.vars)).toEqual(named(envs.test.vars));
      // Cloudflare refuses a var above 5 kB (the first live deploy, 2026-11-16, refused a 10 kB DEPLOYMENT): each is under it
      for (const [k, v] of Object.entries(e.vars)) expect(varBytes(v), k).toBeLessThanOrEqual(VAR_MAX_BYTES);
      for (const k of ["KEEPER_PRIVATE_KEY", "CONTROL_TOKEN_SHA256", "BASE_RPC_URL_SECRET", "BASE_LOGS_RPC_URL_SECRET", "BITTENSOR_RPC_URL_SECRET"]) expect(e.vars).not.toHaveProperty(k);
    }
    // the test environment has no deployment: its Worker runs nothing
    expect(envs.test.vars.DEPLOYMENT).toBe("");
    expect(Object.keys(envs.test.vars).filter((k) => k.startsWith("DEPLOYMENT"))).toEqual(["DEPLOYMENT"]);
    // production's is in three vars: DEPLOYMENT without its for-life list, and that list in two numbered parts
    expect(Object.keys(envs.production.vars).filter((k) => k.startsWith("DEPLOYMENT"))).toEqual(["DEPLOYMENT", "DEPLOYMENT_FOR_LIFE_1", "DEPLOYMENT_FOR_LIFE_2"]);
    expect(envs.production.vars.DEPLOYMENT).not.toHaveProperty("forLife");
    // production holds the v3.2-launch deployment as `pnpm config:from-record` printed it from the live record on deploy
    // day (2026-11-16, Task 67): it reads with no problem, and names the live contracts, the plan's keeper and its caps
    const { config, problems } = readConfig({ COORDINATOR: undefined as never, ...envs.production.vars });
    expect(problems).toEqual([]);
    const d = config!.deployment;
    expect([d.version, d.name, d.chainIds]).toEqual(["v3.2", "v3.2-launch", { base: 8453, bittensor: 964 }]);
    expect(d.addresses).toMatchObject({
      vault: "0x56544AfF15fccea33b4db189cB5B3726DBac724e",
      vaultLens: "0xc8b3b74261489ff544cF18335778498cd6f32010",
      bitAdapter: "0x24B1b5eC0bB46c4F9850Ce9D75f7957eCB3B0027",
      frontDoor: "0xd1Ae29169146Ff62c9E9D4dC17c653B62fA3754e",
      doorLens: "0x9Da3e48fF7ab29AA277f37B0bC5B14c8Bbf96e7f",
      baseAdapter: "0x0BEbdEbD94Ff1eD14a06E8fC055Afabd1465637E",
      staker: "0x371C5CFa5F5F6B3356fBC360EaD26066A2958B87",
    });
    expect(d.keeper).toBe("0x7070F6A27be2Fe8521146450B5EB65190f5C7c9d");
    // the launch's 24-hour spend caps: 0.01 ETH on Base, 0.4 TAO on Bittensor (runbook 2.2)
    expect(d.spendCap).toEqual({ base: 10n ** 16n, bittensor: 4n * 10n ** 17n });
    // the automatic re-execution stays off whatever the record asks (the Worker's own var decides)
    expect(d.reexecAuto).toBe(false);
    // the for-life list came through whole from its parts: every deployed contract's code, both oracle pools
    // the thirteen deployed: the six contracts, the five libraries, both lenses
    expect(d.forLife.code.map((c) => c.contract).sort()).toEqual(["CascadeBatchLib", "CascadeDoorLens", "CascadeFrontDoor", "CascadeHotkeyLib", "CascadePayoutLib", "CascadePayoutMath", "CascadeStakeLib", "CascadeStaker", "CascadeTwapOracle", "CascadeVault", "CascadeVaultLens", "CcipBaseAdapter", "CcipBittensorAdapter"]);
    expect(d.forLife.pools.map((p) => p.pair)).toEqual(["WETH/USDC", "TAO/WETH"]);
    // the list whole, to the entry (the R13 review's Low 4): 32 values, 13 codes, 2 pools, every value and code read at one
    // of the deployment's own addresses or libraries, and the whole deployment's digest as its vars name it
    expect([d.forLife.values.length, d.forLife.code.length, d.forLife.pools.length]).toEqual([32, 13, 2]);
    const own = new Set(Object.values(d.addresses).map((a) => a.toLowerCase()));
    for (const v of d.forLife.values) expect(own.has(v.address.toLowerCase()), `${v.contract}.${v.fn} at ${v.address}`).toBe(true);
    const contracts = d.forLife.code.filter((c) => own.has(c.address.toLowerCase())).map((c) => c.contract).sort();
    expect(contracts).toEqual(["CascadeDoorLens", "CascadeFrontDoor", "CascadeStaker", "CascadeTwapOracle", "CascadeVault", "CascadeVaultLens", "CcipBaseAdapter", "CcipBittensorAdapter"]);
    expect((envs.production.vars.DEPLOYMENT as unknown as { forLifeParts: unknown }).forLifeParts).toEqual({ of: 2, id: "0x29acfbecad21e2e85632c7560ebfaebee587acb7846c766dd94dfb177862ffa8" });
    for (const k of ["DEPLOYMENT_FOR_LIFE_1", "DEPLOYMENT_FOR_LIFE_2"]) expect(envs.production.vars[k], k).toMatchObject({ of: 2, id: "0x29acfbecad21e2e85632c7560ebfaebee587acb7846c766dd94dfb177862ffa8" });
    // the keeper's own hostname, production's alone (runbook 2.3 step 4): the control routes answer on no other
    const routes = c.env as Record<string, { routes?: unknown }>;
    expect(routes.production.routes).toEqual([{ pattern: "keeper.cascadefi.xyz", custom_domain: true }]);
    expect(routes.test.routes).toBeUndefined();
    expect(c.routes).toBeUndefined();
  });

  it("the automatic re-execution setting is the Worker's own OPS_REEXEC_AUTO var: off in both environments (the founder's ruling), on only when it says on, refused when it says anything else", () => {
    const envs = wranglerConfig().env as Record<string, { vars: Record<string, string> }>;
    for (const name of ["test", "production"]) expect(envs[name].vars.OPS_REEXEC_AUTO, name).toBe("off");
    const base = { COORDINATOR: undefined as never, DEPLOYMENT: encodeDeployment(deploymentFor({ reexecAuto: true })), BASE_RPC_URL: "https://a.test", BASE_LOGS_RPC_URL: "https://b.test", BITTENSOR_RPC_URL: "https://c.test" };
    // DEPLOYMENT asks for it; the var decides: unset or off is off, on is on, whatever the case
    for (const v of [undefined, "", "off", "OFF"]) expect(readConfig({ ...base, OPS_REEXEC_AUTO: v }).config?.deployment.reexecAuto, String(v)).toBe(false);
    for (const v of ["on", "On"]) expect(readConfig({ ...base, OPS_REEXEC_AUTO: v }).config?.deployment.reexecAuto, v).toBe(true);
    expect(readConfig({ ...base, DEPLOYMENT: encodeDeployment(deploymentFor({ reexecAuto: false })), OPS_REEXEC_AUTO: "on" }).config?.deployment.reexecAuto).toBe(true);
    const bad = readConfig({ ...base, OPS_REEXEC_AUTO: "yes" });
    expect(bad.config).toBeUndefined();
    expect(bad.problems).toEqual(['OPS_REEXEC_AUTO "yes" is not on or off']);
  });

  it("an unset deployment, a bad URL or a bad budget is refused by name, never quoting a URL's value", () => {
    const { problems } = readConfig({ COORDINATOR: undefined as never, DEPLOYMENT: "", BASE_RPC_URL: "not a url secret-key-123", BASE_LOGS_RPC_URL: "https://x.test", BITTENSOR_RPC_URL: "https://y.test", KEEPER_SUBREQUEST_BUDGET: "lots", RPC_SPACING_MS: "{}" });
    expect(problems).toEqual([
      "DEPLOYMENT is not set: write it with pnpm config:from-record (Task 67)",
      "BASE_RPC_URL is not a URL",
      'KEEPER_SUBREQUEST_BUDGET "lots" is not a whole number',
      'RPC_SPACING_MS is not {"base": <ms>, "bittensor": <ms>}',
    ]);
    expect(problems.join(" ")).not.toContain("secret-key-123");
    // the budget is capped, so a run stays under the platform's 1,000 subrequests
    const high = readConfig({ COORDINATOR: undefined as never, DEPLOYMENT: "", BASE_RPC_URL: "https://a.test", BASE_LOGS_RPC_URL: "https://b.test", BITTENSOR_RPC_URL: "https://c.test", KEEPER_SUBREQUEST_BUDGET: "450" });
    expect(high.problems).toContain("KEEPER_SUBREQUEST_BUDGET 450 is above 400 (a run must stay under the platform's 1,000 subrequests)");
  });
});

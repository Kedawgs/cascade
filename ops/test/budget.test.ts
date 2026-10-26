import { type Hex, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { type BudgetInputs, computeBudget, formatBudget, gatherBudgetInputs } from "../src/budget.ts";
import { paths, SETTINGS_V3, targets, WALLET } from "../src/config.ts";
import { buildPlan, buildPlanV3 } from "../src/plan.ts";
import type { DeploymentRecord } from "../src/record.ts";
import type { Ctx, Sent } from "../src/send.ts";

const inputs: BudgetInputs = {
  bitCreateGas: { bitAdapter: 1_835_528n, vault: 6_038_421n },
  bitConfigGas: 300_000n,
  baseDeployGas: 5_000_000n,
  baseDeploySteps: 2,
  closeGas: 400_000n,
  bitGasPrice: 5_000_000_000n,
  baseGasPrice: 6_000_000n,
  baseFeeQuote: 619_000_000_000_000n,
  taoBalance: 7_999_500_000_000_000n,
  ethBalance: 0n,
};

describe("budget", () => {
  it("computes the needs and the one top-up from the formula", () => {
    const b = computeBudget(inputs);
    // TAO: (1,835,528 + 6,038,421 + 300,000 + 2×500,000 + 3,000,000 + 30,000) gas × 5 gwei
    //      = 61,019,745e9 wei, + 1e12 + 1.5e12 reserves = 61,022,245,000,000,000; × 1.3 = 79,328,918,500,000,000
    expect(b.taoNeed).toBe(79_328_918_500_000_000n);
    // minus 0.0079995 held = 71,329,418,500,000,000, rounded up to 0.001 TAO = 0.072
    expect(b.taoToSend).toBe(72_000_000_000_000_000n);
    // ETH: (5,000,000 + 3×400,000) gas × 0.006 gwei = 3.72e13; + 3 × 6.19e14 × 1.25 = 2.32125e15;
    //      sum 2.35845e15 × 1.3 = 3.065985e15; + (2 + 3 transactions) × 4e13 L1 allowance = 3.265985e15
    expect(b.ethNeed).toBe(3_265_985_000_000_000n);
    expect(b.ethToSend).toBe(3_300_000_000_000_000n);
    expect(b.claim).toBeUndefined();
  });

  it("asks for nothing when the wallet already holds enough", () => {
    const b = computeBudget({ ...inputs, taoBalance: 10n ** 18n, ethBalance: 10n ** 18n });
    expect([b.taoToSend, b.ethToSend]).toEqual([0n, 0n]);
  });

  it("names each destination with its chain", () => {
    const lines = formatBudget(computeBudget(inputs));
    expect(lines).toContain(
      "Send 0.072 TAO to the test wallet's Bittensor address 5FxSW9dM8DbAWUFtADJPX5Wb7DctrJHadkJ3TB1GpBGvxQH2",
    );
    expect(lines).toContain("Send 0.0033 ETH on Base to 0x770932787DD3bcE64f14E31f4746bCe22E214fFF");
    expect(lines.some((l) => /claim/.test(l))).toBe(false);
  });
});

const v3Inputs: BudgetInputs = {
  ...inputs,
  bitCreateGas: { bitAdapter: 1_835_528n, vault: 6_100_000n },
  bitConfigGas: 400_000n,
  baseDeployGas: 12_000_000n,
  baseDeploySteps: 11,
  deliverGas: 350_000n,
  taoBalance: 36_000_000_000_000_000n,
  claimGasLimit: 57_000_000n,
};

describe("budget v3", () => {
  it("counts every Base step, the closes and two USDC deliveries, with an L1 allowance for each transaction", () => {
    const b = computeBudget(v3Inputs);
    // ETH: (12,000,000 + 3×400,000 + 2×350,000) gas × 0.006 gwei = 8.34e13; + 3 × 6.19e14 × 1.25 = 2.32125e15;
    //      sum 2.40465e15 × 1.3 = 3.126045e15; + (11 + 3 + 2) × 4e13 = 6.4e14 → 3.766045e15
    expect(b.ethNeed).toBe(3_766_045_000_000_000n);
    expect(b.ethToSend).toBe(3_800_000_000_000_000n);
    expect(b.baseTxs).toEqual({ deploy: 11, closes: 3, deliveries: 2 });
    // TAO: (1,835,528 + 6,100,000 + 400,000 + 4,030,000) gas × 5 gwei + 2.5e12 = 61,830,140e9; × 1.3
    expect(b.taoNeed).toBe(80_379_182_000_000_000n);
    expect(b.taoToSend).toBe(45_000_000_000_000_000n);
  });

  it("lists the optional claim's up-front TAO separately, outside the totals", () => {
    const b = computeBudget(v3Inputs);
    // 57,000,000 gas × 5 gwei = τ0.285 up front; with the need, 0.365379182 − 0.036 held → 0.330
    expect(b.claim).toEqual({ gasLimit: 57_000_000n, upfront: 285_000_000_000_000_000n, cost: 57_000_000_000_000_000n, taoToSendWith: 330_000_000_000_000_000n });
    expect(computeBudget({ ...v3Inputs, claimGasLimit: undefined }).taoNeed).toBe(b.taoNeed);
    const lines = formatBudget(b);
    expect(lines).toContain(
      "Optional, not counted above: a reward claim is sent with a 57,000,000 gas limit, so the wallet must hold 0.285 TAO up front when it claims; Bittensor refunds the unused gas, and a claim costs about 0.057 TAO",
    );
    expect(lines).toContain("To be able to claim during the test, send 0.33 TAO in all instead");
    expect(lines).toContain("Send 0.045 TAO to the test wallet's Bittensor address 5FxSW9dM8DbAWUFtADJPX5Wb7DctrJHadkJ3TB1GpBGvxQH2");
    expect(lines.find((l) => l.startsWith("Base:"))).toMatch(/the deployment's 11 transactions, 3 batch closes with their bridge fees, 2 USDC deliveries/);
    expect(formatBudget(computeBudget({ ...v3Inputs, taoBalance: 10n ** 18n }))).toContain("The wallet already holds enough TAO to claim as well");
  });
});

describe("gatherBudgetInputs", () => {
  const COLDKEY: Hex = `0x${"22".repeat(32)}`;
  /** A rehearsal record whose every step used a distinct amount of gas: step i used 1,000 × (i + 1). */
  function rehearsalOf(plan: DeploymentRecord["plan"], extra: Partial<DeploymentRecord> = {}): DeploymentRecord {
    const done = Object.fromEntries(plan.steps.map((s, i) => [s.id, { hash: `0x${"cd".repeat(32)}`, block: 1, gasUsed: 1_000n * BigInt(i + 1), costWei: 1n } satisfies Sent]));
    return { target: "rehearsal", wallet: WALLET, createdAt: "", plan, done, rehearsalClose: { gasUsed: 410_000n, fee: 6n * 10n ** 14n }, ...extra };
  }
  function liveChains() {
    const estimates: Hex[] = [];
    const ctx: Ctx = {
      live: true,
      targets: targets({}).live,
      rpc: {
        async request(_chain, method, params) {
          if (method === "eth_getTransactionCount") return numberToHex(7);
          if (method === "eth_call") return COLDKEY;
          if (method === "eth_estimateGas") {
            estimates.push((params[0] as { data: Hex }).data);
            return numberToHex(1_000_000);
          }
          if (method === "eth_gasPrice") return numberToHex(5_000_000_000);
          if (method === "eth_getBalance") return "0x0";
          throw new Error(`unexpected ${method}`);
        },
      },
      runner: { run: async () => ({ code: 1, stdout: "", stderr: "" }) },
      paths: paths({}),
      log: () => undefined,
      receiptTimeoutMs: 10,
    };
    return { ctx, estimates };
  }
  const sumOf = (plan: DeploymentRecord["plan"], keep: (s: DeploymentRecord["plan"]["steps"][number]) => boolean) =>
    plan.steps.reduce((t, s, i) => (keep(s) ? t + 1_000n * BigInt(i + 1) : t), 0n);

  it("counts all eleven v3 Base steps, the five Bittensor calls, the round trip's delivery and the claim's gas limit", async () => {
    const plan = buildPlanV3(0, 0, COLDKEY);
    const rec = rehearsalOf(plan, {
      roundTrip: [{ step: "deliver USDC", chain: "base", payer: "keeper", gasUsed: 333_333n, costWei: 1n, detail: "" }],
    });
    const { ctx, estimates } = liveChains();
    const i = await gatherBudgetInputs(ctx, rec);
    expect(i.baseDeploySteps).toBe(11);
    // steps 1–11 are Base's: 1,000 × (1 + … + 11)
    expect(i.baseDeployGas).toBe(66_000n);
    expect(i.baseDeployGas).toBe(sumOf(plan, (s) => s.chain === "base"));
    // adapterReserve, vaultReserve, setKeeper, setPayoutDelay, setRewardCut: steps 14–18
    expect(i.bitConfigGas).toBe(1_000n * (14n + 15n + 16n + 17n + 18n));
    expect(i).toMatchObject({ closeGas: 410_000n, baseFeeQuote: 6n * 10n ** 14n, deliverGas: 333_333n, claimGasLimit: 57_000_000n });
    // the vault is estimated with the v3 arguments: tao.bot's hotkey
    expect(estimates[1]).toContain(SETTINGS_V3.hotkey.slice(2));
  });

  it("leaves a v2 rehearsal's budget as it was: two Base steps, no deliveries, no claim", async () => {
    const plan = buildPlan(0, 0, COLDKEY);
    const i = await gatherBudgetInputs(liveChains().ctx, rehearsalOf(plan));
    expect(i.baseDeploySteps).toBe(2);
    expect(i.baseDeployGas).toBe(3_000n);
    expect(i.bitConfigGas).toBe(1_000n * (5n + 6n + 7n + 8n));
    expect(i.deliverGas).toBeUndefined();
    expect(i.claimGasLimit).toBeUndefined();
  });
});

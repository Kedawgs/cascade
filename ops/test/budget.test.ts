import { type Hex, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { type BudgetInputs, budgetChecks, computeBudget, formatBudget, gatherBudgetInputs } from "../src/budget.ts";
import { claimPolicy, paths, SETTINGS_V3, targets, WALLET } from "../src/config.ts";
import { buildPlan, buildPlanV3 } from "../src/plan.ts";
import type { DeploymentRecord } from "../src/record.ts";
import { ROUND_TRIP, type StepReport } from "../src/roundtrip.ts";
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

  it("with a separate keeper key, splits the keeper's running costs from the deployment's", () => {
    const KEEPER = "0x000000000000000000000000000000000000c0c1" as const;
    const b = computeBudget({ ...inputs, keeper: { address: KEEPER, taoBalance: 0n, ethBalance: 0n } });
    // the keeper: two stakes, a payout batch and the sweep's 4,030,000 gas × 5 gwei × 1.3; three closes
    // (1,200,000 gas × 0.006 gwei + 3 × 6.19e14 × 1.25) × 1.3, + 3 × 4e13 L1
    expect(b.keeper).toEqual({
      address: KEEPER,
      taoNeed: 26_195_000_000_000_000n,
      ethNeed: 3_146_985_000_000_000n,
      taoBalance: 0n,
      ethBalance: 0n,
      taoToSend: 27_000_000_000_000_000n,
      ethToSend: 3_200_000_000_000_000n,
    });
    // the test wallet: only the deployment, which with the keeper's share adds up to the one-key total
    expect(b.taoNeed).toBe(53_133_918_500_000_000n);
    expect(b.ethNeed).toBe(119_000_000_000_000n);
    const one = computeBudget(inputs);
    expect(b.taoNeed + b.keeper!.taoNeed).toBe(one.taoNeed);
    expect(b.ethNeed + b.keeper!.ethNeed).toBe(one.ethNeed);
    const lines = formatBudget(b);
    expect(lines).toContain(`Keeper ${KEEPER}: about 0.026195 TAO needed on Bittensor (its stakes, payouts and claims); it holds 0 TAO`);
    expect(lines).toContain(`Send 0.027 TAO to the keeper's address ${KEEPER} on Bittensor EVM`);
    expect(lines).toContain(`Keeper ${KEEPER}: about 0.003146985 ETH needed on Base (its batch closes and deliveries); it holds 0 ETH`);
    expect(lines).toContain(`Send 0.0032 ETH on Base to the keeper ${KEEPER}`);
  });

  it("preflight checks each key's balances against its share", () => {
    const KEEPER = "0x000000000000000000000000000000000000c0c1" as const;
    const funded = computeBudget({ ...inputs, taoBalance: 10n ** 18n, ethBalance: 10n ** 18n });
    expect(budgetChecks(funded)).toEqual([
      ["the test wallet holds enough TAO", null],
      ["the test wallet holds enough ETH on Base", null],
    ]);
    const short = computeBudget({ ...inputs, taoBalance: 10n ** 18n, ethBalance: 10n ** 18n, keeper: { address: KEEPER, taoBalance: 1n, ethBalance: 10n ** 18n } });
    expect(budgetChecks(short)).toEqual([
      ["the test wallet holds enough TAO", null],
      ["the test wallet holds enough ETH on Base", null],
      [`the keeper key ${KEEPER} holds enough TAO on Bittensor`, "it holds 1 wei, the budget needs 26195000000000000"],
      [`the keeper key ${KEEPER} holds enough ETH on Base`, null],
    ]);
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

  it("lists the optional claim's up-front TAO separately, outside the totals, with the same 30% margin", () => {
    const b = computeBudget(v3Inputs);
    // 57,000,000 gas × 5 gwei = τ0.285, × 1.3 = τ0.3705 up front; with the need, 0.450879182 − 0.036 held → 0.415
    expect(b.claim).toEqual({ gasLimit: 57_000_000n, upfront: 370_500_000_000_000_000n, cost: 57_000_000_000_000_000n, taoToSendWith: 415_000_000_000_000_000n });
    expect(computeBudget({ ...v3Inputs, claimGasLimit: undefined }).taoNeed).toBe(b.taoNeed);
    const lines = formatBudget(b);
    expect(lines).toContain(
      "Optional, not counted above: a reward claim is sent with a 57,000,000 gas limit, so the wallet must hold about 0.3705 TAO up front when it claims (that limit at today's gas price, plus 30%); Bittensor refunds the unused gas, and a claim costs about 0.057 TAO",
    );
    expect(lines).toContain("To be able to claim during the test, send 0.415 TAO in all instead");
    expect(lines).toContain("Send 0.045 TAO to the test wallet's Bittensor address 5FxSW9dM8DbAWUFtADJPX5Wb7DctrJHadkJ3TB1GpBGvxQH2");
    expect(lines.find((l) => l.startsWith("Base:"))).toMatch(/the deployment's 11 transactions, 3 batch closes with their bridge fees, 2 USDC deliveries/);
    expect(formatBudget(computeBudget({ ...v3Inputs, taoBalance: 10n ** 18n }))).toContain("The wallet already holds enough TAO to claim as well");
  });

  it("states a claim's cost from the claim policy, so a measured OPS_CLAIM_COST_TAO shows", () => {
    const b = computeBudget({ ...v3Inputs, claimCostTao: 45_000_000_000_000_000n });
    expect(b.claim?.cost).toBe(45_000_000_000_000_000n);
    expect(formatBudget(b).some((l) => l.endsWith("and a claim costs about 0.045 TAO"))).toBe(true);
  });
});

describe("gatherBudgetInputs", () => {
  const COLDKEY: Hex = `0x${"22".repeat(32)}`;
  /** A finished rehearsal record whose every step used a distinct amount of gas: step i used 1,000 ×
   * (i + 1); a v3 one has its whole round trip, the USDC delivery using 333,333 gas. */
  function rehearsalOf(plan: DeploymentRecord["plan"], extra: Partial<DeploymentRecord> = {}): DeploymentRecord {
    const done = Object.fromEntries(plan.steps.map((s, i) => [s.id, { hash: `0x${"cd".repeat(32)}`, block: 1, gasUsed: 1_000n * BigInt(i + 1), costWei: 1n } satisfies Sent]));
    const roundTrip = ROUND_TRIP.map((step): StepReport => ({ step, chain: "base", payer: "keeper", gasUsed: step === "deliver USDC" ? 333_333n : 1n, costWei: 1n, detail: "" }));
    return {
      target: "rehearsal",
      wallet: WALLET,
      createdAt: "",
      plan,
      done,
      verify: { ok: true, failures: [], checkedAt: "" },
      rehearsalClose: { gasUsed: 410_000n, fee: 6n * 10n ** 14n },
      ...("version" in plan ? { roundTrip } : {}),
      ...extra,
    };
  }
  function liveChains() {
    const calls: string[] = [];
    const estimates: Hex[] = [];
    const ctx: Ctx = {
      live: true,
      targets: targets({}).live,
      rpc: {
        async request(_chain, method, params) {
          calls.push(method);
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
    return { ctx, estimates, calls };
  }
  const sumOf = (plan: DeploymentRecord["plan"], keep: (s: DeploymentRecord["plan"]["steps"][number]) => boolean) =>
    plan.steps.reduce((t, s, i) => (keep(s) ? t + 1_000n * BigInt(i + 1) : t), 0n);

  it("counts all eleven v3 Base steps, the five Bittensor calls, the round trip's delivery and the claim's gas limit", async () => {
    const plan = buildPlanV3(0, 0, COLDKEY);
    const rec = rehearsalOf(plan);
    const { ctx, estimates } = liveChains();
    const i = await gatherBudgetInputs(ctx, rec);
    expect(i.baseDeploySteps).toBe(11);
    // steps 1–11 are Base's: 1,000 × (1 + … + 11)
    expect(i.baseDeployGas).toBe(66_000n);
    expect(i.baseDeployGas).toBe(sumOf(plan, (s) => s.chain === "base"));
    // adapterReserve, vaultReserve, setKeeper, setPayoutDelay, setRewardCut: steps 14–18
    expect(i.bitConfigGas).toBe(1_000n * (14n + 15n + 16n + 17n + 18n));
    expect(i).toMatchObject({ closeGas: 410_000n, baseFeeQuote: 6n * 10n ** 14n, deliverGas: 333_333n, claimGasLimit: 57_000_000n, claimCostTao: 57n * 10n ** 15n });
    const measured = await gatherBudgetInputs(liveChains().ctx, rec, claimPolicy({ OPS_CLAIM_COST_TAO: "0.045" }));
    expect(measured.claimCostTao).toBe(45n * 10n ** 15n);
    // the vault is estimated with the v3 arguments: tao.bot's hotkey
    expect(estimates[1]).toContain(SETTINGS_V3.hotkey.slice(2));
  });

  it("refuses an unfinished rehearsal before reading anything live: a re-rehearsal that stopped must not price the deployment", async () => {
    const plan = buildPlanV3(0, 0, COLDKEY);
    const finished = rehearsalOf(plan);
    const { vault: _, ...missingStep } = finished.done;
    const unfinished: [Partial<DeploymentRecord>, RegExp][] = [
      // the deployment stopped partway, or a step was recovered without its gas
      [{ done: missingStep }, /1 deployment step\(s\) with no measured gas \(vault\)/],
      [{ done: { ...finished.done, setKeeper: { recovered: true } } }, /no measured gas \(setKeeper\)/],
      [{ pending: { step: "setRewardCut", chain: "bittensor", nonce: 15 } }, /a transaction still pending/],
      // the read-back never ran, or failed
      [{ verify: undefined }, /no read-back check/],
      [{ verify: { ok: false, failures: ["x"], checkedAt: "" } }, /its read-back check failed/],
      // no measured close, or a round trip that stopped before the delivery
      [{ rehearsalClose: undefined }, /no measured batch close/],
      [{ roundTrip: undefined }, /round trip stopped before "permit stake"/],
      [{ roundTrip: finished.roundTrip!.slice(0, -1) }, /round trip stopped before "deliver USDC"/],
    ];
    for (const [extra, why] of unfinished) {
      const live = liveChains();
      const err = await gatherBudgetInputs(live.ctx, { ...finished, ...extra }).catch((e) => e);
      expect(err.message).toMatch(why);
      expect(err.message).toMatch(/run `pnpm ops rehearse` again/);
      expect(live.calls).toEqual([]);
    }
    // v2 has no round trip to finish
    await expect(gatherBudgetInputs(liveChains().ctx, rehearsalOf(buildPlan(0, 0, COLDKEY)))).resolves.toMatchObject({ baseDeploySteps: 2 });
  });

  it("leaves a v2 rehearsal's budget as it was: two Base steps, no deliveries, no claim", async () => {
    const plan = buildPlan(0, 0, COLDKEY);
    const i = await gatherBudgetInputs(liveChains().ctx, rehearsalOf(plan));
    expect(i.baseDeploySteps).toBe(2);
    expect(i.baseDeployGas).toBe(3_000n);
    expect(i.bitConfigGas).toBe(1_000n * (5n + 6n + 7n + 8n));
    expect(i.deliverGas).toBeUndefined();
    expect(i.claimGasLimit).toBeUndefined();
    expect(i.claimCostTao).toBeUndefined();
  });
});

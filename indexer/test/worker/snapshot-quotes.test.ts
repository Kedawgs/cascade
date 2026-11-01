import { describe, expect, it } from "vitest";
import { readSnapshot, type SnapshotInputs } from "../../src/snapshot.ts";
import { deploymentState, fakeDeployment } from "./fake-deployment.ts";
import { testConfig } from "./fixtures.ts";

const cfg = testConfig();
const inputs = (over: Partial<SnapshotInputs> = {}): SnapshotInputs => ({ last: {}, pendingMessages: [], watched: [], payoutUsers: [], deliveredChecks: [], pendingPayoutKeys: [], ...over });
const PREVIOUS = 400_000_000n; // $400 per TAO

describe("the Base reading's swap quotes and the USDC pool's depth", () => {
  it("quotes a $1,000 buy, a $1,000 sell at the previous oracle value, and reads the pool's USDC", async () => {
    const state = deploymentState(cfg);
    const { rpc } = fakeDeployment(cfg, state);
    const s = await readSnapshot(rpc, cfg, inputs({ previousOracleValue: PREVIOUS }), 1_800_000_030);
    const taoIn = (1_000n * 10n ** 6n * 10n ** 18n) / PREVIOUS;
    expect(s.base?.state.buyQuote1000).toBe(state.base.buyQuote);
    expect(s.base?.state.sellQuote).toEqual({ taoIn, usdcOut: (taoIn * state.base.sellUsdcPerTao) / 10n ** 18n });
    expect(state.asked.quoterIn).toContain(taoIn);
    expect(s.base?.state.wethUsdcPoolUsdc).toBe(state.base.wethUsdcPoolUsdc);
  });

  it("asks the buy quote of exactly $1,000 (1,000e6 USDC units)", async () => {
    const state = deploymentState(cfg);
    const { rpc } = fakeDeployment(cfg, state);
    await readSnapshot(rpc, cfg, inputs({ previousOracleValue: PREVIOUS }), 1_800_000_030);
    expect(state.asked.quoterIn).toContain(1_000_000_000n);
  });

  it("with no previous oracle value, skips the sell quote and keeps the rest", async () => {
    const { rpc } = fakeDeployment(cfg, deploymentState(cfg));
    const s = await readSnapshot(rpc, cfg, inputs(), 1_800_000_030);
    expect(s.base?.state.sellQuote).toBeUndefined();
    expect(s.base?.state.buyQuote1000).toBeDefined();
    expect(s.base?.state.wethUsdcPoolUsdc).toBeDefined();
  });

  it("a zero previous oracle value skips the sell quote too", async () => {
    const { rpc } = fakeDeployment(cfg, deploymentState(cfg));
    const s = await readSnapshot(rpc, cfg, inputs({ previousOracleValue: 0n }), 1_800_000_030);
    expect(s.base?.state.sellQuote).toBeUndefined();
  });

  it("a reverting quoter leaves the quotes undefined and every other field set", async () => {
    const state = deploymentState(cfg);
    state.reverts.add("base.quoter");
    const { rpc } = fakeDeployment(cfg, state);
    const s = await readSnapshot(rpc, cfg, inputs({ previousOracleValue: PREVIOUS }), 1_800_000_030);
    expect(s.base?.state.buyQuote1000).toBeUndefined();
    expect(s.base?.state.sellQuote).toBeUndefined();
    expect(s.base?.state.wethUsdcPoolUsdc).toBe(state.base.wethUsdcPoolUsdc);
    expect(s.base?.state.oracleValue).toBe(state.base.oracleValue);
    expect(s.base?.state.openBatch).toBeDefined();
  });
});

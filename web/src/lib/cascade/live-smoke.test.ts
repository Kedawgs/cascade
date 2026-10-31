import { describe, expect, it } from "vitest";
import { createClients } from "./chain";
import { readDeployment } from "./config";
import { nextBatchLine } from "../batch-clock";
import { FAQ_FACTS } from "../faq";
import { readFrontDoor, readNextBatch, readOpenBatch, readVault, taoPriceUsd } from "./reads";
import { stakerDepositsIn } from "./facts";
import { checkWiring } from "./wiring";

/** Reads the live deployment over the public RPCs. Runs only with LIVE=1 and the settings in the environment. */
const d = readDeployment(process.env);
describe.runIf(process.env.LIVE === "1" && d)("live smoke", () => {
  it("reads the front door, the vault and the TAO price", async () => {
    const c = createClients();
    const fd = await readFrontDoor(c, d!);
    expect(fd.minDeposit).toBe(10n ** 16n);
    const v = await readVault(c, d!);
    expect(v.payoutDelay).toBe(3600);
    const price = await taoPriceUsd(c);
    expect(price).toBeGreaterThan(10);
    console.log({ openBatchId: fd.openBatchId, totalAssets: v.totalAssets, nominatorMinWei: v.nominatorMinWei, price });
  }, 60_000);

  it("reads the open batch for Next batch and Send it now, its clock and, once it can close, its bridge fee", async () => {
    const c = createClients();
    const next = await readNextBatch(c, d!);
    // Base's clock, from the block the multicall read: within minutes of this machine's
    expect(Math.abs(next.chainTime - Date.now() / 1000)).toBeLessThan(600);
    const open = await readOpenBatch(c, d!, "0x0000000000000000000000000000000000000001");
    expect(open.id).toBe(next.id);
    if (open.canClose && !open.paused && next.deposits + next.redeems > 0) {
      // today's bridge fee is about 0.0005–0.0008 ETH, and Bittensor's side was read
      expect(open.feeWei).toBeGreaterThan(10n ** 14n);
      expect(open.feeWei).toBeLessThan(10n ** 16n);
      expect(typeof open.bittensorOpen).toBe("boolean");
    }
    // the FAQ's "once its batch is 1 hour old" is the launch front door's batchInterval
    if (d!.batchMaxWaitS) expect(next.interval).toBe(FAQ_FACTS.batchIntervalS.launch);
    // the keeper's count of the batch's staker deposits, from Base's logs back to its start
    const staked = await stakerDepositsIn(c, d!, next.id, next.chainTime - next.start);
    expect(staked.count).toBeLessThanOrEqual(next.deposits + 50);
    console.log({ staked });
    console.log({ next, open, line: nextBatchLine(next, { readAt: Date.now(), now: Date.now(), maxWaitS: d!.batchMaxWaitS }) });
  }, 60_000);

  it("finds the contracts wired to each other as the config says", async () => {
    expect(await checkWiring(createClients(), d!)).toBe("ok");
  }, 60_000);
});

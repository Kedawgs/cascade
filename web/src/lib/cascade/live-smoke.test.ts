import { describe, expect, it } from "vitest";
import { createClients } from "./chain";
import { readDeployment } from "./config";
import { readFrontDoor, readVault, taoPriceUsd } from "./reads";

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
});

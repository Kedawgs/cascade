import { describe, expect, it } from "vitest";
import { readDeployment } from "./cascade/config";
import { howItWorksSteps } from "./landing";

const ENV = {
  NEXT_PUBLIC_CASCADE_FRONT_DOOR: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  NEXT_PUBLIC_CASCADE_BASE_ADAPTER: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  NEXT_PUBLIC_CASCADE_VAULT: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  NEXT_PUBLIC_CASCADE_BIT_ADAPTER: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  NEXT_PUBLIC_CASCADE_BIT_BLOCK: "9357492",
  NEXT_PUBLIC_CASCADE_VAULT_SS58: "5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu",
  NEXT_PUBLIC_CASCADE_HOTKEY_SS58: "5E4z3h9yVhmQyCFWNbY9BPpwhx4xFiPwq3eeqmBgVF6KULde",
};

const staked = (d: Parameters<typeof howItWorksSteps>[0]) => howItWorksSteps(d)[1].body;

describe("how it works", () => {
  it("the test deployment (no max wait) keeps today's wording", () => {
    expect(staked(readDeployment(ENV))).toBe("Your USDC becomes TAO, crosses to Bittensor over Chainlink CCIP and is staked. Usually within the hour.");
    // and so does a site with no deployment
    expect(staked(null)).toBe("Your USDC becomes TAO, crosses to Bittensor over Chainlink CCIP and is staked. Usually within the hour.");
  });

  it("a launch deployment (a 24-hour max wait) says within a day, never within the hour", () => {
    const launch = readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S: "86400" });
    expect(staked(launch)).toBe("Your USDC becomes TAO, crosses to Bittensor over Chainlink CCIP and is staked. Usually within a day.");
    expect(staked({ batchMaxWaitS: 3_600 })).toMatch(/Usually within a day\.$/);
    expect(staked({ batchMaxWaitS: 3 * 86_400 })).toMatch(/Usually within 3 days\.$/);
  });

  it("the other steps read the same for both", () => {
    const test = howItWorksSteps(readDeployment(ENV));
    const launch = howItWorksSteps({ batchMaxWaitS: 86_400 });
    expect(test.map((s) => s.title)).toEqual(["Deposit USDC", "We swap and stake", "Earn, and leave any time"]);
    expect([launch[0], launch[2]]).toEqual([test[0], test[2]]);
  });
});

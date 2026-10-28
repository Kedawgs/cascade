import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import { ERC20, FRONT_DOOR, STAKER, VAULT } from "./abi";
import {
  DELIVERY_TOLERANCE_BPS,
  DELIVERY_VALIDITY_S,
  DESTINATION_BASE,
  isV3,
  PATH_TAO_TO_USDC,
  PATH_USDC_TO_TAO,
  readDeployment,
  RPC,
  USDC_PERMIT,
} from "./config";

const ENV = {
  NEXT_PUBLIC_CASCADE_FRONT_DOOR: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  NEXT_PUBLIC_CASCADE_BASE_ADAPTER: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  NEXT_PUBLIC_CASCADE_VAULT: "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750",
  NEXT_PUBLIC_CASCADE_BIT_ADAPTER: "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b",
  NEXT_PUBLIC_CASCADE_BIT_BLOCK: "9357492",
  NEXT_PUBLIC_CASCADE_VAULT_SS58: "5FNEuRkKZvg2jFjhY3DWpC3TBSH51AC3FKQpLyC1xesTBwLu",
  NEXT_PUBLIC_CASCADE_HOTKEY_SS58: "5E4z3h9yVhmQyCFWNbY9BPpwhx4xFiPwq3eeqmBgVF6KULde",
};

describe("readDeployment", () => {
  it("is null without the settings, so the site shows that it isn't connected", () => {
    expect(readDeployment({})).toBeNull();
  });

  it("is null for an address that is not checksummed", () => {
    expect(readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_VAULT: ENV.NEXT_PUBLIC_CASCADE_VAULT.toLowerCase() })).toBeNull();
  });

  it("reads the live deployment", () => {
    expect(readDeployment(ENV)).toEqual({
      frontDoor: ENV.NEXT_PUBLIC_CASCADE_FRONT_DOOR,
      baseAdapter: ENV.NEXT_PUBLIC_CASCADE_BASE_ADAPTER,
      vault: ENV.NEXT_PUBLIC_CASCADE_VAULT,
      bitAdapter: ENV.NEXT_PUBLIC_CASCADE_BIT_ADAPTER,
      bitBlock: 9357492n,
      vaultSs58: ENV.NEXT_PUBLIC_CASCADE_VAULT_SS58,
      hotkeySs58: ENV.NEXT_PUBLIC_CASCADE_HOTKEY_SS58,
    });
  });

  it("reads the batch max wait when it is a whole number of seconds, else leaves it out", () => {
    expect(readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S: "86400" })?.batchMaxWaitS).toBe(86_400);
    expect(readDeployment(ENV)).not.toHaveProperty("batchMaxWaitS");
    for (const bad of ["", "0", "-5", "1.5", "abc"]) {
      expect(readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_BATCH_MAX_WAIT_S: bad })).not.toHaveProperty("batchMaxWaitS");
    }
  });

  it("reads the vault's payout delay when it is a whole number of seconds (0 included), else leaves it out", () => {
    expect(readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: "86400" })?.payoutDelayS).toBe(86_400);
    expect(readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: "3600" })?.payoutDelayS).toBe(3_600);
    expect(readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: "0" })?.payoutDelayS).toBe(0);
    expect(readDeployment(ENV)).not.toHaveProperty("payoutDelayS");
    for (const bad of ["", "-5", "1.5", "abc", "0x10", "007", " 3600", "1e5"]) {
      expect(readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_PAYOUT_DELAY_S: bad }), bad).not.toHaveProperty("payoutDelayS");
    }
  });

  it("routes swaps USDC → WETH (0.05%) → TAO (0.3%) and back", () => {
    expect(PATH_USDC_TO_TAO).toBe(
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda029130001f44200000000000000000000000000000000000006000bb8f3081494b87e8d5fb7960f066e931d1d0e6e3d67",
    );
    expect(PATH_TAO_TO_USDC.slice(0, 42)).toBe("0xf3081494b87e8d5fb7960f066e931d1d0e6e3d67");
  });

  it("reads Bittensor from OpenTensor's archive node: the lite node keeps only minutes of event history", () => {
    expect(RPC.bittensor).toBe("https://archive.chain.opentensor.ai");
  });
});

const STAKER_ADDR = "0x221Cc4cF9c72EA7270f90E8C0756F8f003b6887b";
const ORACLE_ADDR = "0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750";

describe("v3 deployment", () => {
  it("reads staker and oracle, and isV3 needs both", () => {
    const both = readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_STAKER: STAKER_ADDR, NEXT_PUBLIC_CASCADE_ORACLE: ORACLE_ADDR });
    expect(both?.staker).toBe(STAKER_ADDR);
    expect(both?.oracle).toBe(ORACLE_ADDR);
    expect(isV3(both!)).toBe(true);
    expect(isV3(readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_STAKER: STAKER_ADDR })!)).toBe(false);
    expect(isV3(readDeployment({ ...ENV, NEXT_PUBLIC_CASCADE_ORACLE: ORACLE_ADDR })!)).toBe(false);
  });

  it("a v2 env still reads and is not v3", () => {
    const d = readDeployment(ENV)!;
    expect(d).not.toBeNull();
    expect(isV3(d)).toBe(false);
  });

  it("pins the constants", () => {
    expect(RPC.baseLogs).toBe("https://base-rpc.publicnode.com");
    expect(RPC.base).toBe("https://mainnet.base.org");
    expect(DELIVERY_TOLERANCE_BPS).toBe(200);
    expect(DELIVERY_VALIDITY_S).toBe(604_800);
    expect(DESTINATION_BASE).toBe(6);
    expect(USDC_PERMIT).toEqual({ name: "USD Coin", version: "2" });
  });
});

describe("v3 ABIs match the contracts (selectors from cast sig)", () => {
  const sel = (abi: readonly { type: string; name?: string }[], name: string) => {
    const f = abi.find((x) => x.type === "function" && x.name === name);
    expect(f, name).toBeDefined();
    return toFunctionSelector(f as never);
  };
  it("staker", () => {
    expect(sel(STAKER, "stake")).toBe("0x8f582f94");
    expect(sel(STAKER, "stakeWithPermit")).toBe("0x85d45b3a");
    expect(sel(STAKER, "swapFeeBps")).toBe("0x2ffdaf89");
    expect(sel(STAKER, "depositFeeUsdc")).toBe("0xc53d4ada");
  });
  it("front door, erc20, vault", () => {
    expect(sel(FRONT_DOOR, "requestRedeemWithDelivery")).toBe("0x2ef4028b");
    expect(sel(FRONT_DOOR, "setDelivery")).toBe("0x42047915");
    expect(sel(FRONT_DOOR, "deliveryOf")).toBe("0xe981e53d");
    expect(sel(FRONT_DOOR, "usdc")).toBe("0x3e413bee");
    expect(sel(FRONT_DOOR, "maxDeliverySlippageBps")).toBe("0x663da68a");
    expect(sel(ERC20, "nonces")).toBe("0x7ecebe00");
    expect(sel(VAULT, "rewardCutBps")).toBe("0xabbee453");
    expect(FRONT_DOOR.some((x) => x.type === "event" && x.name === "Delivered")).toBe(true);
  });
});

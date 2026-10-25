import { describe, expect, it } from "vitest";
import { PATH_TAO_TO_USDC, PATH_USDC_TO_TAO, readDeployment, RPC } from "./config";

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

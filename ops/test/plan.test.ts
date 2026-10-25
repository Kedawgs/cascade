import { getContractAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { LIVE, PRECOMPILE, SETTINGS, WALLET } from "../src/config.ts";
import { buildPlan } from "../src/plan.ts";

const coldkey: Hex = "0x9214633d20bb6247cb0475ea91ae10665a084404a04147ea48f673571263ad68";
const at = (nonce: number) => getContractAddress({ from: WALLET, nonce: BigInt(nonce) });

describe("buildPlan", () => {
  // different nonces on the two chains, so a chain mix-up cannot pass by coincidence
  const plan = buildPlan(3, 5, coldkey);
  const step = (id: string) => plan.steps.find((s) => s.id === id)!;

  it("predicts each address from its own chain's nonce", () => {
    expect(plan.addresses).toEqual({ baseAdapter: at(3), frontDoor: at(4), bitAdapter: at(5), vault: at(6) });
  });

  it("orders the steps and their nonces as the spec's table", () => {
    expect(plan.steps.map((s) => s.id)).toEqual([
      "baseAdapter",
      "frontDoor",
      "bitAdapter",
      "vault",
      "adapterReserve",
      "vaultReserve",
      "setKeeper",
      "setPayoutDelay",
    ]);
    expect(plan.steps.map((s) => s.nonce)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(plan.steps.map((s) => s.chain)).toEqual(["base", "base", ...Array(6).fill("bittensor")]);
  });

  it("wires the Base adapter to the predicted Bittensor adapter with the Base gas model", () => {
    const s = step("baseAdapter");
    expect(s.kind === "create" && s.contract).toBe("src/adapters/CcipBaseAdapter.sol:CcipBaseAdapter");
    expect(s.args).toEqual([
      {
        router: LIVE.base.ROUTER,
        token: LIVE.base.TOKEN,
        localChainId: 8453n,
        remoteChainId: 964n,
        remoteSelector: LIVE.bittensor.SELECTOR,
        remoteAdapter: plan.addresses.bitAdapter,
        gasBase: SETTINGS.baseGas.base,
        gasPerEntry: SETTINGS.baseGas.perEntry,
      },
      SETTINGS.minSendAmount,
    ]);
  });

  it("points the front door at the predicted vault with the test settings", () => {
    expect(step("frontDoor").args).toEqual([
      LIVE.base.TOKEN,
      plan.addresses.baseAdapter,
      964n,
      plan.addresses.vault,
      WALLET,
      WALLET,
      600n,
      SETTINGS.minDeposit,
      SETTINGS.depositCap,
      SETTINGS.redeemRequestFee,
    ]);
  });

  it("wires the Bittensor adapter back to the Base adapter and ForeverMoney's vault", () => {
    expect(step("bitAdapter").args).toEqual([
      {
        router: LIVE.bittensor.ROUTER,
        token: LIVE.bittensor.TOKEN,
        localChainId: 964n,
        remoteChainId: 8453n,
        remoteSelector: LIVE.base.SELECTOR,
        remoteAdapter: plan.addresses.baseAdapter,
        gasBase: SETTINGS.bitGas.base,
        gasPerEntry: SETTINGS.bitGas.perEntry,
      },
      LIVE.ALPHA_VAULT,
    ]);
  });

  it("names the front door as the vault's initial front door", () => {
    expect(step("vault").args).toEqual([
      coldkey,
      SETTINGS.hotkey,
      plan.addresses.bitAdapter,
      WALLET,
      WALLET,
      SETTINGS.minDirectDeposit,
      8453n,
      plan.addresses.frontDoor,
    ]);
  });

  it("funds the reserves and configures the vault", () => {
    const reserve = step("adapterReserve");
    expect(reserve.kind === "call" && [reserve.to, reserve.functionName, reserve.value]).toEqual([
      plan.addresses.bitAdapter,
      "fundReserve",
      1_000_000_000_000n,
    ]);
    const vaultReserve = step("vaultReserve");
    expect(vaultReserve.kind === "call" && [vaultReserve.to, vaultReserve.value, vaultReserve.args]).toEqual([
      PRECOMPILE.balanceTransfer,
      1500000000000n,
      [coldkey],
    ]);
    const keeper = step("setKeeper");
    expect(keeper.kind === "call" && [keeper.to, keeper.args]).toEqual([plan.addresses.vault, [WALLET]]);
    const delay = step("setPayoutDelay");
    expect(delay.kind === "call" && [delay.to, delay.args]).toEqual([plan.addresses.vault, [3600n]]);
  });
});

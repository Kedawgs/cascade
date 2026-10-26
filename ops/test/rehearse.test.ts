import { type Address, encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, type Hex, parseAbiParameters } from "viem";
import { describe, expect, it } from "vitest";
import { LIVE } from "../src/config.ts";
import { rehearse } from "../src/rehearse.ts";
import {
  CCIP_ROUTER_ABI,
  type CallFrame,
  calldataGas,
  ccipSendIn,
  checkDelivered,
  DEBIT_EVENT,
  type DeliveryResult,
  deliveryMessage,
  extraArgsGas,
  formatReceivers,
  formatStep,
  forkPermitDomain,
  type Measured,
  ROUND_TRIP,
  type RoundTripDeps,
  runRoundTrip,
  type StepReport,
  standInDebits,
} from "../src/roundtrip.ts";

const user: Address = "0x000000000000000000000000000000000000a11c";
const adapter: Address = "0x00000000000000000000000000000000000ada01";
const STAND_IN: Address = "0x0000000000000000000000000000000000000805";
const ID: Hex = `0x${"ab".repeat(32)}`;

const delivery: DeliveryResult = {
  usdcBefore: 0n,
  usdcAfter: 19_500_000n,
  usdcOut: 19_500_000n,
  floors: { user: 19_000_000n, twap: 19_200_000n, keeper: 19_400_000n },
};

/** Deps that record each call and measure every step the same way, except as `over` says. */
function fakeSteps(over: Partial<RoundTripDeps> = {}) {
  const calls: string[] = [];
  const m = (chain: Measured["chain"], payer: Measured["payer"], bridgeFeeWei?: bigint): Measured => ({
    chain,
    payer,
    gasUsed: 100_000n,
    costWei: 10n ** 12n,
    ...(bridgeFeeWei === undefined ? {} : { bridgeFeeWei }),
    detail: "done",
  });
  const deps: RoundTripDeps = {
    permitStake: async () => (calls.push("permitStake"), m("base", "user")),
    closeBatch: async (which) => (calls.push(`closeBatch(${which})`), m("base", "keeper", 6n * 10n ** 14n)),
    relayToBittensor: async (which) => (calls.push(`relayToBittensor(${which})`), m("bittensor", "bridge")),
    stake: async () => (calls.push("stake"), m("bittensor", "keeper")),
    requestRedeem: async () => (calls.push("requestRedeem"), m("base", "user")),
    processPayouts: async () => (calls.push("processPayouts"), m("bittensor", "keeper", 2n * 10n ** 15n)),
    relayToBase: async () => (calls.push("relayToBase"), m("base", "bridge")),
    deliver: async () => (calls.push("deliver"), { ...m("base", "keeper"), delivery }),
    ...over,
  };
  return { deps, calls };
}

describe("the round trip", () => {
  it("runs the ten steps in order, printing each with its gas and fee, then checks the USDC against the floor", async () => {
    const { deps, calls } = fakeSteps();
    const lines: string[] = [];
    const seen: StepReport[] = [];
    const out = await runRoundTrip(deps, (l) => lines.push(l), (r) => seen.push(r));
    expect(calls).toEqual([
      "permitStake",
      "closeBatch(deposit)",
      "relayToBittensor(deposit)",
      "stake",
      "requestRedeem",
      "closeBatch(redeem)",
      "relayToBittensor(redeem)",
      "processPayouts",
      "relayToBase",
      "deliver",
    ]);
    expect(out.reports.map((r) => r.step)).toEqual([...ROUND_TRIP]);
    expect(seen).toEqual(out.reports);
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe(" 1. Base — permit stake: 100,000 gas, 0.000001 ETH (the user). done");
    expect(lines[1]).toBe(" 2. Base — close the deposit batch: 100,000 gas, 0.000001 ETH (the keeper); bridge fee 0.0006 ETH. done");
    expect(lines[2]).toBe(" 3. Bittensor — deliver the deposit batch on Bittensor: 100,000 gas, 0.000001 TAO (CCIP's executor, out of the bridge fee). done");
    expect(lines[7]).toMatch(/^ 8\. Bittensor — process the payout: .*bridge fee 0\.002 TAO/);
    expect(lines[9]).toMatch(/^10\. Base — deliver USDC:/);
    expect(lines[10]).toBe(
      "The user's USDC rose by 19.5 USDC, at least the floor of 19.4 USDC (user 19 USDC, TWAP 19.2 USDC, keeper 19.4 USDC): the round trip delivers",
    );
    expect(out.delivery).toBe(delivery);
    expect(out.reports[0]).not.toHaveProperty("bridgeFeeWei");
  });

  it("stops at the first failure, naming the step, and runs nothing after it", async () => {
    const { deps, calls } = fakeSteps({
      stake: async () => {
        throw new Error("rehearsal: balance too low");
      },
    });
    const seen: StepReport[] = [];
    await expect(runRoundTrip(deps, () => undefined, (r) => seen.push(r))).rejects.toThrow("step 4 (stake the vault's TAO) failed: rehearsal: balance too low");
    expect(calls).toEqual(["permitStake", "closeBatch(deposit)", "relayToBittensor(deposit)"]);
    expect(seen).toHaveLength(3);
  });

  it("fails when the delivery lands under the floor", async () => {
    const short = { ...delivery, usdcAfter: 19_300_000n, usdcOut: 19_300_000n };
    const { deps } = fakeSteps({ deliver: async () => ({ chain: "base", payer: "keeper", gasUsed: 1n, costWei: 1n, detail: "", delivery: short }) });
    await expect(runRoundTrip(deps, () => undefined)).rejects.toThrow(
      "the user's USDC rose by only 19.3 USDC, below the floor of 19.4 USDC (user 19 USDC, TWAP 19.2 USDC, keeper 19.4 USDC)",
    );
  });
});

describe("checkDelivered", () => {
  it("passes at the floor exactly, and takes the largest of the three floors", () => {
    expect(() => checkDelivered({ ...delivery, usdcAfter: 19_400_000n, usdcOut: 19_400_000n })).not.toThrow();
    const twapHighest = { ...delivery, floors: { user: 1n, twap: 19_600_000n, keeper: 1n } };
    expect(() => checkDelivered(twapHighest)).toThrow(/below the floor of 19.6 USDC/);
  });

  it("fails when the user's balance didn't rise by what the front door reports", () => {
    expect(() => checkDelivered({ ...delivery, usdcOut: 19_600_000n })).toThrow(/rose by 19.5 USDC, but the front door reports delivering 19.6 USDC/);
  });
});

describe("formatStep", () => {
  it("names the payer and leaves out a bridge fee the step didn't pay", () => {
    const r: StepReport = { step: "stake the vault's TAO", chain: "bittensor", payer: "keeper", gasUsed: 1_234_567n, costWei: 5n * 10n ** 15n, detail: "staked." };
    expect(formatStep(4, r)).toBe(" 4. Bittensor — stake the vault's TAO: 1,234,567 gas, 0.005 TAO (the keeper). staked.");
  });
});

describe("relaying by hand", () => {
  const extraArgs = (gas: number): Hex => `0xa69dd4aa${gas.toString(16).padStart(8, "0")}${"00".repeat(4)}${"00".repeat(7)}`;
  const send = (data: Hex, tokens: { token: Address; amount: bigint }[]) =>
    encodeFunctionData({
      abi: CCIP_ROUTER_ABI,
      functionName: "ccipSend",
      args: [LIVE.bittensor.SELECTOR, { receiver: encodeAbiParameters(parseAbiParameters("address"), [adapter]), data, tokenAmounts: tokens, feeToken: "0x0000000000000000000000000000000000000000", extraArgs: extraArgs(566_450) }],
    });
  const router = LIVE.base.ROUTER;

  it("finds the adapter's one ccipSend to the router, however deep, and what it carried", () => {
    const trace: CallFrame = {
      from: user,
      to: "0x00000000000000000000000000000000000f0d00",
      input: "0x",
      calls: [
        { from: adapter, to: router, input: "0x20487ded", output: "0x01" },
        {
          from: "0x00000000000000000000000000000000000f0d00",
          to: adapter,
          input: "0x",
          calls: [
            { from: adapter, to: "0x0000000000000000000000000000000000000bad", input: send("0xdead", []), output: ID },
            { from: adapter, to: router, input: send("0xbeef", [{ token: LIVE.base.TOKEN, amount: 5n }]), output: ID },
          ],
        },
      ],
    };
    const s = ccipSendIn(trace, router);
    expect(s).toEqual({
      from: adapter,
      destinationChainSelector: LIVE.bittensor.SELECTOR,
      data: "0xbeef",
      tokenAmounts: [{ token: LIVE.base.TOKEN, amount: 5n }],
      extraArgs: extraArgs(566_450),
      messageId: ID,
    });
    expect(extraArgsGas(s.extraArgs)).toBe(566_450n);
  });

  it("refuses a transaction with no ccipSend, two, or one that failed", () => {
    const one: CallFrame = { from: adapter, to: router, input: send("0x01", []), output: ID };
    expect(() => ccipSendIn({ from: user, input: "0x", calls: [] }, router)).toThrow(/found 0/);
    expect(() => ccipSendIn({ from: user, input: "0x", calls: [one, one] }, router)).toThrow(/found 2/);
    expect(() => ccipSendIn({ from: user, input: "0x", calls: [{ ...one, error: "execution reverted" }] }, router)).toThrow(/found 0/);
  });

  it("hands the destination adapter the source adapter as a 32-byte sender and the destination's own token", () => {
    const sent = { from: adapter, destinationChainSelector: LIVE.bittensor.SELECTOR, data: "0xbeef" as Hex, tokenAmounts: [{ token: LIVE.base.TOKEN as Address, amount: 7n }], extraArgs: extraArgs(1), messageId: ID };
    expect(deliveryMessage(sent, LIVE.base.SELECTOR, LIVE.bittensor.TOKEN)).toEqual({
      messageId: ID,
      sourceChainSelector: LIVE.base.SELECTOR,
      sender: `0x${"00".repeat(12)}${adapter.slice(2)}`,
      data: "0xbeef",
      destTokenAmounts: [{ token: LIVE.bittensor.TOKEN, amount: 7n }],
    });
  });

  it("reads the gas limit only from the adapters' V3 extra args", () => {
    expect(() => extraArgsGas("0x97a657c9000000000000000000000000000000000000000000000000000000000007a120")).toThrow(/not the adapters' V3 tag/);
  });

  it("prices calldata at 4 gas a zero byte and 16 any other", () => {
    expect(calldataGas("0x00ff0001")).toBe(4n + 16n + 4n + 16n);
    expect(calldataGas("0x")).toBe(0n);
  });
});

describe("the staking stand-in's debits", () => {
  it("are read from the stand-in's Debit events only", () => {
    const debit = (address: Address, who: Address, amount: bigint) => ({
      address,
      topics: encodeEventTopics({ abi: DEBIT_EVENT, eventName: "Debit", args: { who } }) as Hex[],
      data: encodeAbiParameters(parseAbiParameters("uint256"), [amount]),
    });
    const other = { address: STAND_IN, topics: [`0x${"11".repeat(32)}`] as Hex[], data: "0x" as Hex };
    expect(standInDebits([debit(STAND_IN, user, 5n), other, debit(adapter, user, 9n), debit(STAND_IN, adapter, 7n)], STAND_IN)).toEqual([
      { who: getAddress(user), amount: 5n },
      { who: getAddress(adapter), amount: 7n },
    ]);
  });
});

describe("forkPermitDomain", () => {
  const domain = { name: "USD Coin", version: "2", verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address };
  // EIP-712 domain separators of USDC on Base computed independently (cast keccak of the encoded domain)
  const BASE_8453: Hex = "0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f";
  const FORK_31337: Hex = "0xf18492e40a6e518a1b6f7edab84066be6742f11e84f48b72f4c41554c984fe8b";

  it("signs in the fork's own chain id when the token's separator is for it", () => {
    expect(forkPermitDomain(FORK_31337, domain, 31337)).toEqual({ ...domain, chainId: 31337 });
  });

  it("fails loudly, before anything is signed, for a separator of another chain or for Base itself", () => {
    expect(() => forkPermitDomain(BASE_8453, domain, 31337)).toThrow("the token's permit domain is not for the fork's chain id 31337; nothing signed");
    expect(() => forkPermitDomain(BASE_8453, domain, 8453)).toThrow("a rehearsal never signs a permit for Base's chain id 8453; nothing signed");
  });
});

describe("formatReceivers", () => {
  it("puts each relay's need against its message's enforced limit on one line", () => {
    const relay = (step: StepReport["step"], need: bigint, limit: bigint): StepReport => ({
      step,
      chain: "base",
      payer: "bridge",
      gasUsed: 1n,
      costWei: 1n,
      receiver: { need, limit },
      detail: "",
    });
    const close: StepReport = { step: "close the deposit batch", chain: "base", payer: "keeper", gasUsed: 1n, costWei: 1n, detail: "" };
    expect(formatReceivers([close, relay("deliver the deposit batch on Bittensor", 207_051n, 566_450n), relay("deliver the payout on Base", 126_000n, 189_900n)])).toBe(
      "Receiver gas needed of the message's limit, each relay sent with that limit enforced: deliver the deposit batch on Bittensor: 207,051 of 566,450 (36.5%); deliver the payout on Base: 126,000 of 189,900 (66.3%)",
    );
  });

  it("is carried from a relay's measurement into its report", async () => {
    const receiver = { need: 5n, limit: 10n };
    const { deps } = fakeSteps({ relayToBase: async () => ({ chain: "base", payer: "bridge", gasUsed: 1n, costWei: 1n, receiver, detail: "" }) });
    const { reports } = await runRoundTrip(deps, () => undefined);
    expect(reports[8].receiver).toEqual(receiver);
    expect(reports[7]).not.toHaveProperty("receiver");
  });
});

describe("rehearse", () => {
  it("refuses a v2 deployment name before starting anything", async () => {
    const lines: string[] = [];
    await expect(rehearse({}, (l) => lines.push(l))).rejects.toThrow(/set OPS_DEPLOYMENT=v3-rehearsal.*v2 rehearsal record is left as it is/);
    expect(lines).toEqual([]);
  });
});

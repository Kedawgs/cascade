import { type Hex, keccak256, pad, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import { ADAPTER, BIT_ADAPTER, BIT_ADAPTER_V32, FRONT_DOOR, FRONT_DOOR_V32, LIMIT_SETTERS, limitSetterOf, STAKER, VAULT, VAULT_V32 } from "../../src/abi.ts";
import { rolesOf } from "../../src/config.ts";
import { decode, identify, identityOf, is, storedIdentity, storedRefOf, topic0Of } from "../../src/logs.ts";
import { rawLog, testConfig, testConfigV32, tx } from "./fixtures.ts";

const cfg = testConfig();
const d = cfg.deployment;
const roleOf = rolesOf(d);
const KEY = keccak256(toBytes("batch 3")) as Hex;
const USER = "0x00000000000000000000000000000000000a11ce" as Hex;
const one = <T>(xs: T[]): T => {
  expect(xs).toHaveLength(1);
  return xs[0];
};

describe("decode", () => {
  it("decodes BatchDelivered with its role, topics and arguments", () => {
    const raw = rawLog({
      address: d.vault,
      abi: VAULT,
      eventName: "BatchDelivered",
      args: { key: KEY, sourceChain: 8453n, frontDoor: d.frontDoor, batchId: 3n, amount: 5n * 10n ** 17n },
      block: 6_900_100n,
      logIndex: 4,
      txHash: tx(1),
    });
    const log = decode("bittensor", one(identify("bittensor", [raw])), roleOf)!;
    expect(log).toMatchObject({
      chain: "bittensor",
      contract: "vault",
      address: d.vault,
      block: 6_900_100n,
      logIndex: 4,
      txHash: tx(1),
      event: "BatchDelivered",
      topic1: KEY,
      topic2: pad("0x2105"),
      topic3: pad(d.frontDoor),
      data: raw.data,
      args: { key: KEY, sourceChain: "8453", frontDoor: d.frontDoor, batchId: "3", amount: "500000000000000000" },
    });
    expect(is(log, "vault", "BatchDelivered")).toBe(true);
    expect(is(log, "frontDoor", "BatchDelivered")).toBe(false);
  });

  it("tells the front door's Delivered from the Base adapter's", () => {
    const fd = rawLog({ address: d.frontDoor, abi: FRONT_DOOR, eventName: "Delivered", args: { user: USER, taoIn: 7n, usdcOut: 9n }, block: 1n, logIndex: 0, txHash: tx(2) });
    const ad = rawLog({
      address: d.baseAdapter,
      abi: ADAPTER,
      eventName: "Delivered",
      args: { messageId: KEY, sourceChain: 2135107236357186872n, sender: d.vault, recipient: d.frontDoor, amount: 7n },
      block: 1n,
      logIndex: 1,
      txHash: tx(2),
    });
    const [a, b] = identify("base", [fd, ad]).map((x) => decode("base", x, roleOf)!);
    expect([a.contract, a.event, a.args]).toEqual(["frontDoor", "Delivered", { user: USER, taoIn: "7", usdcOut: "9" }]);
    expect([b.contract, b.event]).toEqual(["baseAdapter", "Delivered"]);
    expect(b.args).toEqual({ messageId: KEY, sourceChain: "2135107236357186872", sender: d.vault, recipient: d.frontDoor, amount: "7" });
  });

  it("tells the vault's Staked from the staker's", () => {
    const v = rawLog({ address: d.vault, abi: VAULT, eventName: "Staked", args: { hotkey: d.stakeHotkey, rao: 77_877_093n, measured: 77_877_092n }, block: 5n, logIndex: 0, txHash: tx(3) });
    const s = rawLog({
      address: d.staker,
      abi: STAKER,
      eventName: "Staked",
      args: { payer: USER, beneficiary: USER, usdcIn: 20_000_000n, fees: 80_000n, taoDeposited: 4n * 10n ** 16n },
      block: 5n,
      logIndex: 0,
      txHash: tx(4),
    });
    const vl = decode("bittensor", one(identify("bittensor", [v])), roleOf)!;
    const sl = decode("base", one(identify("base", [s])), roleOf)!;
    expect([vl.contract, vl.event, vl.args.rao, vl.args.measured]).toEqual(["vault", "Staked", "77877093", "77877092"]);
    expect([sl.contract, sl.event, sl.args.payer, sl.args.taoDeposited]).toEqual(["staker", "Staked", USER, "40000000000000000"]);
  });

  it("decodes a csTAO mint Transfer and the Bittensor adapter's ReserveFunded", () => {
    const mint = rawLog({
      address: d.vault,
      abi: VAULT,
      eventName: "Transfer",
      args: { from: "0x0000000000000000000000000000000000000000", to: USER, value: 10n ** 18n },
      block: 9n,
      logIndex: 1,
      txHash: tx(5),
    });
    const fund = rawLog({ address: d.bitAdapter, abi: BIT_ADAPTER, eventName: "ReserveFunded", args: { from: USER, amount: 10n ** 12n }, block: 9n, logIndex: 0, txHash: tx(6) });
    // identify puts them in log order: the top-up (index 0), then the mint (index 1)
    const [f, m] = identify("bittensor", [mint, fund]).map((x) => decode("bittensor", x, roleOf)!);
    expect([f.contract, f.event, f.args]).toEqual(["bitAdapter", "ReserveFunded", { from: USER, amount: "1000000000000" }]);
    expect([m.contract, m.event, m.args]).toEqual(["vault", "Transfer", { from: "0x0000000000000000000000000000000000000000", to: USER, value: "1000000000000000000" }]);
  });

  it('calls a log whose topic no ABI knows "unknown", with no arguments', () => {
    const raw = { ...rawLog({ address: d.vault, abi: VAULT, eventName: "HotkeyAdded", args: { hotkey: d.stakeHotkey }, block: 2n, logIndex: 0, txHash: tx(7) }) };
    raw.topics = [keccak256(toBytes("Nothing(uint256)")), ...raw.topics.slice(1)];
    const log = decode("bittensor", one(identify("bittensor", [raw])), roleOf)!;
    expect([log.contract, log.event, log.args]).toEqual(["vault", "unknown", {}]);
  });

  it('calls a known topic with data that does not decode "unknown"', () => {
    const raw = rawLog({ address: d.vault, abi: VAULT, eventName: "Staked", args: { hotkey: d.stakeHotkey, rao: 1n, measured: 1n }, block: 2n, logIndex: 0, txHash: tx(8) });
    const log = decode("bittensor", one(identify("bittensor", [{ ...raw, data: "0x1234" }])), roleOf)!;
    expect(log.event).toBe("unknown");
  });

  it("leaves out a log from an address that isn't one of ours on that chain", () => {
    const raw = rawLog({ address: d.vault, abi: VAULT, eventName: "HotkeyAdded", args: { hotkey: d.stakeHotkey }, block: 2n, logIndex: 0, txHash: tx(9) });
    expect(decode("base", one(identify("base", [raw])), roleOf)).toBeUndefined();
  });
});

describe("decode by the deployment's contracts version", () => {
  const cfg32 = testConfigV32();
  const d32 = cfg32.deployment;
  const roles32 = rolesOf(d32);
  const chunk31 = { key: KEY, chunk: 0, taken: 2, gross: 3n * 10n ** 18n, net: 2_990_000_000_000_000_000n, fee: 10n ** 16n };
  const chunk32 = { ...chunk31, charged: 9n * 10n ** 15n, unstakeCost: 10n ** 15n };
  const at = (abi: Parameters<typeof rawLog>[0]["abi"], eventName: string, args: Record<string, unknown>, n: number, address = d.vault) =>
    rawLog({ address, abi, eventName, args, block: 6_900_200n, logIndex: n, txHash: tx(50 + n) });

  it("decodes v3.2's eight-field PayoutChunkSent only on a v3.2 deployment, and v3.1's six-field one only on v3.1 (v3-launch)", () => {
    const raw32 = at(VAULT_V32, "PayoutChunkSent", chunk32, 0);
    const raw31 = at(VAULT, "PayoutChunkSent", chunk31, 1);
    // their topics differ: one name, two signatures
    expect(raw32.topics[0]).not.toBe(raw31.topics[0]);
    const v32 = decode("bittensor", one(identify("bittensor", [raw32])), roles32, d32.version)!;
    expect([v32.event, v32.args]).toEqual(["PayoutChunkSent", { key: KEY, chunk: 0, taken: 2, gross: "3000000000000000000", net: "2990000000000000000", fee: "10000000000000000", charged: "9000000000000000", unstakeCost: "1000000000000000" }]);
    expect(decode("bittensor", one(identify("bittensor", [raw31])), roles32, d32.version)?.event).toBe("unknown");
    // v3-launch's deployment (no version: v3.1) decodes exactly as it did
    expect(decode("bittensor", one(identify("bittensor", [raw31])), roleOf)?.args).toEqual({ key: KEY, chunk: 0, taken: 2, gross: "3000000000000000000", net: "2990000000000000000", fee: "10000000000000000" });
    expect(decode("bittensor", one(identify("bittensor", [raw31])), roleOf, "v3.1")?.event).toBe("PayoutChunkSent");
    expect(decode("bittensor", one(identify("bittensor", [raw32])), roleOf)?.event).toBe("unknown");
  });

  it("decodes the events the v3.2 libraries log at the vault's address, and the new front door, adapter and scheduler events", () => {
    const logs = [
      at(VAULT_V32, "DepositBounced", { key: KEY, user: USER, assets: 5n, reason: 1 }, 0),
      at(VAULT_V32, "ShortfallAbsorbed", { amount: 7n }, 1),
      at(VAULT_V32, "RedeemedDirect", { user: USER, shares: 2n, assets: 3n, acceptedMissing: true }, 2),
      at(VAULT_V32, "UnstakeSkipped", { hotkey: d.stakeHotkey }, 3),
      at(VAULT_V32, "PayoutBatchCancelled", { key: KEY, reminted: 9n, bouncesCarried: 2 }, 4),
      at(VAULT_V32, "Scheduled", { id: KEY, kind: 0, selector: "0x12345678", readyAt: 1_800_172_800n, data: "0x12345678" }, 5),
      at(BIT_ADAPTER_V32, "BatchParked", { key: KEY, messageId: KEY, recipient: d.vault, sender: d.frontDoor, amount: 5n, converted: false, reason: "0xdeadbeef" }, 6, d.bitAdapter),
    ];
    const got = identify("bittensor", logs).map((x) => decode("bittensor", x, roles32, "v3.2")!);
    expect(got.map((l) => [l.contract, l.event])).toEqual([
      ["vault", "DepositBounced"],
      ["vault", "ShortfallAbsorbed"],
      ["vault", "RedeemedDirect"],
      ["vault", "UnstakeSkipped"],
      ["vault", "PayoutBatchCancelled"],
      ["vault", "Scheduled"],
      ["bitAdapter", "BatchParked"],
    ]);
    expect(got[0].args).toEqual({ key: KEY, user: USER, assets: "5", reason: 1 });
    expect(got[2].args.acceptedMissing).toBe(true);
    expect(got[4].args).toEqual({ key: KEY, reminted: "9", bouncesCarried: 2 });
    expect(got[5].args).toMatchObject({ id: KEY, kind: 0, selector: "0x12345678", readyAt: "1800172800", data: "0x12345678" });
    const closed = at(FRONT_DOOR_V32, "BatchClosed", { id: 4n, totalDeposits: 1n, nDeposits: 1n, nRedeems: 0n, fee: 2n, potUsed: 2n, potCarried: 3n }, 0, d.frontDoor);
    expect(decode("base", one(identify("base", [closed])), roles32, "v3.2")?.args).toMatchObject({ id: "4", potUsed: "2", potCarried: "3" });
  });

  it("decodes the constructor's deploy-block events (every setter's LimitSet by selector, HotkeyAdded, FrontDoorActivated), the setter named by its selector", () => {
    const [selector, setter] = [...LIMIT_SETTERS][0];
    const logs = [
      at(VAULT_V32, "LimitSet", { selector, a: 5n, b: 0n }, 0),
      at(VAULT_V32, "HotkeyAdded", { hotkey: d.stakeHotkey }, 1),
      at(VAULT_V32, "FrontDoorActivated", { chain: 8453n, addr: d.frontDoor }, 2),
    ];
    const [limit, added, door] = identify("bittensor", logs).map((x) => decode("bittensor", x, roles32, "v3.2")!);
    expect([limit.event, limitSetterOf(String(limit.args.selector)), limitSetterOf(limit.topic1 as Hex)]).toEqual(["LimitSet", setter, setter]);
    expect([added.event, door.event]).toEqual(["HotkeyAdded", "FrontDoorActivated"]);
    // v3-launch's LimitSet(bytes32 name, ...) is another topic: a v3.2 LimitSet would be unknown there
    expect(decode("bittensor", one(identify("bittensor", [logs[0]])), roleOf)?.event).toBe("unknown");
  });

  it("rebuilds a stored v3.2 log's identity from its columns with v3.2's topics", () => {
    const raw = at(VAULT_V32, "PayoutChunkSent", chunk32, 0);
    const log = decode("bittensor", one(identify("bittensor", [raw])), roles32, "v3.2")!;
    const ref = storedRefOf(log);
    expect(storedIdentity(ref, "v3.2")).toBe(identityOf(raw));
    expect(topic0Of("vault", "PayoutChunkSent", "v3.2")).toBe(raw.topics[0]);
    // v3.1's topic for the same name is the six-field event's
    expect(topic0Of("vault", "PayoutChunkSent")).toBe(at(VAULT, "PayoutChunkSent", chunk31, 1).topics[0]);
    expect(storedIdentity(ref)).not.toBe(identityOf(raw));
  });
});

describe("identify", () => {
  const base = rawLog({ address: d.vault, abi: VAULT, eventName: "HotkeyAdded", args: { hotkey: d.stakeHotkey }, block: 10n, logIndex: 3, txHash: tx(10) });

  it("is the keeper's identity with the chain in front", () => {
    const { uid } = one(identify("bittensor", [base]));
    expect(uid).toBe(keccak256(toBytes(`bittensor:${tx(10)}:${base.topics.join(",")}:${base.data}#0`)));
  });

  it("gives a re-mined copy the same uid", () => {
    const again = { ...base, blockNumber: "0xb", logIndex: "0x0" } as const;
    expect(one(identify("bittensor", [base])).uid).toBe(one(identify("bittensor", [again])).uid);
  });

  it("numbers two identical logs in one transaction #0 and #1", () => {
    const twice = identify("bittensor", [base, { ...base, logIndex: "0x4" }]);
    expect(twice).toHaveLength(2);
    expect(twice[0].uid).not.toBe(twice[1].uid);
    expect(twice[1].uid).toBe(keccak256(toBytes(`bittensor:${tx(10)}:${base.topics.join(",")}:${base.data}#1`)));
  });

  it("gives the same log on another chain another uid", () => {
    expect(one(identify("base", [base])).uid).not.toBe(one(identify("bittensor", [base])).uid);
  });

  it("is the same whatever the hex case the node answered in", () => {
    const upper = { ...base, transactionHash: base.transactionHash.toUpperCase().replace("0X", "0x") as Hex, data: base.data.toUpperCase().replace("0X", "0x") as Hex };
    expect(one(identify("bittensor", [upper])).uid).toBe(one(identify("bittensor", [base])).uid);
  });

  it("numbers by log order, whatever order the node listed them in", () => {
    const a = { ...base, logIndex: "0x3" } as const;
    const b = { ...base, logIndex: "0x5" } as const;
    expect(identify("bittensor", [b, a]).map((x) => x.raw.logIndex)).toEqual(["0x3", "0x5"]);
    expect(identify("bittensor", [b, a]).map((x) => x.uid)).toEqual(identify("bittensor", [a, b]).map((x) => x.uid));
  });
});

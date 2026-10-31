import { type Hex, numberToHex } from "viem";
import { describe, expect, it } from "vitest";
import { ADMIN_EVENTS } from "../../src/abi.ts";
import { ATTRIBUTABLE, argSenders, blockTimes, fetchTxs, senderFromArgs, txsToFetch } from "../../src/attribute.ts";
import type { StoredLog } from "../../src/logs.ts";
import { Budget, createRpc } from "../../src/rpc.ts";
import { fakeChains, TEST_URLS } from "./fake-rpc.ts";
import { tx } from "./fixtures.ts";

const PAYER = "0x00000000000000000000000000000000000000aa" as Hex;
const USER = "0x00000000000000000000000000000000000000bb" as Hex;

const log = (contract: StoredLog["contract"], event: string, args: StoredLog["args"] = {}, n = 1): StoredLog => ({
  uid: tx(1000 + n),
  chain: contract === "vault" || contract === "bitAdapter" ? "bittensor" : "base",
  contract,
  address: "0x0000000000000000000000000000000000000001",
  block: 10n,
  logIndex: 0,
  txHash: tx(n),
  event,
  data: "0x",
  args,
});

function setup() {
  const txOf = (hash: Hex) => ({
    hash,
    from: "0x00000000000000000000000000000000000000CC",
    to: "0x00000000000000000000000000000000000000DD",
    input: "0xA9059CBB000000000000000000000000000000000000000000000000000000000000000a",
    nonce: "0x7",
    blockNumber: "0xa",
  });
  const net = fakeChains({
    base: { head: 100n, calls: { eth_getTransactionByHash: ([h]) => (h === tx(404) ? null : txOf(h as Hex)) } },
    bittensor: { head: 100n },
  });
  const budget = new Budget(45);
  const rpc = createRpc({ urls: TEST_URLS, fetch: net.fetch, budget, sleep: async () => {}, spacingMs: { base: 0, bittensor: 0 } });
  return { net, budget, rpc };
}

describe("blockTimes", () => {
  it("reads three blocks' times in one request", async () => {
    const { net, budget, rpc } = setup();
    const times = await blockTimes(rpc, "bittensor", [5n, 7n, 5n, 6n]);
    expect([...times]).toEqual([
      [5n, 1_700_000_060],
      [6n, 1_700_000_072],
      [7n, 1_700_000_084],
    ]);
    expect(net.count()).toBe(1);
    expect(budget.left).toBe(44);
  });

  it("reads at most 20 blocks a tick, the oldest first; the rest wait", async () => {
    const { net, rpc } = setup();
    const times = await blockTimes(rpc, "bittensor", Array.from({ length: 30 }, (_, i) => BigInt(30 - i)));
    expect([...times.keys()]).toEqual(Array.from({ length: 20 }, (_, i) => BigInt(i + 1)));
    expect(net.fetches[0].methods).toHaveLength(20);
  });

  it("leaves out a block the node doesn't have yet, and asks nothing for none", async () => {
    const { net, rpc } = setup();
    expect([...(await blockTimes(rpc, "bittensor", [99n, 150n])).keys()]).toEqual([99n]);
    expect((await blockTimes(rpc, "bittensor", [])).size).toBe(0);
    expect(net.count()).toBe(1);
  });
});

describe("senderFromArgs", () => {
  it("takes the caller from the events that name it", () => {
    expect(senderFromArgs(log("frontDoor", "DepositRequested", { batchId: "1", user: USER, amount: "1", payer: PAYER }))).toBe(PAYER);
    expect(senderFromArgs(log("frontDoor", "FeeCredited", { user: USER, amount: "1", payer: PAYER }))).toBe(PAYER);
    for (const e of ["RedeemRequested", "RedeemCancelled", "DepositCancelled", "Claimed", "DeliverySet"]) {
      expect(senderFromArgs(log("frontDoor", e, { user: USER }))).toBe(USER);
    }
    expect(senderFromArgs(log("staker", "Staked", { payer: PAYER, beneficiary: USER }))).toBe(PAYER);
    expect(senderFromArgs(log("bitAdapter", "ReserveFunded", { from: PAYER, amount: "1" }))).toBe(PAYER);
    // the vault's direct entry points name msg.sender as `user`
    for (const e of ["DepositedDirect", "RedeemedDirect", "FrontDoorRedeemsAllowed"]) {
      expect(senderFromArgs(log("vault", e, { user: USER, assets: "1", shares: "1" })), e).toBe(USER);
    }
  });

  it("names nobody for events that don't carry their caller", () => {
    expect(senderFromArgs(log("vault", "Staked", { hotkey: tx(1), rao: "1", measured: "1" }))).toBeUndefined();
    expect(senderFromArgs(log("vault", "Deposited", { key: tx(1), user: USER }))).toBeUndefined();
    expect(senderFromArgs(log("baseAdapter", "Delivered", { sender: PAYER }))).toBeUndefined();
  });

  it("turns them into transaction rows with the sender only", () => {
    const rows = argSenders([log("frontDoor", "Claimed", { user: USER }, 3), log("vault", "Staked", {}, 4)]);
    expect(rows).toEqual([{ chain: "base", hash: tx(3), from: USER }]);
  });
});

describe("which transactions are fetched", () => {
  it("covers the events only a few addresses cause (the owner's StakeMoved among them), and every admin event", () => {
    for (const e of ["frontDoor:BatchClosed", "frontDoor:BatchRolled", "frontDoor:Delivered", "vault:PayoutChunkSent", "vault:Staked", "vault:RewardsClaimed", "vault:HotkeyAdded", "vault:StakeMoved"]) {
      expect(ATTRIBUTABLE.has(e as never), e).toBe(true);
    }
    for (const e of ADMIN_EVENTS) expect(ATTRIBUTABLE.has(e), e).toBe(true);
    expect(ATTRIBUTABLE.has("baseAdapter:Delivered" as never)).toBe(false);
  });

  it("fetches the front door's Delivered but not the Base adapter's, each transaction once", () => {
    const hashes = txsToFetch([
      log("frontDoor", "Delivered", {}, 1),
      log("baseAdapter", "Delivered", {}, 2),
      log("frontDoor", "BatchClosed", {}, 1),
      log("vault", "PayoutChunkSent", {}, 5),
      log("frontDoor", "DepositRequested", {}, 6),
    ]);
    expect(hashes).toEqual([
      { chain: "base", hash: tx(1) },
      { chain: "bittensor", hash: tx(5) },
    ]);
  });
});

describe("fetchTxs", () => {
  it("reads the senders in one request, with each one's selector and nonce, lowercased", async () => {
    const { net, rpc } = setup();
    const rows = await fetchTxs(rpc, "base", [tx(1), tx(2), tx(1), tx(404)]);
    expect(rows).toEqual([
      { chain: "base", hash: tx(1), from: "0x00000000000000000000000000000000000000cc", to: "0x00000000000000000000000000000000000000dd", selector: "0xa9059cbb", nonce: 7 },
      { chain: "base", hash: tx(2), from: "0x00000000000000000000000000000000000000cc", to: "0x00000000000000000000000000000000000000dd", selector: "0xa9059cbb", nonce: 7 },
    ]);
    expect(net.count()).toBe(1);
  });

  it("reads at most 20 a tick", async () => {
    const { net, rpc } = setup();
    const rows = await fetchTxs(rpc, "base", Array.from({ length: 25 }, (_, i) => tx(i + 1)));
    expect(rows).toHaveLength(20);
    expect(net.fetches[0].methods).toHaveLength(20);
    expect(numberToHex(20)).toBe("0x14");
  });
});

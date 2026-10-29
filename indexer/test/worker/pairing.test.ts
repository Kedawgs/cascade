import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { groupDelivered, pairSent } from "../../src/crosscheck/pairing.ts";
import type { StoredLog } from "../../src/logs.ts";
import { tx } from "./fixtures.ts";
import { slog } from "./rule-ctx.ts";

const FD = "0x8a825738d0287d0959957a0f6ec18ba1276d209d" as Hex;
const VAULT = "0x44ceace0b097d9d5ef01e08b12029ad2762cbdc6" as Hex;
const OTHER = "0x00000000000000000000000000000000000000ee" as Hex;
const T = tx(1);

/** One transaction's logs, in the order given. */
function inTx(...logs: Omit<Partial<StoredLog>, "logIndex">[]): StoredLog[] {
  return logs.map((l, i) => slog({ contract: "frontDoor", event: "x", block: 10n, txHash: T, ...l, logIndex: i } as StoredLog));
}
const sent = (contract: "baseAdapter" | "bitAdapter", sender: Hex, messageId: string) => ({ contract, chain: contract === "baseAdapter" ? "base" : "bittensor", event: "Sent", args: { messageId, sender } }) as const;
const closed = (id: number) => ({ contract: "frontDoor", chain: "base", event: "BatchClosed", args: { id: String(id) } }) as const;
const chunk = (n: number, net: string) => ({ contract: "vault", chain: "bittensor", event: "PayoutChunkSent", args: { chunk: n, net } }) as const;

describe("pairSent", () => {
  it("pairs each of two closes in one transaction with its own Sent", () => {
    const logs = inTx(sent("baseAdapter", FD, "m1"), closed(43), sent("baseAdapter", FD, "m2"), closed(44));
    const p = pairSent(logs, { closer: "frontDoor:BatchClosed", adapter: "baseAdapter", sender: FD });
    expect(p.get(logs[1].uid)?.args.messageId).toBe("m1");
    expect(p.get(logs[3].uid)?.args.messageId).toBe("m2");
  });

  it("takes the nearest earlier Sent from the sender, never one from another sender or before the previous closer", () => {
    const logs = inTx(sent("baseAdapter", FD, "m1"), sent("baseAdapter", OTHER, "m0"), closed(43), closed(44));
    const p = pairSent(logs, { closer: "frontDoor:BatchClosed", adapter: "baseAdapter", sender: FD });
    expect(p.get(logs[2].uid)?.args.messageId).toBe("m1");
    expect(p.get(logs[3].uid)).toBeUndefined();
  });

  it("gives a PayoutChunkSent with net = 0 no Sent, between two others that each take theirs", () => {
    const logs = inTx(sent("bitAdapter", VAULT, "a"), chunk(0, "5"), chunk(1, "0"), sent("bitAdapter", VAULT, "b"), chunk(2, "7"));
    const p = pairSent(logs, { closer: "vault:PayoutChunkSent", adapter: "bitAdapter", sender: VAULT });
    expect([1, 2, 4].map((i) => p.get(logs[i].uid)?.args.messageId)).toEqual(["a", undefined, "b"]);
    expect(p.has(logs[2].uid)).toBe(true);
  });
});

describe("groupDelivered", () => {
  const delivered = (recipient: Hex, messageId: string) => ({ contract: "bitAdapter", chain: "bittensor", event: "Delivered", args: { messageId, recipient } }) as const;
  const vault = (event: string, key: string) => ({ contract: "vault", chain: "bittensor", event, args: { key } }) as const;

  it("keeps two deliveries in one transaction apart, each closed by the first Delivered to the vault after it", () => {
    const logs = inTx(
      vault("BatchDelivered", "k1"),
      vault("Deposited", "k1"),
      delivered(OTHER, "x"),
      delivered(VAULT, "m1"),
      vault("BatchDelivered", "k2"),
      vault("Transfer", ""),
      vault("Redeemed", "k2"),
      delivered(VAULT, "m2"),
    );
    const g = groupDelivered(logs, { opener: "vault:BatchDelivered", adapter: "bitAdapter", recipient: VAULT });
    expect(g.map((x) => [x.opener.args.key, x.events.map((e) => e.event), x.delivered?.args.messageId])).toEqual([
      ["k1", ["Deposited"], "m1"],
      ["k2", ["Transfer", "Redeemed"], "m2"],
    ]);
  });

  it("leaves a group open when no Delivered to the recipient follows", () => {
    const logs = inTx(vault("BatchDelivered", "k1"), vault("Deposited", "k1"));
    const [g] = groupDelivered(logs, { opener: "vault:BatchDelivered", adapter: "bitAdapter", recipient: VAULT });
    expect(g.delivered).toBeUndefined();
    expect(g.events).toHaveLength(1);
  });
});

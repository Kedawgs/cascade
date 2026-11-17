import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { StoredLog } from "../../src/logs.ts";
import { DIRECT_ORIGIN, redeemOrigins } from "../../src/origins.ts";
import { h } from "./bridge-fixtures.ts";
import { slog } from "./rule-ctx.ts";

// v3.2's redeem origins (spec §3.4, Task 18): only setRedeemOrigin logs an event of its own (RedeemOriginSet); a door's
// first mint and a direct deposit are fully determined by their own events and the state before them.

const U = "0x00000000000000000000000000000000000000a1" as Hex;
const V = "0x00000000000000000000000000000000000000b2" as Hex;
let n = 0;
const vault = (event: string, args: StoredLog["args"], o: { block?: bigint; txHash?: Hex } = {}) => slog({ contract: "vault", event, args, block: o.block ?? 10n, logIndex: n++, txHash: o.txHash ?? h(`tx ${n}`) });
const delivered = (key: Hex, chain: bigint, txHash: Hex) => vault("BatchDelivered", { key, sourceChain: String(chain), frontDoor: U, batchId: "1", amount: "1" }, { txHash });

describe("redeemOrigins", () => {
  it("a door's mint of non-zero assets sets an origin of 0 to that door's chain (its BatchDelivered's sourceChain), and keeps any other", () => {
    const t = h("delivery");
    const k = h("key");
    const logs = [delivered(k, 8453n, t), vault("Deposited", { key: k, user: U, assets: "5", shares: "5" }, { txHash: t })];
    expect(redeemOrigins(logs)).toEqual(new Map([[U, 8453n]]));
    // a user already of another origin keeps it (the vault bounced that deposit ForeignOrigin, or it was its own chain)
    expect(redeemOrigins(logs, new Map([[U, DIRECT_ORIGIN]]))).toEqual(new Map([[U, DIRECT_ORIGIN]]));
    expect(redeemOrigins(logs, new Map([[U, 1n]]))).toEqual(new Map([[U, 1n]]));
  });

  it("an entry below a rao (Deposited of 0 assets) and a bounce write no origin", () => {
    const t = h("delivery 2");
    const k = h("key 2");
    const logs = [
      delivered(k, 8453n, t),
      vault("Deposited", { key: k, user: U, assets: "0", shares: "0" }, { txHash: t }),
      vault("DepositBounced", { key: k, user: V, assets: "9", reason: 1 }, { txHash: t }),
    ];
    expect(redeemOrigins(logs)).toEqual(new Map());
  });

  it("a direct deposit sets DIRECT_ORIGIN whatever came before, and setRedeemOrigin sets the chain it names, in log order", () => {
    const logs = [vault("RedeemOriginSet", { user: U, chain: "8453" }, { block: 12n }), vault("DepositedDirect", { user: U, assets: "1", shares: "1" }, { block: 11n }), vault("RedeemOriginSet", { user: V, chain: String(DIRECT_ORIGIN) }, { block: 13n })];
    // the direct deposit (block 11) first, then the user's own choice (block 12)
    expect(redeemOrigins(logs)).toEqual(
      new Map([
        [U, 8453n],
        [V, DIRECT_ORIGIN],
      ]),
    );
    expect(DIRECT_ORIGIN).toBe(2n ** 64n - 1n);
  });

  it("reads only the vault's logs", () => {
    expect(redeemOrigins([slog({ contract: "frontDoor", event: "RedeemOriginSet", args: { user: U, chain: "1" } })])).toEqual(new Map());
  });
});

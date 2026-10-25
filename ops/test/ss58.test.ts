import { describe, expect, it } from "vitest";
import { WALLET_SS58 } from "../src/config.ts";
import { decodeSs58 } from "../src/ss58.ts";

describe("decodeSs58", () => {
  it("decodes Alice's well-known address", () => {
    expect(decodeSs58("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY")).toBe(
      "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
    );
  });

  it("decodes the test wallet's Bittensor address to its live addressMapping", () => {
    expect(decodeSs58(WALLET_SS58)).toBe("0xac29c6a523e78ec14ce4e9086c8ab9f67b1377ef225f2bb285c39e0ba0207481");
  });

  it("refuses a changed character, another network's prefix and junk", () => {
    expect(() => decodeSs58("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQZ")).toThrow(/checksum/);
    // Alice on Polkadot (prefix 0)
    expect(() => decodeSs58("15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5")).toThrow(/prefix/);
    expect(() => decodeSs58("0x1234")).toThrow();
    expect(() => decodeSs58("5Grw")).toThrow(/length/);
  });
});

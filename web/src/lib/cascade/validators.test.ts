import { describe, expect, it } from "vitest";
import EXPECTED from "./deployments.json";
import { VALIDATORS, validatorName } from "./validators";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** The 32-byte public key inside an SS58 address (1 prefix byte, 32 key bytes, 2 checksum bytes). */
function ss58Key(s: string): string {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const hex = n.toString(16).padStart(70, "0");
  return `0x${hex.slice(2, 66)}`;
}

describe("validator names", () => {
  it("tao.bot's hotkey is the live deployment's stake hotkey", () => {
    const live = (EXPECTED as Record<string, { hotkeySs58: string }>)["v3-launch"].hotkeySs58;
    const entry = VALIDATORS.find((v) => v.name === "tao.bot")!;
    expect(entry.ss58).toBe(live);
    expect(entry.hotkey).toBe(ss58Key(live));
    expect(validatorName(ss58Key(live))).toBe("tao.bot");
  });
  it("every listed ss58 decodes to its hex", () => {
    for (const v of VALIDATORS) expect(v.hotkey).toBe(ss58Key(v.ss58));
  });
  it("names Yuma, ignores case, shortens anything else", () => {
    expect(validatorName("0x40C47B6A294686FE9612B5D78DD369F4C77FA3BBF96A4286EDE97410BA2E3209")).toBe("Yuma");
    expect(validatorName("0x" + "ab".repeat(32))).toBe("0xabab…abab");
  });
});

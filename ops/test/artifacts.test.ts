import { describe, expect, it } from "vitest";
import { loadArtifact, maskImmutables } from "../src/artifacts.ts";
import { paths } from "../src/config.ts";

const dir = paths({}).contractsDir;

describe("artifacts", () => {
  it("loads the vault's ABI, code and immutable ranges from the build", () => {
    const a = loadArtifact(dir, "CascadeVault");
    expect(a.abi.some((i) => i.type === "function" && i.name === "processPayouts")).toBe(true);
    expect(a.bytecode.startsWith("0x")).toBe(true);
    expect(a.deployedBytecode.length).toBeGreaterThan(1000);
    expect(a.immutableRanges.length).toBeGreaterThan(0);
  });

  it("loads the rehearsal stand-ins", () => {
    expect(loadArtifact(dir, "RehearsalBalanceTransfer").deployedBytecode.length).toBeGreaterThan(10);
  });

  it("masks immutable byte ranges and keeps the length", () => {
    expect(maskImmutables("0x11223344", [{ start: 1, length: 2 }])).toBe("0x11000044");
    expect(maskImmutables("0x11223344", []).length).toBe(10);
  });
});

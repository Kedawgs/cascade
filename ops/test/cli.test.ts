import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../src/args.ts";

describe("cli arguments", () => {
  it("parses deploy --live --new-plan", () => {
    expect(parseArgs(["deploy", "--live", "--new-plan"])).toEqual({ cmd: "deploy", live: true, newPlan: true, users: [] });
  });

  it("keeps rehearsal as the default target", () => {
    expect(parseArgs(["status"])).toMatchObject({ cmd: "status", live: false });
  });

  it("needs both sweep destinations", () => {
    expect(() => parseArgs(["sweep", "--live", "--eth-to", "0x770932787DD3bcE64f14E31f4746bCe22E214fFF"])).toThrow(UsageError);
    expect(parseArgs(["sweep", "--live", "--tao-to", "5Fx", "--eth-to", "0x77"])).toMatchObject({ taoTo: "5Fx", ethTo: "0x77" });
  });

  it("needs a message id for track", () => {
    expect(() => parseArgs(["track"])).toThrow(UsageError);
    expect(parseArgs(["track", "0xab", "--live"])).toMatchObject({ cmd: "track", messageId: "0xab", live: true });
  });

  it("collects repeated --user and refuses unknown commands and flags", () => {
    expect(parseArgs(["wind-down", "--user", "0x1", "--user", "0x2"]).users).toEqual(["0x1", "0x2"]);
    expect(() => parseArgs(["launch"])).toThrow(UsageError);
    expect(() => parseArgs(["status", "--force"])).toThrow(UsageError);
  });
});

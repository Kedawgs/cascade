import { describe, expect, it } from "vitest";
import { parseActivityParams } from "./activity-params";

describe("parseActivityParams", () => {
  it("defaults to the list", () => {
    expect(parseActivityParams(new URLSearchParams(""))).toEqual({ kind: "list" });
    expect(parseActivityParams(new URLSearchParams("deposit="))).toEqual({ kind: "list" });
  });

  it("picks a deposit or a withdrawal", () => {
    expect(parseActivityParams(new URLSearchParams("deposit=d-1"))).toEqual({
      kind: "deposit",
      id: "d-1",
    });
    expect(parseActivityParams(new URLSearchParams("withdrawal=w-9"))).toEqual({
      kind: "withdrawal",
      id: "w-9",
    });
  });

  it("prefers the deposit when both are given", () => {
    expect(parseActivityParams(new URLSearchParams("withdrawal=w&deposit=d"))).toEqual({
      kind: "deposit",
      id: "d",
    });
  });
});

import { describe, expect, it } from "vitest";
import { parseActivityParams } from "./activity-params";

describe("parseActivityParams", () => {
  it("defaults to the list, on the deposits tab", () => {
    expect(parseActivityParams(new URLSearchParams(""))).toEqual({ kind: "list", tab: "deposits" });
    expect(parseActivityParams(new URLSearchParams("deposit="))).toEqual({ kind: "list", tab: "deposits" });
  });

  it("opens the unstakes tab when asked, and the deposits tab for anything else", () => {
    expect(parseActivityParams(new URLSearchParams("tab=unstakes"))).toEqual({ kind: "list", tab: "unstakes" });
    expect(parseActivityParams(new URLSearchParams("tab=whatever"))).toEqual({ kind: "list", tab: "deposits" });
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

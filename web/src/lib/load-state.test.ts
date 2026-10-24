import { describe, expect, it } from "vitest";
import { loadState } from "./load-state";

describe("loadState", () => {
  it("reports an error before it reports loading", () => {
    expect(loadState({ isError: true, data: undefined })).toBe("error");
    expect(loadState({ isError: true, data: { stale: true } })).toBe("error");
  });

  it("is loading until data arrives, then ready", () => {
    expect(loadState({ isError: false, data: undefined })).toBe("loading");
    expect(loadState({ isError: false, data: null })).toBe("ready");
    expect(loadState({ isError: false, data: [] })).toBe("ready");
  });
});

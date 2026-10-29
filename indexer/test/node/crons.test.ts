import { describe, expect, it } from "vitest";
import { CRONS } from "../../src/crons.ts";
import { pkg, readJsonc } from "./files.ts";

interface Wrangler {
  triggers?: { crons?: string[] };
  env?: Record<string, { triggers?: { crons?: string[] } }>;
}

describe("the crons in wrangler.jsonc", () => {
  const config = readJsonc(pkg("wrangler.jsonc")) as Wrangler;
  const top = config.triggers?.crons;
  // an environment inherits the top level's triggers unless it names its own
  const perEnv = Object.entries(config.env ?? {}).map(([name, e]) => [name, e.triggers?.crons ?? top] as const);

  it("are the handler's dispatch table at the top level", () => {
    expect(top).toEqual(Object.values(CRONS));
  });

  it("are the dispatch table in every environment, and there are both environments", () => {
    expect(perEnv.map(([name]) => name).sort()).toEqual(["production", "test"]);
    for (const [, crons] of perEnv) expect(crons).toEqual(Object.values(CRONS));
  });

  it("are at most five, Workers Free's limit per account", () => {
    expect(top!.length).toBeLessThanOrEqual(5);
    for (const [, crons] of perEnv) expect(crons!.length).toBeLessThanOrEqual(5);
  });
});

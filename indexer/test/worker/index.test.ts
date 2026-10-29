import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CRONS } from "../../src/crons.ts";
import worker from "../../src/index.ts";

describe("the Worker's two handlers", () => {
  it("answers a path it doesn't serve with 404", async () => {
    const res = await exports.default.fetch("https://x/nope");
    expect(res.status).toBe(404);
    await res.text();
  });

  it("runs the minute's tick without throwing", async () => {
    const ctx = createExecutionContext();
    await expect(worker.scheduled(createScheduledController({ cron: CRONS.tick }), env, ctx)).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });
});

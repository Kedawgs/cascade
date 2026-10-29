import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { holdStatements } from "../../src/hold.ts";
import { loadTickState } from "../../src/store.ts";
import { wipe } from "./d1-count.ts";

const db = env.DB;
const hold = { id: "bridge.batch:42:0xabc", rule: "bridge.batch_mismatch" as const, summary: "batch 42's delivery failed the cross-check" };

beforeEach(async () => {
  await wipe(db);
});

describe("holdStatements", () => {
  it("raises one hold with an opaque public id, and not again for the same finding next tick", async () => {
    let s = await loadTickState(db, 100);
    await db.batch(holdStatements(db, [hold, hold], s.holdIds, 100));
    s = await loadTickState(db, 160);
    expect(s.activeHolds.map((x) => [x.id, x.raisedAt])).toEqual([[hold.id, 100]]);
    expect(s.activeHolds[0].publicId).toMatch(/^h_[0-9a-f]{8}$/);
    expect(holdStatements(db, [hold], s.holdIds, 160)).toEqual([]);
  });

  it("never raises a cleared id again", async () => {
    await db.batch(holdStatements(db, [hold], [], 100));
    await db.prepare("UPDATE holds SET cleared_at = 150, cleared_note = 'checked' WHERE id = ?1").bind(hold.id).run();
    const s = await loadTickState(db, 200);
    expect(s.activeHolds).toEqual([]);
    expect(holdStatements(db, [hold], s.holdIds, 200)).toEqual([]);
  });
});

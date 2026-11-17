import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RAIL_RESIDUAL } from "../src/v32/rails.ts";

// Section 5's residual, as ops quotes it (v32/rails.ts RAIL_RESIDUAL: the one-sided lines, the sign page's and verify's
// warnings), held to the spec's own words (T47b review M3, at the merge of v3.2-ops: the spec's paragraph came with
// v3.2's 26b366e, its payout half with cc0f1ff). The spec is never changed to match: ops follows it.

const SPEC = new URL("../../docs/superpowers/specs/2026-10-31-cascade-v3.2-design.md", import.meta.url);
const TITLE = "**The rail between the chains (a residual; Task 39b, I-28).**";

/** Text as a reader sees it: no Markdown code marks, one space between words. */
const plain = (t: string) => t.replace(/`/g, "").replace(/\s+/g, " ").trim();
/** A paragraph's sentences: each ends at a full stop followed by a capital letter. */
const sentences = (t: string) => plain(t).split(/(?<=\.) (?=[A-Z])/);

/** The spec's residual paragraph, after its title, in plain words. */
function specResidual(): string {
  const spec = readFileSync(SPEC, "utf8");
  const at = spec.indexOf(TITLE);
  expect(at, "the spec's residual paragraph").toBeGreaterThan(-1);
  expect(spec.indexOf(TITLE, at + 1), "one residual paragraph").toBe(-1);
  const end = spec.indexOf("\n\n", at);
  return plain(spec.slice(at + TITLE.length, end < 0 ? undefined : end));
}

describe("RAIL_RESIDUAL: section 5's residual in the spec's own words", () => {
  it("each of its sentences is a sentence of the spec's residual paragraph, word for word", () => {
    const spec = sentences(specResidual());
    const ours = RAIL_RESIDUAL.flatMap(sentences);
    expect(ours.length).toBeGreaterThan(0);
    for (const s of ours) expect(spec, s).toContain(s);
  });

  it("it carries both halves: the batches' (Base exits stop) and the payouts' (the front door refuses them, the Base adapter doesn't park)", () => {
    const spec = sentences(specResidual());
    const ours = RAIL_RESIDUAL.flatMap(sentences);
    // every sentence of the spec's paragraph that says what happens to a batch or a payout is quoted: the batch half,
    // the payout half, and the payout half's qualification (a new primary the front door has never activated; Task
    // 39b's re-review, Minor 2)
    const consequences = spec.filter((s) => /\bBase exits stop\b|\bpayouts?\b/.test(s));
    expect(consequences).toHaveLength(3);
    for (const s of consequences) expect(ours, s).toContain(s);
  });

  it('the check is word for word: with "stop" changed to "pause" in our sentences, one of them is no longer found in the spec', () => {
    const spec = sentences(specResidual());
    const changed = RAIL_RESIDUAL.flatMap(sentences).map((s) => s.replace("stop", "pause"));
    expect(changed.some((s) => !spec.includes(s))).toBe(true);
  });
});

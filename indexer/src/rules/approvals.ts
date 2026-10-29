import { utc } from "./context.ts";
import type { Rule } from "./index.ts";

/** checks.owner_approved (critical, event): each delivery check the owner approved with `pnpm checks:approve`
 * since the last tick saw (meta.approvals_seen, moved forward here), so an approval nobody expected is
 * noticed: a hand approval lets the keeper pay that batch. */
export const ownerApproved: Rule = {
  name: "checks.owner_approved",
  run(ctx) {
    if (ctx.approvals.length === 0) return [];
    const latest = Math.max(...ctx.approvals.map((r) => r.approvedAt ?? 0));
    ctx.writes.meta.push({ k: "approvals_seen", v: String(latest) });
    return ctx.approvals.map((r) => ({
      rule: "checks.owner_approved" as const,
      key: `checks.owner_approved:${r.deliveredKey}:${r.approvedAt}`,
      subject: `Batch ${r.batchId}'s delivery check was approved by hand`,
      facts: {
        key: r.deliveredKey,
        batch: String(r.batchId),
        note: r.approvedNote ?? "",
        at: r.approvedAt === null ? "unknown" : utc(r.approvedAt),
        "expected key": r.expectedKey ?? "(not rebuilt)",
        "the check said": r.detail ?? "-",
      },
    }));
  },
};

export const APPROVAL_RULES: Rule[] = [ownerApproved];

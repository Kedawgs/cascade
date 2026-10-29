import type { Finding } from "../alerts.ts";
import type { RuleCtx } from "./context.ts";

/** A rule: reads the context, returns what it found. `name` says which one failed when it throws. */
export interface Rule {
  name: string;
  run(ctx: RuleCtx): Finding[];
}

/** Runs every rule; one that throws never stops the others. Its writes are dropped (it may have pushed a
 * row before failing, e.g. a mismatch without its alert), and it becomes a finding: the critical
 * `monitor.bridge_rule_failed` for a bridge cross-check rule, whose deliveries then stay waiting and
 * unchecked, and the `monitor.rule_failed` warning (a bug to fix) for any other. */
export function runRules(rules: readonly Rule[], ctx: RuleCtx): Finding[] {
  const out: Finding[] = [];
  const w = ctx.writes;
  for (const r of rules) {
    const sizes = { batchChecks: w.batchChecks.length, chunkChecks: w.chunkChecks.length, nonces: w.nonces.length, meta: w.meta.length };
    try {
      out.push(...r.run(ctx));
    } catch (e) {
      w.batchChecks.length = sizes.batchChecks;
      w.chunkChecks.length = sizes.chunkChecks;
      w.nonces.length = sizes.nonces;
      w.meta.length = sizes.meta;
      const error = e instanceof Error ? e.message : String(e);
      const facts = { rule: r.name, error };
      if (r.name.startsWith("bridge.")) {
        out.push({ rule: "monitor.bridge_rule_failed", key: `monitor.bridge_rule_failed:${r.name}`, subject: `The bridge rule ${r.name} failed`, facts });
      } else {
        out.push({ rule: "monitor.rule_failed", key: `monitor.rule_failed:${r.name}`, subject: `The rule ${r.name} failed`, facts });
      }
    }
  }
  return out;
}

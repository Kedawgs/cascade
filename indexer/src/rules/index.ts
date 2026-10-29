import type { Finding } from "../alerts.ts";
import type { RuleCtx } from "./context.ts";

/** A rule: reads the context, returns what it found. `name` says which one failed when it throws. */
export interface Rule {
  name: string;
  run(ctx: RuleCtx): Finding[];
}

/** Runs every rule; one that throws becomes a `monitor.rule_failed` finding (a bug to fix) and never
 * stops the others. */
export function runRules(rules: readonly Rule[], ctx: RuleCtx): Finding[] {
  const out: Finding[] = [];
  for (const r of rules) {
    try {
      out.push(...r.run(ctx));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out.push({ rule: "monitor.rule_failed", key: `monitor.rule_failed:${r.name}`, subject: `The rule ${r.name} failed`, facts: { rule: r.name, error } });
    }
  }
  return out;
}

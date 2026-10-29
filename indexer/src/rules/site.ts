import type { Finding } from "../alerts.ts";
import type { SiteResult } from "../site-job.ts";
import { utc } from "./context.ts";
import type { Rule } from "./index.ts";

// Spec 6.6: the tick turns the site job's last result (meta.site_result) into alerts.

const json = <T>(s: string | undefined): T | undefined => {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};

/** site.integrity (critical): in the last pass, an address or host not approved, a configured Cascade
 * address missing (a complete pass only), or a file it couldn't check: over the byte cap, or one that
 * stopped a site-check invocation. One alert per thing found, for as long as passes keep finding it. */
export const siteIntegrity: Rule = {
  name: "site.integrity",
  run(ctx) {
    const r = json<SiteResult>(ctx.meta.site_result);
    if (!r) return [];
    const pass = utc(r.finishedAt);
    const out: Finding[] = [];
    for (const u of r.unapproved) {
      out.push({
        rule: "site.integrity",
        key: `site.integrity:${u.kind}:${u.value}`,
        subject: `The live site holds ${u.kind === "address" ? "an address" : "a host"} not on the approved list`,
        facts: { [u.kind]: u.value, file: u.file, pass },
      });
    }
    for (const a of r.missing) {
      out.push({ rule: "site.integrity", key: `site.integrity:missing:${a}`, subject: "A Cascade address is missing from the live site", facts: { address: a, pass } });
    }
    for (const p of r.problems) {
      if (p.kind === "unreadable") continue;
      out.push({
        rule: "site.integrity",
        key: `site.integrity:file:${p.file}`,
        subject: "The site check couldn't check a file of the live site",
        facts: { file: p.file, why: p.kind === "too_large" ? p.detail : `${p.detail}: on Workers Free a large legitimate chunk can do this (CPU); see the runbook`, pass },
      });
    }
    return out;
  },
};

/** site.unreachable (warning): no successful fetch of the site for siteUnreachableS. */
export const siteUnreachable: Rule = {
  name: "site.unreachable",
  run(ctx) {
    const since = ctx.meta.site_fail_since ? Number(ctx.meta.site_fail_since) : undefined;
    if (since === undefined || ctx.nowS - since < ctx.t.siteUnreachableS) return [];
    return [{ rule: "site.unreachable", key: "site.unreachable", subject: "The site check can't fetch the site", facts: { since: utc(since), site: ctx.cfg.site.url } }];
  },
};

export const SITE_RULES: Rule[] = [siteIntegrity, siteUnreachable];

/** Places the site links to. Nothing here may point at a page that does not exist. */
export const SITE_LINKS = {
  github: "https://github.com/Kedawgs/cascade",
  security: "https://github.com/Kedawgs/cascade/blob/main/SECURITY.md",
  docs: "https://github.com/Kedawgs/cascade/tree/main/docs",
} as const;

export type AuditStatus = "scheduled" | "done";

/** Flip to "done" (and link the report) only when an audit report exists. */
export const AUDIT_STATUS: AuditStatus = "scheduled";

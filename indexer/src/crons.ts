/** The Worker's four crons and what each runs: the dispatch table `scheduled` uses. A test checks these
 * against `triggers.crons` in wrangler.jsonc, for the top level and every environment. */
export const CRONS = {
  /** Every minute: scan both chains, read their state, run the rules, commit, then send email. */
  tick: "* * * * *",
  /** Every two minutes, in its own invocation: the live site's pages and scripts against the approved lists.
   * A run works on the pass under way; a new pass starts an hour after the last finished (src/site-job.ts). */
  site: "*/2 * * * *",
  /** At minute 17: hourly aggregates, pruning, and the watchdog. */
  hourly: "17 * * * *",
  /** At 13:00 UTC: the daily digest (sent once per UTC day), and the watchdog again. */
  daily: "0 13 * * *",
} as const;

export type CronJob = keyof typeof CRONS;

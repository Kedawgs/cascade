/** Cascade's history indexer and monitor. `fetch` serves read-only routes; `scheduled` runs the jobs in
 * src/crons.ts. Both are filled in by later steps; for now every path is 404 and a cron does nothing. */

async function fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
  return new Response("Not found", { status: 404 });
}

async function scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {}

export default { fetch, scheduled } satisfies ExportedHandler<Env>;

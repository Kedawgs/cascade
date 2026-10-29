import { handleScan } from "./api.ts";
import { type Config, parseConfig } from "./config.ts";

/** Cascade's history indexer and monitor. `fetch` serves read-only routes; `scheduled` runs the jobs in
 * src/crons.ts (filled in by later steps: for now a cron does nothing). */

/** The configuration, or null (with a log line only) when it can't be used: a Worker that isn't
 * configured must refuse to run, not fail loudly. */
function configOf(env: Env): Config | null {
  try {
    return parseConfig(env);
  } catch (e) {
    console.error(`not configured: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/v1/scan" || path.startsWith("/v1/scan/")) {
    const cfg = configOf(env);
    if (!cfg) return new Response("not available", { status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
    return handleScan(request, env, cfg);
  }
  return new Response("Not found", { status: 404 });
}

async function scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {}

export default { fetch, scheduled } satisfies ExportedHandler<Env>;

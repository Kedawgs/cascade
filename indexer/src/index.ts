import { handleHealth, handleScan, handleStatus } from "./api.ts";
import { type Config, parseConfig } from "./config.ts";
import { CRONS } from "./crons.ts";
import { runSiteJob } from "./site-job.ts";

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
    if (!cfg) {
      // the site still gets a readable 503 (and falls back to its own scan) when its origin is set
      const headers: Record<string, string> = { "Retry-After": "60", "Cache-Control": "no-store" };
      if (typeof env.SITE_ORIGIN === "string" && /^https:\/\/[^/]+$/.test(env.SITE_ORIGIN)) headers["Access-Control-Allow-Origin"] = env.SITE_ORIGIN;
      return new Response("not available", { status: 503, headers });
    }
    return handleScan(request, env, cfg);
  }
  const nowS = Math.floor(Date.now() / 1000);
  if (path === "/v1/status") {
    const cfg = configOf(env);
    // unconfigured: the keeper reads an outage and holds
    if (!cfg) return new Response("not available", { status: 503, headers: { "Cache-Control": "no-store" } });
    return handleStatus(request, env, cfg, nowS);
  }
  if (path === "/v1/health") {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { Allow: "GET" } });
    return handleHealth(env, nowS);
  }
  return new Response("Not found", { status: 404 });
}

async function scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
  const cfg = configOf(env);
  if (!cfg) return;
  const nowS = Math.floor(controller.scheduledTime / 1000);
  if (controller.cron === CRONS.site) {
    // its own invocation: its subrequests and CPU are its own, and it never touches the tick's lease
    const r = await runSiteJob({ db: env.DB, cfg, fetch: (input, init) => globalThis.fetch(input, init), nowS, clock: () => Math.floor(Date.now() / 1000) });
    console.log(`site check: ${JSON.stringify(r)}`);
  }
}

export default { fetch, scheduled } satisfies ExportedHandler<Env>;

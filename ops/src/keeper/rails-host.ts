import { existsSync, readFileSync } from "node:fs";
import type { Env } from "../config.ts";
import { type MonitorClient, monitorOverHttp, monitorOverride } from "./core/hold.ts";
import type { RailsEnv } from "./core/v32/rails.ts";

// The PC's half of the v3.2 keeper's rails (design-keeper-worker.md §6; Task 50a): a hand run reads ops/hold.json each
// round and the monitor at OPS_HOLD_URL (the indexer's public URL), and may carry --ignore-monitor-outage --until
// (outages only, never a hold, at most 24 hours ahead). The Worker (Task 50b) reads the monitor through its service
// binding and never carries an override. Task 50b's CLI wires these into the v3.2 hand commands.

/** ops/hold.json: a hand run's own hold, read each round ({"hold": true} holds; see core/hold.ts holdFileHold). */
export const HOLD_FILE = new URL("../../hold.json", import.meta.url);

/** The hold file's text, or undefined when there is none. */
export function holdFileText(path: URL | string = HOLD_FILE): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

/** The monitor at OPS_HOLD_URL (the indexer's base URL, or its /v1/status), or null when it is unset: the v3.2 keeper
 * takes that as an outage and sends nothing. */
export function monitorFromEnv(env: Env, o: { fetch?: typeof globalThis.fetch } = {}): MonitorClient | null {
  const v = env.OPS_HOLD_URL?.trim();
  if (!v) return null;
  if (!/^https:\/\/[^\s/]+/i.test(v)) throw new Error("OPS_HOLD_URL is not an https URL (the monitor's, e.g. https://<the indexer's host>); nothing sent");
  return monitorOverHttp(v, o);
}

/** A hand run's rails: the monitor from the env, ops/hold.json read each round, the deliveries switch the CLI gives,
 * and --ignore-monitor-outage --until when given (refused unless at most 24 hours ahead of `nowMs`). */
export function handRails(
  env: Env,
  o: { nowMs: number; deliveriesOn: boolean; ignoreMonitorOutageUntil?: string; holdPath?: URL | string; fetch?: typeof globalThis.fetch },
): RailsEnv {
  return {
    monitor: monitorFromEnv(env, { fetch: o.fetch }),
    holdFile: () => holdFileText(o.holdPath ?? HOLD_FILE),
    deliveriesOn: o.deliveriesOn,
    ...(o.ignoreMonitorOutageUntil !== undefined ? { override: monitorOverride(o.ignoreMonitorOutageUntil, o.nowMs) } : {}),
  };
}

import { redact } from "./config.ts";
import type { Budget } from "./rpc.ts";

/** A failed GET to a price API or the site. The message names the host only. */
export class HttpError extends Error {
  readonly status?: number;

  constructor(url: string, detail: string, status?: number) {
    super(`${redact(url)}: ${detail}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface HttpOptions {
  fetch: typeof fetch;
  /** one unit per request */
  budget: Budget;
  timeoutMs: number;
}

async function get(url: string, o: HttpOptions, accept: string): Promise<Response> {
  o.budget.spend();
  const signal = AbortSignal.timeout(o.timeoutMs);
  let res: Response;
  try {
    res = await o.fetch(url, { headers: { accept }, signal });
  } catch {
    throw new HttpError(url, signal.aborted ? `no answer within ${o.timeoutMs / 1000} s` : "the request failed");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpError(url, `HTTP ${res.status}`, res.status);
  }
  return res;
}

/** GET and parse JSON (the price references). */
export async function getJson(url: string, o: HttpOptions): Promise<unknown> {
  const res = await get(url, o, "application/json");
  try {
    return await res.json();
  } catch {
    throw new HttpError(url, "answered with something that isn't JSON");
  }
}

/** GET as text. */
export async function getText(url: string, o: HttpOptions): Promise<string> {
  const res = await get(url, o, "text/html, application/javascript, */*");
  try {
    return await res.text();
  } catch {
    throw new HttpError(url, "the answer couldn't be read");
  }
}

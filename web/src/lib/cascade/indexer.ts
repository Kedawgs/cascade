import type { Address } from "viem";
import type { Deployment } from "./config";
import type { StringStorage } from "./oplog";

// The history indexer's seed API (indexer/src/api.ts, spec section 4): two halves of a saved scan, in
// exactly the form the scan store saves (ScanState v1). Nothing here judges what comes back beyond its
// size: the scan store decodes it, and seed.ts verifies it against the chain before any of it is used.

/** How long a seed request may take before the scan goes on without it. */
export const SEED_TIMEOUT_MS = 5_000;
/** The most one half may weigh: years of a deployment's events fit in a fraction of this, and a bigger
 * answer is read no further (a padded seed would otherwise cost a receipt per padding event). */
export const MAX_SEED_BYTES = 2_000_000;

/** Both halves as the indexer sent them: the deployment-wide half and the account's own. */
export interface SeedHalves {
  shared: unknown;
  own: unknown;
}

/** The response's body as text, read no further than MAX_SEED_BYTES (whatever Content-Length says). */
export async function bodyWithin(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > limit) throw new Error("the seed is too big");
  if (!res.body) {
    const text = await res.text();
    if (text.length > limit) throw new Error("the seed is too big");
    return text;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    if (read > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("the seed is too big");
    }
    parts.push(value);
  }
  const all = new Uint8Array(read);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** The two seed pages for `account`, asked together with a timeout (the vault and account in lowercase,
 * no query string: the API refuses any other spelling); null when the deployment names no indexer, or
 * either request fails in any way (a timeout, a network error, any status but 200, a body that isn't
 * JSON, or one over MAX_SEED_BYTES). Never throws: the scan then reads the chain itself, as it did
 * before there was an indexer. */
export async function fetchSeed(d: Deployment, account: Address, o: { fetch?: typeof globalThis.fetch; timeoutMs?: number; maxBytes?: number } = {}): Promise<SeedHalves | null> {
  if (!d.indexerUrl) return null;
  const f = o.fetch ?? globalThis.fetch;
  const timeoutMs = o.timeoutMs ?? SEED_TIMEOUT_MS;
  const maxBytes = o.maxBytes ?? MAX_SEED_BYTES;
  const base = `${d.indexerUrl}/v1/scan/${d.vault.toLowerCase()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const get = async (url: string): Promise<unknown> => {
    const res = await f(url, { method: "GET", mode: "cors", credentials: "omit", signal: controller.signal });
    if (res.status !== 200) throw new Error(`the indexer answered ${res.status}`);
    return JSON.parse(await bodyWithin(res, maxBytes)) as unknown;
  };
  try {
    const [shared, own] = await Promise.all([get(base), get(`${base}/${account.toLowerCase()}`)]);
    return { shared, own };
  } catch {
    // one half failing makes the other useless: abort it too
    controller.abort();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** How long a browser that caught the indexer out leaves it alone. */
export const DISTRUST_MS = 24 * 60 * 60_000;

const distrustKey = (d: Deployment) => `cascade.indexer.distrust.${d.frontDoor.toLowerCase()}.${d.bitBlock}`;

/** Whether this browser decided, within the last DISTRUST_MS, that the indexer's seed for this
 * deployment contradicted the chain. Storage that is blocked, or holds something that isn't a time (or
 * one no distrust could have set, after a clock change), means no distrust. */
export function indexerDistrusted(storage: StringStorage, d: Deployment, now: number): boolean {
  try {
    const raw = storage.getItem(distrustKey(d));
    if (raw === null || !/^\d{1,16}$/.test(raw)) return false;
    const until = Number(raw);
    return now < until && until - now <= DISTRUST_MS;
  } catch {
    return false;
  }
}

/** Remembers that the indexer's seed for this deployment contradicted the chain: no seed is asked for
 * again in this browser for DISTRUST_MS. Never throws (storage may be blocked). */
export function distrustIndexer(storage: StringStorage, d: Deployment, now: number): void {
  try {
    storage.setItem(distrustKey(d), String(now + DISTRUST_MS));
  } catch {
    // blocked: live.ts keeps the decision for this visit in memory
  }
}

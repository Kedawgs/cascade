// What the site check reads in the live site's files (spec 6.6): the 0x-addresses, the https hosts and the
// lazily loaded chunks they name; and how a file is read, as a stream capped at a byte limit.

/** A 40-hex address with hex boundaries, so a 64-hex hash never matches. */
export const ADDRESS_RE = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
/** The host of an https URL. */
export const HOST_RE = /https:\/\/([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?=[/:"'`\s)?#]|$)/g;
/** A Next.js chunk path. */
export const CHUNK_RE = /\/_next\/static\/chunks\/[A-Za-z0-9_./-]+?\.js(?![A-Za-z0-9_])/g;

export interface ScanResult {
  addresses: string[];
  hosts: string[];
  chunks: string[];
}

const uniq = (xs: Iterable<string>) => [...new Set(xs)].sort();

/** The addresses, hosts and chunk paths in a script, lowercased (paths as they are), deduplicated, sorted. */
export function scanScript(text: string): ScanResult {
  return {
    addresses: uniq([...text.matchAll(ADDRESS_RE)].map((m) => m[0].toLowerCase())),
    hosts: uniq([...text.matchAll(HOST_RE)].map((m) => m[1].toLowerCase())),
    chunks: uniq([...text.matchAll(CHUNK_RE)].map((m) => m[0])),
  };
}

/** A page's inline scripts, and its `<script src>` paths under /_next/static/. */
export function pageScripts(html: string): { inline: string[]; srcs: string[] } {
  const inline: string[] = [];
  const srcs: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1];
    if (src) {
      const path = src.startsWith("http") ? safePath(src) : src;
      if (path?.startsWith("/_next/static/")) srcs.push(path);
    } else if (m[2].trim()) inline.push(m[2]);
  }
  return { inline, srcs: [...new Set(srcs)] };
}

const safePath = (u: string) => {
  try {
    return new URL(u).pathname;
  } catch {
    return undefined;
  }
};

/** The body as text, read as a stream and cancelled once past `maxBytes` (never buffering more). */
export async function readCapped(res: Response, maxBytes: number): Promise<{ text: string } | { tooLarge: true }> {
  if (!res.body) return { text: "" };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return { text: new TextDecoder().decode(all) };
}

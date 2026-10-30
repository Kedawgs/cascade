import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ORACLE_POOLS } from "./cardinality.ts";
import type { DeploymentRecord } from "./record.ts";
import { renderPage } from "./sign-page.ts";
import { checkCalls, describeCalls, type KnownContract, type KnownFunction, parseWalletFile, type WalletView } from "./wallet.ts";

const OWNED: readonly KnownFunction[] = ["acceptOwnership", "transferOwnership"];
const PAUSABLE: readonly KnownFunction[] = [...OWNED, "pause", "unpause"];

/** The contracts the signing page may call, and what it may call on each: the oracle's two pools on
 * Base (anyone may grow them), and, from the live deployment's record, the front door and the staker on
 * Base and the vault on Bittensor. */
export function knownContracts(rec: DeploymentRecord | null): KnownContract[] {
  const pools = ORACLE_POOLS.map((p): KnownContract => ({ chainId: 8453, address: p.address, name: p.name, functions: ["increaseObservationCardinalityNext"] }));
  if (!rec) return pools;
  const a = rec.plan.addresses as DeploymentRecord["plan"]["addresses"] & { staker?: `0x${string}` };
  return [
    ...pools,
    { chainId: 8453, address: a.frontDoor, name: "Front door", functions: PAUSABLE },
    ...(a.staker ? [{ chainId: 8453, address: a.staker, name: "Staker", functions: OWNED }] : []),
    { chainId: 964, address: a.vault, name: "Vault", functions: PAUSABLE },
  ];
}

/** `pnpm ops sign <file>`, up to serving: the call file read and checked (parseWalletFile), each call
 * against the contracts of the deployment it names, from that deployment's live record (`recordOf`), then
 * the page and the terminal's description of the same calls. Reads no chain. */
export function prepareSign(path: string, recordOf: (deployment: string) => DeploymentRecord | null): { view: WalletView; page: { html: string; csp: string }; lines: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`can't read ${path} as a call file: ${(e as Error).message}`);
  }
  const file = parseWalletFile(raw);
  const rec = file.deployment ? recordOf(file.deployment) : null;
  if (file.deployment && !rec) {
    throw new Error(`the call file is for deployment ${file.deployment}, but there's no live record for it (deployments/${file.deployment}.json): refusing to show calls to contracts it can't name`);
  }
  const view = checkCalls(file, knownContracts(rec));
  return { view, page: renderPage(view), lines: describeCalls(view) };
}

/** The one address the server listens on: this computer only. */
export const LOOPBACK = "127.0.0.1";

export interface PageServer {
  url: string;
  /** What the server is bound to (always LOOPBACK). */
  address: string;
  port: number;
  close(): Promise<void>;
}

/** Serves `page` at http://127.0.0.1:<a port the system picks>/ and nothing else: GET or HEAD of / only,
 * and only under that exact host name (a page that reached it by another name, DNS rebinding included,
 * gets a 403). The page goes out with its CSP and headers that keep it out of caches and frames. */
export async function servePage(page: { html: string; csp: string }): Promise<PageServer> {
  let host = "";
  const server = createServer((req, res) => {
    const reply = (status: number, headers: Record<string, string> = {}, body?: string) => {
      res.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
      res.end(body);
    };
    if (req.headers.host !== host) return reply(403, { "Content-Type": "text/plain; charset=utf-8" }, `This page is served only as http://${host}/\n`);
    if (req.method !== "GET" && req.method !== "HEAD") return reply(405, { Allow: "GET, HEAD" });
    if (req.url !== "/") return reply(404);
    reply(
      200,
      { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": page.csp, "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" },
      req.method === "HEAD" ? undefined : page.html,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: LOOPBACK, port: 0, exclusive: true }, () => resolve());
  });
  const a = server.address() as AddressInfo;
  host = `${LOOPBACK}:${a.port}`;
  return {
    url: `http://${host}/`,
    address: a.address,
    port: a.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

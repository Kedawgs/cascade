import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChainName } from "./config.ts";
import { ORACLE_POOLS } from "./cardinality.ts";
import { isPlanV3, rolesOf } from "./plan.ts";
import type { DeploymentRecord } from "./record.ts";
import { chainLabel } from "./send.ts";
import { renderPage } from "./sign-page.ts";
import { checkCalls, describeCalls, type KnownCall, type KnownContract, parseWalletFile, type WalletView } from "./wallet.ts";

const CHAIN_ID: Record<ChainName, number> = { base: 8453, bittensor: 964 };

/** The contracts the signing page may call, the calls it may make to each, who may send each (the
 * record's roles), and what each does:
 * - the oracle's two pools on Base: increaseObservationCardinalityNext, from anyone;
 * - from the live deployment's record, the front door and the staker on Base and the vault on Bittensor:
 *   acceptOwnership from the chain's owner (the pending owner the deployer offered it to); on the front
 *   door and the vault also pause, from the guardian or the owner (onlyOwnerOrGuardian), and unpause,
 *   from the owner (onlyOwner).
 * A v2 record has no owner or guardian roles, so it is refused. */
export function knownContracts(rec: DeploymentRecord | null): KnownContract[] {
  const pools = ORACLE_POOLS.map(
    (p): KnownContract => ({
      chainId: 8453,
      address: p.address,
      name: p.name,
      calls: {
        increaseObservationCardinalityNext: {
          senders: "anyone",
          effect: (_from, fn) => `pays gas to let the price pool remember more history (room for ${fn.args[0]?.value} observations); changes no money`,
        },
      },
    }),
  );
  if (!rec) return pools;
  const plan = rec.plan;
  if (!isPlanV3(plan)) throw new Error("the deployment record is a v2 plan, which has no owner or guardian roles: the signing page is for v3 deployments");
  const roles = rolesOf(plan);
  const a = plan.addresses;
  const contract = (chain: ChainName, address: `0x${string}`, name: string, paused?: string): KnownContract => {
    const where = chainLabel(chain);
    const owner = { address: roles.owner[chain], role: `the owner on ${where}` };
    const guardian = { address: roles.guardian[chain], role: `the guardian on ${where}` };
    const accept: KnownCall = { senders: [owner], effect: (from) => `makes ${from} the owner of the ${name} on ${where}` };
    return {
      chainId: CHAIN_ID[chain],
      address,
      name,
      calls: paused
        ? {
            acceptOwnership: accept,
            pause: { senders: [guardian, owner], effect: () => paused },
            unpause: { senders: [owner], effect: () => `lets the ${name} on ${where} run again (undoes pause())` },
          }
        : { acceptOwnership: accept },
    };
  };
  return [
    ...pools,
    contract("base", a.frontDoor, "Front door", "stops deposits, redeem requests, batch closes and USDC deliveries on the Front door until the owner unpauses (claims stay open)"),
    contract("base", a.staker, "Staker"),
    contract("bittensor", a.vault, "Vault", "stops staking, direct deposits and redeems, incoming batches and payouts on the Vault until the owner unpauses"),
  ];
}

/** `pnpm ops sign <file>`, up to serving: the call file read and checked (parseWalletFile); its
 * deployment must be this run's (`deployment`: OPS_DEPLOYMENT, or sign's --deployment), and each call is
 * checked against that deployment's live record (`recordOf`) and the oracle's pools (checkCalls). Then the
 * page and the terminal's description of the same calls, with a warning for a file over a day old at
 * `now`. Reads no chain. */
export function prepareSign(
  path: string,
  o: { deployment: string; recordOf: (deployment: string) => DeploymentRecord | null; now: number },
): { view: WalletView; page: { html: string; csp: string }; lines: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`can't read ${path} as a call file: ${(e as Error).message}`);
  }
  const file = parseWalletFile(raw);
  if (file.deployment && file.deployment !== o.deployment) {
    throw new Error(
      `this file is for deployment ${file.deployment}, but this run's deployment is ${o.deployment} (OPS_DEPLOYMENT, or --deployment): run it with OPS_DEPLOYMENT=${file.deployment} or --deployment ${file.deployment}`,
    );
  }
  const rec = file.deployment ? o.recordOf(file.deployment) : null;
  if (file.deployment && !rec) {
    throw new Error(`the call file is for deployment ${file.deployment}, but there's no live record for it (deployments/${file.deployment}.json): refusing to show calls to contracts it can't name`);
  }
  const view = checkCalls(file, knownContracts(rec), o.now);
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
      {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": page.csp,
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Cross-Origin-Opener-Policy": "same-origin",
      },
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

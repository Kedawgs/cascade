import {
  type Abi,
  type Address,
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  encodeAbiParameters,
  type Hex,
  keccak256,
  type PublicClient,
} from "viem";
import { ADAPTER, FRONT_DOOR, STAKER, VAULT } from "./abi";
import type { Clients } from "./chain";
import { type Deployment, isV3, knownDeployment, TOKENS } from "./config";

const BASE_ID = 8453n;
const BITTENSOR_ID = 964n;

/** Whether the contracts are wired to each other as the build's config says. */
export type Wiring = "ok" | "mismatch";

/** How the vault keys a front door in its registry (CascadeVault.peerId): keccak256(abi.encode(chain, address)). */
export const peerId = (chain: bigint, addr: Address): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [chain, addr]));

/** One read and what it must answer. */
interface Link {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  want: Address | bigint | boolean;
}

const link = (address: Address, abi: Abi, functionName: string, want: Link["want"], args?: readonly unknown[]): Link => ({
  address,
  abi,
  functionName,
  want,
  ...(args ? { args } : {}),
});

/** What each contract must say about the others. On Base: the front door holds TAO for this vault on
 * Bittensor and sends through this Base adapter, which pairs with this Bittensor adapter; on v3 the
 * staker deposits into this front door, which sells deliveries through it and prices them by this
 * oracle. On Bittensor: the vault takes batches from this front door and sends through this adapter,
 * which pairs back with the Base one. */
function links(d: Deployment): { base: Link[]; bittensor: Link[] } {
  const base = [
    link(d.frontDoor, FRONT_DOOR, "asset", TOKENS.tao),
    link(d.frontDoor, FRONT_DOOR, "vault", d.vault),
    link(d.frontDoor, FRONT_DOOR, "vaultChain", BITTENSOR_ID),
    link(d.frontDoor, FRONT_DOOR, "primaryBridge", d.baseAdapter),
    link(d.frontDoor, FRONT_DOOR, "bridgeEnabled", true, [d.baseAdapter]),
    link(d.baseAdapter, ADAPTER, "token", TOKENS.tao),
    link(d.baseAdapter, ADAPTER, "remoteAdapter", d.bitAdapter),
    link(d.baseAdapter, ADAPTER, "remoteChainId", BITTENSOR_ID),
  ];
  if (isV3(d)) {
    const staker = d.staker as Address;
    base.push(
      link(d.frontDoor, FRONT_DOOR, "usdc", TOKENS.usdc),
      link(d.frontDoor, FRONT_DOOR, "oracle", d.oracle as Address),
      link(d.frontDoor, FRONT_DOOR, "swapper", staker),
      link(staker, STAKER, "frontDoor", d.frontDoor),
      link(staker, STAKER, "usdc", TOKENS.usdc),
      link(staker, STAKER, "tao", TOKENS.tao),
    );
  }
  const bittensor = [
    link(d.vault, VAULT, "frontDoorActive", true, [peerId(BASE_ID, d.frontDoor)]),
    link(d.vault, VAULT, "primaryBridge", d.bitAdapter),
    link(d.vault, VAULT, "bridgeEnabled", true, [d.bitAdapter]),
    link(d.bitAdapter, ADAPTER, "remoteAdapter", d.baseAdapter),
    link(d.bitAdapter, ADAPTER, "remoteChainId", BASE_ID),
  ];
  return { base, bittensor };
}

const answers = (got: unknown, want: Link["want"]) =>
  typeof want === "string" ? typeof got === "string" && got.toLowerCase() === want.toLowerCase() : got === want;

/** Whether a failed read is the contract's own answer: it reverted, or nothing answered (no code at the
 * address, empty data). Anything else (the node not reached, a rate limit, a timeout, an RPC error, or
 * the multicall itself failing, whatever error the node gave it) says only that the chain can't be
 * read right now. viem's multicall with allowFailure reports both kinds per call and never throws. */
export function contractRefused(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  if (e instanceof ContractFunctionExecutionError && e.functionName === "aggregate3") return false;
  return e.walk((x) => x instanceof ContractFunctionRevertedError || x instanceof ContractFunctionZeroDataError) !== null;
}

/** One multicall of a chain's links: true when every one answers as it must. A read the contract
 * refused (contractRefused) is a mismatch; any other failed read throws, so the check is "can't check
 * right now" and is asked again, never a mismatch kept for the page's life. */
async function holds(client: Pick<PublicClient, "multicall">, ls: Link[]): Promise<boolean> {
  const contracts = ls.map((l) => ({ address: l.address, abi: l.abi, functionName: l.functionName, ...(l.args ? { args: l.args } : {}) }));
  const results = (await client.multicall({ contracts, allowFailure: true } as never)) as { status: "success" | "failure"; result?: unknown; error?: unknown }[];
  let ok = true;
  ls.forEach((l, i) => {
    const r = results[i];
    if (r?.status === "success") {
      if (!answers(r.result, l.want)) ok = false;
    } else if (r && contractRefused(r.error)) ok = false;
    else throw r?.error ?? new Error(`no answer for ${l.functionName}`);
  });
  return ok;
}

/** Reads the contracts and checks they are wired to each other as the build's config says, after
 * checking the config is one of the committed deployments (no read for one that isn't). Throws when
 * either chain can't be read: the caller must then send nothing ("can't check right now"). */
export async function checkWiring(c: Pick<Clients, "base" | "bittensor">, d: Deployment): Promise<Wiring> {
  if (!knownDeployment(d)) return "mismatch";
  const { base, bittensor } = links(d);
  const [onBase, onBittensor] = await Promise.all([holds(c.base, base), holds(c.bittensor, bittensor)]);
  return onBase && onBittensor ? "ok" : "mismatch";
}

/** Where a pass is remembered for the rest of the browser session. */
export interface SessionCache {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** The tab's sessionStorage (cleared with the tab), or nothing where there is none. */
export function sessionCache(): SessionCache {
  const store = () => (typeof window !== "undefined" ? window.sessionStorage : undefined);
  return {
    get: (k) => store()?.getItem(k) ?? null,
    set: (k, v) => store()?.setItem(k, v),
  };
}

/** The wiring check, once per session: a pass is kept for the tab's session (so a reload asks nothing
 * again), a mismatch for the page's life; a read that failed is kept by neither, so the next call reads
 * again. Calls while a check runs share it. */
export function createWiringCheck(
  c: Pick<Clients, "base" | "bittensor">,
  d: Deployment,
  check: (c: Pick<Clients, "base" | "bittensor">, d: Deployment) => Promise<Wiring> = checkWiring,
  session: SessionCache = sessionCache(),
): () => Promise<Wiring> {
  const key = `cascade:wiring:${[d.frontDoor, d.baseAdapter, d.vault, d.bitAdapter, d.staker ?? "", d.oracle ?? ""].join(":").toLowerCase()}`;
  let known: Promise<Wiring> | undefined;
  const passed = () => {
    try {
      return session.get(key) === "ok";
    } catch {
      return false;
    }
  };
  return () => {
    if (known) return known;
    if (passed()) return (known = Promise.resolve("ok"));
    known = check(c, d).then(
      (w) => {
        if (w === "ok") {
          try {
            session.set(key, "ok");
          } catch {
            // storage blocked: kept for this page only
          }
        }
        return w;
      },
      (e: unknown) => {
        known = undefined;
        throw e;
      },
    );
    return known;
  };
}

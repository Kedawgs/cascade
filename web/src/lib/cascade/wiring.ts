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
  toHex,
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

/** How long a check's answer is kept before the chain is read again. */
export const WIRING_TTL_MS = 15 * 60_000;

/** Where a pass is kept across reloads of the tab. */
export interface SessionCache {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** The tab's sessionStorage (cleared with the tab), or nothing where there is none. */
export function sessionCache(): SessionCache {
  const store = () => (typeof window !== "undefined" ? window.sessionStorage : undefined);
  return {
    get: (k) => store()?.getItem(k) ?? null,
    set: (k, v) => store()?.setItem(k, v),
    remove: (k) => store()?.removeItem(k),
  };
}

/** Every read of the check as its pass is keyed: the chain it is made on, the contract, the function, its
 * arguments and the answer it must give (the v2 deployment has the same addresses on both chains, so
 * without the chain a read on one could pass for a read on the other). */
export function wiringReads(d: Deployment): [chain: "base" | "bittensor", address: string, functionName: string, args: string[], want: string][] {
  const { base, bittensor } = links(d);
  const read = (chain: "base" | "bittensor") => (l: Link): [typeof chain, string, string, string[], string] => [
    chain,
    l.address.toLowerCase(),
    l.functionName,
    (l.args ?? []).map(String),
    String(l.want).toLowerCase(),
  ];
  return [...base.map(read("base")), ...bittensor.map(read("bittensor"))];
}

/** Where a pass of this deployment's check is kept: by a hash of every read and the answer it must
 * give (wiringReads), so a pass of another deployment, or of a check since changed, is never taken for
 * this one's. */
export function wiringKey(d: Deployment): string {
  return `cascade:wiring:${keccak256(toHex(JSON.stringify(wiringReads(d))))}`;
}

/** The wiring check, as the site asks it: an answer (pass or mismatch) is kept for WIRING_TTL_MS, a pass
 * also in the tab's session storage, dated, so a reload within it asks nothing again; a read that failed
 * is kept by neither, so the next call reads again. Calls while a check runs share it. `forget()` (after
 * each flow) makes the next call read the chain again; a check it came during is not kept. */
export interface WiringCheck {
  (): Promise<Wiring>;
  forget(): void;
}

export function createWiringCheck(
  c: Pick<Clients, "base" | "bittensor">,
  d: Deployment,
  check: (c: Pick<Clients, "base" | "bittensor">, d: Deployment) => Promise<Wiring> = checkWiring,
  session: SessionCache = sessionCache(),
  now: () => number = Date.now,
  ttlMs: number = WIRING_TTL_MS,
): WiringCheck {
  const key = wiringKey(d);
  /** The latest check: its answer and when it came (`at` unset while it runs). */
  let known: { at?: number; answer: Promise<Wiring> } | undefined;
  /** Bumped by forget(): a check started before it is not kept. */
  let generation = 0;
  const fresh = (at: number) => now() >= at && now() - at < ttlMs;
  const storedPass = (): number | undefined => {
    try {
      const at = Number((JSON.parse(session.get(key) ?? "null") as { okAt?: unknown } | null)?.okAt);
      return Number.isFinite(at) ? at : undefined;
    } catch {
      return undefined;
    }
  };
  const run = (): Promise<Wiring> => {
    const started = generation;
    const answer = check(c, d).then(
      (w) => {
        if (started !== generation) return w;
        const at = now();
        known = { at, answer };
        if (w === "ok") {
          try {
            session.set(key, JSON.stringify({ okAt: at }));
          } catch {
            // storage blocked: kept for this page only
          }
        }
        return w;
      },
      (e: unknown) => {
        if (started === generation && known?.answer === answer) known = undefined;
        throw e;
      },
    );
    known = { answer };
    return answer;
  };
  const wired = (() => {
    if (known && (known.at === undefined || fresh(known.at))) return known.answer;
    const at = storedPass();
    if (at !== undefined && fresh(at)) {
      known = { at, answer: Promise.resolve("ok" as const) };
      return known.answer;
    }
    return run();
  }) as WiringCheck;
  wired.forget = () => {
    generation++;
    known = undefined;
    try {
      session.remove(key);
    } catch {
      // storage blocked: nothing kept there
    }
  };
  return wired;
}

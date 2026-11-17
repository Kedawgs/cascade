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
import { ADAPTER, DOOR_LENS, FRONT_DOOR, FRONT_DOOR_V32, STAKER, VAULT, VAULT_LENS } from "./abi";
import type { Clients } from "./chain";
import { type Deployment, EXPECTED_DEPLOYMENTS, type ExpectedDeployment, isV3, isV32, knownDeployment, TOKENS } from "./config";

const BASE_ID = 8453n;
const BITTENSOR_ID = 964n;

/** Whether the contracts are wired to each other as the build's config says. */
export type Wiring = "ok" | "mismatch";

/** v3.2's registry state of an active front door (CascadeTypes.DoorState: 0 unknown, 1 active, 2 removed). */
const DOOR_ACTIVE = 1;

/** How the vault keys a front door in its registry (CascadeVault.peerId): keccak256(abi.encode(chain, address)). */
export const peerId = (chain: bigint, addr: Address): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }], [chain, addr]));

/** One read and what it must answer. */
interface Link {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  want: Address | bigint | boolean | number;
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
  if (isV32(d)) return linksV32(d);
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

/** The same on v3.2, where the bridges and the vault's registry are read through the lenses (spec §8.1): each
 * lens must read the contract the deployment names (`target`), the front door must be Active in the vault's
 * registry (`doorState(peer) == Active`, in place of v3-launch's frontDoorActive), and the bridges are the lenses'
 * `primaryBridge` and `bridgeEnabled`. The rest is v3-launch's, asked of the same contracts. */
function linksV32(d: Deployment): { base: Link[]; bittensor: Link[] } {
  const doorLens = d.doorLens as Address;
  const vaultLens = d.vaultLens as Address;
  const staker = d.staker as Address;
  const base = [
    link(d.frontDoor, FRONT_DOOR_V32, "asset", TOKENS.tao),
    link(d.frontDoor, FRONT_DOOR_V32, "vault", d.vault),
    link(d.frontDoor, FRONT_DOOR_V32, "vaultChain", BITTENSOR_ID),
    link(doorLens, DOOR_LENS, "target", d.frontDoor),
    link(doorLens, DOOR_LENS, "primaryBridge", d.baseAdapter),
    link(doorLens, DOOR_LENS, "bridgeEnabled", true, [d.baseAdapter]),
    link(d.baseAdapter, ADAPTER, "token", TOKENS.tao),
    link(d.baseAdapter, ADAPTER, "remoteAdapter", d.bitAdapter),
    link(d.baseAdapter, ADAPTER, "remoteChainId", BITTENSOR_ID),
    link(d.frontDoor, FRONT_DOOR_V32, "usdc", TOKENS.usdc),
    link(d.frontDoor, FRONT_DOOR_V32, "oracle", d.oracle as Address),
    link(d.frontDoor, FRONT_DOOR_V32, "swapper", staker),
    link(staker, STAKER, "frontDoor", d.frontDoor),
    link(staker, STAKER, "usdc", TOKENS.usdc),
    link(staker, STAKER, "tao", TOKENS.tao),
  ];
  const bittensor = [
    link(vaultLens, VAULT_LENS, "target", d.vault),
    link(vaultLens, VAULT_LENS, "doorState", DOOR_ACTIVE, [peerId(BASE_ID, d.frontDoor)]),
    link(vaultLens, VAULT_LENS, "primaryBridge", d.bitAdapter),
    link(vaultLens, VAULT_LENS, "bridgeEnabled", true, [d.bitAdapter]),
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
 * checking the config is one of the committed deployments (`list`, deployments.json; no read for one that
 * isn't). Throws when either chain can't be read: the caller must then send nothing ("can't check right now"). */
export async function checkWiring(
  c: Pick<Clients, "base" | "bittensor">,
  d: Deployment,
  list: Readonly<Record<string, ExpectedDeployment>> = EXPECTED_DEPLOYMENTS,
): Promise<Wiring> {
  if (!knownDeployment(d, list)) return "mismatch";
  const { base, bittensor } = links(d);
  const [onBase, onBittensor] = await Promise.all([holds(c.base, base), holds(c.bittensor, bittensor)]);
  return onBase && onBittensor ? "ok" : "mismatch";
}

/** How long a check's answer is kept before the chain is read again. */
export const WIRING_TTL_MS = 15 * 60_000;

/** The wiring check, as the site asks it: an answer (pass or mismatch) is kept for WIRING_TTL_MS, in
 * this page's memory only. Nothing about it is ever written to or read from the browser's storage: a
 * pass kept there could be written there by anything else on the origin, and would then skip the chain
 * for its lifetime; a reload costs one multicall on each chain instead. A read that failed is not kept,
 * so the next call reads again. Calls while a check runs share it. `forget()` (after each flow) makes
 * the next call read the chain again; a check it came during is not kept. */
export interface WiringCheck {
  (): Promise<Wiring>;
  forget(): void;
}

export function createWiringCheck(
  c: Pick<Clients, "base" | "bittensor">,
  d: Deployment,
  check: (c: Pick<Clients, "base" | "bittensor">, d: Deployment) => Promise<Wiring> = checkWiring,
  now: () => number = Date.now,
  ttlMs: number = WIRING_TTL_MS,
): WiringCheck {
  /** The latest check: its answer and when it came (`at` unset while it runs). */
  let known: { at?: number; answer: Promise<Wiring> } | undefined;
  /** Bumped by forget(): a check started before it is not kept. */
  let generation = 0;
  const fresh = (at: number) => now() >= at && now() - at < ttlMs;
  const run = (): Promise<Wiring> => {
    const started = generation;
    const answer = check(c, d).then(
      (w) => {
        if (started === generation) known = { at: now(), answer };
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
  const wired = (() => (known && (known.at === undefined || fresh(known.at)) ? known.answer : run())) as WiringCheck;
  wired.forget = () => {
    generation++;
    known = undefined;
  };
  return wired;
}

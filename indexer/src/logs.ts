import { type AbiEvent, decodeEventLog, type Hex, hexToBigInt, hexToNumber, keccak256, toBytes, toEventSelector } from "viem";
import { abiFor } from "./abi.ts";
import type { ChainName, Role, RoleOf } from "./config.ts";

/** A log as eth_getLogs returns it. */
export interface RawLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  logIndex: Hex;
  transactionHash: Hex;
}

/** A log as it is stored: tagged with its chain and its contract's role, decoded against that role's
 * ABI. Hex is lowercase; integer arguments are decimal strings (small ones, like a chunk number, are
 * numbers). `event` is "unknown" (and `args` empty) when the role's ABI doesn't match it. */
export interface StoredLog {
  uid: Hex;
  chain: ChainName;
  contract: Role;
  address: Hex;
  block: bigint;
  logIndex: number;
  txHash: Hex;
  event: string;
  topic1?: Hex;
  topic2?: Hex;
  topic3?: Hex;
  data: Hex;
  args: Record<string, string | number | boolean>;
  /** set while a later read of its block no longer has it (a reorg) */
  removed?: boolean;
}

/** A stored log's place and content (store.storedUids loads them for the re-read range): enough for a
 * re-read to recognise it without hashing it again. */
export interface StoredRef {
  block: bigint;
  logIndex: number;
  txHash: Hex;
  contract: Role;
  event: string;
  topic1: Hex | null;
  topic2: Hex | null;
  topic3: Hex | null;
  data: Hex;
}

/** The StoredRef of a log as it is stored. */
export const storedRefOf = (l: StoredLog): StoredRef => ({
  block: l.block,
  logIndex: l.logIndex,
  txHash: l.txHash,
  contract: l.contract,
  event: l.event,
  topic1: l.topic1 ?? null,
  topic2: l.topic2 ?? null,
  topic3: l.topic3 ?? null,
  data: l.data,
});

export interface Identified {
  uid: Hex;
  raw: RawLog;
}

const byPosition = (a: RawLog, b: RawLog) => {
  const ba = hexToBigInt(a.blockNumber);
  const bb = hexToBigInt(b.blockNumber);
  return ba !== bb ? (ba < bb ? -1 : 1) : hexToNumber(a.logIndex) - hexToNumber(b.logIndex);
};

/** What a log's identity is made of, cheap to build: its transaction, topics and data, lowercase. */
export const identityOf = (raw: Pick<RawLog, "transactionHash" | "topics" | "data">): string => `${raw.transactionHash}:${raw.topics.join(",")}:${raw.data}`.toLowerCase();

/** The uid of the `n`th log in a transaction with that identity on that chain: the costly part (a hash). */
export const uidFor = (chain: ChainName, what: string, n: number): Hex => keccak256(toBytes(`${chain}:${what}#${n}`));

/** Puts logs in log order (block, then index). */
export const sortByPosition = (logs: readonly RawLog[]): RawLog[] => [...logs].sort(byPosition);

/** Each log with an id from its chain, transaction and content, numbered when one transaction logs the
 * same thing twice: the keeper's `identified()` (ops/src/keeper/state.ts) with the chain in front, so a
 * copy re-mined in another block or at another index after a reorg is the same log, and the same bytes
 * on the other chain are another. Numbered in log order, whatever order the node listed them in. */
export function identify(chain: ChainName, logs: readonly RawLog[]): Identified[] {
  const count = new Map<string, number>();
  return sortByPosition(logs).map((raw) => {
    const what = identityOf(raw);
    const n = count.get(what) ?? 0;
    count.set(what, n + 1);
    return { uid: uidFor(chain, what, n), raw };
  });
}

/** Topic 0 of a role's event, by name (undefined for "unknown" or a name the role doesn't have). */
export function topic0Of(role: Role, event: string): Hex | undefined {
  let m = topicsByName.get(role);
  if (!m) {
    m = new Map([...eventsOf(role)].map(([selector, e]) => [e.name, selector as Hex]));
    topicsByName.set(role, m);
  }
  return m.get(event);
}
const topicsByName = new Map<Role, Map<string, Hex>>();

/** The identity (identityOf) of a stored log, from its columns: topic 0 comes from its role and event
 * name (not stored). Undefined for an "unknown" log, whose topic 0 can't be known. */
export function storedIdentity(s: StoredRef): string | undefined {
  const t0 = topic0Of(s.contract, s.event);
  if (!t0) return undefined;
  const topics = [t0, s.topic1, s.topic2, s.topic3].filter((t): t is Hex => t !== null);
  return identityOf({ transactionHash: s.txHash, topics, data: s.data });
}

/** Each role's events by topic 0, worked out once. */
const selectors = new Map<Role, Map<string, AbiEvent>>();
function eventsOf(role: Role): Map<string, AbiEvent> {
  let m = selectors.get(role);
  if (!m) {
    m = new Map(abiFor(role).filter((x): x is AbiEvent => x.type === "event").map((e) => [toEventSelector(e), e]));
    selectors.set(role, m);
  }
  return m;
}

const HEX = /^0x[0-9a-fA-F]*$/;

/** viem's decoded arguments as stored: bigints as decimal strings, hex (addresses, hashes) lowercase. */
function plain(args: Record<string, unknown>): StoredLog["args"] {
  const out: StoredLog["args"] = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "bigint") out[k] = v.toString();
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = HEX.test(v) ? v.toLowerCase() : v;
    else out[k] = String(v);
  }
  return out;
}

/** The log decoded against its contract's ABI on its chain; undefined when its address isn't one of
 * the deployment's contracts there. */
export function decode(chain: ChainName, { uid, raw }: Identified, roleOf: RoleOf): StoredLog | undefined {
  const address = raw.address.toLowerCase() as Hex;
  const contract = roleOf(chain, address);
  if (!contract) return undefined;
  const topics = raw.topics.map((t) => t.toLowerCase() as Hex);
  const data = raw.data.toLowerCase() as Hex;
  let event = "unknown";
  let args: StoredLog["args"] = {};
  const abiEvent = topics[0] === undefined ? undefined : eventsOf(contract).get(topics[0]);
  if (abiEvent) {
    try {
      const d = decodeEventLog({ abi: [abiEvent], topics: topics as [Hex, ...Hex[]], data, strict: true });
      event = d.eventName;
      args = plain((d.args ?? {}) as Record<string, unknown>);
    } catch {
      // a known topic with data that doesn't fit its event: stored as unknown, and reported
    }
  }
  const log: StoredLog = {
    uid,
    chain,
    contract,
    address,
    block: hexToBigInt(raw.blockNumber),
    logIndex: hexToNumber(raw.logIndex),
    txHash: raw.transactionHash.toLowerCase() as Hex,
    event,
    data,
    args,
  };
  if (topics[1] !== undefined) log.topic1 = topics[1];
  if (topics[2] !== undefined) log.topic2 = topics[2];
  if (topics[3] !== undefined) log.topic3 = topics[3];
  return log;
}

/** The log is `event` from the contract with `role`: never match on the event name alone. */
export const is = (log: Pick<StoredLog, "contract" | "event">, role: Role, event: string): boolean => log.contract === role && log.event === event;

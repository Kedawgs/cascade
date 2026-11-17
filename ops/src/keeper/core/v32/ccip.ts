import { type Address, decodeAbiParameters, getAddress, type Hex, hexToBigInt, keccak256, padHex, size, slice } from "viem";
import { type AdapterPair, adapterPairs, type DeploymentV32, pairOfBase, pairOfBit } from "../deployment.ts";
import type { ChainName } from "../types.ts";

// CCIP 2.0's MessageV1 as the source OnRamp emits it in CCIPMessageSent (the vendored MessageV1Codec.sol, the same
// format the deployed OffRamp 2.0.0 decodes, R3 W2-2): the keeper rebuilds a park's message and a FAILURE's message from
// it, byte for byte (Task 52). Its id is keccak256 of the encoded bytes, so the bytes the keeper holds are the message
// CCIP executed (or failed), or the check refuses.

/** One token transfer of a MessageV1 (at most one). */
export interface TokenTransferV1 {
  amount: bigint;
  sourcePoolAddress: Hex;
  sourceTokenAddress: Hex;
  destTokenAddress: Hex;
  tokenReceiver: Hex;
  extraData: Hex;
}

/** A MessageV1, as MessageV1Codec._decodeMessageV1 reads it. */
export interface MessageV1 {
  sourceChainSelector: bigint;
  destChainSelector: bigint;
  messageNumber: bigint;
  executionGasLimit: number;
  ccipReceiveGasLimit: number;
  finality: Hex;
  ccvAndExecutorHash: Hex;
  onRampAddress: Hex;
  offRampAddress: Hex;
  sender: Hex;
  receiver: Hex;
  destBlob: Hex;
  tokenTransfer: TokenTransferV1[];
  data: Hex;
}

/** MessageV1Codec's MESSAGE_V1_BASE_SIZE: the fixed fields and the length prefixes. */
const BASE_SIZE = 79;

/** `encoded` decoded as MessageV1Codec._decodeMessageV1 does it (version 1, every length checked, every byte consumed),
 * or throws naming what is wrong: the keeper refuses a message it can't read exactly as the OffRamp does. */
export function decodeMessageV1(encoded: Hex): MessageV1 {
  const n = size(encoded);
  if (n < BASE_SIZE) throw new Error(`the CCIP message is ${n} bytes, shorter than a MessageV1's ${BASE_SIZE}`);
  let at = 0;
  const take = (len: number, what: string): Hex => {
    if (at + len > n) throw new Error(`the CCIP message ends inside its ${what}`);
    const out = len === 0 ? "0x" : slice(encoded, at, at + len);
    at += len;
    return out as Hex;
  };
  const num = (len: number, what: string) => hexToBigInt(take(len, what));
  const version = Number(num(1, "version"));
  if (version !== 1) throw new Error(`the CCIP message's version is ${version}, not 1`);
  const m = {
    sourceChainSelector: num(8, "source chain selector"),
    destChainSelector: num(8, "destination chain selector"),
    messageNumber: num(8, "message number"),
    executionGasLimit: Number(num(4, "execution gas limit")),
    ccipReceiveGasLimit: Number(num(4, "ccipReceive gas limit")),
    finality: take(4, "finality"),
    ccvAndExecutorHash: take(32, "CCV and executor hash"),
  };
  const short = (what: string) => take(Number(num(1, `${what}'s length`)), what);
  const long = (what: string) => take(Number(num(2, `${what}'s length`)), what);
  const onRampAddress = short("onRamp address");
  const offRampAddress = short("offRamp address");
  const sender = short("sender");
  const receiver = short("receiver");
  const destBlob = long("destination blob");
  const transferLength = Number(num(2, "token transfer's length"));
  const tokenTransfer: TokenTransferV1[] = [];
  if (transferLength > 0) {
    const end = at + transferLength;
    const tv = Number(num(1, "token transfer's version"));
    if (tv !== 1) throw new Error(`the CCIP message's token transfer version is ${tv}, not 1`);
    tokenTransfer.push({
      amount: num(32, "token amount"),
      sourcePoolAddress: short("source pool address"),
      sourceTokenAddress: short("source token address"),
      destTokenAddress: short("destination token address"),
      tokenReceiver: short("token receiver"),
      extraData: long("token transfer's extra data"),
    });
    if (at !== end) throw new Error("the CCIP message's token transfer is not the length it says");
  }
  const data = long("data");
  if (at !== n) throw new Error(`the CCIP message has ${n - at} bytes after its data`);
  return { ...m, onRampAddress, offRampAddress, sender, receiver, destBlob, tokenTransfer, data };
}

/** A lane of Cascade's own: Base → Bittensor carries the door's batches to the vault, Bittensor → Base the vault's payouts
 * (and a park's refund) to the door. */
export type Direction = "Base → Bittensor" | "Bittensor → Base";

/** Each lane's ends: the source chain, its OnRamp and adapter (the CCIP sender), the destination chain, its OffRamp and
 * adapter (the CCIP receiver), each side's selector, and who the adapter payload names (recipient and sender). */
export interface Lane {
  direction: Direction;
  source: ChainName;
  dest: ChainName;
  onRamp: Address;
  offRamp: Address;
  sourceSelector: bigint;
  destSelector: bigint;
  /** The adapter that sends (CCIP's message.sender) and the one that receives (message.receiver) */
  sourceAdapter: Address;
  destAdapter: Address;
  /** The payload's recipient and sender: (vault, door) toward Bittensor, (door, vault) toward Base */
  recipient: Address;
  sender: Address;
}

/** The lane `direction` of deployment `d` through adapter pair `pair` (R4, D-M2: any pair the deployment lists; absent,
 * the deploy's own), or why it can't be named (a deployment without the CCIP lane's OnRamps and selectors: nothing is
 * rebuilt then). The OnRamps, OffRamps and selectors are the chains' own, the same for every pair. */
export function laneOf(d: DeploymentV32, direction: Direction, pair?: Pick<AdapterPair, "baseAdapter" | "bitAdapter">): Lane | string {
  if (!d.onRamps || !d.selectors) return "the deployment names no CCIP OnRamps and selectors (onRamps, selectors)";
  const a = d.addresses;
  const p = pair ?? { baseAdapter: a.baseAdapter, bitAdapter: a.bitAdapter };
  const toBittensor = direction === "Base → Bittensor";
  const source: ChainName = toBittensor ? "base" : "bittensor";
  const dest: ChainName = toBittensor ? "bittensor" : "base";
  return {
    direction,
    source,
    dest,
    onRamp: d.onRamps[source],
    offRamp: d.offRamps[dest],
    sourceSelector: d.selectors[source],
    destSelector: d.selectors[dest],
    sourceAdapter: toBittensor ? p.baseAdapter : p.bitAdapter,
    destAdapter: toBittensor ? p.bitAdapter : p.baseAdapter,
    recipient: toBittensor ? a.vault : a.frontDoor,
    sender: toBittensor ? a.frontDoor : a.vault,
  };
}

/** The pair a message of Cascade's was sent through, by its source adapter (CascadeSent.adapter; absent: the deploy's). */
export function pairOfSent(d: DeploymentV32, x: { direction: Direction; adapter?: Address }): AdapterPair | undefined {
  if (!x.adapter) return adapterPairs(d)[0];
  return x.direction === "Base → Bittensor" ? pairOfBase(d, x.adapter) : pairOfBit(d, x.adapter);
}

/** A message rebuilt from its CCIPMessageSent and checked: the encoded bytes (whose keccak256 is its id), the message,
 * and the adapter payload it carries (recipient, sender, message). */
export interface Rebuilt {
  encoded: Hex;
  message: MessageV1;
  payload: { recipient: Address; sender: Address; message: Hex };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** An EVM address as a source-side MessageV1 field holds it: abi.encode(address), 32 bytes. */
const word = (a: Address): Hex => padHex(a.toLowerCase() as Hex, { size: 32 });

/** Why `encoded` is not message `id` of Cascade's own on `lane`, or the message it is (byte for byte: its keccak256 is
 * `id`). Checked: the id; the format (decodeMessageV1); both selectors; the source OnRamp and the destination OffRamp;
 * the CCIP sender (the source adapter, abi-encoded) and receiver (the destination adapter, raw 20 bytes); the adapter
 * payload's recipient and sender (the vault and the door, the way the lane runs); and, when `amount` is given, the token
 * amount (none for 0). Any mismatch refuses. */
export function rebuildProblem(lane: Lane, id: Hex, encoded: Hex, amount?: bigint): { problem: string } | { ok: Rebuilt } {
  if (!same(keccak256(encoded), id)) return { problem: `the bytes the ${lane.source === "base" ? "Base" : "Bittensor"} OnRamp logged hash to ${keccak256(encoded)}, not the message id` };
  let m: MessageV1;
  try {
    m = decodeMessageV1(encoded);
  } catch (e) {
    return { problem: `it is not a MessageV1 the OffRamp reads (${(e as Error).message})` };
  }
  if (m.sourceChainSelector !== lane.sourceSelector || m.destChainSelector !== lane.destSelector) return { problem: "it runs on another lane (its chain selectors)" };
  if (!same(m.onRampAddress, word(lane.onRamp))) return { problem: "another OnRamp sent it" };
  if (!same(m.offRampAddress, lane.offRamp)) return { problem: "it names another OffRamp" };
  if (!same(m.sender, word(lane.sourceAdapter))) return { problem: "Cascade's adapter did not send it (its CCIP sender)" };
  if (!same(m.receiver, lane.destAdapter)) return { problem: "it is not for Cascade's adapter (its CCIP receiver)" };
  let payload: Rebuilt["payload"];
  try {
    const [recipient, sender, message] = decodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "bytes" }], m.data);
    payload = { recipient: getAddress(recipient), sender: getAddress(sender), message };
  } catch {
    return { problem: "its data is not an adapter payload (recipient, sender, message)" };
  }
  if (!same(payload.recipient, lane.recipient) || !same(payload.sender, lane.sender)) {
    return { problem: `its payload runs from ${payload.sender} to ${payload.recipient}, not Cascade's (${lane.sender} to ${lane.recipient})` };
  }
  if (amount !== undefined) {
    const carried = m.tokenTransfer[0]?.amount ?? 0n;
    if (carried !== amount) return { problem: `it carries ${carried} wei of the token, not the ${amount} its record names` };
  }
  return { ok: { encoded, message: m, payload } };
}

import { encodeAbiParameters, type Hex, keccak256, toBytes } from "viem";
import type { Deployment } from "./config.ts";
import type { StoredLog } from "./logs.ts";

// v3.2's parks (spec §3.2, CcipBittensorAdapter.sol): a delivery the Bittensor adapter can't complete is parked under
// keccak256(abi.encode(remoteChainId, sender, recipient, message)), as tokens (the conversion failed) or as native TAO
// (its recipient refused it), with BatchParked; ParkedConverted keeps it parked (a deliverParked its recipient refused,
// now native TAO); ParkedDelivered, ParkedRefunded and ParkedDropped end it. The CCIP message itself succeeds, and
// ccipReceive logs Delivered after a park too (R3 B-I3), so a parked message is read from BatchParked, never Delivered.

/** CcipBittensorAdapter.REFUND_CHUNK: a refund's PAYOUTS message carries the park's key as its batch key and this
 * chunk number, so the front door tells it apart from the vault's own chunks (a test pins it to the source). */
export const REFUND_CHUNK = 4_294_967_295;
/** CcipBittensorAdapter.PARK_TIMEOUT (14 days): from its first parkedAt, a park can be refunded (or dropped when empty). */
export const PARK_TIMEOUT_S = 14 * 86_400;
/** Bittensor's nominal block time (12 s): a park's age, told by its block when its time isn't known, is told at the block time
 * the readings measure (src/blocktime.ts), and at this only while that is unread (a first tick). */
export const BITTENSOR_BLOCK_S = 12;

export const PARK_EVENTS = ["BatchParked", "ParkedConverted", "ParkedDelivered", "ParkedRefunded", "ParkedDropped"] as const;
/** The events that end a park. */
export const PARK_ENDS: ReadonlySet<string> = new Set(["ParkedDelivered", "ParkedRefunded", "ParkedDropped"]);

const lower = (x: unknown) => String(x).toLowerCase() as Hex;
const same = (a: unknown, b: Hex) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const byPosition = (a: StoredLog, b: StoredLog) => (a.block !== b.block ? (a.block < b.block ? -1 : 1) : a.logIndex - b.logIndex);

/** One park: from its BatchParked to the event that ended it, if any. */
export interface Park {
  /** the Bittensor adapter that holds it */
  adapter: Hex;
  key: Hex;
  /** CCIP's message that delivered the batch (the keeper rebuilds the message from the Base OnRamp by it) */
  messageId: Hex;
  recipient: Hex;
  sender: Hex;
  /** wei */
  amount: bigint;
  /** as native TAO now (parked so, or a ParkedConverted since), else as tokens */
  converted: boolean;
  /** the failure's 4-byte selector (0x00000000: an empty revert, or out of gas) */
  reason: Hex;
  /** a batch from the deployment's front door to its vault; any other is a stranger's (R3 A-L2: anyone can send through
   * the Base adapter, naming any recipient) */
  door: boolean;
  parked: StoredLog;
  /** its ParkedDelivered, ParkedRefunded or ParkedDropped */
  ended?: StoredLog;
}

/** The parks in `logs` (the Bittensor adapters' park events, any order): each BatchParked opens one, kept until the
 * next ParkedDelivered, ParkedRefunded or ParkedDropped of its adapter and key after it (a key can be parked again
 * once its park ended: the same batch delivered again). */
export function parksOf(logs: readonly StoredLog[], d: Pick<Deployment, "frontDoor" | "vault">): Park[] {
  const out: Park[] = [];
  const open = new Map<string, Park>();
  for (const l of [...logs].filter((x) => x.chain === "bittensor" && x.contract === "bitAdapter").sort(byPosition)) {
    const id = `${lower(l.address)}:${lower(l.args.key)}`;
    if (l.event === "BatchParked") {
      const p: Park = {
        adapter: lower(l.address),
        key: lower(l.args.key),
        messageId: lower(l.args.messageId),
        recipient: lower(l.args.recipient),
        sender: lower(l.args.sender),
        amount: BigInt(String(l.args.amount ?? "0")),
        converted: String(l.args.converted) === "true",
        reason: lower(l.args.reason ?? "0x00000000"),
        door: same(l.args.sender, d.frontDoor) && same(l.args.recipient, d.vault),
        parked: l,
      };
      open.set(id, p);
      out.push(p);
    } else if (l.event === "ParkedConverted") {
      const p = open.get(id);
      if (p) p.converted = true;
    } else if (PARK_ENDS.has(l.event)) {
      const p = open.get(id);
      if (p) {
        p.ended = l;
        open.delete(id);
      }
    }
  }
  return out;
}

/** CcipBittensorAdapter._parkKey: keccak256(abi.encode(uint64 remoteChainId, address sender, address recipient, bytes
 * message)), the remote chain Base's EVM chain id. */
export const parkKeyOf = (sourceChain: bigint, sender: Hex, recipient: Hex, message: Hex): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint64" }, { type: "address" }, { type: "address" }, { type: "bytes" }], [sourceChain, sender, recipient, message]));

const selector = (signature: string) => keccak256(toBytes(signature)).slice(0, 10) as Hex;
/** Why a batch parked, by the failure's selector: the vault's refusals (onBridgeMessage) and the conversion's (a test
 * pins each signature to the published vault ABI and the adapter's; ForeverMoney's Slippage is theirs). */
const REASONS: ReadonlyMap<Hex, string> = new Map([
  [selector("StakeMissing()"), "the vault refused it: stake is missing (StakeMissing)"],
  [selector("EnforcedPause()"), "the vault refused it: the vault is paused (EnforcedPause)"],
  [selector("UnknownPeer()"), "the vault refused it: it doesn't know this front door (UnknownPeer)"],
  [selector("VaultInsolvent()"), "the vault refused it: underwater with no shares (VaultInsolvent)"],
  [selector("NotBridge()"), "the vault refused it: this bridge isn't enabled on the vault (NotBridge)"],
  [selector("DuplicateBatch()"), "the vault refused it: it took this batch already (DuplicateBatch)"],
  [selector("ValueMismatch()"), "the vault refused it: the TAO sent isn't the batch's amount (ValueMismatch)"],
  [selector("ConversionShort()"), "the conversion came out short with the native reserve empty (ConversionShort)"],
  [selector("BelowConversionFloor(uint256,uint256)"), "the amount is below the chain's conversion floor (BelowConversionFloor)"],
  [selector("Slippage()"), "ForeverMoney's withdraw came out short (Slippage)"],
  ["0x00000000", "an empty revert, or out of gas"],
]);
export const reasonOf = (reason: Hex): string => REASONS.get(lower(reason)) ?? `an error with selector ${lower(reason)}`;
/** The error signatures REASONS names, for the test that pins them to the contracts. */
export const REASON_SIGNATURES = ["StakeMissing()", "EnforcedPause()", "UnknownPeer()", "VaultInsolvent()", "NotBridge()", "DuplicateBatch()", "ValueMismatch()", "ConversionShort()", "BelowConversionFloor(uint256,uint256)"] as const;

import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Signer } from "../../ops/src/keeper/core/send.ts";

// The Worker's signer (design-keeper-worker.md §2): viem's local account from the KEEPER_PRIVATE_KEY secret, read once a
// run. Nothing else reads the secret, and no message here, nor any line the Worker logs or stores, carries it: every
// line goes through `redact`, which cuts the key out wherever it appears (with or without 0x, in either case).

/** The secret is missing or isn't a key. The message never quotes what was set. */
export class KeyProblem extends Error {}

export interface KeeperKey {
  address: Address;
  signer: Signer;
  /** `text` with the key cut out */
  redact(text: string): string;
}

const SHAPE = /^0x[0-9a-fA-F]{64}$/;

/** The keeper's key from the secret: its address, a Signer for the core's raw send path, and the redaction. */
export function keeperKey(secret: string | undefined): KeeperKey {
  const key = (secret ?? "").trim();
  if (!key) throw new KeyProblem("KEEPER_PRIVATE_KEY is not set (pnpm keeper:new-key --put-secret sets it); nothing signed or sent");
  if (!SHAPE.test(key)) throw new KeyProblem("KEEPER_PRIVATE_KEY is not a private key (0x and 64 hex digits); nothing signed or sent");
  let account: ReturnType<typeof privateKeyToAccount>;
  try {
    account = privateKeyToAccount(key as Hex);
  } catch {
    // viem's own message could quote the value: never passed on
    throw new KeyProblem("KEEPER_PRIVATE_KEY is not a usable secp256k1 key; nothing signed or sent");
  }
  const bare = key.slice(2).toLowerCase();
  const redact = (text: string): string => {
    if (!text) return text;
    const lower = text.toLowerCase();
    if (!lower.includes(bare)) return text;
    let out = "";
    let i = 0;
    for (;;) {
      const at = lower.indexOf(bare, i);
      if (at < 0) return out + text.slice(i);
      // the 0x in front goes too
      const from = at >= 2 && lower.slice(at - 2, at) === "0x" ? at - 2 : at;
      out += `${text.slice(i, from)}[the keeper's key]`;
      i = at + bare.length;
    }
  };
  return {
    address: account.address,
    redact,
    signer: {
      address: account.address,
      async signTransaction(tx) {
        try {
          return await account.signTransaction(tx);
        } catch (e) {
          throw new Error(redact(`the keeper's key did not sign (${(e as Error).message.split("\n")[0]})`));
        }
      },
    },
  };
}

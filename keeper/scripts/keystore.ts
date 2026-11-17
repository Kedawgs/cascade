import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { scrypt } from "@noble/hashes/scrypt";
import { type Hex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// The keeper key's keystore on the PC (the founder's 2026-11-07 decision: hand runs use the Worker's key): the Web3
// Secret Storage format (version 3: scrypt, AES-128-CTR, a keccak MAC), which Foundry's `cast wallet` and geth read,
// so the hand run signs with it through ops' cast signer. A test decrypts the format's published test vector.

export interface Keystore {
  version: 3;
  id: string;
  address: string;
  crypto: {
    cipher: "aes-128-ctr";
    cipherparams: { iv: string };
    ciphertext: string;
    kdf: "scrypt";
    kdfparams: { dklen: number; n: number; r: number; p: number; salt: string };
    mac: string;
  };
}

/** geth's standard scrypt cost (n 2^18, r 8, p 1): about a second and 256 MB to open, on purpose */
export const SCRYPT = { n: 262_144, r: 8, p: 1 };

const mac = (dk: Uint8Array, ciphertext: Buffer) => keccak256(Buffer.concat([Buffer.from(dk.subarray(16, 32)), ciphertext])).slice(2);

/** `key` sealed with `password`. */
export function encryptKey(key: Hex, password: string, kdf = SCRYPT): Keystore {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const dk = scryptSync(password, salt, 32, { N: kdf.n, r: kdf.r, p: kdf.p, maxmem: 512 * 1024 * 1024 });
  const c = createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([c.update(Buffer.from(key.slice(2), "hex")), c.final()]);
  return {
    version: 3,
    id: randomUUID(),
    address: privateKeyToAccount(key).address.slice(2).toLowerCase(),
    crypto: {
      cipher: "aes-128-ctr",
      cipherparams: { iv: iv.toString("hex") },
      ciphertext: ciphertext.toString("hex"),
      kdf: "scrypt",
      kdfparams: { dklen: 32, n: kdf.n, r: kdf.r, p: kdf.p, salt: salt.toString("hex") },
      mac: mac(dk, ciphertext),
    },
  };
}

/** The key a keystore seals, opened with `password`; refused on a wrong password (the MAC) or another format. */
export function decryptKey(ks: Keystore, password: string): Hex {
  const k = ks.crypto;
  if (ks.version !== 3 || k?.kdf !== "scrypt" || k.cipher !== "aes-128-ctr") throw new Error("not a version 3 scrypt keystore");
  const p = k.kdfparams;
  // noble's scrypt opens any parameters (OpenSSL refuses some valid ones, e.g. r 1 with n 2^18)
  const dk = scrypt(password, Buffer.from(p.salt, "hex"), { N: p.n, r: p.r, p: p.p, dkLen: p.dklen });
  const ciphertext = Buffer.from(k.ciphertext, "hex");
  if (mac(dk, ciphertext) !== k.mac.toLowerCase()) throw new Error("wrong password (the keystore's MAC doesn't match)");
  const d = createDecipheriv("aes-128-ctr", Buffer.from(dk.subarray(0, 16)), Buffer.from(k.cipherparams.iv, "hex"));
  return `0x${Buffer.concat([d.update(ciphertext), d.final()]).toString("hex")}` as Hex;
}

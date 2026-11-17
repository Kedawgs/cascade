import { type Hex, keccak256, parseSignature, recoverAddress, serializeTransaction } from "viem";
import { bin, type Ctx, redact, SendRefused, signerOf, signingAccount } from "../send.ts";
import type { Signer as TxSigner } from "./core/send.ts";

/** The v3.2 hand run's signer (R4, D-M1): the keeper's keystore (OPS_V32_KEEPER_KEYSTORE, its password by file), signing as
 * its own account, which Foundry's `cast wallet address` opens it to, never as the record's keeper: after a rotation the
 * record still names the plan's first keeper, and readiness holds the key to keeper() on both contracts. A keystore that
 * doesn't open is refused. */
export async function keeperSignerV32(ctx: Pick<Ctx, "runner" | "paths" | "targets">, o: { keystore: string; passwordFile: string }): Promise<TxSigner> {
  const address = await signingAccount(ctx, o);
  if (!address) throw new Error("the keystore at OPS_V32_KEEPER_KEYSTORE didn't open with OPS_V32_KEEPER_PASSWORD_FILE (cast wallet address): check both; nothing sent");
  return castSigner({ ...ctx, signer: { address, keystore: o.keystore, passwordFile: o.passwordFile, name: "the v3.2 keeper" } });
}

/** The PC's signer for the core's raw send path (core/send.ts): Foundry's `cast wallet sign --no-hash` signs the
 * transaction's hash with the context's keystore (by path, its password by file: the key never leaves Foundry), and
 * the signature must recover to the keystore's account before the transaction is put together. The core then decodes
 * what comes back and holds it to the call (signedCallProblem), as it does for any signer. Node-only (child_process,
 * through the context's runner): the Worker's signer is a viem account (Task 50b). */
export function castSigner(ctx: Pick<Ctx, "runner" | "paths" | "signer" | "targets">): TxSigner {
  const s = signerOf(ctx);
  return {
    address: s.address,
    async signTransaction(tx) {
      const digest = keccak256(serializeTransaction(tx));
      const out = await ctx.runner.run(bin(ctx, "cast"), ["wallet", "sign", "--no-hash", digest, "--keystore", s.keystore, "--password-file", s.passwordFile], {
        cwd: ctx.paths.contractsDir,
      });
      const sig = out.code === 0 ? (out.stdout.match(/0x[0-9a-fA-F]{130}(?![0-9a-fA-F])/)?.[0] as Hex | undefined) : undefined;
      if (!sig) {
        const why = redact(ctx.targets, out.stderr.trim() || out.stdout.trim()) || `exit ${out.code}`;
        throw new SendRefused("signer", `${s.name}'s keystore did not sign (${why}); nothing sent`);
      }
      const by = await recoverAddress({ hash: digest, signature: sig });
      if (by.toLowerCase() !== s.address.toLowerCase()) throw new SendRefused("signer", `the keystore signed as ${by}, not ${s.name} ${s.address}; nothing sent`);
      const { r, s: sv, yParity } = parseSignature(sig);
      return serializeTransaction(tx, { r, s: sv, yParity });
    },
  };
}

import { type Env, type Paths, WALLET } from "../config.ts";
import { type Plan, type PlanV3, rolesOf } from "../plan.ts";
import { type Ctx, type Signer, signerOf, signingAccount } from "../send.ts";

const KEEPER_KEY_VARS = "OPS_KEEPER_KEYSTORE and OPS_KEEPER_PASSWORD_FILE";

/** Who signs the keeper commands (run, close, roll, stake, payouts, claim, deliver): with
 * OPS_KEEPER_KEYSTORE and OPS_KEEPER_PASSWORD_FILE set, the record's keeper with that key; with neither,
 * the test wallet with the default keystore (the test cadence's keeper, and a launch whose keeper is the
 * test wallet). stakeIdle, claimRewards and deliver are the keeper's own calls; closeBatch and
 * processPayouts are anyone's, but only the keeper's chunk size counts, so they sign as the keeper too. */
export function keeperSigner(env: Env, p: Pick<Paths, "keystore" | "passwordFile">, plan: Plan | PlanV3): Signer {
  const keystore = env.OPS_KEEPER_KEYSTORE?.trim();
  const passwordFile = env.OPS_KEEPER_PASSWORD_FILE?.trim();
  if (!keystore && !passwordFile) return { address: WALLET, keystore: p.keystore, passwordFile: p.passwordFile, name: "the test wallet" };
  if (!keystore || !passwordFile) {
    throw new Error(`set both ${KEEPER_KEY_VARS} (the keeper's key), or neither (the test wallet's); nothing sent`);
  }
  return { address: rolesOf(plan).keeper, keystore, passwordFile, name: "the keeper" };
}

/** What requireReady says when the keeper commands would sign as someone other than the record's keeper. */
export const keeperMismatch = (keeper: string, signer: string) =>
  `the record's keeper is ${keeper}, but the keeper commands sign as ${signer}: set ${KEEPER_KEY_VARS} to the keeper's key; nothing sent`;

/** Before `run` starts: the record's keeper must be who the keeper commands sign as (with the default
 * keystore too: the test wallet), and the keystore must really sign as it (each send checks it again),
 * so a mismatch or a wrong key stops the loop at once instead of at its first send. */
export async function requireKeeperKey(ctx: Pick<Ctx, "runner" | "paths" | "signer">, rec: { plan: Plan | PlanV3 }): Promise<void> {
  const s = signerOf(ctx);
  const keeper = rolesOf(rec.plan).keeper;
  if (keeper.toLowerCase() !== s.address.toLowerCase()) throw new Error(keeperMismatch(keeper, s.address));
  const signs = await signingAccount(ctx, s);
  if (!signs || signs.toLowerCase() !== s.address.toLowerCase()) {
    throw new Error(
      `the keeper's keystore ${s.keystore} signs as ${signs ?? "no account (it can't be opened)"}, not the record's keeper ${s.address}: set ${KEEPER_KEY_VARS} to the keeper's key; nothing sent`,
    );
  }
}

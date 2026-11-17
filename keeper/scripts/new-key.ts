import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { argsOf, closeIo, confirmed, consoleIo, ENVS, type Io, isMain, type KeeperEnvName } from "./io.ts";
import { decryptKey, encryptKey, type Keystore, SCRYPT } from "./keystore.ts";

// pnpm keeper:new-key -- --env <test|production> [--keystore <path>] [--put-secret]
//   Makes the v3.2 keeper's key in memory and writes it only as a password-protected keystore on the PC (the
//   password asked for twice, never shown), for the hand runs (the founder's 2026-11-07 decision: hand runs use the
//   Worker's key). With --put-secret and the environment's name typed out, the key goes over stdin straight into
//   `wrangler secret put KEEPER_PRIVATE_KEY --env <env>`, run from this folder. Only the address is printed. There is
//   no plaintext file, no clipboard copy and no argument holding the key.
// pnpm keeper:put-key -- --env <test|production> --keystore <path>
//   Puts an existing keystore's key into the secret (after a failed put, or a new Worker): the same confirmation.

const SECRET = "KEEPER_PRIVATE_KEY";
const MIN_PASSWORD = 12;

/** Where the keystore goes when --keystore isn't given: beside Foundry's own keystores. */
export const defaultKeystore = (env: KeeperEnvName) => join(homedir(), ".foundry", "keystores", `cascade-v3.2-keeper-${env}.json`);

function envOf(io: Io, v: string | undefined): KeeperEnvName | undefined {
  if (v && (ENVS as readonly string[]).includes(v)) return v as KeeperEnvName;
  io.say("--env test or --env production is needed (the Worker's environment)");
  return undefined;
}

async function put(io: Io, env: KeeperEnvName, key: string, keystore: string): Promise<number> {
  if (!(await confirmed(io, env, "the keeper's key"))) return 1;
  const code = await io.wrangler(["secret", "put", SECRET, "--env", env], key);
  if (code !== 0) {
    io.say(`wrangler did not set ${SECRET} (exit ${code}). The keystore is kept: pnpm keeper:put-key -- --env ${env} --keystore ${keystore}`);
    return 1;
  }
  io.say(`${SECRET} is set on cascade-keeper-${env}.`);
  return 0;
}

export async function newKey(argv: string[], io: Io, o: { kdf?: typeof SCRYPT } = {}): Promise<number> {
  const a = argsOf(argv, ["--env", "--keystore"]);
  const env = envOf(io, a.value("--env"));
  if (!env) return 1;
  const path = resolve(a.value("--keystore") ?? defaultKeystore(env));
  if (existsSync(path)) {
    io.say(`${path} already exists: nothing made (a keystore is never written over).`);
    return 1;
  }
  const password = await io.hidden(`Password for the keeper's keystore (at least ${MIN_PASSWORD} characters, not shown): `);
  const again = await io.hidden("The same password again: ");
  if (password !== again) {
    io.say("The two passwords differ: nothing made.");
    return 1;
  }
  if (password.length < MIN_PASSWORD) {
    io.say(`The password is shorter than ${MIN_PASSWORD} characters: nothing made.`);
    return 1;
  }
  const key = generatePrivateKey();
  const keystore = encryptKey(key, password, o.kdf ?? SCRYPT);
  writeFileSync(path, `${JSON.stringify(keystore)}\n`, { flag: "wx", mode: 0o600 });
  io.say(`The keeper's address: ${privateKeyToAccount(key).address}`);
  io.say(`Its keystore (password-protected): ${path}`);
  if (!a.flag("--put-secret")) {
    io.say(`Not put into a Worker secret. To put it later: pnpm keeper:put-key -- --env ${env} --keystore ${path}`);
    return 0;
  }
  return put(io, env, key, path);
}

export async function putKey(argv: string[], io: Io): Promise<number> {
  const a = argsOf(argv, ["--env", "--keystore"]);
  const env = envOf(io, a.value("--env"));
  if (!env) return 1;
  const v = a.value("--keystore");
  if (!v || !existsSync(resolve(v))) {
    io.say("--keystore <path> is needed: the keystore pnpm keeper:new-key wrote.");
    return 1;
  }
  const path = resolve(v);
  let key: string;
  try {
    key = decryptKey(JSON.parse(readFileSync(path, "utf8")) as Keystore, await io.hidden("The keystore's password (not shown): "));
  } catch (e) {
    io.say(`The keystore didn't open: ${(e as Error).message}. Nothing put.`);
    return 1;
  }
  io.say(`The keeper's address: ${privateKeyToAccount(key as `0x${string}`).address}`);
  return put(io, env, key, path);
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2).filter((x) => x !== "--");
  const run = argv[0] === "put" ? putKey(argv.slice(1), consoleIo) : newKey(argv, consoleIo);
  run.then(
    (code) => {
      closeIo();
      process.exitCode = code;
    },
    (e: unknown) => {
      closeIo();
      // a message of ours only: no key is ever in one
      console.error(`Stopped: ${(e as Error).message}`);
      process.exitCode = 1;
    },
  );
}

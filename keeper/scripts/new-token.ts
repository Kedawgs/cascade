import { createHash, randomBytes } from "node:crypto";
import { argsOf, closeIo, confirmed, consoleIo, ENVS, type Io, isMain, type KeeperEnvName } from "./io.ts";

// pnpm keeper:new-token -- --env <test|production> [--put-secret]
//   A new control token for the keeper's control routes (design-keeper-worker.md §3): printed once for the PC's
//   ops/.env (OPS_KEEPER_CONTROL_TOKEN), with its SHA-256, the only form the Worker keeps. With --put-secret and the
//   environment's name typed out, the hash goes over stdin into `wrangler secret put CONTROL_TOKEN_SHA256`. A leaked
//   token lets someone stop the keeper or take its lease, never sign or move anything: make a new one.

export async function newToken(argv: string[], io: Io): Promise<number> {
  const a = argsOf(argv, ["--env"]);
  const env = a.value("--env");
  if (!env || !(ENVS as readonly string[]).includes(env)) {
    io.say("--env test or --env production is needed (the Worker's environment)");
    return 1;
  }
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  io.say(`The control token for cascade-keeper-${env} (shown once: put it in ops/.env as OPS_KEEPER_CONTROL_TOKEN): ${token}`);
  io.say(`Its SHA-256 (the Worker's CONTROL_TOKEN_SHA256): ${hash}`);
  if (!a.flag("--put-secret")) return 0;
  if (!(await confirmed(io, env as KeeperEnvName, "the control token's SHA-256"))) return 1;
  const code = await io.wrangler(["secret", "put", "CONTROL_TOKEN_SHA256", "--env", env], hash);
  if (code !== 0) {
    io.say(`wrangler did not set CONTROL_TOKEN_SHA256 (exit ${code}): run this again for a new token.`);
    return 1;
  }
  io.say(`CONTROL_TOKEN_SHA256 is set on cascade-keeper-${env}.`);
  return 0;
}

if (isMain(import.meta.url)) {
  newToken(process.argv.slice(2).filter((x) => x !== "--"), consoleIo).then(
    (code) => {
      closeIo();
      process.exitCode = code;
    },
    (e: unknown) => {
      closeIo();
      console.error(`Stopped: ${(e as Error).message}`);
      process.exitCode = 1;
    },
  );
}

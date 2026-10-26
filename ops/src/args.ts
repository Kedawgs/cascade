import { isAddress } from "viem";

export class UsageError extends Error {}

export const COMMANDS = [
  "preflight",
  "rehearse",
  "budget",
  "deploy",
  "verify",
  "status",
  "close",
  "stake",
  "payouts",
  "rewards",
  "claim",
  "deliver",
  "track",
  "run",
  "wind-down",
  "sweep",
  "web-config",
] as const;

export type Command = (typeof COMMANDS)[number];

export interface Args {
  cmd: Command;
  live: boolean;
  newPlan?: boolean;
  users: string[];
  messageId?: string;
  taoTo?: string;
  ethTo?: string;
}

export const USAGE = `usage: pnpm ops <command> [--live]

  preflight                  read-only checks against the live chains
  rehearse                   deploy and check everything on local forks
  budget                     how much TAO and ETH to send to the test wallet
  deploy [--new-plan]        deploy and configure (resumes after a stop), then check
  verify                     read every setting back and compare it with the plan
  status [--user 0x…]        what is happening on both chains
  close | stake | payouts    do one keeper action now
  rewards                    the rewards waiting, a claim's cost, and whether a claim is due
  claim                      claim the rewards, only when the claim policy says so
  deliver [--user 0x…]       sell redeemed users' TAO for USDC where their minimum allows
  track <messageId>          follow a bridge message to its destination
  run                        do whatever is due, every minute, until stopped (Ctrl-C); never claims
  wind-down --user 0x…       pause the front door once everything is paid out
  sweep --tao-to <SS58> --eth-to <0x…>   send the test wallet's leftovers home
  web-config                 write web/.env.local with the deployment's addresses for the site

Without --live, deploy and the keeper commands use the local forks.`;

export function parseArgs(argv: readonly string[]): Args {
  const [cmd, ...rest] = argv;
  if (!COMMANDS.includes(cmd as Command)) throw new UsageError(cmd ? `unknown command ${cmd}` : "no command given");
  const out: Args = { cmd: cmd as Command, live: false, users: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const value = () => {
      const v = rest[++i];
      if (!v || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--live") out.live = true;
    else if (a === "--new-plan" && cmd === "deploy") out.newPlan = true;
    else if (a === "--user") out.users.push(value());
    else if (a === "--tao-to" && cmd === "sweep") out.taoTo = value();
    else if (a === "--eth-to" && cmd === "sweep") out.ethTo = value();
    else if (cmd === "track" && !a.startsWith("--") && !out.messageId) out.messageId = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (cmd === "deploy" && out.newPlan === undefined) out.newPlan = false;
  if (cmd === "track" && !out.messageId) throw new UsageError("track needs a message id");
  if (cmd === "sweep" && (!out.taoTo || !out.ethTo)) throw new UsageError("sweep needs both --tao-to and --eth-to");
  // deliver sends a transaction naming each user
  const bad = cmd === "deliver" ? out.users.find((u) => !isAddress(u, { strict: false })) : undefined;
  if (bad) throw new UsageError(`--user ${bad} is not an address`);
  return out;
}

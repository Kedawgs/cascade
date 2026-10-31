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
  "handoff",
  "ownership",
  "cardinality",
  "pause",
  "unpause",
  "sign",
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
  /** pause and unpause: which contracts */
  target?: "front-door" | "vault" | "both";
  /** handoff, pause, unpause, cardinality: write a plain account's calls to a file for pnpm ops sign */
  forWallet?: boolean;
  /** cardinality --for-wallet: the account that will send the steps */
  from?: string;
  /** sign: the call file */
  file?: string;
  /** sign: the deployment the file must be for, in place of OPS_DEPLOYMENT */
  deployment?: string;
  /** pause, unpause, wind-down, sweep: a gas price cap for this run, in gwei (these commands have none
   * otherwise; config.ts gasPriceCapFor) */
  maxGasPrice?: string;
}

const PAUSE_TARGETS = ["front-door", "vault", "both"] as const;
const FOR_WALLET: readonly string[] = ["handoff", "pause", "unpause", "cardinality"];
/** The commands --max-gas-price goes with: the ones that send under no cap unless told one (UNCAPPED_COMMANDS). */
const MAX_GAS_PRICE: readonly string[] = ["pause", "unpause", "wind-down", "sweep"];

export const USAGE = `usage: pnpm ops <command> [--live]

  preflight                  read-only checks against the live chains
  rehearse                   on local forks: deploy v3, check it, and run a USDC stake through to a
                             USDC delivery (needs OPS_DEPLOYMENT=v3-…)
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
  wind-down [--user 0x…]     pause the front door once everything is paid out and claimed
  sweep --tao-to <SS58> --eth-to <0x…>   send the test wallet's leftovers home
  web-config                 write web/.env.local with the deployment's addresses for the site
  handoff                    a launch: write the Safe Transaction Builder files (deployments/safe/) in
                             which each final owner accepts ownership; sends nothing
  ownership                  each contract's owner and pending owner, against the plan
  cardinality                the oracle's pools' observation slots (reads Base), and the exact
                             increaseObservationCardinalityNext transactions to send from any wallet
  pause [front-door|vault|both]    EMERGENCY: pause as the guardian (both by default). Always the live
                             deployment: a dry run (estimate and keystore check) unless --live, which
                             sends. Signs with OPS_GUARDIAN_KEYSTORE and OPS_GUARDIAN_PASSWORD_FILE; a
                             Safe guardian gets a Transaction Builder file in deployments/safe/ instead
  unpause [front-door|vault|both]  the same, as the owner (OPS_OWNER_KEYSTORE, OPS_OWNER_PASSWORD_FILE)
  sign <file> [--deployment <name>]   serve a call file on http://127.0.0.1 (this computer only) as a
                             page that sends each call from MetaMask (a Ledger behind it), one per click;
                             Ctrl-C stops. The file must be for OPS_DEPLOYMENT's deployment, or --deployment's

  --for-wallet               with handoff --live, pause, unpause, or cardinality --from <0x…>: also write
                             a plain account's calls to deployments/wallet/<name>.json for pnpm ops sign.
                             Sends nothing and opens no keystore (pause and unpause: not with --live)
  --max-gas-price <gwei>     with pause, unpause, wind-down or sweep: refuse to send over this gas price.
                             These hand-run commands send under no cap otherwise (an emergency pause must
                             go out in a gas spike); every other command sends under OPS_MAX_GAS_PRICE_BASE
                             and OPS_MAX_GAS_PRICE_BITTENSOR (gwei; 5 and 100 by default)

Without --live, deploy and the keeper commands use the local forks.
Live, Base's logs are read from OPS_BASE_LOGS_RPC; without it from OPS_BASE_RPC, unless that is
mainnet.base.org (which refuses eth_getLogs), else https://base-rpc.publicnode.com. OPS_BASE_LOGS_WINDOW
sets the blocks a query asks for (default 10,000).
The keeper commands (status, close, stake, payouts, rewards, claim, deliver, run) sign as the record's
keeper with OPS_KEEPER_KEYSTORE and OPS_KEEPER_PASSWORD_FILE, else as the test wallet.
A launch (OPS_CADENCE=launch) reads its roles from OPS_LAUNCH_OWNER_BASE, OPS_LAUNCH_OWNER_BITTENSOR,
OPS_LAUNCH_GUARDIAN_BASE, OPS_LAUNCH_GUARDIAN_BITTENSOR, OPS_LAUNCH_KEEPER and OPS_LAUNCH_TREASURY.`;

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
    else if ((cmd === "pause" || cmd === "unpause") && (PAUSE_TARGETS as readonly string[]).includes(a) && !out.target) out.target = a as Args["target"];
    else if (a === "--for-wallet" && FOR_WALLET.includes(cmd)) out.forWallet = true;
    else if (a === "--from" && cmd === "cardinality") out.from = value();
    else if (a === "--deployment" && cmd === "sign") out.deployment = value();
    else if (cmd === "sign" && !a.startsWith("--") && !out.file) out.file = a;
    else if (a === "--max-gas-price" && MAX_GAS_PRICE.includes(cmd)) out.maxGasPrice = value();
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (out.maxGasPrice !== undefined && !(/^(\d+)(\.\d{1,9})?$/.test(out.maxGasPrice) && Number(out.maxGasPrice) > 0)) {
    throw new UsageError(`--max-gas-price ${out.maxGasPrice} is not a gas price in gwei (e.g. 5 or 0.5)`);
  }
  if (cmd === "deploy" && out.newPlan === undefined) out.newPlan = false;
  if (cmd === "track" && !out.messageId) throw new UsageError("track needs a message id");
  if ((cmd === "pause" || cmd === "unpause") && !out.target) out.target = "both";
  if (cmd === "sweep" && (!out.taoTo || !out.ethTo)) throw new UsageError("sweep needs both --tao-to and --eth-to");
  if (cmd === "sign" && !out.file) throw new UsageError("sign needs the call file (written by handoff, pause, unpause or cardinality with --for-wallet)");
  if (cmd === "sign" && out.live) throw new UsageError("sign sends nothing itself (MetaMask sends, one click per call): drop --live");
  if (out.deployment !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(out.deployment)) {
    throw new UsageError(`--deployment ${out.deployment} is not a plain name (e.g. v3-launch)`);
  }
  // handoff reads the live record only with --live; on the forks the page couldn't send what it wrote
  if (cmd === "handoff" && out.forWallet && !out.live) throw new UsageError("handoff --for-wallet is for the live deployment: add --live (handoff only reads, it sends nothing)");
  if ((cmd === "pause" || cmd === "unpause") && out.forWallet && out.live) {
    throw new UsageError(`--for-wallet writes the call for MetaMask and sends nothing; --live sends with the keystore: drop --live`);
  }
  if (cmd === "cardinality" && out.forWallet && !out.from) throw new UsageError("cardinality --for-wallet needs --from 0x…, the account that will send the steps from MetaMask");
  if (cmd === "cardinality" && out.from && !out.forWallet) throw new UsageError("--from goes with --for-wallet");
  if (out.from && !isAddress(out.from)) throw new UsageError(`--from ${out.from} is not an address (or its checksum is wrong)`);
  // deliver sends a transaction naming each user
  const bad = cmd === "deliver" ? out.users.find((u) => !isAddress(u, { strict: false })) : undefined;
  if (bad) throw new UsageError(`--user ${bad} is not an address`);
  return out;
}

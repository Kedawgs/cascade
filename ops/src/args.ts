import { type Hex, isAddress } from "viem";
import { decodeSs58 } from "./ss58.ts";
import { STAMP_SPACING_HOURS, stackBoundsProblem } from "./v32/stamp-bounds.ts";

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
  "schedule",
  "pending",
  "execute",
  "cancel",
  "cancel-payouts",
  "retire-pair",
  "remove-door",
  "stamp",
  "adopt",
  "add-hotkey",
  "remove-hotkey",
  "set-stake-hotkey",
  "park",
  "set-redeem-origin",
  "set-keeper",
  "fund-reserve",
  "fund-cushion",
  "disable-bridge",
  "set-idle-buffer",
  "set-claim-gas",
  "add-pair",
  "set-caps",
  "set-batch-limits",
  "pool-floors",
] as const;

export type Command = (typeof COMMANDS)[number];

export interface Args {
  cmd: Command;
  live: boolean;
  newPlan?: boolean;
  /** deploy: the v3.2 deployment (v32/deploy.ts), from fresh deployer keys; rehearse: v3.2's rehearsal (v32/rehearse.ts) */
  v32?: boolean;
  /** rehearse --v32: freeze contracts/out as it is, without forge build first (the build must already be the checkout's;
   * a live deploy builds, and refuses unless its build is the one this rehearsal names) */
  noBuild?: boolean;
  /** verify: read the configured v3.2 validators only (v32/validators.ts), no deployment needed */
  validators?: boolean;
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
  /** schedule: the scheduler contract (vault, front-door, or both for a change to the bridges), the setter and its
   * arguments, as typed */
  contract?: string;
  fn?: string;
  fnArgs?: string[];
  /** execute and cancel: the item id; cancel-payouts: the payout batch's key */
  id?: string;
  /** schedule and execute --one-sided "<reason>": a change to the bridges, or an activation's execute, the rail check
   * would refuse, written all the same with the founder's reason (Task 47b and its fix round) */
  oneSided?: string;
  /** cancel, retire-pair and remove-door: who signs it */
  as?: "owner" | "guardian";
  /** remove-door: the front door's chain id and address, as typed */
  doorChain?: string;
  door?: string;
  /** execute: which scheduler's copy runs, for an id pending on both */
  on?: "vault" | "front-door";
  /** stamp: the owner's signed stamp, its time (seconds) and signature, as typed */
  asOf?: string;
  sig?: string;
  /** stamp --to-stack: add the signed stamp to its chain's stack instead of relaying it */
  toStack?: boolean;
  /** stamp --stack <days> [--every <hours> [--accept-gap-risk "<why>"]]: write the stack's times, as typed */
  stack?: string;
  every?: string;
  acceptGapRisk?: string;
  /** stamp --relay-due: relay the stack's due stamps (for a bot) */
  relayDue?: boolean;
  /** stamp: a priority fee in whole gwei, as typed */
  tip?: string;
  /** v3.2's one-shots that check first (claim, adopt, add-hotkey, remove-hotkey, park; Task 53): --send sends, else they
   * check, simulate and print */
  send?: boolean;
  /** claim, add-hotkey, remove-hotkey, set-stake-hotkey: the hotkey (32 bytes of hex, or its SS58 address as taostats
   * shows it), as 32 bytes of hex */
  hotkey?: Hex;
  /** park: the park's key */
  parkKey?: Hex;
  /** remove-hotkey --as owner --for-wallet: the owner's removal gives up the hotkey's unclaimed rewards */
  forfeit?: boolean;
  /** set-keeper: the new keeper's address, as typed (Task 53's fix round) */
  newKeeper?: string;
  /** disable-bridge: the bridges, as typed (both: the vault's, then the front door's) */
  bridges?: string[];
  /** set-idle-buffer: the new idleBufferBps, as typed */
  bps?: string;
  /** set-claim-gas (R5 Minor 3): the new claimGasRequired, as typed */
  claimGas?: string;
  /** pause --for-wallet --offline (R4, D-L4): the emergency pause written with no chain read, kept ready */
  offline?: boolean;
  /** add-pair: the new pair's Bittensor adapter, then its Base adapter, as typed (R4) */
  pair?: string[];
  /** add-pair --target-block: the Bittensor block to read the deploy's AlphaVault's migration target at (R4-O round 4) */
  targetBlock?: number;
  /** set-caps: the front door's minimum deposit and deposit cap, in TAO, as typed (R4) */
  caps?: string[];
  /** set-batch-limits: the most deposits and the most redeem requests a batch holds, as typed (R6b, U4) */
  batchLimits?: string[];
}

const PAUSE_TARGETS = ["front-door", "vault", "both"] as const;
const FOR_WALLET: readonly string[] = [
  "handoff",
  "pause",
  "unpause",
  "cardinality",
  "schedule",
  "execute",
  "cancel",
  "cancel-payouts",
  "retire-pair",
  "remove-door",
  "add-hotkey",
  "remove-hotkey",
  "set-stake-hotkey",
  "set-redeem-origin",
  "set-keeper",
  "fund-reserve",
  "fund-cushion",
  "disable-bridge",
  "set-idle-buffer",
  "set-claim-gas",
  "set-caps",
  "set-batch-limits",
];
/** Task 53's fix round: the call files the sign page lacked, each --for-wallet --live and nothing else sent (R4: set-caps). */
const DIRECT_FILES: readonly string[] = ["set-keeper", "fund-reserve", "fund-cushion", "disable-bridge", "set-idle-buffer", "set-claim-gas", "set-caps", "set-batch-limits"];
/** v3.2's one-shots that check first and send only with --send (Task 53; pnpm ops reexec parses its own, Task 52w). */
const SEND: readonly string[] = ["claim", "adopt", "add-hotkey", "remove-hotkey", "park"];
/** The commands that name a hotkey (claim's is optional). */
const HOTKEY: readonly string[] = ["claim", "add-hotkey", "remove-hotkey", "set-stake-hotkey"];
/** The v3.2 commands that write the owner's or the guardian's call to a file and nothing else (v32/scheduler.ts and
 * v32/retire.ts). */
const SCHEDULER_FILES: readonly string[] = ["schedule", "execute", "cancel", "cancel-payouts", "retire-pair", "remove-door"];
/** The commands that take --as owner|guardian (pause: a v3.2 deployment's, the owner's pause instead of the guardian's). */
const AS: readonly string[] = ["cancel", "retire-pair", "remove-door", "add-hotkey", "remove-hotkey", "pause", "disable-bridge"];

/** A hotkey as typed: 32 bytes of hex, or its SS58 address (taostats shows that), as 32 bytes of hex. */
function hotkeyOf(v: string): Hex {
  let key: Hex | undefined;
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) key = v.toLowerCase() as Hex;
  else if (!v.startsWith("0x")) {
    try {
      key = decodeSs58(v);
    } catch {
      key = undefined;
    }
  }
  if (!key) throw new UsageError(`${v} is not a hotkey (32 bytes of hex, 0x…, or its SS58 address, 5…)`);
  if (/^0x0{64}$/.test(key)) throw new UsageError(`${v} is the zero hotkey`);
  return key;
}
/** The commands --max-gas-price goes with: the ones that send under no cap unless told one (UNCAPPED_COMMANDS). */
const MAX_GAS_PRICE: readonly string[] = ["pause", "unpause", "wind-down", "sweep"];

export const USAGE = `usage: pnpm ops <command> [--live]

  preflight                  read-only checks against the live chains
  rehearse                   on local forks: deploy v3, check it, and run a USDC stake through to a
                             USDC delivery (needs OPS_DEPLOYMENT=v3-…)
  rehearse --v32 [--no-build]   on local forks: deploy v3.2 from fresh keys as deploy --v32 would, verify it, run
                             the three negatives verify must fail, and the founder's funding and settings steps;
                             writes the record a live deploy needs (OPS_DEPLOYMENT=v3.2-launch)
  budget                     how much TAO and ETH to send to the test wallet; with OPS_DEPLOYMENT=v3.2-launch,
                             what to send v3.2's fresh deployers and the relayer, from its rehearsal record's gas, the
                             founder's steps and today's gas prices (public RPCs), with a 30% margin; reads only
  deploy [--new-plan]        deploy and configure (resumes after a stop), then check
  deploy --v32 [--new-plan]  deploy v3.2 from fresh deployer keys, Bittensor first (resumes after a stop);
                             needs OPS_DEPLOYMENT=v3.2-launch, the deployer keystores, the validators and
                             the keeper's address, a fresh key (OPS_V32_…); prints the three funding steps,
                             which it never sends
  verify                     read every setting back and compare it with the plan (a v3.2 deployment: its
                             code, its state through the lenses and its scheduler's classes too)
  verify --validators        read the v3.2 validators named in OPS_V32_PRIMARY_HOTKEY and
                             OPS_V32_STANDBY_HOTKEY (take, root stake, root uid); needs no deployment
  status [--user 0x…]        what is happening on both chains
  close | stake | payouts    do one keeper action now
  rewards                    the rewards waiting, a claim's cost, and whether a claim is due
  claim                      claim the rewards, only when the claim policy says so
  claim [<hotkey>] [--live] [--send]   v3.2: each listed hotkey's claim, by the claim policy (a hotkey with none of the
                             vault's stake whenever credits wait on it), checked and simulated; only --send sends, with
                             the keeper's key under the Worker's lease (the named hotkey's, or the first due)
  adopt [--live] [--send]    v3.2: the vault's surplus stake adopted (adoptStake) when it is due; only --send sends
  add-hotkey <hotkey> [--live] [--send]   v3.2: the keeper lists a hotkey on the vault (a swap's new hotkey, the standby),
                             checked and simulated; only --send sends. <hotkey>: 0x… (32 bytes) or its SS58 address
  add-hotkey <hotkey> --as owner|guardian --for-wallet --live   the owner's or the guardian's listing, as a call file
  remove-hotkey <hotkey> [--live] [--send]   v3.2: the keeper frees an empty hotkey's slot (not the stake hotkey, none of
                             the vault's stake, no credits waiting), checked and simulated; only --send sends
  remove-hotkey <hotkey> [--forfeit] --as owner|guardian --for-wallet --live   the owner's removal (any stake on it moves
                             onto the stake hotkey; --forfeit gives up its unclaimed rewards) or the guardian's (an empty
                             hotkey only), as a call file
  set-stake-hotkey <hotkey> --for-wallet --live   v3.2: the owner's switch of the stake hotkey, when it applies at once
                             (the new hotkey holds more than the stake hotkey and at least half the booked stake), as a
                             call file; otherwise it waits 48 hours: pnpm ops schedule vault setStakeHotkey <hotkey>
  park [<key>] [--live] [--send]   v3.2: Cascade's parks due a job (deliver, convert, refund, drop), as the keeper's park
                             job reads them; with a park's key and --send, that park's job
  set-redeem-origin --for-wallet --live   v3.2: the treasury's own setRedeemOrigin(DIRECT_ORIGIN), right after deploy
                             and before the first reward cut, as a call file for the treasury's Ledger account
  set-keeper <0x…> --for-wallet --live   v3.2: the owner's setKeeper on the front door and the vault (at once), one file
  fund-reserve --from <0x…> --for-wallet --live   v3.2: fundReserve() on the Bittensor adapter with what its reserve lacks,
                             from that account (anyone may)
  fund-cushion --from <0x…> --for-wallet --live   v3.2: the Bittensor adapter's token cushion, booked: approve, then
                             fundCushion, for what it lacks, from that account (anyone may; never a plain transfer)
  disable-bridge <vault|front-door|both> <bridge…> --as owner|guardian --for-wallet --live   v3.2: the incident's stop
                             (both: the vault's bridge, then the front door's; the front door's call first in the file)
  set-caps <minDeposit> <depositCap> --for-wallet --live   v3.2: the owner's setCaps on the front door, both in TAO,
                             immediate either way (a minimum-stake change, a cap direct exits consumed)
  set-batch-limits <maxDeposits> <maxRedeems> --for-wallet --live   v3.2: the owner's setBatchLimits on the front door,
                             each 1 to 50, immediate either way (set it back in the same sitting; not a lever on a
                             held batch: runbook 7.10)
  set-idle-buffer <bps> --for-wallet --live   v3.2: the owner's immediate raise of idleBufferBps (a lowering is refused:
                             it is pnpm ops schedule vault setIdleBuffer <bps>)
  set-claim-gas <gas> --for-wallet --live   v3.2: the owner's setClaimGasRequired on the vault, at once either way,
                             within 54,100,000 to 63,400,000 (runbook 3.5 step 7: a real claim that needs more)
  deliver [--user 0x…]       sell redeemed users' TAO for USDC where their minimum allows
  track <messageId>          follow a bridge message to its destination
  run                        do whatever is due, every minute, until stopped (Ctrl-C); never claims
  reexec <messageId> [--from-tx <hash> | --proof <file | 0x…> | --empty-proof] [--gas <limit>] [--live] [--send]
                             [--without-lease "<reason>"] [--ignore-monitor-outage --until <time>]
                             v3.2: re-run by hand one of Cascade's bridge messages stuck in CCIP FAILURE, with the
                             committee's results from the failed attempt (or --from-tx, or --proof, or Chainlink's
                             CCIP API when the attempt carried none). It checks and simulates first, and never sends
                             empty results. --empty-proof is the canary's test alone (runbook 3.5): one untouched
                             message of Cascade's own executed with empty results, so its OffRamp writes FAILURE.
                             Only --send sends, under the keeper Worker's lease; a check
                             takes no lease. --live names the live record, as everywhere
  wind-down [--user 0x…]     pause the front door once everything is paid out and claimed
  sweep --tao-to <SS58> --eth-to <0x…>   send the test wallet's leftovers home
  web-config                 write web/.env.local with the deployment's addresses for the site
  handoff                    a launch: write the Safe Transaction Builder files (deployments/safe/) in
                             which each final owner accepts ownership; sends nothing
  ownership                  each contract's owner and pending owner, against the plan
  pool-floors                v3.2: the front door's pool floors from each oracle pool's 30-minute harmonic-mean
                             liquidity, a block a day for 30 days: TAO/WETH a quarter of the median, WETH/USDC
                             half the lowest (reads Base's public archive RPC)
  cardinality                the oracle's pools' observation slots (reads Base), and the exact
                             increaseObservationCardinalityNext transactions to send from any wallet
  pause [front-door|vault|both] --for-wallet [--as owner]   v3.2: the guardian's pause (the owner's with --as owner), as
                             one call file for the sign page (the front door's first); unpause: the owner's
  pause [front-door|vault|both] --for-wallet --offline   v3.2: the same pause written from the record with no chain
                             read, to keep ready for an incident in which ops' RPC is down (the sign page serves it
                             with no chain read either)
  pause [front-door|vault|both]    EMERGENCY: pause as the guardian (both by default). Always the live
                             deployment: a dry run (estimate and keystore check) unless --live, which
                             sends. Signs with OPS_GUARDIAN_KEYSTORE and OPS_GUARDIAN_PASSWORD_FILE; a
                             Safe guardian gets a Transaction Builder file in deployments/safe/ instead
  unpause [front-door|vault|both]  the same, as the owner (OPS_OWNER_KEYSTORE, OPS_OWNER_PASSWORD_FILE)
  schedule <vault|front-door> <function> <args…> --for-wallet --live
                             v3.2: the owner's scheduled change (a loosening, a guardian swap, an activation,
                             a transfer of ownership), checked with the contract's scheduler, as a call file;
                             writeOffMissingStake with no amount takes the missing stake less the unlisted
  schedule <vault|front-door|both> <activateBridge|disableBridge|setPrimaryBridge> <bridge…> [--one-sided "<reason>"]
                             --for-wallet --live   v3.2: a change to the bridges (both: the vault's bridge, then the
                             front door's, in one file), refused when it would leave the two chains disagreeing
                             on the bridge; --one-sided writes it all the same, with the reason in the file
  pending [--live]           v3.2: each scheduler's items that can still run: when each is ready, who can
                             cancel it, and whether it would loosen a limit now
  execute <id> [--on vault|front-door] [--one-sided "<reason>"] --for-wallet --live   v3.2: the owner's call
                             that runs a ready item, as a call file; --on names the copy when the id is pending on
                             both chains; an activation of a bridge is refused when the two chains would disagree on
                             the bridge right after it runs, and --one-sided writes it all the same, with the reason
  cancel <id> --as owner|guardian --for-wallet --live   v3.2: drop a pending item (the guardian: an Ordinary
                             one only), as a call file; one file per chain when the id is pending on both
  cancel-payouts <key> --for-wallet --live   v3.2: the owner's cancel of the vault's payout batch with that
                             key, its list rebuilt from the vault's events, as a call file
  retire-pair --as owner|guardian --for-wallet --live   v3.2: disable the adapter pair on both chains
                             (disableBridge), as one call file; refused while the Bittensor adapter holds a park
  add-pair <bridge> <bridge> [--live]   v3.2: add a new adapter pair (the Bittensor adapter, then the Base adapter) to the
                             record, after checking its halves name each other and share the deploy's router, token
                             and selectors, so the keeper watches its parks and CCIP FAILUREs (runbook section 8)
  add-pair <bridge> <bridge> --target-block <n> [--live]   v3.2: the same for ForeverMoney's replacement pair once
                             its migration's target is cleared: the target read at Bittensor block n (an archive
                             node) is checked and recorded, as during the notice (runbook 7.7)
  remove-door <chain> <door> --as owner|guardian --for-wallet --live   v3.2: the vault's removal of that front
                             door, as a call file; refused while a payout batch of it is queued or a park from it
                             is outstanding
  stamp [vault|front-door|both] --live   v3.2: what the owner's Ledger signs, the owner's stamp as of each
                             chain's head (written to ops/stamps/sign/, and as a file for pnpm ops sign, whose
                             page has the Ledger sign it and relays it); sends nothing
  stamp vault|front-door --as-of <time> --sig <0x…> [--tip <gwei>] --live   relay that signed stamp now from
                             the relayer (OPS_RELAYER_KEYSTORE and OPS_RELAYER_PASSWORD_FILE, a fresh key, never
                             the Ledger's), after asking the contract by eth_call
  stamp --stack <days> [--every <hours>] [vault|front-door|both] --live   write the stack (ops/stamps/<chain>.json):
                             a stamp every 12 hours (or every <hours>, 12 or less) from each chain's head, for the
                             owner to sign (also as a file for pnpm ops sign, whose page adds each to the stack);
                             --every 24 only with --accept-gap-risk "<why>", which prints the risk
  stamp vault|front-door --as-of <time> --sig <0x…> --to-stack --live   add a signed stamp to its stack
  stamp --relay-due [--tip <gwei>] --live   relay each stacked stamp that is due now (for a bot)
  sign <file> [--deployment <name>]   serve a call file on http://127.0.0.1 (this computer only) as a
                             page that sends each call from MetaMask (a Ledger behind it), one per click, or
                             has the owner's Ledger sign each stamp of a v3.2 file and hands it to the relayer
                             (OPS_RELAYER_KEYSTORE) or the stack; Ctrl-C stops. The file must be for
                             OPS_DEPLOYMENT's deployment, or --deployment's

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
keeper with OPS_KEEPER_KEYSTORE and OPS_KEEPER_PASSWORD_FILE, else as the test wallet. A v3.2 record's sign with
OPS_V32_KEEPER_KEYSTORE and OPS_V32_KEEPER_PASSWORD_FILE, under the Worker's lease (OPS_KEEPER_URL); a v3.2 payout adds
at most OPS_PAYOUT_TOPUP_MAX TAO (0 by default) to its bridge fee above what its entries pay, and pays the whole fee
(the full top-up) only when the chain's conversion floor refuses a chunk's net; a park refund pays at most
OPS_PARK_REFUND_FEE_MAX TAO (0.05 by default) as its fee.
A launch (OPS_CADENCE=launch) reads its roles from OPS_LAUNCH_OWNER_BASE, OPS_LAUNCH_OWNER_BITTENSOR,
OPS_LAUNCH_GUARDIAN_BASE, OPS_LAUNCH_GUARDIAN_BITTENSOR, OPS_LAUNCH_KEEPER and OPS_LAUNCH_TREASURY.`;

/** stamp's arguments, checked: one run at a time (a relay or an addition with --sig, a stack, or the due relays), a
 * relay's time and signature for one contract, whole days and hours, and a tip in whole gwei from 1 to 1,000. */
function stampArgs(out: Args): void {
  out.target ??= "both";
  const runs = [out.sig !== undefined, out.stack !== undefined, out.relayDue === true].filter(Boolean).length;
  if (runs > 1) throw new UsageError("--stack, --relay-due and --sig are three different runs: give one");
  if (out.sig !== undefined && out.asOf === undefined) throw new UsageError("--sig needs --as-of, the time the owner signed the stamp for");
  if (out.asOf !== undefined && out.sig === undefined) throw new UsageError("--as-of goes with --sig, the owner's signature of that stamp");
  if (out.sig !== undefined && out.target === "both") throw new UsageError("--sig is for one contract: stamp vault or stamp front-door");
  if (out.asOf !== undefined && !(/^\d{1,20}$/.test(out.asOf) && BigInt(out.asOf) < 1n << 64n)) throw new UsageError(`--as-of ${out.asOf} is not a time in seconds (e.g. 1900000000)`);
  if (out.sig !== undefined && !/^0x[0-9a-fA-F]*$/.test(out.sig)) throw new UsageError(`--sig ${out.sig} is not a signature in hex (0x…)`);
  if (out.toStack && out.sig === undefined) throw new UsageError("--to-stack goes with --sig: stamp vault|front-door --as-of <time> --sig <0x…> --to-stack");
  if (out.stack !== undefined && !/^\d{1,3}$/.test(out.stack)) throw new UsageError(`--stack ${out.stack} is not a number of days (e.g. 7)`);
  if (out.every !== undefined && out.stack === undefined) throw new UsageError("--every goes with --stack");
  if (out.every !== undefined && !/^\d{1,2}$/.test(out.every)) throw new UsageError(`--every ${out.every} is not a number of hours (e.g. 12)`);
  if (out.acceptGapRisk !== undefined && (out.stack === undefined || out.every === undefined)) throw new UsageError("--accept-gap-risk goes with --stack and --every");
  // the stack's bounds, before anything is read (Task 48's review, I1): 1 to 30 days, a stamp every 12 hours or less,
  // 24 only with --accept-gap-risk
  if (out.stack !== undefined) {
    const problem = stackBoundsProblem(Number(out.stack), Number(out.every ?? STAMP_SPACING_HOURS), out.acceptGapRisk);
    if (problem) throw new UsageError(problem);
  }
  if (out.tip !== undefined && !((out.sig !== undefined && !out.toStack) || out.relayDue)) throw new UsageError("--tip goes with --sig or --relay-due, which relay");
  if (out.tip !== undefined && !(/^\d{1,4}$/.test(out.tip) && Number(out.tip) >= 1 && Number(out.tip) <= 1_000)) throw new UsageError(`--tip ${out.tip} is not a tip in whole gwei from 1 to 1000`);
}

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
    else if (a === "--v32" && (cmd === "deploy" || cmd === "rehearse")) out.v32 = true;
    else if (a === "--no-build" && cmd === "rehearse") out.noBuild = true;
    else if (a === "--validators" && cmd === "verify") out.validators = true;
    else if (a === "--user") out.users.push(value());
    else if (a === "--tao-to" && cmd === "sweep") out.taoTo = value();
    else if (a === "--eth-to" && cmd === "sweep") out.ethTo = value();
    else if (cmd === "track" && !a.startsWith("--") && !out.messageId) out.messageId = a;
    else if ((cmd === "pause" || cmd === "unpause") && (PAUSE_TARGETS as readonly string[]).includes(a) && !out.target) out.target = a as Args["target"];
    else if (a === "--for-wallet" && FOR_WALLET.includes(cmd)) out.forWallet = true;
    else if (a === "--from" && (cmd === "cardinality" || cmd === "fund-reserve" || cmd === "fund-cushion")) out.from = value();
    else if (a === "--deployment" && cmd === "sign") out.deployment = value();
    else if (cmd === "sign" && !a.startsWith("--") && !out.file) out.file = a;
    else if (a === "--max-gas-price" && MAX_GAS_PRICE.includes(cmd)) out.maxGasPrice = value();
    else if (a === "--as" && AS.includes(cmd)) {
      const who = value();
      if (who !== "owner" && who !== "guardian") throw new UsageError(`${cmd} needs --as owner or --as guardian, not --as ${who}`);
      out.as = who;
    } else if (cmd === "remove-door" && !a.startsWith("--") && (out.doorChain === undefined || out.door === undefined)) {
      if (out.doorChain === undefined) out.doorChain = a;
      else out.door = a;
    } else if (a === "--one-sided" && (cmd === "schedule" || cmd === "execute")) {
      out.oneSided = value();
      const why = !/^[\x20-\x7e]*$/.test(out.oneSided) ? "has a character outside printable ASCII" : out.oneSided.length > 200 ? "is longer than 200 characters" : "";
      if (why) throw new UsageError(`--one-sided's reason ${why}: say it in plain text`);
    } else if (cmd === "schedule" && !a.startsWith("--")) {
      if (out.contract === undefined) out.contract = a;
      else if (out.fn === undefined) out.fn = a;
      else (out.fnArgs ??= []).push(a);
    } else if (a === "--on" && cmd === "execute") {
      const on = value();
      if (on !== "vault" && on !== "front-door") throw new UsageError(`execute takes --on vault or --on front-door, not --on ${on}`);
      out.on = on;
    } else if ((cmd === "execute" || cmd === "cancel" || cmd === "cancel-payouts") && !a.startsWith("--") && !out.id) out.id = a;
    else if (cmd === "stamp" && (PAUSE_TARGETS as readonly string[]).includes(a) && !out.target) out.target = a as Args["target"];
    else if (cmd === "stamp" && a === "--as-of") out.asOf = value();
    else if (cmd === "stamp" && a === "--sig") out.sig = value();
    else if (cmd === "stamp" && a === "--to-stack") out.toStack = true;
    else if (cmd === "stamp" && a === "--stack") out.stack = value();
    else if (cmd === "stamp" && a === "--every") out.every = value();
    else if (cmd === "stamp" && a === "--accept-gap-risk") out.acceptGapRisk = value();
    else if (cmd === "stamp" && a === "--relay-due") out.relayDue = true;
    else if (cmd === "stamp" && a === "--tip") out.tip = value();
    else if (a === "--send" && SEND.includes(cmd)) out.send = true;
    else if (a === "--offline" && cmd === "pause") out.offline = true;
    else if (a === "--forfeit" && cmd === "remove-hotkey") out.forfeit = true;
    else if (HOTKEY.includes(cmd) && !a.startsWith("--") && out.hotkey === undefined) out.hotkey = hotkeyOf(a);
    else if (cmd === "set-keeper" && !a.startsWith("--") && out.newKeeper === undefined) out.newKeeper = a;
    else if (cmd === "set-idle-buffer" && !a.startsWith("--") && out.bps === undefined) out.bps = a;
    else if (cmd === "set-claim-gas" && !a.startsWith("--") && out.claimGas === undefined) out.claimGas = a;
    else if (cmd === "disable-bridge" && !a.startsWith("--")) {
      if (out.target === undefined) {
        if (!(PAUSE_TARGETS as readonly string[]).includes(a)) throw new UsageError(`disable-bridge takes vault, front-door or both first, not ${a}`);
        out.target = a as Args["target"];
      } else (out.bridges ??= []).push(a);
    }
    else if (cmd === "add-pair" && !a.startsWith("--")) (out.pair ??= []).push(a);
    else if (a === "--target-block" && cmd === "add-pair") {
      const v = value();
      if (!/^\d+$/.test(v)) throw new UsageError(`--target-block needs a block number (Bittensor's), not ${v}`);
      out.targetBlock = Number(v);
    }
    else if (cmd === "set-caps" && !a.startsWith("--")) (out.caps ??= []).push(a);
    else if (cmd === "set-batch-limits" && !a.startsWith("--")) (out.batchLimits ??= []).push(a);
    else if (cmd === "park" && !a.startsWith("--") && out.parkKey === undefined) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(a)) throw new UsageError(`${a} is not a park's key (32 bytes of hex)`);
      out.parkKey = a.toLowerCase() as Hex;
    } else throw new UsageError(`unexpected argument ${a}`);
  }
  if (cmd === "stamp") stampArgs(out);
  if (out.maxGasPrice !== undefined && !(/^(\d+)(\.\d{1,9})?$/.test(out.maxGasPrice) && Number(out.maxGasPrice) > 0)) {
    throw new UsageError(`--max-gas-price ${out.maxGasPrice} is not a gas price in gwei (e.g. 5 or 0.5)`);
  }
  if (cmd === "deploy" && out.newPlan === undefined) out.newPlan = false;
  if (cmd === "rehearse" && out.live) throw new UsageError("rehearse runs on local forks only: drop --live");
  if (out.noBuild && !out.v32) throw new UsageError("--no-build goes with rehearse --v32");
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
  if (out.offline && !out.forWallet) throw new UsageError("--offline writes the pause's call file with no chain read: add --for-wallet");
  if ((cmd === "pause" || cmd === "unpause") && out.forWallet && out.live) {
    throw new UsageError(`--for-wallet writes the call for MetaMask and sends nothing; --live sends with the keystore: drop --live`);
  }
  if (cmd === "cardinality" && out.forWallet && !out.from) throw new UsageError("cardinality --for-wallet needs --from 0x…, the account that will send the steps from MetaMask");
  if (cmd === "cardinality" && out.from && !out.forWallet) throw new UsageError("--from goes with --for-wallet");
  if (out.from && !isAddress(out.from)) throw new UsageError(`--from ${out.from} is not an address (or its checksum is wrong)`);
  // the scheduler's calls go to a file for the sign page, from the live deployment's record; ops signs none of them
  if (SCHEDULER_FILES.includes(cmd)) {
    if (cmd === "schedule" && (out.contract === undefined || out.fn === undefined)) throw new UsageError("schedule needs the contract and the function: schedule <vault|front-door> <function> <args…>");
    if (cmd === "schedule") out.fnArgs ??= [];
    if (cmd === "cancel-payouts" && !out.id) throw new UsageError("cancel-payouts needs the payout batch's key");
    if (cmd === "remove-door") {
      if (out.doorChain === undefined || out.door === undefined) throw new UsageError("remove-door needs the door's chain and address: remove-door <chain> <door>");
      if (!/^[1-9]\d{0,19}$/.test(out.doorChain) || BigInt(out.doorChain) >= 1n << 64n) throw new UsageError(`${out.doorChain} is not a chain id (e.g. 8453)`);
      if (!isAddress(out.door)) throw new UsageError(`${out.door} is not an address (or its checksum is wrong)`);
    }
    if (cmd !== "schedule" && cmd !== "retire-pair" && cmd !== "remove-door" && !out.id) throw new UsageError(`${cmd} needs the item id`);
    if (out.id !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(out.id)) throw new UsageError(`${out.id} is not ${cmd === "cancel-payouts" ? "a payout batch's key" : "an item id"} (32 bytes of hex)`);
    if (AS.includes(cmd) && !out.as) throw new UsageError(`${cmd} needs --as owner or --as guardian: who signs it`);
    if (!out.forWallet) throw new UsageError(`${cmd} writes a call for the sign page and sends nothing: add --for-wallet`);
    if (!out.live) throw new UsageError(`${cmd} --for-wallet is for the live deployment: add --live (it only reads; it sends nothing)`);
  }
  // Task 53's hotkey commands: the keeper's one-shot (--send sends), or the owner's or the guardian's call file
  if ((cmd === "add-hotkey" || cmd === "remove-hotkey" || cmd === "set-stake-hotkey") && out.hotkey === undefined) throw new UsageError(`${cmd} needs the hotkey: ${cmd} <hotkey>`);
  if (cmd === "add-hotkey" || cmd === "remove-hotkey") {
    if (out.forWallet) {
      if (!out.as) throw new UsageError(`${cmd} --for-wallet writes the owner's or the guardian's call: add --as owner or --as guardian`);
      if (!out.live) throw new UsageError(`${cmd} --for-wallet is for the live deployment: add --live (it only reads; it sends nothing)`);
      if (out.send) throw new UsageError(`${cmd} --for-wallet writes a call for the sign page and sends nothing: drop --send`);
    } else if (out.as) throw new UsageError(`--as goes with --for-wallet (a call file for the owner's or the guardian's Ledger); without them the keeper sends it`);
  }
  if (out.forfeit && !(cmd === "remove-hotkey" && out.forWallet && out.as === "owner")) throw new UsageError("--forfeit is the owner's: remove-hotkey <hotkey> --forfeit --as owner --for-wallet --live");
  if (cmd === "set-stake-hotkey") {
    if (!out.forWallet) throw new UsageError("set-stake-hotkey writes the owner's call for the sign page and sends nothing: add --for-wallet");
    if (!out.live) throw new UsageError("set-stake-hotkey --for-wallet is for the live deployment: add --live (it only reads; it sends nothing)");
  }
  if (cmd === "park" && out.send && out.parkKey === undefined) throw new UsageError("park --send needs the park's key: park <key> --send");
  if (cmd === "add-pair") {
    if ((out.pair ?? []).length !== 2) throw new UsageError("add-pair needs the new pair's two adapters: add-pair <the Bittensor adapter> <the Base adapter>");
    for (const b of out.pair ?? []) if (!isAddress(b)) throw new UsageError(`${b} is not an address (or its checksum is wrong)`);
  }
  if (DIRECT_FILES.includes(cmd)) {
    if (cmd === "set-keeper") {
      if (out.newKeeper === undefined) throw new UsageError("set-keeper needs the new keeper's address: set-keeper <0x…>");
      if (!isAddress(out.newKeeper)) throw new UsageError(`${out.newKeeper} is not an address (or its checksum is wrong)`);
    }
    if ((cmd === "fund-reserve" || cmd === "fund-cushion") && !out.from) throw new UsageError(`${cmd} needs --from <0x…>, the account that will send it from MetaMask`);
    if (cmd === "disable-bridge") {
      if (out.target === undefined) throw new UsageError("disable-bridge needs the contract and its bridge: disable-bridge <vault|front-door|both> <bridge…>");
      const n = out.target === "both" ? 2 : 1;
      if ((out.bridges ?? []).length !== n) throw new UsageError(out.target === "both" ? "disable-bridge both needs two bridges: the vault's, then the front door's" : `disable-bridge ${out.target} needs one bridge`);
      for (const b of out.bridges ?? []) if (!isAddress(b)) throw new UsageError(`${b} is not an address (or its checksum is wrong)`);
      if (!out.as) throw new UsageError("disable-bridge needs --as owner or --as guardian: who signs it");
    }
    if (cmd === "set-caps") {
      if ((out.caps ?? []).length !== 2) throw new UsageError("set-caps needs the minimum deposit and the deposit cap, in TAO: set-caps <minDeposit> <depositCap>");
      for (const v of out.caps ?? []) if (!/^\d+(\.\d{1,18})?$/.test(v)) throw new UsageError(`set-caps: ${v} is not an amount of TAO (e.g. 0.06)`);
    }
    // R6b (U4): CascadeFrontDoor _setBatchLimits takes each from 1 to MAX_ENTRIES (50)
    if (cmd === "set-batch-limits") {
      if ((out.batchLimits ?? []).length !== 2) throw new UsageError("set-batch-limits needs the most deposits and the most redeem requests a batch holds, each 1 to 50: set-batch-limits <maxDeposits> <maxRedeems>");
      for (const v of out.batchLimits ?? []) if (!/^\d{1,2}$/.test(v) || Number(v) < 1 || Number(v) > 50) throw new UsageError(`set-batch-limits: ${v} is not a whole number from 1 to 50`);
    }
    if (cmd === "set-idle-buffer" && !(out.bps !== undefined && /^\d{1,4}$/.test(out.bps) && Number(out.bps) <= 1_000)) throw new UsageError(`set-idle-buffer needs a whole number of bps (0 to 1000), not ${out.bps ?? "nothing"}`);
    // R5 Minor 3: the vault's bounds, MIN_CLAIM_GAS and MAX_CLAIM_GAS (the file command and the sign page check them again)
    if (cmd === "set-claim-gas" && !(out.claimGas !== undefined && /^\d{8}$/.test(out.claimGas) && Number(out.claimGas) >= 54_100_000 && Number(out.claimGas) <= 63_400_000)) {
      throw new UsageError(`set-claim-gas needs a whole number of gas within the vault's bounds, 54,100,000 to 63,400,000, not ${out.claimGas ?? "nothing"}`);
    }
    if (!out.forWallet) throw new UsageError(`${cmd} writes a call for the sign page and sends nothing: add --for-wallet`);
    if (!out.live) throw new UsageError(`${cmd} --for-wallet is for the live deployment: add --live (it only reads; it sends nothing)`);
  }
  if (cmd === "set-redeem-origin") {
    if (!out.forWallet) throw new UsageError("set-redeem-origin writes the treasury's call for the sign page and sends nothing: add --for-wallet");
    if (!out.live) throw new UsageError("set-redeem-origin --for-wallet is for the live deployment: add --live (it only reads; it sends nothing)");
  }
  // deliver sends a transaction naming each user
  const bad = cmd === "deliver" ? out.users.find((u) => !isAddress(u, { strict: false })) : undefined;
  if (bad) throw new UsageError(`--user ${bad} is not an address`);
  return out;
}

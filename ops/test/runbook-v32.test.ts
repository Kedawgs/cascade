import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.ts";
import { parseReexecArgs } from "../src/keeper/core/v32/reexec-hand.ts";
import { monitorOverride } from "../src/keeper/core/hold.ts";
import { parseKeeperCommand, takeHandFlags } from "../src/keeper/lease-client.ts";

// Every command docs/runbook-v3.2.md writes exists as written (Task 53): each `pnpm ops …` line, in a code block or in
// a line's code, through the parser the CLI itself runs it through (ops' parseArgs after the hand run's own flags;
// pnpm ops reexec's and pnpm ops keeper's own parsers); each keeper script (pnpm keeper:…, pnpm config:from-record) by
// the flags its source reads; each pnpm wrangler line by the few the runbook may use, deploy and secret naming their
// environment (without --env, wrangler would make a stray Worker). An unknown command or flag fails. Placeholders the
// runbook means literally (<hotkey>, <messageId>, …) stand for a valid value of their kind; any other <…> fails.

const RUNBOOK = new URL("../../docs/runbook-v3.2.md", import.meta.url);
const KEEPER = new URL("../../keeper/", import.meta.url);

/** What each placeholder stands for: a value its parser takes. */
const PLACEHOLDERS: Record<string, string> = {
  "<messageId>": `0x${"ab".repeat(32)}`,
  "<id>": `0x${"cd".repeat(32)}`,
  "<key>": `0x${"ef".repeat(32)}`,
  "<hash>": `0x${"12".repeat(32)}`,
  "<hotkey>": `0x${"5e".repeat(32)}`,
  "<primary>": `0x${"5f".repeat(32)}`,
  "<standby>": `0x${"5a".repeat(32)}`,
  "<bridge>": `0x${"b1".repeat(20)}`,
  "<door>": `0x${"d0".repeat(20)}`,
  "<0x…>": `0x${"a1".repeat(20)}`,
  "<chain>": "8453",
  "<file>": "file.json",
  // two kinds of time (the review's Minor 5): --as-of takes unix seconds, --until a UTC time in ISO form
  "<unix-time>": "1900000000",
  "<utc-time>": "2027-01-18T14:05Z",
  "<sig>": `0x${"aa".repeat(65)}`,
  "<days>": "7",
  "<gwei>": "5",
  "<limit>": "3000000",
  "<bps>": "240",
  "<rao>": "1000000000",
  "<reason>": "the reason",
  // R4: the front door's caps in TAO (set-caps), and a period in seconds (setRewardVesting)
  "<minDeposit>": "0.06",
  "<depositCap>": "45",
  "<seconds>": "2592000",
  // R4-O round 4: the deploy's AlphaVault, and a Bittensor block
  "<alpha-vault>": `0x${"af".repeat(20)}`,
  "<block>": "6900736",
  // a hold's public id (pnpm hold:clear)
  "<hold-id>": "h_3f9a0c1e",
  // R5 Minor 3: a claimGasRequired within the vault's bounds (pnpm ops set-claim-gas)
  "<gas>": "58000000",
  // R6b (U4): the front door's batch limits (pnpm ops set-batch-limits), each 1 to 50
  "<maxDeposits>": "50",
  "<maxRedeems>": "50",
};

/** A command line as a shell splits it: words, a double-quoted run one word. */
function words(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]);
  return out;
}

/** Each placeholder replaced; undefined (with why) when one is unknown. */
function filled(argv: string[]): { argv: string[] } | { problem: string } {
  const out: string[] = [];
  for (const w of argv) {
    let v = w;
    for (const [p, x] of Object.entries(PLACEHOLDERS)) v = v.split(p).join(x);
    if (/<[^>]*>/.test(v)) return { problem: `an unknown placeholder in ${w}` };
    out.push(v);
  }
  return { argv: out };
}

/** Every pnpm command the runbook writes: each line of a code block, and each line's code, that starts with "pnpm ". */
export function runbookCommands(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) {
      inBlock = !inBlock;
      continue;
    }
    if (inBlock) {
      if (line.trim().startsWith("pnpm ")) out.push(line.trim());
      continue;
    }
    for (const m of line.matchAll(/`(pnpm [^`]+)`/g)) out.push(m[1].trim());
  }
  return out;
}

/** The flags a keeper script's source reads (scripts/io.ts argsOf's valued list, and a.flag), by script file. */
function scriptFlags(file: string): { valued: Set<string>; flags: Set<string> } {
  const src = readFileSync(new URL(`scripts/${file}`, KEEPER), "utf8");
  const valued = new Set<string>();
  for (const m of src.matchAll(/argsOf\([^)]*?\[([^\]]*)\]/gs)) for (const f of m[1].matchAll(/"(--[a-z-]+)"/g)) valued.add(f[1]);
  const flags = new Set([...src.matchAll(/\.flag\("(--[a-z-]+)"\)/g)].map((m) => m[1]));
  return { valued, flags };
}

/** The keeper package's scripts, by name (package.json). */
const keeperScripts = (): Record<string, string> => (JSON.parse(readFileSync(new URL("package.json", KEEPER), "utf8")) as { scripts: Record<string, string> }).scripts;
/** The monitor's (R4-O round 4: pnpm alpha-target, run from indexer/), and the flags its owner scripts read
 * (scripts/d1.ts parseArgs(argv, [values], [flags])). */
const INDEXER = new URL("../../indexer/", import.meta.url);
const indexerScripts = (): Record<string, string> => (JSON.parse(readFileSync(new URL("package.json", INDEXER), "utf8")) as { scripts: Record<string, string> }).scripts;
function indexerScriptFlags(file: string): { valued: Set<string>; flags: Set<string> } {
  const src = readFileSync(new URL(`scripts/${file}`, INDEXER), "utf8");
  const m = /parseArgs\(argv, \[([^\]]*)\], \[([^\]]*)\]\)/.exec(src);
  const names = (list: string | undefined) => new Set([...(list ?? "").matchAll(/"([a-z-]+)"/g)].map((n) => `--${n[1]}`));
  return { valued: names(m?.[1]), flags: names(m?.[2]) };
}

/** The secrets the Worker reads (wrangler.jsonc's header names them), the only ones a runbook line may put. */
const SECRETS = ["KEEPER_PRIVATE_KEY", "CONTROL_TOKEN_SHA256", "BASE_RPC_URL_SECRET", "BASE_LOGS_RPC_URL_SECRET", "BITTENSOR_RPC_URL_SECRET"];

/** A hand run's flags off `argv` (takeHandFlags), with --until's value checked as the run checks it (an ISO UTC time;
 * judged an hour before itself, so only its form decides): the review's Minor 5. */
function handFlags(argv: string[]): string[] {
  const t = takeHandFlags(argv);
  if (t.ignoreMonitorOutageUntil !== undefined) monitorOverride(t.ignoreMonitorOutageUntil, Date.parse(t.ignoreMonitorOutageUntil) - 3_600_000);
  return t.argv;
}

/** Why `line` is not a command that exists as written, or undefined. */
export function commandProblem(line: string): string | undefined {
  const all = words(line);
  if (all[0] !== "pnpm" || all.length < 2) return "not a pnpm command";
  const f = filled(all.slice(1));
  if ("problem" in f) return f.problem;
  const [script, ...rest] = f.argv;
  try {
    if (script === "ops") {
      if (rest[0] === "reexec") {
        parseReexecArgs(handFlags(rest).slice(1));
        return undefined;
      }
      if (rest[0] === "keeper") {
        parseKeeperCommand(rest.slice(1));
        return undefined;
      }
      parseArgs(handFlags(rest));
      return undefined;
    }
    if (script === "wrangler") {
      const [sub, ...args] = rest;
      const env = args.indexOf("--env");
      const envOk = env >= 0 && ["test", "production"].includes(args[env + 1] ?? "");
      if (sub === "logout") return args.length ? `wrangler logout takes nothing more: ${args.join(" ")}` : undefined;
      if (sub === "deploy") return envOk && args.length === 2 ? undefined : "wrangler deploy must name its environment, and nothing else: --env test or --env production";
      if (sub === "secret") {
        if (args[0] !== "put" || !SECRETS.includes(args[1] ?? "")) return `wrangler secret: only put of one of the Worker's secrets (${SECRETS.join(", ")})`;
        return envOk && args.length === 4 ? undefined : "wrangler secret put must name its environment: --env test or --env production";
      }
      return `wrangler ${sub} is no command this runbook uses`;
    }
    const scripts = keeperScripts();
    const ofIndexer = !scripts[script] && script in indexerScripts();
    const body = ofIndexer ? indexerScripts()[script] : scripts[script];
    if (!body || !/^node .*scripts\/[a-z-]+\.ts/.test(body)) return `pnpm ${script} is no script of keeper/package.json's`;
    const file = /scripts\/([a-z-]+\.ts)/.exec(body)?.[1] as string;
    if (rest[0] !== "--") return `pnpm ${script} needs -- before its flags`;
    const { valued, flags } = ofIndexer ? indexerScriptFlags(file) : scriptFlags(file);
    const a = rest.slice(1);
    for (let i = 0; i < a.length; i++) {
      if (!a[i].startsWith("--")) continue;
      if (valued.has(a[i])) {
        if (!a[i + 1] || a[i + 1].startsWith("--")) return `${a[i]} needs a value`;
        i++;
      } else if (!flags.has(a[i])) return `${a[i]} is no flag of scripts/${file}`;
    }
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

describe("docs/runbook-v3.2.md: every command exists as written (Task 53)", () => {
  const commands = runbookCommands(readFileSync(RUNBOOK, "utf8"));

  it("it writes many commands, every kind among them", () => {
    expect(commands.length).toBeGreaterThan(60);
    for (const start of ["pnpm ops reexec", "pnpm ops keeper", "pnpm ops claim", "pnpm ops pause", "pnpm ops schedule", "pnpm keeper:new-key", "pnpm config:from-record", "pnpm wrangler deploy", "pnpm ops add-pair", "pnpm ops set-caps", "pnpm ops cancel-payouts"]) {
      expect(commands.some((c) => c.startsWith(start)), start).toBe(true);
    }
  });

  it("each command, its subcommand and every flag are the CLI's (and the keeper's scripts')", () => {
    const problems = commands.map((c) => [c, commandProblem(c)] as const).filter(([, p]) => p !== undefined);
    expect(problems).toEqual([]);
  });

  it("the check fails on what doesn't exist: an unknown command, an unknown flag, a missing value, a stray Worker, an unknown placeholder", () => {
    for (const bad of [
      "pnpm ops frobnicate --live",
      "pnpm ops claim <hotkey> --live --frobnicate",
      "pnpm ops reexec <messageId> --live --sendd",
      "pnpm ops keeper stop",
      "pnpm ops add-hotkey --live --send",
      "pnpm ops schedule vault setIdleBuffer <bps> --live",
      "pnpm ops run --live --without-lease \"x\"",
      "pnpm keeper:new-key -- --env production --frobnicate",
      "pnpm keeper:new-key -- --env",
      "pnpm keeper:nothing -- --env production",
      "pnpm wrangler deploy",
      "pnpm wrangler secret put KEEPER_PRIVATE_KEY",
      "pnpm ops track <nothing>",
      // --until wants an ISO time, never unix seconds; --as-of unix seconds, never an ISO time
      "pnpm ops reexec <messageId> --live --send --ignore-monitor-outage --until <unix-time>",
      "pnpm ops stamp vault --as-of <utc-time> --sig <sig> --live",
    ]) {
      expect(commandProblem(bad), bad).toBeDefined();
    }
    // and passes what does
    for (const good of ["pnpm ops claim <hotkey> --live --send", "pnpm keeper:new-key -- --env production --put-secret", "pnpm wrangler deploy --env production"]) {
      expect(commandProblem(good), good).toBeUndefined();
    }
  });

  it("R5's off-chain review: the canary's gas table compares like with like; step 11's lane check, step 7's tools and threshold, step 9's probes, the adoption's place and the executor's 8 hours are as ruled", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const canary = flat(text.slice(text.indexOf("### 3.5 "), text.indexOf("### 3.6 ")));
    // I-1: a delivery's receiver share is its whole transaction less a token-only execution on the same OffRamp
    expect(canary).toContain("its receiver's share: the OffRamp execution's gas used less a token-only execution's on the same OffRamp (about 283,000 on Bittensor's, 278,000 on Base's, read 2026-11-15)");
    expect(canary).toContain("under 712,658 for one deposit");
    expect(canary).toContain("under 180,200 (85% of 212,000) for one payout");
    expect(canary).not.toContain("gas used under 712,658 for one deposit (the fork's 412,658, plus 300,000 for the live precompile's calls)");
    expect(canary).not.toContain("gas used under 85% of the limit");
    // Minor 2: when the executor is on time, the line and the monitor's email are the lane's check
    expect(canary).toContain("the keeper's `CCIP FAILURE … The lane does not wait for it` line and the monitor's `ccip.failure` email are the check");
    // Minor 3: no explorer routes; the sweep by cast, the claim gas by the new command
    expect(canary).not.toContain("Write Contract");
    expect(canary).toContain('cast send <bitAdapter> "sweepSurplus()"');
    expect(canary).toContain("pnpm ops set-claim-gas <gas> --for-wallet --live");
    // Minor 4: the chain's threshold at a canary's stake, and what passes then
    expect(canary).toContain("RootClaimableThreshold");
    expect(canary).toContain("`RewardsClaimed` with 0");
    // the contracts' 63/64 fix: the claim row and step 7 compare against MIN_CLAIM_GAS 54,100,000
    expect(canary).toContain("| A claim | a 57,000,000 limit; the vault's `claimGasRequired` 55,000,000; `MIN_CLAIM_GAS` 54,100,000 | step 7 |");
    expect(canary).toContain("It refuses anything outside 54,100,000 to 63,400,000");
    expect(canary).not.toContain("53,200,000) plus the vault's own work");
    expect(canary).toContain("the vault's `MIN_CLAIM_GAS`, 54,100,000, is that need at the call's 63/64 forwarding");
    // Minor 5: the uncapped call first, which must succeed; the burn question stays with the GAS USED figures
    expect(canary).toContain("the same call with no gas limit, which must succeed");
    expect(canary).toContain("whether a starved removal burns its gas stays with step 4's `GAS USED` line and step 10's gas used");
    // ... at the chain's minimum stake, since a partial unstake below it is refused whatever the gas
    expect(canary).toContain('"removeStake(bytes32,uint256,uint256)" <primary> 2000000 0 --from <vault> --rpc-url');
    expect(canary).toContain('"removeStake(bytes32,uint256,uint256)" <primary> 2000000 0 --from <vault> --gas-limit 60000');
    expect(canary).not.toContain("<primary> 1000000 0");
    // Minor 6: the adoption, then the probes, before the direct exit empties the shares and the vault's position
    const step = (n: number, title: string) => canary.indexOf(`${n}. **${title}`);
    expect([step(7, "A claim"), step(8, "An adoption"), step(9, "The staking precompile"), step(10, "A direct exit"), step(11, "The live empty-proof test")].every((i, k, all) => i > -1 && (k === 0 || i > all[k - 1]))).toBe(true);
    expect(canary).toContain("what is still vesting when step 10 takes the supply to 0 belongs to no holder");
    // Minor 8: the executor's 8 hours are Chainlink's docs' word
    const s6 = flat(text.slice(text.indexOf("## 6. "), text.indexOf("## 7. ")));
    expect(s6).toContain("Chainlink's docs say its executor retries a FAILURE for up to 8 hours");
    expect(flat(text)).not.toContain("wait (Chainlink's executor retries a FAILURE for up to 8 hours)");
  });

  it("R5's contracts review, for the runbook: step 4 a day after step 1's mint, the auto-claim watch at steps 3 to 7, the treasury key's signature before the deploy", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const canary = flat(text.slice(text.indexOf("### 3.5 "), text.indexOf("### 3.6 ")));
    // 1: the door hold defers a redeem delivered within a day of the mint
    expect(canary).toContain("4. **A redeem, 0.03 TAO, through an unstake, a day after step 1's mint.** Wait until at least 24 hours after step 1's delivery minted your shares");
    expect(canary).toContain("a redeem delivered sooner is deferred (`RedeemDeferred`): no payout comes, the request fee is spent");
    // 2: the surplus and the primary's stake at each of steps 3 to 7; a rise with no claim stops the canary
    expect(canary).toContain("At each of steps 3 to 7, before step 8's gift, record the vault's surplus stake and the primary hotkey's stake");
    expect(canary).toContain('cast call <vaultLens> "surplusStakeRao()(uint256)"');
    expect(canary).toContain('"getStake(bytes32,bytes32,uint256)(uint256)" <primary> <vaultColdkey> 0');
    expect(canary).toContain("**If it happens, stop:** record both readings and when, and the founder decides before any other people's money.");
    expect(canary.indexOf("**The auto-claim watch**")).toBeLessThan(canary.indexOf("1. **A deposit, 0.04 TAO**"));
    // 3: the treasury signs a message on both chains before the deploy
    const before = flat(text.slice(text.indexOf("### 3.1 "), text.indexOf("### 3.2 ")));
    expect(before).toContain("The treasury `0x34D1f7DC8Cb62280d0bc617b784Bd2c4668809f6` (Ledger account 3)");
    expect(before).toContain("on Bittensor EVM (chain 964), then on Base (8453)");
    expect(before).toContain("It is free: no transaction.");
  });

  it("R6, for the runbook: section 8 switches the vault's primary first (D); 3.5 deposits only from the Ledger's own accounts (B); 7.5 the write-off's check and gas (C); 7.2 the block floor's hours (G); 7.8 a pause drops a redeem-only batch's requests (I-2)", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const between = (a: string, b: string) => flat(text.slice(text.indexOf(a), text.indexOf(b)));
    const rails = between("## 8. Changing the rails", "## 9. ");
    expect(rails).toContain("Disable the old pair, the front door first; then switch the primaries, the vault first.");
    expect(rails).toContain("an ordered file: sign the vault's call first). **Why the vault first:** while the vault's primary is disabled it has no way to pay, so it turns away every unstake a batch brings");
    expect(rails).not.toContain("sign the front door's call first");
    expect(between("### 3.5 ", "### 3.6 ")).toContain("**Deposit only from your Ledger's own accounts, and never `depositFor` a contract address:**");
    const stake = between("### 7.5 ", "### 7.6 ");
    expect(stake).toContain("`pnpm ops execute <id> --for-wallet --live` reads it again and refuses if unlisted stake grew meanwhile");
    expect(stake).toContain("**Don't count on the vault's own `WriteOffTooLarge`:**");
    expect(stake).toContain("**The execute goes with a 47,000,000 gas limit set by its file**");
    expect(between("### 7.2 ", "### 7.3 ")).toContain("those blocks are in after about 40 hours of a 48-hour item");
    expect(between("### 7.2 ", "### 7.3 ")).toContain("lets it run in the first block after the resume");
    expect(between("### 7.8 ", "### 7.9 ")).toContain("A batch of unstakes alone is still delivered (it carries no tokens to convert), so its requests are dropped");
    expect(between("### 7.10 ", "### 7.11 ")).toContain("**`batch.deposits_full`**");
  });

  it("R6b (U1, U2), for the runbook: section 4's claim round (every staked hotkey together, 2 days before the schedule ends, whatever a claim costs), and a stranger's claim only once rewards have vested", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const between = (a: string, b: string) => flat(text.slice(text.indexOf(a), text.indexOf(b)));
    const day = between("## 4. Day to day", "**The stamp rule");
    expect(day).toContain("**The keeper claims every staked hotkey in one round:** 2 days before the claim schedule ends");
    expect(day).toContain("even a standby whose own claim costs more than waits on it");
    expect(day).toContain("Only the keeper may claim while rewards still vest");
    expect(day).not.toContain("the monthly claim on a small vault");
    expect(between("## 5. The keeper's one-shots by hand", "## 6. ")).toContain("`claim`: each listed hotkey by the claim round (section 4)");
    expect(between("### 7.5 ", "### 7.6 ")).toContain("the claim is the keeper's; anyone's only once rewards have vested and 7 days have passed since its last claim");
  });

  it("R6b, for the runbook: under a root hold the guardian pauses the front door's deposits and the founder funds the buffer directly; 7.7 says what stops the notice's conversions", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const between = (a: string, b: string) => flat(text.slice(text.indexOf(a), text.indexOf(b)));
    const hold = between("### 7.6 ", "### 7.7 ");
    expect(hold).not.toContain("The buffer fills from deposits and claims");
    expect(hold).toContain("With the front door's deposits paused (below), the buffer fills only from direct deposits: claims re-stake, and nothing unstakes into it.");
    expect(hold).toContain("**Take no deposits through Base while the hold lasts**");
    expect(hold).toContain("**[Ledger: guardian]** Pause the front door's deposits: `pnpm ops pause front-door --for-wallet`, then sign");
    expect(hold).toContain('`cast send <vault> "depositDirect()" --value <amount>');
    const notice = between("### 7.7 ", "### 7.8 ");
    expect(notice).not.toContain("A hold doesn't stop the conversions;");
    expect(notice).toContain('A monitor hold doesn\'t stop the conversions; `pnpm ops keeper stop --reason "<reason>"` does.');
  });

  it("R6b (U4), R7 (L1, L2, L3), for the runbook: 7.10's deposits_blocked is a full batch left open; the door's rule (half the limit at once, unstakes alone wait even at the cap); the levers are minDeposit or the pause, set back in the same sitting; stop deposits by the pause or a cap of 0", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const s = flat(text.slice(text.indexOf("### 7.10 "), text.indexOf("### 7.11 ")));
    expect(s).not.toContain("keep closing");
    expect(s).toContain("the open batch is full by the front door's own rule, so it can close at once, and it has stayed open for 7 readings in a row");
    expect(s).toContain("So a batch at half its limit can be closed at once, and a batch of unstakes alone waits for its interval, even at the cap.");
    // L2: the setBatchLimits fallback added nothing (a batch with no room is closable already)
    expect(s).not.toContain("pnpm ops set-batch-limits 1 <maxRedeems>");
    expect(s).toContain("The levers are the minimum deposit and the deposit pause, not the batch limits: `set-batch-limits` adds nothing here");
    expect(s).toContain("**Set any limit you change for this back in the same sitting**");
    expect(s).toContain("**To stop deposits**, for any reason: the guardian's pause (`pnpm ops pause front-door --for-wallet`) or a `depositCap` of 0");
    expect(s).toContain("never a huge `minDeposit`: setCaps refuses one above the 5,000 TAO batch limit");
  });

  it("R7, for the runbook: 7.6's direct deposit warns of the redeem origin and the buffer target (L5); section 4's vesting sentence (L6); section 5's back-off (M1); section 8's redeem hold (L4)", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const between = (a: string, b: string) => flat(text.slice(text.indexOf(a), text.indexOf(b)));
    const hold = between("### 7.6 ", "### 7.7 ");
    expect(hold).toContain("**Raise `idleBufferBps` first** (the `set-idle-buffer` step above) to the buffer you want, and deposit only the shortfall: `stakeIdle` stakes whatever idle TAO is above the buffer's target");
    expect(hold).toContain("**Use an account with no shares through Base:** `depositDirect` sets the sender's redeem origin to direct (Bittensor)");
    const day = between("## 4. Day to day", "**The stamp rule");
    expect(day).not.toContain("never below the gap between claims");
    expect(day).toContain("A shorter vesting brings the claims with it, not the other way round: the claim round comes 2 days before each claim schedule ends (half the period for a vesting of 4 days or less)");
    expect(day).toContain("(each last claimed more than 5 days before the schedule's restart)");
    const hand = between("## 5. The keeper's one-shots by hand", "## 6. ");
    expect(hand).toContain("Each repeat doubles the hold, 2, 4, 8, then 16 days at most (a `CLAIM REVERTED AGAIN` line each time).");
    expect(hand).not.toContain("burns one claim's fee a day");
    expect(between("## 8. Changing the rails", "## 9. ")).toContain("the keeper holds a batch of unstake requests alone on Base");
  });

  it("R8, for the runbook: section 5's way out of a claim's hold (L-A) and what ends one (L-B, M-A); section 4's short vesting (L-E); section 8's deposits never held past the max wait (L-C); 7.10's seven readings, the close that must land, batch.cancel_churn (the contracts review's L-1)", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const between = (a: string, b: string) => flat(text.slice(text.indexOf(a), text.indexOf(b)));
    const hand = between("## 5. The keeper's one-shots by hand", "## 6. ");
    expect(hand).toContain("and so does one whose receipt came late and reverted (R8, M-A)");
    expect(hand).toContain("A hold ends early only once a claim on that hotkey has paid (its last claim moves past the hold), never on its credits, which rise every epoch and which an unstake can lower (R7 M1, R8 L-B), or once the vault's `claimGasRequired` changes (R8, L-A).");
    expect(hand).toContain("**Once you have fixed the cause, claim by hand** rather than wait out the hold: `pnpm ops claim <hotkey> --live --send` ignores the hold, and a claim that pays ends it");
    expect(hand).toContain("a PC `run` keeps them in the process, so a restart forgets them");
    const day = between("## 4. Day to day", "**The stamp rule");
    expect(day).not.toContain("so every staked hotkey is then claimed about every vesting period less that lead");
    expect(day).toContain("so the first staked hotkey in the vault's list is then claimed about every vesting period less that lead");
    expect(day).toContain("each other staked hotkey is claimed about every 5 days and one such period more (every 6 days at a 4-day vesting, every 8 at 6 days; R8, L-E)");
    const rails = between("## 8. Changing the rails", "## 9. ");
    expect(rails).toContain("A batch with deposits and unstake requests waits so only until its max wait (24 hours at launch; the line names when), then closes with a `REDEEMS DEFERRED` line");
    expect(rails).toContain("A request on Base needs only its fee, no shares, so anyone's could otherwise hold every deposit");
    const full = between("### 7.10 ", "### 7.11 ");
    expect(full).not.toContain("The keeper closes a full batch at once");
    expect(full).toContain("**What protects a full batch is a close that lands while it is full**");
    expect(full).toContain("the site offers \"Send the batch, then stake\" when a stake has no room and the batch can close");
    expect(full).toContain("**`batch.cancel_churn`** (a warning): one address has cancelled deposits in the open batch 3 times, or half its `maxBatchValue` in all");
  });

  it("R9, R10, for the runbook: section 8 says nothing closes during a ForeverMoney pause or notice, a batch of deposits alone too, so the three payouts-closed rules are the vault's primary disabled alone (R9 L-4, R10); the keeper's read of canSendPayouts() is the vault's own call (L-3); 7.10's close sent first waits for the keeper's free one, closable the same way with no gap over 65 s (M-2, M-A), and never claims a keeper round was seen (L-A)", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const between = (a: string, b: string) => flat(text.slice(text.indexOf(a), text.indexOf(b)));
    const rails = between("## 8. Changing the rails", "## 9. ");
    expect(rails).toContain(
      "During a ForeverMoney pause or migration notice nothing closes at all, whatever the batch holds, a batch of deposits alone too (the keeper says `AlphaVault is paused or migrating`; the notice's one close aside, 7.7). The CCIP adapter's `canSendPayouts()` reads false only then, or once a migration has executed (the keeper reads the AlphaVault unhealthy then too, so nothing closes either; R11, N-1), so with it these three rules (a batch of unstake requests alone held, a batch of deposits alone sent, the 24-hour rule for a batch with deposits and unstake requests) apply only while the vault's primary is disabled on the vault alone (R9, L-4; R10).",
    );
    // R10: no blanket "none of this" over the rules before it
    expect(rails).not.toContain("None of this applies");
    expect(rails).toContain(
      "The keeper's read of `canSendPayouts()` is the vault's own call: from the vault, with the 150,000 gas the vault gives it (`RAIL_VIEW_GAS`); a revert, Bittensor's EVM halting it (`evm error`, `evm fatal`) or an odd answer reads open, and a node's own error fails the round, which reads again (R8, L-D; R9, L-3).",
    );
    const full = between("### 7.10 ", "### 7.11 ");
    // R12b: "in between" (a deposit and its cancel within a round) is gone under the cancel cooldown
    expect(full).toContain(
      "Any close that lands while it is full commits the holder: the keeper's, a depositor's own, or yours (`pnpm ops close --live` while it reads full).",
    );
    expect(full).toContain(
      "For a depositor's own, the site offers \"Send the batch, then stake\" when a stake has no room and the batch can close, once reads half a minute apart have found it closable the same way (full, or due by time alone), none of them more than 65 seconds after the one before (R9, M-2; R10, M-A). The wait gives the keeper's next round, which sends a full batch for free, a chance to come first (the site says it normally leaves on its own). It doesn't show the keeper isn't sending it, as its rounds are a minute apart; a wait over a minute would let a holder who cancels before each round start it again every time (R10, L-A).",
    );
    expect(full).not.toContain("still find it there");
  });

  it("R11, for the runbook: 7.10's time-full flapping residual (R10, L-2); 7.5's write-off: the capped read before it executes, the guardian's cancel, execute's own refusal, re-listing after one, at most 2 hotkeys listed, stake.writeoff_bound_off; the canary's read-only checks first; section 8's one-word check of a new bridge (ChatGPT r3)", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const between = (a: string, b: string) => flat(text.slice(text.indexOf(a), text.indexOf(b)));
    const full = between("### 7.10 ", "### 7.11 ");
    // R12b: since the cancel cooldown the flap takes a second address's aged deposit
    expect(full).toContain(
      "The clock starts again too each time the batch changes how it can close, so a holder who moves a batch due by time to full and back within half a minute (a deposit to half its limit, then, since R11, a second address's aged deposit cancelled before the keeper's next round) keeps the site's offer from ever coming for it: the two-address flap above, answered the same way, by a close that lands while it is full (R10, L-2).",
    );
    const stake = between("### 7.5 ", "### 7.6 ");
    expect(stake).toContain(
      'cast call 0x0000000000000000000000000000000000000805 "getTotalColdkeyStakeOnSubnet(bytes32,uint256)(uint256)" <vaultColdkey> 0 --gas-limit 45021000 --rpc-url https://lite.chain.opentensor.ai',
    );
    expect(stake).toContain("**If it fails, the vault's own read fails too and reads 0: the write-off would run with no bound.** **[Ledger: guardian]** Cancel the item:");
    expect(stake).toContain("pnpm ops cancel <id> --as guardian --for-wallet --live");
    expect(stake).toContain("pnpm ops execute already refuses while its own read of the unlisted stake (the lens's, uncapped) fails");
    expect(stake).toContain(
      "**After any write-off, re-listing a hotkey needs a privileged key and a free slot.** Nothing reads missing then, so no stranger can list one: only the owner, guardian or keeper (`addHotkey`), and only into a free slot. With 3 hotkeys listed the last slot is reserved (`SlotReserved`), for every caller, and only the owner can remove a staked hotkey. **Keep at most 2 hotkeys listed**",
    );
    expect(stake).toContain("**If the monitor pages `stake.writeoff_bound_off`**");
    const canary = between("### 3.5 ", "### 3.6 ");
    expect(canary).toContain("**Read-only checks first** (nothing is signed; before step 1).");
    expect(canary).toContain('"method":"state_getRuntimeVersion"');
    expect(canary).toContain("cast call 0x0000000000000000000000000000000000000807 0x658faa385070e074c85bf6b568cf0555a336e39c4086c4d5f43b7e6dff8a04f6 --rpc-url https://lite.chain.opentensor.ai");
    expect(canary).toContain("cast call 0x0000000000000000000000000000000000000807 0x658faa385070e074c85bf6b568cf05555f3bb7bcd0a076a48abf8c256d221721 --rpc-url https://lite.chain.opentensor.ai");
    expect(canary).toContain("`MAX_STAKING_HOTKEYS`");
    expect(canary).toContain("the write-off read's gas, against the vault's 45,000,000 cap");
    // R12d: of the vault's primary bridge as read now, and the write-off read asked by eth_call too
    expect(canary).toContain("`canSendPayouts()` of the vault's primary bridge as read now (the record's Bittensor adapter at launch; R12d: a line names any other) true, asked from the vault with 150,000 gas");
    expect(canary).toContain("and the same read by eth_call, which must answer one word (R12d: an address with no precompile would price at 0 gas)");
    expect(canary).toContain("the AlphaVault's `isPaused()`, `migrationReadyAt()` and `migrationFinished()`, each answering within 30,000 gas");
    const rails = between("## 8. Changing the rails", "## 9. ");
    expect(rails).toContain(
      "pnpm ops schedule checks it before it writes an activation on the vault, or the vault's `setPrimaryBridge`: it asks the bridge's `canSendPayouts()` from the vault with that gas, and refuses anything but one word, nothing written (R11).",
    );
  });

  it("R12a, for the runbook: 2.2 funds the keeper with a full batch's float beside the 0.01 ETH Base cap, which counts the value a send keeps, and one fake redeem request a day is harmless at it; section 4's batch.redeem_fee_thin answers with setRedeemRequestFee; 7.10's list hold as the cancel cooldown leaves it (the ChatGPT r3 DoS scan)", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const between = (a: string, b: string) => flat(text.slice(text.indexOf(a), text.indexOf(b)));
    const fund = between("### 2.2 ", "### 2.3 ");
    expect(fund).not.toContain("0.0017 ETH (");
    expect(fund).not.toContain("about **0.005 ETH** on Base");
    expect(fund).toContain("about **0.03 ETH** on Base: a close sends a float of three times its bridge fee quote");
    expect(fund).toContain("`pnpm ops budget` prints the figure");
    expect(fund).toContain("The 24 hour spend caps are 0.4 TAO and 0.01 ETH");
    // R12d (L-2): less the batch's pot, which the door spends first
    expect(fund).toContain("its gas limit at its fee cap, and the value it keeps: a close's quoted bridge fee less the batch's pot, which the door spends first, the rest of its float coming back");
    expect(fund).toContain("**Base's 0.01 ETH holds a day's closes**");
    // at the launch's request fee (the founder, 2026-11-16: 0.0002 ETH), the pot one request leaves
    expect(fund).toContain("**One fake redeem request** (0.0002 ETH, no shares needed) in an otherwise empty batch makes the keeper close a batch of that request alone at its 24-hour max wait");
    expect(fund).toContain("about 0.00055 ETH net, once a day");
    // a rotated key is funded the same way
    expect(between("### 2.6 ", "### 2.7 ")).toContain("about 0.45 TAO on Bittensor EVM and 0.03 ETH on Base");
    const day = between("## 4. Day to day", "**The stamp rule");
    expect(day).toContain("**`batch.redeem_fee_thin`** (a warning)");
    expect(day).toContain("`setRedeemRequestFee(<wei>)` on the front door: immediate, at most 0.001 ETH");
    // the launch's 0.0002 ETH: a full list pays 0.01 ETH, about 2.3 times a full batch's quote, quiet at launch
    expect(day).toContain("At the launch's 0.0002 ETH (the founder, 2026-11-16;");
    expect(day).toContain("a full list pays 0.01 ETH against a quote of about 0.0031 to 0.0043 ETH, about 2.3 to 3.2 times, so it is quiet at launch");
    expect(day).not.toContain("so it may warn from the start");
    // build B closes the list hold (the list half rule): R12b's pins below say how
    const full = between("### 7.10 ", "### 7.11 ");
    expect(full).not.toContain("**What is left of the list hold**");
    expect(full).not.toContain("a holder with 49 aged entries");
  });

  it("R12d (M-1), for the runbook: 2.2 says a send with no room under the cap only waits, said once, while the round goes on to the rest on both chains; 2.5 lists the spend cap's loud lines", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const between = (a: string, b: string) => flat(text.slice(text.indexOf(a), text.indexOf(b)));
    const fund = between("### 2.2 ", "### 2.3 ");
    expect(fund).toContain(
      "Such a send only waits, said once (`SPEND CAP ROOM: <what> waits: …`): the round goes on to the rest of its work on both chains, and a smaller send that still fits goes (a delivery, a re-execution, a stake, a claim within its own room), until the 24-hour sum leaves room for it.",
    );
    expect(fund).toContain("Before R12d its refusal failed the round every round");
    expect(between("### 2.5 ", "### 2.6 ")).toContain("SPEND CAP and SPEND CAP ROOM (each said once a change)");
  });

  it("R12b (build A), for the runbook: every depositor told to cancel is told it works 5 minutes after their last deposit; 7.10's full batch under the cancel cooldown: its filler can't cancel before the keeper's next round, the keeper's close names the least total still full, and the residuals (two addresses' flap, the under-half hold, gifts ended by the pause)", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const between = (a: string, b: string) => flat(text.slice(text.indexOf(a), text.indexOf(b)));
    const canary = between("### 3.5 ", "### 3.6 ");
    expect(canary).toContain("**A cancel, 0.04 TAO.** Deposit 0.04 TAO again, wait 5 minutes (a cancel works 5 minutes after the last deposit to your entry: the site counts it down), and cancel it on the site before its batch closes.");
    expect(between("### 7.5 ", "### 7.6 ")).toContain("warn depositors with open deposits to cancel them on the site (a cancel works 5 minutes after their last deposit)");
    const notice = between("### 7.7 ", "### 7.8 ");
    // build B: a pause frees every cancel at once (the R12b build B test)
    expect(notice).not.toContain("cancels (each 5 minutes after the depositor's last deposit; no deposit lands while it is paused, so every wait runs out)");
    // build B: at once while the door is paused
    expect(notice).toContain("tell those depositors to cancel them on the site (`cancelDeposit`, at once while the door is paused)");
    const full = between("### 7.10 ", "### 7.11 ");
    expect(full).toContain("**What protects a full batch is a close that lands while it is full**");
    expect(full).toContain(
      "Since R11 the cancel cooldown makes the keeper's next round that close: a cancel works only 5 minutes after the last deposit to the canceller's entry, whoever made it (`cancelableAt`; the site counts it down and sends no cancel before it), so the deposit that filled the batch can't be cancelled before the keeper's next round, a minute later, which commits it. Revision 34's hold (fill the batch just after one round, cancel before the next) is closed.",
    );
    // R12c: the keeper's close at the max wait names 0, and the site's close before a stake the least total still full;
    // R12d (L-1): the keeper's floors before the interval too, by clause, and the close rule on the close's own read; R12e:
    // the site's names the highest of the lines that held, the keeper's the least
    expect(full).toContain(
      "The keeper's close of a batch full by its limits names the least total still full as its `minValue` (the least of the lines that held), read before the interval as after it (a close read just before the interval ends can land after it, closable by time, where only `minValue` guards the line; R12d): for a value line the least total at which it still holds (5 TAO of 10 at half), for a deposit list at its line the least its entries carry (25 minimum deposits, 1 TAO at the 0.04 minimum, or the total if that is less), for a full redeem list 0 (its requests' fees in the pot pay the close). Its close at the max wait names 0, full or not, as it goes whatever its fees there, and the close rule decides again on the close's own read, so a batch cancelled down since the round's read waits for its fees (R12d). The site's \"Send the batch, then stake\" names the same lines (a list at its line the least its entries carry too, R12d; for a batch full by value its line even before the interval, as a wallet prompt can land past it), but where more than one held, the highest of them, not the least (R12e): the user pays for that close, so it lands only while the batch is still full by every line that held at the click, at worst shrunk to the highest (5 TAO of 10 for a batch at half its limit; within a minimum deposit of 10 TAO for one at the limit; never the list's 1 TAO for a batch with 25 or more depositors at half its value), and a cancel that takes it under that line reverts it, only Base's network fee spent, so the user tries once more. So a cancel of a rao from an aged entry between a read and its send no longer voids any of these closes (R12b, R12c).",
    );
    // R12g: the keeper's fee-rule close names the total less one minimum deposit; a reverted close never stops the keeper
    expect(full).toContain(
      "The keeper's close by the fee rule (a batch neither full nor at its max wait, closed because its fees cover its bridge fee) names the total less one minimum deposit (R12g): a cancel refunds none of the fees the rule weighs (the staker took them at the stake), so a rao cancelled just before it with a higher tip no longer voids it",
    );
    expect(full).toContain("A close the chain reverts never stops the keeper, whatever its replay names");
    expect(full).toContain("The site's close of a batch due by time alone still names the exact total.");
    expect(full).not.toContain("a close by the fee rule, and the site's of a batch due by time alone, still name the exact total");
    // R12g: 2.5 says when the keeper stops itself and when it waits, the quiet skip and the breaker, and keeps the skip's line
    const logs = between("### 2.5 ", "### 2.6 ");
    expect(logs).toContain("each quiet skip's reason, `Skipped this round (…): …` (R12g)");
    expect(logs).toContain("A close, the migration notice's one close or a roll the chain reverts never stops it (R12g)");
    expect(logs).toContain("is a wait the breaker counts. **The breaker**: an action refused or waiting three rounds in a row is skipped (`SKIPPING …`) for 5 minutes, then 10, 20, 40, up to an hour (`STILL SKIPPING`)");
    // R12h (M1): what the close's own block explains is a quiet skip whatever a later read shows; only what nothing
    // explains is counted. L2: the adoption's unexplained revert stops the keeper too, and those three are the only ones
    expect(logs).toContain(
      "What the close's own block explains is that round's **quiet skip** (R12h): its replay at the block it was mined in or the one before naming the door's `WrongBatch`, `BatchTooSmall` or `BatchNotReady` (the batch changed under it there), or, when the replay names no reason, a deposit of the batch cancelled from the read the close was sent on through its block (the door's `DepositCancelled` logs), whatever the batch holds by the time anything reads it again.",
    );
    expect(logs).toContain("Only one nothing explains (no door reason replayed, no cancel of the batch logged in those blocks or none readable, and the batch read again still closable as it was sent, or unreadable) is a wait the breaker counts.");
    expect(logs).toContain("or a payout, a stake or an adoption (`adoptStake`) the chain reverted with nothing to explain it: those three are the only sends whose revert can still stop it");
    expect(logs).not.toContain("a payout or a stake the chain reverted with nothing to explain it");
    expect(logs).not.toContain("One nothing explains (the batch still closable as it was sent, or the read failing)");
    // R12h: 7.10's fee-rule close names 0 when the pot covers its quote; a reverted close's own block explains it; L1, the
    // fee-rule batch held to its max wait: its cost and what ends it
    expect(full).toContain("When its pot covers the close's quote (the close keeps none of its float), the keeper's fee-rule close names 0 instead (R12h)");
    expect(full).toContain("what its own block explains is a quiet skip whatever a later read shows (R12h, section 2.5");
    expect(full).toContain("**A fee-rule batch held to its max wait** (R12h): a holder's cancel of a minimum deposit plus 1 rao from an aged entry just before each of the keeper's fee-rule closes");
    expect(full).toContain("It costs the keeper one reverted close a round, about 45,000 gas: about 0.00065 ETH a day at Base's 0.01 gwei");
    expect(full).toContain("It ends when a close lands: the keeper's at the max wait, a depositor's own (`closeBatch` is anyone's to call), or yours (`pnpm ops close --live`");
    expect(full).not.toContain("read again, a batch that moved or shrank is a quiet skip, one still closable as it was a wait the breaker counts");
    expect(full).not.toContain("(0 before the interval, where the door's own `canClose()` guards the line)");
    expect(full).not.toContain("no longer voids the close (R12b).");
    expect(full).not.toContain("names the same least total");
    expect(full).toContain("Two addresses can still flap it: a fresh deposit from one lifts it over the line just after a round, and the other cancels a deposit older than 5 minutes before the next.");
    expect(full).toContain("the cancels in any 5 minutes sum to under half a batch, so the batch reads full in at most about one keeper round in five");
    expect(full).toContain("A stranger's `depositFor` to an address restarts that address's wait: each costs at least the 0.04 TAO minimum every 5 minutes, which the address keeps, and the deposit pause ends it at once");
    expect(full).toContain("The cooldown binds only through a close that lands within those 5 minutes: with the keeper down, the holds come back.");
    expect(full).not.toContain("A holder can deposit the batch full just after a keeper round and cancel before the next");
  });

  it("R12b (build B), for the runbook: the list half rule closes the list hold, batches of 25+ depositors close at the next round, a forced close commits at least 1 TAO (R12d: the reviewer's price before it); batch.deposits_full watches those closes; a pause frees every cancel at once (7.1, 7.7, 7.10)", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const between = (a: string, b: string) => flat(text.slice(text.indexOf(a), text.indexOf(b)));
    const full = between("### 7.10 ", "### 7.11 ");
    expect(full).toContain("a deposit list at half its limit (build B: 25 of 50 deposits) or a full redeem list");
    expect(full).toContain(
      "**The list hold is closed** (build B, the list half rule with the cooldown): reaching 50 entries from at most 24 at a keeper round takes at least 26 deposits under a minute old, none of which can be cancelled before the next round, which finds the list at half or more and closes it. Batches with 25 or more depositors close at the keeper's next round, whatever their fees.",
    );
    // R12d (L-1): the price of a forced close, before and since its floor
    expect(full).toContain(
      "A forced close commits at least 1 TAO at the 0.04 minimum to the vault (25 minimum deposits, the close's floor), in 25 entries or, with the others cancelled under the close past the interval, as few as one entry of at least 1 TAO (R12d). Before R12d that floor was 0, so a cancel-down made it one entry of 0.04 TAO: about 0.00075 ETH of the keeper's a close, one an interval, and about 13 such closes reached the 0.01 ETH Base cap for about 0.52 TAO committed in all. Since R12d the cheapest way to the cap is about 7 closes of 25 minimum deposits, about 7 TAO committed (about 13 one-entry closes would need 13 TAO).",
    );
    expect(full).not.toContain("a forced close costs 25 entries, 1 TAO at the 0.04 minimum");
    expect(full).toContain("This alert counts only closes of 25 entries or more: such cancelled-down closes (one entry of 1 TAO or more, about 0.00075 ETH each) show in the `SPEND CAP` lines and `pnpm ops budget` instead.");
    expect(full).toContain(
      "- **`batch.deposits_full`** (a warning): at least 2 batches closed in the last 24 hours with their deposit list at half its limit or more (25 of 50) of deposits averaging at most twice the minimum.",
    );
    expect(full).toContain("the deposit pause ends it at once: while the door is paused (or its primary bridge disabled) `cancelableAt` reads 0 and every cancel works");
    expect(full).not.toContain("the open batch's 50 deposit slots are taken by deposits near the minimum");
    expect(between("### 7.1 ", "### 7.2 ")).toContain("and frees every deposit's cancel at once (no 5-minute wait while it is paused)");
    expect(between("### 7.7 ", "### 7.8 ")).toContain("cancels (at once: a pause frees every cancel), redeem requests and closes still work while it is paused");
  });

  it("R6b (U6), for the runbook: 7.8 names ForeverMoney's validator hotkey swap (its backing read 0): burns may queue until it repoints, and the owner can cancel", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const s = text.slice(text.indexOf("### 7.8 "), text.indexOf("### 7.9 ")).replace(/\s+/g, " ");
    expect(s).toContain("**If ForeverMoney's validator swaps its hotkey**");
    expect(s).toContain("door burns may queue until ForeverMoney repoints (`migrateValidator`)");
    expect(s).toContain("`pnpm ops cancel-payouts <key> --for-wallet --live`");
  });

  it("R6b (U7), for the runbook: 3.2's cushion: a surplus never refills it, only fundCushion does", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const s = text.slice(text.indexOf("### 3.2 "), text.indexOf("### 3.3 ")).replace(/\s+/g, " ");
    expect(s).toContain("A surplus never refills the cushion, even below its target: only `fundCushion` does");
  });

  it("R6b (U9), for the runbook: a keeper's or guardian's removal waits for the deferred rewards the unclaimed read leaves out", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (t: string) => t.replace(/\s+/g, " ");
    const hand = flat(text.slice(text.indexOf("## 5. The keeper's one-shots by hand"), text.indexOf("## 6. ")));
    expect(hand).toContain("It also refuses while Bittensor still owes the vault deferred rewards on it (the unclaimed read leaves them out) above the dust allowance, as does the guardian's removal file");
    const stake = flat(text.slice(text.indexOf("### 7.5 "), text.indexOf("### 7.6 ")));
    expect(stake).toContain("never while Bittensor still owes the vault deferred rewards on it");
  });

  it("R4-O's fix round (Important 1): 7.7 never disables a primary or pauses the vault during the notice, and keeps its order: the cancels, the schedule, the execute, then the switch", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const sec = text.slice(text.indexOf("### 7.7 "), text.indexOf("### 7.8 "));
    // no step tells the founder to disable a primary (the stamp that kills the replacement rail's activations)
    expect(sec).not.toMatch(/disable the front door's primary/i);
    expect(sec).not.toMatch(/pnpm ops (schedule [a-z-]+ )?disable/);
    expect(sec).not.toMatch(/pnpm ops pause (vault|both)/);
    const flat = sec.replace(/\s+/g, " ");
    for (const m of flat.matchAll(/disabl\w*/gi)) {
      const near = flat.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 60);
      expect(near, near).toMatch(/never|Never|come after both activations/);
    }
    // deposits stop by the front door's pause, which stamps nothing
    expect(sec).toContain("`pnpm ops pause front-door --for-wallet`");
    expect(sec).toContain("The front door's pause stamps nothing");
    // the order
    const at = (x: string) => {
      const i = sec.indexOf(x);
      expect(i, x).toBeGreaterThan(-1);
      return i;
    };
    const order = [at("pnpm ops cancel-payouts <key> --for-wallet --live"), at("every cancel signed and landed"), at("pnpm ops schedule both activateBridge"), at("pnpm ops execute <id>"), at("only then the switch")];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // merge 7b: the hand close carries the open batch's redeem requests, which the vault defers (S-H1), and says so
    const flatSec = sec.replace(/\s+/g, " ");
    expect(flatSec).toContain("Redeem requests in the open batch go with it: the vault defers each while the old rail can't pay (nothing is burned)");
    expect(flatSec).not.toContain("It refuses while redeem requests wait in the open batch");
    // R4-O round 2: the replacement pair's AlphaVault, the old vault's announced migration target, and no --one-sided
    const flatAll = sec.replace(/\s+/g, " ");
    expect(flatAll).toContain("which must be the old vault's announced migration target (`migrationTarget()`, read live)");
    expect(flatAll).toContain("no `--one-sided` is needed");
    expect(sec).not.toMatch(/activateBridge[^\n]*--one-sided/);
    // R4-O round 3: add-pair during the notice records the target; the AlphaVault reads follow the primary; no open mark
    expect(flatAll).toContain("while the notice runs, add the new pair to the record");
    expect(flatAll).toContain("so closes, rolls and payouts resume on the new rail");
    expect(sec).not.toContain("[Open: R4-O round 2]");
    // R4-O round 4: the recovery for a missed add-pair, the monitor's record and its recovery, the monitor following the primary
    expect(flatAll).toContain("pnpm ops add-pair <bridge> <bridge> --target-block <block> --live");
    expect(flatAll).toContain("pnpm alpha-target -- --env production --vault <alpha-vault> --show");
    expect(flatAll).toContain("pnpm alpha-target -- --env production --vault <alpha-vault> --block <block>");
    expect(flatAll).toContain("the monitor's `rail.alpha_vault` and `rail.payouts_closed` follow the new vault");
    expect(flatAll).not.toContain("keep TOKENS on the deploy's AlphaVault");
    // R4-O's last Minors: the hold the rule raised, cleared after the reseed
    expect(flatAll).toContain('pnpm hold:clear -- --env production --id <hold-id> --note "<reason>"');
    expect(flatAll.indexOf("pnpm hold:clear")).toBeGreaterThan(flatAll.indexOf("--vault <alpha-vault> --block <block>"));
    const addPair = flatAll.indexOf("pnpm ops add-pair <bridge> <bridge> --live");
    expect(addPair).toBeGreaterThan(flatAll.indexOf("every cancel signed and landed"));
    expect(addPair).toBeLessThan(flatAll.indexOf("pnpm ops schedule both activateBridge"));
  });

  it("merge 7b (R4, F-1): 3.2 funds the token cushion by approve and fundCushion, says a plain transfer is swept, and the treasury keeps a small holding", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const sec = text.slice(text.indexOf("### 3.2 "), text.indexOf("### 3.3 ")).replace(/\s+/g, " ");
    expect(sec).toContain("by `approve` then `fundCushion`");
    expect(sec).toContain("pnpm ops fund-cushion --from <0x…> --for-wallet --live");
    expect(sec).toContain("**Never by a plain token transfer.**");
    expect(sec).toContain("anyone's `sweepSurplus()` sends it to the treasury");
    expect(sec).not.toMatch(/cushion, by a plain token transfer/);
    // the review's M1: where the funding account's FM-TAO comes from, before the call file, marked for the fork rehearsal
    expect(sec).toContain("First get the FM-TAO into that account, from ForeverMoney **[Fork: T61, done 2026-11-13: a plain account (no code, no role) called it");
    expect(sec).toContain("`depositLiquid(token, minAlphaRao)` on ForeverMoney's AlphaVault, `0x11837459896D96F821a8D88eC93a3C8D152033D4`");
    expect(sec).toContain("`token` is the FM-TAO token, `0xC5b6C1632d34901239396F5E1BDe54B342900256`");
    expect(sec.indexOf("First get the FM-TAO")).toBeLessThan(sec.indexOf("pnpm ops fund-cushion --from <0x…> --for-wallet --live"));
    expect(text.replace(/\s+/g, " ")).toContain("the FM-TAO for it from ForeverMoney's `depositLiquid` (3.2 step 3)");
    // M3: verify fails under 1 rao, not only at 0; M2: 3.3 says to go no further while verify fails
    expect(sec).toContain("`pnpm ops verify` fails while the booked cushion is under 1 rao");
    const s33 = text.slice(text.indexOf("### 3.3 "), text.indexOf("### 3.4 ")).replace(/\s+/g, " ");
    expect(s33).toContain("**Go no further while it fails.** Fix each failure and run it again");
    // R4-K: the treasury's small holding of shares (3.4)
    expect(text.replace(/\s+/g, " ")).toContain("The treasury always keeps a small holding of shares (it never redeems its last)");
  });

  it("3.2 funds the deployer keys from pnpm ops budget, and sweeps a key back only once its chain's creates are all done (the review of 99d4b07)", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const sec = text.slice(text.indexOf("### 3.2 "), text.indexOf("### 3.3 ")).replace(/\s+/g, " ");
    expect(sec).toContain("`pnpm ops budget` reads the rehearsal record");
    // a send from a deployer key spends a nonce the plan holds for a create, and voids the plan
    expect(sec).toContain("Sweep a deployer key back only once that chain's creates are all done");
    expect(sec).toContain("a send from it before then spends a nonce the plan holds for a create, and voids the plan");
    expect(sec).not.toMatch(/after the deploy\. Sweep it back\./);
  });

  it("merge 7b (R4-K review Minor 6): 7.11 step 3 says the keeper's full top-up and its hand route, and no follow-up is left open", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const sec = text.slice(text.indexOf("### 7.11 "), text.indexOf("## 8. ")).replace(/\s+/g, " ");
    expect(sec).toContain("the keeper sends it again with the full top-up: it pays the whole bridge fee, and the entries are sent their gross");
    expect(sec).toContain("it never sends more than the top-up the quote asks");
    expect(sec).toContain("By hand, the same rule: `pnpm ops payouts --live`");
    expect(sec).not.toContain("[Follow-up");
  });

  it("merge 7b (S-H1's deferral, S-M1, S-L2, S-L4): 7.7 is written for the deferral, keeps S-M1's order, and every bounce that can't be cancelled has its way out", () => {
    const text = readFileSync(RUNBOOK, "utf8");
    const flat = (from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to)).replace(/\s+/g, " ");
    const s77 = flat("### 7.7 ", "### 7.8 ");
    expect(s77).not.toContain("[Merge:");
    expect(s77).toContain("**No door redeem is burned while the notice runs.**");
    expect(s77).toContain("the vault defers every door redeem (`RedeemDeferred`)");
    // step 1: the open batch's requests deferred, not to be cancelled for fear of a burn
    expect(s77).not.toContain("redeem requests in it are burned");
    expect(s77).toContain("redeem requests in it are deferred by any close");
    // step 3: the keeper's line names the batches; S-M1: cancel before the schedule; S-L4: a bounce-only batch
    expect(s77).toContain("The keeper names each one on the notice's first round (`MIGRATION NOTICE: cancel …`)");
    expect(s77).toContain("A batch of bounced deposits alone can't be cancelled (`NothingToCancel`)");
    expect(s77).toContain("If no replacement rail will run, record each such bounce as a debt the treasury settles by hand (section 9).");
    expect(s77.indexOf("Do it **before** you schedule the replacement rail")).toBeGreaterThan(s77.indexOf("pnpm ops cancel-payouts <key> --for-wallet --live"));
    // step 4 (S-M1's "stop closes that carry redeems"): nothing to stop now; step 5: how holders leave
    expect(s77).toContain("Closes need no stopping: a close during the notice (a stranger's, after the flush) queues no redeem, since the vault defers each.");
    expect(s77).toContain("A withdrawal requested on Base meanwhile is deferred, not paid, and its fee is spent");
    expect(s77).toContain("a plain wallet directly on Bittensor");
    // S-L4 in 7.8 and section 9: a stranded bounce is a debt the treasury settles by hand
    expect(flat("### 7.8 ", "### 7.9 ")).toContain("record each such bounce as a debt the treasury settles by hand (section 9)");
    expect(flat("## 9. ", "## 10. ")).toContain("record it as a debt: each depositor's address and amount, from its `DepositBounced` log, settled from the treasury by hand");
    // S-L2 (R4-O wrote it): the refusing vault's open batch, its depositors told to cancel, any close parking it
    const s75 = flat("### 7.5 ", "### 7.6 ");
    expect(s75).toContain("warn depositors with open deposits to cancel them on the site");
    expect(s75).toContain("anyone can close it once it is due: it then parks on Bittensor for up to 14 days");
    // R4-K's Glamsterdam line in section 8, with add-pair's check
    expect(flat("## 8. ", "## 9. ")).toContain("**A gas-cost change** (Ethereum's Glamsterdam repricing");
    expect(flat("## 8. ", "## 9. ")).toContain("`pnpm ops add-pair <bridge> <bridge> --live` refuses a new pair whose two copies differ");
  });

  it("v3-launch's runbook is untouched by it (a different file, v3-launch's commands)", () => {
    expect(readFileSync(new URL("../../docs/runbook-test-run.md", import.meta.url), "utf8")).toContain("# Test run runbook");
  });
});

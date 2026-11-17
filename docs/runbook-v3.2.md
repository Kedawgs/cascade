# v3.2 runbook

How to deploy, run and look after Cascade v3.2: the vault on Bittensor, the front door on Base, and the keeper as its own
Cloudflare Worker. The design is `docs/superpowers/specs/2026-10-31-cascade-v3.2-design.md` (its section 7 is the source
of this runbook). v3-launch keeps its own runbook, `docs/runbook-test-run.md`, until it is retired (Task 69).

Every pnpm ops command runs from `ops/`. Every pnpm keeper, config:from-record and wrangler command runs from
`keeper/`, and nowhere else (wrangler reads the folder's own `wrangler.jsonc`). A test (`ops/test/runbook-v32.test.ts`)
checks that every command written here exists, with every flag.

## 1. How to read this runbook

**Who signs each step.** Each step names one signer:

| Tag | Who | How |
|---|---|---|
| **[Ledger: owner]** | your Ledger, account 1 | ops writes a call file; `pnpm ops sign <file>` serves it on this computer; MetaMask (the Ledger behind it) sends one call per click |
| **[Ledger: guardian]** | your Ledger, account 2 | the same, from account 2 |
| **[Ledger: treasury]** | your Ledger, account 3 | the same, from account 3 |
| **[Owner, scheduled]** | the owner's timelock | pnpm ops schedule writes the owner's `schedule(…)` call; once it is ready (48 hours, 7 or 8 days), `pnpm ops execute <id> --for-wallet --live` writes the call that runs it. The guardian can cancel most items meanwhile. Every one is under **the stamp rule** (section 4) |
| **[Keeper]** | the keeper's key | the Worker does it by itself each minute; or you run the hand command, signed with the same key from its keystore on this PC |
| **[Relayer]** | the stamp relayer's key | a fresh key on this PC, never from the Ledger seed |
| **[Anyone]** | any account | |

**[FOUNDER ONLY]** marks every step that moves money, picks an address or sends a transaction. No one else does these.

**[Fork: T61]** marks a step to confirm at the fork rehearsal (Task 61); **[Canary]** one to confirm at the mainnet canary
(3.5), which replaced the testnet tasks (62 to 64) on 2026-11-11.

**The flags.**
- `--live` names the live deployment's record (without it, the local forks'). It never means "send" here.
- `--send` sends, for the commands that check first: `claim`, `adopt`, `add-hotkey`, `remove-hotkey`, `park` and
  `reexec`. Without it they check, simulate and print what they would send, and take no lease.
- `close`, `stake` and `payouts` send as they are run (as on v3-launch).
- `--for-wallet` writes a call file for the sign page and sends nothing.
- A keeper command by hand takes the Worker's lease first (so two keepers never run at once). If Cloudflare can't be
  reached, a one-shot command may go ahead with `--without-lease "<reason>"`; it says so loudly, and only the nonce then
  keeps two transactions apart. `run` never goes without the lease.

**What ops/.env holds for v3.2** (names only; never paste a key anywhere):
- `OPS_DEPLOYMENT=v3.2-launch`;
- `OPS_BASE_RPC`, `OPS_BASE_LOGS_RPC`, and `OPS_BITTENSOR_RPC`, which must keep history: use the archive node
  (`https://archive.chain.opentensor.ai`). The lite node drops logs within minutes, and the scans refuse it;
- `OPS_V32_KEEPER_KEYSTORE` and `OPS_V32_KEEPER_PASSWORD_FILE`: the keeper's keystore and the file holding its password.
  The password file leaves the keystore guarded only by your Windows login, as v3-launch's keeper is (Task 50b's
  Minor 6). Keep the file in your user folder, readable by you alone, and delete it if the PC is shared;
- `OPS_KEEPER_URL` (the keeper's own hostname) and `OPS_KEEPER_CONTROL_TOKEN`;
- `OPS_HOLD_URL`, the monitor's public URL, which hand runs read for the hold; `ops/hold.json` with `{"hold": true}` holds
  a hand run too;
- `OPS_RELAYER_KEYSTORE` and `OPS_RELAYER_PASSWORD_FILE`: the stamp relayer.

## 2. The keeper Worker

The keeper runs as the Cloudflare Worker `cascade-keeper-production`, once a minute. It can't move user funds or change
any setting. Its key lives in two places by your choice (2026-11-07): a Worker secret, and a password-protected keystore
on this PC for hand runs.

**Before any of it.** Cloudflare two-factor login is on (confirmed 2026-11-07). A logged-in `wrangler` on this PC skips
it, so log out after each deploy:

```
pnpm wrangler logout
```

A new dependency in `keeper/` needs a networked pnpm install; today's lockfile installs offline.

### 2.1 Make the keeper's key (before the deploy plan: the plan needs its address) [FOUNDER ONLY]

```
pnpm keeper:new-key -- --env production
```

It asks for a password twice (at least 12 characters, not shown), writes only the keystore, and prints the address. Put
that address in ops/.env as `OPS_V32_KEEPER_ADDRESS`, and the keystore's path as `OPS_V32_KEEPER_KEYSTORE`. The key is
put into the Worker later (2.3): a secret put before the Worker's first deploy makes a draft Worker.

### 2.2 Fund the keeper [FOUNDER ONLY]

- about **0.45 TAO** on Bittensor EVM: one claim's up-front fee (a 57,000,000 gas limit, about 0.285 TAO at today's
  5 gwei) and a day of payouts and stakes;
- about **0.03 ETH** on Base: a close sends a float of three times its bridge fee quote (the front door sends back what
  the fee leaves, but the wallet must hold the whole float for the send to go at all), and a full 50 + 50 batch quotes
  about 0.0043 ETH, so its float is about 0.013 ETH; beside it, the 24 hour cap below, what the keeper may spend in a
  day. `pnpm ops budget` prints the figure (0.0298 ETH at the 0.01 ETH cap and its 0.0043 ETH quote allowance, with its
  30% margin). The 0.005 ETH of before couldn't even send a close quoting above about 0.0016 ETH (R12a).

The 24 hour spend caps are 0.4 TAO and 0.01 ETH (`ops/LAUNCH-SETTINGS.md`, the v3.2 section). A claim fits under the
0.4 TAO cap while Bittensor's gas price is up to about 5.5 gwei (a claim's 57,000,000 gas limit and a day of payouts and
stakes); above it, claims wait, said loudly. The cap refuses a send whose worst case (its gas limit at its fee cap, and
the value it keeps: a close's quoted bridge fee less the batch's pot, which the door spends first, the rest of its float
coming back; a payout's top-up whole) would cross what is left of it, and once a send is mined counts only what it cost.
Such a send only waits, said once (`SPEND CAP ROOM: <what> waits: …`): the round goes on to the rest of its work on both
chains, and a smaller send that still fits goes (a delivery, a re-execution, a stake, a claim within its own room),
until the 24-hour sum leaves room for it. Before R12d its refusal failed the round every round, so in the band just
under the cap (a full batch's close above about 0.0052 ETH spent, a one-entry close above about 0.0092) everything behind
it waited, on both chains, at rounds slowed to 5 minutes, for up to a day. The monitor's `keeper.low_tao` and
`keeper.low_eth` warn when it runs low (`keeper.low_eth` below 0.015 ETH, or below four full-batch quotes when that is
more: the float and one more close).

- **Base's 0.01 ETH holds a day's closes**: about two full 50 + 50 batches (about 0.0043 ETH each, gas and fee) or a
  dozen one-entry ones (about 0.00075 ETH each). It was 0.0017 ETH, less than one full-list close (about 0.002 ETH), so
  one forced early close (a full list, or the half rule) stopped every Base send for up to 24 hours (R12a, the ChatGPT
  r3 DoS scan). At the cap, Base's sends wait (`SPEND CAP` lines) until the 24-hour sum falls under it; Bittensor's go
  on. A full batch's close in flight counts its whole float (about 0.013 ETH, over the cap) until its receipt says what
  came back, so a stuck one is cancelled rather than sent again at a higher fee, and the next round closes the batch.
- **One fake redeem request** (0.0002 ETH, no shares needed) in an otherwise empty batch makes the keeper close a batch
  of that request alone at its 24-hour max wait: the bridge fee less the pot, about 0.00055 ETH net, once a day for as
  long as someone pays the fee each day. At the 0.01 ETH cap that is harmless (it was over a third of the old 0.0017);
  nothing to do unless `SPEND CAP` lines show the cap reached.

- **Keep 0.4 TAO for the self-funded launch. Before other people's money, raise it to 0.6 TAO** (the T61a review: a
  busy day, one claim and about 24 payouts and 24 stakes, is near 0.48 TAO): `OPS_KEEPER_SPEND_CAP_BITTENSOR=0.6` in
  ops/.env, then 2.3 steps 1 and 2 again (the cap is in the Worker's `DEPLOYMENT` var), and fund the keeper to match.
- A `claimGasRequired` raised above about 62,500,000 (3.5 step 7) makes a claim need more than 0.4 TAO at 5 gwei (at the
  vault's top, 63,400,000, a 64,900,000 limit: 0.402 TAO): raise the cap with it, the same way.

### 2.3 Deploy the Worker (Task 67, after the contracts) [FOUNDER ONLY]

1. Print the Worker's deployment setting from the live record:

   ```
   pnpm config:from-record -- ../ops/deployments/v3.2-launch.json
   ```

   Paste what it prints into `wrangler.jsonc`, over the `production` environment's `DEPLOYMENT` line and every
   `DEPLOYMENT_FOR_LIFE_` line after it. It prints several vars: Cloudflare takes 5 kB in one, and the record is about
   10, so `DEPLOYMENT` comes without its for-life list, which the numbered `DEPLOYMENT_FOR_LIFE_1`, `_2`, ... carry
   (each says which part of how many it is; the Worker joins them, and a part missing or out of place leaves the keeper
   not ready, by name, never running on a shorter list). It prints the spend caps beside them, and says that
   `OPS_REEXEC_AUTO` stays `off`. **[Done 2026-11-16: production holds v3.2-launch's, in three vars.]**
2. Deploy, always naming the environment (without `--env`, wrangler would make a stray Worker with a cron), at 100%,
   never as a gradual deployment:

   ```
   pnpm wrangler deploy --env production
   ```

   A fresh Worker reads as stopped: it sends nothing until `pnpm ops keeper start`.
3. Put the secrets in: the key from its keystore, the control token, and the keyed RPC URLs (each `wrangler secret put`
   asks for the value; never type it on the command line):

   ```
   pnpm keeper:put-key -- --env production --keystore <file>
   pnpm keeper:new-token -- --env production --put-secret
   pnpm wrangler secret put BASE_RPC_URL_SECRET --env production
   pnpm wrangler secret put BASE_LOGS_RPC_URL_SECRET --env production
   pnpm wrangler secret put BITTENSOR_RPC_URL_SECRET --env production
   ```

   `new-token` prints the control token once: put it in ops/.env as `OPS_KEEPER_CONTROL_TOKEN`.
4. The Worker's own hostname is `keeper.cascadefi.xyz` (a custom domain in `wrangler.jsonc`'s `production` routes,
   made by the deploy; **done 2026-11-16**). Put it in ops/.env as `OPS_KEEPER_URL=https://keeper.cascadefi.xyz`.
   workers.dev stays off, so the control routes answer nowhere else. **[Canary]**
5. Check it, then start it:

   ```
   pnpm ops keeper status
   pnpm ops keeper start
   ```

   `status` must show `Key: …, keeper() on both contracts: yes`, no code on it on either chain, and its balances. The
   keeper is whatever key `keeper()` names on both contracts; the plan's first keeper is shown beside it, and differs
   after a rotation (2.6).
6. `pnpm wrangler logout`.

### 2.4 Stop and start

```
pnpm ops keeper stop --reason "<reason>"
pnpm ops keeper start
```

A stop takes effect before the Worker's next send, within a minute; a send already in flight finishes. From a phone: the
Cloudflare dashboard, `cascade-keeper-production`, Triggers, delete the cron (add it back to resume). The last resorts:
the owner's `setKeeper(0)` on both chains stops the key itself
(`pnpm ops set-keeper 0x0000000000000000000000000000000000000000 --for-wallet --live`, then `pnpm ops sign <file>`), and
the guardian's pause (section 7.1) stops everyone.

**A hold is not a stop.** The monitor's hold, or `ops/hold.json`, stops everything but one thing: converting token parks
during ForeverMoney's migration notice. To stop even that, use `pnpm ops keeper stop --reason "<reason>"`, not a
hold.

Other control commands: `pnpm ops keeper status --runs 50` (the last runs' lines), `pnpm ops keeper deliveries off`
(credits stay claimable; `on` again), `pnpm ops keeper retry <key>` (try again an action marked FINAL), and
`pnpm ops keeper lease --break` (free a stuck lease; its old holder can't write again).

### 2.5 Reading the logs

`pnpm ops keeper status` shows the last runs and every loud line: STOPPED, FINAL, SKIPPING, HELD, CCIP FAILURE, PARK…,
MIGRATION NOTICE…, STAKE MISSING, UNLISTED STAKE, ROOT HOLD, SPEND CAP and SPEND CAP ROOM (each said once a change),
each hotkey line, and each quiet skip's reason, `Skipped this round (…): …` (R12g). Workers Logs (the dashboard,
`cascade-keeper-production`, Logs) keep every line for 7 days. "DELIVERIES READ IN PART" can repeat once per turn of the
delivery queue while a user's reads keep failing: only log lines, nothing is held.

**When the keeper stops itself, and when it only waits.** It stops itself (`THE KEEPER STOPPED ITSELF`; later runs don't
start until `pnpm ops keeper start`) only on what needs you: the keeper wallet with code (assume its key is stolen), the
record not ready or changed, the wrong key, an RPC on another chain, the live gate, a payout list that doesn't match the
vault's on two full scans, the keeper's own mistake (`BadValue`), 30 rounds in a row failing on something unexpected, or
a payout, a stake or an adoption (`adoptStake`) the chain reverted with nothing to explain it: those three are the only
sends whose revert can still stop it (a claim's, a hotkey removal's or a park job's holds that one job, a park
conversion's or a re-execution's waits, a delivery's holds that user). A close, the migration notice's one close or a roll
the chain reverts never stops it (R12g): a reverted close moves nothing. What the close's own block explains is that
round's **quiet skip** (R12h): its replay at the block it was mined in or the one before naming the door's `WrongBatch`,
`BatchTooSmall` or `BatchNotReady` (the batch changed under it there), or, when the replay names no reason, a deposit of
the batch cancelled from the read the close was sent on through its block (the door's `DepositCancelled` logs), whatever
the batch holds by the time anything reads it again. Otherwise the keeper reads the batch again: closed by another,
emptied, no longer able to close, or holding less, a quiet skip too. A quiet skip is said as `Skipped this round (…): …`
and kept in the runs table, no failed round, no count for the breaker, and the next round decides again from its own
read. A close its own reads refuse before anything is sent (the batch changed since the round read it) is a quiet skip
too. Only one nothing explains (no door reason replayed, no cancel of the batch logged in those blocks or none readable,
and the batch read again still closable as it was sent, or unreadable) is a wait the breaker counts. **The breaker**: an action refused or waiting three rounds in a
row is skipped (`SKIPPING …`) for 5 minutes, then 10, 20, 40, up to an hour (`STILL SKIPPING`), while the keeper's other
work goes on; it is tried again after each back-off, and a round in which it goes through, or isn't due, starts its count
again (a quiet skip neither adds to the count nor starts it again). The same quiet skip 10 rounds running says
`STILL FAILING (10 rounds; closing the batch): Skipped this round …`: someone may be timing cancels against the keeper
(section 7.10).

Avoid a release that bumps the keeper's memory version during a ForeverMoney notice: a new memory version restarts
every scan from the start blocks (10 to 20 minutes behind), and the conversions wait for it.

### 2.6 Rotate the key (planned, or at any sign of theft) [FOUNDER ONLY]

1. `pnpm ops keeper stop --reason "rotating the key"`.
2. Make a new key: `pnpm keeper:new-key -- --env production --keystore <file> --put-secret` (it replaces the secret and
   prints the new address; the old key's leftover gas is abandoned). Fund the new address as 2.2 says (about 0.45 TAO on
   Bittensor EVM and 0.03 ETH on Base) before step 4: an unfunded keeper sends nothing.
3. **[Ledger: owner]** `setKeeper(<new address>)` on the front door and on the vault, one file:

   ```
   pnpm ops set-keeper <0x…> --for-wallet --live
   pnpm ops sign <file>
   ```

   Both apply at once. Until both have landed, the Worker refuses every send (its address isn't `keeper()`).
   **[Fork: T61, done 2026-11-13 (`pnpm ops rehearse --v32`): the file's two calls passed the sign page's checks and,
   sent from the owner, applied at once on both forks (30,935 gas on Base, 30,639 on Bittensor); verify then named the
   new key as a rotation, with no failure.]**
4. Point `OPS_V32_KEEPER_KEYSTORE` at the new keystore; then `pnpm ops keeper start`.

Nothing else changes: no new `DEPLOYMENT` and no redeploy. Each round the Worker and every hand run hold their key to
`keeper()` on both contracts, not to the record's keeper (the plan's first, which `pnpm ops keeper status` shows beside
it). `status` must then show `keeper() on both contracts: yes`. **[Fork: T61: a whole rotation, the Worker and a hand
run each sending after it; the owner's file is done (step 3 above), the Worker's and a hand run's sends are not yet]**

`pnpm ops verify` reads `keeper()` as the chains name it. After a whole rotation it reports the new key as
information, never a failure. It fails while the two chains name different keys (the rotation half done). Nothing
gates on verify; `pnpm ops keeper status` is the check here.

**A stolen keeper key** is this rotation, at once. A thief with it can sell users' USDC deliveries at a bad moment (never
below the user's floor, at most 1.5% under the TWAP), split payouts small, fill free hotkey slots, or spend its gas. It
can't move user funds. `keys.keeper_unexplained_tx` warns of a send the Worker's journal doesn't show.

### 2.7 When the Worker or Cloudflare is down

1. Stop the Worker if you can: `pnpm ops keeper stop --reason "running by hand"`.
2. Run the keeper by hand, under the lease: `pnpm ops run --live` (Ctrl-C stops it). It claims, stakes, pays out, runs
   the park jobs and reports FAILUREs, as the Worker does.
3. If the lease can't be had at all, one-shots go without it, each with its reason. The monitor is a Cloudflare Worker
   too: with Cloudflare down it can't be read, and the rails stop every send until you say for how long (at most 24
   hours; a hold still stops everything):
   `pnpm ops payouts --live --without-lease "Cloudflare is down" --ignore-monitor-outage --until <utc-time>`. Without the
   lease, the spend cap counts only that command's sends.
4. A Worker transaction stuck in the pool after the stop blocks every hand send on that chain ("waiting"), and a hand
   run never replaces the Worker's rows. Let the Worker's next run settle it, or cancel the nonce by hand
   (`ops/LAUNCH-SETTINGS.md`, "A stuck transaction").

## 3. Deploying v3.2 (spec section 7)

### 3.1 Before you start

- The fork rehearsal is green (Task 61, `pnpm ops rehearse --v32`), run again on the final build and settings (Task 65:
  `EXIT_GAS_RESERVE` 2,000,000, `MAX_CLAIM_GAS` 63,400,000, the launch `claimGasRequired` 55,000,000, the toward-Base
  gas pair 180,000 / 32,000). The testnet tasks (62 to 64) were dropped on 2026-11-11: what only the live chains can
  show is the mainnet canary's (3.5), right after the deploy and before any real money.
- Both oracle pools' observation slots in use are at least the oracle's `MIN_CARDINALITY` (its constructor refuses fewer,
  and the deploy simulates it first). See and write the steps (they print the cost in all):
  `pnpm ops cardinality`, then `pnpm ops cardinality --for-wallet --from <0x…>` and `pnpm ops sign <file>` **[FOUNDER
  ONLY]** (any account; each step with the gas limit it prints).
- `pnpm ops preflight` says all clear.
- **The treasury's key signs, on both chains** **[Ledger: treasury]** (the contracts review). The treasury
  `0x34D1f7DC8Cb62280d0bc617b784Bd2c4668809f6` (Ledger account 3) is written into both adapters and the front door for
  good, and has never signed on either chain. With the Ledger in MetaMask, on that account, sign one message with
  MetaMask on Bittensor EVM (chain 964), then on Base (8453). Any page that asks for a signature will do, such as
  MetaMask's own test page (https://metamask.github.io/test-dapp/, "Sign Typed Data V4": its message names the
  network's chain id, and it is the kind of signature the owner's stamps use). It is free: no transaction. Write down
  that both worked (in the canary record, 3.5). **If either fails, stop:** the deploy would name a treasury that can't
  sign.
- The validators: `pnpm ops verify --validators` reads the primary's and the standby's take, root stake and root uid.
- The monitor's scheduler alerts are live (admin.scheduled, admin.cancelled, admin.executed).
- The guardian is a different account from the owner (the constructors refuse the same one).
- **Task 66:** Bittensor's runtime is specVersion 452 or later (a precompile DELEGATECALL flaw was fixed there; it read
  490 on 2026-11-11). Read it, and check `specVersion` in the answer:

  ```
  curl -s -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"state_getRuntimeVersion","params":[]}' https://archive.chain.opentensor.ai
  ```

### 3.2 Deploy [FOUNDER ONLY]

```
pnpm ops deploy --v32 --live
```

It needs the two fresh deployer keystores (`OPS_V32_DEPLOYER_*`), the validators and the keeper's address, and deploys
Bittensor first, then Base, each from its own fresh single-use key at its planned nonces. It resumes after a stop. If a
create reverts, the plan is void: make new deployer keys and run `pnpm ops deploy --v32 --new-plan --live`.

Fund the two deployer keys first. With `OPS_DEPLOYMENT=v3.2-launch`, `pnpm ops budget` reads the rehearsal record and
today's gas prices and prints what to send each deployer key and the relayer, and what each role's steps cost. Send
the deployers what it says: deploy refuses to start unless each holds its creates' gas ceilings at twice the price, so
most of it (about 0.17 TAO and a little ETH at 2026-11-14 prices) is still in those keys after the deploy. Sweep a
deployer key back only once that chain's creates are all done: a send from it before then spends a nonce the plan holds
for a create, and voids the plan.

It prints three funding steps and sends none of them. Send each exactly as printed, no more: anyone's `sweepSurplus()`
sends the native TAO above the reserve's target, and any FM-TAO the cushion's books don't hold, to the treasury, and
the monitor's `bridge.cushion_low` warns only below half a target.
1. the vault's `ED_RESERVE`, by substrate transfer to the vault's SS58 account (an EVM transfer is refused);
2. `fundReserve()` on the Bittensor adapter, from any funded account you name (the file carries what its reserve
   lacks; a plain transfer to the adapter reverts) **[Fork: T61, done 2026-11-13: the file's fundReserve() with
   0.0010005 TAO, sent from a plain account, 23,208 gas; the reserve then read 0.0010005 TAO, as a fork keeps the 500
   rao that Bittensor's EVM leaves out]**:

   ```
   pnpm ops fund-reserve --from <0x…> --for-wallet --live
   pnpm ops sign <file>
   ```

3. the adapter's 0.001 FM-TAO token cushion, by `approve` then `fundCushion`, from any account that holds the FM-TAO
   on Bittensor (one file, two calls: sign them in order) **[Fork: T61, done 2026-11-13: the approve (46,353 gas) then
   fundCushion (81,898 gas), sent in order from the account below; verify then read the booked cushion as 0.001 FM-TAO
   and passed; before it, the empty cushion was its one failure]**. Since 2026-11-14 verify also fails on a native
   reserve under 1 rao (a delivery short by a rao parks until it is funded), so before steps 2 and 3 expect two failures,
   both the adapter's: the empty reserve and the empty cushion.

   First get the FM-TAO into that account, from ForeverMoney **[Fork: T61, done 2026-11-13: a plain account (no code, no
   role) called it with 0.002 TAO and 1999999, and got 0.002 FM-TAO; any account may call it (ForeverMoney's source,
   verified on Sourcify: no role, only not halted, no migration announced, the token listed), and it mints the stake it
   actually received, in rao, refusing less than `minAlphaRao` (Slippage); the fork's staking precompile is a stand-in
   that stakes the whole amount]**. From that account, call
   `depositLiquid(token, minAlphaRao)` on ForeverMoney's AlphaVault, `0x11837459896D96F821a8D88eC93a3C8D152033D4`
   (the adapter's `alphaVault()`), with native TAO as the value: a whole number of rao, at least the chain's minimum
   stake (0.002 TAO on 2026-11-11). `token` is the FM-TAO token, `0xC5b6C1632d34901239396F5E1BDe54B342900256` (the
   adapter's `token()`), and `minAlphaRao` the value in rao less 1, as the adapter asks (for 0.002 TAO: 1999999). It
   mints the FM-TAO to the sender, about as much as the TAO sent. Send it outside the sign page, which sends only
   Cascade's calls. `fund-cushion` refuses while the account holds too little. Then:

   ```
   pnpm ops fund-cushion --from <0x…> --for-wallet --live
   pnpm ops sign <file>
   ```

   **Never by a plain token transfer.** The adapter books its cushion (`tokenCushion`). A plain transfer is surplus,
   and anyone's `sweepSurplus()` sends it to the treasury. A surplus never refills the cushion, even below its target:
   only `fundCushion` does (R6b, U7; the contracts README's older sweep sentence says otherwise). `pnpm ops verify`
   fails while the booked cushion is under 1 rao (it covers a mint at most 1 rao short).

### 3.3 Check it

```
pnpm ops verify --live
```

Every contract's code, every setting, the rails, the exits state, the parks and the scheduler. The keeper never waits on
a stored `verify.ok`: a later verify can fail a healthy vault after a legitimate owner change; the keeper checks what
must always be true live, each round.

**Go no further while it fails.** Fix each failure and run it again. Right after the deploy, an unfunded token cushion
(step 3 of 3.2 left out, or done by a plain transfer) is one of them: verify is the only check that reads it.

### 3.4 The treasury's redeem origin, before the first deposit [Ledger: treasury]

Right after deploy, before the first reward cut (so no front door can ever burn the treasury's cut shares):

```
pnpm ops set-redeem-origin --for-wallet --live
pnpm ops sign <file>
```

The treasury always keeps a small holding of shares (it never redeems its last), so the supply never reaches 0 and
vested rewards are never left with no holder.

`verify` warns until it is done. A treasury changed later (a scheduled `setRewardCut` naming a new one) needs its own:
run the same command once that item has executed (it reads the treasury the vault names now) and sign it from the new
treasury's account before the next claim mints it a cut.

### 3.5 The mainnet canary, before any real money (spec section 7, step 4) [FOUNDER ONLY]

The testnet (Tasks 62 to 64) was dropped on 2026-11-11: this canary, on mainnet with tiny amounts, checks what only the
live chains show (the staking precompile, a real claim, the live gas), right after 3.1 to 3.4 and before any real
deposit. The contracts are immutable: **a step that fails is a stop.** Deposit nothing more until it is understood (a
wrong constant means new contracts, which costs little now and much later).

**The record.** Keep it in `ops/deployments/v3.2-launch-canary.md` (git-ignored, beside the deployment record; it is
never pushed). For each step: the time (UTC), each transaction's hash, its gas limit and its gas used, and pass or
fail. The keeper prints one `GAS USED:` line for each claim and each payout (`pnpm ops keeper status` keeps them; a
hand run prints them too). Read any other transaction's gas used on its explorer (evm.taostats.io for Bittensor,
basescan.org for Base).

What each gas figure is held to:

| What | Its gas | Passes when |
|---|---|---|
| A delivery to Bittensor (a batch) | the batch's CCIP limit, 1,300,000 + 57,000 an entry, is its receiver's alone | it is SUCCESS at the executor's first attempt, nothing parks, and its receiver's share: the OffRamp execution's gas used less a token-only execution's on the same OffRamp (about 283,000 on Bittensor's, 278,000 on Base's, read 2026-11-15), is under 712,658 for one deposit (the fork's least receiver gas, 412,658, plus 300,000 for the live precompile's calls) |
| A delivery to Base (a payout chunk) | its CCIP limit, 180,000 + 32,000 an entry, is its receiver's alone | it is SUCCESS at the executor's first attempt, and its receiver's share (as above: less about 278,000) is under 180,200 (85% of 212,000) for one payout (the fork's least: 126,003) |
| A payout or a direct exit | its gas limit: the estimate + 2,000,000 (`EXIT_GAS_RESERVE`) + 400,000 a listed hotkey | it goes through, and its gas used less 145,000 for each removal in its receipt (each `Unstaked` or `UnstakeSkipped`) is at most 1,000,000: half the reserve, the contracts' own two-to-one rule |
| A claim | a 57,000,000 limit; the vault's `claimGasRequired` 55,000,000; `MIN_CLAIM_GAS` 54,100,000 | step 7 |
| A park's write (only if a delivery parks) | `PARK_GAS_RESERVE` 150,000 (the fork's worst: 59,344) | the delivery logs `BatchParked` and the park job delivers it |

The two delivery rows compare like with like: the fork measured the least gas the receiver's call needs, while the
explorer shows the whole transaction (the intrinsic gas, the committee's signature checks, the token pool, the Router),
so a delivery's figure is its gas used less what an execution with no receiver call already costs on that OffRamp
(read 2026-11-15 from token-only executions: 282,789 to 282,825 on Bittensor's, 265,839 to 277,790 on Base's).

**The auto-claim watch** (the contracts review's M-3). At each of steps 3 to 7, before step 8's gift, record the
vault's surplus stake and the primary hotkey's stake for the vault's coldkey (read only):

```
cast call <vaultLens> "surplusStakeRao()(uint256)" --rpc-url https://lite.chain.opentensor.ai
cast call 0x0000000000000000000000000000000000000805 "getStake(bytes32,bytes32,uint256)(uint256)" <primary> <vaultColdkey> 0 --rpc-url https://lite.chain.opentensor.ai
```

`<vaultLens>` is the record's vault lens, `<vaultColdkey>` the vault's coldkey as 0x… (32 bytes: the record's
`plan.vaultColdkey`). A stake or an unstake moves both the booked stake and the chain's, so the surplus stays put; a
rise of the surplus, or of the primary's stake beyond what the vault staked, with no claim between the two readings,
means the chain claimed root rewards onto the vault's stake by itself (auto-claim): adopted later as a surplus, they
would bypass the reward cut. **If it happens, stop:** record both readings and when, and the founder decides before any
other people's money.

**Read-only checks first** (nothing is signed; before step 1). Two reads the vault's code trusts the live chain for
(R11, ChatGPT r3), each recorded:

- **The live runtime's limits.** The write-off read's 45,000,000-gas cap is the chain's ceiling for that read under
  spec 490: at most 256 staking hotkeys a coldkey (`MAX_STAKING_HOTKEYS`) on at most 128 subnets and root. Read the
  runtime's version:

  ```
  curl -s -H "Content-Type: application/json" -d '{"id":1,"jsonrpc":"2.0","method":"state_getRuntimeVersion","params":[]}' https://lite.chain.opentensor.ai
  ```

  Record its `specVersion`. `MAX_STAKING_HOTKEYS` is a constant in subtensor's code (`pallets/subtensor/src/lib.rs`),
  not a value the chain stores: if `specVersion` isn't 490, read it in that release's source before going on. Then the
  subnet limit (`SubnetLimit`) and the count of subnets now (`TotalNetworks`), each a u16 stored little-endian, through
  the storage-query precompile (0x8000 is 128):

  ```
  cast call 0x0000000000000000000000000000000000000807 0x658faa385070e074c85bf6b568cf0555a336e39c4086c4d5f43b7e6dff8a04f6 --rpc-url https://lite.chain.opentensor.ai
  cast call 0x0000000000000000000000000000000000000807 0x658faa385070e074c85bf6b568cf05555f3bb7bcd0a076a48abf8c256d221721 --rpc-url https://lite.chain.opentensor.ai
  ```

  An empty answer (`0x`) is no entry, or another name in this runtime: read them in polkadot.js apps' Chain state
  instead (subtensorModule, subnetLimit and totalNetworks). **Passes:** `MAX_STAKING_HOTKEYS` at most 256 and the
  subnet limit at most 128; record the count too.
- **What `pnpm ops verify --live` (3.3) reads for this:** the write-off read's gas, against the vault's 45,000,000 cap
  (eth_estimateGas of the precompile's `getTotalColdkeyStakeOnSubnet` for the vault's coldkey on root), and the same
  read by eth_call, which must answer one word (R12d: an address with no precompile would price at 0 gas); the
  `canSendPayouts()` of the vault's primary bridge as read now (the record's Bittensor adapter at launch; R12d: a line
  names any other) true, asked from the vault with 150,000 gas, as the vault reads it; and the AlphaVault's
  `isPaused()`, `migrationReadyAt()` and `migrationFinished()`, each answering within 30,000 gas, as that bridge
  reads them. Record its three lines. **Passes:** none of them fails, and `canSendPayouts()` reads true. A
  missing getter, or one over 30,000, would make the adapter read payouts closed for good (every door unstake
  deferred, its fee lost), and a write-off read over the cap would leave a write-off unbounded: either is a stop.

1. **A deposit, 0.04 TAO** (the minimum). On the site: Stake, 0.04 TAO, from your own wallet. The Worker closes the
   batch when it is due (or `pnpm ops close --live`) and prints `Bridge message <messageId> sent`. Record the deposit,
   the close (its gas used), the message id and its delivery on Bittensor (the OffRamp's execution: its gas used).
   **Passes:** the shares reach your address on Bittensor (the site's balance), the delivery's gas is as the table
   says, and nothing parks.
2. **A cancel, 0.04 TAO.** Deposit 0.04 TAO again, wait 5 minutes (a cancel works 5 minutes after the last deposit to
   your entry: the site counts it down), and cancel it on the site before its batch closes. The keeper holds a batch
   this small for its fees, so it waits; should it leave first, deposit again. Record the cancel's transaction.
   **Passes:** the receipt held the cancel until the wait was over; the 0.04 TAO is back in your wallet, and the batch
   closes without it (or rolls empty).
3. **The sweep, then the stake.** First anyone's `sweepSurplus()` on the Bittensor adapter with nothing to sweep, from
   any funded account: the stamp relayer's, say (`<bitAdapter>` is the record's Bittensor adapter; the keystore and its
   password file are `OPS_RELAYER_KEYSTORE` and `OPS_RELAYER_PASSWORD_FILE`):

   ```
   cast send <bitAdapter> "sweepSurplus()" --keystore <keystore> --password-file <password-file> --rpc-url https://lite.chain.opentensor.ai
   ```

   Then the stake: the Worker stakes the idle TAO (or `pnpm ops stake --live`). Record both transactions and the
   stake's gas used (the live `addStake` estimate was 104,208). **Passes:** the sweep moves nothing
   (`pnpm ops verify --live` still reads the reserve and the cushion at their targets); the booked stake rises by what
   was staked, on the primary hotkey (`pnpm ops verify --live` prints `bookedStake()`).
4. **A redeem, 0.03 TAO, through an unstake, a day after step 1's mint.** Wait until at least 24 hours after step 1's
   delivery minted your shares (its time on evm.taostats.io): the door hold lets a front door burn only shares held a
   day (`STAKE_RAMP`), and a redeem delivered sooner is deferred (`RedeemDeferred`): no payout comes, the request fee
   is spent, and it reads as a failure. Steps 2 and 3 fit in that day. Then, on the site: Unstake 0.03 TAO. Its batch
   closes, the vault queues the
   payout, and after the payout delay (24 hours) the keeper pays it out (or `pnpm ops payouts --live`). The vault's TAO
   is staked since step 3, so the payout's walk unstakes (an `Unstaked` in its receipt): the canary's live
   `removeStake`. Then claim the TAO on Base (the site's Withdraw). Record the payout's `GAS USED` line, its removals,
   the message to Base and its delivery's gas used, and the claim. **Passes:** the TAO arrives on Base; both gas figures
   are as the table says.
5. **The stamp, per chain, with the real Ledger on the page.** `pnpm ops stamp both --live`, then
   `pnpm ops sign <file>`: the Ledger signs one stamp for each chain on the page, and the relayer submits them. Record
   both stamps' transactions. **Passes:** each chain's `lastOwnerClose` reads its stamp's `asOf`
   (`pnpm ops pending --live` shows the owner's clock).
6. **The 48-hour change** (Task 67). A no-op setting on the owner's clock, after step 5's `asOf` (the stamp rule,
   section 4): `pnpm ops schedule vault setRewardVesting <seconds> --for-wallet --live` with today's value, 2592000
   (30 days), signed with `pnpm ops sign <file>`. Before it, one more scheduled the same way and cancelled by the
   guardian (`pnpm ops pending --live` names its id):

   ```
   pnpm ops cancel <id> --as guardian --for-wallet --live
   pnpm ops sign <file>
   ```

   After 48 hours, `pnpm ops execute <id> --for-wallet --live`, then `pnpm ops sign <file>`.
   **Passes:** the cancelled one can't run; the other executes (`Executed`), and the monitor emailed `Scheduled`,
   `Cancelled` and `Executed`.
7. **A claim, with its gas.** Once a day of rewards has accrued on the primary hotkey (from step 3's stake). At a
   canary's stake they are far under the chain's `RootClaimableThreshold` for root: it has no entry on mainnet, so its
   default holds, 500,000 rao (0.0005 TAO; read 2026-11-15 by `state_getStorage`), and subtensor skips a root claim
   whose payout is under it (it logs `root claim skipped (below threshold)`), paying nothing. The vault's claim then
   lands and books 0. The claim policy waits for rewards worth 25 claims, which a canary's stake never has, so for this
   one claim put `OPS_CLAIM_COST_TAO=0.000000001` in ops/.env (it changes only what a hand run decides), then
   `pnpm ops claim <hotkey> --live` (it checks and simulates), then `pnpm ops claim <hotkey> --live --send`. Take the
   line out of ops/.env afterwards. Record: the gas limit sent (57,000,000), that the pool accepted it (the
   transaction has a block), which block, how many tries it took (a 57,000,000-gas transaction is most of a block's
   weight and needs a fairly quiet block; the keeper's own claims try again each round), its `GAS USED` line and what
   it booked (`RewardsClaimed`). **Passes** at a canary's stake: status 1, those figures recorded, and `RewardsClaimed`
   with 0 (a skipped claim's gas, not a full one's). With rewards above the threshold: status 1, `RewardsClaimed` with
   what it booked, and its gas used the precompile's need (53,200,000, its declared weight) plus the vault's own work,
   under the limit; the vault's `MIN_CLAIM_GAS`, 54,100,000, is that need at the call's 63/64 forwarding (what must
   be left at the call). A full claim's gas is measured by the first claim of real rewards (your own deposits): the
   keeper's `GAS USED` line records it, and it is the real claim your deposits stay small until (below).
   **If it needs more:** a claim that reverts `InsufficientGas`, or burns its whole limit, needs more than 55,000,000
   left. The owner raises `claimGasRequired` (immediate both ways) to what it needed plus a margin, at most 63,400,000
   (the vault's top: with the claim's own work it is the most Bittensor's per-transaction limit, about 65,000,000,
   holds; the keeper sends a claim with at most 64,900,000, which at that top setting still forwards about 63,600,000 to
   the claim, so a claim that needs up to about that is met there). **[Ledger: owner]**:

   ```
   pnpm ops set-claim-gas <gas> --for-wallet --live
   pnpm ops sign <file>
   ```

   It refuses anything outside 54,100,000 to 63,400,000, and so does the sign page. Above about 62,500,000, raise the
   spend cap too (2.2). Then claim again, and record it.
8. **An adoption** (before the direct exit, while step 1's shares are still out). Give the vault a little root stake
   it doesn't book: from your own coldkey, a stake transfer (btcli's `stake transfer`) of at least the chain's minimum
   stake (0.002 TAO on 2026-11-11) to the vault's coldkey (its SS58 account, in 3.2's first funding step) on the primary
   hotkey, which the vault lists (onto an unlisted hotkey the chain refuses it: the vault's reject flag). A day after
   the last adoption or the deploy (`STAKE_RAMP`), `pnpm ops adopt --live` checks it, and
   `pnpm ops adopt --live --send` sends it (or the Worker does). Record both. **Passes:** the transfer lands,
   `StakeAdopted`, and the booked stake rises by the gift. The gift vests over the adoption drip to the shares
   outstanding; what is still vesting when step 10 takes the supply to 0 belongs to no holder, and the next mint (step
   11's deposit) leaves it out of its price, so it vests to that depositor (`_unvestedForMint`: written down only if a
   loss left the drips above what the vault holds).
9. **The staking precompile's two refusals, read only** (no transaction: an `eth_call` from the vault's address with
   `cast call`; nothing is signed), before step 10 empties the vault's position on the primary. `<vault>` is the
   vault's address, `<standby>` and `<primary>` the two hotkeys as 0x… (32 bytes):

   ```
   cast call 0x0000000000000000000000000000000000000805 "removeStakeFull(bytes32,uint256)" <standby> 0 --from <vault> --rpc-url https://lite.chain.opentensor.ai
   cast call 0x0000000000000000000000000000000000000805 "removeStake(bytes32,uint256,uint256)" <primary> 2000000 0 --from <vault> --rpc-url https://lite.chain.opentensor.ai
   cast call 0x0000000000000000000000000000000000000805 "removeStake(bytes32,uint256,uint256)" <primary> 2000000 0 --from <vault> --gas-limit 60000 --rpc-url https://lite.chain.opentensor.ai
   ```

   **Passes:** the first, on an empty position (the standby, listed and never staked), reverts rather than paying 0
   (contracts/README.md, checklist item 2). The second is the same call with no gas limit, which must succeed: it takes
   2,000,000 rao (0.002 TAO, the chain's minimum stake: the chain refuses a partial unstake below it whatever the gas,
   contracts/README.md's "The staking floor") off the vault's position on the primary (what is left of step 1's TAO,
   with step 8's gift), and shows the third's revert is the gas's. The third, that call under a capped gas, must revert
   with no data, as the walk's `try` expects of a removal starved of gas (it skips the pair, `UnstakeSkipped`:
   checklist items 5 and 6). Record the three answers. An `eth_call` can't show what a starved removal costs: whether a
   starved removal burns its gas stays with step 4's `GAS USED` line and step 10's gas used (each against the table's
   rule). A held pair's refusal needs a root hold (`RootStakeUnlockInterval` above 0), which mainnet does not have
   today: recorded as not reproducible, the mock and fork tests standing.
10. **A direct exit, on Bittensor.** On the site: Unstake, "withdraw straight from the vault on Bittensor"
    (`/unstake/bittensor/`): set your redeem origin, then withdraw what is left of step 1's shares. Record the
    withdrawal's gas limit and gas used, and its removals. **Passes:** the TAO arrives at your address on Bittensor; the
    figure is as the table says.
11. **The live empty-proof test** (the founder agreed it on 2026-11-14), only once steps 1 to 10 pass. One more 0.04 TAO
    deposit: its batch's Base → Bittensor message is the test. Anyone may call the OffRamp's `execute` with empty
    committee results on a message no one has executed yet: the OffRamp writes FAILURE, and Cascade's receiver is never
    called. This step does it to our own message, before Chainlink's executor delivers it, to see what follows.
    - **The window: send it within 15 minutes of the close.** The command needs only the close's log on Base, so it
      can go as soon as the keeper prints `Bridge message <messageId> sent`. On this lane Chainlink's executor delivered
      Cascade's six past messages (the v2 test's and v3-test's, October 2026) 16.4 to 19.6 minutes after their send
      (16.4, 18.6, 18.6, 18.9, 19.3 and 19.6; read 2026-11-15 from Bittensor's archive node and mainnet.base.org): it
      waits for the committee, which waits for Base's finality. The empty proof needs no committee result: it fails the
      OffRamp's check whenever it lands, so the only race is with the executor. If the executor wins, the command says
      so and nothing is lost: try again with the next deposit.
    - Check it, then send it (the keeper's key, under the Worker's lease):

      ```
      pnpm ops reexec <messageId> --empty-proof --live
      pnpm ops reexec <messageId> --empty-proof --live --send
      ```

      It refuses anything but an untouched message of Cascade's own, on a lane of Cascade's own, and simulates first.
      It prints `Done … is in FAILURE, written by this empty proof`, with the time 2 hours on.
    - **Watch** `pnpm ops reexec <messageId> --live` (it reads the state; a check sends nothing). Chainlink's docs say
      its executor retries a FAILURE for up to 8 hours. Record when the message becomes SUCCESS and who sent the
      execution (its transaction on evm.taostats.io).
    - **The lane.** The lane would wait only after 30 minutes in FAILURE, and the executor delivered this lane's
      messages 16.4 to 19.6 minutes after their send (above): when it is on time the message is SUCCESS first, so the
      keeper's `CCIP FAILURE … The lane does not wait for it` line and the monitor's `ccip.failure` email are the check
      (a critical alert, which holds nothing). Only if it is still in FAILURE after 30 minutes, deposit once more: the
      Worker still closes its batch.
    - **If it is still in FAILURE after 2 hours,** recover it with the real committee results (section 6: they come
      from Chainlink's CCIP API here, since our attempt carried none): `pnpm ops reexec <messageId> --live --send`.
    - **Passes:** the message is delivered (by Chainlink's executor or by the recovery), the shares are minted, and the
      lane was never held. Record which one delivered it, and when.

Then your own deposits, **small until a real claim (one that books rewards, held to step 7's rule) and a full exit
have succeeded**: a full exit is every
share of one address paid out on Base, or withdrawn on Bittensor, with the gas as the table says.
**Deposit only from your Ledger's own accounts, and never `depositFor` a contract address:** whoever controls a
contract's address on Bittensor can withdraw its shares there (R6, ChatGPT R2 claim B: a known risk, no contract
change; the site's full refusal of contract wallets comes before other people's money).

### 3.6 Keep the guardian's offline pause ready [Ledger: guardian]

Right after deploy, write the emergency pause with no chain read, and keep the file:

```
pnpm ops pause both --for-wallet --offline
```

It is for an incident in which ops' RPC for a chain is down while MetaMask's own network still works: `pnpm ops sign
<file>` serves it with no chain read either (7.1 step 1). What it fixes in advance is only what the deploy fixed for
life: the record's front door and vault, their chain ids, the call (`pause()`, no argument) and the sender (the
record's guardian). It fixes no gas, fee or nonce: MetaMask sets those when you sign. Why that is safe to keep:
`pause()` only stops things and the owner's `unpause()` undoes it; the contracts take it only from the guardian or the
owner; and the sign page serves a file marked offline only while every call in it is that pause. After a
`setGuardian`, write it again (the old file's call would be refused).

## 4. Day to day

- `pnpm ops keeper status`: the Worker, its lease, its last runs.
- `pnpm ops pending --live`: each scheduler's items that can still run, when each is ready, who can cancel it.
- The monitor emails every `Scheduled`, `Cancelled` and `Executed` on both chains. **Any you didn't cause: section 7.2.**
- The stamp bot (section 7.2) runs `pnpm ops stamp --relay-due --live` on this PC every hour. While it runs, set the
  monitor's THRESHOLDS `stampQuietS` (about 50400: 14 hours) so `admin.stamp_quiet` pages when it stops (the PC off,
  the relayer out of gas, the stack run out); set it back to 0 while the bot is off on purpose (7.3).
- **Rewards vest over 30 days** (`rewardVesting`, the contract's maximum), so a holder present only while rewards vest
  takes no more than its time share of them (this also closes the vault-favour review's Low 2). Keep it there. The
  keeper says `REWARDS VEST TOO FAST` while it is shorter. A shorter vesting brings the claims with it, not the other way
  round: the claim round comes 2 days before each claim schedule ends (half the period for a vesting of 4 days or
  less), so the first staked hotkey in the vault's list is then claimed about every vesting period less that lead, each
  claim at its full fee (R7, L6). Below about 7 days the others don't keep that pace: the 5-day slack that lets a round
  of four end (R7, M2) is then longer than the period less the lead, so each other staked hotkey is claimed about every
  5 days and one such period more (every 6 days at a 4-day vesting, every 8 at 6 days; R8, L-E). To shorten it anyway, a 48-hour item **[Owner, scheduled]** (the stamp rule, section 4):
  `pnpm ops schedule vault setRewardVesting <seconds> --for-wallet --live`.
- **The keeper claims every staked hotkey in one round:** 2 days before the claim schedule ends, 28 days at the latest
  after any staked hotkey's last claim, or sooner once rewards worth 25 claims wait on one. The others follow in the
  same round (each last claimed more than 5 days before the schedule's restart), even a standby whose own claim costs
  more than waits on it (its `Rewards on hotkey` line says the cost). A claim on one hotkey restarts the whole schedule,
  so they go together (R6b, U1 and U2); the 5 days cover a round of 4 hotkeys at one claim a day, so the round ends
  (R7, M2). At launch that is about two
  claims a month, about 0.057 TAO each at 1 gwei; the spend cap still bounds them. Only the keeper may claim while
  rewards still vest; anyone may once they have vested and 7 days have passed since that hotkey's last claim.
- **`batch.redeem_fee_thin`** (a warning): a full redeem list's fees (`redeemRequestFee` × `maxRedeems`, 50) cover the
  bridge fee to close a full 50 + 50 batch less than 1.5 times. A redeem request needs only its fee, no shares, so
  anyone can fill the list with fake ones; while the fees cover the close the spam pays for itself (into the pot), and
  below it a junk-filled list can't close itself (the next request reverts `InsufficientFee`) and the keeper pays the
  rest from its ETH. No user funds are at risk. At the launch's 0.0002 ETH (the founder, 2026-11-16; at the 0.0001 ETH
  before, about 1.2 to 1.6 times) a full list pays 0.01 ETH against a quote of about 0.0031 to 0.0043 ETH, about 2.3 to
  3.2 times, so it is quiet at launch and warns only once a full batch's quote passes about 0.0067 ETH (a rise in TAO/ETH
  or in Bittensor's gas price). The response is **[Ledger: owner]**
  `setRedeemRequestFee(<wei>)` on the front door: immediate, at most 0.001 ETH (`MAX_REDEEM_REQUEST_FEE`); the email
  names the fee that covers 1.5 times. Each user pays it once per batch they request in. The launch's fee is a
  constructor argument (`SETTINGS_V32_LAUNCH.frontDoor.redeemRequestFee`). No ops command writes this call yet, and the
  sign page refuses a call it doesn't know: have the command added, as `set-claim-gas` was, before you need it.

**The stamp rule (before you schedule anything).** A relayed owner stamp kills every item on the owner's clock scheduled
at or before its `asOf`, of every kind. With a pre-signed stack relayed every 12 hours, an item scheduled inside the
stack's horizon is dead by the next stamp, and its `execute` reverts after the whole wait. So:
- before you schedule anything, check the stack's last `asOf` (`ops/stamps/bittensor.json` and `ops/stamps/base.json`)
  and schedule after it. pnpm ops schedule warns before it writes when a signed stack on this PC reaches the item's
  schedule time, and, when it finds no stack it can read, says to check the relayer's stack by hand;
- sign no new stack reaching past an item's schedule time until that item has executed. Every new stamp is as of a
  later time, so in practice: no new stack while an item you mean to keep is pending. The monitor's `Scheduled` alerts
  stay your watch meanwhile (section 7.2).

Each scheduled step in this runbook points here.

What the keeper does each minute: pays out due batches, delivers USDC where users asked, stakes idle TAO, closes or
rolls the open batch, runs the park jobs, reports CCIP FAILUREs, adopts a surplus, claims rewards per hotkey, and frees
a swap's old hotkey's slot (section 7.5). It closes, rolls and flushes nothing while the vault reads paused, its launch
door isn't Active, or stake is missing: the batch then waits on Base, safe.

## 5. The keeper's one-shots by hand

All sign with the keeper's key, under the Worker's lease (2.7 for without it). Each checks first; only `--send` sends.

```
pnpm ops claim <hotkey> --live
pnpm ops claim <hotkey> --live --send
pnpm ops adopt --live --send
pnpm ops add-hotkey <hotkey> --live --send
pnpm ops remove-hotkey <hotkey> --live --send
pnpm ops park --live
pnpm ops park <key> --live --send
```

- `claim`: each listed hotkey by the claim round (section 4), and a hotkey with none of the vault's stake whenever
  credits wait on it.
  It refuses while the cap can't fit a claim, and, with the root hold set, while a payout is due (section 7.6).
  A claim that reverts with nothing to explain it holds that hotkey's claims a day (a `HELD` line), and so does one
  whose receipt came late and reverted (R8, M-A). Each repeat doubles the hold, 2, 4, 8, then 16 days at most (a
  `CLAIM REVERTED AGAIN` line each time). A hold ends early only once a claim on that hotkey has paid (its last claim
  moves past the hold), never on its credits, which rise every epoch and which an unstake can lower (R7 M1, R8 L-B), or
  once the vault's `claimGasRequired` changes (R8, L-A). So a hotkey whose claim can't land costs one claim's fee every
  16 days at most. Check the hotkey and the vault's `claimGasRequired`
  (`pnpm ops set-claim-gas <gas> --for-wallet --live`); on a hotkey with no stake, the owner removes or fixes it.
  **Once you have fixed the cause, claim by hand** rather than wait out the hold: `pnpm ops claim <hotkey> --live --send`
  ignores the hold, and a claim that pays ends it (a new `claimGasRequired` ends it at the keeper's next reading too).
  The Worker keeps its holds in its saved memory; a PC `run` keeps them in the process, so a restart forgets them.
- `add-hotkey`: the keeper lists a hotkey (a swap's new hotkey, the standby). `<hotkey>` is 0x… or its SS58 address.
- `remove-hotkey`: the keeper frees an empty slot: not the stake hotkey, none of the vault's stake, no credits waiting.
  It also refuses while Bittensor still owes the vault deferred rewards on it (the unclaimed read leaves them out) above
  the dust allowance, as does the guardian's removal file (R6b, U9): a claim pays them once they convert, then remove
  it; or the owner gives them up (`pnpm ops remove-hotkey <hotkey> --as owner --forfeit --for-wallet --live`).
- `park`: Cascade's parks due a job (deliver, convert, refund, drop), as the park job reads them.
  `OPS_PARK_REFUND_FEE_MAX` caps a refund's bridge fee (0.05 TAO by default); it is bounded only by the spend cap.
- `close`, `stake`, `payouts`: as on v3-launch, they send as run (`pnpm ops payouts --live`). A hand close or payout
  first warns when its lane has a CCIP FAILURE of Cascade's open. During ForeverMoney's migration notice, `close` is the
  notice's one close (7.7).
- **The spend cap hit by many one-entry payout batches** (`SPEND CAP` lines, each batch forced by 49 junk redeem
  requests) is griefing: the keeper pays each batch's payout gas. Honest payouts wait up to a day; anyone can pay a batch
  by hand meanwhile (`pnpm ops payouts --live`). The cap is sized against the measured payout gas at the rehearsal.
  **[Fork: T61]**

## 6. A CCIP FAILURE, re-executed by hand

A message whose delivery reverted stays in CCIP `FAILURE` on its destination's OffRamp, with no expiry. **Its tokens stay
locked in the bridge until it is re-executed: nothing is lost.** The keeper reports each one of Cascade's
(`CCIP FAILURE: bridge message …`) with the command to run. Automatic re-execution stays off (`OPS_REEXEC_AUTO` off in
`wrangler.jsonc`) until you turn it on after the rehearsals.

1. Check it (a check signs nothing and takes no lease, so the Worker goes on):

   ```
   pnpm ops reexec <messageId> --live
   ```

   It checks the message is Cascade's own, in FAILURE, its bytes rebuilt; takes the committee's results from the first
   source that has them (below); and simulates. It never sends empty results.
2. Send it:

   ```
   pnpm ops reexec <messageId> --live --send
   ```

   Under the Worker's lease (or `--without-lease "<reason>"`), through the one send path.
3. **Where the committee's results come from, in order.** A FAILURE written by a stranger's empty or junk proof carries
   none, so:
   1. `--proof <file>`, or `--proof 0x…`, when you give them: a file of `{"ccvs": [...], "verifierResults": [...]}`, or
      the CCIP API's answer saved as a file, or the calldata (hex) of any other `execute` of the same message that
      carried them;
   2. `--from-tx <hash>`: another attempt's transaction to the OffRamp;
   3. by default, the attempt that wrote the FAILURE (its public calldata), unless it carried none;
   4. then Chainlink's CCIP API, read on this PC: `https://api.ccip.chain.link/v2/messages/<messageId>/execution-inputs`
      (the committee's results the CCIP Indexer collected; Chainlink's docs, "CCIP Manual Execution"). Its answer is
      checked against the message's rebuilt bytes and the lane's OffRamp, then simulated, as any proof is.
   If none has them, it says so and sends nothing: wait (Chainlink's docs say its executor retries a FAILURE for up to
   8 hours; the canary's step 11 checks it), then try again.
4. Out of gas: raise it with `--gas <limit>`: `pnpm ops reexec <messageId> --gas <limit> --live --send`.
5. If the monitor itself is out, a hand run may go ahead for a while:
   `pnpm ops reexec <messageId> --live --send --ignore-monitor-outage --until <utc-time>` (`<utc-time>` is a UTC time in
   ISO form at most 24 hours ahead, e.g. `2027-01-18T14:05Z`; an outage only, never a hold).

On a mainnet fork (Task 61) the reports print `--live`, since a fork keeps the live chain ids. The CLI can't run them
there: without `--live` it expects the anvil chain ids (31337, 31338) and refuses, and `--live` uses the live record and
RPCs. On a fork, call the same command functions in process with the fork's context, as the rehearsal does. While one of Cascade's FAILUREs stays open 30 minutes, the keeper sends nothing new on that lane
(toward Bittensor no close; toward Base no payout or park refund); everything else goes on. **Except a FAILURE whose
failing attempt never reached Cascade's receiver** (the OffRamp refused its committee results, or it carried none: a
stranger's empty or junk proof, which anyone can send): the keeper says so in its `CCIP FAILURE` line and holds no lane
for 8 hours 30 minutes from when it first saw it (Chainlink's docs say its executor retries a FAILURE for up to 8
hours), since nothing is wrong with Cascade's side; after that the lane waits as for any FAILURE, and the line says
so. Recover it as above; if it can't tell, it holds the lane as before.
**[Fork: T61: one real FAILURE recovered by hand, with real committee results]** **[Canary: 3.5 step 11]**

## 7. Incidents

### 7.1 The incident order

1. **[Ledger: guardian]** Pause both chains: one file, sign both calls (the front door's first).

   ```
   pnpm ops pause both --for-wallet
   pnpm ops sign <file>
   ```

   The front door's pause stops deposits and stamps nothing; a batch still closes (a pause never stops a close on
   v3.2), and frees every deposit's cancel at once (no 5-minute wait while it is paused). The vault's pause stops payouts and direct exits, and stamps the guardian's clock: Ordinary items die, a
   pending `setGuardian` and Reopens are spared. **[Fork: T61, done 2026-11-13: the guardian's pause() of the front door
   from its file, 49,794 gas: deposits paused, the exits open, verify passed; the owner's unpause() after, 25,122 gas]**

   If ops' RPC for a chain is down, sign the offline file kept ready (3.6) instead: `pnpm ops sign <file>` serves it
   with no chain read, and MetaMask sends it over its own network. While the vault refuses batches, warn depositors as
   7.5 says.
2. **[Ledger: guardian]** To stop closes too, disable the primary bridges (the guardian can no longer stop closes by
   pausing the door). One ordered file, the vault's bridge then the front door's on the command line, the front door's
   call first on the page:

   ```
   pnpm ops disable-bridge both <bridge> <bridge> --as guardian --for-wallet --live
   pnpm ops sign <file>
   ```

   Disabling a primary closes the exits on that chain and stamps the guardian's clock (Ordinary items die; a pending
   `setGuardian` and Reopens are spared). The vault's pause in step 1 is not enough alone against a stolen owner key:
   the owner can `unpause()` at once, and from then the vault takes every batch that arrives again. With a stolen owner
   key, first disable any spare enabled bridge (no record, no stamp), one file each
   (`pnpm ops disable-bridge vault <bridge> --as guardian --for-wallet --live`, or `front-door`), then the primaries with
   the command above, or the owner could switch to a spare and clear the hold in the same block. At launch there is one
   pair and no spare. **[Fork: T61, done 2026-11-13: the guardian's `disable-bridge both`, one ordered file, the front
   door's call first (53,998 gas), then the vault's (54,093); verify then failed on the exits and the bridges, as it must
   while they are closed. The Reopen was not rehearsed]**

   **The way back** is a 7-day Reopen on each chain **[Owner, scheduled]** (the stamp rule, section 4), which reopens
   the exits when it runs: `pnpm ops schedule both activateBridge <bridge> <bridge> --for-wallet --live` (the vault's
   bridge, then the front door's), and `pnpm ops execute <id> --for-wallet --live` for each once ready. Until then Base
   exits and payouts stop: no batch closes on Base, and no payout is sent.

   Only if the guardian can't sign, the owner's route **[Ledger: owner]**:
   `pnpm ops schedule both disableBridge <bridge> <bridge> --for-wallet --live` (direct calls in one file, the front
   door's first). It stamps the owner's clock on both chains and kills every item pending there, a pending `setGuardian`
   included.
3. A removal meant to last is the guardian's: `pnpm ops remove-door <chain> <door> --as guardian --for-wallet --live`
   (the door becomes unknown; the honest way back is `setGuardian` to the same guardian, 8 days, then a replacement,
   15 days). The owner account is only for a temporary hold, which only a Reopen of that door undoes.
4. **Ordering:** sign the stamping actions first, then schedule the items you mean to keep. An owner's pause, an
   owner's disable of a primary bridge, a launch-door cancel or an owner stamp kills every item pending on the owner's
   clock, your own `transferOwnership` included. Schedule in a later block than any of these closes: an item scheduled
   in the same second as a close would be dead at once, and the scheduler refuses it.
5. Unpause when it is over: **[Ledger: owner]** `pnpm ops unpause both --for-wallet`, then `pnpm ops sign <file>`. If
   step 2 disabled the primaries, the exits reopen only when their Reopens run (step 2's way back).

A rogue front door is answered by the guardian's pause (step 1), not by `remove-door`.

### 7.2 A copied seed, or any `Scheduled` alert you didn't cause

One Ledger owns everything until the Safe, so a copied seed copies the owner and the guardian together. The signed
stamp is the defence: it kills every item scheduled before its `asOf`. A stolen guardian is this section unless 7.3's
first paragraph says otherwise; while 7.3 has the bot off, this section still wins on any `Scheduled` alert you didn't
cause.

**Your time to act is the block floor's, not the whole delay.** An item runs only once its delay has passed and half of
it in blocks since it was scheduled. On Bittensor's 12-second blocks those blocks are in after about 40 hours of a
48-hour item (5.8 days of a 7-day one, 6.7 days of an 8-day one): cancel or stamp within that. A Bittensor halt that
starts after those blocks and spans the item's ready time lets it run in the first block after the resume (point 4).

1. **[Ledger: owner, then Relayer]** Stamp both chains now, as of each chain's head:

   ```
   pnpm ops stamp both --live
   pnpm ops sign <file>
   ```

   The page has the Ledger sign each stamp and hands it to the relayer (`OPS_RELAYER_KEYSTORE`), which submits it on its
   chain. Only if you ask on the page does it relay itself. A stamp signed elsewhere is relayed with
   `pnpm ops stamp vault --as-of <unix-time> --sig <sig> --live` (and `front-door`), with `--tip <gwei>` when it must
   land first. `<unix-time>` is the stamp's time in seconds, e.g. `1900000000`.
2. **Never refill a swept account.** A thief's sweeper takes it again.
   With both keys stolen, keep a small redeem request of your own waiting in the open batch: a batch with an entry is
   never rolled empty, so the thief can't keep restarting its timer. **[Fork: T61, done 2026-11-13: a due empty batch
   rolls on anyone's closeBatch; with one redeem request of 1 share waiting in it, the same call is refused
   (BatchTooSmall), so the batch can only be sent]**
3. Point the website at a fresh staker, stop offering USDC delivery (`pnpm ops keeper deliveries off`), and prompt
   preference holders to `claim()`.
4. After a Bittensor halt longer than about a day, the first block is a race: relay a fresh stamp at once with a high
   tip. A safe-mode freeze (blocks made, user transactions refused) is the same: on resume the guardian pauses and a
   fresh owner stamp goes out at a high tip. A halt doesn't lapse a pending item whose blocks are still to come: an
   item lapses only once both its 7 days and its window in blocks have passed (Revision 28), and a halt holds the
   blocks. After the resume, `pnpm ops pending` shows what can still run; cancel what you don't want.

**The stamp bot.** The relayer is a fresh key made with `cast wallet new`, funded on both chains, never from the Ledger
seed. Pre-sign a stack (a stamp every 12 hours, a short horizon):

```
pnpm ops stamp --stack <days> --live
pnpm ops sign <file>
```

The stack is kept in `ops/stamps/<chain>.json`, on this PC only (it is the relayer's; nobody else can relay it). The bot
runs `pnpm ops stamp --relay-due --live` every hour (Windows Task Scheduler on this PC). After an outage it relays the
newest due stamp first, which covers the older ones. The last stamp's `asOf` is the earliest date for any item you mean
to survive, the Safe's `transferOwnership` included. After an accepted ownership transfer, pre-signed stamps stop
working: sign a new stack.

### 7.3 A stolen guardian

**First, which case you are in.** The deciding fact is whether the guardian's key is held apart from the owner's seed:
on a separate Ledger or account (as after the Safe). Until then one Ledger seed holds the owner and the guardian, so a
stolen guardian means a copied seed: that is section 7.2, not this one. This section alone is for a guardian key held
apart that leaked. A thief's guardian actions show chiefly as `admin.exits_state` (the vault's pause, a primary's
disable, a door's removal) and `admin.cancelled` (an item cancelled) that you didn't cause; `keys.unexplained_tx` fires only for an admin key's
transaction that didn't touch Cascade, or reverted. No owner-side alert is not proof that the owner's seed is safe: a
thief holding it may simply not have used it yet. Any doubt: 7.2. And 7.2 wins on the first owner-side alert (a
`Scheduled` you didn't cause, or an owner action you didn't make).

**With the bot off there is no stamp defence.** For the 8 to 14 days below, nothing kills what a thief schedules except
a stamp by hand, and the monitor's `Scheduled` alerts are the only watch. On any `Scheduled` alert you didn't cause,
7.2 wins: stamp at once (7.2 step 1), accept that `setGuardian` and the Reopens die with the thief's items, and schedule
them again after that stamp's `asOf` (a new 8 days).

Use no owner instrument that stamps until `setGuardian` executes, **the stamp bot included**: the stamp rule (section
4) holds here above all. An owner stamp relayed as of the day you schedule or later kills the 8-day `setGuardian`, and
the stolen guardian stays in place. Before you schedule, check the stack's last `asOf` and schedule after it, or disable
the bot's task in Task Scheduler so none of the stack is relayed; sign no new stack, and keep the bot off, until
`setGuardian` and the Reopens have executed. **[Fork: T61: the whole sequence]**

**[Owner, scheduled]** the same day:
`pnpm ops schedule vault setGuardian <0x…> --for-wallet --live` (and `front-door`), and the Reopen of each bridge the
thief disabled: both chains' primaries, `pnpm ops schedule both activateBridge <bridge> <bridge> --for-wallet --live`
(the vault's bridge, then the front door's); one side's only, that chain's alone,
`pnpm ops schedule vault activateBridge <bridge> --for-wallet --live` (or `front-door`). On day 8 execute `setGuardian` first (`pnpm ops execute <id> --for-wallet --live`), then the Reopens
(their window ends on day 14). For a door the thief removed: cancel the door's payout batches, if at all, after the swap,
then schedule its activation, `pnpm ops schedule vault activateFrontDoor <chain> <door> --for-wallet --live` (7 days:
it runs on day 15). A stolen guardian can take over owner-removed doors; that takeover emits `Cancelled` for the Reopen
and `ExitsClosed`, bounded by the 15-day swap path.

### 7.4 A stolen keeper key

Section 2.6, at once.

### 7.5 Stake missing (most likely a validator's hotkey swap)

The monitor's `stake.missing` and the keeper's `STAKE MISSING` line name the hotkey whose stake left. Nothing is lost:
the vault mints nothing while it lasts. **The keeper holds every close, roll and the notice's flush while the vault reads
stake missing, paused, or its launch door isn't Active: the batch stays on Base.** Staking waits; payouts, claims and
deliveries go on.

1. Find where the stake went: the old hotkey's page on taostats shows the swap and the new hotkey. (No reader of the
   chain's `HotkeySwapped` events exists in ops: that search is by hand, on taostats or an archive node's events.)
2. **[Keeper]** List the new hotkey (anyone may, if it holds at least the chain's minimum and was never listed):

   ```
   pnpm ops add-hotkey <hotkey> --live
   pnpm ops add-hotkey <hotkey> --live --send
   ```

   Stake is no longer missing once it lands; closes and staking go on, and the parks deliver.
3. **[Ledger: owner]** Make the new hotkey the stake hotkey: `pnpm ops set-stake-hotkey <hotkey> --for-wallet --live`,
   then `pnpm ops sign <file>`. It applies at once when the new hotkey holds more than the old and at least half the
   booked stake (after a whole swap it does); otherwise it is **[Owner, scheduled]** (the stamp rule, section 4):
   `pnpm ops schedule vault setStakeHotkey <hotkey> --for-wallet --live`.
4. **[Keeper]** The keeper then claims any credits the swap left on the old hotkey and, once they read 0, frees its slot
   by itself (`Hotkey … removed from the vault's list`). It frees only a hotkey it saw emptied (all its stake gone)
   while stake was missing, never a standby waiting for its stake nor one that only dipped, and never while Bittensor
   still owes the vault deferred rewards on it (its line says so; they show as credits once they convert, and are
   claimed then). A hotkey that holds stake
   again once nothing is missing is let go of: if a claim paid those credits as stake onto the old hotkey, only the
   owner's removal frees it **[Ledger: owner]**: `pnpm ops remove-hotkey <hotkey> --as owner --for-wallet --live` (its
   stake moves onto the stake hotkey).
   If the swap's new hotkey is listed between two of the monitor's readings, the monitor may lean toward a hold
   (`stake.unexplained_drop`): the keeper just waits; check the cause, then clear the hold.
5. **The set is full** (4 hotkeys) and stake is missing: free a slot first. The keeper's `remove-hotkey` takes an empty
   non-stake hotkey; else **[Keeper]** claim a non-stake hotkey's rewards (`pnpm ops claim <hotkey> --live --send`: the
   claim is the keeper's; anyone's only once rewards have vested and 7 days have passed since its last claim) and
   **[Ledger: owner]** remove it
   (`pnpm ops remove-hotkey <hotkey> --as owner --for-wallet --live`), then the new hotkey is listed.
6. Only if the stake is really gone: **[Owner, scheduled]** (the stamp rule, section 4)
   `pnpm ops schedule vault writeOffMissingStake --for-wallet --live` (7 days; the guardian can veto). With no amount it
   writes off the missing stake less the unlisted, as read now. After 7 days, `pnpm ops execute <id> --for-wallet --live`
   reads it again and refuses if unlisted stake grew meanwhile: then list that hotkey instead. **Don't count on the
   vault's own `WriteOffTooLarge`:** its read of the unlisted stake is capped, and anyone can make it costlier
   (`stake.writeoff_read_gas` warns; R6, ChatGPT R2 claim C). The guardian vetoes a write-off larger than the missing
   stake less the unlisted (`pnpm ops pending --live` and the lens's `missingStakeRao()` and `unlistedStakeRao()`).
   **The execute goes with a 47,000,000 gas limit set by its file** (the vault's read is given 45,000,000): the
   owner's account on Bittensor must hold 47,000,000 × the gas price up front, about 0.24 TAO at 5 gwei (only the gas
   used is paid). `pnpm ops budget` prices it on its own line, "Only if you plan a write-off": fund the owner's account
   with it once you schedule one, not at launch.

   **Before it executes, read the vault's bound as the vault reads it** (read only; R11, ChatGPT r3): the staking
   precompile's total for the vault's coldkey on root, with the 45,000,000 gas the vault gives that read. The limit
   below is that and the 21,000 a call takes first; the calldata's few hundred gas come out of the read's share, so a
   pass here holds for the vault too:

   ```
   cast call 0x0000000000000000000000000000000000000805 "getTotalColdkeyStakeOnSubnet(bytes32,uint256)(uint256)" <vaultColdkey> 0 --gas-limit 45021000 --rpc-url https://lite.chain.opentensor.ai
   ```

   `<vaultColdkey>` is the record's `plan.vaultColdkey` (32 bytes, 0x…). It must answer a number. **If it fails, the
   vault's own read fails too and reads 0: the write-off would run with no bound.** **[Ledger: guardian]** Cancel the
   item:

   ```
   pnpm ops cancel <id> --as guardian --for-wallet --live
   pnpm ops sign <file>
   ```

   pnpm ops execute already refuses while its own read of the unlisted stake (the lens's, uncapped) fails, but with
   no cap it can pass a read the vault's capped one fails, and nothing on chain stops the owner's key sending the
   execute. **If the monitor pages `stake.writeoff_bound_off`** (the lens's read of the unlisted stake reverts on two
   readings in a row, or since R12d is priced over the vault's 45,000,000 cap on two readings, though the lens's own
   uncapped read still answers), the same holds now: cancel any scheduled write-off as above (`pnpm ops pending --live`
   names it), schedule none until the read answers again within the cap, and find what changed: in the runtime (its
   `specVersion`, as in 3.5's read-only checks) for a revert; for the price, the positions on the vault's coldkey,
   which only grow (plan the next vault before other people's money).
7. **After any write-off, re-listing a hotkey needs a privileged key and a free slot.** Nothing reads missing then, so
   no stranger can list one: only the owner, guardian or keeper (`addHotkey`), and only into a free slot. With 3
   hotkeys listed the last slot is reserved (`SlotReserved`), for every caller, and only the owner can remove a staked
   hotkey. **Keep at most 2 hotkeys listed** (the launch lists the primary and the standby), so stake that turns up
   again after a write-off can be listed by the keeper with no owner key, and the keeper's `adoptStake` then books it
   (`stake.unlisted` names it). A holder who leaves before that adoption loses their part of it.

While the keeper is held during a ForeverMoney migration notice (a hold lets only the conversions go on), it doesn't
read the hotkey watch, so STAKE MISSING is not said in its lines then; the monitor's `stake.missing` still pages.

**While the vault refuses batches** (stake missing, paused, or its launch door not Active), warn depositors with open
deposits to cancel them on the site (a cancel works 5 minutes after their last deposit). The keeper keeps the batch on
Base, but anyone can close it once it is due: it then
parks on Bittensor for up to 14 days, and a token park's refund needs ForeverMoney's rail.

The owner's forfeit removal after a failed unclaimed-rewards read (`--forfeit`) needs a gas limit of a few million: set
about 3,000,000 in MetaMask before you confirm. **[Fork: T61]**

### 7.6 The root hold and the buffer rule

When Bittensor sets `RootStakeUnlockInterval` above 0, root stake must sit that many blocks after each add, remove or
claim before it can leave, so an exit that needs an unstake can wait it out. The monitor's `root.hold_interval` pages,
and the keeper says `ROOT HOLD: … BUFFER RULE: the owner raises the vault's idleBufferBps from X to Y …`: Y keeps the
queued payouts and a day's floor (`minDailyOutflow`) liquid.

- **[Ledger: owner]** Raise it, at once (a raise is a direct call; a lowering is refused here):

  ```
  pnpm ops set-idle-buffer <bps> --for-wallet --live
  pnpm ops sign <file>
  ```

  At most 1,000 (10%). Lowering it later waits 48 hours **[Owner, scheduled]** (the stamp rule, section 4):
  `pnpm ops schedule vault setIdleBuffer <bps> --for-wallet --live`.
- Claims wait while any payout is due (a claim stamps the pair it claims on), by the keeper's rule and by hand.
- With the front door's deposits paused (below), the buffer fills only from direct deposits: claims re-stake, and
  nothing unstakes into it.
- **Take no deposits through Base while the hold lasts** (R6b).
  **[Ledger: guardian]** Pause the front door's deposits: `pnpm ops pause front-door --for-wallet`, then sign. Batches
  then carry only unstakes, which deliver and pay out. **[FOUNDER ONLY]** Fund the idle buffer with a direct deposit
  from a Bittensor EVM account you hold (it mints you csTAO at today's price). Two warnings first (R7, L5):
  - **Raise `idleBufferBps` first** (the `set-idle-buffer` step above) to the buffer you want, and deposit only the
    shortfall: `stakeIdle` stakes whatever idle TAO is above the buffer's target, so TAO beyond it goes to stake, not
    the buffer.
  - **Use an account with no shares through Base:** `depositDirect` sets the sender's redeem origin to direct
    (Bittensor), so no front door burns that account's shares any more; any it holds through Base could then leave only
    by `redeemDirect` on Bittensor.

  `cast send <vault> "depositDirect()" --value <amount> --keystore <keystore> --password-file <password-file> --rpc-url https://lite.chain.opentensor.ai`
  (`<amount>` in TAO, such as `1ether`).
- The hold also gates the owner's stake moves: `moveStake` and a `removeHotkey` that moves stake wait it out like an
  exit (spec section 3.8).
- **When `stake.removal_fee` first fires** (the chain kept part of a root unstake): raise idleBufferBps above 0
  (`pnpm ops set-idle-buffer <bps> --for-wallet --live`) and keep unstakeMarginRao at 0. A chunk whose walk's cost would
  leave an entry nothing (FeeTooHigh) then waits only until the buffer pays it without a walk.
- **When `stake.add_fee` fires** (the chain kept part of a stake add): every holder bears it, since the vault books what
  the chain added. Check the transaction, raise it with Opentensor, and watch whether it repeats.
- **The root-hold report**, when you choose: file it with Opentensor (the draft is spec question 12): the
  destination stamp, the claim stamp and `move_stake`.

### 7.7 ForeverMoney's migration notice

The moment `migrationReadyAt()` is not 0 (critical alerts on the notice and on any token park during it):

**Stamp nothing from step 3's schedule until the replacement rail's activations have executed.** They are Ordinary
items: both chains' exits must read OPEN when they are scheduled and when they are executed, and any later owner or
guardian stamp kills them (section 4). So through the notice: never disable a primary (it holds the exits closed and
stamps), never pause the vault (the same), and cancel a launch-door payout batch only before the schedule or after the
activations have executed. A stamp in between costs a 7-day Reopen, then 7 more days for the new pair, with Base exits
closed meanwhile. If an incident needs 7.1 anyway, it wins: act, then schedule the activations again after its stamp.

**No door redeem is burned while the notice runs.** The vault asks its primary bridge `canSendPayouts()` at each
delivery; from the notice on it answers false, and the vault defers every door redeem (`RedeemDeferred`): the requester
keeps the shares, and nothing is queued that the old rail can't pay. Deposits still mint, and direct exits on
Bittensor are unaffected.

1. **[Ledger: guardian]** Pause the front door (new deposits stop): `pnpm ops pause front-door --for-wallet`, then sign.
   The front door's pause stamps nothing (only the vault's does), so it costs the replacement rail nothing; cancels
   (at once: a pause frees every cancel), redeem requests and closes still work while it is paused. Then read the open batch (`pnpm ops status --live`):
   - deposits made after the keeper's flush sit in it, and anyone can close it once it is due, so it may land after the
     migration executes, as ForeverMoney's token: tell those depositors to cancel them on the site (`cancelDeposit`, at
     once while the door is paused);
   - redeem requests in it are deferred by any close (above): the requesters keep their shares, and their
     request fee is spent. Tell them to ask again once the replacement rail runs, or to leave directly (step 5).
2. **[Keeper]** The keeper closes the open batch once, at once, with its id, converts every token park
   (`deliverParked`), and closes nothing afterwards. While the notice runs it sends no payout (its send would revert on
   ForeverMoney's closed `depositLiquid`) and says each round what waits (`MIGRATION NOTICE: …`). A monitor hold doesn't
   stop the conversions; `pnpm ops keeper stop --reason "<reason>"` does. By hand: `pnpm ops park --live`, then
   `pnpm ops park <key> --live --send` for each.
   A CCIP FAILURE toward Bittensor open 30 minutes holds the notice's one close (a stranger can force one with junk
   results). Check it (`pnpm ops reexec <messageId> --live`); if it is a stranger's and the deposits must still go,
   close by hand: `pnpm ops close --live` is the notice's one close during the notice, and warns of the FAILURE first.
   Redeem requests in the open batch go with it: the vault defers each while the old rail can't pay (nothing is
   burned), and the command says so.
3. **[Ledger: owner]** The payout batches queued before the notice can never be paid through the old rail: no payout
   goes through it while the notice runs or after the migration. The keeper names each one on the notice's first round
   (`MIGRATION NOTICE: cancel …`), and `rail.payouts_closed` pages for each. Cancel each, one file each, its redeemers'
   shares re-minted:

   ```
   pnpm ops cancel-payouts <key> --for-wallet --live
   pnpm ops sign <file>
   ```

   A batch of bounced deposits alone can't be cancelled (`NothingToCancel`): leave it for the replacement rail, which
   pays it after the switch (step 4). If no replacement rail will run, record each such bounce as a debt the treasury
   settles by hand (section 9).

   Do it **before** you schedule the replacement rail (section 8): each cancel stamps the owner's clock and kills every
   item pending on it, a pending activation included. So, in this order:
   - every cancel signed and landed;
   - while the notice runs, add the new pair to the record (section 8 step 3's command, its Bittensor adapter then its
     Base adapter): `pnpm ops add-pair <bridge> <bridge> --live`. It checks the pair, and records beside it the
     target it read live with the Bittensor block it read it at: ForeverMoney's `finishMigration` may clear the target
     later, and the rail checks and verify then accept the recorded address, after reading the target again at that
     block (Bittensor's archive node), never another, and only once the old vault reads its migration finished (a
     cancelled notice clears the target too, and then nothing moved). **If it was missed**, run it once the target is
     cleared with a Bittensor block from the notice (the block in the monitor's `rail.alpha_vault` alert, or
     ForeverMoney's `initiateMigration` transaction's):
     `pnpm ops add-pair <bridge> <bridge> --target-block <block> --live`. It reads the target at that block on the
     archive node and records it, under the same rules;
   - check that the monitor recorded the target too (its own record, which `rails.incoherent` accepts once the target
     is cleared), from `indexer/`: `pnpm alpha-target -- --env production --vault <alpha-vault> --show`, where
     `<alpha-vault>` is the deploy's AlphaVault;
   - then, in a later block, while both chains' exits read OPEN and after the stamp stack's last `asOf` (the stamp rule,
     section 4), schedule the new pair's activations (section 8 step 1: the vault's new bridge, then the front door's):
     `pnpm ops schedule both activateBridge <bridge> <bridge> --for-wallet --live`. The new pair's Bittensor adapter
     names ForeverMoney's vault after the migration, which must be the old vault's announced migration target
     (`migrationTarget()`, read live): the schedule accepts that address and no other (it refuses any other, naming the
     target), and no `--one-sided` is needed. Every other setting must match the deploy's adapters exactly;
   - 7 days later, execute both (section 8 step 2): `pnpm ops execute <id> --for-wallet --live`, for each of the two
     ids `pnpm ops pending --live` shows;
   - only then the switch (section 8 steps 3 and 4): the old primaries' disables come after both activations have
     executed, never before. Verify accepts the new vault on the same terms, and so does the monitor's
     `rails.incoherent`, which reads the target at the deploy adapter's own AlphaVault and keeps its own record of it
     as it reads it live (accepted once the target is cleared and the migration finished).
   **If the monitor's record is lost** (its database wiped, or the monitor down through the notice), it refuses the new
   pair once the target is cleared: `rails.incoherent` fires and holds the keeper on a correct rail. Switch the rule off
   while you restore the record (THRESHOLDS `rules.off`: add `rails.incoherent`, then redeploy the monitor), restore it
   from a read of the chain at a block from the notice (the archive node; `latest` while the target still reads), from
   `indexer/`: `pnpm alpha-target -- --env production --vault <alpha-vault> --block <block>` (it refuses an RPC that
   isn't Bittensor's, chain 964), and check it with `--show`. Then clear the hold the rule already raised, by the public
   id its alert names, from `indexer/`: `pnpm hold:clear -- --env production --id <hold-id> --note "<reason>"`, and
   switch the rule back on. The script writes only what the vault announced at that block.
   The keeper, the site and the monitor read ForeverMoney's state (its pause, its notice, its finish, its backing) at
   the AlphaVault of the rail now primary on each chain: the front door's primary's Bittensor half's and the vault's
   primary's. Before the switch that is the old vault, so its notice governs (step 2's waits stand). Once both
   primaries are the replacement pair's, it is the new vault, so closes, rolls and payouts resume on the new rail, and
   the monitor's `rail.alpha_vault` and `rail.payouts_closed` follow the new vault (its pause, a new notice); half
   switched, both vaults count. After the switch, set the monitor's TOKENS `alphaVault` to the new vault so its events
   are watched too; `rails.incoherent` reads the target at the deploy adapter's own vault either way.
4. **A payout batch that lands meanwhile.** Closes need no stopping: a close during the notice (a stranger's, after
   the flush) queues no redeem, since the vault defers each. Never disable a primary to stop closes: that is the stamp
   above. Only a bounced deposit can still queue a payout batch now. Leave it queued while the activations are pending
   (a bounce-only batch has no cancel anyway); the new primary pays it after the switch (a payout goes through the
   vault's primary, whichever it is).
5. Tell holders how to leave meanwhile: a plain wallet directly on Bittensor (the site's `/unstake/bittensor/`,
   `redeemDirect`); a smart-wallet holder waits for the replacement rail. A withdrawal requested on Base meanwhile is
   deferred, not paid, and its fee is spent: tell holders not to request one until the replacement rail runs.
6. A refusal that lasts past the flush's deadline (24 hours before `migrationReadyAt`: the vault paused, its door not
   Active, or stake missing) leaves that batch on Base until the migration ends: safe, but those deposits wait. Unpause
   or re-activate the door more than 24 hours before `migrationReadyAt`.
7. Avoid deploying a keeper release that bumps its memory version during the notice (section 2.5).
8. While a hold keeps the keeper to the conversions, it doesn't read the hotkey watch: STAKE MISSING is not said in its
   lines; the monitor's `stake.missing` still pages.

### 7.8 ForeverMoney fails (its TAO, its pool or its lane)

At risk is only the FM-TAO on Base at that moment (the open batch, unclaimed credits, messages in flight). Staked TAO is
native on Bittensor.

**While ForeverMoney's AlphaVault is paused** (`rail.payouts_closed`, "ForeverMoney's AlphaVault is paused"), the vault
defers every unstake from Base. A batch of unstakes alone is still delivered (it carries no tokens to convert), so its
requests are dropped: each holder asks again and pays the request fee again. A batch with any deposit in it parks whole
instead, and is delivered with its unstakes once the pause ends. Tell holders to wait for the pause to end before they
unstake (R6, Fable's I-2).

**If ForeverMoney's validator swaps its hotkey** (`fmtao.backing_true` with the AlphaVault's backing at 0: R6b, U6), its
conversions both ways revert until ForeverMoney points its vault at the new hotkey, and `canSendPayouts()` doesn't see
it. So door burns may queue until ForeverMoney repoints (`migrateValidator`): unstakes from Base are burned on delivery
and their payouts fail each try, then pay by themselves once it repoints. Tell ForeverMoney at once. **[Ledger: owner]**
If they won't repoint soon, cancel each queued payout batch, which gives those holders their shares back:
`pnpm ops cancel-payouts <key> --for-wallet --live`, then `pnpm ops sign <file>`.
1. **[Ledger: guardian]** Pause the front door, and the vault if a forged delivery or a drain is in play
   (`pnpm ops pause both --for-wallet`).
2. **[Ledger: owner]** Cancel payout batches not sent yet: `pnpm ops cancel-payouts <key> --for-wallet --live`, one per
   batch. A cancel re-mints each leaver the value it was owed at today's price, never more shares than it burned: after
   a claim it costs the stayers nothing; after a loss the burned holders get their shares back. Cancel a rogue door's
   batches; pay honest ones out. Once every holder has left (supply 0), cancel before any new deposit lands: a cancel
   then re-mints the burned shares beside the new depositor's, mixing the redeemers' value with theirs. A batch of
   bounced deposits alone can't be cancelled (`NothingToCancel`): it is paid only through its front door and the vault's
   primary bridge. If ForeverMoney's rail is gone for good and no replacement can pay it, record each such bounce as a
   debt the treasury settles by hand (section 9).
3. Point users to the website's Withdraw on Bittensor page (`/unstake/bittensor/`): `redeemDirect`, no ForeverMoney,
   for holders with a plain wallet; it needs a little native TAO for gas.
4. Stand up a replacement door on another bridge: a new front door and adapter pair, activated on the vault (scheduled,
   7 days, the guardian may veto; the stamp rule, section 4).

**A forged batch** (`bridge.batch_mismatch` on a batch no front door closed: a compromised lane can deliver a
redeem-only batch that burns real holders' shares and queues payouts it can divert in transit). Its payouts wait
`payoutDelay` (24 hours at launch), and the keeper never pays a batch that failed its check, but anyone can call
`processPayouts` once the delay ends. **[Ledger: owner]** Before the deadline the alert names, cancel its payout batch,
which re-mints the holders' shares: `pnpm ops cancel-payouts <key> --for-wallet --live`, then `pnpm ops sign <file>`.
**[Ledger: guardian]** If the owner can't sign before the deadline, the guardian's vault pause stops `processPayouts`
(it reverts while the vault is paused), as the alert says: `pnpm ops pause vault --for-wallet`, then sign; the cancel
follows (it works while paused). The pause stamps the guardian's clock, so pending Ordinary items die. Then treat the
lane as compromised: 7.1 (pause both, disable the primaries) and the steps above.

### 7.9 An emptied vault's last payout

In the walk's whole-removal corner under a chain removal fee, a due payout chunk can refuse `UnstakeShort`. It clears
once the balance or the positions move by more than a few rao (a deposit, an exit, a reward). **[FOUNDER ONLY]** A tiny
stake gift to the stake hotkey clears it at once: the gift goes on the stake hotkey's position and is the payout hole plus
the removal fee less the free balance; a gift onto another empty listed hotkey must be at least the chain's minimum and
costs its own fee. (Pins: `test_theLastChunkOfAnEmptiedVaultWaitsForADeposit`,
`test_theLastChunkOfAnEmptiedVaultPastTheToleranceNeedsAStakeGift`, `test_theLastChunkOfAnEmptiedVaultWaitsAtAOneRaoFee`.)

### 7.10 Every deposit refused, or the cap full of exits

- **`batch.deposits_blocked`**: the open batch is full by the front door's own rule, so it can close at once, and it
  has stayed open for 7 readings in a row (the monitor reads each minute; R8: the half rule makes full routine, and a
  busy keeper can take a few rounds). The rule (R6b's room rule, as the contracts' R7 round leaves it): a deposit list
  at half its limit (build B: 25 of 50 deposits) or a full redeem list; or, while the batch holds deposits, half its `maxBatchValue`, half the room left under `depositCap`,
  or no room for a minimum deposit under either. So a batch at half its limit can be closed at once, and a batch of
  unstakes alone waits for its interval, even at the cap. The keeper closes a full batch on its next round, a minute
  later, so this means it isn't closing: check that it runs, its ETH on Base and its Base spend cap (`SPEND CAP` lines),
  and its holds (the monitor's; a `closing waits: … the vault's payouts are closed …` line, section 8). No funds are at
  risk; deposits may be refused meanwhile.

  **What protects a full batch is a close that lands while it is full** (R8, the contracts review's L-1): the close
  commits the holder's deposits, but the keeper only tries once a minute. Since R11 the cancel cooldown makes the
  keeper's next round that close: a cancel works only 5 minutes after the last deposit to the canceller's entry,
  whoever made it (`cancelableAt`; the site counts it down and sends no cancel before it), so the deposit that filled
  the batch can't be cancelled before the keeper's next round, a minute later, which commits it. Revision 34's hold
  (fill the batch just after one round, cancel before the next) is closed. The keeper's close of a batch full by its
  limits names the least total still full as its `minValue` (the least of the lines that held), read before the
  interval as after it (a close read just before the interval ends can land after it, closable by time, where only
  `minValue` guards the line; R12d): for a
  value line the least total at which it still holds (5 TAO of 10 at half), for a deposit list at its line the least its
  entries carry (25 minimum deposits, 1 TAO at the 0.04 minimum, or the total if that is less), for a full redeem list 0
  (its requests' fees in the pot pay the close). Its close at the max wait names 0, full or not, as it goes whatever its
  fees there, and the close rule decides again on the close's own read, so a batch cancelled down since the round's read
  waits for its fees (R12d). The site's "Send the batch, then stake" names the same lines (a list at its line
  the least its entries carry too, R12d; for a batch full by value its line even before the interval, as a wallet
  prompt can land past it), but where more than one held, the highest of them, not the least (R12e): the user pays for
  that close, so it lands only while the batch is still full by every line that held at the click, at worst shrunk to
  the highest (5 TAO of 10 for a batch at half its limit; within a minimum deposit of 10 TAO for one at the limit; never
  the list's 1 TAO for a batch with 25 or more depositors at half its value), and a cancel that takes it under that line
  reverts it, only Base's network fee spent, so the user tries once more. So a cancel of a rao from an aged entry
  between a read and its send no longer voids any of these closes (R12b, R12c). The keeper's close by the fee rule (a
  batch neither full nor at its max wait, closed because its fees cover its bridge fee) names the total less one minimum
  deposit (R12g): a cancel refunds none of the fees the rule weighs (the staker took them at the stake), so a rao cancelled
  just before it with a higher tip no longer voids it, round after round, until the breaker held every such batch for its
  max wait; a cancel of more than a minimum deposit still voids it, and that is the round's quiet skip (section 2.5), the
  next round deciding on what is left. When its pot covers the close's quote (the close keeps none of its float), the
  keeper's fee-rule close names 0 instead (R12h): the door pays the bridge fee from the pot whatever a cancel leaves, so
  junk redeem requests that make a batch fee-covered buy no cancel that voids its close. A close the chain reverts never
  stops the keeper, whatever its replay names (a cancel just before it and a deposit just after, both blocks closable,
  gave a replay with no reason, which stopped it before R12g), and what its own block explains is a quiet skip whatever
  a later read shows (R12h, section 2.5: the door's reason in its replay, or a cancel of the batch logged up to its block).
  Before R12h the keeper's read a few seconds after the close decided alone, so a holder's cancel just before each close
  and a deposit back just after, the TAO back by that read, made three counted waits in a row, and the breaker held the
  close back for 5 minutes, doubling to an hour, while the holder kept the batch full. The site's close of a batch due by
  time alone still names the exact total. **What is left** (Revision 35), each with no loss to anyone. **A fee-rule batch
  held to its max wait** (R12h): a holder's cancel of a minimum deposit plus 1 rao from an aged entry just before each of
  the keeper's fee-rule closes (a higher tip; a deposit back from a second address just after, as the canceller's own
  waits out its cooldown) voids each, and as each is that round's quiet skip, never a count for the breaker, the keeper
  tries again the next round, so the batch stays open until its max wait (24 hours), where its close names 0 and goes.
  It takes a batch whose deposit fees cover its bridge fee with its pot short of the quote (a pot that covers it names 0).
  It costs the keeper one reverted close a round, about 45,000 gas: about 0.00065 ETH a day at Base's 0.01 gwei, plus
  each transaction's small L1 data fee, well within its 0.01 ETH Base spend cap, and nothing else waits on it; the holder
  pays two transactions a round and keeps aged deposits to cancel from. Nothing is lost and no deposit is refused (the
  batch isn't full). It ends when a close lands: the keeper's at the max wait, a depositor's own (`closeBatch` is anyone's
  to call), or yours (`pnpm ops close --live`, which names the keeper's floor, so a holder timing every close can void it
  the same way); if it goes on, raise `minDeposit` (each void then needs a larger aged cancel) or pause deposits, as
  below, set back in the same sitting. It shows as `STILL FAILING (10 rounds; closing the batch): Skipped this round …`
  and as `batch.cancel_churn`. The keeper doesn't space its tries once that starts: it keeps a minute's cadence, so the
  close lands the first round the holder misses. Two addresses can
  still flap it: a fresh deposit from one lifts it over the line just after a round, and the other cancels a deposit
  older than 5 minutes before the next. Each cancel needs a deposit that sat under the line through an earlier round, so the cancels in any 5 minutes
  sum to under half a batch, so the batch reads full in at most about one keeper round in five, and only deposits above
  about half a batch are refused then. A holder that stays under half refuses only deposits above about half a batch
  (or half the cap's room), and must cancel as much as each honest deposit adds, so honest deposits keep landing. A
  stranger's `depositFor` to an address restarts that address's wait: each costs at least the 0.04 TAO minimum every 5
  minutes, which the address keeps, and the deposit pause ends it at once: while the door is paused (or its primary
  bridge disabled) `cancelableAt` reads 0 and every cancel works, so no close that can't land holds anyone's cancel.
  **The list hold is closed** (build B, the list half rule with the cooldown): reaching 50 entries from at most 24 at a
  keeper round takes at least 26 deposits under a minute old, none of which can be cancelled before the next round,
  which finds the list at half or more and closes it. Batches with 25 or more depositors close at the keeper's next
  round, whatever their fees. A forced close commits at least 1 TAO at the 0.04 minimum to the vault (25 minimum
  deposits, the close's floor), in 25 entries or, with the others cancelled under the close past the interval, as few as
  one entry of at least 1 TAO (R12d). Before R12d that floor was 0, so a cancel-down made it one entry of 0.04 TAO: about
  0.00075 ETH of the keeper's a close, one an interval, and about 13 such closes reached the 0.01 ETH Base cap for about
  0.52 TAO committed in all. Since R12d the cheapest way to the cap is about 7 closes of 25 minimum deposits, about 7 TAO
  committed (about 13 one-entry closes would need 13 TAO). The cooldown binds only through a close that lands within
  those 5 minutes: with the keeper down, the holds come back. Any close that lands while it is full commits the holder: the keeper's, a
  depositor's own, or yours (`pnpm ops close --live` while it reads full). `batch.cancel_churn` names such an address
  (below). For a depositor's own, the site offers "Send the batch, then stake" when a stake has no room and the batch
  can close, once reads half a minute apart have found it closable the same way (full, or due by time alone), none of
  them more than 65 seconds after the one before (R9, M-2; R10, M-A). The wait gives the keeper's next round, which
  sends a full batch for free, a chance to come first (the site says it normally leaves on its own). It doesn't show
  the keeper isn't sending it, as its rounds are a minute apart; a wait over a minute would let a holder who cancels
  before each round start it again every time (R10, L-A). The clock starts again too each time the batch changes how it
  can close, so a holder who moves a batch due by time to full and back within half a minute (a deposit to half its
  limit, then, since R11, a second address's aged deposit cancelled before the keeper's next round) keeps the site's
  offer from ever coming for it: the two-address flap above, answered the same way, by a close that lands while it is
  full (R10, L-2).

  If it fills again after each close with deposits cancelled before the close, someone is holding it. The levers are
  the minimum deposit and the deposit pause, not the batch limits: `set-batch-limits` adds nothing here (a batch with no
  room left can be closed at once already). **[Ledger: owner]** Raise `minDeposit` so holding the batch costs more (keep
  `depositCap` as it is):

  ```
  pnpm ops set-caps <minDeposit> <depositCap> --for-wallet --live
  pnpm ops sign <file>
  ```

  Or **[Ledger: guardian]** pause the front door's deposits: `pnpm ops pause front-door --for-wallet`, then sign
  (batches of unstakes still go). **Set any limit you change for this back in the same sitting** (the same command with
  the old value): a limit left changed keeps refusing honest deposits, or closes every batch at once at the keeper's
  cost. Report the payer.
- **`batch.cancel_churn`** (a warning): one address has cancelled deposits in the open batch 3 times, or half its
  `maxBatchValue` in all (the alert names the address, its cancels and the amounts, and what it deposited). That is the
  holder above, timing its deposits between the keeper's rounds (since R11 with a second address: its own cancels wait
  5 minutes after its last deposit). No funds are at risk. If you see the batch full,
  close it by hand (`pnpm ops close --live`, which commits the holder's deposit); if it goes on, use the levers above,
  `minDeposit` or the deposit pause, set back in the same sitting, and report the address. An honest user who cancels a
  few times needs nothing.
- **To stop deposits**, for any reason: the guardian's pause (`pnpm ops pause front-door --for-wallet`) or a
  `depositCap` of 0 (`pnpm ops set-caps <minDeposit> 0 --for-wallet --live`, keeping `minDeposit`), never a huge
  `minDeposit`: setCaps refuses one above the 5,000 TAO batch limit, and ops' `set-caps` says so first.
- **`cap.exits_consumed`**, or **`cap.nearly_full`** when the door's depositors haven't put that much in: the deposit
  cap counts what the front door sent, and only payouts back to Base take it off, so TAO that left by direct exits on
  Bittensor still fills it (four 10 TAO round trips fill the launch cap of 40; R6, Fable's L-1). **[Ledger: owner]**
  Raise `depositCap` by the difference, the direct exits since the last change (setCaps is immediate either way; keep
  `minDeposit` as it is):

  ```
  pnpm ops set-caps <minDeposit> <depositCap> --for-wallet --live
  pnpm ops sign <file>
  ```
- **`batch.deposits_full`** (a warning): at least 2 batches closed in the last 24 hours with their deposit list at half
  its limit or more (25 of 50) of deposits averaging at most twice the minimum. Such a list closes at once (the list half
  rule), its bridge fee paid by its closer beyond its pot, mostly the keeper: lists filled to half with 0.04 TAO
  deposits spend the keeper's ETH (its Base spend cap, 0.01 ETH a day, holds the closes of about 7 TAO so committed
  instead of about 10). Each forced close commits its deposits to the vault, so it costs the one forcing it about 1 TAO
  of capital a close: at least that since R12d, as the keeper's close names the least 25 entries carry, so a list
  cancelled down to fewer entries past the interval still closes only with 1 TAO or more. This alert counts only closes
  of 25 entries or more: such cancelled-down closes (one entry of 1 TAO or more, about 0.00075 ETH each) show in the
  `SPEND CAP` lines and `pnpm ops budget` instead. Once is an honest rush. If it goes on, check the keeper's ETH on Base (`pnpm ops budget`), and
  **[Ledger: owner]** raise `minDeposit` with the same `pnpm ops set-caps <minDeposit> <depositCap> --for-wallet --live`
  (keep `depositCap`), so each forced close costs more to force.

### 7.11 When Bittensor announces a minimum-stake change

1. **[Ledger: owner]** Before it takes effect, raise the front door's `minDeposit` above the new minimum plus a fee
   margin (setCaps: owner only, immediate; keep `depositCap` as it is):
   `pnpm ops set-caps <minDeposit> <depositCap> --for-wallet --live`, then `pnpm ops sign <file>`.
2. Clear the small refunds and payouts still queued before the change lands: let the keeper pay them, or by hand
   `pnpm ops payouts --live` and `pnpm ops park --live`.
3. The floor alert (`stake.min_near_floor` at half of the 0.03 TAO redeem floor, `stake.min_at_floor` at 80%) and the
   full top-up are only the backstops for a change made without notice. When the chain's floor refuses a payout
   chunk's net (`BelowConversionFloor`), the keeper sends it again with the full top-up: it pays the whole bridge fee,
   and the entries are sent their gross. Otherwise it never sends more than the top-up the quote asks (any value that
   covers the fee pays all of it). By hand, the same rule: `pnpm ops payouts --live`. A floor above a chunk's gross
   (about 0.04 TAO for the smallest bounce, 0.03 for the smallest redeem) no top-up lifts: that payout waits for the
   floor to fall or for a new route. A batch with redeems can be cancelled
   (`pnpm ops cancel-payouts <key> --for-wallet --live`); a bounce-only one can't.

## 8. Changing the rails (the bridges)

The rail between the chains is coherent only by operation: each chain keeps its own bridges and its own primary.
**A rail switch is one two-sided operation.** pnpm ops schedule refuses a one-sided one, and the monitor's
`rails.incoherent` alerts and holds.

1. **[Owner, scheduled]** Activate the new pair on both sides (the vault's new bridge, then the front door's):
   `pnpm ops schedule both activateBridge <bridge> <bridge> --for-wallet --live` (7 days, the guardian may veto; the
   stamp rule, section 4).
2. **Execute the new pair's activations before any disable,** one item on each chain:
   `pnpm ops execute <id> --for-wallet --live`, for each of the two ids `pnpm ops pending --live` shows.
3. **Add the new pair to the monitor's `BRIDGES`** when it is activated, and redeploy the monitor. **Add it to the
   keeper too**, so it works the new pair's parks, conversions and CCIP FAILUREs (the old pair's stay watched): write it
   into the record, the Bittensor adapter then the Base adapter (it checks they name each other and share the deploy's
   router, token, selectors and AlphaVault; the one exception is the AlphaVault the deploy's AlphaVault announced as its
   migration's target, read live, which a pair made for ForeverMoney's migration names, 7.7, and records beside the
   pair; for that pair it runs earlier, during the notice. The rail checks, verify and the monitor hold a pair to the
   same terms):

   ```
   pnpm ops add-pair <bridge> <bridge> --live
   ```

   It also finds each adapter's creation block, where the keeper's scans of it start; on Bittensor that needs an archive
   node. ops' default Bittensor RPC (archive.chain.opentensor.ai) is one. If `OPS_BITTENSOR_RPC` points at a pruned node,
   the search fails and nothing is written: point it back at the archive node (or unset it) for this one command, and
   run it again.

   Hand commands see it at once. For the Worker, print the deployment's vars again, paste them into `wrangler.jsonc`
   (over `DEPLOYMENT` and its `DEPLOYMENT_FOR_LIFE_` parts, section 2.3 step 1), and deploy:
   `pnpm config:from-record -- ../ops/deployments/v3.2-launch.json`, then `pnpm wrangler deploy --env production` (both
   from `keeper/`). Until then the keeper says `RAILS NOT LISTED` once a primary is switched.
4. **[Ledger: owner]** Disable the old pair, the front door first; then switch the primaries, the vault first. A
   primary is switched only while it is disabled, and the vault takes a batch only from a bridge enabled now: a batch
   that closed just before the front door's disable is still crossing, and reaching a disabled bridge it is parked and
   refunded only after 14 days. So the disables are two files, with a wait between (the split, not one "both" file):
   - disable the front door's old bridge, and sign it (closes stop on Base):
     `pnpm ops schedule front-door disableBridge <bridge> --for-wallet --live`;
   - **wait until the monitor shows no batch in flight** through the old rail, and the old Bittensor adapter holds no
     park (`pnpm ops park --live`; the vault's `disableBridge` file warns while it holds any);
   - then disable the vault's old bridge, and sign it:
     `pnpm ops schedule vault disableBridge <bridge> --for-wallet --live`;
   - then make the new pair the primaries: `pnpm ops schedule both setPrimaryBridge <bridge> <bridge> --for-wallet --live`
     (the vault's new bridge, then the front door's; an ordered file: sign the vault's call first). **Why the vault
     first:** while the vault's primary is disabled it has no way to pay, so it turns away every unstake a batch brings
     (the request is lost and must be made again). pnpm ops schedule refuses the front door's switch first, and
     `rails.incoherent` alerts on it. Whenever the vault's payouts read closed while the front door still closes (the
     vault's primary disabled alone, or its `canSendPayouts()` false), the keeper holds a batch of unstake requests
     alone on Base (it says `closing waits: … the vault's payouts are closed …`, and `pnpm ops close --live` refuses it
     the same way), so the requests wait rather than being turned away; a batch of deposits alone still goes (R7, L4).
     A batch with deposits and unstake requests waits so only until its max wait (24 hours at launch; the line names
     when), then closes with a `REDEEMS DEFERRED` line: the vault defers its unstake requests (the requesters keep their
     shares and ask again once the payouts open), so the deposits never wait longer behind them. A request on Base needs
     only its fee, no shares, so anyone's could otherwise hold every deposit for as long as the payouts stay closed
     (R8, L-C). During a ForeverMoney pause or migration notice nothing closes at all, whatever the batch holds, a batch
     of deposits alone too (the keeper says `AlphaVault is paused or migrating`; the notice's one close aside, 7.7). The
     CCIP adapter's `canSendPayouts()` reads false only then, or once a migration has executed (the keeper reads the
     AlphaVault unhealthy then too, so nothing closes either; R11, N-1), so with it these three rules (a batch of
     unstake requests alone held, a batch of deposits alone sent, the 24-hour rule for a batch with deposits and unstake
     requests) apply only while the vault's primary is disabled on the vault alone (R9, L-4; R10). The keeper's read of
     `canSendPayouts()` is the vault's own call: from the vault, with the 150,000 gas the vault gives it
     (`RAIL_VIEW_GAS`); a revert, Bittensor's EVM halting it (`evm error`, `evm fatal`)
     or an odd answer reads open, and a node's own error fails the round, which reads again (R8, L-D; R9, L-3).

   Exits are closed from the front door's disable until the switch. Each disable of a primary by the owner stamps the
   owner's clock on its chain and kills every item pending there, a pending `setGuardian` or `transferOwnership`
   included: switch before you schedule anything you mean to keep (pnpm ops schedule warns when it writes the file).
   **[Fork: T61: the whole switch, the wait for the batch in flight included]**
5. Before switching to a primary with a smaller cap (`maxMessageValue()`), drain every queued payout batch (a carried
   bounce above the new cap can be neither sent nor cancelled), tighten `maxBatchValue` to the new cap while the old
   primary still sends, and let the open batch close under it. Otherwise closes revert `MessageTooLarge` until deposits
   are cancelled down to the cap. Tighten the vault's `maxMessageValue` (its `setMessageLimits`) to the new cap first
   too, or the vault's `setPrimaryBridge` reverts `AboveBridgeCap` (it fails safe).
6. Never activate a door on a chain the primary doesn't serve: its payouts couldn't be sent (`WrongDestination`).
7. A new bridge's `canSendPayouts()` must cost under the vault's 150,000-gas cap (`RAIL_VIEW_GAS`) and never revert:
   the vault reads it once per delivery, and a call that fails (out of gas included) or answers anything but one word
   reads open, so door redeems would burn into a queue its rail may not be able to pay (R4, S-H1).
   pnpm ops schedule checks it before it writes an activation on the vault, or the vault's `setPrimaryBridge`: it asks
   the bridge's `canSendPayouts()` from the vault with that gas, and refuses anything but one word, nothing written
   (R11). A false is one word (its payouts closed now), and its line says so.

**A misconfigured pair.** The adapters' peers are fixed at deploy (immutable). A pair whose halves don't name each other,
or a primary that sends to another chain, has no fix in place: move both sides to a correct pair, as above.

**A gas-cost change** (Ethereum's Glamsterdam repricing, or one on Base or Bittensor): the CCIP adapters' gas settings
are fixed at deploy. Re-measure the gas models; re-execute FAILUREs with more gas (`--gas`, section 6); then redeploy the
CCIP adapter pair with new `gasBase` and `gasPerEntry` and make the two-sided switch above. Both adapters take the
lane's new inbound pair: the Base adapter as its `gasBase` and `gasPerEntry` toward Bittensor, and the Bittensor adapter
as its `inboundGasBase` and `inboundGasPerEntry` (what `deliverParked` requires for the vault's call). The plan feeds
both from one setting, and `verify` fails while they differ;
`pnpm ops add-pair <bridge> <bridge> --live` refuses a new pair whose two copies differ.

## 9. Retiring a door, a pair, v3-launch

- **A front door.** Drain it first: stop its deposits, let its open and in-flight batches deliver, and let its queued
  payout batches be paid, carried bounces included (a carried bounce can't be cancelled and waits until the door is
  active again). `pnpm ops remove-door <chain> <door> --as guardian --for-wallet --live` refuses while any of its payout
  batches is queued or a park from it is outstanding. It reads the vault's logs from its creation: one archive node, a
  few minutes.
- **A bounce-only payout queue has no exit** if its door or rail is gone for good: a bounce can't be cancelled, and is
  paid only through its front door and the vault's primary bridge. Never retire a door or a rail while one is queued
  (`payout.bounces_stranded` pages if one waits on a door or bridge that is going). If one is stranded anyway (its rail
  gone for good, 7.7 or 7.8), record it as a debt: each depositor's address and amount, from its `DepositBounced` log,
  settled from the treasury by hand.
- **An adapter pair.** `pnpm ops retire-pair --as owner --for-wallet --live` (refused while the Bittensor adapter holds a
  park) disables the record's pair on both chains: it applies only while that pair is still enabled (winding the
  deployment down, or a pair kept enabled as a spare). After section 8's switch the old pair is already disabled, and
  there is nothing to retire. The file holds both calls: **sign the front door's call first**, and the vault's once the
  Base adapter's last sends have landed.
- **v3-launch (Task 69).** The old door is paused; the owner's `setCaps(min, 0)` and `setMaxTotalAssets(0)`;
  `removeFrontDoor` on the old vault and `disableBridge` on both; the reserves stay; `deployments.json` `stage: retired`;
  `SECURITY.md` and the README tables. v3-launch's own commands are its runbook's.

## 10. Owners, Safes and the standby

- **The Safe** (recommended before other people's money): **[Owner, scheduled]**
  `pnpm ops schedule vault transferOwnership <0x…> --for-wallet --live` (and `front-door`), 8 days; execute only when
  the Safe is ready to accept, while the exits are open; the Safe accepts within 7 days of the execute, before any
  closure or owner stamp (a stamp as of the execute or later refuses it: let the bot's last `asOf` precede the execute).
  A pending owner expires at its `pendingSince` plus 7 days, and any closure of the exits kills it (a pause of the
  vault, a primary's disable, the launch door's removal). The stamp rule (section 4) holds for the transfer's item.
  Moving the owner to a Safe and then making the old owner account the guardian is two 8-day steps, one after the
  other.
- **Listing the standby** (Task 68) **[Fork: T61]**: **[Keeper]** `pnpm ops add-hotkey <standby> --live --send` (or
  **[Ledger: owner]** `pnpm ops add-hotkey <standby> --as owner --for-wallet --live`). Then the same day
  **[Owner, scheduled]** (the stamp rule, section 4), both 48 hours:
  `pnpm ops schedule vault setStakeHotkey <standby> --for-wallet --live` and
  `pnpm ops schedule vault moveStake <primary> <standby> <rao> --for-wallet --live` (from the primary, to the standby;
  `<rao>` about 10% of `bookedStake()`). Once they are ready, in this order:
  1. execute `setStakeHotkey(standby)`: `pnpm ops execute <id> --for-wallet --live`;
  2. then execute `moveStake` (it moves onto the stake hotkey, the standby now):
     `pnpm ops execute <id> --for-wallet --live`;
  3. then at once, **[Ledger: owner]** `pnpm ops set-stake-hotkey <primary> --for-wallet --live` and sign it: it applies
     at once, since the primary then holds more than the standby and at least half the booked stake. Until it lands,
     new stake goes to the standby.

  In the wrong order, `moveStake` reverts and stays pending (execute it again in order, within its window): before
  step 1 its `from`, the primary, is still the stake hotkey (`HotkeyInUse`); its `to` must be the stake hotkey when it
  runs (`InvalidParameter`). A listed standby with no stake is never freed by the keeper.

## 11. What waits for a rehearsal

- **[Fork: T61]** Done on 2026-11-13 by `pnpm ops rehearse --v32` (OPS_DEPLOYMENT=v3.2-launch; two anvil forks
  that keep the live chain ids; each call file passed through the sign page's own checks, then sent from its
  account): the deployment from fresh keys and verify, green; the three deployments verify must fail, failed for their
  change alone; `fund-reserve`, `fund-cushion` (the FM-TAO for it from ForeverMoney's `depositLiquid` (3.2 step 3), its
  approve, then `fundCushion`, and verify's booked cushion after), `set-redeem-origin` (3.4), `set-keeper` (2.6), the guardian's `pause()` of the front door and
  the owner's `unpause()`, `set-idle-buffer`, the guardian's `disable-bridge both` (7.1), and the waiting redeem request
  that stops the roll (7.2). Each line above says what it did.
  Still to do: the rail switch's wait for the batch in flight; the stolen-guardian sequence (7.3); the standby listing
  (section 10: the fork's staking stand-in has no `moveStake`); one CCIP FAILURE recovered by hand with real committee
  results (on a fork, through the command functions in process: the CLI refuses a fork's live chain ids without `--live`); the owner's forfeit removal's gas limit. R4's: a keeper-sent
  `deliverParked` of a one-deposit park, parked behind a paused vault then unpaused, ends in `ParkedDelivered` (its gas
  floor); a whole keeper key rotation with the Worker and a hand run sending (2.6); the Bittensor spend cap against the
  measured payout gas.
  **To confirm at T61:** on an anvil fork the keeper logs ROOT HOLD UNREAD and its claims wait while a payout is due.
  The storage-query precompile holds no code on the live chain, so a fork answers its calls with an empty `0x`
  (checked 2026-11-13), and the keeper reads the hold as unread. The keeper's run on a fork is not yet done.
- **[Canary: 3.5]** (the testnet tasks were dropped on 2026-11-11) the Worker's custom domain and its control routes
  (2.3); one stamp per chain signed through the page with the real Ledger (step 5); a claim's gas at the canary's stake
  (step 7: under the chain's threshold; a full claim's at the first real claim); a real
  node's acceptance of a keeper's cancel (whenever one is needed; record it); the live empty-proof FAILURE (step 11).

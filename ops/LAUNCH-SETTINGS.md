# Launch settings

What `OPS_CADENCE=launch` deploys, for a first launch of about $10k (the 40 TAO deposit cap). Every
value lives in `src/config.ts` (`SETTINGS_V3_LAUNCH`, `LAUNCH_VAULT_LIMITS`), is set during deploy and is
read back by `pnpm ops verify`. Items marked **Decision** are product calls for the owner, not facts.

## Roles

A launch refuses to plan unless all six are set (in `ops/.env` or the shell). Nothing defaults to the
test wallet.

| Variable | What it is |
|---|---|
| `OPS_LAUNCH_OWNER_BASE`, `OPS_LAUNCH_OWNER_BITTENSOR` | The final owner on each chain: a Safe, a timelock run by a Safe, or a plain account (v3-launch: one hardware-wallet account on both chains). It may be a contract. Per chain, because a Safe at one address on Base may not exist (or may be someone else's) on Bittensor. |
| `OPS_LAUNCH_GUARDIAN_BASE`, `OPS_LAUNCH_GUARDIAN_BITTENSOR` | The guardian on each chain, set in the constructors (so there is no 8-day wait). A plain account with its own key, or a Safe. |
| `OPS_LAUNCH_KEEPER` | The keeper on both chains. Must be a plain account. Before every send, the keeper reads its code on both chains, fresh each time (never kept for the round). Code on either chain blocks every send, because one key holds the address on both and an EIP-7702 delegation can cover every chain at once. `run` then stops. |
| `OPS_LAUNCH_TREASURY` | Receives the reward cut and the staker's fees. Must be a plain account (no code on either chain): deploy checks this before planning, and verify checks it again. |

Refused: a guardian equal to any owner or to the keeper; the keeper equal to any owner; the test wallet
as an owner or a guardian.

verify reads every role's code on each chain where the role acts. An EIP-7702 delegation fails any role.
That code is `0xef0100` plus an address, and it means the account's key has installed code in it, as in
the Binance hot-wallet drain. Any other code fails the keeper or the treasury. A launch owner with no code
is only a warning.

How it runs: the test wallet deploys and owns everything while it configures. Each chain's last steps
then offer ownership of the front door, the staker and the vault to that chain's owner (Ownable2Step).
The oracle and the adapters have no owner. Then:

1. `pnpm ops handoff --live` writes `deployments/safe/<name>-accept-ownership-<chain>.json`, a Safe
   Transaction Builder batch with `acceptOwnership()` on each contract. For a timelock owner it writes
   two files: `scheduleBatch`, then `executeBatch` after the timelock's delay.
2. Each owner loads its file and executes it.
3. `pnpm ops ownership --live` shows each contract's owner and pending owner. Until acceptance, verify
   reports the hand-off as a warning, not a failure, so deploy can finish.
4. `pnpm ops verify --live` records the hand-off once every contract is accepted. Until a read-back has
   recorded that, the keeper commands and `web-config` refuse the launch: the test wallet, a hot key,
   still owns everything and could hand it elsewhere.

- **Decision: the keeper.** The keeper commands (run, close, stake, payouts, claim, deliver) sign as the
  record's keeper. With `OPS_KEEPER_KEYSTORE` and `OPS_KEEPER_PASSWORD_FILE` set, they use that key.
  Without them they sign as the test wallet, so `OPS_LAUNCH_KEEPER` can be the test wallet with no more
  setup. If the record's keeper isn't who the commands sign as, they refuse before sending, and `run`
  also checks the keystore before it starts. With a separate key, `budget` says what to send it and
  `preflight` checks its TAO and ETH. A launch rehearsal's keeper steps still sign as the test wallet,
  so rehearse with `OPS_LAUNCH_KEEPER` set to it. The keeper can time and route but never take funds. A
  separate keeper key keeps the deployer's key off the always-on keeper machine.
- **Decision: the owners.** Is the owner a Safe, or a timelock behind a Safe? The contracts README
  was written for a 48-hour timelock. With a timelock, every limit change and every unpause waits for
  it. Check that Safe{Wallet} supports Bittensor EVM (chain 964) for the Bittensor owner. If it
  doesn't, use a plain account there and accept from it (`handoff` prints the transaction). A plain
  account on a Ledger, used through MetaMask, accepts with the signing page below. **Decided for
  v3-launch:** one plain account on a hardware wallet, the same on both chains, with no Safe and no
  timelock, so limit changes and unpauses take effect at once. A Safe plus a timelock is planned
  before other people's money.

## Sending from MetaMask (a Ledger)

For an owner or guardian that is a plain account on a Ledger, used through MetaMask (no Safe).
`pnpm ops sign` serves the prepared calls as a page on this computer. The page sends them from
MetaMask, one call per click.

1. Write the calls to a file in `deployments/wallet/`. This reads the chains and sends nothing.
   - `pnpm ops handoff --live --for-wallet`: each plain-account owner's `acceptOwnership()`, Base
     and Bittensor in one file.
   - `pnpm ops pause [front-door|vault|both] --for-wallet` (the guardian) or `unpause … --for-wallet`
     (the owner): checks that each call would succeed and that the account can pay its gas. No
     keystore is used. Not with `--live`.
   - `pnpm ops cardinality --for-wallet --from 0x…`: the pool steps, in order, from the account you
     name, each with its gas limit set.
2. `pnpm ops sign deployments/wallet/<file>.json` prints the calls and a URL such as
   `http://127.0.0.1:53114/`. The file must be for the deployment in `OPS_DEPLOYMENT` (or pass
   `--deployment <name>`). Open the URL in the browser where MetaMask is.
3. In MetaMask, select the Ledger account, then click Send on a call. The page refuses unless
   MetaMask's selected account is that call's sender. It asks MetaMask to switch to the call's
   network, adding Bittensor EVM (chain 964) if MetaMask doesn't have it. Then check the call before
   you approve (below). The page shows the hash, waits for the receipt, and then checks that the mined
   transaction is the call it sent. It reads a receipt only while MetaMask is on that call's network:
   if MetaMask moves to another, the call says to switch back to see its result (or gives its explorer
   link), and carries on once MetaMask is back. While a call waits for its receipt, the page won't send
   a call on the other network: send it once the waiting call shows Done, or after 5 minutes if it still
   isn't mined. Reloading the page also frees it, but forgets that call: check it on the explorer first.
4. Disconnect the site in MetaMask (Connected sites), then press Ctrl-C to stop the server. Check the
   result with `pnpm ops ownership --live` and then `pnpm ops verify --live` (hand-off), the pause dry
   run, or `pnpm ops cardinality`.

**Checking a call on the Ledger.** With Blind signing on, the Ledger signs a contract call without
showing what it does. To see the call on the Ledger itself:
- In the Ledger's Ethereum app settings, turn on Blind signing, and also Debug data (some versions call
  it Contract data). The Ledger then shows the call's selector and each 32-byte parameter.
- Compare the selector (for example `0x79ba5097` for `acceptOwnership()`), each parameter word and the
  To address with the page.
- Or compare them with the Hex (Data) tab of MetaMask's confirmation.
- Turn Blind signing and Debug data off again afterwards.

**Rehearse before launch.** On the launch deployment, before the hand-off:
1. Run `pnpm ops pause --for-wallet` and `pnpm ops sign` on the file it writes.
2. Connect MetaMask, click Send, and check what the Ledger shows.
3. **Reject on the Ledger.**

This proves, at no cost, that MetaMask is found, that the account and network checks and switching
work, and what the Ledger displays.

**Keep a pause file ready.** After the rehearsal, keep `deployments/wallet/<name>-pause.json`:
- In an emergency, `pnpm ops sign` on it is one command away. `sign` checks it against the record again,
  and `pause()`'s data never changes. The warning that it is over a day old is expected.
- If the guardian is replaced (`proposeGuardian`, then `acceptGuardian` after the delay), make it again
  with `pnpm ops pause --for-wallet`. That writes the new guardian, read from the contract, and writes
  nothing while the contracts are already paused.
- For pause and unpause, `sign` reads each target contract's `guardian()` and `owner()` when it serves
  the file. It accepts the record's roles or those, and shows a role found only on the contract as "read
  from the contract now (the record says 0x…)".
- If that read fails, only the record's roles count, and `sign` says so. A replaced guardian's file is
  then refused until the RPC answers (`OPS_BASE_RPC`, `OPS_BITTENSOR_RPC`).

What it guards:
- `sign` refuses anything but the known functions (`acceptOwnership`, `pause`, `unpause`,
  `increaseObservationCardinalityNext`). There is no `transferOwnership`, the call that would hand a
  contract away. Each function is allowed only on the contracts it is for: the deployment's front door,
  staker and vault from its live record, and the oracle's two pools.
- Each sender must hold the role the function needs:
  - `acceptOwnership`: the chain's owner, from the record only;
  - `pause`: the guardian or the owner, from the record or as the contract names them now;
  - `unpause`: the owner, from the record or as the contract names it now (never a guardian);
  - the pool steps: one `--from` account.
- It refuses value, a gas limit on anything but a pool step, any character outside printable ASCII, and
  a file for another deployment.
- The page's headings, effects and roles come from the decoded data and the record. The file's title
  and labels are shown only as notes, and a label must start with the function the data calls.
- It listens on 127.0.0.1 only and loads nothing from anywhere (a strict CSP). It has nothing to type
  into and never asks for seed words or keys. It finds MetaMask by its EIP-6963 announcement; if it has
  to use another wallet, it names that wallet on the page.
- Reloading the page forgets what it sent: check on the explorer before sending a call again.

## Settings

The Launch column is v3-launch's (`src/config.ts`). The v3.2 column is v3.2's constructor arguments
(`src/v32/settings.ts` `SETTINGS_V32_LAUNCH`, spec Appendix B), set at deploy and never after; where it differs, its
Why says so.

| Setting | Launch | v3.2 | Default or test | Why |
|---|---|---|---|---|
| Deposit cap (front door) | 40 TAO | 40 TAO | same | Already set. About $10k. |
| Batch value (front door) | 10 TAO | 10 TAO | same | A batch carries at most a quarter of the cap. |
| Minimum deposit | 0.04 TAO | 0.04 TAO | same | v3.2 refuses one below 0.03 TAO (`MIN_DEPOSIT_FLOOR`, twice `MAX_FEE_ABS`). |
| Batch interval / payout delay | 1 h / 24 h | 1 h / 24 h | 10 min / 1 h (test) | The payout delay gives the guardian a day to stop a bad batch. |
| Redeem request fee | 0.0001 ETH | **0.0002 ETH** | 0.0001 ETH | v3-launch's is kept. v3.2's is twice it (**the founder, 2026-11-16**): a full redeem list (50 requests) pays 0.01 ETH into the pot, which must cover the bridge fee to close a full batch, 50 deposits and 50 redeem requests (about 0.0031 to 0.0043 ETH on v3.2: 7,000,000 gas toward Bittensor), not a one-entry batch's: about 2.3 times at the 0.0043 ETH quote. At 0.0001 ETH a full list paid 0.005 ETH, about 1.0 to 1.6 times, a thin margin that a rise in TAO/ETH or in Bittensor's gas price takes away. Below it a list filled with fake requests (a request needs only its fee) can't close itself, and the keeper pays the rest. v3.2's monitor warns below 1.5 times (`batch.redeem_fee_thin`: at 0.0002 ETH, a full batch's quote above about 0.0067 ETH); the owner's `setRedeemRequestFee` is immediate, at most 0.001 ETH. Each user pays it once per batch they request in. **Decision.** |
| **Outflow: `maxDailyOutflowBps` / `minDailyOutflow`** | **20% / 10 TAO** | **20% / 10 TAO** (and `globalOutflowBps` 20%) | 20% / 100 TAO | See below. **Decision.** |
| **`maxEntryValue` / `maxMessageValue` / `minChunk`** | **10 TAO / 15 TAO / 10** | **10 TAO / 15 TAO / 10** | 2,000 / 4,000 / 10 | One redeem entry burns at most 10 TAO per delivery. One payout message carries at most 15 TAO: near the 10 TAO batch, and above a day's largest allowance at 60 TAO (12 TAO), so a day's exits still go home in one message and pay one bridge fee. **Decision** (15 TAO). |
| **`maxFeeBps` / `maxFeeAbs`** (payout bridge-fee ceiling) | **1% / 0.005 TAO** | **1% / 0.015 TAO** | 1% / 0.02 TAO | The live fee is about 0.00105 TAO, so v3-launch's leaves about 5x. Above the ceiling, payouts wait (nothing is lost) until fees fall or the owner raises it. 0.02 TAO could take half of a 0.04 TAO minimum deposit; 0.005 takes at most an eighth. v3.2 bounds it to 0.01 to 0.015 TAO (`MIN_FEE_ABS` to `MAX_FEE_ABS`, half its 0.03 TAO smallest redeem) and launches at the top, about 14x the live fee: a fee above the ceiling is the caller's to top up, and the charge on a payout is at most half its sum. **Decision.** |
| **`maxTotalAssets`** | **44 TAO** | **44 TAO** | 1,000 TAO | Stops direct (Bittensor) deposits 10% above the cap. It never stops a front-door batch. It also bounds the large direct deposit that draining the outflow allowance's base with a gift needs (a direct deposit no longer raises the base, which counts only ramped-in stake). **Decision.** |
| **Adapter caps (`maxMessageValue`, each adapter's constructor)** | **50 TAO each** | **50 TAO each** | 5,000 TAO (test: the lane's limit, as before) | One bridge message carries at most 50 TAO either way: five times the 10 TAO batch and above the 15 TAO payout message, so a bug or a stolen key moves at most that per message. The Base adapter's must hold a full batch (`maxBatchValue`); the Bittensor adapter's the vault's payout message and entry and a full batch (a bounced deposit can be one); deploy refuses to plan otherwise and verify fails. Raising those limits past 50 TAO needs new adapters first (7 days). **Decision** (about 50 TAO). |
| Reward cut / swap fee / deposit fee | 10% / 0.15% / $0.05 | 10% / 0.15% / $0.05 | same | Unchanged from the test. |
| Delivery slippage | 1.5% | 1.5% | same | Default. |
| `maxDeposits` / `maxRedeems`, claim gas, hotkey dust, floors, unstake margin | defaults | 50 / 50, 55,000,000, 0.001 TAO, the pools' measured floors (`MEASURED_V32`), 0 | same | Unchanged. verify now reads them all back. Build B's list half rule: a deposit list at half its limit (25 of 50) can close at once and the keeper closes it on its next round, whatever its fees (the list still refuses a new depositor only at 50); the redeem list closes at full. A forced close commits at least 1 TAO at the 0.04 minimum to the vault: its close names the least 25 entries carry (R12d), so it is 25 entries, or, with the others cancelled under the close past the interval, as few as one entry of at least 1 TAO. At 0.01 ETH a day the keeper's Base cap holds the closes of about 7 TAO so committed instead of about 10 (about 13 one-entry closes need 13 TAO; before R12d a cancel-down made each one entry of 0.04 TAO, about 0.00075 ETH, so about 13 closes and 0.52 TAO reached the cap) (runbook 7.10, `batch.deposits_full`). |
| v3.2 only: `rewardVesting` / `idleBufferBps` / `unstakeGas` / `minDirectDeposit` | none | 30 days / 0 / 400,000 / 0.01 TAO | | Spec Appendix B. |

### The outflow limit, the main trade-off

In each 24-hour window, a front door's redeems burn at most the larger of 20% of the vault and the
floor. With the default floor of 100 TAO, larger than the whole vault, a forged bridge message could
force-exit everyone in one day.

At 10 TAO, a forced exit takes at most 25% of a 40 TAO vault per day (20% of a 50 or 60 TAO one).
Windows are fixed, not rolling, so two windows back to back can take about twice that within minutes.

What holds a forged batch is the guardian, inside the 24-hour payout delay. Its `pause` stops
`processPayouts`, and so does `removeFrontDoor` or `disableBridge` (the registry's disable). Behind a
48-hour timelock the owner couldn't act in that time: anything it schedules would land a day after the
payout could go. (v3-launch's owner has no timelock, so it can act at once, but only if its holder is
there to sign.) Undoing the batch is `cancelPayoutBatch`, which re-mints the burned shares. It is
owner-only, so with a timelock it goes through it, after the guardian has paused (it works while
paused). So the guardian's key, and someone watching, are what stop a forged batch in time.

The cost: one holder of the whole 40 TAO cap needs 4 windows to leave, 10 TAO a day. A request asks
for everything, burns at most the window's allowance, and the holder asks again the next day (the
site should say so). When many people leave at once, the first come are served first.

Alternatives: a 5 TAO floor exits a big holder in 8 windows; a 15 TAO floor bounds a forced exit at
37% of a 40 TAO vault.

## Before launch

- **Grow the TAO/WETH pool's observation slots.** `pnpm ops cardinality` prints the exact
  transactions. The oracle's 30-minute TWAP needed 901 slots on Base's 2-second blocks, and the pool had
  600 (read 2026-10-28). The target was 2,000, for margin. Since Base's 200 ms blocks (2026-11-05) a pool
  still writes at most one observation a second, so the window needs 1,801: the pool's 2,000 cover it.
  1,801 is also the v3.2 oracle's `MIN_CARDINALITY` (`TWAP_WINDOW + 1`, Revision 28), which `pnpm ops
  cardinality` now grows both pools to (more only if Base's measured block time ever needs more).
  - Base refuses any transaction above 16,777,216 gas, and one call from 600 to 2,000 needs about 31M.
    Two steps of 700 would each need about 15.7M, within 6% of the cap.
  - So it takes three transactions, from any wallet: `increaseObservationCardinalityNext(1200)` (a
    600-slot step measured 13,479,008 gas), then `(1800)`, then `(2000)` (about 4.5M).
  - Send each with the gas limit printed (15.1M, 15.1M, 5.1M): a wallet that pads its own limit could
    go over the cap. From MetaMask, `cardinality --for-wallet --from 0x…` and `pnpm ops sign` set
    these limits and send the steps in order (see "Sending from MetaMask" above).
  - verify fails a launch, and preflight flags a problem, until the pool has enough slots.
- **Base logs.** Every Base log scan reads from `OPS_BASE_LOGS_RPC`. Without it, the scans use
  `OPS_BASE_RPC` (your keyed provider), unless that is `mainnet.base.org`, which refuses `eth_getLogs`.
  Failing both, they use `https://base-rpc.publicnode.com`. The tools print the host they use, its
  domain only (e.g. `drpc.org`), so no key in it is ever shown. Each query asks for `OPS_BASE_LOGS_WINDOW`
  blocks (default 10,000). publicnode accepted 50,000-block ranges and answered 1M blocks deep
  (probed 2026-10-28), so verify's first registry scan of a month-old deployment takes about 130
  queries. Each later scan resumes from the last. If the logs server refuses part of a scan, verify
  prints what is NOT CHECKED but still passes, so the keeper keeps running; `status` and `run` repeat
  it. Once such a gap began more than 7 days ago (the registry delay), verify fails: a bridge or front
  door proposed in it could be active by now. Otherwise only something it finds fails verify: an
  unexpected bridge, front door, route or proposal, or an extra one it found before whose state it
  can't read now.
- **Expected extras.** If you register a standby adapter or a second route on purpose, list it in
  `OPS_VERIFY_ALLOW` (for example `0xAdapter, route:1`), or verify fails on it. Pending proposals
  always show as warnings.
- **Emergency.** `pnpm ops pause [front-door|vault|both]` does a dry run: it estimates the call and
  checks the keystore. `--live` sends as the guardian, with `OPS_GUARDIAN_KEYSTORE` and
  `OPS_GUARDIAN_PASSWORD_FILE`. A Safe guardian gets a Transaction Builder file instead. A Ledger
  guardian in MetaMask uses `pause --for-wallet`, then `pnpm ops sign` (see above). If the
  guardian's plain account holds an EIP-7702 delegation, pause prints a WARNING and still pauses from
  its key: assume that key is compromised, and rotate the guardian afterwards. `unpause` is the owner's
  and goes through the timelock if there is one. Do the dry run once before launch.

## Running the keeper unattended

`ops/scripts/keeper-supervised.ps1` runs `pnpm ops run --live` for one deployment, logs every line to a
file, and restarts the keeper if it crashes. It passes the keeper's keystore and password file by path
only; it never opens them.

What `run` survives on its own: a failure inside one round is logged on one line (`Failed this round
(…)`), and the next round tries again. The wait grows after each failure in a row (1, 2, 4, then 5
minutes at most). After 10 failed rounds in a row, each line starts `STILL FAILING (n rounds)`, and so
does a skip of one action 10 rounds in a row (another caller beating the same close, a delivery the
wallet's guard keeps refusing). Nothing is retried within the round that failed, and every send passes
the usual guards again. Every line has any URL cut down to its domain, so no RPC key reaches the log.

The keeper stops itself only for states that are unsafe, or wrong, for everyone. One user's delivery,
one refused payout or one stuck transaction never stops it: those are held, skipped or replaced, as the
next section says.

| Waits for the next round | Stops for good (exit code 3, never restarted) |
|---|---|
| Someone else closed the batch, or paid a batch out, first | The keeper wallet has code (an EIP-7702 delegation): assume its key is stolen |
| An earlier transaction is still pending; a nonce race (replaced after 15 minutes, below) | The keystore signs as another account (a wrong key) |
| The simulation refused the send (the chain changed); from the third refusal in a row the action is skipped (below) | The record isn't complete and verified, a read-back since has failed, or the hand-off isn't accepted |
| No receipt yet (a slow block; the next send waits for it) | The record file is gone, or now holds another deployment |
| A pause, or the chain changed since the round's read | An RPC answers for another chain |
| An RPC error, a timeout, a dropped connection | A transaction reverted on chain and nothing explains it (read again the next round if the first read fails) |
| A delivery that reverted because the price moved or the user claimed or changed their preference first (held up to 30 minutes, or longer once over the user's revert budget) | The payout list rebuilt from the vault's events doesn't match the vault's on two full scans of those events |
| A delivery that reverted for no reason it can see (the round counts as failed; that user is held) | 30 rounds in a row failed on something unexpected |
| Anything else unexpected | Another keeper already runs for the deployment (`deployments/<name>.run.lock`) |
| | Anything `run` refuses at start (no record, a bad setting) |

### Holds, back-offs and skips

How the keeper keeps one user's, one action's or one transaction's trouble from stopping the rest.
Each has its own loud line, in capitals, so it stands out in the log.

- **A delivery needs room.** The keeper sells a user's TAO only when the quote (after the swap fee)
  clears every floor the front door applies, the user's and the 30-minute TWAP's, by 0.5%; its own
  minimum is the quote less 0.5%. A quote within 0.5% of a floor waits for a better one (`Delivery to
  … waits: the quote … clears the user's floor … by less than the 0.5% room …`). Sent at the floor
  itself, any downtick before the sale landed would revert it, for the gas, round after round for a
  user whose floor sits at the market price.
- **A reverted delivery is explained before it is counted.** The keeper replays a reverted
  transaction's call at its block to decode why. A price race (`BelowMinimum`, `InsufficientOutput`,
  `Too little received`) or the user's own change (`NoDelivery`, `DeliveryExpired`, `NothingToClaim`)
  explains it, and so does the user's claimable amount, preference or quote having changed: that user
  is held for 30 minutes, or until their facts change, and no round fails. A revert nothing explains
  fails its round (so the log shows it) and holds that user the same way. Neither ever stops the keeper.
- **The revert budget.** Every reverted delivery of one user, explained or not, counts: two within 24
  hours and that user is held 6 hours, whatever the price or their preference does (`DELIVERY HELD:
  deliver to … reverted on chain 2 times within 24 hours …; held 6 hours, until …`). Each time the
  budget runs out again within a day of the last hold's end, the hold doubles: 12, 24, then 48 hours at
  most. A user who changes their preference once a round to make the keeper send reverting deliveries
  gets two a day, not one a round. The user can claim by hand throughout, and the keeper's other work
  goes on.
- **The circuit breaker.** A close, stake or payout whose simulation (or own re-read of the chain, or
  the gas price cap below) refuses it three times in a row is skipped: the round moves on to the next
  due action (other payouts, deliveries, the stake, the close), and the refused one is tried again 5
  minutes later, then 10, 20, 40, 60 at most, as long as it keeps being refused (`SKIPPING paying out
  batch …: refused 3 times in a row (…); the keeper's other actions go ahead; tried again in 5 min`;
  once the wait is at its hour, `STILL SKIPPING …`). The count is of tries, which from the third are a
  back-off apart, not of rounds. The rounds that failed on those refusals are not followed by a
  `Recovered` line once the action is skipped: nothing recovered. A payout the vault refuses for a
  bridge fee over its ceiling, or a stake on a deregistered hotkey, no longer stops the deliveries and
  closes behind it. A refused simulation sends nothing, so a skip can never send twice; while skipped
  the action is not even estimated. An action that goes through, or is no longer due, starts its count
  again.
- **The gas price cap.** The keeper's sends (`run`, and the hand-run `close`, `stake`, `payouts`,
  `deliver`, `claim`; `deploy` too) go out at no gas price over `OPS_MAX_GAS_PRICE_BASE` /
  `OPS_MAX_GAS_PRICE_BITTENSOR` (gwei, decimals allowed; by default 5 and 100, against prices that sit
  under 0.1 and about 5: Bittensor's base fee read 5 gwei on 2026-11-08). Over it the send is refused (`the gas price is … gwei, over the … gwei cap
  (OPS_MAX_GAS_PRICE_…); … waits for it to fall; nothing sent`) and tried again later, and so is a
  replacement whose effective price (what it would pay a gas now, judged as a fresh send's is) would be
  over it: a fee spike costs a wait, never the wallet's funds. **The emergency and owner commands have
  no cap**: `pause`, `unpause`, `wind-down` and `sweep` are run by hand and meant, gas spike or not, so
  a guardian's pause always goes out; `--max-gas-price <gwei>` gives one of them a cap for that run.
- **A stuck transaction is replaced.** A transaction of the keeper's still pending 15 minutes after
  the keeper stopped waiting for its receipt (a 5-minute wait at the send, so about 20 minutes in all)
  is sent again at the same nonce with a 12.5% higher fee (fee cap and tip on Base, the tip never under
  the node's suggestion; the gas price on Bittensor), the same call if it still passes, or, only when
  its estimate is a genuine revert (the call would fail now), a cancel that only frees the nonce
  (`REPLACING transaction … (closing the batch, nonce 12): no receipt 15 min after the keeper stopped
  waiting for one …`). When the node didn't answer the estimate (a rate limit, a timeout) nothing is
  sent or cancelled, and it is tried again 15 minutes later. Every replacement passes the guards every
  send passes first: the record still complete and verified, the keeper wallet still without code on
  either chain, the right keystore and chain; a failure of those stops the keeper, as at any send. A
  replacement stuck in its turn is replaced after 30 minutes, then 60; three at most. Two transactions
  at one nonce can't both be mined, so a replacement never doubles a send; the keeper checks first that
  the transaction is still pending, its own, at that nonce, and nothing has been mined at it. The
  original's hash and every replacement's are all watched: whichever has a receipt ends the watch
  (`Replaced: … went through (transaction …)` or `Late receipt: …`, with its bridge message recorded),
  and so does the wallet's mined nonce passing the call's, two rounds running, with none of them mined
  (`Watch ended: something else was mined at nonce …`: check the hashes on the explorer). `Not
  replaced: …` means the node had nothing to replace (it landed or was dropped meanwhile): the watch
  goes on until a receipt or the nonce ends it. A transaction with no receipt 6 hours after the keeper
  stopped waiting for one is reported as probably dropped (`NO RECEIPT 6 hours after …`).
- **A batch's deposits are counted from its first block.** The close rule's fee estimate scans the
  open batch's `DepositRequested` logs from the block the batch opened in, found by its timestamp, so a
  keeper restarted at any hour of a batch counts the staker's deposits (before, a restart more than
  four hours in read them as $0.00 and held the batch for its whole max wait). The look-back is cut at
  72 queries of `OPS_BASE_LOGS_WINDOW` (720,000 blocks at the live server's 10,000; 7,200, four hours,
  at a public RPC's 100); when the cut bites, `Base logs: batch N opened at block …, further than the …
  blocks the logs window allows …` says so once, and the variable to raise.
- **A payout list is rebuilt before it is refused.** A payout list rebuilt from the vault's events that
  doesn't match the vault's stored hash fails that round (`Failed this round (the payout list is being
  rebuilt, …)`), and the vault's events are scanned again, in full, from the deploy block, the next
  round: one short `eth_getLogs` answer (a lagging replica, given a round to catch up) no longer stops
  the keeper. Only two full scans in two rounds that both mismatch do.

Lines that need a look when they appear, though the keeper runs on:

- `SENT, BUT NOT SAVED: transaction …, bridge message …`: the transaction went through, but the record
  couldn't be saved. Follow the message with the `pnpm ops track` command the line gives, adding
  `--live`.
- `NO RECEIPT 6 hours after the keeper stopped waiting for one: transaction(s) …`: a transaction that
  timed out, and its replacements, never showed a receipt, so they probably dropped. Check them on the
  chain's explorer. One that does land later is logged as `Late receipt: …`, with its bridge message
  recorded.
- `Watch ended: something else was mined at nonce …`: the wallet's nonce moved past a watched
  transaction's without any of its hashes getting a receipt (a node this one can't see took one of
  them, or you sent something at that nonce by hand). Check the hashes on the explorer; `pnpm ops
  status` finds a bridge message.
- `DELIVERY HELD: …`, `SKIPPING …` / `STILL SKIPPING …`, `REPLACING transaction …`: the holds, skips
  and replacements above. Each says what it is waiting on and until when; a `STILL SKIPPING` that
  repeats for hours (a bridge fee over the vault's ceiling, a paused lane, a gas price over the cap)
  needs the owner, not the keeper.
- `Base logs: batch N opened at block …, further than … the logs window allows`: raise
  `OPS_BASE_LOGS_WINDOW`, or the batch waits its max wait.

**A transaction stuck from before a restart.** The keeper replaces only transactions it sent in this
run: what it was watching is forgotten when it restarts (a crash, a `-Stop`). If a transaction of the
keeper's was pending at that moment and stays stuck, every send on that chain is then refused with
`an earlier transaction from the keeper (nonce N) is still waiting to be mined`, round after round,
and nothing replaces it. Free it by hand, from a machine with the keeper's keystore (never while the
supervisor is running another send: `-Stop` first, or do it between rounds):

1. Find the stuck nonce: `cast nonce <keeper> --rpc-url <rpc>` is the mined count, `cast nonce
   <keeper> --block pending --rpc-url <rpc>` the pending one; the stuck nonce is the mined count when
   the pending one is higher. The line above names it too.
2. Cancel it with a transfer of nothing to the keeper itself at that nonce. A node takes a replacement
   only with every fee at least 10% over the stuck transaction's (geth's rule; use 12.5% as the keeper
   does), and never under the market's now. `cast tx <hash> --rpc-url <rpc>` shows the stuck fees; the
   explorer too.
   - Bittensor (legacy transactions: one gas price):
     `cast send <keeper> --value 0 --nonce <N> --legacy --gas-price <wei> --keystore <keystore>
     --password-file <pw> --rpc-url <rpc>`
   - Base (EIP-1559: a fee cap and a tip, BOTH bumped, the cap not under the tip):
     `cast send <keeper> --value 0 --nonce <N> --gas-price <fee cap wei> --priority-gas-price <tip wei>
     --keystore <keystore> --password-file <pw> --rpc-url <rpc>` (cast's `--gas-price` is the fee cap
     of a 1559 transaction; `cast gas-price` and `cast rpc eth_maxPriorityFeePerGas` give the market's).
   Or re-send the stuck call the same way instead of a cancel, if it should still go.
3. Start the keeper again. The next round decides what is due; nothing is sent twice, since the nonce
   was taken by the cancel.

`run` takes `deployments/<name>.run.lock` while it runs, so a keeper started by hand can't run beside
the supervised one. A lock left by a keeper that was killed is taken over once its process is gone.
Before each start the supervisor removes a leftover lock only if the PID it names isn't running, isn't
`node.exe`, or started after the lock was taken (Windows reused the PID). Otherwise it refuses to start,
since that may be a keeper running elevated or as another user, which its process check can't see. If
no keeper is running, delete the lock by hand.

**Before the first start**, stop the keeper you started by hand. The supervisor refuses to start while
any keeper runs. Windows can leave the keeper's `node` process running after its window or shell is
closed, so check that none is left:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'cli\.ts' -and $_.CommandLine -match '\brun\b' } | Select-Object ProcessId, CommandLine
```

End any that is listed with `Stop-Process -Id <PID>`.

**Start**, in a PowerShell window, from the main checkout:

```powershell
cd E:\projects\cascade\ops
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\keeper-supervised.ps1 -Deployment v3-launch -DryRun
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\keeper-supervised.ps1 -Deployment v3-launch
```

`-DryRun` prints what it would run, checks the key paths, the record, pnpm and the lock, and says
whether a real start would go ahead. It starts and writes nothing. The key paths default to
`C:/Users/danie/.foundry/keystores/cascade-keeper` and `C:/Users/danie/.foundry/cascade-keeper.pw`;
change them with `-Keystore` and `-PasswordFile`. `-Cadence` (default `launch`) sets `OPS_CADENCE`.

**Stop**: press Ctrl-C in its window, or from any PowerShell window run
`powershell -NoProfile -ExecutionPolicy Bypass -File E:\projects\cascade\ops\scripts\keeper-supervised.ps1 -Stop`.
`-Stop` asks the supervisor to stop, waits up to 30 seconds, then ends it. Either way it ends the
keeper's whole process tree (cmd, pnpm's node, the keeper's node).

- **In an emergency, use `-Stop`, never Task Manager on `node.exe`.** The supervisor counts an ended
  keeper as a crash and starts it again within seconds.
- Don't end the supervisor from Task Manager or with `Stop-ScheduledTask` either: that ends PowerShell
  only and leaves the keeper running. If that happens, run `-Stop`: it finds the keeper the dead
  supervisor recorded in its lock and ends it.

**Keep `main` checked out while it runs.** Each start and restart runs the code in the working tree as
it is then, so switching branches makes the next restart run that branch. Pulled changes take effect
only at the next restart: to run new code now, `-Stop` and start it again.

**Logs**: `ops/logs/keeper-<deployment>-<yyyy-MM-dd>.log`, a new file each day. Every keeper line is
timestamped, and the supervisor's own lines are marked `[supervisor]`. The folder is git-ignored, and
nothing deletes old files. To watch today's log:

```powershell
Get-Content "E:\projects\cascade\ops\logs\keeper-v3-launch-$(Get-Date -Format yyyy-MM-dd).log" -Wait -Tail 20
```

**Restarts**: exit code 3 with the keeper's line `THE KEEPER STOPPED ITSELF` means it stopped on
something from the right-hand column. It is never restarted: its last lines say why, so fix that and
start the supervisor again. Exit 2 with the usage text, or 0, is not restarted either. Any other exit is a
crash, including a 3 or a 2 without that line (cmd's or pnpm's own code). A crash restarts after 10
seconds, then 20, 40 and so on, at most 5 minutes apart, and a keeper that ran 10 minutes or more starts
the count again. Before each start the supervisor checks that no other keeper is running, and it never
starts one without that check succeeding: if Windows can't list the processes, it tries again every 10
seconds. A passing failure to read the process list or write the log is only logged; it never ends a
healthy keeper.

**At logon (optional).** To have Windows start the supervisor when you log on, run this once yourself in
PowerShell. It is a suggestion; nothing here registers it:

```powershell
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "E:\projects\cascade\ops\scripts\keeper-supervised.ps1" -Deployment v3-launch' -WorkingDirectory 'E:\projects\cascade\ops'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'Cascade keeper' -Action $action -Trigger $trigger -Settings $settings -Description 'Cascade keeper, under keeper-supervised.ps1'
```

- `-ExecutionTimeLimit ([TimeSpan]::Zero)` matters: by default Windows ends a task after 72 hours.
- Don't add a restart-on-failure setting to the task. The supervisor exits 3 only when the keeper
  stopped itself, and a task restart would undo that stop.
- It runs only while you are logged on. After a reboot it starts when you log on. If the PC sleeps, the
  keeper sleeps with it.
- Start it now: `Start-ScheduledTask -TaskName 'Cascade keeper'`. Stop it with `-Stop` (above). Remove
  it: `Unregister-ScheduledTask -TaskName 'Cascade keeper'`.

## v3.2 (the keeper Worker and its settings)

v3.2 deploys constructor-only (`ops/src/v32/settings.ts`, spec Appendix B): nothing is set after deploy. The keeper is
its own Cloudflare Worker, `cascade-keeper-production` (`keeper/wrangler.jsonc`). How to run each step:
`docs/runbook-v3.2.md`. The values the keeper runs with:

| Setting | Default | Where | What it is |
|---|---|---|---|
| The keeper's key | none: a fresh key | `pnpm keeper:new-key`, then `OPS_V32_KEEPER_ADDRESS` | never v3-launch's `0xBE2a34…`; one key on both chains, a Worker secret and a password-protected keystore on this PC for hand runs |
| Its funding | about 0.45 TAO and 0.03 ETH | the founder sends it (`pnpm ops budget` prints the ETH) | Bittensor: one claim's up-front fee (a 57,000,000 gas limit, about 0.285 TAO at 5 gwei) and a day of payouts and stakes. Base (R12a): a close sends a float of three times its bridge fee quote, which the wallet must hold whole (the door sends back what the fee leaves), so a full 50 + 50 batch's, about 0.013 ETH at 0.0043 ETH a quote, beside the 24 h cap; 0.005 ETH couldn't send a close quoting above about 0.0016 ETH |
| The 24 h spend cap, Bittensor | 0.4 TAO | `OPS_KEEPER_SPEND_CAP_BITTENSOR` (into the Worker's `DEPLOYMENT` by `pnpm config:from-record`) | one claim's worst case and a day of payouts and stakes; a claim fits up to about 5.5 gwei (Task 65's 2,000,000 exit reserve), above it claims wait, said loudly. A send whose worst case would cross what is left is refused; a mined one counts what it cost. 0.6 TAO before other people's money (runbook 2.2) |
| The 24 h spend cap, Base | 0.01 ETH | `OPS_KEEPER_SPEND_CAP_BASE` (into the Worker's `DEPLOYMENT` by `pnpm config:from-record`) | a day's closes: about two full 50 + 50 batches (about 0.0043 ETH each, gas and fee) or a dozen one-entry ones (about 0.00075). It was 0.0017 ETH, less than one full-list close, so one forced close stopped every Base send for up to 24 h (R12a). A send whose worst case, its gas and the value it keeps (a close's quoted fee less its batch's pot, not its whole float), would cross what is left is refused; a mined one counts what it cost. One fake redeem request a day in an empty batch costs about 0.00055 ETH net at the max wait (its 0.0002 ETH fee pays the rest): harmless at this cap |
| Payout top-up | 0 | `OPS_PAYOUT_TOPUP_MAX` (TAO, whole rao) | the most the keeper adds to a payout's bridge fee above what its entries pay; at 0 a fee above the ceiling waits |
| Park refund fee cap | 0.05 TAO | `OPS_PARK_REFUND_FEE_MAX` | the most the keeper pays as a park refund's bridge fee; bounded only by the spend cap |
| Automatic re-execution | off | the Worker's `OPS_REEXEC_AUTO` var | the keeper reports each CCIP FAILURE; you re-run it by hand (`pnpm ops reexec`); on only after the rehearsals |
| Gas price caps | 5 gwei (Base), 100 gwei (Bittensor) | `MAX_GAS_PRICE_*_GWEI` vars, `OPS_MAX_GAS_PRICE_*` for hand runs | Bittensor's base fee read 5 gwei on 2026-11-08 |
| Bittensor's per-transaction gas | at most 64,900,000 | `ops/src/keeper/core/ceiling.ts` (a constant) | the pool refuses a gas limit above about 64,998,400 (read 2026-11-15), whatever the 75,000,000 block; every keeper limit is held under it, a claim's included |
| Subrequests a run | 300 | `KEEPER_SUBREQUEST_BUDGET` | RPC requests a Worker run makes at most (the platform allows 1,000) |
| The claim policy | a claim at 25 × its cost, or monthly under $20 | `src/config.ts` `CLAIM_POLICY`; `OPS_CLAIM_COST_TAO` (a claim's measured cost) for hand runs | per listed hotkey; a hotkey with none of the vault's stake is claimed whenever credits wait |

**What ops/.env holds for a v3.2 hand run.** `OPS_DEPLOYMENT=v3.2-launch`; `OPS_BITTENSOR_RPC` an archive node
(`https://archive.chain.opentensor.ai`: the lite node keeps minutes of logs); `OPS_V32_KEEPER_KEYSTORE` and
`OPS_V32_KEEPER_PASSWORD_FILE` (the password file leaves the keystore guarded by your Windows login alone, as v3-launch's
keeper is); `OPS_KEEPER_URL` and `OPS_KEEPER_CONTROL_TOKEN` (the Worker's lease and control routes); `OPS_HOLD_URL` (the
monitor); `OPS_RELAYER_KEYSTORE` and `OPS_RELAYER_PASSWORD_FILE` (the stamp relayer, a fresh key made with
`cast wallet new`, never from the Ledger seed).

**The roles** are one Ledger's accounts: account 1 the owner, account 2 the guardian, account 3 the treasury; the keeper
its own key; the relayer its own. The Safe is recommended before other people's money (`docs/runbook-v3.2.md`, section 10).

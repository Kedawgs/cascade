# Launch settings

What `OPS_CADENCE=launch` deploys, for a first launch of about $10k (the 40 TAO deposit cap). Every
value lives in `src/config.ts` (`SETTINGS_V3_LAUNCH`, `LAUNCH_VAULT_LIMITS`), is set during deploy and is
read back by `pnpm ops verify`. Items marked **Decision** are product calls for the owner, not facts.

## Roles

A launch refuses to plan unless all six are set (in `ops/.env` or the shell). Nothing defaults to the
test wallet.

| Variable | What it is |
|---|---|
| `OPS_LAUNCH_OWNER_BASE`, `OPS_LAUNCH_OWNER_BITTENSOR` | The final owner on each chain: a Safe, or a timelock run by a Safe. It may be a contract. Per chain, because a Safe at one address on Base may not exist (or may be someone else's) on Bittensor. |
| `OPS_LAUNCH_GUARDIAN_BASE`, `OPS_LAUNCH_GUARDIAN_BITTENSOR` | The guardian on each chain, set in the constructors (so there is no 8-day wait). A plain account with its own key, or a Safe. |
| `OPS_LAUNCH_KEEPER` | The keeper on both chains. |
| `OPS_LAUNCH_TREASURY` | Receives the reward cut and the staker's fees. Must be a plain account (no code on either chain): deploy checks this before planning, and verify checks it again. |

Refused: a guardian equal to any owner or to the keeper; the keeper equal to any owner; the test wallet
as an owner or a guardian.

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
  also checks the keystore before it starts. The keeper can time and route but never take funds. A
  separate keeper key keeps the deployer's key off the always-on keeper machine.
- **Decision: the owners.** Is the owner a Safe, or a timelock behind a Safe? The README assumes a
  48-hour timelock. With a timelock, every limit change and every unpause waits for it. Check that
  Safe{Wallet} supports Bittensor EVM (chain 964) for the Bittensor owner. If it doesn't, use a plain
  account there and accept from it (`handoff` prints the transaction).

## Settings

| Setting | Launch | Default or test | Why |
|---|---|---|---|
| Deposit cap (front door) | 40 TAO | same | Already set. About $10k. |
| Batch value (front door) | 10 TAO | same | A batch carries at most a quarter of the cap. |
| Minimum deposit | 0.04 TAO | same | |
| Batch interval / payout delay | 1 h / 24 h | 10 min / 1 h (test) | The payout delay gives the guardian a day to stop a bad batch. |
| Redeem request fee | 0.0001 ETH | same | Kept: 50 redeems pay about 0.005 ETH, the bridge fee to close a full batch. |
| **Outflow: `maxDailyOutflowBps` / `minDailyOutflow`** | **20% / 10 TAO** | 20% / 100 TAO | See below. **Decision.** |
| **`maxEntryValue` / `maxMessageValue` / `minChunk`** | **10 TAO / 15 TAO / 10** | 2,000 / 4,000 / 10 | One redeem entry burns at most 10 TAO per delivery. One payout message carries at most 15 TAO: near the 10 TAO batch, and above a day's largest allowance at 60 TAO (12 TAO), so a day's exits still go home in one message and pay one bridge fee. **Decision** (15 TAO). |
| **`maxFeeBps` / `maxFeeAbs`** (payout bridge-fee ceiling) | **1% / 0.005 TAO** | 1% / 0.02 TAO | The live fee is about 0.00105 TAO, so this leaves about 5x. Above the ceiling, payouts wait (nothing is lost) until fees fall or the owner raises it. 0.02 TAO could take half of a 0.04 TAO minimum deposit; 0.005 takes at most an eighth. **Decision.** |
| **`maxTotalAssets`** | **44 TAO** | 1,000 TAO | Stops direct (Bittensor) deposits 10% above the cap. It never stops a front-door batch. It also bounds what a direct deposit can add to the outflow allowance's base. **Decision.** |
| Reward cut / swap fee / deposit fee | 10% / 0.15% / $0.05 | same | Unchanged from the test. |
| Delivery slippage | 1.5% | same | Default. |
| `maxDeposits` / `maxRedeems`, claim gas, hotkey dust, floors, unstake margin | defaults | same | Unchanged. verify now reads them all back. |

### The outflow limit, the main trade-off

In each 24-hour window, a front door's redeems burn at most the larger of 20% of the vault and the
floor. With the default floor of 100 TAO, larger than the whole vault, a forged bridge message could
force-exit everyone in one day.

At 10 TAO, a forced exit takes at most 25% of a 40 TAO vault per day (20% of a 50 or 60 TAO one). The
24-hour payout delay gives the guardian time to pause or remove the front door, and the owner time to
cancel the batch, which re-mints the shares. Windows are fixed, not rolling, so two windows back to
back can take about twice that within minutes.

The cost: one holder of the whole 40 TAO cap needs 4 windows to leave, 10 TAO a day. A request asks
for everything, burns at most the window's allowance, and the holder asks again the next day (the
site should say so). When many people leave at once, the first come are served first.

Alternatives: a 5 TAO floor exits a big holder in 8 windows; a 15 TAO floor bounds a forced exit at
37% of a 40 TAO vault.

## Before launch

- **Grow the TAO/WETH pool's observation slots.** `pnpm ops cardinality` prints the exact
  transactions. The oracle's 30-minute TWAP needs 901 slots on Base's 2-second blocks, and the pool has
  600 (read 2026-10-28). Base refuses any transaction above 16,777,216 gas, and one call from 600 to
  1,800 needs about 27M. So it takes two transactions from any wallet: `increaseObservationCardinalityNext(1200)`
  (measured: 13,479,008 gas), then `(1800)`. verify fails a launch, and preflight flags a problem, until
  the pool has enough slots.
- **Base logs.** `OPS_BASE_LOGS_RPC` (default `https://base-rpc.publicnode.com`) serves every Base log
  scan, because `mainnet.base.org` refuses `eth_getLogs`. Each query asks for `OPS_BASE_LOGS_WINDOW`
  blocks (default 10,000). publicnode accepted 50,000-block ranges and answered 1M blocks deep
  (probed 2026-10-28), so verify's first registry scan of a month-old deployment takes about 130
  queries. Each later scan resumes from the last. If the logs server refuses part of a scan, verify
  prints what is NOT CHECKED but still passes, so the keeper keeps running. Only something it finds
  fails verify: an unexpected bridge, front door, route or proposal.
- **Expected extras.** If you register a standby adapter or a second route on purpose, list it in
  `OPS_VERIFY_ALLOW` (for example `0xAdapter, route:1`), or verify fails on it. Pending proposals
  always show as warnings.
- **Emergency.** `pnpm ops pause [front-door|vault|both]` does a dry run: it estimates the call and
  checks the keystore. `--live` sends as the guardian, with `OPS_GUARDIAN_KEYSTORE` and
  `OPS_GUARDIAN_PASSWORD_FILE`. A Safe guardian gets a Transaction Builder file instead. `unpause` is
  the owner's and goes through the timelock if there is one. Do the dry run once before launch.

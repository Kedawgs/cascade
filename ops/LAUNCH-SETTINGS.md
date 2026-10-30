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
| `OPS_LAUNCH_KEEPER` | The keeper on both chains. Must be a plain account. Before each send, the keeper reads its code on both chains, once a round at most. Code on either chain blocks every send, because one key holds the address on both and an EIP-7702 delegation can cover every chain at once. `run` then stops. |
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
| **`maxTotalAssets`** | **44 TAO** | 1,000 TAO | Stops direct (Bittensor) deposits 10% above the cap. It never stops a front-door batch. It also bounds the large direct deposit that draining the outflow allowance's base with a gift needs (a direct deposit no longer raises the base, which counts only ramped-in stake). **Decision.** |
| **Adapter caps (`maxMessageValue`, each adapter's constructor)** | **50 TAO each** | 5,000 TAO (test: the lane's limit, as before) | One bridge message carries at most 50 TAO either way: five times the 10 TAO batch and above the 15 TAO payout message, so a bug or a stolen key moves at most that per message. The Base adapter's must hold a full batch (`maxBatchValue`); the Bittensor adapter's the vault's payout message and entry and a full batch (a bounced deposit can be one); deploy refuses to plan otherwise and verify fails. Raising those limits past 50 TAO needs new adapters first (7 days). **Decision** (about 50 TAO). |
| Reward cut / swap fee / deposit fee | 10% / 0.15% / $0.05 | same | Unchanged from the test. |
| Delivery slippage | 1.5% | same | Default. |
| `maxDeposits` / `maxRedeems`, claim gas, hotkey dust, floors, unstake margin | defaults | same | Unchanged. verify now reads them all back. |

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
  transactions. The oracle's 30-minute TWAP needs 901 slots on Base's 2-second blocks, and the pool has
  600 (read 2026-10-28). The target is 2,000, for margin.
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

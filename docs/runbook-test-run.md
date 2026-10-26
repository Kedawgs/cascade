# Test run runbook

The first real-money test of cascade.fi: about $20 of the owner's own money through the whole loop
on Base and Bittensor mainnet, from a throwaway test wallet. The contracts are unaudited, the site
is not advertised, and nobody else deposits. Design:
`docs/superpowers/specs/2026-10-24-cascade-test-deployment-design.md`.

Every command runs from `ops/` as `pnpm ops <command>`. Without `--live` a command uses the local
forks; with `--live` it uses the real networks. Every transaction is checked first (right network,
the wallet's expected next transaction, nothing of its own still waiting to be mined, and a trial
run on the network itself); if the trial fails, nothing is sent and no gas is spent, and the reason
is named (for example `NothingToStake()`). Signing is done by Foundry with the keystore and the
password file; the tool never reads either, and it checks once per run that the keystore signs as
the test wallet. Keeper commands also refuse until the whole deployment is in place and its
read-back has passed.

## Before you start

- **The test wallet** is `0x770932787DD3bcE64f14E31f4746bCe22E214fFF` on both chains. Its Bittensor
  address (SS58) is `5FxSW9dM8DbAWUFtADJPX5Wb7DctrJHadkJ3TB1GpBGvxQH2`. It deploys, owns, guards
  and runs the keeper for the test only.
- **The password file** `%USERPROFILE%\.foundry\cascade-test.pw` exists, and only your Windows
  account can read it. Keep the password itself until the end: the sweep needs the wallet.
- **Do not use the test wallet for anything else** until the deployment is done. Its addresses are
  predicted from its transaction count; receiving money is fine, sending is not.
- **Build the contracts** with `forge build` in `contracts/`.

## 1. Check the live networks (read-only)

`pnpm ops preflight` checks:

- both bridge lanes still run Chainlink's OffRamp 2.0.0 at the known addresses;
- both public RPCs answer the keeper's log queries (Base's allows only 200 blocks a query);
- ForeverMoney's vault is open (not paused, no migration announced);
- the wallet's transaction counts match the plan;
- the wallet holds the budget;
- a simulated delivery succeeds on the live Bittensor node (`SIMULATION OK`).

Before the real deployment, also run the fork tests: `FORK=1 forge test` in `contracts/`, using
the anvil cache recipe in `contracts/README.md` for Bittensor.

## 2. Rehearse on local copies

`pnpm ops rehearse` starts local copies of both chains, deploys and configures everything exactly
as the real run will, reads every setting back, then rehearses a 0.01-TAO deposit and the keeper
closing its batch through Chainlink's real contracts. Its transactions are signed for local chain
ids, so they can never be replayed on the real networks. It ends with "Rehearsed a batch close".

## 3. Top up once

`pnpm ops budget` prints exactly what to send. On 2026-10-24 it was 0.071 TAO and 0.0033 ETH.

- **TAO**: Kraken → your Tangem wallet → the test wallet's SS58 address. Kraken rejects that
  address directly, so the Tangem hop is needed. Withdraw a little extra to cover both fees.
- **ETH**: withdraw to `0x770932787DD3bcE64f14E31f4746bCe22E214fFF` and choose the **Base** network.
  Copy addresses in full from here or from `pnpm ops budget`, never from a shortened form.

Run `pnpm ops preflight` again: the balance lines should now say OK.

## 4. Deploy

`pnpm ops deploy --live` deploys in this order:

1. The Base bridge adapter.
2. The front door.
3. The Bittensor bridge adapter.
4. The vault, which names the front door, so the front door is active at once.
5. The two small reserves.
6. Making the test wallet the keeper.
7. Setting the payout delay to 1 hour.

It prints one line per step with its cost and then reads everything back. If it stops halfway,
run the same command again: it picks up where it stopped and never repeats a step that already
landed. If a transaction is still waiting to be mined, it stops and says so: run it again once
the transaction is mined (a dropped one is noticed and sent again). Only if it says the plan no
longer matches the wallet did something else use the wallet before a contract was created: then
`pnpm ops deploy --live --new-plan` starts over from the current transaction counts. The four
settings steps after the contracts go at whatever the wallet's next transaction is.

`pnpm ops verify --live` repeats the read-back at any time.

## 5. Deposit (from the website)

Run the site on your machine: `pnpm --dir ops ops web-config --live` once, then `pnpm dev` in
`web/`, and open http://localhost:3000. Connect MetaMask on Base. It needs USDC to stake and a
little ETH for network fees.

1. On **Stake**, enter a small amount first (about $3; the form shows the live limits). The form
   shows the TAO you will stake, the price, the swap fees and how long it takes.
2. Press **Stake**. If MetaMask offers to switch to a smart account, accepting makes it one
   confirmation; otherwise it asks four times the first time (approve USDC, swap, approve TAO,
   deposit), three after. If you stop halfway, the deposit's receipt in **Activity** has
   **Continue this deposit**, and nothing already confirmed is sent again. **Take it back before
   the batch closes** returns the TAO to your wallet while the batch is still open.
3. The operator closes the batch once it is due (every 10 minutes): `pnpm ops close --live`, which
   prints the bridge message id; `pnpm ops track <messageId> --live` follows it. The receipt in
   **Activity** moves along on its own: swap, deposit, cross to Bittensor, stake.
4. Deposit the rest of the $20 the same way.
5. The operator stakes it: `pnpm ops stake --live`. Staking waits until the vault holds at least
   0.02 TAO for one position (the chain's nominator minimum), so the first small deposit is staked
   together with the rest; until then it sits in the vault and still counts in your balance.

`pnpm ops run --live` does the operator's part by itself: it checks every minute, does whatever is
due and prints each bridge message id. It stops at the first problem and says why.

## 6. Withdraw (from the website)

1. On **Unstake**, enter an amount (at least 0.005 TAO, and never leaving less than that behind;
   the form offers **Unstake all** instead) and press **Unstake**. The first request in a batch
   carries a small ETH fee; the form shows it with the bridge fee and the time.
2. The operator closes the batch (`close`, then `track`). The vault burns your shares and queues
   the payout.
3. After the 1-hour payout delay the operator sends it back: `pnpm ops payouts --live`, then
   `track` the printed message to SUCCESS.
4. The receipt in **Activity** then says **Ready to claim**: **Claim as USDC** claims and swaps it
   back in one go (or **Keep it as TAO**).

## 7. Wind down

1. `pnpm ops wind-down --live --user <your Base address>`. It refuses, listing what is left,
   unless the open batch is empty, nothing is queued and nothing is waiting to be claimed. Then
   it pauses the front door and sets its cap to 0 (run again after a stop: it skips what is done).
2. Sweep the leftovers home, giving your own addresses in full:
   `pnpm ops sweep --live --tao-to <your Tangem SS58> --eth-to <your Base wallet>`.
   It refuses until the front door is paused, checks both addresses first, and sends the TAO
   through Bittensor's transfer precompile. Run again after a stop: a leg already home is skipped.
3. Only then delete the password file:
   `Remove-Item $env:USERPROFILE\.foundry\cascade-test.pw`

The contracts stay on-chain, paused. The tiny reserves (about 0.0000025 TAO) stay in them.

## If something goes wrong

- **A delivery shows FAILURE.** The TAO is held by the bridge, not lost. Re-running the
  delivery needs Chainlink's verifier data (contracts README, checklist item 27). For this test,
  write down the message id and stop the test.
- **ForeverMoney pauses or announces a migration.** `close` and `payouts` refuse until it lifts.
  Do not close batches during a migration notice: a batch delivered after the migration is
  stranded.
- **A keeper command refuses.** Read its one-line reason. "Would fail, nothing sent" means the
  trial run on the network failed, so no gas was spent; the name in brackets is the contract's
  reason. If `stake` refuses, the TAO stays in the vault and still pays out: carry on with
  `close` and the withdrawal.

## v3 test deployment (the one to run)

Sections 1 to 7 above describe the v2 test and stay as history. For the v3 test, follow this section.
v3 has its own deployment record, so the v2 one stays intact. Words used below: a **deployment** is
putting the contracts on the real chains; the **keeper** is the program that does the batch work the
site cannot (closing batches, staking, paying out); **gas** is the network fee on each transaction.

Where you type: commands starting `pnpm ops` run in `E:\projects\cascade\ops`. Commands that send real
money. If Claude's safety check blocks any `--live` command, type it yourself with `! ` in front, in
the Claude Code prompt, for example `! pnpm ops deploy --live` or `! pnpm ops stake --live`. The
variable below is per terminal: set it again in any new terminal before running an ops command. Never paste a private key or the password anywhere: the tools take the
password file by its path only.

Set the name once per shell. It picks which record every command reads and writes:

```
$env:OPS_DEPLOYMENT = "v3-test"
```

Use the same name for rehearsing and deploying: `budget` and `preflight` read
`rehearsal-v3-test.json`, which only `rehearse` under that name writes (the live record is
`ops/deployments/v3-test.json`). Without the name, `deploy` and `--new-plan` refuse, and `verify`
refuses the old v2 record (`test-2026-10.json`).

1. **Rehearse (free, on local copies).** `pnpm ops rehearse`. It deploys v3 on local copies of both
   chains, stakes with a USDC permit and delivers USDC back, signing on local chain ids so nothing
   can be replayed on the real networks. Good: it finishes with a success line and writes
   `ops/deployments/rehearsal-v3-test.json`. If it fails, stop and tell Claude.
2. **Budget.** `pnpm ops budget` prints exactly what to send. For a v3 deploy that is about
   0.044 TAO on Bittensor plus 0.002 ETH on Base; use the live figure it prints. A reward claim is
   not part of this test. If you ever want one it needs about 0.37 TAO up front (a large gas limit,
   refunded down to about 0.057 TAO afterwards); `budget` lists that separately, so ignore that line
   tomorrow.
3. **Top up.** As in section 3: TAO goes Kraken, then your Tangem wallet, then the test wallet's
   SS58 address (`5FxSW9dM8DbAWUFtADJPX5Wb7DctrJHadkJ3TB1GpBGvxQH2`); ETH goes to
   `0x770932787DD3bcE64f14E31f4746bCe22E214fFF` on the **Base** network. Withdraw a little extra
   for fees. You stake from your own MetaMask in step 8, so the test wallet does not need USDC.
4. **Preflight (read-only).** `pnpm ops preflight`. Good: every line says OK, including both
   balances and `SIMULATION OK`. A balance line short of the budget means send a bit more.
5. **Deploy (real money, you type it).** `! pnpm ops deploy --live`. It prints one line per step with
   its cost, then reads everything back. The test settings: 10-minute batches, 1-hour payout delay,
   validator tao.bot, treasury = the test wallet. If it stops halfway, run the same command again;
   it resumes and never repeats a step. If it says a transaction is still waiting, wait and rerun.
   Good: it ends with the read-back passing.
6. **Verify.** `pnpm ops verify --live`. It reads every setting back, including that the treasury has
   no code on either chain (so it is a plain wallet), the price oracle's two pool addresses, and
   the front door's delivery slippage of 150 basis points (1.5%). Good: all checks pass. If
   anything fails, stop and do not stake.
7. **Point the site at v3.** `pnpm ops web-config --live` writes `web/.env.local` with the
   deployment's public addresses (never a key). Then in `web/` run `pnpm dev` and open
   http://localhost:3000. The site reads `.env.local` only when it starts, so restart `pnpm dev` if
   it was already running. This is the same step as for v2: a record that includes the v3 staker
   and price oracle addresses switches the site to the v3 flows by itself. Good: the Stake tab shows
   live limits and a price. Bad: "isn't connected to a deployment" means `.env.local` is missing or
   was not reloaded.
8. **Stake a small amount from the site.** Connect MetaMask on Base (it needs about $20 of USDC
   and a little ETH for fees). The v3 front door refuses deposits under 0.04 TAO (about $10 at
   $250 per TAO; the contract error is BelowMinDeposit), so stake at least what the form's
   "From $X" shows. Enter $15 to $20 so fees and price moves cannot push it under. A normal MetaMask account signs one message (a USDC
   permit, which allows exactly this amount once, for 30 minutes) and then sends one transaction. A
   smart account asks for approve, then stake. Good: Activity shows a receipt for the deposit. If
   you stop midway, **Continue this deposit** on the receipt picks up where it left off.
9. **Hand-run the keeper.** One step at a time: `pnpm ops close --live` (closes the batch once its
   10 minutes are up and prints a bridge message id; `pnpm ops track <id> --live` follows it until
   SUCCESS), then `! pnpm ops stake --live` (stakes the TAO on Bittensor; the vault must hold at
   least 0.02 TAO, which a deposit of the size above already meets). Or all in one: `pnpm ops run
   --live`, which checks every minute, does whatever is due, prints each message id and never claims
   rewards. On a problem with stake, close or payouts it stops and says why. A delivery it cannot
   send does not stop it: it logs the reason once, holds that user until their facts change, and
   carries on. Good: the lines advance without errors.
10. **Watch Activity.** The deposit receipt moves along on its own: swap, deposit, cross to
    Bittensor, stake. Activity reads Base history from https://base-rpc.publicnode.com (the main
    Base RPC refuses log queries), so it needs internet access to that address. Good: the last step
    says staked and your balance shows on Stake and Unstake.
11. **Unstake.** On the Unstake tab enter an amount (at least 0.005 TAO, leaving at least that
    behind, or **Unstake all**). The form says USDC arrives automatically, at least today's price
    less 2%, and that floor is valid for 7 days. The first request in a batch pays a small ETH fee.
    Then the keeper does `close` and, after the 1-hour payout delay, `payouts`
    (`pnpm ops payouts --live`, then `track` the message to SUCCESS); `run` does both.
12. **Watch USDC arrive.** Once the TAO is back on Base the keeper sells it and sends USDC to your
    wallet: `run` does this by itself, or use `pnpm ops deliver --live` (add `--user <your address>`
    to deal with only you). Good: the receipt ends with USDC received, and USDC lands in MetaMask
    at or above the floor shown. If it does not arrive, after one hour back on Base the receipt
    says "taking longer than usual" and offers **Claim as USDC**; it also offers it at once if the
    price is below your floor. Claiming by hand is safe and always available. To retry a held
    delivery from the keeper side: `pnpm ops deliver --live --user <your address>`, or restart `run`.
13. **Wind down.** Check everything is paid out, then run
    `pnpm ops wind-down --live --user <your Base address>` (it refuses and lists what is left unless
    the open batch is empty and nothing is queued or waiting to be claimed), then
    `pnpm ops sweep --live --tao-to <your Tangem SS58> --eth-to <your Base wallet>` (full addresses),
    and only then delete the password file (section 7).

Rewards are not part of tomorrow. `pnpm ops rewards --live` shows what is waiting and a claim's
cost; `pnpm ops claim --live` claims only when the policy allows (at least 25 times the cost, or
monthly while a claim costs under $20 and does not exceed what is waiting). After a first claim, set
`OPS_CLAIM_COST_TAO` to the cost it printed.

The old v2 test deployment (record `test-2026-10.json`) still holds about 0.0702 TAO staked. You
unstake that yourself through the v2 site flows, separately; v3 `deploy` and `verify` refuse v2
records, so the two never mix.

Before any launch (not tomorrow): call `increaseObservationCardinalityNext(1800)` on the TAO/WETH
pool (checklist item 32 in `contracts/README.md`; it gives the price average enough history), and
close the rest of items 31 to 34.

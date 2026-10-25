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

## 5. Deposit

1. On the website, swap a little USDC to TAO on Base and deposit **0.01 TAO** (about $3) first.
2. `pnpm ops status --live --user <your Base address>` shows the open batch. After 10 minutes,
   `pnpm ops close --live` sends it to Bittensor and prints the full bridge message id with the
   command to follow it.
3. `pnpm ops track <messageId> --live` follows it until SUCCESS (usually tens of minutes). Your
   shares now exist on Bittensor and the TAO sits in the vault.
4. Deposit the rest of the $20 and repeat steps 2 and 3.
5. `pnpm ops stake --live` stakes it with the validator. Staking waits until the vault holds at
   least 0.02 TAO for one position (the chain's nominator minimum), so the first 0.01 TAO is
   staked together with the rest; until then it stays in the vault and still counts.

`pnpm ops run --live` does all of this by itself: it checks every minute, does whatever is due and
prints each bridge message id. It stops at the first problem and says why.

## 6. Withdraw

1. On the website, request a withdrawal of everything (it carries a small fee in ETH).
2. `close`, then `track` as above. The vault burns your shares and queues the payout.
3. After the 1-hour payout delay, `pnpm ops payouts --live` unstakes and sends the TAO back to
   Base, and prints the full bridge message id. `track` it to SUCCESS.
4. Claim the TAO on the website, then swap it back to USDC if you like.

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

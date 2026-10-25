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

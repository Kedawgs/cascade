# Cascade test deployment and hand-run keeper — design

Date: 2026-10-24. Pieces 2 and 3 of the test-run milestone (see the adapters spec,
`2026-10-24-cascade-ccip-adapters-design.md`, for piece 1). Status: revised after the builder check (2026-10-24).

## Intent

The user wants to put about $20 of their own money through the whole loop on the real networks:
USDC on Base → ForeverMoney's TAO on Base → front door → CCIP → vault on Bittensor EVM → root
stake → redeem → payout back to Base. This piece puts the four contracts on mainnet from a
throwaway test wallet and gives an operator (Claude on the user's machine) the commands to run
the batches by hand. Piece 4 (web wiring) then lets the user deposit and redeem from the website.

The user cares most about: security first; doing as much as possible today (no avoidable waiting);
small, known costs ("Half a Tao is like 140 bucks"); and plain-language output they can follow.

## Goals

1. One command that deploys and configures all four contracts on both chains from the test
   wallet, stopping at the first surprise, and that can be safely re-run after a stop.
2. A dry run first that proves the commands work and prints the exact TAO and ETH to top up.
3. A read-back check that compares every on-chain setting with the plan and fails loudly.
4. A hand-run keeper: commands to see what is due and do it (close batch, stake, pay out, follow
   a CCIP message), plus a loop that does the next due thing until told to stop.
5. A runbook in plain language: what happens in which order, what to check, how to stop and wind
   down.

## Non-goals

- The real launch. That gets a clean deployment after the audit, behind a timelock and a Safe,
  with a separate guardian. Nothing here is reused for it except, perhaps, the scripts.
- A hosted keeper bot, alerting, or a dashboard.
- Reward claims (a claim holds ~0.27 TAO of gas up front; $20 of stake earns below the
  0.0005-TAO claim threshold). Direct deposits on Bittensor.
- Web wiring (piece 4). This piece only writes the deployment record that piece 4 reads.

## Anti-goals (a failure even if it "works")

- Any code of ours reading, printing, logging or copying the private key, the keystore contents
  or the password. The password file is passed to Foundry by path only.
- A transaction sent without first being estimated against the live node (an estimate that fails
  means no transaction and no burned gas).
- A deployment that leaves a contract trusting an address that holds no code, or that a later
  step silently re-points.
- Costs well above the plan without the operator saying so first.

## Constraints and facts (verified 2026-10-24 unless marked)

- Test wallet `0x770932787DD3bcE64f14E31f4746bCe22E214fFF`: nonce 0 on both chains; 0.0079995
  TAO on Bittensor; 0 ETH on Base. Keystore
  `C:\Users\danie\.foundry\keystores\9ffde5b1-4193-4175-9eb3-a26f9d027214`, password file
  `C:\Users\danie\.foundry\cascade-test.pw` (only the user's Windows account can read it; it
  unlocks the wallet — checked). Another keystore, `sf-mainnet`, sits in the same folder and must
  never be used.
- The wallet is deployer, owner, guardian and keeper for the test. Accepted for the test only.
- Live addresses are the constants in `contracts/test/fork/ForkBase.sol` (Routers, OnRamps,
  OffRamps 2.0.0, both TAO tokens, pools, `AlphaVault`), selectors Base `15971525489660198786`,
  Bittensor `2135107236357186872`; chain ids 8453 and 964.
- Bittensor EVM: 5 gwei gas price; balances read net of a 500-rao existential deposit; staking
  floor 0.002 TAO (`getDefaultMinStake` = 2e6 rao), nominator minimum 0.02 TAO
  (`getNominatorMinRequiredStake` = 2e7 rao). Public RPCs allow ~128 requests a minute.
- Base gas price ~0.006 gwei.
- **`forge script` cannot deploy or operate the vault.** It runs every call in a local EVM first,
  and that EVM has none of Bittensor's precompiles (address mapping `0x…080C`, staking `0x…0805`),
  which the vault's constructor, `stakeIdle` and `processPayouts` call. Every Bittensor
  transaction must therefore be estimated and sent by the node itself (`cast send` /
  `cast send --create`, whose gas estimate runs on the live node with the real precompiles).
- `CascadeVault.coldkey` is immutable, so the vault's runtime code depends on the real address
  mapping and cannot be reproduced on a local fork byte for byte.
- Constructor signatures (main `f14319c`):
  - `CcipBaseAdapter(Config, uint256 minSendAmount)`,
    `CcipBittensorAdapter(Config, IAlphaVault)`, with
    `Config{router, token, localChainId, remoteChainId, remoteSelector, remoteAdapter, gasBase,
    gasPerEntry}`.
  - `CascadeFrontDoor(asset, bridge, vaultChain, vault, owner, guardian, batchInterval,
    minDeposit, depositCap, redeemRequestFee)`.
  - `CascadeVault(expectedColdkey, hotkey, bridge, owner, guardian, minDirectDeposit,
    initialFrontDoorChain, initialFrontDoor)`; the initial front door is active at once.
- Runbook facts carried from piece 1 and the initial-front-door review (contracts README,
  checklist items 11, 15, 25, 27, 28): fund the Bittensor adapter's 1e12-wei reserve with
  `fundReserve()` before any delivery; the vault's existential reserve (1e12 wei) before use;
  `setKeeper` before the first batch; the first live batch is one small entry; the keeper must not
  close a batch while `AlphaVault.migrationReadyAt() != 0`, `migrationFinished()` or `isPaused()`;
  run `script/simulate_inbound.sh` with the real constructor arguments just before deploying;
  confirm the OffRamp 2.0.0 addresses still match; a CCIP FAILURE needs Chainlink's
  `verifierResults` to re-execute (open item 27: if unanswered, accept the risk for $20 and say so).

## Decided with the user

- Real money, about $20, the user is the only depositor, the site stays unadvertised, the audit
  still gates anyone else's money.
- No 7-day wait: the vault names its front door at deployment (merged at `f14319c`).
- The password sits in a file only the user's account can read; deleted when the test ends.
- Top-ups happen once, after the dry run gives exact figures. TAO goes Kraken → the user's Tangem
  wallet → the test wallet's SS58 `5FxSW9dM8DbAWUFtADJPX5Wb7DctrJHadkJ3TB1GpBGvxQH2`.
- The user deposits and redeems from the website (piece 4); the operator runs the keeper.

## The design (my calls are marked *call*)

### Tooling (*call*)

A small TypeScript package `ops/` at the repo root (Node 24, pnpm, viem for reads and ABI
encoding, vitest for tests), reading ABIs and bytecode from `contracts/out/`. It sends every
transaction through Foundry with `--keystore <file> --password-file <file>`, so our code never
touches the key: contract creations with `forge create` (it reads the build output, so the
vault's 51,494-hex-character creation code never goes on a command line; Windows caps a command
line at 32,767 characters, and `cast send --create` failed on it with "Argument list too long"),
and calls with `cast send`. Estimates are raw `eth_estimateGas` requests from viem with **no
gas price** (with a gas price the node checks the balance and refuses; without one it estimates
even beyond the balance — checked live). Reasons: the
precompile constraint above rules out `forge script`; the keeper needs event scanning and simple
decisions that are awkward in bash; and piece 4 can reuse the ABIs and the deployment record.

Every send goes through one function that: checks the wallet's nonce equals the planned nonce;
estimates against the live node (stop if it fails); prints what it is about to do in
one plain line with the estimated cost; sends; waits for the receipt; and fails unless the status
is success (and, for a create, the contract address equals the predicted one and has code).
Output never includes key material; the password file path may appear, its contents never.

### Deployment order (from the initial-front-door review)

Base first, so the vault names a front door that already has code:

| Step | Chain | Nonce | Transaction |
|---|---|---|---|
| 1 | Base | 0 | Deploy `CcipBaseAdapter`; `remoteAdapter` = predicted Bittensor adapter (Bittensor nonce 0) |
| 2 | Base | 1 | Deploy `CascadeFrontDoor`; `bridge` = step 1; `vault` = predicted vault (Bittensor nonce 1) |
| 3 | Bittensor | 0 | Deploy `CcipBittensorAdapter`; `remoteAdapter` = step 1 (has code) |
| 4 | Bittensor | 1 | Deploy `CascadeVault`; `expectedColdkey` = `addressMapping(predicted vault)` read from the live precompile; bridge = step 3; initial front door = (8453, step 2) |
| 5+ | Bittensor | 2… | `adapterBit.fundReserve{1e12}`; 1.5e12 wei to the vault's SS58 mirror through the balance-transfer precompile `0x…0800` `transfer(bytes32 mirror)` (the vault's `receive` refuses plain transfers, CascadeVault.sol:687; estimated live at 28,872 gas; the vault then reads 1e12 net of the 500-rao existential deposit); `setKeeper(wallet)`; `setPayoutDelay(1 hour)` |

Before step 1, a fresh plan is computed from the current nonces on both chains and saved; steps
3–4 must land at exactly the predicted addresses or the run stops. If any nonce is found
different from the plan (a stray transaction, a reverted step), the plan is void: stop, explain,
and on the next run compute a new plan from the current nonces, abandoning the partial contracts
(they are disposable; a Base-side leftover trusts only empty or abandoned Bittensor slots).
Re-running after a stop resumes at the first step whose on-chain effect is missing.

With both nonces at 0 today, the Base adapter and the Bittensor adapter get the same address
(`0x221Cc4cF…887b`), and the front door and the vault share
`0x1694FcFCDb99CD1D64f54c787C47aDA5684E5750`; the vault's coldkey will be `0x9214633d…ad68`. The
record and all output always name the chain next to an address.

### Test settings (*call*, all owner-settable later except the immutables)

| Setting | Value | Why |
|---|---|---|
| Base adapter gas model | 540,000 / 26,450; `minSendAmount` 0.01 TAO | piece 1 calibration |
| Bittensor adapter gas model | 120,000 / 29,900 | piece 1 calibration |
| Front door `batchInterval` | 10 minutes | short waits in the test |
| `minDeposit` | 0.01 TAO | equals `minSendAmount` |
| `depositCap` | 0.15 TAO (≈ $40) | covers the user's $20 with room; the only bound on money through the front door, so it also bounds any stranger |
| `redeemRequestFee` | 1e14 wei (the beta value) | unchanged |
| Vault hotkey | `0x58aef7b1efb44806fe14c6c58d0c1eb634a59fd2513f0ced6f2d10e0569af40d` (SS58 `5E4z3h9yVhmQyCFWNbY9BPpwhx4xFiPwq3eeqmBgVF6KULde`) | the root validator ForeverMoney's `AlphaVault` stakes with (`positionOf`, netuid 0); ~52,550 TAO staked on it; already used by the fork tests |
| `minDirectDeposit` | 0.01 TAO | direct deposits are not used |
| `payoutDelay` | 1 hour | short waits; still exercises the delay |
| `maxTotalAssets`, fee, outflow and message limits | defaults | `maxTotalAssets` only bounds direct deposits (CascadeVault.sol:439), unused here; the fee ceiling `max(1%, 0.02 TAO)` covers the live Bittensor→Base fee of 0.001045 TAO |

### Dry run

1. **Pre-flight (read-only, live):** OffRamp 2.0.0 addresses match `ForkBase.sol`;
   `AlphaVault` not paused and no migration; nonces 0/0 (or the saved plan's); `simulate_inbound.sh`
   with `REMOTE_ADAPTER` = predicted Base adapter and the Bittensor gas model prints
   `SIMULATION OK`; the fork test suite (`FORK=1`) green on a recent block.
2. **Rehearsal on local forks:** run the full deployment and configuration against an anvil fork
   of Base and one of Bittensor, with the wallet's real nonces. On the Bittensor fork, minimal
   stand-ins for the two precompiles are installed with `anvil_setCode` (constructor-only: an
   address mapping and a no-op `setRejectStakingHotkeyGrowth`). Then run the read-back check
   against the forks. This proves the commands, the order and the check.
3. **Costs:** Base costs come from the rehearsal at the live gas price. Bittensor creates are
   estimated against the live node (real precompiles); the small configuration calls use the
   rehearsal's gas. An estimate creates at the wallet's *current* nonce, so the vault's estimate
   must use the coldkey of the address at that nonce (at nonce 0: `addressMapping(0x221C…)`),
   or it reverts `ColdkeyMismatch`. Measured by the builder check: Bittensor adapter 1,835,528
   gas (≈ 0.009 TAO), vault 6,038,421 gas (≈ 0.030 TAO); live CCIP fees Base→Bittensor
   6.19e14 wei, Bittensor→Base 0.001045 TAO. Add the keeper's expected Bittensor calls
   (`stakeIdle`, `processPayouts`, a handful) and Base calls (`closeBatch` plus the CCIP fee from
   the live Router quote, a handful), apply a 30% margin, subtract current balances, and print
   "send X TAO and Y ETH" in plain words. The earlier rough figure was ~0.08 TAO and ~0.003 ETH.

### Read-back check

After deployment (and on demand), on both chains, compare against the plan and fail on any
difference:

- every adapter immutable: `router`, `token`, `localChainId`, `remoteChainId`, `remoteSelector`,
  `remoteAdapter` (circular), `gasBase`, `gasPerEntry`, `minSendAmount`, `alphaVault`;
- front door: `vault`, `vaultChain`, `primaryBridge`, `asset`, owner, guardian, `batchInterval`,
  `minDeposit`, `depositCap`, `redeemRequestFee`;
- vault: `coldkey` equals the live `addressMapping(vault)`, `stakeHotkey`, `primaryBridge`,
  owner, guardian, keeper, `frontDoorActive(peerId(adapterBit.remoteChainId(), frontDoor))`,
  exactly one `FrontDoorActivated` in its deploy transaction, `payoutDelay`, and the reserves:
  balances read 500 rao (5e11 wei) below what was sent, so expect the adapter at sent − 5e11
  (at least 5e11) and the vault at 1e12 or more;
- each contract's runtime code equals the build's `deployedBytecode` with the immutable ranges
  (from the artifact's `immutableReferences`) masked.

### Hand-run keeper

Commands (names are the builder's):

- `status`: plain-language state of both chains: the open batch (entries, total, when it can
  close), CCIP messages in flight and their state on the destination OffRamp, vault assets,
  stake, queued payouts and when each is due, claimable payouts on Base, wallet balances.
- `close`: `closeBatch` on the front door when due, with `msg.value` = the live fee quote plus a
  margin (the front door refunds the rest). A lone redeem's `redeemRequestFee` (1e14 wei) is
  below the live fee (6.19e14 wei), so the keeper always tops up. Refuses while `AlphaVault` is paused, migrating or
  migrated.
- `track <messageId>`: follow a CCIP message to `SUCCESS` or `FAILURE` on the destination OffRamp.
- `stake`: `stakeIdle` when the vault's available balance is at least the staking floor.
- `payouts`: for each batch from `PayoutBatchQueued` (cursor, count and `queuedAt` from
  `getPayoutBatch`), once its delay has passed, call
  `processPayouts(bytes32 key, (address user, uint256 shares, uint256 assets)[] payouts,
  uint32 maxEntries)` (CascadeVault.sol:544) with the batch's **full** list on every call: the
  `DepositBounced` entries (shares 0) first, then the `Redeemed` entries, in log order
  (CascadeVault.sol:523-524). The keeper checks the list against the stored running hash
  (`keccak(abi.encode(h, user, shares, assets))`, CascadeVault.sol:795-817) before sending.
  `maxEntries` for the keeper is raised to at least `minChunk` and capped at 100. Before sending
  it also checks: not paused, the front door active, the fee within the ceiling, the chunk's net
  at least the staking floor (else `BelowConversionFloor`), and `AlphaVault` not paused.
- `run`: loop every minute or so doing the next due action, printing one line per action and a
  short status, until stopped.

Every keeper transaction goes through the same send function (nonce, live estimate, plain-line
summary, receipt check). Event scans use bounded block ranges and back off on HTTP 429.

### Deployment record

`ops/deployments/test-2026-10.json` (git-ignored; the website for the test runs on the user's
machine at localhost and reads it locally, so it never needs to reach the public repo or a host): the plan, every transaction hash, block, gas used
and cost, the contract addresses and the read-back result. Piece 4 reads it.

### Runbook

`docs/runbook-test-run.md`, plain language: before you start (balances, password file), the dry
run, the deployment, the checks, the deposits (*call*: the user's first website deposit is 0.01
TAO, about $3, followed until it is staked; then the rest of the $20; then one redeem of
everything, its payout and the claim on Base: three batch closes and one payout batch, which the
single top-up is sized for), and winding down: redeem everything, wait for the payout and claim
it, `pause` the front door and set its cap to 0, then sweep the test wallet's leftovers (TAO to
the user's Tangem address through the `0x…0800` transfer precompile, ETH to the user's own Base
wallet; the user gives both addresses in chat at the time), and only then delete the password
file. Keep the password until the sweep is done. What to do if something stops halfway.

## Testing (*call*)

- Unit tests (vitest) for: the nonce plan and address prediction (with different nonces on the
  two chains, so a chain mix-up cannot pass by coincidence); the cost arithmetic; the
  read-back comparison (including the masked-code check); the keeper's "what is due" decisions;
  rebuilding payout entries from logs and checking them against `payoutsHash`; and that the
  send function refuses on a nonce mismatch or a failed estimate and never prints secrets.
- The rehearsal on local forks is the integration test for deployment, configuration and
  read-back; `close` and `track` are also rehearsed on the Base fork (real OnRamp on the fork).
- `stakeIdle` and `processPayouts` touch the staking precompile and cannot run on a fork; they are
  covered by the existing forge tests (mocks) and the fork tests, and guarded live by the
  estimate-first rule.

## Left to the builder

File layout inside `ops/`; command names and flags; how `cast` is located and called on Windows
(`C:\Users\danie\.foundry\bin\cast.exe`); legacy versus EIP-1559 transactions on each chain; RPC
endpoints (public by default, overridable); log formatting; how the `run` loop sleeps.

## Settled by the builder check

1. Estimating beyond the balance works when no gas price is sent (Bittensor adapter estimated at
   1,835,528 gas with 0.008 TAO in the wallet; with a 5-gwei gas price the node refuses).
2. `processPayouts` and the event rebuild are as written under the keeper's `payouts` command.
3. No floor trap at these sizes: a 0.01-TAO deposit stakes 9,999,500 rao; a full redeem pays out
   about 0.009999 TAO, minus the 0.001045-TAO fee, which clears the 0.002 floor; the unstake takes
   the full-exit path below the 0.02 nominator minimum (CascadeVault.sol:922-923). Not settled by
   code: whether the chain accepts a root position below the nominator minimum at `addStake`; the
   estimate-first rule catches a refusal, and the TAO then stays liquid and still pays out.
4. The settings are accepted: both gas models stay under the 7M cap at 200 entries; `payoutDelay`
   is at most 7 days; the rest have no bounds. Live: the hotkey is `AlphaVault`'s root position;
   `AlphaVault` is not paused or migrating; nonces 0 and 0.

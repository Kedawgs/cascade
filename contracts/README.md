# Cascade contracts (v3)

Solidity contracts for Cascade: staked TAO for people who do not have a Bittensor wallet. Users
deposit TAO on Base, the TAO is staked on Bittensor's root network (netuid 0), and users hold csTAO
shares whose price rises as staking rewards come in.

- Product context: [`docs/architecture.md`](../docs/architecture.md).
- Authoritative design: [`docs/superpowers/specs/2026-10-21-cascade-v2-vault-on-bittensor-design.md`](../docs/superpowers/specs/2026-10-21-cascade-v2-vault-on-bittensor-design.md)
  (revision 5, with the as-built rulings of revision 6 at the top).
- Rail facts (CCIP, ForeverMoney, limits): [`reports/Cascade v2 Bittensor vault rails.md`](../reports/Cascade%20v2%20Bittensor%20vault%20rails.md).
- Bridge adapters: [`docs/superpowers/specs/2026-10-24-cascade-ccip-adapters-design.md`](../docs/superpowers/specs/2026-10-24-cascade-ccip-adapters-design.md)
  and [`docs/forevermoney-probe.md`](../docs/forevermoney-probe.md).

v3 (2026-10-26) adds one-signature staking from USDC, USDC delivered on exit, and a reward cut. Design:
[`docs/superpowers/specs/2026-10-26-cascade-v3-design.md`](../docs/superpowers/specs/2026-10-26-cascade-v3-design.md);
research: [`reports/Cascade v3 swap routes and permits.md`](../reports/Cascade%20v3%20swap%20routes%20and%20permits.md)
and [`reports/Cascade v3 root validators.md`](../reports/Cascade%20v3%20root%20validators.md). The
[v3 trust model](#v3-trust-model) says plainly what each new power can and cannot do. See the
[pre-mainnet checklist](#pre-mainnet-checklist).

v3.2 (deployed 2026-11-16 as `v3.2-launch`) is the live version. Design:
[`docs/superpowers/specs/2026-10-31-cascade-v3.2-design.md`](../docs/superpowers/specs/2026-10-31-cascade-v3.2-design.md);
runbook: [`docs/runbook-v3.2.md`](../docs/runbook-v3.2.md). Below, what it changed is marked "v3.2".

Licence: the repository is MIT, except `src/CascadeTwapOracle.sol`, which is GPL-2.0-or-later
because it ports the maths of Uniswap's `OracleLibrary`.

## Launch configuration (v3.2-launch)

Live on Base and Bittensor mainnet since 2026-11-16, holding only the founder's own money while a
mainnet canary with small amounts runs. Not professionally audited.
The source is verified on Sourcify for all 13 contracts and libraries: an exact match for 11, and a match for the vault and `CascadePayoutLib`, the two that link libraries (links in [`SECURITY.md`](../SECURITY.md)).
These are the only Cascade contracts: the previous deployment (`v3-launch`,
[below](#the-previous-deployment-v3-launch)) is empty and is being retired, and the old test
deployments (`v3-test` and `test-2026-10`) still exist on-chain but are not the product. See also
[`SECURITY.md`](../SECURITY.md).

| Contract | Chain | Address |
|---|---|---|
| `CascadeFrontDoor` | Base (8453) | [`0xd1Ae29169146Ff62c9E9D4dC17c653B62fA3754e`](https://basescan.org/address/0xd1Ae29169146Ff62c9E9D4dC17c653B62fA3754e) |
| `CascadeStaker` | Base (8453) | [`0x371C5CFa5F5F6B3356fBC360EaD26066A2958B87`](https://basescan.org/address/0x371C5CFa5F5F6B3356fBC360EaD26066A2958B87) |
| `CascadeTwapOracle` | Base (8453) | [`0xDddd746237b923A0081630F4DcE7857De568696D`](https://basescan.org/address/0xDddd746237b923A0081630F4DcE7857De568696D) |
| `CcipBaseAdapter` | Base (8453) | [`0x0BEbdEbD94Ff1eD14a06E8fC055Afabd1465637E`](https://basescan.org/address/0x0BEbdEbD94Ff1eD14a06E8fC055Afabd1465637E) |
| `CascadeDoorLens` (the front door's read-only lens) | Base (8453) | [`0x9Da3e48fF7ab29AA277f37B0bC5B14c8Bbf96e7f`](https://basescan.org/address/0x9Da3e48fF7ab29AA277f37B0bC5B14c8Bbf96e7f) |
| `CascadeVault` | Bittensor EVM (964) | [`0x56544AfF15fccea33b4db189cB5B3726DBac724e`](https://evm.taostats.io/address/0x56544AfF15fccea33b4db189cB5B3726DBac724e) |
| `CcipBittensorAdapter` | Bittensor EVM (964) | [`0x24B1b5eC0bB46c4F9850Ce9D75f7957eCB3B0027`](https://evm.taostats.io/address/0x24B1b5eC0bB46c4F9850Ce9D75f7957eCB3B0027) |
| `CascadeVaultLens` (the vault's read-only lens) | Bittensor EVM (964) | [`0xc8b3b74261489ff544cF18335778498cd6f32010`](https://evm.taostats.io/address/0xc8b3b74261489ff544cF18335778498cd6f32010) |
| `CascadeBatchLib` (library, linked by the vault) | Bittensor EVM (964) | [`0xf8A59A42e8A67C5609714d6bC3fAeDC7F8a799CD`](https://evm.taostats.io/address/0xf8A59A42e8A67C5609714d6bC3fAeDC7F8a799CD) |
| `CascadeStakeLib` (library, linked by the vault) | Bittensor EVM (964) | [`0xE52a9c0ea3DE0D4FF7249a65c8cFbeE78f68E01C`](https://evm.taostats.io/address/0xE52a9c0ea3DE0D4FF7249a65c8cFbeE78f68E01C) |
| `CascadePayoutLib` (library, linked by the vault) | Bittensor EVM (964) | [`0xA141426E5DFf1F7C9Cc2019A0bD2AC0BD0809328`](https://evm.taostats.io/address/0xA141426E5DFf1F7C9Cc2019A0bD2AC0BD0809328) |
| `CascadeHotkeyLib` (library, linked by the vault) | Bittensor EVM (964) | [`0xa499190631AeBFa8A2987764fFA4cb3A6B5dd0aa`](https://evm.taostats.io/address/0xa499190631AeBFa8A2987764fFA4cb3A6B5dd0aa) |
| `CascadePayoutMath` (library, linked by `CascadePayoutLib`) | Bittensor EVM (964) | [`0xEa16630ba8376bE307CEa231540E5A72295aa3B9`](https://evm.taostats.io/address/0xEa16630ba8376bE307CEa231540E5A72295aa3B9) |

Roles: owner `0x478965abDe80ef000e0f3e60008B43ac46130bFC` (both chains), guardian
`0xf996A598B75ab25B140bC50989C76eBB56B0187F` (a second account on the owner's hardware wallet for
now), keeper `0x7070F6A27be2Fe8521146450B5EB65190f5C7c9d`, treasury
`0x34D1f7DC8Cb62280d0bc617b784Bd2c4668809f6`.

Limits: a 40 TAO deposit cap, at most 10 TAO per batch, a minimum deposit of 0.04 TAO, a 24-hour
payout delay, at most 10 TAO per unstake, unstakes through Base limited to 20% of the staked TAO a
day, or 10 TAO if that is more, an unstake request fee of 0.0002 ETH and a reward cut of 10%; the
validator is tao.bot (`ops/LAUNCH-SETTINGS.md` has every value and why).

**The owner at launch is a single hardware-wallet account,** the same account on both chains, not a
Safe, with no timelock contract in front of it. The waits are in the contracts themselves (v3.2's
owner scheduler, in the `CascadeBase` row [below](#contracts)): an owner change that loosens a
protective limit runs only as a scheduled item, announced on-chain, 48 hours later for a setting,
7 days for a new bridge or front door, and 8 days for a new owner or guardian; the guardian can
cancel a setting change or a new bridge or front door while it waits. A tightening, a pause and the
setters that row lists as immediate take effect as soon as the owner signs, within the bounds in the
code. Wherever this README speaks of "the timelock" or "the timelock's delay" (a timelock as owner,
which its older passages assume), that delay is zero for v3.2-launch: the scheduler's waits are the
only ones. A Safe as owner is recommended before Cascade takes other people's money.

### The previous deployment (v3-launch)

Live from 2026-10-30 until v3.2-launch replaced it. It is empty (its vault holds 0 shares and 0 TAO
since the founder's test money left) and is being retired: do not send money to it. It runs the
earlier contracts (v3.1), and its addresses stay here for the record.

| Contract | Chain | Address |
|---|---|---|
| `CascadeFrontDoor` | Base (8453) | [`0xbAe5417A40613141790624bCeF6BaFc3b24ff9AA`](https://basescan.org/address/0xbAe5417A40613141790624bCeF6BaFc3b24ff9AA) |
| `CascadeStaker` | Base (8453) | [`0xe33012f8ae80E17a7D7B8d9249043dB01D27e59E`](https://basescan.org/address/0xe33012f8ae80E17a7D7B8d9249043dB01D27e59E) |
| `CascadeTwapOracle` | Base (8453) | [`0xcAa85F00b6e470Dd28a31FBa982267B820736eBc`](https://basescan.org/address/0xcAa85F00b6e470Dd28a31FBa982267B820736eBc) |
| `CcipBaseAdapter` | Base (8453) | [`0xF2B3A36185e74ddCf8Ea9A174c06b75520F47F92`](https://basescan.org/address/0xF2B3A36185e74ddCf8Ea9A174c06b75520F47F92) |
| `CascadeVault` | Bittensor EVM (964) | [`0x450cD94401B45c72C09734071fe683F6b74Aea72`](https://evm.taostats.io/address/0x450cD94401B45c72C09734071fe683F6b74Aea72) |
| `CcipBittensorAdapter` | Bittensor EVM (964) | [`0x002d7C6b2A6062d4E066FB41671DbB3Fd4f388E1`](https://evm.taostats.io/address/0x002d7C6b2A6062d4E066FB41671DbB3Fd4f388E1) |

Its owner, guardian and treasury are the accounts above; its keeper is
`0xBE2a34FE20C3006E759537922C807c228707DC23`. v3.1 has no scheduler, so its owner's parameter changes
and unpauses take effect as soon as it signs, within the bounds in the code; a new front door or
bridge waits 7 days and the guardian can veto it, and replacing the guardian takes 8 days.

## Contracts

| Contract | Chain | What it does |
|---|---|---|
| `CascadeVault` | Bittensor EVM (chain 964) | Holds the root stake and the csTAO balances. Prices every batch from the stake it reads directly. Queues payouts and sends them in chunks. Lets Bittensor-native users deposit and redeem directly. v3 adds the reward cut. v3.2 makes every getter internal but the share token's (`name`, `symbol`, `decimals`, `totalSupply`, `balanceOf`, `allowance`), `CascadeBase`'s `owner`, `pendingOwner`, `paused` and `extsload`, and its own `launchChain` (the immutable chain of its launch door, from the constructor's `Params`): the vault lens serves the rest under the same names, `price` and `hotkeyCount` only there. Its `LimitSet` event is keyed by the setter's selector. v3.2's `setOutflowLimits(bps, minDaily, globalBps)` adds a global outflow window beside each door's, and lower bounds on all three values (Task 17, `OutflowLimitsSet`; the lens serves `globalOutflowBps`). v3.2 replaces `directOnly` and `allowFrontDoorRedeems` with origin by chain (Task 18, spec §3.4): each holder's `redeemOrigin` (the lens serves it and `DIRECT_ORIGIN`) is 0 until a front door first mints for it, then that door's chain; every direct deposit sets `DIRECT_ORIGIN`; `setRedeemOrigin(chain)` lets the holder name any chain with an active door, or `DIRECT_ORIGIN` (`RedeemOriginSet`, else `UnknownOrigin`); a door burns only for its own chain's holders and bounces a deposit for another chain's (`DepositBounced` gains its `reason`, `Insolvent` or `ForeignOrigin`), and no door may be activated on chain `DIRECT_ORIGIN`. v3.2 adds the vault's own exits machine (spec §3.6) beside `CascadeBase`'s: `pause` (owner or guardian) records the pauser (`pausedBy`) and stamps its clock, with `ExitsClosed`, and a second pause reverts; the owner's `unpause` clears it, stamps nothing and emits `ExitsReopened`. Each door has a state (`doorState(peer)`: `Unknown`, `Active` or `Removed`, replacing `frontDoorActive`) and each chain a count of active doors (`activeDoors(chain)`). `removeFrontDoor` (owner or guardian) of an active door makes it `Unknown` when the guardian removes it (its re-activation Ordinary, guardian-cancellable) and `Removed` when the owner does (its re-activation a Reopen, owner-only to cancel). The guardian may also remove a door the owner removed, making that removal its own: the door becomes `Unknown` (it is not counted out again) and its pending Reopen is deleted (`Cancelled`, by the guardian), and on the launch chain, while the launch door's hold is the owner's, the hold becomes the guardian's (its record and its clock, with `ExitsClosed`); the owner can never remove an `Unknown` door. Removing the launch chain's last active door also records the remover (`launchDoorRemovedBy`), stamps its clock and emits `ExitsClosed`, while any other door's removal (another chain's last included) records and stamps nothing. An activation on the launch chain clears that hold; so does `setGuardian` when the guardian made it (to the sitting guardian too), never an owner's. `activateFrontDoor` refuses chain 0. The owner's `cancelPayoutBatch` of a launch-chain door's batch stamps the owner's clock (`ExitsClosed`), recording nothing. The vault's `ownerHold`/`guardianHold` read all three records. v3.2's unstake walk outlasts a root hold (Task 20, spec §3.8): each removal runs in a `try` with its share of the gas, `max(unstakeGas, (gasleft - EXIT_GAS_RESERVE) / positionsLeft)` (`setUnstakeGas`, 150,000 to 5,000,000, immediate both ways, 400,000 at launch; the lens serves `unstakeGas` and `EXIT_GAS_RESERVE`, 1,200,000), and a removal the chain refuses, or that burns its gas, is skipped (`UnstakeSkipped`) while the walk goes on, so one held pair no longer freezes every exit. Every listed pair can be held, though, so `idleBufferBps` (`setIdleBuffer`, at most 1,000 bps, an increase at once and a decrease scheduled, 0 at launch; the lens serves it) has `stakeIdle` keep that share of the booked stake, at least `minDailyOutflow`, liquid for exits. |
| `CascadeFrontDoor` | Base | Collects deposits of ForeverMoney's bridged TAO and redeem requests into batches, forwards each batch to the vault with each user's address, receives payouts and lets users claim them. It never prices anything. v3 adds USDC delivery: `setDelivery`, `requestRedeemWithDelivery` and a keeper-only `deliver`. v3.2 closes by id (Task 29, spec §3.5): `closeBatch(expectedId, minValue)` sends only the batch it names (else `WrongBatch(openId)`) and only with at least `minValue` of deposits in it (else `BatchTooSmall`; an empty batch still rolls, whatever `minValue`); `canClose` dropped the room rule, which R6b U4 brought back and R7 widened to the half rule (while the batch holds deposits it closes early at half the batch value or half the cap's room, or with no room left for a minimum deposit; a batch of redeems alone waits for its interval); the batch's fee pot pays the bridge fee first and the closer's value only the rest, the closer gets back only its unused value, and the pot's remainder rolls into the next batch's pot (`potCarried`, and `BatchClosed`'s new last field) instead of going to the closer; the owner's `sweepPot(amount)` sends at most `potCarried` to the immutable `treasury` (a new `Params` field, non-zero), with `PotSwept(amount)`. v3.2's pause stops only `deposit`, `depositFor` and `deliver` (Task 30, spec §3.5): every exit call (`requestRedeem`, `requestRedeemWithDelivery`, `cancelRedeem`, `cancelDeposit`, `closeBatch`, `claim` and incoming payouts) works while the front door is paused. v3.2 adds a cancel cooldown (R11, spec §3.5): `cancelDeposit` reverts `CancelTooSoon(cancelableAt)` until `CANCEL_COOLDOWN` (5 minutes) after the caller's last `deposit` or `depositFor` (the entry owner's clock, `lastDepositAt`, internal, declared last; the view `cancelableAt(user)`), so a deposit that lifts a batch over the half rule's line is still there at the keeper's next round; none applies while the door is paused (closes still land, but no deposit can, so there is no fresh deposit to hold) or its primary bridge is disabled (no close with entries can land), R12: `cancelableAt` reads 0 and the cancel goes at once. R12 also gives the deposit list a half rule: `canClose` is true once the list holds half its limit (`2 x entries >= maxDeposits`, 25 of 50), while the redeem list still needs its full limit. Payouts are accepted from any known bridge (`bridgeKnown`, ever activated), so a bridge disabled since still delivers a late payout or a refund, bounded exactly as an enabled one by `TokensNotReceived` and its own replay record, while `disableBridge` stops only the closes through it. `MAX_BATCH_INTERVAL` is 24 hours (7 days before); `minDeposit` is at least `MIN_DEPOSIT_FLOOR`, 0.03 TAO (twice the vault's `MAX_FEE_ABS`), in the constructor and `setCaps` (`InvalidParameter`); and `maxBatchValue` is at most the primary bridge's `maxMessageValue()` in the constructor, `setMaxBatchValue` (either way) and `setPrimaryBridge` (`AboveBridgeCap`). v3.2 adds a pool-depth floor on deliveries (Task 32, spec §3.7): `minPoolLiquidity[0]` (TAO/WETH) and `minPoolLiquidity[1]` (WETH/USDC), a new `Params` field (`uint128[2]`), are the least 30-minute harmonic-mean in-range liquidity each pool must show (the oracle's `meanLiquidity()`, read beside the TWAP floor, one call each); `deliver` reverts `ThinPool(index, liquidity)` for the first pool below its floor, TAO/WETH first, before any token moves, and `claim` never reads it, so the user claims by hand meanwhile. `setMinPoolLiquidity(index, value)` (owner) applies a raise or an equal value at once and a cut only as a scheduled item; an index above 1 is `InvalidParameter`; a floor of 0 checks nothing (the emergency path if liquidity moves to other pools). Each change, and each floor the constructor sets, logs `LimitSet("minPoolLiquidity", index, value)`. |
| `CascadeStaker` | Base | One-signature staking. Takes USDC (by permit signature, or by approval for wallets that cannot sign a permit), pays the fees to the treasury, swaps through an owner-set route with a minimum checked by the balance it actually received, and calls the front door's `depositFor` for the user. `sellFor` does the reverse swap for deliveries. v3.2 adds the buy floor (Task 33, spec §3.7, I-31): the TAO a stake receives must also be at least 95% of what the front door's TWAP oracle says the USDC swapped is worth (`taoValue(usdcIn - fees)`; `MAX_BUY_SLIPPAGE_BPS`, 500, a constant), at every size, else `BelowOracleFloor`, an error apart from the caller's own minimum (`InsufficientOutput`, or the router's "Too little received"); a stake reverts `NoOracle` while the front door has no oracle and the oracle's own revert while it cannot answer. `sellFor` reads no buy floor (the front door's delivery floors bound the sale). Its constructor takes one `Params` (the tokens and front door, owner, treasury, route 0, the delivery route and the fees), each through its setter's check and logged as its setter logs it, so it stakes with no owner call after deploy; routes and fees stay the owner's to change at once, within their caps. |
| `CascadeTwapOracle` | Base | A 30-minute average TAO price in USDC, from Uniswap's TAO/WETH 0.3% and WETH/USDC 0.05% pools. Used only for floors, never as a price anything settles at: v3's delivery floor (`usdcValue`). v3.2 adds the inverse, `taoValue(usdcUnits)` (rounded down), for the staker's buy floor (Task 33), and each pool's 30-minute harmonic-mean in-range liquidity, `meanLiquidity()`, for the front door's depth floor on deliveries (Task 32, spec §3.7); its constructor refuses a pool with fewer than `MIN_CARDINALITY` (1,801, `TWAP_WINDOW + 1`, since Revision 28; 901 before) observation slots in use (`TooFewObservations`). Ownerless. GPL-2.0-or-later (ports Uniswap's `OracleLibrary`). |
| `CascadeBase` | both | Shared admin: two-step owner, guardian, pause, bridges, and the owner scheduler. `renounceOwnership` is disabled. v3.2 adds `extsload(bytes32)`, a view returning one storage slot's raw word, for the read-only lenses (one slot per call, never a batch form), and makes its other getters internal (`guardian`, `bridgeEnabled`, `primaryBridge`, `REGISTRY_DELAY`, `GUARDIAN_DELAY`): the lenses serve them under the same names, and both targets keep `owner`, `pendingOwner`, `paused` and `extsload`. v3.2 replaces the bridge and guardian registries (and the vault's front-door registry) with the owner scheduler (spec §3.6): `schedule(data)` stores an owner change under `keccak256(data)` for its class delay (48 hours, 7 days for an activation, 8 days for `setGuardian` and `transferOwnership`), `execute(data)` runs it through a self-call from its `readyAt` and its `readyBlock` (half its delay in the chain's calibrated blocks, `MS_PER_BLOCK`) until it lapses, once its 7-day window in time and its window in blocks (half the 7 days in calibrated blocks after `readyBlock`, Revision 28) have both passed, the owner `cancel`s any item and the guardian an Ordinary one, and anyone `prune`s a lapsed one. `setGuardian`, `transferOwnership`, `activateBridge` and the vault's `activateFrontDoor` run only that way (a new bridge or door is Ordinary, so the guardian can veto it; a known bridge's re-activation is a Reopen, which only the owner cancels); the lenses serve `scheduled(id)`, `bridgeKnown`, `PARAM_DELAY` and `EXECUTE_WINDOW`. v3.2 also adds the exits machine's base (spec §3.6): the primary bridge's `disableBridge` records its actor (`primaryDisabledBy`, the hold) and stamps that actor's clock (`lastOwnerClose` or `lastGuardianClose`), with `ExitsClosed`; while either actor holds the primary, exits are not open, and an Ordinary item can be neither scheduled nor executed, a `setGuardian` only under no owner hold, a Reopen always; an item dies once its clock (both clocks for Ordinary, the owner's for the rest) reaches its scheduling second, so `schedule` refuses a clock of this second and `execute` one at or after the item's `scheduledAt` (`ExitsNotOpen`). The primary's Reopen, or `setPrimaryBridge` (now allowed only while the primary is disabled, else `PrimaryStillEnabled`), clears the hold with `ExitsReopened` and stamps nothing. `pause`/`unpause` record and stamp nothing here (the front door's; the vault overrides both as instruments, below). The lenses serve `lastOwnerClose`, `lastGuardianClose`, `primaryDisabledBy`, `ownerHold`, `guardianHold` and `exitsOpen`, through the formulas the contracts use (`CascadeFormulas`). The guardian and the owner are never one account: the constructor refuses it, `setGuardian` refuses the owner and the pending owner, and `transferOwnership` the guardian, each at `schedule` and again at `execute` (`InvalidParameter`). `stampBySig(asOf, sig)` takes the owner's EIP-712 signature of `OwnerStamp(uint64 asOf)` (domain `"Cascade"`, `"3.2"`, the chain id, the contract), relayed by any account: exactly 65 bytes, `v` 27 or 28, `s` in the lower half, recovered by `ecrecover` to the owner (no ERC-1271), else `BadStamp`; `asOf` no later than now and at most `STAMP_MAX_TTL` (1 day) old, else `StampOutOfWindow`. It moves `lastOwnerClose` to `asOf` when later, killing every item scheduled at or before it, changes nothing else, and emits `StampedBySig(asOf, relayer)` on every valid call (no nonce: a replay moves nothing). The lenses serve `STAMP_TYPEHASH`, `STAMP_MAX_TTL` and `DOMAIN_SEPARATOR`, which they recompute from the chain id and their target (the contracts hash it once, into an immutable). An owner setting that loosens a protective limit runs only as a scheduled item (the Param class, 48 hours, Ordinary: the guardian may cancel it and a close kills it), while a tightening or an equal value applies at once (`NotScheduled` for a loosening outside `execute`; a multi-field setter loosens if any field does): on the vault `setOutflowLimits` (any of its three values up), `setMessageLimits` (values up, `minChunk` down), `setFeeLimits` (up), `setPayoutDelay` (down), `setRewardCut` (the cut up, or any change of treasury), `setMaxTotalAssets` (up) and `setIdleBuffer` (down), with `moveStake(from, to, rao)` scheduled whatever its value (`to` must still be the stake hotkey at execute, else `InvalidParameter`) and `setStakeHotkey` scheduled unless it follows stake that already moved (Task 14a, below); on the front door `setMaxDeliverySlippage` (up), `setBatchInterval` (down), `setMaxBatchValue` (up) and `setMinPoolLiquidity` (down, per pool), with `setOracle` and `setSwapper` scheduled whatever their value. `setKeeper`, `setMinDirectDeposit`, `setHotkeyDustRao`, `setUnstakeMarginRao`, `setUnstakeGas`, `setClaimGasRequired`, `setCaps`, `setBatchLimits` and `setRedeemRequestFee` stay immediate, and none of them, nor any tightening, stamps a clock or records a hold. |
| `CcipBaseAdapter` | Base | The front door's bridge: sends ForeverMoney's TAO plus a `BATCH` over Chainlink CCIP, and delivers incoming tokens plus `PAYOUTS` to the front door. See [Bridge adapters](#bridge-adapters-ccip-20). |
| `CcipBittensorAdapter` | Bittensor EVM | The vault's bridge: converts between native TAO and ForeverMoney's TAO through their `AlphaVault` in the same transaction as each send and delivery. |

csTAO ("Cascade Staked TAO") has 24 decimals and cannot be transferred: `transfer`, `transferFrom`
and `approve` revert. At launch 1 csTAO is worth 1 TAO.

**For the auditor: v3.2's share token replaces an audited component.** v3.1's vault inherited
OpenZeppelin's `ERC20`; v3.2's inherits `CascadeShares` (`src/CascadeShares.sol`, about 50 lines of
code), a minimal token written for Cascade (spec §8.1). Its ERC-20 surface is `name`, `symbol`,
`decimals` (24), `balanceOf`, `totalSupply` and the `Transfer` events, plus `transfer`,
`transferFrom` and `approve` that revert `NonTransferable` and an `allowance` that returns 0, which
wallets handle better than unknown selectors. There is no allowance storage and no `Approval` event.
Every mint and burn goes through two shared helpers, `mintShares` and `burnShares` (free functions
taking a pointer to the `SharesData` struct, so the vault and, from v3.2's batch and payout
libraries, the code it delegates to update one record), each emitting `Transfer` from or to the zero
address, as OpenZeppelin's did; a burn above the balance reverts with OpenZeppelin's
`ERC20InsufficientBalance(sender, balance, needed)`, as before. **They drop OpenZeppelin's
zero-address checks** (`ERC20InvalidReceiver` on a mint, `ERC20InvalidSender` on a burn): the vault
never mints to or burns from the zero address (a delivery skips a zero user, a cancel re-mints only
the users its batch's payout hash fixed at delivery, a direct deposit or redeem is the caller's, and
the treasury is non-zero whenever the reward cut is). The token comes first in the vault's
inheritance, so `SharesData` takes storage slots 0 (`totalSupply`) and 1 (`balanceOf`) and
everything after it sits three slots lower than in v3.1 (`guardian` at 5). Invariant I-34: for every
account, its `Transfer` mints less burns equal its `balanceOf`, and their sum equals `totalSupply`
(`test/vault/VaultShares.t.sol` at unit level).

Libraries and interfaces:

- `CascadeMath`: share math with a virtual offset of 1e6 shares (the ERC-4626 defence against
  inflation attacks). Every result rounds down, in the vault's favour.
- `CascadePayoutMath`: the vault's payout math (the batch check, the chunking, the fee split), a
  linked external library that the payout engine (`CascadePayoutLib`, below) reaches by `delegatecall`,
  in the vault's context (see [Static analysis](#static-analysis)).
- `CascadeBatchLib` (L1, spec §8.1): the batch path, `onBridgeMessage`'s body after the vault's
  checks. A linked external library the vault runs by `delegatecall`, in its own context, so its
  events come from the vault's address and a direct call stops at the compiler's call guard. The
  vault checks the bridge, the pause, the peer, the value and the replay record, reads the stake, the
  price inputs and the allowance base once, and passes them in a `BatchIn`; L1 decodes the message and
  checks its sum, logs `BatchDelivered`, mints or bounces each deposit, burns each redeem within the
  front door's window and the global window all doors share (`burnWindows(bytes32(0))`, Task 17) and
  returns the payout queue, which the vault stores with its reservation and announces with
  `PayoutBatchQueued`. It holds no state, makes no external call, and writes only through its storage
  pointers (the share balances and supply, the burn windows, and the redeem origins: a door's first
  mint for an address of origin 0 sets its origin to the door's chain, Task 18). A replayed
  message whose amount is also wrong now reverts `DuplicateBatch`, not `AmountMismatch` (the replay
  check comes first). `node script/library-rules.mjs`, one of the build
  checks, holds every linked library to I-32's static rules over the library and the first-party
  helpers it compiles in, following double- and single-quoted imports: no `msg.value` or `tx.origin`,
  `msg.sender` only as L3's refund target, no `selfdestruct`, `delegatecall`, `callcode`, state
  variable, or inline assembly of any kind (R1-C F-1; OpenZeppelin's `Math` is the vendored exception);
  no TSTORE in any library, no SSTORE in L2 or the payout math, no LOG in the payout math; imports from outside first-party `src/` only from each library's allow-list (today
  OpenZeppelin's `Math`). Where a library calls is read from solc's AST, not from the source text
  (5f fix round 4): L1's own file, and L2 and L3 with everything they compile in, are compiled alone
  into a scratch directory, and every call solc types as external (an external function, with or
  without call options such as `{gas: …}`, a low-level call, `transfer` or `send`, a creation, a
  library's DELEGATECALL, a precompile, `selfdestruct`) must be one of the library's targets as solc
  resolved it. L2's is a call on `IStaking(ISTAKING_ADDRESS)`, with both names resolved by solc to
  `IStaking.sol`'s interface and its file-level constant at the precompile's address. L3's (Task 5g)
  are `quoteFee` and `send` on `PayoutIn.bridge`, the primary bridge the vault reads and passes: the
  interface's functions, on that field, on a `PayoutIn` parameter of one of L3's own external
  functions, with the field and the parameter never written anywhere in the closure (no assignment,
  `delete`, tuple component or write through another name for the same memory), and its DELEGATECALLs
  into the payout math it links, whose external functions' bodies are the payout math's own code
  (held by its bytecode rule) and skipped. L1 may make none at all. No external function may be a value there (a
  variable, a field, a parameter, a return, an array element, a conditional). Internal library
  calls, OpenZeppelin's `Math` and the builtins that call nothing (`abi.*`, `keccak256`, …) pass by
  their types, so a shadowing, spacing, a comment, parentheses or a renamed import cannot point a
  call elsewhere, and a closure that does not compile fails. L4's target is L2's, the precompile
  cast. Its write-set rule (step L4) holds L4 to exactly its set of the vault's storage (the hotkey
  list, `isHotkey`, `lastClaimAt`; never the ledger): it compiles the vault in the
  same solc run, binds each of L4's storage parameters to the vault state variable the vault's call
  sites pass (by name, never a local or an expression), traces every storage write L4 runs (its own
  and its helpers', through internal calls) to those parameters, and fails a write outside the set,
  an entry never written, or a write it cannot trace (a storage pointer local or reassignment, a
  returned pointer, a storage argument to an unresolved call). It checks the link graph (today the
  vault links `CascadeBatchLib`, `CascadeHotkeyLib`, `CascadeStakeLib` and `CascadePayoutLib`,
  `CascadePayoutLib` links `CascadePayoutMath`, and nothing else in `src/` links anything; an
  artifact that does not name its contract fails the check), and scans each library's runtime code
  for call opcodes (L1 and the payout math have none, L2 and L4 only `CALL` and `STATICCALL`, L3
  `CALL`, `STATICCALL` and `DELEGATECALL`; a library allowed one must have its targets in the call
  rule). The warning gate
  (`node script/warning-gate.mjs`, also a build check) keeps `src/` compiling with no solc warning,
  shadowings (2519, 2319) included. It compiles `src/` alone, forced, with the project's settings,
  into a scratch directory, never `out/`, and reads forge's JSON, which keeps the warnings the
  project's ignore lists would hide. Its precompile rule (fix round 1 of step L4, Task 42a's
  per-function allow-list pulled forward) pins which precompile functions the code compiled into L2
  and L4 calls, exactly (`PRECOMPILE_FUNCTIONS`; L4 never `addStake`, `claimRootWithHotkey` or
  `setRejectStakingHotkeyGrowth`), reading the code each library's external functions reach; and
  no call into a linked library may go through `using … for`, since the rules read its arguments
  positionally. The staking interface may inherit nothing (fix round 2), so the lists see every
  function a call on it can reach. L1's bytecode has no call opcode at all. Task 42a adds three: the
  Yul call rule (no code compiled into a library, vendored code included, reaches a function whose
  assembly calls out or creates, so OpenZeppelin's `Math.modExp`, a STATICCALL to the 0x05
  precompile that the assembly rule does not read, is never reached); the delegatecall rule (no
  `delegatecall` or `callcode` anywhere in first-party `src/`; the code compiled into the vault, its
  bases and the vendored code it reaches included, DELEGATECALLs only its linked libraries, on
  solc's AST; and no first-party artifact has CALLCODE, nor DELEGATECALL unless it links a
  library, in its runtime code or its creation code, where a constructor's code is); and the
  boundary coverage (every external function of each linked library in the build has its
  direct-call test; see [The library boundary](#the-library-boundary)).
- `CascadeStakeLib` (L2, spec §8.1): the unstake walk, v3.1's `_unstake` moved whole. A linked
  external library the vault runs by `delegatecall` from `redeemDirect` and `processPayouts` (the
  vault's own walk, between the payout engine's two halves; L3 neither links nor calls L2). It writes nothing: the vault hands it a `WalkParams` (a
  memory copy of the hotkey set, at most four, the stake hotkey, the coldkey, the margin, the
  shortfall tolerance and `unstakeGas`), it reads the floors (the live reads against the constant
  fallbacks, since Task 23) and the stake from the precompile itself, makes the removals, counts the
  stake each takes at face value against the request (never what the chain paid for it, Task 36b),
  stops once what is unmet is within the tolerance (1,000 rao, `SHORTFALL_TOLERANCE_RAO`; Task 19),
  and returns what was left unmet, what it received and the stake it took, which the vault books and
  from which it reckons the walk's cost (what the chain kept), the exit's to bear. Under a root hold (Task 20, spec
  §3.8) it reads each position once before the
  walk and counts those of at least the minimum stake (`positionsLeft`), then forwards each removal
  `max(unstakeGas, (gasleft - EXIT_GAS_RESERVE) / positionsLeft)` gas inside a `try`, the last one tried
  getting the rest less the 2,000,000-gas reserve the exit needs after the walk (Task 65; kept while each share
  exceeds `unstakeGas`; see the caller's gas rule under [Operator notes](#operator-notes)). A removal that fails
  for any reason (the chain's refusal of a held pair, or burning the gas it was given) is skipped with
  `UnstakeSkipped`, adds nothing to what was received, and the walk goes on to the next position; if
  what is left unmet is more than the tolerance, the vault reverts `UnstakeShort`. Its only
  call target is the staking precompile. The vault sets its unstake flag around the call, so the
  precompile's TAO enters `receive()` as in v3.1. The flag (`_unstaking`) is a transient state
  variable: set and cleared within the transaction, it takes no storage slot, and transient storage is
  per address, so `receive()` reads it while L2 runs in the vault's context. `removeHotkey` keeps its
  direct removal in the vault (a refusal reverts the call rather than being skipped).
- `CascadePayoutLib` (L3, spec §8.1, Task 5g): the payout engine, v3.1's `processPayouts` and
  `cancelPayoutBatch` after the vault's own checks, moved whole. A linked external library the vault
  runs by `delegatecall`, so its events come from the vault's address and a direct call stops at the
  compiler's call guard. The vault keeps the pause, the lock and the owner check, reads what the engine
  needs into a `PayoutIn` (the batch and the reservation as memory copies, the primary bridge and
  whether it is enabled, whether the batch's front door is active, whether the caller is the keeper,
  the call's value, the limits) and runs a payout in two halves around the walk, because the unstake
  flag is a transient vault variable no library can set and must never be set across a bridge call: L3's
  `prepare` makes v3.1's checks in v3.1's order (the batch, the list, the delay, the door, the primary
  bridge), takes the chunk, quotes the fee and runs the fee valve (the entries' share under the
  ceiling, the caller's top-up; Task 21), logs the dust and returns a `PayoutPlan` (what is sent, the
  fee, the shortfall, the refund, the message, the liquidity read before the walk and the dust count)
  without writing anything; the vault unstakes the shortfall plus 1,000 rao through L2 under its flag
  (the shortfall rule, under [Payout leg](#payout-leg-bittensor-to-base)) and hands `finish` what the
  walk received and its cost; L3's `finish` splits the cost over the entries with the fee's share when
  the walk cost anything (`FeeTooHigh` if that leaves an entry nothing), checks that the liquidity
  and the receipts fund what is sent (`UnstakeShort` otherwise), releases the reservation, advances
  or deletes the batch, then sends net + fee to the bridge, then logs `PayoutChunkSent`, then refunds
  the caller the rest of its value. v3.1's order of checks, effects, external calls and events holds
  (`PayoutLibBoundary.t.sol` pins it, a re-entering bridge included), and the refund comes after all
  of it: the library rules hold it to `finish`'s last statement, and
  `test_reentrantCallerRefusedAtTheRefund` (`VaultPayouts.t.sol`) shows a caller re-entering from it
  refused by the lock. `PayoutChunkSent` logs the fee the bridge was paid, the part the entries were
  `charged` and the walk's cost they bore (`unstakeCost`, Task 36b). `cancel` re-mints each entry the value it was owed at the price the vault
  passes in (its `totalAssets()`, read before anything is released, over the supply), never more
  shares than it burned (Task 34c), releases, and returns the batch's source chain for Task 10's
  launch-door stamp. L3 calls only the bridge the vault passes, the vault's caller for its refund
  (value only, empty calldata, `finish`'s last statement: the library rules' refund target) and, by
  `delegatecall`, `CascadePayoutMath`; it reads `msg.sender` only as the refund's target, and never
  `msg.value` (the vault passes it in `PayoutIn.value`).
- `CascadeHotkeyLib` (L4, spec §8.1, the reserve lever, step L4): hotkey management, the bodies of
  `addHotkey`, `removeHotkey` and `moveStake` after the vault's role reads, moved whole with no
  behaviour change: the permissionless way back (`NotEligible`), the reserved last slot
  (`SlotReserved`), the three removal paths and their authorization, the owner's leftover handling
  (moved to the stake hotkey, or below the minimum removed into balance by the direct removal, whose
  two measurements it returns for the vault to book as a walk's), `moveStake`'s checks and move, the
  list's swap-and-pop, `isHotkey` and `lastClaimAt`; the constructor lists its first hotkey through it
  as a privileged add. A linked external library the vault runs by `delegatecall`, so its events
  (`HotkeyAdded`, `HotkeyRemoved`, `StakeMoved`, `Unstaked`) come from the vault's address in v3.1's
  order. It writes exactly the hotkey list, `isHotkey` and `lastClaimAt` through the storage pointers
  the vault passes (never the ledger: the vault books the removal, `CascadeLedger.applyWalk`), calls
  only the staking precompile, and reads neither `msg.sender` nor `msg.value`: the vault reads the
  roles (`privileged` for an add; `byOwner` and `byKeeperOrGuardian` for a removal) and passes them
  with what L4 cannot read (the coldkey, the stake hotkey, the booked stake, the dust allowance); it
  reads the staking floor itself, against the constant fallback (Task 23). L4 reads the stake guard
  as the vault does, and only where the vault read it. The vault keeps the entry points, `moveStake`'s
  schedule check, `setStakeHotkey` and `claimRewards`, and sets its transient unstake flag around the
  owner's `remove` call, the only one that can unstake.
- `CascadeLedger`: the ledger's shared internal helpers, compiled into each user: `removalMeasured`, the
  two measurements of a removal that went through (the wei the balance received and the rao that left
  the position) and its `Unstaked` event (L2's walk and `removeHotkey`'s direct removal, in L4), whose
  `wantRao` is the whole position on a full removal and the request on a partial one (R2 F2);
  `removalDebit`, the direct removal that reverts on the chain's refusal and is measured so (L4's); and
  `applyWalk`, the ledger after an unstake (the stake that left off the booked stake, the receipt off
  the ramping stake, each floored). The vault's `pendingPayouts`, `bookedStake` and `rampingStake` are
  the `Ledger` struct's `pending`, `booked` (in rao since Task 12, moved only by stake-side
  measurements, `adoptStake` and the owner's write-off; spec §3.1) and `ramping` (`CascadeTypes.sol`);
  the lens serves `pending` as
  `pendingPayouts()`, `booked` as `bookedStake()` and `ramping` as `rampingStake()` (in wei, R2 F4, so
  the outflow base can be computed from the lens alone), and `VaultInternals` exposes the transient flag
  under v3.1's name.
- `CascadeFormulas`: every value the vault derives that its lens also computes (the priced stake,
  min(visible, booked), gross and total assets, unvested rewards (one drip's; the vault and the lens
  each sum the claim schedule's and the adoption drip's, Revision 27), the missing tolerance, the unlisted
  stake, the staking floors with their fallbacks, the peer id and the batch key, and `sub0`, a
  subtraction floored at 0, unchecked since it subtracts only when it cannot underflow),
  written once as internal functions over plain values and compiled into both, so the vault and its
  lens can differ only in the raw reads (spec §8.1).
- `CascadeMessages`: the two bridge messages. `BATCH` goes from a front door to the vault (batch
  id, deposits, redeem requests). `PAYOUTS` goes back (batch key, chunk number, payouts). At most
  50 entries per list (`MAX_ENTRIES`; 100 before v3.2's Task 18, when a first deposit began writing its
  redeem origin: at 50 + 50 every legal message fits the 7,000,000 gas cap).
- `ICascadeBridge` / `ICascadeReceiver`: the adapter interface (`send` and `quoteFee` out,
  `onBridgeMessage` in).
- `IStaking` (the staking precompile at `0x…0805`) and `IAddressMapping` (`0x…080c`, used once in
  the vault's constructor to derive its own coldkey, and once in the vault lens's).
- `IExtsload`: what a lens calls on its target, `extsload(bytes32)`.
- `IAlphaVault`: ForeverMoney's `depositLiquid` and `withdrawLiquid`, which the Bittensor adapter
  calls, plus four views the tests read.
- `src/vendor/ccip`: three files from Chainlink's `@chainlink/contracts-ccip@2.0.0` (the message
  structs, the Router interface and the receiver interface), copied byte-for-byte; `VENDOR.md`
  records the package, its integrity hash and the one changed import path.

Shared layout files, each declaration made once at file level and imported by name:

- `CascadeTypes.sol`: the structs the vault shares with its libraries and (from v3.2's lens) its
  readers: `SharesData`, `PayoutBatch` and `Window`; `BatchIn`, L1's argument, which only travels
  in memory; and the enums they share (`BounceReason`, `DepositBounced`'s reason, among them).
- `CascadeShares.sol`: the share token (above) and its `mintShares` and `burnShares` helpers.
- `CascadeConstants.sol`: the constants they share (`RAO`, `NETUID_ROOT`, `ED_RESERVE`,
  `KEEPER_FALLBACK`, `MAX_REWARD_CUT_BPS`, `REGISTRY_DELAY`, `GUARDIAN_DELAY`,
  `STAMP_TYPEHASH`, `STAMP_MAX_TTL`, and those L1 applies, `MIN_REDEEM_VALUE`, `GLOBAL_WINDOW` and
  `DIRECT_ORIGIN`),
  which the lenses serve from here; `CascadeBase` and the vault hold theirs as internal constants
  under the same names.
- `CascadeErrors.sol` and `CascadeEvents.sol`: every custom error and event of `CascadeBase`,
  `CascadeVault` and the vault's libraries. The front door, the adapters and the staker keep their
  own. The vault's `LimitSet(bytes4 indexed selector, uint256 a, uint256 b)` is keyed by the setter's
  selector; `setMessageLimits`, with three values, emits two under its selector, `(maxEntryValue,
  maxMessageValue)` then `(minChunk, 0)`; `setOutflowLimits`, with three, logs
  `OutflowLimitsSet(bps, minDaily, globalBps)` instead (Task 17). The front door keeps its own
  `LimitSet(bytes32 indexed name, …)`.
- `src/lens/generated/VaultLayout.sol` and `DoorLayout.sol`: where the vault and the front door
  keep each state variable (`SLOT_<VAR>`, `OFFSET_<VAR>`, `SIZE_<VAR>`) and each member of the
  shared structs (`<STRUCT>_<MEMBER>_SLOT`, `_OFFSET`, `_SIZE`), for the lenses that read them
  through `extsload` (spec §8.1). `node script/gen-lens-layout.mjs` generates them from the storage
  layout in the build (`extra_output = ["storageLayout"]` in `foundry.toml`); they are committed, and
  the build checks fail on any byte of difference from a fresh generation.
- `abi/CascadeVault.json`: the published vault ABI, the one ops, the indexer and the web decode
  with. An error or event only a library emits is in that library's artifact, not the vault's, yet
  comes from the vault's address, so `node script/merge-abi.mjs` merges the vault artifact's ABI
  with every event and error of each library it links (followed through the link references),
  de-duplicated and sorted by type, name and signature. It is generated and committed; the build
  checks fail when it is stale.

The read-only lenses (`src/lens/`, spec §8.1), one per target, each built with only its target's
address, holding no state and having only views; a lens bug shows wrong numbers, never moves funds,
and a lens can be redeployed without its target:

- `CascadeVaultLens` (Bittensor): every view of the vault's read surface, under its getter's name,
  arguments and return type, `CascadeBase`'s included (92 views: its state, `lastAdoptAt`,
  `rampingStake` and the adoption drip's three fields, Revision 27, among it,
  constants, `coldkey` and the computed views `price`,
  `totalAssets`, `grossAssets`, `unvestedRewards`, `visibleStakeRao`, `bookedStake`, `missingStakeRao`,
  `surplusStakeRao`, `stakeMissing`, `unlistedStakeRao`, `minStakeRao`, `minRemainRao`,
  `hotkeyCount`, `getPayoutBatch`, `peerId`, `batchKey`, `ownerHold`, `guardianHold`, `exitsOpen`,
  `DOMAIN_SEPARATOR`; the vault's holds count all three records: `primaryDisabledBy`, `pausedBy`,
  `launchDoorRemovedBy`), plus
  `totalSupply` and `balanceOf`. `burnWindows(peer)` serves the window as of now (R2 F4), through the
  rule the batch path burns against (`CascadeFormulas.currentWindow`): one 24 hours past its start, or
  never written, reads as a fresh window opening now with nothing burned. It reads
  the vault's storage through `extsload` at the generated slots, computes through `CascadeFormulas`,
  reads the stake from the staking precompile as the vault does, and derives the vault's `coldkey`
  from its address through the address-mapping precompile, as the vault's constructor does.
  `hotkeys(i)` past the end reverts without data, as the vault's getter did.
- `CascadeDoorLens` (any chain): `CascadeBase`'s getters (the exits machine's holds and `exitsOpen`,
  the stamp's constants and `DOMAIN_SEPARATOR` among them) and the front door's `keeper`. It calls
  nothing but the front door's `extsload`. The front door keeps all of its own getters (`asset`,
  `usdc` and `oracle` above all, which on-chain callers read), `keeper` among them.
- `CascadeBaseLens`: their shared part (the target, the reads, `CascadeBase`'s getters, each lens
  locating them from its own generated constants).

Since v3.2's Task 5d, `CascadeBase`'s getters are internal on both targets, and the vault's own are
too, but for the share token's `totalSupply` and `balanceOf`: only the lenses serve them. The lens
parity tests
(`test/lens/LensParity.t.sol`, I-33) call every lens view over the fixture's states and compare its
return bytes, reverts included, with `exposed_<view>` on a test-only subclass that reads the value
inside the target (`test/utils/VaultInternals.sol`, `DoorInternals.sol`), and with the target's own
getter where it still has one (the vault's `totalSupply` and `balanceOf`, the front door's `keeper`);
where it has none, they check the target's call reverts.
`node script/lens-surface.mjs`, one of the build checks, fails unless each lens serves every state
variable and getter of its target with the target's types (and a state variable's view with the
types its declaration gives, the anchor once the getter is gone), each view has its exposure, the
parity tests' view lists (`test/utils/LensViews.sol`) equal the lenses' ABIs, neither target has a
getter of `CascadeBase`'s, the vault has no view beyond its kept list, and each test-only subclass
has exactly its target's storage layout
(label, slot, offset and type), so it adds no storage. A missing artifact or storage layout fails
the check.

There are no proxies and no arbitrary external calls; the only `delegatecall`s are the vault's to its
fixed, linked libraries, `CascadeBatchLib`, `CascadeStakeLib`, `CascadePayoutLib` and
`CascadeHotkeyLib`, and
`CascadePayoutLib`'s to `CascadePayoutMath`, all run in the vault's context. Value leaves the vault in
only two ways: a payout chunk sent through the primary bridge, and a direct redeem paid to the share
owner.

### What adapters must honour

The vault and the front door never see CCIP or ForeverMoney. A Bittensor adapter sits between CCIP
and the vault, and a Base adapter between CCIP and the front door. They are the parts designed to be
replaced, because every outside change (ForeverMoney's token, Chainlink's lane, a Bittensor runtime
upgrade) lands there. An adapter must:

- **Be immutable.** No admin and no upgrade path. Its router, remote adapter and ForeverMoney
  contract are constructor constants. Any change is a new adapter that goes through the 7-day
  registry. Otherwise the adapter's own admin would bypass the delay, and because any enabled
  adapter may present any registered front door, the weakest adapter would set the security level
  for every front door.
- **Report the true source.** The receivers trust the `(sourceChain, sender)` pair the adapter
  passes in. The adapter verifies it against CCIP before calling `onBridgeMessage`.
- **Keep the fee-budget rule.** Accept any `send` whose budget covers the real fee, keep the excess,
  and never send value back to the caller (the vault's `receive()` would reject it).
- **Inbound (Base to vault):** receive ForeverMoney's token plus the `BATCH` data, convert the token
  to native TAO, then call `vault.onBridgeMessage{value: amount}(...)` with `amount` equal to the sum
  of the deposits. Preferred: conversion through a ForeverMoney function in the same transaction.
  Fallback, if ForeverMoney only offers asynchronous "liquid delivery" to an address: the adapter
  owns that address, holds the data as "awaiting funds", and calls the vault only once its own
  balance covers the batch. Either way the vault's `msg.value == amount` rule holds and the
  fragility stays in the adapter.
- **Outbound (vault to front door):** receive native TAO plus `PAYOUTS` data from
  `processPayouts`, convert through ForeverMoney's gateway, and deliver token plus data to the front
  door. If the gateway cannot carry data, send the data as a separate CCIP message. The front door's
  `TokensNotReceived` check makes that safe: the data message fails until the tokens are there, then
  anyone re-executes it. In that fallback the token check is pooled across chunks, so a chunk whose
  tokens the rail loses makes the *last* chunk's data fail, not its own.
- **Enforce the lane's limits before sending:** at most 5,000 TAO per message (ForeverMoney's pool
  rate limit, refilling at 0.6 TAO/s and shared with every ForeverMoney user; each adapter is
  deployed with its own lower cap, `maxMessageValue`), at most 32,000 bytes
  of data, and a delivery gas budget within about 7.2M on Bittensor and about 13M on Base. The
  contracts' defaults are set to stay under these: 4,000 TAO per batch and per payout chunk, and at
  most 50 entries in any list (50 + 50 per batch, the hard bound since Task 18).

The adapters in this build take the preferred path in both directions: ForeverMoney's `AlphaVault`
converts in the same transaction (`withdrawLiquid` inbound, `depositLiquid` outbound; permissionless
and exactly 1:1, per `docs/forevermoney-probe.md`), and each CCIP message carries the tokens and the
data together. The fallbacks above are not built. How they meet each rule:
[Bridge adapters (CCIP 2.0)](#bridge-adapters-ccip-20).

### Bridge adapters (CCIP 2.0)

Two immutable adapters sit between Chainlink CCIP and the vault and front door, which see only
`ICascadeBridge` / `ICascadeReceiver` and run unchanged from the `MockBridge` build. Both lanes run
the CCIP 2.0.0 execution model (`OnRamp 2.0.0`, `OffRamp 2.0.0`, `Router 1.2.0`).

| Adapter | Sends | Delivers |
|---|---|---|
| `CcipBaseAdapter` (Base) | pulls exactly `amount` of ForeverMoney's TAO from the caller (the front door), approves the Router, sends tokens plus `BATCH`, resets the approval | transfers the tokens to the recipient, then calls its `onBridgeMessage` with no value |
| `CcipBittensorAdapter` (Bittensor EVM) | turns `amount` of the caller's (the vault's) native TAO into ForeverMoney's TAO with `AlphaVault.depositLiquid(token, amount / 1 rao - 1)` (ForeverMoney checks the stake it measured against that and refuses a mint more than 1 rao short itself, `Slippage`; then the mint must be at least `amount - 1 rao` and the token balance must still cover the token parks plus `amount`, the token cushion paying any shortfall, else `ConversionShort`; v3.2, Task 28, and R3, below), then sends exactly `amount` of tokens plus `PAYOUTS` | turns the tokens back with `AlphaVault.withdrawLiquid(token, amount, amount - 1 rao)` in its self-only `convertExact` (ForeverMoney checks the TAO it measured against that and refuses a payment more than 1 rao short itself, `Slippage`; then the native balance must grow by at least `amount - 1 rao` and still cover the native parks plus `amount`, else `ConversionShort`, which on the live rail means the reserve is empty), then calls `onBridgeMessage{value: amount}`; a batch it cannot convert or deliver is parked (v3.2, Task 25, below) |

Both inherit `CcipAdapterBase`: the Router and sender checks, ERC-165, the payload, gas sizing,
the fee rule and (v3.2, Task 24) the one path to the Router, `_ccipSend`, which never collects:
`send` runs its checks, collects and then calls it, and the Bittensor adapter's `refundParked`
calls it too. It makes no amount check of its own: `send` makes send's two, the per-message cap
and the side's minimum (`_checkAmount`), before it collects, and a refund makes neither, so no
floor or cap can trap one (spec §3.2, I-10; v3.2 Task 27 removed the `checkAmount` flag that Task
24 gave it for this, since no caller passed true).

- **Immutables only.** `router`, `token` (ForeverMoney's TAO on that chain), `localChainId`,
  `remoteChainId`, `remoteSelector`, `remoteAdapter` (the only CCIP sender a delivery accepts), and
  the gas model `gasBase` and `gasPerEntry`, the per-message cap `maxMessageValue`, and (v3.2)
  `treasury`, the one payee of a sweep; plus `minSendAmount` on Base and `alphaVault` on
  Bittensor. No owner, pause, upgrade or rescue function, and no stored balance anyone can
  withdraw: a sweep pays only the immutable treasury. A change is a new adapter through the
  7-day bridge registry. The constructor rejects zero addresses (the treasury's too), equal
  chain ids, a gas model whose largest message does not fit the cap, a zero `remoteSelector` or a
  gas model of 0 and 0 (`InvalidParameter`, since R3), a `maxMessageValue` of 0 or above 5,000
  TAO, and (Base) a `minSendAmount` above `maxMessageValue`.
- **A pipe, not a peer.** The CCIP data is `abi.encode(recipient, sender, message)`: who called
  `send` and who should receive. A delivery checks that the message came from the Router, from
  `remoteSelector` and from `remoteAdapter` (exactly 32 bytes), and carries at most one token, ours.
  Whether that sender and recipient are registered peers is the vault's and the front door's
  decision, as with `MockBridge`. This is what lets one adapter pair serve an old and a new front
  door during a migration (the vault pays every front door through its one primary bridge).
  Anyone may call `send`; a caller that names a recipient that rejects the delivery strands only
  its own tokens. Since Task 25 the Bittensor adapter delivers only a well-formed `BATCH` whose
  deposits sum to the tokens it carries, and parks a refused one under that batch's own record.
- **Tokens and data in one transaction.** The OffRamp releases or mints the tokens and calls
  `ccipReceive` in one call, so any revert undoes the token transfer too and marks the message
  `FAILURE`. On Base that is every failure of the front door's delivery. On Bittensor, since v3.2
  (Task 25), a ForeverMoney pause, a raised staking floor, a short conversion, a paused vault, a
  missing stake or a recipient out of gas no longer revert: the adapter parks the batch (below).
  What still reverts there is a malformed batch, a batch already parked (`AlreadyParked`), books
  that do not cover a token park (`ReserveShort`), a recipient with no code, a recipient or its
  conversion refused with `ReentrancyGuardReentrantCall` (a lock held around a stranger's code: the
  vault's, or, since R3's fix round 2, ForeverMoney's AlphaVault's around `withdrawLiquid`'s
  payment; free again once the transaction holding it ends, so since R3 the adapter reverts rather
  than park, see Parking; a recipient that re-enters the adapter and bubbles the adapter's own
  refusal fails every execution, which harms only its own batch), and a delivery given too little
  gas to write the park. Those reach `ccipReceive` and revert there. Two causes come before
  `ccipReceive` on either lane, where Bittensor's parking cannot catch them (R3, CC-L2, CC-L4): the
  destination pool's inbound rate limit (enabled on both pools at the same 5,000 TAO and 0.6 TAO/s
  as outbound, so a burst of messages, or Chainlink's executor catching up after an outage, can
  fail a delivery inside the pool's `releaseOrMint`), and a stranger's attempt: anyone may execute
  any `UNTOUCHED` message first, and can move it to `FAILURE` with junk `verifierResults` or too
  little transaction gas. A stranger executing it from inside a lock (the Bittensor adapter's
  around `deliverParked`'s recipient call; on Base, the front door's around `closeBatch`'s refund;
  the vault's and ForeverMoney's, above) reaches `ccipReceive` and fails there (note 22). Each
  writes nothing, and re-execution delivers the message exactly once. CCIP calls a
  receiver only if it answers ERC-165 for `IAny2EVMMessageReceiver`, otherwise it delivers the
  tokens alone; the adapters answer it, and answer false for the V2 interface so the lane's default
  verifiers and "wait for finality" apply.
- **Manual re-execution.** On CCIP 2.0, `OffRamp.execute(encodedMessage, ccvs, verifierResults,
  gasLimitOverride)` is permissionless: anyone can execute a message in `FAILURE` again at any time,
  with no expiry, and `gasLimitOverride` can raise (never lower: a lower non-zero value reverts
  before anything is written) the receiver gas. This is the retry path for every failure above that
  still reverts (on Bittensor, since Task 25, most failures park instead). Every execution needs the
  default committee's `verifierResults` (signatures), which only Chainlink's verifier infrastructure
  produces, and the deployed OffRamp 2.0.0 checks them every time: re-executing a `FAILURE` needs
  them too (Task 52's review; R3's CC-L3 reading, that a `FAILURE` needs none, was wrong). At launch
  the keeper never re-executes on its own: it reports the `FAILURE`. The founder runs
  `pnpm ops reexec <messageId>`, which (runbook section 6) takes the committee's results from the first source that has them: `--proof` (a file, the CCIP API's answer saved, or another `execute`'s calldata), `--from-tx` (another attempt's transaction), the attempt that wrote the `FAILURE` (its public calldata, unless it carried none, as a stranger's empty proof does), then Chainlink's CCIP API (`execution-inputs`, checked against the rebuilt message); it simulates first and sends nothing when none has them (wait: Chainlink's docs say its executor retries a `FAILURE` for up to 8 hours). Automatic re-execution
  stays off until the founder turns it on after the rehearsals (checklist item 27); until then a
  failed message's tokens stay locked in the bridge, and nothing is lost. A `SUCCESS` is never
  executed again, by anyone, with any override; a `FAILURE` writes nothing (the token release and
  `ccipReceive` share one frame that reverts whole). The adapters
  store no message ids: CCIP executes a message successfully at most once, and the vault and front
  door reject a repeated delivery as a duplicate.
- **Fee rule.** Fees are paid in the native coin (ETH on Base, TAO on Bittensor) and do not depend
  on the amount. `quoteFee` prices exactly the message `send` builds (same payload length, same gas
  limit, a token entry only when `amount > 0`), so the quote is the fee paid. `send` needs
  `msg.value >= fee` on Base and `msg.value >= amount + fee` on Bittensor (`InsufficientFee`), pays
  the Router exactly the fee, keeps any excess and never sends value back.
- **Gas sizing.** The delivery gas limit is `min(gasBase + entries × gasPerEntry, 7,000,000)`
  (`GAS_CAP`), with `entries` read from the message's length (both message kinds have a fixed size
  per entry); a message of neither shape gets the cap. The deployment values, calibrated in
  `test/adapters/AdapterGas.t.sol` with at least 15% headroom, are, for v3.2 (Task 18, measured cold;
  recalibrated at R4 on a real clock, where a day's first burn writes both windows' starts, with R4's
  reads; set by the R4 review to include `PARK_GAS_RESERVE`, which `ccipReceive` keeps back from the
  recipient's call), `gasBase` 1,300,000 and `gasPerEntry` 57,000 toward Bittensor (Base adapter, and the
  Bittensor adapter's inbound pair; at least 221,000 of slack at every measured point, 50+1 the least;
  Task 61 kept it on the fork's figures, below) and 180,000 and 32,000 toward Base (Bittensor adapter;
  140,000 and 29,900 until Task 65 raised them, the T61a review's I-2, erring high on the thinnest margin);
  the constructor's check over the largest legal message, 2 × `MAX_ENTRIES` = 100 entries, gives
  exactly 7,000,000 and 3,380,000, both within the cap (v3-launch runs
  780,000 / 31,100 and its own Base-side figures, in ops). They are constructor arguments, so a tune is a
  redeploy, not a code change. A delivery that
  still runs short fails and is re-executed with `gasLimitOverride` (on Bittensor, one that runs
  short inside the conversion or the vault parks instead); nothing is lost. The
  Bittensor-side figures rest on mock-precompile measurements plus a 300,000-gas allowance, and a
  message that carries tokens also carries the real AlphaVault's extra cost over the mock (52,844 gas,
  from the fork measurement of the 1-deposit point, 187,450). A delivery's first redeem writes a payout
  batch and starts its burn windows, a fixed cost a deposit does not pay, and since Task 18 a new
  depositor's first mint also writes its redeem origin (about 22,500 mock gas, 25,800 of need), so a
  deposit climbs about 57,500 of need against about 17,000 for a further redeem. With the per-entry
  figure on that climb the binding point is 1+1: it needs 823,791 of 896,000, 72,209 gas of slack (then
  10+1 76,476, 25+1 83,483, 40+1 90,365, 50+1 94,882; 50+50 needs 4,425,915 of 6,580,000).
  Since Task 25 the Bittensor adapter's own delivery work (the lock, the batch's decode and sum,
  the park key, the self-call into `convertExact`) adds about 19,000 of need at 1+1 and 46,000 at
  50+1. At R3 (`AdapterGas.t.sol`, 2026-11-05) the model's slack over its own need is 50+1 45,752
  (it binds there), 40+1 46,933, 25+1 48,526, 10+1 49,910, 1+1 50,637; 50+50 has 2,086,455. The
  150,000 of `PARK_GAS_RESERVE` the adapter keeps back from the vault's call was not in that model
  (since the R4 review the launch pair includes it, above), and it ate most of the margin (R3, A-L1): a delivery lands only when its gas limit covers
  the real cost plus the reserve, and measured by bisection over the mocks, the headroom left over
  the model's own central estimate is 25,106 gas at 1+1 (about 2.8% of its 896,000; then 0+1
  111,560, 1+0 144,237, 10+1 92,818, 25+1 205,583, 50+1 393,288), and 8,543 at 1+1 with four
  hotkeys listed (each listed hotkey is one more `getStake` per delivery, about 5,500 mock gas;
  a stranger can list the last slot while stake is missing). So 1+1, not 50+1, binds once the
  reserve is counted. A delivery whose real cost runs over that headroom parks its native TAO
  instead of failing (CCIP `SUCCESS`; it is then delivered with `deliverParked`, Task 26): never a
  loss, but small batches with a redeem would park systematically if the live precompile and
  AlphaVault costs exceed the allowance by that much. Since the R4 review the pair includes the
  reserve, and Task 61 (2026-11-14, at 077e73f, Revisions 27 and 28 in place) re-measured it. Over the
  mocks every point's need rose about 7,800 with deposits and 5,300 redeem-only since R4 (Revision 27's
  two more cold slots on every pricing path, its review's M-2), leaving 50+1 221,446 of slack, the least
  (then 40+1 243,829, 25+1 277,191, 10+1 310,302, 1+1 330,048). By A-L1's bisection, the least limit at
  which a batch reaches the vault rather than parking, through the real OffRamp, LockRelease pool and
  AlphaVault on a fork (`BittensorForkV32`): 1+0 412,658, 0+1 485,109, 1+1 630,009 (with four hotkeys
  listed 651,831, a few thousand a hotkey), 10+1 1,092,973, 50+1 3,151,413, 50+50 3,857,298; with the
  300,000 allowance and the 15% rule on them, the launch pair keeps 260,376 at 50+1, the least, 366,990
  at 1+1, 341,895 at 1+1 with four hotkeys, and a 1+1 batch at exactly the pair's limit delivers with one
  hotkey and with four. So 1,300,000 / 57,000 stands, and the batch limits stay 50 + 50: the largest
  legal batch needs about 4.2M of the pair's 7.0M (the pair itself is exactly `GAS_CAP` at 100 entries,
  by construction). The real AlphaVault costs about 7,800 gas less than the mock (1+0), so the mock
  calibration's carry for it (+10,009) errs high. Toward Base, through the real OffRamp and FM-TAO into a real front door
  (`BaseForkV32`, R3 TH-5): 1, 25 and 50 payouts and a 50-deposit refund land at 123,203, 733,964,
  1,370,340 and 1,370,340 on a door that never closed a batch, which the 140,000 / 29,900 model covered with
  15% and 28,217, 43,442, 59,109 and 59,109 to spare. The live door's last write changes a non-zero
  `netForwarded`, 2,800 gas more at every point, so since Task 65 the test counts it (126,003, 736,764,
  1,373,140 and 1,373,140 at block 57,607,777), and the 180,000 / 32,000 launch pair covers them with 15%
  and 67,097, 132,722, 200,889 and 200,889 to spare (one payout: 43% over its need).
  `AdapterGas.t.sol` checks 1+0, 0+1, 1+1 to 1+10, 2+2, 0+5, 0+50, 10+0, 10+1, 25+0, 25+1, 25+25,
  40+1, 50+0, 50+1, 50+2, 50+5, 50+10 and 50+50, each measured cold (as on chain), and logs each
  one's slack: every legal shape is covered. A 100 + 100 batch of new depositors would need about
  8.1M, past the cap under any model, which is why `MAX_ENTRIES` is 50. The first calibration,
  540,000 and 26,450, fell short at every small batch with a redeem (1+1 needed 756,075 of 592,900)
  and at every deposit-heavy one (50+1: 2,361,591 of 1,888,950). Real-precompile
  delivery gas is unmeasured until the first live batch, which should therefore be the single-entry
  batch of the checklist (item 28), with the re-execution path ready (`pnpm ops reexec`, which takes the
  committee's results from `--proof`, `--from-tx`, the failed attempt or Chainlink's CCIP API, runbook section 6;
  checklist item 27).
- **Send limits.** At most `maxMessageValue` per message (`MessageTooLarge`), a constructor
  argument at most `MAX_MESSAGE_VALUE`, 5,000 TAO, the pools' bucket capacity. Deploy it near the
  real sizes: the Base adapter's must be at least the front door's `maxBatchValue` (a batch above it
  cannot close), and the Bittensor adapter's at least the largest payout entry, which is the larger
  of the vault's `maxMessageValue` and the front door's `maxBatchValue` (a bounced deposit can be a
  whole batch). An entry above the Bittensor adapter's cap can never be sent, and a cancel cannot
  clear a bounced deposit (it carries it forward, still owed: note 7), so raising those limits past
  the caps needs new adapters (7 days) first. Deliveries are not checked against the cap. The
  adapters do not read the pools' rate-limit bucket: a short bucket makes `ccipSend` revert, so `closeBatch` or
  `processPayouts` reverts and the batch waits.
- **The reserve and the cushion.** The Bittensor adapter's `receive()` accepts TAO only from the
  `AlphaVault` (the `withdrawLiquid` proceeds), so TAO sent to it by mistake bounces. `fundReserve()`
  adds TAO the adapter keeps, except that a delivery's conversion paying at most 1 rao short
  (`SHORTFALL_TOLERANCE_WEI`, v3.2) is covered from it, never from parked TAO. Bittensor EVM
  reports a balance net of the chain's 500-rao existential deposit, so an adapter that holds
  nothing sees every incoming conversion 500 rao short, past the tolerance: on v3.1 every delivery
  reverted `ConversionShort` (re-executable once funded; the live simulation shows both cases), and
  since Task 25 every such batch parks as tokens until it is delivered (Task 26). The deployer funds
  the reserve through `fundReserve()` before the first delivery (1e12 wei is enough to deliver;
  v3.2's deploy funds `RESERVE_TARGET`, 0.001 TAO). The send side has the same 1-rao tolerance
  (v3.2, Task 28, spec §3.3): `_collect`, which every conversion of native TAO into the token runs
  (`send`, so every payout chunk, and a converted refund), accepts a `depositLiquid` mint of at least
  `amount - 1 rao`, a larger one included, provided the token balance then still covers
  `parkedTokens + amount`. ForeverMoney's deployed `depositLiquid` checks the stake it measured
  against its `minAlphaRao`, so since R3 (B-1) `_collect` passes `amount / 1 rao - 1`: before that
  a stake 1 rao short reverted `Slippage` inside ForeverMoney and the tolerance could not fire. So a
  short mint is made up from the token cushion, never from a token park, the send still carries its
  whole `amount`, and `ShortfallCovered(amount)` logs what the cushion paid; a mint short by more
  is refused inside ForeverMoney (`Slippage`), and one 1 rao short that the cushion cannot cover
  reverts `ConversionShort` (on v3.1 any mint but exactly `amount` reverted, stalling the payout
  chunk). Root staking is 1:1 on today's chain (the probe's simulation minted exactly), so this
  covers a rounding not yet observed. Since R4 (F-1) the cushion is booked: `tokenCushion`, what
  `fundCushion(amount)` pulled in (approve it first; `CushionFunded`) less what covered a short mint;
  the deployer funds it with `fundCushion` of 0.001 FM-TAO (`TOKEN_RESERVE_TARGET`), and a plain
  transfer is surplus, the sweep's. The books tell cushion from surplus, never the balance, so no
  delivery, park function or sweep spends the cushion, and a forged amount takes at most unswept
  surplus. With it empty, a payout chunk or a converted refund that ForeverMoney mints short reverts
  until `fundCushion` tops it up (nothing is lost; the keeper retries), while parking never depends
  on it. Since R4 (F-3) `convertExact` also refuses a conversion that burned more than its amount of
  the adapter's tokens (an under-burn is surplus). A withdraw's surplus, a
  deposit's over-mint and any kept fee excess stay in the adapter until the sweep (below); the
  reserve, the cushion, any such surplus and the parks are what the Bittensor adapter holds at rest.
- **Parking (v3.2, Task 25, spec §3.2).** A batch the Bittensor adapter cannot convert, or whose
  recipient refuses it, is kept under a record instead of failing the CCIP message, whose
  re-execution would fail again for as long as the cause lasts (a permanent one, such as a
  ForeverMoney migration, would strand it). `parked(key)` is `(amount, parkedAt, converted)`, the
  key `keccak256(abi.encode(remoteChainId, sender, recipient, message))`; `parkedNative` and
  `parkedTokens` are the totals the adapter owes (it always holds at least each). `_deliver`, under
  the adapter's one `nonReentrant` lock, in order: (1) the `BATCH` decodes, its deposits sum to the
  tokens carried (`AmountMismatch`) and the amount is whole rao (`NotRaoAligned`), else the message
  reverts; (2) the batch is not parked already (`AlreadyParked`); (3) unless the batch carries no
  tokens (a redeem-only batch needs no conversion), the self-only `convertExact` runs with all the
  gas but `PARK_GAS_RESERVE` (150,000; the park's write after a failure that burned all its gas
  measured at most 59,344 at Task 61, with no precompile after the failure): it reads the staking floor (`BelowConversionFloor`) and converts, and its failure, a
  failing floor read or an out-of-gas included, rolls ForeverMoney's burn back and parks the tokens
  (`converted` false), provided the
  token balance covers `parkedTokens + amount` (else `ReserveShort`: only wrong books fail it). On
  the live rail a conversion paid more than 1 rao short fails inside ForeverMoney, whose
  `withdrawLiquid` checks the TAO it measured (`Slippage`, R3 FM-L1), and one paid at most 1 rao
  short with the reserve empty fails the adapter's `ConversionShort`; either parks the tokens, with
  that reason, and ForeverMoney's halt parks them with its `IsHalted`, the position gone after a
  migration with `Insolvent`; (4)
  the recipient's `onBridgeMessage` runs with the native TAO and all the gas but the reserve, and
  its refusal (a pause, an unknown door, missing stake, `VaultInsolvent` at a supply of 0, a
  duplicate, out of gas) parks the native TAO (`converted` true; a redeem-only batch parks the same
  way with amount 0). One refusal does not park (R3, CC-L1): `ReentrancyGuardReentrantCall`, which
  the vault returns while its own lock is held around a stranger's code (`redeemDirect`'s payment,
  `processPayouts`' refund to its caller), from which the stranger can execute an honest batch with
  `OffRamp.execute`. That is no answer to the batch, and the lock is free once the stranger's
  transaction ends, so the adapter reverts the whole delivery: CCIP records `FAILURE`, nothing is
  written, and it is re-executed with the committee's results from the failed attempt (operator
  note 18). Without this the
  stranger could turn an honest batch's first delivery into a native park, whose refund then needs
  ForeverMoney's rail. The same holds one call earlier (R3 fix round 2): a conversion refused by ForeverMoney's own lock
  (a stranger delivering from `withdrawLiquid`'s payment) reverts the delivery instead of parking the tokens. Each park emits `BatchParked(key, messageId, recipient, sender, amount,
  converted, reason)`, `reason` the failure's selector (0x00000000 for an empty revert or no gas),
  and `ccipReceive` then still emits `Delivered` (R3, B-I3): `Delivered` means CCIP's message was
  handled, after a park as after a delivery, not that the recipient took the TAO, so an indexer
  reads the same transaction's `BatchParked` first. The reserve covers the park's writes in every
  failure: the tests measure at most about 57,300 gas of it used after a recipient that burns all its gas
  and about 53,000 after such a conversion. Anyone delivers a park with
  `deliverParked(recipient, sender, message)` (Task 26), under the same lock: it recomputes the key
  (`NotParked` without a record); a token park is converted first with `convertExact`, outside any
  `try`, so a conversion that still fails reverts the call and the record stays; then the record
  is deleted and its total lowered before the recipient's `onBridgeMessage`, which runs with the
  native TAO and all the gas but the reserve. Since R4 (A-M1, C-M1) it requires, right before that
  call, `parkedDeliveryGas(message)` left: the lane's inbound model for the batch, `inboundGasBase +
  entries × inboundGasPerEntry` (constructor arguments after the alpha vault, the Base adapter's own
  `gasBase` and `gasPerEntry`, which `verify` holds equal; the pair includes `PARK_GAS_RESERVE`, so
  the reserve is counted once, in the pair, and the constructor refuses a base at or below it), else
  `InsufficientGas` and the park stays exactly as it was. So a call with too little gas for the
  vault never converts or re-parks; the keeper's floor is that view plus the call's own work. And
  since R4 (C-L1) every path that converts or spends a token park's tokens (an inbound delivery
  before its conversion, `deliverParked` and an unconverted refund) first requires the token balance
  to cover the other token parks, the booked cushion and its own amount (`ReserveShort`, F-1), so a
  forged delivery naming tokens that never arrived takes at most the unswept surplus, never a park
  or the cushion. Accepted, it emits `ParkedDelivered(key)`; refused,
  the record is restored as a converted park of the same amount from its first `parkedAt` (so no
  retry postpones the refund's timeout), `parkedNative` takes the amount back, and it emits
  `ParkedConverted(key)`; refused by a held lock (`ReentrancyGuardReentrantCall`, R3), the whole
  call reverts and the park stays exactly as it was, a token park unconverted. So the keeper can convert every token park out of ForeverMoney's token
  during a migration notice even while the vault is paused (M-7). Anyone refunds a park to its
  door with `refundParked(recipient, sender, message)` (Task 27), under the same lock, once
  `PARK_TIMEOUT` (14 days) has passed since its first `parkedAt` (`ParkedTooYoung` before; a
  refused `deliverParked` keeps that time, so no retry postpones it); `NotParked` without a record,
  `NothingToRefund` for an empty park. The message is `PAYOUTS(key, REFUND_CHUNK, [(user, amount)
  per deposit])` (`REFUND_CHUNK = type(uint32).max`), each depositor's exact deposit from the
  parked `BATCH`, with the park's recipient (the vault) as the payload's sender and its sender (the
  door) as the recipient, so the door credits each depositor as a payout from its vault and its
  `netForwarded` falls by the refund (I-9). The record is deleted and its total lowered first; then
  a converted park goes back into the token through `_collect` (`depositLiquid`, so it waits while
  ForeverMoney's rail is closed or its own minimum refuses it), and an unconverted one sends the
  tokens it holds as they are, never touching the native balance or `parkedNative`. Neither makes
  send's amount checks (so a sub-floor token park, a raised floor or a park above this adapter's
  `maxMessageValue` is still refunded, I-10). The fee comes from `msg.value`
  (`quoteRefund(recipient, sender, message)` quotes exactly that message, before the timeout too);
  any excess stays in the adapter. It emits `Sent` (the vault as sender, so the indexer tells a
  refund from a vault payout by `ParkedRefunded(key, messageId)` and the chunk) and then
  `ParkedRefunded`. A token park that a `deliverParked` converted (its recipient refused or was
  starved of gas, Task 26) is refunded as a converted park, through `depositLiquid` rather than as
  the tokens: never a loss, but it needs the rail. `dropParked(recipient, sender, message)` (same
  lock, after the timeout) deletes an empty park, `ParkedDropped(key)`; a park that owes anything is
  `NotParked` there. A dropped redeem-only batch owes nothing: the vault refused it, so its redeems
  were never burned and their requesters ask again (the request fee is not returned).
- **The Bittensor sweep (v3.2, Task 28, spec §3.2).** `sweepSurplus()` (anyone) sends `treasury`
  the native balance above `RESERVE_TARGET + parkedNative` and the token balance above
  `parkedTokens + tokenCushion` (the booked cushion since R4, F-1), each floored at 0, with `SurplusSwept(native, tokens)`: a
  refund's or a send's kept fee excess, a withdraw's rounding surplus, a deposit's over-mint,
  tokens sent by mistake. It never sends what the parks are owed (I-7). It leaves
  `RESERVE_TARGET + parkedNative` of native TAO, so a native surplus refills the reserve first, and
  `parkedTokens + tokenCushion` of tokens, the booked cushion: a token surplus never refills the
  cushion, which only `fundCushion` tops up (R6b U7; this paragraph said otherwise until then). Unlike
  the Base sweep it runs
  under the adapter's one lock, because this adapter owes its parks: a treasury that re-enters the
  sweep, or a park function, from the native payment gets `ReentrancyGuardReentrantCall` (the tokens
  still go before the native payment, through the shared `_sweep`). The targets are sweep and
  monitor lines, never parking conditions (M-B): the indexer's `bridge.cushion_low` warns when
  `balance - parkedNative < RESERVE_TARGET` or `tokens - parkedTokens < TOKEN_RESERVE_TARGET`, that
  is when the native reserve or the token cushion has fallen below 0.001 TAO (each covered 1-rao
  shortfall spends up to a rao of one of them; since R4 the monitor should read the booked
  `tokenCushion()`, an off-chain change). Top the reserve up with `fundReserve()` and the cushion
  with `fundCushion` (a plain token transfer is surplus since R4). Below its target either still covers shortfalls until it is
  empty; then a short conversion parks (a delivery) or reverts (a send or a converted refund), and
  never takes parked funds.
- **The Base sweep (v3.2, Task 24).** The Base adapter owes nothing between calls, so
  `sweepSurplus()` (anyone) sends its whole native balance (kept fee excess) and token balance
  (tokens sent to it by mistake) to `treasury`, with `SurplusSwept(native, tokens)`; with nothing
  to sweep it succeeds and moves nothing. It is the stated exception to a lock on every function
  that pays out (ruling B12): the payee is immutable, nothing is written before the transfers, and
  the tokens go before the native payment, so a treasury that re-enters sweeps 0.

**The staking floor.** Bittensor refuses to add stake, or pay out a partial unstake, below
`DefaultMinStake` (2,000,000 rao = 0.002 TAO today; the root key can change it), and both
conversions stake or unstake on ForeverMoney's validator. The adapters make the failure early and
explicit:

- Bittensor adapter: `send` and `quoteFee` revert `BelowConversionFloor(amount, floor)` when
  `0 < amount < floor`, with the floor read live from the staking precompile
  (`getDefaultMinStake()`); a delivery makes the same check inside `convertExact`, and since Task
  25 a batch below it parks as tokens (refunded as they are after `PARK_TIMEOUT`, Task 27).
- Base adapter: it cannot read Bittensor, so `send` and `quoteFee` revert
  `BelowSendMinimum(amount, minSendAmount)` below an immutable minimum, 0.01 TAO at deployment
  (five times today's floor). The front door keeps every entry at or above `minDeposit` (a partial
  `cancelDeposit` may not leave less), so with `minDeposit >= minSendAmount` an honest batch never
  trips it.

What remains, and who owns it:

| Stall | What happens | Owner |
|---|---|---|
| A payout chunk whose net is below the live floor | `processPayouts` reverts `BelowConversionFloor` while the entries pay their fee share | Since R4 (the full top-up): a caller whose value covers the whole fee pays all of it, and the chunk goes at its gross, so a floor between the net and the gross no longer stalls it (the keeper sends the whole fee when it reads `BelowConversionFloor`). The full top-up has no separate ask, so the keeper's rule, and the hand route's, is to send exactly the top-up the quote asks, never more, unless choosing the full top-up; a quote that falls to at or below the value sent between the read and the send costs that caller the whole fee (never the entries; the keeper's code follows at the merge); a floor above the gross itself (about 0.04 TAO for the smallest bounce) still waits. Rare anyway: the vault defers (does not burn) any front-door redeem worth less than 0.03 TAO after clipping (`RedeemDeferred`), and the users are charged at most the fee ceiling (at most 0.015 TAO on a small chunk), so a chunk nets at least 0.015 TAO. It can still happen if the root key raises the floor past that, or a tiny bounced deposit goes alone. The keeper groups it with neighbouring entries (`maxEntries`); if every remaining entry is tiny, the owner cancels the batch (`cancelPayoutBatch` re-mints each redeem the value it was owed, never more shares than it burned; nobody loses funds), which carries its bounced deposits forward, still owed; a batch of tiny bounces alone cannot be cancelled (`NothingToCancel`) and waits for the floor to drop. The web app must still refuse unstake requests worth less than 0.03 TAO (web-wiring spec), or the user pays the request fee for a deferral. |
| A deposit batch in flight when the root key raises the floor above its total | the batch parks as tokens (Task 25) until the floor comes back down and it is delivered (Task 26), or is refunded to its door after `PARK_TIMEOUT` (Task 27) | The keeper reads `getDefaultMinStake()` before `closeBatch` (keeper spec). At a 0.01 TAO minimum this needs a five-fold raise. |
| `minDeposit` set below `minSendAmount` with `setCaps` (since v3.2 only possible with an adapter whose `minSendAmount` is above `MIN_DEPOSIT_FLOOR`, 0.03 TAO) | a batch whose total is below `minSendAmount` reverts `BelowSendMinimum` at `closeBatch` and stays open until more deposits arrive | The operator keeps `minDeposit >= minSendAmount` ([Operator notes](#operator-notes)). |

**Tests.** Unit and end-to-end tests (`test/adapters`) run the adapters over `MockRouter` and
`MockAlphaVault`, including a vault-to-front-door round trip with the two adapters in place of
`MockBridge`. Since R3 (F6) `MockAlphaVault` is ForeverMoney's deployed `AlphaVault` as the
adapter meets it, written from its behaviour (bridge-contracts `e80a443`): it stakes and unstakes
through the staking double and checks the stake and the TAO it measured (`Slippage`), uses
ForeverMoney's error names (`IsHalted`, `MigrationInProgress`, `UnknownToken`, `Insolvent`), has
no floor of its own (the precompile's refusal surfaces), and halts and migrates as ForeverMoney
does (a halt is a clock; deposits close at a migration's notice; `test/MockAlphaVault.t.sol` pins
each); its rounding knobs move whole rao, as the chain does. `ForeverMoneyFidelity.t.sol` ports
R3's second-wave PoCs against it, and `SendSideTolerance.t.sol` pins the send side against
ForeverMoney's measured-stake check (B-1). `BittensorParking.t.sol` covers parking (Task 25): every conversion failure and vault
refusal parks, a gas-burning conversion or recipient, or one reverting with a 1 MiB returndata
bomb, still leaves a record, and a malformed or already-parked batch reverts; and `deliverParked`
(Task 26): it converts and delivers, converts and stays parked, reverts when the conversion fails,
keeps the first `parkedAt` over failed retries, converts token parks while the vault is paused
(M-7), restores the park after a gas-burning or bomb-reverting recipient, and refuses a
reverting-then-re-entering, a re-entering-then-reverting and a two-level re-entrant recipient
(`test/mocks/ReentrantRecipient.sol`) with the totals and records exact (H-3, I-11); and
`refundParked`, `quoteRefund` and `dropParked` (Task 27): the refund opens exactly at
`parkedAt + PARK_TIMEOUT` and a refused retry does not postpone it; a converted park converts back
through `depositLiquid` (and waits while it is closed), an unconverted one sends its tokens without
touching the native balance or `parkedNative`; the router's message is `PAYOUTS` of each exact
deposit from the vault to the door; a sub-floor token park, a raised floor and a park over the
cap are refunded; the fee comes from `msg.value` with the excess kept; the quote is the fee of
exactly the message sent; only an empty park is dropped, after the timeout; both are refused under
the lock. `AdaptersEndToEnd.t.sol::test_refundCreditsEachDepositorOnBase` carries two parks (one
native, one tokens) through the Base adapter to the door, which credits each depositor exactly their
deposit, `netForwarded` falling by each refund to 0 (I-9). The send-side tolerance, the cushion
and the sweep (Task 28) are in `CcipBittensorAdapter.t.sol`: an over-mint is accepted; a mint
1 rao short is paid by the cushion with the whole amount sent, and one 2 or 3 rao short is
refused inside ForeverMoney (`Slippage`); a drained cushion reverts a short send, never paid by the token park beside
it, until a transfer tops it up, and never stops a token park; the sweep takes exactly what is
above the targets and the parks, sends 0 and 0 with nothing to sweep, and refuses a treasury
that re-enters it or `deliverParked` (the lock); and in `BittensorParking.t.sol` a converted
refund minted 1 rao short is covered by the cushion, waits for a drained one until topped up,
and its kept fee excess is swept. The v3.1 send-side and surplus PoCs in
`test/pentest/BridgeConversionStall.t.sol` are inverted. The live
simulation's Router stand-in runs over the mocks in `SimulationRouter.t.sol` (a park fails it).
`BridgeConversionStall.t.sol`'s `RoundingAlphaVault` is a lenient, rounding-only double (no
ForeverMoney check of any kind), kept to reach the adapter's own equalities behind ForeverMoney's:
`test_sendRefused_whenDepositLiquidUnderMintsPastTheTolerance` pins `_collect`'s own 1-rao check,
which the faithful `MockAlphaVault` never reaches (its `Slippage` refuses such a mint first; Task
38). `MockAlphaVault` runs ForeverMoney's gates before its lock, as the deployed modifiers are
ordered (`test_theGatesRefuseBeforeTheLock`). The adapters' half of the looped-rounding test
(`AdapterLoopedRounding.t.sol`, Task 38): a looper sending bridged TAO to itself on Bittensor and
back, ForeverMoney 1 rao short both ways, exact or in its favour, pays exactly the two lanes' fees a
trip and draws at most a rao from each reserve, a millionth of the fee it pays; 500 trips at the
0.01 TAO minimum cost it 1,000 fees; a looper that drains the reserves parks its own next batch
and has its next send refused until they are topped up, the parks beside it whole. The adapter
campaign (`test/invariants/Adapter.invariants.t.sol`, Task 38) is described under Build and test.
The Bittensor fork test of a paused AlphaVault, which asserted v3.1's `FAILURE` and re-execution, is
gone: since v3.2 a halted ForeverMoney parks the batch as tokens, and Task 61's `BittensorForkV32`
tests that and the token park with the burn rolled back. The fork tests (`test/fork`, run on demand)
drive deliveries through the deployed `OffRamp 2.0.0` on forks of both mainnets with only its
verifiers stubbed, so the real Router, the real token pools (BurnMint on Base, LockRelease on
Bittensor) and the real ERC-165 gate run; on Bittensor, ForeverMoney's real `AlphaVault` code runs
over `MockStaking`, because the forked EVM has no staking precompile. They also assert the lane
limits and the `OffRamp 2.0.0` addresses. `script/simulate_inbound.sh` runs one delivery against
the live Bittensor node, the only run through the real staking precompile (see
[Build and test](#build-and-test)).

## Compiler and verification

The profile is solc 0.8.38, `via_ir`, `cancun`, optimizer 200 (`foundry.toml`). Desk check of whether
the verifiers accept it, from their own public endpoints (2026-10-31):

| Question | Answer | Source |
|---|---|---|
| Is 0.8.38 in solc's release list? | Yes. `latestRelease` is 0.8.38, built as `soljson-v0.8.38+commit.1835d247.js` | https://binaries.soliditylang.org/bin/list.json |
| Does Sourcify list chains 964, 945, 8453, 84532? | Yes, all four with `supported: true` (964 and 945 as "Subtensor EVM" and "Subtensor EVM Testnet"; `etherscanAPI` is false for them, true for Base) | https://sourcify.dev/server/chains |
| Does Sourcify support 0.8.38? | **Not confirmed.** I found no public list of Sourcify's compilers, and its docs pages I tried returned 404. Sourcify fetches solc builds from the official list above, which has 0.8.38, so it is expected to work, but only the testnet probe proves it. | none |
| Which verifier does evm.taostats.io run? | Blockscout v7.0.2 with the Rust verifier microservice enabled | https://evm.taostats.io/api/v2/config/backend-version and https://evm.taostats.io/api/v2/smart-contracts/verification/config |
| Does it accept 0.8.38, cancun, viaIR, a linked library? | 0.8.38 (`v0.8.38+commit.1835d247`) and EVM version `cancun` are in its config lists. Standard-input (JSON) verification is offered, which carries `viaIR` and library addresses. Whether the full flow works for a linked library is not stated anywhere public. | same config URL |
| Basescan (Base Sepolia) | Not checked from a public source here | |

Public sources do not say whether taostats takes `viaIR` or linked libraries in practice. Treat the
rows above as "no known blocker", not as confirmation.

**Step 2 (founder), moved to the mainnet deploy: the probe on 945 and Base Sepolia.** The plan was: from a
throwaway key, deploy `test/toolchain/VerifyProbe.sol` (`VerifyProbe` plus its library `ProbeMath`, built with
the project profile) to Bittensor testnet 945 and Base Sepolia. Verify on Sourcify (both), taostats
(945) and Basescan (Base Sepolia). Expected: a full or exact match everywhere. The testnet rehearsal
(plan Tasks 62 to 64) was dropped on 2026-11-11, so this check is now the mainnet deploy's own: verify
the deployed contracts on Sourcify and taostats before the mainnet canary. If any verifier fails, the
answer is a newer 0.8.x that both
accept, never 0.8.24 (spec section 8 and 10, question 2). Record results and links here.

## Build and test

```shell
forge build
FOUNDRY_PROFILE=parity forge test                                  # the whole suite: unit, end-to-end and invariant tests
FOUNDRY_PROFILE=parity forge test --match-path "test/invariants/*" # invariant suite only
CASCADE_MIN_HITS_RUNS=3000 FOUNDRY_INVARIANT_RUNS=3000 FOUNDRY_PROFILE=parity forge test --match-path "test/invariants/*" --fuzz-seed 1 -vv  # the long run, its minimum hits asserted
script/seed-sweep.sh 128 64 sweep-logs 1 2 3      # the seed sweep: one invariant run per seed (--fuzz-seed), each seed's result and hit totals logged
forge build --sizes                           # the vault must stay under 24,576 bytes
node script/build-checks.mjs                  # size gate, published vault ABI, lens layout, lens surface, library rules, warning-free src, library links (set FORGE if forge is not on PATH); keeps forge's saved fuzz and invariant failures
node script/merge-abi.mjs                     # regenerate abi/CascadeVault.json after an ABI change
node script/gen-lens-layout.mjs               # regenerate src/lens/generated/ after a change to the vault's or front door's state
node script/gen-library-links.mjs             # regenerate test/utils/generated/LibraryLinks.sol (the link offsets I-32's run-time check reads) after a change to the vault's or a library's code
node script/lens-surface.mjs                  # the lenses serve every state variable and getter, exposed and listed for parity
node script/library-rules.mjs                 # I-32's static rules over the linked libraries, their call targets on solc's AST, the link graph, their call opcodes
node script/warning-gate.mjs                  # src/ compiles with no solc warning (no shadowing), built into a scratch directory
node --test script/*.test.mjs                 # the build scripts' own tests
forge fmt --check
forge lint
```

- **Profiles:** the whole suite runs under `[profile.parity]` (`FOUNDRY_PROFILE=parity forge test`),
  from v3.2's Task 5c on. It inherits every setting of `[profile.default]`, so the compiler settings
  and the bytecode are identical, and lifts only the test EVM's code-size limit (`code_size_limit`),
  for test-only subclasses such as `VaultInternals` that may grow past EIP-170. `forge build` and
  `node script/build-checks.mjs` run on the default profile: the size gate is the authority on
  EIP-170, not the tests. (Foundry 1.7 has no `disable_code_size_limit` key, and its tests apply no
  code-size limit unless `code_size_limit` is set; the profile states the lift rather than relying
  on that default.)

- **Suite:** `forge test --force` runs 114 suites, 1,456 tests passing (2026-11-15, R5's fixes, on the parity
  profile: R5's claim at the floor (M-4) and three rail-starvation sweeps (M-5, `VaultExitRail`), and the
  Bittensor stranger test's fork-only suite, `BittensorForkV32Failure`; 113 and 1,452 at Task 65's fix round
  and 3bb6617: Task 65's three claim-gas tests, `VaultClaimGas.t.sol`, and `AdapterGas`'s three exit tests in a suite
  of their own, `AdapterGasExitsTest`, so that neither test contract reaches via-IR's jump-tag limit; 111 and 1,449
  at 2140bb5: Task 61's nine `AdapterGas` tests, the model at its limit, the park write and the work after the walk,
  and its two fork suites, `BaseForkV32` and `BittensorForkV32`, which skip without `FORK`; 109 and 1,440 at
  b88b44e: the copied-key walk's two regression tests for the sweep's seed 115; 1,438 after the review of
  Revision 28: the 61 ms bound and Base's back-filled outages; 1,437 at Revision 28:
  the block floor in milliseconds and the lapse on both windows, `BlockFloor.t.sol`, the oracle's 1,801,
  the capped reads' gas scans, and the exits routine's last direct exits with seed 112's pin; 108 and
  1,428 after the review of the adoption drip, Revision 27: the delivery path's write-down over both
  drips, its `VaultInsolvent` revert, a cover net of queued payouts, and the I-15 fuzz test's pinned
  counterexample; 1,424 at the adoption drip: the drip's unit tests, `VaultAdoptionDrip.t.sol`, and
  the write-down's over both drips; 107 and 1,416 at Task 42's fourth fix round: part 1's exits and
  vault-favour campaigns, the exits campaign's second contract at the launch limits, and the other
  campaigns' new invariants and draws; the fix rounds' pins of the long run's and its rerun's
  counterexamples, of a partial request, of an adoption (now that it no longer lets the vest outrun
  the accrual), and of the four targeted draws; 1,413 at the third fix round, 1,404 at the second,
  1,398 at the first,
  106 and 1,376 at part 1; unit, end-to-end, fuzz, the ported v3.1
  PoCs, the scenario table's cells (`test/governance/ExitsMachine.t.sol`) and the Phase 8 invariant
  campaigns at 128 runs × 64 depth, set in `foundry.toml`), plus 49 that need a fork (48 before Task 65's
  Bittensor stranger test, `BittensorForkV32Failure.t.sol`, a fork-only suite of its own; in
  `test/fork`, and one ported PoC) and report as skipped unless `FORK` is set (below). Before it,
  `FOUNDRY_PROFILE=parity forge test --force` (the parity profile only lifts the test EVM's
  code-size limit) ran 104 suites and 1,346 tests at merge 7b (2026-11-11, every track together:
  R4's contract fixes and the exits machine's rows 1 to 5, `T-6` and `T-R`). Each invariant file to
  Task 41 also held at 512 runs × 64 when its task closed; Task 42's changed and new files held at
  three seeds of 128 × 64 each. Task 42 part 2 ran the whole invariant folder at 3,000 × 64 (seed
  20261113, on 8d05725: 284 passed and 3 failed, each a gap in the tests, fixed and pinned; the four
  changed campaigns again on dece524: 2 more such failures, fixed and pinned) and the 32-seed sweep at
  128 × 64 (seeds 101 to 132; on 7f3dcee, the final source: 31 seeds passed every test, and seed 115's one
  failure, a gap in the copied-key walk's model, was fixed and pinned in b88b44e, after which that campaign
  passed at all 32 seeds); `reports/2026-11-v3.2-campaign.md` records the runs.
- **Saved failures:** forge replays the fuzz and invariant failures it saves under `cache/fuzz` and
  `cache/invariant`. Any forced build removes them, whatever its `--cache-path`: `forge test --force`,
  and the scratch compiles of the warning gate, the library rules and their tests. `node
  script/build-checks.mjs` puts them back as they were (Task 42a); the regression tests stay the record.
- **Stale artifacts:** running `forge lint` right after an edit can leave test artifacts without
  bytecode, and `forge test` then reports "No tests found", or, now that the vault links
  `CascadeBatchLib`, `CascadeStakeLib`, `CascadePayoutLib` (which links `CascadePayoutMath`) and
  `CascadeHotkeyLib`, panics in forge's linker (`crates/linking`, `Option::unwrap()` on a `None`
  value). `forge clean && forge build` fixes it.
- **Invariants** (Phase 8, `test/invariants/`): every handler extends `TrackedHandler` and every
  invariant file inherits `BoundaryInvariants`, so lens parity (I-33), token accounting (I-34) and
  the fixed library links (I-32's run-time half) hold after every step of every campaign (the
  liveness file's probe-family contracts excepted: each runs one probe on the same actions, and the
  file's first contract runs the boundary invariants on them probe-free), and every
  refusal a handler meets is predicted from its state, counted, and fails
  `invariant_noUnexpectedReverts` when it is another or none happens. The core campaign
  (`Cascade.invariants.t.sol`): the price never falls but by I-4's exceptions, each recorded by the
  handler step that causes it, and no exit lowers it (I-35); an owner's payout-batch cancel re-mints
  each entry the value it was owed, never more shares than it burned (Task 34c), so it never lowers
  the price while `totalAssets()` reads above 0, and with assets reading 0 by its rounding dust at
  most, one rao per re-minted entry (and at a supply of 0 the hole the re-minted holders absorb);
  gross assets are conserved; reserved payouts match the queue; no front door burns more than its
  allowance in a window, nor all doors more than the global allowance in theirs (I-15; checked
  against the base the vault computed, rebuilt from its storage; with the booked-stake cap removed,
  it fails on the gift action); the front door's token and ETH balances match its books; users never
  claim more than was paid out. The handler also simulates rare losses (at most two a run, from
  liquid TAO not reserved for payouts) that can make the vault insolvent; the price floor restarts
  from each post-loss price and gross-asset conservation subtracts the losses, so bounced deposits
  are delivered, paid out and carried forward by a cancel (Task 22) under fuzzing. It also gives
  stake to the vault from outside (`gift`, counted in gross-asset conservation) and cycles capital
  through the keeper (`cycle`: a direct deposit, the keeper's stake, a direct redeem), the two ways
  the allowance base was found to move, and checks the base the vault computes across each: a gift
  is never booked and moves neither the base nor the price but for the missing stake it makes up, by
  which both may rise (never fall); a cycle never raises the base, and leaves it where it was, less
  what its receipts came back short, when the booked stake ends no lower than it began. The ledger
  campaign (`Ledger.invariants.t.sol`, I-1 to I-6), the payout campaign at an idle buffer of 0
  (`Payouts.invariants.t.sol`, I-12 to I-14 and I-19) and the two-door campaign
  (`Doors.invariants.t.sol`, I-15 to I-21, on a second door on chain 10 activated through the real
  schedule) each measure their invariants from the handler's own ghosts, never the vault's views
  alone. The adapter campaign (`Adapter.invariants.t.sol`, I-7 to I-11, Task 38) runs both CCIP
  adapters over two mock routers with the vault and the front door (their test-only subclasses),
  the handler relaying every message as the lanes carry it: the door's batches, and a re-entrant
  recipient's own batches through the Base adapter, to itself or to the vault; the vault paused,
  its stake swapped away, ForeverMoney short, halted or migrating, the floor raised, the reserves
  drained, time past `PARK_TIMEOUT`, and every park function and both sweeps by anyone. Its ghost
  map holds each message's state (in flight, failed, delivered, parked as tokens or as native TAO,
  refunded, dropped), moved only by the handler's calls and their events and compared after every
  step (and between a composite step's calls) with the adapter's record under every batch's key it
  has seen, a delivered batch's holding none, and its totals and balances (I-7), the vault's
  `processed` flags (I-8: minted exactly when delivered, never also parked), and on Base each
  refund's credits (I-9); refund liveness is probed by snapshot (I-10, refusals allowed only where a
  converted park needs ForeverMoney's rail or the token cushion), and around every call that
  reaches the re-entrant recipient no other park moves and every re-entry meets the lock, one
  through the router (another pending batch executed inside the delivery) included (I-11). The
  governance campaign (`Governance.invariants.t.sol`, I-22 to I-25 and I-29, Task 39a, on
  `test/governance/GovernanceFixture.sol`) drives both schedulers: the owner schedules, executes
  (at, around and across a halt of each item's readiness), calls directly and cancels a setter table
  of tightening, equal, loosening and out-of-bounds values and of new, known and guardian-removed
  activations, and plays every instrument; the guardian (swapped by `setGuardian`) cancels and plays
  its own; a stranger relays the owner's signed stamps, valid and not, and prunes. Its ghost log of
  every item's life and its model of every field a setter, instrument or stamp writes move only by
  the handler's own calls and their events, and are compared with both lenses and both contracts
  after every step. Task 39b's two campaigns run on the same world (`GovernanceWorld.sol`, the
  handlers subclassing 39a's). The liveness campaign (`GovernanceLiveness.invariants.t.sol`,
  `LivenessHandler`) probes, after every action and in snapshots, the owner's own way back to OPEN
  (I-26), every pending `setGuardian` run at its readyAt through the guardian's every instrument one
  second before (I-27), a launch batch delivered and a payout credited while both chains read OPEN
  (I-28, each half judged on its own rail and asserted while that rail is coherent; the states OPEN
  alone allows, no launch door or a disabled primary after a swap (the spec's section 3.6) and a rail
  the other side does not take (the one-sided rail switch, the residual below the spec's section 5
  table), are counted, not asserted, and a half whose primary is the probe, a re-entry stand-in
  rather than a rail, goes untried), and no pending activation naming an active target. Foundry runs
  each invariant as its own campaign, so each probe family has its own contract with only its own
  probe on, its invariant, `invariant_noUnexpectedReverts` and its reach log, and the file's first
  contract, `GovernanceLivenessTest`, carries the boundary invariants probe-free and the pins, each
  with every probe on. The copied-key walk (`CopiedKey.invariants.t.sol`, `CopiedKeyHandler`) runs the
  sweeper (`GovernanceFixture.sweeper`): the founder acts only through its 12-hour stack, relayed as
  each asOf passes, while the thief holds both keys, and no item the thief schedules ever executes;
  each dies to the first stamp covering it (the owner's clock reaches its schedule time, and its
  execute is refused). Its pins put the largest safe spacing at the shortest class delay, 48 hours,
  with the relay in the asOf's own second, so no margin: a real relay needs the spacing less its
  latency and a block, within the stamp's 1-day TTL, and the 12-hour stack leaves room for both.
  Task 42 adds two campaigns: the exits campaign (`Exits.invariants.t.sol`, `ExitHandler`, I-37: every
  claim has a non-owner exit; see [Exit liveness](#exit-liveness-task-42-i-37)) and the vault-favour
  campaign (`Favor.invariants.t.sol`, `FavorHandler`, I-38: no one gains except by time held:
  `noActorGainsByActing`, `gainsOnlyByTimeShare`, `gainsAreConserved`, at the launch's 30 days of
  vesting and 10% cut; a pin shows the review's late entrant taking more than its time share at 7
  days). The core campaign gains I-30 (each delivery against its three floors apart) and I-31 (a
  stake action through the staker against the 95% buy floor, with `NoOracle` and the oracle's own
  revert among its refusals; no delivery settles while a pool is thinned, with a delivery draw that
  always thins one) and an unstake-margin switch; the adapter campaign, dedicated draws for F-2 (a forged redeem-only batch from the door) and
  for the sweep a forged call sets off; the copied-key walk, relay outages (up to just under 36 hours,
  then the newest due stamp first); the liveness file's I-28 family, token accounting in its own
  invariant; and several campaigns, targeted draws for their thin states. Every campaign's
  `invariant_noUnexpectedReverts` runs with fail-on-revert, so a handler call that reverts unwrapped
  fails it. Minimum hits (ruling B9): each file names its rare states (`MinimumHits.sol`); each run's
  counters are summed across the runs and campaigns of a file in the forge process's environment and
  asserted against their minimums only when `CASCADE_MIN_HITS_RUNS` is set (the long run sets it to
  3,000); each reach log prints the totals. Each minimum is a quarter of what the slowest of three
  128 × 64 seed runs projects for 3,000 runs, and 0 (logged, not asserted) when that projection is
  under 8 (the controller's rule of 2026-11-12; Task 42's second fix round re-derived every file's,
  and set each against the first long run's totals).
- **Test doubles** (`test/mocks`): `MockStaking` is etched at the precompile address and models the
  floor reads, over-request clipping, sweeps, a fresh position reading one rao short, claims that
  burn all gas when refused, an optional per-removal chain fee (`removeFeeRao`) and claims paid out
  as balance (`claimToBalance`). For the root hold (Task 20): `setPairLocked(hotkey, true)` refuses
  removals from that hotkey's pairs and moves off it (`RootStakeLocked`), `setBurnRemoveGas(true)`
  makes a refused removal burn all the gas forwarded to it instead, as a failed precompile write does
  on the live runtime, and `setRecordRemovalGas(true)` records the gas each removal that goes through
  was given (`removalGas(hotkey)`), the walk's split. `HoldStaking` (`test/pentest`) models the hold
  with its block clock; it credits with `vm.deal`, which a reverted call does not undo, so a test of
  it that expects a revert after a removal resets the vault's balance. `MockStaking` moves value only
  by value transfers since Task 35, which a revert undoes with everything else: `addStake`'s debit goes
  to a sink, a removal pays by a call with value (into the vault's `receive()`, the unstake guard), and
  a claim paid as balance is a forced credit, as the chain credits it, since the vault's `receive()`
  refuses value outside an unstake; `setPayByCall(true)` pays a claim by a call too (the guard's test)
  and `setPayByCall(false)` forces every credit. `MockBridge` is
  chain-aware, enforces the fee rule and a 5,000-TAO message cap, delivers with a 7,000,000 gas cap,
  and keeps failed deliveries queued for retry. For the adapters, `MockRouter` records each
  `ccipSend`, quotes a settable fee and delivers the way the 2.0 OffRamp does (code-size and
  ERC-165 gate, tokens, then `ccipReceive` as the Router), and `MockAlphaVault` is ForeverMoney's
  deployed `AlphaVault` as the adapter meets it (since R3, F6: its measured-output checks, error
  names, halt clock and migration; see the bridge's Tests paragraph), with whole-rao rounding knobs.
  `ProbeBridge`, made a primary, re-enters its caller's scheduled-only paths from inside each cap
  check (`maxMessageValue`, `execute`'s self-call included) and reverts `ReentryAdmitted` if one gets
  past its gate (I-25). Also `MockAddressMapping`, `StubBridge` and `MockTAO`.
- **Gas:** a 50 + 50 batch delivery, the largest legal one, costs 3,491,035 gas measured cold (test
  bound 3,750,000), with one hotkey in the set (2026-11-03: Task 18's redeem origin adds about 22,500
  for each new depositor, its slot's first write, and `MAX_ENTRIES` falls to 50, so 100 + 100 is no
  longer legal; Task 17's global outflow window adds about 48,000 to a delivery that burns, its
  window's read and first write; 2026-11-01, the batch path in the
  linked `CascadeBatchLib`: about 7,000 gas more for the library call, and about 18,000 more for a
  deposit-only delivery, which now reads the allowance base and the limits too). A delivery reads the
  stake once (one `getStake` per hotkey in the set). The lane gives about 7.2M. The batch limits'
  bound, 50 + 50, is also their launch value. Since the walk moved into the linked
  `CascadeStakeLib` (Task 5f), an exit that unstakes executes about 1,700 to 2,700 (`redeemDirect`)
  and 8,600 (`processPayouts`) gas more (the library call, the hotkey copy and the encoded
  parameters), partly offset by the transient unstake flag, which costs two `TSTORE`s where v3.1's
  storage flag cost a write and a reset (refunded); after refunds, about 5,500 and 11,500 more.
  Since the payout engine moved into the linked `CascadePayoutLib` (Task 5g), `processPayouts`
  executes about 11,500 gas more for a one-entry chunk with a walk and about 40,500 more for a full
  100-entry chunk, with or without a walk (two library calls, each carrying the batch and the limits;
  the entry list crosses one more call; the chunk's message passes from the first half to the
  second), and a 100-entry `cancelPayoutBatch` about 22,900 more (measured against a bridge that
  records nothing; delivery gas is unchanged). Since the walk outlasts a root hold (Task 20), it reads
  every listed position once before it walks (one `getStake` per hotkey, in place of one per position
  visited), and each removal costs the walk about 3,000 gas of its own beyond the precompile's (the
  debit's `getStake` read, the balance reads, the gas split, the `try`, `Unstaked`; about 34,000 per
  removal in the mock, its removal included, `test_gasSplitCountsOnlyUnstakeablePositions`). A held
  pair refused at once costs little (an exit with all three listed pairs refused: about 65,000 gas
  for `redeemDirect`, 89,000 for `processPayouts`); one that burns its gas burns only its share,
  and the exit keeps `EXIT_GAS_RESERVE` (2,000,000 since Task 65, 1,200,000 before) while each share exceeds
  `unstakeGas` (below that, burning floors can eat the reserve and the exit runs out of gas, reverting whole).
  The reserve is sized from Task 61's fork measurement of the work after the walk (below); `unstakeGas`
  (400,000) and the live precompile's costs are the mainnet canary's to record.
- **Sizes: Task 65** (2026-11-15, Revision 30's constants; solc 0.8.38, `via_ir`, Cancun,
  `optimizer_runs = 200`). `node script/size-gate.mjs` holds the vault and the front door to 23,076 B
  (EIP-170's 24,576 less 1,500 B of headroom) and every other part to EIP-170. Runtime code, with size
  gate D (Task 42's final gate, Revision 27's build) beside it:

  | Part | Size | Limit | Headroom | Gate D |
  |---|---|---|---|---|
  | `CascadeVault` | 22,655 B | 23,076 B | 421 B | 22,396 B |
  | `CascadeFrontDoor` | 19,102 B | 23,076 B | 3,974 B | 18,684 B |
  | `CascadePayoutMath` | 1,997 B | 24,576 B | 22,579 B | 1,997 B |
  | `CascadeBatchLib` (L1) | 4,239 B | 24,576 B | 20,337 B | 4,239 B |
  | `CascadeStakeLib` (L2) | 2,006 B | 24,576 B | 22,570 B | 1,963 B |
  | `CascadePayoutLib` (L3) | 6,253 B | 24,576 B | 18,323 B | 6,253 B |
  | `CascadeHotkeyLib` (L4) | 2,599 B | 24,576 B | 21,977 B | 2,574 B |
  | `CascadeVaultLens` | 8,825 B | 24,576 B | 15,751 B | 8,808 B |
  | `CascadeDoorLens` | 2,688 B | 24,576 B | 21,888 B | 2,688 B |

  No library or lens counts toward the vault's limit. The vault is 1,921 B under EIP-170 itself. Task 65's
  constants leave it as it was (Revision 29's 73,500,000 had added 1 B, the claim gas bounds' span no longer fitting
  three bytes; Revision 30's 63,400,000 fits again) and took 26 B off the lens (8,851 B at Revision 28); every other
  part is unchanged. Revision
  28 added 259 B to it (the lapse's window in blocks, about 215 B, in the shared scheduler, which also put
  418 B on the front door; the capped reads' gas check, about 44 B, also in the walk, the hotkey library and
  the lens); it grew from 22,174 B (902 B of headroom) at the morning's gate to 22,396 B with the adoption
  drip (+222 B), and its lens from 8,593 B to 8,808 B. Not gated (read from the same build's artifacts, each under EIP-170):
  `CcipBaseAdapter` 6,433 B, `CcipBittensorAdapter` 12,613 B, `CascadeStaker` 8,350 B, `CascadeTwapOracle`
  3,715 B. Earlier, on 2026-11-01, with the batch path, the walk and the payout engine first moved into
  libraries: the vault 15,460 B (7,616 B under the gate), `CascadePayoutMath` 1,867 B, `CascadeBatchLib`
  3,286 B, `CascadeStakeLib` 1,367 B, `CascadePayoutLib` 4,500 B, the lenses 5,130 B and 1,553 B; the
  front door 18,684 B since Task 32 (17,598 B before Task 29); the adapters 6,299 B and 11,240 B at Task 28.
  The size gate reports every part of the build (the vault, the front door, then each library and lens)
  and fails one that is missing, the vault or the front door above 23,076 B, or any other part above
  EIP-170.
  Any change to `src/` runs the build checks (`node script/build-checks.mjs`) and commits what
  they regenerate (the published ABI and the lens layout), and adds to the lens what it adds to
  the state.

### Fork tests and the live simulation

The fork tests (`test/fork`, 29 on Base: 6 in `BaseFork.t.sol`, 8 of v3 and v3.2 in
`BaseForkV3.t.sol`, 6 in `FrontdoorPentest.t.sol` and 9 in `BaseForkV32.t.sol`; and 19 on Bittensor: 5 in
`BittensorFork.t.sol`, 13 in `BittensorForkV32.t.sol` and 1 in `BittensorForkV32Failure.t.sol`, pinned to its
own block) fork both mainnets and are skipped unless
`FORK` is set, as is one ported PoC (`test/pentest/OracleIdleTwapPentest.t.sol`, pinned to a Base block).
`FORK=1 forge test` runs the whole suite including all 49; run each chain on its own to pin it.

```shell
FORK=1 forge test --match-path "test/fork/{Base*,FrontdoorPentest}.t.sol"     # the 29 on Base
FORK=1 FORK_BLOCK=<N> BITTENSOR_RPC=http://127.0.0.1:8547 \
  forge test --match-path "test/fork/Bittensor*.t.sol"                      # the 19 on Bittensor (below)
bash script/simulate_inbound.sh                                             # live eth_call, Bittensor node
```

| Variable | Default | Effect |
|---|---|---|
| `FORK` | unset | Runs the fork tests; without it they report as skipped. |
| `BASE_RPC` | `https://mainnet.base.org` | Base RPC. It must serve old state: two Base tests fork pinned blocks of their own (53,341,000 and 57,505,354). |
| `BITTENSOR_RPC` | `https://lite.chain.opentensor.ai` | Bittensor EVM RPC. The lite node keeps only about 300 blocks of state. |
| `BITTENSOR_SUBSTRATE_RPC` | `https://archive.chain.opentensor.ai` | The substrate RPC the runtime-version test reads (`state_getStorage`), which an anvil cache does not serve. |
| `BITTENSOR_ARCHIVE_RPC` | `https://archive.chain.opentensor.ai` | The RPC `BittensorForkV32Failure` forks at its own pinned block (9,499,544), which the lite node and an anvil cache at another block cannot serve; forge's disk cache serves repeat runs. |
| `FORK_BLOCK` | latest block | Forks at this block, so Foundry's on-disk RPC cache serves repeat runs. It applies to every fork in the run, so pin one chain at a time with `--match-path`. |

- **Base** runs fine on the public RPC (green at block 53034779, and pinned there again with
  `FORK_BLOCK=53034779`; all 29 green at 57,571,630 on 2026-11-14, and `BaseForkV32`'s 9 again at
  57,607,777 at Task 65).
- **Bittensor rate limit.** Both public Bittensor RPCs (`lite.chain.opentensor.ai` and
  `archive.chain.opentensor.ai`) allow about 128 requests a minute, and a cold run of the
  Bittensor fork tests needs more, so it fails with HTTP 429. Run a local anvil as a cache of the
  archive node at a fixed block and point the tests at it, at the same block (green at block 9354721;
  all 18 at 9508000 on 2026-11-14, and `BittensorForkV32`'s 13 again there at Task 65, served by forge's
  disk cache with `BITTENSOR_RPC` the archive node). A first run may still time out on reads the cache had not fetched
  yet (`operation timed out`); run it again, and each run fetches more:

  ```shell
  anvil --fork-url https://archive.chain.opentensor.ai --fork-block-number <N> --port 8547 \
    --retries 12 --fork-retry-backoff 20000 --timeout 60000
  FORK_BLOCK=<N> BITTENSOR_RPC=http://127.0.0.1:8547 FORK=1 forge test --match-path "test/fork/Bittensor*.t.sol" -vv
  ```

- **The v3.2 rehearsal (Task 61).** `BittensorForkV32` runs the vault and the Bittensor adapter at the
  launch gas pairs over 50 seeded holders: a token park with ForeverMoney's burn rolled back (its unstake
  refused) and a halted ForeverMoney's park, each delivered by `deliverParked` once the cause ends; a paused
  vault's native park, delivered by the keeper's `deliverParked` at the least gas a bisecting estimator
  would send (the adapter's `InsufficientGas` floor makes that enough: 1,385,782 for a one-deposit park
  whose floor is 1,357,000); the two 1-rao tolerances under the real AlphaVault (a delivery's from the
  native reserve, a payout's from the booked cushion, R3 B-NV1); the rail's reads (`canSendPayouts` 10,731
  gas cold against its 150,000 cap, each read about 2,400 against 30,000); the inbound model bisected at its
  tightest points; the work after the walk with the real send (below); the owner's forfeit removal after an
  unclaimed read that burns its gas (1,601,642 at most, under the runbook's 3,000,000); a rail switch with a
  batch in flight (waited for, it is delivered by the old adapter; not, it parks and is refunded through the
  old adapter's real OnRamp after 14 days); and the runtime's version (`specVersion` 490, at least 452).
  `BaseForkV32` runs the front door at the launch values: the receive gas toward Base (above), a refund
  through the real OffRamp to a door that switched rails (it lands through the disabled, still known, old
  adapter; through an adapter the door never knew it is refused, CCIP `FAILURE`), the close with the id
  through the real Router, a real CCIP `FAILURE` re-executed by hand with the committee's real results
  (checklist item 27), and the oracle's history requirement (1,801 slots; a fork before the TAO/WETH pool
  grew has the constructor refuse it, which is why `BaseForkV3` and `FrontdoorPentest` skip there).
  `test/fork/GasProbes.sol` holds the probes: a staking stand-in that can eat gas inside ForeverMoney's
  `addStake`, a holder whose `receive` eats gas, and the cold-run notes (a revert to a snapshot restores
  cold state; `vm.cool` cools an account's slots, not the account; a run under
  `vm.startStateDiffRecording` is charged as warm, so the probes never record).
- **The reserves and the spend cap (Task 61, 2026-11-14; Task 65's constants).** `PARK_GAS_RESERVE` (150,000,
  kept): a park's write after a recipient or a conversion that burned all its gas takes at most 59,344 (a native
  park of 50 deposits; 58,523 for one, 31,626 for a redeem-only batch's empty park, 14,437 for `deliverParked`'s
  restore), and a token park after a burning conversion leaves at least 121,646 of it unused; no
  precompile runs after the failure, so the live write costs the same (`AdapterGas.t.sol`: the reserve holds
  twice the worst write; raising it would raise every inbound message's CCIP gas).
  `EXIT_GAS_RESERVE` (2,000,000 since Task 65; 1,200,000 before): with the walk's paying removal burning its
  share down to 60,000, at the keeper's gas (its estimate, the reserve and `unstakeGas` a position), a payout
  through the real AlphaVault, Router and OnRamp has 1,450,930 to spare after its work at one entry and
  1,352,465 at fifty (its work after the walk about 549,000 and 648,000 over the mock precompile; at 1,200,000
  the committed tests printed 663,688 and 565,016 spare). The live chain adds the real `addStake` in the send
  and the walk's last `getStake` (the T61a review's live estimates from an account: `addStake` 104,208 gas,
  `getStake` 27,427, `removeStake` 144,167, each with the 21,000 intrinsic; about 60,000 to 110,000 in all),
  so the reserve holds 2.6 to 3.3 times the live work. Every exit test asserts the reserve holds at least
  twice its work with a 150,000 live allowance (`AdapterGas`'s and `BittensorForkV32`'s; over the mocks the
  work is about 763,000 at one entry, MockRouter storing the whole message), which 1,200,000 failed.
  `redeemDirect` at the site's floor (the reserve, `unstakeGas` a position and 500,000) has 1,965,364 (one
  position) and 1,983,419 (four) to spare: its own work after the walk is about 35,000. A payout's least gas,
  the estimate Bittensor's bisecting node gives, is 821,665 at one entry and 1,310,954 at fifty on the fork,
  its fee quote's reads cold as on chain (Task 65: the T61a figures, 768,188 and 1,257,478, had them warm;
  about 0.0041 and 0.0066 TAO at 5 gwei, before the live precompile's costs; the reserve does not move it):
  after one claim's up-front 57,000,000 gas at 5 gwei the keeper's 0.4 TAO day leaves 0.115 TAO, 27
  one-entry payouts at their estimate and top-up (0 here: the entries' fee covers the quote), or 7 if each
  counted at its whole gas limit with the 2,000,000 reserve (9 at 1,200,000); the cap's sizing is ops'.
  `MAX_CLAIM_GAS` (63,400,000 since Task 65's fix round, Revision 30; 60,000,000 before): a claim's overhead
  outside the forwarded `claimRootWithHotkey` is 218,947 at its dearest over the mocks (four hotkeys, eight
  `getStake` reads, the treasury's first cut, every slot cold; `VaultClaimGas.t.sol`), allowed 500,000, so a
  claim at the top fits Bittensor's per-transaction limit, about 65,000,000 (75% of the block less 10% for
  initialization; 64,998,400 read live on 2026-11-15), with a 1,000,000 margin: 63,400,000 + 500,000 +
  1,000,000 = 64,900,000. The 75,000,000 block gas limit is not what one transaction meets: the pool refuses
  a gas limit from about 64,998,600 up (`ExhaustsResources`). At the top, a claim that needs all it is given
  completes in a transaction of 63,900,000. The setting's live headroom runs from 54.1M to 63.4M left. The
  bounds set only the least a claim requires left (R6, ChatGPT R2's gas note): what is forwarded is the
  caller's gas limit's, 63/64 of what is left, so a transaction at the per-transaction ceiling forwards about
  63.7M at any setting, and a real claim that needs up to about 63.6M forwarded can still be met; one that
  needs more can be met by no setting and no gas limit. `MIN_CLAIM_GAS` is 54,100,000 since R5 (M-4): the 53.2M a `claimRootWithHotkey` needs, section 2's
  figure, reaches the precompile only from about 54.03M left, so at 53,200,000 a claim at the floor forwarded
  about 52.37M and burned (`VaultClaimGas.test_aClaimAtTheFloorForwardsWhatThePrecompileNeeds` bisects the
  least gas the check lets through and lands the claim there); no fork can run the real claim.
- **What the forks cannot run.** The forked Bittensor EVM has no staking precompile, so the fork
  tests etch `MockStaking` at its address and ForeverMoney's real `AlphaVault` code runs over a
  mock unstake: every Bittensor figure above carries the mock's precompile costs, and the inbound
  model's check adds a 300,000 allowance for them. The live costs (a real `removeStake` measured
  144,811 gas; `claimRootWithHotkey` against `MIN_CLAIM_GAS`; the 500-rao existential-deposit read
  that parks a delivery to an empty reserve) are the live simulation's and the mainnet canary's.

`script/simulate_inbound.sh` covers that gap. It deploys the Bittensor adapter (real constructor
arguments) and `test/fork/Sink.sol` on a throwaway local anvil to get their runtime code, then
runs one `ccipReceive` as a plain `eth_call` on the live Bittensor node with state overrides: the
two runtime codes at unused addresses, 1 TAO of ForeverMoney's token in the adapter's balance slot
(found by matching the pool's balance), and a stand-in at the Router's address
(`test/fork/SimulationRouter.sol`) that funds the adapter's 1e12-wei reserve through
`fundReserve()` and then forwards the `ccipReceive`, so the adapter still sees the Router as
caller. ForeverMoney's real `withdrawLiquid` burns the tokens, unstakes through the real precompile
and pays the adapter, which forwards the TAO to the sink; the sink reverts unless it receives
exactly the amount. Since Task 25 the adapter parks what it cannot convert or deliver instead of
reverting, so a returning `ccipReceive` is not a pass: the stand-in then reads `parkedNative()`
and `parkedTokens()` and, unless both are 0, reverts `SimulationParked` (both totals and the
batch's record, `parked(key)`). The script then prints the record and
`SIMULATION FAILED: the delivery PARKED ...` and exits 1; after a token park it also runs
`withdrawLiquid` alone from the adapter, to show ForeverMoney's answer. Before the delivery it
checks, with the same overrides, that the adapter answers `alphaVault()`, the sink `reverting()`
and the stand-in `adapter()`, because the node silently ignores some overrides and calls to an
empty account succeed. Only a delivery that reached the sink with nothing parked prints
`SIMULATION OK` (the line `pnpm ops preflight` requires); a revert is named (the adapter's, the
sink's or ForeverMoney's error). Nothing is broadcast. It makes about 15 requests to the node.
Options: `BITTENSOR_RPC`, `REMOTE_ADAPTER` (the Base adapter's address), `AMOUNT` (wei),
`GAS_BASE` and `GAS_PER_ENTRY` (the Bittensor adapter's gas model), `MAX_MESSAGE` (its per-message
cap, which a delivery does not check), `RESERVE` (0 shows the unfunded adapter's
`ConversionShort`, now a token park and a failed simulation) and `FUNDER`. Run on 2026-10-24
against the lite node, with the v3.1 adapter: 1 TAO and exactly 0.002 TAO (the floor) delivered;
`RESERVE=0` reverted `ConversionShort`; 20,000 TAO, more than ForeverMoney's position, reverted
their `Insolvent()` (both would now fail as token parks). The parking verdict was dry-run on
2026-11-04 against a local anvil standing in for the node, with the mocks at the live addresses:
a delivery printed `SIMULATION OK`; a halted alpha vault and a conversion 2 rao short each failed
as a token park, a refusing sink as a native park, and an amount not in whole rao as a named
revert, each exiting 1.

## Money flow

### Deposit leg (Base to Bittensor)

1. The app swaps the user's USDC for ForeverMoney's TAO on Base. The user calls `deposit`, or a
   one-signature "zap" contract calls `depositFor`, which can only credit the named user. Amounts
   must be whole rao (1 rao = 1e-9 TAO), at least `minDeposit`, inside the front door's
   `depositCap`, and inside the batch's 4,000-TAO value limit. Each user has one merged entry per
   batch. `cancelDeposit` returns tokens while the batch is still open, from five minutes after the
   user's last deposit (`CANCEL_COOLDOWN`, R11): before that it reverts `CancelTooSoon(cancelableAt)`,
   ahead of every other check, and `cancelableAt(user)` gives the second it opens. No cooldown applies
   while the front door is paused or its primary bridge is disabled (R12): paused, no deposit can
   land, so there is no fresh deposit to hold (closes still land); with the primary disabled, no close
   with entries can land. `cancelableAt` reads 0 and the cancel goes at once; an unpause or the
   primary enabled again brings it back (a `setGuardian` that clears a guardian's hold does not: the
   bypass reads the primary's flag). Every `deposit` and `depositFor` restarts the clock of the entry's
   owner (whoever pays), so a `depositFor(victim, ...)` holds the victim's cancel five more minutes at
   the cost of a gift of at least `minDeposit` (0.03 TAO, `MIN_DEPOSIT_FLOOR`, at the lowest), bounded
   by the batch's and the cap's room; the pause stops that and frees the victim's cancel at once. A
   partial cancel must leave
   at least `minDeposit`; a full cancel is always allowed, so every entry is at least the
   `minDeposit` in force when it last changed. FM-TAO or USDC sent to the front door by a plain
   transfer is credited to no one (R6b U8): the door has no sweep, so stray USDC is lost for good, and
   stray FM-TAO comes back only if the owner activates (7 days) a contract that delivers a payout
   crediting its sender. Use `deposit` or `depositFor`.
2. To exit, a user calls `requestRedeem(shares)`. The front door cannot see balances on Bittensor,
   so the vault clips each request later. The first request per user per batch costs
   `redeemRequestFee` in ETH (the spec's launch value, 2e14 wei or 0.0002 ETH, is about $0.36 at about $1,816 an ETH;
   v3-launch's is 1e14 wei). It is paid cash first:
   the call may carry up to the fee, and the user's credit covers the rest. Anyone can pre-pay
   credit with `creditRedeemFee`; this is how the app sponsors passkey wallets that hold no ETH.
   The app may send the full fee or `fee - credit`. The full fee in cash always works, so a gift of
   credit cannot make a request revert. `cancelRedeem` reduces a request; the fee is not refunded.
   Credit is not withdrawable, by design (R6, ChatGPT R2 H): it is a sponsor's ETH, spent only on
   that user's own requests, so pre-pay only what will be spent; credit on a retired door, or while
   the fee is 0, stays there. Two other fees are not returned either: the open batch's own request
   fees if a door is retired with that batch never closed (they are not `potCarried`, so `sweepPot`
   cannot reach them; at most 50 fees), and the fee of a redeem the vault skips or defers (another
   origin, the day's allowance spent, fresh shares, or payouts closed), which the holder pays again in
   a later batch, once a batch while ForeverMoney's pause lasts.
3. Anyone calls `closeBatch(id, minValue)` once the batch interval has passed (12 hours in the beta),
   or the deposit list holds half its limit (R12: 25 of 50 entries) or the redeem list is full, or,
   while the batch holds deposits, the half rule (R7) is met: the deposits
   are at least half the batch's value limit or half the room left under the door's `depositCap`, or
   no deposit of `minDeposit` fits any more under either (the room rule of R6b U4; it decides alone only
   after `setCaps` raises `minDeposit` above a batch already holding deposits, since every entry is at
   least the minimum when made, so normally the half clauses already hold: R8, the R7 review's I-1). A
   deposit is free to cancel until the close (from five minutes after its last deposit, R11), so
   without it one address could hold every batch just
   under a limit, refusing every other deposit, and cancel before each close; the room rule alone still
   let it keep the room at exactly `minDeposit` (9.96 of 10 TAO at launch). What is left, stated: a
   holder can still refuse deposits above about half a batch, by sitting just under half and cancelling
   as much as each honest deposit adds, so the honest deposits land and go with the batch. And the rule
   binds a holder over the line only through a close that lands before its cancel (R8, the R7 review's
   L-1): the keeper runs once a minute, so a holder could deposit a full batch just after one round and
   cancel before the next, and every honest deposit reverted `BatchValueFull` (or `CapExceeded`) for
   most of each minute. The cancel cooldown (R11) closes that: the holder's cancel waits five minutes,
   so the keeper's next round, a minute later, finds the batch over the line and commits it; its own
   top-up restarts its clock for the whole entry. With more addresses a lift over half can still be
   cancelled back within a round, but only from deposits five minutes old, which were in the batch at
   an earlier round, under half: the cancels within any five minutes add up to less than half a batch,
   so the batch is near full for at most about one round in five
   (`FrontDoorClose.test_aLiftOverHalfCancelsOnlyAnOldDeposit`), as long as each keeper close lands:
   an aged entry's one-rao cancel between the keeper's read and its close voids a close whose
   `minValue` is the total it read, so the keeper names a lenient `minValue` on a batch it closes early
   (`FrontDoorClose.test_anAgedOneRaoCancelVoidsAnExactMinValueButNotALenientOne`); that keeper is the
   one built from v3.2-wire, and `canClose`'s NatSpec saying so is true of it only. A forced early close
   now takes 25 entries (1 TAO), about 0.0016 ETH of pot or keeper cost each (an interpolated figure),
   bounded by the 40 TAO cap; the pot pays first, so sweep the carried pot regularly (`sweepPot`). `closeBatch` is permissionless, so the
   web still offers the refused depositor "close this batch, then deposit" when the deposit does not fit
   and `canClose()` is true, and that close commits the holder; the monitor warns on heavy cancelling.
   The deposit list's half rule (R12) ends the list's hold: a round that finds the batch waiting found
   at most 24 entries, so a holder that fills the list after it pushes at least 26 entries too young to
   cancel, and the next round commits them (`EndToEnd.test_theDepositListHoldEndsAtTheKeepersNextRound`).
   What is left, stated: the under-half hold and the honest closer's bridge fee for a deposits-only
   batch; their contract cure, a deposit fee the cancel does not return (checklist item 29), stays
   deferred. A batch of redeems
   alone waits for its interval or a full redeem list whatever the limits (at a filled cap the room rule had
   made every redeem-only batch closable at once). With the pot rolled forward and `minValue`, an
   early close only forwards the deposits. The call names the open batch's id
   (`WrongBatch` otherwise, so a closer whose batch already left never pays for the next one) and the
   least total of deposits it will pay to send (`BatchTooSmall` otherwise, so a cancel landing first
   cannot leave it paying for less). The batch's fee pot pays the bridge fee first and the caller's
   value only the rest; the caller gets back the value the pot did not need, and the pot's remainder
   rolls into the next batch's pot (`potCarried`), never to the caller. An empty batch just restarts
   its timer and refunds the value, whatever `minValue`. When the redeem list is full, the next
   `requestRedeem` closes the batch itself on the pot alone and lands in the new batch, so junk
   requests cost the spammer a fee per slot and cannot block exits. If the pot is short of the fee,
   that request reverts `InsufficientFee`; the full batch can close at once, so the requester closes it
   with a top-up and requests again (see [Operator notes](#operator-notes)). The owner may sweep the
   carried remainder, and only it, to the immutable treasury (`sweepPot`): never a batch's own request
   fees, which pay for its close, and never the pre-paid credits.
4. The batch crosses on CCIP. On Bittensor the adapter converts the token to native TAO and calls
   the vault's `onBridgeMessage`. The vault fixes one price for the whole batch, mints shares for
   each deposit, then burns shares for each redeem request, clipped to what the user holds, to
   2,000 TAO per entry, and to the smaller of the front door's daily allowance and the global one
   all doors share (Task 17). Whatever is clipped is not burned:
   the user keeps those shares and can request again. Since R4 (B-H1) a door burns only shares held a
   day: the shares a door's deposit or a direct deposit minted for the holder in its last run of
   mints (`freshShares`, the lens serves it) are held until a day after the run's clock, the
   share-weighted mean of its mints' times (S-L3: a stranger's gift moves it by its share alone), so a
   deposit and a redeem in one batch burn nothing (`RedeemDeferred`, no allowance taken); a cancel's
   re-mint and the reward cut are never held, nor is `redeemDirect`, which lowers the holder's fresh
   shares to the balance it leaves (R6 A), so a share gone on Bittensor never weighs in a later mint's
   clock and repeated one-block round trips cannot shorten a later deposit's hold. Since R4 (S-H1) no
   door redeem burns while the primary bridge's `canSendPayouts()` is false (ForeverMoney's migration
   notice or pause), and since R6 (D) while the vault has its primary disabled (a batch delivered
   through another enabled bridge in a half-switched replacement): each is deferred, so nothing is
   burned into a payout queue that could not be paid; deposits still mint and direct exits are
   unaffected. A bounce in such a delivery still queues behind the closed rail, and a deferral drops
   the request, so its holder asks again and pays the fee again. Under ForeverMoney's pause a
   redeem-only batch carries nothing to convert, so it is delivered and its redeems dropped, while a
   batch with any deposit fails its conversion and parks whole, redeems kept, until after the pause;
   under a disabled primary a mixed batch's redeems are dropped too (Fable's whole-system review, I-2). And (S-L1) a redeem clipped to the entry limit or the
   day's allowance leaves its holder 0 or at least 0.03 TAO, never shares no door burns. A stated residual (merge 7b):
   an owner's cancel re-mints each entry its owed value at the cancel's price, rounded down, so an entry owed exactly
   0.03 TAO can come back worth just under it, which every door then defers. It is tiny (under 0.03 TAO), arises only
   after an owner's cancel, and stays with its holder (`redeemDirect` pays any amount; a price rise or another deposit
   lifts it back over the minimum). Revisit before other people's money. A redeem worth less than 0.03 TAO
   (`MIN_REDEEM_VALUE`) after clipping is not burned at all (`RedeemDeferred`): its share of the
   payout fee could take more than half of it. Each burn's payout is reserved and queued.
   If the vault is insolvent (share price below half the launch price), deposits are not minted:
   each is bounced, queued ahead of the batch's redeems as a payout of its TAO with 0 shares
   (`DepositBounced`, reason `Insolvent`), and comes back to the user on Base like any payout.
   At a supply of 0 that line cannot trip, and an underwater vault (a queued payout short of its
   TAO by more than 1,000 rao) refuses the whole batch instead (`VaultInsolvent`, v3.2): a bounce's
   TAO, reserved, would fill the hole for the older payout, and no redeem can burn at a supply of
   0. The Bittensor adapter parks the batch (Task 25) until the reservation is whole again.
   Origin by chain (Task 18, spec §3.4): a deposit for an address of redeem origin 0 mints and sets
   its origin to the door's chain; one for an address of the door's chain, or of `DIRECT_ORIGIN`,
   mints and leaves it; one for an address whose origin is another chain bounces the same way
   (reason `ForeignOrigin`), so a door never hands shares to whoever controls that address on its
   own chain. A redeem is burned only for an address whose origin is the door's chain; any other is
   skipped (`RedeemSkipped`: nothing burned, nothing queued; its request fee is spent). While stake is missing
   (`stakeMissing()`: more than max(0.1% of the booked stake less the queued payouts, 0.001 TAO) of
   the booked stake is off the listed hotkeys, as after a validator's hotkey swap; since R6's E-fix
   the bps part is of the stake that still backs shares, a door redeem's payout staying staked until
   it is sent) the vault refuses the whole batch (`StakeMissing`), since its
   deposits would mint and its redeems burn at a price lowered by stake that is still the holders'.
   On v3.1 that failed the adapter's `ccipReceive`, leaving the message in CCIP `FAILURE`; since
   Task 25 the adapter parks the batch's converted TAO, and it is delivered once the hotkey is
   listed (Task 26). The vault stores only a
   running hash of the queue; the keeper resubmits the list from the `DepositBounced` and
   `Redeemed` events, in log order. No single entry can make a batch revert. Delivery never stakes
   and never claims rewards.
5. Later, the keeper calls `stakeIdle` to stake the liquid TAO that is not reserved for payouts.
   That stake ramps into the front doors' daily allowance base over the next 24 hours.

### Payout leg (Bittensor to Base)

1. Once `payoutDelay` (24 hours) has passed, anyone calls `processPayouts` with the batch's full
   list. Only the keeper chooses the chunk size, and a keeper request below 10 entries (`minChunk`)
   is raised to 10; anyone else's call sends the largest chunk that fits (up to 50 entries,
   `MAX_ENTRIES`). A tail of fewer than 10 entries that would be left behind is folded into the
   chunk when the whole still fits, so a short tail does not pay a message fee alone. A chunk stays
   within 4,000 TAO, except that it always takes at least one entry. The vault quotes the bridge
   fee, rounded up to whole rao, and runs the fee valve (Task 21, spec §3.3): the chunk's users are
   charged at most the fee ceiling, the larger of 1% of the chunk and 0.015 TAO at launch
   (`maxFeeBps`, `maxFeeAbs`), and any fee above it is the caller's to pay with the call's value
   (`processPayouts` is payable; the value must be whole rao, else `BadValue`). Without that top-up
   the call reverts `FeeTooHigh` and the batch waits, for fees to fall or for anyone to top it up;
   the rest of the caller's value comes back to it as the call's last step, and none of it ever
   counts as the chunk's liquidity. Each user pays a pro-rata share of what is charged, in TAO,
   rounded against the user and down to whole rao. A bounced deposit left with nothing is recorded
   as dust (`PayoutDust`) and its value stays in the vault; an entry with shares left with nothing
   reverts the chunk `FeeTooHigh` instead (unreachable under the bounds: every burned exit is at
   least 0.03 TAO, twice the ceiling's 0.015 TAO top). When nothing is sent, no fee is paid and the
   caller's whole value comes back. The vault unstakes what the chunk needs beyond
   the liquid TAO above `ED_RESERVE` and the other batches' reservations (read once, before the
   walk), plus 1,000 rao, plus the owner's `unstakeMarginRao` (0 by default, and best left there: it
   moves no fee since Task 36b), and sends the chunk through the primary bridge. The shortfall rule
   (Task 19, spec §3.3) and the leaver pays (Task 36b, the founder's ruling of 2026-11-06): the walk
   counts the stake it takes at face value and may leave at most 1,000 rao
   (`SHORTFALL_TOLERANCE_RAO`) of its request untaken, else `UnstakeShort` and the batch waits; what
   the chain keeps of that stake (its removal fee; root unstaking is fee-free today) is the chunk's own
   cost, which its entries bear pro rata with their share of the bridge fee, a bounce included, each
   share rounded up and each net floored to rao (`PayoutChunkSent.unstakeCost`), never the holders or
   the caller. A cost that would leave an entry nothing reverts the chunk `FeeTooHigh` (a chain fee
   of at least 0.00375 TAO a removal for the smallest entry); it is paid once liquid TAO covers it
   without a walk (deposits net the queued payouts, or the idle buffer), or the owner cancels it. The
   chunk is paid from that liquidity and its own receipts, never from `ED_RESERVE` or another
   batch's reservation (`finish` checks it); the 1,000 rao asked on top covers the second split's
   rounding and stays idle for `stakeIdle`, except in one corner under a chain fee. The walk stops
   once at most 1,000 rao is unmet, whether or not other positions remain, so when it ends after a
   whole removal with less than a rao an entry of that cushion left, the second split's rounding can
   leave the entries a few rao more than the receipts. That chunk refuses `UnstakeShort`, even with
   other positions holding plenty, and nothing is lost; it clears on its own once the balance or the
   positions move by more than a few rao (a deposit, an exit, a stake or a reward usually does).
   Under a root hold the walk skips a held pair (`UnstakeSkipped`) and takes the chunk from the next
   position; with every pair held the chunk is paid only from liquid TAO, which the idle buffer keeps
   (`idleBufferBps`, see [Operator notes](#operator-notes)), else it reverts `UnstakeShort` and waits.
   A batch whose front door has been removed is refused (`FrontDoorInactive`).
2. The adapters deliver ForeverMoney's TAO plus the payout list to the front door, which credits
   each user. Incoming payouts are accepted even while the front door is paused.
3. The user calls `claim` on Base, and the app swaps to USDC. Credited TAO earns nothing while it
   waits, so claim promptly.

End to end, a withdrawal through the front door takes about two days: the batch interval, the
24-hour delay, and the bridge.

### Direct access (on Bittensor EVM)

- `depositDirect` takes whole-rao TAO, at least `minDirectDeposit`, while the vault's assets stay
  within `maxTotalAssets`, and mints shares at once. It reverts `StakeMissing` while stake is
  missing (see the delivery leg). It also sets the address's redeem origin to `DIRECT_ORIGIN`
  (every direct deposit, whatever it was): no front door burns for it, and a door's deposit for it
  still mints, until the address names a chain again.
- `setRedeemOrigin(chain)` sets the caller's redeem origin (Task 18): any chain with an active
  front door now (`activeDoors(chain) > 0`), whose doors then burn its shares and only theirs, or
  `DIRECT_ORIGIN`; any other chain, chain 0 included, reverts `UnknownOrigin` (`RedeemOriginSet`).
  An address whose only shares came from the reward cut has origin 0, which honest doors skip and a
  rogue door can claim (see the treasury note under [the reward cut](#v3-trust-model)): the treasury
  sets `DIRECT_ORIGIN` right after deploy and uses `redeemDirect`. A door's removal changes no origin; an address of
  a chain left without a door sets another, or redeems directly.
- `redeemDirect(shares, acceptMissing)` burns the shares, unstakes any shortfall and pays the caller
  at once. It has no outflow cap: the share owner signs on this chain, and it costs other holders
  nothing: the leaver pays every cost of its exit (Task 36b, below). **Simulate it first**
  (`eth_call` from the holder's address): the walk runs in the same call, so the simulation returns
  the exact payment (`RedeemedDirect.assets`) at that state, the chain's removal fee included (none
  today); nothing on-chain previews it otherwise. While stake is
  missing it reverts `StakeMissing` unless `acceptMissing` is true: the caller's consent to be paid
  at min(visible, booked), the floor price, which may underpay the leaver and never the stayers.
  `RedeemedDirect`'s `acceptedMissing` is true only when the exit was priced while stake was
  missing. The web never passes `true`.
- The shortfall rule and the leaver pays (Task 19, Task 36b, spec §3.3, I-13, I-35): `redeemDirect`
  reads the liquid TAO above `ED_RESERVE` and the queued payouts once, before the walk, and unstakes
  only what that does not cover; it never pays from `ED_RESERVE` or a payout's reservation, and never
  counts a reservation that is still staked as cover. The walk counts the stake it takes at face value
  and stops once what is unmet is within 1,000 rao (`SHORTFALL_TOLERANCE_RAO`), so a removal fee never
  sends it to a further position. The leaver bears its exit's whole cost: what is unmet and what the
  chain kept of the stake the walk took (its removal fee, every removal's, rounded up to rao), paid
  the exit's value less both, floored to rao, with `ShortfallAbsorbed(amount)` (in wei, the two
  together) logged before `RedeemedDirect`, whose `assets` is what was paid. The holders who stay pay
  nothing for it, at any fee and any `unstakeMarginRao` (which no longer moves a fee: leave it 0). An
  exit that would be paid nothing (one worth at most 1,000 rao with nothing liquid, or one whose walk's
  cost eats it) reverts `ZeroAmount` and keeps its shares: refused, never subsidised. More than 1,000
  rao left untaken (the stake out of reach) reverts `UnstakeShort`. There is no minimum exit: one
  served from liquid TAO costs nobody anything, and one that walks pays the chain's fee itself.
- Under a root hold (Task 20, spec §3.8) the walk skips each held pair (`UnstakeSkipped`) and takes
  the exit from the next position, so one held pair no longer freezes `redeemDirect`; with every pair
  held only liquid TAO, which the idle buffer keeps, can pay it, and an exit beyond it reverts
  `UnstakeShort` until a hold lifts. v3.1 bubbled the chain's refusal, so one held pair froze every
  exit that needed an unstake.
- `depositDirect` and `redeemDirect` refuse while the vault is paused; `setRedeemOrigin` works while
  paused (it moves nothing, and deliveries revert while paused anyway). See
  [Who can use direct access](#who-can-use-direct-access).

### Where the ledger meets the chain (v3.2, Task 16)

- `adoptStake` books the surplus, the stake on the listed hotkeys above the booked stake (a gift, stake
  that came back after a write-off, or a chain-side credit that landed inside a stake: `stakeIdle`
  books at most what it staked, R2 F3), and vests it into the price on its own drip, with no cut
  (Revision 27): the adoption drip (`adoptVestingAmount`, `adoptVestingStart`, `adoptVestingPeriod`,
  served by the lens) restarts on what is left of it and the surplus, over `rewardVesting` or what is
  left of the drip if longer (the claim schedule's rule), and the claim schedule is not touched, so no
  adoption pushes rewards that holders already earned later. `unvestedRewards()` is both drips' sum,
  and the write-down at a supply of 0 covers both (the adoption drip first, then the claim schedule
  when it alone exceeds what the gross holds). The price does not step, so a deposit made just before
  gains only what vests while it is held.
  It enters the outflow allowance's base at once and leaves `lastStakeAt` and the ramp alone. The
  keeper may adopt once a day (`AdoptTooSoon`), anyone once 7 days have passed since the last
  adoption (`NotKeeper`), and only a surplus of at least the chain's minimum stake
  (`BelowMinAdoption`); while stake is missing there is no surplus, so nothing is adopted. It
  refuses while the vault is paused. `StakeAdopted(rao)`.
- `writeOffMissingStake(rao)` is the owner's, a scheduled item of the Registry class (7 days) and
  the Ordinary kind: the guardian may cancel it, and it is neither schedulable nor executable while
  the exits are closed. It lowers the booked stake by `min(rao, missing)`, and only by stake that
  is gone: the missing stake less what sits on the vault's coldkey under hotkeys it does not list
  (`WriteOffTooLarge` otherwise, the item kept), which listing could still bring back (by anyone
  while stake is missing, for a never-listed hotkey holding the chain's minimum; else by the owner,
  the guardian or the keeper). That total is read in a `try` capped at 45,000,000 gas
  (`WRITE_OFF_READ_GAS`, R6 C; 100,000 before): the chain prices this read by the coldkey's
  positions (runtime 490: 1,875 + 1,250 per hotkey + 1,250 per position + 12,500 per root position),
  which a stranger can add under the vault's own hotkeys for 0.0001 TAO each and the vault can never
  remove, so about 67 of them priced the old cap out for good; 45M is the most any coldkey's read can
  cost today (256 hotkeys on 128 subnets and root). A failed read counts as 0, so the bound is lost
  if the precompile function ever goes, or a later runtime raises the metering past the cap, which
  the 7-day notice and the veto cover. The execute needs about a 46.5M-gas transaction (46,479,084
  measured over the mocks), under Bittensor's 64,998,400: ops sends it with an explicit gas limit,
  not the wallet's estimate. The read is always given its whole cap (Revision 28's gas audit): with less
  gas left than the cap's 64/63 and a margin, the write-off reverts `InsufficientGas` (the item
  kept), so no gas limit, a wallet's estimate included, can starve the read into that 0. The price already reads min(visible, booked), so a write-off never moves it;
  once nothing is missing it reopens minting at that price. `StakeWrittenOff(rao)`.

## Roles

Routine calls and who makes them:

| Call | Who | Fallback |
|---|---|---|
| `closeBatch` (Base) | anyone; the keeper in practice | — |
| `processPayouts` (Bittensor) | anyone; the keeper in practice, and only the keeper chooses the chunk size | — |
| `stakeIdle` | keeper | anyone, once 7 days have passed since the last stake (or the deploy) |
| `claimRewards(hotkey)` | keeper | anyone, once 7 days have passed since that hotkey's last claim (or since it was first added) |
| `adoptStake` (v3.2) | keeper, at most once a day | anyone, once 7 days have passed since the last adoption (or the deploy) |
| CCIP re-execution | anyone | — |

- **Deposit-leg fee:** the CCIP fee in ETH, paid from the batch's redeem-request pot first and then
  by whoever calls `closeBatch`, who gets back the value the pot did not need; the pot's remainder
  rolls into the next batch's pot (v3.2; v3.1 paid it to the caller), and the owner may sweep it to
  the treasury (`sweepPot`). With no redeem requests it is an operator cost of about $1.5–11 per
  batch, depending on size and the delivery gas bought.
- **Payout-leg fee:** the CCIP fee in native TAO, deducted from the chunk pro-rata up to the fee
  ceiling. The caller fronts gas (about $1.4–4 per `processPayouts` at the chain's 5-gwei
  floor), and, only when the fee is above the ceiling, the excess as the call's value (the fee
  valve; the rest of the value is refunded).
- There are no other fees to users.
- The keeper times reward claims and staking and may add a hotkey to the set; it cannot move funds.
  Timing does shift a little value between leavers and stayers. Rewards count in the price only
  after a claim, and then vest linearly over the vesting period (7 days at launch), so someone who
  leaves forgoes rewards that are still unclaimed or vesting. With weekly claims the unclaimed part
  is at most about a week of yield (about 0.1%).
- `setKeeper(address(0))` is allowed and leaves only the 7-day fallback.
- Both fallbacks start counting at once, so only the keeper can act in the first 7 days: the stake
  fallback from deploy, and each hotkey's claim fallback from deploy (the constructor hotkey) or
  from when the hotkey is first added (`addHotkey`; `setStakeHotkey` names a listed hotkey only, v3.2).
  A removed and re-added hotkey keeps its last claim time.

Other roles:

- **Owner:** at launch (v3.2-launch), a single hardware-wallet account; its changes that loosen a
  protective limit wait in the owner scheduler (48 hours, 7 days or 8 days), and a Safe as owner is
  recommended before Cascade takes other people's money (see
  [Launch configuration](#launch-configuration-v32-launch)). Proposes and activates front
  doors and bridges, sets the primary bridge, keeper, hotkeys and limits, replaces the guardian
  (`proposeGuardian`, then `acceptGuardian` 8 days later; only the owner can
  `cancelGuardianProposal`), cancels payout batches, and unpauses.
- **Guardian:** a fast, low-trust key that can only stop flows: `pause`, `removeFrontDoor`,
  `disableBridge`, `cancelBridgeProposal` and `cancelFrontDoorProposal`. It can also `addHotkey`,
  which only widens the stake the price reads, and (v3.2) `removeHotkey` of a hotkey with no stake and
  no more than `hotkeyDustRao` unclaimed. It stays in office for 8 days after the owner
  proposes its replacement, longer than the 7-day registry delay, so it can still veto anything
  proposed alongside.
- **Keeper:** times `stakeIdle` and `claimRewards` (above), chooses the payout chunk size, and can
  `addHotkey` and (v3.2) `removeHotkey` as the guardian can.
- **Everyone else:** deposits, redeem requests, cancels, closes, payouts, claims and direct access.

The keeper bot is a separate deliverable. Hosted keeper services are gone (Chainlink Automation,
Gelato Web3 Functions and OpenZeppelin Defender all shut down in 2026), so it is a self-hosted bot
on both chains with its keys in OpenZeppelin Relayer or a cloud KMS. It needs an archive or paid
RPC: the public lite RPC drops state after about 300 blocks, and payout lists are rebuilt from
events. Its jobs: close batches after checking the pools' rate-limit allowance and the live
staking floor (`getDefaultMinStake()`; the adapters size delivery gas to the entry count
themselves); report failed deliveries (at launch it never re-executes one on its own: the founder
runs `pnpm ops reexec`, with `gasLimitOverride` when a delivery ran out of gas, operator note 18);
run `processPayouts` after the delay; run `stakeIdle` on a schedule;
run `claimRewards` weekly after an `eth_call` pre-check (expected delta, no `RootClaimTooHeavy`);
watch the validators for hotkey swaps and drops in the vault's stake (re-add the hotkey with
`addHotkey` and alert the guardian); watch `getPrecompileStatus` for the staking precompile; and
run the contracts' precompile calls against each Bittensor pre-release (on testnet 945, which the
launch's own rehearsal no longer uses: its live checks are the mainnet canary's).

## Exit safety

A front door speaks for its users: a `BATCH` from it burns the named users' shares, and the TAO is
owed to that front door. So whoever gets an address registered as a front door, or controls an
enabled adapter, could submit redeem-only batches naming every holder. The vault bounds this.

The honest statement, as the spec states it (kept current with the code):

> The team cannot move user funds instantly; any front door or bridge added after deployment is
> announced on-chain seven days ahead and the guardian can veto it; a compromised front door can burn at most about 20%
> of the vault per 24-hour window in redemptions, and since the windows are fixed, not rolling, about 40% within
> seconds across a window's reset (per registered front door, and all doors together, never
> less than `minDailyOutflow` a window: 10 TAO at launch, bounded to 10 to 100 TAO), nothing it burned
> can be paid out for 24 hours, the guardian can hold those payouts at once, and the owner can then
> cancel the batch and return the value burned (never more shares than were burned; Task 34c).
> Outside the contract, ForeverMoney's signers, Chainlink's lane configuration and Bittensor's sudo
> key can stop or change the rails with no delay.

"About 20% of the vault" is measured on the vault's root stake that has ramped in: stake that
`stakeIdle` added counts linearly over the 24 hours after it, and liquid TAO never counts. So neither
a batch's own deposits, nor capital delivered or deposited earlier and taken back within a day, can
raise it (see the soft spots below).

The four layers:

1. **Registry changes are slow, visible and vetoable.** A new front door or bridge can be activated
   only 7 days after it is proposed on-chain (the ones named at deployment are active at once); the
   guardian or owner can cancel a proposal, remove a front door or disable a bridge at once. The guardian itself can be replaced only 8 days after the
   owner proposes it, so it outlasts any registry proposal made alongside.
2. **Burns are capped per front door, and across all doors, at delivery.** Each front door may burn
   at most `max(maxDailyOutflowBps of the ramped-in root stake, minDailyOutflow)` per fixed 24-hour
   window, and all doors together at most `max(globalOutflowBps of it, minDailyOutflow)` in the
   global window (Task 17: the floor is shared, one for all doors; at launch 20%, 20% and 10 TAO, so
   a second door adds no allowance); requests beyond either are deferred and the users keep their
   shares.
3. **Payouts wait, and stop the moment a front door is removed.** Nothing burned can leave for 24
   hours, `processPayouts` refuses a removed front door's batches, and the owner can then
   `cancelPayoutBatch`, which re-mints every unsent redeem the value it was owed, never more shares
   than it burned, and carries the batch's unsent bounced deposits forward, still owed (a batch of
   bounces alone reverts `NothingToCancel`). So the holders a rogue door burned get back the value
   at burn time: the vault's rewards over the hold go to the holders who stayed, and after a fall
   the burned holders get their shares back.
4. **Pause holds the money flows:** deliveries, payouts, staking, and direct deposits and redeems
   on Bittensor; deposits and USDC deliveries on Base. It never blocks an exit on Base (v3.2, spec
   §3.5, I-20: redeem requests, cancels, closes, claims and incoming payouts all run while the front
   door is paused, a deposit's cancel once five minutes have passed since the user's last deposit, R11),
   nor reward claims or payout-batch cancels, and the owner's stake management
   (`moveStake`, `removeHotkey`), `addHotkey` and `creditRedeemFee` also run while paused. What holds
   a batch on Base is the primary bridge's disable (`PrimaryBridgeDisabled` on every close).

Soft spots:

- **The allowance base trusts capital that stays a day.** The base is the vault's root stake, at
  most the stake the vault has booked, less what is still ramping in (each stake re-spreads what is
  still ramping, plus what it adds, linearly over the next 24 hours, like reward vesting). Liquid TAO
  never counts: a delivery's deposits, an earlier delivery's, a direct deposit, payouts reserved in
  the balance. So borrowed or short-lived capital cannot raise the base: unstakes come off the ramp
  first, so fresh stake can stand in for stake that leaves during its ramp; the base never exceeds
  what it would be had that stake stayed. Measured: a rogue adapter
  that delivers 4,000 TAO of its own as a deposit-only batch, then a redeem batch naming a
  1,000-TAO holder, burns that holder for 200 TAO, not 1,000, whether in the same transaction (the
  adapter then takes its 4,000 back with `redeemDirect`), a block later, or a block after the keeper
  staked the 4,000 (about 200.1 TAO). The ramp applies whoever calls `stakeIdle` (the keeper, or
  anyone after `KEEPER_FALLBACK`), so a stolen keeper key cannot shortcut it. Stake can also rise
  without `stakeIdle`: another coldkey can move stake onto the vault's hotkeys. The booked-stake cap
  keeps it out (v3.2, Tasks 12 and 16): `stakeIdle` books only what it measured landing on the stake
  hotkey, at most what it staked (R2 F3); a reward claim books the visible stake's rise; an unstake
  takes the stake that left off the booked stake and what it received off what is ramping. A gift is
  never booked by a stake: it stays a surplus (`surplusStakeRao()`), outside the price and the base,
  until `adoptStake` books it (the keeper's, at most once a day, a surplus of at least the chain's
  minimum stake), which vests it into the price on its own drip, with no cut (over `rewardVesting`,
  or what is left of the running adoption drip if longer; the claim schedule is not touched, Revision
  27), and puts it in the base at once, with no ramp: a gift cannot be taken back but through the shares, so it is not the
  borrowed capital the ramp is for, and a giver gets it back only by holding through the vesting.
  Capital cycled through the keeper (deposit, the keeper stakes it, redeem directly) nets to nothing
  (measured: 20 TAO cycled every minute for 12 hours leaves the base where it was).
  Capital that stays staked raises the base as it ramps in: half after 12 hours, all after 24. To
  the vault that is a holder like any other, and a percentage cap cannot tell them apart; the
  backstop is unchanged (the 24-hour payout delay, the guardian's hold and the owner's cancel).
  Flagged for the auditor.
- **New stake counts over a day, or more slowly.** The cost to honest users: deposits count in the
  base only as they ramp in after the keeper stakes them, so a new vault, or one that grew fast, has
  a lower allowance for a while (never below `minDailyOutflow`). Because every stake re-spreads what
  is still ramping, frequent stakes (the ops keeper stakes whenever TAO is idle, and anyone can make
  it stake with a small direct deposit) turn the linear day into an exponential with a one-day time
  constant: about 63% counts after a day, 86% after two, 95% after three (measured: a 0.01-TAO
  direct deposit every minute leaves a 1,000-TAO stake about 64% counted after a day). That is the
  slowest it can get, and it never lets stake count sooner. Keeping each stake's own schedule needs
  per-stake state the vault has no bytes for, and a single weighted schedule would let parked capital
  count faster than a day, so it is left conservative. A keeper that stops staking leaves the base at
  what has ramped in; anyone may stake after `KEEPER_FALLBACK`.
- **A gift the walk takes out leaves a surplus until `adoptStake`.** An exit is priced without an
  unadopted gift, and the walk's debit is the stake that left each position, off the booked stake,
  floored at 0 (spec §3.1, M-2), so a full removal of a gifted position debits the gift too. Where the
  ledger holds less than that debit, the excess arrived as liquid balance and is priced at once.
  Where it holds more (the usual case, in a vault with other stake), the gift's rao come off real
  booked stake instead and an equal surplus stays on the remaining positions: the price does not
  move, but the allowance base sits that much lower until `adoptStake` books the surplus (vested,
  with no cut), and a residue below the chain's minimum stake (0.002 TAO) is never adoptable alone:
  it waits for a larger surplus. `stakeIdle` books only its own stake and restores nothing (v3.1's stake
  re-booked the root stake it found; v3.2's does not). Stake the hotkey set does not show (a swapped
  hotkey not yet re-added) is not a base question: it is missing stake, which closes mints until the
  hotkey is listed (`addHotkey`, by anyone while stake is missing), and no stake or adoption re-books
  it. Exits stay open at the floor and through `redeemDirect`; it takes nothing.
- **Dust cannot leave through a front door.** A holder whose shares are worth less than 0.03 TAO,
  or whose request the window's last sliver of allowance would clip below 0.03 TAO, is deferred
  (`RedeemDeferred`) and keeps the shares; `redeemDirect` pays any amount. Why 0.03 TAO (Task 21,
  spec §3.3): the entries of a chunk are charged at most the fee ceiling, whose absolute part is at
  most `MAX_FEE_ABS` = `MIN_REDEEM_VALUE` / 2 = 0.015 TAO, so an exit with shares keeps at least
  half its value at any setting (I-14), well above the Bittensor adapter's conversion floor
  (`getDefaultMinStake()`, 0.002 TAO today); a fee above the ceiling is topped up by the caller,
  never charged to the entries. The minimum (`MIN_REDEEM_VALUE`) is a constant: it does not follow a
  floor the root key raises (a raise past 0.015 TAO brings the stall back for entries near the
  minimum). The web app forces "withdraw all" when a remainder would be worth less than 0.03 TAO,
  says a remainder just above it can fall below by delivery if the price drops (that entry is then
  deferred and the user requests again), and asks for a little more than the minimum, since the vault
  values a request at the batch's price, rounded down.
- **First come, first served.** A front door's allowance goes to redeems in delivery order, so one
  large holder can take a door's whole window, and the global window goes to the doors in the
  order their batches arrive, so one door's exits can fill it for the others (Task 17: that is its
  price). Deferred users must request again and pay the redeem-request fee again.
- **Earlier unpaid burns can count again.** Payouts reserved in the liquid balance do not count in
  the base, but value burned and not yet paid out that is still staked (when the balance does not
  cover the queue, which `processPayouts` then unstakes) counts in the next window's base.
- **Windows are fixed, not rolling.** A rogue front door can burn a full allowance just before its
  window ends and another just after, about 2× in a short span (`VaultDelivery.test_claimF_...`: 399
  TAO of a 200 TAO allowance in one second). So a compromised lane that forges burns loses up to two
  allowances in one payout delay, not one, if the guardian answers only at the first lost payout;
  answered when the forged delivery lands, both are still queued. A leaky bucket is queued for before
  other people's money (spec section 5's list).
- **A rogue adapter gets the global allowance.** Any enabled adapter can present any registered
  front door: two during a migration, more if Robinhood Chain is added. Since Task 17 (spec §3.4)
  the global window caps all doors together, so presenting more doors adds nothing past
  `globalOutflowBps` of the base a window; the cost is that one door's honest exits can defer
  another's users until the window resets.
- **The backstop needs people.** Beyond the allowance, protection depends on the guardian removing
  the front door (or disabling the adapter) within the 24-hour delay, and on the owner then
  cancelling the batch. Otherwise the loss is bounded by the allowance each window, for as long as
  nobody acts.
- **A cancel does not restore the burn windows,** neither the front door's nor, since Task 17, the
  global one all doors share, so honest requests through every front door may be deferred until the
  global window resets (and through that door until its own window does).
- **Chunk size is the keeper's call.** `processPayouts` is permissionless, but only the keeper's
  `maxEntries` counts: anyone else sends the largest chunk that fits, so a stranger cannot split a
  batch into many fee-paying messages. A stolen keeper key could still send `minChunk`-sized
  chunks, and a tail that would push a chunk over `maxMessageValue` still goes alone. Each extra
  message costs its users at most the fee ceiling.
- **Vesting follows the keeper's rounds.** Each claim re-spreads what is still unvested of the
  claim schedule plus the new reward over the vesting period (`rewardVesting`, 30 days at launch), so
  the keeper claims every listed hotkey with stake in the same round, rounds no further apart than
  `rewardVesting` (a little before the schedule ends, at 29 days). That is I-38's precondition, and it
  is the keeper's and the chain's to keep (R6b U2): a hotkey claimed apart from the others re-spreads
  their rewards; one the keeper's cost rule skips, or whose claims the chain refuses, for longer than
  the period brings a backlog that vests over one period, above its accrual, which an entrant who
  times it shares. Before such a backlog claim the owner can stop new entrants for that period
  (tighten `maxTotalAssets` and the door's cap, both immediate); the monitor's `rewards.uncollected`
  is the trigger. An adoption vests on its own drip and never re-spreads the claimed rewards
  (Revision 27).
- **The claim fallback is permissionless, but not mid-schedule.** If the keeper lapses for 7 days,
  anyone may claim a hotkey's rewards and so choose when its validator basket is sold into root
  stake, but only once the claim schedule holds nothing still vesting (R6b U1: before, a stranger's
  claim of one small hotkey mid-schedule re-spread the rest of the month's rewards past their end,
  up to about a quarter); until then the rewards stay owed on chain (`NotKeeper`). Two edges, neither
  at launch: with the keeper, the guardian and the owner all gone and the set full, a stranger freeing
  a slot must first claim that hotkey to 0, which can wait for the schedule's end; and in that case a
  griefer can keep the window shut by claiming a dust hotkey each time the schedule ends (`setKeeper`
  is immediate). Stated plainly (the R6b review's Low-4, no change): with no keeper, the permissionless
  claim allows one stranger claim per vesting period, since the first restarts the schedule and every
  other hotkey then waits for its end (`NotKeeper`); the rewards stay owed on chain, and the owner's
  `setKeeper` restores the keeper at once. Do not let the keeper lapse.
- **The limits are owner parameters, within hard bounds.** They change without the 7-day registry
  delay, behind only the owner's timelock (an operational setting; none at launch, so they take
  effect at once), but the code bounds each one, so even a captured owner cannot loosen layers 2 and
  3 past these bounds (I-23: no setter reaches a value outside its bounds, and a tightening within
  them is never refused). The exit limits are bounded on both sides, so none of them freezes an exit:
  the outflow limits since Task 17; the fee ceiling since Task 21 (its absolute part is at least 0.01
  TAO, `MIN_FEE_ABS`, and any fee above the ceiling can be topped up by whoever calls
  `processPayouts`, so no fee setting holds a chunk); and since Task 23 the entry limit (at least 10
  TAO, `MIN_ENTRY_VALUE`, where v3.1's `maxEntryValue` of 0 deferred every front-door redeem) and the
  payout delay (at most 48 hours). The owner holds exits closed only with its instruments (`pause`, a
  door's removal, a bridge's disable), which stamp its clock.

  | Setter | Bound in the code | Why this bound |
  |---|---|---|
  | `setOutflowLimits(bps, minDaily, globalBps)` | each door's and all doors' percentages 20% to 50% of the base a day; the floor they share 10 to 100 TAO | A rogue front door, or every door at once, takes at most half the base a window; the 20% launch value is the lower bound (spec §3.4), so no setting can freeze an exit, and a floor below 10 TAO would be an exit delay the owner sets without a stamp (round 5's L-4). Any value up is scheduled, none up applies at once; `OutflowLimitsSet` logs the three. |
  | `setPayoutDelay` | 1 hour to 48 hours (`MIN_PAYOUT_DELAY`, `MAX_PAYOUT_DELAY`; Task 23, where v3.1 allowed 7 days) | The delay is the guardian's window to hold a rogue batch; 1 hour is what the test cadence uses. At most 48 hours, so no setting holds every honest front-door exit for days. A launch build may want a higher floor (12 hours or more), a code change that the test cadence would then have to follow. |
  | `setFeeLimits` | at most 5% of a chunk; the absolute part 0.01 to 0.015 TAO (`MIN_FEE_ABS` to `MAX_FEE_ABS` = `MIN_REDEEM_VALUE` / 2) | What the primary adapter can quote, and keep, out of a chunk's users per chunk (the live fee is about 0.001 TAO); at most half the smallest burned exit, so an exit with shares is never left with nothing. The floor keeps a low ceiling from being a freeze instrument (spec §3.6): a fee above the ceiling is the caller's to top up. Up is scheduled; down applies at once. |
  | `setMessageLimits` | `maxEntryValue` 10 TAO (`MIN_ENTRY_VALUE`) to `maxMessageValue`; `maxMessageValue` at most 5,000 TAO and at most the primary bridge's `maxMessageValue()` (`AboveBridgeCap`); `minChunk` 1 to 50 (`MAX_ENTRIES`) | The lane's per-message limit (the adapters' `MAX_MESSAGE_VALUE`): above it chunks are unsendable, and so above the primary adapter's own deployed cap, which the constructor, this setter and `setPrimaryBridge` read (spec §3.9, Task 23; a bridge with a smaller cap becomes primary once the owner has tightened to it). The 10 TAO floor (the launch value) keeps a low entry limit from deferring every front-door redeem. |
  | `setClaimGasRequired` | 54,100,000 to 63,400,000 gas (`MIN_CLAIM_GAS` to `MAX_CLAIM_GAS`, both served by the lens; Task 23, the top raised from 60,000,000 at Task 65, the floor from 53,200,000 at R5) | The gas a claim needs left before it calls the precompile: at least 54.1M, so that the call, which forwards 63/64 of what is left, gives the precompile the 53.2M a `claimRootWithHotkey` takes (section 2's figure; no fork can run the claim, so the mainnet canary measures a real one): no setting lets a claim start short and burn its gas; at most the most whose claim still fits Bittensor's per-transaction limit, about 65,000,000 (75% of the block less 10% for initialization), with the claim's own overhead (218,947 measured at its dearest, four hotkeys and the treasury's first cut; 500,000 allowed) and a 1,000,000 margin, so the owner can raise it at once should a real claim need more (`VaultClaimGas.t.sol`). The live headroom runs from 54.1M to 63.4M left, about 53.25M to 62.4M forwarded: a claim that needs more than that can be met by no setting. Immediate both ways within the bounds: it decides only whether a claim starts. |
  | `setHotkeyDustRao` | at most `type(uint256).max / 1e9` (`MAX_HOTKEY_DUST_RAO`; Task 23) | Every removal path computes `hotkeyDustRao * RAO`; the bound keeps that product within a word, so no owner value can make a removal panic, the stranger's removal of an empty hotkey (the way back after a validator's swap, I-6) among them. An overflow bound, not an economic one: forfeited rewards stay claimable after re-adding the hotkey. |
  | `setUnstakeMarginRao` | at most 1 TAO per removal | A huge margin turns every exit into a full unstake and re-stake, which also ramps back into the allowance base. |
  | `setUnstakeGas` | 150,000 to 5,000,000 gas | The least each removal of the unstake walk is forwarded (Task 20). Below the bound a real removal could starve and be skipped; above it the floor alone, which a removal gets even when its share is smaller, could eat into `EXIT_GAS_RESERVE` for an exit sent with ordinary gas. Within it the walk still tries every position, so it is no instrument (spec §3.6): immediate both ways. The reserve holds while each share exceeds the floor, so callers send at least `EXIT_GAS_RESERVE` + positions × `unstakeGas` + the exit's work (operator note 13). |
  | `setIdleBuffer` | at most 1,000 bps (10% of the booked stake) | The buffer is stake not earning; 10% with the `minDailyOutflow` floor covers a day's exits at the launch size. An increase applies at once (more liquid for exits); a decrease is scheduled (48 hours, guardian-cancellable). |
  | `setRedeemRequestFee` (front door, and its constructor) | at most 0.001 ETH | Five times the launch fee (0.0002 ETH; ten times v3-launch's 0.0001 ETH): no setting can price every exit out. |
  | `setMaxBatchValue` (front door, and its constructor) | at most 5,000 TAO | A batch above the lane's limit can never be sent, and its redeems wait with it. |

  Deliberately unbounded: `maxTotalAssets` and the front door's `depositCap` (beta caps that must
  grow with the product, and since the allowance base counts only ramped-in stake, a direct deposit
  no longer feeds it); `minDeposit` and `minDirectDeposit` (they gate deposits, not exits); the front
  door's pool-depth floors, `minPoolLiquidity` (any `uint128`, 0 included, which checks nothing: a floor
  gates only the keeper's USDC sale, never a claim, and only its cut is scheduled; Task 32). The
  staking floors' fallbacks are no longer settings at all: constants since Task 23
  (`FALLBACK_MIN_STAKE_RAO`, `FALLBACK_MIN_REMAIN_RAO`), so v3.1's `setFloorFallbacks` is gone.
- **Retiring a front door fails its in-flight batches.** `removeFrontDoor` also makes that door's
  batches still crossing revert `UnknownPeer` at delivery; their deposits wait in the rail until the
  door is registered again (7 days). Drain a door before retiring it.
- **The guardian's veto holds through the registry delay, not forever.** Replacing the guardian
  takes 8 days from the owner's proposal, longer than the 7-day registry delay, and only the owner
  can cancel it. So the sitting guardian stays in office through any registry proposal made
  alongside its replacement and can veto it: a compromised owner cannot bypass that veto within the
  registry delay. After 8 days it can install its own guardian and propose again, so a rogue front
  door or bridge needs at least 15 days of public notice plus the timelock's delay, during which
  users can exit.
- **A stolen guardian key can freeze for about 15 days.** Besides pausing, it can `removeFrontDoor`
  and `disableBridge`, and while still in office it can cancel the owner's re-registration
  proposals (`cancelFrontDoorProposal`, `cancelBridgeProposal`). Front-door deposits, redeems and
  payouts can therefore stay frozen for about 15 days plus the owner's timelock (8 days to replace
  the guardian, then a 7-day registry re-proposal); direct deposits and redeems, which only a pause
  stops, for 8 days plus the timelock. It cannot cancel its own replacement. This bound holds only
  if the guardian key is NOT granted the timelock's canceller role. Without that role the guardian
  cannot veto timelocked parameter changes within their hard bounds (the outflow percentage, `payoutDelay`, the fee ceiling,
  `setStakeHotkey` / `moveStake`), which wait only for the timelock.
- **An insolvent vault bounces deposits, not exits.** If the share price falls below half the
  launch price, a front-door batch still delivers: its deposits are not minted but bounced, queued
  ahead of the batch's redeems as payouts of their TAO with 0 shares (`DepositBounced`), and its
  redeems burn at the lowered price. A bounced deposit comes back to the user on Base after the
  24-hour payout delay, less its share of the bridge fee and the rao floor, so a griefer's deposit
  cannot hold up a batch's exits. `depositDirect` reverts `VaultInsolvent` until the vault is
  recapitalised out of band (see [Operator notes](#operator-notes)); direct redeems keep working.
  With no shares outstanding the line cannot trip, so there an underwater vault refuses a batch
  whole (`VaultInsolvent`, v3.2) and the Bittensor adapter parks it: bounced, its TAO would fill
  the hole for an older queued payout, and with no shares no redeem can burn.
- **A cancel carries bounced deposits forward (v3.2, Task 22, spec §3.5).** `cancelPayoutBatch`
  re-mints each unsent redeem the value it was owed (never more shares than it burned, Task 34c)
  and keeps the batch's unsent bounced deposits (0 shares), in order, as its new list: still
  reserved, its `queuedAt` and chunk numbering kept, paid by `processPayouts` like any batch
  (`PayoutBatchCancelled(key, reminted, bouncesCarried)`; the keeper rebuilds the list as the last
  `bouncesCarried` of the batch's `DepositBounced` entries). A batch left with bounces alone cannot
  be cancelled (`NothingToCancel`, final), so a bounce's TAO goes back to its depositor, never to
  the holders (I-19). v3.1's cancel released it to the holders, and since
  Task 18 a solvent vault bounces too (`ForeignOrigin`, a deposit for another chain's holder).
- **Origin by chain (Task 18) is what makes a second chain's front door safe.** Each holder has a
  redeem origin: the chain whose doors may burn its shares (set by a door's first mint, or by the
  holder), or `DIRECT_ORIGIN`, which no door burns for. So a door on another chain neither redeems
  shares deposited through Base nor mints for a Base holder's address (that deposit bounces,
  `ForeignOrigin`), and a contract wallet's twin on another chain (see
  [Who can use direct access](#who-can-use-direct-access)) gets nothing. A second door on the same
  chain burns for the first's depositors, so a door replacement strands nobody. A stated residual,
  reachable only with two chains' doors: a stranger can pin a fresh address's origin to chain B by
  depositing for it there first, so the real user's later Base deposit bounces (back to Base after
  the payout delay); the user sets the origin from Bittensor, or uses another address. A holder
  whose origin is elsewhere who requests a redeem on Base is skipped (`RedeemSkipped`) and loses
  the request fee: the app warns before the request when it can read the origin.
- **A position below the minimum stake waits.** The unstake walk skips any hotkey whose stake is
  below the minimum stake: the chain may refuse to touch it, and that revert would block every exit.
  An exit that needs that dust (under the minimum stake per hotkey: 0.002 TAO today, the larger of
  the chain's live minimum and a constant fallback, so only a raise of the chain's `DefaultMinStake`
  moves it; no owner setting does since Task 23) reverts `UnstakeShort` until the position is
  cleared, unless what it needs is within the 1,000-rao shortfall tolerance, which a direct exit's
  leaver bears (and an exit that would then be paid nothing reverts `ZeroAmount`, Task 36b). `stakeIdle` tops up only the stake hotkey, and only once at least the minimum stake is
  idle; otherwise the
  owner sweeps the position with `removeHotkey`, which exits it fully (for the stake hotkey, after
  `setStakeHotkey` elsewhere first).
- **A root hold on every pair waits for the buffer.** Subtensor's `RootStakeUnlockInterval` (0 today,
  sudo-settable) holds a (coldkey, hotkey) pair after any root add, removal or claim on it, and a
  stranger's 0.0001 TAO `transfer_stake` onto a listed hotkey re-stamps it. The walk skips a held pair
  and goes on (Task 20), so one held pair no longer freezes exits, but every listed pair can be held,
  and then an exit is paid only from liquid TAO: the idle buffer (`idleBufferBps`, 0 at launch), which
  the owner raises once the monitor reports a non-zero interval. The hold also gates `move_stake`, so
  `moveStake` and the owner's `removeHotkey` of a held pair revert and wait (a scheduled `moveStake`
  stays executable through its window); `removeHotkey` never skips a refused removal, so it never
  delists a hotkey that still holds stake.

### Exit liveness (Task 42, I-37)

Every place a user's money can sit has a way out that needs no owner: the user, anyone, or the
keeper's routine work. The exits campaign (`test/invariants/Exits.invariants.t.sol`, `ExitHandler`,
on the adapter campaign's world) checks it from every state it reaches, with one more blocker
applied each time, and checks this table both ways: money left with a path open fails the test (a
new owner-only exit), and so does money the table says is held that got out (a stale row: under a
blocker that holds a whole kind, such as the vault's pause, that holding never falls). It also
checks that what got out reached its own user: each user's bridged TAO on Base and native TAO,
with the request fees it paid, rise by at least what left its holdings, less 64 rao of rounding,
the walk's tolerance (0.000001 TAO) for each direct exit, and one share's value for each mint of
its money (the chain's removal fee is 0 there, and every payout goes with the whole fee, so no
entry is charged); and that none of it reached `anyone` or the door's treasury. A mint rounds to
whole shares: under a rao normally, but about the vault's assets over 1e6 at a supply of 0 that
still holds assets (the long run's counterexamples: the stake a consenting last holder forfeited,
relisted by anyone; see the orphan residual below). Users: a Base EOA (BE, may also
sign on Bittensor), a Base smart wallet (SW, Base only), a Bittensor EOA (TE, direct only). The
routine runs about 19 days: four rounds of requests a day or more apart (the door hold passes), the
payout delay after each, and the park timeout. The amount-dependent holds are the routine's own
observations where they can be: the day's allowance and the entry limit by what the last round's
request met, not by a model; a payout chunk's or a direct exit's refusal by the handlers' model,
which a clean probe (no blocker, the chain's minimum at its default, the rail converting) must
never need; and shares under 0.03 TAO are the holder's own choice only if the routine did not burn
them down to that. A second contract (`ExitsAtLaunchLimitsInvariantTest`) runs the same campaign at
the launch's exit limits, a 10 TAO entry limit and a 10 TAO allowance floor, where full requests
clip every day: there every clip's cause (the entry limit's worth burned, or the day's allowance
spent) is judged as often as it happens, and a targeted draw (`nearTheEntryLimit`) tops the smart
wallet's holding up to just above the entry limit and asks for all of it, so S-L1's keep is reached
(a clip that would leave under 0.03 TAO keeps 0.03 TAO instead).

| Where the money is | User | Way out (who) | Held only while (who clears it) |
|---|---|---|---|
| A deposit in the open batch | BE, SW | `cancelDeposit` (the user), from five minutes after its last deposit (R11's cooldown), at once while the door is paused or its primary disabled (R12) | never |
| A batch, payout or refund in flight, or in CCIP FAILURE | all | CCIP executes it; anyone re-executes a FAILURE | never here (the lane is Chainlink's), but one: a payout sent through a vault primary the door never activated stays FAILURE until the owner's `activateBridge` on the door (7 days; I-28's residual: `invariant_twoChainLiveness` in `GovernanceLiveness.invariants.t.sol` counts that class, and `test_I28_aOneSidedRailMigration` pins it) |
| A parked delivery, as tokens | BE, SW | `refundParked` (anyone) after 14 days: the tokens back | never |
| A parked delivery, as native TAO | BE, SW | `deliverParked` (anyone); `refundParked` (anyone) after 14 days | both are closed: the delivery by the vault paused, the door not active on the vault, the vault's primary disabled (owner), stake missing that listing cannot bring back (owner: a write-off) or the vault underwater at a supply of 0; and the refund by ForeverMoney halted, migrating or finished, the chain's minimum above the park, or the cushion short (ForeverMoney, the chain, the founder) |
| Shares | BE | `redeemDirect` (the user); the door | both closed: the direct exit by the vault paused (owner) or its walk refused (the chain's minimum); the door as for SW |
| Shares | SW | a door request, closed, delivered, burned | the vault paused, the door not active on the vault, either primary disabled, stake missing as above (owner); the rail closed (ForeverMoney: the redeem is deferred, not burned); the last request clipped to the entry limit or deferred by the day's spent allowance (the next batch, the next window); shares worth under 0.03 TAO the holder kept (its own choice) |
| Shares | TE | `redeemDirect` (the user) | the vault paused (owner), or its walk refused |
| A queued payout or a bounce | all | `processPayouts` (anyone) after the delay | the vault paused, the door not active, the vault's primary disabled (owner: for shares a `cancelPayoutBatch`, for a bounce nothing); the chunk under the chain's minimum, its walk refused, its rail closed or short (ForeverMoney, the chain, the founder) |
| A credit on Base | all | `claim` (the user), at once | never |

The owner-only ones: the vault paused; the launch door removed (a Reopen, 7 days; 15 after the
guardian's removal); a primary disabled (a Reopen, 7 days, or a switch); stake truly lost (a
write-off, 7 days); a queued payout behind a rail closed for good (the owner's cancel; a bounce
has none, the stuck-money review's S-L4); and I-28's payout sent through a vault primary the door
never activated (the door's `activateBridge`, 7 days). Not owner-only: ForeverMoney's halt ends by itself (its
guardian's 2 days at most, its operator's hold); a paused door closes no exit; a validator's
hotkey swap is anyone's to undo (`addHotkey` while stake is missing).

Every delivery in that campaign is also read for R4's two burn rules: no door redeem burns while
the vault's primary cannot send payouts, its own view closed or (R6 D) the vault's primary disabled (S-H1: deferred
instead), and a holder that asked for all
its shares (none fresh) keeps 0 or at least 0.03 TAO (S-L1), and keeps any shares only for a cause.
The probe's routine counts in all of these too. A CCIP FAILURE is a draw of its own
(`relayShortGas`: a message delivered with too little gas, re-executed by anyone later). Not reached
there: a bounce (one door and no booked loss, so no deposit is ever foreign or meets a vault below
half the launch price); the doors campaign pays its foreign bounces out, and EndToEnd's
`test_insolventVaultBouncesDepositBackToBase` and VaultDelivery's insolvency pins hold the rest.

**The orphan at a supply of 0 (a stated residual, Task 42's long run).** A holder who exits directly
with `acceptMissing` while stake is missing is paid at the floor price, min(visible, booked), and
forfeits its share of the missing stake to the holders who stay (I-1). When it is the last holder
there are none: once the stake comes back (anyone's `addHotkey` of the swapped hotkey, I-6), the
vault holds it at a supply of 0, owned by the virtual offset's 1e6 shares (42.7 and 49 TAO in the
long run's two counterexamples). There is no on-chain recovery at a supply of 0: no exit, reward cut
or adoption releases it, and a first depositor gets its own deposit less rounding, nothing of the
orphan (the owner's forfeit path was not traced exhaustively). It counts in `totalAssets`, so it
uses up `depositDirect`'s cap (`maxTotalAssets`: 42.7 TAO under the launch's 44 leaves about 1.3 TAO
of direct deposits until the owner raises it), and as stake it enters the base of the day's outflow
allowance. It also sets the share price at about the orphan over 1e6, and the orphan keeps earning,
and any donation adds to it, so every later mint rounds away up to orphan / 1e6 (0.000044 TAO a mint
at 44 TAO, more as it grows; `sharesForDeposit` rounds down), in the vault's favour: the value
accrues pro rata to the virtual shares and the holders of the moment. The treasury's permanent share
holding (runbook 3.4) keeps the supply above 0, so the forfeit goes to the treasury and the other
stayers instead, from where it can be returned off chain. And outside that corner (the review's
point beyond the diff): a consenting leaver's forfeit goes to whoever stays, so a stayer who calls
`addHotkey` right after another holder's `acceptMissing` exit takes that holder's forfeit. The guard
(relist the hotkey before any nudge to the floor price) is the controller's carry for the UI and the
runbook, and the UI copy needs it before other people's money. Revisit before other people's money.

**A leaver's forfeit vests to whoever holds (a stated residual, the rerun of Task 42's fix round
2).** A holder who leaves, through the door or directly, is paid at a price that leaves out the
rewards not yet vested and those not yet claimed, so it forfeits its share of both to the holders
who stay; and a door leaver's queued payout stays staked until it is paid, earning for those holders
meanwhile. All of it reaches the holders as the schedule vests, and a claim restarts the schedule on
what is left and the claim, over 30 days from then, whatever the stake did since the rewards accrued
(`_vest`): after a large exit takes stake out, the schedule vests faster than the smaller stake now
accrues, and whoever holds then gets more than its share of the accrual, a new entrant timed after a
big exit included. What it takes beyond its accrual share is bounded by its share of what the
departed stake earned and had not yet vested: entrant share x the departed stake's last vesting
period of net rewards (about 1.5% of the departed stake at 18% a year net), out of the stayers'
windfall. No one's principal is at risk, no stayer loses what its own capital earned, and the
leaver ends worse off than if it had stayed. The vault-favour campaign's time-share bound credits
the attacker this recapture, funded by the stake that left: each of its exits whose walk took
booked stake (a payout chunk or a direct exit) credits net rate x that stake x 30 days, for 60 days
(the rerun's counterexample: its 38.985 TAO payout, about 26.2 TAO of it still staked, earned about
0.32 TAO for the holders over 24.5 days, but its walk took only 6.19 TAO of stake, crediting 0.0916
TAO, of which the vest above the accrual spent 0.023 TAO; the attacker had taken 0.000533 TAO beyond
its accrual share). A fall in the reward rate does the same with a rate in place of stake (R7, the
favour campaign's seed 9402): when the owner moves stake to a weaker validator, or the chain's own
rates fall, the schedule still holds rewards earned at the old rate and vests above the new accrual
for up to a period, so a holder through it takes its share of the difference (in the campaign, an
attacker entered after the month's rewards accrued took 0.0027 TAO beyond its time share); the
campaign credits each move like a departure. Revisit before other people's money (the cure: per-holder
reward accounting, a rewards-per-share accumulator).

**A retained hotkey swap can freeze the hotkey list (an open risk, unverified on chain).** A validator's
hotkey swap moves the vault's root stake onto a hotkey the vault does not list, and anyone (or the owner) relists
the new hotkey while stake is missing, so exits work again (I-6). If the chain lets the old hotkey keep part of the
position (a swap that retains nominators, or a split), each such swap fills one more of the four slots, and the old
hotkey cannot be freed while it still holds stake or claim-only credits; once the slots run out, the next swap's
stake can never be relisted, and every exit is refused `StakeMissing` for good (spec 3.5's hotkey freeze, which a
thief with both keys can also cause on purpose). Whether a partial retain happens on mainnet, and what a swap costs,
was the dropped testnet task's question (plan Task 63). The record is Task 14's two-way model in `MockStaking`
(`swapHotkey`: any share of the position moves, the rest stays; `swapHotkeyWithCredits`: claim-only credits stay on
the old hotkey, paid by its claim as stake or as balance), and the keeper's rule stands: it never frees a slot whose
`getUnclaimedRootTaoByHotkey` credits read above 0. Revisit before other people's money.

**An adoption no longer pushes rewards later (fixed, Revision 27; was a fifth stated residual,
Task 42's fix round 4).** An adoption restarted the one reward schedule without claiming, so rewards
already vesting were pushed later and whoever held afterwards, a timed entrant included, took a share
of them. The founder chose to fix it before launch (2026-11-13): an adoption now vests the surplus on
its own drip and never restarts the claim schedule, so no claimed reward moves. The vault-favour
campaign's adoption credit is gone with it, and the old behaviour's mutation fails that campaign.
What is left lives inside the drip: an adoption still re-spreads what is left of the drip over the
longer of `rewardVesting` and what it has left, so anyone (7 days after the last adoption, with a
surplus of at least the chain's minimum stake, about 0.002 TAO) can push up to a quarter of the drip
later, where a timed entrant shares it. It is bounded and touches no claimed reward, but the drip is
not only gifts: the surplus can be stake that came back after a write-off, the former holders'
principal. Revisit before other people's money.

### Vault favour (Task 42, I-38)

No one gains except by time held (`test/invariants/Favor.invariants.t.sol`, `FavorHandler`, at
the launch's 30 days of vesting and 10% cut). Two honest holders deposit and stay; the attacker
does everything a holder can (door and direct deposits and exits, same-batch pairs, cancels, its
own reward claims after the keeper's fallback and the moment the claim schedule has fully vested, a
late entry in a claim gap, a retry of a failed delivery at the moment it picks); a stranger gives
stake, forces TAO in and claims rewards; the
keeper closes, pays out, stakes, claims and adopts; the guardian pauses (the owner unpauses), and
the owner cancels queued payouts. Three invariants:

- `noActorGainsByActing`: across every action but time's, the actor's wealth does not rise; and
  across every action the attacker does not make (the keeper's closes, payouts, stakes, claims and
  adoptions, where every door-path mint, burn and payout is priced; the owner's cancel; a retry;
  the others' acts), the attacker's does not rise beyond that action's rounding (1 rao an entry it
  prices and 1 more; at a donation, its share of it).
- `gainsOnlyByTimeShare`: the attacker gains at most its time share of the rewards, the vesting
  gifts and the donations, at the shares it held at each moment, and of the vest above the accrual
  rate as far as the stake that left funded it (the leaver's-forfeit residual above: each of its
  exits whose walk took booked stake credits net rate x that stake x the vesting period, an upper
  bound on that stake's rewards still to vest; since R7 the owner's move onto the standby, which
  accrues at half the rate, credits the rate it gives up x the moved stake x the period the same way,
  since a fall in the rate makes the schedule vest above the accrual as a departure does (seed 9402;
  the fourth residual's rate form, above); each credit spent oldest first and lasting two vesting periods;
  what nothing funded is logged as `unfundedVest` and credited to no one).
  The gifts' vest is read off the adoption drip and the rewards' off the claim schedule (Revision 27);
  an adoption credits nothing, since it no longer restarts the claim schedule (the fourth fix round's
  adoption credit, removed), and that premise is asserted with the bound (`adoptionsMovedClaims` 0:
  the old behaviour's mutations fail here, and the adoption pin fails first on the vest above the
  accrual, 0.0053 TAO, when the claim schedule is restarted). The stranger never gains. Its stated
  precondition is the keeper's: no two claims further apart than the vesting period. The
  review asked this bound of every actor; here it is the attacker's alone: the honest holders never
  act against the vault (deposits and cancels only), and what reaches them is bounded by the next.
- `gainsAreConserved`: every actor's gain and the keeper's, with the stranger's gifts the vault
  has not booked yet, are at most the rewards claimed net of the cut less what of the schedule is
  still vesting, plus 1 rao an action. Its slack is only what leaves the world (bridge and chain
  fees, the keeper's top-ups) and the treasury's share of what vests after its cut.

Since R6b U1 a non-keeper's claim is refused while the claim schedule still vests, so the
attacker's and the stranger's claims past the fallback are nearly all refusals; since R7 the campaign
also claims the moment the schedule has fully vested (`claimAtVestEnd`: time passes to the
schedule's end, before the keeper's round due then), and its minimums count the claims the vault
took (`outsideClaimsMade`) and those at a vested end (`claimsAtVestEnd`), so refusals alone no
longer meet them. A model that refused those claims fails the campaign; before R7 it passed.

The failure branches it covers: the paused vault's refused delivery and its retry (by the
attacker or the keeper), and the owner's cancel with its re-mint. The ones it does not, with the
pins and campaigns that hold the favour review's verdict on each:

| Branch (the favour review's part 4) | What may not gain | Held by |
|---|---|---|
| a removal fails and is skipped | nothing booked; past the tolerance the exit reverts whole | `VaultExits.t.sol`: `test_aWalkSucceedsSkipsAndSucceeds`; `LeaverPays.t.sol`: `test_aFeeAboveTEndsTheWalkAtOnePartialRemoval` |
| an exit that cannot pay its cost | reverts, shares kept | `LeaverPays.t.sol`: `test_anExitItsWalksCostLeavesNothingIsRefused` |
| a walk's cost zeroes an entry, or receipts fall short | the chunk reverts whole | `LeaverPays.t.sol`: `test_aBounceAWalksCostWouldZeroIsRefused`, `test_theFeeTooHighThresholdOfAWalksCost`; the payout campaign's `toTheWalkCost` (the least removal fee that zeroes an entry, `chunksRefusedWalkCost`; pin `test_theWalkCostDrawRefusesAtTheLeastZeroingFee`) |
| a deposit bounced | queued at its own TAO, no shares | `VaultDelivery.t.sol`: `test_delivery_insolventVaultBouncesDeposit`, `test_delivery_belowHalfLaunchPriceBouncesDeposits`; the doors campaign's foreign bounces |
| a conversion or the vault refuses: a park, delivered later or refunded at face | the mint at that moment's fair price, the refund exact | `AdaptersEndToEnd.t.sol`: `test_pausedVaultParksTheBatch`; `BittensorParking.t.sol`: `test_vaultRefusalParksNative`, `test_deliverParkedConvertsAndDelivers`, `test_refundConverted`, `test_refundUnconverted`; the adapter campaign's parks |
| anyone delivers a park at a time they pick | the same | the favour campaign's `retryDelivery` (a refused delivery retried at the moment the attacker picks, judged by `noActorGainsByActing`; pin `test_aDeliveryRefusedWhilePausedIsRetriedByTheAttackerForNothing`), the same free option over MockBridge; the adapter campaign's `deliverParked` by anyone |
| stake missing | deposits and deliveries refused; a direct exit only with consent, at the floor price; no cut | `VaultLedger.t.sol`: `test_redeemDirectNeedsTheFlagWhileMissing`, `test_batchDeliveryRevertsStakeMissing`, `test_noRewardCutWhileMissing`, `test_noAdoptionWhileStakeMissing`; `HotkeySwapMisprice.t.sol`; the core campaign's swaps |
| a sale under its floor (the USDC delivery) | reverts, TAO included | the core campaign's I-30 (`invariant_deliveryNeverBelowFloor`) |

Not built from the favour review's proposal: its griefing actions (a gift deposit, filling a
batch's room, forcing a failure, raising the bridge fee, halting a lane) and its assertion 3; the
treasury's fee excess (L3) does not arise over the mock bridge.

## Trust and supply chain

Outside parties. No delay applies to any of them.

| Party | What it can do | What bounds it |
|---|---|---|
| ForeverMoney's guardian and admin | Halt their `AlphaVault` or start a migration (admin), with no notice. The halt is a clock (R3, FM-I2): the guardian's lasts at most 2 days a shot, lifts itself, and waits a 12-hour cooldown before the next; the operator (the same Safe, and a second Safe of the same three signers) can hold it for any finite time (`adminHold`, no cap) and lift it at once (`unpause`). | A halt stalls both legs: deliveries to the vault park as tokens (`withdrawLiquid` reverts inside `convertExact`; on v3.1 they failed and were re-executed) and are delivered once it lifts (`deliverParked`, Task 26), and `processPayouts` reverts (`depositLiquid`) and is retried. A migration is different and permanent for inbound batches: `initiateMigration` closes `depositLiquid` from the announcement (payouts through this adapter stop then and never resume on it; that TAO stays in Cascade's vault, so nothing is lost on that leg) while `withdrawLiquid` stays open for the 7-day delay, `executeMigration` moves the whole position and `withdrawLiquid` then reverts `Insolvent` for good, and `finishMigration` halts the vault indefinitely (ForeverMoney's operator can lift the halt; that does not bring the position back). The adapter's `alphaVault` is immutable and always answers ERC-165, so every `BATCH` delivered after `executeMigration` parks as ForeverMoney's tokens (since Task 25; on v3.1 it sat in CCIP `FAILURE` forever), a claim ForeverMoney will not honour (spec §3.2, M-7), so the depositors in those batches can still lose their TAO, which was burned on Base. A token park that exists when the notice begins can be converted during it with `deliverParked` (Task 26). A converted (native) park needs no ForeverMoney call to be delivered, so it still delivers to the vault during and after a migration (R3, FM-I3); only its refund, which goes back through `depositLiquid`, closes at the announcement, and for good once the vault retires (the adapter's `alphaVault` is immutable), so such a park's one exit is delivery. The 7-day notice window is the only protection: the keeper must not close batches during it, and ForeverMoney's `MIGRATION_DELAY` (7 days) equals the bridge registry's `REGISTRY_DELAY` (7 days), so the owner must propose the replacement adapter pair (both adapters, because `remoteAdapter` is circular) the day a migration is announced (see [Operator notes](#operator-notes) 17 and checklist item 25). No ForeverMoney key can take TAO that sits in the vault. |
| ForeverMoney's validator | Holds the stake behind bridged TAO while a batch or payout is in flight (minutes). Swap its hotkey (`swap_hotkey`), which moves every nominator's root stake, ForeverMoney's included, to the new hotkey. | Conversion is 1:1 both ways, and the vault's own stake sits with its own validators. After a hotkey swap (R6b U6), conversions both ways revert until ForeverMoney repoints (`migrateValidator`, its operator's, at once), while `canSendPayouts()` still reads open: batches with deposits park, and door redeems delivered meanwhile burn into the payout queue and pay once ForeverMoney repoints (or the owner cancels them). A stated residual beside S-H1, bounded by the daily allowance for as long as it lasts; the monitor alerts, and the guardian's vault pause stops the burns. |
| ForeverMoney's 2-of-3 Safe (`0xADF6…3546`, the same three signers on Base and Bittensor, no timelock, no modules; it is also the AlphaVault's admin, operator and guardian and the CCIP registry administrator of both tokens; a second Safe with the same signers, `0x2d91…221b`, is an operator too; read 2026-11-05, R3 FM-L2) | With no delay on any of it: mint FM-TAO on Base with nothing behind it (`grantRole(MINTER_ROLE)` on the token, one transaction) or revoke the pool's mint and burn roles (the lane stops); withdraw the wTAO locked on Bittensor that backs every FM-TAO on Base and Robinhood (`setRebalancer`, which logs nothing, then `withdrawLiquidity`); swap or remove either token's pool in Chainlink's TokenAdminRegistry (`setPool`); pause or throttle the lanes (rate limits, chain removal, the pool's router); hold the AlphaVault for as long as it likes (`adminHold`). | Exposure is the FM-TAO the front door holds (the open batch and unclaimed credits) plus batches and payout chunks in flight; staked TAO is native on Bittensor and unaffected. A delisted, throttled or unwired pool is a delay: sends revert and in-flight messages wait in CCIP `FAILURE` until it is wired again. A pool that mints the wrong amount cannot credit anyone: the OffRamp passes the measured amount, and the door (`TokensNotReceived`, the payout sum) and the Bittensor adapter (`AmountMismatch`) refuse it. Unbacked minting and a lock drain are a loss of the exposure above and nothing else; the monitor's `fmtao.role_change_critical` fires on the grant and `fmtao.backing_true` on the drain within the hour, and the guardian's answer is to pause the front door and the vault. Chainlink's registry owner cannot take the pool assignment over (`AlreadyRegistered`). The Base FM-TAO token is Chainlink's `BurnMintERC20` (no pause, blacklist, fee or hook), so no ForeverMoney power freezes the door's own functions. |
| Chainlink CCIP (lane configuration, the default verifier committee, the Risk Management Network) | Pause a lane, change its gas or data limits, or withhold verification, which stalls batches in either direction. A compromised CCIP network could also deliver forged `BATCH` or `PAYOUTS` messages that an honest adapter accepts. The Risk Management Network check, an extra independent verification, is disabled on these lanes. Executions on both lanes go through `OffRamp 2.0.0` (read 2026-10-24). | Sends revert or deliveries wait. A lane gas limit lowered below an adapter's gas model needs a new adapter through the 7-day registry. Forged messages get the same bounds as a rogue adapter (see the contracts table below), and funds in flight are exposed. A failed delivery is retried by manual re-execution, which anyone can run, with no expiry. Anyone can also move an `UNTOUCHED` Cascade message to `FAILURE` on either lane (wrong `verifierResults`, too little transaction gas, or from inside a Cascade lock: the OffRamp checks the committee's results inside the same self-call as the token release and `ccipReceive`, so a wrong result fails that call and `execute` records `FAILURE`; on a message already in `FAILURE`, a failed attempt reverts, `NoStateProgressMade`, and records nothing), and the destination pool's inbound rate limit can fail a delivery inside `releaseOrMint`, before `ccipReceive`, where Bittensor's parking cannot catch it (R3, CC-L2, CC-L4): nothing of the message is written either way, and re-execution delivers it exactly once. Re-executing a `FAILURE` needs the committee's `verifierResults`, which the OffRamp checks on every execution (Task 52's review corrected R3's CC-L3): at launch the keeper only reports it, and the founder re-executes it by hand (`pnpm ops reexec`, which simulates first; operator note 18). A `FAILURE` recorded by an attempt with wrong or empty results has no committee results in its calldata to reuse; `pnpm ops reexec` then takes them, in order, from `--proof`, `--from-tx` (another attempt, such as Chainlink's executor's: its docs say it retries a `FAILURE` for up to 8 hours), then Chainlink's CCIP API (runbook section 6). A message the rail loses loses only that batch's funds: there is no in-contract recovery and no in-flight lock, so other batches are unaffected. |
| Chainlink's default executor | Executes verified messages on the destination chain, or stops doing so. | Anyone, including the keeper, can execute a verified message with `OffRamp.execute`; there is no expiry. |
| Bittensor's sudo (root) key | Ship runtime upgrades (about weekly) that change precompile behaviour, or disable a precompile (a disabled staking precompile also makes the owner's `cancelPayoutBatch` revert, where it ran before: since Task 34c it reads every listed hotkey's stake to price the re-mint). Raise the staking floor (`DefaultMinStake`). Set the root unstake hold (`RootStakeUnlockInterval`, 0 today; no admin call sets it, a runtime upgrade or a raw storage write would). | The walk skips a held pair and exits wait for the idle buffer only when every pair is held (see [the soft spots](#exit-safety)); `moveStake` and `removeHotkey` of a held pair wait. A raised floor parks a deposit batch below it as tokens (v3.2, Task 25; on v3.1 it waited in CCIP `FAILURE`), to be delivered once the floor drops (`deliverParked`, Task 26) or refunded to its door after `PARK_TIMEOUT` (Task 27), and a payout chunk below it reverts until regrouped or cancelled (see [the staking floor](#bridge-adapters-ccip-20)); the adapters add one precompile read, `getDefaultMinStake()`. Value-moving precompile calls are measured, and a chain fee on root unstake is the exit's own cost (Task 36b): the walk counts the stake it takes at face value, a direct exit's leaver is paid its value less what the chain kept, and a payout chunk's entries bear it pro rata, never the holders who stay and never reserves or other users' payouts; an exit the fee would leave nothing is refused (`ZeroAmount` direct, `FeeTooHigh` for a payout entry, paid later from liquid TAO), and only stake the walk cannot take (more than 1,000 rao of the request), or the walk's whole-removal corner (see [the payout leg](#payout-leg-bittensor-to-base)), reverts `UnstakeShort`. So a fee is no freeze, and `unstakeMarginRao` no longer moves it (leave it 0). For the Bittensor adapter an under-delivering root unstake no longer strands batches in flight (v3.2, Task 25; on v3.1 its delivery required the native delta from `withdrawLiquid(token, amount, amount)` to be at least `amount`, so one rao short stranded every batch in flight, checklist item 26): a conversion at most 1 rao short (`SHORTFALL_TOLERANCE_WEI`, 1e9 wei) is covered from its reserve, never from parked TAO, and one short by more parks the batch's tokens (ForeverMoney's `Slippage`, its own check of the TAO it measured, R3 FM-L1; the burn rolled back), to be delivered or refunded later. The tolerance is immutable, so a chain that systematically under-delivers by more parks every inbound batch until it stops; a wider tolerance needs a new adapter. The price itself trusts the stake read, so a changed read would misprice; the keeper is to run each pre-release on testnet 945 first, and the [checklist](#pre-mainnet-checklist) lists the behaviours to confirm. Under a hold the monitor's `root.hold_interval` pages, the guardian pauses the front door's deposits so batches carry none, and the founder funds the buffer with `depositDirect` (R6b). |
| Bittensor's block authors (20 Aura authorities, read 2026-11-15) | Order their own block as they like: an author can sandwich a reward claim, selling a subnet's alpha just before it and buying back after, since the chain pays the claim at the same block's pool prices and `claimRewards` takes no minimum (R6b U5; the author keeps the swap fees). | A few percent of some claims, never principal, carried by every root staker; it needs a rogue authority, inside the trust already given to Bittensor's operators. A stated residual: a `minDelta` on the claim, or a keeper forwarder that checks the claim's delta (`setKeeper` is immediate), is the founder's call, and covers every claim only with U1's guard and a keeper that claims before the schedule ends. A refused claim still burns about its whole gas, so the keeper needs a retry limit. |
| Validators (the hotkey owners) | The owner picks them, and they keep their validator take from the rewards. A validator's hotkey swap moves the vault's root stake to a new hotkey outside the set the vault reads, so the price drops until that hotkey is added back. | The keeper watches for hotkey swaps and stake drops, and the owner, guardian or keeper re-adds the hotkey (`addHotkey`; no timelock for the guardian or keeper). While more than max(0.1% of the booked stake less the queued payouts, 0.001 TAO; R6's E-fix) of the booked stake is missing, the vault refuses every mint and every burn the holder did not consent to (`stakeMissing()`, Task 13): deposits and batches revert `StakeMissing`, a direct redeem needs `acceptMissing` and then pays the floor price, and the reward cut is skipped. Within the tolerance a deposit can gain at most its share of it. From v3.2 (Task 14a) anyone may list the swap's new hotkey while stake is missing (one the vault never listed, holding at least the chain's minimum of its stake), and the last of the 4 slots opens only to an add made while stake is missing of a hotkey holding that minimum, so a swapped hotkey always finds a slot; a full set with stake missing lets anyone remove an empty hotkey with nothing unclaimed. Stake that is gone for good the owner writes off (`writeOffMissingStake`, Task 16: 7 days of notice, the guardian's veto), never what an unlisted hotkey of the vault still holds; the price does not move, and minting reopens at it. |

Keys:

| Key | What it can do | What bounds it |
|---|---|---|
| Owner | Everything in [Roles](#roles) under "Owner", including replacing the guardian (8 days after proposing it) and picking the validators. | Cannot move user funds directly. The only route would be registering a rogue front door or bridge, which waits 7 days in public, and the sitting guardian can veto it: replacing the guardian takes 8 days, longer than the registry delay, and the guardian stays in office until then. A compromised owner cannot bypass the sitting guardian's veto within the registry delay; with the guardian vetoing, a rogue registration needs at least 15 days of public notice plus the timelock's delay. Parameter changes wait only for the timelock. |
| Guardian | Stop only: pause, remove a front door, disable a bridge, cancel a pending proposal. It can also add a hotkey, which only widens what the price reads. | A stolen guardian key can freeze, not take. The owner proposes a replacement at once and accepts it after 8 days; the guardian cannot cancel that. Until then it can re-pause, remove front doors, disable bridges and cancel the owner's re-registration proposals, so front-door deposits, redeems and payouts can stay frozen for about 15 days plus the owner's timelock (8-day replacement, then a 7-day registry re-proposal), and direct deposits and redeems for 8 days plus the timelock. The bound holds only if the guardian key does NOT hold the timelock's canceller role. It could fill the hotkey set (at most 4); the owner removes extras. |
| Keeper | Time `claimRewards`, `stakeIdle` and `adoptStake`; add a hotkey, and remove an empty one with at most `hotkeyDustRao` unclaimed (as the guardian may); choose payout chunk sizes. | A stolen key can time claims and stakes badly (frequent tiny claims stretch vesting), and on a runtime with a post-stake hold on unstaking it can re-arm that hold on the stake hotkey's pair with `stakeIdle` (the walk then skips that pair, and with every pair held exits wait for the idle buffer; Task 20), and it alone chooses payout chunk sizes (each extra chunk costs its users at most the fee ceiling); it cannot move funds. Anyone may act after 7 days (counted from deploy, or from when a hotkey was first added, until the first stake or claim), and the owner can replace or clear the keeper. |
| Deployer | One-shot: the vault's constructor takes one `Params` struct: the owner (the owner from the start; there is no hand-off), guardian, keeper, treasury and reward cut, hotkey, expected coldkey, initial bridge, every limit, the launch chain (`launchChain()`, immutable) and the launch door on it, which is required. Each value passes the check its setter makes (no constructor can set what no setter could) and is logged as its setter logs it. The front door's constructor takes one `Params` too: its asset, initial bridge, vault chain and vault (immutable, with the USDC), owner, guardian, keeper, oracle, swapper and every limit, each through its setter's check and logged likewise. So does the staker's (v3.2, Task 33): its USDC, TAO and front door (immutable; the tokens must be the front door's own), owner, treasury, route 0, the delivery route (it must be active, so only 0 can pass) and the fees, each through its setter's check and logged likewise, so the staker needs no owner call before the first stake. The initial bridge and the launch door are active at once, with no delay, because nobody has deposited yet; every later front door or bridge waits 7 days. | Check every constructor argument before anyone deposits (checklist item 28), including that the initial front door has code and points back at this vault: `doorState(peerId(chain, frontDoor))` reading `Active` (through the vault lens; v3-launch's `frontDoorActive`) proves only the registration. The vault derives its own coldkey and reverts `ColdkeyMismatch` if the expected one differs. |

Contracts:

| If compromised | What it can do | What bounds it |
|---|---|---|
| A front door | Burn the shares of users it names, up to `max(20% of the ramped-in root stake, minDailyOutflow)` per fixed 24-hour window (the floor 10 TAO at launch, bounded to 10 to 100 TAO, and shared with every other door in the global window), with the TAO owed to itself. | The 24-hour payout delay, an instant guardian hold, and an owner cancel that re-mints the burned value (never more shares than were burned: the burned holders get back the value at burn time, the vault's rewards over the hold go to the holders who stayed, and after a fall the burned holders get their shares back). It burns only for holders whose redeem origin is its own chain: direct depositors (`DIRECT_ORIGIN`) and other chains' holders are skipped. Holders of origin 0 (shares only from the reward cut) are skipped by honest doors, but a rogue door can claim one: L1 credits a batch's deposits before it burns its redeems, so a 1-rao deposit for the address sets its origin to the door's chain and the same batch's redeem then burns its shares, within the door's window, the guardian's hold and the owner's cancel. The treasury closes this with `setRedeemOrigin(DIRECT_ORIGIN)` right after deploy (see [the reward cut](#v3-trust-model)). |
| An adapter | Present any registered front door, so it gets every door's allowance (same bounds). It holds whatever passes through it in flight. On Base it can credit only tokens the front door holds beyond its books: donations, or payout tokens that landed ahead of their data in the separate-data-message fallback. It can credit that surplus to anyone with a made-up `PAYOUTS` message, and the pending chunk whose tokens it spent then fails `TokensNotReceived`. Its replay slots are its own, so it cannot pre-mark another adapter's deliveries. Whichever adapter is primary sets the fee quote: it can quote up to the fee ceiling and keep the excess. Borrowed TAO delivered as a forged deposit-only batch first does not raise a door's allowance base: only stake that has ramped in for a day counts (see the soft spots). | The same bounds, plus the 7-day bridge registry and the guardian's `disableBridge`. A non-primary adapter's forged redeems are paid out through the primary adapter to the registered front door, which credits the named users on Base: forced exits, not theft. Theft needs a rogue front door or the primary adapter. Disabling a non-primary adapter does not hold batches it already delivered; hold those by removing the front door, then cancel them. |

App side (outside this build): the swap router and onramp APIs, npm dependencies, and the keeper's
RPC provider.

Build dependencies: OpenZeppelin Contracts v5.4.0 and forge-std v1.17.0, pinned by tag in
`foundry.lock`; solc 0.8.38 with the IR pipeline (via_ir) and EVM target cancun. Chainlink
code is vendored, not a dependency: three files of `@chainlink/contracts-ccip@2.0.0` in
`src/vendor/ccip` and its message codec in `test/vendor/ccip` (tests only), each with a `VENDOR.md`
giving the package's integrity hash.

## v3 trust model

**Staking (USDC on entry).** The user states a minimum TAO out (the site: its quote less 0.5%), which the
staker checks by the balance it actually received, so a router that reports more than it pays only makes
the stake revert. That minimum was a stake's only protection in v3: stakes were not checked against the
oracle. v3.2 adds a floor the contract holds whatever minimum the caller passes (Task 33, spec §3.7,
I-31): the TAO received must be at least 95% of what the front door's 30-minute TWAP oracle says the USDC
swapped is worth (`taoValue(usdcIn - fees)`, the value and the 95% each rounded down), at every size,
else the stake reverts `BelowOracleFloor` with nothing moved. The 5% is a constant
(`MAX_BUY_SLIPPAGE_BPS`): no owner can loosen or skip it. It fails closed: no stake settles while the
front door has no oracle (`NoOracle`) or its oracle cannot answer (for example "OLD", a pool's history
short of the window).

- A sandwich bot, a stale quote, a loose minimum or a hostile front end can cost a staker at most about 5%
  against the 30-minute average. A front-run in the same block does not move the floor: a pool's
  cumulative for the current second carries the tick from before the block's first tick-moving swap.
- That 5% is the bound, not the expectation (R3, C-I5). At launch sizes (a batch of at most 10 TAO, a
  stake of about $2.2k at most) no profitable front-run was found on the November 2026 pools, but
  above them the floor alone becomes extractable: on a stake of $10k with no minimum of its own, a
  $25.6k front-run nets the attacker about $66 and leaves the victim at 96.5% of the oracle's value,
  against an honest 99.0%. The web passes its quote less 0.5%; an integrator or a contract that
  calls `stake` must pass its own `minTaoOut`, never 0, and not rely on the 5%.
- The staker's routes and fees change with no delay in the staker itself (within the 0.5% and $0.25 fee
  caps), so the floor also bounds a bad route: it pays at least 95% of the oracle's value or the stake
  reverts.
- The floor can refuse an honest stake: when the pool's price runs more than about 5% ahead of its
  30-minute average (in a sharp rally the TAO is dearer than the average says), or when a stake is so
  large that its own price impact and the pools' fees pass 5%. Nothing moves; the user stakes later or
  smaller. On a Base fork in November 2026 (block 53,549,000) an honest $1,800 stake filled at 99.4% of
  the oracle's value, 4.4% above its floor; a $25,000 front-run buy still left it at 96.7% (it filled),
  and from $50,000 the floor refused it (`FrontdoorPentest`'s buy-leg PoCs).

**Delivery (USDC on exit).** With `requestRedeemWithDelivery` the user states a minimum USDC out and
a deadline. When the payout reaches Base, the keeper calls `deliver`: the front door hands the TAO to
the swapper, measures its own USDC balance before and after, and forwards what it received to the
user. The result must be at least the largest of three floors: the user's floor, the keeper's
floor, and the 30-minute TWAP value less 1.5% (owner-set, hard maximum 3%).

- A stolen keeper key can time deliveries but cannot sell a user's TAO more than 1.5% below the
  30-minute average price (or below the user's own floor).
- A malicious swapper can only make a delivery revert. It cannot keep the TAO or count an unrelated
  transfer as the proceeds, because the front door measures its own balance.
- `claim()` always works. If a delivery keeps failing, or the user's USDC address is blocked, the
  user claims the TAO by hand, as in v2.
- The owner changes the swapper only behind the 48-hour schedule; the staker's routes (the delivery
  route among them), fees and treasury change at once, within the hard caps (0.5%, $0.25), the
  floors bounding what a bad route costs (R3, C-L3). So a stolen staker owner can reroute
  deliveries at once, to no worse than the floors (§5).

**The oracle and pool depth.** The price is a 30-minute average of two pools, the smaller holding
about $200k. Holding such a pool off-price for 30 minutes costs more than the margin on capped
deliveries (the 1.5% edge), so it is not worth attacking. v3 checks no pool depth on chain. v3.2's
oracle also serves each pool's 30-minute harmonic-mean in-range liquidity (`meanLiquidity()`, Task
31), and the front door refuses a delivery while either pool reads below its floor (Task 32, spec
§3.7): `deliver` reads `meanLiquidity()` beside the TWAP floor and reverts `ThinPool(index,
liquidity)` for the first pool under `minPoolLiquidity[index]` (0 TAO/WETH, 1 WETH/USDC), before any
token moves. The keeper skips the user and retries later; `claim()` never reads the floor, so the
user can always take the TAO by hand. The owner raises a floor at once and cuts one only through the
48-hour schedule (the guardian may cancel it); a floor of 0 checks nothing, the way out if liquidity
moves to other pools for good (then the owner also swaps the oracle). The launch floors are measured
at deploy, not fixed in the code (Task 61): TAO/WETH's depth swung about fivefold over a few days in
Task 31's samples (6.2e20 to 3.1e21), so half its median would have held deliveries at some of them.
A harmonic mean counts a thin stretch in full: one second of an empty range in the window reads at
most 1,800 (Uniswap divides by the liquidity, at least 1), so a pool pushed thin for one block reads
thin for up to 30 minutes, and the floor holds deliveries that long. A griefer who moves TAO/WETH's
price into a near-empty range for one block (about two swap fees on the size it takes) can so hold
every delivery for up to 30 minutes, again and again; no one loses anything, as users still claim by
hand, but the deliveries wait. Measured on the November 2026 pool (Base block 53,552,705; R3,
C-L1): selling about 72 TAO into TAO/WETH at the end of one block (all of its roughly 6 WETH) and
buying it back at the start of the next costs about $88 of pool fees per 30-minute hold (about $176
an hour), needs about $15.6k of capital for that one block, and puts about $1.8k at risk to an
arbitrageur trading between the two blocks; it also moves the TWAP about 0.4%, inside both margins.
`claim()` stays available throughout, and the cost moves with the depth of TAO/WETH's WETH side. The
reading measures depth that is there, not a proven cost to move
the price: anyone can raise it with narrow in-range liquidity of their own, so the 30-minute window
stays the main defence and the floor only refuses the obviously thin pool. The oracle's constructor
also refuses a pool with fewer than 1,801 observation slots in use (`MIN_CARDINALITY`, `TWAP_WINDOW +
1`, Revision 28): one a second over the 30 minutes, plus one. Uniswap writes at most one observation per
block timestamp, and timestamps are whole seconds, so whatever the block time (Base went from 2-second to
0.2-second blocks at block 53,556,128, on 2026-11-05, five blocks to a timestamp) no pool writes more than
one a second, and 1,801 slots always reach back the window; the 901 before assumed one per 2-second block
and covered only 15 minutes at today's speed. With too few, anyone who swaps dust every second can
overwrite the window's history and make all three views revert "OLD": stakes and deliveries wait,
failing closed, and claims work. The live pools hold 2,000 (TAO/WETH) and 6,700 (WETH/USDC) today, above
the minimum; a pool below it grows with `increaseObservationCardinalityNext`, open to anyone (`pnpm ops
cardinality --grow`). If liquidity thins a lot, the owner lowers the delivery slippage or swaps the oracle.
A delivery reverts unless the swap can pay at least the 30-minute average less
`maxDeliverySlippageBps` (1.5%). The keeper then skips it and retries later, and the user can always
claim by hand. The keeper delivers once its quote (after the 0.15% swap fee) less its 0.5% room
clears both floors, and waits otherwise; that quote less 0.5% is its own minimum (R3, C-L3: it never
clamps up to a floor, so today a delivery goes when the quote is within about 1.0% of the TWAP, not
1.5%). Observation, not a guarantee: on a Base fork in October 2026 (pool fees about 0.35%, the 0.15% swap
fee, pools near $200k) deliveries went through while the pools' sell quote (pool fees and price
impact included) was within about 1.35% of the 30-minute average, which is the mid price within
about 1.0% of it.
A delivery sells everything the user is owed at once, and its TWAP floor is the marginal 30-minute
value, which ignores the sale's own price impact (R3, C-L2; founder decision 2026-11-05: deliveries
stay all at once). On the November 2026 pools (block 53,552,705) an honest sale nets about 99.2% of
the oracle's value at 1 TAO, 99.0% at 5, 98.6% at 12 and 98.4% at 14 TAO, so in a flat market the
keeper skips a delivery of about 5 TAO or more and the contract refuses one of about 13 TAO or
more, whatever the keeper passes (a payout entry can be 10 TAO, a whole-cap holder 40). Those users
claim their TAO by hand with `claim()`; the web steers larger exits to "receive TAO" and shows the
largest USDC delivery the pools allow at that moment (Phase 12).

**The reward cut.** At each reward claim the vault mints shares worth 10% of the claimed rewards
(owner-set, hard maximum 20%) to the treasury, at the price from before the claim, so the cut never
moves the share price. It is skipped while stake is missing (`stakeMissing()`, before the claim or
after it), when the price is
below half the launch price (the existing insolvency line) or while the vault is underwater; that
claim then vests normally for everyone.

- The treasury must be an address with no code on both chains. `pnpm ops verify` checks it. A
  contract treasury could be impersonated by a twin at the same address on the other chain.
- The cut's shares carry no redeem origin (v3.2, Task 18). Honest front doors skip an origin of 0 (the
  treasury's Base redeem requests are skipped) and `redeemDirect` always works, but a rogue door on any
  chain could claim it: a 1-rao deposit for the treasury ahead of a redeem in one batch sets its origin
  to the door's chain (L1 credits deposits before it burns redeems), and the redeem then burns the cut's
  shares, within the door's window, the guardian's hold and the owner's cancel. So **right after
  deploy, before the first cut, the treasury calls `setRedeemOrigin(DIRECT_ORIGIN)`**: from then on no
  front door can ever burn its shares (a door's deposit for it still mints and leaves
  `DIRECT_ORIGIN`), and it exits with `redeemDirect`. The step is mandatory if the treasury is ever a
  contract (R6, Fable's whole-system review I-3): until it runs, a stranger's 0.04 TAO `depositFor` of
  the treasury on Base pins its origin to Base, and a twin at its address on Base could then redeem
  the cut's shares. With the launch treasury an EOA the same key holds both addresses.
- The effective share is slightly above the rate, about 10.01% at normal claim sizes (a claim near
  1% of assets), because the treasury's new shares also share in that claim's 7-day vesting. Say
  "about 10%" in copy.
- If a reward claim happens while no shares are outstanding, the treasury (the only holder) ends up
  with the whole claim as it vests; nobody else is affected.
- Unclaimed rewards sit outside the share price until collected. Collection is expensive (one claim
  is about 53M gas; the vault requires `claimGasRequired` = 55M and the ops tool sends a 57M limit), so the keeper claims only when the rewards waiting are at least 25 times the
  claim's cost, or monthly while a claim costs under $20 and does not exceed what is waiting.
  Someone who leaves before a collection misses up to about a month of yield. Anyone can still
  claim by hand.

**Validator.** The v3 test deployment stakes with tao.bot (0% take, the largest, among the cheapest estimated
claim; see `reports/Cascade v3 root validators.md`). Moving to another validator later is
`setStakeHotkey` plus `moveStake`.

## Who can use direct access

- **Bittensor-native users, and anyone with a plain key-pair wallet (EOA) who holds TAO for gas on
  chain 964.** The same key controls the same address on both chains.
- **Not, in practice, smart-wallet users on Base.** No Coinbase Smart Wallet factory, faucet or gas
  sponsorship was found on chain 964, so smart-wallet users rely on the front door for exits. A
  user-registered Bittensor recovery address is the v2.1 answer.
- **Contract wallets whose address someone else can claim on Bittensor must be handled by the app.**
  `redeemDirect` pays whoever controls the address on chain 964. A legacy `CREATE` wallet's address
  follows its deployer's nonce, so a different party may hold it there: the app must refuse these.
  A counterfactual (`CREATE2`) wallet's address follows its factory and its *initial* owners
  (Coinbase Smart Wallet, Safe): if the owner set changed after deployment (a rotated key, a
  replaced signer), the original owners can deploy the same address on chain 964 and call
  `redeemDirect` on its shares. The app must warn users who rotated keys.
- **v3.2 states this as a known risk (R6, ChatGPT R2 claim B; the founder's decision: no contract
  change before the self-funded launch, whose deposits come from Ledger EOAs).** Origin by chain gates
  doors only, never `redeemDirect`, so the twin takes door-credited shares too, at any time: its
  claim has no deadline, and it can wait for the balance to grow. It can also set the address's
  origin to `DIRECT_ORIGIN` (even while paused, holding nothing), which locks the wallet out of its
  door (every Base redeem `RedeemSkipped`, its fee spent) while later Base deposits for the address
  still mint, for the twin (`SmartWalletTwin.t.sol`). Nobody else loses. Before other people's money
  the site must refuse contract-account deposits other than EIP-7702 ones (or at least any that is
  not a recognised `CREATE2` wallet with unchanged owners) or warn properly that another party may
  control the address on Bittensor (the stake form's note today says only that such a wallet "can only
  leave Cascade through Unstake here"), and warn before a deposit into a `DIRECT_ORIGIN` address; no
  site guard helps a wallet that calls the contracts directly, or a third party's `depositFor`. A
  contract fix is an audit item: an opt-in "door only" lock sent from Base, or a registered Bittensor
  withdrawal address, never a forced Base consent for every direct exit, since the direct exit is EOA
  holders' way out when the bridge or a door fails.
- Because csTAO cannot be transferred, every share balance was created either by a front door (a
  deposit for that address on Base) or by `depositDirect` (the address acted on Bittensor, and its
  redeem origin is `DIRECT_ORIGIN` until it names a chain). A Base party therefore cannot redeem a
  Bittensor depositor's shares. Anyone can deposit for any address (`depositFor` on Base), so an address can hold shares
  it did not pay for, but shares can never be taken from anyone: only the address itself can redeem
  them, directly on Bittensor or by its own redeem request on Base.
- **The same address on a second front door's chain may be a different party.** Origin by chain
  (Task 18) answers it: a door burns only for holders whose redeem origin is its own chain, and a
  deposit there for an address of another chain's origin bounces, so the contract-wallet cases
  above cannot cross between two front-door chains (see the soft spots under
  [Exit safety](#exit-safety)).

## Operator notes

1. **Fund the reserves first.** Before first use, send the vault's address at least `ED_RESERVE`
   (1e12 wei = 1,000 rao) as a substrate-side transfer to its mirror (SS58) address; `receive()`
   rejects plain EVM sends. The reserve is never spent or counted, so the chain's 500-rao
   existential deposit can never make a payout fail. Funding it up front means the first users'
   deposits do not have to fill it. Also fund the Bittensor adapter's reserve (`fundReserve()`,
   `RESERVE_TARGET` 1e15 wei plus the 500-rao existential deposit; v3-launch's 1e12 wei) and its token cushion
   before its first delivery. Bittensor EVM reports balances net of the existential deposit, so an
   adapter that holds nothing sees each conversion 500 rao short, past the 1-rao tolerance, and
   every delivery parks as tokens (`ConversionShort`) until the reserve is there (nothing is lost;
   deliver them afterwards with `deliverParked`, Task 26). From v3.2 (Task 28) fund it with
   `RESERVE_TARGET` (0.001 TAO) instead, and fund its token cushion with `fundCushion` of 0.001
   FM-TAO (approved first; since R4 a plain transfer is surplus, not cushion), which pays a payout's
   1-rao conversion shortfall; below either target the monitor's `bridge.cushion_low` warns.
2. **Size the redeem-request fee to the bridge fee.** Keep `redeemRequestFee × maxRedeems` at or
   above the live Base-to-Bittensor bridge fee for a full batch, 50 deposits and 50 redeem requests
   (the costliest close: a full redeem list can sit beside a full deposit list; 7,000,000 gas toward
   Bittensor at v3.2's launch gas model), not a one-entry batch's. At the launch values, 2e14 wei × 50
   = 0.01 ETH against about 0.0031 to 0.0043 ETH quoted for such a batch: about 2.3 times at the
   0.0043 ETH quote (the founder set 2e14 wei on 2026-11-16; at 1e14 wei, 0.005 ETH covered about 1.2
   to 1.6 times, a thin margin that a rise in TAO/ETH or in Bittensor's gas price takes away: R12a, the
   ChatGPT r3 DoS scan). The monitor's `batch.redeem_fee_thin` warns below 1.5 times (at 2e14 wei, a
   full batch's quote above about 0.0067 ETH); the response is `setRedeemRequestFee` (owner,
   immediate, at most 0.001 ETH).
   Otherwise a junk-filled batch cannot self-close: the `requestRedeem` that would close it reverts
   `InsufficientFee`, and the keeper (or the requester) must close it with `closeBatch` and ETH
   attached. A remainder carried from earlier batches counts in the pot (v3.2), so leave the
   carried remainder in place unless it is well above what self-closes need. The fee is capped at
   `MAX_REDEEM_REQUEST_FEE` (0.001 ETH; 0.05 ETH for a full 50-entry list).
3. **Set the beta cap, in TAO.** Set the vault's `maxTotalAssets` (default 1,000 TAO; it caps direct
   deposits against the whole vault's assets) and each front door's `depositCap` (its deposits, net
   of payouts and refunds received on Base: `netForwarded`) to the beta cap: about $250k, sized to the
   TAO liquidity on Base. A direct exit on Bittensor never lowers `netForwarded` (R6, Fable's
   whole-system review L-1): a door deposit taken back by `redeemDirect` keeps its share of the cap
   used, so at a 40 TAO cap four 10 TAO round trips stop every door deposit (`CapExceeded`) while the
   vault holds none of them (`EndToEnd.test_aDirectExitLeavesTheDoorsCapUsed`). No funds move; the
   owner raises the cap at once (`setCaps`). The other way, payouts carry yield, so `netForwarded`
   under-counts what the door's depositors still hold. The monitor compares `netForwarded` with the
   door-origin holders' value; a cap on a value the vault reports is for a later version.
4. **Claims need about 55M gas.** `claimRewards` refuses to start below `claimGasRequired` (default
   55,000,000; bounded to 54,100,000 to 63,400,000, the top 60,000,000 from Task 23 to Task 65 and the floor
   53,200,000 until R5), so a mis-sized call cannot burn its gas in the precompile. Size it against the real
   precompile (about 53.2M measured, which `MIN_CLAIM_GAS` divides by 63/64 and rounds up; the mainnet canary
   records a real claim's gas), allowing for a call forwarding at most 63/64 of the gas left and for the stake
   reads of every hotkey in the set before and after the
   claim, and pre-check each claim with `eth_call`. A claim's transaction needs `claimGasRequired` plus the
   claim's own overhead (218,947 at its dearest over the mocks, Task 65), within Bittensor's per-transaction
   limit, about 65,000,000 (75% of the block less 10% for initialization; 64,998,400 read live on 2026-11-15:
   the pool refuses a higher gas limit with `ExhaustsResources`, whatever the 75,000,000 block gas limit
   says). At the top, 63,400,000 + a 500,000 allowance + a 1,000,000 margin is 64,900,000, so the keeper's
   claim gas limit (`claimGasRequired` plus its margin, 2,000,000 in ops today) must be capped under that
   limit (about 64,900,000), or its margin cut to 1,500,000. The live headroom runs from 54.1M to 63.4M left;
   the bounds set only the least a claim requires left, and a ceiling-capped transaction forwards about 63.7M at any
   setting, so a real claim needing up to about 63.6M forwarded can still be met, and one needing more by no setting and
   no gas limit (R6). And Frontier weighs a transaction by its gas
   limit, so a claim near 55M gas takes about 55% of a block's weight: it needs a fairly quiet block, and the
   pool may hold it for a few blocks.
5. **Batch limits.** 50 deposits + 50 redeems per batch is both the launch value and, since Task 18,
   the hard bound (`MAX_ENTRIES`): fork-measure that 50 + 50 of new depositors fits the lane's delivery
   gas with as many hotkeys in the set as you use. The adapters
   size each delivery's gas to its entry count (unused gas is not refunded); check the pools'
   rate-limit allowance before closing. Keep the vault's `maxMessageValue` and the front door's
   `maxBatchValue` at or below the deployed adapters' `maxMessageValue()` (see the send limits in
   [Bridge adapters](#bridge-adapters-ccip-20)); the code refuses more than the lane's 5,000 TAO, and
   since Task 23 the vault refuses a `maxMessageValue` above its primary adapter's cap
   (`AboveBridgeCap`: at construction, in `setMessageLimits` and in `setPrimaryBridge`; the front
   door's check of `maxBatchValue` is Task 30's). A bridge's `maxMessageValue()` must never change
   (`ICascadeBridge`; the adapters' is `immutable`): a cap that fell below a limit already set would
   refuse the owner's tightening of it, which I-23 forbids. A new cap is a new adapter.
6. **ETH receivers.** `closeBatch` refunds the caller's unused value with a plain call (v3.2: only
   its own value, never the pot's remainder, which rolls forward), as does a roll of an empty batch;
   a `requestRedeem` that self-closes a full batch pays its caller nothing. A keeper, router or wallet
   contract that cannot receive ETH can close only with exactly the value the pot lacks (0 when the
   pot covers the fee); give it a payable `receive`. `sweepPot` pays the front door's immutable
   `treasury` the same way: a treasury that refuses ETH reverts its sweep, and the remainder stays
   in the pot for later closes (no close ever pays the treasury).
7. **Insolvency recovery is out of band.** If the share price falls below half the launch price,
   front-door deposits bounce back to their users (`processPayouts` pays them; a cancel re-mints
   only a batch's redeems and carries its bounces forward, still owed, and a batch of bounces alone
   reverts `NothingToCancel`) and `depositDirect` reverts
   `VaultInsolvent`; redeems keep working. Recover with a substrate-side transfer to the vault's
   mirror address; deposits mint again from the next delivery. At a supply of 0 an underwater
   vault (a queued payout more than 1,000 rao short) refuses each front-door batch whole
   (`VaultInsolvent`), and the Bittensor adapter parks it until the same transfer makes the
   reservation whole. A `cancelPayoutBatch` at a supply of 0 after a new deposit there re-mints
   each redeemer the value it was owed at the price that deposit set, never more shares than it
   burned (Task 34c), so when the batch's price was above the deposit's (which minted at the launch
   price if the vault held nothing beyond its reservations) the redeemers get their burned shares
   back, worth less, and the new depositor gains the difference (pre-existing; below it, no value
   moves): cancel such a batch before the vault takes a deposit at a supply of 0, or let it pay out.
8. **Pause on any unexplained drop in `totalAssets`.** The insolvency guard trips only below half
   the launch price. A smaller unexplained drop (a misread stake, for example) still lets batches
   and direct deposits through at the lowered price until someone pauses.
9. **`batchInterval` has no lower bound, but it has an upper one.** A very short interval lets anyone
   close a batch before a user's cancel lands. Set it behind the timelock with care. The other way,
   `MAX_BATCH_INTERVAL` is 24 hours (v3.2, Task 30; 7 days before): the constructor and
   `setBatchInterval` refuse more (`InvalidParameter`), so even a captured owner cannot set a longer
   `batchInterval`, and a request is never more than a day from its close by the timer. A pause no
   longer stops closes (v3.2, spec §3.5); the owner or guardian can still disable the primary bridge,
   which stops them for as long as it lasts (deposits stay cancellable with `cancelDeposit`, at once
   since R12, and redeems with `cancelRedeem`, meanwhile), and the keeper's 24-hour hold under the launch cadence is
   an off-chain policy, not something the contract enforces.
10. **The primary bridge is a single point of liveness.** Disabling a contract's primary bridge stops
    its outgoing messages (closes on Base, payouts on Bittensor) until the owner sets another enabled
    bridge as primary, and a new adapter takes 7 days to register. Keep a standby adapter registered.
    On Base a disabled bridge still delivers what it brings in (v3.2, Task 30: the front door takes
    payouts and refunds from any bridge it ever activated); the vault takes batches from enabled
    bridges alone.
11. **Hotkeys.** `setStakeHotkey` routes new stake to a new validator and `moveStake` moves existing
    stake onto it. Keep an old hotkey in the set (at most 4) until its rewards are claimed, because
    rewards land on the hotkey that earned them. `removeHotkey` refuses while unclaimed rewards
    exceed `hotkeyDustRao`, unless told to forfeit them. Should the chain's unclaimed-rewards read
    fail (R2 F1: it is read in a `try`), only the owner's forfeit removes (logging 0 unclaimed); every
    other path refuses, as for rewards above the dust. The owner, guardian or keeper can
    `addHotkey`: after a validator's hotkey swap, add the new hotkey at once so its stake counts in
    the price again (pause first if batches are arriving). v3.2 (Task 14a): anyone may add it while
    stake is missing (`NotEligible` otherwise, and always for a hotkey the vault once listed); the
    fourth slot is reserved for such an add (`SlotReserved`); the keeper or guardian may remove a
    non-stake hotkey with no stake and unclaimed rewards within `hotkeyDustRao`, and anyone an empty
    one with nothing unclaimed while the set is full and stake is missing (`NotAuthorized`
    otherwise); `setStakeHotkey` needs a listed hotkey (`NotListed`) and runs at once when that
    hotkey holds more than the stake hotkey and at least half the booked stake (after a swap of the
    stake hotkey: list the new hotkey, follow it, then the keeper frees the old one's slot), else it
    is a 48-hour scheduled item; a scheduled `moveStake` names its destination, which must still be
    the stake hotkey when it runs. The unstake walk skips a position below the minimum
    stake: `stakeIdle` tops up only the stake hotkey, and only when at least the minimum stake is
    idle; `removeHotkey` exits such dust fully (on the stake hotkey, `setStakeHotkey` elsewhere
    first).
12. **Replacing the guardian takes 8 days.** `proposeGuardian`, then `acceptGuardian` once
    `GUARDIAN_DELAY` has passed; only the owner can `cancelGuardianProposal`. Do NOT grant the
    guardian key the timelock's canceller role, or the bound below fails. A stolen guardian key can
    keep front-door flows frozen for about 15 days plus the owner's timelock (it can cancel
    re-registration proposals until it is replaced), and direct deposits and redeems for 8 days
    plus the timelock. Without the canceller role the guardian cannot veto timelocked parameter
    changes (the outflow percentage, `payoutDelay`, the fee ceiling, `setStakeHotkey` /
    `moveStake`), which wait only for the timelock. A compromised owner cannot bypass the sitting
    guardian's veto within the registry delay.
13. **Unstake margin and floors.** If root unstakes start delivering short (a chain fee), the exit
    that walked pays it (Task 36b): a direct exit's leaver (`ShortfallAbsorbed`) and a payout chunk's
    entries (`PayoutChunkSent.unstakeCost`), never the holders; nothing to set. Leave
    `unstakeMarginRao` at 0: it no longer moves a fee, and any excess it asks only sits idle for
    `stakeIdle`. Under a large fee, process payouts right after deliveries, while deposits are liquid
    (no walk, no fee); a chunk whose fee would leave an entry nothing waits for that. With a chain
    removal fee, a due chunk can also refuse `UnstakeShort` in the walk's whole-removal corner (spec
    §3.3, I-13); it clears once the balance or the positions move by more than a few rao (a
    deposit, an exit or a reward usually does), and a tiny stake gift to the stake hotkey clears it at once. The floors are
    the larger of the live reads and constant fallbacks (2,000,000 / 20,000,000 rao since Task 23; v3.1's
    `setFloorFallbacks` is gone), which apply alone while a read fails. **The root hold
    (Task 20, spec §3.8):** the monitor watches `RootStakeUnlockInterval` (critical) and stamps on the
    vault's pairs; once the interval is non-zero, raise `setIdleBuffer` (an increase applies at once,
    at most 1,000 bps) so the buffer, the larger of that share of the booked stake and
    `minDailyOutflow`, covers `pendingPayouts` plus a day's floor, and let deposits and claims fill it:
    `stakeIdle` keeps it liquid, and nothing unstakes into it. Lowering it is a 48-hour item. Round the
    keeper's order as payouts, then stake, then claims, so a claim's or a stake's stamp lands after the
    day's payouts. `setUnstakeGas` (150,000 to 5,000,000, immediate) sets the least gas each removal
    gets; keep it above a real removal's cost (a real `removeStake` measured 144,811 gas; the mainnet canary
    records one). **The caller's gas rule:** send
    `processPayouts` and `redeemDirect` with a gas limit of at least `EXIT_GAS_RESERVE` + (listed
    positions × `unstakeGas`) + the exit's own work (3.6M with four hotkeys at the launch values,
    plus the exit; 2,000,000 of it the reserve since Task 65). At the setter's top, `MAX_UNSTAKE_GAS` ×
    `MAX_HOTKEYS` + `EXIT_GAS_RESERVE` is 5,000,000 × 4 + 2,000,000 = 22.0M plus the exit, inside Bittensor's
    per-transaction limit, about 65M (75% of the block less 10% for initialization; the 75M block gas limit, read live
    2026-11-11 and 2026-11-14, is not what one transaction meets), so no `unstakeGas` makes an exit too large for a transaction; the keeper's own payout gas
    limit must still cover it (carried to the final merge). Below it, when held pairs burn their gas, each removal gets the `unstakeGas` floor
    rather than a share of what is above the reserve, the floors together can eat the reserve, and the
    call runs out of gas (it reverts whole, nothing lost) instead of reverting `UnstakeShort`; above it,
    a held pair costs only its share and the exit keeps the reserve.
14. **Drain a front door before retiring it.** `removeFrontDoor` also fails that door's batches
    still in flight (`UnknownPeer`). Stop its deposits, let its open and in-flight batches deliver,
    and let its queued payout batches be paid, carried bounces included (spec §3.5, M-4), then remove
    it: `processPayouts` refuses a removed door's batches, and a carried bounce cannot be cancelled
    (`NothingToCancel`), so it waits until the door is active again.
15. **Outside parties.** ForeverMoney's 2-of-3 Safe, Chainlink's lane configuration and Bittensor's
    sudo key can each stop or change the rails with no delay. See [Trust and supply chain](#trust-and-supply-chain).
16. **Deposit minimums.** A partial `cancelDeposit` must leave at least `minDeposit` (a full cancel
    always works), so no entry sits below the minimum in force when it last changed. Keep the front
    door's `minDeposit` at or above the Base adapter's `minSendAmount` (0.01 TAO). Since v3.2
    `setCaps` and the constructor refuse a `minDeposit` below `MIN_DEPOSIT_FLOOR` (0.03 TAO), and since
    R7 one above `MAX_BATCH_VALUE` (5,000 TAO: no larger deposit could be sent, and before the bound
    `setCaps(type(uint256).max, ...)` overflowed `canClose` and panicked every close), so with
    today's adapter it cannot go below; only an adapter deployed with a `minSendAmount` above 0.03 TAO
    could leave a batch whose total is below it, which reverts `BelowSendMinimum` at `closeBatch` and
    stays open until more deposits arrive.
17. **Staking-floor stalls.** A payout chunk whose net is below the live floor (0.002 TAO today)
    makes `processPayouts` revert `BelowConversionFloor` until the keeper groups it with
    neighbouring entries (`maxEntries`). The vault no longer burns a redeem worth less than 0.03 TAO,
    and charges a chunk's users at most the fee ceiling (0.015 TAO on a small chunk), so this needs a
    floor raised past 0.015 TAO or a tiny bounced deposit. If every remaining entry is tiny, the
    owner cancels the batch (`cancelPayoutBatch` re-mints each redeem the value it was owed, never
    more shares than it burned; nobody loses funds); its bounced deposits are carried forward, still
    owed (note 7), and tiny bounces alone cannot be cancelled (`NothingToCancel`): they wait for
    the floor to drop. The web app must refuse unstake requests worth less than 0.03 TAO (the vault
    would defer them, and the user would have paid the request fee for nothing); it asks for a
    little more. Before `closeBatch`, the keeper reads `getDefaultMinStake()`: a deposit batch that
    arrives while the floor sits above its total parks as tokens (Task 25) until the floor drops and
    it is delivered (Task 26), or is refunded after `PARK_TIMEOUT` (at v3.2's least minimum deposit,
    `MIN_DEPOSIT_FLOOR`'s 0.03 TAO, that takes a fifteen-fold raise of today's 0.002 TAO;
    twenty-fold at launch's 0.04 TAO). Next to that floor pre-check, a second keeper rule: do not
    `closeBatch` while `AlphaVault.migrationReadyAt() != 0`, `AlphaVault.migrationFinished()` or `AlphaVault.isPaused()` is true
    (a batch delivered after a completed ForeverMoney migration parks as tokens ForeverMoney will
    not honour; see
    [Trust and supply chain](#trust-and-supply-chain)).
18. **Re-executing a failed delivery.** A delivery that reverts stays `FAILURE` on the
    destination's `OffRamp 2.0.0`: on Base, any failure of the front door's delivery; on
    Bittensor, since Task 25, only a malformed batch, `AlreadyParked`, `ReserveShort`, a recipient
    with no code, a recipient or its conversion refusing with `ReentrancyGuardReentrantCall` (a
    held lock, the vault's or ForeverMoney's, since R3: note 22) or too little gas to write the
    park (ForeverMoney paused, the vault paused, the
    floor raised, an unfunded reserve and a recipient out of gas now park the batch, for
    `deliverParked`, Task 26). On either lane two more causes come before `ccipReceive`, where
    no parking can catch them (R3, CC-L2, CC-L4): the destination pool's inbound rate limit
    (5,000 TAO, refilling at 0.6 TAO/s, as outbound), which a burst of messages or Chainlink's
    executor catching up after an outage can exhaust inside `releaseOrMint`; and a stranger's
    attempt, since anyone may execute an `UNTOUCHED` message first and can fail it with junk
    `verifierResults` or too little transaction gas (from inside a lock it fails in `ccipReceive`
    instead, note 22). Neither writes anything of Cascade's, but the message is left in `FAILURE`: a
    stranger's attempt with empty `verifierResults` returns and writes `FAILURE` on both lanes'
    `OffRamp 2.0.0`, and the honest results still deliver it from there (fork-tested on Base, Task 61's
    `BaseForkV32`, and on Bittensor, Task 65's `BittensorForkV32Failure`, each on a real message forked the
    block before its execution). Anyone can run `OffRamp.execute(encodedMessage,
    ccvs, verifierResults, gasLimitOverride)` on a `FAILURE` again at any time, with no expiry,
    and it then delivers exactly once; raise `gasLimitOverride` if it ran out of gas.
    Re-executing a `FAILURE` needs the default committee's `verifierResults`, as every execution
    does: the deployed OffRamp 2.0.0 checks the committee's results every time (Task 52's review;
    R3's CC-L3 reading, that a `FAILURE` needs none, was wrong). Only Chainlink's verifier
    infrastructure produces them (CCIP explorer or verifier API), and a failed attempt's public
    calldata carries them, unless a stranger's empty-proof attempt wrote the `FAILURE`: then that
    calldata holds no usable proof. At launch the keeper never re-executes on its own: it reports the
    `FAILURE` (the monitor watches for `FAILURE` executions and low buckets, Task 56). The founder
    runs `pnpm ops reexec <messageId>`, which (runbook section 6) takes the committee's results from the first source that has them: `--proof` (a file, the CCIP API's answer saved, or another `execute`'s calldata), `--from-tx` (another attempt's transaction), the attempt that wrote the `FAILURE` (its public calldata, unless it carried none, as a stranger's empty proof does), then Chainlink's CCIP API (`execution-inputs`, checked against the rebuilt message); it simulates first and sends nothing when none has them (wait: Chainlink's docs say its executor retries a `FAILURE` for up to 8 hours). Automatic
    re-execution stays off until the founder turns it on after the rehearsals (checklist item 27);
    until then a failed message's tokens stay locked in the bridge, and nothing is lost.
19. **A lowered allowance base.** A surplus (`surplusStakeRao()` on the lens), left by a gift or by a
    walk that took a gifted position whole, lowers the allowance base by its size until `adoptStake`
    books it (see the soft spots under [Exit safety](#exit-safety)): the keeper adopts at most once a day
    and only a surplus of at least the chain's minimum stake, anyone after 7 days; it vests into the
    price over `rewardVesting` and enters the base at once. `stakeIdle` does not restore the base in
    v3.2 (it books only its own stake, at most what it staked). Missing stake (a swap) is not a base
    question: list the swap's hotkey (`addHotkey`). Until then front-door exits are held to the larger
    of the outflow share and `minDailyOutflow` a day, and `redeemDirect` stays open.
20. **The fee valve (Task 21, spec §3.3).** `processPayouts` is payable: a chunk's users are
    charged at most the fee ceiling (the larger of `maxFeeBps` of the chunk and `maxFeeAbs`, 0.01 to
    0.015 TAO), and when the bridge quotes more, the caller sends the excess as the call's value
    (whole rao, else `BadValue`; the rest is refunded to the caller, last, so a caller contract
    needs a payable `receive`). `FeeTooHigh` from `processPayouts` has two causes (ruling B11): the
    quote is above the ceiling and the value does not cover the excess (retry with
    `ceilToRao(quote) - floorToRao(ceiling)` as the value, the top-up `fee - charged`; plain
    `quote - ceiling` rounded up to rao can be a rao short when the ceiling is not whole rao), or an
    entry with shares would be left with
    nothing after its share of the fee, which the bounds make unreachable (every burned exit is at
    least `MIN_REDEEM_VALUE`, 0.03 TAO, twice `MAX_FEE_ABS`). `MAX_FEE_ABS` is a TAO amount
    while the CCIP fee is a dollar cost: at today's fee (about 0.001 TAO) the 0.015 TAO ceiling
    leaves 14× headroom, but a deep fall in TAO's price leaves small chunks waiting until someone
    pays the excess (nothing is lost; the keeper can top up). The monitor's `payout.fee_ceiling`
    alert is the early warning.
21. **Cancelling a payout batch, switching the primary, a second chain (R2).** A `cancelPayoutBatch`
    re-mints each cancelled leaver the value it was owed at today's price, never more shares than it
    burned (Task 34c): a cancel after a claim costs the stayers nothing (the leavers forgo the
    delay's rewards), and one after a loss returns the burned shares, so the loss stays the
    leavers'. Cancel rogue-door batches; process honest ones. Before `setPrimaryBridge` to a bridge
    whose `maxMessageValue()` is below the old `maxEntryValue`, drain every queued batch: entries
    are checked against the cap only when they are queued, so a redeem above the new cap can then
    only be cancelled, and a carried bounce above it can be neither sent nor cancelled. Payouts
    route through the one primary bridge, and an adapter serves one lane: a door on a chain the
    primary does not serve cannot be paid (`processPayouts` reverts `WrongDestination`, and its
    bounces lock), so no such door may be activated until payouts route per chain. On Base the
    switch's cap check reads `maxBatchValue`, not the open batch (Task 30): if the owner lowers
    `maxBatchValue` below what the open batch already holds (an immediate tightening, which also
    makes the batch full by value) and then, the old primary disabled, switches to a primary whose
    `maxMessageValue()` is below that batch's deposits, the switch passes, and every close of that
    batch reverts `MessageTooLarge` in the new adapter's `quoteFee`, before any fee moves; so does a
    request that meets a full redeem list (its self-close), and a new deposit reverts
    `BatchValueFull`. Cancels, claims and payouts still work. The batch, and its redeems with it,
    then waits until its depositors cancel down to the new cap, or until the switch is undone (the
    owner Reopens the old primary, 7 days, then disables the new one and switches back). So before
    `setPrimaryBridge` to a smaller cap, tighten `maxBatchValue` to it while the old primary still
    sends, and let the open batch close under it; if the old primary is already disabled, check that
    the open batch's `totalDeposits` fits under the new cap first. A monitor rule should flag an
    open batch above the primary's `maxMessageValue()`
    (`test_aSwitchBelowTheOpenBatchHoldsItUntilCancels` pins this).
22. **Executions from inside a lock (Task 25, review round 1; corrected at R3, CC-L1, CC-L3).**
    Anyone may send through the Base adapter and name any recipient, and `OffRamp.execute` is
    permissionless. A recipient that calls `OffRamp.execute` on another message during its own
    delivery is refused by the OffRamp itself (its contract-wide guard,
    `ReentrancyGuardReentrantCall`, before the message is decoded), so the other message stays
    `UNTOUCHED` and later delivers normally: the nesting this note used to describe cannot happen
    on `OffRamp 2.0.0` (R3's fork PoC). The OffRamp's guard is held only inside `execute`, though,
    and locks are held around a stranger's code in ordinary transactions: the vault's around
    `redeemDirect`'s payment and `processPayouts`' refund to its caller, the Bittensor adapter's
    around `deliverParked`'s recipient call, the front door's around `closeBatch`'s refund, and
    ForeverMoney's AlphaVault's around `withdrawLiquid`'s payment to its caller. A stranger can
    execute an honest message from there. Meeting the adapter's own lock, that message goes to
    `FAILURE` with nothing written; meeting the vault's, it would have parked native on its first
    delivery, and meeting ForeverMoney's (the conversion refused), it would have parked its tokens,
    so since R3 (and its fix round 2 for the conversion) the adapter reverts the whole delivery when
    the recipient or the conversion refuses with `ReentrancyGuardReentrantCall` (a lock is
    transient, not a refusal of the batch), and `deliverParked` keeps such a park as it was. Either
    way nothing is lost: re-execute the `FAILURE` as in note 18 (`pnpm ops reexec`, with the
    committee's results from the failed attempt). The
    locks are the spec's (§3.2, H-3, ruling A2) and stay. Monitor for a `FAILURE` whose revert is
    `ReentrancyGuardReentrantCall`. The tests
    `test_aRecipientReenteringThroughTheRouterIsRefusedByTheLock`,
    `test_aHeldLockRevertsTheDeliveryWhole`, `test_aStrangerUnderTheVaultsLockCannotParkAnHonestBatch`
    and `test_aStrangerUnderForeverMoneysLockCannotParkAnHonestBatch` pin the adapter's side.
23. **A small swap shortfall can become stake missing (Task 42's rerun).** `stakeMissing()`
    tolerates a gap of max(0.1% of the booked stake less the queued payouts, 0.001 TAO; R6's E-fix),
    so, all the more while the queue is large, a fixed shortfall under it (a
    validator's swap of a small position: 0.03 TAO is under it at 34 TAO booked) becomes stake
    missing as exits shrink the vault (at 15 TAO booked it is over), which halts door deliveries and
    minting until anyone relists the hotkey (`addHotkey`, when it holds at least the chain's minimum
    stake) or the owner writes it off (`writeOffMissingStake`).

Defaults at deploy:

| Parameter | Default | Contract |
|---|---|---|
| `maxDeposits` / `maxRedeems` | constructor arguments (`Params`; 1 to 50 entries each, `MAX_ENTRIES`) | front door |
| `maxBatchValue` | constructor argument (`Params`; at most `MAX_BATCH_VALUE`, 5,000 TAO, and at most the primary bridge's `maxMessageValue()`, else `AboveBridgeCap`: checked at construction, by `setMaxBatchValue` either way and by `setPrimaryBridge` against the new primary) | front door |
| `batchInterval`, `minDeposit`, `depositCap`, `redeemRequestFee` | constructor arguments (`Params`); `batchInterval` is capped at `MAX_BATCH_INTERVAL` (24 hours), `minDeposit` is at least `MIN_DEPOSIT_FLOOR` (0.03 TAO, 2 × the vault's `MAX_FEE_ABS`) and at most `MAX_BATCH_VALUE` (5,000 TAO, R7), `redeemRequestFee` at most `MAX_REDEEM_REQUEST_FEE` (0.001 ETH) | front door |
| `keeper`, `oracle`, `swapper`, `maxDeliverySlippageBps` | constructor arguments (`Params`; the slippage at most `MAX_DELIVERY_SLIPPAGE_BPS`, 3%; a zero keeper, oracle or swapper stops deliveries, never claims) | front door |
| `treasury` | constructor argument (`Params`, non-zero, immutable; v3.2, Task 29): where `sweepPot` sends the pot's carried remainder | front door |
| `route0`, `deliveryRouteId`, `swapFeeBps`, `depositFeeUsdc`, `treasury` | constructor arguments (`Params`; v3.2, Task 33): route 0 checked as `setRoute` checks it, the delivery route as `setDeliveryRoute` does (it must be active, so 0), the fees at most `MAX_SWAP_FEE_BPS` (0.5%) and `MAX_DEPOSIT_FEE_USDC` ($0.25), launch 0.15% and $0.05, the treasury non-zero; the owner changes each at once, within the caps | staker |
| `MAX_BUY_SLIPPAGE_BPS` | 500 (constant, 5%): a stake's TAO is at least the oracle's value of the USDC swapped less this (v3.2, Task 33) | staker |
| `minPoolLiquidity[0]` / `[1]` | constructor argument (`Params`, `uint128[2]`: TAO/WETH, then WETH/USDC; v3.2, Task 32): measured at deploy from the pools' 30-day history (`pnpm ops pool-floors`; ruled 2026-11-13: TAO/WETH 840,821,765,121,181,246,191, a quarter of the median, and WETH/USDC 225,756,018,589,565,184, half the lowest; not a constant), non-zero at launch (Task 44's verify will check that the deployed floors are non-zero; ops has no such check yet); any value is accepted, 0 checking nothing | front door |
| `maxDailyOutflowBps` / `minDailyOutflow` | constructor arguments (`Params`), per 24-hour window per front door (at most 50% / 100 TAO) | vault |
| `maxEntryValue` / `maxMessageValue` / `minChunk` | constructor arguments (`Params`; `maxEntryValue` 10 TAO to `maxMessageValue`, `maxMessageValue` at most 5,000 TAO and the primary bridge's `maxMessageValue()`, `minChunk` 1 to 50 entries) | vault |
| `payoutDelay` | constructor argument (`Params`; owner-settable, 1 hour to 48 hours) | vault |
| `maxFeeBps` / `maxFeeAbs` | constructor arguments (`Params`; at most 5% / 0.01 to 0.015 TAO; launch 1% / 0.015 TAO) | vault |
| `maxTotalAssets` | constructor argument (`Params`) | vault |
| `minDirectDeposit` | constructor argument (`Params`) | vault |
| `claimGasRequired` | constructor argument (`Params`; 54,100,000 to 63,400,000 gas since R5) | vault |
| `hotkeyDustRao` | constructor argument (`Params`; at most `type(uint256).max / 1e9`) | vault |
| `FALLBACK_MIN_STAKE_RAO` / `FALLBACK_MIN_REMAIN_RAO` | 2,000,000 / 20,000,000 rao (0.002 / 0.02 TAO; constants since Task 23, served by the lens); the floors used are the larger of these and the live reads | vault |
| `unstakeMarginRao` | constructor argument (`Params`; at most 1 TAO) | vault |
| `msPerBlock` | constructor argument (`Params`; 61 to 60,000 milliseconds, immutable `MS_PER_BLOCK`; Revision 28; 60 or less is refused so that a block time in seconds, the old unit, is never taken for milliseconds: 2 on Base would hold a 48-hour item about 100 days): Bittensor 7,200, Base 120, calibrated so half the delay in blocks takes 5/6 of it at today's speed (1.67 times faster blocks than each chain's today, 12 s and 0.2 s), which the deploy must set. A scheduled item also waits half its delay in calibrated blocks, `ceil(delay * 1000 / (2 * MS_PER_BLOCK))`, counted from the scheduling block, so on Bittensor (the vault), whose blocks stop in a halt, the guardian always gets that many live blocks, about 0.83 of the delay at today's speed (0.42 after a 2x speed-up). The count is cumulative (R6 G): a halt that begins once those blocks are in and spans readyAt leaves the item ready in the first block after the resume, where a cancel races the execute (`BlockFloor.test_aHaltAfterTheFloorSpanningReadyAtLeavesItReadyAtTheResume`); the founder's response budget is the floor's live blocks, not the whole delay. Base's block number follows its timestamp and an outage's blocks are back-filled, so on the front door the floor comes with readyAt and the guardian's cancel (by L1 forced inclusion too) and the owner's stamp are the protection after an outage, as they always were. Delays lengthen only on blocks more than twice the calibrated time apart (1.2 times today's: Bittensor above 14.4 s; Base only by a fork). An item lapses only once its 7-day window in time and its window in blocks (half the 7 days in calibrated blocks after `readyBlock`) have both passed, so a slower chain, whose blocks reach the floor later, never strands an item; on blocks up to about twice the calibrated time apart (today's and faster) the lapse is the time window exactly | both |
| `rewardVesting` | constructor argument (`Params`; 7 days at launch; owner-settable, 1 to 30 days, a decrease scheduled 48 hours, an increase at once; a change applies from each drip's next restart, the claim schedule's (a claim, the write-down) snapshotting into `vestingPeriod` and the adoption drip's (an adoption, the write-down; Revision 27) into `adoptVestingPeriod` the longer of it and what is left of the old drip: a carried remainder never vests faster than its own schedule) | vault |
| `REGISTRY_DELAY`, `KEEPER_FALLBACK` | 7 days each (constants) | both / vault |
| `GUARDIAN_DELAY` | 8 days (constant) | both |
| `ED_RESERVE` | 1e12 wei (constant) | vault |
| `gasBase` / `gasPerEntry` toward Bittensor | 1,300,000 / 57,000 (the R4 review, the park reserve included; constructor arguments, Base adapter, and the Bittensor adapter's `inboundGasBase` / `inboundGasPerEntry`; calibrated in `test/adapters/AdapterGas.t.sol`; the live v3-test adapters have 540,000 / 26,450) | Base adapter |
| `gasBase` / `gasPerEntry` toward Base | 180,000 / 32,000 (constructor arguments, Bittensor adapter; raised at Task 65 from 140,000 / 29,900, the T61a review's I-2, an ops deploy setting) | Bittensor adapter |
| `inboundGasBase` / `inboundGasPerEntry` (R4) | the Base adapter's `gasBase` / `gasPerEntry` toward Bittensor, the lane's inbound model, `PARK_GAS_RESERVE` included, which `deliverParked` requires (constructor arguments after the alpha vault; `verify` fails when they differ) | Bittensor adapter |
| `minSendAmount` | 0.01 TAO (1e16 wei; constructor argument; keep `minDeposit` at or above it) | Base adapter |
| adapter reserve | `RESERVE_TARGET` 1e15 wei plus the 500-rao existential deposit, funded by the deployer through `fundReserve()` before the first delivery (v3-launch's 1e12 wei), and the token cushion `TOKEN_RESERVE_TARGET` through `fundCushion` | Bittensor adapter |
| `GAS_CAP` | 7,000,000 (constant) | both adapters |
| `MAX_MESSAGE_VALUE` | 5,000 TAO (constant): the most `maxMessageValue` may be | both adapters |
| `maxMessageValue` | constructor argument (`Config`), 0 < value <= 5,000 TAO; see the send limits | both adapters |

## Static analysis

**Re-run on the final source (2026-11-14, 7f3dcee, after Revision 28):** Slither again gives the same 171
results. The only changes are Revision 28's own: the `timestamp` result moved from `prune` to `_lapsed`, which now
also compares blocks, and the naming results read `MS_PER_BLOCK` for `SECONDS_PER_BLOCK`. Aderyn gives the same 5
High and 21 Low kinds, plus two `large-numeric-literal` instances: `READ_GAS = 100_000`
(`libraries/CascadeFormulas.sol:29`, the capped reads' gas check) and the block-time bound `60_000`
(`CascadeBase.sol:133`). The rows below carry both changes; no verdict changed. (R6 adds a third such constant,
`WRITE_OFF_READ_GAS = 45_000_000` in `CascadeFormulas.sol`; neither tool was re-run for R6.)

**Task 42 part 2 (2026-11-13, on 0f07933: Revision 27's source).** Run from `contracts/`:

- **Slither** 0.11.5, `slither .` (`slither.config.json` filters out `lib/` and `test/`, as `--filter-paths
  "lib/|test/"` does): **171 results** over 53 contracts (High 13, Medium 66, Low 55, Informational 37). Each has
  its verdict: the 23 in linked-library code in the library boundary's table (below; Task 42a's, every verdict
  standing), the other 148 in the Slither table here. **None needs a code change.**
- **Aderyn** 0.6.8, `aderyn .` (run in WSL: Aderyn has no Windows build): **5 High and 21 Low** issue kinds, 272
  instances on 260 lines. Each kind's verdict is in the Aderyn table here; its 16 instances in library code are also
  in the library boundary's table. **None needs a code change.**
- **`forge lint`**: exit 0 and no errors on b88b44e (2026-11-14, the final source): 66 warnings, 62 of them in
  tests and mocks (`unsafe-typecast` in test arithmetic, `incorrect-shift` on the handlers' bit masks, `1 << k`, the intended order,
  `block-timestamp` in `MockAlphaVault`, an unchecked mock call and transfer). The 4 in `src` are `unsafe-typecast`
  in the vendored Uniswap `TickMath` (`src/vendor/uniswap/TickMath.sol:28, 29, 120`), Uniswap's own code unchanged:
  an `int24` tick widened to `int256` before its absolute value, and a bit index under 256. **`forge fmt --check`**:
  clean at b88b44e.
- The DELEGATECALLs into the linked libraries, which neither tool reports, are the Slither table's first row.

**How the count moved.** v3.1: 69 results. v3.2 on 2026-10-31, when the payout math moved into a linked library:
131, against 134 on the tree just before the move (as recorded then; that tree is gone, so the facts that row
stated are checked again on today's build, in the first row below). Task 42a (2026-11-11, L1 to L4 linked): 168.
Now 171. Four results are new since Task 42a, all from R4's contract fixes (643e728, 0f4412c), which came after it:
`_payoutsOpen`'s capped staticcall (`return-bomb` and `low-level-calls`), the Bittensor adapter's `_railRead`
(`assembly`) and `convertExact`'s check of the tokens it burned (`reentrancy-balance`, R4 F-3). Three moved:
`reentrancy-benign` is now at the adapter's `_collect` (no longer at `_deliver` and `deliverParked`), `timestamp` at
the vault's `_restartPeriod` (Revision 27; it was `_vest`) and `divide-before-multiply` at `_gasModel` (it was
`gasFor`). v3.1's `arbitrary-send-eth` in `processPayouts` is L3's `finish` now (the library table). Of the 148
results outside library code, 37 fall under verdicts the earlier table had written (v3.1's, and Task 5c's for
`extsload`; the tables here replace it, extending some of its rows) and 111 have verdicts first written here, 106
of which were already among Task 42a's 168. The "Since" column names where a row's verdict was first written
(v3.1, Task 42a as "42a", this run as "42"); "+" marks a row this run extended or corrected.

### Slither: every result outside library code

| Severity | Detector (results) | Where | Verdict | Since |
|---|---|---|---|---|
| Info (not reported) | The DELEGATECALLs into the linked libraries | The vault (into L1 to L4) and L3 (into `CascadePayoutMath`) | The only DELEGATECALLs in the system, all into linked libraries: held by the delegatecall rule (rule 10 of `script/library-rules.mjs`, one of the build checks, which passed 7 of 7 at f9541cf) and counted again on the build's artifacts from 0f07933's source. The vault's runtime code has 8, one at each call site of a linked library's external function: L1 `CascadeBatchLib.deliver` (in `onBridgeMessage`), L2 `CascadeStakeLib.unstake` (in `_unstake`, which `redeemDirect` and `processPayouts` share), L3 `CascadePayoutLib.prepare` and `finish` (in `processPayouts`) and `cancel` (in `cancelPayoutBatch`), and L4 `CascadeHotkeyLib.add` (in `addHotkey`), `remove` (in `removeHotkey`) and `move` (in `moveStake`); its creation code has one more, the constructor's L4 `add` of the first hotkey. L3's runtime code has 5, all into `CascadePayoutMath`: `verify` (in `prepare` and in `cancel`), `takeChunk` (in `prepare`) and `deductFee` (in `prepare` and in `finish`). No other first-party contract has one, in runtime or creation code, and no first-party source has `delegatecall` or `callcode`. Each target is fixed: the library's address is linked into its caller's bytecode at deployment (the link graph: the vault links exactly L1 to L4, L3 the payout math), and no caller, parameter or storage slot can change it. What a library may do in its caller's context is the library boundary's (below): L1 writes the vault's shares, redeem origins and burn windows through its storage pointers and calls nothing; L2 writes nothing (no SSTORE) and calls only the staking precompile; L3 writes the payout queue, the ledger's `pending` and, on a cancel, the shares, and calls only the bridge the vault passes and the refund to the vault's caller; L4 writes the hotkey list, `isHotkey` and `lastClaimAt` and calls only the staking precompile. The payout math is pure in fact: its runtime code has no SLOAD, SSTORE, LOG, CALL, STATICCALL, DELEGATECALL or SELFDESTRUCT (read again from 0f07933's artifact: the Task 5 carry). A direct call to a library stops at the compiler's call guard (a non-view function) or runs on the library's own empty storage (a pure one). The deploy links the addresses it deployed the libraries at, and the read-back compares the linked code. | 2026-10-31; rewritten 42 |
| High | `arbitrary-send-eth` (1; L3's `finish` is in the library table) | `CcipBittensorAdapter._payOrParkNative` (`src/adapters/CcipBittensorAdapter.sol:448-469`) | By design: it pays the recipient the CCIP payload names, which only the Base adapter can have sent (`ccipReceive` admits only the router, the lane's source selector and the remote adapter as sender, `CcipAdapterBase.sol:262-276`), exactly the native TAO that message brought: `_deliver` first requires the tokens to have arrived (`_requireTokens`) and the conversion to have paid the amount less at most 1 rao (`convertExact`, else `ConversionShort`); `deliverParked` pays a park's own amount to that park's recipient, its key recomputed from the message, after `_requireNative`. Every caller holds the adapter's lock, so the recipient cannot re-enter a park function, and a refusal re-parks. The adapter campaign's forged-lane invariant (`invariant_aForgedMessageMovesNothingItDidNotCarry`) holds that no message moves more than it carried. | 42 |
| High | `weak-prng` (2) | `CascadeVault.redeemDirect` (`CascadeVault.sol:944`, `:958`) | False positive: `x -= x % RAO` floors an amount to whole rao; nothing is random. | v3.1 |
| High | `incorrect-exp` (1) | `FullMath.mulDiv` (`src/vendor/uniswap/FullMath.sol:88`) | Intended: `(3 * denominator) ^ 2` is a XOR, the seed of Newton's iteration for the modular inverse (correct to four bits), as Uniswap v3-core has it. Vendored unchanged (`src/vendor/uniswap/VENDOR.md` records the commit and each file's SHA-256); only `CascadeTwapOracle` uses it. | 42 |
| High | `reentrancy-balance` (7) | The Bittensor adapter's `_collect` (`:366-384`) and `convertExact` (`:202-220`); `CascadeStaker._swap`, four paths (`CascadeStaker.sol:301-330`); `CascadeFrontDoor.deliver` (`CascadeFrontDoor.sol:530-566`) | The intended measurement: each reads a balance before a call and a fresh one after, and judges the call by the difference (the tokens minted or burned, the input the router took and the output it paid, the USDC the swapper paid); the "stale" value Slither names is that reference point, never used as a current balance. The callees: the adapter's immutable ForeverMoney AlphaVault (every caller of `convertExact` holds the adapter's lock, and `refundParked` holds it around `_collect`; `send` takes none, and between its collect and the CCIP send it runs only the immutable AlphaVault, token and router, as `sweepSurplus`'s note requires); the staker's owner-set router (`stake`, `stakeWithPermit` and `sellFor` are all `nonReentrant`, and a wrong route can only make the call revert); the front door's scheduled swapper (under the door's lock, the user's credit cleared before the call). | 42 |
| High | `reentrancy-eth` (1) | `CascadeFrontDoor._requestRedeem` (`:387-410`) | The self-close path. Every function that moves ETH or tokens is `nonReentrant`. The self-close pays the caller nothing (its budget is the pot, so `_pay` gets 0), so its only outside code is the primary bridge's `send`; the functions open mid-call are `creditRedeemFee`, which only adds credit (credit added there may pay the same request's fee, which is taken after the close), and `setDelivery`, which writes only its caller's own preference. | v3.1+ |
| Medium | `divide-before-multiply` (31) | The vault's `stakeIdle` (`:743`, `:752`), `_idleBuffer` (`:1413`) and `_unstake` (`:1537`); `CcipAdapterBase._gasModel` (`:150`); `FullMath` (8) and `TickMath` (19), vendored | Intended: `stakeIdle` floors the liquid TAO to whole rao before staking it and books exactly the rao staked, in wei; `_idleBuffer`'s `RAO / 10_000` is exact (1e5); `_unstake` rounds the walk's cost up to whole rao, in the vault's favour; `_gasModel`'s `(words - header) / 2` is exact (any other message gets the cap). The vendored ones are Uniswap's, unchanged. | 42 |
| Medium | `incorrect-equality` (5) | The front door's `_pay` (`amount == 0`, `:818`) and `closeBatch` (both lists empty, `:432`); the vault's `redeemDirect` (`out == 0`, `:946`; `paid == 0`, `:960`) | Intentional zero checks. | v3.1 |
| Medium | `incorrect-equality` (the fifth) | The vault's `cancelPayoutBatch` (`CascadePayoutLib.cancel(...) == launchChain`, `:1118`) | A chain id compared with the immutable launch chain (whether the cancelled batch was a launch-door batch, whose cancel is an instrument that stamps the owner's clock): an identifier, never a balance or a time. | 42 |
| Medium | `reentrancy-no-eth` (5) | The vault's `claimRewards` (`:835`) and `stakeIdle` (`:748`) | Calls into the staking precompile, which is runtime code, not EVM code, and cannot re-enter. | v3.1 |
| Medium | `reentrancy-no-eth` | The Bittensor adapter's `_deliver` (`:418`) and `deliverParked` (`:245`) | The call is `this.convertExact`, the adapter's own function (`OnlySelf`), made with the adapter's lock held; its one outside call is the immutable AlphaVault's `withdrawLiquid`. `_deliver` writes a park only in the `catch`, after a failed conversion, which keeps nothing it did; `deliverParked` lowers the park's total before the call and deletes the record after it, before the recipient's call, the one call that could re-enter (it meets the lock). | 42 |
| Medium | `reentrancy-no-eth` | `CascadeBase.execute` (`:172`) | The scheduler's self-call: the item is deleted before it, and `_executingHash`, transient, admits only that calldata while it runs and is cleared after (I-25; `ProbeBridge` re-enters from inside every cap check). Owner only. | 42 |
| Medium | `uninitialized-local` (16; 10 in library code) | The vault's `redeemDirect` (`unmet` and `cost`, `:951-952`), `removeFrontDoor` (`closes`, `:443`) and `writeOffMissingStake` (`unlisted`, `:800`); the Bittensor adapter's `_deliver` (`sum`, `:404`); `CcipAdapterBase.ccipReceive` (`amount`, `:268`) | Intentional zero starts: an exit the liquid balance covers walks nothing, so nothing is unmet and nothing costs; a removal that closes nothing; a failed read of the coldkey's total counts as 0 (the function's documented rule); a sum; a message with no tokens carries 0 (a redeem-only batch). v3.1's two (the delivery's queue and the burn total) are L1's now. | v3.1+ |
| Medium | `unused-return` (9) | The front door's `deliver` (`sellFor`, `:560`); `CascadeStaker._swap` (`exactInput`, `:317`, `:322`); the Bittensor adapter's `convertExact` (`withdrawLiquid`, `:209`), `_collect` (`depositLiquid`, `:371`), `_deliver` and `_refundOf` (`decodeBatch`, `:403`, `:525`); `CascadeTwapOracle._checkPool` (`slot0`, `:107`) and `_observe` (`observe`, `:121`) | By design: no swap's or conversion's own answer is trusted; the balance difference is measured instead (the `reentrancy-balance` row). The adapter needs only a batch's deposits (it checks their sum, and refunds them); the oracle needs only `slot0`'s observation cardinality; `_observe` returns `observe`'s values (a false positive). | 42 |
| Low | `missing-zero-check` (6) | `CascadeBase.setGuardian` (`:204-206`); the five addresses of `CascadeTwapOracle`'s constructor (`:65-72`) | `setGuardian` runs only through `execute`, and scheduling it refuses a zero guardian (`_classify`, `CascadeBase.sol:296-298`; `execute` runs exactly the scheduled calldata). The oracle's constructor checks each pool's `token0` and `token1` against the token arguments, and its observation cardinality (`_checkPool`): a zero pool has no code, so the call reverts, and a zero token matches no pool. (v3.1's row, `setKeeper`, is no longer reported; its verdict stands: `address(0)` leaves only the 7-day fallback.) | 42 |
| Low | `reentrancy-benign` (6) | The Bittensor adapter's `_collect` (`tokenCushion -= short`, `:379`) and `_payOrParkNative` (the park, `:466-467`); the front door's `_requestRedeem` (the fee credit, `:401-402`); the vault's `_unstake` (`:1533`) and `removeHotkey` (`:726`) (`_unstaking = false`), and `claimRewards` (the ledger and the schedule, `:841-874`) | `_collect`: the immutable AlphaVault, as in the `reentrancy-balance` row. The park: written only when the recipient's call reverted, so nothing that call did survives, under the adapter's lock. The fee credit: the self-close, as in the `reentrancy-eth` row. The unstake flag: set exactly around L2's walk and the owner's L4 removal, so that the precompile's TAO may enter `receive()`, and cleared after; L2 and L4 call only the staking precompile (`test_thePrecompilesTaoInsideL2MeetsTheLock`, `test_hotkeyLibCallsOutOnlyToThePrecompile`). `claimRewards`: the precompile cannot re-enter, and the function is `nonReentrant`. | 42 |
| Low | `reentrancy-events` (7; 4 in library code) | `CcipAdapterBase._ccipSend` (`Sent`, `:230-232`); the Bittensor adapter's `_collect` (`ShortfallCovered`, `:380`); `CascadeBase.execute` (`Executed`, `:179`) | Each event reports the call's outcome (CCIP's message id, the shortfall the mint left, a run that succeeded), so it follows the call. The router and the AlphaVault are immutable; `execute`'s call is the contract's own. | 42 |
| Low | `return-bomb` (1) | `CascadeVault._payoutsOpen` (`:1364-1369`) | Bounded, and a trusted target. The staticcall to the primary bridge's `canSendPayouts()` is given at most `RAIL_VIEW_GAS` (150,000), and memory costs grow with the square of its size, paid first by the callee inside that cap, so the vault's copy of whatever it returns costs at most about as much again (some 200,000 gas at the worst). The target is the owner-registered primary bridge (7-day registry, the guardian's veto), which already decides whether payouts move; the Bittensor adapter's view answers one word. A delivery left short of gas reverts, and the adapter parks it whole. Hardening not taken: copy at most one word, as the adapter's `_railRead` does (the vault has 680 B of headroom). New since Task 42a (R4, S-H1). | 42 |
| Low | `timestamp` (33; 3 in library code) | Time comparisons (14): `CascadeBase.execute`, `_lapsed` (`prune`'s test before Revision 28 moved it; an item lapses only once both its time and its block window have passed) and `acceptOwnership` (the class delays, `EXECUTE_WINDOW`), `stampBySig` (`STAMP_MAX_TTL`) and `_gate` (an actor's clock against an item's schedule time); the front door's `canClose` (`batchInterval`), `deliver` and `_setDelivery` (the user's deadline); `CascadeStaker._stake` (the caller's deadline); the vault's `adoptStake` (`STAKE_RAMP`), `_requireKeeperOrAfter` (`KEEPER_FALLBACK`) and `_restartPeriod` (a drip's end); the Bittensor adapter's `refundParked` and `dropParked` (`PARK_TIMEOUT`, 14 days) | Windows of hours to weeks tolerate a block producer's few seconds of drift (v3.1's verdict); a deadline is its caller's own; `_gate` orders two timestamps the chain recorded; `_restartPeriod`'s period moves by the drift at most. | v3.1+ |
| Low | `timestamp` | Not time comparisons (16): the front door's `_requestRedeem`, `closeBatch`, `onBridgeMessage`, `_closeBatch` and `_pay`; the vault's `stakeIdle`, `writeOffMissingStake`, `claimRewards`, `depositDirect`, `redeemDirect`, `onBridgeMessage`, `processPayouts`, `cancelPayoutBatch`, `_idleBuffer`, `_unvestedForMint` and `_unstake` | Slither flags any comparison whose operands it can trace to a timestamp somewhere in the function (an unvested amount, a ramp, a batch start written nearby); these compare amounts, list lengths or flags (`amount == 0`, `fee != 0`, `rao < minStakeRao()`, `unmetWei` against the tolerance). | 42 |
| Info | `assembly` (7) | `CascadeBase.extsload` (`:460-464`) | From v3.2's Task 5c: a single `sload` of the slot its caller names, in a `view` (it reads one word and writes nothing; every slot it can reveal is public on-chain anyway). | v3.2 (5c) |
| Info | `assembly` | `CascadeBase.execute` (`:175-177`); `CascadeStaker._checkPath` (`:339-341`); the Bittensor adapter's `_railRead` (`:476-481`) and `_caughtSelector` (`:497-502`); `FullMath` and `TickMath`, vendored | All memory-safe, and none in a linked library (the library rules' assembly rule). `execute` re-raises the self-call's revert data as it came; `_checkPath` reads a path's last token, after a length check that keeps that word inside the path; `_railRead` (new since Task 42a) is a STATICCALL capped at `RAIL_READ_GAS` that copies at most one word, into scratch space; `_caughtSelector` reads the first 4 bytes of the return data and never copies the rest, so no revert data can eat the gas reserve. The vendored ones are Uniswap's. | 42 |
| Info | `cyclomatic-complexity` (3; 2 in library code) | `TickMath.getSqrtRatioAtTick` (vendored) | Uniswap's, unchanged. | 42 |
| Info | `dead-code` (6) | The vault's `bookedStake`, `missingStakeRao`, `surplusStakeRao`, `unlistedStakeRao` and `minRemainRao` (`:566-638`); `CascadeBase._checkBridgeCaps` (`:407`) | The vault's derived values, kept under the names the vault lens serves: the test harness exposes each (`test/utils/VaultInternals.sol:378-421`) and `LensParity` checks the lens against it. The compiler emits no code for an internal function nothing calls, so the deployed vault carries none. `_checkBridgeCaps` is the base's empty default, which the front door and the vault override and `setPrimaryBridge` calls. | 42 |
| Info | `solc-version` (2) | The vendored CCIP and Uniswap files (`^0.8.0`, `^0.8.4`) | Every file compiles with solc 0.8.38 (`foundry.toml`), which has none of the bugs listed; the vendored pragmas stay as published. | 42 |
| Info | `low-level-calls` (6; L3's refund is in the library table) | The front door's `_pay` (`:819`); the vault's `redeemDirect` (`:962`); `CcipAdapterBase._sweep` (`:290`) | Intended value sends. | v3.1 |
| Info | `low-level-calls` | `CascadeBase.execute` (`:172`); the vault's `_payoutsOpen` (`:1366-1367`) | The scheduler's self-call (I-25); the capped, fail-open read of the primary bridge's `canSendPayouts()` (the `return-bomb` row). | 42 |
| Info | `naming-convention` (9) | `IStaking.moveStake`'s four parameters | The precompile's own snake_case parameter names. | v3.1 |
| Info | `naming-convention` | `CascadeBase.DOMAIN_SEPARATOR` and `MS_PER_BLOCK` (immutables, `:69`, `:87`; `SECONDS_PER_BLOCK` before Revision 28); `IExtsload.MS_PER_BLOCK()`; `CascadeBaseLens.DOMAIN_SEPARATOR()` and `MS_PER_BLOCK()` | Immutables named as constants, `DOMAIN_SEPARATOR` as EIP-712 names it; the getters keep the names the lenses serve. | 42 |
| Info | `too-many-digits` (1) | `TickMath` (vendored) | Uniswap's. | 42 |
| Info | `unindexed-event-address` (1) | `RewardCutSet(address treasury, uint16 bps)` (`CascadeEvents.sol:70`) | An owner setter's rare event, found by the vault's address and its topic; indexing the address would change its topics, which the indexer's ABI declares. No change. | 42 |
| Info | `unused-state` (2) | The vault's `MAX_HOTKEYS` (`:109`); `CcipAdapterBase.RAO` in `CcipBaseAdapter` (`:43`) | Constants, which take no storage: the vault's names the bound its NatSpec cites (L2 and L4 read `Constants.MAX_HOTKEYS`); `RAO` is the Bittensor adapter's. | 42 |

### Aderyn: every issue kind

Aderyn's names, its count of instances, where (outside library code; its library instances are in the library
boundary's table), and the verdict.

| Kind (instances) | Where | Verdict | Since |
|---|---|---|---|
| H-1 `eth-send-unchecked-address` (6) | The front door's `requestRedeem` and `requestRedeemWithDelivery` (`:373`, `:378`) and `closeBatch` (`:428`); the vault's `redeemDirect` (`:940`); both adapters' `sweepSurplus` (`CcipBaseAdapter.sol:30`, `CcipBittensorAdapter.sol:337`) | Each pays its caller its own value (a redeem request's self-close refund, which is 0; a closer's unused value; a direct exit's payment) or the immutable treasury (the sweeps); the bridge sends go to the owner-registered primary. | 42 |
| H-2 `incorrect-caret-operator` (1) | `FullMath.sol:88` (vendored) | Slither's `incorrect-exp` row: intended. | 42 |
| H-3 `incorrect-shift-order` (1) | The Bittensor adapter's `_caughtSelector` (`:500`) | A false positive: Yul's `shl(shift, value)`, so `shl(224, 0xffffffff)` moves the 4-byte mask to the top of the word, and the `and` keeps the selector. | 42 |
| H-4 `reentrancy-state-change` (12; L4's `remove` is in the library table) | The constructors (the front door `:249`, the staker `:131`, the vault `:356`); views (the front door's `onBridgeMessage` `:477`, `deliver` `:548` and `:552`); the vault's `removeFrontDoor` (`:448`); the vault's `stakeIdle` (`:748`), `writeOffMissingStake` (`:801`) and `claimRewards` (`:835`); the Bittensor adapter's `deliverParked` (`:245`) | The constructors' calls run before the contract has code anyone could re-enter (the asset's `decimals`, the front door's `asset` and `usdc`, the address-mapping precompile). The views (`balanceOf`, the oracle's reads) compile to STATICCALL, and run under the door's lock. In `removeFrontDoor`, `this.activateFrontDoor` inside `abi.encodeCall` only names a selector: nothing is called. The precompile cannot re-enter (Slither's `reentrancy-no-eth` row). `deliverParked`: Slither's row for `this.convertExact`. | 42a+ |
| H-5 `unsafe-casting` (5) | `CascadeShares.addFresh` (`:68`, `:70`); `CcipAdapterBase.extraArgs` (`:158`); the Bittensor adapter's `_deliver` and `_payOrParkNative` (`:427`, `:466`) | Each bounded, as its comment says beside forge-lint's waiver: `since` is at most now (a weighted mean of an earlier time and now) and `fresh` is capped at `type(uint128).max`; a gas limit is at most `GAS_CAP` (7,000,000), which fits `uint32`; an amount of bridged tokens the adapter holds is at most the token's supply (2.1e25 wei, far below 2^128). | 42 |
| L-1 `centralization-risk` (37) | The owner's functions across `CascadeBase`, the front door, the staker and the vault | The stated trust model ("v3 trust model", "Roles"): every loosening waits its class delay under the guardian's veto (spec §3.6), within hard bounds, and `renounceOwnership` is disabled; the staker's routes and fees are the owner's at once, within caps in code (`MAX_SWAP_FEE_BPS`, `MAX_DEPOSIT_FEE_USDC`, the 95% buy floor). | 42 |
| L-2 `costly-loop` (1) | The front door's `onBridgeMessage` (`:485`) | One credit per payout entry, at most `MAX_ENTRIES` (50) a message, inside the lane's gas model. | 42 |
| L-3 `dead-code` (5) | The vault (`:566-638`) | Slither's `dead-code` row. | 42 |
| L-4 `division-before-multiplication` (1) | The vault's `_unstake` (`:1537`) | The walk's cost rounded up to whole rao (Slither's `divide-before-multiply` row). | 42 |
| L-5 `ecrecover` (1) | `CascadeBase.stampBySig` (`:260`) | Malleability is refused: `s` in the lower half of the curve order (EIP-2), `v` 27 or 28, a zero signer refused; a replay moves nothing (the owner's clock only moves forward). | 42 |
| L-6 `empty-block` (3) | `CascadeBase._onGuardianSet` (`:347`) and `_checkBridgeCaps` (`:407`); the vault's `_classify` (`:473`) | Virtual defaults the vault and the front door override; in `_classify`, the one-word setters' branch keeps the defaults (its comment says so). | 42 |
| L-7 `empty-require-revert` (4) | `CascadeVaultLens.hotkeys` (`:73`); `FullMath` (3, vendored) | Past the end of the set the lens reverts without data, as the vault's v3.1 getter did (ruling DA6: a reader takes a failed read as the end). | 42 |
| L-8 `internal-function-used-once` (10; 3 in library code) | `CascadeBase.guardianHold` and `exitsOpen` (`:357`, `:362`); the vault's `pricedStakeRao`, `unvestedRewards` and `batchKey` (`:597`, `:608`, `:969`); `FullMath.mulDiv` and `TickMath.getSqrtRatioAtTick` (vendored) | Virtual hooks the vault overrides, and named derived values the vault lens mirrors under the same names. No change. | 42a+ |
| L-9 `large-numeric-literal` (27 on 25 lines; 29 on 27 since Revision 28; 3 in library code) | `CascadeConstants.sol`, the front door, the staker, the vault, both adapters; since Revision 28, `CascadeBase`'s constructor and `CascadeFormulas` | Underscored literals: basis-point denominators (`10_000`), the half-launch-price factor (`2_000_000`), gas figures (`150_000`, `30_000`, `7_000_000`; Revision 28's `READ_GAS = 100_000`), the block-time bound (`60_000` ms) and the constants file. Style; no change. | 42a+ |
| L-10 `literal-instead-of-constant` (60) | The same literals, the lenses' and `TickMath`'s (vendored) | Style; no change. | 42 |
| L-11 `local-variable-shadowing` (47) | The constructors' `Params` members (the front door `:66-85`, the staker `:51-59`, the vault `:184-207`) | Struct fields named as the state variables they set, read as `p.field`: they shadow nothing (the warning gate keeps `src/` free of solc's shadowing warnings). | 42 |
| L-12 `modifier-used-only-once` (1) | `CascadeBase.onlyOwnerOrGuardian` (`:109`) | Style. | 42 |
| L-13 `non-reentrant-not-first` (10) | The front door (`:318`, `:445`, `:533`), the staker (`:229`), the vault (`:740`, `:768`, `:886`, `:940`, `:1090`, `:1117`) | The modifiers before `nonReentrant` (`whenNotPaused`, `onlyOwner`) only read state and call nothing, so the order changes nothing. | 42 |
| L-14 `push-zero-opcode` (5) | The vendored files' pragmas | The build targets Cancun (`foundry.toml`), and both chains run PUSH0: v3-launch's contracts, built the same way, run there. | 42 |
| L-15 `state-change-without-event` (2) | The vault's `removeHotkey` (`:710`) and `processPayouts` (`:1086`) | Their events are logged by the libraries, at the vault's address (L4's `HotkeyRemoved` and `CascadeLedger`'s `Unstaked`; L3's `PayoutChunkSent` and L2's `Unstaked`), which Aderyn does not follow; the transient unstake flag needs none. | 42 |
| L-16 `state-no-address-check` (6) | `CascadeBase.setGuardian` (`:206`) and `setPrimaryBridge` (`:438`); the front door's `_setKeeper`, `_setSwapper` and `_setOracle` (`:642`, `:653`, `:663`); the vault's `_setKeeper` (`:1134`) | `setGuardian`: refused at schedule (Slither's `missing-zero-check` row). `setPrimaryBridge` takes only an enabled bridge, never zero. On the front door a zero keeper, swapper or oracle stops deliveries (and, for the oracle, stakes), never claims: by design. The vault's keeper: v3.1's `setKeeper` verdict (`address(0)` leaves only the 7-day fallback). | v3.1+ |
| L-17 `unchecked-return` (6) | `CascadeBase` (`:110`); the front door (`:560`); the staker (`:317`, `:322`); `CcipAdapterBase.send` (`:192`); the Bittensor adapter (`:209`) | `onlyOwnerOrGuardian` calls `_actor()` for its revert, not its answer; the swaps and the conversion are measured by balance (Slither's `unused-return` row); `send` drops `_ccipSend`'s message id, which `Sent` logs. | 42 |
| L-18 `uninitialized-local-variable` (14; 9 in library code) | Loop counters, `uint256 i;` (the front door `:472`, `:485`; the vault `:560`; the Bittensor adapter `:405`; the vault lens `:456`) | Zero by default: the loop's start. | 42a+ |
| L-19 `unspecific-solidity-pragma` (2) | The vendored CCIP interfaces | Compiled at 0.8.38; the vendored pragmas stay as published. | 42 |
| L-20 `unused-error` (3) | `IRouterClient`'s errors (vendored) | Chainlink's interface, unchanged. | 42 |
| L-21 `unused-state-variable` (2) | The vault's `MAX_HOTKEYS` (`:109`) and `RAIL_VIEW_GAS` (`:117`) | `MAX_HOTKEYS`: Slither's `unused-state` row. `RAIL_VIEW_GAS`: a false positive; it is the gas option of `_payoutsOpen`'s staticcall (`:1367`). | 42 |

### The library boundary

Spec §8.1, §9.1 and I-32; Task 42a. A linked library is also deployed on its own, and anyone can call
it. The boundary is held by the tests in `test/libraries/` (`LibraryBoundary.t.sol` covers every
function and every re-entry below; `BatchLibBoundary`, `StakeLibBoundary` and `PayoutLibBoundary`
keep their per-library proofs), by the library rules (`node script/library-rules.mjs`, a build
check) and by the storage table below, read against §8.1.

**Every external function, called directly.** The list is the build's: the library rules read each
linked library's functions from its artifact (`methodIdentifiers`, each function's kind from the
artifact's AST; solc's JSON ABI lists only a library's view and pure functions, so L1 to L4's
list none) and fail when a function has no entry in `BOUNDARY_TESTS`, an entry has no function, a
kind differs, or the named test does not name the function's selector. A function added to a
library fails the build checks until a test calls it directly.

| Library | Function (solc's signature) | Selector | Kind | Direct-call test |
|---|---|---|---|---|
| L1 `CascadeBatchLib` | `deliver(SharesData storage,mapping(bytes32 => Window) storage,mapping(address => uint64) storage,BatchIn,bytes)` | `0x81e3f1da` | non-view | `test_everyNonViewLibraryFunctionStopsAtTheCallGuard` (and `BatchLibBoundary`'s `test_directCallToDeliverReverts`) |
| L2 `CascadeStakeLib` | `unstake(WalkParams,uint256)` | `0x5086fc13` | non-view | the same (and `StakeLibBoundary`'s `test_directCallToUnstakeReverts`) |
| L3 `CascadePayoutLib` | `prepare(bytes32,CascadeMessages.Payout[],uint32,PayoutIn)` | `0x18d7beec` | non-view | the same (and `PayoutLibBoundary`'s `test_directCallsToPrepareFinishAndCancelRevert`) |
| L3 `CascadePayoutLib` | `finish(mapping(bytes32 => PayoutBatch) storage,Ledger storage,bytes32,CascadeMessages.Payout[],PayoutIn,PayoutPlan)` | `0x78dab3ac` | non-view | the same (and the same) |
| L3 `CascadePayoutLib` | `cancel(SharesData storage,mapping(bytes32 => PayoutBatch) storage,Ledger storage,bytes32,CascadeMessages.Payout[],uint256)` | `0x2567bbbf` | non-view | the same (and the same) |
| L4 `CascadeHotkeyLib` | `add(bytes32[] storage,mapping(bytes32 => bool) storage,mapping(bytes32 => uint64) storage,bytes32,bool,bytes32,uint256)` | `0xf169d8ed` | non-view | `test_everyNonViewLibraryFunctionStopsAtTheCallGuard` |
| L4 `CascadeHotkeyLib` | `remove(bytes32[] storage,mapping(bytes32 => bool) storage,bytes32,bool,bool,bool,bytes32,bytes32,uint256,uint256)` | `0x9fa435b8` | non-view | the same |
| L4 `CascadeHotkeyLib` | `move(bool,bytes32,bytes32,uint256,bytes32,bytes32)` | `0x29b48baa` | non-view | the same |
| `CascadePayoutMath` | `verify(CascadeMessages.Payout[],uint256,bytes32)` | `0x49c42746` | pure | `test_everyPureLibraryFunctionKeepsTheValueAndTouchesNothing` |
| `CascadePayoutMath` | `takeChunk(CascadeMessages.Payout[],uint256,uint256,uint256,uint256)` | `0x6202d023` | pure | the same |
| `CascadePayoutMath` | `deductFee(CascadeMessages.Payout[],uint256,uint256,uint256,uint256)` | `0x752f6740` | pure | the same |

A non-view function stops at the compiler's call guard: with and without value it reverts with no
data, keeps no value, reads, writes and logs nothing and never reaches the vault; the same calldata
run by DELEGATECALL from a stand-in gets past the guard (`deliver`, `unstake`, `prepare`, `add`,
`move` and `remove` run; `finish` and `cancel` revert in their bodies, with data, on the stand-in's
empty storage), so the guard is what stopped it: an empty revert alone could also be a decoding
failure. A pure function runs when
called directly with value, on the library's own empty storage; it emits nothing, leaves the vault
unchanged and keeps the value. A library's balance is informational, never a verify failure or a
keeper stop (rev 12 L-4). A plain transfer, an unknown selector or a pure function that fails keeps
nothing, so a view or pure call with value is the only way to leave TAO at a library.

**Re-entry across the boundary meets the vault's lock.** Library code calls EVM code that could re-enter in
three places, each under the vault's `nonReentrant` (`processPayouts`, `redeemDirect`), and a probe re-enters
from each of them every one of the vault's eight lock-guarded entry points (`stakeIdle`, `adoptStake`,
`claimRewards`, `depositDirect`, `redeemDirect`, `onBridgeMessage`, `processPayouts`, `cancelPayoutBatch`, the
last as the owner so the lock is what refuses it):

| Where library code calls out | Test (`LibraryBoundary.t.sol`) | What it shows |
|---|---|---|
| L3's `send` to the primary bridge (`finish`) | `test_aReentrantBridgeSendMeetsTheLock` (and `PayoutLibBoundary`'s `test_reentrantBridgeHitsTheVaultsLock`) | each re-entry reverts `ReentrancyGuardReentrantCall`, and 1 wei sent back is refused by `receive()` (the unstake flag is clear across a bridge call); caught, the payout ends exactly as a plain one (the same state and logs); bubbled, it reverts whole and nothing moved |
| L3's refund to the caller (`finish`'s last statement) | `test_aReentrantRefundTargetMeetsTheLock` (and `VaultPayouts`' `test_reentrantCallerRefusedAtTheRefund`) | the same; bubbled, the refund fails and the payout reverts `TransferFailed`, nothing moved |
| L2's removals (the staking precompile, in `redeemDirect`'s and `processPayouts`' walks) | `test_thePrecompilesTaoInsideL2MeetsTheLock` (and `StakeLibBoundary`'s `test_receiveOnlyWhileUnstaking`) | a re-entering precompile (MockStaking's code behind a probe) is refused at the lock, and its TAO enters `receive()` mid-walk, under the flag; caught, the exit ends exactly as a plain one; bubbled, the walk skips the removal and the exit reverts `UnstakeShort`, nothing moved; after the walk `receive()` refuses value |
| L4's calls (`addHotkey`, `removeHotkey`, `moveStake`) | `test_hotkeyLibCallsOutOnlyToThePrecompile` | every call an L4 frame makes, on every path, goes to the staking precompile with no value; the only call back is the precompile's TAO into `receive()` on the owner's direct removal, under the flag. No L4 path calls code that can re-enter, so those entry points stay outside the lock, as in v3.1 |

Spec §9.1's re-entrant payout recipient is on Base, behind the bridge and the front door: the vault's only call
toward it is the bridge's `send`, the first row. The entry points outside the lock (`addHotkey`, `removeHotkey`,
`setRedeemOrigin`, the owner's setters and `execute`) can be reached from the send or the refund. They are safe
there: L3's `finish` makes every effect before the send, and the walk is booked before `finish`, so a re-entry sees
the state a call after the payout would. A stranger's `addHotkey` from inside the send is refused `NotEligible`, as
it is outside (`test_aStrangersAddHotkeyInsideTheSendIsRefusedAsOutside`).

**The storage each library writes**, against §8.1. A library has no state of its own and no assembly
(the library rules), so it can write the vault's storage only through the storage pointers the vault
passes. The table reads that three ways, on 2026-11-11 over `src/` (solc 0.8.38, `via_ir`):

- *the test*, `test_eachLibraryWritesOnlyItsDeclaredFields` (ruling DB8): every write in every
  DELEGATECALL frame of each library's code, in the vault's own runs, named by the generated layout.
  Foundry's state diff files a caller's storage accesses after a callee returns under the callee's
  last resume record when the callee accessed storage (a read is enough) after its own last call
  (L3's `cancel` does), so in that test each library runs its own code through a pass-through at its
  linked address that closes its records, and a write to the vault's storage in any record below a
  library's frame is refused (`test_aVaultWriteBelowALibraryFrameIsRefused`);
- *Slither* 0.11.5 (`slither . --filter-paths "lib/|test/"`, then `--print vars-and-auth,function-summary`):
  it reports no state variable written by any library function (DB8's prediction: the writes go
  through storage parameters), and the vault's entry points list only their own writes. What it does
  read is the storage each library call receives at the vault's call sites, its function summary's
  library calls;
- *Aderyn* 0.6.8 (`aderyn .`): 88 detectors; like Slither it lists findings, not writes, and reports
  no storage write by a library. Its one library finding about state is `reentrancy-state-change` at
  L4's `remove`.

| Library | §8.1: it writes | The test: writes seen | Slither: storage each call passes | Aderyn | Verdict |
|---|---|---|---|---|---|
| L1 `CascadeBatchLib` | balances and supply, the redeem origins, both burn windows | `deliver`: the supply, the balances, `redeemOrigin`, `burnWindows` (the door's and the global window) | `deliver(_shares, burnWindows, redeemOrigin, …)` | none on state (`uninitialized-local-variable` ×3, `large-numeric-literal` ×1) | Matches. The origins and windows are read and written through their pointers (a mapping cannot be passed as a memory copy) |
| L2 `CascadeStakeLib` | nothing | nothing (and no SSTORE in its bytecode) | `unstake(p, wantWei)`: no storage (a memory copy of the hotkeys) | none on state (`uninitialized-local-variable` ×2) | Matches |
| L3 `CascadePayoutLib` | the payout queue, the ledger and, on a cancel, balances and supply | `prepare`: nothing; `finish`: `payoutBatches`, `ledger.pending`; `cancel`: those, the supply and the balances | `prepare(key, payouts, maxEntries, input)`: none; `finish(payoutBatches, ledger, …)`; `cancel(_shares, payoutBatches, ledger, …)` | none on state (`uninitialized-local-variable` ×2) | Matches. Of the ledger only `pending` (`booked` and `ramping` are the vault's, booked after the walk) |
| L4 `CascadeHotkeyLib` | the hotkey list, `isHotkey`, `lastClaimAt` | `add`: `hotkeys`, `isHotkey`, `lastClaimAt`; `remove`: `hotkeys`, `isHotkey`; `move`: nothing | `add(hotkeys, isHotkey, lastClaimAt, …)`; `remove(hotkeys, isHotkey, …)`; `move(isHotkey[from], …)`: no storage | `reentrancy-state-change` at `remove`: the list's writes after the precompile's reads and move (`uninitialized-local-variable` ×1) | Matches; also held on solc's AST by the write-set rule |
| `CascadePayoutMath` | nothing | nothing (and no SSTORE or LOG in its bytecode) | not called by the vault (L3's calls pass calldata only) | none on state (`uninitialized-local-variable`, `internal-function-used-once`, `large-numeric-literal`, one each) | Matches |

Each library finding, with its verdict (Task 42a: Slither's 168 results over `src/`, 23 in library code; Aderyn's 26
issue kinds, 16 instances in library code. Task 42 part 2's runs on 0f07933, 171 results and the same 26 kinds, find
the same 23 and 16, and every verdict below stands):

| Tool | Finding in library code | Verdict |
|---|---|---|
| Slither | `arbitrary-send-eth` (High) in `CascadePayoutLib.finish` | By design: the send goes to `PayoutIn.bridge`, the owner-registered primary bridge the vault reads and passes (the call rule holds the field and the struct unwritten), and the refund to `msg.sender`, the vault's caller, is its own value less the top-up (value only, empty calldata, `finish`'s last statement). Both run under the vault's lock (the re-entry tests above) |
| Slither | `reentrancy-events` ×4 (Low): L4's `_move` and `remove`, `CascadeLedger.removalDebit`, L3's `finish` | Events after the staking precompile's calls, which cannot re-enter, and after the bridge's send, under the lock with the unstake flag clear; v3.1's event order, which the indexer and the keeper read |
| Slither | `low-level-calls` (Info) in `finish` | The refund, as above |
| Slither, Aderyn | `uninitialized-local` ×10 / `uninitialized-local-variable` ×9 | Intentional zero starts (counters, sums, the cancel's carried hash, L4's unclaimed read before its `try`) |
| Slither | `calls-loop` ×2 (Low) in L2's `_tryRemoval` | Bounded by `MAX_HOTKEYS` = 4 positions, each removal in a `try` with its gas share |
| Slither | `timestamp` ×3 (Low): L3's `prepare`, `CascadeFormulas.unspent` and `currentWindow` | The 24-hour delay and windows tolerate drift |
| Slither | `cyclomatic-complexity` ×2 (Info): L4's `remove`, L3's `prepare` | v3.1's checks, moved whole |
| Aderyn | `reentrancy-state-change` (High) at L4's `remove` | The list's writes come after the precompile's views (`getStake`, the unclaimed read) and the leftover's move or removal, in v3.1's order; the precompile is runtime code and cannot re-enter, and every call an L4 frame makes is to it (`test_hotkeyLibCallsOutOnlyToThePrecompile`) |
| Aderyn | `internal-function-used-once` ×3, `large-numeric-literal` ×3 (Low) | Shared helpers and basis-point constants; no change |

Neither tool reports the vault's DELEGATECALLs into its linked libraries (as on 2026-10-31); the
delegatecall rule holds them, and the Slither table's first row counts them.

**Review checklist for the auditor (the library boundary).**
1. *Pointer aliasing.* Each library function's storage parameters have distinct types (L1: `SharesData`,
   `mapping(bytes32 => Window)`, `mapping(address => uint64)`; L3's `finish`: the queue and `Ledger`, `cancel` those
   and `SharesData`; L4: `bytes32[]`, `mapping(bytes32 => bool)`, `mapping(bytes32 => uint64)`), so no two can name
   one slot, and the vault passes each state variable by name (the write-set rule binds L4's). What a library only
   reads comes by value or as a memory copy (`BatchIn`, `PayoutIn` and the batch it holds, `WalkParams` with the
   hotkey list); the call rule refuses any write to `PayoutIn` or, in memory, to its batch (`prepare`'s and
   `finish`'s `b` alias it). Check that no library keeps a storage reference past a write it does not expect.
2. *Events from libraries.* Every library event is logged by the vault's address (DELEGATECALL), in v3.1's order,
   and a direct call to a library logs nothing (the guard; the payout math has no LOG opcode). Each event and error
   is declared once, at file level; the published vault ABI merges the libraries' (a build check).
3. *`msg.value` and `msg.sender`.* No library reads `msg.value` (L3 takes it as `PayoutIn.value` and refunds at
   most it); `msg.sender` appears only as L3's refund target, a value-only, empty-calldata call that is `finish`'s
   last statement (the source and call rules). Under DELEGATECALL `msg.sender` is the vault's caller; under
   `execute` it is the vault. L4 reads neither: the vault passes the roles.
4. *Linking.* The vault links exactly L1 to L4 and L3 the payout math (the link-graph check, creation and runtime
   code); the vault's only DELEGATECALLs are to them (the delegatecall rule: no other in src/, on the text, on the
   vault's AST with its vendored code, and in every artifact's runtime and creation code); the deployed code at each linked address
   is that library's, with its `library_deploy_address` filled in (`LibraryBoundary.t.sol`'s link tests at run
   time, `verify` at deploy). No library is called with a user-supplied target, and none is upgradeable.
5. *Direct calls and balances.* Every external function of each library in the build is called directly by a test
   (the coverage check, over each artifact's `methodIdentifiers`); a library's balance can only grow through a view
   or pure call with value, and is informational.
6. *Transient state.* No library has TSTORE (the bytecode backstop); the vault sets its unstake flag only around
   L2's walk and the owner's L4 removal, never across a bridge call or the refund.

## Pre-mainnet checklist

This list predates the launches: v3-launch went live on 2026-10-30 and v3.2-launch, the live
deployment, on 2026-11-16, each holding only the founder's own money. Item 23, an independent audit,
is still open and comes before other people's money.

Confirm on a fork of chain 964 or, for what a fork cannot run (the real precompile), with the mainnet canary's
tiny amounts after the deploy (the testnet rehearsal was dropped on 2026-11-11):

1. `claimRootWithHotkey` behaves as the mock models: it credits root (netuid 0) stake on the same
   hotkey for the vault's coldkey (the vault measures its whole position, so a credit elsewhere in
   the set or as balance still vests); the root claim type is Swap, not Keep; what it does when
   there is nothing to claim; no chain-side auto-claim bypasses vesting; and `getStake` reads one
   rao short only on a fresh position. **Open, the canary watches it (the auto-claim index, plan Task 64
   step 3):** if root dividends land as stake on the vault's hotkey without its claim, they show as a surplus
   (`surplusStakeRao()` rising, the primary's stake rising, with no `claimRewards`), adopted later with no cut:
   holders lose nothing, but the reward cut is bypassed. The canary records both before its gift step (runbook
   3.5, the auto-claim watch); a rise with no claim stops the founder before other people's money, since the
   fix is a contract change.
2. Units and rounding: the precompile's stake amounts are rao; root `removeStake` and
   `removeStakeFull` credit exactly `want × 1e9` wei, and a partial root removal lowers `getStake` by
   exactly `want` (otherwise the walking exit pays the difference, Task 36b: the vault charges the
   position's measured fall × 1e9 less what it received, which an `Unstaked` log alone does not show
   when the fall is more than `want`; the monitor alerts on `PayoutChunkSent.unstakeCost` and
   `ShortfallAbsorbed`, an `Unstaked` short of `wantRao × 1e9` a secondary signal);
   `getUnclaimedRootTaoByHotkey` is 18-decimal; Bittensor EVM floors value transfers to rao (the
   payout-fee rounding assumes it); `removeStakeFull` on an empty position reverts rather than
   silently paying 0.
3. Floors: the minimum-stake boundary is inclusive on both remove and add (for a partial unstake
   of exactly the floor, the live simulation in item 11 showed it), and a full exit of a position
   below the minimum stake succeeds (`removeHotkey` relies on it).
4. Identity: `addressMapping(vault)` equals the coldkey the staking precompile credits (stake dust
   and read it back).
5. Root unstake "too early" windows for a contract coldkey (the root hold, `RootStakeUnlockInterval`), and
   pauses during basket migrations: the walk skips a refused pair (`UnstakeSkipped`, Task 20), so a payout
   or direct redeem that hits one is served by the next pair, or the idle buffer, and reverts `UnstakeShort`
   to be retried only when none can pay it. Confirm that a held pair's `removeStake` is refused under a
   capped gas (spec §3.8's test, the mainnet canary's since the testnet was dropped) and record an exit's gas
   against `EXIT_GAS_RESERVE` and `unstakeGas` (on a fork, Task 61: a payout's work after the walk with the real
   send about 640,000 at the keeper's gas with the paying removal burning its share; Task 65 set the reserve to
   2,000,000 on it, 2.6 to 3.3 times that with the live precompile's costs; those costs are the canary's).
   The canary's exits that walk (runbook 3.5: its payout and its direct exit) also run `TSTORE`/`TLOAD` in
   a real transaction for the first time in any Cascade build (`_unstaking` around the walk); section 2
   checked them only by an `eth_call` override.
6. Precompile failure modes on the live runtime: a failed write reverts with no data and burns the
   forwarded gas (the walk forwards each removal only its share, so a burned one is skipped and the
   exit keeps `EXIT_GAS_RESERVE` while each share exceeds `unstakeGas`), and a capped `try/catch`
   view read (the live floors from `getDefaultMinStake` and
   `getNominatorMinRequiredStake`, 100,000 gas each, and always given their whole cap since
   Revision 28's gas audit, else `InsufficientGas`) falls back to the constant fallbacks
   (`FALLBACK_MIN_STAKE_RAO`, `FALLBACK_MIN_REMAIN_RAO`) as modelled, and that `removeHotkey`'s
   `getUnclaimedRootTaoByHotkey` read fails the same way (a `try` with no gas cap since R2 F1: a
   failed read leaves only the owner's forfeit, every other removal path refusing).
   A read that succeeds with malformed return data is NOT caught by the `try/catch`: the decode
   reverts in the vault and fails every call that reads the floors. Nor is an out-of-range
   (implausibly large) but successful read: every position would read as below the minimum stake,
   so the unstake walk skips them all and exits freeze until the owner moves stake and removes
   hotkeys (each removal exits its position fully). The scheduler's `_executingHash` (`TSTORE`/`TLOAD`)
   likewise runs in a real transaction first at the canary's scheduled item; the walk's `_unstaking` at its
   exits (item 5).
7. `setRejectStakingHotkeyGrowth` semantics, and that it has no clearing setter; a root-to-root
   `moveStake` is fee-free.
8. A validator's hotkey swap moves a contract coldkey's root stake (the keeper's swap monitoring and
   `addHotkey` exist for this).
9. Gas: the per-transaction limit, about 65M (75% of the block less 10% for initialization, under the 75M
   block gas limit; 64,998,400 read live on 2026-11-15), exceeds the 57M a reward claim is sent with, and
   delivery gas with 4 hotkeys in the set (every price read walks the set).
10. The post-Root-Reborn reward cadence, to set how often the keeper claims.

Rails and ForeverMoney:

11. ForeverMoney's conversion: answered on 2026-10-23 (`withdrawLiquid` and `depositLiquid` on
    their `AlphaVault`, permissionless and exactly 1:1; `docs/forevermoney-probe.md`). Just before
    deploying (`pnpm ops preflight` in `ops/` does this), run `bash script/simulate_inbound.sh` against the live node with the deployment's
    constructor arguments (`REMOTE_ADAPTER`, `GAS_BASE`, `GAS_PER_ENTRY`) and record its output in
    the runbook: it is the only run of their real unstake through the real staking precompile. On
    2026-10-24 it delivered 1 TAO, and exactly 0.002 TAO (so a partial unstake at the floor
    succeeds; the v3.1 adapter). Since Task 25 a delivery that parks fails it
    (`SIMULATION FAILED: the delivery PARKED ...`): only `SIMULATION OK` passes.
12. The adapters deliver tokens and data together (fork-tested through the real `OffRamp 2.0.0` on
    both lanes; the front door's `TokensNotReceived` check assumes tokens arrive with or before
    their data). Still open: a batch with no deposits (`amount` 0) sent through a real Router (the
    fork tests deliver one through Bittensor's OffRamp but send none).
13. CCIP manual re-execution never expires on these lanes (none in the 2.0.0 source; the fork tests
    re-execute a failed message through the real OffRamp).
14. The CCIP fee does not depend on the token amount on these lanes (the vault quotes on gross
    amounts and sends the net).
15. Executions land on `OffRamp 2.0.0` on both lanes (read 2026-10-24). Before deploying, confirm
    the `OffRamp 2.0.0` addresses still match `test/fork/ForkBase.sol` (`BASE_OFFRAMP`,
    `BIT_OFFRAMP`); the fork tests' `offRamp20` check fails if they changed.
16. ForeverMoney's TAO on Base has no transfer fee and does not rebase (the front door checks only
    its 18 decimals).

Measurements and policy:

17. Fork-measure delivery gas at 50 + 50 of new depositors (the hard bound since Task 18). Done at
    Task 61 through the real OffRamp and AlphaVault: 3,857,298, about 4.2M with the precompile
    allowance, of the launch pair's 7.0M; the live precompile's cost is the canary's to confirm.
18. Run the build checks (`node script/build-checks.mjs`: the size gate, the published ABI, the
    lens layout, the lens surface, the library rules, the warning gate and the library links) after any post-audit change: the vault has
    421 B of headroom under the gate's 23,076 B after Revision 28 (22,655 B, 1,921 B under EIP-170;
    2026-11-13; 680 B at size gate D, after Revision 27's adoption drip), with the batch path, the walk, the payout engine and
    hotkey management in L1 to L4 (it had 7,616 B on 2026-11-01, at 15,460 B).
19. **Done since Task 23** (v3-launch's item): `setClaimGasRequired` is hard-bounded (54,100,000 to
    63,400,000 since R5 and Task 65), so no setting disables the guard or asks more than one transaction can
    carry; within the bounds it is immediate both ways, owner discipline.
20. Maintenance: the vault's front-door registry (`proposeFrontDoor`, `activateFrontDoor`,
    `cancelFrontDoorProposal`, `removeFrontDoor`) duplicates the bridge registry in `CascadeBase`
    (propose, activate after `REGISTRY_DELAY`, cancel, disable), and the vault's constructor
    activates the initial front door the way `CascadeBase`'s activates the initial bridge. A fix to
    one must be mirrored in the other; consider one shared, keyed registry in a later version. v3.2
    does this: both activations, and the guardian's replacement, are items of the one owner scheduler
    in `CascadeBase`, and the registries are gone.
21. Per-peer share-origin tracking, before a second front door on another chain is activated (see
    the soft spots under [Exit safety](#exit-safety)). Built in v3.2 as origin by chain (Task 18).

Outside this build:

22. The deployment scripts and runbook, and the keeper bot (including the tooling that re-executes
    failed deliveries). The adapters are built.
23. An independent audit of the contracts and the adapters.
24. Legal: jurisdictions, fees, US users.

Added by the final whole-branch review (2026-10-24):

25. ForeverMoney migration: a completed migration strands every inbound batch delivered after it
    (since v3.2's Task 25 it parks as tokens ForeverMoney will not honour),
    and `MIGRATION_DELAY` (7 days) equals `REGISTRY_DELAY` (7 days). Have the runbook say that the
    owner proposes the replacement adapter pair (both adapters, because `remoteAdapter` is
    circular) the day a migration is announced, and that the keeper stops closing batches while
    `AlphaVault.migrationReadyAt() != 0`, `AlphaVault.migrationFinished()` or `AlphaVault.isPaused()`.
26. Decide, before any deployment larger than the first test run, whether the next adapter version
    tops up a bounded shortfall (for example at most 1 rao per delivery) from its reserve; the
    current adapter requires exact 1:1. v3.2 does for deliveries (Task 25: at most 1 rao per
    conversion, from the reserve, never from parked TAO) and for payouts and converted refunds
    (Task 28: at most 1 rao per conversion, from the token cushion, never from parked tokens).
27. Before deploying, rehearse on these lanes, against the real committee verifier (Task 61's fork
    rehearsal), a `FAILURE` message's re-execution by `pnpm ops reexec` (the committee's results
    reused from the failed attempt's calldata: the deployed `OffRamp 2.0.0` checks them on every
    execution, so R3's CC-L3 reading, that a `FAILURE` needs none, was wrong), and how to obtain the
    default committee's `verifierResults` should an `UNTOUCHED` message ever need its first execution
    by hand. Automatic re-execution stays off until the founder turns it on after these rehearsals.
    The contracts' half is done (Task 61, `BaseForkV32`, the real committee verifier, no verifier
    stubbed): a real Bittensor-to-Base message (a third party's plain token transfer, not one of
    Cascade's) forked the block before its execution, its first attempt made to fail by the test (FM-TAO's
    `mint` mocked to revert, the BurnMint pool's release), is refused with an empty proof and delivered with
    the failed attempt's own calldata; and a stranger's empty-proof attempt on the `UNTOUCHED` message returns
    and writes `FAILURE` (asserted since Task 65), so a FAILURE-writing transaction may hold no usable proof,
    and the honest results (Chainlink's executor's) still deliver it. Bittensor's `OffRamp 2.0.0` does the
    same (Task 65, `BittensorForkV32Failure`, the real committee verifier, no verifier stubbed): a real
    Base-to-Bittensor message (again a third party's plain token transfer) forked the block before its
    execution (9,499,544), a stranger's empty-proof attempt returns and writes `FAILURE`, nothing is
    released, and the real transaction's calldata delivers it from that `FAILURE` (`SUCCESS`). A first
    attempt that fails in the receiver, re-executed with its own results, is fork-tested on Base only: since
    v3.2 parks where v3.1 wrote FAILURE, Bittensor lost that test (a held lock, `AlreadyParked` or a malformed
    batch can still write FAILURE there; the same OffRamp 2.0.0). `pnpm ops reexec` against a fork is the
    founder's step.
28. After deploying (`pnpm ops deploy` and `pnpm ops verify` in `ops/` do all of this; see
    `docs/runbook-test-run.md`), read back on chain `adapterBase.remoteAdapter()`, `adapterBit.remoteAdapter()`,
    both adapters' `router()`, `token()` and `remoteSelector()`, and `adapterBit.alphaVault()`, and
    compare them with the plan: `remoteAdapter` is circular across two chains, and a wrong
    prediction (a stray transaction, a nonce mismatch) makes every delivery `WrongSender` and
    leaves the first batch's tokens in FAILURE forever. v3.2's plan deploys Bittensor first (the
    adapter, the four libraries, the vault, its lens), then Base (runbook section 3, plan Task 67): every
    cross-chain address is a nonce prediction from a fresh deployer key, and `pnpm ops verify` reads each back
    (v3-launch deployed Base first, so its vault named an initial door that already had code). Then read back
    on Base the
    front door's `vault()`, `vaultChain()` and `primaryBridge()` (from v3.2, through the door lens)
    and its code hash, and on Bittensor
    `vault.frontDoorActive(vault.peerId(chain, frontDoor))` (from v3.2 `doorState(peerId(chain, frontDoor))` reading
    `Active` and `activeDoors(chain)` reading 1, through the vault lens) with
    `chain` equal to
    `adapterBit.remoteChainId()` (the chain id the adapter reports, not the CCIP selector), and
    that the vault's deploy transaction emitted exactly one `FrontDoorActivated`. Fund the Bittensor
    adapter's native reserve to `RESERVE_TARGET` (1e15 wei) plus the chain's 500-rao existential deposit, and its
    booked token cushion to `TOKEN_RESERVE_TARGET` (approve, then `fundCushion`), before the first delivery
    (runbook 3.2; v3-launch's `fundReserve()` was 1e12 wei). Send one single-entry batch at the minimum deposit
    (0.04 TAO, the canary's first step; v3-launch's was 0.01 TAO) and watch it deliver before opening
    deposits.
29. **Implemented in v3.** Add a reward cut before taking other people's money (owner decision, 2026-10-25): the contracts
    charge nothing today, so the keeper's batch, stake and payout fees are pure cost (about $1.60
    per deposit batch at test-run prices). Planned shape: at each reward claim the vault mints
    treasury shares worth a set share of the claimed rewards (about 10%, as Lido does), with a
    hard-coded ceiling and the rate behind the timelock. The vault has 799 bytes of headroom, so it
    must fit there or go in a new vault version; it gets its own spec, tests and review.
    The cut alone does not cover spam: costs are per batch, and 50 minimum deposits from 50
    addresses fill the deposit list (`maxDeposits`), which makes the batch closable at once and
    reverts every other deposit (`BatchFull`) until someone pays the ~$1.45 bridge fee to close it.
    Give deposits a small fee into the batch's fee pot, as redeem requests already have, sized so a
    full batch pays its own close; raise `minDeposit` for launch; and give the keeper a close policy
    (close a full batch at once, otherwise on the timer). The slots are also free to hold (R6,
    Fable's whole-system review L-2): a deposit is cancellable at any time (since R11 once five
    minutes old), so one holder's full cancel just before a close leaves the batch not ready
    (`BatchNotReady`), and its deposit again refills the list; with R11's cooldown the holder kept 49
    aged entries and cycled one a round. Closed by the list's half rule (R12, spec Revision 36): the
    batch is closable once the list holds half its limit (25 of 50), so a list filled after a keeper's
    round holds at least 26 entries too young to cancel and the next round commits them
    (`EndToEnd.test_theDepositListHoldEndsAtTheKeepersNextRound`). Still open:
    the deposit fee into the pot is on the spec's before-other-people's-money list (section 5), for the
    honest closer's fee on a deposits-only batch. The
    value-limit variant is closed (R6b U4, the multi-agent review; the founder reversed decision 6):
    one address held the batch just under `maxBatchValue` (maxBatchValue less minDeposit plus a rao,
    9.960000001 TAO at launch) or just under `depositCap`, refusing every honest deposit, and cancelled
    before each close; the room rule is back in `canClose`, so a batch with no room for a minimum
    deposit is closable at once and a close that lands before the holder's cancel (the keeper's, or
    the refused depositor's own) commits the holder's deposit
    (`FrontDoorClose.test_aDepositHeldJustUnderTheValueLimitIsClosedAtOnce`). Its exact-room form
    (room for exactly one minimum, 9.96 TAO, every larger deposit refused) is closed by the half rule
    (R7, the founder's choice): a batch holding at least half the value limit, or half the room under
    the cap, is closable at once (`FrontDoorClose.test_anExactRoomHoldIsClosableAtOnce`). Stated: a
    holder can still refuse deposits above about half a batch, sitting just under half and cancelling
    as much as each honest deposit adds, which the honest deposits survive
    (`test_aHoldJustUnderHalfTakesHonestDepositsAndTheFirstMakesItClosable`). Also stated (R8, the R7
    review's L-1): the keeper closes once a minute, so a holder that deposited a full batch just after
    one round and cancelled before the next refused every deposit for most of each minute. Closed by
    the cancel cooldown (R11): a deposit's cancel waits five minutes, so the keeper's next round
    commits it (`FrontDoorClose.test_aFullBatchCannotBeFlappedBetweenTheKeepersRounds`); with more
    addresses the cancels within any five minutes add up to less than half a batch
    (`test_aLiftOverHalfCancelsOnlyAnOldDeposit`), while each keeper close lands (the keeper names a
    lenient `minValue`). The list hold above is closed by R12's list half rule; the cooldown does not
    close the honest closer's fee for a deposits-only batch; the web
    offers the refused depositor "close this batch, then deposit" (`closeBatch` is permissionless),
    the monitor warns on heavy cancelling, and this item's deposit fee, if a cancel does not return
    it, is the contract cure, still deferred. `FrontDoorClose.testFuzz_canCloseMatchesTheRule` checks
    `canClose` against the rule recomputed from the spec (R8, the review's L-2).
30. **Implemented in v3.** USDC lands in the wallet (owner decision, 2026-10-25): no claim step for users. Planned shape:
    with the redeem request the user signs (EIP-712) a minimum USDC out and a deadline; when the
    payout reaches Base, the keeper calls the next front door's claim-and-swap for that user, which
    swaps through the fixed Uniswap route and reverts below the signed minimum, then sends USDC to
    the user. Below the minimum or past the deadline it waits or delivers the TAO; the user can
    always claim by hand. No keeper-chosen slippage, so a keeper or a sandwich bot cannot take more
    than the user agreed to. Own spec, tests and review; launch can ship one-click claim-and-swap
    first if this is not ready.

Added for v3 (2026-10-26):

31. Measure a real claim with the mainnet canary (gas used and TAO cost; the testnet rehearsal was dropped)
    and compare candidate
    validators' basket sizes; set `OPS_CLAIM_COST_TAO` from the measurement. The 53M gas figure (the vault requires 55M, ops sends 57M) and
    the tao.bot cost estimate (about 0.045 TAO) come from research, not from a run.
32. **Done; enforced from v3.2.** Both pools' observation slots cover the oracle's 30 minutes
    (Uniswap TAO/WETH 0.3% and WETH/USDC 0.05%). The TAO/WETH pool
    (`0x82dD34C6631C286cDD1dB16f2c232f60E402Dd5A`) had 600 in use on 2026-10-31, with 2,000
    requested, and 2,000 on 2026-11-05; WETH/USDC 6,700. A pool writes at most one observation a
    second (one per block timestamp, whole seconds, whatever the block time: Base's blocks are 0.2
    seconds since 2026-11-05), so v3.2's oracle constructor refuses a pool with fewer than 1,801 in use
    (`MIN_CARDINALITY`, `TWAP_WINDOW + 1`, `TooFewObservations`; 901 before Revision 28): the deploy
    cannot go ahead on a pool with too few. `pnpm ops cardinality` reads both pools and prints the
    transactions that grow one (anyone may send them).
33. **Partly done.** The launch cadence now exists in ops: `OPS_CADENCE=launch` when making a new v3
    plan gives a 1-hour minimum batch interval, a 24-hour payout delay and a keeper that closes a
    batch when it is full, 24 hours old, or its estimated Cascade fees cover its bridge fee (the
    test cadence is 10 minutes and 1 hour; the cadence is stored in the record, so `verify` checks
    each record against its own values). Still to decide before real users: the treasury (the test
    deployment uses the test wallet), a timelock as owner (so interval changes are announced first),
    and the caps. v3-launch has its own treasury and a 40 TAO cap; its owner is a single
    hardware-wallet account with no timelock, and the Safe plus timelock is still to come.
34. **Done in v3.** The v3 Bittensor adapter's payout gas is raised: `SETTINGS_V3.bitGas.base`
    goes from 120,000 to 170,000 (29,900 per entry, unchanged), and v2 keeps 120,000. The Base
    payout receiver needs about 134.6k for one entry: the node's estimate, which counts gas before
    refunds. That was 90% of the old 149,900 limit and is about 67% of 199,900. The ops rehearsal
    now relays each message with exactly the gas limit the message asks for, and fails when a
    receiver needs more. A failed delivery would need manual CCIP re-execution.

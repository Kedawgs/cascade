// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

// Every custom error of CascadeBase, CascadeVault (its share token included) and the vault's
// libraries, each declared once at file level (spec §8.1) and imported by name where it is used. An
// error that only a library reverts with is in that library's ABI, not the vault's;
// abi/CascadeVault.json (script/merge-abi.mjs) merges them. The front door's, the adapters' and the
// staker's own errors stay in those contracts, but for the front door's cancel cooldown (R11), declared here.

// ---- CascadeBase ----

error ZeroAddress();
error NotGuardian();
error NotBridge();
/// Nothing is scheduled under the id: execute, cancel or prune of an item that is not there.
error NoProposal();
/// Too early: execute before an item's readyAt or its readyBlock; prune before it lapses (both readyAt +
/// EXECUTE_WINDOW and readyBlock plus half EXECUTE_WINDOW in blocks passed, Revision 28).
error NotReady();
error BridgeNotEnabled();
error PrimaryBridgeDisabled();
error RenounceDisabled();
// the scheduler (spec §3.6)
/// A scheduled-only call outside execute's self-call, or a direct loosening.
error NotScheduled();
/// schedule of a selector the contract does not classify.
error UnknownSelector();
/// schedule of calldata that is not exactly its selector's canonical length.
error BadCalldata();
/// execute after the item lapsed (its windows in time and in blocks both passed, Revision 28); acceptOwnership
/// after the pending owner's window.
error LapsedItem();
/// cancel by anyone but the owner, or by the guardian of an item that is not Ordinary.
error NotCanceller();
/// The activation of a target already active, at schedule and at execute.
error AlreadyActive();
// the exits machine's gates and clocks (spec §3.6)
/// schedule or execute of an item whose gate fails (Ordinary: exits not open; GuardianSwap: an owner
/// hold) or whose clock is not older than block.timestamp (schedule) or its scheduledAt (execute). The
/// spec names no error for these; one keeps the bytes down.
error ExitsNotOpen();
/// setPrimaryBridge while the current primary is enabled: the switch is allowed only while it is disabled.
error PrimaryStillEnabled();
/// A per-message limit above what the primary bridge carries in one message, its maxMessageValue() (spec §3.9;
/// CascadeBase._requireBridgeCap): the vault's maxMessageValue at construction, in setMessageLimits and in
/// setPrimaryBridge (Task 23), and the front door's maxBatchValue likewise (Task 30).
error AboveBridgeCap();
// the owner-signed stamp (spec §3.6)
/// stampBySig with a signature that is not the owner's: not 65 bytes, v not 27 or 28, s in the upper half
/// of the curve order, unrecoverable, or recovering another account.
error BadStamp();
/// stampBySig with an asOf later than now, or more than STAMP_MAX_TTL before it.
error StampOutOfWindow();

// ---- CascadeShares (the vault's share token) ----

error NonTransferable();
/// A burn above the holder's balance: OpenZeppelin's IERC20Errors signature, kept from v3.1's ERC20.
error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed);

// ---- CascadeVault ----

error ColdkeyMismatch(bytes32 expected, bytes32 derived);
error ZeroHotkey();
error PeerNotActive();
error NotRaoAligned();
error BelowMinDeposit();
error CapExceeded();
error InvalidParameter();
error DirectTransferNotAllowed();
error HotkeyKnown();
error TooManyHotkeys();
error UnknownHotkey();
error HotkeyInUse();
error HotkeyHasRewards();
/// addHotkey by anyone but the owner, the guardian or the keeper, unless stake is missing and the hotkey, never
/// listed, holds at least the chain's minimum of the vault's root stake (spec §3.1, I-6).
error NotEligible();
/// An add that would fill the last hotkey slot without stake missing and the chain's minimum on the hotkey.
error SlotReserved();
/// setStakeHotkey of a hotkey the vault does not list, directly or at execute (spec §3.10.3).
error NotListed();
error NotKeeper();
error NotAuthorized();
error NothingToStake();
error ZeroAmount();
error TransferFailed();
error UnstakeShort();
/// Too little gas for a step that must not run short: claimRewards below claimGasRequired, the adapter's deliverParked
/// below its lane's model, and a capped read of the staking precompile left less than its cap's 64/63
/// (CascadeFormulas.requireGasFor: the floors' reads and the write-off's, Revision 28's gas audit).
error InsufficientGas();
error VaultInsolvent();
/// A mint, or a burn the holder did not consent to, while stake is missing (spec §3.1, I-1).
error StakeMissing();
/// adoptStake of a surplus below the chain's minimum stake, minStakeRao(): nothing to adopt, as while stake is
/// missing, when the surplus is 0 (spec §3.1).
error BelowMinAdoption();
/// adoptStake within STAKE_RAMP (a day) of the last adoption, or of the deploy (spec §3.1).
error AdoptTooSoon();
/// writeOffMissingStake of more than is missing less what sits unlisted on the vault's coldkey (spec §3.1, M-1).
error WriteOffTooLarge();
error UnknownPeer();
/// setRedeemOrigin of a chain with no active front door, or of chain 0 (spec §3.4, Task 18).
error UnknownOrigin();
error ValueMismatch();
error AmountMismatch();
error DuplicateBatch();
error NotPending();
/// cancelPayoutBatch of a batch whose unsent entries are all bounced deposits (0 shares): nothing to re-mint, so
/// nothing is cancelled and the bounces stay queued for processPayouts (spec §3.10.5). Final: a retry reverts again.
error NothingToCancel();
error PayoutDelayed();
error FrontDoorInactive();
/// The vault's, its payout engine's and the payout math's (ruling B11: one error). setRewardCut: a cut above
/// MAX_REWARD_CUT_BPS. processPayouts (the fee valve, spec §3.3), for one of two causes: (1) the bridge fee is above
/// the ceiling the entries are charged and the call's value is short of the excess (the top-up: retry with it); or
/// (2) CascadePayoutMath.deductFee: an entry with shares would net 0 after its share of the fee (I-14: a burned exit
/// is never finalised at zero). The second is unreachable under the bounds: every burned exit is at least
/// MIN_REDEEM_VALUE (0.03 TAO), twice MAX_FEE_ABS (0.015 TAO), so its share leaves it at least half.
error FeeTooHigh();
/// processPayouts with a value that is not whole rao (spec §3.3, Task 21): the chain floors value transfers to rao.
error BadValue();

// ---- CascadePayoutMath ----

error PayoutsMismatch();

// ---- CascadeFrontDoor ----

/// cancelDeposit before `cancelableAt`, the caller's last deposit's time plus CANCEL_COOLDOWN (5 minutes; R11, spec
/// §3.5): the first second its cancel works, as the front door's `cancelableAt(user)` returns it. (Not `at`, which a
/// later Solidity reserves: src compiles with no warning.)
error CancelTooSoon(uint256 cancelableAt);

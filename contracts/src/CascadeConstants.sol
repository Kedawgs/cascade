// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

// The constants the vault, its libraries, its shared formulas and its lens share (and the front door, MAX_FEE_ABS),
// each declared once at file level (ruling DA5), so no copy can disagree with another. The lenses serve them from here;
// CascadeBase's delays and execute window (Tasks 5d-1 and 7a) and the vault's own (Task 5d-2) are
// internal constants on their contracts, under the same names.

// Wei per rao: TAO is in wei on the EVM and in rao (1e9 wei) at the staking precompile.
uint256 constant RAO = 1e9;

// The root network's id at the staking precompile: the vault stakes only there.
uint256 constant NETUID_ROOT = 0;

// Wei the vault never spends and never counts, so the chain's existential deposit cannot fail a payout.
uint256 constant ED_RESERVE = 1e12;

// After this long without the keeper, anyone may stake the idle balance, or claim a hotkey's rewards.
uint64 constant KEEPER_FALLBACK = 7 days;

// The largest reward cut, in basis points of each claim.
uint16 constant MAX_REWARD_CUT_BPS = 2_000;

// The most hotkeys the vault lists (spec §3.1); the last slot is reserved for a swap's new hotkey. Applied by
// the hotkey library (CascadeHotkeyLib).
uint256 constant MAX_HOTKEYS = 4;

// How far, in wei, the gross assets may fall short of the queued payouts, with no reward vesting, before every
// mint is refused (CascadeFormulas.underwater, spec §3.1): 1,000 rao, a rounding of the chain's at a supply of 0
// (a fresh position's read one rao short; no exit leaves one, since every exit pays its own cost, spec §3.3), so
// such a rounding cannot refuse deposits at a supply of 0 for good. While any reward vests, any shortfall refuses.
uint256 constant UNDERWATER_TOLERANCE = 1_000 * RAO;

// The stake guard's tolerance (spec §3.1, CascadeFormulas.stakeMissing): stake is missing once the booked stake
// exceeds the visible by more than the larger of MISSING_TOLERANCE_BPS of the booked (0.1%) and
// MIN_MISSING_TOLERANCE_RAO (0.001 TAO), so a swap's or a chain fee's rounding cannot close minting. Both in rao,
// as the ledger is.
uint256 constant MISSING_TOLERANCE_BPS = 10;
uint256 constant MIN_MISSING_TOLERANCE_RAO = 1_000_000;

// A day (spec §3.10.12, §3.5): stake added by stakeIdle enters the outflow allowance's base linearly over it, an adoption
// waits it after the last, and a holder's fresh shares (its Holder record, CascadeTypes.sol; R4 B-H1, the door hold) stay
// unburnable by a front door until it has passed since their run's clock. Applied by the vault and the batch library
// (CascadeBatchLib), through CascadeShares.sol's freshOf.
uint256 constant STAKE_RAMP = 1 days;

// The owner scheduler's class delays (CascadeBase, spec §3.6): a limit's loosening and the other Param
// items wait PARAM_DELAY; an activation (a bridge, a front door) waits REGISTRY_DELAY; a guardian swap
// and an ownership transfer wait GUARDIAN_DELAY, longer than REGISTRY_DELAY, so the sitting guardian can
// still veto an activation scheduled alongside its replacement.
uint64 constant PARAM_DELAY = 48 hours;
uint64 constant REGISTRY_DELAY = 7 days;
uint64 constant GUARDIAN_DELAY = 8 days;

// A scheduled item executes from its readyAt until this long after it; then, once half this long in its
// chain's calibrated blocks has also passed after its readyBlock (Revision 28: a slowdown never strands an
// item), it lapses and anyone may prune it.
uint64 constant EXECUTE_WINDOW = 7 days;

// The owner-signed stamp (CascadeBase.stampBySig, spec §3.6): its EIP-712 type, and how long after its
// as-of time a stamp may still be relayed.
bytes32 constant STAMP_TYPEHASH = keccak256("OwnerStamp(uint64 asOf)");
uint64 constant STAMP_MAX_TTL = 1 days;

// The key of the burn window all front doors share (spec §3.4, Task 17), beside each door's own under its peer
// id: no peer id (a keccak256) is 0. Applied by the batch library (CascadeBatchLib).
bytes32 constant GLOBAL_WINDOW = bytes32(0);

// The redeem origin (spec §3.4, Task 18) of an address that deposited directly, or chose Bittensor: no front door
// burns for it, and a door's deposit for it still mints (the address already belongs here, so the shares go to no
// one else). Every other origin is 0 (none yet) or a chain id; no chain is type(uint64).max. Applied by the batch
// library (CascadeBatchLib) and the vault.
uint64 constant DIRECT_ORIGIN = type(uint64).max;

// The gas the unstake walk leaves, below what it forwards to its removals, for its exit's work after the walk (spec
// §3.8, Task 20): each removal gets max(unstakeGas, (gasleft - EXIT_GAS_RESERVE) / positionsLeft). While each share,
// (gasleft - EXIT_GAS_RESERVE) / positionsLeft, is at least unstakeGas, removals that burn their gas leave the reserve
// for the ledger, a payout's send or a direct exit's payment. Below that, each gets unstakeGas, and burning ones can
// eat into the reserve: the exit then runs out of gas and reverts whole (nothing lost), so callers send at least
// EXIT_GAS_RESERVE + positions × unstakeGas + the exit's own work (README, operator notes). Applied by the walk
// (CascadeStakeLib). 2,000,000, erring high (Task 65; 1,200,000 before): Task 61's fork measured a payout's work after
// the walk at about 640,000 with the real send, and the live precompile adds about 60,000 to 110,000, so the reserve
// holds about three times it; the mainnet canary records an exit's gas.
uint256 constant EXIT_GAS_RESERVE = 2_000_000;

// The smallest front-door redeem burned (spec §3.3): MAX_FEE_ABS (below), the top of the payout fee ceiling's
// absolute part, is half of it (0.015 TAO), so under any ceiling an entry with shares keeps at least half its value
// (I-14), above the Bittensor adapter's conversion floor (0.002 TAO today). A constant: it does not follow a raised
// floor. Applied by the batch library (CascadeBatchLib).
uint256 constant MIN_REDEEM_VALUE = 0.03e18;

// The top of the payout fee ceiling's absolute part (spec §3.3): half the smallest burned redeem, 0.015 TAO, so an
// entry with shares keeps at least half its value (I-14). The front door's minimum deposit is at least twice it
// (MIN_DEPOSIT_FLOOR, Task 30), so a bounced deposit is never dust either. Applied by the vault (setFeeLimits) and
// the front door (setCaps).
uint256 constant MAX_FEE_ABS = MIN_REDEEM_VALUE / 2;

// The staking floors' fallbacks, in rao (spec §3.9, Appendix B, Task 23: constants, where v3.1 had owner-set
// parameters): the chain's minimum stake operation and minimum nominator position the vault uses are the larger of
// the precompile's live read and these, or these alone when the read fails (CascadeFormulas.minStakeRao and
// minRemainRao). Applied by the vault, the walk (CascadeStakeLib) and the hotkey library (CascadeHotkeyLib).
uint256 constant FALLBACK_MIN_STAKE_RAO = 2_000_000;
uint256 constant FALLBACK_MIN_REMAIN_RAO = 20_000_000;

// The bounds of claimGasRequired, the gas a claim requires left before it calls the precompile (spec §3.9, Task 23,
// Task 65). The call forwards 63/64 of the gas left, less its own cost, so the floor is the 53.2M a
// claimRootWithHotkey needs, as section 2 measured it, divided by 63/64 (about 54.03M) and rounded up: 54.1M left
// forwards about 53.25M, and no setting lets a claim start with less than the chain needs (no fork can run the claim:
// the mainnet canary measures a real one; 53.2M until R5 M-4, which forwarded only about 52.37M). The top is the most
// whose claim still fits Bittensor's per-transaction limit, about 65,000,000 (75% of the block less 10% for
// initialization; 64,998,400 read live), with the claim's own overhead (218,947 measured at its dearest, 500,000
// allowed) and a 1,000,000 margin (60M before Task 65), so the owner can raise claimGasRequired at once should a real
// claim need more. The bounds set only the least a claim requires left; what is forwarded is the caller's gas limit's
// (63/64 of what is left): a transaction at Bittensor's per-transaction ceiling reaches the check with about 64.78M left
// and forwards about 63.7M at any setting, so a claim that needs up to about 63.6M forwarded can still be met, and one
// that needs more can be met by no setting and no gas limit (R6, ChatGPT R2's gas note). Applied by the vault; the lens
// serves both.
uint256 constant MIN_CLAIM_GAS = 54_100_000;
uint256 constant MAX_CLAIM_GAS = 63_400_000;

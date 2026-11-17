// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AmountMismatch, InsufficientGas, InvalidParameter} from "../CascadeErrors.sol";
import {ICascadeReceiver} from "../interfaces/ICascadeBridge.sol";
import {IAlphaVault} from "../interfaces/IAlphaVault.sol";
import {IStaking, ISTAKING_ADDRESS} from "../interfaces/IStaking.sol";
import {CascadeMessages} from "../libraries/CascadeMessages.sol";
import {CcipAdapterBase} from "./CcipAdapterBase.sol";

/// @notice The Bittensor EVM side of the CCIP bridge: native TAO is converted to and from the bridged
/// token through the ForeverMoney alpha vault. Sending turns the caller's native TAO into the token and
/// hands it to the router; delivery turns the token back into native TAO and pays it to the recipient.
/// A delivered batch the adapter cannot convert, or that its recipient refuses, is parked (spec §3.2):
/// kept under a record keyed by the batch, as the tokens (`converted` false) or as the native TAO
/// (`converted` true), and the CCIP message succeeds, instead of reverting into CCIP `FAILURE`, whose
/// re-execution fails again while its cause lasts (a permanent cause, such as a ForeverMoney migration, would strand
/// it) and, like every execution, needs the committee's `verifierResults`, which the deployed OffRamp 2.0.0 checks each
/// time (Task 52's review: R3 CC-L3's reading, that it needs none, was wrong); at launch a FAILURE is reported and
/// re-executed by hand (README, operator note 18). `parkedNative` and `parkedTokens` are what the adapter owes
/// its parks (I-7: it always holds at least that much of each). Only a malformed batch, a batch already
/// parked, a token balance that does not cover the token parks, the booked cushion and the batch's amount (R4 C-L1,
/// F-1: so a forged amount with no tokens behind it converts nothing), a recipient with no code (Solidity's code check runs
/// before the `try`), a recipient or a conversion refused with `ReentrancyGuardReentrantCall` (a held lock, transient)
/// and a delivery left too little gas to write the park still revert the message.
/// @dev The adapter keeps a native reserve (`fundReserve`) and a token cushion, booked since R4 (`fundCushion`,
/// `tokenCushion`; a plain transfer of the token is surplus): the fee is paid out of msg.value; a conversion at most 1
/// rao short (`SHORTFALL_TOLERANCE_WEI`) is covered from the reserve on delivery and from the booked cushion on a send or
/// a converted refund, never from a park; any rounding surplus from the alpha vault and any kept fee excess stay in the
/// adapter until `sweepSurplus` sends what is above the native reserve, the booked cushion and the parks to the
/// immutable treasury. Since R4 a deliverParked keeps the vault's gas for its call (parkedDeliveryGas), and the vault
/// asks `canSendPayouts` before it burns a door redeem. One lock (`nonReentrant`) covers every inbound path, every
/// park function and the sweep: `_deliver`, which `ccipReceive` runs, `deliverParked`, `refundParked`,
/// `dropParked` and `sweepSurplus` (spec §3.2, H-3); `convertExact` is self-only and runs inside it. After
/// PARK_TIMEOUT a park is refunded to its door on Base, credited to each depositor, or dropped when empty.
contract CcipBittensorAdapter is CcipAdapterBase, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// A parked batch: what it owes (`amount`), since when (`parkedAt`, never 0 for a record, so an empty park
    /// of a redeem-only batch is a record too), and whether as native TAO (`converted`) or as tokens.
    struct Parked {
        uint128 amount;
        uint64 parkedAt;
        bool converted;
    }

    IStaking public constant STAKING = IStaking(ISTAKING_ADDRESS);
    /// After this long from its first `parkedAt` a park can be refunded to its door (`refundParked`), or dropped
    /// when empty (`dropParked`).
    uint64 public constant PARK_TIMEOUT = 14 days;
    /// The gas a delivery keeps back from the conversion and from the recipient's call, so a failure of either,
    /// out of gas included, still leaves enough to write the park. Task 61's fork measured the write at most 59,344
    /// (a native park of 50 deposits after a recipient that burned all its gas), 2.5 times under it, and no precompile
    /// runs after the failure, so the live write costs the same (R3 A-I2); kept at Task 65, since the reserve is part of
    /// every inbound message's CCIP gas.
    uint256 public constant PARK_GAS_RESERVE = 150_000;
    /// The most a conversion may come out short, 1 rao: a delivery's withdraw, covered from the native reserve, and a
    /// send's or a converted refund's deposit, covered from the token cushion; never from a park.
    uint256 public constant SHORTFALL_TOLERANCE_WEI = 1e9;
    /// The targets of the native reserve and the token cushion, 0.001 TAO each: what `sweepSurplus` leaves above the
    /// native parks (the reserve), and the monitor's `bridge.cushion_low` lines for both (since R4 the sweep leaves the
    /// booked `tokenCushion`, whatever it is, not this target); never parking conditions (M-B).
    uint256 public constant RESERVE_TARGET = 1e15;
    uint256 public constant TOKEN_RESERVE_TARGET = 1e15;
    /// The most gas canSendPayouts gives each of its three reads of ForeverMoney's AlphaVault (R4, S-H1; the vault-favour
    /// review): a view reads a slot or two, and a read that burns its gas then fails (false) within it, so the vault's
    /// call, inside every delivery, can never be made to starve the delivery.
    uint256 public constant RAIL_READ_GAS = 30_000;
    /// The chunk number of a refund's PAYOUTS message, beside the park's key as its batch key, so a refund is told
    /// apart from the vault's own payout chunks.
    uint32 public constant REFUND_CHUNK = type(uint32).max;

    IAlphaVault public immutable alphaVault;
    /// The lane's inbound gas model (R4, A-M1/C-M1): the Base adapter's own `gasBase` and `gasPerEntry`, the gas CCIP gives
    /// this adapter's `ccipReceive` for a message, `inboundGasBase + entries * inboundGasPerEntry` (capped at GAS_CAP), so
    /// at least what the vault's call for that message needs plus PARK_GAS_RESERVE, which the adapter keeps back from it:
    /// the pair includes the reserve (the R4 review), counted once, here. One model in two copies: the deploy plan passes
    /// the Base adapter's pair here too, and ops' verify fails when they differ. `deliverParked` requires it left for the
    /// recipient's call (parkedDeliveryGas). Held to the base's own model checks, and its base above the reserve.
    uint256 public immutable inboundGasBase;
    uint256 public immutable inboundGasPerEntry;

    /// The parks, by `keccak256(abi.encode(remoteChainId, sender, recipient, message))`.
    mapping(bytes32 key => Parked) public parked;
    /// The sum of the converted parks' amounts: native TAO the adapter owes them.
    uint256 public parkedNative;
    /// The sum of the unconverted parks' amounts: bridged tokens the adapter owes them.
    uint256 public parkedTokens;
    /// The token cushion, booked (R4, F-1): what `fundCushion` brought in, less what covered a send's or a converted
    /// refund's mint at most 1 rao short (`ShortfallCovered`). Every token above `parkedTokens + tokenCushion` is
    /// surplus, the sweep's (a mint's rounding in the adapter's favour, a plain transfer): the books tell the two apart,
    /// never the balance. No delivery, park function or sweep spends the booked cushion; a forged amount can take at
    /// most the unswept surplus.
    uint256 public tokenCushion;

    event ReserveFunded(address indexed from, uint256 amount);
    /// `fundCushion` booked `amount` of the bridged token from `from` into the token cushion (R4, F-1).
    event CushionFunded(address indexed from, uint256 amount);
    /// A delivered batch parked: `converted` as native TAO (its recipient refused it) or as tokens (the conversion
    /// failed); `reason` is the failure's 4-byte selector, 0x00000000 for an empty revert or no gas. `messageId` is
    /// CCIP's, by which the keeper rebuilds the message from the Base OnRamp's CCIPMessageSent.
    event BatchParked(
        bytes32 indexed key,
        bytes32 indexed messageId,
        address recipient,
        address sender,
        uint256 amount,
        bool converted,
        bytes4 reason
    );

    /// `deliverParked` delivered the park under `key`: its record is gone and its recipient took the native TAO.
    event ParkedDelivered(bytes32 indexed key);
    /// `deliverParked` could not deliver the park under `key` (its recipient refused it): it stays parked as native
    /// TAO, converted first if it was tokens, its amount and `parkedAt` unchanged.
    event ParkedConverted(bytes32 indexed key);
    /// `refundParked` refunded the park under `key` to its door: its record is gone and its amount left in the CCIP
    /// message `messageId` toward Base.
    event ParkedRefunded(bytes32 indexed key, bytes32 indexed messageId);
    /// `dropParked` deleted the empty park under `key`.
    event ParkedDropped(bytes32 indexed key);
    /// `_collect`'s conversion minted `amount` wei less than the TAO it was paid (at most SHORTFALL_TOLERANCE_WEI), and
    /// the token cushion, never a token park, made up the difference: the send still carries its whole amount.
    event ShortfallCovered(uint256 amount);

    error AlreadyParked();
    error NotParked();
    error ReserveShort();
    error OnlySelf();
    error ParkedTooYoung();
    error NothingToRefund();

    constructor(Config memory c, IAlphaVault alphaVault_, uint256 inboundGasBase_, uint256 inboundGasPerEntry_)
        CcipAdapterBase(c)
    {
        if (address(alphaVault_) == address(0)) revert ZeroAddress();
        _checkGasModel(inboundGasBase_, inboundGasPerEntry_);
        // the pair includes the reserve the recipient's call is kept short of, so its base must exceed it
        if (inboundGasBase_ <= PARK_GAS_RESERVE) revert InvalidParameter();
        alphaVault = alphaVault_;
        inboundGasBase = inboundGasBase_;
        inboundGasPerEntry = inboundGasPerEntry_;
    }

    /// @notice The gas `deliverParked` requires left right before it calls the recipient with the parked batch
    /// `message` (R4, A-M1/C-M1): the lane's inbound model for the message, `inboundGasBase + entries *
    /// inboundGasPerEntry` capped at GAS_CAP (a message that does not parse: the cap), which includes PARK_GAS_RESERVE
    /// (the R4 review: counted once, in the pair), so the recipient's call gets at least what a CCIP delivery's would.
    /// The keeper's floor: a deliverParked sent with less gas than this plus the call's own work reverts InsufficientGas.
    function parkedDeliveryGas(bytes memory message) public view returns (uint256) {
        return _gasModel(message, inboundGasBase, inboundGasPerEntry);
    }

    /// @notice Smallest non-zero amount the alpha vault converts, in wei: the chain's default minimum stake
    /// (rao) times 1e9.
    function floor() public view returns (uint256) {
        return STAKING.getDefaultMinStake() * RAO;
    }

    /// @notice Whether this adapter can send payouts now (spec §3.5, R4 S-H1): every send converts through ForeverMoney's
    /// `depositLiquid`, so false while its AlphaVault is paused, has a migration announced (closed from the
    /// announcement until ForeverMoney's `cancelMigration()` reopens it, which this view reads live) or has finished
    /// one, or when any of those reads fails. The vault defers its front-door redeems
    /// while its primary bridge answers false, so no exit is burned into a queue that cannot be paid. Never reverts
    /// (the R4 review): no code at the AlphaVault's address, a read that reverts, answers empty or less than a word, or
    /// runs out of its RAIL_READ_GAS each reads false (`_railRead`), so the vault's fail-open read of this view is
    /// never reached through it.
    function canSendPayouts() external view returns (bool) {
        address av = address(alphaVault);
        if (av.code.length == 0) return false;
        (bool ok, uint256 word) = _railRead(av, IAlphaVault.isPaused.selector);
        if (!ok || word != 0) return false;
        (ok, word) = _railRead(av, IAlphaVault.migrationReadyAt.selector);
        if (!ok || word != 0) return false;
        (ok, word) = _railRead(av, IAlphaVault.migrationFinished.selector);
        return ok && word == 0;
    }

    /// @notice Tops up the native reserve, which keeps the adapter's balance above zero and covers a delivery's
    /// conversion shortfall of at most 1 rao.
    function fundReserve() external payable {
        emit ReserveFunded(msg.sender, msg.value);
    }

    /// @notice Tops up the token cushion (R4, F-1): pulls `amount` of the bridged token from the caller (approve it
    /// first) and books it in `tokenCushion`, which covers a send's or a converted refund's mint at most 1 rao short. A
    /// plain transfer of the token is surplus, the sweep's, not the cushion. Under the adapter's lock.
    function fundCushion(uint256 amount) external nonReentrant {
        token.safeTransferFrom(msg.sender, address(this), amount);
        tokenCushion += amount;
        emit CushionFunded(msg.sender, amount);
    }

    /// @notice Converts `amount` of the bridged token the adapter holds into native TAO through the alpha vault
    /// (spec §3.2). Only the adapter calls it (`OnlySelf`), from inside its lock, which it does not take, so its
    /// failure reverts this frame alone, ForeverMoney's burn with it. Reverts `BelowConversionFloor` below the
    /// chain's minimum stake (read here, so a failing read fails the conversion too), and `ConversionShort` unless
    /// the native balance grew by at least `amount - SHORTFALL_TOLERANCE_WEI` and still covers `parkedNative +
    /// amount`: the covering rao comes from the reserve, never from parked TAO. ForeverMoney's `withdrawLiquid`
    /// checks the TAO it measured against the same `amount - SHORTFALL_TOLERANCE_WEI` first, so on the live rail a
    /// payment more than 1 rao short reverts there (`Slippage`, R3 FM-L1), and `ConversionShort` means one at most 1
    /// rao short with the reserve empty.
    function convertExact(uint256 amount) external {
        if (msg.sender != address(this)) revert OnlySelf();
        uint256 min = floor();
        if (amount < min) revert BelowConversionFloor(amount, min);
        uint256 before = address(this).balance;
        uint256 tokensBefore = token.balanceOf(address(this));
        // the callers pass a non-zero whole-rao amount, so amount >= 1 rao and this cannot underflow
        alphaVault.withdrawLiquid(address(token), amount, amount - SHORTFALL_TOLERANCE_WEI);
        uint256 balance = address(this).balance;
        // F-3 (R4): at most `amount` of the adapter's tokens burned (ForeverMoney's withdrawLiquid burns exactly `wad`),
        // never more, out of the cushion or another park; one that burned less leaves the rest as surplus, so a 1-wei
        // rounding on its side parks nothing
        if (
            token.balanceOf(address(this)) + amount < tokensBefore
                || balance - before < amount - SHORTFALL_TOLERANCE_WEI || balance < parkedNative + amount
        ) {
            revert ConversionShort();
        }
    }

    /// @notice Delivers the parked batch `message` from `sender` to `recipient` (spec §3.2). Anyone may call it, under
    /// the adapter's one lock (H-3). It recomputes the key and reverts `NotParked` when there is no record. A token
    /// park is converted first, with `convertExact` and no `try`, so a conversion that still fails reverts this call
    /// with its error and the record stays as it was. Then checks-effects-interactions: the record is deleted and its
    /// total lowered before the recipient's `onBridgeMessage`, which runs with the native TAO and all the gas but
    /// PARK_GAS_RESERVE, as `_deliver`'s step 4. Accepted, it emits `ParkedDelivered`. Refused, the record is
    /// restored as a converted park of the same amount from the same `parkedAt`, so no retry moves the refund's
    /// PARK_TIMEOUT (I-10), the amount is added back to `parkedNative`, and it emits `ParkedConverted`. Refused by a
    /// held lock (`ReentrancyGuardReentrantCall`), the whole call reverts and the park stays exactly as it was, a
    /// token park unconverted (R3 CC-L1).
    function deliverParked(address recipient, address sender, bytes calldata message) external nonReentrant {
        bytes memory m = message;
        bytes32 key = _parkKey(recipient, sender, m);
        Parked memory p = parked[key];
        if (p.parkedAt == 0) revert NotParked();
        // §3.2 converts, moves `amount` from parkedTokens to parkedNative and marks the record converted, then deletes
        // the record and takes `amount` off parkedNative; the move and the decrement net to lowering the total the
        // park is counted in, which is all that is written here. convertExact's `parkedNative + amount` check runs
        // first, so it sees parkedNative without this park either way.
        if (!p.converted && p.amount != 0) {
            parkedTokens -= p.amount;
            // C-L1 (R4): the park's own tokens, never another park's
            _requireTokens(p.amount);
            this.convertExact(p.amount);
        } else {
            parkedNative -= p.amount;
            // F-5 (R4): the park's own native TAO, never another park's
            _requireNative(p.amount);
        }
        delete parked[key];
        // R4 (A-M1, C-M1): the recipient's call below gets all the gas but PARK_GAS_RESERVE and a refusal is caught, so
        // a call starved of gas would "succeed" as a re-park; with less than the lane's model for this batch left here
        // (the vault's need and the reserve), the whole call reverts instead and the park stays exactly as it was (a
        // token park unconverted)
        uint256 need = parkedDeliveryGas(m);
        if (gasleft() < need) revert InsufficientGas();
        // ruling B7c: _deliver's own recipient call and native park; its catch restores what was just deleted, with
        // the record's first parkedAt
        (bool paid,) = _payOrParkNative(key, p.parkedAt, recipient, sender, m, p.amount);
        if (paid) emit ParkedDelivered(key);
        else emit ParkedConverted(key);
    }

    /// @notice Refunds the parked batch `message` from `sender` (its door) to `recipient` (its vault) back to the door
    /// on Base (spec §3.2, I-9, I-10). Anyone may call it, under the adapter's one lock (H-3), once PARK_TIMEOUT has
    /// passed since the park's first `parkedAt` (else `ParkedTooYoung`; a refused `deliverParked` keeps it, so no
    /// retry postpones the refund). `NotParked` without a record, `NothingToRefund` for an empty park (dropped
    /// instead). The message is `PAYOUTS(key, REFUND_CHUNK, [(user, amount) per deposit])`, each depositor's exact
    /// deposit from the parked BATCH, with the park's recipient (the vault) as the payload's sender and its sender
    /// (the door) as the recipient, so the door takes it as a payout from its vault and `netForwarded` falls by it.
    /// Checks-effects-interactions: the record is deleted and its total lowered first; then a converted park goes
    /// back into the bridged token through `_collect` (`depositLiquid`, which needs ForeverMoney's rail open), and an
    /// unconverted one approves the router for the tokens it holds, as they are. The send makes no amount check
    /// (`_ccipSend`): the conversion floor applies only to conversions, and no floor or cap may trap a refund
    /// (I-10). The fee comes from msg.value (`quoteRefund`); any excess stays in the adapter. A token park that a
    /// `deliverParked` converted (the recipient refused it, or was starved of gas) is refunded as a converted park,
    /// through `depositLiquid`: never a loss, but it needs the rail.
    function refundParked(address recipient, address sender, bytes calldata message) external payable nonReentrant {
        (bytes32 key, Parked memory p, bytes memory payouts) = _refundOf(recipient, sender, message);
        // a validator's few seconds of timestamp skew are nothing against a 14-day timeout
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < p.parkedAt + PARK_TIMEOUT) revert ParkedTooYoung();
        delete parked[key];
        // each total is lowered before its branch's first call
        if (p.converted) {
            parkedNative -= p.amount;
            // F-5 (R4): the park's own native TAO, never another park's
            _requireNative(p.amount);
            _collect(p.amount);
        } else {
            parkedTokens -= p.amount;
            // C-L1 (R4): the park's own tokens, never another park's
            _requireTokens(p.amount);
            token.forceApprove(address(router), p.amount);
        }
        bytes32 messageId = _ccipSend(sender, recipient, payouts, p.amount, msg.value);
        emit ParkedRefunded(key, messageId);
    }

    /// @notice The CCIP fee `refundParked` pays for the same park: the router's fee for exactly the message it sends.
    /// Not gated by the timeout, so the keeper can quote ahead; `NotParked` and `NothingToRefund` as `refundParked`.
    function quoteRefund(address recipient, address sender, bytes calldata message) external view returns (uint256) {
        (, Parked memory p, bytes memory payouts) = _refundOf(recipient, sender, message);
        return router.getFee(remoteSelector, buildMessage(sender, recipient, payouts, p.amount));
    }

    /// @notice Deletes the empty park (a refused redeem-only batch, amount 0) of `message` from `sender` to
    /// `recipient` (spec §3.2), with `ParkedDropped`. Anyone may call it, under the adapter's one lock (H-3), once
    /// PARK_TIMEOUT has passed since its `parkedAt` (else `ParkedTooYoung`); a park that owes an amount, or none at
    /// all, is `NotParked` (an amount is refunded, never dropped). Nothing else is owed: the redeems in a dropped
    /// batch were never burned, since the vault refused the batch, so their requesters keep their shares and request
    /// again.
    function dropParked(address recipient, address sender, bytes calldata message) external nonReentrant {
        bytes32 key = _parkKey(recipient, sender, message);
        Parked memory p = parked[key];
        if (p.parkedAt == 0 || p.amount != 0) revert NotParked();
        // as refundParked's: seconds of skew against 14 days
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < p.parkedAt + PARK_TIMEOUT) revert ParkedTooYoung();
        delete parked[key];
        emit ParkedDropped(key);
    }

    /// @notice Sends what the adapter holds above its reserves and its parks to the immutable `treasury` (spec §3.2):
    /// the native balance above RESERVE_TARGET + parkedNative (a refund's or a send's kept fee excess, a withdraw's
    /// rounding surplus) and the token balance above parkedTokens + tokenCushion, the booked cushion (R4, F-1: a
    /// deposit's over-mint, tokens sent by mistake or by a plain transfer), each floored at 0, with `SurplusSwept`. Anyone may call it. It never sends what is owed
    /// (I-7): it leaves at least each park total plus its reserve, or the whole balance when that is less. Unlike the
    /// Base adapter's (ruling B12) it is under the adapter's one lock (H-3), because this adapter owes its parks: a
    /// treasury that re-enters from the native payment meets the lock on every park function.
    /// @dev The I-7 argument also relies on `send`, which takes no lock, staying callback-free between `_collect`'s
    /// `depositLiquid` and `_ccipSend`'s `router.ccipSend`: in that window the minted tokens and the fee budget sit in
    /// the balance but in neither park total, so a sweep run there would count them as surplus. Only the immutable
    /// alpha vault, token and router run there today; any future callback in `send` must take the lock or account for
    /// the value in flight.
    function sweepSurplus() external nonReentrant {
        _sweep(
            _sub0(address(this).balance, RESERVE_TARGET + parkedNative),
            _sub0(token.balanceOf(address(this)), parkedTokens + tokenCushion)
        );
    }

    /// @dev Only the alpha vault pays native TAO in (the proceeds of `withdrawLiquid`).
    receive() external payable {
        if (msg.sender != address(alphaVault)) revert UnexpectedValue();
    }

    function _checkAmount(uint256 amount) internal view override {
        if (amount != 0 && amount < floor()) revert BelowConversionFloor(amount, floor());
    }

    function _budget(uint256 amount) internal view override returns (uint256) {
        if (msg.value < amount) revert InsufficientFee();
        return msg.value - amount;
    }

    /// @dev Every path that turns native TAO into the bridged token, `send` (the vault's payouts) and a converted
    /// refund (spec §3.2, §3.3): `depositLiquid` of exactly `amount`, then the mint must be at least `amount -
    /// SHORTFALL_TOLERANCE_WEI` (more is kept, as surplus for the sweep); the at most 1 rao short comes out of the
    /// booked cushion (R4, F-1: `tokenCushion`, lowered by it; else `ConversionShort`), never out of a park or the
    /// surplus, and the token balance must still cover `parkedTokens + tokenCushion + amount` (else `ConversionShort`).
    /// `ShortfallCovered` names what the cushion paid. Then the router is approved for `amount`. ForeverMoney's
    /// `depositLiquid` checks the stake it measured against `minAlphaRao` (`Slippage`), so it is asked for the amount
    /// less 1 rao, the tolerance (R3 B-1): a stake 1 rao short reaches this check, which binds; one shorter fails there.
    function _collect(uint256 amount) internal override {
        if (amount % RAO != 0) revert NotRaoAligned();
        uint256 before = token.balanceOf(address(this));
        // both callers pass a non-zero amount, a whole number of rao (checked above), so amount >= 1 rao and neither
        // this subtraction nor the tolerance's below can underflow
        alphaVault.depositLiquid{value: amount}(address(token), amount / RAO - 1);
        uint256 balance = token.balanceOf(address(this));
        uint256 minted = balance - before;
        if (minted < amount - SHORTFALL_TOLERANCE_WEI) revert ConversionShort();
        if (minted < amount) {
            // F-1 (R4): the at most 1 rao short comes out of the booked cushion, never a park or the surplus
            uint256 short = amount - minted;
            if (short > tokenCushion) revert ConversionShort();
            tokenCushion -= short;
            emit ShortfallCovered(short);
        }
        if (balance < parkedTokens + tokenCushion + amount) revert ConversionShort();
        token.forceApprove(address(router), amount);
    }

    /// @dev Spec §3.2's four steps, in order, under the lock (ruling A2: every inbound path runs through here, and
    /// `ccipReceive` stays the base's):
    /// 1. the BATCH decodes and its deposits sum to `amount` (`AmountMismatch`), a whole number of rao
    ///    (`NotRaoAligned`); a malformed batch reverts the message, which only a malformed sender produces;
    /// 2. the batch is not parked already (`AlreadyParked`);
    /// 3. unless `amount == 0` (a redeem-only batch needs no conversion, L-A), `convertExact` with all the gas but
    ///    PARK_GAS_RESERVE; on failure the tokens park, if the token balance covers `parkedTokens + amount` (the
    ///    pool has just released `amount`, so only wrong books fail it: `ReserveShort`), except a refusal by
    ///    ForeverMoney's held lock (`ReentrancyGuardReentrantCall`), which reverts the message;
    /// 4. the recipient's `onBridgeMessage` with the native TAO and all the gas but PARK_GAS_RESERVE; on failure
    ///    the native TAO parks (a redeem-only batch with `amount == 0`), `_payOrParkNative`, except a refusal by a
    ///    held lock (`ReentrancyGuardReentrantCall`), which reverts the message (CCIP `FAILURE`, re-executable).
    function _deliver(bytes32 messageId, address recipient, address sender, bytes memory message, uint256 amount)
        internal
        override
        nonReentrant
    {
        (, CascadeMessages.Entry[] memory deposits,) = CascadeMessages.decodeBatch(message);
        uint256 sum;
        for (uint256 i; i < deposits.length; ++i) {
            sum += deposits[i].amount;
        }
        if (sum != amount) revert AmountMismatch();
        if (amount % RAO != 0) revert NotRaoAligned();

        bytes32 key = _parkKey(recipient, sender, message);
        if (parked[key].parkedAt != 0) revert AlreadyParked();

        if (amount != 0) {
            // C-L1 (R4): only tokens that arrived; the router names `amount`, and a compromised lane naming tokens it
            // never delivered would otherwise have the conversion burn the token parks
            _requireTokens(amount);
            try this.convertExact{gas: _sub0(gasleft(), PARK_GAS_RESERVE)}(amount) {}
            catch {
                // read before any other call replaces the return data
                bytes4 reason = _caughtSelector();
                _revertIfLocked(reason);
                // the balance still covers the parks and `amount`: a failed conversion rolled ForeverMoney's burn back
                // casting to 'uint128' is safe because `amount` is bridged tokens the adapter holds, at most the
                // token's supply (TAO's 21M, 2.1e25 wei, far below 2^128)
                // forge-lint: disable-next-line(unsafe-typecast)
                parked[key] = Parked(uint128(amount), uint64(block.timestamp), false);
                parkedTokens += amount;
                emit BatchParked(key, messageId, recipient, sender, amount, false, reason);
                return;
            }
        }

        (bool paid, bytes4 why) = _payOrParkNative(key, uint64(block.timestamp), recipient, sender, message, amount);
        if (!paid) emit BatchParked(key, messageId, recipient, sender, amount, true, why);
    }

    /// @dev The recipient's `onBridgeMessage` with `amount` of native TAO and all the gas but PARK_GAS_RESERVE, and
    /// its native park (ruling B7c): on success it writes nothing; on a revert, or with no gas above the reserve,
    /// it records the batch under `key` as a converted park of `amount` from `parkedAt`, adds `amount` to
    /// `parkedNative`, and returns the failure's selector for the caller's event. It writes nothing before the
    /// call, and a recipient that re-enters meets the lock. `_deliver` calls it with nothing recorded and now as
    /// `parkedAt`; `deliverParked` calls it after deleting the record and lowering its total, which this failure
    /// branch restores as a converted park, with the record's own `parkedAt`. A refusal whose selector is
    /// `ReentrancyGuardReentrantCall` (a lock the recipient holds, such as the vault's while a stranger's code runs
    /// under it) is transient, not a refusal of the batch: it reverts with that selector instead, so the caller's
    /// whole call reverts (R3 CC-L1).
    function _payOrParkNative(
        bytes32 key,
        uint64 parkedAt,
        address recipient,
        address sender,
        bytes memory message,
        uint256 amount
    ) private returns (bool paid, bytes4 reason) {
        try ICascadeReceiver(recipient).onBridgeMessage{value: amount, gas: _sub0(gasleft(), PARK_GAS_RESERVE)}(
            remoteChainId, sender, message, amount
        ) {
            return (true, bytes4(0));
        } catch {
            reason = _caughtSelector();
            _revertIfLocked(reason);
            // casting to 'uint128' is safe because `amount` is native TAO converted from bridged tokens, at most
            // the token's supply (2.1e25 wei, far below 2^128)
            // forge-lint: disable-next-line(unsafe-typecast)
            parked[key] = Parked(uint128(amount), parkedAt, true);
            parkedNative += amount;
        }
    }

    /// @dev One of canSendPayouts' reads: the AlphaVault's no-argument getter `selector` by a STATICCALL capped at
    /// RAIL_READ_GAS, copying back at most one word (so no answer, however long, costs more than the cap); `ok` only when
    /// the call succeeded and answered at least a whole word, `word` that first word (a bool's 0 or 1, a timestamp).
    function _railRead(address av, bytes4 selector) private view returns (bool ok, uint256 word) {
        uint256 cap = RAIL_READ_GAS;
        assembly ("memory-safe") {
            mstore(0x00, selector)
            let success := staticcall(cap, av, 0x00, 0x04, 0x00, 0x20)
            ok := and(success, iszero(lt(returndatasize(), 0x20)))
            word := mload(0x00)
        }
    }

    /// @dev A refusal by a lock held around a stranger's code is no answer to the batch and is free once that outer
    /// transaction ends (R3 CC-L1): the recipient's (the vault's, around `redeemDirect`'s payment or `processPayouts`'
    /// refund) or the conversion's (ForeverMoney's AlphaVault's, around `withdrawLiquid`'s payment), both OpenZeppelin
    /// v5's `ReentrancyGuardReentrantCall`. Reverts the whole call with it, so CCIP records FAILURE (re-executable once
    /// the lock is free, with the committee's results, as every execution: README, operator note 18) and a
    /// `deliverParked` keeps the park as it was; any other `reason` returns.
    function _revertIfLocked(bytes4 reason) private pure {
        if (reason == ReentrancyGuardReentrantCall.selector) revert ReentrancyGuardReentrantCall();
    }

    /// @dev The 4-byte selector of the failure just caught, read from the return data without copying the rest (so
    /// no length of revert data can eat the gas reserve); 0x00000000 for an empty or shorter revert, as an out of
    /// gas leaves.
    function _caughtSelector() private pure returns (bytes4 reason) {
        assembly ("memory-safe") {
            if gt(returndatasize(), 3) {
                returndatacopy(0, 0, 4)
                reason := and(mload(0), shl(224, 0xffffffff))
            }
        }
    }

    /// @dev A park's key (spec §3.2): the batch's source chain, sender, recipient and message, so a park is found
    /// again from the message the keeper rebuilds, and no other batch's content can reach it.
    function _parkKey(address recipient, address sender, bytes memory message) private view returns (bytes32) {
        return keccak256(abi.encode(remoteChainId, sender, recipient, message));
    }

    /// @dev The park of `message` from `sender` to `recipient` that a refund needs (`NotParked` without a record,
    /// `NothingToRefund` for an empty one), and its refund message, `PAYOUTS(key, REFUND_CHUNK, deposits)`: the parked
    /// BATCH's deposit entries as they are, each depositor's exact deposit, which `_deliver` checked sum to the
    /// park's amount before writing the record the key now finds.
    function _refundOf(address recipient, address sender, bytes calldata message)
        private
        view
        returns (bytes32 key, Parked memory p, bytes memory payouts)
    {
        bytes memory m = message;
        key = _parkKey(recipient, sender, m);
        p = parked[key];
        if (p.parkedAt == 0) revert NotParked();
        if (p.amount == 0) revert NothingToRefund();
        (, CascadeMessages.Entry[] memory deposits,) = CascadeMessages.decodeBatch(m);
        payouts = CascadeMessages.encodePayouts(key, REFUND_CHUNK, deposits);
    }

    /// @dev C-L1 and F-1 (R4; spec §3.2, §5's Chainlink row): reverts ReserveShort unless the token balance covers the
    /// token parks (`parkedTokens`, without the caller's own park, which it has already taken out), the booked cushion
    /// (`tokenCushion`) and `amount`, so no conversion or spend of `amount` takes another park's tokens or the cushion:
    /// an inbound delivery's, which only tokens that arrived can pass (a forged amount takes at most the unswept
    /// surplus, the treasury's), and a token park's own conversion or refund, which only wrong books can fail.
    function _requireTokens(uint256 amount) private view {
        if (token.balanceOf(address(this)) < parkedTokens + tokenCushion + amount) revert ReserveShort();
    }

    /// @dev F-5 (R4): reverts ReserveShort unless the native balance covers the native parks (`parkedNative`, without the
    /// caller's own park, already taken out) and `amount`: a converted park's delivery or refund spends only its own
    /// native TAO. Only wrong books fail it (every native outflow is measured or paid by its caller).
    function _requireNative(uint256 amount) private view {
        if (address(this).balance < parkedNative + amount) revert ReserveShort();
    }

    /// @dev `a - b`, floored at 0: a gas reserve larger than what is left forwards no gas, and that call fails.
    function _sub0(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}

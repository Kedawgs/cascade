// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {IStaking} from "../../src/interfaces/IStaking.sol";
import {mirror} from "./Mirror.sol";

// Where addStake's debit goes (rao * 1e9 wei a stake): an address with no code, which nothing reads.
address constant STAKED_TAO_SINK = address(uint160(uint256(keccak256("MockStaking: the staked TAO"))));

/// @notice Test double for the staking precompile. Etch at ISTAKING_ADDRESS with vm.etch (constructors
/// never run), so every setting is zero-valued by default and means "use the real-chain default".
/// Like the precompile it debits/credits the caller's native balance (rao * 1e9 wei), and every debit and credit is a
/// value transfer, which a call that reverts undoes with everything else (Task 35: a `vm.deal` survived a revert, so a
/// walk or a stake that reverted left the caller's balance moved). addStake's debit is a value transfer from the
/// caller to STAKED_TAO_SINK; a removal pays by a call with value by default (setPayByCall); a claim paid as balance
/// is a forced credit by default (no code runs, as the chain credits it).
contract MockStaking is IStaking {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error UnknownHotkey();
    error BelowMinStake();
    error AmountTooLow();
    error InsufficientBalance();
    error InsufficientStake();
    error TooEarly();
    error UnexpectedValue();
    error TotalReadReverted();
    error InvalidBps();
    error RootStakeLocked();
    error UnclaimedReadReverted();
    /// @dev A read given less than `readGasFloor` gas (see it).
    error ReadRefusedShortOfGas();

    uint256 private constant RAO_TO_WEI = 1e9;

    // Overrides: 0 means default.
    uint256 public minStakeOverride;
    uint256 public nominatorMinOverride;
    uint256 public claimGasOverride;
    /// @dev false (default) means a credit into an empty position lands one rao short.
    bool public exactStakeReads;
    bool public claimTooHeavy;
    bool public unstakeBlocked;
    /// @dev A chain fee, in rao, deducted from what each removeStake / removeStakeFull credits.
    uint256 public removeFeeRao;
    /// @dev true pays a claim out as the caller's native balance instead of stake on the hotkey.
    bool public claimToBalance;
    /// @dev How a credit reaches the caller (both are value transfers, undone by a revert). By default (Task 35) a
    /// removal pays by a call with value, so the TAO enters the caller's receive() as an EVM transfer would, and a
    /// refused payment reverts the removal with the caller's revert data; a claim paid as balance is forced (no code
    /// runs: the real precompile credits the balance without a call, and the vault's receive() refuses value outside
    /// an unstake). setPayByCall(true) pays every credit by a call, a claim's too (the unstake guard's test);
    /// setPayByCall(false) forces every credit. Stored inverted, as an etched mock starts at zero.
    bool private _removalsForced;
    bool private _claimsByCall;
    /// @dev true makes getTotalColdkeyStakeOnSubnet revert, as a precompile function that is gone would.
    bool public totalReadReverts;
    /// @dev true makes getTotalColdkeyStakeOnSubnet burn all the gas it is given (an invalid opcode), as a
    /// dispatch failure would, so a caller's gas stipend is what bounds the read (Task 16).
    bool public totalReadBurnsGas;
    /// @dev Rao the claimed hotkey's root position loses during each claim, after the claim lands (an unexpected
    /// fall, spec §3.10.14), floored at 0.
    uint256 public claimFallRao;
    /// @dev The gas below which getTotalColdkeyStakeOnSubnet, getDefaultMinStake and getNominatorMinRequiredStake
    /// refuse at once with a revert, returning the rest of what they were given (0: never): a precompile that checks
    /// its cost up front and refuses rather than running out, so a caller whose capped read was starved keeps the gas
    /// to go on (Revision 28's gas audit, CascadeFormulas.requireGasFor).
    uint256 public readGasFloor;

    mapping(bytes32 hotkey => bool) public knownHotkey;
    mapping(bytes32 hotkey => mapping(bytes32 coldkey => mapping(uint256 netuid => uint256))) private _stake;
    /// @dev Each coldkey's stake on each subnet across every hotkey, kept by _setStake (every write of _stake).
    mapping(bytes32 coldkey => mapping(uint256 netuid => uint256)) private _total;
    mapping(bytes32 coldkey => mapping(bytes32 hotkey => uint256)) private _unclaimed;
    mapping(bytes32 coldkey => bool) private _rejectsGrowth;
    mapping(address who => bytes32) public coldkeyAlias;
    /// @dev Hotkeys whose pairs are under a root hold (spec §3.8, Task 20; HoldStaking's model without its clock):
    /// every coldkey's removeStake and removeStakeFull on the hotkey, and its moveStake from it, are refused.
    mapping(bytes32 hotkey => bool) public pairLocked;
    /// @dev true makes a refused removal (a held pair, or setUnstakeBlocked) consume all the gas forwarded to it (an
    /// invalid opcode) instead of reverting at once, as a failed precompile write does on the live runtime (README,
    /// the pre-mainnet checklist), so the caller's gas cap is what bounds it (Task 20).
    bool public burnRemoveGas;
    /// @dev true records, for each removal that goes through, the gas it was given (gasleft() at its entry), by
    /// hotkey (the last such removal on it): the unstake walk's per-position gas split, which a test reads (Task 20).
    bool public recordRemovalGas;
    mapping(bytes32 hotkey => uint256) public removalGas;
    /// @dev Non-zero: a removal that goes through first burns its gas down to this much, then completes, as an
    /// expensive removal on the live runtime would, so what the walk's caller has left after it is the reserve the walk
    /// kept back (Task 20's follow-up).
    uint256 public removalKeepsGas;
    /// @dev true makes getUnclaimedRootTaoByHotkey revert, as a precompile function that is gone would (R2 F1: the
    /// vault's removeHotkey reads it as an optional read).
    bool public unclaimedReadReverts;
    /// @dev Rao credited onto the staked position inside each addStake beyond what was staked and paid for, as a
    /// chain-side credit landing during the stake would (a root-claim settlement on a stake change, the pre-mainnet
    /// checklist's item 1; R2 F3: stakeIdle books at most what it staked).
    uint256 public addStakeCreditRao;
    /// @dev Wei, under a rao, the chain keeps of each removeStake / removeStakeFull credit beyond removeFeeRao: a
    /// hypothetical chain that does not floor transfers to rao (Task 36b: the vault's walk cost rounds up to rao, a
    /// defensive rounding no whole-rao fee shows). 0 by default.
    uint256 public removeFeeWei;

    // ---- test configuration ----

    function addHotkey(bytes32 hotkey) external {
        knownHotkey[hotkey] = true;
    }

    function setMinStake(uint256 v) external {
        minStakeOverride = v;
    }

    function setNominatorMin(uint256 v) external {
        nominatorMinOverride = v;
    }

    function setClaimGasRequired(uint256 v) external {
        claimGasOverride = v;
    }

    /// @dev Routes this account's calls to `coldkey` instead of its mirror, so real contract bytecode can
    /// act as a ForeverMoney-style coldkey.
    function setColdkeyAlias(address who, bytes32 coldkey) external {
        coldkeyAlias[who] = coldkey;
    }

    function setOneRaoShort(bool on) external {
        exactStakeReads = !on;
    }

    function setClaimTooHeavy(bool v) external {
        claimTooHeavy = v;
    }

    function setUnstakeBlocked(bool v) external {
        unstakeBlocked = v;
    }

    function setRemoveFeeRao(uint256 rao) external {
        removeFeeRao = rao;
    }

    function setRemoveFeeWei(uint256 wei_) external {
        removeFeeWei = wei_;
    }

    function setClaimToBalance(bool v) external {
        claimToBalance = v;
    }

    /// @dev true: every credit by a call with value, a claim's too; false: every credit forced (see _removalsForced).
    function setPayByCall(bool on) external {
        _removalsForced = !on;
        _claimsByCall = on;
    }

    /// @dev Whether a removal pays by a call with value (the default).
    function payByCall() external view returns (bool) {
        return !_removalsForced;
    }

    function setTotalReadReverts(bool on) external {
        totalReadReverts = on;
    }

    function setTotalReadBurnsGas(bool on) external {
        totalReadBurnsGas = on;
    }

    function setReadGasFloor(uint256 floor) external {
        readGasFloor = floor;
    }

    function setUnclaimedReadReverts(bool on) external {
        unclaimedReadReverts = on;
    }

    function setAddStakeCreditRao(uint256 rao) external {
        addStakeCreditRao = rao;
    }

    function setClaimFallRao(uint256 rao) external {
        claimFallRao = rao;
    }

    /// @dev A root hold on `hotkey`'s pairs while `locked`: removeStake, removeStakeFull and moveStake on that pair
    /// revert RootStakeLocked (or burn their gas, setBurnRemoveGas; moveStake always reverts at once).
    function setPairLocked(bytes32 hotkey, bool locked) external {
        pairLocked[hotkey] = locked;
    }

    /// @dev true: a refused removal consumes all the gas forwarded to it (burnRemoveGas).
    function setBurnRemoveGas(bool on) external {
        burnRemoveGas = on;
    }

    function setRecordRemovalGas(bool on) external {
        recordRemovalGas = on;
    }

    /// @dev Non-zero: every removal that goes through uses all its gas but `keep` (removalKeepsGas); 0, off.
    function setRemovalKeepsGas(uint256 keep) external {
        removalKeepsGas = keep;
    }

    /// @dev Sets (does not add to) the unclaimed root amount, in rao.
    function setUnclaimed(bytes32 coldkey, bytes32 hotkey, uint256 rao) external {
        _unclaimed[coldkey][hotkey] = rao;
    }

    /// @dev Root stake moved onto (hotkey, coldkey) from outside, as another coldkey's transferStake would.
    function donateStake(bytes32 hotkey, bytes32 coldkey, uint256 rao) external {
        donateStakeOnSubnet(hotkey, coldkey, 0, rao);
    }

    /// @dev Stake on subnet `netuid` (alpha, unless 0) moved onto (hotkey, coldkey) from outside.
    function donateStakeOnSubnet(bytes32 hotkey, bytes32 coldkey, uint256 netuid, uint256 amount) public {
        _setStake(hotkey, coldkey, netuid, _stake[hotkey][coldkey][netuid] + amount);
    }

    /// @dev Root stake gone from (hotkey, coldkey) for good, as a real loss would leave it (the case the vault's
    /// write-off is for, Task 16): the position and the coldkey's total fall by `rao`, floored at 0, and nothing
    /// is paid to anyone. Unlike swapHotkey, the stake is under no other hotkey of the coldkey.
    function loseStake(bytes32 hotkey, bytes32 coldkey, uint256 rao) external {
        uint256 held = _stake[hotkey][coldkey][0];
        _setStake(hotkey, coldkey, 0, held > rao ? held - rao : 0);
    }

    /// @dev A validator's hotkey swap as `coldkey` sees it: `movedBps` of its root position on `from` moves to
    /// `to` (10_000 the whole position, 0 none: the old hotkey retains it; between them a split), exactly, and
    /// `to` is registered. Root only; unclaimed rewards stay where they are.
    function swapHotkey(bytes32 from, bytes32 to, bytes32 coldkey, uint256 movedBps) public {
        if (movedBps > 10_000) revert InvalidBps();
        knownHotkey[to] = true;
        uint256 held = _stake[from][coldkey][0];
        uint256 moved = held * movedBps / 10_000;
        _setStake(from, coldkey, 0, held - moved);
        _setStake(to, coldkey, 0, _stake[to][coldkey][0] + moved);
    }

    /// @dev A hotkey swap that also retains root rewards as credits on `from` (the runtime's
    /// HotkeySwapStakeRetained and HotkeySwapBasketCredits, as understood today): the position moves as in
    /// swapHotkey, and `creditRao` is added to what is owed to `coldkey` on `from`. The credits show in
    /// getUnclaimedRootTaoByHotkey(coldkey, from) and claimRootWithHotkey(from) pays them, as stake on `from`
    /// (setCreditsPayTo(true), the default) or as the caller's balance (false).
    function swapHotkeyWithCredits(bytes32 from, bytes32 to, bytes32 coldkey, uint256 movedBps, uint256 creditRao)
        external
    {
        swapHotkey(from, to, coldkey, movedBps);
        _unclaimed[coldkey][from] += creditRao;
    }

    /// @dev Where claimRootWithHotkey pays: true as stake on the claimed hotkey, false as balance (the same
    /// switch as setClaimToBalance, inverted).
    function setCreditsPayTo(bool toStakeOnFrom) external {
        claimToBalance = !toStakeOnFrom;
    }

    function rejectsGrowth(bytes32 coldkey) external view returns (bool) {
        return _rejectsGrowth[coldkey];
    }

    // ---- IStaking ----

    function addStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable {
        if (msg.value != 0) revert UnexpectedValue();
        if (!knownHotkey[hotkey]) revert UnknownHotkey();
        if (amount < _minStake()) revert BelowMinStake();
        uint256 cost = amount * RAO_TO_WEI;
        if (msg.sender.balance < cost) revert InsufficientBalance();
        _debit(msg.sender, cost);
        bytes32 cold = _cold(msg.sender);
        _credit(hotkey, cold, netuid, amount);
        if (addStakeCreditRao != 0) _setStake(hotkey, cold, netuid, _stake[hotkey][cold][netuid] + addStakeCreditRao);
    }

    function removeStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable {
        _enterRemoval(hotkey);
        bytes32 cold = _cold(msg.sender);
        uint256 staked = _stake[hotkey][cold][netuid];
        if (amount > staked) amount = staked;
        if (amount < _minStake() && amount != staked) revert AmountTooLow();
        uint256 remainder = staked - amount;
        uint256 removed = amount;
        if (remainder != 0 && remainder < _nominatorMin()) {
            removed = staked;
            remainder = 0;
        }
        _setStake(hotkey, cold, netuid, remainder);
        _payOutWei(_afterFeeWei(removed), !_removalsForced);
    }

    function removeStakeFull(bytes32 hotkey, uint256 netuid) external payable {
        _enterRemoval(hotkey);
        bytes32 cold = _cold(msg.sender);
        uint256 staked = _stake[hotkey][cold][netuid];
        _setStake(hotkey, cold, netuid, 0);
        _payOutWei(_afterFeeWei(staked), !_removalsForced);
    }

    function moveStake(
        bytes32 originHotkey,
        bytes32 destHotkey,
        uint256 originNetuid,
        uint256 destNetuid,
        uint256 amount
    ) external payable {
        // the hold gates move_stake from a held pair (spec §3.8)
        if (pairLocked[originHotkey]) revert RootStakeLocked();
        if (!knownHotkey[destHotkey]) revert UnknownHotkey();
        bytes32 cold = _cold(msg.sender);
        uint256 held = _stake[originHotkey][cold][originNetuid];
        if (amount > held) revert InsufficientStake();
        _setStake(originHotkey, cold, originNetuid, held - amount);
        _credit(destHotkey, cold, destNetuid, amount);
    }

    function _cold(address who) private view returns (bytes32 c) {
        c = coldkeyAlias[who];
        if (c == bytes32(0)) c = mirror(who);
    }

    function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) external view returns (uint256) {
        return _stake[hotkey][coldkey][netuid];
    }

    /// @dev The coldkey's stake on `netuid` across every hotkey, listed by the caller or not.
    function getTotalColdkeyStakeOnSubnet(bytes32 coldkey, uint256 netuid) external view returns (uint256) {
        _readGas();
        if (totalReadReverts) revert TotalReadReverted();
        if (totalReadBurnsGas) {
            assembly {
                invalid()
            }
        }
        return _total[coldkey][netuid];
    }

    function claimRootWithHotkey(bytes32 hotkey) external {
        if (gasleft() < _claimGas() || claimTooHeavy) {
            // Burns all forwarded gas, like a dispatch failure on the real precompile.
            assembly {
                invalid()
            }
        }
        bytes32 cold = _cold(msg.sender);
        uint256 amount = _unclaimed[cold][hotkey];
        _unclaimed[cold][hotkey] = 0;
        if (claimToBalance) _payOut(amount, _claimsByCall);
        else _setStake(hotkey, cold, 0, _stake[hotkey][cold][0] + amount);
        uint256 after_ = _stake[hotkey][cold][0];
        if (claimFallRao != 0) _setStake(hotkey, cold, 0, after_ > claimFallRao ? after_ - claimFallRao : 0);
    }

    /// @return taoValue 18-decimal (rao * 1e9)
    function getUnclaimedRootTaoByHotkey(bytes32 coldkey, bytes32 hotkey) external view returns (uint256 taoValue) {
        if (unclaimedReadReverts) revert UnclaimedReadReverted();
        return _unclaimed[coldkey][hotkey] * RAO_TO_WEI;
    }

    function setRejectStakingHotkeyGrowth(bool enabled) external {
        _rejectsGrowth[_cold(msg.sender)] = enabled;
    }

    function getDefaultMinStake() external view returns (uint256) {
        _readGas();
        return _minStake();
    }

    function getNominatorMinRequiredStake() external view returns (uint256) {
        _readGas();
        return _nominatorMin();
    }

    /// @dev ReadRefusedShortOfGas when given less than readGasFloor.
    function _readGas() private view {
        if (gasleft() < readGasFloor) revert ReadRefusedShortOfGas();
    }

    // ---- internals ----

    /// @dev A removal's entry: its two refusals, the unstake block (TooEarly) and a held pair (RootStakeLocked), each
    /// burning all the forwarded gas instead while burnRemoveGas is set; then, while recordRemovalGas is set, the
    /// gas it was given (read first, before anything else here runs); then, while removalKeepsGas is set, its gas
    /// burned down to that.
    function _enterRemoval(bytes32 hotkey) private {
        uint256 given = gasleft();
        bool held = pairLocked[hotkey];
        if (held || unstakeBlocked) {
            if (burnRemoveGas) {
                assembly {
                    invalid()
                }
            }
            if (held) revert RootStakeLocked();
            revert TooEarly();
        }
        if (recordRemovalGas) removalGas[hotkey] = given;
        uint256 keep = removalKeepsGas;
        while (keep != 0 && gasleft() > keep) {}
    }

    function _minStake() private view returns (uint256) {
        return minStakeOverride == 0 ? 2_000_000 : minStakeOverride;
    }

    function _nominatorMin() private view returns (uint256) {
        return nominatorMinOverride == 0 ? 20_000_000 : nominatorMinOverride;
    }

    function _claimGas() private view returns (uint256) {
        return claimGasOverride == 0 ? 53_200_000 : claimGasOverride;
    }

    /// @dev Any credit into an empty position lands one rao short unless exactStakeReads is set.
    function _credit(bytes32 hotkey, bytes32 coldkey, uint256 netuid, uint256 rao) private {
        uint256 current = _stake[hotkey][coldkey][netuid];
        _setStake(hotkey, coldkey, netuid, current + ((current == 0 && !exactStakeReads && rao != 0) ? rao - 1 : rao));
    }

    /// @dev Every write of a position, keeping the coldkey's total on the subnet.
    function _setStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid, uint256 value) private {
        _total[coldkey][netuid] = _total[coldkey][netuid] - _stake[hotkey][coldkey][netuid] + value;
        _stake[hotkey][coldkey][netuid] = value;
    }

    function _afterFee(uint256 rao) private view returns (uint256) {
        return rao > removeFeeRao ? rao - removeFeeRao : 0;
    }

    /// @dev A removal's credit of `rao`, in wei: less the rao fee, then less the wei fee, each floored at 0.
    function _afterFeeWei(uint256 rao) private view returns (uint256) {
        uint256 amount = _afterFee(rao) * RAO_TO_WEI;
        return amount > removeFeeWei ? amount - removeFeeWei : 0;
    }

    /// @dev Credits `rao` to the caller (_payOutWei of rao × 1e9 wei).
    function _payOut(uint256 rao, bool byCall) private {
        _payOutWei(rao * RAO_TO_WEI, byCall);
    }

    /// @dev Credits `amount` wei to the caller, by a call with value (`byCall`) or forced, either way a value transfer
    /// a revert undoes. The mock funds it from its own balance, raised first by vm.deal (which a revert does not undo,
    /// so the mock may keep wei of a reverted credit; nothing reads its balance). A forced credit creates a contract
    /// whose init code is `PUSH20 caller; SELFDESTRUCT`: the value moves to the caller and no code of the caller runs
    /// (EIP-6780: created and destroyed in one transaction, it leaves nothing behind). A zero credit moves nothing.
    function _payOutWei(uint256 amount, bool byCall) private {
        if (amount == 0) return;
        vm.deal(address(this), address(this).balance + amount);
        if (byCall) {
            (bool ok, bytes memory ret) = msg.sender.call{value: amount}("");
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }
            return;
        }
        bytes memory init = abi.encodePacked(hex"73", msg.sender, hex"ff");
        address created;
        assembly ("memory-safe") {
            created := create(amount, add(init, 32), mload(init))
        }
        if (created == address(0)) revert InsufficientBalance();
    }

    /// @dev addStake's debit: `amount` wei moved from `from` (the caller) to STAKED_TAO_SINK by a call with value made
    /// as `from` (a prank), so a revert undoes it; the prank's kind follows an outer test prank's, which forge would
    /// otherwise refuse to override.
    function _debit(address from, uint256 amount) private {
        if (amount == 0) return;
        (VmSafe.CallerMode mode,,) = vm.readCallers();
        bool recurrent = mode == VmSafe.CallerMode.RecurrentPrank;
        if (recurrent) vm.startPrank(from);
        else vm.prank(from);
        (bool ok,) = STAKED_TAO_SINK.call{value: amount}("");
        if (recurrent) vm.stopPrank();
        if (!ok) revert InsufficientBalance();
    }
}

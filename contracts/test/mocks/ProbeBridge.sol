// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ICascadeBridge} from "../../src/interfaces/ICascadeBridge.sol";
import {NotScheduled} from "../../src/CascadeErrors.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {ICascadeTwap} from "../../src/interfaces/ICascadeTwap.sol";

/// @notice A bridge that re-enters its caller's scheduler (Task 39a, I-25's re-entrant path). The vault and the front
/// door read a bridge's `maxMessageValue()` inside a setter: the vault's setMessageLimits and the front door's
/// setMaxBatchValue check their limit against the primary's cap, and setPrimaryBridge checks a new primary's. Made a
/// target's primary, this bridge is called there, inside `execute`'s self-call when the setter runs as a scheduled item
/// (the only external call a scheduled setter makes, spec §3.6), and from each owner's direct call. Each time it calls
/// back into its caller every function that only `execute` may reach: each `onlyScheduled` one (NotScheduled) and the
/// scheduled path of each owner setter with a loosening value (`onlyOwnerOrScheduled`: OwnableUnauthorizedAccount of
/// this bridge, the owner check that only `execute`'s own self-call passes), plus `schedule` and `execute`
/// themselves. Any other answer, a success included, means the re-entry got past its gate: the whole call then
/// reverts ReentryAdmitted(selector), which bubbles out of the target's call.
/// @dev `maxMessageValue` is a view, so the target reaches it by STATICCALL and the re-entries run in a static
/// context: one that passed its gate would revert at its first write, with no revert data, which is not the gate's
/// error either. As a plain bridge it quotes `fee`, accepts every send (a native one keeps its value) and holds `cap`.
contract ProbeBridge is ICascadeBridge {
    error ReentryAdmitted(bytes4 selector);

    address public immutable vault;
    address public immutable door;
    uint256 public fee;
    uint256 public cap = 5_000e18;
    uint256 public sends;

    constructor(address vault_, address door_) {
        vault = vault_;
        door = door_;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function quoteFee(uint64, address, bytes calldata, uint256) external view returns (uint256) {
        return fee;
    }

    function send(uint64, address, bytes calldata, uint256) external payable {
        ++sends;
    }

    /// Re-enters the caller (the vault or the front door; any other caller is not probed), then returns `cap`.
    function maxMessageValue() external view returns (uint256) {
        if (msg.sender == vault) _probeVault();
        else if (msg.sender == door) _probeDoor();
        return cap;
    }

    /// The vault's scheduled-only functions and its owner setters' scheduled path.
    function _probeVault() internal view {
        bytes[6] memory scheduledOnly = [
            abi.encodeCall(CascadeBase.setGuardian, (address(0xdead))),
            abi.encodeCall(CascadeBase.transferOwnership, (address(0xdead))),
            abi.encodeCall(CascadeBase.activateBridge, (address(0xdead))),
            abi.encodeCall(CascadeVault.activateFrontDoor, (uint64(77), address(0xdead))),
            abi.encodeCall(CascadeVault.moveStake, (bytes32(uint256(2)), bytes32(uint256(1)), 1)),
            abi.encodeCall(CascadeVault.writeOffMissingStake, (1))
        ];
        for (uint256 i; i < scheduledOnly.length; ++i) {
            _expect(vault, scheduledOnly[i], abi.encodeWithSelector(NotScheduled.selector));
        }
        // loosening values: each passes its setter's bounds, so only the gate refuses it
        bytes[11] memory ownerOnly = [
            abi.encodeCall(CascadeVault.setMaxTotalAssets, (type(uint256).max)),
            abi.encodeCall(CascadeVault.setOutflowLimits, (5_000, 100e18, 5_000)),
            abi.encodeCall(CascadeVault.setMessageLimits, (5_000e18, 5_000e18, 1)),
            abi.encodeCall(CascadeVault.setFeeLimits, (500, 0.015e18)),
            abi.encodeCall(CascadeVault.setPayoutDelay, (1 hours)),
            abi.encodeCall(CascadeVault.setRewardCut, (address(0xdead), 2_000)),
            abi.encodeCall(CascadeVault.setRewardVesting, (1 days)),
            abi.encodeCall(CascadeVault.setIdleBuffer, (0)),
            abi.encodeCall(CascadeVault.setStakeHotkey, (bytes32(uint256(2)))),
            abi.encodeCall(CascadeBase.schedule, (abi.encodeCall(CascadeBase.setGuardian, (address(0xdead))))),
            abi.encodeCall(CascadeBase.execute, (abi.encodeCall(CascadeBase.setGuardian, (address(0xdead)))))
        ];
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this));
        for (uint256 i; i < ownerOnly.length; ++i) {
            _expect(vault, ownerOnly[i], notOwner);
        }
    }

    /// The front door's scheduled-only functions and its owner setters' scheduled path.
    function _probeDoor() internal view {
        bytes[5] memory scheduledOnly = [
            abi.encodeCall(CascadeBase.setGuardian, (address(0xdead))),
            abi.encodeCall(CascadeBase.transferOwnership, (address(0xdead))),
            abi.encodeCall(CascadeBase.activateBridge, (address(0xdead))),
            abi.encodeCall(CascadeFrontDoor.setOracle, (ICascadeTwap(address(0xdead)))),
            abi.encodeCall(CascadeFrontDoor.setSwapper, (address(0xdead)))
        ];
        for (uint256 i; i < scheduledOnly.length; ++i) {
            _expect(door, scheduledOnly[i], abi.encodeWithSelector(NotScheduled.selector));
        }
        bytes[6] memory ownerOnly = [
            abi.encodeCall(CascadeFrontDoor.setMaxDeliverySlippage, (300)),
            abi.encodeCall(CascadeFrontDoor.setBatchInterval, (0)),
            abi.encodeCall(CascadeFrontDoor.setMaxBatchValue, (5_000e18)),
            abi.encodeCall(CascadeFrontDoor.setMinPoolLiquidity, (0, 0)),
            abi.encodeCall(CascadeBase.schedule, (abi.encodeCall(CascadeBase.setGuardian, (address(0xdead))))),
            abi.encodeCall(CascadeBase.execute, (abi.encodeCall(CascadeBase.setGuardian, (address(0xdead)))))
        ];
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this));
        for (uint256 i; i < ownerOnly.length; ++i) {
            _expect(door, ownerOnly[i], notOwner);
        }
    }

    /// ReentryAdmitted unless `data` on `target` reverts with exactly `refusal`.
    function _expect(address target, bytes memory data, bytes memory refusal) internal view {
        (bool ok, bytes memory ret) = target.staticcall(data);
        if (ok || keccak256(ret) != keccak256(refusal)) revert ReentryAdmitted(bytes4(data));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {ICascadeReceiver} from "../../src/interfaces/ICascadeBridge.sol";
import {IStaking} from "../../src/interfaces/IStaking.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";

// Task 61's gas probes, for the adapter calibration (`AdapterGas.t.sol`) and the fork rehearsal
// (`BittensorForkV32.t.sol`): a stand-in for the staking precompile that can eat gas inside an `addStake`, a holder whose
// `receive` can eat gas, and a recipient that burns all it is given. Each eater measures how much gas an exit still had
// spare after its walk: the most it can burn with the exit still completing is the reserve's margin over the exit's own
// work after the walk (spec §3.8, EXIT_GAS_RESERVE).

// The slot of StakingTap's eat amount, beside MockStaking's own storage at the precompile's address (far from its
// sequential slots).
bytes32 constant TAP_EAT_SLOT = keccak256("cascade.t61a.StakingTap.eat");
// The slot where StakingTap writes the gas a removal had left when it returned (its unused gas).
bytes32 constant TAP_REMOVAL_LEFT_SLOT = keccak256("cascade.t61a.StakingTap.removalLeft");
// The slot of a selector StakingTap fails by burning all the gas it is given (an invalid opcode), as a precompile's
// dispatch failure would; 0 for none.
bytes32 constant TAP_BURN_SELECTOR_SLOT = keccak256("cascade.t61a.StakingTap.burnSelector");

/// @notice Etched at the staking precompile's address over MockStaking's state: every call runs MockStaking's code
/// (`impl`, by DELEGATECALL, so the state stays at the precompile's address and its cheatcodes run from there), except
/// that an `addStake` first burns exactly the gas stored at TAP_EAT_SLOT (all it has, and fails, when that is more), a
/// call of the selector at TAP_BURN_SELECTOR_SLOT burns all it is given, and a removal that goes through writes the gas
/// it has left at TAP_REMOVAL_LEFT_SLOT just before it returns. The DELEGATECALL and the selector's read cost each call
/// a few hundred gas more than MockStaking etched alone, so the tap is used only where an eater is: it counts against
/// the exit, never for it.
contract StakingTap {
    address public immutable impl;

    constructor(address impl_) {
        impl = impl_;
    }

    fallback() external payable {
        bytes4 sig = msg.sig;
        bytes32 burnSlot = TAP_BURN_SELECTOR_SLOT;
        bytes4 burn;
        assembly ("memory-safe") {
            burn := sload(burnSlot)
        }
        if (burn != bytes4(0) && sig == burn) {
            assembly ("memory-safe") {
                invalid()
            }
        }
        if (sig == IStaking.addStake.selector) _eat();
        (bool ok, bytes memory ret) = impl.delegatecall(msg.data);
        if (ok && (sig == IStaking.removeStake.selector || sig == IStaking.removeStakeFull.selector)) {
            bytes32 slot = TAP_REMOVAL_LEFT_SLOT;
            assembly ("memory-safe") {
                sstore(slot, gas())
            }
        }
        assembly ("memory-safe") {
            switch ok
            case 0 { revert(add(ret, 32), mload(ret)) }
            default { return(add(ret, 32), mload(ret)) }
        }
    }

    function _eat() private view {
        bytes32 slot = TAP_EAT_SLOT;
        uint256 eat;
        assembly ("memory-safe") {
            eat := sload(slot)
        }
        burnGas(eat);
    }
}

/// Burns exactly `amount` gas, or all of it (an invalid opcode) when less than that is left.
function burnGas(uint256 amount) view {
    if (amount == 0) return;
    uint256 g = gasleft();
    if (amount >= g) {
        assembly ("memory-safe") {
            invalid()
        }
    }
    uint256 stop = g - amount;
    while (gasleft() > stop) {}
}

/// @notice A direct holder of the vault whose `receive` burns `eat` gas: redeemDirect pays it last, after the walk, so
/// the most it can burn with the exit still completing is the walk's reserve's margin over redeemDirect's own work after
/// it.
contract EatingHolder {
    uint256 public eat;

    function setEat(uint256 amount) external {
        eat = amount;
    }

    function deposit(CascadeVault vault) external payable {
        vault.depositDirect{value: msg.value}();
    }

    function redeem(CascadeVault vault, uint256 shares) external {
        vault.redeemDirect(shares, false);
    }

    receive() external payable {
        burnGas(eat);
    }
}

/// @notice Cold runs for a bisection. A test is one transaction to the EVM; vm.revertToState brings back the warm and
/// cold state as it was at the snapshot (measured: a 1+1 delivery costs the same 502,117 gas fresh and after a revert),
/// so a bisection from a snapshot taken before anything was touched runs cold every time. What was touched before the
/// snapshot stays warm: `cool` marks those accounts' storage slots cold again (vm.cool), but not the accounts
/// themselves (measured: a second balanceOf after vm.cool pays the cold slot, 2,100, and the warm account, 100), so a
/// run misses 2,500 for each such account it touches: `ACCOUNT_SURCHARGE` each, which a bisection adds to what it found
/// (or takes off a margin). (vm.startStateDiffRecording is not used: a run recorded with it, and every run after it,
/// reverted or not, was charged as if warm, 371,317 for the same delivery.)
abstract contract ColdRuns {
    Vm private constant VM_COLD = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant ACCOUNT_SURCHARGE = 2_500;

    function cool(address[] memory t) internal {
        for (uint256 i; i < t.length; ++i) {
            VM_COLD.cool(t[i]);
        }
    }

    /// The gas the last call's own frame had left when it ended (vm.lastCallGas's gasRemaining), read from the
    /// cheatcode's first five words: this forge returns five, the forge-std struct declares six.
    function lastFrameRemaining() internal view returns (uint256 remaining) {
        (bool ok, bytes memory ret) = address(VM_COLD).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok && ret.length >= 160, "lastCallGas");
        (,,,, remaining) = abi.decode(ret, (uint256, uint256, uint256, uint256, uint256));
    }
}

/// @notice A recipient that consumes every unit of gas it is given (an invalid opcode), as a vault that runs out of gas
/// would: the adapter's park after it is written from PARK_GAS_RESERVE alone.
contract BurningRecipient is ICascadeReceiver {
    function onBridgeMessage(uint64, address, bytes calldata, uint256) external payable {
        assembly ("memory-safe") {
            invalid()
        }
    }
}

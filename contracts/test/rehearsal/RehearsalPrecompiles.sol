// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Bittensor's balance-transfer precompile: sends msg.value to an SS58 public key.
address constant BALANCE_TRANSFER_ADDRESS = 0x0000000000000000000000000000000000000800;

/// @notice Stand-ins for Bittensor's precompiles on a local anvil fork, which has none. The ops
/// rehearsal installs their runtime code at the precompile addresses with `anvil_setCode`. They only
/// cover what deploying and configuring the vault touches; nothing here runs on a real chain.

/// Rehearsal mapping: an address's "coldkey" is the address itself, zero-padded, so the transfer
/// stand-in can turn it back into an address. The real chain uses blake2b-256("evm:" ++ address).
contract RehearsalAddressMapping {
    function addressMapping(address addr) external pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }
}

/// Reads answer like an empty root position under the live floors; writes are refused.
contract RehearsalStaking {
    function setRejectStakingHotkeyGrowth(bool) external {}

    function getStake(bytes32, bytes32, uint256) external pure returns (uint256) {
        return 0;
    }

    function getDefaultMinStake() external pure returns (uint256) {
        return 2_000_000;
    }

    function getNominatorMinRequiredStake() external pure returns (uint256) {
        return 20_000_000;
    }

    function addStake(bytes32, uint256, uint256) external payable {
        revert("rehearsal: no staking");
    }

    function removeStake(bytes32, uint256, uint256) external payable {
        revert("rehearsal: no staking");
    }

    function removeStakeFull(bytes32, uint256) external payable {
        revert("rehearsal: no staking");
    }
}

/// Like the real precompile, credits the destination without running its code (the vault refuses
/// plain transfers): a throwaway contract self-destructs to it, which moves the balance only.
contract RehearsalBalanceTransfer {
    function transfer(bytes32 data) external payable {
        new ForceSend{value: msg.value}(payable(address(uint160(uint256(data)))));
    }
}

contract ForceSend {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}

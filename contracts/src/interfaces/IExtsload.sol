// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice What a lens calls on its target (CascadeBase's, on the vault and the front door): extsload, one
/// storage slot's raw word, as a view; and MS_PER_BLOCK, an immutable, which no slot holds.
interface IExtsload {
    function extsload(bytes32 slot) external view returns (bytes32);

    // forge-lint: disable-next-line(mixed-case-function)
    function MS_PER_BLOCK() external view returns (uint64);
}

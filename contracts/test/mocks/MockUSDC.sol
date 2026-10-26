// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Mintable stand-in for Base USDC: 6 decimals, EIP-2612 permit under USDC's own domain
/// ("USD Coin", version "2"), and one settable blocked address that can receive nothing (USDC's
/// blacklist, or a recipient that refuses tokens).
/// @dev OpenZeppelin's ERC20Permit fixes the domain version at "1"; the domain separator and the
/// ERC-5267 description are re-pointed at "2" so signatures match the real token's.
contract MockUSDC is ERC20Permit {
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    address public blocked;

    error RecipientBlocked(address recipient);

    constructor() ERC20("USD Coin", "USDC") ERC20Permit("USD Coin") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// address(0) blocks no one.
    function setBlocked(address account) external {
        blocked = account;
    }

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view override returns (bytes32) {
        return _usdcDomainSeparator();
    }

    function eip712Domain()
        public
        view
        override
        returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory)
    {
        return (hex"0f", "USD Coin", "2", block.chainid, address(this), bytes32(0), new uint256[](0));
    }

    function _hashTypedDataV4(bytes32 structHash) internal view override returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(_usdcDomainSeparator(), structHash);
    }

    function _usdcDomainSeparator() private view returns (bytes32) {
        return
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("USD Coin"), keccak256("2"), block.chainid, address(this)));
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to != address(0) && to == blocked) revert RecipientBlocked(to);
        super._update(from, to, value);
    }
}

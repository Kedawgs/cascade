// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract MockUSDCTest is Test {
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    MockUSDC usdc;

    function setUp() public {
        usdc = new MockUSDC();
    }

    function test_metadataAndUsdcDomain() public view {
        assertEq(usdc.name(), "USD Coin");
        assertEq(usdc.symbol(), "USDC");
        assertEq(usdc.decimals(), 6);
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USD Coin"),
                keccak256("2"),
                block.chainid,
                address(usdc)
            )
        );
        assertEq(usdc.DOMAIN_SEPARATOR(), expected);
        (, string memory name, string memory version,,,,) = usdc.eip712Domain();
        assertEq(name, "USD Coin");
        assertEq(version, "2");
    }

    /// A permit signed over USDC's real domain (version "2") is accepted once.
    function test_permitUnderVersion2() public {
        (address holder, uint256 key) = makeAddrAndKey("holder");
        address spender = makeAddr("spender");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, holder, spender, 5e6, 0, deadline))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        usdc.permit(holder, spender, 5e6, deadline, v, r, s);
        assertEq(usdc.allowance(holder, spender), 5e6);
        assertEq(usdc.nonces(holder), 1);

        vm.expectRevert();
        usdc.permit(holder, spender, 5e6, deadline, v, r, s);
    }

    function test_blockedRecipientReceivesNothing() public {
        address alice = makeAddr("alice");
        usdc.mint(address(this), 10e6);
        usdc.setBlocked(alice);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.RecipientBlocked.selector, alice));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        usdc.transfer(alice, 1e6);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.RecipientBlocked.selector, alice));
        usdc.mint(alice, 1e6);

        usdc.setBlocked(address(0));
        assertTrue(usdc.transfer(alice, 1e6));
        assertEq(usdc.balanceOf(alice), 1e6);
    }
}

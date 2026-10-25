// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {ADDRESS_MAPPING_ADDRESS, IAddressMapping} from "../../src/interfaces/IAddressMapping.sol";
import {ISTAKING_ADDRESS, IStaking} from "../../src/interfaces/IStaking.sol";
import {StubBridge} from "../mocks/StubBridge.sol";
import {
    BALANCE_TRANSFER_ADDRESS,
    RehearsalAddressMapping,
    RehearsalBalanceTransfer,
    RehearsalStaking
} from "./RehearsalPrecompiles.sol";

/// @notice The stand-ins the ops rehearsal installs on a local Bittensor fork, at the precompile addresses.
contract RehearsalPrecompilesTest is Test {
    address constant WALLET = 0x770932787DD3bcE64f14E31f4746bCe22E214fFF;
    bytes32 constant HK = bytes32(uint256(0x58));

    function setUp() public {
        vm.etch(ADDRESS_MAPPING_ADDRESS, address(new RehearsalAddressMapping()).code);
        vm.etch(ISTAKING_ADDRESS, address(new RehearsalStaking()).code);
        vm.etch(BALANCE_TRANSFER_ADDRESS, address(new RehearsalBalanceTransfer()).code);
    }

    function newVault() internal returns (CascadeVault) {
        StubBridge bridge = new StubBridge(IERC20(address(0)));
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        bytes32 coldkey = IAddressMapping(ADDRESS_MAPPING_ADDRESS).addressMapping(predicted);
        return new CascadeVault(coldkey, HK, bridge, WALLET, WALLET, 1e16, 8453, makeAddr("frontDoor"));
    }

    function test_mappingPadsTheAddress() public view {
        assertEq(IAddressMapping(ADDRESS_MAPPING_ADDRESS).addressMapping(WALLET), bytes32(uint256(uint160(WALLET))));
    }

    function test_vaultDeploysOnTheStandIns() public {
        CascadeVault vault = newVault();
        assertEq(vault.coldkey(), bytes32(uint256(uint160(address(vault)))));
    }

    function test_transferForcesBalanceIntoAVaultThatRefusesPlainTransfers() public {
        CascadeVault vault = newVault();
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(vault).call{value: 1}("");
        assertFalse(ok);

        uint256 before = address(vault).balance;
        RehearsalBalanceTransfer(BALANCE_TRANSFER_ADDRESS).transfer{value: 1.5e12}(vault.coldkey());
        assertEq(address(vault).balance - before, 1.5e12);
    }

    function test_stakingReadsAndRefusesWrites() public {
        IStaking s = IStaking(ISTAKING_ADDRESS);
        assertEq(s.getDefaultMinStake(), 2_000_000);
        assertEq(s.getNominatorMinRequiredStake(), 20_000_000);
        assertEq(s.getStake(HK, bytes32(uint256(1)), 0), 0);
        s.setRejectStakingHotkeyGrowth(true);
        vm.expectRevert(bytes("rehearsal: no staking"));
        s.addStake(HK, 1, 0);
    }
}

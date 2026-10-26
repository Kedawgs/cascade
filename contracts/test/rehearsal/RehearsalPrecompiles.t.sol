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

        RehearsalBalanceTransfer(BALANCE_TRANSFER_ADDRESS).transfer{value: 1.5e12}(vault.coldkey());
        assertEq(address(vault).balance, 1e12, "an empty account reads 500 rao below what was sent");
        RehearsalBalanceTransfer(BALANCE_TRANSFER_ADDRESS).transfer{value: 1e12}(vault.coldkey());
        assertEq(address(vault).balance, 2e12, "later transfers are credited in full");
        vm.expectRevert(bytes("rehearsal: below the existential deposit"));
        RehearsalBalanceTransfer(BALANCE_TRANSFER_ADDRESS).transfer{value: 500e9}(bytes32(uint256(0xE0A)));
    }

    /// The reserve reads exactly ED_RESERVE, so the first deposit mints at the launch price (1e6 share
    /// units per wei), as on the real chain.
    function test_aReservedVaultMintsTheFirstDepositAtTheLaunchPrice() public {
        CascadeVault vault = newVault();
        vm.deal(address(this), 1 ether);
        RehearsalBalanceTransfer(BALANCE_TRANSFER_ADDRESS).transfer{value: 1.5e12}(vault.coldkey());
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.price(), 1e12, "1 wei per 1e6 shares, scaled by 1e18");
    }

    function test_stakingReads() public {
        IStaking s = IStaking(ISTAKING_ADDRESS);
        assertEq(s.getDefaultMinStake(), 2_000_000);
        assertEq(s.getNominatorMinRequiredStake(), 20_000_000);
        assertEq(s.getStake(HK, bytes32(uint256(1)), 0), 0);
        assertEq(s.getUnclaimedRootTaoByHotkey(bytes32(uint256(1)), HK), 0);
        s.setRejectStakingHotkeyGrowth(true);
    }

    /// The stand-in cannot debit its caller on anvil: it records the stake and emits Debit for the
    /// rehearsal to settle, here with vm.deal as the rehearsal does with anvil_setBalance.
    function test_vaultStakesAndTheDebitIsLeftToSettle() public {
        CascadeVault vault = newVault();
        vm.prank(WALLET);
        vault.setKeeper(WALLET);
        vm.deal(address(vault), 1e12 + 1e17);

        vm.expectEmit(true, false, false, true, ISTAKING_ADDRESS);
        emit RehearsalStaking.Debit(address(vault), 1e17);
        vm.prank(WALLET);
        vault.stakeIdle();
        assertEq(vault.rootStakeRao(), 1e8, "stake recorded on the vault's coldkey");
        assertEq(address(vault).balance, 1e12 + 1e17, "balance untouched until the rehearsal settles");
    }

    function test_addStakeRefusesValueTheMinimumAndAShortBalance() public {
        IStaking s = IStaking(ISTAKING_ADDRESS);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(bytes("rehearsal: addStake takes no value"));
        s.addStake{value: 1}(HK, 2_000_000, 0);
        vm.expectRevert(bytes("rehearsal: below the minimum stake"));
        s.addStake(HK, 1_999_999, 0);
        vm.expectRevert(bytes("rehearsal: balance too low"));
        s.addStake(HK, 2e9, 0);
    }

    function test_unstakePaysFromItsOwnBalanceByForcedSend() public {
        CascadeVault vault = newVault();
        vm.prank(WALLET);
        vault.setKeeper(WALLET);
        vm.deal(address(vault), 1e12 + 1e17);
        vm.prank(WALLET);
        vault.stakeIdle();
        vm.deal(address(vault), 1e12); // the rehearsal's settlement
        vm.deal(ISTAKING_ADDRESS, 1 ether);

        // a redeem pays out of stake: the vault unstakes through the stand-in, which force-sends
        vm.prank(address(vault));
        IStaking(ISTAKING_ADDRESS).removeStakeFull(HK, 0);
        assertEq(address(vault).balance, 1e12 + 1e17, "paid into a vault that refuses plain transfers");
        assertEq(ISTAKING_ADDRESS.balance, 1 ether - 1e17);
        assertEq(vault.rootStakeRao(), 0);
    }

    function test_removeStakeTakesThePositionWhenLessThanTheNominatorMinimumWouldRemain() public {
        RehearsalStaking s = RehearsalStaking(ISTAKING_ADDRESS);
        bytes32 cold = bytes32(uint256(0xC01D));
        address av = makeAddr("alphaVault");
        s.setColdkeyAlias(av, cold);
        s.seedStake(HK, cold, 0, 30_000_000);
        vm.deal(ISTAKING_ADDRESS, 1 ether);

        vm.prank(av);
        s.removeStake(HK, 5_000_000, 0);
        assertEq(s.getStake(HK, cold, 0), 25_000_000, "under its alias");
        assertEq(av.balance, 5e15);

        vm.prank(av);
        s.removeStake(HK, 10_000_000, 0);
        assertEq(s.getStake(HK, cold, 0), 0, "15,000,000 rao would remain, below the nominator minimum");
        assertEq(av.balance, 5e15 + 25e15);
    }
}

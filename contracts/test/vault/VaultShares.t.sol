// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {CascadeShares, burnShares, mintShares} from "../../src/CascadeShares.sol";
import {ERC20InsufficientBalance, NonTransferable} from "../../src/CascadeErrors.sol";
import {Transfer} from "../../src/CascadeEvents.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {Schedule} from "../governance/Schedule.sol";

/// The share token alone, with the shared mint and burn helpers exposed.
contract SharesHarness is CascadeShares {
    function mint(address to, uint256 amount) external {
        mintShares(_shares, to, amount);
    }

    function burn(address from, uint256 amount) external {
        burnShares(_shares, from, amount);
    }
}

/// @notice The minimal non-transferable share token (spec §8.1) that replaces OpenZeppelin's ERC20:
/// its metadata, its reverting transfer surface, its Transfer events, its place in the vault's
/// storage, and I-34 at unit level.
contract VaultSharesTest is VaultTestBase {
    address treasury = makeAddr("treasury");

    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
    }

    function test_metadata() public view {
        assertEq(vault.name(), "Cascade Staked TAO");
        assertEq(vault.symbol(), "csTAO");
        assertEq(vault.decimals(), 24);
    }

    function test_transfersRevertAllowanceIsZero() public {
        depositDirect(alice, 10e18);

        vm.startPrank(alice);
        vm.expectRevert(NonTransferable.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vault.transfer(bob, 1);
        vm.expectRevert(NonTransferable.selector);
        vault.approve(bob, 1);
        vm.expectRevert(NonTransferable.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vault.transferFrom(alice, bob, 1);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(NonTransferable.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vault.transferFrom(alice, bob, 1);

        assertEq(vault.allowance(alice, bob), 0);
        assertEq(vault.allowance(alice, alice), 0);
        assertEq(vault.balanceOf(alice), 1e25);
        assertEq(vault.balanceOf(bob), 0);
        assertEq(vault.totalSupply(), 1e25);
    }

    function test_mintAndBurnEmitTransferFromAndToZero() public {
        // the shared helpers on their own
        SharesHarness h = new SharesHarness();
        vm.expectEmit(address(h));
        emit Transfer(address(0), alice, 5);
        h.mint(alice, 5);
        vm.expectEmit(address(h));
        emit Transfer(address(0), bob, 7);
        h.mint(bob, 7);
        assertEq(h.balanceOf(alice), 5);
        assertEq(h.balanceOf(bob), 7);
        assertEq(h.totalSupply(), 12);

        vm.expectEmit(address(h));
        emit Transfer(alice, address(0), 3);
        h.burn(alice, 3);
        assertEq(h.balanceOf(alice), 2);
        assertEq(h.totalSupply(), 9);

        // a short balance reverts with OpenZeppelin's error, as v3.1's _burn did
        vm.expectRevert(abi.encodeWithSelector(ERC20InsufficientBalance.selector, alice, 2, 3));
        h.burn(alice, 3);
        // zero amounts still emit, as OpenZeppelin's did (a cancel re-mints a bounce's 0 shares)
        vm.expectEmit(address(h));
        emit Transfer(address(0), carol, 0);
        h.mint(carol, 0);
        vm.expectEmit(address(h));
        emit Transfer(carol, address(0), 0);
        h.burn(carol, 0);
        assertEq(h.totalSupply(), 9);

        // through the vault: a direct deposit mints from zero, a direct redeem burns to zero
        vm.deal(alice, 10e18);
        vm.expectEmit(address(vault));
        emit Transfer(address(0), alice, 1e25);
        vm.prank(alice);
        vault.depositDirect{value: 10e18}();
        vm.expectEmit(address(vault));
        emit Transfer(alice, address(0), 1e24);
        vm.prank(alice);
        vault.redeemDirect(1e24, false);

        // a direct redeem above the balance reverts in the burn
        vm.expectRevert(abi.encodeWithSelector(ERC20InsufficientBalance.selector, alice, 9e24, 9e24 + 1));
        vm.prank(alice);
        vault.redeemDirect(9e24 + 1, false);
    }

    /// The token comes first in the vault's inheritance, so SharesData takes slots 0 (totalSupply) and
    /// 1 (balanceOf) and CascadeBase's guardian sits at slot 5 (spec §8.1).
    function test_sharesTakeTheVaultsFirstSlots() public {
        depositDirect(alice, 10e18);
        depositDirect(bob, 5e18);
        assertEq(uint256(vm.load(address(vault), bytes32(uint256(0)))), vault.totalSupply());
        assertEq(uint256(vm.load(address(vault), keccak256(abi.encode(alice, uint256(1))))), 1e25);
        assertEq(uint256(vm.load(address(vault), keccak256(abi.encode(bob, uint256(1))))), 5e24);
        assertEq(address(uint160(uint256(vm.load(address(vault), bytes32(uint256(5)))))), guardian);
    }

    /// I-34 at unit level: across a direct deposit, a batch mint, a reward cut, a batch redeem, a direct
    /// redeem and a cancel's re-mint, each account's Transfer mints less burns equal its balanceOf, and
    /// their sum equals totalSupply. No Transfer moves shares between two accounts.
    function test_tokenAccountingPerAccount() public {
        // the treasury's cut, named and raised from none (a loosening): a scheduled item (Task 11), run first
        Schedule.run(vault, owner, abi.encodeCall(CascadeVault.setRewardCut, (treasury, 1_000)));
        vm.recordLogs();

        // a direct deposit and a batch mint
        depositDirect(alice, 10e18);
        depositVia(bob, 100e18);
        vm.prank(keeper);
        vault.stakeIdle();

        // a reward cut minted to the treasury
        staking.setUnclaimed(vaultLens.coldkey(), HK1, 10_000_000_000);
        vm.prank(keeper);
        vault.claimRewards{gas: 60_000_000}(HK1);
        assertGt(vault.balanceOf(treasury), 0, "cut minted");

        // a batch redeem (bob) and a direct redeem (alice)
        uint256 bobRedeem = vault.balanceOf(bob) / 4;
        bytes32 key = deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(bob, bobRedeem));
        uint256 queued = vaultLens.getPayoutBatch(key).remaining;
        assertGt(queued, 0, "redeem queued");
        uint256 aliceRedeem = vault.balanceOf(alice) / 2;
        vm.prank(alice);
        vault.redeemDirect(aliceRedeem, false);

        // the owner cancels bob's batch: his shares are re-minted
        CascadeMessages.Payout[] memory list = new CascadeMessages.Payout[](1);
        list[0] = CascadeMessages.Payout(bob, bobRedeem, queued);
        vm.prank(owner);
        vault.cancelPayoutBatch(key, list);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        address[] memory accounts = new address[](logs.length);
        int256[] memory net = new int256[](logs.length);
        uint256 n;
        uint256 transfers;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault) || logs[i].topics[0] != Transfer.selector) continue;
            ++transfers;
            address from = address(uint160(uint256(logs[i].topics[1])));
            address to = address(uint160(uint256(logs[i].topics[2])));
            int256 value = int256(abi.decode(logs[i].data, (uint256)));
            assertTrue((from == address(0)) != (to == address(0)), "a mint or a burn, never a transfer");
            address who = from == address(0) ? to : from;
            uint256 j;
            while (j < n && accounts[j] != who) {
                ++j;
            }
            if (j == n) accounts[n++] = who;
            net[j] += from == address(0) ? value : -value;
        }
        // alice's mint and burn, bob's mint, burn and re-mint, the treasury's mint
        assertEq(transfers, 6, "Transfer events");
        assertEq(n, 3, "accounts");

        uint256 sum;
        for (uint256 j; j < n; ++j) {
            assertGe(net[j], 0);
            assertEq(uint256(net[j]), vault.balanceOf(accounts[j]), "mints less burns = balanceOf");
            sum += uint256(net[j]);
        }
        assertEq(sum, vault.totalSupply(), "sum = totalSupply");
        assertEq(vault.balanceOf(bob) + vault.balanceOf(alice) + vault.balanceOf(treasury), vault.totalSupply());
    }
}

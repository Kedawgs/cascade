// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Vm} from "forge-std/Vm.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {HotkeyHasRewards, NotAuthorized} from "../../src/CascadeErrors.sol";
import {HotkeyRemoved, Staked, Unstaked} from "../../src/CascadeEvents.sol";

/// Checkpoint R2's fix round: the vault's behaviour each item changed, beside the suites of the code it touched. In
/// its own file: VaultCore.t.sol sits at via-IR's jump-tag limit.
///   - F1: removeHotkey's read of the unclaimed rewards is an optional read (spec §3.1): should it fail, the owner's
///     forfeit still removes (and logs 0 unclaimed), and every other path refuses as if the rewards were above the
///     dust.
///   - F2: a walk's Unstaked logs the rao the removal took off the position: the whole position on a full removal,
///     the request otherwise.
///   - F3: stakeIdle books at most what it staked: a chain-side credit landing inside addStake stays a surplus, which
///     only adoptStake books (vested, with no cut).
contract VaultR2Test is VaultTestBase {
    bytes32 constant HK6 = bytes32(uint256(6));
    uint256 constant RAO = 1e9;
    address stranger = makeAddr("stranger");

    /// Exact stake reads (no one-rao-short fresh position), and a sixth hotkey the chain knows.
    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
        staking.addHotkey(HK6);
    }

    // ---- helpers ----

    function coldkey() internal view returns (bytes32) {
        return vaultLens.coldkey();
    }

    function stakeOf(bytes32 h) internal view returns (uint256) {
        return staking.getStake(h, coldkey(), 0);
    }

    /// `amount` wei deposited directly by alice and staked by the keeper on the stake hotkey (HK1).
    function fund(uint256 amount) internal {
        depositDirect(alice, amount);
        vm.prank(keeper);
        vault.stakeIdle();
    }

    /// The chain moves `rao` of the vault's root position from `from` to `to`: a validator's hotkey swap when `to`
    /// is not listed.
    function chainMoves(bytes32 from, bytes32 to, uint256 rao) internal {
        vm.prank(address(vault));
        staking.moveStake(from, to, 0, 0, rao);
    }

    function refusedRemove(address who, bytes32 h, bool forfeit, bytes4 err) internal {
        vm.prank(who);
        vm.expectRevert(err);
        vault.removeHotkey(h, forfeit);
    }

    /// The (wantRao, receivedWei) of the vault's Unstaked log for `h` in `logs`.
    function unstakedOf(Vm.Log[] memory logs, bytes32 h) internal view returns (uint256 wantRao, uint256 receivedWei) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == Unstaked.selector && logs[i].topics[1] == h) {
                return abi.decode(logs[i].data, (uint256, uint256));
            }
        }
        revert("no Unstaked for the hotkey");
    }

    /// The set full and stake missing, with two empty hotkeys and nothing unclaimed (I-6's case for a stranger's
    /// removal): HK2 and HK3 listed beside HK1, a first swap's hotkey (HK5) listed into the last slot, then a second
    /// swap onto HK6, which no slot is free for.
    function fullAndMissing() internal {
        fund(10e18);
        vm.startPrank(owner);
        vault.addHotkey(HK2);
        vault.addHotkey(HK3);
        vm.stopPrank();
        chainMoves(HK1, HK5, 4_000_000_000);
        vm.prank(stranger);
        vault.addHotkey(HK5);
        chainMoves(HK1, HK6, 4_000_000_000);
        assertEq(vaultLens.hotkeyCount(), 4);
        assertTrue(vaultLens.stakeMissing());
    }

    // ---- F1: the unclaimed-rewards read is optional ----

    /// With the precompile's read reverting (a function gone): the stranger's, the keeper's and the guardian's
    /// removals of an empty hotkey refuse (NotAuthorized, as for rewards above the dust), and so does the owner's
    /// without forfeit (HotkeyHasRewards); the owner's forfeit removes it and logs 0 unclaimed, which frees the slot
    /// the second swap's hotkey needs. With the read back, a stranger's removal runs as before.
    function test_F1_aFailedUnclaimedReadLeavesTheOwnersForfeit() public {
        fullAndMissing();
        staking.setUnclaimedReadReverts(true);

        refusedRemove(stranger, HK2, false, NotAuthorized.selector);
        refusedRemove(stranger, HK2, true, NotAuthorized.selector);
        refusedRemove(keeper, HK2, false, NotAuthorized.selector);
        refusedRemove(guardian, HK2, true, NotAuthorized.selector);
        refusedRemove(owner, HK2, false, HotkeyHasRewards.selector);
        assertTrue(vaultLens.isHotkey(HK2), "nothing removed");

        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK2, 0, true);
        vm.prank(owner);
        vault.removeHotkey(HK2, true);
        assertFalse(vaultLens.isHotkey(HK2));
        assertEq(vaultLens.hotkeyCount(), 3);
        // the freed slot takes the second swap's hotkey, by anyone: the way back
        vm.prank(stranger);
        vault.addHotkey(HK6);
        assertFalse(vaultLens.stakeMissing());

        // with the read working, nothing changed: the stranger's removal of an empty hotkey, full and missing
        staking.setUnclaimedReadReverts(false);
        chainMoves(HK1, HK4, 1_000_000_000);
        assertTrue(vaultLens.stakeMissing());
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK3, 0, false);
        vm.prank(stranger);
        vault.removeHotkey(HK3, false);
    }

    /// The stake checks come first, as before: with the read reverting, a keeper's removal of a hotkey with stake is
    /// refused for the stake, and the owner's forfeit moves the stake to the stake hotkey and removes it, logging 0.
    function test_F1_theOwnersForfeitMovesTheLeftoverWithTheReadFailed() public {
        fund(10e18);
        vm.prank(owner);
        vault.addHotkey(HK2);
        chainMoves(HK1, HK2, 3_000_000_000);
        staking.setUnclaimed(coldkey(), HK2, 5);
        staking.setUnclaimedReadReverts(true);

        refusedRemove(keeper, HK2, true, NotAuthorized.selector);
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK2, 0, true);
        vm.prank(owner);
        vault.removeHotkey(HK2, true);
        assertEq(stakeOf(HK2), 0);
        assertEq(stakeOf(HK1), 10_000_000_000, "the leftover moved to the stake hotkey");
        assertEq(vaultLens.bookedStake(), 10_000_000_000, "nothing booked or un-booked");
    }

    /// What the `try` cannot catch: a read that succeeds with fewer than 32 bytes of return data reverts in L4 itself,
    /// as Solidity decodes it outside the `catch` (the floors' and the total's reads alike; README, the pre-mainnet
    /// checklist): every path, the owner's forfeit included, until the read is back.
    function test_F1_aShortSuccessfulReadStillRevertsEveryPath() public {
        fullAndMissing();
        vm.mockCall(address(staking), abi.encodeWithSelector(staking.getUnclaimedRootTaoByHotkey.selector), "");
        vm.prank(stranger);
        vm.expectRevert(bytes(""));
        vault.removeHotkey(HK2, false);
        vm.prank(owner);
        vm.expectRevert(bytes(""));
        vault.removeHotkey(HK2, true);
        vm.clearMockedCalls();
        vm.prank(owner);
        vault.removeHotkey(HK2, true);
        assertFalse(vaultLens.isHotkey(HK2));
    }

    /// With the read working, the owner's forfeit logs what it read, as before.
    function test_F1_theOwnersForfeitLogsTheReadWhenItWorks() public {
        fund(10e18);
        vm.prank(owner);
        vault.addHotkey(HK2);
        uint256 dust = vaultLens.hotkeyDustRao();
        staking.setUnclaimed(coldkey(), HK2, dust + 1);
        refusedRemove(owner, HK2, false, HotkeyHasRewards.selector);
        vm.expectEmit(address(vault));
        emit HotkeyRemoved(HK2, (dust + 1) * RAO, true);
        vm.prank(owner);
        vault.removeHotkey(HK2, true);
    }

    // ---- F2: Unstaked logs the position a full removal took ----

    /// A request at least the position (want >= s): alice's 5 TAO exit walks HK1 (the stake hotkey, 3 TAO) whole and
    /// takes the rest from HK2 (7 TAO). HK1's Unstaked logs the 3 TAO its full removal took, not the 5 TAO asked;
    /// HK2's partial removal logs its 2 TAO request. What was received and the ledger are as before.
    function test_F2_aFullRemovalLogsThePositionItTook() public {
        fund(10e18);
        vm.prank(owner);
        vault.addHotkey(HK2);
        chainMoves(HK1, HK2, 7_000_000_000);
        // 5e24 of alice's 1e25 shares: 5e24 * (10e18 + 1) / (1e25 + 1e6) = 5e18 exactly
        vm.recordLogs();
        vm.prank(alice);
        vault.redeemDirect(5e24, false);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(alice.balance, 5e18);

        (uint256 want, uint256 received) = unstakedOf(logs, HK1);
        assertEq(want, 3_000_000_000, "the position HK1's full removal took, not the 5 TAO asked");
        assertEq(received, 3e18);
        (want, received) = unstakedOf(logs, HK2);
        assertEq(want, 2_000_000_000, "a partial removal logs its request");
        assertEq(received, 2e18);
        assertEq(stakeOf(HK1), 0);
        assertEq(stakeOf(HK2), 5_000_000_000);
        assertEq(vaultLens.bookedStake(), 5_000_000_000, "the ledger as before: the stake that left");
    }

    /// A request that would leave less than the nominator minimum (s - want < minRemain): alice's 9.99 TAO exit of a
    /// 10 TAO position removes it whole, and its Unstaked logs the 10 TAO taken, not the 9.99 asked; the 0.01 TAO
    /// over stays idle.
    function test_F2_aSweptRemainderLogsThePositionItTook() public {
        fund(10e18);
        // 9.99e24 shares: 9.99e24 * (10e18 + 1) / (1e25 + 1e6) = 9.99e18 exactly; 10 TAO - 9.99 TAO < 0.02 TAO
        vm.recordLogs();
        vm.prank(alice);
        vault.redeemDirect(9.99e24, false);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(alice.balance, 9.99e18);

        (uint256 want, uint256 received) = unstakedOf(logs, HK1);
        assertEq(want, 10_000_000_000, "the whole position, not the 9.99 TAO asked");
        assertEq(received, 10e18);
        assertEq(stakeOf(HK1), 0);
        assertEq(vaultLens.bookedStake(), 0);
        assertEq(address(vault).balance, ED + 0.01e18, "the excess received stays idle");
    }

    // ---- F3: stakeIdle books at most what it staked ----

    /// A chain-side credit of 1 TAO lands on the stake hotkey inside the keeper's 10 TAO addStake. stakeIdle books and
    /// ramps the 10 TAO it staked, not the 11 it measured (logged as measured); the 1 TAO stays a surplus, unpriced,
    /// until adoptStake books it a day after the deploy and vests it over the reward period, with no cut.
    function test_F3_aCreditInsideTheStakeStaysASurplus() public {
        depositDirect(alice, 10e18);
        staking.setAddStakeCreditRao(1_000_000_000);
        vm.expectEmit(address(vault));
        emit Staked(HK1, 10_000_000_000, 11_000_000_000);
        vm.prank(keeper);
        vault.stakeIdle();
        assertEq(stakeOf(HK1), 11_000_000_000);
        assertEq(vaultLens.bookedStake(), 10_000_000_000, "booked what it staked");
        assertEq(vaultLens.rampingStake(), 10e18, "and ramps only that");
        assertEq(vaultLens.surplusStakeRao(), 1_000_000_000, "the credit is a surplus");
        assertEq(vaultLens.totalAssets(), 10e18, "not priced at once");

        // only adoptStake books it, vested from now with no cut
        staking.setAddStakeCreditRao(0);
        vm.warp(deployedAt + 1 days);
        vm.prank(keeper);
        vault.adoptStake();
        assertEq(vaultLens.bookedStake(), 11_000_000_000);
        assertEq(vaultLens.surplusStakeRao(), 0);
        assertEq(vaultLens.unvestedRewards(), 1e18);
        assertEq(vaultLens.totalAssets(), 10e18, "the price does not step");
        // on the adoption drip (Revision 27), over its own period
        vm.warp(vm.getBlockTimestamp() + vaultLens.adoptVestingPeriod());
        assertEq(vaultLens.totalAssets(), 11e18, "it vests in");
    }

    /// The existing handling of a short read is kept: a fresh position that reads one rao short books what it read.
    function test_F3_aFreshPositionOneRaoShortBooksTheRead() public {
        staking.setOneRaoShort(true);
        depositDirect(alice, 10e18);
        vm.prank(keeper);
        vault.stakeIdle();
        assertEq(stakeOf(HK1), 9_999_999_999);
        assertEq(vaultLens.bookedStake(), 9_999_999_999);
        assertEq(vaultLens.surplusStakeRao(), 0);
        assertFalse(vaultLens.stakeMissing());
    }
}

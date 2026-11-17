// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISTAKING_ADDRESS} from "../src/interfaces/IStaking.sol";
import {MockAlphaVault} from "./mocks/MockAlphaVault.sol";
import {MockStaking} from "./mocks/MockStaking.sol";
import {MockTAO} from "./mocks/MockTAO.sol";

/// @dev Withdraws from the vault and, in the payment, tries to deposit again (ForeverMoney's lock refuses it), or
/// makes the re-entry `setReentry` names, after closing a gate first with `before` (a halt or a migration notice; the
/// mock has no roles), while the payment holds the lock.
contract ReenteringCaller {
    MockAlphaVault internal immutable vault;
    MockTAO internal immutable tao;
    bytes public reentryReturn;
    bytes public before;
    bytes public reentry;

    constructor(MockAlphaVault vault_, MockTAO tao_) {
        vault = vault_;
        tao = tao_;
    }

    function setReentry(bytes calldata before_, bytes calldata reentry_) external {
        before = before_;
        reentry = reentry_;
    }

    function withdraw(uint256 wad) external {
        vault.withdrawLiquid(address(tao), wad, 0);
    }

    receive() external payable {
        if (before.length != 0) {
            (bool ok,) = address(vault).call(before);
            require(ok, "the gate");
        }
        bytes memory call_ =
            reentry.length != 0 ? reentry : abi.encodeCall(MockAlphaVault.depositLiquid, (address(tao), 0));
        // only a deposit takes value; the cast keeps the call's selector, its first 4 bytes
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 value = bytes4(call_) == MockAlphaVault.depositLiquid.selector ? msg.value : 0;
        (, reentryReturn) = address(vault).call{value: value}(call_);
    }
}

/// @notice The ForeverMoney double against the deployed AlphaVault's behaviour (bridge-contracts e80a443), one test per
/// line of the R3 ForeverMoney-fidelity report's Differences table that the adapter can meet (D-1 to D-7, D-9, D-10).
contract MockAlphaVaultTest is Test {
    MockStaking staking = MockStaking(ISTAKING_ADDRESS);
    MockTAO tao;
    MockAlphaVault vault;

    function setUp() public {
        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        tao = new MockTAO(18);
        vault = new MockAlphaVault(tao);
        vm.deal(address(vault), 100 ether);
        vm.deal(address(this), 100 ether);
    }

    receive() external payable {}

    function staked() internal view returns (uint256) {
        return vault.stakedValueRao(address(tao));
    }

    // ---- D-1: depositLiquid stakes through the precompile and checks the stake it measured ----

    function test_depositLiquid_stakesAndMintsTheMeasuredStake() public {
        assertEq(staked(), vault.SEED_RAO(), "the seeded position");
        uint256 balance = address(vault).balance;
        uint256 minted = vault.depositLiquid{value: 3e18}(address(tao), 3e9);
        assertEq(minted, 3e18);
        assertEq(tao.balanceOf(address(this)), 3e18);
        assertEq(staked(), vault.SEED_RAO() + 3e9, "staked, not held");
        assertEq(address(vault).balance, balance, "the precompile took the TAO");
    }

    /// The check reads the stake measured, not msg.value: 1 rao short against a minimum of the whole amount is
    /// Slippage; against the amount less 1 rao it mints what was measured. Over-credited, it mints more.
    function test_depositLiquid_checksTheMeasuredStake() public {
        vault.setShortBy(1e9);
        vm.expectRevert(MockAlphaVault.Slippage.selector);
        vault.depositLiquid{value: 3e18}(address(tao), 3e9);
        assertEq(vault.depositLiquid{value: 3e18}(address(tao), 3e9 - 1), 3e18 - 1e9);
        vault.setShortBy(0);
        vault.setOvermint(5e9);
        assertEq(vault.depositLiquid{value: 3e18}(address(tao), 3e9), 3e18 + 5e9);
        assertEq(tao.balanceOf(address(this)), 6e18 + 4e9);
    }

    /// A measured stake of 0 is Slippage whatever the minimum (`received == 0`); the input checks come first.
    function test_depositLiquid_refusesNothingAndDust() public {
        vm.expectRevert(MockAlphaVault.ZeroAmount.selector);
        vault.depositLiquid{value: 0}(address(tao), 0);
        vm.expectRevert(MockAlphaVault.NotWholeRao.selector);
        vault.depositLiquid{value: 3e18 + 1}(address(tao), 0);
        // the chain credits nothing at all
        vault.setShortBy(3e18);
        vm.expectRevert(MockAlphaVault.Slippage.selector);
        vault.depositLiquid{value: 3e18}(address(tao), 0);
    }

    // ---- D-2: withdrawLiquid checks the TAO it measured ----

    function test_withdrawLiquid_burnsUnstakesAndPays() public {
        tao.mint(address(this), 10e18);
        uint256 before = address(this).balance;
        uint256 out = vault.withdrawLiquid(address(tao), 4e18, 4e18);
        assertEq(out, 4e18);
        assertEq(tao.balanceOf(address(this)), 6e18);
        assertEq(address(this).balance - before, 4e18);
        assertEq(staked(), vault.SEED_RAO() - 4e9, "unstaked from the position");
    }

    /// 1 rao short against a minimum of the whole amount is Slippage (the burn rolled back); against the amount less 1
    /// rao it pays what was measured. Overpaid, it pays more.
    function test_withdrawLiquid_checksTheMeasuredTao() public {
        tao.mint(address(this), 10e18);
        vault.setShortBy(1e9);
        vm.expectRevert(MockAlphaVault.Slippage.selector);
        vault.withdrawLiquid(address(tao), 4e18, 4e18);
        assertEq(tao.balanceOf(address(this)), 10e18, "the burn rolled back");
        assertEq(staked(), vault.SEED_RAO(), "the unstake rolled back");
        uint256 before = address(this).balance;
        assertEq(vault.withdrawLiquid(address(tao), 4e18, 4e18 - 1e9), 4e18 - 1e9);
        assertEq(address(this).balance - before, 4e18 - 1e9);
        vault.setShortBy(0);
        vault.setOverpay(5e9);
        before = address(this).balance;
        assertEq(vault.withdrawLiquid(address(tao), 4e18, 4e18), 4e18 + 5e9);
        assertEq(address(this).balance - before, 4e18 + 5e9);
    }

    // ---- D-3: the halt is a clock ----

    /// The guardian's pause lifts itself; one shot is at most 2 days and the next waits out a 12-hour cooldown; the
    /// operator holds past the cap and lifts at once. Both legs refuse IsHalted while it holds.
    function test_theHaltIsAClock() public {
        tao.mint(address(this), 10e18);
        vm.expectRevert(MockAlphaVault.PauseCapExceeded.selector);
        vault.guardianPause(2 days + 1);
        vault.guardianPause(1 days);
        assertTrue(vault.isPaused());
        vm.expectRevert(MockAlphaVault.IsHalted.selector);
        vault.depositLiquid{value: 1e18}(address(tao), 0);
        vm.expectRevert(MockAlphaVault.IsHalted.selector);
        vault.withdrawLiquid(address(tao), 1e18, 0);

        vm.warp(vm.getBlockTimestamp() + 1 days);
        assertFalse(vault.isPaused(), "lifted by itself");
        vault.withdrawLiquid(address(tao), 1e18, 0);
        vm.expectRevert(MockAlphaVault.PauseCooldown.selector);
        vault.guardianPause(1 days);

        vault.adminHold(vm.getBlockTimestamp() + 30 days);
        vm.warp(vm.getBlockTimestamp() + 3 days);
        assertTrue(vault.isPaused(), "the operator holds past the guardian's cap");
        vault.unpause();
        assertFalse(vault.isPaused());
        vault.depositLiquid{value: 1e18}(address(tao), 0);
    }

    // ---- D-4: a migration closes deposits only; the position then leaves ----

    function test_aMigrationClosesDepositsThenWithdrawalsAreInsolvent() public {
        tao.mint(address(this), 10e18);
        vault.initiateMigration();
        vm.expectRevert(MockAlphaVault.MigrationInProgress.selector);
        vault.depositLiquid{value: 1e18}(address(tao), 0);
        vault.withdrawLiquid(address(tao), 1e18, 0);
        vault.cancelMigration();
        vault.depositLiquid{value: 1e18}(address(tao), 0);

        vault.initiateMigration();
        vm.expectRevert(MockAlphaVault.MigrationNotReady.selector);
        vault.executeMigration();
        vm.warp(vm.getBlockTimestamp() + vault.MIGRATION_DELAY());
        vault.executeMigration();
        assertEq(staked(), 0, "the position left");
        vm.expectRevert(MockAlphaVault.MigrationIrreversible.selector);
        vault.cancelMigration();
        vm.expectRevert(MockAlphaVault.Insolvent.selector);
        vault.withdrawLiquid(address(tao), 1e18, 0);
        vault.finishMigration();
        assertTrue(vault.isPaused(), "halted for good");
        vm.expectRevert(MockAlphaVault.IsHalted.selector);
        vault.depositLiquid{value: 1e18}(address(tao), 0);
    }

    // ---- D-5: no floor of its own: the precompile's ----

    function test_belowTheChainsMinimumThePrecompileRefuses() public {
        tao.mint(address(this), 10e18);
        // the default minimum is 2,000,000 rao
        vm.expectRevert(MockStaking.BelowMinStake.selector);
        vault.depositLiquid{value: 1e15}(address(tao), 0);
        vm.expectRevert(MockStaking.AmountTooLow.selector);
        vault.withdrawLiquid(address(tao), 1e15, 0);
        vault.depositLiquid{value: 2e15}(address(tao), 0);
        vault.withdrawLiquid(address(tao), 2e15, 0);
        staking.setMinStake(20_000_000);
        vm.expectRevert(MockStaking.BelowMinStake.selector);
        vault.depositLiquid{value: 1e16}(address(tao), 0);
    }

    // ---- D-6, D-7: listing and balance ----

    function test_unknownTokenAndInsufficientBalance() public {
        MockTAO other = new MockTAO(18);
        vm.expectRevert(MockAlphaVault.UnknownToken.selector);
        vault.depositLiquid{value: 1e18}(address(other), 0);
        vm.expectRevert(MockAlphaVault.UnknownToken.selector);
        vault.withdrawLiquid(address(other), 1e18, 0);
        assertFalse(vault.isListed(address(other)));
        assertTrue(vault.isListed(address(tao)));
        tao.mint(address(this), 1e18);
        vm.expectRevert(abi.encodeWithSelector(MockAlphaVault.InsufficientBalance.selector, 1e18, 2e18));
        vault.withdrawLiquid(address(tao), 2e18, 0);
    }

    // ---- D-9, D-10: a plain send bounces; the lock ----

    function test_aPlainSendBounces() public {
        (bool ok, bytes memory ret) = address(vault).call{value: 1}("");
        assertFalse(ok);
        assertEq(bytes4(ret), MockAlphaVault.DirectSendNotAllowed.selector);
    }

    function test_aCallerReenteringFromItsPaymentMeetsTheLock() public {
        ReenteringCaller c = new ReenteringCaller(vault, tao);
        tao.mint(address(c), 1e18);
        c.withdraw(1e18);
        assertEq(c.reentryReturn(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
    }

    /// The gates run before the lock, as the deployed modifiers are ordered (whenNotHalted, whenNotMigrating, then
    /// nonReentrant; R3 re-review, new breakage 4): with the lock held by a withdrawal's payment, a deposit during a
    /// migration's notice refuses MigrationInProgress, and a deposit or a withdrawal under a halt refuses IsHalted, not
    /// the lock's ReentrancyGuardReentrantCall.
    function test_theGatesRefuseBeforeTheLock() public {
        ReenteringCaller c = new ReenteringCaller(vault, tao);
        tao.mint(address(c), 3e18);
        bytes memory deposit = abi.encodeCall(MockAlphaVault.depositLiquid, (address(tao), 0));
        c.setReentry(abi.encodeCall(MockAlphaVault.initiateMigration, ()), deposit);
        c.withdraw(1e18);
        assertEq(c.reentryReturn(), abi.encodeWithSelector(MockAlphaVault.MigrationInProgress.selector));
        vault.cancelMigration();

        bytes memory hold = abi.encodeCall(MockAlphaVault.adminHold, (vm.getBlockTimestamp() + 1 days));
        c.setReentry(hold, deposit);
        c.withdraw(1e18);
        assertEq(c.reentryReturn(), abi.encodeWithSelector(MockAlphaVault.IsHalted.selector));
        vault.unpause();

        c.setReentry(hold, abi.encodeCall(MockAlphaVault.withdrawLiquid, (address(tao), 1e18, 0)));
        c.withdraw(1e18);
        assertEq(c.reentryReturn(), abi.encodeWithSelector(MockAlphaVault.IsHalted.selector));
    }

    // ---- the test knobs ----

    function test_theKnobsAreWholeRao() public {
        vm.expectRevert(MockAlphaVault.NotWholeRao.selector);
        vault.setShortBy(1);
        vm.expectRevert(MockAlphaVault.NotWholeRao.selector);
        vault.setOverpay(1e9 + 1);
        vm.expectRevert(MockAlphaVault.NotWholeRao.selector);
        vault.setOvermint(5);
    }
}

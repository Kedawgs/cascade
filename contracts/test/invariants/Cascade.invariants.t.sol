// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {ADDRESS_MAPPING_ADDRESS} from "../../src/interfaces/IAddressMapping.sol";
import {CascadeMath} from "../../src/libraries/CascadeMath.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MockAddressMapping} from "../mocks/MockAddressMapping.sol";
import {MockBridge} from "../mocks/MockBridge.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {mirror} from "../mocks/Mirror.sol";
import {Handler} from "./Handler.sol";

/// @dev Random sequences of front-door deposits, redeem requests and cancels, batch closes (delivered at
/// once by MockBridge), payouts, claims, direct deposits and redeems, staking, root rewards, payout
/// cancels, rare simulated losses (which can make the vault insolvent, so deliveries bounce deposits)
/// and time jumps, over the EndToEnd fixture: the vault on BITTENSOR, one front door on BASE,
/// exact stake reads, bridge fee 1e15, redeem-request fee 1e14. Only the handler's actions are fuzzed.
/// The vault's deposit cap and the front door's are raised so that neither is ever why a call fails.
contract CascadeInvariantTest is Test {
    uint64 constant BASE = 8453;
    uint64 constant BITTENSOR = 964;
    bytes32 constant HK1 = bytes32(uint256(1));
    uint256 constant ED = 1e12;
    uint256 constant FEE = 1e15;
    uint256 constant REQUEST_FEE = 1e14;
    uint256 constant HIGH_CAP = 1_000_000e18;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");

    MockStaking staking = MockStaking(ISTAKING_ADDRESS);
    MockTAO tao;
    MockUSDC usdc;
    MockBridge bridge;
    CascadeVault vault;
    CascadeFrontDoor fd;
    Handler handler;

    function setUp() public {
        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        vm.etch(ADDRESS_MAPPING_ADDRESS, address(new MockAddressMapping()).code);
        staking.addHotkey(HK1);
        staking.setOneRaoShort(false);

        tao = new MockTAO(18);
        usdc = new MockUSDC();
        bridge = new MockBridge(tao);
        bridge.setFee(FEE);

        bytes32 expectedColdkey = mirror(vm.computeCreateAddress(address(this), vm.getNonce(address(this))));
        vault = new CascadeVault(expectedColdkey, HK1, bridge, owner, guardian, 1e15, 0, address(0));
        vm.deal(address(vault), ED);

        fd = new CascadeFrontDoor(
            tao, bridge, BITTENSOR, address(vault), owner, guardian, 12 hours, 1e18, HIGH_CAP, REQUEST_FEE, usdc
        );
        bridge.connect(BITTENSOR, address(vault), true);
        bridge.connect(BASE, address(fd), false);
        vm.prank(owner);
        vault.proposeFrontDoor(BASE, address(fd));
        vm.warp(block.timestamp + 7 days);
        vm.startPrank(owner);
        vault.activateFrontDoor(BASE, address(fd));
        vault.setMaxTotalAssets(HIGH_CAP);
        // minChunk 1 (default value limits): a batch of 2 or 3 entries can go out in several chunks
        vault.setMessageLimits(2_000e18, 4_000e18, 1);
        vm.stopPrank();

        handler = new Handler(vault, fd, tao, bridge, owner, HK1, BASE);
        vm.prank(owner);
        vault.setKeeper(address(handler));
        // pays every close's bridge fee
        vm.deal(address(handler), 100 ether);

        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = Handler.deposit.selector;
        selectors[1] = Handler.requestRedeem.selector;
        selectors[2] = Handler.cancelDeposit.selector;
        selectors[3] = Handler.cancelRedeem.selector;
        selectors[4] = Handler.closeBatch.selector;
        selectors[5] = Handler.processPayouts.selector;
        selectors[6] = Handler.claim.selector;
        selectors[7] = Handler.depositDirect.selector;
        selectors[8] = Handler.redeemDirect.selector;
        selectors[9] = Handler.stakeIdle.selector;
        selectors[10] = Handler.accrueAndClaim.selector;
        selectors[11] = Handler.warp.selector;
        selectors[12] = Handler.cancelQueued.selector;
        selectors[13] = Handler.simulateLoss.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev The price never falls below the highest price seen, one rao of tolerance in the assets for
    /// rounding. A payout cancel resets the floor to the post-cancel price, after the handler checks that
    /// price against the batch's delivery price (invariant_cancelDustBounded); a simulated loss resets it
    /// to the post-loss price.
    function invariant_priceNeverFallsExceptAcrossCancel() public view {
        assertGe(CascadeMath.price(vault.totalAssets() + 1e9, vault.totalSupply()), handler.priceFloor());
    }

    /// @dev A cancel leaves the price at most its re-minted entries' rounding dust (under 1 rao each,
    /// which a holder who exits before the cancel can take) below min(floor, delivery price).
    function invariant_cancelDustBounded() public view {
        assertEq(handler.cancelDustViolations(), 0);
    }

    /// @dev Exact stake reads and no donations: the vault holds every wei delivered or deposited, less
    /// every wei sent out, plus every claimed reward, less every simulated loss.
    function invariant_grossAssetsConserved() public view {
        // ghostIn - ghostOut + ghostRewards - ghostLoss, ordered so nothing underflows
        assertEq(
            vault.grossAssets(), handler.ghostIn() + handler.ghostRewards() - handler.ghostOut() - handler.ghostLoss()
        );
    }

    /// @dev Every reserved wei belongs to a batch still in the queue.
    function invariant_pendingPayoutsMatchQueue() public view {
        uint256 sum;
        uint256 n = handler.queuedCount();
        for (uint256 i; i < n; ++i) {
            sum += vault.getPayoutBatch(handler.queuedKeys(i)).remaining;
        }
        assertEq(sum, vault.pendingPayouts());
    }

    function invariant_burnWindowsRespected() public view {
        assertEq(handler.burnViolations(), 0);
    }

    /// @dev The front door holds exactly the open batch's deposits plus every unclaimed credit in TAO
    /// (exact because the handler never donates), and exactly the open batch's fee pot plus the
    /// pre-paid credits in ETH.
    function invariant_frontDoorIdentities() public view {
        (,, uint256 totalDeposits, uint256 feePot,,) = fd.openBatch();
        assertEq(tao.balanceOf(address(fd)), totalDeposits + fd.totalClaimable());
        assertEq(address(fd).balance, feePot + fd.totalFeeCredit());
    }

    /// @dev Users claim at most what the vault paid out, and the front door owes exactly the rest.
    function invariant_claimsNeverExceedPayouts() public view {
        assertLe(handler.ghostClaimed(), handler.ghostPayoutsReceived());
        assertEq(fd.totalClaimable(), handler.ghostPayoutsReceived() - handler.ghostClaimed());
    }

    function invariant_noUnexpectedReverts() public view {
        assertEq(handler.unexpectedReverts(), 0);
    }

    /// @dev Successful calls per action, to show each one is reached; asserts nothing.
    function invariant_reachabilityLogged() public {
        emit log_named_uint("deposits", handler.deposits());
        emit log_named_uint("redeemRequests", handler.redeemRequests());
        emit log_named_uint("depositCancels", handler.depositCancels());
        emit log_named_uint("redeemCancels", handler.redeemCancels());
        emit log_named_uint("closes", handler.closes());
        emit log_named_uint("deliveries", handler.deliveries());
        emit log_named_uint("payoutChunks", handler.payoutChunks());
        emit log_named_uint("partialChunks", handler.partialChunks());
        emit log_named_uint("claims", handler.claims());
        emit log_named_uint("directDeposits", handler.directDeposits());
        emit log_named_uint("directRedeems", handler.directRedeems());
        emit log_named_uint("stakes", handler.stakes());
        emit log_named_uint("rewardClaims", handler.rewardClaims());
        emit log_named_uint("cancels", handler.cancels());
        emit log_named_uint("cancelsAfterPartial", handler.cancelsAfterPartial());
        emit log_named_uint("redeemDeferred", handler.redeemDeferred());
        emit log_named_uint("redeemSkipped", handler.redeemSkipped());
        emit log_named_uint("losses", handler.losses());
        emit log_named_uint("depositBounces", handler.depositBounces());
        emit log_named_uint("bouncesPaid", handler.bouncesPaid());
        emit log_named_uint("bouncesCancelled", handler.bouncesCancelled());
        emit log_named_uint("maxQueueDepth", handler.maxQueueDepth());
        emit log_named_uint("dustBlocked", handler.dustBlocked());
    }

    // ---- regression ----

    /// @dev The sequence that took a cancel more than one rao below its batch's delivery price: alice
    /// keeps part of her shares through a 3-entry batch, takes her part of its dust out by a direct
    /// redeem, then the owner cancels the batch. Amounts are inside the handler's bounds, so they pass
    /// through unchanged; neither direct deposit is 3 mod 4 in rao, so both actors are opted back in.
    function test_cancelAfterExitStaysWithinDustTolerance() public {
        // alice and carol deposit directly; 0.818140478 TAO of rewards vest
        handler.depositDirect(0, 10_889_328_168);
        handler.depositDirect(2, 8_834_290_024);
        handler.accrueAndClaim(818_140_478);
        handler.warp(3 days);
        handler.warp(3 days);
        handler.warp(3 days);
        // bob deposits 19.000000012 TAO at the front door; more rewards vest
        handler.deposit(1, 19_000_000_012);
        handler.closeBatch();
        handler.accrueAndClaim(879_191_032);
        handler.warp(3 days);
        handler.warp(3 days);
        handler.warp(3 days);
        // alice asks for part of her shares, bob and carol for all of theirs: one batch, 3 entries
        handler.requestRedeem(0, 1_883_245_995_349_222_618_070_820);
        handler.requestRedeem(1, type(uint256).max);
        handler.requestRedeem(2, type(uint256).max);
        handler.closeBatch();
        assertEq(handler.queuedCount(), 1);
        bytes32 key = handler.queuedKeys(0);
        CascadeVault.PayoutBatch memory b = vault.getPayoutBatch(key);
        assertEq(b.count, 3);
        uint256 reMinted = b.count - b.cursor;
        // alice exits with the rest; the owner cancels the batch
        handler.redeemDirect(0, type(uint256).max);
        assertEq(vault.balanceOf(handler.actors(0)), 0);
        uint256 f = Math.min(handler.priceFloor(), handler.deliveryPrice(key));
        handler.cancelQueued(0);
        assertEq(handler.cancels(), 1);

        // more than one rao short of min(floor, delivery price), within one rao per re-minted entry
        uint256 assets = vault.totalAssets();
        uint256 supply = vault.totalSupply();
        assertLt(CascadeMath.price(assets + 1e9, supply), f);
        assertGe(CascadeMath.price(assets + reMinted * 1e9, supply), f);
        assertEq(handler.cancelDustViolations(), 0);
        // the floor restarts from the post-cancel price
        assertEq(handler.priceFloor(), vault.price());
        invariant_cancelDustBounded();
        invariant_priceNeverFallsExceptAcrossCancel();
        invariant_grossAssetsConserved();
        invariant_pendingPayoutsMatchQueue();
        invariant_noUnexpectedReverts();
    }

    /// @dev A simulated loss makes the vault insolvent: a direct deposit is refused (expected), a batch's
    /// deposits bounce ahead of its redeem, one bounce is paid back to Base and claimed, and the owner
    /// cancels the rest of the batch (a bounce among it), all with every invariant holding.
    function test_lossBouncesDepositsThenPayoutAndCancel() public {
        // alice deposits 10 TAO at the front door: 1e25 shares, left liquid
        handler.deposit(0, 10_000_000_000);
        handler.closeBatch();
        assertEq(vault.balanceOf(handler.actors(0)), 1e25);

        // seed 42e18: 42e18 % 7 == 0 and 6e18 lies in [free / 2, free] = [5e18, 10e18], so 6e18 is lost.
        // totalAssets 4e18 against 1e25 shares is below half the launch price.
        handler.simulateLoss(42e18);
        assertEq(handler.losses(), 1);
        assertEq(handler.ghostLoss(), 6e18);
        assertLt(vault.totalAssets() * 2_000_000, vault.totalSupply());
        // refused VaultInsolvent, which the handler expects
        handler.depositDirect(1, 1_000_000_000);
        assertEq(handler.directDeposits(), 0);

        // bob and carol deposit, alice asks to redeem half: both deposits bounce ahead of her redeem
        handler.deposit(1, 1_000_000_000);
        handler.deposit(2, 2_000_000_000);
        handler.requestRedeem(0, 5e24);
        handler.closeBatch();
        assertEq(handler.depositBounces(), 2);
        assertEq(handler.queuedCount(), 1);
        bytes32 key = handler.queuedKeys(0);
        assertEq(vault.getPayoutBatch(key).count, 3);
        assertEq(vault.balanceOf(handler.actors(1)), 0);
        assertEq(vault.balanceOf(handler.actors(2)), 0);

        // the keeper's first chunk (1 entry, minChunk 1) pays bob's bounce back; bob claims it on Base
        handler.processPayouts(0);
        assertEq(handler.bouncesPaid(), 1);
        assertEq(handler.partialChunks(), 1);
        handler.claim(1);
        assertEq(handler.claims(), 1);

        // the owner cancels the rest: carol's bounce stays in the vault, alice's shares come back
        handler.cancelQueued(0);
        assertEq(handler.bouncesCancelled(), 1);
        assertEq(handler.cancelsAfterPartial(), 1);
        assertEq(vault.balanceOf(handler.actors(0)), 1e25);

        invariant_priceNeverFallsExceptAcrossCancel();
        invariant_cancelDustBounded();
        invariant_grossAssetsConserved();
        invariant_pendingPayoutsMatchQueue();
        invariant_frontDoorIdentities();
        invariant_claimsNeverExceedPayouts();
        invariant_noUnexpectedReverts();
    }

    /// @dev A position below the minimum stake is skipped by the unstake walk: alice's full exit empties
    /// HK1, a 0.001-TAO reward lands on it, and bob's full exit (which needs that reward) is refused
    /// UnstakeShort, counted as dust-blocked rather than unexpected. Once stakeIdle tops HK1 up, bob exits.
    function test_subMinimumStakeBlocksExitUntilToppedUp() public {
        handler.depositDirect(0, 10_000_000_000);
        handler.stakeIdle();
        handler.redeemDirect(0, type(uint256).max);
        assertEq(staking.getStake(HK1, vault.coldkey(), 0), 0);
        handler.depositDirect(1, 10_000_000_000);
        handler.accrueAndClaim(1_000_000);
        assertEq(staking.getStake(HK1, vault.coldkey(), 0), 1_000_000);
        handler.warp(3 days);
        handler.warp(3 days);
        handler.warp(3 days);

        handler.redeemDirect(1, type(uint256).max);
        assertEq(handler.dustBlocked(), 1);
        assertEq(handler.directRedeems(), 1);
        invariant_noUnexpectedReverts();

        // bob's 10 TAO staked onto the dust position, then he exits in full
        handler.stakeIdle();
        handler.redeemDirect(1, type(uint256).max);
        assertEq(handler.directRedeems(), 2);
        assertEq(vault.totalSupply(), 0);
        invariant_noUnexpectedReverts();
        invariant_grossAssetsConserved();
    }
}

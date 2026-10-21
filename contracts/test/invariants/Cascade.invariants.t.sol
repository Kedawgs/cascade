// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {StakeEngine} from "../../src/StakeEngine.sol";
import {MockBridge} from "../mocks/MockBridge.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {Handler} from "./Handler.sol";

/// @dev Random sequences of deposits, redemptions, cancels, closes, settles, claims, root rewards and
/// time jumps against the vault and the engine, wired through MockBridge exactly as in
/// EndToEnd.t.sol. Only the handler's actions are fuzzed. Each invariant reads the contracts' public
/// state and compares it with the handler's ghost totals of what actually happened.
contract CascadeInvariantTest is Test {
    bytes32 constant HOTKEY = keccak256("validator");
    address constant GUARDIAN = address(0x6A2D);
    uint256 constant FEE = 0.001 ether;

    MockStaking staking;
    MockTAO tao;
    MockBridge bridge;
    StakeEngine engine;
    CascadeVault vault;
    Handler handler;
    bytes32 COLDKEY;

    function setUp() public {
        MockStaking impl = new MockStaking();
        vm.etch(ISTAKING_ADDRESS, address(impl).code);
        staking = MockStaking(ISTAKING_ADDRESS);
        staking.addHotkey(HOTKEY);

        tao = new MockTAO(18);
        bridge = new MockBridge(tao);

        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        COLDKEY = staking.mirror(predicted);
        engine = new StakeEngine(COLDKEY, HOTKEY, bridge, address(this), GUARDIAN);
        assertEq(address(engine), predicted);

        vault = new CascadeVault(IERC20Metadata(address(tao)), bridge, address(this), GUARDIAN, 1 days, 10_000e18, 1e18);
        bridge.connect(address(vault), payable(address(engine)));
        bridge.setFee(FEE);

        handler = new Handler(vault, engine, tao, staking, COLDKEY, HOTKEY, FEE);

        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = Handler.deposit.selector;
        selectors[1] = Handler.cancelDeposit.selector;
        selectors[2] = Handler.redeem.selector;
        selectors[3] = Handler.cancelRedeem.selector;
        selectors[4] = Handler.closeEpoch.selector;
        selectors[5] = Handler.settle.selector;
        selectors[6] = Handler.claimShares.selector;
        selectors[7] = Handler.claimAssets.selector;
        selectors[8] = Handler.accrueAndClaimRewards.selector;
        selectors[9] = Handler.warp.selector;
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev The share price set by a settlement is never below the highest price seen before it.
    function invariant_priceNeverDecreases() public view {
        uint256 price = vault.lastPrice();
        if (price != 0) assertGe(price, handler.lastSeenPrice());
    }

    /// @dev The vault holds exactly the open epoch's deposits plus every settled payout not yet claimed.
    function invariant_vaultAssetsCoverObligations() public view {
        uint256 openDeposits = vault.epochs(vault.currentEpochId()).totalDeposits;
        assertEq(tao.balanceOf(address(vault)), openDeposits + handler.paidAssets() - handler.claimedAssets());
    }

    /// @dev The vault's own csTAO is exactly the escrow of the open and in-flight epochs plus every
    /// settled mint not yet claimed.
    function invariant_shareEscrowIsExact() public view {
        uint64 inFlight = vault.inFlightEpoch();
        uint256 escrowed = vault.epochs(vault.currentEpochId()).totalRedeemShares;
        if (inFlight != 0) escrowed += vault.epochs(inFlight).totalRedeemShares;
        assertEq(vault.balanceOf(address(vault)), escrowed + handler.mintedShares() - handler.claimedShares());
    }

    /// @dev With no epoch pending, everything above the 0.002 TAO minimum stake is staked.
    function invariant_engineHoldsNoIdleWithoutPending() public view {
        if (!engine.hasPending()) assertLt(address(engine).balance, 2_000_000 * 1e9);
    }

    /// @dev Honest flows with rewards at half the vault's APR bound never trip the price check.
    function invariant_noEpochFlagged() public view {
        uint64 current = vault.currentEpochId();
        for (uint64 id = 1; id <= current; id++) {
            assertNotEq(uint8(vault.epochs(id).status), uint8(CascadeVault.EpochStatus.Flagged));
        }
    }

    function invariant_atMostOneInFlight() public view {
        uint64 inFlight = vault.inFlightEpoch();
        if (inFlight != 0) {
            assertEq(uint8(vault.epochs(inFlight).status), uint8(CascadeVault.EpochStatus.InFlight));
        }
    }
}

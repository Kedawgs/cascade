// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {CascadeMath} from "../src/libraries/CascadeMath.sol";

contract CascadeMathTest is Test {
    function test_firstDepositMintsWithVirtualOffset() public pure {
        // Empty vault: 1 TAO buys 1e24 shares (asset decimals + 6).
        assertEq(CascadeMath.sharesForDeposit(1e18, 0, 0), 1e24);
    }

    function test_depositAtUnchangedPriceMintsSameRate() public pure {
        assertEq(CascadeMath.sharesForDeposit(1e18, 2e18, 2e24), 1e24);
    }

    function test_depositAfterRewardsMintsFewerShares() public pure {
        // 10% rewards accrued: 2.2 TAO backs 2e24 shares.
        assertEq(CascadeMath.sharesForDeposit(1e18, 2.2e18, 2e24), 909090909090909090950413);
    }

    function test_redeemAfterRewardsPaysMore() public pure {
        assertEq(CascadeMath.assetsForRedeem(1e24, 2.2e18, 2e24), 1099999999999999999);
    }

    function test_roundsDownInFavourOfTheVault() public pure {
        assertEq(CascadeMath.sharesForDeposit(1, 2, 0), 333333);
        assertEq(CascadeMath.assetsForRedeem(1, 2, 0), 0);
    }

    function test_pricePerShare() public pure {
        assertEq(CascadeMath.price(0, 0), 1e12);
        assertEq(CascadeMath.price(2.2e18, 2e24), 1099999999999);
    }

    /// A deposit followed by an immediate redeem of the minted shares never returns more than was put in.
    function testFuzz_roundTripNeverProfits(uint128 assets, uint128 totalAssets, uint128 totalSupply) public pure {
        assets = uint128(bound(assets, 0, 1e36));
        totalAssets = uint128(bound(totalAssets, 0, 1e36));
        totalSupply = uint128(bound(totalSupply, 0, 1e36));
        vm.assume(assets > 0);
        uint256 shares = CascadeMath.sharesForDeposit(assets, totalAssets, totalSupply);
        uint256 back = CascadeMath.assetsForRedeem(shares, uint256(totalAssets) + assets, uint256(totalSupply) + shares);
        assertLe(back, assets);
    }

    /// Minting at the current price never lowers the price for existing holders.
    function testFuzz_depositNeverLowersPrice(uint128 assets, uint128 totalAssets, uint128 totalSupply) public pure {
        assets = uint128(bound(assets, 0, 1e36));
        totalAssets = uint128(bound(totalAssets, 0, 1e36));
        totalSupply = uint128(bound(totalSupply, 0, 1e36));
        uint256 before = CascadeMath.price(totalAssets, totalSupply);
        uint256 shares = CascadeMath.sharesForDeposit(assets, totalAssets, totalSupply);
        uint256 afterPrice = CascadeMath.price(uint256(totalAssets) + assets, uint256(totalSupply) + shares);
        assertGe(afterPrice, before);
    }

    /// Paying out a redemption never lowers the price for the holders who stay.
    function testFuzz_redeemNeverLowersPrice(uint128 shares, uint128 totalAssets, uint128 totalSupply) public pure {
        shares = uint128(bound(shares, 0, 1e36));
        totalAssets = uint128(bound(totalAssets, 0, 1e36));
        totalSupply = uint128(bound(totalSupply, 0, 1e36));
        vm.assume(shares <= totalSupply);
        uint256 before = CascadeMath.price(totalAssets, totalSupply);
        uint256 out = CascadeMath.assetsForRedeem(shares, totalAssets, totalSupply);
        assertLe(out, totalAssets);
        uint256 afterPrice = CascadeMath.price(uint256(totalAssets) - out, uint256(totalSupply) - shares);
        assertGe(afterPrice, before);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeStaker} from "../../src/CascadeStaker.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {ICascadeBridge} from "../../src/interfaces/ICascadeBridge.sol";

// The vault's, the front door's and the staker's constructor arguments as every fixture builds them (ruling
// A12): each construction site starts from defaultVaultParams, defaultFrontDoorParams or defaultStakerParams and
// changes only what it is about, so a field a later task appends to CascadeVault.Params (rewardVesting in Task 15,
// globalOutflowBps in Task 17, idleBufferBps and unstakeGas in Task 20) or to CascadeFrontDoor.Params
// (treasury in Task 29, minPoolLiquidity in Task 32) touches one line here and no construction site.
// Every Params is launch-shaped: the owner, the keeper and every limit come from the constructor, and
// the launch door is active on the launch chain from the deploy (spec §7), as the deployment does.

/// The parties a fixture names and the fixtures' values: v3.1's code defaults, which the suite's
/// assertions are written against (maxTotalAssets 1,000 TAO, entry and message limits 2,000 and 4,000
/// TAO, a 100 TAO outflow floor, a 24 h payout delay, a 0.001 TAO minimum direct deposit, no reward cut, v3.1's
/// 7-day reward vesting, Appendix B's too), the fee ceiling at Appendix B's 1% / 0.015 TAO (v3.1's 0.02 TAO is above
/// MAX_FEE_ABS since Task 21), Appendix B's 20% global outflow
/// window beside each door's 20% (Task 17), Appendix B's walk settings (no idle buffer, 400,000 gas the least each
/// removal is forwarded; Task 20), and Bittensor's calibrated 7,200 ms blocks (Revision 28).
/// `expectedColdkey` is the mirror of the address the vault will have (its CREATE's), which the constructor
/// checks.
function defaultVaultParams(
    bytes32 expectedColdkey,
    bytes32 hotkey,
    ICascadeBridge bridge,
    address owner,
    address guardian,
    address keeper,
    uint64 launchChain,
    address initialFrontDoor
) pure returns (CascadeVault.Params memory p) {
    p.expectedColdkey = expectedColdkey;
    p.hotkey = hotkey;
    p.bridge = bridge;
    p.owner = owner;
    p.guardian = guardian;
    p.keeper = keeper;
    p.treasury = address(0);
    p.rewardCutBps = 0;
    p.launchChain = launchChain;
    p.initialFrontDoor = initialFrontDoor;
    p.payoutDelay = 24 hours;
    p.maxDailyOutflowBps = 2_000;
    p.minDailyOutflow = 100e18;
    p.maxEntryValue = 2_000e18;
    p.maxMessageValue = 4_000e18;
    p.minChunk = 10;
    p.maxFeeBps = 100;
    p.maxFeeAbs = 0.015e18;
    p.maxTotalAssets = 1_000e18;
    p.minDirectDeposit = 1e15;
    p.claimGasRequired = 55_000_000;
    p.hotkeyDustRao = 1_000_000;
    p.unstakeMarginRao = 0;
    // the deploy's calibration (Revision 28): twice as fast as Bittensor's 12-second blocks
    p.msPerBlock = 7_200;
    p.rewardVesting = 7 days;
    p.globalOutflowBps = 2_000;
    p.idleBufferBps = 0;
    p.unstakeGas = 400_000;
}

/// `p` with Appendix B's launch values where they differ from the fixtures' (spec, Appendix B): outflow
/// 2,000 bps with a 10 TAO floor (the global 2,000 bps, the idle buffer, unstakeGas and the 1% / 0.015 TAO fee
/// ceiling are the fixtures' already), entries of 10 TAO and messages of 15 TAO, 44 TAO of assets, a 10% reward cut
/// (to `p.treasury`, which the caller names). The minimum direct deposit, which Appendix B does not fix, is
/// v3-launch's 0.01 TAO. The parties are `p`'s.
function withLaunchValues(CascadeVault.Params memory p) pure returns (CascadeVault.Params memory) {
    p.rewardCutBps = 1_000;
    p.minDailyOutflow = 10e18;
    p.maxEntryValue = 10e18;
    p.maxMessageValue = 15e18;
    p.maxTotalAssets = 44e18;
    p.minDirectDeposit = 0.01e18;
    return p;
}

// The front door's treasury in every fixture (Task 29): a fixed address with no code, which only `sweepPot`
// pays. A test that needs a treasury that refuses ETH names its own.
address constant DOOR_TREASURY = address(uint160(uint256(keccak256("cascade fixture: the front door's treasury"))));

// The front door's pool-depth floors in every fixture (Task 32): non-zero, so every delivery runs the check, against
// MockTwap's default depth (the uint128 maximum on both pools), which passes it. A test that thins a pool sets the
// mock's depth below these; the live-shaped fork fixtures name their own, below the live pools' depth (Task 61
// calibrates the launch value).
uint128 constant DOOR_TAO_WETH_FLOOR = 1e20;
uint128 constant DOOR_WETH_USDC_FLOOR = 1e17;

/// The parties a fixture names for a front door and the fixtures' values: v3.1's, which the suite's
/// assertions are written against (a 12 h batch interval, a 1 TAO minimum deposit, a 10,000 TAO deposit
/// cap, a 1e14 wei redeem-request fee, 50 deposits and 50 redeems a batch, 4,000 TAO of batch value, a
/// 1.5% delivery slippage), Base's calibrated 120 ms blocks (Revision 28), `DOOR_TREASURY` and the pool-depth
/// floors above. No oracle and no swapper: a fixture that delivers names its own.
function defaultFrontDoorParams(
    IERC20Metadata asset,
    ICascadeBridge bridge,
    uint64 vaultChain,
    address vault,
    IERC20 usdc,
    address owner,
    address guardian,
    address keeper
) pure returns (CascadeFrontDoor.Params memory p) {
    p.asset = asset;
    p.bridge = bridge;
    p.vaultChain = vaultChain;
    p.vault = vault;
    p.usdc = usdc;
    p.owner = owner;
    p.guardian = guardian;
    p.keeper = keeper;
    p.treasury = DOOR_TREASURY;
    p.minPoolLiquidity = [DOOR_TAO_WETH_FLOOR, DOOR_WETH_USDC_FLOOR];
    p.batchInterval = 12 hours;
    p.minDeposit = 1e18;
    p.depositCap = 10_000e18;
    p.redeemRequestFee = 1e14;
    p.maxDeposits = 50;
    p.maxRedeems = 50;
    p.maxBatchValue = 4_000e18;
    p.maxDeliverySlippageBps = 150;
    // the deploy's calibration (Revision 28): twice as fast as Base's 0.2-second blocks
    p.msPerBlock = 120;
}

/// `p` with Appendix B's launch values where they differ from the fixtures' (spec, Appendix B): a 1 h
/// batch interval, a 0.04 TAO minimum deposit, a 40 TAO deposit cap and 10 TAO of batch value. The
/// redeem-request fee (0.0001 ETH), the batch limits (50 + 50) and the delivery slippage (1.5%) are the
/// fixtures' already. The parties are `p`'s.
function withLaunchValues(CascadeFrontDoor.Params memory p) pure returns (CascadeFrontDoor.Params memory) {
    p.batchInterval = 1 hours;
    p.minDeposit = 0.04e18;
    p.depositCap = 40e18;
    p.maxBatchValue = 10e18;
    return p;
}

// The staker's fees in every fixture (Task 33): Appendix B's launch values, a 0.15% swap fee and a $0.05 deposit fee
// (50,000 USDC units).
uint16 constant STAKER_SWAP_FEE_BPS = 15;
uint256 constant STAKER_DEPOSIT_FEE_USDC = 50_000;

/// The parties a fixture names for a staker (its tokens, front door, owner and treasury), its route 0 (Uniswap's
/// router kind, active, through `router` along `buyPath` USDC -> TAO and `sellPath` TAO -> USDC), which is also its
/// delivery route (the only id the constructor can name: the route must be active), and the fees above. A fixture
/// with another first route or other fees changes the field.
function defaultStakerParams(
    IERC20Permit usdc,
    IERC20 tao,
    CascadeFrontDoor frontDoor,
    address owner,
    address treasury,
    address router,
    bytes memory buyPath,
    bytes memory sellPath
) pure returns (CascadeStaker.Params memory p) {
    p.usdc = usdc;
    p.tao = tao;
    p.frontDoor = frontDoor;
    p.owner = owner;
    p.treasury = treasury;
    p.route0 = CascadeStaker.Route(CascadeStaker.RouterKind.UniswapV3, router, buyPath, sellPath, true);
    p.deliveryRouteId = 0;
    p.swapFeeBps = STAKER_SWAP_FEE_BPS;
    p.depositFeeUsdc = STAKER_DEPOSIT_FEE_USDC;
}

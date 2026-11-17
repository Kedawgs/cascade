// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {CascadeFrontDoor} from "../src/CascadeFrontDoor.sol";
import {CascadeDoorLens} from "../src/lens/CascadeDoorLens.sol";
import {MockTAO} from "./mocks/MockTAO.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {StubBridge} from "./mocks/StubBridge.sol";
import {defaultFrontDoorParams} from "./utils/DefaultParams.sol";
import {Schedule} from "./governance/Schedule.sol";

/// @notice Shared front-door fixture: 18-decimal bridged TAO, 6-decimal USDC, an ERC-20-side stub
/// bridge charging 1e15 wei, and a front door on frontDoorParams() (a 12h interval, 1 TAO minimum,
/// 10,000 TAO cap, a 1e14 wei redeem-request fee and the keeper, all from the constructor), with the
/// door lens built on it. alice, bob and carol each hold 1,000 TAO (approved) and 1 ether.
abstract contract FrontDoorTestBase is Test {
    uint64 constant BITTENSOR = 964;

    /// The owner, and its key for signed stamps (stampBySig, spec §3.6): makeAddrAndKey("owner"), the
    /// address makeAddr("owner") gave, set in the constructor so every initializer and setUp can use both.
    address owner;
    uint256 ownerKey;
    address guardian = makeAddr("guardian");
    address keeper = makeAddr("keeper");
    address vault = makeAddr("vault");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    MockTAO tao;
    MockUSDC usdc;
    StubBridge bridge;
    CascadeFrontDoor fd;
    /// The read-only lens on `fd` (spec §8.1).
    CascadeDoorLens doorLens;
    uint256 fillerCount;

    constructor() {
        (owner, ownerKey) = makeAddrAndKey("owner");
    }

    function setUp() public virtual {
        tao = new MockTAO(18);
        usdc = new MockUSDC();
        bridge = new StubBridge(tao);
        bridge.setFee(1e15);
        beforeFrontDoor();
        fd = deployFrontDoor(frontDoorParams());
        doorLens = new CascadeDoorLens(address(fd));

        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < users.length; ++i) {
            tao.mint(users[i], 1_000e18);
            vm.prank(users[i]);
            tao.approve(address(fd), type(uint256).max);
            vm.deal(users[i], 1 ether);
        }
    }

    /// Runs once the tokens and the bridge exist, before the front door: a suite deploys here what its
    /// front door's constructor names (FrontDoorDelivery: the oracle and the swapper).
    function beforeFrontDoor() internal virtual {}

    /// The fixture's front door's constructor arguments (DefaultParams.sol), so a new door is
    /// `new CascadeFrontDoor(frontDoorParams())`; a suite overrides it to change a value for all its doors.
    function frontDoorParams() internal view virtual returns (CascadeFrontDoor.Params memory) {
        return defaultFrontDoorParams(tao, bridge, BITTENSOR, vault, usdc, owner, guardian, keeper);
    }

    /// The front door the fixture deploys on `p`: a CascadeFrontDoor, or in the lens parity tests a
    /// test-only subclass (DoorInternals) with the same constructor.
    function deployFrontDoor(CascadeFrontDoor.Params memory p) internal virtual returns (CascadeFrontDoor) {
        return new CascadeFrontDoor(p);
    }

    /// The address the next contract this test creates will have (its CREATE's).
    function nextAddress() internal view returns (address) {
        return vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
    }

    /// n fresh addresses on `door`, each dealt the door's redeem-request fee and requesting 1 share with it.
    function fillRedeems(CascadeFrontDoor door, uint256 n) internal {
        uint256 fee = door.redeemRequestFee();
        for (uint256 i; i < n; ++i) {
            address filler = makeAddr(string.concat("filler", vm.toString(++fillerCount)));
            vm.deal(filler, fee);
            vm.prank(filler);
            door.requestRedeem{value: fee}(1);
        }
    }

    /// Waits out `user`'s cancel cooldown on `fd` (R11): the clock to `fd.cancelableAt(user)` when that is still ahead.
    /// For the tests whose cancel follows a deposit and is not about the cooldown (FrontDoorBatches pins the cooldown
    /// and the view against the deposit's own time).
    function waitCancel(address user) internal {
        uint256 ready = fd.cancelableAt(user);
        if (vm.getBlockTimestamp() < ready) Schedule.warpTo(ready);
    }

    /// A first request in the open batch, paying the current redeemRequestFee as msg.value.
    function requestWithFee(address user, uint256 shares) internal {
        uint256 fee = fd.redeemRequestFee();
        vm.prank(user);
        fd.requestRedeem{value: fee}(shares);
    }
}

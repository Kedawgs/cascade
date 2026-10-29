// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CcipBaseAdapter} from "../../src/adapters/CcipBaseAdapter.sol";
import {CcipBittensorAdapter} from "../../src/adapters/CcipBittensorAdapter.sol";
import {IAlphaVault} from "../../src/interfaces/IAlphaVault.sol";
import {ICascadeBridge} from "../../src/interfaces/ICascadeBridge.sol";
import {ADDRESS_MAPPING_ADDRESS} from "../../src/interfaces/IAddressMapping.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";
import {MockAddressMapping} from "../mocks/MockAddressMapping.sol";
import {MockAlphaVault} from "../mocks/MockAlphaVault.sol";
import {MockRouter} from "../mocks/MockRouter.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {mirror} from "../mocks/Mirror.sol";

/// @notice Two "chains" in one EVM, joined by the two CCIP adapters over two mock routers: Base holds the
/// front door, its adapter and `taoBase` (the ERC-20); Bittensor holds the vault, its adapter, the alpha
/// vault and `taoBit` (the bridged token). Routers only record sends; tests relay them by hand with
/// `relayToBittensor` / `relayToBase`. Fee 1e15 each way; alice and bob hold 1_000 TAO on Base.
abstract contract AdaptersFixture is Test {
    uint64 constant BASE = 8453;
    uint64 constant BITTENSOR = 964;
    uint64 constant BASE_SELECTOR = 15971525489660198786;
    uint64 constant BITTENSOR_SELECTOR = 2135107236357186872;
    bytes32 constant HK1 = bytes32(uint256(1));
    uint256 constant ED = 1e12;
    uint256 constant FEE = 1e15;
    uint256 constant REQUEST_FEE = 1e14;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    MockStaking staking = MockStaking(ISTAKING_ADDRESS);
    MockTAO taoBase;
    MockUSDC usdcBase;
    MockTAO taoBit;
    MockRouter routerBase;
    MockRouter routerBit;
    MockAlphaVault av;
    CcipBaseAdapter adapterBase;
    CcipBittensorAdapter adapterBit;
    CascadeVault vault;
    CascadeFrontDoor fd;

    function setUp() public virtual {
        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        vm.etch(ADDRESS_MAPPING_ADDRESS, address(new MockAddressMapping()).code);
        staking.addHotkey(HK1);

        taoBase = new MockTAO(18);
        usdcBase = new MockUSDC();
        routerBase = new MockRouter(taoBase);
        routerBase.setFee(FEE);
        taoBit = new MockTAO(18);
        routerBit = new MockRouter(taoBit);
        routerBit.setFee(FEE);
        av = new MockAlphaVault(taoBit);
        vm.deal(address(av), 1_000e18);

        // deployment order: adapterBase, adapterBit, vault, fd
        uint256 nonce = vm.getNonce(address(this));
        address pAdapterBase = vm.computeCreateAddress(address(this), nonce);
        address pAdapterBit = vm.computeCreateAddress(address(this), nonce + 1);
        address pVault = vm.computeCreateAddress(address(this), nonce + 2);
        address pFd = vm.computeCreateAddress(address(this), nonce + 3);

        adapterBase = new CcipBaseAdapter(
            CcipAdapterBase.Config({
                router: address(routerBase),
                token: address(taoBase),
                localChainId: BASE,
                remoteChainId: BITTENSOR,
                remoteSelector: BITTENSOR_SELECTOR,
                remoteAdapter: pAdapterBit,
                gasBase: 1_000_000,
                gasPerEntry: 25_000,
                maxMessageValue: 5_000e18
            }),
            0.01e18
        );
        adapterBit = new CcipBittensorAdapter(
            CcipAdapterBase.Config({
                router: address(routerBit),
                token: address(taoBit),
                localChainId: BITTENSOR,
                remoteChainId: BASE,
                remoteSelector: BASE_SELECTOR,
                remoteAdapter: pAdapterBase,
                gasBase: 1_000_000,
                gasPerEntry: 25_000,
                maxMessageValue: 5_000e18
            }),
            IAlphaVault(address(av))
        );
        // the front door is named at deploy, as the deployment does, so it is active with no delay
        vault = new CascadeVault(
            mirror(pVault), HK1, ICascadeBridge(address(adapterBit)), owner, guardian, 1e15, BASE, pFd
        );
        fd = newFrontDoor();
        assertEq(address(adapterBase), pAdapterBase);
        assertEq(address(adapterBit), pAdapterBit);
        assertEq(address(vault), pVault);
        assertEq(address(fd), pFd);

        // the operator funds the vault's existential reserve and the adapter's native reserve
        vm.deal(address(vault), ED);
        vm.deal(address(this), 1 ether);
        adapterBit.fundReserve{value: ED}();
        vm.prank(owner);
        vault.setKeeper(keeper);

        address[2] memory users = [alice, bob];
        for (uint256 i; i < users.length; ++i) {
            taoBase.mint(users[i], 1_000e18);
            vm.prank(users[i]);
            taoBase.approve(address(fd), type(uint256).max);
            vm.deal(users[i], 1 ether);
        }
        vm.deal(keeper, 1 ether);
    }

    // ---- relay ----

    /// Delivers router `from`'s send number `sendIndex` to `toAdapter` through router `to`, minting the
    /// token on the destination side as the real network would.
    function relay(
        MockRouter from,
        MockRouter to,
        address toAdapter,
        address fromAdapter,
        uint64 fromSelector,
        uint256 sendIndex
    ) internal returns (bool ok, bytes memory reason) {
        MockRouter.Sent memory s = from.sendAt(sendIndex);
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](s.tokenAmounts.length);
        for (uint256 i; i < t.length; ++i) {
            t[i] = Client.EVMTokenAmount(address(to.token()), s.tokenAmounts[i].amount);
        }
        Client.Any2EVMMessage memory m =
            Client.Any2EVMMessage(s.messageId, fromSelector, abi.encode(fromAdapter), s.data, t);
        (, ok, reason) = to.deliver(toAdapter, m, to.gasLimitOf(s.extraArgs));
    }

    function relayToBittensor(uint256 i) internal returns (bool, bytes memory) {
        return relay(routerBase, routerBit, address(adapterBit), address(adapterBase), BASE_SELECTOR, i);
    }

    function relayToBase(uint256 i) internal returns (bool, bytes memory) {
        return relay(routerBit, routerBase, address(adapterBase), address(adapterBit), BITTENSOR_SELECTOR, i);
    }

    /// The adapter's own revert data, unwrapped from the router's DeliveryFailed(bytes).
    function inner(bytes memory reason) internal pure returns (bytes memory out) {
        bytes memory body = new bytes(reason.length - 4);
        for (uint256 i; i < body.length; ++i) {
            body[i] = reason[i + 4];
        }
        out = abi.decode(body, (bytes));
    }

    // ---- lifecycle helpers ----

    function newFrontDoor() internal returns (CascadeFrontDoor) {
        return new CascadeFrontDoor(
            taoBase,
            adapterBase,
            BITTENSOR,
            address(vault),
            owner,
            guardian,
            12 hours,
            0.01e18,
            10_000e18,
            REQUEST_FEE,
            usdcBase
        );
    }

    function registerFrontDoor(uint64 chain, address addr) internal {
        vm.prank(owner);
        vault.proposeFrontDoor(chain, addr);
        vm.warp(block.timestamp + 7 days);
        vm.prank(owner);
        vault.activateFrontDoor(chain, addr);
    }

    function depositVia(CascadeFrontDoor door, address user, uint256 amount) internal {
        vm.prank(user);
        door.deposit(amount);
    }

    function requestVia(CascadeFrontDoor door, address user, uint256 shares) internal {
        vm.prank(user);
        door.requestRedeem{value: REQUEST_FEE}(shares);
    }

    /// Closes `door`'s open batch, warping to its due time first if needed; the keeper pays the router fee.
    /// The send is only recorded; relay it with `relayToBittensor`.
    function close(CascadeFrontDoor door) internal {
        (, uint64 start,,,,) = door.openBatch();
        // test-controlled time
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < uint256(start) + 12 hours) vm.warp(uint256(start) + 12 hours);
        vm.prank(keeper);
        door.closeBatch{value: FEE}();
    }

    /// The batch key by its formula, independent of the vault.
    function keyOf(
        uint64 chain,
        address door,
        uint64 batchId,
        CascadeMessages.Entry[] memory deposits,
        CascadeMessages.Entry[] memory redeems
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(chain, door, keccak256(CascadeMessages.encodeBatch(batchId, deposits, redeems))));
    }

    function entries1(address user, uint256 amount) internal pure returns (CascadeMessages.Entry[] memory e) {
        e = new CascadeMessages.Entry[](1);
        e[0] = CascadeMessages.Entry(user, amount);
    }

    function noEntries() internal pure returns (CascadeMessages.Entry[] memory) {
        return new CascadeMessages.Entry[](0);
    }

    /// The keeper's view: batch `key`'s ordered payout list, rebuilt from the vault's Redeemed events.
    function redeemedList(Vm.Log[] memory logs, bytes32 key)
        internal
        view
        returns (CascadeMessages.Payout[] memory list)
    {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (isRedeemed(logs[i], key)) ++n;
        }
        list = new CascadeMessages.Payout[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (!isRedeemed(logs[i], key)) continue;
            (uint256 shares, uint256 assets) = abi.decode(logs[i].data, (uint256, uint256));
            // casting to 'uint160' is safe because the topic is an indexed address
            // forge-lint: disable-next-line(unsafe-typecast)
            list[n++] = CascadeMessages.Payout(address(uint160(uint256(logs[i].topics[2]))), shares, assets);
        }
    }

    function isRedeemed(Vm.Log memory log, bytes32 key) internal view returns (bool) {
        return log.emitter == address(vault) && log.topics.length > 2 && log.topics[0] == CascadeVault.Redeemed.selector
            && log.topics[1] == key;
    }

    /// A deposit of `amount` by `user` through `door`, closed and relayed as the router's send `sendIndex`.
    function depositAndRelay(CascadeFrontDoor door, address user, uint256 amount, uint256 sendIndex) internal {
        depositVia(door, user, amount);
        close(door);
        (bool ok,) = relayToBittensor(sendIndex);
        assertTrue(ok, "deposit relay");
    }

    /// Requests `shares` for `user` through `door` as batch `batchId`, closes it, relays it as send
    /// `sendIndex`, and returns the batch key and the keeper's payout list.
    function redeemAndRelay(CascadeFrontDoor door, address user, uint256 shares, uint64 batchId, uint256 sendIndex)
        internal
        returns (bytes32 key, CascadeMessages.Payout[] memory list)
    {
        requestVia(door, user, shares);
        key = keyOf(BASE, address(door), batchId, noEntries(), entries1(user, shares));
        close(door);
        vm.recordLogs();
        (bool ok,) = relayToBittensor(sendIndex);
        assertTrue(ok, "redeem relay");
        list = redeemedList(vm.getRecordedLogs(), key);
    }

    /// Neither adapter keeps tokens, the Base adapter keeps no native value, and the Bittensor adapter
    /// holds exactly `bitNative` (its reserve plus any fee surplus).
    function assertAdaptersHold(uint256 bitNative) internal view {
        assertEq(taoBase.balanceOf(address(adapterBase)), 0, "adapterBase tokens");
        assertEq(taoBit.balanceOf(address(adapterBit)), 0, "adapterBit tokens");
        assertEq(address(adapterBase).balance, 0, "adapterBase native");
        assertEq(address(adapterBit).balance, bitNative, "adapterBit native");
    }

    /// The keeper pays out `key` after the payout delay; the send is recorded on `routerBit`.
    function pay(bytes32 key, CascadeMessages.Payout[] memory list) internal {
        vm.warp(block.timestamp + vault.payoutDelay());
        vm.prank(keeper);
        vault.processPayouts(key, list, 50);
    }
}

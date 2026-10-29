// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Vm} from "forge-std/Vm.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CcipBittensorAdapter} from "../../src/adapters/CcipBittensorAdapter.sol";
import {ADDRESS_MAPPING_ADDRESS} from "../../src/interfaces/IAddressMapping.sol";
import {IAlphaVault} from "../../src/interfaces/IAlphaVault.sol";
import {ICascadeBridge} from "../../src/interfaces/ICascadeBridge.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";
import {mirror} from "../mocks/Mirror.sol";
import {MockAddressMapping} from "../mocks/MockAddressMapping.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MessageV1Codec} from "../vendor/ccip/MessageV1Codec.sol";
import {ForkBase, IOffRamp20, IPoolView, IRouterView, ITypeAndVersion} from "./ForkBase.sol";

/// @notice The Bittensor adapter and vault against the live CCIP lane on a Bittensor EVM fork: deliveries
/// come in through the real OffRamp 2.0.0 (verifiers stubbed), Router and LockRelease pool and are
/// converted by ForeverMoney's real AlphaVault; payouts go out through the real AlphaVault, Router,
/// OnRamp 2.0.0 and pool. The forked EVM has no Bittensor precompiles, so `MockStaking` and
/// `MockAddressMapping` are etched at their addresses and the AlphaVault's position is seeded there.
/// Run with `FORK=1` (optionally `BITTENSOR_RPC=<url>`).
contract BittensorForkTest is ForkBase {
    uint64 constant BASE = 8453;
    uint64 constant BITTENSOR = 964;
    bytes32 constant HK1 = bytes32(uint256(1));
    /// The vault's existential reserve and the adapter's native reserve, both 1e12 wei.
    uint256 constant ED = 1e12;
    uint256 constant RESERVE = 1e12;
    /// The AlphaVault's TAO position as seeded in the staking mock, in rao (20,000 TAO).
    uint256 constant AV_SEED_RAO = 20_000e9;

    address owner = makeAddr("owner");
    address guardian = makeAddr("guardian");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice");
    address fdAddr = makeAddr("frontDoor");
    address remoteAdapter = makeAddr("adapterBase");

    MockStaking staking = MockStaking(ISTAKING_ADDRESS);
    IERC20 tao = IERC20(BIT_TAO);
    address offRamp;
    bytes32 validator;
    bytes32 avColdkey;
    CcipBittensorAdapter adapterBit;
    CascadeVault vault;

    function setUp() public {
        forkFrom("BITTENSOR_RPC", "https://lite.chain.opentensor.ai");
        if (!isFork()) return;
        // Bittensor's (Frontier) block header carries no prevrandao, which the Cancun EVM requires
        vm.prevrandao(bytes32(uint256(1)));
        emit log_named_uint("fork block", block.number);
        offRamp = offRamp20(BIT_ROUTER, BASE_SELECTOR);

        // precompile mocks: the forked EVM has none. The staking mock moves native TAO with vm.deal, and
        // a fork lets an account that exists on the remote chain use cheatcodes only when allowed.
        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        vm.allowCheatcodes(ISTAKING_ADDRESS);
        vm.etch(ADDRESS_MAPPING_ADDRESS, address(new MockAddressMapping()).code);

        // the real AlphaVault's TAO position, read and moved through the staking mock under its own coldkey
        uint256 netuid;
        (validator, netuid) = IAlphaVault(ALPHA_VAULT).positionOf(BIT_TAO);
        assertEq(netuid, 0, "TAO position on root");
        avColdkey = IAlphaVault(ALPHA_VAULT).vaultColdkey();
        staking.addHotkey(validator);
        staking.setColdkeyAlias(ALPHA_VAULT, avColdkey);
        staking.donateStake(validator, avColdkey, AV_SEED_RAO);
        staking.setOneRaoShort(false);
        staking.addHotkey(HK1);

        // deployment order: adapterBit, vault (the vault's coldkey is its own address's mirror)
        uint256 nonce = vm.getNonce(address(this));
        address pAdapterBit = vm.computeCreateAddress(address(this), nonce);
        address pVault = vm.computeCreateAddress(address(this), nonce + 1);
        adapterBit = new CcipBittensorAdapter(
            CcipAdapterBase.Config({
                router: BIT_ROUTER,
                token: BIT_TAO,
                localChainId: BITTENSOR,
                remoteChainId: BASE,
                remoteSelector: BASE_SELECTOR,
                remoteAdapter: remoteAdapter,
                gasBase: 1_000_000,
                gasPerEntry: 25_000,
                maxMessageValue: 5_000e18
            }),
            IAlphaVault(ALPHA_VAULT)
        );
        // the Base front door is named at deploy, as the deployment does, so it is active with no delay
        vault = new CascadeVault(
            mirror(pVault), HK1, ICascadeBridge(address(adapterBit)), owner, guardian, 1e15, BASE, fdAddr
        );
        assertEq(address(adapterBit), pAdapterBit, "adapter address");
        assertEq(address(vault), pVault, "vault address");

        // the operator funds the vault's existential reserve and the adapter's native reserve
        vm.deal(address(vault), ED);
        vm.deal(address(this), 1 ether);
        adapterBit.fundReserve{value: RESERVE}();
        vm.prank(owner);
        vault.setKeeper(keeper);
    }

    // ---- lane limits ----

    function test_fork_limitsMatchSpec() public onlyFork {
        (uint256 maxDataBytes, uint256 maxPerMsgGasLimit) = destChainLimits(BIT_ONRAMP, BASE_SELECTOR);
        assertEq(maxDataBytes, 32_000, "maxDataBytes");
        assertEq(maxPerMsgGasLimit, 15_000_000, "maxPerMsgGasLimit");
        assertEq(
            IPoolView(BIT_POOL).getCurrentOutboundRateLimiterState(BASE_SELECTOR).capacity,
            5_000e18,
            "pool outbound capacity"
        );
        assertEq(offRamp20(BIT_ROUTER, BASE_SELECTOR), BIT_OFFRAMP, "OffRamp 2.0.0");
        assertEq(ITypeAndVersion(BIT_ONRAMP).typeAndVersion(), "OnRamp 2.0.0", "OnRamp version");
        assertEq(IRouterView(BIT_ROUTER).getOnRamp(BASE_SELECTOR), BIT_ONRAMP, "router's OnRamp");
        assertEq(IERC20Metadata(BIT_TAO).decimals(), 18, "bridged TAO decimals");
        assertFalse(IAlphaVault(ALPHA_VAULT).isPaused(), "AlphaVault not halted");
        assertTrue(IAlphaVault(ALPHA_VAULT).isListed(BIT_TAO), "AlphaVault lists bridged TAO");
    }

    // ---- receiving ----

    function test_fork_batchDeliveredThroughRealOffRampAndAlphaVault() public onlyFork {
        uint256 poolBefore = tao.balanceOf(BIT_POOL);
        uint256 supplyBefore = tao.totalSupply();
        uint256 avNativeBefore = ALPHA_VAULT.balance;

        (bytes32 id, bool ok, bytes memory err) = execute(offRamp, fromBase(depositBatch(), 1e18));

        assertEq(err, "", "no error");
        assertTrue(ok, "executed");
        assertEq(IOffRamp20(offRamp).getExecutionState(id), SUCCESS, "state");
        assertEq(tao.balanceOf(BIT_POOL), poolBefore - 1e18, "LockRelease pool released the deposit");
        assertEq(tao.totalSupply(), supplyBefore - 1e18, "AlphaVault burned it");
        assertEq(staking.getStake(validator, avColdkey, 0), AV_SEED_RAO - 1e9, "AlphaVault unstaked 1 TAO");
        assertEq(ALPHA_VAULT.balance, avNativeBefore, "AlphaVault passed the TAO on");
        assertEq(vault.balanceOf(alice), 1e24, "alice's shares at the launch price");
        assertEq(address(vault).balance, ED + 1e18, "vault holds the deposit");
        assertEq(tao.balanceOf(address(adapterBit)), 0, "adapter holds no tokens");
        assertEq(address(adapterBit).balance, RESERVE, "adapter holds its reserve");

        // delivery does not stake; the keeper does
        assertEq(staking.getStake(HK1, vault.coldkey(), 0), 0, "nothing staked on delivery");
        vm.prank(keeper);
        vault.stakeIdle();
        assertEq(staking.getStake(HK1, vault.coldkey(), 0), 1e9, "vault stake (rao)");
        assertEq(address(vault).balance, ED, "vault keeps its reserve");
    }

    function test_fork_pausedAlphaVaultFailsAndRetries() public onlyFork {
        MessageV1Codec.MessageV1 memory m = fromBase(depositBatch(), 1e18);
        uint256 poolBefore = tao.balanceOf(BIT_POOL);
        uint256 supplyBefore = tao.totalSupply();

        // ForeverMoney halted: the real AlphaVault reverts IsHalted() on withdrawLiquid
        bytes memory halted = abi.encodeWithSignature("IsHalted()");
        vm.mockCallRevert(ALPHA_VAULT, abi.encodeWithSelector(IAlphaVault.withdrawLiquid.selector), halted);
        (bytes32 id, bool ok, bytes memory err) = execute(offRamp, m);

        assertFalse(ok, "first attempt failed");
        assertEq(IOffRamp20(offRamp).getExecutionState(id), FAILURE, "state FAILURE");
        assertEq(err, abi.encodeWithSignature("ReceiverError(bytes)", halted), "AlphaVault's revert, wrapped");
        assertEq(tao.balanceOf(BIT_POOL), poolBefore, "release rolled back");
        assertEq(tao.totalSupply(), supplyBefore, "nothing burned");
        assertEq(tao.balanceOf(address(adapterBit)), 0, "adapter holds no tokens");
        assertEq(address(adapterBit).balance, RESERVE, "adapter holds its reserve");
        assertEq(vault.balanceOf(alice), 0, "no shares");
        assertEq(vault.totalSupply(), 0, "no supply");
        assertEq(address(vault).balance, ED, "vault unchanged");

        // ForeverMoney resumes; anyone re-executes the same message
        vm.clearMockedCalls();
        (bytes32 id2, bool ok2, bytes memory err2) = execute(offRamp, m);

        assertEq(id2, id, "same message");
        assertEq(err2, "", "no error");
        assertTrue(ok2, "retry executed");
        assertEq(IOffRamp20(offRamp).getExecutionState(id), SUCCESS, "state SUCCESS");
        assertEq(tao.balanceOf(BIT_POOL), poolBefore - 1e18, "released once");
        assertEq(tao.totalSupply(), supplyBefore - 1e18, "burned once");
        assertEq(tao.balanceOf(address(adapterBit)), 0, "adapter holds no tokens");
        assertEq(address(adapterBit).balance, RESERVE, "adapter holds its reserve");
        assertEq(vault.balanceOf(alice), 1e24, "alice's shares");
        assertEq(address(vault).balance, ED + 1e18, "vault holds the deposit");
    }

    function test_fork_receiverGasMeasured() public onlyFork {
        bytes memory batch = depositBatch();
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](1);
        t[0] = Client.EVMTokenAmount(BIT_TAO, 1e18);
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: keccak256("gas"),
            sourceChainSelector: BASE_SELECTOR,
            sender: abi.encode(remoteAdapter),
            data: adapterBit.encodePayload(address(vault), fdAddr, batch),
            destTokenAmounts: t
        });
        // what the pool would have released to the adapter
        deal(BIT_TAO, address(adapterBit), 1e18);

        vm.prank(BIT_ROUTER);
        uint256 g = gasleft();
        adapterBit.ccipReceive(m);
        g -= gasleft();

        emit log_named_uint("receiver gas 1+0 (mock precompile)", g);
        assertEq(vault.balanceOf(alice), 1e24, "delivered");
        assertEq(tao.balanceOf(address(adapterBit)), 0, "converted");
        assertLt(g, adapterBit.gasFor(batch), "within the adapter's own gas limit");
    }

    // ---- sending ----

    function test_fork_payoutThroughRealAlphaVaultAndPool() public onlyFork {
        (bytes32 key, CascadeMessages.Payout[] memory payouts) = depositThenRedeemAll();
        vm.warp(block.timestamp + vault.payoutDelay());
        (uint256 fee, uint256 net, uint256 quote, bytes memory payoutsMessage) = vaultFee(key, payouts[0].assets);
        Snapshot memory before = snapshot();

        vm.recordLogs();
        vm.prank(keeper);
        vault.processPayouts(key, payouts, 10);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (uint256 chunkNet, uint256 chunkFee) = payoutChunk(logs, key);
        assertEq(chunkNet, net, "vault sent net");
        assertEq(chunkFee, fee, "vault paid the rounded fee");
        assertEq(sentFee(logs), quote, "Sent fee == live quote");
        assertEq(tao.balanceOf(BIT_POOL), before.pool + net, "LockRelease pool locked the payout");
        assertEq(tao.totalSupply(), before.supply + net, "AlphaVault minted it");
        assertEq(staking.getStake(validator, avColdkey, 0), before.avStake + net / 1e9, "AlphaVault staked it");
        assertEq(tao.balanceOf(address(adapterBit)), 0, "adapter holds no tokens");
        assertEq(tao.allowance(address(adapterBit), BIT_ROUTER), 0, "approval cleared");
        assertEq(address(adapterBit).balance, RESERVE + (fee - quote), "adapter keeps the rounding surplus");
        assertEq(before.wrapped.balance - before.wrappedNative, quote, "router wrapped exactly the fee");
        assertEq(BIT_ROUTER.balance, before.router, "router keeps no TAO");
        assertEq(staking.getStake(HK1, vault.coldkey(), 0), 0, "vault unstaked the payout");
        assertEq(address(vault).balance, ED, "vault keeps its reserve");
        assertEq(vault.pendingPayouts(), 0, "nothing pending");
        assertPayoutSent(logs, adapterBit.encodePayload(fdAddr, address(vault), payoutsMessage), net);
    }

    function test_fork_subFloorQuoteReverts() public onlyFork {
        assertEq(adapterBit.floor(), 2e15, "floor from the precompile's default min stake");
        vm.expectRevert(abi.encodeWithSelector(CcipAdapterBase.BelowConversionFloor.selector, 1e15, 2e15));
        adapterBit.quoteFee(BASE, fdAddr, CascadeMessages.encodePayouts(bytes32(0), 0, entries1(alice, 1e15)), 1e15);
    }

    // ---- helpers ----

    /// Balances the payout moves, taken before it.
    struct Snapshot {
        uint256 pool;
        uint256 supply;
        uint256 avStake;
        address wrapped;
        uint256 wrappedNative;
        uint256 router;
    }

    function snapshot() internal view returns (Snapshot memory s) {
        s.pool = tao.balanceOf(BIT_POOL);
        s.supply = tao.totalSupply();
        s.avStake = staking.getStake(validator, avColdkey, 0);
        s.wrapped = IRouterView(BIT_ROUTER).getWrappedNative();
        s.wrappedNative = s.wrapped.balance;
        s.router = BIT_ROUTER.balance;
    }

    /// Alice deposits 1 TAO (batch 1), the keeper stakes it, then batch 2 (no token, data only) redeems
    /// all her shares. Returns batch 2's key and its payout list, rebuilt from the vault's Redeemed events.
    function depositThenRedeemAll() internal returns (bytes32 key, CascadeMessages.Payout[] memory payouts) {
        (, bool ok,) = execute(offRamp, fromBase(depositBatch(), 1e18));
        assertTrue(ok, "deposit delivered");
        vm.prank(keeper);
        vault.stakeIdle();

        uint256 shares = vault.balanceOf(alice);
        bytes memory batch2 = CascadeMessages.encodeBatch(2, noEntries(), entries1(alice, shares));
        key = keccak256(abi.encode(BASE, fdAddr, keccak256(batch2)));
        (, bool ok2, bytes memory err, Vm.Log[] memory logs) = executeLogged(offRamp, fromBase(batch2, 0));
        assertEq(err, "", "no error");
        assertTrue(ok2, "redeem delivered");
        payouts = redeemedList(logs, key);
        assertEq(payouts.length, 1, "one payout");
        assertEq(payouts[0].user, alice, "payout user");
        assertEq(payouts[0].shares, shares, "all shares burned");
        assertEq(payouts[0].assets, 1e18, "worth 1 TAO");
        assertEq(vault.balanceOf(alice), 0, "alice burned");
    }

    /// The vault's fee for a 1-entry chunk worth `sum`, as `processPayouts` computes it: quoted on the
    /// gross message, rounded up to whole rao, taken off the entry. Also the live quote for the net
    /// message the vault then sends, and that message.
    function vaultFee(bytes32 key, uint256 sum)
        internal
        returns (uint256 fee, uint256 net, uint256 quote, bytes memory payoutsMessage)
    {
        vm.prank(address(vault));
        uint256 grossQuote =
            adapterBit.quoteFee(BASE, fdAddr, CascadeMessages.encodePayouts(key, 0, entries1(alice, sum)), sum);
        fee = Math.ceilDiv(grossQuote, 1e9) * 1e9;
        net = sum - fee;
        payoutsMessage = CascadeMessages.encodePayouts(key, 0, entries1(alice, net));
        vm.prank(address(vault));
        quote = adapterBit.quoteFee(BASE, fdAddr, payoutsMessage, net);
        assertGt(quote, 0, "live quote");
        emit log_named_uint("payout fee quote (wei)", quote);
    }

    /// Batch 1: alice deposits 1 TAO, no redeems.
    function depositBatch() internal view returns (bytes memory) {
        return CascadeMessages.encodeBatch(1, entries1(alice, 1e18), noEntries());
    }

    /// A message from the Base adapter (the front door's batch for the vault) through the Bittensor adapter,
    /// carrying `amount` bridged TAO with the source pool's decimals as the real OnRamp sends them, and the
    /// adapter's own gas limit for `batch`.
    function fromBase(bytes memory batch, uint256 amount) internal view returns (MessageV1Codec.MessageV1 memory m) {
        m = message(
            BASE_SELECTOR,
            BITTENSOR_SELECTOR,
            BASE_ONRAMP,
            offRamp,
            remoteAdapter,
            address(adapterBit),
            BASE_POOL,
            BASE_TAO,
            BIT_TAO,
            amount,
            "",
            0
        );
        // set after the call: twelve arguments plus these locals do not fit the stack
        if (amount > 0) m.tokenTransfer[0].extraData = abi.encode(uint256(18));
        m.data = adapterBit.encodePayload(address(vault), fdAddr, batch);
        // gasFor never exceeds GAS_CAP (7_000_000), which fits in uint32
        // forge-lint: disable-next-line(unsafe-typecast)
        m.ccipReceiveGasLimit = uint32(adapterBit.gasFor(batch));
    }

    /// The real OnRamp's message for a 1-entry payout of `amount`: the remote (Base) adapter is receiver
    /// and token receiver, the Base OffRamp the off-ramp.
    function assertPayoutSent(Vm.Log[] memory logs, bytes memory payload, uint256 amount) internal view {
        MessageV1Codec.MessageV1 memory sent = sentMessage(logs, BIT_ONRAMP);
        assertEq(sent.sourceChainSelector, BITTENSOR_SELECTOR, "source selector");
        assertEq(sent.destChainSelector, BASE_SELECTOR, "dest selector");
        assertEq(sent.ccipReceiveGasLimit, 1_025_000, "receiver gas: gasBase + 1 entry");
        assertEq(sent.finality, bytes4(0), "wait for finality");
        assertEq(sent.onRampAddress, abi.encode(BIT_ONRAMP), "onRamp");
        assertEq(sent.offRampAddress, abi.encodePacked(BASE_OFFRAMP), "offRamp");
        assertEq(sent.sender, abi.encode(address(adapterBit)), "sender");
        assertEq(sent.receiver, abi.encodePacked(remoteAdapter), "receiver");
        assertEq(sent.data, payload, "data");
        assertEq(sent.tokenTransfer.length, 1, "one token");
        assertEq(sent.tokenTransfer[0].amount, amount, "amount");
        assertEq(sent.tokenTransfer[0].sourcePoolAddress, abi.encode(BIT_POOL), "source pool");
        assertEq(sent.tokenTransfer[0].sourceTokenAddress, abi.encode(BIT_TAO), "source token");
        assertEq(sent.tokenTransfer[0].destTokenAddress, abi.encodePacked(BASE_TAO), "dest token");
        assertEq(sent.tokenTransfer[0].tokenReceiver, abi.encodePacked(remoteAdapter), "token receiver");
        assertEq(sent.tokenTransfer[0].extraData, abi.encode(uint256(18)), "source decimals");
    }

    /// The fee in the Bittensor adapter's single Sent event among `logs`.
    function sentFee(Vm.Log[] memory logs) internal view returns (uint256 fee) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(adapterBit) || logs[i].topics[0] != CcipAdapterBase.Sent.selector) {
                continue;
            }
            (,, fee,) = abi.decode(logs[i].data, (uint64, uint256, uint256, uint256));
            ++n;
        }
        assertEq(n, 1, "one Sent event");
    }

    /// `net` and `fee` of the vault's single PayoutChunkSent event for `key` among `logs`.
    function payoutChunk(Vm.Log[] memory logs, bytes32 key) internal view returns (uint256 net, uint256 fee) {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter != address(vault) || logs[i].topics[0] != CascadeVault.PayoutChunkSent.selector
                    || logs[i].topics[1] != key
            ) continue;
            (,,, net, fee) = abi.decode(logs[i].data, (uint32, uint32, uint256, uint256, uint256));
            ++n;
        }
        assertEq(n, 1, "one PayoutChunkSent event");
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
            (uint256 s, uint256 a) = abi.decode(logs[i].data, (uint256, uint256));
            // casting to 'uint160' is safe because the topic is an indexed address
            // forge-lint: disable-next-line(unsafe-typecast)
            list[n++] = CascadeMessages.Payout(address(uint160(uint256(logs[i].topics[2]))), s, a);
        }
    }

    function isRedeemed(Vm.Log memory log, bytes32 key) internal view returns (bool) {
        return log.emitter == address(vault) && log.topics.length > 2 && log.topics[0] == CascadeVault.Redeemed.selector
            && log.topics[1] == key;
    }

    function entries1(address user, uint256 amount) internal pure returns (CascadeMessages.Entry[] memory e) {
        e = new CascadeMessages.Entry[](1);
        e[0] = CascadeMessages.Entry(user, amount);
    }

    function noEntries() internal pure returns (CascadeMessages.Entry[] memory) {
        return new CascadeMessages.Entry[](0);
    }
}

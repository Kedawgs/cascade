// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Vm} from "forge-std/Vm.sol";
import {CascadeBase} from "../../src/CascadeBase.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {CcipAdapterBase} from "../../src/adapters/CcipAdapterBase.sol";
import {CcipBittensorAdapter} from "../../src/adapters/CcipBittensorAdapter.sol";
import {ADDRESS_MAPPING_ADDRESS} from "../../src/interfaces/IAddressMapping.sol";
import {IAlphaVault} from "../../src/interfaces/IAlphaVault.sol";
import {ICascadeBridge} from "../../src/interfaces/ICascadeBridge.sol";
import {IStaking, ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Redeemed} from "../../src/CascadeEvents.sol";
import {Schedule} from "../governance/Schedule.sol";
import {mirror} from "../mocks/Mirror.sol";
import {MockAddressMapping} from "../mocks/MockAddressMapping.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {defaultVaultParams} from "../utils/DefaultParams.sol";
import {MessageV1Codec} from "../vendor/ccip/MessageV1Codec.sol";
import {ForkBase, IOffRamp20} from "./ForkBase.sol";
import {ColdRuns, StakingTap, TAP_BURN_SELECTOR_SLOT, TAP_EAT_SLOT, TAP_REMOVAL_LEFT_SLOT} from "./GasProbes.sol";

/// @notice Cascade v3.2 on a Bittensor EVM fork (Task 61, spec §9.2's fork rehearsal): the vault and the Bittensor adapter
/// at the launch gas pairs behind the deployed CCIP lane, every delivery through the real `OffRamp 2.0.0` (verifiers
/// stubbed), Router and LockRelease pool, converted by ForeverMoney's real `AlphaVault`, and every payout and refund out
/// through the real AlphaVault, Router, `OnRamp 2.0.0` and pool. The forked EVM has no Bittensor precompiles, so
/// `MockStaking` and `MockAddressMapping` are etched at their addresses and the AlphaVault's position is seeded there.
/// The parks (a token park with the burn rolled back, a paused vault's native park, the keeper's deliverParked of both),
/// the two 1-rao tolerances under the real AlphaVault, the rail reads' gas, the delivery model at its limit, the work
/// after the walk with the real send (EXIT_GAS_RESERVE) and a day of payouts against the keeper's spend cap, a rail
/// switch with a batch in flight, and the runtime's version. setUp seeds 50 holders (20 TAO each, staked, held a day),
/// a transaction of its own, so every test starts cold. Run with `FORK=1` (optionally `BITTENSOR_RPC=<url>`, a local
/// anvil cache of the archive node: README, Fork tests).
contract BittensorForkV32Test is ForkBase, ColdRuns {
    uint64 constant BASE = 8453;
    uint64 constant BITTENSOR = 964;
    bytes32 constant HK1 = bytes32(uint256(1));
    uint256 constant ED = 1e12;
    /// The AlphaVault's TAO position as seeded in the staking mock, in rao (20,000 TAO).
    uint256 constant AV_SEED_RAO = 20_000e9;
    /// The launch gas pairs (Appendix B, ops settings): toward Bittensor (the Base adapter's own, the Bittensor adapter's
    /// inbound model, PARK_GAS_RESERVE inside it) and toward Base (the Bittensor adapter's own, raised at Task 65 from
    /// 140,000 / 29,900, the T61a review's I-2).
    uint256 constant INBOUND_BASE = 1_300_000;
    uint256 constant INBOUND_PER_ENTRY = 57_000;
    uint256 constant TO_BASE_BASE = 180_000;
    uint256 constant TO_BASE_PER_ENTRY = 32_000;
    /// AdapterGas's allowance for the real precompile calls of a delivery the mock does not charge for (a real
    /// removeStake measured 144,811 gas; bittensor_evm_home_chain.md).
    uint256 constant PRECOMPILE_ALLOWANCE = 300_000;
    uint256 constant PARK_GAS_RESERVE = 150_000;
    /// CascadeConstants.EXIT_GAS_RESERVE, restated (2,000,000 since Task 65).
    uint256 constant EXIT_GAS_RESERVE = 2_000_000;
    /// What the live precompile adds to the work after the walk over the mock's, rounded up (AdapterGas'
    /// LIVE_EXIT_ALLOWANCE: ForeverMoney's addStake and the walk's last getStake, the T61a review's live estimates).
    uint256 constant LIVE_EXIT_ALLOWANCE = 150_000;
    /// The seeded holders: 50 addresses from 0x1000, 20 TAO each.
    uint256 constant HOLDERS = 50;

    address owner = makeAddr("v32 owner");
    address guardian = makeAddr("v32 guardian");
    address keeper = makeAddr("v32 keeper");
    address treasury = makeAddr("v32 treasury");
    address fdAddr = makeAddr("v32 frontDoor");
    address remoteAdapter = makeAddr("v32 adapterBase");

    MockStaking staking = MockStaking(ISTAKING_ADDRESS);
    IERC20 tao = IERC20(BIT_TAO);
    address offRamp;
    bytes32 validator;
    bytes32 avColdkey;
    CcipBittensorAdapter adapterBit;
    CascadeVault vault;
    CascadeVaultLens vaultLens;

    function setUp() public {
        forkFrom("BITTENSOR_RPC", "https://lite.chain.opentensor.ai");
        if (!isFork()) return;
        // Bittensor's (Frontier) block header carries no prevrandao, which the Cancun EVM requires
        vm.prevrandao(bytes32(uint256(1)));
        emit log_named_uint("fork block", vm.getBlockNumber());
        offRamp = offRamp20(BIT_ROUTER, BASE_SELECTOR);

        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        vm.allowCheatcodes(ISTAKING_ADDRESS);
        vm.etch(ADDRESS_MAPPING_ADDRESS, address(new MockAddressMapping()).code);
        uint256 netuid;
        (validator, netuid) = IAlphaVault(ALPHA_VAULT).positionOf(BIT_TAO);
        assertEq(netuid, 0, "TAO position on root");
        avColdkey = IAlphaVault(ALPHA_VAULT).vaultColdkey();
        staking.addHotkey(validator);
        staking.setColdkeyAlias(ALPHA_VAULT, avColdkey);
        staking.donateStake(validator, avColdkey, AV_SEED_RAO);
        staking.setOneRaoShort(false);
        staking.addHotkey(HK1);

        adapterBit = newAdapter(remoteAdapter);
        uint256 nonce = vm.getNonce(address(this));
        address pVault = vm.computeCreateAddress(address(this), nonce);
        CascadeVault.Params memory p = defaultVaultParams(
            mirror(pVault), HK1, ICascadeBridge(address(adapterBit)), owner, guardian, keeper, BASE, fdAddr
        );
        p.maxTotalAssets = 5_000e18;
        vault = new CascadeVault(p);
        assertEq(address(vault), pVault, "vault address");
        vaultLens = new CascadeVaultLens(address(vault));

        // the deploy's funding (runbook 3.2): the vault's existential reserve, the adapter's native reserve and its
        // booked token cushion, each its target
        vm.deal(address(vault), ED);
        vm.deal(address(this), 10 ether);
        fund(adapterBit);

        // 50 holders, 20 TAO each, through the real OffRamp and AlphaVault, staked, then held a day (the door hold)
        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](HOLDERS);
        for (uint256 i; i < HOLDERS; ++i) {
            d[i] = CascadeMessages.Entry(holder(i), 20e18);
        }
        (bool ok,) = deliver(CascadeMessages.encodeBatch(1, d, none()), 20e18 * HOLDERS);
        assertTrue(ok, "the holders' batch delivered");
        assertEq(vault.balanceOf(holder(HOLDERS - 1)), 2e25, "the last holder's shares");
        vm.prank(keeper);
        vault.stakeIdle();
        vm.warp(vm.getBlockTimestamp() + 1 days);
    }

    // ---- the lane, the rail and the runtime ----

    /// Task 66's runtime check as a test (runbook 2.5): Bittensor's runtime is specVersion 452 or later, where a
    /// precompile refuses a DELEGATECALL (bittensor_evm_home_chain.md, PR #3130): the walk and the hotkey library reach
    /// the staking precompile from the vault's DELEGATECALL frames, by CALL. Read by the substrate RPC (the archive node,
    /// or BITTENSOR_SUBSTRATE_RPC; an anvil cache does not serve it) as System's LastRuntimeUpgrade, the SCALE pair
    /// (Compact<u32> spec_version, spec_name), the value state_getRuntimeVersion's specVersion reports.
    function test_fork_v32_runtimeIsAtLeast452() public onlyFork {
        string memory rpc = vm.envOr("BITTENSOR_SUBSTRATE_RPC", string("https://archive.chain.opentensor.ai"));
        // twox128("System") ++ twox128("LastRuntimeUpgrade")
        bytes memory v =
            vm.rpc(rpc, "state_getStorage", '["0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8"]');
        (uint256 spec, uint256 at) = compactU32(v, 0);
        (uint256 nameLength, uint256 nameAt) = compactU32(v, at);
        bytes memory name = new bytes(nameLength);
        for (uint256 i; i < nameLength; ++i) {
            name[i] = v[nameAt + i];
        }
        emit log_named_uint("specVersion", spec);
        assertEq(string(name), "node-subtensor", "subtensor's runtime");
        assertGe(spec, 452, "specVersion at least 452");
    }

    /// A SCALE Compact<u32> at `at` in `b`: its value and the offset after it (one-, two- and four-byte modes).
    function compactU32(bytes memory b, uint256 at) internal pure returns (uint256 value, uint256 next) {
        uint8 b0 = uint8(b[at]);
        uint8 mode = b0 & 3;
        if (mode == 0) return (b0 >> 2, at + 1);
        if (mode == 1) return ((uint256(b0) | uint256(uint8(b[at + 1])) << 8) >> 2, at + 2);
        require(mode == 2, "compact: big-integer mode");
        value = uint256(b0) | uint256(uint8(b[at + 1])) << 8 | uint256(uint8(b[at + 2])) << 16
            | uint256(uint8(b[at + 3])) << 24;
        return (value >> 2, at + 4);
    }

    /// R4-K Minor 7 and S-H1: canSendPayouts on ForeverMoney's deployed AlphaVault, cold (the first call of the test,
    /// as a redeem-only delivery's rail read finds the AlphaVault), inside the vault's RAIL_VIEW_GAS cap (150,000) and
    /// answering open; then each of its three reads, each slot cold again (vm.cool), inside RAIL_READ_GAS (30,000). Each
    /// figure is the callee's own use of what it was forwarded: a cold account's 2,600 is charged to the caller at the
    /// call, outside the cap (in canSendPayouts' total, the adapter's three calls to the AlphaVault are inside it).
    function test_fork_v32_railReadsFitTheirCaps() public onlyFork {
        (bool open, bytes memory r) =
            address(adapterBit).staticcall{gas: 150_000}(abi.encodeCall(CcipBittensorAdapter.canSendPayouts, ()));
        uint256 viewGas = 150_000 - lastFrameRemaining();
        emit log_named_uint("canSendPayouts gas (cold)", viewGas);
        assertTrue(open && abi.decode(r, (bool)), "the live rail is open");
        assertLe(viewGas * 4, 150_000, "canSendPayouts under a quarter of RAIL_VIEW_GAS");

        assertEq(adapterBit.RAIL_READ_GAS(), 30_000, "the adapter's cap");
        bytes4[3] memory sels = [
            IAlphaVault.isPaused.selector, IAlphaVault.migrationReadyAt.selector, IAlphaVault.migrationFinished.selector
        ];
        string[3] memory names = ["isPaused", "migrationReadyAt", "migrationFinished"];
        uint256 worst;
        for (uint256 i; i < 3; ++i) {
            vm.cool(ALPHA_VAULT);
            (bool ok, bytes memory ret) = ALPHA_VAULT.staticcall{gas: 30_000}(abi.encodeWithSelector(sels[i]));
            uint256 used = 30_000 - lastFrameRemaining();
            assertTrue(ok && ret.length == 32 && abi.decode(ret, (uint256)) == 0, "answers 0");
            emit log_named_uint(string.concat(names[i], " gas (its slots cold)"), used);
            if (used > worst) worst = used;
        }
        assertLe(worst * 4, 30_000, "each read under a quarter of RAIL_READ_GAS");
    }

    // ---- the delivery model at its limit ----

    /// The accounts a delivery or an exit touches whose slots each run must find cold.
    function sideAccounts() internal view returns (address[] memory t) {
        t = new address[](7);
        (t[0], t[1], t[2], t[3], t[4], t[5], t[6]) =
        (address(vault), address(adapterBit), BIT_TAO, ALPHA_VAULT, ISTAKING_ADDRESS, BIT_ROUTER, BIT_POOL);
    }

    /// Whether `batch` (carrying `amount`) is delivered to the vault through the real OffRamp, not parked, when its
    /// message gives the adapter exactly `limit` gas, the side's slots cold.
    function deliversAt(bytes memory batch, uint256 amount, uint256 limit) internal returns (bool) {
        MessageV1Codec.MessageV1 memory m = fromBase(adapterBit, remoteAdapter, batch, amount, limit);
        cool(sideAccounts());
        (, bool ok,) = execute(offRamp, m);
        if (!ok) return false;
        (, uint64 parkedAt,) = adapterBit.parked(parkKey(adapterBit, batch));
        return parkedAt == 0;
    }

    /// The least receiver gas limit, to 256 gas, at which the delivery of `batch` reaches the vault: bisected over cold
    /// runs, plus the surcharge of the `warm` accounts it touches that the test touched first (ColdRuns).
    function leastDeliveringLimit(bytes memory batch, uint256 amount, uint256 warm) internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        assertTrue(deliversAt(batch, amount, 7_500_000), "delivers with plenty of gas");
        uint256 lo = PARK_GAS_RESERVE;
        uint256 hi = 7_500_000;
        while (hi - lo > 256) {
            uint256 mid = (lo + hi) / 2;
            vm.revertToState(snap);
            if (deliversAt(batch, amount, mid)) hi = mid;
            else lo = mid;
        }
        vm.revertToState(snap);
        return hi + warm * ACCOUNT_SURCHARGE;
    }

    /// `nd` fresh deposits (0x2000 + i, 1 TAO each) and `nr` redeems of seeded holders (1 TAO of shares each).
    function pointBatch(uint256 nd, uint256 nr) internal pure returns (bytes memory) {
        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](nd);
        CascadeMessages.Entry[] memory r = new CascadeMessages.Entry[](nr);
        for (uint256 i; i < nd; ++i) {
            d[i] = CascadeMessages.Entry(address(uint160(0x2000 + i)), 1e18);
        }
        for (uint256 i; i < nr; ++i) {
            r[i] = CascadeMessages.Entry(holder(i), 1e24);
        }
        return CascadeMessages.encodeBatch(2, d, r);
    }

    /// One point against the launch inbound pair (1,300,000 + 57,000 an entry): the least receiver limit through the
    /// real OffRamp and AlphaVault, then the model's headroom over it with only the precompile allowance added (the
    /// AlphaVault is ForeverMoney's own code here, so no carry), and the 15% rule (what the limit gives beyond the
    /// reserve, plus the allowance, x 1.15, then the reserve).
    function checkPoint(uint256 nd, uint256 nr, uint256 warm, string memory label) internal returns (uint256 least) {
        least = leastDeliveringLimit(pointBatch(nd, nr), nd * 1e18, warm);
        uint256 model = INBOUND_BASE + (nd + nr) * INBOUND_PER_ENTRY;
        uint256 ruleNeed = (least - PARK_GAS_RESERVE + PRECOMPILE_ALLOWANCE) * 115 / 100 + PARK_GAS_RESERVE;
        emit log_named_uint(string.concat("fork least delivering limit ", label), least);
        emit log_named_int(
            string.concat("fork headroom over limit + allowance ", label),
            int256(model) - int256(least + PRECOMPILE_ALLOWANCE)
        );
        emit log_named_int(string.concat("fork slack under the 15% rule ", label), int256(model) - int256(ruleNeed));
        assertGe(model, ruleNeed, string.concat(label, ": the launch pair covers the 15% rule"));
    }

    /// Task 61 step 2 on the fork: the points where the launch pair is tightest (R3 A-L1), each bisected through the real
    /// OffRamp, Router, LockRelease pool and AlphaVault (the precompile still mock: the allowance stands for it).
    function test_fork_v32_inboundModelAtTheSmallPoints() public onlyFork {
        uint256 snap = vm.snapshotState();
        checkPoint(1, 0, 0, "1+0");
        vm.revertToState(snap);
        checkPoint(0, 1, 0, "0+1");
        vm.revertToState(snap);
        checkPoint(1, 1, 0, "1+1");
        vm.revertToState(snap);
        checkPoint(10, 1, 0, "10+1");
    }

    function test_fork_v32_inboundModelAtTheLargePoints() public onlyFork {
        uint256 snap = vm.snapshotState();
        checkPoint(50, 1, 0, "50+1");
        vm.revertToState(snap);
        checkPoint(50, 50, 0, "50+50");
    }

    /// A-L1's four-hotkey case: three more hotkeys listed (the last while stake is missing, as after a swap; the listing
    /// touched the vault and the staking stand-in first), each read in every delivery; 1+1 at exactly the launch pair's
    /// limit still delivers.
    function test_fork_v32_inboundModelWithFourHotkeys() public onlyFork {
        bytes32 cold = vaultLens.coldkey();
        for (uint256 i = 2; i <= 4; ++i) {
            bytes32 h = bytes32(i);
            staking.addHotkey(h);
            staking.donateStake(h, cold, 10e9);
            if (i < 4) {
                vm.prank(owner);
                vault.addHotkey(h);
            } else {
                staking.loseStake(HK1, cold, 500e9);
                vault.addHotkey(h);
                staking.donateStake(HK1, cold, 500e9);
            }
        }
        assertFalse(vaultLens.stakeMissing(), "nothing missing");
        assertEq(vaultLens.hotkeys(3), bytes32(uint256(4)), "four listed");
        uint256 snap = vm.snapshotState();
        checkPoint(1, 1, 2, "1+1, 4 hotkeys");
        vm.revertToState(snap);
        assertTrue(deliversAt(pointBatch(1, 1), 1e18, INBOUND_BASE + 2 * INBOUND_PER_ENTRY), "1+1 at the launch limit");
    }

    // ---- parks ----

    /// Spec §3.2 (Task 25): a token park with ForeverMoney's burn rolled back. The real AlphaVault's withdrawLiquid burns
    /// the adapter's tokens, then its unstake is refused (the chain's TooEarly, from the staking stand-in), so it reverts
    /// and its burn with it: the batch parks as the tokens the pool released (CCIP SUCCESS, nothing minted). Once the
    /// chain lets the unstake go, the keeper's deliverParked converts them through the real AlphaVault and the vault mints.
    function test_fork_v32_tokenParkWithTheBurnRolledBack() public onlyFork {
        bytes memory batch = CascadeMessages.encodeBatch(2, entries1(alice(), 1e18), none());
        uint256 poolBefore = tao.balanceOf(BIT_POOL);
        uint256 supplyBefore = tao.totalSupply();
        uint256 nativeBefore = address(adapterBit).balance;
        uint256 vaultBefore = address(vault).balance;
        staking.setUnstakeBlocked(true);
        (bool ok,) = deliver(batch, 1e18);
        assertTrue(ok, "CCIP SUCCESS: the batch parked");
        (uint128 amount, uint64 parkedAt, bool converted) = adapterBit.parked(parkKey(adapterBit, batch));
        assertEq(amount, 1e18, "parked whole");
        assertGt(parkedAt, 0, "a record");
        assertFalse(converted, "as tokens");
        assertEq(adapterBit.parkedTokens(), 1e18, "the token parks' total");
        assertEq(tao.balanceOf(BIT_POOL), poolBefore - 1e18, "the pool released the tokens");
        assertEq(tao.totalSupply(), supplyBefore, "the supply unchanged (ForeverMoney's burn, if it ran, rolled back)");
        assertEq(tao.balanceOf(address(adapterBit)), 1e18 + adapterBit.tokenCushion(), "the adapter holds them");
        assertEq(address(adapterBit).balance, nativeBefore, "the native reserve untouched by the park");
        assertEq(vault.balanceOf(alice()), 0, "nothing minted");

        staking.setUnstakeBlocked(false);
        uint256 used = keeperDeliversParked(batch);
        emit log_named_uint("deliverParked of a token park: least gas that delivers", used);
        assertEq(tao.totalSupply(), supplyBefore - 1e18, "burned once, at the conversion");
        assertEq(adapterBit.parkedTokens(), 0, "nothing parked");
        assertEq(vault.balanceOf(alice()), 1e24, "alice's shares at the launch price");
        assertEq(address(adapterBit).balance, nativeBefore, "the native reserve untouched by the delivery");
        assertEq(address(vault).balance, vaultBefore + 1e18, "the vault holds the deposit's TAO");
    }

    /// The v3.1 test this replaces (BittensorFork's paused-AlphaVault FAILURE and re-execution, Task 25's carry): since
    /// v3.2 a halted ForeverMoney (IsHalted on withdrawLiquid) parks the batch as tokens, CCIP SUCCESS, and the message is
    /// never re-executed; deliverParked delivers it once ForeverMoney resumes.
    function test_fork_v32_haltedAlphaVaultParksTokens() public onlyFork {
        bytes memory batch = CascadeMessages.encodeBatch(2, entries1(alice(), 1e18), none());
        bytes memory halted = abi.encodeWithSignature("IsHalted()");
        vm.mockCallRevert(ALPHA_VAULT, abi.encodeWithSelector(IAlphaVault.withdrawLiquid.selector), halted);
        (bool ok, Vm.Log[] memory logs) = deliver(batch, 1e18);
        assertTrue(ok, "CCIP SUCCESS");
        assertParked(logs, parkKey(adapterBit, batch), false, bytes4(keccak256("IsHalted()")));
        assertEq(vault.balanceOf(alice()), 0, "nothing minted");
        vm.clearMockedCalls();
        keeperDeliversParked(batch);
        assertEq(vault.balanceOf(alice()), 1e24, "delivered once ForeverMoney resumed");
    }

    /// R4 (the runbook's section 11 item): a one-deposit batch reaching a paused vault parks as native TAO (the real
    /// AlphaVault converted it, the vault refused: EnforcedPause); the owner unpauses; the keeper's deliverParked, sent
    /// with the gas a binary-search estimator answers (the least that does not revert: the adapter's InsufficientGas
    /// floor, parkedDeliveryGas), ends in ParkedDelivered there, never a re-park.
    function test_fork_v32_pausedVaultParkThenKeeperDelivery() public onlyFork {
        bytes memory batch = CascadeMessages.encodeBatch(2, entries1(alice(), 1e18), none());
        vm.prank(guardian);
        vault.pause();
        (bool ok, Vm.Log[] memory logs) = deliver(batch, 1e18);
        assertTrue(ok, "CCIP SUCCESS");
        assertParked(logs, parkKey(adapterBit, batch), true, bytes4(keccak256("EnforcedPause()")));
        assertEq(adapterBit.parkedNative(), 1e18, "the native parks' total");
        vm.prank(owner);
        vault.unpause();
        uint256 used = keeperDeliversParked(batch);
        emit log_named_uint("deliverParked of a native park: least gas that delivers", used);
        emit log_named_uint("its floor, parkedDeliveryGas", adapterBit.parkedDeliveryGas(batch));
        assertEq(vault.balanceOf(alice()), 1e24, "alice's shares");
        assertEq(adapterBit.parkedNative(), 0, "nothing parked");
    }

    /// The keeper's deliverParked of `batch` as a binary-search estimator would send it: the least gas, to 256, at which
    /// the call does not revert (a re-park returns, so it counts as not reverting); asserts that at that gas the park
    /// was delivered (ParkedDelivered, the record gone), not re-parked: the adapter's InsufficientGas floor makes the
    /// estimate itself enough, so the keeper's parkedDeliveryGas + 100,000 above it (ops parked.ts) is margin. Leaves the
    /// delivery done. Returns that gas plus the surcharge of the four accounts inside the call the test's delivery
    /// touched first (the token, the AlphaVault, the stand-in, the vault: ColdRuns).
    function keeperDeliversParked(bytes memory batch) internal returns (uint256) {
        uint256 hi;
        uint256 snap = vm.snapshotState();
        uint256 lo = 50_000;
        hi = 9_000_000;
        while (hi - lo > 256) {
            uint256 mid = (lo + hi) / 2;
            vm.revertToState(snap);
            cool(sideAccounts());
            vm.prank(keeper);
            try adapterBit.deliverParked{gas: mid}(address(vault), fdAddr, batch) {
                hi = mid;
            } catch {
                lo = mid;
            }
        }
        vm.revertToState(snap);
        cool(sideAccounts());
        vm.recordLogs();
        vm.prank(keeper);
        adapterBit.deliverParked{gas: hi}(address(vault), fdAddr, batch);
        bytes32 key = parkKey(adapterBit, batch);
        assertEq(
            countEvent(vm.getRecordedLogs(), address(adapterBit), CcipBittensorAdapter.ParkedDelivered.selector, key),
            1,
            "delivered at the estimator's gas"
        );
        (, uint64 parkedAt,) = adapterBit.parked(key);
        assertEq(parkedAt, 0, "the record gone");
        assertGe(hi, adapterBit.parkedDeliveryGas(batch), "the adapter's floor binds the estimate");
        return hi + 4 * ACCOUNT_SURCHARGE;
    }

    // ---- the two 1-rao tolerances (T28 c6, R3 B-NV1) ----

    /// The delivery side (spec §3.2, Task 25): ForeverMoney's real withdrawLiquid asks for at least amount - 1 rao, the
    /// chain's unstake pays 1 rao short (the stand-in's removal fee), and the adapter makes up the rao from its native
    /// reserve, so the vault receives the whole amount and mints for it.
    function test_fork_v32_deliveryOneRaoShortFromTheReserve() public onlyFork {
        uint256 reserveBefore = address(adapterBit).balance;
        staking.setRemoveFeeRao(1);
        (bool ok,) = deliver(CascadeMessages.encodeBatch(2, entries1(alice(), 1e18), none()), 1e18);
        staking.setRemoveFeeRao(0);
        assertTrue(ok, "delivered");
        assertEq(vault.balanceOf(alice()), 1e24, "minted for the whole amount");
        assertEq(address(adapterBit).balance, reserveBefore - 1e9, "the reserve paid the rao");
        assertEq(adapterBit.parkedNative(), 0, "nothing parked");
    }

    /// The send side (R3 B-NV1, Task 28): a payout's depositLiquid into ForeverMoney's empty position, which the chain
    /// credits a rao short (the stand-in's fresh-position read): the real AlphaVault measures the stake, accepts it
    /// against the adapter's minAlphaRao (amount / 1 rao - 1, R3 B-1) and mints a rao short; the booked cushion makes it
    /// up (ShortfallCovered), and the payout leaves with its whole net through the real OnRamp.
    function test_fork_v32_payoutOneRaoShortFromTheCushion() public onlyFork {
        (bytes32 key, CascadeMessages.Payout[] memory list) = queuedPayout(1);
        staking.loseStake(validator, avColdkey, staking.getStake(validator, avColdkey, 0));
        staking.setOneRaoShort(true);
        uint256 cushionBefore = adapterBit.tokenCushion();
        vm.recordLogs();
        pay(key, list, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(adapterBit)
                    && logs[i].topics[0] == CcipBittensorAdapter.ShortfallCovered.selector
            ) {
                assertEq(abi.decode(logs[i].data, (uint256)), 1e9, "a rao");
                ++n;
            }
        }
        assertEq(n, 1, "ShortfallCovered once");
        assertEq(adapterBit.tokenCushion(), cushionBefore - 1e9, "the cushion paid the rao");
        assertEq(vaultLens.pendingPayouts(), 0, "paid");
        MessageV1Codec.MessageV1 memory sent = sentMessage(logs, BIT_ONRAMP);
        assertEq(sent.tokenTransfer.length, 1, "one token");
        (,, bytes memory payload) = adapterBit.decodePayload(sent.data);
        (,, CascadeMessages.Entry[] memory entries) = CascadeMessages.decodePayouts(payload);
        assertEq(sent.tokenTransfer[0].amount, entries[0].amount, "the whole net sent");
    }

    // ---- the work after the walk, with the real send (EXIT_GAS_RESERVE), and the spend cap ----

    /// A redeem-only batch of `nr` seeded holders (1 TAO each), delivered through the real OffRamp and its payout delay
    /// waited: its key and the keeper's payout list.
    function queuedPayout(uint256 nr) internal returns (bytes32 key, CascadeMessages.Payout[] memory list) {
        bytes memory batch = pointBatch(0, nr);
        key = keccak256(abi.encode(BASE, fdAddr, keccak256(batch)));
        MessageV1Codec.MessageV1 memory m = fromBase(adapterBit, remoteAdapter, batch, 0, 0);
        (, bool ok,, Vm.Log[] memory logs) = executeLogged(offRamp, m);
        assertTrue(ok, "the redeems delivered");
        list = redeemedList(logs, key);
        assertEq(list.length, nr, "every redeem queued");
        vm.warp(vm.getBlockTimestamp() + vaultLens.payoutDelay());
    }

    /// The caller's top-up for the next chunk of `key` (CascadePayoutLib.prepare's split): the quoted fee, rounded up to
    /// rao, less what the entries may be charged (maxFeeBps and maxFeeAbs of the chunk's sum).
    function topUpFor(CcipBittensorAdapter a, bytes32 key, CascadeMessages.Payout[] memory list)
        internal
        returns (uint256)
    {
        CascadeMessages.Entry[] memory e = new CascadeMessages.Entry[](list.length);
        uint256 sum;
        for (uint256 i; i < list.length; ++i) {
            e[i] = CascadeMessages.Entry(list[i].user, list[i].assets);
            sum += list[i].assets;
        }
        vm.prank(address(vault));
        uint256 quote = a.quoteFee(BASE, fdAddr, CascadeMessages.encodePayouts(key, 0, e), sum);
        uint256 fee = Math.ceilDiv(quote, 1e9) * 1e9;
        uint256 ceiling = Math.min(sum * vaultLens.maxFeeBps() / 10_000, vaultLens.maxFeeAbs());
        uint256 charged = Math.min(fee, ceiling) / 1e9 * 1e9;
        emit log_named_uint(string.concat("payout fee quote, ", vm.toString(list.length), " entries (wei)"), quote);
        return fee - charged;
    }

    function pay(bytes32 key, CascadeMessages.Payout[] memory list, uint256 gas) internal {
        uint256 value = topUpFor(adapterBit, key, list);
        vm.deal(keeper, keeper.balance + value);
        vm.prank(keeper);
        if (gas == 0) vault.processPayouts{value: value}(key, list, 50);
        else vault.processPayouts{value: value, gas: gas}(key, list, 50);
    }

    function payoutGoes(bytes32 key, CascadeMessages.Payout[] memory list, uint256 limit, uint256 value, uint256 eat)
        internal
        returns (bool ok)
    {
        vm.store(ISTAKING_ADDRESS, TAP_EAT_SLOT, bytes32(eat));
        uint256 gas = limit - 21_000 - 16 * abi.encodeCall(CascadeVault.processPayouts, (key, list, 50)).length;
        vm.deal(keeper, value);
        cool(sideAccounts());
        vm.prank(keeper);
        try vault.processPayouts{value: value, gas: gas}(key, list, 50) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    /// The payout of `nr` entries with the real send: its least transaction gas (Bittensor's binary-search estimate),
    /// what that costs at 5 gwei (the keeper's spend cap), and, the walk's one removal burning its share down to 60,000
    /// (spec §3.8), the most a StakingTap eater inside ForeverMoney's addStake can take at the keeper's gas (estimate +
    /// EXIT_GAS_RESERVE + unstakeGas): the reserve's margin over the work after the walk once the removal's hand-back is
    /// taken off (the walk's tail, the ledger, L3's effects, the adapter's send through the real AlphaVault, Router,
    /// OnRamp and pool, PayoutChunkSent). The keeper's top-up is quoted in a snapshot and reverted before the bisections
    /// (the T61a review's Minor 3), so each run pays the fee quote's reads cold, as the payout's own quote does on chain.
    function checkRealPayout(uint256 nr) internal returns (uint256 estimate, int256 margin, uint256 value) {
        string memory label = string.concat(vm.toString(nr), " entries");
        (bytes32 key, CascadeMessages.Payout[] memory list) = queuedPayout(nr);
        uint256 quoted = vm.snapshotState();
        value = topUpFor(adapterBit, key, list);
        vm.revertToState(quoted);
        // the queue's delivery touched these first: the adapter, the token, the AlphaVault, the stand-in, the router and
        // the pool
        uint256 warm = 6;
        vm.etch(ISTAKING_ADDRESS, address(new StakingTap(address(new MockStaking()))).code);
        uint256 snap = vm.snapshotState();
        uint256 lo = 200_000;
        uint256 hi = 20_000_000;
        while (hi - lo > 256) {
            uint256 mid = (lo + hi) / 2;
            vm.revertToState(snap);
            if (payoutGoes(key, list, mid, value, 0)) hi = mid;
            else lo = mid;
        }
        estimate = hi + warm * ACCOUNT_SURCHARGE;
        vm.revertToState(snap);
        staking.setRemovalKeepsGas(60_000);
        uint256 keeperGas = estimate + EXIT_GAS_RESERVE + vaultLens.unstakeGas();
        uint256 snap2 = vm.snapshotState();
        assertTrue(
            payoutGoes(key, list, keeperGas, value, 0), "the payout goes at the keeper's gas, its removal burning"
        );
        uint256 left = uint256(vm.load(ISTAKING_ADDRESS, TAP_REMOVAL_LEFT_SLOT));
        lo = 0;
        hi = keeperGas;
        while (hi - lo > 256) {
            uint256 mid = (lo + hi) / 2;
            vm.revertToState(snap2);
            if (payoutGoes(key, list, keeperGas, value, mid)) lo = mid;
            else hi = mid;
        }
        vm.revertToState(snap2);
        margin = int256(lo) - int256(warm * ACCOUNT_SURCHARGE) - int256(left);
        emit log_named_uint(string.concat("fork payout estimate (least gas), ", label), estimate);
        emit log_named_uint(string.concat("fork payout at 5 gwei (wei), ", label), estimate * 5 gwei);
        emit log_named_uint(string.concat("fork payout top-up (wei), ", label), value);
        emit log_named_uint(string.concat("fork payout keeper gas, ", label), keeperGas);
        emit log_named_uint(string.concat("fork payout: the removal handed back, ", label), left);
        emit log_named_int(string.concat("fork payout: the reserve's margin after the walk, ", label), margin);
        emit log_named_int(
            string.concat("fork payout: work after the walk, about, ", label), int256(EXIT_GAS_RESERVE) - margin
        );
    }

    /// Task 65 (the T61a review's Minor 4): EXIT_GAS_RESERVE holds at least twice the work after the walk with the live
    /// chain's allowance, the work being the reserve less the margin measured above.
    function assertReserveHoldsTwiceTheWork(int256 margin, string memory label) internal view {
        uint256 reserve = vaultLens.EXIT_GAS_RESERVE();
        assertGt(margin, 0, string.concat(label, ": the reserve covers the work after the walk"));
        // casting to 'uint256' is safe because the margin is above 0 (asserted above)
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 m = uint256(margin);
        uint256 work = m < reserve ? reserve - m : 0;
        assertLe(
            2 * (work + LIVE_EXIT_ALLOWANCE),
            reserve,
            string.concat(label, ": the reserve holds twice the work, the live costs included")
        );
        assertEq(reserve, EXIT_GAS_RESERVE, "the keeper's rule's reserve is the vault's");
    }

    function test_fork_v32_payoutWorkAfterTheWalk() public onlyFork {
        uint256 snap = vm.snapshotState();
        (uint256 g1, int256 m1, uint256 v1) = checkRealPayout(1);
        vm.revertToState(snap);
        (uint256 g50, int256 m50, uint256 v50) = checkRealPayout(50);
        assertReserveHoldsTwiceTheWork(m1, "1 entry");
        assertReserveHoldsTwiceTheWork(m50, "50 entries");
        // the keeper's spend cap on Bittensor (runbook 2.2): 0.4 TAO a day, one claim's up-front fee (57,000,000 gas)
        // first; at 5 gwei what is left pays this many one-entry payouts at their estimate and top-up, or 50-entry ones
        uint256 left = 0.4e18 - 57_000_000 * 5 gwei;
        emit log_named_uint("spend cap after a claim, at 5 gwei (wei)", left);
        emit log_named_uint("one-entry payouts that fit, at their estimate and top-up", left / (g1 * 5 gwei + v1));
        emit log_named_uint("50-entry payouts that fit, at their estimate and top-up", left / (g50 * 5 gwei + v50));
        emit log_named_uint(
            "one-entry payouts that fit, at the keeper's gas limit and top-up",
            left / ((g1 + EXIT_GAS_RESERVE + 400_000) * 5 gwei + v1)
        );
    }

    // ---- the owner's forfeit removal after a failed unclaimed read (runbook 7.5) ----

    /// The owner's removeHotkey(h, true) when the unclaimed-rewards read fails by burning all the gas it is given (a
    /// dispatch failure; the read has no cap, R2 F1): the removal goes on with the 64th it kept. The least gas it goes
    /// through with, bisected, for a hotkey holding nothing and for one whose stake moves to the stake hotkey, against
    /// the runbook's "about 3,000,000".
    function test_fork_v32_forfeitRemovalGas() public onlyFork {
        bytes32 h2 = bytes32(uint256(2));
        bytes32 h3 = bytes32(uint256(3));
        staking.addHotkey(h2);
        staking.addHotkey(h3);
        vm.startPrank(owner);
        vault.addHotkey(h2);
        vault.addHotkey(h3);
        vm.stopPrank();
        staking.donateStake(h3, vaultLens.coldkey(), 10e9);
        vm.etch(ISTAKING_ADDRESS, address(new StakingTap(address(new MockStaking()))).code);
        vm.store(ISTAKING_ADDRESS, TAP_BURN_SELECTOR_SLOT, bytes32(IStaking.getUnclaimedRootTaoByHotkey.selector));
        uint256 empty = leastForfeitGas(h2);
        uint256 moved = leastForfeitGas(h3);
        emit log_named_uint("forfeit removal, nothing on the hotkey: least gas", empty);
        emit log_named_uint("forfeit removal, its stake moved: least gas", moved);
        assertLe(empty, 3_000_000, "the runbook's 3,000,000 covers it");
        assertLe(moved, 3_000_000, "and with a move");
    }

    function leastForfeitGas(bytes32 h) internal returns (uint256 hi) {
        uint256 snap = vm.snapshotState();
        uint256 lo = 50_000;
        hi = 30_000_000;
        while (hi - lo > 1_024) {
            uint256 mid = (lo + hi) / 2;
            vm.revertToState(snap);
            cool(sideAccounts());
            vm.prank(owner);
            try vault.removeHotkey{gas: mid}(h, true) {
                hi = mid;
            } catch {
                lo = mid;
            }
        }
        vm.revertToState(snap);
        vm.prank(owner);
        vault.removeHotkey{gas: hi}(h, true);
        assertFalse(vaultLens.isHotkey(h), "removed");
        vm.revertToState(snap);
        // the transaction's intrinsic gas, and the two accounts the listing touched first (the vault, the stand-in)
        hi += 21_000 + 16 * 68 + 2 * ACCOUNT_SURCHARGE;
    }

    // ---- the rail switch with a batch in flight (runbook 7.7 step 4) ----

    /// Runbook 7.7 step 4, the vault's half on a fork: a batch the front door closed through the old rail just before
    /// its disable is still crossing. Waited for, it is delivered by the old adapter while the vault still has it
    /// enabled; then the vault's old bridge is disabled, the new pair made primary, and a payout leaves through the new
    /// adapter's real OnRamp. Not waited for (the vault's disable first), it reaches a disabled bridge, parks as native
    /// TAO, and after PARK_TIMEOUT anyone refunds it to its door through the old adapter, its tokens and its deposits'
    /// entries on the real OnRamp (BaseForkV32 lands such a refund at the door through its disabled twin).
    function test_fork_v32_railSwitchWithABatchInFlight() public onlyFork {
        address remoteB = makeAddr("v32 adapterBase B");
        CcipBittensorAdapter adapterB = newAdapter(remoteB);
        fund(adapterB);
        Schedule.run(vault, owner, abi.encodeCall(CascadeBase.activateBridge, (address(adapterB))));
        bytes memory inFlight = CascadeMessages.encodeBatch(2, entries1(alice(), 1e18), none());
        uint256 snap = vm.snapshotState();

        // waited for: delivered through the old rail, then the switch
        (bool ok,) = deliver(inFlight, 1e18);
        assertTrue(ok, "delivered");
        assertEq(vault.balanceOf(alice()), 1e24, "minted through the old rail");
        vm.startPrank(owner);
        vault.disableBridge(address(adapterBit));
        vault.setPrimaryBridge(address(adapterB));
        vm.stopPrank();
        bytes memory redeem = CascadeMessages.encodeBatch(3, none(), entries1(holder(0), 1e24));
        bytes32 key = keccak256(abi.encode(BASE, fdAddr, keccak256(redeem)));
        (, bool ok2,, Vm.Log[] memory logs) =
            executeLogged(offRamp, fromBase(adapterB, remoteB, redeem, 0, INBOUND_BASE + INBOUND_PER_ENTRY));
        assertTrue(ok2, "the new rail delivers");
        CascadeMessages.Payout[] memory list = redeemedList(logs, key);
        assertEq(list.length, 1, "burned through the new rail");
        vm.warp(vm.getBlockTimestamp() + vaultLens.payoutDelay());
        uint256 topUp = topUpFor(adapterB, key, list);
        vm.deal(keeper, topUp);
        vm.recordLogs();
        vm.prank(keeper);
        vault.processPayouts{value: topUp}(key, list, 50);
        MessageV1Codec.MessageV1 memory sent = sentMessage(vm.getRecordedLogs(), BIT_ONRAMP);
        assertEq(sent.sender, abi.encode(address(adapterB)), "the payout left through the new adapter");
        assertEq(sent.receiver, abi.encodePacked(remoteB), "to its Base twin");

        // not waited for: the vault's old bridge disabled first; the batch parks, then is refunded
        vm.revertToState(snap);
        vm.prank(owner);
        vault.disableBridge(address(adapterBit));
        (bool ok3, Vm.Log[] memory parkLogs) = deliver(inFlight, 1e18);
        assertTrue(ok3, "CCIP SUCCESS: parked");
        assertParked(parkLogs, parkKey(adapterBit, inFlight), true, bytes4(keccak256("NotBridge()")));
        assertEq(vault.balanceOf(alice()), 0, "nothing minted");
        vm.warp(vm.getBlockTimestamp() + adapterBit.PARK_TIMEOUT());
        uint256 fee = adapterBit.quoteRefund(address(vault), fdAddr, inFlight);
        vm.recordLogs();
        adapterBit.refundParked{value: fee}(address(vault), fdAddr, inFlight);
        MessageV1Codec.MessageV1 memory refund = sentMessage(vm.getRecordedLogs(), BIT_ONRAMP);
        assertEq(refund.sender, abi.encode(address(adapterBit)), "through the old adapter");
        assertEq(refund.receiver, abi.encodePacked(remoteAdapter), "to its Base twin");
        assertEq(refund.tokenTransfer[0].amount, 1e18, "the deposit's TAO");
        assertEq(
            refund.data,
            adapterBit.encodePayload(
                fdAddr,
                address(vault),
                CascadeMessages.encodePayouts(
                    parkKey(adapterBit, inFlight), adapterBit.REFUND_CHUNK(), entries1(alice(), 1e18)
                )
            ),
            "PAYOUTS(park key, REFUND_CHUNK, the deposits) from the vault to the door"
        );
        assertEq(refund.ccipReceiveGasLimit, TO_BASE_BASE + TO_BASE_PER_ENTRY, "the toward-Base model for one entry");
        assertEq(adapterBit.parkedNative(), 0, "nothing parked");
    }

    // ---- helpers ----

    /// A Bittensor adapter at the launch pairs whose Base twin is `remote`.
    function newAdapter(address remote) internal returns (CcipBittensorAdapter) {
        return new CcipBittensorAdapter(
            CcipAdapterBase.Config({
                router: BIT_ROUTER,
                token: BIT_TAO,
                localChainId: BITTENSOR,
                remoteChainId: BASE,
                remoteSelector: BASE_SELECTOR,
                remoteAdapter: remote,
                gasBase: TO_BASE_BASE,
                gasPerEntry: TO_BASE_PER_ENTRY,
                maxMessageValue: 5_000e18,
                treasury: treasury
            }),
            IAlphaVault(ALPHA_VAULT),
            INBOUND_BASE,
            INBOUND_PER_ENTRY
        );
    }

    /// The deploy's funding of an adapter (runbook 3.2): RESERVE_TARGET of native TAO and TOKEN_RESERVE_TARGET of
    /// FM-TAO booked as its cushion (approve, then fundCushion).
    function fund(CcipBittensorAdapter a) internal {
        a.fundReserve{value: a.RESERVE_TARGET()}();
        uint256 c = a.TOKEN_RESERVE_TARGET();
        deal(BIT_TAO, address(this), c);
        tao.approve(address(a), c);
        a.fundCushion(c);
        assertEq(a.tokenCushion(), c, "the cushion booked");
    }

    /// A front door's batch from `remote` (Base) through adapter `a` carrying `amount` bridged TAO (the source pool's
    /// decimals in extraData, as the real OnRamp sends them), the receiver's gas limit `gas` (0: the lane's inbound model
    /// for the batch, parkedDeliveryGas).
    function fromBase(CcipBittensorAdapter a, address remote, bytes memory batch, uint256 amount, uint256 gas)
        internal
        view
        returns (MessageV1Codec.MessageV1 memory m)
    {
        m = message(
            BASE_SELECTOR,
            BITTENSOR_SELECTOR,
            BASE_ONRAMP,
            offRamp,
            remote,
            address(a),
            BASE_POOL,
            BASE_TAO,
            BIT_TAO,
            amount,
            "",
            0
        );
        if (amount > 0) m.tokenTransfer[0].extraData = abi.encode(uint256(18));
        m.data = a.encodePayload(address(vault), fdAddr, batch);
        // the model never exceeds GAS_CAP (7,000,000), and the bisection's limits stay under 7,500,000: both fit uint32
        // forge-lint: disable-next-line(unsafe-typecast)
        m.ccipReceiveGasLimit = uint32(gas == 0 ? a.parkedDeliveryGas(batch) : gas);
    }

    /// Delivers `batch` through the real OffRamp to the vault by the old (first) adapter at the lane's model; the
    /// execution's logs (ForkBase.executeLogged records them itself, so a caller's vm.recordLogs would find none).
    function deliver(bytes memory batch, uint256 amount) internal returns (bool ok, Vm.Log[] memory logs) {
        (, ok,, logs) = executeLogged(offRamp, fromBase(adapterBit, remoteAdapter, batch, amount, 0));
    }

    function parkKey(CcipBittensorAdapter a, bytes memory batch) internal view returns (bytes32) {
        return keccak256(abi.encode(a.remoteChainId(), fdAddr, address(vault), batch));
    }

    /// One BatchParked for `key` among `logs`: as native TAO or tokens, with `reason`'s selector.
    function assertParked(Vm.Log[] memory logs, bytes32 key, bool converted, bytes4 reason) internal pure {
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length < 2 || logs[i].topics[0] != CcipBittensorAdapter.BatchParked.selector) continue;
            if (logs[i].topics[1] != key) continue;
            (,,, bool c, bytes4 r) = abi.decode(logs[i].data, (address, address, uint256, bool, bytes4));
            assertEq(c, converted, "parked as expected");
            assertEq(r, reason, "the refusal's selector");
            ++n;
        }
        assertEq(n, 1, "one BatchParked");
    }

    function countEvent(Vm.Log[] memory logs, address emitter, bytes32 topic0, bytes32 topic1)
        internal
        pure
        returns (uint256 n)
    {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic0 && logs[i].topics[1] == topic1) ++n;
        }
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
        return log.emitter == address(vault) && log.topics.length > 2 && log.topics[0] == Redeemed.selector
            && log.topics[1] == key;
    }

    function holder(uint256 i) internal pure returns (address) {
        // casting to 'uint160' is safe because i is a small test index
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(0x1000 + i));
    }

    function alice() internal pure returns (address) {
        return address(uint160(0xA11CE));
    }

    function entries1(address user, uint256 amount) internal pure returns (CascadeMessages.Entry[] memory e) {
        e = new CascadeMessages.Entry[](1);
        e[0] = CascadeMessages.Entry(user, amount);
    }

    function none() internal pure returns (CascadeMessages.Entry[] memory) {
        return new CascadeMessages.Entry[](0);
    }
}

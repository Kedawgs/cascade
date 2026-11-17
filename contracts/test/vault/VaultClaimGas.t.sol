// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeVault} from "../../src/CascadeVault.sol";
import {InsufficientGas} from "../../src/CascadeErrors.sol";
import {IStaking, ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {VaultTestBase} from "../VaultTestBase.sol";
import {burnGas} from "../fork/GasProbes.sol";
import {MockStaking} from "../mocks/MockStaking.sol";

// Task 65's claim probe: the slot where ClaimTap writes the gas the last claimRootWithHotkey used in its own frame, and
// the slot of the gas a claim keeps when it first burns the rest of what it is given (0: it burns none). Both beside
// MockStaking's storage at the precompile's address, far from its sequential slots.
bytes32 constant CLAIM_USED_SLOT = keccak256("cascade.t65.ClaimTap.used");
bytes32 constant CLAIM_KEEP_SLOT = keccak256("cascade.t65.ClaimTap.keep");

/// @notice Etched at the staking precompile's address over MockStaking's state, as GasProbes' StakingTap: every call
/// runs MockStaking's code (`impl`, by DELEGATECALL, so the state stays at the precompile's address). A
/// claimRootWithHotkey first burns all its gas but CLAIM_KEEP_SLOT's (a claim that needs all it is given), and once it
/// returns writes the gas its frame used, from its first instruction to the DELEGATECALL's return, at CLAIM_USED_SLOT.
/// The write comes after the reading, so its cost counts against the vault's overhead, outside the claim, never for it.
contract ClaimTap {
    address public immutable impl;

    constructor(address impl_) {
        impl = impl_;
    }

    fallback() external payable {
        uint256 entry = gasleft();
        bool claim = msg.sig == IStaking.claimRootWithHotkey.selector;
        if (claim) {
            bytes32 keepSlot = CLAIM_KEEP_SLOT;
            uint256 keep;
            assembly ("memory-safe") {
                keep := sload(keepSlot)
            }
            uint256 g = gasleft();
            if (keep != 0 && g > keep) burnGas(g - keep);
        }
        (bool ok, bytes memory ret) = impl.delegatecall(msg.data);
        if (claim && ok) {
            uint256 used = entry - gasleft();
            bytes32 usedSlot = CLAIM_USED_SLOT;
            assembly ("memory-safe") {
                sstore(usedSlot, used)
            }
        }
        assembly ("memory-safe") {
            switch ok
            case 0 { revert(add(ret, 32), mload(ret)) }
            default { return(add(ret, 32), mload(ret)) }
        }
    }
}

/// Task 65 (spec §3.9, Appendix B, Revision 30): the bounds of claimGasRequired against Bittensor's per-transaction
/// limit. The owner sets claimGasRequired at once within [MIN_CLAIM_GAS, MAX_CLAIM_GAS], so a real claim measured above
/// today's setting can be met live; MAX_CLAIM_GAS is the most whose claim's transaction the chain still accepts:
/// MAX_CLAIM_GAS + the claim's overhead allowance + a 1,000,000 margin <= 64,998,400, about 65,000,000 (75% of the
/// block less 10% for initialization), not the 75,000,000 block. The overhead is the vault's gas outside the forwarded
/// claimRootWithHotkey: the transaction's intrinsic gas, the caller's and the hotkey's checks, the position read
/// before (one getStake a listed hotkey), the gas check, the call's own cost, the read after, the booking, the cut's
/// price and mint, the schedule's restart and the events. Measured at its dearest: four hotkeys listed (eight
/// getStake reads), the treasury's first cut, every slot cold (setUp is a transaction of its own, so each test starts
/// cold).
contract VaultClaimGasTest is VaultTestBase {
    /// The most gas limit Bittensor accepts for one transaction (the Task 65 review's I-1): the normal class's
    /// max_extrinsic over Frontier's weight per gas. Subtensor spec 490, runtime/src/lib.rs: a 4e12 ref-time block,
    /// NORMAL_DISPATCH_RATIO 75%, BlockWeights::with_sensible_defaults, BLOCK_GAS_LIMIT 75,000,000, so WeightPerGas
    /// 40,000; frame_system's with_sensible_defaults reserves 10% of the block for initialization, so max_extrinsic is
    /// 3e12 - 0.4e12 - the base extrinsic weight; Frontier weighs an Ethereum transaction by its gas LIMIT, and
    /// CheckWeight refuses one above max_extrinsic (ExhaustsResources), in the pool and in the block. Read live
    /// 2026-11-15 by a read-only TaggedTransactionQueue_validate_transaction state_call: a gas limit of 64,998,400
    /// passes the weight check, 64,998,600 and up are ExhaustsResources. The block gas limit (75,000,000, read
    /// 2026-11-14) is not what one transaction meets.
    uint256 constant TX_GAS_LIMIT = 64_998_400;
    /// The margin a claim's transaction keeps under that limit (the controller's ruling, Task 65; it also covers a
    /// runtime upgrade that moves the base weights).
    uint256 constant TX_MARGIN = 1_000_000;
    /// The claim's overhead allowance: at least twice the overhead measured below (its live reads cost a few thousand
    /// gas more each than the mock's: a getStake from an account, 27,427 gas less the 21,000 intrinsic).
    uint256 constant CLAIM_OVERHEAD = 500_000;
    /// The gas a claim that needs all it is given keeps for MockStaking's own claim and the tap's write.
    uint256 constant CLAIM_KEEPS = 150_000;

    address treasury = makeAddr("treasury");

    /// The launch's reward cut (Appendix B: 10% to the treasury).
    function vaultParams() internal view override returns (CascadeVault.Params memory p) {
        p = super.vaultParams();
        p.treasury = treasury;
        p.rewardCutBps = 1_000;
    }

    /// Exact stake reads; alice's 100 TAO staked on HK1; HK2 to HK4 listed with 10 TAO each (the owner lists HK2 and
    /// HK3; the last slot, which the vault keeps for a swap's new hotkey, only while stake is missing: here in a window
    /// made by a loss on HK1 that is then made good, as AdapterGas' listHotkeys does); 1 TAO of HK1 rewards waiting;
    /// then the staking stand-in swapped for ClaimTap, MockStaking's state kept.
    function setUp() public override {
        super.setUp();
        staking.setOneRaoShort(false);
        depositDirect(alice, 100e18);
        vm.prank(keeper);
        vault.stakeIdle();
        bytes32 cold = vaultLens.coldkey();
        bytes32[3] memory more = [HK2, HK3, HK4];
        for (uint256 i; i < 3; ++i) {
            staking.donateStake(more[i], cold, 10_000_000_000);
            if (i < 2) {
                vm.prank(owner);
                vault.addHotkey(more[i]);
            } else {
                staking.loseStake(HK1, cold, 50_000_000_000);
                vault.addHotkey(more[i]);
                staking.donateStake(HK1, cold, 50_000_000_000);
            }
        }
        assertEq(vaultLens.hotkeys(3), HK4, "four listed");
        assertFalse(vaultLens.stakeMissing(), "nothing missing");
        staking.setUnclaimed(cold, HK1, 1_000_000_000);
        vm.etch(ISTAKING_ADDRESS, address(new ClaimTap(address(new MockStaking()))).code);
    }

    /// A transaction's intrinsic gas for `data`, high: 21,000 and 16 a byte, as if every byte were non-zero.
    function intrinsic(bytes memory data) internal pure returns (uint256) {
        return 21_000 + 16 * data.length;
    }

    /// The keeper's claim of HK1's 1 TAO, every slot cold: its overhead, the intrinsic gas and all the call used but
    /// what the claim's own frame used (the test's call into the vault, an extcodesize check and a cold account the
    /// transaction's own call does not pay, counts too: high).
    function test_claimOverheadIsWithinItsAllowance() public {
        bytes memory data = abi.encodeCall(CascadeVault.claimRewards, (HK1));
        vm.prank(keeper);
        uint256 g0 = gasleft();
        vault.claimRewards(HK1);
        uint256 used = g0 - gasleft();
        uint256 inside = uint256(vm.load(ISTAKING_ADDRESS, CLAIM_USED_SLOT));
        uint256 overhead = intrinsic(data) + used - inside;
        emit log_named_uint("claim: the call's gas", used);
        emit log_named_uint("claim: claimRootWithHotkey's own frame", inside);
        emit log_named_uint("claim: overhead (intrinsic + the vault outside the claim)", overhead);
        assertGt(inside, 0, "the claim ran through the tap");
        assertGt(vault.balanceOf(treasury), 0, "the dearest path: the treasury's first cut minted");
        assertLe(overhead * 2, CLAIM_OVERHEAD, "the allowance holds twice the overhead");
    }

    /// MAX_CLAIM_GAS is the most claimGasRequired whose claim still fits Bittensor's per-transaction limit with the
    /// overhead allowance and the margin, to 100,000; MIN_CLAIM_GAS is 54.1M (R5 M-4: the 53.2M a claimRootWithHotkey
    /// needs, section 2, reaches the precompile only from about 54.03M left, the call forwarding 63/64; the mainnet
    /// canary measures a real claim). The setting's live headroom is 54.1M to 63.4M left, about 53.25M to 62.4M
    /// forwarded: a real claim that needs more than that cannot be met by any setting.
    function test_maxClaimGasIsTheMostThatFitsOneTransaction() public {
        uint256 top = vaultLens.MAX_CLAIM_GAS();
        emit log_named_uint("MAX_CLAIM_GAS", top);
        emit log_named_uint("its transaction at the allowance, with the margin", top + CLAIM_OVERHEAD + TX_MARGIN);
        assertLe(top + CLAIM_OVERHEAD + TX_MARGIN, TX_GAS_LIMIT, "fits one transaction with the margin");
        assertGt(top + CLAIM_OVERHEAD + TX_MARGIN + 100_000, TX_GAS_LIMIT, "the most that fits, to 100,000");
        assertEq(vaultLens.MIN_CLAIM_GAS(), 54_100_000, "the floor, 63/64 counted");
    }

    /// R5 M-4: the floor keeps its promise, that no setting lets a claim start short of what the chain needs. With
    /// claimGasRequired at MIN_CLAIM_GAS, the least gas the vault's own check lets through (bisected to 1 gas) still
    /// forwards the precompile what it needs: MockStaking (etched back, no tap in the way) refuses, by burning all it is
    /// given, a claim forwarded less than 53.2M, section 2's figure. The check reads the gas left before the call, which
    /// forwards 63/64 of it (less the call's own cost), so 53.2M left reached it with about 52.37M, and the claim burned.
    function test_aClaimAtTheFloorForwardsWhatThePrecompileNeeds() public {
        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        uint256 floor = vaultLens.MIN_CLAIM_GAS();
        vm.prank(owner);
        vault.setClaimGasRequired(floor);
        uint256 snap = vm.snapshotState();
        uint256 lo = floor;
        uint256 hi = floor + 1_000_000;
        assertTrue(refusedByTheCheck(lo), "short of the setting: refused by the vault's check");
        vm.revertToState(snap);
        assertFalse(refusedByTheCheck(hi), "well above it: past the check");
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            vm.revertToState(snap);
            if (refusedByTheCheck(mid)) lo = mid;
            else hi = mid;
        }
        vm.revertToState(snap);
        uint256 stakeBefore = staking.getStake(HK1, vaultLens.coldkey(), 0);
        (bool ok,) = claimWith(hi);
        emit log_named_uint("the least gas the check lets through, at the floor", hi);
        assertTrue(ok, "at the least gas the check lets through, the precompile gets what it needs");
        assertEq(staking.getStake(HK1, vaultLens.coldkey(), 0), stakeBefore + 1_000_000_000, "the claim landed");
    }

    /// The keeper's claim of HK1 with exactly `gas` given to the vault's call.
    function claimWith(uint256 gas) internal returns (bool ok, bytes memory ret) {
        vm.prank(keeper);
        (ok, ret) = address(vault).call{gas: gas}(abi.encodeCall(CascadeVault.claimRewards, (HK1)));
    }

    /// Whether the vault's own gas check refused the claim at `gas` (InsufficientGas), rather than letting it reach the
    /// precompile, which either lands it or burns (an empty revert).
    function refusedByTheCheck(uint256 gas) internal returns (bool) {
        (bool ok, bytes memory ret) = claimWith(gas);
        return !ok && ret.length == 4 && bytes4(ret) == InsufficientGas.selector;
    }

    /// At the top of the setting, a claim that needs all it is given (the tap burns all but CLAIM_KEEPS, then the claim
    /// lands): a transaction of MAX_CLAIM_GAS + the allowance, within the per-transaction limit less its margin,
    /// completes, the cut and the booking after the claim paid from the 64th the vault kept back; one of MAX_CLAIM_GAS
    /// alone is refused InsufficientGas before the call, as any claim short of claimGasRequired is. (The test EVM has
    /// no per-transaction ceiling: TX_GAS_LIMIT, read from the chain, stands in for it.)
    function test_aClaimAtTheTopThatNeedsAllItIsGivenFitsOneTransaction() public {
        uint256 top = vaultLens.MAX_CLAIM_GAS();
        vm.prank(owner);
        vault.setClaimGasRequired(top);
        // the tap's burn stands in for the claim's cost: MockStaking's own check let through
        staking.setClaimGasRequired(1);
        vm.store(ISTAKING_ADDRESS, CLAIM_KEEP_SLOT, bytes32(CLAIM_KEEPS));
        bytes memory data = abi.encodeCall(CascadeVault.claimRewards, (HK1));
        uint256 limit = top + CLAIM_OVERHEAD;
        assertLe(limit + TX_MARGIN, TX_GAS_LIMIT, "the transaction fits the per-transaction limit with the margin");

        vm.prank(keeper);
        vm.expectRevert(InsufficientGas.selector);
        vault.claimRewards{gas: top - intrinsic(data)}(HK1);

        uint256 stakeBefore = staking.getStake(HK1, vaultLens.coldkey(), 0);
        vm.prank(keeper);
        vault.claimRewards{gas: limit - intrinsic(data)}(HK1);
        uint256 inside = uint256(vm.load(ISTAKING_ADDRESS, CLAIM_USED_SLOT));
        emit log_named_uint("claim at the top: claimRootWithHotkey's own frame", inside);
        assertGt(inside, top * 63 / 64 - 200_000, "the claim used nearly all it was forwarded");
        assertEq(staking.getStake(HK1, vaultLens.coldkey(), 0), stakeBefore + 1_000_000_000, "the claim landed");
        assertGt(vault.balanceOf(treasury), 0, "and the cut was minted after it");
    }
}

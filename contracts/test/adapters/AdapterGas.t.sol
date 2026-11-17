// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";
import {
    BurningRecipient,
    ColdRuns,
    EatingHolder,
    StakingTap,
    TAP_EAT_SLOT,
    TAP_REMOVAL_LEFT_SLOT
} from "../fork/GasProbes.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {AdaptersFixture} from "./AdaptersFixture.sol";

/// @notice The world AdapterGas' two suites share: the adapters' fixture with 50 seeded holders, and the batches, the
/// cold runs' accounts and the hotkey listing both use. Two suites since Task 65, so that neither test contract reaches
/// via-IR's jump-tag limit (the calibration's, with the exits' section, did when compiled beside a vault suite).
abstract contract AdapterGasWorld is AdaptersFixture, ColdRuns {
    /// 50 holders (0x1000 + i) deposit 20e18 each at A = 0, S = 0: 2e25 shares each.
    function setUp() public override {
        super.setUp();
        vm.deal(address(av), 2_000e18);
        CascadeMessages.Entry[] memory holders = new CascadeMessages.Entry[](50);
        for (uint256 i; i < 50; ++i) {
            holders[i] = CascadeMessages.Entry(addr(0x1000 + i), 20e18);
        }
        bytes memory batch = CascadeMessages.encodeBatch(1, holders, noEntries());
        taoBit.mint(address(adapterBit), 1_000e18);
        Client.Any2EVMMessage memory m =
            wrap(address(vault), address(fd), batch, address(taoBit), 1_000e18, BASE_SELECTOR, address(adapterBase));
        vm.prank(address(routerBit));
        adapterBit.ccipReceive(m);
        // their shares held a day, so the measured redeems burn (the door hold, R4 B-H1)
        vm.warp(vm.getBlockTimestamp() + 1 days);
    }

    function addr(uint256 n) internal pure returns (address) {
        // casting to 'uint160' is safe because n is a small test index
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(n));
    }

    function wrap(
        address recipient,
        address sender,
        bytes memory message,
        address token,
        uint256 amount,
        uint64 selector,
        address remoteAdapter
    ) internal view returns (Client.Any2EVMMessage memory m) {
        Client.EVMTokenAmount[] memory t = new Client.EVMTokenAmount[](amount == 0 ? 0 : 1);
        if (amount != 0) t[0] = Client.EVMTokenAmount(token, amount);
        m = Client.Any2EVMMessage(
            keccak256(message),
            selector,
            abi.encode(remoteAdapter),
            adapterBit.encodePayload(recipient, sender, message),
            t
        );
    }

    /// The batch of `nd` fresh deposits (0x2000 + i, 1e18 each) and `nr` redeems of seeded holders (0x1000 + i, 1e24
    /// shares each, 1 TAO), batch id 2, from the front door, as CCIP delivers it to the Bittensor adapter: its tokens
    /// minted to the adapter first, as the pool releases them (a batch with no deposits carries none).
    function vaultBatchMessage(uint256 nd, uint256 nr) internal returns (Client.Any2EVMMessage memory m) {
        bytes memory batch = vaultBatch(nd, nr);
        uint256 value = nd * 1e18;
        if (value != 0) taoBit.mint(address(adapterBit), value);
        m = wrap(address(vault), address(fd), batch, address(taoBit), value, BASE_SELECTOR, address(adapterBase));
    }

    function vaultBatch(uint256 nd, uint256 nr) internal pure returns (bytes memory) {
        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](nd);
        CascadeMessages.Entry[] memory r = new CascadeMessages.Entry[](nr);
        for (uint256 i; i < nd; ++i) {
            d[i] = CascadeMessages.Entry(addr(0x2000 + i), 1e18);
        }
        for (uint256 i; i < nr; ++i) {
            r[i] = CascadeMessages.Entry(addr(0x1000 + i), 1e24);
        }
        return CascadeMessages.encodeBatch(2, d, r);
    }

    /// The accounts a vault-side delivery or exit touches whose slots each run must find cold (coolVaultSide's and the
    /// router's).
    function sideAccounts() internal view returns (address[] memory t) {
        t = new address[](6);
        (t[0], t[1], t[2], t[3], t[4], t[5]) =
        (address(vault), address(adapterBit), address(taoBit), address(av), address(staking), address(routerBit));
    }

    /// Lists `n` hotkeys in all (the stake hotkey HK1 and HK2.. after it), each holding stake, so every delivery reads
    /// each (spec §3.1: one getStake per listed hotkey). The owner lists all but the last slot; the last, which the
    /// vault keeps for a swap's new hotkey, only while stake is missing (CascadeHotkeyLib.add): it is listed in that
    /// window, here made by a loss on HK1 that is then made good, as a stranger could after a swap.
    function listHotkeys(uint256 n) internal {
        bytes32 cold = vaultLens.coldkey();
        for (uint256 i = 2; i <= n; ++i) {
            bytes32 h = bytes32(i);
            staking.addHotkey(h);
            staking.donateStake(h, cold, 10_000_000_000);
            if (i < 4) {
                vm.prank(owner);
                vault.addHotkey(h);
            } else {
                staking.loseStake(HK1, cold, 500_000_000_000);
                vault.addHotkey(h);
                staking.donateStake(HK1, cold, 500_000_000_000);
            }
        }
        assertFalse(vaultLens.stakeMissing(), "nothing missing after the listing");
    }
}

/// @notice Calibrates the deployment gas model `gasLimit = gasBase + entries * gasPerEntry` against receiver
/// gas measured by calling `ccipReceive` directly as the router (the router's own overhead is excluded), and (Task 61)
/// bisects the model's limit and measures the park write against PARK_GAS_RESERVE (the exits' work after the walk
/// against EXIT_GAS_RESERVE: AdapterGasExitsTest, below).
contract AdapterGasTest is AdapterGasWorld {
    // Deployment gas model, `gasLimit = min(gasBase + entries * gasPerEntry, 7_000_000)`, copied into the
    // deployment spec (ops/src/config.ts: baseGas toward Bittensor, bitGas toward Base). The first
    // calibration (the Bittensor side is recalibrated below). Raw receiver gas (mock alpha vault and mock
    // staking precompile, `ccipReceive` called as the router):
    //   vault side:      1+0 = 134,606   50+50 = 2,447,691   100+100 = 4,630,863   (entries = deposits + redeems)
    //   front-door side: 1   = 128,115   50    = 1,380,682   100     = 2,660,606
    // Per entry: slope (g_max - g_1) / (entries_max - 1) rounded up to the next 1,000, then x1.15.
    //   Bittensor: (4,630,863 - 134,606) / 199 = 22,595.3 -> 23,000 -> 26,450
    //   Base:      (2,660,606 - 128,115) / 99  = 25,580.7 -> 26,000 -> 29,900
    // Base: (g_1 + allowance) x 1.15 - perEntry, rounded up to the next 10,000.
    //   Bittensor: (134,606 + 300,000) x 1.15 - 26,450 = 473,346 -> 480,000 by the formula, but that fails the
    //     50+50 point (3,125,000 < 3,159,845), so it is raised to 520,000 for it; raised again to 540,000 so the
    //     1+0 point also covers Task 8's real-AlphaVault receiver gas of 187,450:
    //     (187,450 + 300,000) x 1.15 = 560,567 <= 540,000 + 26,450 = 566,450.
    //   Base:      128,115 x 1.15 - 29,900 = 117,432 -> 120,000 (no precompile allowance on this side)
    // Both fit the cap: 540,000 + 200 x 26,450 = 5,830,000 and 120,000 + 200 x 29,900 = 6,100,000 <= 7,000,000.
    // Since then (2026-10-29, the pre-audit changes) the vault side reads 1+0 = 136,763, 50+50 = 2,437,137,
    // 100+100 = 4,620,503 (main read 136,914 / 2,430,018 / 4,613,184; a delivery with redeems now reads the
    // booked and ramping stake, about 7,000 gas, and a deposit-only one does not). The real-AlphaVault 1+0
    // point is not re-measured offline, so the test carries the vault's own change since the calibration
    // onto it: 187,450 + (136,763 - 134,606) = 189,607.
    // Since v3.2's Task 5e the batch path runs in the linked CascadeBatchLib: the vault reads the allowance
    // base and the limits before the DELEGATECALL, redeems or not, and the message is copied into the call.
    // 1+0 = 152,046, 50+50 = 2,334,283, 100+100 = 4,414,553 (from 133,600 / 2,327,419 / 4,406,931 just
    // before); the tightest point, 50+1, keeps 57,673 gas of slack (62,785 before).
    // Since v3.2's Task 17 a delivery that burns also reads and writes the global outflow window (about
    // 48,000 mock gas, about 55,000 of need after x 1.15). Measured 2026-11-03: 1+0 = 154,581, 50+50 =
    // 2,362,272, 100+100 = 4,442,568; the front-door side 1 = 125,603, 50 = 1,354,211, 100 = 2,609,692.
    //
    // Recalibrated toward Bittensor (2026-10-29) on small, one-sided and deposit-heavy batches, each measured
    // from a cold start in its own test. The first redeem of a delivery writes a payout batch and starts a
    // burn window, about 105,000 gas a deposit does not cost (0+1 = 242,671 against 1+0 = 136,763), and a
    // deposit costs about 28,500 gas against 15,000 for a further redeem. So the 540,000 / 26,450 model fell
    // short of the 15% rule at every small batch with a redeem (1+1: 592,900 < 756,075) and at every
    // deposit-heavy one. Every point counts the same way (`vaultNeed`): a message with tokens (any deposit)
    // carries the real AlphaVault's 52,844 gas over the mock, a redeem-only one calls no AlphaVault; then
    // + 300,000 and x 1.15.
    //   The binding shape was many deposits with one redeem, the deposits' climb plus the first redeem's
    //   fixed cost: after Task 17, 50+1 needed 2,340,596 of 780,000 + 51 x 31,100 = 2,366,100 (25,504 of slack).
    //
    // Since v3.2's Task 18 a door's first mint for an address also writes its redeem origin, a fresh slot: about
    // 22,460 mock gas, about 25,800 of need, per new depositor (a redeem's origin read replaces directOnly's, at
    // the same cost). And MAX_ENTRIES is 50 a side: a 100+100 batch of new depositors would need about 8.1M,
    // past GAS_CAP under any model, so 50+50 is the largest legal batch and the adapters' constructor check
    // counts 2 x 50 = 100 entries. Every point is measured cold (coolVaultSide; the front door's side likewise),
    // as on chain, where the delivery is a transaction of its own: the test's own token mint just before the
    // call had warmed the token's slots (about 9,600 gas at every point with deposits, 4,800 on Base; setUp's
    // writes were already cold, setUp being a transaction of its own here too).
    //
    // The v3.2 model (Task 18, measured 2026-11-03), for Task 43's v3.2 ops settings (ops/src/config.ts keeps
    // v3-launch's, which has no origin write):
    //   Toward Bittensor: gasBase 780,000 and 58,000 per entry; 100 entries (50+50) = 6,580,000 <= GAS_CAP.
    //     A deposit now climbs about 57,500 of need ((50+0 - 1+0) / 49), so the per-entry figure follows it
    //     and the base stays. The binding point is 1+1: it needs 823,791 of 780,000 + 2 x 58,000 = 896,000,
    //     72,209 gas of slack. The next tightest, need and slack: 10+1 (1,341,524, 76,476), 25+1 (2,204,517,
    //     83,483), 40+1 (3,067,635, 90,365), 50+1 (3,643,118, 94,882), 1+2 (842,931, 111,069), 2+2 (897,235,
    //     114,765), 50+2 (3,659,071, 136,929), 1+3 (858,853, 153,147), 0+1 (656,926, 181,074), the real 1+0
    //     (620,399, 217,601), 10+0 (1,138,136, 221,864), 25+0 (2,001,116, 228,884), 1+5 (890,699, 237,301),
    //     50+0 (3,439,694, 240,306), 50+5 (3,706,938, 263,062), 0+5 (720,611, 349,389), 1+10 (970,330,
    //     447,670), 50+10 (3,786,734, 473,266), 25+25 (2,587,291, 1,092,709), 50+50 (4,425,915, 2,154,085),
    //     0+50 (1,438,063, 2,241,937).
    //   Toward Base: gasBase 140,000 (from 120,000: the cold 1-payout chunk needs 125,603 -> 130,403 mock,
    //     149,963 after x 1.15, 63 more than 120,000 + 29,900; 140,000 leaves it about 20,000 of slack) and
    //     29,900 per entry; slack at 1, 25 and 50 payouts 19,937, 45,682 and 71,963; 100 entries = 3,130,000
    //     <= GAS_CAP.
    //   The tests below log every point's need and slack.
    //
    // Recalibrated toward Bittensor at R4 (2026-11-11). setUp now ages the seeded holders a day (the door hold, R4
    // B-H1), which also puts every point on a real clock. At t = 1 a window never written reads as the current one
    // (CascadeFormulas.currentWindow keeps its start of 0 for 24 hours), so a first burn wrote no window start; on chain
    // every day's first burn writes the door's and the global window's (`Window.start`, a slot of its own, zero to
    // non-zero, about 20,000 mock gas each). The 88b056a tree measured with the day's warp alone was already past the
    // 780,000 / 58,000 model at every N+1 point: 1+1 needed 902,046 of 896,000, 10+1 1,424,774 of 1,418,000, 25+1
    // 2,296,159 of 2,288,000, 40+1 3,167,753 of 3,158,000, 50+1 3,748,935 of 3,738,000. R4's own reads then add, at
    // 1+1, about 21,500 mock gas: the rail read (S-H1: the vault's staticcall of canSendPayouts and the adapter's three
    // AlphaVault reads, about 10,400), the token check before the conversion (C-L1: the balance, parkedTokens and
    // tokenCushion, about 7,400), the over-burn check (F-3, about 2,300); and the fresh shares a deposit writes into its
    // holder record (B-H1, about 970 a deposit). Measured: 0+1 732,432, 0+5 798,523, 0+50 1,543,799, 1+1 926,768, 1+2
    // 946,509, 1+3 963,033, 1+5 996,085, 1+10 1,078,741, 2+2 1,002,480, 10+0 1,209,357, 10+1 1,459,513, 25+0
    // 2,097,441, 25+1 2,347,623, 40+1 3,235,985, 50+0 3,578,141, 50+1 3,828,367, 50+2 3,844,951, 50+5 3,894,717, 50+10
    // 3,977,692, 50+50 4,642,926.
    //   Toward Bittensor: per entry, the deposit climb ((50+1 - 1+1) / 49 = 59,216) rounded up to the next 1,000,
    //     60,000; the base, the binding 1+1 point's need less 2 x 60,000 (806,768) rounded up to the next 10,000 and
    //     10,000 more kept for drift, 820,000. 100 entries = 6,820,000 <= GAS_CAP (Task 61's park reserve, about
    //     +150,000 on the base, then gives 6,970,000). Slack: 1+1 13,232, 10+1 20,487, 25+1 32,377, 40+1 44,015, 50+1
    //     51,633, 1+2 53,491, 2+2 57,520, 50+2 95,049, 1+3 96,967, 0+1 147,568, 1+5 183,915, 10+0 210,643, 25+0
    //     222,559, 50+5 225,283, 50+0 241,859, 0+5 321,477, 1+10 401,259, 50+10 442,308, 50+50 2,177,074, 0+50
    //     2,276,201. A delivery's windows in two slots each are Task 61's to weigh (one packed slot would save about
    //     40,000 gas at every day's first burn).
    //
    // The R4 review's launch pair (2026-11-11): the need now counts PARK_GAS_RESERVE (150,000) on top of the measured
    // delivery, since ccipReceive keeps it back from the recipient's call, so the pair includes it (counted once, here;
    // the adapter's parkedDeliveryGas adds nothing to it). On the GAS_CAP line (base = 7,000,000 - 100 x perEntry) a
    // higher base and a lower per-entry figure leave far more slack at the binding deposit-heavy points than 970,000 /
    // 60,000 would (13,232 at 1+1): 1,300,000 + 57,000 an entry, exactly 7,000,000 at 100 entries. canSendPayouts' reads
    // are now low-level (Important 2), about 640 gas of need cheaper at 1+1. Needs, reserve counted: 0+1 881,795, 0+5
    // 947,886, 0+50 1,693,162, 1+1 1,076,131, 1+2 1,095,872, 1+3 1,112,395, 1+5 1,145,448, 1+10 1,228,104, 2+2 1,151,843,
    // 10+0 1,358,720, 10+1 1,608,876, 25+0 2,246,804, 25+1 2,496,986, 40+1 3,385,347, 50+0 3,727,503, 50+1 3,977,730,
    // 50+2 3,994,314, 50+5 4,044,080, 50+10 4,127,055, 50+50 4,792,288. Slack: 50+1 229,270 (the least), 40+1 251,653,
    // 50+2 269,686, 25+1 285,014, 10+1 318,124, 1+1 337,869, 1+2 375,128, 2+2 376,157, 50+5 390,920, 1+3 415,605, 50+0
    // 422,497, 0+1 475,205, 25+0 478,196, 1+5 496,552, 10+0 511,280, 50+10 592,945, 0+5 637,114, 1+10 698,896, 50+50
    // 2,207,712, 0+50 2,456,838. maxDeposits and maxRedeems stay 50 (40 deposits would buy about 22,000). CARRY T61: the
    // fork's figures decide the final pair.
    //
    // Task 61 (2026-11-14, at 077e73f: Revision 27's adoption drip and Revision 28 in place, the library boundary as
    // deployed). Needs, reserve counted: 0+1 887,075, 0+5 953,164, 0+50 1,698,442, 1+1 1,083,952, 1+2 1,103,693, 1+3
    // 1,120,218, 1+5 1,153,271, 1+10 1,235,926, 2+2 1,159,665, 10+0 1,366,541, 10+1 1,616,698, 25+0 2,254,626, 25+1
    // 2,504,809, 40+1 3,393,171, 50+0 3,735,327, 50+1 3,985,554, 50+2 4,002,138, 50+5 4,051,904, 50+10 4,134,879, 50+50
    // 4,800,115: 7,820 to 7,830 of need more than R4's at every point with deposits and 5,280 at the redeem-only ones,
    // about 6,800 and 4,600 gas (Revision 27's two more cold slots on every pricing path, its review's M-2, about 4,200,
    // and the drips' write-down's own reads; Revision 28's gas check runs on no delivery path). Slack: 50+1 221,446 (the
    // least), 40+1 243,829, 25+1 277,191, 10+1 310,302, 1+1 330,048, 1+2 367,307, 2+2 368,335, 50+5 383,096, 1+3
    // 407,782, 50+0 414,673, 0+1 469,925, 25+0 470,374, 1+5 488,729, 10+0 503,459, 50+10 585,121, 0+5 631,836, 1+10
    // 691,074, 50+50 2,199,885, 0+50 2,451,558. The bisection (test_gas_limit_*, R3 A-L1's method on this tree: the
    // least limit at which the batch reaches the vault rather than parking) agrees: 1+0 420,453, 0+1 485,950, 1+1
    // 637,972 (with four hotkeys listed 659,906, about 6,400 a further hotkey), 10+1 1,100,935, 50+1 3,159,320, 50+50
    // 3,865,092, and under the 15% rule on them 50+1 keeps 239,772, the least. Through the real OffRamp, LockRelease pool
    // and AlphaVault (BittensorForkV32, which carries no AlphaVault estimate: ForeverMoney's code runs) the limits are
    // 1+0 412,658, 0+1 485,109, 1+1 630,009 (four hotkeys 651,831), 10+1 1,092,973, 50+1 3,151,413, 50+50 3,857,298, a
    // few thousand under these (the real AlphaVault costs about 7,800 less than the mock and its carry, which so errs
    // high), and 50+1's 260,376 the least slack under the 15% rule. So the launch pair 1,300,000 / 57,000 stands, and
    // 50 / 50 too: the largest legal batch needs about 4.2M (3.86M and the 300,000 allowance) of its 7.0M.
    // Toward Base (test_gas_frontDoorDeliveryModelHasHeadroom): 1 = 130,511, 25 = 732,124, 50 = 1,359,271, slack 19,813,
    // 45,558 and 71,839; through the real OffRamp and FM-TAO into a real door (BaseForkV32), the least limits 123,203,
    // 733,964 and 1,370,340, a 50-deposit refund the same, slack under the 15% rule 28,217, 43,442 and 59,109.
    uint256 public constant GAS_BASE_TO_BITTENSOR = 1_300_000;
    uint256 public constant GAS_PER_ENTRY_TO_BITTENSOR = 57_000;
    // Task 65 (the T61a review's I-2): the toward-Base pair raised to 180,000 + 32,000 an entry, erring high (the
    // thinnest margin in the table, and the live door's non-zero netForwarded write costs 2,800 more than the forks
    // measured); 3,380,000 at 100 entries, within GAS_CAP. An ops deploy setting (the Bittensor adapter's constructor).
    // Slack under the 15% rule over the mocks at 1, 25 and 50 payouts 61,913, 138,058 and 216,839; on the Base fork
    // (BaseForkV32, block 57,607,777, the 2,800 counted) the least limits 126,003, 736,764 and 1,373,140, a 50-deposit
    // refund the same, slack 67,097, 132,722 and 200,889.
    uint256 public constant GAS_BASE_TO_BASE = 180_000;
    uint256 public constant GAS_PER_ENTRY_TO_BASE = 32_000;

    /// Two real precompile calls a delivery makes that the mock does not charge for (a real removeStake
    /// measured 144,811 gas; bittensor_evm_home_chain.md).
    uint256 constant PRECOMPILE_ALLOWANCE = 300_000;

    /// CcipBittensorAdapter.PARK_GAS_RESERVE: what ccipReceive keeps back from the conversion's and the recipient's
    /// calls, so a starved delivery can still park (spec §3.2).
    uint256 constant PARK_GAS_RESERVE = 150_000;

    /// Task 8's real-AlphaVault receiver gas for the 1+0 point (BittensorFork's "receiver gas 1+0"), and the
    /// mock 1+0 gas this test read at the same calibration. The vault's own changes since move both alike.
    /// Since R3 (F6) MockAlphaVault stakes and unstakes through the staking double as ForeverMoney's code does, 42,835
    /// gas more than the old double at every delivery that carries tokens (measured at every such point; a redeem-only
    /// delivery never calls it): the calibration's mock point moves by exactly that (134,606 to 177,441), so the real
    /// AlphaVault's carry falls from 52,844 to 10,009 and the model's estimate of the real cost is unchanged.
    uint256 constant REAL_ALPHAVAULT_1_0 = 187_450;
    uint256 constant MOCK_1_0_AT_CALIBRATION = 177_441;

    /// Gas of one `ccipReceive` on the vault side for `n` fresh deposits (0x2000 + i, 1e18) and `n` redeems
    /// of seeded holders (0x1000 + i, 1e24 each, batch id 2).
    function measureVault(uint256 n) internal returns (uint256 g) {
        return measureVaultBatch(n, n);
    }

    /// Marks every contract a vault-side delivery reads cold, as on chain, where the delivery is its own
    /// transaction (Task 18): the vault (the share token is its own storage), the adapter, the bridged token, the
    /// mock AlphaVault and the mock staking precompile. Without it the holders' balances and redeem origins,
    /// which setUp wrote, read warm.
    function coolVaultSide() internal {
        vm.cool(address(vault));
        vm.cool(address(adapterBit));
        vm.cool(address(taoBit));
        vm.cool(address(av));
        vm.cool(address(staking));
    }

    /// Gas of one `ccipReceive` on the vault side for `nd` fresh deposits (0x2000 + i, 1e18 each) and `nr`
    /// redeems of seeded holders (0x1000 + i, 1e24 shares each, 1 TAO), batch id 2, measured cold
    /// (coolVaultSide). A batch with no deposits carries no tokens, as a front door sends it.
    function measureVaultBatch(uint256 nd, uint256 nr) internal returns (uint256 g) {
        Client.Any2EVMMessage memory m = vaultBatchMessage(nd, nr);
        coolVaultSide();
        vm.prank(address(routerBit));
        g = gasleft();
        adapterBit.ccipReceive(m);
        g -= gasleft();
        if (nd != 0) assertEq(vault.balanceOf(addr(0x2000 + nd - 1)), 1e24, "deposit credited");
        if (nr != 0) assertEq(vault.balanceOf(addr(0x1000 + nr - 1)), 19e24, "redeem applied");
    }

    /// The gas the model must give a vault-side delivery of `nd` deposits that used `g` mock gas: the
    /// real-AlphaVault cost carried on when the message carries tokens (any deposit; a redeem-only batch
    /// carries none and never calls the AlphaVault), plus the precompile allowance, plus 15%, plus the park reserve the
    /// adapter keeps back from the recipient's call (the R4 review: the pair includes PARK_GAS_RESERVE, counted here).
    function vaultNeed(uint256 g, uint256 nd) internal pure returns (uint256) {
        uint256 real = nd == 0 ? g : g + REAL_ALPHAVAULT_1_0 - MOCK_1_0_AT_CALIBRATION;
        return (real + PRECOMPILE_ALLOWANCE) * 115 / 100 + PARK_GAS_RESERVE;
    }

    /// What the deployment model gives a delivery of `entries` entries.
    function vaultModel(uint256 entries) internal pure returns (uint256) {
        return GAS_BASE_TO_BITTENSOR + entries * GAS_PER_ENTRY_TO_BITTENSOR;
    }

    /// Measures one small point from a cold start (each in its own test), logs it and its slack, and
    /// checks the model covers it.
    function checkVaultPoint(uint256 nd, uint256 nr) internal {
        uint256 g = measureVaultBatch(nd, nr);
        uint256 need = vaultNeed(g, nd);
        string memory point = string.concat(vm.toString(nd), "+", vm.toString(nr));
        emit log_named_uint(string.concat("vault gas ", point), g);
        emit log_named_uint(string.concat("vault need ", point), need);
        emit log_named_int(string.concat("vault slack ", point), int256(vaultModel(nd + nr)) - int256(need));
        assertGe(vaultModel(nd + nr), need, point);
    }

    // The first redeem of a delivery writes a payout batch and starts the front door's burn window and, since
    // Task 17, the global one: a fixed cost a deposit does not pay (about 105,000 gas at the 2026-10-29
    // calibration, more since). These are the points where that fixed cost weighs most: 1+1 binds the v3.2
    // model (Task 18).
    function test_gas_vault_0_1() public {
        checkVaultPoint(0, 1);
    }

    function test_gas_vault_0_5() public {
        checkVaultPoint(0, 5);
    }

    function test_gas_vault_1_1() public {
        checkVaultPoint(1, 1);
    }

    function test_gas_vault_1_2() public {
        checkVaultPoint(1, 2);
    }

    function test_gas_vault_1_3() public {
        checkVaultPoint(1, 3);
    }

    function test_gas_vault_1_5() public {
        checkVaultPoint(1, 5);
    }

    function test_gas_vault_1_10() public {
        checkVaultPoint(1, 10);
    }

    function test_gas_vault_2_2() public {
        checkVaultPoint(2, 2);
    }

    function test_gas_vault_0_50() public {
        checkVaultPoint(0, 50);
    }

    // A deposit costs more than a redeem after the first (about 28,500 gas against 15,000, and since Task 18
    // about 22,500 more for a new depositor's origin), so a batch of deposits alone climbs faster than the
    // per-entry average: up to the largest legal 50 deposits.
    function test_gas_vault_10_0() public {
        checkVaultPoint(10, 0);
    }

    function test_gas_vault_50_0() public {
        checkVaultPoint(50, 0);
    }

    // Many deposits and a few redeems: the deposits' steep climb (each also writes its new redeem origin since
    // Task 18) plus the first redeem's fixed cost. These bound the model before Task 18, 50+1 hardest; they
    // stay next to 1+1.
    function test_gas_vault_10_1() public {
        checkVaultPoint(10, 1);
    }

    function test_gas_vault_25_1() public {
        checkVaultPoint(25, 1);
    }

    function test_gas_vault_50_1() public {
        checkVaultPoint(50, 1);
    }

    function test_gas_vault_50_5() public {
        checkVaultPoint(50, 5);
    }

    function test_gas_vault_50_10() public {
        checkVaultPoint(50, 10);
    }

    function test_gas_vault_40_1() public {
        checkVaultPoint(40, 1);
    }

    function test_gas_vault_50_2() public {
        checkVaultPoint(50, 2);
    }

    function test_gas_vault_25_0() public {
        checkVaultPoint(25, 0);
    }

    // the largest legal batch (MAX_ENTRIES a side), from a cold start in its own test
    function test_gas_vault_50_50() public {
        checkVaultPoint(50, 50);
    }

    /// Gas of one `ccipReceive` on the front-door side for a chunk of `n` payouts (0x3000 + i, 1e18 each), measured
    /// cold: the front door, its adapter and the tokens.
    function measureFrontDoor(uint256 n) internal returns (uint256 g) {
        CascadeMessages.Entry[] memory p = new CascadeMessages.Entry[](n);
        for (uint256 i; i < n; ++i) {
            p[i] = CascadeMessages.Entry(addr(0x3000 + i), 1e18);
        }
        uint256 value = n * 1e18;
        taoBase.mint(address(adapterBase), value);
        Client.Any2EVMMessage memory m = wrap(
            address(fd),
            address(vault),
            CascadeMessages.encodePayouts(bytes32(uint256(7)), 0, p),
            address(taoBase),
            value,
            BITTENSOR_SELECTOR,
            address(adapterBit)
        );
        vm.cool(address(fd));
        vm.cool(address(adapterBase));
        vm.cool(address(taoBase));
        vm.cool(address(usdcBase));
        vm.prank(address(routerBase));
        g = gasleft();
        adapterBase.ccipReceive(m);
        g -= gasleft();
        assertEq(fd.claimable(addr(0x3000 + n - 1)), 1e18, "payout credited");
    }

    /// 1+0, 25+25 and the largest legal batch, 50+50 (MAX_ENTRIES), and the adapter's constructor check: the model
    /// at 2 * MAX_ENTRIES entries within GAS_CAP.
    function test_gas_vaultDeliveryModelHasHeadroom() public {
        uint256 s = vm.snapshotState();
        uint256 g1 = measureVaultDepositOnly();
        vm.revertToState(s);
        s = vm.snapshotState();
        uint256 g25 = measureVault(25);
        vm.revertToState(s);
        uint256 g50 = measureVault(50);
        emit log_named_uint("vault gas 1+0", g1);
        emit log_named_uint("vault gas 25+25", g25);
        emit log_named_uint("vault gas 50+50", g50);
        // the real-AlphaVault 1+0 point, carried forward by the vault's change since the calibration
        uint256 need1 = vaultNeed(g1, 1);
        emit log_named_uint("real 1+0 (estimated)", REAL_ALPHAVAULT_1_0 + g1 - MOCK_1_0_AT_CALIBRATION);
        emit log_named_uint("real 1+0 slack", vaultModel(1) - need1);
        assertGe(vaultModel(1), need1, "real 1+0");
        assertGe(vaultModel(50), vaultNeed(g25, 25), "25+25");
        assertGe(vaultModel(100), vaultNeed(g50, 50), "50+50");
        assertEq(CascadeMessages.MAX_ENTRIES, 50);
        assertLe(vaultModel(2 * CascadeMessages.MAX_ENTRIES), 7_000_000, "within GAS_CAP");
        assertEq(adapterBit.PARK_GAS_RESERVE(), PARK_GAS_RESERVE, "the reserve the need counts is the adapter's");
    }

    function measureVaultDepositOnly() internal returns (uint256 g) {
        return measureVaultBatch(1, 0);
    }

    /// A chunk of 1, 25 and the largest, 50 payouts (MAX_ENTRIES), and the adapter's constructor check: the model at
    /// 2 * MAX_ENTRIES entries within GAS_CAP.
    function test_gas_frontDoorDeliveryModelHasHeadroom() public {
        uint256 s = vm.snapshotState();
        uint256 g1 = measureFrontDoor(1);
        vm.revertToState(s);
        s = vm.snapshotState();
        uint256 g25 = measureFrontDoor(25);
        vm.revertToState(s);
        uint256 g50 = measureFrontDoor(50);
        emit log_named_uint("front door gas 1", g1);
        emit log_named_uint("front door gas 25", g25);
        emit log_named_uint("front door gas 50", g50);
        emit log_named_int("front door slack 1", int256(baseModel(1)) - int256(g1 * 115 / 100));
        emit log_named_int("front door slack 25", int256(baseModel(25)) - int256(g25 * 115 / 100));
        emit log_named_int("front door slack 50", int256(baseModel(50)) - int256(g50 * 115 / 100));
        assertGe(baseModel(1), g1 * 115 / 100, "1");
        assertGe(baseModel(25), g25 * 115 / 100, "25");
        assertGe(baseModel(50), g50 * 115 / 100, "50");
        assertLe(baseModel(2 * CascadeMessages.MAX_ENTRIES), 7_000_000, "within GAS_CAP");
    }

    /// What the deployment model gives a front-door delivery of `entries` payouts.
    function baseModel(uint256 entries) internal pure returns (uint256) {
        return GAS_BASE_TO_BASE + entries * GAS_PER_ENTRY_TO_BASE;
    }

    // ---- Task 61: the inbound model at its limit, by bisection (R3 A-L1) ----

    /// The park key of the vault-side batch `batch` from the front door to `recipient` (CcipBittensorAdapter._parkKey).
    function parkKeyOf(address recipient, bytes memory batch) internal view returns (bytes32) {
        return keccak256(abi.encode(BASE, address(fd), recipient, batch));
    }

    /// Whether the batch of `nd` deposits and `nr` redeems is delivered to the vault, not parked, when the router gives
    /// `ccipReceive` exactly `limit` gas, the side's slots cold (ColdRuns). A limit too low even to park reverts: false.
    function deliversAt(uint256 nd, uint256 nr, uint256 limit) internal returns (bool) {
        Client.Any2EVMMessage memory m = vaultBatchMessage(nd, nr);
        cool(sideAccounts());
        vm.prank(address(routerBit));
        try adapterBit.ccipReceive{gas: limit}(m) {
            (, uint64 parkedAt,) = adapterBit.parked(parkKeyOf(address(vault), vaultBatch(nd, nr)));
            return parkedAt == 0;
        } catch {
            return false;
        }
    }

    /// The least gas limit, to 64 gas, at which CCIP's delivery of the batch reaches the vault rather than parking (spec
    /// §3.2: the adapter keeps PARK_GAS_RESERVE back from the vault's call, so this is the vault's need, the adapter's own
    /// work and the reserve), bisected over cold runs from this state, which it leaves as it found it, plus the surcharge
    /// of the `warm` accounts the delivery touches that this test touched before the bisection (ColdRuns).
    function leastDeliveringLimit(uint256 nd, uint256 nr, uint256 warm) internal returns (uint256 least) {
        uint256 snap = vm.snapshotState();
        assertTrue(deliversAt(nd, nr, 7_500_000), "delivers with plenty of gas");
        uint256 lo = PARK_GAS_RESERVE;
        uint256 hi = 7_500_000;
        while (hi - lo > 64) {
            uint256 mid = (lo + hi) / 2;
            vm.revertToState(snap);
            if (deliversAt(nd, nr, mid)) hi = mid;
            else lo = mid;
        }
        vm.revertToState(snap);
        least = hi + warm * ACCOUNT_SURCHARGE;
    }

    /// One point's bisection against the model: the least delivering limit over the mocks, then the model's central
    /// estimate of the live need (that limit, the real AlphaVault's carry when the batch carries tokens, and the
    /// precompile allowance) and its headroom over it, and the 15% rule on the same figures (what the limit gives beyond
    /// the reserve, plus the carry and the allowance, x 1.15, then the reserve). Asserts both.
    function checkLimitPoint(uint256 nd, uint256 nr, uint256 warm, string memory label)
        internal
        returns (uint256 least)
    {
        least = leastDeliveringLimit(nd, nr, warm);
        uint256 carry = nd == 0 ? 0 : REAL_ALPHAVAULT_1_0 - MOCK_1_0_AT_CALIBRATION;
        uint256 central = least + carry + PRECOMPILE_ALLOWANCE;
        uint256 ruleNeed = (least - PARK_GAS_RESERVE + carry + PRECOMPILE_ALLOWANCE) * 115 / 100 + PARK_GAS_RESERVE;
        uint256 model = vaultModel(nd + nr);
        emit log_named_uint(string.concat("least delivering limit ", label), least);
        emit log_named_int(string.concat("headroom over the central estimate ", label), int256(model) - int256(central));
        emit log_named_int(string.concat("slack under the 15% rule ", label), int256(model) - int256(ruleNeed));
        assertGe(model, central, string.concat(label, ": the model covers the central estimate"));
        assertGe(model, ruleNeed, string.concat(label, ": the model covers the 15% rule"));
    }

    /// The points where the model is tightest (R3 A-L1's bisection, re-run on this tree): the small batches with a
    /// redeem and a deposit-heavy one; then the largest legal batch.
    function test_gas_limit_smallBatches() public {
        uint256 snap = vm.snapshotState();
        checkLimitPoint(1, 0, 0, "1+0");
        vm.revertToState(snap);
        checkLimitPoint(0, 1, 0, "0+1");
        vm.revertToState(snap);
        checkLimitPoint(1, 1, 0, "1+1");
        vm.revertToState(snap);
        checkLimitPoint(10, 1, 0, "10+1");
    }

    function test_gas_limit_largeBatches() public {
        uint256 snap = vm.snapshotState();
        checkLimitPoint(50, 1, 0, "50+1");
        vm.revertToState(snap);
        checkLimitPoint(50, 50, 0, "50+50");
    }

    /// R3 A-L1 and the README's Task 61 note: a 1+1 batch at exactly the model's limit, with one hotkey listed and with
    /// four (each one more getStake in every delivery), from staked TAO; and each case's least delivering limit (the
    /// staking and the listing touched the vault and the staking stand-in first: 2 warm accounts).
    function test_gas_limit_oneAndFourHotkeysAtTheModel() public {
        vm.prank(keeper);
        vault.stakeIdle();
        uint256 snap = vm.snapshotState();

        uint256 least1 = checkLimitPoint(1, 1, 2, "1+1, 1 hotkey");
        vm.revertToState(snap);
        assertTrue(deliversAt(1, 1, vaultModel(2)), "1+1 at the model's limit, 1 hotkey: delivered");

        vm.revertToState(snap);
        listHotkeys(4);
        uint256 snap4 = vm.snapshotState();
        uint256 least4 = checkLimitPoint(1, 1, 2, "1+1, 4 hotkeys");
        vm.revertToState(snap4);
        assertTrue(deliversAt(1, 1, vaultModel(2)), "1+1 at the model's limit, 4 hotkeys: delivered");
        emit log_named_uint("each further listed hotkey's cost in a delivery's limit", (least4 - least1) / 3);
    }

    // ---- Task 61: the park write (PARK_GAS_RESERVE) ----
    // Measured 2026-11-14 (077e73f): the native park after a recipient that burned its gas 58,523 (1 deposit) and
    // 59,344 (50), the empty one of a redeem-only batch 31,626, the restore after a deliverParked whose recipient burned
    // its gas 14,437 (its record and total, deleted earlier in the transaction, cost little to write again); a token
    // park after a burning conversion leaves 121,646 of the 150,000 unused at the model's lowest limit (convertExact's
    // returned 64th helps it). The reserve holds 2.5 times the worst write.

    /// What the adapter had left unused when `ccipReceive` of `m` ended, the router giving it exactly `limit` gas, the
    /// side's slots cold (ColdRuns.lastFrameRemaining: the adapter frame's own remaining gas).
    function receiveRemaining(Client.Any2EVMMessage memory m, uint256 limit) internal returns (uint256) {
        cool(sideAccounts());
        vm.prank(address(routerBit));
        adapterBit.ccipReceive{gas: limit}(m);
        return lastFrameRemaining();
    }

    /// The gas a park's write takes after a recipient that burned all it was given (BurningRecipient): ccipReceive
    /// calls it with all but PARK_GAS_RESERVE and gets nothing back, so the park, the Delivered event and the return run
    /// on the reserve, less the call's own cost: the reserve less what is left over, at each of three limits, each run
    /// cold, plus the surcharge of the recipient's account, cold on chain (the vault) and created here (ColdRuns). `nd`
    /// deposits (tokens converted first, then a native park of their TAO, the call carrying value) or one redeem (a
    /// redeem-only batch: no conversion, an empty native park, its total read cold).
    function parkWrite(uint256 nd, uint256 nr) internal returns (uint256 worst) {
        address burner = address(new BurningRecipient());
        uint256[3] memory limits = [vaultModel(nd + nr), 3_000_000, 7_000_000];
        uint256 snap = vm.snapshotState();
        bytes memory batch = vaultBatch(nd, nr);
        for (uint256 i; i < limits.length; ++i) {
            vm.revertToState(snap);
            uint256 value = nd * 1e18;
            if (value != 0) taoBit.mint(address(adapterBit), value);
            Client.Any2EVMMessage memory m =
                wrap(burner, address(fd), batch, address(taoBit), value, BASE_SELECTOR, address(adapterBase));
            uint256 left = receiveRemaining(m, limits[i]);
            (uint128 amount, uint64 parkedAt, bool converted) = adapterBit.parked(parkKeyOf(burner, batch));
            assertGt(parkedAt, 0, "parked");
            assertTrue(converted, "as native TAO");
            assertEq(amount, value, "the batch's amount");
            uint256 used = PARK_GAS_RESERVE - left + ACCOUNT_SURCHARGE;
            if (used > worst) worst = used;
            emit log_named_uint(string.concat("park write, limit ", vm.toString(limits[i])), used);
        }
        vm.revertToState(snap);
    }

    /// The reserve's use by the park write, native (a deposit's TAO, after its conversion) and empty (a redeem-only
    /// batch): the candidate PARK_GAS_RESERVE (R3 A-I2, spec §3.2). No precompile runs after the failure, so the live
    /// chain's write costs what this one does.
    function test_gas_park_writeAfterABurningRecipient() public {
        uint256 native1 = parkWrite(1, 0);
        uint256 native50 = parkWrite(50, 0);
        uint256 empty = parkWrite(0, 1);
        emit log_named_uint("park write, worst, 1 deposit", native1);
        emit log_named_uint("park write, worst, 50 deposits", native50);
        emit log_named_uint("park write, worst, redeem-only", empty);
        uint256 worst = native1 > native50 ? native1 : native50;
        if (empty > worst) worst = empty;
        emit log_named_uint("park write, worst of all", worst);
        assertLe(worst * 2, PARK_GAS_RESERVE, "the reserve holds twice the worst park write");
    }

    /// A conversion that burns all its gas (ForeverMoney's withdrawLiquid running out): the token park is written on
    /// the reserve plus the 64th convertExact kept back, which it returns on its revert; logs what is left unused.
    function test_gas_park_tokenParkAfterABurningConversion() public {
        av.setBurnGas(true);
        uint256[3] memory limits = [vaultModel(1), 3_000_000, 7_000_000];
        uint256 snap = vm.snapshotState();
        uint256 least = type(uint256).max;
        for (uint256 i; i < limits.length; ++i) {
            vm.revertToState(snap);
            Client.Any2EVMMessage memory m = vaultBatchMessage(1, 0);
            uint256 left = receiveRemaining(m, limits[i]);
            (uint128 amount,, bool converted) = adapterBit.parked(parkKeyOf(address(vault), vaultBatch(1, 0)));
            assertEq(amount, 1e18, "parked");
            assertFalse(converted, "as tokens");
            if (left < least) least = left;
            emit log_named_uint(string.concat("token park: left unused, limit ", vm.toString(limits[i])), left);
        }
        assertGt(least, PARK_GAS_RESERVE / 2, "half the reserve left unused at the least");
    }

    /// deliverParked of a native park to a recipient that burns all it is given: the record is restored as a
    /// converted park on the reserve (spec §3.2). Logs the reserve's use, at the call's least legal gas
    /// (parkedDeliveryGas plus its own work before the check) and above it, the adapter's slots cold and the recipient's
    /// account (warm here, from the first park) surcharged (ColdRuns).
    function test_gas_park_restoreAfterABurningRecipient() public {
        address burner = address(new BurningRecipient());
        bytes memory batch = vaultBatch(1, 0);
        taoBit.mint(address(adapterBit), 1e18);
        Client.Any2EVMMessage memory m =
            wrap(burner, address(fd), batch, address(taoBit), 1e18, BASE_SELECTOR, address(adapterBase));
        // a gas limit, as CCIP gives one: the burner takes all it is given
        vm.prank(address(routerBit));
        adapterBit.ccipReceive{gas: 3_000_000}(m);
        uint256 need = adapterBit.parkedDeliveryGas(batch);
        uint256[3] memory limits = [need + 60_000, 3_000_000, 7_000_000];
        uint256 snap = vm.snapshotState();
        uint256 worst;
        for (uint256 i; i < limits.length; ++i) {
            vm.revertToState(snap);
            cool(sideAccounts());
            adapterBit.deliverParked{gas: limits[i]}(burner, address(fd), batch);
            uint256 left = lastFrameRemaining();
            (, uint64 parkedAt, bool converted) = adapterBit.parked(parkKeyOf(burner, batch));
            assertTrue(parkedAt != 0 && converted, "restored as a converted park");
            uint256 used = PARK_GAS_RESERVE - left + ACCOUNT_SURCHARGE;
            if (used > worst) worst = used;
            emit log_named_uint(string.concat("park restore, limit ", vm.toString(limits[i])), used);
        }
        assertLe(worst * 2, PARK_GAS_RESERVE, "the reserve holds twice the worst restore");
    }
}

/// @notice Task 61's exits (spec §3.8): the work after the walk of a payout and of a direct exit against EXIT_GAS_RESERVE,
/// over AdapterGasWorld (moved from AdapterGasTest at Task 65, unchanged but for Task 65's reserve and its floor).
contract AdapterGasExitsTest is AdapterGasWorld {
    // ---- Task 61: the work after the walk (EXIT_GAS_RESERVE) ----
    // Measured 2026-11-14 at Task 65 (EXIT_GAS_RESERVE 2,000,000), the walk's paying removal burning its share down to
    // 60,000: at the keeper's gas a one-entry payout over the mocks keeps 1,237,048 of the reserve spare after its work
    // (work about 763,000; four positions, three held and burning: 1,256,145), MockRouter's storing of the whole message
    // most of that work; through the real AlphaVault, Router and OnRamp (BittensorForkV32) 1,450,930 at one entry and
    // 1,352,465 at fifty (work about 549,000 and 648,000). redeemDirect at the site's floor keeps 1,965,364 (one
    // position) and 1,983,419 (four): its work after the walk is about 35,000 at most. At 1,200,000 (Task 61, 077e73f;
    // the committed tests' output) the mocks kept 449,675 and 468,784, the fork 663,688 and 565,016, redeemDirect
    // 1,165,457 and 1,183,588. Each case now asserts the reserve holds twice its work with LIVE_EXIT_ALLOWANCE (Task
    // 65; the T61a review's Minor 4), which 1,200,000 failed over the mocks (1,776,960 and 1,738,300 needed).

    /// CascadeConstants.EXIT_GAS_RESERVE, restated (2,000,000 since Task 65).
    uint256 constant EXIT_GAS_RESERVE_V = 2_000_000;
    /// What the live chain's precompile adds to the work after the walk over the mock's, rounded up: ForeverMoney's
    /// addStake in the payout's send (104,208 gas from an account, less the 21,000 intrinsic: about 83,000) and the walk's
    /// last getStake (27,427 less 21,000), the T61a review's live estimates (about 60,000 to 110,000 in all).
    uint256 constant LIVE_EXIT_ALLOWANCE = 150_000;
    /// The accounts a payout touches inside its own frame that the exits' world touched first (ColdRuns): the staking
    /// stand-in, the Bittensor adapter, the alpha vault, the bridged token and the router (the walk's and the payout
    /// engine's libraries are first touched by the payout itself).
    uint256 constant PAYOUT_WARM = 5;
    /// redeemDirect's: the staking stand-in (the holder, the transaction's sender, is warm on chain too).
    uint256 constant REDEEM_WARM = 1;

    /// The exits' world: the vault's idle TAO staked on HK1 (1,000 TAO), and, for `positions` > 1, HK2 to HK4 listed
    /// with 10 TAO each (listHotkeys) and HK1 to HK3 held (spec §3.8, a root hold), so the walk tries every position and
    /// the last pays. Then the staking stand-in swapped for StakingTap, MockStaking's state kept.
    function exitWorld(uint256 positions) internal {
        vm.prank(keeper);
        vault.stakeIdle();
        if (positions > 1) {
            listHotkeys(4);
            for (uint256 i = 1; i < 4; ++i) {
                staking.setPairLocked(bytes32(i), true);
            }
        }
        vm.etch(address(staking), address(new StakingTap(address(new MockStaking()))).code);
    }

    /// The walk's removals as the reserve is sized for (spec §3.8): each held one burns all it is given and is
    /// skipped, and the one that goes through burns its gas down to 60,000 before it completes, so the walk leaves the
    /// exit EXIT_GAS_RESERVE and what that removal hands back (logged). Off: the held ones refuse at once and the
    /// removal costs what it costs.
    function burningWalk(bool on) internal {
        staking.setBurnRemoveGas(on);
        staking.setRemovalKeepsGas(on ? 60_000 : 0);
    }

    /// A redeem-only batch of `nr` seeded holders (1 TAO each) delivered and its payout delay waited: its key and the
    /// keeper's payout list.
    function queuedPayout(uint256 nr) internal returns (bytes32 key, CascadeMessages.Payout[] memory list) {
        bytes memory batch = vaultBatch(0, nr);
        key = keccak256(abi.encode(BASE, address(fd), keccak256(batch)));
        Client.Any2EVMMessage memory m = vaultBatchMessage(0, nr);
        vm.recordLogs();
        vm.prank(address(routerBit));
        adapterBit.ccipReceive(m);
        list = redeemedList(vm.getRecordedLogs(), key);
        assertEq(list.length, nr, "every redeem queued");
        vm.warp(vm.getBlockTimestamp() + vaultLens.payoutDelay());
    }

    /// A transaction's intrinsic gas for `data`, high: 21,000 and 16 a byte, as if every byte were non-zero.
    function intrinsic(bytes memory data) internal pure returns (uint256) {
        return 21_000 + 16 * data.length;
    }

    /// The keeper's processPayouts of `key` as a transaction of `limit` gas (the call gets the limit less its intrinsic
    /// gas), the side's slots cold, with StakingTap eating `eat` gas inside the send's addStake: whether it went through.
    function payoutWithEat(bytes32 key, CascadeMessages.Payout[] memory list, uint256 limit, uint256 eat)
        internal
        returns (bool ok)
    {
        vm.store(address(staking), TAP_EAT_SLOT, bytes32(eat));
        uint256 gas = limit - intrinsic(abi.encodeCall(CascadeVault.processPayouts, (key, list, 50)));
        cool(sideAccounts());
        vm.prank(keeper);
        try vault.processPayouts{gas: gas}(key, list, 50) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    /// The least transaction gas a payout of `key` goes through with, to 256 gas: the binary-search estimate Bittensor's
    /// node gives (the keeper's `estimate`), plus the surcharge of the PAYOUT_WARM accounts (ColdRuns).
    function leastPayoutGas(bytes32 key, CascadeMessages.Payout[] memory list) internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        uint256 lo = 100_000;
        uint256 hi = 20_000_000;
        while (hi - lo > 256) {
            uint256 mid = (lo + hi) / 2;
            vm.revertToState(snap);
            if (payoutWithEat(key, list, mid, 0)) hi = mid;
            else lo = mid;
        }
        vm.revertToState(snap);
        return hi + PAYOUT_WARM * ACCOUNT_SURCHARGE;
    }

    /// The most gas the eater inside the payout's send (ForeverMoney's addStake, in StakingTap) can burn, to 256 gas,
    /// with the payout still going through at `limit`, less the surcharge of the PAYOUT_WARM accounts (ColdRuns): the
    /// work after the walk's margin. Also what the walk's last removal handed back.
    function payoutSpare(bytes32 key, CascadeMessages.Payout[] memory list, uint256 limit)
        internal
        returns (uint256 spare, uint256 removalLeft)
    {
        uint256 snap = vm.snapshotState();
        assertTrue(payoutWithEat(key, list, limit, 0), "the payout goes through with no eater");
        removalLeft = uint256(vm.load(address(staking), TAP_REMOVAL_LEFT_SLOT));
        uint256 lo;
        uint256 hi = limit;
        while (hi - lo > 256) {
            uint256 mid = (lo + hi) / 2;
            vm.revertToState(snap);
            if (payoutWithEat(key, list, limit, mid)) lo = mid;
            else hi = mid;
        }
        vm.revertToState(snap);
        uint256 surcharge = PAYOUT_WARM * ACCOUNT_SURCHARGE;
        spare = lo > surcharge ? lo - surcharge : 0;
    }

    /// processPayouts after a walk whose removals burn what they are given (spec §3.8): at the keeper's gas (its
    /// estimate, EXIT_GAS_RESERVE and unstakeGas per listed position: ops payout.ts gasAbove), the payout still goes
    /// through, and the eater measures what the reserve has spare over the work after the walk (the walk's own tail,
    /// the ledger, L3's effects, the adapter's send through the alpha vault's depositLiquid and the router,
    /// PayoutChunkSent): the spare less what the removal handed back is the reserve's own margin (the 64th the vault
    /// keeps at its call into the walk is spare too, uncounted). Over the mocks the send ends in MockRouter, which
    /// stores the whole message: the fork's figure, through the real OnRamp, is the one for the reserve
    /// (BittensorForkV32).
    function checkPayoutReserve(uint256 positions, uint256 entries) internal {
        string memory label = string.concat(vm.toString(entries), " entries, ", vm.toString(positions), " positions");
        exitWorld(positions);
        (bytes32 key, CascadeMessages.Payout[] memory list) = queuedPayout(entries);
        uint256 estimate = leastPayoutGas(key, list);
        burningWalk(true);
        uint256 keeperGas = estimate + EXIT_GAS_RESERVE_V + positions * vaultLens.unstakeGas();
        (uint256 spare, uint256 removalLeft) = payoutSpare(key, list, keeperGas);
        emit log_named_uint(string.concat("payout: estimate (least gas), ", label), estimate);
        emit log_named_uint(string.concat("payout: keeper gas, ", label), keeperGas);
        emit log_named_uint(string.concat("payout: the last removal handed back, ", label), removalLeft);
        emit log_named_uint(string.concat("payout: most eaten after the walk, ", label), spare);
        emit log_named_int(
            string.concat("payout: the reserve's margin (eaten - handed back), ", label),
            int256(spare) - int256(removalLeft)
        );
        assertReserveHoldsTwiceTheWork(spare, removalLeft, label);
    }

    /// Task 65 (the T61a review's Minor 4): the vault's EXIT_GAS_RESERVE (the keeper's and the site's rule above use
    /// the same) holds at least twice the work after the walk with the live chain's allowance, the work being the
    /// reserve less its margin (what an eater could burn after the walk, less what the walk's last removal handed back).
    function assertReserveHoldsTwiceTheWork(uint256 spare, uint256 removalLeft, string memory label) internal {
        uint256 reserve = vaultLens.EXIT_GAS_RESERVE();
        assertGt(spare, removalLeft, "the reserve alone covers the work after the walk");
        uint256 margin = spare - removalLeft;
        uint256 work = margin < reserve ? reserve - margin : 0;
        emit log_named_uint(string.concat("the work after the walk, about, ", label), work);
        assertLe(2 * (work + LIVE_EXIT_ALLOWANCE), reserve, "the reserve holds twice the work, the live costs included");
        assertEq(reserve, EXIT_GAS_RESERVE_V, "the rule's reserve is the vault's");
    }

    function test_gas_exit_payoutAfterABurningWalk() public {
        checkPayoutReserve(1, 1);
    }

    function test_gas_exit_payoutAfterFourBurningPositions() public {
        checkPayoutReserve(4, 1);
    }

    /// `holder`'s redeemDirect of `shares` as a transaction of `limit` gas (the call gets the limit less its intrinsic
    /// gas), the side's slots cold, its receive eating `eat` gas when paid: whether it paid.
    function redeemWithEat(EatingHolder holder, uint256 shares, uint256 limit, uint256 eat) internal returns (bool ok) {
        holder.setEat(eat);
        uint256 gas = limit - intrinsic(abi.encodeCall(CascadeVault.redeemDirect, (shares, false)));
        cool(sideAccounts());
        vm.prank(address(holder));
        try vault.redeemDirect{gas: gas}(shares, false) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    /// redeemDirect after a walk whose removals burn what they are given: at the gas the site sends it with when its
    /// estimate is lower (EXIT_GAS_RESERVE, unstakeGas per listed position and the web's EXIT_WORK_GAS, its 500,000
    /// estimate of the exit's own work), the exit still pays, and an eating holder measures what the reserve has spare
    /// over the work after the walk (the walk's own tail, the ledger, the payment, RedeemedDirect). The holder is a
    /// seeded one (0x1000 + 49, 20 TAO of shares), given the eater's code.
    function checkRedeemReserve(uint256 positions) internal {
        string memory label = string.concat(vm.toString(positions), " positions");
        EatingHolder holder = EatingHolder(payable(addr(0x1000 + 49)));
        vm.etch(address(holder), type(EatingHolder).runtimeCode);
        exitWorld(positions);
        burningWalk(true);
        uint256 limit = EXIT_GAS_RESERVE_V + positions * vaultLens.unstakeGas() + 500_000;
        uint256 snap = vm.snapshotState();
        assertTrue(redeemWithEat(holder, 1e24, limit, 0), "the exit pays at the site's floor");
        uint256 removalLeft = uint256(vm.load(address(staking), TAP_REMOVAL_LEFT_SLOT));
        uint256 lo;
        uint256 hi = limit;
        while (hi - lo > 256) {
            uint256 mid = (lo + hi) / 2;
            vm.revertToState(snap);
            if (redeemWithEat(holder, 1e24, limit, mid)) lo = mid;
            else hi = mid;
        }
        vm.revertToState(snap);
        uint256 surcharge = REDEEM_WARM * ACCOUNT_SURCHARGE;
        uint256 spare = lo > surcharge ? lo - surcharge : 0;
        emit log_named_uint(string.concat("redeemDirect: the site's floor, ", label), limit);
        emit log_named_uint(string.concat("redeemDirect: the last removal handed back, ", label), removalLeft);
        emit log_named_uint(string.concat("redeemDirect: most eaten after the walk, ", label), spare);
        emit log_named_int(
            string.concat("redeemDirect: the reserve's margin (eaten - handed back), ", label),
            int256(spare) - int256(removalLeft)
        );
        assertReserveHoldsTwiceTheWork(spare, removalLeft, label);
    }

    function test_gas_exit_redeemDirectAfterABurningWalk() public {
        uint256 snap = vm.snapshotState();
        checkRedeemReserve(1);
        vm.revertToState(snap);
        checkRedeemReserve(4);
    }
}

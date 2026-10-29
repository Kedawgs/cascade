// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CascadeMessages} from "../../src/libraries/CascadeMessages.sol";
import {Client} from "../../src/vendor/ccip/Client.sol";
import {AdaptersFixture} from "./AdaptersFixture.sol";

/// @notice Calibrates the deployment gas model `gasLimit = gasBase + entries * gasPerEntry` against receiver
/// gas measured by calling `ccipReceive` directly as the router (the router's own overhead is excluded).
contract AdapterGasTest is AdaptersFixture {
    // Deployment gas model, `gasLimit = min(gasBase + entries * gasPerEntry, 7_000_000)`, copied into the
    // deployment spec. Raw receiver gas (mock alpha vault and mock staking precompile, `ccipReceive` called
    // as the router):
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
    // onto it: 187,450 + (136,763 - 134,606) = 189,607, and (189,607 + 300,000) x 1.15 = 563,048 <= 566,450,
    // about 3,400 gas of slack. A batch with redeems has more: 50+50 is 3,147,707 <= 3,185,000.
    uint256 public constant GAS_BASE_TO_BITTENSOR = 540_000;
    uint256 public constant GAS_PER_ENTRY_TO_BITTENSOR = 26_450;
    uint256 public constant GAS_BASE_TO_BASE = 120_000;
    uint256 public constant GAS_PER_ENTRY_TO_BASE = 29_900;

    /// Two real precompile calls a delivery makes that the mock does not charge for (a real removeStake
    /// measured 144,811 gas; bittensor_evm_home_chain.md).
    uint256 constant PRECOMPILE_ALLOWANCE = 300_000;

    /// Task 8's real-AlphaVault receiver gas for the 1+0 point (BittensorFork's "receiver gas 1+0"), and the
    /// mock 1+0 gas this test read at the same calibration. The vault's own changes since move both alike.
    uint256 constant REAL_ALPHAVAULT_1_0 = 187_450;
    uint256 constant MOCK_1_0_AT_CALIBRATION = 134_606;

    /// 100 holders (0x1000 + i) deposit 10e18 each at A = 0, S = 0: 1e25 shares each.
    function setUp() public override {
        super.setUp();
        vm.deal(address(av), 2_000e18);
        CascadeMessages.Entry[] memory holders = new CascadeMessages.Entry[](100);
        for (uint256 i; i < 100; ++i) {
            holders[i] = CascadeMessages.Entry(addr(0x1000 + i), 10e18);
        }
        bytes memory batch = CascadeMessages.encodeBatch(1, holders, noEntries());
        taoBit.mint(address(adapterBit), 1_000e18);
        Client.Any2EVMMessage memory m =
            wrap(address(vault), address(fd), batch, address(taoBit), 1_000e18, BASE_SELECTOR, address(adapterBase));
        vm.prank(address(routerBit));
        adapterBit.ccipReceive(m);
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

    /// Gas of one `ccipReceive` on the vault side for `n` fresh deposits (0x2000 + i, 1e18) and `n` redeems
    /// of seeded holders (0x1000 + i, 1e24 each, batch id 2).
    function measureVault(uint256 n) internal returns (uint256 g) {
        CascadeMessages.Entry[] memory d = new CascadeMessages.Entry[](n);
        CascadeMessages.Entry[] memory r = new CascadeMessages.Entry[](n);
        for (uint256 i; i < n; ++i) {
            d[i] = CascadeMessages.Entry(addr(0x2000 + i), 1e18);
            r[i] = CascadeMessages.Entry(addr(0x1000 + i), 1e24);
        }
        uint256 value = n * 1e18;
        taoBit.mint(address(adapterBit), value);
        Client.Any2EVMMessage memory m = wrap(
            address(vault),
            address(fd),
            CascadeMessages.encodeBatch(2, d, r),
            address(taoBit),
            value,
            BASE_SELECTOR,
            address(adapterBase)
        );
        vm.prank(address(routerBit));
        g = gasleft();
        adapterBit.ccipReceive(m);
        g -= gasleft();
        assertEq(vault.balanceOf(addr(0x2000 + n - 1)), 1e24, "deposit credited");
        assertEq(vault.balanceOf(addr(0x1000 + n - 1)), 9e24, "redeem applied");
    }

    /// Gas of one `ccipReceive` on the front-door side for a chunk of `n` payouts (0x3000 + i, 1e18 each).
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
        vm.prank(address(routerBase));
        g = gasleft();
        adapterBase.ccipReceive(m);
        g -= gasleft();
        assertEq(fd.claimable(addr(0x3000 + n - 1)), 1e18, "payout credited");
    }

    function test_gas_vaultDeliveryModelHasHeadroom() public {
        uint256 s = vm.snapshotState();
        uint256 g1 = measureVaultDepositOnly();
        vm.revertToState(s);
        s = vm.snapshotState();
        uint256 g50 = measureVault(50);
        vm.revertToState(s);
        uint256 g100 = measureVault(100);
        emit log_named_uint("vault gas 1+0", g1);
        emit log_named_uint("vault gas 50+50", g50);
        emit log_named_uint("vault gas 100+100", g100);
        assertGe(GAS_BASE_TO_BITTENSOR + 1 * GAS_PER_ENTRY_TO_BITTENSOR, (g1 + PRECOMPILE_ALLOWANCE) * 115 / 100, "1+0");
        // the real-AlphaVault 1+0 point, carried forward by the vault's change since the calibration
        uint256 real1 = REAL_ALPHAVAULT_1_0 + g1 - MOCK_1_0_AT_CALIBRATION;
        uint256 need1 = (real1 + PRECOMPILE_ALLOWANCE) * 115 / 100;
        emit log_named_uint("real 1+0 (estimated)", real1);
        emit log_named_uint("real 1+0 slack", GAS_BASE_TO_BITTENSOR + GAS_PER_ENTRY_TO_BITTENSOR - need1);
        assertGe(GAS_BASE_TO_BITTENSOR + 1 * GAS_PER_ENTRY_TO_BITTENSOR, need1, "real 1+0");
        assertGe(
            GAS_BASE_TO_BITTENSOR + 100 * GAS_PER_ENTRY_TO_BITTENSOR, (g50 + PRECOMPILE_ALLOWANCE) * 115 / 100, "50+50"
        );
        assertGe(
            GAS_BASE_TO_BITTENSOR + 200 * GAS_PER_ENTRY_TO_BITTENSOR,
            (g100 + PRECOMPILE_ALLOWANCE) * 115 / 100,
            "100+100"
        );
        assertLe(GAS_BASE_TO_BITTENSOR + 200 * GAS_PER_ENTRY_TO_BITTENSOR, 7_000_000, "within GAS_CAP");
    }

    function measureVaultDepositOnly() internal returns (uint256 g) {
        CascadeMessages.Entry[] memory d = entries1(addr(0x2000), 1e18);
        taoBit.mint(address(adapterBit), 1e18);
        Client.Any2EVMMessage memory m = wrap(
            address(vault),
            address(fd),
            CascadeMessages.encodeBatch(2, d, noEntries()),
            address(taoBit),
            1e18,
            BASE_SELECTOR,
            address(adapterBase)
        );
        vm.prank(address(routerBit));
        g = gasleft();
        adapterBit.ccipReceive(m);
        g -= gasleft();
        assertEq(vault.balanceOf(addr(0x2000)), 1e24, "deposit credited");
    }

    function test_gas_frontDoorDeliveryModelHasHeadroom() public {
        uint256 s = vm.snapshotState();
        uint256 g1 = measureFrontDoor(1);
        vm.revertToState(s);
        s = vm.snapshotState();
        uint256 g50 = measureFrontDoor(50);
        vm.revertToState(s);
        uint256 g100 = measureFrontDoor(100);
        emit log_named_uint("front door gas 1", g1);
        emit log_named_uint("front door gas 50", g50);
        emit log_named_uint("front door gas 100", g100);
        assertGe(GAS_BASE_TO_BASE + 1 * GAS_PER_ENTRY_TO_BASE, g1 * 115 / 100, "1");
        assertGe(GAS_BASE_TO_BASE + 50 * GAS_PER_ENTRY_TO_BASE, g50 * 115 / 100, "50");
        assertGe(GAS_BASE_TO_BASE + 100 * GAS_PER_ENTRY_TO_BASE, g100 * 115 / 100, "100");
        assertLe(GAS_BASE_TO_BASE + 200 * GAS_PER_ENTRY_TO_BASE, 7_000_000, "within GAS_CAP");
    }
}

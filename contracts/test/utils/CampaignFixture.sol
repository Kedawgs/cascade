// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {CascadeVault} from "../../src/CascadeVault.sol";
import {CascadeFrontDoor} from "../../src/CascadeFrontDoor.sol";
import {CascadeStaker} from "../../src/CascadeStaker.sol";
import {CascadeVaultLens} from "../../src/lens/CascadeVaultLens.sol";
import {CascadeDoorLens} from "../../src/lens/CascadeDoorLens.sol";
import {ICascadeTwap} from "../../src/interfaces/ICascadeTwap.sol";
import {ISTAKING_ADDRESS} from "../../src/interfaces/IStaking.sol";
import {ADDRESS_MAPPING_ADDRESS} from "../../src/interfaces/IAddressMapping.sol";
import {MockAddressMapping} from "../mocks/MockAddressMapping.sol";
import {MockBridge} from "../mocks/MockBridge.sol";
import {MockStaking} from "../mocks/MockStaking.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";
import {MockSwapper} from "../mocks/MockSwapper.sol";
import {MockTAO} from "../mocks/MockTAO.sol";
import {MockTwap} from "../mocks/MockTwap.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {mirror} from "../mocks/Mirror.sol";
import {defaultFrontDoorParams, defaultStakerParams, defaultVaultParams} from "./DefaultParams.sol";
import {DoorInternals} from "./DoorInternals.sol";
import {VaultInternals} from "./VaultInternals.sol";

/// The Phase 8 campaigns' one deployment (Task 34a, ruling DB16): the EndToEnd fixture, the vault on BITTENSOR and
/// one front door on BASE over MockBridge (fee 1e15), as their test-only subclasses VaultInternals and DoorInternals
/// (which add no storage and no behaviour, so each lens can be checked against its target's internal values, I-33),
/// both lenses, the front door's swapper (a CascadeStaker at 15 bps selling through a mock router), its oracle (a
/// mock TWAP) and a swapper that pays short. The campaign's handler is the vault's keeper and the front door's, named
/// at deploy as the deployment names them, so it is the creation right after the fixture's.
///
/// The addresses named before their creation (the vault's own, for its expected coldkey; the front door, the
/// staker, the TWAP and the handler) are a plan: each creation from the plan's first nonce has its Slot, and each
/// lands at its slot's address or the setUp fails, naming the slot (`landed`). So a creation added, dropped or moved
/// anywhere in the sequence fails loudly at the first creation it shifts; it never wires a contract to an address
/// another contract took. A campaign changes its values through the params hooks, never the order.
abstract contract CampaignFixture is Test {
    uint64 internal constant BASE = 8453;
    uint64 internal constant BITTENSOR = 964;
    bytes32 internal constant HK1 = bytes32(uint256(1));
    uint256 internal constant ED = 1e12;
    uint256 internal constant FEE = 1e15;
    uint256 internal constant REQUEST_FEE = 1e14;
    uint256 internal constant HIGH_CAP = 1_000_000e18;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    /// The vault's treasury, which takes the reward cut and never acts (the staker's fee treasury too).
    address internal treasury = makeAddr("treasury");

    /// The creations in their order, from the plan's first nonce (see the contract's notes).
    enum Slot {
        Vault,
        FrontDoor,
        Router,
        Staker,
        Twap,
        ShortPayer,
        VaultLens,
        DoorLens,
        Handler
    }

    /// What the fixture deployed.
    struct Campaign {
        MockTAO tao;
        MockUSDC usdc;
        MockBridge bridge;
        VaultInternals vault;
        DoorInternals fd;
        CascadeVaultLens vaultLens;
        CascadeDoorLens doorLens;
        MockSwapRouter router;
        CascadeStaker staker;
        MockTwap twap;
        MockSwapper shortPayer;
    }

    uint256 private _planStart;
    bool private _planned;

    /// Deploys the fixture (see the contract's notes); the caller's next creation must be its handler, which it then
    /// passes to `landed(Slot.Handler, ...)`. Mocks first: the staking and address-mapping precompiles (exact fresh
    /// reads to start with; removals paid by a call with value and claims paid as balance forced, MockStaking's
    /// defaults since Task 35, so a call that reverts after its walk, its stake or its claim undoes them too), the
    /// bridged TAO, USDC and the bridge. The vault's limits are raised so that its deposit cap is
    /// never why a call fails, and its minChunk is 1 (a batch of 2 or 3 entries can go out in several chunks); the
    /// front door's deposit cap is raised likewise and its redeem-request fee is 1e14. Each campaign may change any
    /// value through the hooks below.
    function deployCampaign() internal returns (Campaign memory c) {
        vm.etch(ISTAKING_ADDRESS, address(new MockStaking()).code);
        vm.etch(ADDRESS_MAPPING_ADDRESS, address(new MockAddressMapping()).code);
        MockStaking staking = MockStaking(ISTAKING_ADDRESS);
        staking.addHotkey(HK1);
        staking.setOneRaoShort(false);
        c.tao = new MockTAO(18);
        c.usdc = new MockUSDC();
        c.bridge = new MockBridge(c.tao);
        c.bridge.setFee(FEE);

        _planStart = vm.getNonce(address(this));
        _planned = true;
        address keeper = planned(Slot.Handler);
        CascadeVault.Params memory p = defaultVaultParams(
            mirror(planned(Slot.Vault)), HK1, c.bridge, owner, guardian, keeper, BASE, planned(Slot.FrontDoor)
        );
        p.maxTotalAssets = HIGH_CAP;
        p.minChunk = 1;
        campaignVaultParams(p);
        c.vault = new VaultInternals(p);
        landed(Slot.Vault, address(c.vault));
        vm.deal(address(c.vault), ED);

        CascadeFrontDoor.Params memory fp =
            defaultFrontDoorParams(c.tao, c.bridge, BITTENSOR, address(c.vault), c.usdc, owner, guardian, keeper);
        fp.depositCap = HIGH_CAP;
        fp.redeemRequestFee = REQUEST_FEE;
        fp.oracle = ICascadeTwap(planned(Slot.Twap));
        fp.swapper = planned(Slot.Staker);
        campaignDoorParams(fp);
        c.fd = new DoorInternals(fp);
        landed(Slot.FrontDoor, address(c.fd));
        c.bridge.connect(BITTENSOR, address(c.vault), true);
        c.bridge.connect(BASE, address(c.fd), false);

        c.router = new MockSwapRouter();
        landed(Slot.Router, address(c.router));
        CascadeStaker.Params memory sp = defaultStakerParams(
            c.usdc,
            c.tao,
            c.fd,
            owner,
            treasury,
            address(c.router),
            abi.encodePacked(address(c.usdc), uint24(3000), address(c.tao)),
            abi.encodePacked(address(c.tao), uint24(3000), address(c.usdc))
        );
        // no deposit fee: the core handler never stakes USDC
        sp.depositFeeUsdc = 0;
        campaignStakerParams(sp);
        c.staker = new CascadeStaker(sp);
        landed(Slot.Staker, address(c.staker));
        c.twap = new MockTwap(250e6);
        landed(Slot.Twap, address(c.twap));
        c.shortPayer = new MockSwapper(c.tao, c.usdc);
        landed(Slot.ShortPayer, address(c.shortPayer));

        c.vaultLens = new CascadeVaultLens(address(c.vault));
        landed(Slot.VaultLens, address(c.vaultLens));
        c.doorLens = new CascadeDoorLens(address(c.fd));
        landed(Slot.DoorLens, address(c.doorLens));
    }

    /// The address the plan gives `s`: this contract's CREATE at the plan's first nonce plus the slot's place.
    function planned(Slot s) internal view returns (address) {
        require(_planned, "CampaignFixture: no plan yet");
        return vm.computeCreateAddress(address(this), _planStart + uint256(s));
    }

    /// Fails the setUp unless `created` is where the plan put slot `s`.
    function landed(Slot s, address created) internal view {
        if (created == planned(s)) return;
        string[9] memory names =
            ["vault", "front door", "router", "staker", "TWAP", "short payer", "vault lens", "door lens", "handler"];
        revert(string.concat("CampaignFixture: the deploy order moved; the ", names[uint256(s)], " landed elsewhere"));
    }

    /// Hooks: a campaign's own values, set on the fixture's (each defaults to none changed).
    function campaignVaultParams(
        CascadeVault.Params memory /* p */
    )
        internal
        view
        virtual {}

    function campaignDoorParams(
        CascadeFrontDoor.Params memory /* p */
    )
        internal
        view
        virtual {}

    function campaignStakerParams(
        CascadeStaker.Params memory /* p */
    )
        internal
        view
        virtual {}
}

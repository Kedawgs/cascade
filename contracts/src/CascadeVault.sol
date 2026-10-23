// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {CascadeBase} from "./CascadeBase.sol";
import {ICascadeBridge} from "./interfaces/ICascadeBridge.sol";
import {ISTAKING_ADDRESS, IStaking} from "./interfaces/IStaking.sol";
import {ADDRESS_MAPPING_ADDRESS, IAddressMapping} from "./interfaces/IAddressMapping.sol";
import {CascadeMath} from "./libraries/CascadeMath.sol";
import {CascadeMessages} from "./libraries/CascadeMessages.sol";

/// @notice Cascade vault on Bittensor EVM: holds the root stake and the csTAO share balances.
/// Front doors on other chains batch deposits and redemption requests and deliver them over a
/// registered bridge; Bittensor-native users can deposit directly.
/// @dev csTAO has 24 decimals and is non-transferable. Prices read the stake live through the
/// staking precompile; TAO is in wei here and in rao (1e9 wei) at the precompile.
contract CascadeVault is ERC20, CascadeBase {
    // ---- constants ----

    uint256 public constant RAO = 1e9;
    uint256 public constant NETUID_ROOT = 0;
    /// Never spent and never counted, so the chain's existential deposit cannot fail a payout.
    uint256 public constant ED_RESERVE = 1e12;
    uint256 public constant MAX_HOTKEYS = 4;
    uint64 public constant KEEPER_FALLBACK = 7 days;
    uint64 public constant REWARD_VESTING = 7 days;
    IStaking public constant STAKING = IStaking(ISTAKING_ADDRESS);
    IAddressMapping public constant ADDRESS_MAPPING = IAddressMapping(ADDRESS_MAPPING_ADDRESS);

    // ---- immutables ----

    /// The vault's own substrate coldkey (the mirror of its H160 address).
    bytes32 public immutable coldkey;

    // ---- state ----

    // hotkeys
    bytes32[] public hotkeys;
    mapping(bytes32 => bool) public isHotkey;
    bytes32 public stakeHotkey;
    mapping(bytes32 => uint64) public lastClaimAt;

    // keeper timing and the unstake guard
    address public keeper;
    uint64 public lastStakeAt;
    bool internal _unstaking;

    // accounting
    uint256 public pendingPayouts;
    uint256 public vestingAmount;
    uint64 public vestingStart;

    // front doors and direct users
    mapping(bytes32 => bool) public frontDoorActive;
    mapping(bytes32 => uint64) public frontDoorProposedAt;
    mapping(address => bool) public directOnly;

    // parameters (spec defaults; maxTotalAssets is a plan decision)
    uint32 public minChunk = 10;
    uint64 public payoutDelay = 24 hours;
    uint256 public maxDailyOutflowBps = 2000;
    uint256 public minDailyOutflow = 100e18;
    uint256 public maxEntryValue = 2_000e18;
    uint256 public maxMessageValue = 4_000e18;
    uint256 public maxFeeBps = 100;
    uint256 public maxFeeAbs = 0.02e18;
    uint256 public maxTotalAssets = 1_000e18;
    uint256 public minDirectDeposit;
    uint256 public hotkeyDustRao = 1_000_000;
    uint256 public claimGasRequired = 55_000_000;
    uint256 public fallbackMinStakeRao = 2_000_000;
    uint256 public fallbackMinRemainRao = 20_000_000;

    // ---- errors ----

    error ColdkeyMismatch(bytes32 expected, bytes32 derived);
    error ZeroHotkey();
    error NonTransferable();
    error PeerKnown();
    error PeerNotActive();
    error NotRaoAligned();
    error BelowMinDeposit();
    error CapExceeded();
    error InvalidParameter();
    error DirectTransferNotAllowed();

    // ---- events ----

    event StakeHotkeySet(bytes32 indexed hotkey);
    event FrontDoorProposed(uint64 indexed chain, address indexed addr, uint64 readyAt);
    event FrontDoorActivated(uint64 indexed chain, address indexed addr);
    event FrontDoorProposalCancelled(uint64 indexed chain, address indexed addr);
    event FrontDoorRemoved(uint64 indexed chain, address indexed addr);
    event DepositedDirect(address indexed user, uint256 assets, uint256 shares);
    event FrontDoorRedeemsAllowed(address indexed user);
    event KeeperSet(address keeper);
    event ClaimGasSet(uint256 claimGasRequired);
    event LimitSet(bytes32 indexed name, uint256 a, uint256 b);

    // ---- constructor ----

    constructor(
        bytes32 expectedColdkey,
        bytes32 hotkey,
        ICascadeBridge bridge,
        address owner_,
        address guardian_,
        uint256 minDirectDeposit_
    ) ERC20("Cascade Staked TAO", "csTAO") CascadeBase(owner_, guardian_, address(bridge)) {
        bytes32 derived = ADDRESS_MAPPING.addressMapping(address(this));
        if (derived != expectedColdkey) revert ColdkeyMismatch(expectedColdkey, derived);
        coldkey = derived;
        if (hotkey == bytes32(0)) revert ZeroHotkey();
        hotkeys.push(hotkey);
        isHotkey[hotkey] = true;
        stakeHotkey = hotkey;
        emit StakeHotkeySet(hotkey);
        minDirectDeposit = minDirectDeposit_;
        STAKING.setRejectStakingHotkeyGrowth(true);
    }

    // ---- token: 24 decimals, non-transferable ----

    function decimals() public pure override returns (uint8) {
        return 24;
    }

    function transfer(address, uint256) public pure override returns (bool) {
        revert NonTransferable();
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        revert NonTransferable();
    }

    function approve(address, uint256) public pure override returns (bool) {
        revert NonTransferable();
    }

    // ---- front-door registry ----

    function peerId(uint64 chain, address addr) public pure returns (bytes32) {
        return keccak256(abi.encode(chain, addr));
    }

    /// Re-proposing a pending peer restarts its delay.
    function proposeFrontDoor(uint64 chain, address addr) external onlyOwner {
        if (addr == address(0)) revert ZeroAddress();
        bytes32 id = peerId(chain, addr);
        if (frontDoorActive[id]) revert PeerKnown();
        frontDoorProposedAt[id] = uint64(block.timestamp);
        emit FrontDoorProposed(chain, addr, uint64(block.timestamp) + REGISTRY_DELAY);
    }

    function activateFrontDoor(uint64 chain, address addr) external onlyOwner {
        bytes32 id = peerId(chain, addr);
        uint64 proposedAt = frontDoorProposedAt[id];
        if (proposedAt == 0) revert NoProposal();
        if (block.timestamp < uint256(proposedAt) + REGISTRY_DELAY) revert NotReady();
        delete frontDoorProposedAt[id];
        frontDoorActive[id] = true;
        emit FrontDoorActivated(chain, addr);
    }

    function cancelFrontDoorProposal(uint64 chain, address addr) external onlyOwnerOrGuardian {
        bytes32 id = peerId(chain, addr);
        if (frontDoorProposedAt[id] == 0) revert NoProposal();
        delete frontDoorProposedAt[id];
        emit FrontDoorProposalCancelled(chain, addr);
    }

    function removeFrontDoor(uint64 chain, address addr) external onlyOwnerOrGuardian {
        bytes32 id = peerId(chain, addr);
        if (!frontDoorActive[id]) revert PeerNotActive();
        frontDoorActive[id] = false;
        emit FrontDoorRemoved(chain, addr);
    }

    // ---- views ----

    /// Root stake across the hotkey set, in rao.
    function rootStakeRao() public view returns (uint256 total) {
        uint256 n = hotkeys.length;
        for (uint256 i; i < n; ++i) {
            total += STAKING.getStake(hotkeys[i], coldkey, NETUID_ROOT);
        }
    }

    function grossAssets() public view returns (uint256) {
        return _sub0(rootStakeRao() * RAO + address(this).balance, ED_RESERVE);
    }

    function unvestedRewards() public view returns (uint256) {
        uint256 elapsed = block.timestamp - vestingStart;
        if (elapsed >= REWARD_VESTING) return 0;
        return vestingAmount * (REWARD_VESTING - elapsed) / REWARD_VESTING;
    }

    function totalAssets() public view returns (uint256) {
        return _sub0(grossAssets(), pendingPayouts + unvestedRewards());
    }

    /// Assets per share, scaled by 1e18.
    function price() external view returns (uint256) {
        return CascadeMath.price(totalAssets(), totalSupply());
    }

    // ---- direct access ----

    function depositDirect() external payable whenNotPaused nonReentrant {
        uint256 assets = msg.value;
        if (assets % RAO != 0) revert NotRaoAligned();
        if (assets < minDirectDeposit) revert BelowMinDeposit();
        uint256 assetsBefore = _sub0(totalAssets(), assets);
        if (assetsBefore + assets > maxTotalAssets) revert CapExceeded();
        // Set on every direct deposit: a front door may redeem for this address only after an opt-in.
        directOnly[msg.sender] = true;
        uint256 shares = CascadeMath.sharesForDeposit(assets, assetsBefore, totalSupply());
        _mint(msg.sender, shares);
        emit DepositedDirect(msg.sender, assets, shares);
    }

    function allowFrontDoorRedeems() external {
        directOnly[msg.sender] = false;
        emit FrontDoorRedeemsAllowed(msg.sender);
    }

    // ---- admin: parameters ----

    /// address(0) leaves only the permissionless fallback.
    function setKeeper(address newKeeper) external onlyOwner {
        keeper = newKeeper;
        emit KeeperSet(newKeeper);
    }

    function setMinDirectDeposit(uint256 amount) external onlyOwner {
        minDirectDeposit = amount;
        emit LimitSet("minDirectDeposit", amount, 0);
    }

    function setMaxTotalAssets(uint256 amount) external onlyOwner {
        maxTotalAssets = amount;
        emit LimitSet("maxTotalAssets", amount, 0);
    }

    function setOutflowLimits(uint256 bps, uint256 minDaily) external onlyOwner {
        if (bps > 10_000) revert InvalidParameter();
        maxDailyOutflowBps = bps;
        minDailyOutflow = minDaily;
        emit LimitSet("maxDailyOutflowBps", bps, minDaily);
    }

    function setMessageLimits(uint256 maxEntryValue_, uint256 maxMessageValue_, uint32 minChunk_) external onlyOwner {
        if (maxEntryValue_ > maxMessageValue_ || minChunk_ == 0 || minChunk_ > CascadeMessages.MAX_ENTRIES) {
            revert InvalidParameter();
        }
        maxEntryValue = maxEntryValue_;
        maxMessageValue = maxMessageValue_;
        minChunk = minChunk_;
        emit LimitSet("maxEntryValue", maxEntryValue_, maxMessageValue_);
        emit LimitSet("minChunk", minChunk_, 0);
    }

    function setFeeLimits(uint256 bps, uint256 abs_) external onlyOwner {
        if (bps > 10_000) revert InvalidParameter();
        maxFeeBps = bps;
        maxFeeAbs = abs_;
        emit LimitSet("maxFeeBps", bps, abs_);
    }

    function setPayoutDelay(uint64 delay) external onlyOwner {
        if (delay > 7 days) revert InvalidParameter();
        payoutDelay = delay;
        emit LimitSet("payoutDelay", delay, 0);
    }

    function setClaimGasRequired(uint256 gasRequired) external onlyOwner {
        claimGasRequired = gasRequired;
        emit ClaimGasSet(gasRequired);
    }

    function setHotkeyDustRao(uint256 rao) external onlyOwner {
        hotkeyDustRao = rao;
        emit LimitSet("hotkeyDustRao", rao, 0);
    }

    function setFloorFallbacks(uint256 minStake, uint256 minRemain) external onlyOwner {
        if (minStake == 0 || minStake > minRemain || minRemain > 1e9) revert InvalidParameter();
        fallbackMinStakeRao = minStake;
        fallbackMinRemainRao = minRemain;
        emit LimitSet("fallbackMinStakeRao", minStake, minRemain);
    }

    // ---- receive ----

    /// Value arrives only through depositDirect, a batch delivery, or an unstake in progress.
    receive() external payable {
        if (!_unstaking) revert DirectTransferNotAllowed();
    }

    // ---- internal ----

    /// a - b, floored at 0.
    function _sub0(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}

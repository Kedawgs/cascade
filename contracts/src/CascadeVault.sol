// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CascadeBase} from "./CascadeBase.sol";
import {ICascadeBridge, ICascadeReceiver} from "./interfaces/ICascadeBridge.sol";
import {ISTAKING_ADDRESS, IStaking} from "./interfaces/IStaking.sol";
import {ADDRESS_MAPPING_ADDRESS, IAddressMapping} from "./interfaces/IAddressMapping.sol";
import {CascadeMath} from "./libraries/CascadeMath.sol";
import {CascadeMessages} from "./libraries/CascadeMessages.sol";

/// @notice Cascade vault on Bittensor EVM: holds the root stake and the csTAO share balances.
/// Front doors on other chains batch deposits and redemption requests and deliver them over a
/// registered bridge; Bittensor-native users can deposit directly.
/// @dev csTAO has 24 decimals and is non-transferable. Prices read the stake live through the
/// staking precompile; TAO is in wei here and in rao (1e9 wei) at the precompile.
contract CascadeVault is ERC20, CascadeBase, ICascadeReceiver {
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

    // batch delivery and the payout queue (entries are not stored: the keeper resubmits them from
    // the Redeemed events and the vault checks them against payoutsHash)
    struct PayoutBatch {
        uint64 sourceChain;
        address frontDoor;
        uint64 batchId;
        uint64 queuedAt;
        uint32 cursor;
        uint32 count;
        uint32 chunk;
        uint256 remaining;
        bytes32 payoutsHash;
    }

    struct Window {
        uint64 start;
        uint256 burned;
    }

    /// Every delivered batch, payouts or not: the replay record.
    mapping(bytes32 => bool) public processed;
    mapping(bytes32 => PayoutBatch) public payoutBatches;
    /// Value burned per front door (keyed by peerId) in its current 24-hour window.
    mapping(bytes32 => Window) public burnWindows;

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
    error HotkeyKnown();
    error TooManyHotkeys();
    error UnknownHotkey();
    error HotkeyInUse();
    error HotkeyHasRewards();
    error NotKeeper();
    error NothingToStake();
    error ZeroAmount();
    error TransferFailed();
    error UnstakeShort();
    error InsufficientGas();
    error VaultInsolvent();
    error UnknownPeer();
    error ValueMismatch();
    error AmountMismatch();
    error DuplicateBatch();

    // ---- events ----

    event StakeHotkeySet(bytes32 indexed hotkey);
    event HotkeyAdded(bytes32 indexed hotkey);
    /// `unclaimed` is the hotkey's unclaimed root reward at removal, 18-decimal.
    event HotkeyRemoved(bytes32 indexed hotkey, uint256 unclaimed, bool forfeit);
    /// `moved` is the destination's measured stake increase, in rao.
    event StakeMoved(bytes32 indexed from, bytes32 indexed to, uint256 rao, uint256 moved);
    /// `measured` is the stake hotkey's measured stake increase, in rao.
    event Staked(bytes32 indexed hotkey, uint256 rao, uint256 measured);
    /// `receivedWei` is the vault's measured balance increase.
    event Unstaked(bytes32 indexed hotkey, uint256 wantRao, uint256 receivedWei);
    /// `deltaRao` is the hotkey's measured stake increase from the claim.
    event RewardsClaimed(bytes32 indexed hotkey, uint256 deltaRao);
    event FrontDoorProposed(uint64 indexed chain, address indexed addr, uint64 readyAt);
    event FrontDoorActivated(uint64 indexed chain, address indexed addr);
    event FrontDoorProposalCancelled(uint64 indexed chain, address indexed addr);
    event FrontDoorRemoved(uint64 indexed chain, address indexed addr);
    event DepositedDirect(address indexed user, uint256 assets, uint256 shares);
    event RedeemedDirect(address indexed user, uint256 shares, uint256 assets);
    event FrontDoorRedeemsAllowed(address indexed user);
    event KeeperSet(address keeper);
    event ClaimGasSet(uint256 claimGasRequired);
    event LimitSet(bytes32 indexed name, uint256 a, uint256 b);
    event BatchDelivered(
        bytes32 indexed key, uint64 indexed sourceChain, address indexed frontDoor, uint64 batchId, uint256 amount
    );
    event DepositSkipped(bytes32 indexed key, address user, uint256 assets);
    event Deposited(bytes32 indexed key, address indexed user, uint256 assets, uint256 shares);
    event RedeemSkipped(bytes32 indexed key, address indexed user, uint256 requested);
    event RedeemDeferred(bytes32 indexed key, address indexed user, uint256 requested);
    event Redeemed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets);
    /// `price` is the batch price, CascadeMath.price(A, S).
    event PayoutBatchQueued(
        bytes32 indexed key, uint64 indexed sourceChain, uint64 batchId, uint32 count, uint256 total, uint256 price
    );

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

    function hotkeyCount() external view returns (uint256) {
        return hotkeys.length;
    }

    /// The chain's minimum stake operation, in rao; the owner-set fallback if the read fails.
    function minStakeRao() public view returns (uint256) {
        try STAKING.getDefaultMinStake{gas: 100_000}() returns (uint256 v) {
            return v;
        } catch {
            return fallbackMinStakeRao;
        }
    }

    /// The chain's minimum nominator position, in rao; the owner-set fallback if the read fails.
    function minRemainRao() public view returns (uint256) {
        try STAKING.getNominatorMinRequiredStake{gas: 100_000}() returns (uint256 v) {
            return v;
        } catch {
            return fallbackMinRemainRao;
        }
    }

    // ---- stake and hotkeys ----

    /// Adds `h` to the set without routing new stake to it (e.g. to claim a forfeited hotkey's rewards).
    function addHotkey(bytes32 h) external onlyOwner {
        _addHotkey(h);
    }

    function setStakeHotkey(bytes32 h) external onlyOwner {
        if (!isHotkey[h]) _addHotkey(h);
        stakeHotkey = h;
        emit StakeHotkeySet(h);
    }

    /// Moves root stake from `from` onto the stake hotkey (root to root, fee-free).
    function moveStake(bytes32 from, uint256 rao) external onlyOwner {
        if (!isHotkey[from]) revert UnknownHotkey();
        if (from == stakeHotkey) revert HotkeyInUse();
        _moveStake(from, rao);
    }

    /// Clears any stake left on `h` first, so dust parked on it cannot block removal. Unless
    /// `forfeit`, refuses while `h` has unclaimed rewards above the dust allowance; forfeited
    /// rewards stay owed on chain and can be claimed after re-adding `h`.
    function removeHotkey(bytes32 h, bool forfeit) external onlyOwner {
        if (!isHotkey[h]) revert UnknownHotkey();
        if (h == stakeHotkey) revert HotkeyInUse();

        uint256 leftover = _stakeOf(h);
        if (leftover != 0) {
            if (leftover < minStakeRao()) {
                // A move below the minimum would be refused; the TAO becomes idle balance.
                _unstaking = true;
                _removeStake(h, leftover, true);
                _unstaking = false;
            } else {
                _moveStake(h, leftover);
            }
        }

        uint256 unclaimed = STAKING.getUnclaimedRootTaoByHotkey(coldkey, h);
        if (!forfeit && unclaimed > hotkeyDustRao * RAO) revert HotkeyHasRewards();

        uint256 last = hotkeys.length - 1;
        for (uint256 i; i <= last; ++i) {
            if (hotkeys[i] == h) {
                hotkeys[i] = hotkeys[last];
                break;
            }
        }
        hotkeys.pop();
        isHotkey[h] = false;
        emit HotkeyRemoved(h, unclaimed, forfeit);
    }

    /// Stakes the liquid balance not reserved for queued payouts or the existential deposit. Keeper
    /// only, or anyone once KEEPER_FALLBACK has passed since the last stake.
    function stakeIdle() external whenNotPaused nonReentrant {
        // forge-lint: disable-next-line(block-timestamp)
        if (msg.sender != keeper && block.timestamp < lastStakeAt + KEEPER_FALLBACK) revert NotKeeper();
        uint256 rao = _available() / RAO;
        if (rao < minStakeRao()) revert NothingToStake();

        bytes32 h = stakeHotkey;
        uint256 before = _stakeOf(h);
        STAKING.addStake(h, rao, NETUID_ROOT);
        uint256 measured = _sub0(_stakeOf(h), before);
        lastStakeAt = uint64(block.timestamp);
        emit Staked(h, rao, measured);
    }

    // ---- rewards ----

    /// Claims `hotkey`'s root rewards into stake and vests the measured increase over REWARD_VESTING,
    /// on top of what is still unvested. An empty claim leaves the schedule as it is. Keeper only, or
    /// anyone once KEEPER_FALLBACK has passed since this hotkey's last claim. Works while paused. The
    /// chain can refuse a claim by burning the forwarded gas; the revert bubbles up and nothing changes.
    function claimRewards(bytes32 hotkey) external nonReentrant {
        if (!isHotkey[hotkey]) revert UnknownHotkey();
        // forge-lint: disable-next-line(block-timestamp)
        if (msg.sender != keeper && block.timestamp < lastClaimAt[hotkey] + KEEPER_FALLBACK) revert NotKeeper();
        if (gasleft() < claimGasRequired) revert InsufficientGas();

        uint256 before = _stakeOf(hotkey);
        STAKING.claimRootWithHotkey(hotkey);
        uint256 delta = _sub0(_stakeOf(hotkey), before);
        lastClaimAt[hotkey] = uint64(block.timestamp);
        // restarting on 0 would re-spread the unvested remainder over a fresh REWARD_VESTING
        if (delta != 0) {
            vestingAmount = unvestedRewards() + delta * RAO;
            vestingStart = uint64(block.timestamp);
        }
        emit RewardsClaimed(hotkey, delta);
    }

    // ---- direct access ----

    function depositDirect() external payable whenNotPaused nonReentrant {
        uint256 assets = msg.value;
        if (assets % RAO != 0) revert NotRaoAligned();
        if (assets < minDirectDeposit) revert BelowMinDeposit();
        uint256 assetsBefore = _sub0(totalAssets(), assets);
        uint256 supply = totalSupply();
        // Below half the launch price (1e-6 TAO per share) assets were lost; minting there would hand
        // this deposit much of the vault. A supply of 0 never trips it.
        if (assetsBefore * 2_000_000 < supply) revert VaultInsolvent();
        if (assetsBefore + assets > maxTotalAssets) revert CapExceeded();
        // Set on every direct deposit: a front door may redeem for this address only after an opt-in.
        directOnly[msg.sender] = true;
        uint256 shares = CascadeMath.sharesForDeposit(assets, assetsBefore, supply);
        _mint(msg.sender, shares);
        emit DepositedDirect(msg.sender, assets, shares);
    }

    function allowFrontDoorRedeems() external {
        directOnly[msg.sender] = false;
        emit FrontDoorRedeemsAllowed(msg.sender);
    }

    /// Burns `shares` and pays their value to the caller, unstaking any shortfall. No outflow cap:
    /// the share owner signs on this chain, and root unstaking is 1:1 and fee-free.
    function redeemDirect(uint256 shares) external whenNotPaused nonReentrant {
        uint256 out = CascadeMath.assetsForRedeem(shares, totalAssets(), totalSupply());
        out -= out % RAO;
        // Also covers shares == 0.
        if (out == 0) revert ZeroAmount();
        _burn(msg.sender, shares);
        uint256 available = _available();
        // An under-delivering unstake must never be paid from ED_RESERVE or queued payouts.
        if (available < out && _unstake(out - available) != 0) revert UnstakeShort();
        (bool ok,) = msg.sender.call{value: out}("");
        if (!ok) revert TransferFailed();
        emit RedeemedDirect(msg.sender, shares, out);
    }

    // ---- bridge delivery ----

    function batchKey(uint64 sourceChain, address sender, bytes calldata message) public pure returns (bytes32) {
        return keccak256(abi.encode(sourceChain, sender, keccak256(message)));
    }

    function getPayoutBatch(bytes32 key) external view returns (PayoutBatch memory) {
        return payoutBatches[key];
    }

    /// Delivers a front door's BATCH with its deposits' TAO. Prices every entry at one price fixed
    /// before the batch (A = assets without this delivery, S = supply), mints for deposits, then burns
    /// for redeems within the front door's daily allowance and queues their payouts. No per-entry
    /// condition reverts the batch. Reverts while paused so the rail holds the money. No staking or
    /// claiming here.
    function onBridgeMessage(uint64 sourceChain, address sender, bytes calldata message, uint256 amount)
        external
        payable
        nonReentrant
    {
        // whenNotPaused, checked after the bridge
        _requireBridge();
        _requireNotPaused();
        bytes32 peer = peerId(sourceChain, sender);
        if (!frontDoorActive[peer]) revert UnknownPeer();
        if (msg.value != amount) revert ValueMismatch();
        (uint64 batchId, CascadeMessages.Entry[] memory deposits, CascadeMessages.Entry[] memory redeems) =
            CascadeMessages.decodeBatch(message);
        {
            uint256 sum;
            for (uint256 i; i < deposits.length; ++i) {
                sum += deposits[i].amount;
            }
            if (sum != amount) revert AmountMismatch();
        }
        bytes32 key = batchKey(sourceChain, sender, message);
        if (processed[key]) revert DuplicateBatch();
        processed[key] = true;
        emit BatchDelivered(key, sourceChain, sender, batchId, amount);

        uint256 A = _sub0(totalAssets(), msg.value - msg.value % RAO);
        uint256 S = totalSupply();
        // Below half the launch price (1e-6 TAO per share) assets were lost; minting there would hand
        // these deposits much of the vault. S == 0 never trips it.
        if (A * 2_000_000 < S) revert VaultInsolvent();

        _creditDeposits(key, deposits, A, S);
        PayoutBatch memory b = _burnRedeems(key, peer, redeems, A, S);
        if (b.remaining != 0) {
            b.sourceChain = sourceChain;
            b.frontDoor = sender;
            b.batchId = batchId;
            b.queuedAt = uint64(block.timestamp);
            payoutBatches[key] = b;
            pendingPayouts += b.remaining;
            emit PayoutBatchQueued(key, sourceChain, batchId, b.count, b.remaining, CascadeMath.price(A, S));
        }
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

    /// The vault's root stake on `h`, in rao.
    function _stakeOf(bytes32 h) internal view returns (uint256) {
        return STAKING.getStake(h, coldkey, NETUID_ROOT);
    }

    /// Liquid balance above the existential reserve and queued payouts, floored at 0, in wei.
    function _available() internal view returns (uint256) {
        return _sub0(_sub0(address(this).balance, ED_RESERVE), pendingPayouts);
    }

    /// Delivery step 1: mints each deposit, floored to rao, at (A, S). A zero user is skipped and its
    /// TAO stays in the vault.
    function _creditDeposits(bytes32 key, CascadeMessages.Entry[] memory deposits, uint256 A, uint256 S) internal {
        for (uint256 i; i < deposits.length; ++i) {
            address user = deposits[i].user;
            uint256 a = deposits[i].amount;
            a -= a % RAO;
            if (user == address(0)) {
                emit DepositSkipped(key, user, a);
                continue;
            }
            uint256 shares = CascadeMath.sharesForDeposit(a, A, S);
            _mint(user, shares);
            emit Deposited(key, user, a, shares);
        }
    }

    /// Delivery steps 2-3: burns each redeem at (A, S), clipped to the holder's balance, the per-entry
    /// bound and the front door's remaining daily allowance. Returns the queue's count, total (as
    /// `remaining`) and running hash; the caller fills in the rest.
    function _burnRedeems(bytes32 key, bytes32 peer, CascadeMessages.Entry[] memory redeems, uint256 A, uint256 S)
        internal
        returns (PayoutBatch memory b)
    {
        if (redeems.length == 0) return b;
        Window memory w = burnWindows[peer];
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= w.start + 24 hours) w = Window(uint64(block.timestamp), 0);
        // gross includes the deposits just credited
        uint256 allowance = _sub0(Math.max(grossAssets() * maxDailyOutflowBps / 10_000, minDailyOutflow), w.burned);
        uint256 maxEntry = maxEntryValue;
        for (uint256 i; i < redeems.length; ++i) {
            address user = redeems[i].user;
            uint256 requested = redeems[i].amount;
            uint256 s = Math.min(requested, balanceOf(user));
            if (s == 0 || directOnly[user]) {
                emit RedeemSkipped(key, user, requested);
                continue;
            }
            s = Math.min(s, CascadeMath.sharesForDeposit(Math.min(maxEntry, allowance), A, S));
            uint256 out = CascadeMath.assetsForRedeem(s, A, S);
            out -= out % RAO;
            if (out == 0) {
                // nothing burned; the holder keeps the shares and may request again
                emit RedeemDeferred(key, user, requested);
                continue;
            }
            _burn(user, s);
            // out <= cap <= allowance, since s <= sharesForDeposit(cap, A, S)
            allowance -= out;
            b.remaining += out;
            ++b.count;
            b.payoutsHash = keccak256(abi.encode(b.payoutsHash, user, s, out));
            emit Redeemed(key, user, s, out);
        }
        if (b.remaining != 0) {
            w.burned += b.remaining;
            burnWindows[peer] = w;
        }
    }

    function _addHotkey(bytes32 h) internal {
        if (h == bytes32(0)) revert ZeroHotkey();
        if (isHotkey[h]) revert HotkeyKnown();
        if (hotkeys.length >= MAX_HOTKEYS) revert TooManyHotkeys();
        hotkeys.push(h);
        isHotkey[h] = true;
        emit HotkeyAdded(h);
    }

    function _moveStake(bytes32 from, uint256 rao) internal {
        bytes32 to = stakeHotkey;
        uint256 before = _stakeOf(to);
        STAKING.moveStake(from, to, NETUID_ROOT, NETUID_ROOT, rao);
        emit StakeMoved(from, to, rao, _sub0(_stakeOf(to), before));
    }

    /// Unstakes at least `shortfallWei` (when the stake allows), walking the stake hotkey first and
    /// then the set in order. Rounds each request up to the chain's floors and exits a position fully
    /// when the chain would sweep its remainder anyway. A precompile revert bubbles up; retry later.
    /// Returns the part of the shortfall the measured receipts did not cover (0 when covered); a short
    /// receipt never reverts here, the caller decides.
    function _unstake(uint256 shortfallWei) internal returns (uint256 unmet) {
        unmet = shortfallWei;
        uint256 minStake = minStakeRao();
        uint256 minRemain = minRemainRao();
        bytes32 first = stakeHotkey;
        uint256 n = hotkeys.length;
        _unstaking = true;
        // i == 0 is the stake hotkey; i >= 1 is hotkeys[i - 1], skipping the stake hotkey.
        for (uint256 i; i <= n && unmet != 0; ++i) {
            bytes32 h = i == 0 ? first : hotkeys[i - 1];
            if (i != 0 && h == first) continue;
            uint256 s = _stakeOf(h);
            if (s == 0) continue;
            uint256 want = Math.max(Math.ceilDiv(unmet, RAO), minStake);
            uint256 received = _removeStake(h, want, want >= s || s - want < minRemain);
            unmet -= Math.min(unmet, received);
        }
        _unstaking = false;
    }

    /// Removes `want` rao from `h` (or the whole position when `full`) and returns the measured
    /// balance increase. The caller sets `_unstaking`.
    function _removeStake(bytes32 h, uint256 want, bool full) internal returns (uint256 received) {
        uint256 before = address(this).balance;
        if (full) STAKING.removeStakeFull(h, NETUID_ROOT);
        else STAKING.removeStake(h, want, NETUID_ROOT);
        received = _sub0(address(this).balance, before);
        emit Unstaked(h, want, received);
    }
}

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
    uint16 public constant MAX_REWARD_CUT_BPS = 2_000;
    /// Stake added by stakeIdle enters the outflow allowance's base linearly over this period.
    uint256 internal constant STAKE_RAMP = 1 days;
    // Hard bounds on the owner's exit-safety parameters, so no setting removes the outflow cap, the
    // payout delay or the fee ceiling, or makes payouts unsendable.
    uint64 internal constant MIN_PAYOUT_DELAY = 1 hours;
    uint256 internal constant MAX_OUTFLOW_BPS = 5_000;
    uint256 internal constant MAX_MIN_DAILY_OUTFLOW = 100e18;
    /// The lane's per-message limit (the adapters' MAX_MESSAGE_VALUE at most).
    uint256 internal constant MAX_MESSAGE_VALUE = 5_000e18;
    uint256 internal constant MAX_FEE_BPS = 500;
    uint256 internal constant MAX_FEE_ABS = 0.1e18;
    uint256 internal constant MAX_UNSTAKE_MARGIN_RAO = 1e9;
    /// The smallest front-door redeem burned: anything smaller could, after its share of the payout fee,
    /// fall below the bridge's conversion floor (0.002 TAO today) and never be sent.
    uint256 internal constant MIN_REDEEM_VALUE = 0.01e18;
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
    /// Wei staked by stakeIdle, still entering the allowance base over STAKE_RAMP from lastStakeAt.
    uint256 internal rampingStake;

    // accounting
    uint256 public pendingPayouts;
    uint256 public vestingAmount;
    uint64 public vestingStart;

    // reward cut: the share of each claim minted to the treasury as csTAO
    address public treasury;
    uint16 public rewardCutBps;

    // front doors and direct users
    mapping(bytes32 => bool) public frontDoorActive;
    mapping(bytes32 => uint64) public frontDoorProposedAt;
    mapping(address => bool) public directOnly;

    // batch delivery and the payout queue (entries are not stored: the keeper resubmits them from
    // the DepositBounced and Redeemed events and the vault checks them against payoutsHash)
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
    /// Read with getPayoutBatch.
    mapping(bytes32 => PayoutBatch) internal payoutBatches;
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
    /// Added to every unstake request, in rao, to cover a chain fee or short delivery on root unstakes.
    uint256 public unstakeMarginRao;

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
    error NotAuthorized();
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
    error NotPending();
    error PayoutsMismatch();
    error PayoutDelayed();
    error FrontDoorInactive();
    error FeeTooHigh();

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
    /// `deltaRao` is the vault's measured position increase from the claim (stake across the set plus
    /// liquid balance), in rao, floored.
    event RewardsClaimed(bytes32 indexed hotkey, uint256 deltaRao);
    event RewardCutSet(address treasury, uint16 bps);
    /// `assets` is the cut, 18-decimal; `shares` its csTAO at the price before the claim.
    event RewardCutMinted(address indexed treasury, uint256 assets, uint256 shares);
    event FrontDoorProposed(uint64 indexed chain, address indexed addr, uint64 readyAt);
    event FrontDoorActivated(uint64 indexed chain, address indexed addr);
    event FrontDoorProposalCancelled(uint64 indexed chain, address indexed addr);
    event FrontDoorRemoved(uint64 indexed chain, address indexed addr);
    event DepositedDirect(address indexed user, uint256 assets, uint256 shares);
    event RedeemedDirect(address indexed user, uint256 shares, uint256 assets);
    event FrontDoorRedeemsAllowed(address indexed user);
    event KeeperSet(address indexed keeper);
    event ClaimGasSet(uint256 claimGasRequired);
    event LimitSet(bytes32 indexed name, uint256 a, uint256 b);
    event BatchDelivered(
        bytes32 indexed key, uint64 indexed sourceChain, address indexed frontDoor, uint64 batchId, uint256 amount
    );
    event DepositSkipped(bytes32 indexed key, address user, uint256 assets);
    event Deposited(bytes32 indexed key, address indexed user, uint256 assets, uint256 shares);
    /// A deposit delivered while the vault is insolvent: no shares are minted, and `assets` is queued
    /// back to the front door with the batch's payouts as an entry with 0 shares.
    event DepositBounced(bytes32 indexed key, address indexed user, uint256 assets);
    event RedeemSkipped(bytes32 indexed key, address indexed user, uint256 requested);
    event RedeemDeferred(bytes32 indexed key, address indexed user, uint256 requested);
    event Redeemed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets);
    /// `price` is the batch price, CascadeMath.price(A, S).
    event PayoutBatchQueued(
        bytes32 indexed key, uint64 indexed sourceChain, uint64 batchId, uint32 count, uint256 total, uint256 price
    );
    /// `gross` is the chunk's queued value; `net + fee` is the value sent (both 0 when nothing was sent).
    event PayoutChunkSent(bytes32 indexed key, uint32 chunk, uint32 taken, uint256 gross, uint256 net, uint256 fee);
    /// An entry left with nothing after its share of the fee; `assets` stays in the vault.
    event PayoutDust(bytes32 indexed key, address indexed user, uint256 assets);
    event RedeemReversed(bytes32 indexed key, address indexed user, uint256 shares, uint256 assets);
    event PayoutBatchCancelled(bytes32 indexed key, uint256 remaining);

    // ---- constructor ----

    constructor(
        bytes32 expectedColdkey,
        bytes32 hotkey,
        ICascadeBridge bridge,
        address owner_,
        address guardian_,
        uint256 minDirectDeposit_,
        uint64 initialFrontDoorChain,
        address initialFrontDoor
    ) ERC20("Cascade Staked TAO", "csTAO") CascadeBase(owner_, guardian_, address(bridge)) {
        bytes32 derived = ADDRESS_MAPPING.addressMapping(address(this));
        if (derived != expectedColdkey) revert ColdkeyMismatch(expectedColdkey, derived);
        coldkey = derived;
        if (hotkey == bytes32(0)) revert ZeroHotkey();
        hotkeys.push(hotkey);
        isHotkey[hotkey] = true;
        stakeHotkey = hotkey;
        // the keeper fallbacks count from deploy, not from 0
        lastStakeAt = uint64(block.timestamp);
        lastClaimAt[hotkey] = uint64(block.timestamp);
        emit StakeHotkeySet(hotkey);
        minDirectDeposit = minDirectDeposit_;
        // Like the initial bridge, the initial front door is active at once: nobody has deposited yet,
        // so the deployer's choice needs no delay. Later front doors wait REGISTRY_DELAY. Zero = none.
        if (initialFrontDoor != address(0)) {
            frontDoorActive[peerId(initialFrontDoorChain, initialFrontDoor)] = true;
            emit FrontDoorActivated(initialFrontDoorChain, initialFrontDoor);
        }
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
        // forge-lint: disable-next-line(block-timestamp)
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
        return _sub0(_positionWei(), ED_RESERVE);
    }

    function unvestedRewards() public view returns (uint256) {
        return _unspent(vestingAmount, vestingStart, REWARD_VESTING);
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

    /// The chain's minimum stake operation, in rao: the larger of the live read and the owner-set
    /// fallback, or the fallback alone if the read fails.
    function minStakeRao() public view returns (uint256) {
        try STAKING.getDefaultMinStake{gas: 100_000}() returns (uint256 v) {
            return Math.max(v, fallbackMinStakeRao);
        } catch {
            return fallbackMinStakeRao;
        }
    }

    /// The chain's minimum nominator position, in rao: the larger of the live read and the owner-set
    /// fallback, or the fallback alone if the read fails.
    function minRemainRao() public view returns (uint256) {
        try STAKING.getNominatorMinRequiredStake{gas: 100_000}() returns (uint256 v) {
            return Math.max(v, fallbackMinRemainRao);
        } catch {
            return fallbackMinRemainRao;
        }
    }

    // ---- stake and hotkeys ----

    /// Adds `h` to the set without routing new stake to it (e.g. to claim a forfeited hotkey's rewards,
    /// or to bring stake a validator's hotkey swap moved back into the price). Owner, guardian or keeper:
    /// adding only widens what the price reads, and the set stays capped at MAX_HOTKEYS.
    function addHotkey(bytes32 h) external {
        if (msg.sender != owner() && msg.sender != guardian && msg.sender != keeper) revert NotAuthorized();
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
    /// only, or anyone once KEEPER_FALLBACK has passed since the last stake (or the deploy). What it
    /// stakes, with what is still ramping from earlier stakes, enters the outflow allowance's base
    /// linearly over STAKE_RAMP from now.
    function stakeIdle() external whenNotPaused nonReentrant {
        uint64 last = lastStakeAt;
        // forge-lint: disable-next-line(block-timestamp)
        if (msg.sender != keeper && block.timestamp < last + KEEPER_FALLBACK) revert NotKeeper();
        uint256 rao = _available() / RAO;
        if (rao < minStakeRao()) revert NothingToStake();

        bytes32 h = stakeHotkey;
        uint256 before = _stakeOf(h);
        STAKING.addStake(h, rao, NETUID_ROOT);
        uint256 measured = _sub0(_stakeOf(h), before);
        rampingStake = _unspent(rampingStake, last, STAKE_RAMP) + rao * RAO;
        lastStakeAt = uint64(block.timestamp);
        emit Staked(h, rao, measured);
    }

    // ---- rewards ----

    /// Claims `hotkey`'s root rewards and vests the measured increase of the whole position (stake
    /// across the set plus liquid balance, wherever the chain credits the claim) over REWARD_VESTING,
    /// on top of what is still unvested. The reward cut (rewardCutBps of the increase, floored) does not
    /// vest: it is minted to the treasury as csTAO at the price before the claim, rounded down, so the
    /// price is unchanged; below half the launch price it is skipped and vests with the rest. An empty
    /// claim leaves the schedule as it is. Keeper only, or
    /// anyone once KEEPER_FALLBACK has passed since this hotkey's last claim (or since it was first
    /// added). Works while paused. The chain can refuse a claim by burning the forwarded gas; the
    /// revert bubbles up and nothing changes.
    function claimRewards(bytes32 hotkey) external nonReentrant {
        if (!isHotkey[hotkey]) revert UnknownHotkey();
        // forge-lint: disable-next-line(block-timestamp)
        if (msg.sender != keeper && block.timestamp < lastClaimAt[hotkey] + KEEPER_FALLBACK) revert NotKeeper();

        uint256 before = _positionWei();
        // checked after the measurement, right before the call it protects
        if (gasleft() < claimGasRequired) revert InsufficientGas();
        STAKING.claimRootWithHotkey(hotkey);
        uint256 delta = _sub0(_positionWei(), before);
        lastClaimAt[hotkey] = uint64(block.timestamp);
        uint256 fee = delta * rewardCutBps / 10_000;
        if (fee != 0) {
            // the price before this claim: totalAssets() already counts delta, the old schedule does not
            uint256 assetsBefore = _sub0(totalAssets(), delta);
            uint256 supply = totalSupply();
            if (assetsBefore * 2_000_000 < supply) {
                // Below half the launch price (as for deposits) the cut is skipped and vests with the
                // rest: minted at a price reading a loss, it could take most of the vault once the
                // loss is repaired (e.g. stake a hotkey swap moved outside the set). S == 0 never trips it.
                fee = 0;
            } else {
                address t = treasury;
                uint256 shares = CascadeMath.sharesForDeposit(fee, assetsBefore, supply);
                _mint(t, shares);
                emit RewardCutMinted(t, fee, shares);
            }
        }
        // The cut does not vest, so the mint leaves the price as it was. Restarting on 0 would re-spread
        // the unvested remainder over a fresh REWARD_VESTING.
        if (delta - fee != 0) {
            vestingAmount = unvestedRewards() + (delta - fee);
            vestingStart = uint64(block.timestamp);
        }
        emit RewardsClaimed(hotkey, delta / RAO);
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
    /// for redeems within the front door's daily allowance (measured on the gross before this delivery's
    /// deposits) and queues their payouts. Below half the launch price deposits are not minted but
    /// bounced: queued back to the front door ahead of the redeems, as entries with 0 shares. No
    /// per-entry condition reverts the batch. Reverts while paused so the rail holds the money. No
    /// staking or claiming here.
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
            uint256 sum = 0;
            for (uint256 i; i < deposits.length; ++i) {
                sum += deposits[i].amount;
            }
            if (sum != amount) revert AmountMismatch();
        }
        bytes32 key = batchKey(sourceChain, sender, message);
        if (processed[key]) revert DuplicateBatch();
        processed[key] = true;
        emit BatchDelivered(key, sourceChain, sender, batchId, amount);

        // one read of the stake for the whole delivery: A is totalAssets() without this delivery's
        // credited value
        uint256 gross = grossAssets();
        uint256 A = _sub0(_sub0(gross, pendingPayouts + unvestedRewards()), msg.value - msg.value % RAO);
        uint256 S = totalSupply();
        // Below half the launch price (1e-6 TAO per share) assets were lost; minting there would hand
        // these deposits much of the vault, so they bounce instead. S == 0 never trips it. Redeems still
        // burn, so exits keep working in a broken vault.
        bool insolvent = A * 2_000_000 < S;

        // one queue for both steps: bounced deposits first, then redeems
        PayoutBatch memory b;
        _creditDeposits(key, deposits, A, S, insolvent, b);
        // The allowance base is the root stake (gross less the liquid balance, so never this or an
        // earlier delivery's TAO, nor a direct deposit) less what stakeIdle added in the last STAKE_RAMP
        // and has not yet ramped in: capital borrowed for a transaction, or parked for less than a day,
        // cannot raise it.
        _burnRedeems(
            key,
            peer,
            redeems,
            A,
            S,
            _sub0(_sub0(gross + ED_RESERVE, address(this).balance), _unspent(rampingStake, lastStakeAt, STAKE_RAMP)),
            b
        );
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

    // ---- payouts ----

    /// Sends the next chunk of batch `key` to its front door through the primary bridge, once
    /// payoutDelay has passed. `payouts` is the batch's full ordered list, rebuilt from its
    /// DepositBounced and Redeemed events in log order. Permissionless; only the keeper's `maxEntries`
    /// counts, anyone else sends the largest chunk that fits. Each entry pays its share of the bridge
    /// fee and is floored to rao; an entry left with nothing (every entry when the chunk is worth no
    /// more than the fee) is PayoutDust and stays in the vault. No staking here.
    function processPayouts(bytes32 key, CascadeMessages.Payout[] calldata payouts, uint32 maxEntries)
        external
        whenNotPaused
        nonReentrant
    {
        PayoutBatch memory b = _verifyPayouts(key, payouts);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < uint256(b.queuedAt) + payoutDelay) revert PayoutDelayed();
        if (!frontDoorActive[peerId(b.sourceChain, b.frontDoor)]) revert FrontDoorInactive();
        ICascadeBridge bridge = _primary();

        // 1. chunk; 2. fee, quoted on the gross message, under the ceiling
        (CascadeMessages.Entry[] memory entries, uint256 sum) = _takeChunk(payouts, b.cursor, maxEntries);
        // casting to 'uint32' is safe because a chunk holds at most MAX_ENTRIES entries
        // forge-lint: disable-next-line(unsafe-typecast)
        uint32 taken = uint32(entries.length);
        uint256 fee =
            bridge.quoteFee(b.sourceChain, b.frontDoor, CascadeMessages.encodePayouts(key, b.chunk, entries), sum);
        // Rounded up to whole rao: the chain floors value transfers to rao, so a sub-rao net + fee
        // would reach the adapter short of amount + fee.
        fee = Math.ceilDiv(fee, RAO) * RAO;
        if (fee > Math.max(sum * maxFeeBps / 10_000, maxFeeAbs)) revert FeeTooHigh();
        uint256 net = _deductFee(key, entries, fee, sum);
        if (net == 0) fee = 0;

        // 3. liquidity beyond the reserve and the other batches' reservations, floored at 0
        {
            uint256 available = _sub0(_sub0(address(this).balance, ED_RESERVE), pendingPayouts - b.remaining);
            if (available < net + fee && _unstake(net + fee - available) != 0) revert UnstakeShort();
        }

        // 4. effects
        pendingPayouts -= sum;
        if (b.cursor + taken == b.count) {
            // processed[key] stays
            delete payoutBatches[key];
        } else {
            PayoutBatch storage s = payoutBatches[key];
            s.cursor = b.cursor + taken;
            s.chunk = b.chunk + 1;
            s.remaining = b.remaining - sum;
        }

        // 5. send exactly net + fee; the rounding difference sum - net - fee stays in the vault
        if (net != 0) {
            bytes memory message = CascadeMessages.encodePayouts(key, b.chunk, entries);
            bridge.send{value: net + fee}(b.sourceChain, b.frontDoor, message, net);
        }
        emit PayoutChunkSent(key, b.chunk, taken, sum, net, fee);
    }

    /// Undoes the unsent rest of batch `key`: re-mints each remaining entry's shares (exact, at the
    /// batch's fixed price) and releases its reservation. Chunks already sent stay sent; the front
    /// door's burn window is not restored. A bounced deposit has 0 shares to re-mint, so cancelling
    /// leaves its TAO in the vault for the holders: process a batch with bounced deposits, do not
    /// cancel it. Owner only; works while paused and after the front door was removed.
    function cancelPayoutBatch(bytes32 key, CascadeMessages.Payout[] calldata payouts) external onlyOwner nonReentrant {
        PayoutBatch storage b = _verifyPayouts(key, payouts);
        for (uint256 i = b.cursor; i < payouts.length; ++i) {
            CascadeMessages.Payout calldata p = payouts[i];
            _mint(p.user, p.shares);
            emit RedeemReversed(key, p.user, p.shares, p.assets);
        }
        uint256 remaining = b.remaining;
        pendingPayouts -= remaining;
        delete payoutBatches[key];
        emit PayoutBatchCancelled(key, remaining);
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

    /// At most MAX_OUTFLOW_BPS (50%) of the base a day, and a floor of at most MAX_MIN_DAILY_OUTFLOW
    /// (100 TAO).
    function setOutflowLimits(uint256 bps, uint256 minDaily) external onlyOwner {
        if (bps > MAX_OUTFLOW_BPS || minDaily > MAX_MIN_DAILY_OUTFLOW) revert InvalidParameter();
        maxDailyOutflowBps = bps;
        minDailyOutflow = minDaily;
        emit LimitSet("maxDailyOutflowBps", bps, minDaily);
    }

    /// maxMessageValue at most MAX_MESSAGE_VALUE (the lane's 5,000 TAO).
    function setMessageLimits(uint256 maxEntryValue_, uint256 maxMessageValue_, uint32 minChunk_) external onlyOwner {
        if (
            maxEntryValue_ > maxMessageValue_ || maxMessageValue_ > MAX_MESSAGE_VALUE || minChunk_ == 0
                || minChunk_ > CascadeMessages.MAX_ENTRIES
        ) revert InvalidParameter();
        maxEntryValue = maxEntryValue_;
        maxMessageValue = maxMessageValue_;
        minChunk = minChunk_;
        emit LimitSet("maxEntryValue", maxEntryValue_, maxMessageValue_);
        emit LimitSet("minChunk", minChunk_, 0);
    }

    /// The payout fee ceiling: at most MAX_FEE_BPS (5%) of a chunk, or MAX_FEE_ABS (0.1 TAO).
    function setFeeLimits(uint256 bps, uint256 abs_) external onlyOwner {
        if (bps > MAX_FEE_BPS || abs_ > MAX_FEE_ABS) revert InvalidParameter();
        maxFeeBps = bps;
        maxFeeAbs = abs_;
        emit LimitSet("maxFeeBps", bps, abs_);
    }

    /// MIN_PAYOUT_DELAY (1 hour) to 7 days: the guardian's window to hold a rogue batch.
    function setPayoutDelay(uint64 delay) external onlyOwner {
        if (delay < MIN_PAYOUT_DELAY || delay > 7 days) revert InvalidParameter();
        payoutDelay = delay;
        emit LimitSet("payoutDelay", delay, 0);
    }

    /// The treasury and its cut of each claim, in bps, at most MAX_REWARD_CUT_BPS. A zero treasury
    /// is allowed only with a zero cut.
    function setRewardCut(address treasury_, uint16 bps) external onlyOwner {
        if (bps > MAX_REWARD_CUT_BPS) revert FeeTooHigh();
        if (treasury_ == address(0) && bps != 0) revert ZeroAddress();
        treasury = treasury_;
        rewardCutBps = bps;
        emit RewardCutSet(treasury_, bps);
    }

    function setClaimGasRequired(uint256 gasRequired) external onlyOwner {
        claimGasRequired = gasRequired;
        emit ClaimGasSet(gasRequired);
    }

    function setHotkeyDustRao(uint256 rao) external onlyOwner {
        hotkeyDustRao = rao;
        emit LimitSet("hotkeyDustRao", rao, 0);
    }

    /// At most MAX_UNSTAKE_MARGIN_RAO (1 TAO) per removal.
    function setUnstakeMarginRao(uint256 rao) external onlyOwner {
        if (rao > MAX_UNSTAKE_MARGIN_RAO) revert InvalidParameter();
        unstakeMarginRao = rao;
        emit LimitSet("unstakeMarginRao", rao, 0);
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

    /// What is left of `amount` spent linearly over `period` from `start` (unvested rewards, ramping stake).
    function _unspent(uint256 amount, uint64 start, uint256 period) internal view returns (uint256) {
        uint256 elapsed = block.timestamp - start;
        return elapsed >= period ? 0 : amount * (period - elapsed) / period;
    }

    /// Root stake across the set plus the liquid balance, in wei, before any reserve.
    function _positionWei() internal view returns (uint256) {
        return rootStakeRao() * RAO + address(this).balance;
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
    /// TAO stays in the vault. While `insolvent`, a non-zero deposit is bounced instead: queued in `b`
    /// as (user, 0 shares, assets), to be paid back to the front door like a redeem.
    function _creditDeposits(
        bytes32 key,
        CascadeMessages.Entry[] memory deposits,
        uint256 A,
        uint256 S,
        bool insolvent,
        PayoutBatch memory b
    ) internal {
        for (uint256 i; i < deposits.length; ++i) {
            address user = deposits[i].user;
            uint256 a = deposits[i].amount;
            a -= a % RAO;
            if (user == address(0)) {
                emit DepositSkipped(key, user, a);
                continue;
            }
            if (insolvent && a != 0) {
                _queuePayout(b, user, 0, a);
                emit DepositBounced(key, user, a);
                continue;
            }
            uint256 shares = CascadeMath.sharesForDeposit(a, A, S);
            _mint(user, shares);
            emit Deposited(key, user, a, shares);
        }
    }

    /// Delivery steps 2-3: burns each redeem at (A, S), clipped to the holder's balance, the per-entry
    /// bound and the front door's remaining daily allowance, max(maxDailyOutflowBps of `base`, the
    /// ramped-in root stake, minDailyOutflow) per 24-hour window, and queues it in `b` after any bounced
    /// deposits. A redeem worth less than MIN_REDEEM_VALUE after clipping is deferred, not burned. Only
    /// burns count against the window. The caller fills in the rest of `b`.
    function _burnRedeems(
        bytes32 key,
        bytes32 peer,
        CascadeMessages.Entry[] memory redeems,
        uint256 A,
        uint256 S,
        uint256 base,
        PayoutBatch memory b
    ) internal {
        if (redeems.length == 0) return;
        Window memory w = burnWindows[peer];
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= w.start + 24 hours) w = Window(uint64(block.timestamp), 0);
        uint256 allowance = _sub0(Math.max(base * maxDailyOutflowBps / 10_000, minDailyOutflow), w.burned);
        uint256 maxEntry = maxEntryValue;
        // this delivery's burns, without its bounced deposits
        uint256 burned;
        for (uint256 i; i < redeems.length; ++i) {
            address user = redeems[i].user;
            uint256 s = Math.min(redeems[i].amount, balanceOf(user));
            if (s == 0 || directOnly[user]) {
                emit RedeemSkipped(key, user, redeems[i].amount);
                continue;
            }
            s = Math.min(s, CascadeMath.sharesForDeposit(Math.min(maxEntry, allowance), A, S));
            uint256 out = CascadeMath.assetsForRedeem(s, A, S);
            out -= out % RAO;
            if (out < MIN_REDEEM_VALUE) {
                // nothing burned; the holder keeps the shares and may request again (redeemDirect pays
                // any amount)
                emit RedeemDeferred(key, user, redeems[i].amount);
                continue;
            }
            _burn(user, s);
            // out <= cap <= allowance, since s <= sharesForDeposit(cap, A, S)
            allowance -= out;
            burned += out;
            _queuePayout(b, user, s, out);
            emit Redeemed(key, user, s, out);
        }
        if (burned != 0) {
            w.burned += burned;
            burnWindows[peer] = w;
        }
    }

    /// Appends (user, shares, assets) to the payout queue `b`: its count, total (as `remaining`) and
    /// running hash.
    function _queuePayout(PayoutBatch memory b, address user, uint256 shares, uint256 assets) internal pure {
        ++b.count;
        b.remaining += assets;
        b.payoutsHash = keccak256(abi.encode(b.payoutsHash, user, shares, assets));
    }

    /// The batch under `key` once `payouts` is shown to be its full ordered list. NotPending unless
    /// entries are left (an unknown key has none); PayoutsMismatch unless the length is `count` and the
    /// running hash over every entry equals `payoutsHash`.
    function _verifyPayouts(bytes32 key, CascadeMessages.Payout[] calldata payouts)
        internal
        view
        returns (PayoutBatch storage b)
    {
        b = payoutBatches[key];
        if (b.cursor >= b.count) revert NotPending();
        if (payouts.length != b.count) revert PayoutsMismatch();
        bytes32 h = bytes32(0);
        for (uint256 i; i < payouts.length; ++i) {
            h = keccak256(abi.encode(h, payouts[i].user, payouts[i].shares, payouts[i].assets));
        }
        if (h != b.payoutsHash) revert PayoutsMismatch();
    }

    /// Payout step 1: from `start`, the next entry always (even above maxMessageValue), then entries in
    /// order while fewer than the limit are taken and the sum stays within maxMessageValue. The limit
    /// is max(maxEntries, minChunk), capped at MAX_ENTRIES, for the keeper, and MAX_ENTRIES for anyone
    /// else (a stranger cannot split a batch into small chunks that each pay a fee). A tail of fewer
    /// than minChunk entries that would be left behind is taken too when the whole chunk still fits
    /// within maxMessageValue and MAX_ENTRIES, so a tail never pays a message fee alone. Returns them at
    /// their gross value, with their sum.
    function _takeChunk(CascadeMessages.Payout[] calldata payouts, uint256 start, uint256 maxEntries)
        internal
        view
        returns (CascadeMessages.Entry[] memory entries, uint256 sum)
    {
        uint256 n = payouts.length;
        uint256 limit = msg.sender == keeper
            ? Math.min(Math.max(maxEntries, minChunk), CascadeMessages.MAX_ENTRIES)
            : CascadeMessages.MAX_ENTRIES;
        uint256 end = Math.min(start + limit, n);
        uint256 cap = maxMessageValue;
        uint256 i = start;
        do {
            sum += payouts[i].assets;
            ++i;
        } while (i < end && sum + payouts[i].assets <= cap);
        // fold a short tail in
        if (i < n && n - i < minChunk && n - start <= CascadeMessages.MAX_ENTRIES) {
            uint256 total = sum;
            for (uint256 j = i; j < n; ++j) {
                total += payouts[j].assets;
            }
            if (total <= cap) (sum, i) = (total, n);
        }
        entries = new CascadeMessages.Entry[](i - start);
        for (uint256 j; j < entries.length; ++j) {
            entries[j] = CascadeMessages.Entry(payouts[start + j].user, payouts[start + j].assets);
        }
    }

    /// Payout step 2: each entry pays ceil(assets * fee / sum) and is floored to rao. An entry left with
    /// 0 (every entry when sum <= fee, the dust tail) emits PayoutDust and is dropped. Rewrites
    /// `entries` in place as the list to send and returns its total.
    function _deductFee(bytes32 key, CascadeMessages.Entry[] memory entries, uint256 fee, uint256 sum)
        internal
        returns (uint256 net)
    {
        uint256 n;
        for (uint256 i; i < entries.length; ++i) {
            CascadeMessages.Entry memory e = entries[i];
            uint256 a = _sub0(e.amount, Math.mulDiv(e.amount, fee, sum, Math.Rounding.Ceil));
            a -= a % RAO;
            if (a == 0) {
                emit PayoutDust(key, e.user, e.amount);
                continue;
            }
            e.amount = a;
            entries[n++] = e;
            net += a;
        }
        // shrink to the n entries kept
        assembly ("memory-safe") {
            mstore(entries, n)
        }
    }

    /// A hotkey never seen before starts its claim fallback now; a re-added one keeps its last claim.
    function _addHotkey(bytes32 h) internal {
        if (h == bytes32(0)) revert ZeroHotkey();
        if (isHotkey[h]) revert HotkeyKnown();
        if (hotkeys.length >= MAX_HOTKEYS) revert TooManyHotkeys();
        hotkeys.push(h);
        isHotkey[h] = true;
        if (lastClaimAt[h] == 0) lastClaimAt[h] = uint64(block.timestamp);
        emit HotkeyAdded(h);
    }

    function _moveStake(bytes32 from, uint256 rao) internal {
        bytes32 to = stakeHotkey;
        uint256 before = _stakeOf(to);
        STAKING.moveStake(from, to, NETUID_ROOT, NETUID_ROOT, rao);
        emit StakeMoved(from, to, rao, _sub0(_stakeOf(to), before));
    }

    /// Unstakes at least `shortfallWei` (when the stake allows), walking the stake hotkey first and
    /// then the set in order. Skips a position below the minimum stake (the chain may refuse to touch
    /// it, and that revert would block every exit). Rounds each request up to the minimum stake, adds
    /// `unstakeMarginRao`, and exits a position fully when the chain would sweep its remainder anyway.
    /// A precompile revert bubbles up; retry later. Returns the part of the shortfall the measured
    /// receipts did not cover (0 when covered); a short receipt never reverts here, the caller decides.
    /// Any excess received stays idle for stakeIdle.
    function _unstake(uint256 shortfallWei) internal returns (uint256 unmet) {
        unmet = shortfallWei;
        uint256 minStake = minStakeRao();
        uint256 minRemain = minRemainRao();
        uint256 margin = unstakeMarginRao;
        bytes32 first = stakeHotkey;
        uint256 n = hotkeys.length;
        _unstaking = true;
        // i == 0 is the stake hotkey; i >= 1 is hotkeys[i - 1], skipping the stake hotkey.
        for (uint256 i; i <= n && unmet != 0; ++i) {
            bytes32 h = i == 0 ? first : hotkeys[i - 1];
            if (i != 0 && h == first) continue;
            uint256 s = _stakeOf(h);
            // also skips an empty position (minStake >= fallbackMinStakeRao >= 1)
            if (s < minStake) continue;
            uint256 want = Math.max(Math.ceilDiv(unmet, RAO), minStake) + margin;
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

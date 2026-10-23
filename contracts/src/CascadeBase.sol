// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICascadeBridge} from "./interfaces/ICascadeBridge.sol";

/// Shared admin surface: two-step owner, guardian, pause, and a bridge registry where new bridges
/// wait REGISTRY_DELAY before activation and the guardian can cancel or disable at once.
abstract contract CascadeBase is Ownable2Step, Pausable, ReentrancyGuard {
    uint64 public constant REGISTRY_DELAY = 7 days;

    address public guardian;
    mapping(address => bool) public bridgeEnabled;
    mapping(address => uint64) public bridgeProposedAt;
    address public primaryBridge;

    error ZeroAddress();
    error NotGuardian();
    error NotBridge();
    error BridgeKnown();
    error NoProposal();
    error NotReady();
    error BridgeNotEnabled();
    error PrimaryBridgeDisabled();
    error RenounceDisabled();

    event GuardianSet(address guardian);
    event BridgeProposed(address indexed bridge, uint64 readyAt);
    event BridgeActivated(address indexed bridge);
    event BridgeProposalCancelled(address indexed bridge);
    event BridgeDisabled(address indexed bridge);
    event PrimaryBridgeSet(address indexed bridge);

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(address owner_, address guardian_, address initialBridge) Ownable(owner_) {
        if (guardian_ == address(0) || initialBridge == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianSet(guardian_);
        bridgeEnabled[initialBridge] = true;
        emit BridgeActivated(initialBridge);
        primaryBridge = initialBridge;
        emit PrimaryBridgeSet(initialBridge);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        guardian = newGuardian;
        emit GuardianSet(newGuardian);
    }

    function proposeBridge(address bridge) external onlyOwner {
        if (bridge == address(0)) revert ZeroAddress();
        if (bridgeEnabled[bridge]) revert BridgeKnown();
        bridgeProposedAt[bridge] = uint64(block.timestamp);
        emit BridgeProposed(bridge, uint64(block.timestamp) + REGISTRY_DELAY);
    }

    function activateBridge(address bridge) external onlyOwner {
        uint64 proposedAt = bridgeProposedAt[bridge];
        if (proposedAt == 0) revert NoProposal();
        if (block.timestamp < uint256(proposedAt) + REGISTRY_DELAY) revert NotReady();
        delete bridgeProposedAt[bridge];
        bridgeEnabled[bridge] = true;
        emit BridgeActivated(bridge);
    }

    function cancelBridgeProposal(address bridge) external onlyOwnerOrGuardian {
        if (bridgeProposedAt[bridge] == 0) revert NoProposal();
        delete bridgeProposedAt[bridge];
        emit BridgeProposalCancelled(bridge);
    }

    function disableBridge(address bridge) external onlyOwnerOrGuardian {
        if (!bridgeEnabled[bridge]) revert BridgeNotEnabled();
        bridgeEnabled[bridge] = false;
        emit BridgeDisabled(bridge);
    }

    function setPrimaryBridge(address bridge) external onlyOwner {
        if (!bridgeEnabled[bridge]) revert BridgeNotEnabled();
        primaryBridge = bridge;
        emit PrimaryBridgeSet(bridge);
    }

    function pause() external onlyOwnerOrGuardian {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    function _requireBridge() internal view {
        if (!bridgeEnabled[msg.sender]) revert NotBridge();
    }

    function _primary() internal view returns (ICascadeBridge) {
        address p = primaryBridge;
        if (!bridgeEnabled[p]) revert PrimaryBridgeDisabled();
        return ICascadeBridge(p);
    }
}

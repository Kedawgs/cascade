// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev Bittensor's balance-transfer precompile: sends msg.value to an SS58 public key.
address constant BALANCE_TRANSFER_ADDRESS = 0x0000000000000000000000000000000000000800;

/// @notice Stand-ins for Bittensor's precompiles on a local anvil fork, which has none. The ops
/// rehearsal installs their runtime code at the precompile addresses with `anvil_setCode`. They cover
/// what deploying the vault and the rehearsal's round trip touch (stake, unstake, ForeverMoney's
/// AlphaVault converting TAO); nothing here runs on a real chain.

/// Rehearsal mapping: an address's "coldkey" is the address itself, zero-padded, so the transfer
/// stand-in can turn it back into an address. The real chain uses blake2b-256("evm:" ++ address).
contract RehearsalAddressMapping {
    function addressMapping(address addr) external pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }
}

/// A root-stake ledger that answers like the staking precompile under the live floors, with two
/// limits an anvil fork imposes (it runs no cheatcodes):
/// - `addStake` cannot debit the caller's balance as the precompile does. It records the stake and
///   emits `Debit`; the rehearsal settles each Debit with `anvil_setBalance` right after the
///   transaction (the caller's balance down, this stand-in's up).
/// - Unstaking pays from this stand-in's own balance (the rehearsal funds it) by a forced send, which,
///   like the precompile, credits the coldkey without running its code.
/// A caller's coldkey is the rehearsal mapping's, unless an alias is set (ForeverMoney's AlphaVault
/// stakes under its own coldkey); `seedStake` gives such a coldkey its position. Anyone may call the
/// setup functions: the stand-in only ever exists on a local fork.
contract RehearsalStaking {
    uint256 private constant RAO = 1e9;
    uint256 private constant MIN_STAKE = 2_000_000;
    uint256 private constant NOMINATOR_MIN = 20_000_000;

    mapping(bytes32 hotkey => mapping(bytes32 coldkey => mapping(uint256 netuid => uint256 rao))) private _stake;
    mapping(address who => bytes32) public coldkeyAlias;

    /// The precompile would have debited `amount` wei from `who`'s balance.
    event Debit(address indexed who, uint256 amount);

    // ---- rehearsal setup ----

    function setColdkeyAlias(address who, bytes32 coldkey) external {
        coldkeyAlias[who] = coldkey;
    }

    function seedStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid, uint256 rao) external {
        _stake[hotkey][coldkey][netuid] += rao;
    }

    // ---- the precompile's interface ----

    function setRejectStakingHotkeyGrowth(bool) external {}

    function getStake(bytes32 hotkey, bytes32 coldkey, uint256 netuid) external view returns (uint256) {
        return _stake[hotkey][coldkey][netuid];
    }

    function getDefaultMinStake() external pure returns (uint256) {
        return MIN_STAKE;
    }

    function getNominatorMinRequiredStake() external pure returns (uint256) {
        return NOMINATOR_MIN;
    }

    /// Nothing accrues on a fork.
    function getUnclaimedRootTaoByHotkey(bytes32, bytes32) external pure returns (uint256) {
        return 0;
    }

    /// `amount` in rao, from the caller's balance (settled by the rehearsal: see `Debit`).
    function addStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable {
        require(msg.value == 0, "rehearsal: addStake takes no value");
        require(amount >= MIN_STAKE, "rehearsal: below the minimum stake");
        require(msg.sender.balance >= amount * RAO, "rehearsal: balance too low");
        _stake[hotkey][_cold(msg.sender)][netuid] += amount;
        emit Debit(msg.sender, amount * RAO);
    }

    /// As the chain: at most what is staked, and the whole position when less than the nominator
    /// minimum would remain.
    function removeStake(bytes32 hotkey, uint256 amount, uint256 netuid) external payable {
        bytes32 cold = _cold(msg.sender);
        uint256 staked = _stake[hotkey][cold][netuid];
        if (amount > staked) amount = staked;
        require(amount >= MIN_STAKE || amount == staked, "rehearsal: below the minimum stake");
        uint256 remainder = staked - amount;
        if (remainder != 0 && remainder < NOMINATOR_MIN) remainder = 0;
        _stake[hotkey][cold][netuid] = remainder;
        _pay(staked - remainder);
    }

    function removeStakeFull(bytes32 hotkey, uint256 netuid) external payable {
        bytes32 cold = _cold(msg.sender);
        uint256 staked = _stake[hotkey][cold][netuid];
        _stake[hotkey][cold][netuid] = 0;
        _pay(staked);
    }

    function _cold(address who) private view returns (bytes32 c) {
        c = coldkeyAlias[who];
        if (c == bytes32(0)) c = bytes32(uint256(uint160(who)));
    }

    function _pay(uint256 rao) private {
        if (rao != 0) new ForceSend{value: rao * RAO}(payable(msg.sender));
    }
}

/// Like the real precompile, credits the destination without running its code (the vault refuses
/// plain transfers): a throwaway contract self-destructs to it, which moves the balance only. An
/// empty destination is credited 500 rao less, as Bittensor's EVM reads an account's balance less the
/// existential deposit (the vault's 1.5e12 wei reserve reads 1e12, its ED_RESERVE); the 500 rao stay here.
contract RehearsalBalanceTransfer {
    uint256 private constant EXISTENTIAL_DEPOSIT = 500e9;

    function transfer(bytes32 data) external payable {
        address payable to = payable(address(uint160(uint256(data))));
        uint256 credit = msg.value;
        if (to.balance == 0) {
            require(credit > EXISTENTIAL_DEPOSIT, "rehearsal: below the existential deposit");
            credit -= EXISTENTIAL_DEPOSIT;
        }
        new ForceSend{value: credit}(to);
    }
}

contract ForceSend {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ForkBase, IOffRamp20} from "./ForkBase.sol";
import {
    BIT_REAL_EXECUTE_INPUT,
    BIT_REAL_EXECUTION_AMOUNT,
    BIT_REAL_EXECUTION_FORK_BLOCK,
    BIT_REAL_EXECUTION_MESSAGE_ID,
    BIT_REAL_EXECUTION_RECEIVER,
    BIT_REAL_EXECUTION_TOKEN
} from "./RealExecutionBittensor.sol";

/// @notice A stranger's empty-proof execution on Bittensor's OffRamp 2.0.0 (Task 65; the T61a review's Minor 5): the
/// Bittensor half of BaseForkV32's `aStrangersEmptyProofWritesAFailureTheRealResultsRecover`, on the real committee
/// verifier, nothing stubbed. A real Base-to-Bittensor message (RealExecutionBittensor.sol: a third party's plain token
/// transfer, not one of Cascade's), forked the block before its execution, so it is UNTOUCHED. Its own suite: the fork
/// is pinned to that block (BITTENSOR_ARCHIVE_RPC, default the archive node, which serves old state; forge's disk cache
/// serves repeat runs), and BittensorForkV32's setUp, which seeds the vault at the latest or FORK_BLOCK, is not needed
/// here. Run with `FORK=1`.
contract BittensorForkV32FailureTest is ForkBase {
    function setUp() public {
        if (!vm.envOr("FORK", false)) return;
        vm.createSelectFork(
            vm.envOr("BITTENSOR_ARCHIVE_RPC", string("https://archive.chain.opentensor.ai")),
            BIT_REAL_EXECUTION_FORK_BLOCK
        );
        // Bittensor's (Frontier) block header carries no prevrandao, which the Cancun EVM requires
        vm.prevrandao(bytes32(uint256(1)));
    }

    /// R4 C's unconfirmed item and T52's W2-L2 on Bittensor's OffRamp: the real message, UNTOUCHED, executed first by a
    /// stranger with no committee results. What that attempt leaves decides what the keeper's hand re-execution must
    /// find: as on Base, the attempt returns and writes FAILURE (the proof is checked inside the OffRamp's inner call,
    /// whose failure it records), so its calldata holds no usable proof; the honest results (the real transaction's
    /// calldata) still deliver it from that FAILURE.
    function test_fork_v32_aStrangersEmptyProofWritesAFailureTheRealResultsRecover() public onlyFork {
        (bytes memory encoded, address[] memory ccvs) = executeArgs();
        bytes32 id = keccak256(encoded);
        assertEq(id, BIT_REAL_EXECUTION_MESSAGE_ID, "the message id");
        assertEq(ccvs.length, 1, "one committee verifier");
        address offRamp = offRamp20(BIT_ROUTER, BASE_SELECTOR);
        assertEq(offRamp, BIT_OFFRAMP, "Bittensor's OffRamp 2.0.0");
        assertEq(IOffRamp20(offRamp).getExecutionState(id), UNTOUCHED, "untouched before its block");
        IERC20 token = IERC20(BIT_REAL_EXECUTION_TOKEN);
        uint256 before = token.balanceOf(BIT_REAL_EXECUTION_RECEIVER);

        vm.prank(makeAddr("v32 bittensor stranger"));
        (bool strangerOk,) =
            offRamp.call(abi.encodeCall(IOffRamp20.execute, (encoded, ccvs, new bytes[](ccvs.length), uint32(0))));
        uint8 state = IOffRamp20(offRamp).getExecutionState(id);
        emit log_named_uint("fork block", vm.getBlockNumber());
        emit log_named_uint("the stranger's attempt returned (1) or reverted (0)", strangerOk ? 1 : 0);
        emit log_named_uint("the state it left (0 untouched, 3 failure)", state);
        // what the real OffRamp does, asserted exactly, as on Base: a change in its behaviour fails here
        assertTrue(strangerOk, "the stranger's attempt returns");
        assertEq(state, FAILURE, "and writes FAILURE");
        assertEq(token.balanceOf(BIT_REAL_EXECUTION_RECEIVER), before, "nothing released");

        (bool honest,) = offRamp.call(BIT_REAL_EXECUTE_INPUT);
        assertTrue(honest, "the honest results go through");
        assertEq(IOffRamp20(offRamp).getExecutionState(id), SUCCESS, "SUCCESS");
        assertEq(
            token.balanceOf(BIT_REAL_EXECUTION_RECEIVER), before + BIT_REAL_EXECUTION_AMOUNT, "the tokens released"
        );
    }

    /// The real transaction's first two arguments, the encoded message and the verifiers: its input, the selector
    /// checked, then skipped (the length word moved up over it in memory), decoded.
    function executeArgs() internal pure returns (bytes memory encoded, address[] memory ccvs) {
        bytes memory input = BIT_REAL_EXECUTE_INPUT;
        assertEq(bytes4(input), IOffRamp20.execute.selector, "execute's selector");
        bytes memory args;
        assembly ("memory-safe") {
            args := add(input, 4)
            mstore(args, sub(mload(input), 4))
        }
        (encoded, ccvs) = abi.decode(args, (bytes, address[]));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICascadeSwapper} from "../../src/interfaces/ICascadeSwapper.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice Delivery swapper stand-in. Honest pays `taoIn * param / 1e18` USDC (param = USDC units
/// per 1e18 TAO) whatever the minimum; KeepsTao pays nothing; PaysLess pays `minUsdcOut` less `param`
/// bps; Reverts reverts. The dishonest modes still report `minUsdcOut` as paid. Every call records
/// what it was asked and how much TAO it held when called.
contract MockSwapper is ICascadeSwapper {
    enum Mode {
        Honest,
        KeepsTao,
        PaysLess,
        Reverts
    }

    IERC20 public immutable tao;
    MockUSDC public immutable usdc;

    Mode public mode;
    uint256 public param;

    uint256 public calls;
    uint256 public lastTaoIn;
    address public lastRecipient;
    uint256 public lastMinOut;
    uint256 public taoHeldAtCall;

    error SwapFailed();

    constructor(IERC20 tao_, MockUSDC usdc_) {
        tao = tao_;
        usdc = usdc_;
    }

    function setMode(Mode mode_, uint256 param_) external {
        mode = mode_;
        param = param_;
    }

    function sellFor(uint256 taoIn, address recipient, uint256 minUsdcOut) external returns (uint256) {
        calls++;
        lastTaoIn = taoIn;
        lastRecipient = recipient;
        lastMinOut = minUsdcOut;
        taoHeldAtCall = tao.balanceOf(address(this));
        if (mode == Mode.Reverts) revert SwapFailed();
        if (mode == Mode.KeepsTao) return minUsdcOut;
        if (mode == Mode.PaysLess) {
            usdc.mint(recipient, minUsdcOut * (10_000 - param) / 10_000);
            return minUsdcOut;
        }
        uint256 out = taoIn * param / 1e18;
        usdc.mint(recipient, out);
        return out;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CascadeFrontDoor} from "./CascadeFrontDoor.sol";
import {ICascadeSwapper} from "./interfaces/ICascadeSwapper.sol";
import {ISlipstreamRouter} from "./interfaces/ISlipstreamRouter.sol";
import {IUniswapV3Router02} from "./interfaces/IUniswapV3Router02.sol";

/// @notice Cascade's stake contract on Base: takes USDC (by allowance, or by a USDC permit in the same
/// transaction), takes the deposit fee and the swap fee to the treasury, swaps the rest for TAO along an
/// owner-set route and deposits it, floored to whole rao, into the front door for any beneficiary. For
/// the front door's deliveries it sells TAO for USDC along the delivery route, less the swap fee.
/// @dev No upgrade path; it holds nothing between transactions, so any balance is dust the owner may
/// sweep to the treasury. Every swap approves the router for exactly its input, resets the approval to
/// zero, and requires by balance deltas that the router took all of the input and paid at least the
/// minimum, so a wrong or malicious route can only make a call revert. Fees have hard caps in code.
contract CascadeStaker is Ownable2Step, ReentrancyGuard, ICascadeSwapper {
    using SafeERC20 for IERC20;

    /// UniswapV3: SwapRouter02's `exactInput` (no deadline field). Slipstream: Aerodrome's SwapRouter
    /// `exactInput` (a deadline field, tick spacing in the path).
    enum RouterKind {
        UniswapV3,
        Slipstream
    }

    /// `buyPath` runs USDC -> TAO and `sellPath` TAO -> USDC, each `token | 3 bytes | token ...`.
    struct Route {
        RouterKind kind;
        address router;
        bytes buyPath;
        bytes sellPath;
        bool active;
    }

    // ---- constants and immutables ----

    uint16 public constant MAX_SWAP_FEE_BPS = 50;
    /// $0.25 in USDC units.
    uint256 public constant MAX_DEPOSIT_FEE_USDC = 250_000;
    uint256 public constant RAO = 1e9;

    IERC20 public immutable usdc;
    IERC20 public immutable tao;
    CascadeFrontDoor public immutable frontDoor;

    // ---- state ----

    mapping(uint8 => Route) public routes;
    address public treasury;
    uint16 public swapFeeBps;
    uint8 public deliveryRouteId;
    uint256 public depositFeeUsdc;

    // ---- errors ----

    error BadPath();
    error RouteInactive();
    error Expired();
    error InsufficientOutput();
    error BadBeneficiary();
    error NotFrontDoor();
    error FeeTooHigh();
    error ZeroAddress();
    error TokenMismatch();
    error AmountTooSmall();
    error SwapIncomplete();
    error RenounceDisabled();

    // ---- events ----

    event RouteSet(uint8 indexed id, RouterKind kind, address router, bytes buyPath, bytes sellPath, bool active);
    event DeliveryRouteSet(uint8 indexed id);
    event FeesSet(uint16 swapFeeBps, uint256 depositFeeUsdc);
    event TreasurySet(address indexed treasury);
    event Swept(address indexed token, uint256 amount);
    /// `fees` is the deposit fee plus the swap fee, in USDC units; `taoDeposited` is in TAO wei.
    event Staked(
        address indexed payer, address indexed beneficiary, uint256 usdcIn, uint256 fees, uint256 taoDeposited
    );
    /// `usdcOut` is what `recipient` was paid, after `fee`.
    event Sold(address indexed recipient, uint256 taoIn, uint256 usdcOut, uint256 fee);

    // ---- constructor ----

    /// `tao` and `usdc` must be the front door's own asset and USDC.
    constructor(IERC20Permit usdc_, IERC20 tao_, CascadeFrontDoor frontDoor_, address owner_, address treasury_)
        Ownable(owner_)
    {
        if (
            address(usdc_) == address(0) || address(tao_) == address(0) || address(frontDoor_) == address(0)
                || treasury_ == address(0)
        ) revert ZeroAddress();
        if (address(frontDoor_.asset()) != address(tao_) || address(frontDoor_.usdc()) != address(usdc_)) {
            revert TokenMismatch();
        }
        usdc = IERC20(address(usdc_));
        tao = tao_;
        frontDoor = frontDoor_;
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    // ---- staking ----

    /// Pulls `usdcIn` USDC from the caller, sends the deposit fee and then the swap fee on the rest to the
    /// treasury, swaps the remainder along route `routeId` and deposits the TAO received, floored to whole
    /// rao, into the front door's open batch for `beneficiary`. Reverts if the TAO received is below
    /// `minTaoOut`, after `deadline`, or if the front door refuses the deposit (its minimum, cap and batch
    /// limits apply). Any sender may stake for any beneficiary except the zero address, this contract and
    /// the front door.
    function stake(address beneficiary, uint256 usdcIn, uint256 minTaoOut, uint8 routeId, uint256 deadline)
        external
        nonReentrant
        returns (uint256 taoDeposited)
    {
        return _stake(beneficiary, usdcIn, minTaoOut, routeId, deadline);
    }

    /// `stake` after USDC's EIP-2612 `permit` for exactly `usdcIn`, signed by the caller. A permit that
    /// fails (already submitted by someone watching the mempool, expired, or signed for another amount)
    /// is ignored: the stake then runs on whatever allowance exists, which it never exceeds, or reverts.
    function stakeWithPermit(
        address beneficiary,
        uint256 usdcIn,
        uint256 minTaoOut,
        uint8 routeId,
        uint256 deadline,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256) {
        try IERC20Permit(address(usdc)).permit(msg.sender, address(this), usdcIn, permitDeadline, v, r, s) {} catch {}
        return _stake(beneficiary, usdcIn, minTaoOut, routeId, deadline);
    }

    // ---- delivery ----

    /// @inheritdoc ICascadeSwapper
    /// @dev Front door only. Sells `taoIn` along the delivery route, sends the swap fee on the USDC out
    /// to the treasury and the rest to `recipient`, which must be at least `minUsdcOut`.
    function sellFor(uint256 taoIn, address recipient, uint256 minUsdcOut)
        external
        nonReentrant
        returns (uint256 usdcOut)
    {
        if (msg.sender != address(frontDoor)) revert NotFrontDoor();
        Route storage route = routes[deliveryRouteId];
        if (!route.active) revert RouteInactive();
        uint256 gross = _swap(route, false, taoIn, minUsdcOut, block.timestamp);
        uint256 fee = gross * swapFeeBps / 10_000;
        usdcOut = gross - fee;
        if (usdcOut < minUsdcOut) revert InsufficientOutput();
        if (fee != 0) usdc.safeTransfer(treasury, fee);
        usdc.safeTransfer(recipient, usdcOut);
        emit Sold(recipient, taoIn, usdcOut, fee);
    }

    // ---- admin ----

    /// Adds, replaces or (with `active` false) switches off route `id`. Both paths must run between the
    /// right tokens: `buyPath` USDC -> TAO, `sellPath` TAO -> USDC.
    function setRoute(uint8 id, Route calldata r) external onlyOwner {
        if (r.router == address(0)) revert ZeroAddress();
        _checkPath(r.buyPath, address(usdc), address(tao));
        _checkPath(r.sellPath, address(tao), address(usdc));
        routes[id] = r;
        emit RouteSet(id, r.kind, r.router, r.buyPath, r.sellPath, r.active);
    }

    /// The route deliveries sell along; it must be active now, and switching it off later stops
    /// deliveries (users then claim their TAO by hand).
    function setDeliveryRoute(uint8 id) external onlyOwner {
        if (!routes[id].active) revert RouteInactive();
        deliveryRouteId = id;
        emit DeliveryRouteSet(id);
    }

    function setFees(uint16 swapFeeBps_, uint256 depositFeeUsdc_) external onlyOwner {
        if (swapFeeBps_ > MAX_SWAP_FEE_BPS || depositFeeUsdc_ > MAX_DEPOSIT_FEE_USDC) revert FeeTooHigh();
        swapFeeBps = swapFeeBps_;
        depositFeeUsdc = depositFeeUsdc_;
        emit FeesSet(swapFeeBps_, depositFeeUsdc_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// Sends this contract's whole balance of `token` (dust: sub-rao TAO, anything sent here) to the
    /// treasury.
    function sweep(IERC20 token) external onlyOwner nonReentrant {
        uint256 amount = token.balanceOf(address(this));
        token.safeTransfer(treasury, amount);
        emit Swept(address(token), amount);
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ---- internal ----

    function _stake(address beneficiary, uint256 usdcIn, uint256 minTaoOut, uint8 routeId, uint256 deadline)
        private
        returns (uint256 amount)
    {
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert Expired();
        if (beneficiary == address(0) || beneficiary == address(this) || beneficiary == address(frontDoor)) {
            revert BadBeneficiary();
        }
        Route storage route = routes[routeId];
        if (!route.active) revert RouteInactive();
        uint256 depositFee = depositFeeUsdc;
        if (usdcIn <= depositFee) revert AmountTooSmall();

        usdc.safeTransferFrom(msg.sender, address(this), usdcIn);
        uint256 swapFee = (usdcIn - depositFee) * swapFeeBps / 10_000;
        uint256 fees = depositFee + swapFee;
        if (fees != 0) usdc.safeTransfer(treasury, fees);

        uint256 taoOut = _swap(route, true, usdcIn - fees, minTaoOut, deadline);
        amount = taoOut - taoOut % RAO;

        tao.forceApprove(address(frontDoor), amount);
        frontDoor.depositFor(beneficiary, amount);
        tao.forceApprove(address(frontDoor), 0);
        emit Staked(msg.sender, beneficiary, usdcIn, fees, amount);
    }

    /// Swaps exactly `amountIn` held here (USDC -> TAO if `buy`, else TAO -> USDC) along `route` with the
    /// router's own minimum set to `minOut`, and returns the output received, measured by balance. The
    /// router must take all of the input (none of it stays here) and pay at least `minOut`.
    function _swap(Route storage route, bool buy, uint256 amountIn, uint256 minOut, uint256 deadline)
        private
        returns (uint256 out)
    {
        (IERC20 tokenIn, IERC20 tokenOut) = (tao, usdc);
        if (buy) (tokenIn, tokenOut) = (usdc, tao);
        address router = route.router;
        uint256 inBefore = tokenIn.balanceOf(address(this));
        uint256 outBefore = tokenOut.balanceOf(address(this));

        tokenIn.forceApprove(router, amountIn);
        bytes memory path = buy ? route.buyPath : route.sellPath;
        if (route.kind == RouterKind.UniswapV3) {
            IUniswapV3Router02.ExactInputParams memory p = IUniswapV3Router02.ExactInputParams({
                path: path, recipient: address(this), amountIn: amountIn, amountOutMinimum: minOut
            });
            IUniswapV3Router02(router).exactInput(p);
        } else {
            ISlipstreamRouter.ExactInputParams memory p = ISlipstreamRouter.ExactInputParams({
                path: path, recipient: address(this), deadline: deadline, amountIn: amountIn, amountOutMinimum: minOut
            });
            ISlipstreamRouter(router).exactInput(p);
        }
        tokenIn.forceApprove(router, 0);

        if (tokenIn.balanceOf(address(this)) + amountIn != inBefore) revert SwapIncomplete();
        uint256 outAfter = tokenOut.balanceOf(address(this));
        out = outAfter > outBefore ? outAfter - outBefore : 0;
        if (out < minOut) revert InsufficientOutput();
    }

    /// `path` is at least one hop (20 + 23n bytes) from `tokenIn` to `tokenOut`.
    function _checkPath(bytes calldata path, address tokenIn, address tokenOut) private pure {
        uint256 len = path.length;
        if (
            len < 43 || (len - 20) % 23 != 0 || address(bytes20(path[:20])) != tokenIn
                || address(bytes20(path[len - 20:])) != tokenOut
        ) revert BadPath();
    }
}

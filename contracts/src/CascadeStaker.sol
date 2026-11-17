// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CascadeFrontDoor} from "./CascadeFrontDoor.sol";
import {ICascadeSwapper} from "./interfaces/ICascadeSwapper.sol";
import {ICascadeTwap} from "./interfaces/ICascadeTwap.sol";
import {ISlipstreamRouter} from "./interfaces/ISlipstreamRouter.sol";
import {IUniswapV3Router02} from "./interfaces/IUniswapV3Router02.sol";

/// @notice Cascade's stake contract on Base: takes USDC (by allowance, or by a USDC permit in the same
/// transaction), takes the deposit fee and the swap fee to the treasury, swaps the rest for TAO along an
/// owner-set route, requires at least 95% of what the front door's TWAP oracle says the USDC swapped is worth
/// (the buy floor, spec §3.7, I-31), and deposits the TAO, floored to whole rao, into the front door for any
/// beneficiary. For the front door's deliveries it sells TAO for USDC along the delivery route, less the swap
/// fee (the front door's own floors bound that sale).
/// @dev No upgrade path; it holds nothing between transactions, so any balance is dust the owner may
/// sweep to the treasury. Every swap approves the router for exactly its input, resets the approval to
/// zero, and requires by balance deltas that the router took all of the input and paid at least the
/// minimum, so a wrong or malicious route can only make a call revert, and a stake's route can pay no less
/// than the buy floor. Fees have hard caps in code. Routes and fees are the owner's at once, within those
/// caps; the constructor sets the first of each, so a deploy needs no owner call before the first stake.
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

    /// The constructor's arguments. `usdc` and `tao` must be the front door's own USDC and asset; `route0` is
    /// stored at id 0 as `setRoute` stores it, `deliveryRouteId` set as `setDeliveryRoute` sets it (the route
    /// must be active, so only 0 can pass here) and the fees as `setFees` sets them, each with its setter's
    /// check and its setter's event.
    struct Params {
        IERC20Permit usdc;
        IERC20 tao;
        CascadeFrontDoor frontDoor;
        address owner;
        address treasury;
        Route route0;
        uint8 deliveryRouteId;
        uint16 swapFeeBps;
        uint256 depositFeeUsdc;
    }

    // ---- constants and immutables ----

    uint16 public constant MAX_SWAP_FEE_BPS = 50;
    /// $0.25 in USDC units.
    uint256 public constant MAX_DEPOSIT_FEE_USDC = 250_000;
    /// The buy floor's discount (spec §3.7, I-31): a stake's TAO must be at least the front door's oracle's
    /// 30-minute value of the USDC swapped, `taoValue(usdcIn - fees)`, less 5%, at every size. A constant: no
    /// owner can loosen or skip it. It is the bound, not the expectation (R3 C-I5): above launch sizes a
    /// sandwich of a stake with no minimum of its own can take the victim most of the way to it, so a caller,
    /// an integrator or a contract above all, passes its own `minTaoOut`, never 0.
    uint16 public constant MAX_BUY_SLIPPAGE_BPS = 500;
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
    /// The TAO a stake's swap paid is under the buy floor (the oracle's value of the USDC swapped, less 5%),
    /// though it met the caller's own minimum. Its causes: the pool's price is far from its 30-minute average (a
    /// pushed pool, or a rally the average lags), the stake's own price impact and the pools' fees exceed 5%, or
    /// the route pays badly (an owner-set route through a poor pool or router).
    error BelowOracleFloor();
    /// The front door has no oracle (the zero address, which also stops its deliveries): no stake can be floored.
    error NoOracle();

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

    /// Logs `TreasurySet`, then route 0's `RouteSet`, `DeliveryRouteSet` and `FeesSet`, as the setters log them.
    constructor(Params memory p) Ownable(p.owner) {
        if (
            address(p.usdc) == address(0) || address(p.tao) == address(0) || address(p.frontDoor) == address(0)
                || p.treasury == address(0)
        ) revert ZeroAddress();
        if (address(p.frontDoor.asset()) != address(p.tao) || address(p.frontDoor.usdc()) != address(p.usdc)) {
            revert TokenMismatch();
        }
        usdc = IERC20(address(p.usdc));
        tao = p.tao;
        frontDoor = p.frontDoor;
        treasury = p.treasury;
        emit TreasurySet(p.treasury);
        _setRoute(0, p.route0);
        _setDeliveryRoute(p.deliveryRouteId);
        _setFees(p.swapFeeBps, p.depositFeeUsdc);
    }

    // ---- staking ----

    /// Pulls `usdcIn` USDC from the caller, sends the deposit fee and then the swap fee on the rest to the
    /// treasury, swaps the remainder along route `routeId` and deposits the TAO received, floored to whole
    /// rao, into the front door's open batch for `beneficiary`. Reverts if the TAO received is below
    /// `minTaoOut`, below the buy floor (`BelowOracleFloor`: 95% of the front door's oracle's 30-minute value
    /// of the USDC swapped, both rounded down), while the front door has no oracle (`NoOracle`) or its oracle
    /// cannot answer (the oracle's own revert), after `deadline`, or if the front door refuses the deposit (its
    /// minimum, cap and batch limits apply). Any sender may stake for any beneficiary except the zero address,
    /// this contract and the front door.
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
    /// to the treasury and the rest to `recipient`, which must be at least `minUsdcOut`. No buy floor: the
    /// front door's delivery floors (its TWAP floor among them) set `minUsdcOut`.
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
        _setRoute(id, r);
    }

    /// The route deliveries sell along; it must be active now, and switching it off later stops
    /// deliveries (users then claim their TAO by hand).
    function setDeliveryRoute(uint8 id) external onlyOwner {
        _setDeliveryRoute(id);
    }

    function setFees(uint16 swapFeeBps_, uint256 depositFeeUsdc_) external onlyOwner {
        _setFees(swapFeeBps_, depositFeeUsdc_);
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

    /// `setRoute`'s check, write and log, shared with the constructor (which runs it after the immutables are set).
    function _setRoute(uint8 id, Route memory r) private {
        if (r.router == address(0)) revert ZeroAddress();
        _checkPath(r.buyPath, address(usdc), address(tao));
        _checkPath(r.sellPath, address(tao), address(usdc));
        routes[id] = r;
        emit RouteSet(id, r.kind, r.router, r.buyPath, r.sellPath, r.active);
    }

    function _setDeliveryRoute(uint8 id) private {
        if (!routes[id].active) revert RouteInactive();
        deliveryRouteId = id;
        emit DeliveryRouteSet(id);
    }

    function _setFees(uint16 swapFeeBps_, uint256 depositFeeUsdc_) private {
        if (swapFeeBps_ > MAX_SWAP_FEE_BPS || depositFeeUsdc_ > MAX_DEPOSIT_FEE_USDC) revert FeeTooHigh();
        swapFeeBps = swapFeeBps_;
        depositFeeUsdc = depositFeeUsdc_;
        emit FeesSet(swapFeeBps_, depositFeeUsdc_);
    }

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
        uint256 fees = depositFee + (usdcIn - depositFee) * swapFeeBps / 10_000;
        uint256 swapped = usdcIn - fees;

        // the buy floor, read before any token moves (a same-block swap leaves a 30-minute mean where it was):
        // the oracle's value of the USDC swapped, less MAX_BUY_SLIPPAGE_BPS, each step rounded down
        ICascadeTwap oracle = frontDoor.oracle();
        if (address(oracle) == address(0)) revert NoOracle();
        uint256 oracleFloor = oracle.taoValue(swapped) * (10_000 - MAX_BUY_SLIPPAGE_BPS) / 10_000;

        usdc.safeTransferFrom(msg.sender, address(this), usdcIn);
        if (fees != 0) usdc.safeTransfer(treasury, fees);

        uint256 taoOut = _swap(route, true, swapped, minTaoOut, deadline);
        if (taoOut < oracleFloor) revert BelowOracleFloor();
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
    function _checkPath(bytes memory path, address tokenIn, address tokenOut) private pure {
        uint256 len = path.length;
        if (len < 43 || (len - 20) % 23 != 0) revert BadPath();
        // the last token: the low 20 bytes of the word that ends at the path's last byte (len >= 43 > 32, so
        // that word lies inside the path's bytes)
        address last;
        assembly ("memory-safe") {
            last := and(mload(add(path, len)), 0xffffffffffffffffffffffffffffffffffffffff)
        }
        // the first token: the path's first 20 bytes, which is all bytes20(path) keeps
        // forge-lint: disable-next-line(unsafe-typecast)
        if (address(bytes20(path)) != tokenIn || last != tokenOut) revert BadPath();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import {HorizonSwapVM} from "./HorizonSwapVM.sol";
import {BinaryMarket} from "./BinaryMarket.sol";

/// @notice Exact-share routes in one market, with no protocol or routing fee.
contract RouteExecutor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_FILLS = 4;
    HorizonSwapVM public immutable router;
    IERC20 public immutable usdc;

    struct Leg {
        address maker;
        HorizonSwapVM.CurveStrategy strategy;
        uint256 shares;
        uint256 expectedFilled;
    }

    struct Request {
        address market;
        bool isYes;
        bool isBuy;
        uint256 shares;
        uint256 limit;
        address recipient;
        uint40 deadline;
    }

    struct Active {
        bytes32 hash;
        address maker;
        address token;
        BinaryMarket market;
        uint256 shares;
        uint256 cost;
        uint256 usdcExpected;
        bool yes;
    }

    Active private active;

    error InvalidRoute();
    error StaleQuote();
    error LimitExceeded();
    error UnauthorizedCallback();
    error UnexpectedBalance();

    event RouteExecuted(
        address indexed market,
        address indexed taker,
        address indexed recipient,
        bool isYes,
        bool isBuy,
        uint256 shares,
        uint256 usdcAmount,
        uint256 fills
    );

    constructor(HorizonSwapVM router_) {
        router = router_;
        usdc = IERC20(router_.registry().usdc());
    }

    function execute(Request calldata request, Leg[] calldata legs) external nonReentrant returns (uint256 totalUSDC) {
        if (
            legs.length == 0 || legs.length > MAX_FILLS || request.shares == 0 || request.recipient == address(0)
                || request.recipient == address(this) || block.timestamp > request.deadline
                || !router.registry().isMarket(request.market) || !BinaryMarket(request.market).isOpen()
        ) revert InvalidRoute();
        BinaryMarket market = BinaryMarket(request.market);
        IERC20 wanted = IERC20(address(request.isYes ? market.yesToken() : market.noToken()));
        uint256 usdBefore = usdc.balanceOf(address(this));
        uint256 tokenBefore = wanted.balanceOf(address(this));
        if (request.isBuy) usdc.safeTransferFrom(msg.sender, address(this), request.limit);
        else wanted.safeTransferFrom(msg.sender, address(this), request.shares);
        uint256 totalShares;
        for (uint256 i; i < legs.length; ++i) {
            Leg calldata leg = legs[i];
            if (leg.strategy.market != request.market || leg.shares == 0) revert InvalidRoute();
            bool makerBuy = leg.strategy.flags & 2 != 0;
            bool makerYes = leg.strategy.flags & 1 != 0;
            bool complementary = request.isBuy && makerBuy;
            if (complementary ? makerYes == request.isYes : (makerYes != request.isYes || makerBuy == request.isBuy)) {
                revert InvalidRoute();
            }
            ISwapVM.Order memory order = router.buildCurveOrder(leg.maker, leg.strategy);
            bytes32 hash = router.hash(order);
            if (router.filledShares(hash) != leg.expectedFilled) revert StaleQuote();
            address outcome = router.curveOutcome(leg.strategy);
            address input = makerBuy ? outcome : address(usdc);
            address output = makerBuy ? address(usdc) : outcome;
            TakerTraitsLib.Args memory args;
            args.taker = address(this);
            args.isExactIn = makerBuy;
            args.isAToB = input < output;
            args.useTransferFromAndAquaPush = true;
            args.hasPreTransferInCallback = complementary;
            args.deadline = request.deadline;
            bytes memory data = TakerTraitsLib.build(args);
            (uint256 amountIn, uint256 amountOut,) = ISwapVM(address(router)).quote(order, leg.shares, data);
            uint256 cost = makerBuy ? amountOut : amountIn;
            uint256 legUSDC = complementary ? leg.shares - cost : cost;
            totalUSDC += legUSDC;
            totalShares += leg.shares;
            if (totalShares > request.shares || (request.isBuy && totalUSDC > request.limit)) revert LimitExceeded();
            if (complementary) {
                active = Active(
                    hash, leg.maker, outcome, market, leg.shares, cost, usdc.balanceOf(address(this)) + cost, makerYes
                );
            } else {
                IERC20(input).forceApprove(address(router), amountIn);
            }
            (uint256 actualIn, uint256 actualOut, bytes32 actualHash) = router.swap(order, leg.shares, data);
            if (actualIn != amountIn || actualOut != amountOut || actualHash != hash || active.hash != bytes32(0)) {
                revert UnexpectedBalance();
            }
            IERC20(input).forceApprove(address(router), 0);
        }
        if (totalShares != request.shares || (!request.isBuy && totalUSDC < request.limit)) revert LimitExceeded();
        if (request.isBuy) {
            if (
                wanted.balanceOf(address(this)) != tokenBefore + request.shares
                    || usdc.balanceOf(address(this)) != usdBefore + request.limit - totalUSDC
            ) revert UnexpectedBalance();
            wanted.safeTransfer(request.recipient, request.shares);
            usdc.safeTransfer(msg.sender, request.limit - totalUSDC);
        } else {
            if (
                wanted.balanceOf(address(this)) != tokenBefore || usdc.balanceOf(address(this)) != usdBefore + totalUSDC
            ) revert UnexpectedBalance();
            usdc.safeTransfer(request.recipient, totalUSDC);
        }
        emit RouteExecuted(
            request.market,
            msg.sender,
            request.recipient,
            request.isYes,
            request.isBuy,
            request.shares,
            totalUSDC,
            legs.length
        );
    }

    function preTransferInCallback(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 hash,
        bytes calldata
    ) external {
        Active memory a = active;
        if (
            msg.sender != address(router) || a.hash == bytes32(0) || hash != a.hash || maker != a.maker
                || taker != address(this) || tokenIn != a.token || tokenOut != address(usdc) || amountIn != a.shares
                || amountOut != a.cost
        ) revert UnauthorizedCallback();
        delete active;
        if (usdc.balanceOf(address(this)) != a.usdcExpected) revert UnexpectedBalance();
        usdc.forceApprove(address(a.market), a.shares);
        a.market.mintPair(a.shares, address(this), address(this));
        usdc.forceApprove(address(a.market), 0);
        IERC20(a.token).forceApprove(address(router), a.shares);
    }
}

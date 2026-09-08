// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import {HorizonSwapVM} from "./HorizonSwapVM.sol";
import {BinaryMarket} from "./BinaryMarket.sol";

/// @notice Combine a taker's USDC with an Aqua maker's USDC before issuing a fully backed pair.
contract ComplementaryExecutor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    HorizonSwapVM public immutable router;
    IERC20 public immutable usdc;

    struct ActiveFill {
        bytes32 orderHash;
        address maker;
        BinaryMarket market;
        address input;
        address recipient;
        bool makerBuysYes;
        bool callbackDone;
        uint256 quantity;
        uint256 makerCost;
        uint256 usdcBefore;
    }

    ActiveFill private active;

    error InvalidExecution();
    error PriceLimitExceeded();
    error UnauthorizedCallback();
    error UnexpectedBalance();

    event ComplementaryMatched(
        bytes32 indexed orderHash,
        address indexed market,
        address indexed taker,
        address maker,
        address recipient,
        bool takerBuysYes,
        uint256 shares,
        uint256 takerUSDC,
        uint256 makerUSDC
    );

    constructor(HorizonSwapVM router_) {
        router = router_;
        usdc = IERC20(router_.registry().usdc());
    }

    function execute(
        address maker,
        HorizonSwapVM.BuyStrategy calldata strategy,
        uint256 quantity,
        uint256 maxTakerUSDC,
        address recipient,
        uint40 deadline
    ) external nonReentrant returns (uint256 takerCost) {
        if (recipient == address(0) || recipient == address(this) || block.timestamp > deadline) {
            revert InvalidExecution();
        }
        ISwapVM.Order memory order = router.buildBuyOrder(maker, strategy);
        address input = router.outcome(strategy);
        bytes memory takerData = _takerData(input, deadline);
        (uint256 quotedShares, uint256 makerCost, bytes32 orderHash) =
            ISwapVM(address(router)).quote(order, quantity, takerData);
        if (quotedShares != quantity || makerCost >= quantity) revert InvalidExecution();
        takerCost = quantity - makerCost;
        if (takerCost > maxTakerUSDC) revert PriceLimitExceeded();

        uint256 beforeUSDC = usdc.balanceOf(address(this));
        uint256 beforeInput = IERC20(input).balanceOf(address(this));
        active = ActiveFill(
            orderHash,
            maker,
            BinaryMarket(strategy.market),
            input,
            recipient,
            strategy.buyYes,
            false,
            quantity,
            makerCost,
            beforeUSDC
        );
        usdc.safeTransferFrom(msg.sender, address(this), takerCost);
        // Output first: Aqua sends maker USDC, then calls us to mint the input outcome.
        (uint256 amountIn, uint256 amountOut, bytes32 actualHash) = router.swap(order, quantity, takerData);
        if (!active.callbackDone || amountIn != quantity || amountOut != makerCost || actualHash != orderHash) {
            revert InvalidExecution();
        }
        if (usdc.balanceOf(address(this)) != beforeUSDC || IERC20(input).balanceOf(address(this)) != beforeInput) {
            revert UnexpectedBalance();
        }
        IERC20(input).forceApprove(address(router), 0);
        usdc.forceApprove(strategy.market, 0);
        delete active;
        emit ComplementaryMatched(
            orderHash, strategy.market, msg.sender, maker, recipient, !strategy.buyYes, quantity, takerCost, makerCost
        );
    }

    function _takerData(address input, uint40 deadline) private view returns (bytes memory) {
        TakerTraitsLib.Args memory args;
        args.taker = address(this);
        args.isExactIn = true;
        args.isAToB = input < address(usdc);
        args.useTransferFromAndAquaPush = true;
        args.hasPreTransferInCallback = true;
        args.deadline = deadline;
        return TakerTraitsLib.build(args);
    }

    function preTransferInCallback(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 orderHash,
        bytes calldata
    ) external {
        ActiveFill storage fill = active;
        if (
            msg.sender != address(router) || fill.orderHash == bytes32(0) || fill.callbackDone
                || orderHash != fill.orderHash || maker != fill.maker || taker != address(this) || tokenIn != fill.input
                || tokenOut != address(usdc) || amountIn != fill.quantity || amountOut != fill.makerCost
        ) revert UnauthorizedCallback();
        fill.callbackDone = true;
        if (usdc.balanceOf(address(this)) != fill.usdcBefore + fill.quantity) revert UnexpectedBalance();
        usdc.forceApprove(address(fill.market), fill.quantity);
        fill.market.mintPair(
            fill.quantity,
            fill.makerBuysYes ? address(this) : fill.recipient,
            fill.makerBuysYes ? fill.recipient : address(this)
        );
        IERC20(fill.input).forceApprove(address(router), fill.quantity);
    }
}

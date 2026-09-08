// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AquaSwapVMRouter} from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {Context, ContextLib} from "@1inch/swap-vm/src/libs/VM.sol";
import {MarketRegistry} from "./MarketRegistry.sol";
import {BinaryMarket} from "./BinaryMarket.sol";
import {CurveMath} from "./CurveMath.sol";

/// @notice Phase 1 fixed-price BUY strategies. The maker spends only USDC and receives its exact market outcome.
contract HorizonSwapVM is AquaSwapVMRouter {
    using ContextLib for Context;

    // Application-local instruction in SwapVM's reserved opcode range; no upstream opcode is enabled.
    uint8 public constant BUY_OPCODE = 0xf0;
    uint8 public constant CURVE_OPCODE = 0xf1;
    uint256 public constant PRICE_SCALE = 1e6;
    MarketRegistry public immutable registry;

    struct BuyStrategy {
        address market;
        bool buyYes;
        uint32 price;
        uint128 maxShares;
        bytes32 salt;
    }

    mapping(bytes32 => uint256) public filledShares;

    // flags: YES bit 0, BUY bit 1, shape (1, 2, 3) in bits 2..3.
    struct CurveStrategy {
        address market;
        uint8 flags;
        uint32 startPrice;
        uint32 endPrice;
        uint64 maxShares;
        bytes32 salt;
    }

    event CurveFilled(
        bytes32 indexed orderHash,
        address indexed market,
        address indexed maker,
        uint256 shares,
        uint256 usdcAmount,
        uint256 totalFilled
    );

    function curveOutcome(CurveStrategy memory s) public view returns (address) {
        if (!registry.isMarket(s.market)) revert InvalidStrategy();
        BinaryMarket m = BinaryMarket(s.market);
        return address(s.flags & 1 != 0 ? m.yesToken() : m.noToken());
    }

    function curveCumulative(CurveStrategy memory s, uint256 q) public pure returns (uint256) {
        return CurveMath.cumulative(s.startPrice, s.endPrice, s.maxShares, s.flags >> 2, q, s.flags & 2 != 0);
    }

    function buildCurveOrder(address maker, CurveStrategy memory s) public view returns (ISwapVM.Order memory) {
        if (maker == address(0)) revert InvalidStrategy();
        curveCumulative(s, 0);
        address token = curveOutcome(s);
        address usd = registry.usdc();
        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.useAquaInsteadOfSignature = true;
        (args.tokenA, args.tokenB) = token < usd ? (token, usd) : (usd, token);
        args.program = abi.encodePacked(CURVE_OPCODE, uint8(192), abi.encode(s));
        return MakerTraitsLib.build(args);
    }

    /// @notice Validates Aqua publication data for indexers, including all maker traits and tokens.
    function decodeCurveOrder(bytes calldata encodedOrder)
        external
        view
        returns (CurveStrategy memory strategy, address maker, bytes32 orderHash)
    {
        ISwapVM.Order memory order = abi.decode(encodedOrder, (ISwapVM.Order));
        if (order.data.length != 234 || uint8(order.data[40]) != CURVE_OPCODE || uint8(order.data[41]) != 192) {
            revert UnsupportedOrder();
        }
        bytes memory args = new bytes(192);
        for (uint256 i; i < 192; ++i) {
            args[i] = order.data[42 + i];
        }
        strategy = abi.decode(args, (CurveStrategy));
        maker = order.maker;
        orderHash = keccak256(abi.encode(order));
        if (orderHash != keccak256(abi.encode(buildCurveOrder(maker, strategy)))) revert UnsupportedOrder();
    }

    error InvalidStrategy();
    error UnsupportedOrder();
    error UnsupportedDirection();
    error FillUnavailable();

    event BuyFilled(
        bytes32 indexed orderHash,
        address indexed market,
        address indexed maker,
        bool buyYes,
        uint256 shares,
        uint256 usdcPaid,
        uint256 totalFilled
    );

    constructor(address aqua, MarketRegistry registry_, address owner)
        AquaSwapVMRouter(aqua, address(0), owner, "Horizon", "1")
    {
        registry = registry_;
    }

    function outcome(BuyStrategy memory strategy) public view returns (address) {
        if (!registry.isMarket(strategy.market)) revert InvalidStrategy();
        BinaryMarket market = BinaryMarket(strategy.market);
        return address(strategy.buyYes ? market.yesToken() : market.noToken());
    }

    /// @notice Encode this exact order with abi.encode(order) when shipping it to Aqua.
    function buildBuyOrder(address maker, BuyStrategy memory strategy)
        public
        view
        returns (ISwapVM.Order memory order)
    {
        if (maker == address(0) || strategy.price == 0 || strategy.price >= PRICE_SCALE || strategy.maxShares == 0) {
            revert InvalidStrategy();
        }
        address input = outcome(strategy);
        address output = registry.usdc();
        MakerTraitsLib.Args memory args;
        args.maker = maker;
        (args.tokenA, args.tokenB) = input < output ? (input, output) : (output, input);
        args.useAquaInsteadOfSignature = true;
        args.program = abi.encodePacked(BUY_OPCODE, uint8(160), abi.encode(strategy));
        order = MakerTraitsLib.build(args);
    }

    function _runOpcode(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        if (opcode == CURVE_OPCODE) {
            _runCurve(ctx, args);
            return;
        }
        if (opcode != BUY_OPCODE) revert UnknownOpcode(opcode);
        if (args.length != 160 || ctx.program().length != 162 || ctx.vm.nextPC != 162) revert UnsupportedOrder();
        BuyStrategy memory strategy = abi.decode(args, (BuyStrategy));
        // Bind every maker trait, receiver, token, hook and byte of program to the canonical Aqua order.
        if (ctx.query.orderHash != keccak256(abi.encode(buildBuyOrder(ctx.query.maker, strategy)))) {
            revert UnsupportedOrder();
        }
        if (!BinaryMarket(strategy.market).isOpen()) revert FillUnavailable();
        if (!ctx.query.isExactIn || ctx.query.tokenIn != outcome(strategy) || ctx.query.tokenOut != registry.usdc()) {
            revert UnsupportedDirection();
        }
        uint256 previous = filledShares[ctx.query.orderHash];
        uint256 quantity = ctx.swap.amountIn;
        if (quantity == 0 || quantity > uint256(strategy.maxShares) - previous) revert FillUnavailable();
        uint256 total = previous + quantity;
        // Cumulative floor rounding makes total maker cost independent of how a fill is split.
        uint256 cost = total * strategy.price / PRICE_SCALE - previous * strategy.price / PRICE_SCALE;
        if (cost == 0 || cost >= quantity || cost > ctx.swap.balanceOut) revert FillUnavailable();
        ctx.swap.amountOut = cost;
        if (!ctx.vm.isStaticContext) {
            filledShares[ctx.query.orderHash] = total;
            emit BuyFilled(
                ctx.query.orderHash, strategy.market, ctx.query.maker, strategy.buyYes, quantity, cost, total
            );
        }
    }

    function _runCurve(Context memory ctx, bytes calldata args) private {
        if (args.length != 192 || ctx.program().length != 194 || ctx.vm.nextPC != 194) revert UnsupportedOrder();
        CurveStrategy memory s = abi.decode(args, (CurveStrategy));
        if (ctx.query.orderHash != keccak256(abi.encode(buildCurveOrder(ctx.query.maker, s)))) {
            revert UnsupportedOrder();
        }
        if (!BinaryMarket(s.market).isOpen()) revert FillUnavailable();
        bool buy = s.flags & 2 != 0;
        address token = curveOutcome(s);
        address usd = registry.usdc();
        if (
            ctx.query.isExactIn != buy || ctx.query.tokenIn != (buy ? token : usd)
                || ctx.query.tokenOut != (buy ? usd : token)
        ) revert UnsupportedDirection();
        uint256 previous = filledShares[ctx.query.orderHash];
        uint256 q = buy ? ctx.swap.amountIn : ctx.swap.amountOut;
        if (q == 0 || q > uint256(s.maxShares) - previous) revert FillUnavailable();
        uint256 cost = curveCumulative(s, previous + q) - curveCumulative(s, previous);
        if (cost == 0 || cost >= q || (buy ? cost : q) > ctx.swap.balanceOut) revert FillUnavailable();
        if (buy) ctx.swap.amountOut = cost;
        else ctx.swap.amountIn = cost;
        if (!ctx.vm.isStaticContext) {
            filledShares[ctx.query.orderHash] = previous + q;
            emit CurveFilled(ctx.query.orderHash, s.market, ctx.query.maker, q, cost, previous + q);
        }
    }
}

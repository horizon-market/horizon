// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AquaSwapVMRouter} from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {Context, ContextLib} from "@1inch/swap-vm/src/libs/VM.sol";
import {MarketRegistry} from "./MarketRegistry.sol";
import {BinaryMarket} from "./BinaryMarket.sol";
import {CurveMath} from "./CurveMath.sol";
import {OrderBudget} from "./OrderBudget.sol";

/**
 * @notice Horizon's SwapVM application: executable pricing curves, and the per-market order budget
 *         that keeps one maker's orders inside one market from committing the same money twice.
 *
 * A maker's USDC stays shared across markets — an allocation in market A never reduces what may be
 * committed in market B. Inside one market, every order that spends the same token is added up:
 * BUY YES and BUY NO share the USDC budget, while a YES sell and a NO sell each draw on their own
 * inventory. Nothing is reserved and no fill is guaranteed; the rule only refuses to let a maker
 * promise more than the wallet can currently pay.
 */
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

    /// @notice The per-market order ledger this router enforces. Deployed with it and owned by it.
    OrderBudget public immutable budget;

    error NotAdmitted();

    /// @notice A maker's order became a live commitment against its market-and-token budget.
    event StrategyAdmitted(
        bytes32 indexed orderHash,
        address indexed market,
        address indexed maker,
        address token,
        uint256 commitment,
        uint256 committedBefore,
        uint256 spendable
    );

    /**
     * @notice Publishes an Aqua-shipped curve to this router, which is what makes it executable.
     * @dev The maker ships to Aqua first and admits second. Admission is where the per-market budget
     *      is enforced, and it is enforced here rather than in a service because Aqua's `ship` has no
     *      application callback: anyone can ship a strategy naming this router without asking
     *      Horizon. An order that stops after shipping holds its allocation and never fills.
     */
    function admitCurve(CurveStrategy memory s) external returns (bytes32 orderHash) {
        // `buildCurveOrder` validates the curve and that its market is registered, so it runs first.
        orderHash = keccak256(abi.encode(buildCurveOrder(msg.sender, s)));
        if (!BinaryMarket(s.market).isOpen()) revert FillUnavailable();
        bool buy = s.flags & 2 != 0;
        uint256 filled = filledShares[orderHash];
        // A BUY owes the exact integral over what it has left, a SELL the outcome tokens it has not
        // delivered. Neither is the opening price times the size, nor the budget before it filled.
        uint256 owed = buy ? curveCumulative(s, s.maxShares) - curveCumulative(s, filled) : s.maxShares - filled;
        _admit(s.market, orderHash, buy ? registry.usdc() : curveOutcome(s), owed, s.flags);
    }

    /// @notice The same publication step for a Phase 1 fixed-price BUY, which is a flat curve here.
    function admitBuy(BuyStrategy memory s) external returns (bytes32 orderHash) {
        orderHash = keccak256(abi.encode(buildBuyOrder(msg.sender, s)));
        if (!BinaryMarket(s.market).isOpen()) revert FillUnavailable();
        uint256 price = s.price;
        // Exactly the cumulative the BUY opcode charges, so what is owed matches what will be spent.
        uint256 owed = uint256(s.maxShares) * price / PRICE_SCALE - filledShares[orderHash] * price / PRICE_SCALE;
        _admit(s.market, orderHash, registry.usdc(), owed, uint8(4 | 2 | (s.buyYes ? 1 : 0)));
    }

    function _admit(address market, bytes32 orderHash, address token, uint256 owed, uint8 flags) private {
        (uint256 commitment, uint256 before, uint256 spendable) =
            budget.admit(msg.sender, market, orderHash, token, owed, flags);
        emit StrategyAdmitted(orderHash, market, msg.sender, token, commitment, before, spendable);
    }

    /// @notice Frees the slots of orders that can no longer fill. Anyone may run it for any maker.
    function releaseClosed(address maker, address market) external returns (uint256) {
        return budget.releaseClosed(maker, market);
    }

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
        budget = new OrderBudget(AQUA);
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
        // Shipping to Aqua publishes an order; admitting it here is what makes it executable, and is
        // where its market budget was checked. An order that skipped that step never fills.
        if (!budget.isAdmitted(ctx.query.orderHash)) revert NotAdmitted();
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
            budget.spend(ctx.query.orderHash, cost);
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
        if (!budget.isAdmitted(ctx.query.orderHash)) revert NotAdmitted();
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
            budget.spend(ctx.query.orderHash, buy ? cost : q);
            emit CurveFilled(ctx.query.orderHash, s.market, ctx.query.maker, q, cost, previous + q);
        }
    }
}

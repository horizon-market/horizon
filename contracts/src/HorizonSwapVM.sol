// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AquaSwapVMRouter} from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Context, ContextLib} from "@1inch/swap-vm/src/libs/VM.sol";
import {MarketRegistry} from "./MarketRegistry.sol";
import {BinaryMarket} from "./BinaryMarket.sol";
import {CurveMath} from "./CurveMath.sol";

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
    /// @notice Live commitments one maker may hold in one market, across both outcomes and every funding token.
    uint256 public constant MAX_OPEN_ORDERS = 16;
    /// @dev Aqua marks a docked strategy with this token count; zero means it was never shipped.
    uint8 private constant _DOCKED = 0xff;
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

    /**
     * @notice One admitted order's maximum remaining spend, in the single token that order can spend.
     * @dev `token` is USDC for a BUY and the market's outcome token for a SELL, so a BUY of YES and a
     *      BUY of NO in the same market share one budget while the two sell inventories stay apart.
     *      A fixed-price order is a curve with equal endpoints and is stored the same way, which is
     *      what keeps limit orders and curves inside one accounting.
     */
    struct Commitment {
        address token;
        uint8 flags;
        uint32 startPrice;
        uint32 endPrice;
        uint64 maxShares;
    }

    mapping(bytes32 orderHash => Commitment) private _commitments;
    mapping(address maker => mapping(address market => bytes32[])) private _open;

    error NotAdmitted();
    error AlreadyAdmitted();
    error StrategyNotShipped();
    error NothingToCommit();
    error TooManyOpenOrders();
    error MarketBudgetExceeded(address token, uint256 spendable, uint256 committed, uint256 requested);

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

    /// @notice A cancelled or exhausted order stopped consuming budget. It can never fill again.
    event StrategyReleased(bytes32 indexed orderHash, address indexed market, address indexed maker, address token);

    /// @notice Whether this router will execute an order at all. Aqua publication alone is not enough.
    function isAdmitted(bytes32 orderHash) public view returns (bool) {
        return _commitments[orderHash].token != address(0);
    }

    function commitmentOf(bytes32 orderHash) external view returns (Commitment memory) {
        return _commitments[orderHash];
    }

    /// @notice Every order this maker still has admitted in one market, both outcomes and both directions.
    function openOrders(address maker, address market) external view returns (bytes32[] memory) {
        return _open[maker][market];
    }

    /// @notice What the maker can actually spend now: allowance alone is not funding, and a balance
    ///         the spender may not touch is not funding either.
    function spendable(address maker, address token) public view returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(maker);
        uint256 allowed = IERC20(token).allowance(maker, address(AQUA));
        return balance < allowed ? balance : allowed;
    }

    /**
     * @dev The exact remaining obligation of one admitted order, reconciled against Aqua. `terminal`
     *      marks an order that can never spend again — docked by the maker, or filled to its size —
     *      which is the only condition that releases a commitment. An order whose allocation has run
     *      out contributes nothing but is not terminal, because a later Aqua push can refund it.
     */
    function _remaining(address maker, bytes32 orderHash, Commitment memory c)
        private
        view
        returns (uint256 remaining, bool terminal)
    {
        (uint256 allocation, uint8 tokensCount) = AQUA.rawBalances(maker, address(this), orderHash, c.token);
        uint256 filled = filledShares[orderHash];
        if (tokensCount == 0 || tokensCount == _DOCKED || filled >= c.maxShares) return (0, true);
        uint256 owed = c.flags & 2 != 0
            ? CurveMath.cumulative(c.startPrice, c.endPrice, c.maxShares, c.flags >> 2, c.maxShares, true)
                - CurveMath.cumulative(c.startPrice, c.endPrice, c.maxShares, c.flags >> 2, filled, true)
            : c.maxShares - filled;
        return (owed < allocation ? owed : allocation, false);
    }

    /// @notice Remaining commitment of one order, or zero once it is cancelled or exhausted.
    function remainingCommitment(address maker, bytes32 orderHash) external view returns (uint256 remaining) {
        Commitment memory c = _commitments[orderHash];
        if (c.token == address(0)) return 0;
        (remaining,) = _remaining(maker, orderHash, c);
    }

    /// @notice Everything this maker has already committed in one market against one funding token.
    function committed(address maker, address market, address token)
        public
        view
        returns (uint256 total, uint256 orders)
    {
        bytes32[] storage open = _open[maker][market];
        for (uint256 i; i < open.length; ++i) {
            Commitment memory c = _commitments[open[i]];
            if (c.token != token) continue;
            (uint256 remaining,) = _remaining(maker, open[i], c);
            if (remaining == 0) continue;
            total += remaining;
            ++orders;
        }
    }

    /**
     * @notice The whole budget for one maker, market and funding token.
     * @dev `available` is zero rather than negative when shared funds were spent elsewhere, withdrawn
     *      or de-approved: the market is then over budget and admits nothing further until the maker
     *      cancels an order or refunds the wallet. Nothing here is reserved, and USDC stays shared
     *      with the same wallet's other markets.
     */
    function marketBudget(address maker, address market, address token)
        external
        view
        returns (uint256 spendableAmount, uint256 committedAmount, uint256 available, uint256 orders)
    {
        spendableAmount = spendable(maker, token);
        (committedAmount, orders) = committed(maker, market, token);
        available = spendableAmount > committedAmount ? spendableAmount - committedAmount : 0;
    }

    /**
     * @notice Drops every cancelled or exhausted order from a maker's market list. Permissionless:
     *         it can only remove orders that are already unable to fill, and frees the maker's slots.
     */
    function releaseClosed(address maker, address market) public returns (uint256 removed) {
        bytes32[] storage open = _open[maker][market];
        for (uint256 i = open.length; i > 0;) {
            --i;
            bytes32 orderHash = open[i];
            Commitment memory c = _commitments[orderHash];
            (, bool terminal) = _remaining(maker, orderHash, c);
            if (!terminal) continue;
            open[i] = open[open.length - 1];
            open.pop();
            delete _commitments[orderHash];
            unchecked {
                ++removed;
            }
            emit StrategyReleased(orderHash, market, maker, c.token);
        }
    }

    /**
     * @notice Publishes an Aqua-shipped curve to this router, which is what makes it executable.
     * @dev The maker ships to Aqua first and admits second. Admission is where the per-market budget
     *      is enforced, and it is enforced here rather than in a service because Aqua's `ship` has no
     *      application callback: anyone can ship a strategy naming this router without asking Horizon.
     *      Two admissions racing each other cannot both pass, because the second one reads the first.
     */
    function admitCurve(CurveStrategy memory s) external returns (bytes32 orderHash) {
        orderHash = keccak256(abi.encode(buildCurveOrder(msg.sender, s)));
        address token = s.flags & 2 != 0 ? registry.usdc() : curveOutcome(s);
        _admit(msg.sender, s.market, orderHash, Commitment(token, s.flags, s.startPrice, s.endPrice, s.maxShares));
    }

    /// @notice The same publication step for a Phase 1 fixed-price BUY, which is a flat curve here.
    function admitBuy(BuyStrategy memory s) external returns (bytes32 orderHash) {
        if (s.maxShares > CurveMath.MAX_SHARES) revert InvalidStrategy();
        orderHash = keccak256(abi.encode(buildBuyOrder(msg.sender, s)));
        uint8 flags = uint8(4 | 2 | (s.buyYes ? 1 : 0));
        _admit(
            msg.sender,
            s.market,
            orderHash,
            Commitment(registry.usdc(), flags, s.price, s.price, uint64(s.maxShares))
        );
    }

    function _admit(address maker, address market, bytes32 orderHash, Commitment memory c) private {
        if (!BinaryMarket(market).isOpen()) revert FillUnavailable();
        if (_commitments[orderHash].token != address(0)) revert AlreadyAdmitted();
        (, uint8 tokensCount) = AQUA.rawBalances(maker, address(this), orderHash, c.token);
        // An allocation the maker has not shipped, or has already docked, authorizes no spending.
        if (tokensCount == 0 || tokensCount == _DOCKED) revert StrategyNotShipped();
        (uint256 requested, bool terminal) = _remaining(maker, orderHash, c);
        if (terminal || requested == 0) revert NothingToCommit();
        releaseClosed(maker, market);
        (uint256 committedAmount,) = committed(maker, market, c.token);
        uint256 spendableAmount = spendable(maker, c.token);
        if (committedAmount + requested > spendableAmount) {
            revert MarketBudgetExceeded(c.token, spendableAmount, committedAmount, requested);
        }
        bytes32[] storage open = _open[maker][market];
        if (open.length >= MAX_OPEN_ORDERS) revert TooManyOpenOrders();
        open.push(orderHash);
        _commitments[orderHash] = c;
        emit StrategyAdmitted(orderHash, market, maker, c.token, requested, committedAmount, spendableAmount);
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
        if (!isAdmitted(ctx.query.orderHash)) revert NotAdmitted();
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
        if (!isAdmitted(ctx.query.orderHash)) revert NotAdmitted();
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

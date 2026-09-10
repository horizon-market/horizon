// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";

/**
 * @notice Per-market order budgets for one Horizon router.
 *
 * A maker's USDC is shared across markets through Aqua and stays shared: a commitment in market A
 * is never subtracted from market B. What this ledger accounts for is the other half of that
 * arrangement — inside one market, every order the maker has resting that spends the same token is
 * added together, so the same money cannot be promised twice over.
 *
 * Groups are (maker, market, funding token). A BUY spends USDC whichever outcome it names, so BUY
 * YES and BUY NO share one budget. A SELL spends that market's YES or NO token, and those are
 * separate contracts, so each has a budget of its own.
 *
 * Nothing here is a reservation and no fill is promised. The rule only refuses to let a maker
 * promise more than the wallet can currently pay, and it refuses at the moment of promising.
 *
 * The router deploys this contract and is its only writer. It is deliberately not the router
 * itself: the pricing VM and the ledger of what a maker owes are separate concerns, and keeping
 * them apart is also what keeps the router inside the contract size limit.
 */
contract OrderBudget {
    /// @notice Live commitments one maker may hold in one market, across both outcomes and all tokens.
    uint256 public constant MAX_OPEN_ORDERS = 16;
    /// @dev Aqua marks a docked strategy with this token count; zero means it was never shipped.
    uint8 private constant _DOCKED = 0xff;

    IAqua public immutable AQUA;
    /// @notice The router that owns this ledger. It is the only account that may change it.
    address public immutable app;

    /**
     * @notice One admitted order's remaining obligation, in the single token that order can spend.
     * @dev `owed` is set at admission from the exact curve integral over the whole remaining size,
     *      and each fill subtracts exactly what that fill spent — the same figure the router
     *      charged. Because the cumulative integral telescopes, an order filled to its size owes
     *      precisely zero, so exhaustion needs no separate bookkeeping. `flags` carries the order's
     *      YES and BUY bits so a budget can be described without re-reading the strategy.
     */
    struct Commitment {
        address token;
        uint88 owed;
        uint8 flags;
    }

    mapping(bytes32 orderHash => Commitment) private _commitments;
    mapping(address maker => mapping(address market => bytes32[])) private _open;

    error NotRouter();
    error AlreadyAdmitted();
    error StrategyNotShipped();
    error NothingToCommit();
    error TooManyOpenOrders();
    error MarketBudgetExceeded(address token, uint256 spendable, uint256 committed, uint256 requested);

    constructor(IAqua aqua) {
        AQUA = aqua;
        app = msg.sender;
    }

    modifier onlyRouter() {
        if (msg.sender != app) revert NotRouter();
        _;
    }

    /// @notice Whether the router will execute this order at all. Aqua publication alone is not enough.
    function isAdmitted(bytes32 orderHash) external view returns (bool) {
        return _commitments[orderHash].token != address(0);
    }

    function commitmentOf(bytes32 orderHash) external view returns (Commitment memory) {
        return _commitments[orderHash];
    }

    /// @notice Every order this maker still has admitted in one market, both outcomes and directions.
    function openOrders(address maker, address market) external view returns (bytes32[] memory) {
        return _open[maker][market];
    }

    /// @notice What the maker can actually spend now: an allowance is not funding, and a balance the
    ///         spender may not touch is not funding either.
    function spendable(address maker, address token) public view returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(maker);
        uint256 allowed = IERC20(token).allowance(maker, address(AQUA));
        return balance < allowed ? balance : allowed;
    }

    /**
     * @dev What one order can still spend, reconciled against Aqua. `terminal` marks an order that
     *      can never spend again — docked by the maker, or filled to its size — which is the only
     *      condition that releases a commitment. An order whose allocation has run out contributes
     *      nothing while it stands but is not terminal, because a later Aqua push can refund it.
     */
    function _remaining(address maker, bytes32 orderHash, Commitment memory c)
        private
        view
        returns (uint256 remaining, bool terminal)
    {
        (uint256 allocation, uint8 tokensCount) = AQUA.rawBalances(maker, app, orderHash, c.token);
        if (tokensCount == 0 || tokensCount == _DOCKED || c.owed == 0) return (0, true);
        // Aqua will not release more than the order's own allocation, so that caps what it can spend.
        return (c.owed < allocation ? c.owed : allocation, false);
    }

    /// @notice Remaining commitment of one order, or zero once it is cancelled or exhausted.
    function remainingCommitment(address maker, bytes32 orderHash) external view returns (uint256 remaining) {
        (remaining,) = _remaining(maker, orderHash, _commitments[orderHash]);
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
     * @dev `available` is zero rather than negative when shared funds were spent elsewhere,
     *      withdrawn or de-approved. The market is then over budget and admits nothing further
     *      until the maker cancels an order or refunds the wallet. Outstanding orders keep their
     *      full commitment: counting an underfunded wallet's orders for less would invent room.
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
     * @notice Drops every cancelled or exhausted order from a maker's market list, freeing its slot.
     * @dev Only orders that already cannot fill are removed, so this is safe to run for anyone.
     */
    function releaseClosed(address maker, address market) public returns (uint256 removed) {
        bytes32[] storage open = _open[maker][market];
        for (uint256 i = open.length; i > 0;) {
            --i;
            bytes32 orderHash = open[i];
            (, bool terminal) = _remaining(maker, orderHash, _commitments[orderHash]);
            if (!terminal) continue;
            open[i] = open[open.length - 1];
            open.pop();
            delete _commitments[orderHash];
            unchecked {
                ++removed;
            }
        }
    }

    /**
     * @notice Records a new commitment, or refuses it because this market has no room left.
     * @dev The router has already established that the order is well formed, which market and
     *      token it spends, and what it owes. Two admissions racing each other cannot both pass:
     *      the second reads the first, because both are the same transaction ordering on chain.
     */
    function admit(address maker, address market, bytes32 orderHash, address token, uint256 owed, uint8 flags)
        external
        onlyRouter
        returns (uint256 requested, uint256 committedAmount, uint256 spendableAmount)
    {
        if (_commitments[orderHash].token != address(0)) revert AlreadyAdmitted();
        if (owed == 0 || owed > type(uint88).max) revert NothingToCommit();
        (uint256 allocation, uint8 tokensCount) = AQUA.rawBalances(maker, app, orderHash, token);
        // An allocation the maker has not shipped, or has already docked, authorizes no spending.
        if (tokensCount == 0 || tokensCount == _DOCKED) revert StrategyNotShipped();
        requested = owed < allocation ? owed : allocation;
        if (requested == 0) revert NothingToCommit();
        releaseClosed(maker, market);
        (committedAmount,) = committed(maker, market, token);
        spendableAmount = spendable(maker, token);
        if (committedAmount + requested > spendableAmount) {
            revert MarketBudgetExceeded(token, spendableAmount, committedAmount, requested);
        }
        bytes32[] storage open = _open[maker][market];
        if (open.length >= MAX_OPEN_ORDERS) revert TooManyOpenOrders();
        open.push(orderHash);
        _commitments[orderHash] = Commitment(token, uint88(owed), flags);
    }

    /// @notice A fill spends part of an obligation. It is not a cancellation: only what was paid goes.
    function spend(bytes32 orderHash, uint256 amount) external onlyRouter {
        Commitment storage c = _commitments[orderHash];
        uint88 owed = c.owed;
        c.owed = amount >= owed ? 0 : owed - uint88(amount);
    }
}

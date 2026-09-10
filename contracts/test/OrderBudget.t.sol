// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TestBase} from "./TestBase.sol";
import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {HorizonSwapVM} from "../src/HorizonSwapVM.sol";
import {OrderBudget} from "../src/OrderBudget.sol";
import {RouteExecutor} from "../src/RouteExecutor.sol";
import {BinaryMarket} from "../src/BinaryMarket.sol";

/**
 * The per-market order budget, exercised at the boundary that enforces it. Publication is two
 * steps — ship to Aqua, then admit to this router — because Aqua's `ship` has no application
 * callback, so the router is the first place Horizon can refuse an order. Every test here drives
 * the contracts directly; nothing depends on the API or on indexed data.
 */
contract OrderBudgetTest is TestBase {
    Aqua internal aqua;
    HorizonSwapVM internal router;
    OrderBudget internal ledger;
    RouteExecutor internal executor;

    function setUp() public override {
        super.setUp();
        aqua = new Aqua();
        router = new HorizonSwapVM(address(aqua), registry, address(this));
        ledger = router.budget();
        executor = new RouteExecutor(router);
        usdc.mint(MAKER, 100e6);
        usdc.mint(TAKER, 100e6);
        vm.prank(TAKER);
        usdc.approve(address(executor), type(uint256).max);
        fund(100e6, 100e6);
    }

    // ---- helpers -------------------------------------------------------------------------------

    /// @dev Spendable USDC is the lesser of these two, so both are set explicitly in every test.
    function fund(uint256 balance, uint256 allowance) internal {
        uint256 held = usdc.balanceOf(MAKER);
        if (held > balance) {
            vm.prank(MAKER);
            usdc.transfer(address(this), held - balance);
        } else if (held < balance) {
            usdc.mint(MAKER, balance - held);
        }
        vm.prank(MAKER);
        usdc.approve(address(aqua), allowance);
    }

    function curve(address where, uint8 flags, uint32 start, uint32 end, uint64 size, uint256 salt)
        internal
        pure
        returns (HorizonSwapVM.CurveStrategy memory)
    {
        return HorizonSwapVM.CurveStrategy(where, flags, start, end, size, bytes32(salt));
    }

    /// @dev Publication step one: the Aqua allocation. On its own this order can never fill.
    function ship(HorizonSwapVM.CurveStrategy memory s) internal returns (bytes32) {
        ISwapVM.Order memory order = router.buildCurveOrder(MAKER, s);
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        tokens[0] = router.curveOutcome(s);
        tokens[1] = address(usdc);
        bool buy = s.flags & 2 != 0;
        amounts[buy ? 1 : 0] = buy ? router.curveCumulative(s, s.maxShares) : s.maxShares;
        vm.prank(MAKER);
        aqua.ship(address(router), abi.encode(order), tokens, amounts);
        return router.hash(order);
    }

    /// @dev Publication step two, and the only place the budget is checked.
    function publish(HorizonSwapVM.CurveStrategy memory s) internal returns (bytes32 orderHash) {
        orderHash = ship(s);
        vm.prank(MAKER);
        router.admitCurve(s);
    }

    function committedUsdc(address where) internal view returns (uint256 total) {
        (total,) = ledger.committed(MAKER, where, address(usdc));
    }

    function refuses(HorizonSwapVM.CurveStrategy memory s, address token, uint256 spendable, uint256 committed)
        internal
    {
        ship(s);
        uint256 requested = s.flags & 2 != 0 ? router.curveCumulative(s, s.maxShares) : s.maxShares;
        vm.expectRevert(
            abi.encodeWithSelector(
                OrderBudget.MarketBudgetExceeded.selector, token, spendable, committed, requested
            )
        );
        vm.prank(MAKER);
        router.admitCurve(s);
    }

    function sellInventory(uint256 quantity) internal {
        mintPair(quantity, MAKER, MAKER);
    }

    // ---- USDC budgets --------------------------------------------------------------------------

    /// A fixed-price order is a curve with equal endpoints; both consume the one market budget.
    function testCombinedLimitAndCurveBuysShareOneMarketUsdcBudget() public {
        fund(7e6, 7e6);
        HorizonSwapVM.CurveStrategy memory limit = curve(address(market), 7, 400_000, 400_000, 10e6, 1);
        HorizonSwapVM.CurveStrategy memory shaped = curve(address(market), 6, 400_000, 200_000, 10e6, 2);
        publish(limit);
        eq(committedUsdc(address(market)), 4e6);
        publish(shaped);
        // 4 USDC of flat order plus the shaped order's integral, which is 3 and not 4.
        eq(router.curveCumulative(shaped, shaped.maxShares), 3e6);
        eq(committedUsdc(address(market)), 7e6);
        (uint256 spendable, uint256 committed, uint256 available, uint256 orders) =
            ledger.marketBudget(MAKER, address(market), address(usdc));
        eq(spendable, 7e6);
        eq(committed, 7e6);
        eq(available, 0);
        eq(orders, 2);
    }

    /// Both directions of a binary market spend USDC, so they are one budget, not two.
    function testBuyYesAndBuyNoDrawOnTheSameUsdcBudget() public {
        fund(5e6, 5e6);
        publish(curve(address(market), 7, 300_000, 300_000, 10e6, 1)); // BUY YES, 3 USDC
        eq(committedUsdc(address(market)), 3e6);
        publish(curve(address(market), 6, 200_000, 200_000, 10e6, 2)); // BUY NO, 2 USDC
        eq(committedUsdc(address(market)), 5e6);
        refuses(curve(address(market), 7, 1, 1, 1e6, 3), address(usdc), 5e6, 5e6);
    }

    /// The obligation is the integral over the whole size, never the opening price times the size.
    function testCurveBudgetUsesTheIntegralNotThePriceTimesSize() public {
        fund(3_333_333, 3_333_333);
        HorizonSwapVM.CurveStrategy memory shaped = curve(address(market), 10, 400_000, 200_000, 10e6, 1);
        // Opening price times size would claim 4 USDC and refuse this order. The integral is 3.333333,
        // which is exactly what the wallet can pay, so the order is admitted at its true obligation.
        eq(router.curveCumulative(shaped, shaped.maxShares), 3_333_333);
        publish(shaped);
        eq(committedUsdc(address(market)), 3_333_333);
        (,, uint256 available,) = ledger.marketBudget(MAKER, address(market), address(usdc));
        eq(available, 0);
    }

    function testExactBudgetIsAdmittedAndOneUnitMoreIsRefused() public {
        fund(4e6, 4e6);
        publish(curve(address(market), 7, 400_000, 400_000, 10e6, 1));
        (,, uint256 available,) = ledger.marketBudget(MAKER, address(market), address(usdc));
        eq(available, 0);
        // One micro-USDC of obligation: a one-share order at the smallest representable price.
        refuses(curve(address(market), 7, 1, 1, 1e6, 2), address(usdc), 4e6, 4e6);
        // One unit of extra funding is enough to accept exactly that order.
        fund(4_000_001, 4_000_001);
        publish(curve(address(market), 7, 1, 1, 1e6, 3));
        eq(committedUsdc(address(market)), 4_000_001);
    }

    /// Approving tokens does not create them, and holding tokens does not authorize the spender.
    function testSpendableIsTheLesserOfBalanceAndAllowance() public {
        fund(10e6, 4e6);
        eq(ledger.spendable(MAKER, address(usdc)), 4e6);
        refuses(curve(address(market), 7, 500_000, 500_000, 10e6, 1), address(usdc), 4e6, 0);
        fund(3e6, 10e6);
        eq(ledger.spendable(MAKER, address(usdc)), 3e6);
        refuses(curve(address(market), 7, 500_000, 500_000, 10e6, 2), address(usdc), 3e6, 0);
        fund(5e6, 5e6);
        publish(curve(address(market), 7, 500_000, 500_000, 10e6, 3));
        eq(committedUsdc(address(market)), 5e6);
    }

    // ---- outcome inventory ---------------------------------------------------------------------

    /// YES and NO inventories are different tokens, so they are different budgets in one market.
    function testYesAndNoSellInventoriesAreSeparateBudgets() public {
        sellInventory(20e6);
        vm.startPrank(MAKER);
        market.yesToken().approve(address(aqua), 10e6);
        market.noToken().approve(address(aqua), 10e6);
        vm.stopPrank();
        HorizonSwapVM.CurveStrategy memory sellYes = curve(address(market), 5, 600_000, 800_000, 10e6, 1);
        publish(sellYes);
        (uint256 spendable, uint256 committed, uint256 available,) =
            ledger.marketBudget(MAKER, address(market), address(market.yesToken()));
        eq(spendable, 10e6);
        eq(committed, 10e6);
        eq(available, 0);
        // A second YES sell has no inventory left, even though the wallet still holds 10 YES that
        // Aqua may not touch and 20 NO that belong to a different budget entirely.
        refuses(curve(address(market), 5, 600_000, 800_000, 1e6, 2), address(market.yesToken()), 10e6, 10e6);
        publish(curve(address(market), 4, 600_000, 800_000, 10e6, 3));
        (, uint256 noCommitted,,) = ledger.marketBudget(MAKER, address(market), address(market.noToken()));
        eq(noCommitted, 10e6);
        // Selling inventory never touched the USDC budget.
        eq(committedUsdc(address(market)), 0);
    }

    // ---- fills, cancellation and exhaustion ----------------------------------------------------

    /// A fill is not a cancellation: it moves the obligation and the wallet by the same amount.
    function testPartialFillReleasesExactlyTheIntegratedAmountSpent() public {
        fund(10e6, 10e6);
        HorizonSwapVM.CurveStrategy memory shaped = curve(address(market), 10, 400_000, 200_000, 10e6, 1);
        bytes32 orderHash = publish(shaped);
        uint256 whole = router.curveCumulative(shaped, shaped.maxShares);
        eq(committedUsdc(address(market)), whole);

        RouteExecutor.Leg[] memory legs = new RouteExecutor.Leg[](1);
        legs[0] = RouteExecutor.Leg(MAKER, shaped, 1e6, 0);
        vm.prank(TAKER);
        executor.execute(RouteExecutor.Request(address(market), true, true, 1e6, 1e6, RECIPIENT, closeAt), legs);

        uint256 spent = router.curveCumulative(shaped, 1e6);
        eq(router.filledShares(orderHash), 1e6);
        eq(spent, 399_333); // cumulative floor rounding, not price times quantity
        (uint256 spendable, uint256 committed, uint256 available,) =
            ledger.marketBudget(MAKER, address(market), address(usdc));
        eq(committed, whole - spent);
        eq(spendable, 10e6 - spent);
        // Both sides moved by the same amount, so the room for a further order is unchanged.
        eq(available, 10e6 - whole);
        eq(ledger.remainingCommitment(MAKER, orderHash), whole - spent);
    }

    function testCancellationAndExhaustionReleaseTheirCommitments() public {
        fund(7e6, 7e6);
        HorizonSwapVM.CurveStrategy memory keep = curve(address(market), 7, 400_000, 400_000, 10e6, 1);
        HorizonSwapVM.CurveStrategy memory drop = curve(address(market), 6, 300_000, 300_000, 10e6, 2);
        publish(keep);
        bytes32 dropped = publish(drop);
        eq(committedUsdc(address(market)), 7e6);

        address[] memory tokens = new address[](2);
        tokens[0] = router.curveOutcome(drop);
        tokens[1] = address(usdc);
        vm.prank(MAKER);
        aqua.dock(address(router), dropped, tokens);
        // Cancelling releases the whole remaining commitment and nothing else.
        eq(committedUsdc(address(market)), 4e6);
        eq(ledger.remainingCommitment(MAKER, dropped), 0);
        publish(curve(address(market), 6, 300_000, 300_000, 10e6, 3));
        eq(committedUsdc(address(market)), 7e6);

        // Exhaustion by fill releases the same way. A one-share BUY NO order fills completely.
        fund(8e6, 8e6);
        HorizonSwapVM.CurveStrategy memory small = curve(address(market), 6, 500_000, 500_000, 1e6, 4);
        bytes32 smallHash = publish(small);
        eq(committedUsdc(address(market)), 7_500_000);
        RouteExecutor.Leg[] memory legs = new RouteExecutor.Leg[](1);
        legs[0] = RouteExecutor.Leg(MAKER, small, 1e6, 0);
        vm.prank(TAKER);
        executor.execute(RouteExecutor.Request(address(market), true, true, 1e6, 1e6, RECIPIENT, closeAt), legs);
        eq(router.filledShares(smallHash), 1e6);
        eq(ledger.remainingCommitment(MAKER, smallHash), 0);
        eq(committedUsdc(address(market)), 7e6);
    }

    // ---- cross-market sharing and shortfalls ---------------------------------------------------

    /// Market A's commitments are never subtracted from market B's budget. That is the point of Aqua.
    function testMarketsHoldIndependentBudgetsOverTheSameWallet() public {
        fund(10e6, 10e6);
        BinaryMarket second = makeMarket(bytes32(uint256(2)));
        publish(curve(address(market), 7, 400_000, 400_000, 25e6, 1));
        eq(committedUsdc(address(market)), 10e6);
        // The same ten USDC may back a second market in full.
        publish(curve(address(second), 7, 400_000, 400_000, 25e6, 2));
        eq(committedUsdc(address(second)), 10e6);
        refuses(curve(address(second), 7, 1, 1, 1e6, 3), address(usdc), 10e6, 10e6);
    }

    /// Funds leaving the wallet make an existing market over budget. It refuses more and says so.
    function testFundingWithdrawalLeavesTheMarketOverBudgetAndRefusesMore() public {
        fund(10e6, 10e6);
        publish(curve(address(market), 7, 400_000, 400_000, 20e6, 1));
        eq(committedUsdc(address(market)), 8e6);
        fund(3e6, 10e6);
        (uint256 spendable, uint256 committed, uint256 available,) =
            ledger.marketBudget(MAKER, address(market), address(usdc));
        eq(spendable, 3e6);
        // The outstanding order is still counted in full: an underfunded wallet must not create room.
        eq(committed, 8e6);
        eq(available, 0);
        refuses(curve(address(market), 7, 1, 1, 1e6, 2), address(usdc), 3e6, 8e6);
        // A reduced allowance has exactly the same effect as a reduced balance.
        fund(10e6, 2e6);
        refuses(curve(address(market), 7, 1, 1, 1e6, 3), address(usdc), 2e6, 8e6);
    }

    // ---- the bypass this is supposed to close --------------------------------------------------

    /// Aqua lets anyone ship a strategy naming this router. Shipping alone buys nothing here.
    function testOrderShippedStraightToAquaCannotFillOrConsumeBudget() public {
        fund(10e6, 10e6);
        HorizonSwapVM.CurveStrategy memory direct = curve(address(market), 6, 400_000, 400_000, 10e6, 1);
        bytes32 orderHash = ship(direct);
        (uint256 allocation,) = aqua.rawBalances(MAKER, address(router), orderHash, address(usdc));
        eq(allocation, 4e6); // Aqua accepted the publication
        require(!ledger.isAdmitted(orderHash), "admitted without the router");
        eq(committedUsdc(address(market)), 0);

        RouteExecutor.Leg[] memory legs = new RouteExecutor.Leg[](1);
        legs[0] = RouteExecutor.Leg(MAKER, direct, 1e6, 0);
        vm.expectRevert();
        vm.prank(TAKER);
        executor.execute(RouteExecutor.Request(address(market), true, true, 1e6, 1e6, RECIPIENT, closeAt), legs);
        eq(router.filledShares(orderHash), 0);
        eq(market.collateral(), 0);
    }

    /// Two publications cannot both pass a check taken before either of them landed.
    function testSecondAdmissionSeesTheFirstSoTwoOrdersCannotRaceThroughOneBudget() public {
        fund(6e6, 6e6);
        HorizonSwapVM.CurveStrategy memory first = curve(address(market), 7, 400_000, 400_000, 10e6, 1);
        HorizonSwapVM.CurveStrategy memory second = curve(address(market), 6, 400_000, 400_000, 10e6, 2);
        // Both are prepared and shipped against the same 6 USDC while neither is admitted yet.
        ship(first);
        ship(second);
        eq(committedUsdc(address(market)), 0);
        vm.prank(MAKER);
        router.admitCurve(first);
        vm.expectRevert(
            abi.encodeWithSelector(OrderBudget.MarketBudgetExceeded.selector, address(usdc), 6e6, 4e6, 4e6)
        );
        vm.prank(MAKER);
        router.admitCurve(second);
        eq(committedUsdc(address(market)), 4e6);
    }

    function testAdmittingTwiceOrWithoutShippingIsRefused() public {
        fund(10e6, 10e6);
        HorizonSwapVM.CurveStrategy memory s = curve(address(market), 7, 400_000, 400_000, 10e6, 1);
        vm.expectRevert(OrderBudget.StrategyNotShipped.selector);
        vm.prank(MAKER);
        router.admitCurve(s);
        publish(s);
        vm.expectRevert(OrderBudget.AlreadyAdmitted.selector);
        vm.prank(MAKER);
        router.admitCurve(s);
    }

    /// The ledger is the router's. Nobody else may record a commitment or spend one down.
    function testLedgerOnlyAcceptsWritesFromItsRouter() public {
        eq(ledger.app(), address(router));
        HorizonSwapVM.CurveStrategy memory s = curve(address(market), 7, 400_000, 400_000, 10e6, 1);
        bytes32 orderHash = publish(s);
        vm.expectRevert(OrderBudget.NotRouter.selector);
        vm.prank(MAKER);
        ledger.admit(MAKER, address(market), bytes32(uint256(0xdead)), address(usdc), 1e6, 7);
        vm.expectRevert(OrderBudget.NotRouter.selector);
        vm.prank(MAKER);
        ledger.spend(orderHash, 4e6);
        eq(committedUsdc(address(market)), 4e6);
    }

    function testOpenOrderCapAndReleaseOfClosedOrders() public {
        fund(10e6, 10e6);
        uint256 cap = ledger.MAX_OPEN_ORDERS();
        for (uint256 i; i < cap; ++i) {
            publish(curve(address(market), 7, 1, 1, 1e6, 100 + i));
        }
        HorizonSwapVM.CurveStrategy memory extra = curve(address(market), 7, 1, 1, 1e6, 999);
        ship(extra);
        vm.expectRevert(OrderBudget.TooManyOpenOrders.selector);
        vm.prank(MAKER);
        router.admitCurve(extra);

        HorizonSwapVM.CurveStrategy memory cancelled = curve(address(market), 7, 1, 1, 1e6, 100);
        address[] memory tokens = new address[](2);
        tokens[0] = router.curveOutcome(cancelled);
        tokens[1] = address(usdc);
        bytes32 cancelledHash = router.hash(router.buildCurveOrder(MAKER, cancelled));
        vm.prank(MAKER);
        aqua.dock(address(router), cancelledHash, tokens);
        eq(router.releaseClosed(MAKER, address(market)), 1);
        eq(ledger.openOrders(MAKER, address(market)).length, cap - 1);
        vm.prank(MAKER);
        router.admitCurve(extra);
        eq(ledger.openOrders(MAKER, address(market)).length, cap);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TestBase} from "./TestBase.sol";
import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {HorizonSwapVM} from "../src/HorizonSwapVM.sol";
import {RouteExecutor} from "../src/RouteExecutor.sol";
import {CurveMath} from "../src/CurveMath.sol";

contract CurveRoutesTest is TestBase {
    Aqua aqua;
    HorizonSwapVM router;
    RouteExecutor executor;

    function setUp() public override {
        super.setUp();
        aqua = new Aqua();
        router = new HorizonSwapVM(address(aqua), registry, address(this));
        executor = new RouteExecutor(router);
        usdc.mint(MAKER, 100e6);
        usdc.mint(TAKER, 100e6);
        vm.prank(MAKER);
        usdc.approve(address(aqua), type(uint256).max);
        vm.prank(TAKER);
        usdc.approve(address(executor), type(uint256).max);
    }

    function curve(uint8 flags, uint32 start, uint32 end, uint256 salt)
        internal
        view
        returns (HorizonSwapVM.CurveStrategy memory)
    {
        return HorizonSwapVM.CurveStrategy(address(market), flags, start, end, 10e6, bytes32(salt));
    }

    function ship(HorizonSwapVM.CurveStrategy memory s) internal returns (bytes32) {
        ISwapVM.Order memory order = router.buildCurveOrder(MAKER, s);
        address token = router.curveOutcome(s);
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        tokens[0] = token;
        tokens[1] = address(usdc);
        amounts[s.flags & 2 != 0 ? 1 : 0] = s.flags & 2 != 0 ? router.curveCumulative(s, s.maxShares) : s.maxShares;
        vm.prank(MAKER);
        aqua.ship(address(router), abi.encode(order), tokens, amounts);
        // Shipping publishes the order; admitting it is what makes this router execute it.
        vm.prank(MAKER);
        router.admitCurve(s);
        return router.hash(order);
    }

    function request(bool buy, uint256 shares, uint256 limit) internal view returns (RouteExecutor.Request memory) {
        return RouteExecutor.Request(address(market), true, buy, shares, limit, RECIPIENT, closeAt);
    }

    function testTwoComplementaryCurvesAndRefund() public {
        HorizonSwapVM.CurveStrategy memory s = curve(6, 400000, 200000, 1);
        HorizonSwapVM.CurveStrategy memory t = curve(10, 500000, 300000, 2);
        ship(s);
        ship(t);
        RouteExecutor.Leg[] memory legs = new RouteExecutor.Leg[](2);
        legs[0] = RouteExecutor.Leg(MAKER, s, 1e6, 0);
        legs[1] = RouteExecutor.Leg(MAKER, t, 1e6, 0);
        uint256 expected = 2e6 - router.curveCumulative(s, 1e6) - router.curveCumulative(t, 1e6);
        vm.prank(TAKER);
        eq(executor.execute(request(true, 2e6, 2e6), legs), expected);
        eq(market.collateral(), 2e6);
        eq(market.yesToken().balanceOf(RECIPIENT), 2e6);
        eq(market.noToken().balanceOf(MAKER), 2e6);
        eq(usdc.balanceOf(TAKER), 100e6 - expected);
        eq(usdc.balanceOf(address(executor)), 0);
        eq(market.noToken().balanceOf(address(executor)), 0);
    }

    function testMixedDirectSellAndComplementaryBuy() public {
        mintPair(10e6, MAKER, MAKER);
        vm.startPrank(MAKER);
        market.yesToken().approve(address(aqua), type(uint256).max);
        vm.stopPrank();
        HorizonSwapVM.CurveStrategy memory sell = curve(13, 400000, 600000, 1);
        HorizonSwapVM.CurveStrategy memory buy = curve(6, 400000, 200000, 2);
        ship(sell);
        ship(buy);
        RouteExecutor.Leg[] memory legs = new RouteExecutor.Leg[](2);
        legs[0] = RouteExecutor.Leg(MAKER, sell, 1e6, 0);
        legs[1] = RouteExecutor.Leg(MAKER, buy, 1e6, 0);
        vm.prank(TAKER);
        executor.execute(request(true, 2e6, 2e6), legs);
        eq(market.yesToken().balanceOf(RECIPIENT), 2e6);
        eq(market.collateral(), 11e6);
        eq(usdc.balanceOf(address(executor)), 0);
        eq(market.yesToken().balanceOf(address(executor)), 0);
    }

    function testSellExistingOutcomesAcrossBuyers() public {
        mintPair(2e6, TAKER, TAKER);
        vm.startPrank(TAKER);
        market.yesToken().approve(address(executor), 2e6);
        vm.stopPrank();
        HorizonSwapVM.CurveStrategy memory a = curve(7, 600000, 400000, 1);
        HorizonSwapVM.CurveStrategy memory b = curve(11, 500000, 300000, 2);
        ship(a);
        ship(b);
        RouteExecutor.Leg[] memory legs = new RouteExecutor.Leg[](2);
        legs[0] = RouteExecutor.Leg(MAKER, a, 1e6, 0);
        legs[1] = RouteExecutor.Leg(MAKER, b, 1e6, 0);
        uint256 expected = router.curveCumulative(a, 1e6) + router.curveCumulative(b, 1e6);
        vm.prank(TAKER);
        eq(executor.execute(request(false, 2e6, expected), legs), expected);
        eq(usdc.balanceOf(RECIPIENT), expected);
        eq(market.yesToken().balanceOf(MAKER), 2e6);
        eq(market.collateral(), 2e6);
    }

    function testSecondLegFailureRevertsFirstAndFunding() public {
        HorizonSwapVM.CurveStrategy memory a = curve(6, 400000, 400000, 1);
        HorizonSwapVM.CurveStrategy memory b = curve(6, 400000, 400000, 2);
        bytes32 hash = ship(a);
        ship(b);
        vm.prank(MAKER);
        usdc.transfer(address(this), 99_600_000);
        RouteExecutor.Leg[] memory legs = new RouteExecutor.Leg[](2);
        legs[0] = RouteExecutor.Leg(MAKER, a, 1e6, 0);
        legs[1] = RouteExecutor.Leg(MAKER, b, 1e6, 0);
        vm.prank(TAKER);
        vm.expectRevert();
        executor.execute(request(true, 2e6, 2e6), legs);
        eq(router.filledShares(hash), 0);
        eq(market.collateral(), 0);
        eq(market.yesToken().totalSupply(), 0);
        eq(usdc.balanceOf(MAKER), 400000);
        eq(usdc.balanceOf(TAKER), 100e6);
    }

    function testStaleStateSlippageWrongSideAndCapReject() public {
        HorizonSwapVM.CurveStrategy memory s = curve(6, 400000, 400000, 1);
        ship(s);
        RouteExecutor.Leg[] memory legs = new RouteExecutor.Leg[](1);
        legs[0] = RouteExecutor.Leg(MAKER, s, 1e6, 1);
        vm.prank(TAKER);
        vm.expectRevert(RouteExecutor.StaleQuote.selector);
        executor.execute(request(true, 1e6, 1e6), legs);
        legs[0].expectedFilled = 0;
        vm.prank(TAKER);
        vm.expectRevert(RouteExecutor.LimitExceeded.selector);
        executor.execute(request(true, 1e6, 599999), legs);
        legs[0].strategy.flags = 7;
        vm.prank(TAKER);
        vm.expectRevert(RouteExecutor.InvalidRoute.selector);
        executor.execute(request(true, 1e6, 1e6), legs);
        legs = new RouteExecutor.Leg[](5);
        vm.prank(TAKER);
        vm.expectRevert(RouteExecutor.InvalidRoute.selector);
        executor.execute(request(true, 1e6, 1e6), legs);
    }

    function testFuzzCurveIntegralAdditivity(uint32 price, uint64 size, uint64 first, uint8 shape, bool buy)
        public
        view
    {
        uint64 q = uint64(1e6 + uint256(size) % (1e15 - 1e6));
        uint256 x = uint256(first) % q;
        uint32 p = uint32(1 + uint256(price) % 999999);
        uint32 lo = p / 2 + 1;
        uint8 alpha = 1 + shape % 3;
        uint256 end = CurveMath.cumulative(buy ? p : lo, buy ? lo : p, q, alpha, q, buy);
        uint256 mid = CurveMath.cumulative(buy ? p : lo, buy ? lo : p, q, alpha, x, buy);
        require(mid <= end && end <= q, "Monotonic bounded integral");
        eq(mid + (end - mid), end);
        uint256 flat = CurveMath.cumulative(p, p, q, alpha, x, buy);
        eq(flat, buy ? uint256(p) * x / 1e6 : (uint256(p) * x + 999999) / 1e6);
    }
}

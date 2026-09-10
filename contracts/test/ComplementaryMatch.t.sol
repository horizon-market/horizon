// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TestBase, TestUSDC, Vm} from "./TestBase.sol";
import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraits, MakerTraitsLib} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import {HorizonSwapVM} from "../src/HorizonSwapVM.sol";
import {ComplementaryExecutor} from "../src/ComplementaryExecutor.sol";
import {BinaryMarket} from "../src/BinaryMarket.sol";
import {OutcomeToken} from "../src/OutcomeToken.sol";

contract ComplementaryMatchTest is TestBase {
    Aqua internal aqua;
    HorizonSwapVM internal router;
    ComplementaryExecutor internal executor;
    HorizonSwapVM.BuyStrategy internal strategy;

    function setUp() public override {
        super.setUp();
        aqua = new Aqua();
        router = new HorizonSwapVM(address(aqua), registry, address(this));
        executor = new ComplementaryExecutor(router);
        strategy = HorizonSwapVM.BuyStrategy(address(market), false, 400_000, 10e6, bytes32(0));
        usdc.mint(MAKER, 100e6);
        usdc.mint(TAKER, 100e6);
        vm.prank(MAKER);
        usdc.approve(address(aqua), type(uint256).max);
        vm.prank(TAKER);
        usdc.approve(address(executor), type(uint256).max);
    }

    function ship(HorizonSwapVM.BuyStrategy memory s) internal returns (ISwapVM.Order memory order) {
        order = router.buildBuyOrder(MAKER, s);
        shipOrder(order, router.outcome(s), address(usdc), uint256(s.maxShares) * s.price / 1e6);
        vm.prank(MAKER);
        router.admitBuy(s);
    }

    function shipOrder(ISwapVM.Order memory order, address input, address output, uint256 budget) internal {
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        tokens[0] = input;
        tokens[1] = output;
        // No outcome inventory or outcome spending authorization is needed for a BUY strategy.
        amounts[0] = 0;
        amounts[1] = budget;
        vm.prank(MAKER);
        bytes32 hash = aqua.ship(address(router), abi.encode(order), tokens, amounts);
        require(hash == router.hash(order), "Aqua hash");
    }

    function fill(HorizonSwapVM.BuyStrategy memory s, uint256 quantity, uint256 maxCost) internal returns (uint256) {
        vm.prank(TAKER);
        return executor.execute(MAKER, s, quantity, maxCost, RECIPIENT, closeAt);
    }

    function quote(ISwapVM.Order memory order, address input, bool exactIn, uint256 quantity)
        internal
        view
        returns (uint256, uint256, bytes32)
    {
        TakerTraitsLib.Args memory args;
        args.taker = address(this);
        args.isExactIn = exactIn;
        args.isAToB = input < address(usdc);
        return ISwapVM(address(router)).quote(order, quantity, TakerTraitsLib.build(args));
    }

    function testSixtyFortyBackedMatchAndWinnerRedemption() public {
        ISwapVM.Order memory order = ship(strategy);
        eq(market.yesToken().totalSupply(), 0);
        eq(market.noToken().totalSupply(), 0);
        eq(fill(strategy, 1e6, 600_000), 600_000);
        eq(usdc.balanceOf(MAKER), 99_600_000);
        eq(usdc.balanceOf(TAKER), 99_400_000);
        eq(market.yesToken().balanceOf(RECIPIENT), 1e6);
        eq(market.noToken().balanceOf(MAKER), 1e6);
        eq(market.collateral(), 1e6);
        eq(usdc.balanceOf(address(market)), 1e6);
        eq(router.filledShares(router.hash(order)), 1e6);
        eq(usdc.balanceOf(address(executor)), 0);
        eq(usdc.balanceOf(address(router)), 0);
        eq(usdc.balanceOf(address(aqua)), 0);
        eq(market.noToken().balanceOf(address(executor)), 0);
        eq(market.noToken().balanceOf(address(router)), 0);
        eq(market.noToken().allowance(address(executor), address(router)), 0);
        eq(usdc.allowance(address(executor), address(market)), 0);
        eq(market.noToken().allowance(MAKER, address(aqua)), 0);
        resolve(BinaryMarket.Result.Yes);
        vm.prank(RECIPIENT);
        eq(market.redeem(1e6, 0, RECIPIENT), 1e6);
        eq(market.collateral(), 0);
    }

    function testMakerCanBuyYesAndTakerReceivesNo() public {
        strategy.buyYes = true;
        strategy.price = 600_000;
        ship(strategy);
        eq(fill(strategy, 1e6, 400_000), 400_000);
        eq(market.yesToken().balanceOf(MAKER), 1e6);
        eq(market.noToken().balanceOf(RECIPIENT), 1e6);
        resolve(BinaryMarket.Result.No);
        vm.prank(RECIPIENT);
        eq(market.redeem(0, 1e6, RECIPIENT), 1e6);
    }

    function testQuotesDoNotConsumeCapacityAndPartialFillsStayFlat() public {
        ISwapVM.Order memory order = ship(strategy);
        (, uint256 cost,) = quote(order, address(market.noToken()), true, 2e6);
        eq(cost, 800_000);
        eq(router.filledShares(router.hash(order)), 0);
        eq(fill(strategy, 1e6, 600_000), 600_000);
        (, cost,) = quote(order, address(market.noToken()), true, 2e6);
        eq(cost, 800_000);
        eq(fill(strategy, 2e6, 1_200_000), 1_200_000);
        eq(router.filledShares(router.hash(order)), 3e6);
    }

    function testLimitsAndFailureRollBackAllEffects() public {
        ISwapVM.Order memory order = ship(strategy);
        vm.expectRevert(ComplementaryExecutor.PriceLimitExceeded.selector);
        fill(strategy, 1e6, 599_999);
        vm.prank(TAKER);
        usdc.approve(address(executor), 599_999);
        vm.expectRevert();
        fill(strategy, 1e6, 600_000);
        eq(router.filledShares(router.hash(order)), 0);
        eq(market.collateral(), 0);
        eq(market.yesToken().totalSupply(), 0);
        eq(usdc.balanceOf(MAKER), 100e6);
        eq(usdc.balanceOf(TAKER), 100e6);
        (uint248 budget,) = aqua.rawBalances(MAKER, address(router), router.hash(order), address(usdc));
        eq(budget, 4e6);
    }

    function testExpiredDeadlineAndBadRecipientFail() public {
        ship(strategy);
        vm.prank(TAKER);
        vm.expectRevert(ComplementaryExecutor.InvalidExecution.selector);
        executor.execute(MAKER, strategy, 1e6, 600_000, RECIPIENT, uint40(block.timestamp - 1));
        vm.prank(TAKER);
        vm.expectRevert(ComplementaryExecutor.InvalidExecution.selector);
        executor.execute(MAKER, strategy, 1e6, 600_000, address(0), closeAt);
        vm.prank(TAKER);
        vm.expectRevert(ComplementaryExecutor.InvalidExecution.selector);
        executor.execute(MAKER, strategy, 1e6, 600_000, address(executor), closeAt);
    }

    function testClosedMarketAndExhaustedSizeFail() public {
        strategy.maxShares = 1e6;
        ship(strategy);
        fill(strategy, 1e6, 600_000);
        vm.expectRevert(HorizonSwapVM.FillUnavailable.selector);
        fill(strategy, 1e6, 600_000);
        vm.warp(closeAt);
        vm.expectRevert(HorizonSwapVM.FillUnavailable.selector);
        fill(strategy, 1e6, 600_000);
    }

    function testDockedStrategyCannotFill() public {
        ISwapVM.Order memory order = ship(strategy);
        address[] memory tokens = new address[](2);
        tokens[0] = address(market.noToken());
        tokens[1] = address(usdc);
        bytes32 hash = router.hash(order);
        vm.prank(MAKER);
        aqua.dock(address(router), hash, tokens);
        vm.expectRevert();
        fill(strategy, 1e6, 600_000);
        eq(market.collateral(), 0);
    }

    function testUSDCSharedAcrossMarketsCannotBeDoubleSpent() public {
        // Both markets may commit the same 4 USDC: the per-market budget never subtracts the other
        // market's commitments. What money cannot do is pay both, which is what this asserts.
        ship(strategy);
        BinaryMarket second = makeMarket(bytes32(uint256(2)));
        HorizonSwapVM.BuyStrategy memory other = strategy;
        other.market = address(second);
        ISwapVM.Order memory order = ship(other);
        (uint256 spendable,, uint256 available,) = router.budget().marketBudget(MAKER, address(second), address(usdc));
        eq(spendable, 100e6);
        eq(available, 96e6);
        vm.prank(MAKER);
        usdc.transfer(address(this), 99_600_000);
        // The wallet now funds one fill. The second market is over budget and admits nothing more,
        // but its already-published order is still counted, not quietly forgotten.
        (uint256 nowSpendable, uint256 nowCommitted, uint256 nowAvailable,) =
            router.budget().marketBudget(MAKER, address(second), address(usdc));
        eq(nowSpendable, 400_000);
        eq(nowCommitted, 4e6);
        eq(nowAvailable, 0);
        fill(strategy, 1e6, 600_000);
        vm.expectRevert();
        fill(other, 1e6, 600_000);
        eq(second.collateral(), 0);
        eq(second.yesToken().totalSupply(), 0);
        eq(second.noToken().totalSupply(), 0);
        eq(router.filledShares(router.hash(order)), 0);
        eq(usdc.balanceOf(TAKER), 99_400_000);
        (uint248 budget,) = aqua.rawBalances(MAKER, address(router), router.hash(order), address(usdc));
        eq(budget, 4e6);
    }

    function testRevokedMakerAllowanceRollsBackTakerContribution() public {
        ISwapVM.Order memory order = ship(strategy);
        vm.prank(MAKER);
        usdc.approve(address(aqua), 0);
        vm.expectRevert();
        fill(strategy, 1e6, 600_000);
        eq(usdc.balanceOf(TAKER), 100e6);
        eq(router.filledShares(router.hash(order)), 0);
        eq(market.collateral(), 0);
    }

    function testLateTransferRevertRollsBackCollateralTokensAndBothContributions() public {
        ISwapVM.Order memory order = router.buildBuyOrder(MAKER, strategy);
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        tokens[0] = address(market.noToken());
        tokens[1] = address(usdc);
        // Force the final Aqua.push to overflow its allocation AFTER the callback mints.
        amounts[0] = type(uint248).max;
        amounts[1] = 4e6;
        vm.prank(MAKER);
        aqua.ship(address(router), abi.encode(order), tokens, amounts);
        vm.expectRevert();
        fill(strategy, 1e6, 600_000);
        eq(market.collateral(), 0);
        eq(usdc.balanceOf(address(market)), 0);
        eq(market.yesToken().totalSupply(), 0);
        eq(market.noToken().totalSupply(), 0);
        eq(usdc.balanceOf(MAKER), 100e6);
        eq(usdc.balanceOf(TAKER), 100e6);
        eq(usdc.balanceOf(address(executor)), 0);
        eq(router.filledShares(router.hash(order)), 0);
        eq(usdc.allowance(address(executor), address(market)), 0);
        eq(market.noToken().allowance(address(executor), address(router)), 0);
    }

    function testDifferentProgramCannotReuseCanonicalAquaAuthorization() public {
        ship(strategy);
        MakerTraitsLib.Args memory args;
        args.maker = MAKER;
        args.useAquaInsteadOfSignature = true;
        args.allowZeroAmountIn = true;
        address input = address(market.noToken());
        (args.tokenA, args.tokenB) = input < address(usdc) ? (input, address(usdc)) : (address(usdc), input);
        // An empty VM program cannot borrow the maker's authorization for the canonical BUY.
        ISwapVM.Order memory other = MakerTraitsLib.build(args);
        vm.expectRevert();
        quote(other, input, false, 400_000);
        eq(usdc.balanceOf(MAKER), 100e6);
    }

    function testUnknownMarketAndInvalidPricesFail() public {
        strategy.market = address(usdc);
        vm.expectRevert(HorizonSwapVM.InvalidStrategy.selector);
        router.buildBuyOrder(MAKER, strategy);
        strategy.market = address(market);
        strategy.price = 0;
        vm.expectRevert(HorizonSwapVM.InvalidStrategy.selector);
        router.buildBuyOrder(MAKER, strategy);
        strategy.price = 1e6;
        vm.expectRevert(HorizonSwapVM.InvalidStrategy.selector);
        router.buildBuyOrder(MAKER, strategy);
    }

    function testReverseDirectionAndExactOutputAreUnsupported() public {
        ISwapVM.Order memory order = ship(strategy);
        address input = address(market.noToken());
        TakerTraitsLib.Args memory args;
        args.isExactIn = true;
        args.isAToB = !(input < address(usdc));
        bytes memory data = TakerTraitsLib.build(args);
        vm.expectRevert(HorizonSwapVM.UnsupportedDirection.selector);
        ISwapVM(address(router)).quote(order, 1e6, data);
        vm.expectRevert(HorizonSwapVM.UnsupportedDirection.selector);
        quote(order, input, false, 400_000);
    }

    function testWrongMarketOutcomeAndWrongUSDCRejectEvenIfShipped() public {
        BinaryMarket other = makeMarket(bytes32(uint256(2)));
        address wrongOutcome = address(other.noToken());
        ISwapVM.Order memory order = alteredTokens(wrongOutcome, address(usdc));
        shipOrder(order, wrongOutcome, address(usdc), 4e6);
        vm.expectRevert(HorizonSwapVM.UnsupportedOrder.selector);
        quote(order, wrongOutcome, true, 1e6);
        TestUSDC wrongUSDC = new TestUSDC();
        address correctOutcome = address(market.noToken());
        order = alteredTokens(correctOutcome, address(wrongUSDC));
        shipOrder(order, correctOutcome, address(wrongUSDC), 4e6);
        TakerTraitsLib.Args memory args;
        args.isExactIn = true;
        args.isAToB = correctOutcome < address(wrongUSDC);
        bytes memory data = TakerTraitsLib.build(args);
        vm.expectRevert(HorizonSwapVM.UnsupportedOrder.selector);
        ISwapVM(address(router)).quote(order, 1e6, data);
    }

    function alteredTokens(address input, address output) internal view returns (ISwapVM.Order memory) {
        MakerTraitsLib.Args memory args;
        args.maker = MAKER;
        args.useAquaInsteadOfSignature = true;
        (args.tokenA, args.tokenB) = input < output ? (input, output) : (output, input);
        args.program = abi.encodePacked(uint8(0xf0), uint8(160), abi.encode(strategy));
        return MakerTraitsLib.build(args);
    }

    function testAlteredMakerTraitsAndExtraInstructionsReject() public {
        ISwapVM.Order memory order = router.buildBuyOrder(MAKER, strategy);
        order.traits = MakerTraits.wrap(MakerTraits.unwrap(order.traits) | (1 << 253));
        address input = address(market.noToken());
        shipOrder(order, input, address(usdc), 4e6);
        vm.expectRevert(HorizonSwapVM.UnsupportedOrder.selector);
        quote(order, input, true, 1e6);
        order = router.buildBuyOrder(MAKER, strategy);
        order.data = bytes.concat(order.data, abi.encodePacked(uint8(0xf0), uint8(160), abi.encode(strategy)));
        shipOrder(order, input, address(usdc), 4e6);
        vm.expectRevert(HorizonSwapVM.UnsupportedOrder.selector);
        quote(order, input, true, 1e6);
    }

    function testForgedAndInactiveCallbacksFail() public {
        address input = address(market.noToken());
        vm.expectRevert(ComplementaryExecutor.UnauthorizedCallback.selector);
        executor.preTransferInCallback(
            MAKER, address(executor), input, address(usdc), 1e6, 400_000, bytes32(uint256(1)), ""
        );
        vm.prank(address(router));
        vm.expectRevert(ComplementaryExecutor.UnauthorizedCallback.selector);
        executor.preTransferInCallback(
            MAKER, address(executor), input, address(usdc), 1e6, 400_000, bytes32(uint256(1)), ""
        );
    }

    function testDonationsAreNotSpentByNextTrader() public {
        usdc.mint(address(executor), 17);
        mintPair(23, address(executor), address(executor));
        ship(strategy);
        fill(strategy, 1e6, 600_000);
        eq(usdc.balanceOf(address(executor)), 17);
        eq(market.noToken().balanceOf(address(executor)), 23);
        eq(market.yesToken().balanceOf(address(executor)), 23);
        eq(market.collateral(), 1e6 + 23);
    }

    function testEventsExposeMatchCollateralAndResolution() public {
        vm.recordLogs();
        ship(strategy);
        fill(strategy, 1e6, 600_000);
        resolve(BinaryMarket.Result.Invalid);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool shipped;
        bool matched;
        bool collateral;
        bool resolved;
        for (uint256 i; i < logs.length; ++i) {
            bytes32 topic = logs[i].topics[0];
            if (logs[i].emitter == address(aqua) && topic == keccak256("Shipped(address,address,bytes32,bytes)")) {
                shipped = true;
            }
            if (
                logs[i].emitter == address(executor)
                    && topic
                        == keccak256(
                            "ComplementaryMatched(bytes32,address,address,address,address,bool,uint256,uint256,uint256)"
                        )
            ) matched = true;
            if (logs[i].emitter == address(market) && topic == keccak256("CollateralChanged(uint256)")) {
                collateral = true;
            }
            if (logs[i].emitter == address(market) && topic == keccak256("MarketResolved(uint8,address,string)")) {
                resolved = true;
            }
        }
        require(shipped && matched && collateral && resolved, "Indexing events missing");
    }

    function testFuzzSplitFillsConserveFundsAndFlatPrice(uint32 rawPrice, uint64 rawA, uint64 rawB, bool side) public {
        strategy.price = uint32(1 + uint256(rawPrice) % 999_999);
        strategy.buyYes = side;
        // At least a whole share per leg ensures both complementary contributions are positive.
        uint256 first = 1e6 + uint256(rawA) % 1e12;
        uint256 second = 1e6 + uint256(rawB) % 1e12;
        uint256 total = first + second;
        strategy.maxShares = uint128(total);
        usdc.mint(MAKER, total);
        usdc.mint(TAKER, total);
        ISwapVM.Order memory order = ship(strategy);
        uint256 makerBefore = usdc.balanceOf(MAKER);
        uint256 takerBefore = usdc.balanceOf(TAKER);
        uint256 paid = fill(strategy, first, first) + fill(strategy, second, second);
        uint256 makerPaid = total * strategy.price / 1e6;
        eq(makerBefore - usdc.balanceOf(MAKER), makerPaid);
        eq(takerBefore - usdc.balanceOf(TAKER), paid);
        eq(paid + makerPaid, total);
        eq(market.collateral(), total);
        eq(market.yesToken().totalSupply(), total);
        eq(market.noToken().totalSupply(), total);
        eq(router.filledShares(router.hash(order)), total);
        vm.expectRevert(HorizonSwapVM.FillUnavailable.selector);
        fill(strategy, 1e6, 1e6);
    }
}

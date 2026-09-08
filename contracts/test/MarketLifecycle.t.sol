// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TestBase, TestUSDC} from "./TestBase.sol";
import {BinaryMarket} from "../src/BinaryMarket.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {OutcomeToken} from "../src/OutcomeToken.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract WrongDecimals is ERC20 {
    constructor() ERC20("Wrong", "WRONG") {}
}

contract FeeUSDC is TestUSDC {
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0) && amount > 1) {
            super._update(from, address(0), 1);
            amount -= 1;
        }
        super._update(from, to, amount);
    }
}

contract MarketLifecycleTest is TestBase {
    function testRegistryRecordsFixedConfigurationAndUniqueTokens() public {
        BinaryMarket second = makeMarket(bytes32(uint256(2)));
        eq(registry.usdc(), address(usdc));
        eq(registry.marketByCreationId(bytes32(uint256(1))), address(market));
        require(registry.isMarket(address(market)) && registry.isMarket(address(second)), "Registry");
        eq(market.resolver(), address(this));
        eq(market.closeAt(), closeAt);
        eq(market.yesToken().market(), address(market));
        eq(market.noToken().market(), address(market));
        require(market.yesToken().isYes() && !market.noToken().isYes(), "Sides");
        eq(market.yesToken().decimals(), 6);
        require(address(market.yesToken()) != address(second.yesToken()), "Shared outcomes");
        require(keccak256(bytes(market.question())) == keccak256(bytes(second.question())), "Question");
        require(bytes(market.rules()).length > 0 && bytes(market.evidenceSource()).length > 0, "Public rules");
    }

    function testUnauthorizedCreationAndDuplicateIdsFail() public {
        vm.prank(TAKER);
        vm.expectRevert();
        registry.createMarket(bytes32(uint256(2)), "Q", "R", "E", closeAt, TAKER);
        vm.expectRevert(MarketRegistry.InvalidCreationId.selector);
        makeMarket(bytes32(uint256(1)));
        vm.expectRevert(MarketRegistry.InvalidCreationId.selector);
        makeMarket(bytes32(0));
    }

    function testInvalidConfigurationFails() public {
        vm.expectRevert(BinaryMarket.InvalidConfiguration.selector);
        registry.createMarket(bytes32(uint256(2)), "", "R", "E", closeAt, TAKER);
        vm.expectRevert(BinaryMarket.InvalidConfiguration.selector);
        registry.createMarket(bytes32(uint256(2)), "Q", "R", "E", uint40(block.timestamp), TAKER);
        vm.expectRevert(BinaryMarket.InvalidConfiguration.selector);
        registry.createMarket(bytes32(uint256(2)), "Q", "R", "E", closeAt, address(0));
        WrongDecimals token = new WrongDecimals();
        vm.expectRevert(MarketRegistry.InvalidUSDC.selector);
        new MarketRegistry(address(token), address(this));
    }

    function testMintBacksBothSidesAndCannotMintOrBurnExternally() public {
        mintPair(1e6, TAKER, MAKER);
        eq(usdc.balanceOf(address(market)), 1e6);
        eq(market.collateral(), 1e6);
        OutcomeToken yes = market.yesToken();
        OutcomeToken no = market.noToken();
        eq(yes.balanceOf(TAKER), 1e6);
        eq(no.balanceOf(MAKER), 1e6);
        vm.expectRevert(OutcomeToken.OnlyMarket.selector);
        yes.mint(TAKER, 1);
        vm.expectRevert(OutcomeToken.OnlyMarket.selector);
        no.burn(MAKER, 1);
    }

    function testMintRequiresExactCollateralAndValidRecipients() public {
        vm.expectRevert();
        market.mintPair(1e6, TAKER, MAKER);
        vm.expectRevert(BinaryMarket.InvalidQuantityOrRecipient.selector);
        market.mintPair(0, TAKER, MAKER);
        vm.expectRevert(BinaryMarket.InvalidQuantityOrRecipient.selector);
        market.mintPair(1e6, address(0), MAKER);
        eq(market.collateral(), 0);
        eq(market.yesToken().totalSupply(), 0);
    }

    function testFeeOnTransferCannotCreateUnderbackedClaims() public {
        FeeUSDC feeToken = new FeeUSDC();
        BinaryMarket feeMarket = new BinaryMarket(address(feeToken), "Q", "R", "E", closeAt, address(this));
        feeToken.mint(address(this), 1e6);
        feeToken.approve(address(feeMarket), 1e6);
        vm.expectRevert(BinaryMarket.UnsupportedCollateralTransfer.selector);
        feeMarket.mintPair(1e6, TAKER, MAKER);
        eq(feeMarket.yesToken().totalSupply(), 0);
        eq(feeToken.balanceOf(address(this)), 1e6);
    }

    function testClosingAndResolutionBoundary() public {
        vm.expectRevert(BinaryMarket.MarketNotClosed.selector);
        market.close();
        vm.expectRevert(BinaryMarket.MarketNotClosed.selector);
        market.resolve(BinaryMarket.Result.Yes, "Evidence");
        vm.warp(closeAt);
        require(!market.isOpen(), "Timestamp must stop trading");
        vm.expectRevert(BinaryMarket.MarketNotOpen.selector);
        market.mintPair(1, TAKER, MAKER);
        market.close();
        market.close();
        require(market.closed(), "Close");
        vm.prank(TAKER);
        vm.expectRevert(BinaryMarket.UnauthorizedResolver.selector);
        market.resolve(BinaryMarket.Result.Yes, "Evidence");
        vm.expectRevert(BinaryMarket.InvalidResolution.selector);
        market.resolve(BinaryMarket.Result.Unresolved, "Evidence");
        vm.expectRevert(BinaryMarket.InvalidResolution.selector);
        market.resolve(BinaryMarket.Result.Yes, "");
        market.resolve(BinaryMarket.Result.Yes, "Evidence");
        vm.expectRevert(BinaryMarket.InvalidResolution.selector);
        market.resolve(BinaryMarket.Result.No, "Replacement");
    }

    function testYesResolutionPaysWinnerAndBurnsLoser() public {
        mintPair(1e6, TAKER, MAKER);
        vm.prank(TAKER);
        vm.expectRevert(BinaryMarket.InvalidResolution.selector);
        market.redeem(1e6, 0, TAKER);
        resolve(BinaryMarket.Result.Yes);
        vm.prank(TAKER);
        eq(market.redeem(1e6, 0, RECIPIENT), 1e6);
        vm.prank(MAKER);
        eq(market.redeem(0, 1e6, MAKER), 0);
        eq(usdc.balanceOf(RECIPIENT), 1e6);
        eq(market.collateral(), 0);
        eq(market.yesToken().totalSupply(), 0);
        eq(market.noToken().totalSupply(), 0);
        vm.prank(TAKER);
        vm.expectRevert();
        market.redeem(1e6, 0, TAKER);
    }

    function testNoResolutionAndTransferableClaims() public {
        mintPair(1e6, TAKER, MAKER);
        OutcomeToken no = market.noToken();
        vm.prank(MAKER);
        no.transfer(RECIPIENT, 1e6);
        resolve(BinaryMarket.Result.No);
        vm.prank(RECIPIENT);
        eq(market.redeem(0, 1e6, RECIPIENT), 1e6);
        eq(market.collateral(), 0);
    }

    function testInvalidPaysHalfAndRetainsFractionAcrossCalls() public {
        mintPair(1e6 + 1, TAKER, MAKER);
        resolve(BinaryMarket.Result.Invalid);
        vm.startPrank(TAKER);
        eq(market.redeem(1, 0, TAKER), 0);
        eq(market.invalidRemainder(TAKER), 1);
        eq(market.redeem(1, 0, TAKER), 1);
        eq(market.invalidRemainder(TAKER), 0);
        eq(market.redeem(999_999, 0, TAKER), 499_999);
        vm.stopPrank();
        vm.prank(MAKER);
        eq(market.redeem(0, 1e6 + 1, MAKER), 500_000);
        eq(market.collateral(), 1);
        eq(market.invalidRemainder(TAKER), 1);
        eq(market.invalidRemainder(MAKER), 1);
    }

    function testFuzzAllResultsConserveCollateral(uint96 rawQuantity, uint8 rawResult, uint96 rawSplit) public {
        uint256 quantity = uint256(rawQuantity) + 1;
        uint256 split = uint256(rawSplit) % (quantity + 1);
        mintPair(quantity, TAKER, TAKER);
        BinaryMarket.Result result = BinaryMarket.Result(1 + rawResult % 3);
        resolve(result);
        uint256 payout;
        vm.startPrank(TAKER);
        if (split > 0) payout += market.redeem(split, 0, TAKER);
        payout += market.redeem(quantity - split, quantity, TAKER);
        vm.stopPrank();
        eq(payout, quantity);
        eq(usdc.balanceOf(TAKER), quantity);
        eq(market.collateral(), 0);
        eq(usdc.balanceOf(address(market)), 0);
        eq(market.invalidRemainder(TAKER), 0);
    }
}

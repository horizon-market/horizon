// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OutcomeToken} from "./OutcomeToken.sol";

/// @notice Isolated, fully collateralized binary claims, denominated in six-decimal USDC.
contract BinaryMarket is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Result {
        Unresolved,
        Yes,
        No,
        Invalid
    }

    IERC20 public immutable usdc;
    OutcomeToken public immutable yesToken;
    OutcomeToken public immutable noToken;
    address public immutable resolver;
    uint40 public immutable closeAt;
    string public question;
    string public rules;
    string public evidenceSource;
    string public resolutionEvidence;
    Result public result;
    bool public closed;
    uint256 public collateral;
    // Half of one USDC base unit, retained per redeemer to make split INVALID claims additive.
    mapping(address => uint256) public invalidRemainder;

    error InvalidConfiguration();
    error MarketNotOpen();
    error MarketNotClosed();
    error InvalidResolution();
    error UnauthorizedResolver();
    error InvalidQuantityOrRecipient();
    error UnsupportedCollateralTransfer();

    event PairMinted(
        address indexed payer, address indexed yesRecipient, address indexed noRecipient, uint256 quantity
    );
    event CollateralChanged(uint256 collateral);
    event MarketClosed(uint40 closeAt);
    event MarketResolved(Result result, address indexed resolver, string evidence);
    event Redeemed(
        address indexed holder, address indexed recipient, uint256 yesQuantity, uint256 noQuantity, uint256 payout
    );

    constructor(
        address usdc_,
        string memory question_,
        string memory rules_,
        string memory evidenceSource_,
        uint40 closeAt_,
        address resolver_
    ) {
        if (
            usdc_ == address(0) || IERC20Metadata(usdc_).decimals() != 6 || resolver_ == address(0)
                || closeAt_ <= block.timestamp || bytes(question_).length == 0 || bytes(rules_).length == 0
                || bytes(evidenceSource_).length == 0
        ) revert InvalidConfiguration();
        usdc = IERC20(usdc_);
        resolver = resolver_;
        closeAt = closeAt_;
        question = question_;
        rules = rules_;
        evidenceSource = evidenceSource_;
        yesToken = new OutcomeToken(true);
        noToken = new OutcomeToken(false);
    }

    function isOpen() public view returns (bool) {
        return block.timestamp < closeAt && result == Result.Unresolved;
    }

    /// @dev One USDC base unit backs one base unit of EACH outcome; no trading fee is deducted.
    function mintPair(uint256 quantity, address yesRecipient, address noRecipient) external nonReentrant {
        if (!isOpen()) revert MarketNotOpen();
        if (quantity == 0 || yesRecipient == address(0) || noRecipient == address(0)) {
            revert InvalidQuantityOrRecipient();
        }
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), quantity);
        if (usdc.balanceOf(address(this)) != beforeBalance + quantity) revert UnsupportedCollateralTransfer();
        collateral += quantity;
        yesToken.mint(yesRecipient, quantity);
        noToken.mint(noRecipient, quantity);
        emit PairMinted(msg.sender, yesRecipient, noRecipient, quantity);
        emit CollateralChanged(collateral);
    }

    /// @notice Trading stops by timestamp even if nobody calls close().
    function close() public {
        if (block.timestamp < closeAt) revert MarketNotClosed();
        if (!closed) {
            closed = true;
            emit MarketClosed(closeAt);
        }
    }

    function resolve(Result result_, string calldata evidence) external {
        if (msg.sender != resolver) revert UnauthorizedResolver();
        if (result != Result.Unresolved || result_ == Result.Unresolved || bytes(evidence).length == 0) {
            revert InvalidResolution();
        }
        close();
        result = result_;
        resolutionEvidence = evidence;
        emit MarketResolved(result_, msg.sender, evidence);
    }

    function redeem(uint256 yesQuantity, uint256 noQuantity, address recipient)
        external
        nonReentrant
        returns (uint256 payout)
    {
        if (result == Result.Unresolved) revert InvalidResolution();
        if (recipient == address(0) || (yesQuantity == 0 && noQuantity == 0)) revert InvalidQuantityOrRecipient();
        yesToken.burn(msg.sender, yesQuantity);
        noToken.burn(msg.sender, noQuantity);
        if (result == Result.Yes) {
            payout = yesQuantity;
        } else if (result == Result.No) {
            payout = noQuantity;
        } else {
            uint256 halfUnits = yesQuantity + noQuantity + invalidRemainder[msg.sender];
            payout = halfUnits / 2;
            invalidRemainder[msg.sender] = halfUnits % 2;
        }
        collateral -= payout;
        if (payout != 0) usdc.safeTransfer(recipient, payout);
        emit Redeemed(msg.sender, recipient, yesQuantity, noQuantity, payout);
        emit CollateralChanged(collateral);
    }
}

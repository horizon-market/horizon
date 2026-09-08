// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {BinaryMarket} from "./BinaryMarket.sol";

/// @notice The creation service publishes fixed rules; each market has an immutable resolver.
contract MarketRegistry is Ownable2Step {
    address public immutable usdc;
    mapping(address => bool) public isMarket;
    mapping(bytes32 => address) public marketByCreationId;

    error InvalidUSDC();
    error InvalidCreationId();

    event MarketCreated(
        bytes32 indexed creationId,
        address indexed market,
        address indexed resolver,
        address yesToken,
        address noToken,
        uint40 closeAt,
        string question,
        string rules,
        string evidenceSource
    );

    constructor(address usdc_, address creator) Ownable(creator) {
        if (usdc_ == address(0) || IERC20Metadata(usdc_).decimals() != 6) revert InvalidUSDC();
        usdc = usdc_;
    }

    function createMarket(
        bytes32 creationId,
        string calldata question,
        string calldata rules,
        string calldata evidenceSource,
        uint40 closeAt,
        address resolver
    ) external onlyOwner returns (BinaryMarket market) {
        if (creationId == bytes32(0) || marketByCreationId[creationId] != address(0)) revert InvalidCreationId();
        market = new BinaryMarket(usdc, question, rules, evidenceSource, closeAt, resolver);
        isMarket[address(market)] = true;
        marketByCreationId[creationId] = address(market);
        emit MarketCreated(
            creationId,
            address(market),
            resolver,
            address(market.yesToken()),
            address(market.noToken()),
            closeAt,
            question,
            rules,
            evidenceSource
        );
    }
}

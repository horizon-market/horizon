// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A market-specific claim. Only its escrow can issue or redeem it.
contract OutcomeToken is ERC20 {
    address public immutable market;
    bool public immutable isYes;

    error OnlyMarket();

    constructor(bool yes_) ERC20(yes_ ? "Horizon YES" : "Horizon NO", yes_ ? "YES" : "NO") {
        market = msg.sender;
        isYes = yes_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 quantity) external {
        if (msg.sender != market) revert OnlyMarket();
        _mint(to, quantity);
    }

    function burn(address from, uint256 quantity) external {
        if (msg.sender != market) revert OnlyMarket();
        _burn(from, quantity);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {BinaryMarket} from "../src/BinaryMarket.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function warp(uint256 timestamp) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract TestUSDC is ERC20 {
    constructor() ERC20("Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant MAKER = address(0xa11ce);
    address internal constant TAKER = address(0xb0b);
    address internal constant RECIPIENT = address(0xca11);
    TestUSDC internal usdc;
    MarketRegistry internal registry;
    BinaryMarket internal market;
    uint40 internal closeAt;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        closeAt = uint40(block.timestamp + 1 days);
        usdc = new TestUSDC();
        registry = new MarketRegistry(address(usdc), address(this));
        market = makeMarket(bytes32(uint256(1)));
    }

    function makeMarket(bytes32 id) internal returns (BinaryMarket) {
        return registry.createMarket(
            id,
            "Will the published condition be met?",
            "YES if the official result is true; otherwise NO. INVALID if unavailable.",
            "https://example.org/official-result",
            closeAt,
            address(this)
        );
    }

    function mintPair(uint256 quantity, address yesRecipient, address noRecipient) internal {
        usdc.mint(address(this), quantity);
        usdc.approve(address(market), quantity);
        market.mintPair(quantity, yesRecipient, noRecipient);
    }

    function resolve(BinaryMarket.Result result) internal {
        vm.warp(closeAt);
        market.resolve(result, "https://example.org/official-result/final");
    }

    function eq(uint256 a, uint256 b) internal pure {
        require(a == b, "Values differ");
    }

    function eq(address a, address b) internal pure {
        require(a == b, "Addresses differ");
    }
}

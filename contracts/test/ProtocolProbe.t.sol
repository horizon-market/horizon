// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {AquaSwapVMRouter} from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import {LimitSwap} from "@1inch/swap-vm/src/instructions/LimitSwap.sol";
import {Context} from "@1inch/swap-vm/src/libs/VM.sol";
import {OpcodeOps} from "@1inch/swap-vm/src/libs/OpcodeList.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Aqua's default opcode set excludes LimitSwap. Extend the virtual opcode hook;
// keep the vendored protocol source intact. No fee opcodes are enabled here.
contract ProbeRouter is AquaSwapVMRouter {
    constructor(address aqua) AquaSwapVMRouter(aqua, address(0), msg.sender, "Horizon integration probe", "0") {}

    function _runOpcode(Context memory ctx, uint256 opcode, bytes calldata args) internal pure override {
        if (opcode == OpcodeOps.asU8(LimitSwap.opcode)) LimitSwap.exec(ctx, args);
        else revert UnknownOpcode(opcode);
    }
}

// Test assets and callback observer; neither represents a backed Horizon outcome.
contract ProbeToken is ERC20 {
    constructor(string memory name_) ERC20(name_, name_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 value) external {
        _mint(to, value);
    }
}

contract CallbackProbe {
    ISwapVM public immutable router;
    bool public observedOutput;
    bytes32 private activeHash;
    uint256 private balanceBefore;

    constructor(ISwapVM router_) {
        router = router_;
    }

    function execute(ISwapVM.Order memory order, ProbeToken input, ProbeToken output) external {
        activeHash = router.hash(order);
        balanceBefore = output.balanceOf(address(this));
        input.approve(address(router), type(uint256).max);
        TakerTraitsLib.Args memory args;
        args.taker = address(this);
        args.isExactIn = false;
        args.isAToB = address(input) < address(output);
        args.useTransferFromAndAquaPush = true;
        args.hasPreTransferInCallback = true;
        args.threshold = abi.encode(uint256(1e6));
        args.deadline = uint40(block.timestamp + 60);
        // isFirstTransferFromTaker stays false: maker USDC arrives before this callback.
        (uint256 amountIn, uint256 amountOut,) = router.swap(order, 400_000, TakerTraitsLib.build(args));
        require(amountIn == 1e6 && amountOut == 400_000, "Unexpected amounts");
        activeHash = bytes32(0);
    }

    function preTransferInCallback(
        address,
        address taker,
        address,
        address tokenOut,
        uint256,
        uint256 amountOut,
        bytes32 orderHash,
        bytes calldata
    ) external {
        require(
            msg.sender == address(router) && activeHash != bytes32(0) && orderHash == activeHash,
            "Unauthorized callback"
        );
        require(taker == address(this), "Wrong taker");
        require(ERC20(tokenOut).balanceOf(address(this)) == balanceBefore + amountOut, "Output must arrive first");
        observedOutput = true;
    }
}

contract ProtocolProbeTest {
    Aqua private aqua;
    AquaSwapVMRouter private router;
    ProbeToken private usdc;
    ProbeToken private outcomeA;
    ProbeToken private outcomeB;
    CallbackProbe private taker;

    function setUp() public {
        aqua = new Aqua();
        router = new ProbeRouter(address(aqua));
        usdc = new ProbeToken("Test USDC");
        outcomeA = new ProbeToken("Test outcome A");
        outcomeB = new ProbeToken("Test outcome B");
        taker = new CallbackProbe(ISwapVM(address(router)));
        usdc.mint(address(this), 400_000);
        usdc.approve(address(aqua), type(uint256).max);
        outcomeA.mint(address(taker), 1e6);
        outcomeB.mint(address(taker), 1e6);
    }

    function ship(ProbeToken outcome) private returns (ISwapVM.Order memory order) {
        MakerTraitsLib.Args memory args;
        args.maker = address(this);
        (args.tokenA, args.tokenB) =
            address(outcome) < address(usdc) ? (address(outcome), address(usdc)) : (address(usdc), address(outcome));
        args.useAquaInsteadOfSignature = true;
        args.program = LimitSwap.build(address(outcome), address(usdc));
        order = MakerTraitsLib.build(args);
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        tokens[0] = address(outcome);
        tokens[1] = address(usdc);
        amounts[0] = 1e6;
        amounts[1] = 400_000;
        require(
            aqua.ship(address(router), abi.encode(order), tokens, amounts) == router.hash(order), "Aqua hash mismatch"
        );
    }

    function testOfficialRouterTransfersAndCallsAfterMakerOutput() public {
        ISwapVM.Order memory order = ship(outcomeA);
        taker.execute(order, outcomeA, usdc);
        require(taker.observedOutput(), "Callback not reached");
        require(usdc.balanceOf(address(taker)) == 400_000 && usdc.balanceOf(address(this)) == 0, "USDC transfer");
        require(outcomeA.balanceOf(address(this)) == 1e6 && outcomeA.balanceOf(address(taker)) == 0, "Outcome transfer");
        require(
            usdc.balanceOf(address(router)) == 0 && outcomeA.balanceOf(address(router)) == 0, "Unexpected retained fees"
        );
    }

    function testSharedWalletCannotSpendTheSameUSDCInAnotherStrategy() public {
        ISwapVM.Order memory first = ship(outcomeA);
        ISwapVM.Order memory second = ship(outcomeB);
        taker.execute(first, outcomeA, usdc);
        (bool success,) = address(taker).call(abi.encodeCall(taker.execute, (second, outcomeB, usdc)));
        require(!success, "Shared USDC was double spent");
        require(outcomeB.balanceOf(address(taker)) == 1e6, "Failed fill changed token balance");
        (uint248 remaining,) = aqua.rawBalances(address(this), address(router), router.hash(second), address(usdc));
        require(remaining == 400_000, "Allocation should survive reverted fill");
    }

    function testDirectCallbackCannotImpersonateRouter() public {
        (bool success,) = address(taker).call(
            abi.encodeCall(
                taker.preTransferInCallback,
                (
                    address(this),
                    address(taker),
                    address(outcomeA),
                    address(usdc),
                    1e6,
                    400_000,
                    bytes32(uint256(1)),
                    bytes("")
                )
            )
        );
        require(!success, "Forged callback accepted");
    }
}

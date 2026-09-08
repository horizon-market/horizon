// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

library CurveMath {
    uint256 internal constant SCALE = 1e6;
    uint256 internal constant MAX_SHARES = 1e15;

    error InvalidCurve();

    // Exact rational integral. The size cap bounds all intermediates below 4e66.
    function cumulative(uint32 start, uint32 end, uint64 size, uint8 shape, uint256 q, bool buy)
        internal
        pure
        returns (uint256)
    {
        if (
            size == 0 || size > MAX_SHARES || q > size || shape < 1 || shape > 3 || start == 0 || end == 0
                || start >= SCALE || end >= SCALE || (buy ? end > start : end < start)
        ) revert InvalidCurve();
        uint256 denominator = (uint256(shape) + 1) * uint256(size) ** shape;
        uint256 numerator = uint256(start) * q * denominator;
        uint256 delta = start > end ? start - end : end - start;
        uint256 adjustment = delta * q ** (uint256(shape) + 1);
        numerator = buy ? numerator - adjustment : numerator + adjustment;
        denominator *= SCALE;
        return buy ? numerator / denominator : (numerator + denominator - 1) / denominator;
    }
}

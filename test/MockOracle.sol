// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test double for IPriceOracle: prices are set directly without
///         EIP-712 signatures so unit tests can focus on WorldBet logic.
contract MockOracle {
    struct Posted {
        uint128 price;
        uint64 timestamp;
        bool exists;
    }

    mapping(bytes32 => mapping(uint64 => Posted)) private _prices;

    function set(bytes32 asset, uint64 hourId, uint128 price) external {
        _prices[asset][hourId] = Posted({price: price, timestamp: uint64(block.timestamp), exists: true});
    }

    function priceAt(bytes32 asset, uint64 hourId)
        external
        view
        returns (uint128 price, uint64 timestamp, bool posted)
    {
        Posted storage p = _prices[asset][hourId];
        return (p.price, p.timestamp, p.exists);
    }
}

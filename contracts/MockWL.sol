// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockWL
/// @notice Testnet stand-in for the real WL BEP-20 token. Deploy ONLY on
///         BSC testnet (chainId 97) or other test environments. Anyone can
///         mint up to 1M tWL per call so testers can self-fund without a
///         centralized faucet.
contract MockWL {
    string public constant name = "Mock WorldLand";
    string public constant symbol = "tWL";
    uint8 public constant decimals = 18;

    uint256 public constant MAX_MINT_PER_CALL = 1_000_000 ether;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Faucet(address indexed to, uint256 amount);

    /// @notice Open faucet — anyone can mint up to 1M tWL per call to any
    ///         recipient. Repeat-call to top up.
    function mint(address to, uint256 amount) external {
        require(to != address(0), "tWL: to=0");
        require(amount > 0 && amount <= MAX_MINT_PER_CALL, "tWL: bad amount");
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
        emit Faucet(to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "tWL: allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "tWL: balance");
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
    }
}

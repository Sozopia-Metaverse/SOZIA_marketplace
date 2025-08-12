// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

// ERC-20 token contract for MetaverseNFTMarketplace payments
contract EcoToken is ERC20, Ownable {
    constructor(uint256 initialSupply) ERC20("EcoToken", "ECO") Ownable(msg.sender) {
        _mint(msg.sender, initialSupply);
    }

    // Mint additional tokens (only owner)
    function mint(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid recipient address");
        require(amount > 0, "Amount must be greater than zero");
        _mint(to, amount);
    }
}
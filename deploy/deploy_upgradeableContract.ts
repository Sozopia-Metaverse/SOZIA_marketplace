import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { ethers, upgrades } from "hardhat";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
    const { getNamedAccounts } = hre;
    const { deployer } = await getNamedAccounts();

    // Ensure we're deploying to Sepolia
    if (hre.network.name !== "sepolia") {
        throw new Error("This script is configured for Sepolia deployment only");
    }

    // Log deployer address and balance
    console.log("Upgrading contracts with account:", deployer);
    const balance = await ethers.provider.getBalance(deployer);
    console.log("Deployer balance:", ethers.formatEther(balance), "Sepolia ETH");

    // Proxy address of the existing MarketplaceV1 deployment
    const proxyAddress = process.env.MARKETPLACE_PROXY_ADDRESS; // Replace with the actual proxy address from the initial deployment

    // Deploy the new implementation (MarketplaceV1_1)
    const MarketplaceV1_1Factory = await ethers.getContractFactory("MarketplaceV1_1");

    // Upgrade the proxy to point to the new implementation
    const upgraded = await upgrades.upgradeProxy(proxyAddress, MarketplaceV1_1Factory, {
        kind: "uups",
    });
    await upgraded.waitForDeployment();
    console.log("MarketplaceV1_1 proxy upgraded at:", proxyAddress);

    // Log new implementation address
    const newImplementationAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
    console.log("MarketplaceV1_1 new implementation deployed to:", newImplementationAddress);

    // Verify the new implementation contract on Etherscan
    console.log("Verifying MarketplaceV1-1 implementation on Etherscan...");
    try {
        await hre.run("verify:verify", {
            address: newImplementationAddress,
            constructorArguments: [], // No constructor arguments for implementation
        });
        console.log("MarketplaceV1_1 verified at:", `https://sepolia.etherscan.io/address/${newImplementationAddress}`);
    } catch (error) {
        console.error("MarketplaceV1_1 verification failed:", error);
    }
};

export default func;
func.tags = ["all", "MarketplaceV1_1"];
func.runAtTheEnd = true;
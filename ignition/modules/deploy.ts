import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const EcoTokenModule = buildModule("EcoTokenModule", (m) => {
    const initialSupply = m.getParameter("initialSupply", "1000000000000000000000000"); // 1M tokens with 18 decimals

    const ecoToken = m.contract("EcoToken", [initialSupply]);

    // Log the deployed EcoToken address for debugging
    m.call(ecoToken, "name", [], { id: "logEcoTokenName" }); // Optional: Verify contract deployment by calling a function

    return { ecoToken };
});

const MarketplaceModule = buildModule("MarketplaceModule", (m) => {
    const { ecoToken } = m.useModule(EcoTokenModule);

    const marketplace = m.contract("Marketplace", [ecoToken]);

    return { marketplace };
});

export default MarketplaceModule;
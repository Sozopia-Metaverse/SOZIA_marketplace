# SOZIA Marketplace (Sozoer)

An upgradeable ERC-721 NFT marketplace powered by an ERC-20 payment token.

This repository contains:

- `EcoToken` — an ERC-20 token used as the payment currency
- `MarketplaceV1_1` — an upgraded marketplace adding platform commission and ERC-2981 royalties

Contracts are written with OpenZeppelin libraries and deployed with Hardhat. Tests cover minting, listing, buying, cancellations, commission, and royalties.

---

## Table of Contents

- [SOZIA Marketplace (Sozoer)](#sozia-marketplace-sozoer)
  - [Table of Contents](#table-of-contents)
  - [Features](#features)
  - [Project Structure](#project-structure)
  - [Smart Contracts](#smart-contracts)
    - [EcoToken (ERC-20)](#ecotoken-erc-20)
    - [MarketplaceV1\_1 (UUPS, ERC-721 + ERC-2981)](#marketplacev1_1-uups-erc-721--erc-2981)
  - [Getting Started](#getting-started)
  - [Environment Variables](#environment-variables)
  - [Build, Test, and Lint](#build-test-and-lint)
  - [Deployments](#deployments)
  - [Deployment and Upgrade Guide](#deployment-and-upgrade-guide)
    - [1) Fresh local deploy for development (recommended via tests)](#1-fresh-local-deploy-for-development-recommended-via-tests)
    - [2) Upgrade an existing proxy to MarketplaceV1\_1 (Sepolia)](#2-upgrade-an-existing-proxy-to-marketplacev1_1-sepolia)
  - [How It Works](#how-it-works)
  - [Example Flows](#example-flows)
  - [Verification](#verification)
  - [Security Notes](#security-notes)
  - [License](#license)

---

## Features

- Upgradeable marketplace via UUPS proxy pattern
- ERC-721 minting (owner-only), listing, buying (escrow), and cancellation
- Payments in `EcoToken` (ERC-20)
- Platform commission (basis points) configurable by owner
- ERC-2981 royalties: default and per-token
- Event-rich design (`NFTListed`, `NFTPurchased`, `ListingCancelled`, `CommissionPaid`, `RoyaltyPaid`)

## Project Structure

```
SOZIA_marketplace/
  contracts/
    EcoToken.sol
    MarketplaceV1_1.sol
  deploy/
    deploy_upgradeableContract.ts
  deployments/
    sepolia/
      EcoToken.json
      Marketplace.json
      MarketplaceV1.json
  test/
    Marketplace.test.ts
  hardhat.config.ts
  package.json
  tsconfig.json
```

Notes:

- `deploy/deploy_upgradeableContract.ts` handles upgrading an existing UUPS proxy to `MarketplaceV1_1` on Sepolia.
- `deployments/sepolia/*.json` contains addresses and ABIs for previously deployed artifacts.
- `test/Marketplace.test.ts` uses Hardhat and OpenZeppelin Upgrades to deploy a proxy and validate core flows.

## Smart Contracts

### EcoToken (ERC-20)

- Symbol: `ECO`
- Owner-mintable
- Used as the payment currency in the marketplace

### MarketplaceV1_1 (UUPS, ERC-721 + ERC-2981)

Adds:

- Commission in basis points: `commissionBps` and `commissionRecipient`
- ERC-2981 royalties with default and per-token configuration
- `totalListings` tracking

Initialization and upgrades:

- `initialize(address paymentToken)` — initial deploy (sets ERC-20 payment token)
- `initializeV2(address recipient, uint16 bps)` — set commission during upgrade
- `initializeV3Royalty(address defaultReceiver, uint96 defaultBps)` — enable and set default royalties on upgrade

## Getting Started

Prerequisites:

- Node.js 18+
- npm 9+ (or yarn/pnpm)

Install dependencies:

```bash
npm install
```

## Environment Variables

Create a `.env` at the repo root:

```env
SEPOLIA_RPC_URL="https://sepolia.infura.io/v3/<your-key>"  # or Alchemy/other
PRIVATE_KEY="0x..."                                        # deployer key
ETHERSCAN_API_KEY="..."                                    # for verification

# For upgrade script
MARKETPLACE_PROXY_ADDRESS="0x..."                          # existing UUPS proxy
```

The Hardhat config uses `sepolia` with `chainId: 11155111`.

## Build, Test, and Lint

Compile contracts:

```bash
npx hardhat compile
```

Run tests:

```bash
npx hardhat test
```

Optional gas reporting:

```bash
REPORT_GAS=true npx hardhat test
```

## Deployments

Known Sepolia addresses (from `deployments/sepolia` and logs):

- `EcoToken`: `0x830bAEFBD1B6CC8b158B24E678B443BeE2e59603`
- `Marketplace` proxy: `0xfd1fAB2E969aE7eC95De81caf1240107a76963Dc`

Use the existing proxy address as `MARKETPLACE_PROXY_ADDRESS` when upgrading.

## Deployment and Upgrade Guide

### 1) Fresh local deploy for development (recommended via tests)

The test suite demonstrates deploying `EcoToken` and a `MarketplaceV1_1` proxy:

```ts
const EcoTokenFactory = await ethers.getContractFactory("EcoToken");
const ecoToken = await EcoTokenFactory.deploy(ethers.parseUnits("10000", 18));

const MarketplaceFactory = await ethers.getContractFactory("MarketplaceV1_1");
const marketplace = await upgrades.deployProxy(
  MarketplaceFactory,
  [await ecoToken.getAddress()],
  {
    kind: "uups",
    initializer: "initialize",
  }
);
```

### 2) Upgrade an existing proxy to MarketplaceV1_1 (Sepolia)

Configure `.env` with `SEPOLIA_RPC_URL`, `PRIVATE_KEY`, and `MARKETPLACE_PROXY_ADDRESS`, then run:

```bash
npx hardhat deploy --network sepolia --tags MarketplaceV1_1
```

The script `deploy/deploy_upgradeableContract.ts` will:

- Deploy the `MarketplaceV1_1` implementation
- Upgrade the existing UUPS proxy
- Print the new implementation address
- Attempt Etherscan verification for the implementation

After upgrading, you may call reinitializers if needed:

```solidity
initializeV2(recipient, bps);
initializeV3Royalty(defaultReceiver, defaultBps);
```

## How It Works

High-level flow:

1. Admin mints an NFT to a user via `mint(to, metadataURI)`
2. Owner lists an NFT via `listNFT(tokenId, price)` — NFT moves to contract escrow
3. Buyer approves the marketplace to spend `ECO` and calls `buyNFT(tokenId)`
4. On purchase: royalties and commission are computed and paid in `ECO`, remainder goes to seller; NFT transfers to buyer
5. Seller may cancel listing via `cancelListing(tokenId)` to retrieve the NFT

## Example Flows

Approve marketplace to spend `ECO` (buyer):

```ts
await ecoToken.connect(buyer).approve(marketplaceAddress, price);
```

List NFT (seller):

```ts
await marketplace.connect(seller).listNFT(tokenId, price);
```

Buy NFT (buyer):

```ts
await marketplace.connect(buyer).buyNFT(tokenId);
```

Set platform commission (owner):

```ts
await marketplace.setCommission(250, owner.address); // 2.5%
```

Set default royalty (owner):

```ts
await marketplace.setDefaultRoyalty(royaltyReceiver, 500); // 5%
```

## Verification

Verify implementation contracts on Etherscan after deploy/upgrade:

```bash
npx hardhat verify --network sepolia <IMPLEMENTATION_ADDRESS>
```

Note: UUPS proxies verify the implementation contract, not the proxy itself.

## Security Notes

- `mint` and all admin/upgrade functions are `onlyOwner`
- UUPS upgrades require `_authorizeUpgrade` implemented with `onlyOwner`
- Users must approve sufficient `ECO` allowance before purchasing
- Always review and test reinitializers (`initializeV2`, `initializeV3Royalty`) before invoking on a live proxy

## License

MIT

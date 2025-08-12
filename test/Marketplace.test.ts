import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { EcoToken, MarketplaceV1_1 } from "../typechain-types";

describe("MarketplaceV1_1 and EcoToken", function () {
  let ecoToken: EcoToken;
  let marketplace: MarketplaceV1_1; // Proxy of MarketplaceV1_1
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;

  const initialSupply = ethers.parseUnits("10000", 18);
  const nftPrice = ethers.parseUnits("100", 18);
  const metadataURI = "ipfs://QmTestMetadataURI";

  const COMMISSION_BPS = 250n; // 2.5%
  const BPS_DENOM = 10000n;

  beforeEach(async function () {
    [owner, user1, user2, user3] = await ethers.getSigners();

    // Deploy EcoToken
    const EcoTokenFactory = await ethers.getContractFactory("EcoToken");
    ecoToken = (await EcoTokenFactory.deploy(initialSupply)) as EcoToken;
    await ecoToken.waitForDeployment();

    // Deploy MarketplaceV1_1 via UUPS proxy with initialize(paymentToken)
    const MarketplaceFactory = await ethers.getContractFactory("MarketplaceV1_1");
    marketplace = await upgrades.deployProxy(MarketplaceFactory, [await ecoToken.getAddress()], {
      kind: "uups",
      initializer: "initialize",
    });
    await marketplace.waitForDeployment();

    // Transfer some EcoTokens to user1 for mint ownership/misc
    await ecoToken.transfer(user1.address, ethers.parseUnits("1000", 18));
  });

  describe("buyNFT", function () {
    let tokenId: string;

    beforeEach(async function () {
      // Mint NFT to user1
      const tx = await marketplace.mint(user1.address, metadataURI);
      const receipt = await tx.wait();
      tokenId = receipt?.logs[0].topics[3] ? BigInt(receipt.logs[0].topics[3]).toString() : "0";

      // List NFT for sale
      await marketplace.connect(user1).listNFT(tokenId, nftPrice);

      // Ensure user2 has sufficient balance and allowance
      await ecoToken.transfer(user2.address, nftPrice);
      await ecoToken.connect(user2).approve(await marketplace.getAddress(), nftPrice);

      const user2Balance = await ecoToken.balanceOf(user2.address);
      expect(user2Balance).to.be.at.least(nftPrice, "User2 has insufficient EcoToken balance");
    });

    it("should buy listed NFT and emit event", async function () {
      await expect(marketplace.connect(user2).buyNFT(tokenId))
        .to.emit(marketplace, "NFTPurchased")
        .withArgs(tokenId, user2.address, user1.address, nftPrice);
    });

    it("should revert if NFT not listed", async function () {
      await marketplace.connect(user1).cancelListing(tokenId);
      await expect(marketplace.connect(user2).buyNFT(tokenId)).to.be.revertedWith("NFT not listed for sale");
    });

    it("should revert with insufficient allowance", async function () {
      await ecoToken.connect(user2).approve(await marketplace.getAddress(), nftPrice - 1n);
      await expect(marketplace.connect(user2).buyNFT(tokenId)).to.be.revertedWith("Insufficient ERC-20 allowance");
    });

    it("should revert with insufficient balance", async function () {
      await ecoToken.connect(user2).transfer(user3.address, await ecoToken.balanceOf(user2.address));
      await expect(marketplace.connect(user2).buyNFT(tokenId)).to.be.revertedWith("Insufficient ERC-20 balance");
    });
  });

  describe("NFT Listing and Buying with commission", function () {
    let tokenId: string;

    beforeEach(async function () {
      const tx = await marketplace.mint(user1.address, metadataURI);
      const receipt = await tx.wait();
      tokenId = receipt?.logs[0].topics[3] ? BigInt(receipt.logs[0].topics[3]).toString() : "0";

      await ecoToken.connect(user2).approve(marketplace.getAddress(), nftPrice);
    });

    it("should allow user to list NFT for sale", async function () {
      await marketplace.connect(user1).listNFT(tokenId, nftPrice);
      const listing = await marketplace.listings(tokenId);
      expect(listing.seller).to.equal(user1.address);
      expect(listing.price).to.equal(nftPrice);
      expect(listing.active).to.be.true;
      expect(await marketplace.ownerOf(tokenId)).to.equal(await marketplace.getAddress());
    });

    it("should buy listed NFT paying commission to owner by default", async function () {
      await marketplace.connect(user1).listNFT(tokenId, nftPrice);
      await ecoToken.transfer(user2.address, nftPrice);

      const commission = (nftPrice * COMMISSION_BPS) / BPS_DENOM;
      const sellerNet = nftPrice - commission;

      const ownerBefore = await ecoToken.balanceOf(owner.address);
      const user1Before = await ecoToken.balanceOf(user1.address);

      await marketplace.connect(user2).buyNFT(tokenId);

      // Buyer becomes owner
      expect(await marketplace.ownerOf(tokenId)).to.equal(user2.address);
      expect((await marketplace.listings(tokenId)).active).to.be.false;

      // Seller receives net after commission
      expect(await ecoToken.balanceOf(user1.address)).to.equal(user1Before + sellerNet);

      // Commission recipient (default owner) receives commission
      expect(await ecoToken.balanceOf(owner.address)).to.equal(ownerBefore + commission);
    });

    it("should allow seller to cancel listing", async function () {
      await marketplace.connect(user1).listNFT(tokenId, nftPrice);
      await marketplace.connect(user1).cancelListing(tokenId);
      expect(await marketplace.ownerOf(tokenId)).to.equal(user1.address);
      expect((await marketplace.listings(tokenId)).active).to.be.false;
    });

    it("should revert if non-seller tries to cancel listing", async function () {
      await marketplace.connect(user1).listNFT(tokenId, nftPrice);
      await expect(marketplace.connect(user2).cancelListing(tokenId)).to.be.revertedWith("Not seller");
    });
  });

  describe("Royalty distribution (ERC-2981)", function () {
    let tokenId: string;

    beforeEach(async function () {
      const tx = await marketplace.mint(user1.address, metadataURI);
      const receipt = await tx.wait();
      tokenId = receipt?.logs[0].topics[3] ? BigInt(receipt.logs[0].topics[3]).toString() : "0";

      // Set a default royalty of 5% to user3
      await marketplace.setDefaultRoyalty(user3.address, 500); // 500 bps = 5%
    });

    it("pays royalty and commission, remainder to seller", async function () {
      await marketplace.connect(user1).listNFT(tokenId, nftPrice);
      await ecoToken.transfer(user2.address, nftPrice);
      await ecoToken.connect(user2).approve(await marketplace.getAddress(), nftPrice);

      const royalty = (nftPrice * 500n) / BPS_DENOM; // 5%
      const commission = (nftPrice * COMMISSION_BPS) / BPS_DENOM; // 2.5%
      const sellerNet = nftPrice - royalty - commission;

      const ownerBefore = await ecoToken.balanceOf(owner.address);
      const sellerBefore = await ecoToken.balanceOf(user1.address);
      const royaltyBefore = await ecoToken.balanceOf(user3.address);

      await marketplace.connect(user2).buyNFT(tokenId);

      expect(await marketplace.ownerOf(tokenId)).to.equal(user2.address);
      expect((await marketplace.listings(tokenId)).active).to.be.false;

      expect(await ecoToken.balanceOf(user1.address)).to.equal(sellerBefore + sellerNet);
      expect(await ecoToken.balanceOf(owner.address)).to.equal(ownerBefore + commission);
      expect(await ecoToken.balanceOf(user3.address)).to.equal(royaltyBefore + royalty);
    });
  });
});
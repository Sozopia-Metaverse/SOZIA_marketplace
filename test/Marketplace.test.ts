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

      // FIX: await the marketplace address
      await ecoToken.connect(user2).approve(await marketplace.getAddress(), nftPrice);
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

  describe("Auctions", function () {
    let tokenId: string;

    const startingBid = ethers.parseUnits("50", 18);
    const minIncrement = ethers.parseUnits("10", 18);
    const duration = 60; // seconds

    beforeEach(async function () {
      const tx = await marketplace.mint(user1.address, metadataURI);
      const receipt = await tx.wait();
      tokenId = receipt?.logs[0].topics[3] ? BigInt(receipt.logs[0].topics[3]).toString() : "0";
      // Default royalty 5% to user3 for auction settlement checks
      await marketplace.setDefaultRoyalty(user3.address, 500);
    });

    it("creates an auction and locks NFT", async function () {
      await marketplace.connect(user1).createAuction(tokenId, startingBid, minIncrement, duration);
      const a = await marketplace.auctions(tokenId);
      expect(a.active).to.equal(true);
      expect(a.seller).to.equal(user1.address);
      expect(a.startingBid).to.equal(startingBid);
      expect(a.minIncrement).to.equal(minIncrement);
      expect(await marketplace.ownerOf(tokenId)).to.equal(await marketplace.getAddress());
      expect(await marketplace.minNextBid(tokenId)).to.equal(startingBid);
    });

    it("places bids and refunds previous bidder", async function () {
      await marketplace.connect(user1).createAuction(tokenId, startingBid, minIncrement, duration);

      // fund and approve user2 and user3
      await ecoToken.transfer(user2.address, startingBid + minIncrement);
      await ecoToken.transfer(user3.address, startingBid + 2n * minIncrement);
      await ecoToken.connect(user2).approve(await marketplace.getAddress(), startingBid + minIncrement);
      await ecoToken.connect(user3).approve(await marketplace.getAddress(), startingBid + 2n * minIncrement);

      const u2Before = await ecoToken.balanceOf(user2.address);
      await expect(marketplace.connect(user2).bid(tokenId, startingBid))
        .to.emit(marketplace, "BidPlaced")
        .withArgs(tokenId, user2.address, startingBid);
      const u2After = await ecoToken.balanceOf(user2.address);
      expect(u2Before - u2After).to.equal(startingBid);

      // Next min bid should be startingBid + minIncrement
      expect(await marketplace.minNextBid(tokenId)).to.equal(startingBid + minIncrement);

      const u2BeforeRefund = await ecoToken.balanceOf(user2.address);
      const u3Before = await ecoToken.balanceOf(user3.address);
      await expect(marketplace.connect(user3).bid(tokenId, startingBid + minIncrement))
        .to.emit(marketplace, "BidRefunded")
        .withArgs(tokenId, user2.address, startingBid)
        .and.to.emit(marketplace, "BidPlaced")
        .withArgs(tokenId, user3.address, startingBid + minIncrement);

      // user2 refunded
      const u2AfterRefund = await ecoToken.balanceOf(user2.address);
      expect(u2AfterRefund - u2BeforeRefund).to.equal(startingBid);

      // user3 funds locked in contract
      const u3After = await ecoToken.balanceOf(user3.address);
      expect(u3Before - u3After).to.equal(startingBid + minIncrement);
    });

    it("cancels auction only by seller and only without bids", async function () {
      await marketplace.connect(user1).createAuction(tokenId, startingBid, minIncrement, duration);
      await expect(marketplace.connect(user2).cancelAuction(tokenId)).to.be.revertedWith("Not seller");

      // place a bid, then cancel should fail
      await ecoToken.transfer(user2.address, startingBid);
      await ecoToken.connect(user2).approve(await marketplace.getAddress(), startingBid);
      await marketplace.connect(user2).bid(tokenId, startingBid);
      await expect(marketplace.connect(user1).cancelAuction(tokenId)).to.be.revertedWith("Already has bids");
    });

    it("cancels auction without bids returns NFT to seller", async function () {
      await marketplace.connect(user1).createAuction(tokenId, startingBid, minIncrement, duration);
      await marketplace.connect(user1).cancelAuction(tokenId);
      expect(await marketplace.ownerOf(tokenId)).to.equal(user1.address);
    });

    it("cannot settle before end", async function () {
      await marketplace.connect(user1).createAuction(tokenId, startingBid, minIncrement, duration);
      await expect(marketplace.settleAuction(tokenId)).to.be.revertedWith("Auction not ended");
    });

    it("settles auction with no bids, returns NFT to seller", async function () {
      await marketplace.connect(user1).createAuction(tokenId, startingBid, minIncrement, duration);
      await ethers.provider.send("evm_increaseTime", [duration + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(marketplace.settleAuction(tokenId))
        .to.emit(marketplace, "AuctionSettled")
        .withArgs(tokenId, ethers.ZeroAddress, user1.address, 0);

      expect(await marketplace.ownerOf(tokenId)).to.equal(user1.address);
    });

    it("settles auction with bids, pays royalty and commission, transfers NFT to winner", async function () {
      await marketplace.connect(user1).createAuction(tokenId, startingBid, minIncrement, duration);

      const bidAmount = startingBid + 2n * minIncrement; // make sure above min
      await ecoToken.transfer(user2.address, bidAmount);
      await ecoToken.connect(user2).approve(await marketplace.getAddress(), bidAmount);
      await marketplace.connect(user2).bid(tokenId, bidAmount);

      const royalty = (bidAmount * 500n) / BPS_DENOM;
      const commission = (bidAmount * COMMISSION_BPS) / BPS_DENOM;
      const sellerNet = bidAmount - royalty - commission;

      const sellerBefore = await ecoToken.balanceOf(user1.address);
      const royaltyBefore = await ecoToken.balanceOf(user3.address);
      const commissionBefore = await ecoToken.balanceOf(owner.address);

      await ethers.provider.send("evm_increaseTime", [duration + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(marketplace.settleAuction(tokenId))
        .to.emit(marketplace, "AuctionSettled")
        .withArgs(tokenId, user2.address, user1.address, bidAmount);

      expect(await marketplace.ownerOf(tokenId)).to.equal(user2.address);
      expect(await ecoToken.balanceOf(user1.address)).to.equal(sellerBefore + sellerNet);
      expect(await ecoToken.balanceOf(user3.address)).to.equal(royaltyBefore + royalty);
      expect(await ecoToken.balanceOf(owner.address)).to.equal(commissionBefore + commission);
    });
  });
});
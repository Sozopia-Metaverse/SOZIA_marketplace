// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/common/ERC2981Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

contract MarketplaceV1_1 is
    ERC721Upgradeable,
    ERC2981Upgradeable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable,
    IERC721Receiver
{
    uint256 private _tokenIdCounter;
    IERC20 public paymentToken;

    mapping(uint256 => string) private _tokenURIs;

    struct Listing {
        address seller;
        uint256 price;
        bool active;
    }

    mapping(uint256 => Listing) public listings;
    uint256 public totalListings;

    // Commission config (upgradeable): 250 = 2.5%
    uint16 public commissionBps;
    address public commissionRecipient;

    event NFTListed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event NFTPurchased(uint256 indexed tokenId, address indexed buyer, address indexed seller, uint256 price);
    event ListingCancelled(uint256 indexed tokenId, address indexed seller);

    event CommissionUpdated(uint16 bps, address recipient);
    event CommissionPaid(uint256 indexed tokenId, address indexed payer, address indexed recipient, uint256 amount);
    event RoyaltyPaid(uint256 indexed tokenId, address indexed payer, address indexed recipient, uint256 amount);

    function initialize(address _paymentToken) external initializer {
        require(_paymentToken != address(0), "Invalid ERC-20 token address");
        paymentToken = IERC20(_paymentToken);

        __ERC721_init("SozoerMetaverseNFT", "SMNFT");
        __ERC2981_init();
        __Ownable_init(msg.sender);
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();

        totalListings = 0;

        // Defaults for fresh deployments of V1_1
        commissionBps = 250; // 2.5%
        commissionRecipient = owner();
        // Default royalty is 0 unless owner sets it via setDefaultRoyalty
    }

    // Reinitializer for proxies upgrading from V1 → V1_1 (commission)
    function initializeV2(address _recipient, uint16 _bps) external reinitializer(2) onlyOwner {
        uint16 bps = _bps == 0 ? 250 : _bps; // default 2.5% if zero passed
        require(bps <= 10_000, "Invalid bps");
        commissionBps = bps;
        commissionRecipient = _recipient == address(0) ? owner() : _recipient;
        emit CommissionUpdated(commissionBps, commissionRecipient);
    }

    // Reinitializer for adding ERC2981 support on upgrade (safe to call once)
    function initializeV3Royalty(address defaultReceiver, uint96 defaultBps) external reinitializer(3) onlyOwner {
        __ERC2981_init();
        if (defaultReceiver != address(0) && defaultBps > 0) {
            _setDefaultRoyalty(defaultReceiver, defaultBps); // defaultBps in basis points, max 10000
        }
    }

    // Commission admin
    function setCommission(uint16 _bps, address _recipient) external onlyOwner {
        require(_bps <= 10_000, "Invalid bps");
        require(_recipient != address(0), "Invalid recipient");
        commissionBps = _bps;
        commissionRecipient = _recipient;
        emit CommissionUpdated(_bps, _recipient);
    }

    // Royalty admin (ERC-2981)
    function setDefaultRoyalty(address receiver, uint96 feeNumerator) external onlyOwner {
        _setDefaultRoyalty(receiver, feeNumerator); // feeNumerator in bps, max 10000
    }

    function deleteDefaultRoyalty() external onlyOwner {
        _deleteDefaultRoyalty();
    }

    function setTokenRoyalty(uint256 tokenId, address receiver, uint96 feeNumerator) external onlyOwner {
        _setTokenRoyalty(tokenId, receiver, feeNumerator);
    }

    function resetTokenRoyalty(uint256 tokenId) external onlyOwner {
        _resetTokenRoyalty(tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure override returns (bytes4) {
        return this.onERC721Received.selector;
    }

    function mint(address to, string memory metadataURI) external onlyOwner returns (uint256) {
        require(to != address(0), "Invalid recipient address");
        require(bytes(metadataURI).length > 0, "Token URI cannot be empty");
        uint256 tokenId = _tokenIdCounter;
        _tokenIdCounter += 1;
        _safeMint(to, tokenId);
        _tokenURIs[tokenId] = metadataURI;
        return tokenId;
    }

    function listNFT(uint256 tokenId, uint256 price) external nonReentrant {
        require(ownerOf(tokenId) == msg.sender, "Not token owner");
        require(price > 0, "Price must be greater than zero");
        require(!listings[tokenId].active, "NFT already listed");

        _transfer(msg.sender, address(this), tokenId);

        listings[tokenId] = Listing({ seller: msg.sender, price: price, active: true });
        totalListings += 1;

        emit NFTListed(tokenId, msg.sender, price);
    }

    function buyNFT(uint256 tokenId) external nonReentrant {
        Listing memory listing = listings[tokenId];
        require(listing.active, "NFT not listed for sale");
        require(paymentToken.allowance(msg.sender, address(this)) >= listing.price, "Insufficient ERC-20 allowance");
        require(paymentToken.balanceOf(msg.sender) >= listing.price, "Insufficient ERC-20 balance");

        delete listings[tokenId];
        totalListings -= 1;

        // Compute commission and royalty
        uint256 fee = (listing.price * commissionBps) / 10_000;
        (address royaltyReceiver, uint256 royaltyAmount) = royaltyInfo(tokenId, listing.price);

        require(fee + royaltyAmount <= listing.price, "Fees exceed price");
        uint256 sellerAmount = listing.price - fee - royaltyAmount;

        // Pay royalty (if any)
        if (royaltyAmount > 0 && royaltyReceiver != address(0)) {
            paymentToken.transferFrom(msg.sender, royaltyReceiver, royaltyAmount);
            emit RoyaltyPaid(tokenId, msg.sender, royaltyReceiver, royaltyAmount);
        }

        // Pay commission (if any)
        if (fee > 0) {
            paymentToken.transferFrom(msg.sender, commissionRecipient, fee);
            emit CommissionPaid(tokenId, msg.sender, commissionRecipient, fee);
        }

        // Pay seller
        paymentToken.transferFrom(msg.sender, listing.seller, sellerAmount);

        // Transfer NFT to buyer
        _transfer(address(this), msg.sender, tokenId);

        emit NFTPurchased(tokenId, msg.sender, listing.seller, listing.price);
    }

    function cancelListing(uint256 tokenId) external nonReentrant {
        Listing memory listing = listings[tokenId];
        require(listing.active, "NFT not listed");
        require(listing.seller == msg.sender, "Not seller");

        delete listings[tokenId];
        totalListings -= 1;

        _transfer(address(this), msg.sender, tokenId);

        emit ListingCancelled(tokenId, msg.sender);
    }

    function tokenURI(uint256 tokenId) public view virtual override returns (string memory) {
        return _tokenURIs[tokenId];
    }

    function totalSupply() external view returns (uint256) {
        return _tokenIdCounter;
    }

    function getTotalListings() external view returns (uint256) {
        return totalListings;
    }

    // Required override for interface support
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721Upgradeable, ERC2981Upgradeable)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
    struct Auction {
		address seller;
		uint64 endTime;
		uint256 startingBid;
		uint256 minIncrement;
		address highestBidder;
		uint256 highestBid;
		bool active;
		bool settled;
	}


    mapping(uint256 => Auction) public auctions;

    uint256 public totalAuctionsActive;

        event AuctionCreated(
		uint256 indexed tokenId,
		address indexed seller,
		uint256 startingBid,
		uint256 minIncrement,
		uint64 endTime
	);
	event BidPlaced(uint256 indexed tokenId, address indexed bidder, uint256 amount);
	event BidRefunded(uint256 indexed tokenId, address indexed bidder, uint256 amount);
	event AuctionCancelled(uint256 indexed tokenId, address indexed seller);
	event AuctionSettled(
		uint256 indexed tokenId,
		address indexed winner,
		address indexed seller,
		uint256 finalPrice
	);

    function createAuction(
		uint256 tokenId,
		uint256 startingBid,
		uint256 minIncrement,
		uint64 duration
	) external nonReentrant {
		require(ownerOf(tokenId) == msg.sender, "Not token owner");
		require(!listings[tokenId].active, "Already listed");
		require(!auctions[tokenId].active, "Auction exists");
		require(duration > 0, "Invalid duration");

		_transfer(msg.sender, address(this), tokenId);

		uint64 endTime = uint64(block.timestamp) + duration;
		auctions[tokenId] = Auction({
			seller: msg.sender,
			endTime: endTime,
			startingBid: startingBid,
			minIncrement: minIncrement,
			highestBidder: address(0),
			highestBid: 0,
			active: true,
			settled: false
		});
		totalAuctionsActive += 1;

		emit AuctionCreated(tokenId, msg.sender, startingBid, minIncrement, endTime);
	}

    function minNextBid(uint256 tokenId) public view returns (uint256) {
		Auction memory a = auctions[tokenId];
		require(a.active, "No auction");
		if (a.highestBid == 0) {
			return a.startingBid;
		}
		return a.highestBid + a.minIncrement;
	}

    function bid(uint256 tokenId, uint256 amount) external nonReentrant {
		Auction storage a = auctions[tokenId];
		require(a.active, "No auction");
		require(block.timestamp < a.endTime, "Auction ended");
		uint256 requiredMin = a.highestBid == 0 ? a.startingBid : a.highestBid + a.minIncrement;
		require(amount >= requiredMin, "Bid too low");

		require(paymentToken.allowance(msg.sender, address(this)) >= amount, "Insufficient allowance");
		require(paymentToken.balanceOf(msg.sender) >= amount, "Insufficient balance");
		paymentToken.transferFrom(msg.sender, address(this), amount);

		if (a.highestBidder != address(0)) {
			address prevBidder = a.highestBidder;
			uint256 prevAmount = a.highestBid;
			a.highestBidder = msg.sender;
			a.highestBid = amount;
			paymentToken.transfer(prevBidder, prevAmount);
			emit BidRefunded(tokenId, prevBidder, prevAmount);
		} else {
			a.highestBidder = msg.sender;
			a.highestBid = amount;
		}

		emit BidPlaced(tokenId, msg.sender, amount);
	}

    function cancelAuction(uint256 tokenId) external nonReentrant {
		Auction memory a = auctions[tokenId];
		require(a.active, "No auction");
		require(a.seller == msg.sender, "Not seller");
		require(a.highestBid == 0, "Already has bids");

		delete auctions[tokenId];
		totalAuctionsActive -= 1;

		_transfer(address(this), msg.sender, tokenId);

		emit AuctionCancelled(tokenId, msg.sender);
	}

    function settleAuction(uint256 tokenId) external nonReentrant {
		Auction memory a = auctions[tokenId];
		require(a.active, "No auction");
		require(block.timestamp >= a.endTime, "Auction not ended");

		delete auctions[tokenId];
		totalAuctionsActive -= 1;

		if (a.highestBidder == address(0)) {
			_transfer(address(this), a.seller, tokenId);
			emit AuctionSettled(tokenId, address(0), a.seller, 0);
			return;
		}

		uint256 salePrice = a.highestBid;

		uint256 fee = (salePrice * commissionBps) / 10_000;
		(address royaltyReceiver, uint256 royaltyAmount) = royaltyInfo(tokenId, salePrice);
		require(fee + royaltyAmount <= salePrice, "Fees exceed price");
		uint256 sellerAmount = salePrice - fee - royaltyAmount;

		if (royaltyAmount > 0 && royaltyReceiver != address(0)) {
			paymentToken.transfer(royaltyReceiver, royaltyAmount);
			emit RoyaltyPaid(tokenId, a.highestBidder, royaltyReceiver, royaltyAmount);
		}

		if (fee > 0) {
			paymentToken.transfer(commissionRecipient, fee);
			emit CommissionPaid(tokenId, a.highestBidder, commissionRecipient, fee);
		}

		paymentToken.transfer(a.seller, sellerAmount);

		_transfer(address(this), a.highestBidder, tokenId);

		emit AuctionSettled(tokenId, a.highestBidder, a.seller, salePrice);
	}


}
const Product = require('../models/Product');
const Order = require('../models/Order');
const ProductReview = require('../models/ProductReview');

// Create or update a product review — only allowed if user purchased the product (delivered/completed)
exports.createOrUpdateReview = async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ message: 'Auth required' });

    const { productId, slug, rating, comment } = req.body || {};
    if (!productId && !slug) return res.status(400).json({ message: 'productId or slug is required' });
    const prod = productId ? await Product.findById(productId) : await Product.findOne({ slug });
    if (!prod) return res.status(404).json({ message: 'Product not found' });

    const pid = prod._id;

    const r = Number(rating);
    if (!r || r < 1 || r > 5) return res.status(400).json({ message: 'rating must be an integer between 1 and 5' });

    // Verify user has at least one completed/delivered order containing this product
    const hasPurchased = await Order.exists({ userId: user._id, orderStatus: { $in: ['delivered','completed'] }, 'items.productId': pid });
    if (!hasPurchased) {
      return res.status(403).json({ message: 'You can only review products you have purchased and received' });
    }

    // If user already reviewed, update; otherwise create
    let review = await ProductReview.findOne({ productId: pid, userId: user._id });
    if (review) {
      review.rating = r;
      review.comment = comment || review.comment;
      await review.save();
      return res.json({ message: 'Review updated', review });
    }

    review = new ProductReview({ productId: pid, userId: user._id, rating: r, comment });
    await review.save();
    return res.status(201).json({ message: 'Review created', review });
  } catch (err) {
    console.error('createOrUpdateReview error', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get reviews for a product by slug
exports.getReviewsBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const PAGE = Math.max(1, parseInt(page));
    const LIMIT = Math.min(50, Math.max(1, parseInt(limit)));

    const prod = await Product.findOne({ slug });
    if (!prod) return res.status(404).json({ message: 'Product not found' });

    const total = await ProductReview.countDocuments({ productId: prod._id });
    const reviews = await ProductReview.find({ productId: prod._id })
      .sort({ createdAt: -1 })
      .skip((PAGE - 1) * LIMIT)
      .limit(LIMIT)
      .populate('userId', 'firstName lastName avatar')
      .populate('adminReply.adminId', 'firstName lastName avatar');

    return res.json({ productId: prod._id, total, page: PAGE, perPage: LIMIT, reviews });
  } catch (err) {
    console.error('getReviewsBySlug error', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get all reviews (admin) with pagination and optional filters
exports.getAllReviews = async (req, res) => {
  try {
    const { page = 1, limit = 20, productId, userId, minRating, maxRating, sort = '-createdAt' } = req.query;
    const PAGE = Math.max(1, parseInt(page));
    const LIMIT = Math.min(200, Math.max(1, parseInt(limit)));

    const filter = {};
    if (productId) filter.productId = productId;
    if (userId) filter.userId = userId;
    if (minRating || maxRating) filter.rating = {};
    if (minRating) filter.rating.$gte = Number(minRating);
    if (maxRating) filter.rating.$lte = Number(maxRating);

    const total = await ProductReview.countDocuments(filter);
    const reviews = await ProductReview.find(filter)
      .sort(sort)
      .skip((PAGE - 1) * LIMIT)
      .limit(LIMIT)
      .populate('userId', 'firstName lastName email avatar')
      .populate('productId', 'name slug')
      .populate('adminReply.adminId', 'firstName lastName email avatar')
      .lean();

    return res.json({ total, page: PAGE, perPage: LIMIT, reviews });
  } catch (err) {
    console.error('getAllReviews error', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Delete review by id (owner or admin)
exports.deleteReview = async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ message: 'Auth required' });

    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'review id required' });

    const review = await ProductReview.findById(id);
    if (!review) return res.status(404).json({ message: 'Review not found' });

    const isOwner = String(review.userId) === String(user._id);
    const isAdmin = user.role === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ message: 'Not allowed' });

    await review.remove();

    // After removal, recompute product rating
    const reviews = await ProductReview.find({ productId: review.productId });
    if (reviews.length === 0) {
      await Product.findByIdAndUpdate(review.productId, { $set: { 'rating.average': 0, 'rating.count': 0 } });
    } else {
      const avg = reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length;
      await Product.findByIdAndUpdate(review.productId, { $set: { 'rating.average': avg, 'rating.count': reviews.length } });
    }

    return res.json({ message: 'Review deleted' });
  } catch (err) {
    console.error('deleteReview error', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Admin reply to a review (create or update reply)
exports.replyToReview = async (req, res) => {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ message: 'Auth required' });
    if (user.role !== 'admin') return res.status(403).json({ message: 'Admin only' });

    const { id } = req.params;
    const { message } = req.body || {};
    if (!id) return res.status(400).json({ message: 'review id required' });
    if (!message) return res.status(400).json({ message: 'message is required' });

    const review = await ProductReview.findById(id);
    if (!review) return res.status(404).json({ message: 'Review not found' });

    review.adminReply = { adminId: user._id, message, repliedAt: new Date() };
    await review.save();

    const populated = await ProductReview.findById(id)
      .populate('userId', 'firstName lastName avatar')
      .populate('productId', 'name slug')
      .populate('adminReply.adminId', 'firstName lastName avatar')
      .lean();

    return res.json({ message: 'Reply saved', review: populated });
  } catch (err) {
    console.error('replyToReview error', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// Get latest reviews from 5 most recent distinct customers across the site
exports.getLatestFiveCustomerReviews = async (req, res) => {
  try {
    // Fetch recent reviews sorted by creation time
    const recentReviews = await ProductReview.find()
      .sort({ createdAt: -1 })
      .limit(50) // fetch a buffer to find 5 distinct users
      .populate('userId', 'firstName lastName avatar')
      .populate('productId', 'name slug')
      .populate('adminReply.adminId', 'firstName lastName avatar')
      .lean();

    const usersSeen = new Set();
    const result = [];

    for (const r of recentReviews) {
      const uid = String(r.userId?._id || r.userId);
      if (!uid) continue;
      if (usersSeen.has(uid)) continue;
      usersSeen.add(uid);
      result.push({
        _id: r._id,
        product: r.productId || null,
        user: r.userId || null,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
        adminReply: r.adminReply ? {
          message: r.adminReply.message || null,
          repliedAt: r.adminReply.repliedAt || null,
          admin: r.adminReply.adminId ? {
            _id: r.adminReply.adminId._id || r.adminReply.adminId,
            firstName: r.adminReply.adminId.firstName,
            lastName: r.adminReply.adminId.lastName,
            avatar: r.adminReply.adminId.avatar
          } : null
        } : null
      });
      if (result.length >= 5) break;
    }

    return res.json({ count: result.length, reviews: result });
  } catch (err) {
    console.error('getLatestFiveCustomerReviews error', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

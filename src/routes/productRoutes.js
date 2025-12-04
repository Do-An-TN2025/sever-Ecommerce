const express = require("express");
const router = express.Router();
const productController = require("../controllers/productController");
const { authMiddleware, staffOrAdmin , adminOnly } = require("../middlewares/authMiddleware");
const reviewController = require('../controllers/reviewController');

router.get("/", productController.getAllProducts);
router.get("/default-variant", productController.getAllProductsWithDefaultVariant);
router.get("/all", productController.getAllProductsFiltered);
router.get("/search", productController.searchProducts);
router.get("/best-sellers", productController.getBestSellers);
router.get("/new", productController.getNewProducts);
router.get("/details/:slug", productController.getProductDetailsBySlug);
router.get("/details/:slug/reviews", reviewController.getReviewsBySlug);
router.get('/reviews/recent-customers', reviewController.getLatestFiveCustomerReviews);


// Admin: list all reviews with filters/pagination
router.get('/reviews', reviewController.getAllReviews);

// create or update review (auth)
router.post('/:productId/reviews', authMiddleware, reviewController.createOrUpdateReview);

// delete review (owner or admin)
router.delete('/reviews/:id', authMiddleware, reviewController.deleteReview);
// admin reply to a review
router.put('/reviews/:id/reply', authMiddleware, adminOnly, reviewController.replyToReview);
router.post("/recently-viewed", productController.getRecentlyViewedProducts);
router.get("/:slug", productController.getProductBySlugCategory);
router.get("/variant/details", productController.getVariantDetails);

// Staff/Admin
router.post("/add-product", authMiddleware, adminOnly, productController.createProduct);
router.put("/:id", authMiddleware, adminOnly, productController.updateProduct);
router.delete("/:id", authMiddleware, adminOnly, productController.deleteProduct);

// Public
router.get("/ml-recommend", productController.mlRecommend);

module.exports = router;

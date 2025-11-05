const express = require("express");
const router = express.Router();
const productController = require("../controllers/productController");
const { authMiddleware, staffOrAdmin , adminOnly } = require("../middlewares/authMiddleware");

router.get("/", productController.getAllProducts);
router.get("/default-variant", productController.getAllProductsWithDefaultVariant);
router.get("/search", productController.searchProducts);
router.get("/details/:slug", productController.getProductDetailsBySlug);
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

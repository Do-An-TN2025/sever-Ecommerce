const express = require("express");
const router = express.Router();
const productController = require("../controllers/productController");
const { authMiddleware, staffOrAdmin } = require("../middlewares/authMiddleware");

router.get("/", productController.getAllProducts);
router.get("/default-variant", productController.getAllProductsWithDefaultVariant);
router.get("/search", productController.searchProducts);
router.get("/details/:slug", productController.getProductDetailsBySlug);
router.get("/:slug", productController.getProductBySlugCategory);
router.get("/variant/details", productController.getVariantDetails);

// Staff/Admin
router.post("/add-product", authMiddleware, staffOrAdmin, productController.createProduct);
router.put("/:id", authMiddleware, staffOrAdmin, productController.updateProduct);
router.delete("/:id", authMiddleware, staffOrAdmin, productController.deleteProduct);

// Public
router.get("/ml-recommend", productController.mlRecommend);

module.exports = router;

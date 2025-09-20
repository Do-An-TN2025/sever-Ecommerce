const express = require("express");
const router = express.Router();
const upload = require("../middlewares/upload");
const { createVariant, getProductWithVariants} = require("../controllers/variantController");

router.get("/product/:productId", getProductWithVariants);
router.post("/add-variant", upload.array("images", 5), createVariant);

module.exports = router;
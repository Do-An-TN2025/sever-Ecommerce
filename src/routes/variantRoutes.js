const express = require("express");
const router = express.Router();
const upload = require("../middlewares/upload");
const { createVariant, getAllVariantsByProduct} = require("../controllers/variantController");

router.post("/add-variant", upload.array("images", 5), createVariant);
router.get("/product/:productId", getAllVariantsByProduct);
module.exports = router;
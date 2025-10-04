const express = require("express");
const router = express.Router();
const upload = require("../middlewares/upload");

const {
  createVariant,
  addSizeToVariant,
  updateSizeInVariant,
  removeSizeFromVariant,
  updateVariantImages,
  updateVariant
} = require("../controllers/variantController");

router.post("/add-variant", upload.array("images", 5), createVariant);

router.put("/update-variant/:variantId" , upload.array("images", 10) , updateVariant );

router.post("/:variantId/sizes", addSizeToVariant);

router.put("/:variantId/sizes/:sizeId", updateSizeInVariant);

router.delete("/:variantId/sizes/:sizeId", removeSizeFromVariant);

router.put(
  "/:variantId/images",
  upload.array("images", 5),
  updateVariantImages
);

module.exports = router;

const express = require("express");
const router = express.Router();
const upload = require("../middlewares/upload");
const { createVariant } = require("../controllers/variantController");
const { authMiddleware, staffOrAdmin } = require("../middlewares/authMiddleware");

router.post("/add-variant", upload.array("images", 5),authMiddleware, staffOrAdmin, createVariant);

module.exports = router;
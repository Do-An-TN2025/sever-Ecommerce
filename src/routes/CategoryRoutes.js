const express = require("express");
const router = express.Router();
const categoryController = require("../controllers/categoryController");
const { authMiddleware, adminOnly } = require("../middlewares/authMiddleware");

router.get("/", categoryController.getCategories);
router.get("/:slug", categoryController.getCategoryBySlug);


router.post("/add-categories", authMiddleware, adminOnly, categoryController.createCategory);
router.put("/:slug", authMiddleware, adminOnly, categoryController.updateCategory);
router.delete("/:slug", authMiddleware, adminOnly, categoryController.deleteCategory);

module.exports = router;

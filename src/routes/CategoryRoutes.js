const express = require("express");
const router = express.Router();
const categoryController = require("../controllers/categoryController");

const { authMiddleware, adminOnly } = require("../middlewares/authMiddleware");



router.get("/", categoryController.getAllCategories);
router.get("/:id", categoryController.getCategoryById);

router.post("/add", authMiddleware, adminOnly,categoryController.createCategory);

router.put("/:id",authMiddleware, adminOnly, categoryController.updateCategory);
router.delete("/:id",authMiddleware, adminOnly, categoryController.deleteCategory);

module.exports = router;

const express = require("express");
const router = express.Router();
const {
  createOrder,
  getMyOrders,
  getOrderById,
  handlePayOSWebhook
} = require("../controllers/orderController");
const { authMiddleware } = require("../middlewares/authMiddleware");


router.post("/create-orders",  createOrder);
router.get("/", getMyOrders);
router.get("/:id", authMiddleware, getOrderById);

router.post("/payos/webhook", handlePayOSWebhook);

module.exports = router;
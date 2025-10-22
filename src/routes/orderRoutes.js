const express = require("express");
const router = express.Router();
const {
  createOrder,
  getMyOrders,
  getOrderById,
  handlePayOSWebhook,
  checkPaymentStatus,
  cancelOrder
} = require("../controllers/orderController");
const { authMiddleware , authOptional } = require("../middlewares/authMiddleware");


router.post("/create-orders", authOptional, createOrder);
router.post("/payos/webhook", handlePayOSWebhook);

router.get("/",authMiddleware,getMyOrders);
router.get("/:id", authMiddleware, getOrderById);

router.get('/payment-status/:orderCode', checkPaymentStatus);
router.post('/:id/cancel', cancelOrder);

module.exports = router;
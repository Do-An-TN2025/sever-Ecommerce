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
const { authMiddleware } = require("../middlewares/authMiddleware");


router.post("/create-orders",  createOrder);
router.post("/payos/webhook", handlePayOSWebhook);
router.get("/",authMiddleware,getMyOrders);
router.get("/:id", authMiddleware, getOrderById);

router.get('/payment-status/:orderCode', authMiddleware, checkPaymentStatus);
router.post('/:id/cancel', authMiddleware, cancelOrder);

module.exports = router;
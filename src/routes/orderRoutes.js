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
router.get("/",authMiddleware,getMyOrders);
router.get("/:id", authMiddleware, getOrderById);

router.post("/payos/webhook", handlePayOSWebhook);

router.get('/payment-status/:orderCode', authMiddleware, checkPaymentStatus);
router.post('/:id/cancel', authMiddleware, cancelOrder);

module.exports = router;
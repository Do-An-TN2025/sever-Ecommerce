const express = require("express");
const router = express.Router();
const {
  createOrder,
  getMyOrders,
  getOrderById,
  handlePayOSWebhook,
  checkPaymentStatus,
  cancelOrder,
  getOrdersAdmin,
  updateOrderStatus
} = require("../controllers/orderController");
const { authMiddleware , authOptional , adminOnly } = require("../middlewares/authMiddleware");


router.post("/create-orders", authOptional, createOrder);
router.post("/payos/webhook", handlePayOSWebhook);



//admin routes 
router.get("/admin", authMiddleware , adminOnly , getOrdersAdmin);
router.patch("/admin/:id/status", authMiddleware, adminOnly, updateOrderStatus);

router.get("/",authMiddleware,getMyOrders);
router.get("/:id", authMiddleware, getOrderById);

router.get('/payment-status/:orderCode', checkPaymentStatus);
router.post('/:id/cancel', cancelOrder);



module.exports = router;
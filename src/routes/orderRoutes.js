const express = require("express");
const router = express.Router();
const {
  createOrder,
  getMyOrders,
  getOrderById,
  getOrderByCode,
  handlePayOSWebhook,
  checkPaymentStatus,
  cancelOrder,
  getOrdersAdmin,
  updateOrderStatus
} = require("../controllers/orderController");
const { authMiddleware , authOptional , adminOnly } = require("../middlewares/authMiddleware");
const statisController = require('../controllers/statisController');

router.post("/create-orders", authOptional, createOrder);

router.post("/payos/webhook", handlePayOSWebhook);



//admin routes 
router.get("/admin", authMiddleware , adminOnly , getOrdersAdmin);
router.patch("/admin/:id/status", authMiddleware, adminOnly, updateOrderStatus);
router.get('/stats/overview', authMiddleware , adminOnly, statisController.getAdminStats);
router.get('/stats/sales', authMiddleware , adminOnly, statisController.getSalesByPeriod);
router.get('/stats/top-products', authMiddleware , adminOnly, statisController.getTopProducts);

router.get("/",authMiddleware,getMyOrders);
router.get("/code/:orderCode", getOrderByCode);
router.get("/:id", getOrderById);

router.get('/payment-status/:orderCode', checkPaymentStatus);
router.post('/:id/cancel', cancelOrder);



module.exports = router;
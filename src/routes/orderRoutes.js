const express = require("express");
const router = express.Router();
const {
  createOrder,
  getMyOrders,
  getOrderById,
  getOrderByCode,
  getOrderInvoice,
  handlePayOSWebhook,
  checkPaymentStatus,
  cancelOrder,
  requestOrderCancellation,
  getOrdersAdmin,
  updateOrderStatus
} = require("../controllers/orderController");
const { authMiddleware , authOptional , adminOnly } = require("../middlewares/authMiddleware");
const statisController = require('../controllers/statisController');

router.post("/create-orders", authOptional, createOrder);

router.post("/payos/webhook", handlePayOSWebhook);

router.get('/invoice', authOptional, getOrderInvoice);


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



router.post('/:id/report', authMiddleware, requestOrderCancellation);
// admin: reports
const { getOrderReportsAdmin, approveOrderReport } = require('../controllers/orderController');
router.get('/admin/reports', authMiddleware, adminOnly, getOrderReportsAdmin);
router.patch('/admin/reports/:id/approve', authMiddleware, adminOnly, approveOrderReport);



module.exports = router;
const express = require('express');
const router = express.Router();
const statisController = require('../controllers/statisController');
const { authMiddleware, adminOnly } = require('../middlewares/authMiddleware');

// All routes here require authentication and admin role
router.use(authMiddleware, adminOnly);

// GET /api/admin/stats/overview
router.get('/overview', statisController.getAdminStats);

// GET /api/admin/stats/sales
router.get('/sales', statisController.getSalesByPeriod);

router.get('/top-products', statisController.getTopProducts);

// GET /api/admin/stats/slow-products
router.get('/slow-products', statisController.getSlowestProducts);

// GET /api/admin/stats/top-customers
router.get('/top-customers', statisController.getTopCustomers);
// GET /api/admin/stats/forecast?period=day&limit=1
router.get('/forecast', statisController.getRevenueForecast);

// GET /api/admin/stats/export-excel
router.get('/export-excel', statisController.exportStatsExcel);

module.exports = router;

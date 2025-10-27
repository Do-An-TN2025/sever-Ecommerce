const express = require('express');
const router = express.Router();
const voucherCtrl = require('../controllers/voucherController');
const {authMiddleware , adminOnly} = require("../middlewares/authMiddleware");

router.post('/apply', authMiddleware , voucherCtrl.applyVoucher);
router.post('/redeem', authMiddleware, voucherCtrl.redeemVoucher);
router.get('/my', authMiddleware, voucherCtrl.getUserVouchers);

router.post('/', authMiddleware, adminOnly, voucherCtrl.createVoucher);
router.get('/', authMiddleware, adminOnly, voucherCtrl.getAllVouchers);
router.put('/:id', authMiddleware, adminOnly, voucherCtrl.updateVoucher);
router.delete('/:id', authMiddleware, adminOnly, voucherCtrl.deleteVoucher);

module.exports = router;    
const express = require('express');
const router = express.Router();
const voucherCtrl = require('../controllers/VoucherController');
const {authMiddleware , adminOnly} = require("../middlewares/authMiddleware");

router.post('/apply', authMiddleware , voucherCtrl.applyVoucher);
router.post('/redeem', authMiddleware, voucherCtrl.redeemVoucher);// gọi khi order thành công


router.post('/', authMiddleware, adminOnly, voucherCtrl.createVoucher);

module.exports = router;
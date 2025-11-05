const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/cartController');
const { authMiddleware } = require('../middlewares/authMiddleware');

router.get('/', authMiddleware , ctrl.getCart);
router.post('/add', authMiddleware , ctrl.addItem);
router.patch('/item/:itemId', authMiddleware , ctrl.updateItem);
router.patch('/item/:itemId/decrement', authMiddleware , ctrl.decrementItem);
router.delete('/item/:itemId', authMiddleware , ctrl.removeItem);
router.delete('/clear', authMiddleware , ctrl.clearCart);


router.post('/merge',authMiddleware ,ctrl.mergeCart);



module.exports = router;
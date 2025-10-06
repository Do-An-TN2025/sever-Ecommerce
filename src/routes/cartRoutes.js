const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/cartController');
const { authMiddleware } = require('../middlewares/authMiddleware');

router.get('/', ctrl.getCart);
router.post('/add', ctrl.addItem);
router.patch('/item/:itemId', ctrl.updateItem);
router.delete('/item/:itemId', ctrl.removeItem);
router.delete('/clear', ctrl.clearCart);


router.post('/merge',authMiddleware ,ctrl.mergeCart);



module.exports = router;
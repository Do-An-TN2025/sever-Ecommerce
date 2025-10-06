const express = require('express');
const router = express.Router();
const { chatSearch } = require('../controllers/chatController');

router.post('/search', chatSearch);

module.exports = router;
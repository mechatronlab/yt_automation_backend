const express = require('express');
const router = express.Router();
const { googleLogin, connectGoogleAccount } = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');

router.post('/google', googleLogin);
router.post('/google/connect', protect, connectGoogleAccount);

module.exports = router;

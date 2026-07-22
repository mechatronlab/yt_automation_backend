const express = require('express');
const router = express.Router();
const {
  googleLogin,
  connectGoogleAccount,
  startGoogleOAuthLogin,
  startGoogleOAuthConnect,
  oauthCallback,
} = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');

router.post('/google', googleLogin);
router.get('/google/login', startGoogleOAuthLogin);
router.get('/google/connect/start', startGoogleOAuthConnect);
router.post('/google/connect', protect, connectGoogleAccount);
router.get('/google/oauth-callback', oauthCallback);

module.exports = router;

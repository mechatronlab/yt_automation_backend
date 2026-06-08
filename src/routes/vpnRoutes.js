const express = require('express');
const router = express.Router();
const {
  getAssignedConfigs,
  connectVpn,
  disconnectVpn,
  getVpnStatus,
} = require('../controllers/vpnController');
const { protect } = require('../middlewares/authMiddleware');

// All routes are protected
router.get('/configs/assigned', protect, getAssignedConfigs);
router.post('/connect/:googleAccountId', protect, connectVpn);
router.post('/disconnect', protect, disconnectVpn);
router.get('/status', protect, getVpnStatus);

module.exports = router;

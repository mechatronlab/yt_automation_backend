const express = require('express');
const router = express.Router();
const {
  getAssignedConfigs,
  connectVpn,
  disconnectVpn,
  getVpnStatus,
  preConnectVpn,
  getPoolConfigs,
} = require('../controllers/vpnController');
const { protect } = require('../middlewares/authMiddleware');
const { blockOnCloud } = require('../middlewares/cloudRuntimeMiddleware');

// All routes are protected
router.get('/configs/assigned', protect, getAssignedConfigs);
router.post('/connect/:googleAccountId', protect, blockOnCloud('VPN'), connectVpn);
router.post('/disconnect', protect, blockOnCloud('VPN'), disconnectVpn);
router.get('/status', protect, getVpnStatus);
router.post('/pre-connect', protect, blockOnCloud('VPN'), preConnectVpn);
router.get('/configs/pool', protect, getPoolConfigs);

module.exports = router;

'use strict';

/**
 * pythonScriptRoutes.js
 *
 * Routes for the Google Account creation Python script.
 * All routes are JWT-protected.
 *
 * POST /api/python-script/run      — Run the script (SSE stream)
 * GET  /api/python-script/status   — Check if running
 * POST /api/python-script/stop     — Stop running script
 * GET  /api/python-script/config   — Get config values
 * POST /api/python-script/config   — Update config values
 * GET  /api/python-script/logs     — Get recent output logs
 */

const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const {
  runScript,
  getScriptStatus,
  stopScript,
  getConfig,
  updateConfig,
  getLogs,
  registerAccount,
} = require('../controllers/pythonScriptController');

const { blockOnCloud } = require('../middlewares/cloudRuntimeMiddleware');

router.post('/run', protect, blockOnCloud('Create Account script'), runScript);
router.get('/status', protect, getScriptStatus);
router.post('/stop', protect, blockOnCloud('Create Account script'), stopScript);
router.get('/config', protect, getConfig);
router.post('/config', protect, updateConfig);
router.get('/logs', protect, getLogs);
router.post('/register-account', protect, registerAccount);

module.exports = router;

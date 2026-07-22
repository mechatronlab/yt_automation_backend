'use strict';

/**
 * puppeteerRoutes.js
 *
 * All routes are protected by JWT middleware (same as the rest of the API).
 *
 * POST   /api/browser/launch/:googleAccountId   — Launch/reuse browser
 * GET    /api/browser/status                    — List open sessions
 * GET    /api/browser/tasks                     — List available task names
 * POST   /api/browser/run-task/:googleAccountId — Run a named task
 * POST   /api/browser/close/:googleAccountId    — Close one session
 * POST   /api/browser/close-all                 — Close all sessions
 */

const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const { blockOnCloud } = require('../middlewares/cloudRuntimeMiddleware');
const {
  launchBrowser,
  getStatus,
  closeBrowser,
  closeAllBrowsers,
  runTask,
  listTasks,
} = require('../controllers/puppeteerController');

router.post('/launch/:googleAccountId', protect, blockOnCloud('Browser automation'), launchBrowser);
router.get('/status', protect, getStatus);
router.get('/tasks', protect, listTasks);
router.post('/run-task/:googleAccountId', protect, blockOnCloud('Browser automation'), runTask);
router.post('/close/:googleAccountId', protect, blockOnCloud('Browser automation'), closeBrowser);
router.post('/close-all', protect, blockOnCloud('Browser automation'), closeAllBrowsers);

module.exports = router;

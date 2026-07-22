'use strict';

/**
 * puppeteerController.js
 *
 * REST handlers for managing Puppeteer browser sessions per Google account.
 * All routes are JWT-protected (see puppeteerRoutes.js).
 *
 * Routes mounted at /api/browser:
 *   POST   /launch/:googleAccountId   — Launch (or reuse) a browser for an account
 *   GET    /status                    — List all open browser sessions
 *   POST   /close/:googleAccountId    — Close one session + disconnect its VPN
 *   POST   /close-all                 — Close all sessions + disconnect all VPNs
 *   POST   /run-task/:googleAccountId — Run a named task inside an account's browser
 */

const GoogleAccount = require('../models/GoogleAccount');
const VpnProfile = require('../models/VpnProfile');
const puppeteerService = require('../services/puppeteerService');

// ─── Built-in task registry ───────────────────────────────────────────────────
//
// Each task receives (page, account) and must return a plain-object result.
// Add new tasks here without touching the controller logic.

const TASK_REGISTRY = {
  /**
   * Navigates to ipify and returns the current public IP seen by the browser.
   * Useful to verify the correct VPN tunnel is active.
   */
  'get-current-ip': async (page) => {
    await page.goto('https://api.ipify.org?format=json', { waitUntil: 'networkidle2', timeout: 15000 });
    const body = await page.evaluate(() => document.body.innerText);
    return JSON.parse(body);
  },

  /**
   * Checks whether the account is currently logged in to YouTube.
   * Returns { loggedIn, channelName | null }.
   */
  'youtube-login-check': async (page) => {
    await page.goto('https://www.youtube.com', { waitUntil: 'networkidle2', timeout: 20000 });

    // Look for the avatar button — only visible when signed in
    const avatarExists = (await page.$('#avatar-btn')) !== null;

    let channelName = null;
    if (avatarExists) {
      try {
        // The channel name lives in the "aria-label" of the button
        channelName = await page.$eval('#avatar-btn', (el) => el.getAttribute('aria-label'));
      } catch {
        channelName = 'Unknown (signed in)';
      }
    }

    return { loggedIn: avatarExists, channelName };
  },

  /**
   * Opens YouTube Studio and captures basic channel analytics visible on the dashboard.
   */
  'youtube-studio-snapshot': async (page) => {
    await page.goto('https://studio.youtube.com', { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait briefly for dashboard cards to render
    await new Promise((r) => setTimeout(r, 3000));

    const url = page.url();
    const title = await page.title();

    return {
      finalUrl: url,
      pageTitle: title,
      note: 'Open browser_sessions/{accountId} screenshots manually for visual inspection.',
    };
  },

  /**
   * Takes a full-page screenshot and saves it to the account's session directory.
   * Returns the file path.
   */
  'screenshot': async (page, account) => {
    const sessionDir = puppeteerService.getSessionDir(account._id.toString());
    const screenshotPath = require('path').join(sessionDir, `screenshot_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return { screenshotPath };
  },
};

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Fetches the GoogleAccount and its VpnProfile for the authenticated user.
 * Throws with a 404 if the account doesn't belong to the user.
 */
const resolveAccountAndVpn = async (googleAccountId, userId) => {
  const account = await GoogleAccount.findOne({
    _id: googleAccountId,
    user: userId,
  });

  if (!account) {
    const err = new Error('Google account not found or does not belong to this user.');
    err.statusCode = 404;
    throw err;
  }

  const vpnProfile = await VpnProfile.findOne({ googleAccount: account._id });

  return { account, vpnProfile };
};

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * @desc    Launch (or reuse) a browser session for a Google account.
 *          Connects the account's VPN first if one is assigned.
 * @route   POST /api/browser/launch/:googleAccountId
 * @access  Private
 */
const launchBrowser = async (req, res, next) => {
  try {
    const { googleAccountId } = req.params;
    const { account, vpnProfile } = await resolveAccountAndVpn(googleAccountId, req.user._id);

    const { reused } = await puppeteerService.getBrowser(account, vpnProfile);

    res.status(200).json({
      message: reused
        ? `Reusing existing browser session for ${account.email}.`
        : `Browser launched for ${account.email}.`,
      accountId: account._id,
      email: account.email,
      status: 'open',
      reused,
      vpn: vpnProfile
        ? { assigned: true, location: vpnProfile.serverLocation, file: vpnProfile.originalFileName }
        : { assigned: false },
    });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode);
    next(error);
  }
};

/**
 * @desc    List all currently open browser sessions.
 * @route   GET /api/browser/status
 * @access  Private
 */
const getStatus = async (req, res, next) => {
  try {
    const sessions = puppeteerService.getSessionStatus();
    res.status(200).json({
      total: sessions.length,
      sessions,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Close the browser session for a specific Google account.
 *          Also disconnects the account's VPN.
 * @route   POST /api/browser/close/:googleAccountId
 * @access  Private
 */
const closeBrowser = async (req, res, next) => {
  try {
    const { googleAccountId } = req.params;
    const { account, vpnProfile } = await resolveAccountAndVpn(googleAccountId, req.user._id);

    await puppeteerService.closeBrowser(account._id.toString(), vpnProfile);

    res.status(200).json({
      message: `Browser session closed for ${account.email}.`,
      accountId: account._id,
    });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode);
    next(error);
  }
};

/**
 * @desc    Close ALL browser sessions and disconnect all VPNs.
 * @route   POST /api/browser/close-all
 * @access  Private
 */
const closeAllBrowsers = async (req, res, next) => {
  try {
    await puppeteerService.closeAll();
    res.status(200).json({ message: 'All browser sessions closed and VPNs disconnected.' });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Run a named task inside an account's browser session.
 *          Launches the browser first if it is not already open.
 *          Available tasks: get-current-ip, youtube-login-check, youtube-studio-snapshot, screenshot
 * @route   POST /api/browser/run-task/:googleAccountId
 * @body    { "task": "youtube-login-check" }
 * @access  Private
 */
const runTask = async (req, res, next) => {
  try {
    const { googleAccountId } = req.params;
    const { task } = req.body;

    if (!task) {
      res.status(400);
      throw new Error('Please provide a "task" name in the request body.');
    }

    const taskFn = TASK_REGISTRY[task];
    if (!taskFn) {
      res.status(400);
      throw new Error(
        `Unknown task "${task}". Available tasks: ${Object.keys(TASK_REGISTRY).join(', ')}`
      );
    }

    const { account, vpnProfile } = await resolveAccountAndVpn(googleAccountId, req.user._id);

    // Ensure browser is open (reuse if alive, launch if not)
    const { page } = await puppeteerService.getBrowser(account, vpnProfile);

    console.log(`[Puppeteer] Running task "${task}" for ${account.email}…`);
    const result = await taskFn(page, account);

    res.status(200).json({
      message: `Task "${task}" completed for ${account.email}.`,
      accountId: account._id,
      email: account.email,
      task,
      result,
    });
  } catch (error) {
    if (error.statusCode) res.status(error.statusCode);
    next(error);
  }
};

/**
 * @desc    List all available registered tasks.
 * @route   GET /api/browser/tasks
 * @access  Private
 */
const listTasks = async (req, res, next) => {
  try {
    res.status(200).json({
      tasks: Object.keys(TASK_REGISTRY),
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  launchBrowser,
  getStatus,
  closeBrowser,
  closeAllBrowsers,
  runTask,
  listTasks,
};

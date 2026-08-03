'use strict';

/**
 * puppeteerService.js
 *
 * Manages multiple Puppeteer browser sessions — one per Google account.
 * Each session uses a dedicated Chrome userDataDir so cookies, localStorage,
 * and IndexedDB are persisted between server restarts (no manual cookie serialization).
 *
 * VPN lifecycle mirrors commentController.js:
 *   disconnectAll → connect(vpnProfile) → settle → launch browser → work → close
 *
 * Session map key: googleAccountId (string)
 *
 * NOTE: puppeteer-extra and puppeteer-extra-plugin-stealth are loaded lazily
 * (only when the first browser is launched) so the server starts cleanly
 * even before the packages are installed.
 * Install them with:
 *   npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth
 */

const fs = require('fs');
const path = require('path');
const openvpnService = require('./openvpnService');

// ─── Lazy puppeteer loader ────────────────────────────────────────────────────

let _puppeteer = null;

/**
 * Returns a puppeteer-extra instance with the stealth plugin applied.
 * Throws a clear error if the packages are not installed.
 */
const getPuppeteer = () => {
  if (_puppeteer) return _puppeteer;

  try {
    const puppeteerExtra = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(StealthPlugin());
    _puppeteer = puppeteerExtra;
    return _puppeteer;
  } catch (err) {
    throw new Error(
      '[Puppeteer] Required packages are not installed. ' +
      'Run: npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth\n' +
      `Original error: ${err.message}`
    );
  }
};

// ─── Config ──────────────────────────────────────────────────────────────────

const HEADLESS = process.env.PUPPETEER_HEADLESS !== 'false'; // default true
const SESSIONS_BASE_DIR = path.resolve(
  process.cwd(),
  process.env.BROWSER_SESSIONS_DIR || 'browser_sessions'
);
const VPN_SETTLE_MS = 3000;   // time to wait after VPN connects before launching browser
const BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
  '--window-size=1280,800',
];

// ─── In-memory session map ────────────────────────────────────────────────────

/**
 * @type {Map<string, {
 *   browser: import('puppeteer').Browser,
 *   vpnProfileId: string | null,
 *   accountEmail: string,
 *   launchedAt: Date,
 * }>}
 */
const sessionMap = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns the persistent Chrome userDataDir for an account.
 * Created on first launch, reused on every subsequent launch.
 */
const getSessionDir = (accountId) => {
  const dir = path.join(SESSIONS_BASE_DIR, String(accountId));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
};

/**
 * Checks whether a browser in the session map is still alive.
 * Puppeteer throws when you call browser.pages() on a disconnected browser.
 */
const isBrowserAlive = async (browser) => {
  try {
    await browser.pages();
    return true;
  } catch {
    return false;
  }
};

// ─── Core API ─────────────────────────────────────────────────────────────────

/**
 * Launches a new browser for the given account.
 * Connects to the account's VPN first (if a vpnProfile is provided).
 *
 * @param {import('../models/GoogleAccount')} account  - Mongoose GoogleAccount document
 * @param {import('../models/VpnProfile') | null} vpnProfile - VPN profile to connect, or null
 * @returns {Promise<{ browser: Browser, page: Page }>}
 */
const launchBrowser = async (account, vpnProfile) => {
  const accountId = account._id.toString();

  // ── 1. VPN lifecycle ────────────────────────────────────────────────────────
  if (vpnProfile) {
    console.log(`[Puppeteer] Disconnecting all VPNs before launching for ${account.email}…`);
    await openvpnService.disconnectAll();

    console.log(`[Puppeteer] Connecting VPN "${vpnProfile.originalFileName}" for ${account.email}…`);
    await openvpnService.connect(vpnProfile);

    console.log(`[Puppeteer] VPN connected. Settling for ${VPN_SETTLE_MS}ms…`);
    await new Promise((r) => setTimeout(r, VPN_SETTLE_MS));
  } else {
    console.log(`[Puppeteer] No VPN profile for ${account.email}. Launching without VPN.`);
  }

  // ── 2. Launch browser ───────────────────────────────────────────────────────
  const userDataDir = getSessionDir(accountId);
  console.log(`[Puppeteer] Launching browser for ${account.email} (userDataDir: ${userDataDir})`);

  const puppeteer = getPuppeteer();
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    userDataDir,
    args: BROWSER_ARGS,
    defaultViewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: false,
  });

  // ── 3. Open a first page ────────────────────────────────────────────────────
  const pages = await browser.pages();
  const page = pages.length > 0 ? pages[0] : await browser.newPage();

  // Set a realistic user-agent (stealth plugin also handles this, belt-and-suspenders)
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36'
  );

  // ── 4. Register session ─────────────────────────────────────────────────────
  sessionMap.set(accountId, {
    browser,
    vpnProfileId: vpnProfile ? vpnProfile._id.toString() : null,
    accountEmail: account.email,
    launchedAt: new Date(),
  });

  // Auto-clean session map if browser disconnects unexpectedly
  browser.on('disconnected', () => {
    console.log(`[Puppeteer] Browser for ${account.email} disconnected unexpectedly.`);
    sessionMap.delete(accountId);
  });

  console.log(`[Puppeteer] ✅ Browser ready for ${account.email}`);
  return { browser, page };
};

/**
 * Returns an existing open browser session for the account, or launches a new one.
 * Pass vpnProfile so that if a re-launch is needed the VPN is reconnected.
 *
 * @param {import('../models/GoogleAccount')} account
 * @param {import('../models/VpnProfile') | null} vpnProfile
 * @returns {Promise<{ browser: Browser, page: Page, reused: boolean }>}
 */
const getBrowser = async (account, vpnProfile) => {
  const accountId = account._id.toString();
  const existing = sessionMap.get(accountId);

  if (existing) {
    const alive = await isBrowserAlive(existing.browser);
    if (alive) {
      console.log(`[Puppeteer] Reusing existing browser session for ${account.email}`);
      const pages = await existing.browser.pages();
      const page = pages.length > 0 ? pages[0] : await existing.browser.newPage();
      return { browser: existing.browser, page, reused: true };
    }
    // Stale reference — clean up
    console.log(`[Puppeteer] Stale session found for ${account.email}. Re-launching…`);
    sessionMap.delete(accountId);
  }

  const result = await launchBrowser(account, vpnProfile);
  return { ...result, reused: false };
};

/**
 * Closes the browser for a specific account and disconnects its VPN.
 *
 * @param {string} accountId
 * @param {import('../models/VpnProfile') | null} vpnProfile - pass to do a targeted disconnect
 */
const closeBrowser = async (accountId, vpnProfile = null) => {
  const session = sessionMap.get(String(accountId));

  if (session) {
    console.log(`[Puppeteer] Closing browser for ${session.accountEmail}…`);
    try {
      await session.browser.close();
    } catch (err) {
      console.warn(`[Puppeteer] Error closing browser: ${err.message}`);
    }
    sessionMap.delete(String(accountId));
  }

  // Disconnect VPN
  if (vpnProfile) {
    try {
      await openvpnService.disconnect(vpnProfile);
      console.log(`[Puppeteer] VPN disconnected for account ${accountId}`);
    } catch (err) {
      console.warn(`[Puppeteer] VPN disconnect error: ${err.message}`);
    }
  }
};

/**
 * Closes ALL open browser sessions and disconnects all VPNs.
 */
const closeAll = async () => {
  console.log(`[Puppeteer] Closing all ${sessionMap.size} browser session(s)…`);

  const closePromises = [];
  for (const [accountId, session] of sessionMap.entries()) {
    closePromises.push(
      session.browser.close().catch((e) =>
        console.warn(`[Puppeteer] Error closing browser for ${session.accountEmail}: ${e.message}`)
      )
    );
  }

  await Promise.allSettled(closePromises);
  sessionMap.clear();

  try {
    await openvpnService.disconnectAll();
  } catch (err) {
    console.warn(`[Puppeteer] VPN disconnect-all error: ${err.message}`);
  }

  console.log('[Puppeteer] All sessions closed.');
};

/**
 * Returns a snapshot of all open sessions (safe to serialize as JSON).
 * @returns {Array<{ accountId: string, accountEmail: string, vpnProfileId: string|null, launchedAt: Date }>}
 */
const getSessionStatus = () => {
  const status = [];
  for (const [accountId, session] of sessionMap.entries()) {
    status.push({
      accountId,
      accountEmail: session.accountEmail,
      vpnProfileId: session.vpnProfileId,
      launchedAt: session.launchedAt,
    });
  }
  return status;
};

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('[Puppeteer] SIGINT received — closing all browser sessions…');
  await closeAll();
});

process.on('SIGTERM', async () => {
  console.log('[Puppeteer] SIGTERM received — closing all browser sessions…');
  await closeAll();
});

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  launchBrowser,
  getBrowser,
  closeBrowser,
  closeAll,
  getSessionStatus,
  getSessionDir,
};

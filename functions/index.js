'use strict';

/**
 * Single Cloud Function entry: entire Express API (auth, YouTube, comments, etc.).
 * Deploy with: npm run deploy:functions
 * Hosting rewrites /api/** → this function.
 */

const path = require('path');
const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');

setGlobalOptions({
  region: 'us-central1',
  maxInstances: 20,
});

// Firebase loads functions/.env at deploy; dotenv covers local emulator + copied bundle
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Fill any missing keys from hardcoded project defaults (env / .env always win)
const { applyEnvDefaults } = require('./src/config/envDefaults');
applyEnvDefaults({ cloud: true });

process.env.YT_USER_DATA = process.env.YT_USER_DATA || path.join('/tmp', 'yt_automation');

const connectDB = require('./src/config/db');
const app = require('./src/app');

let readyPromise;

const ensureReady = async () => {
  if (!readyPromise) {
    readyPromise = connectDB().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
};

/**
 * One HTTPS function for the whole API.
 * Timeout/memory sized for comment generation + YouTube batch work.
 */
exports.api = onRequest(
  {
    timeoutSeconds: 3600,
    memory: '1GiB',
    cors: true,
    invoker: 'public',
  },
  async (req, res) => {
    try {
      await ensureReady();
    } catch (err) {
      console.error('[API] Startup failed:', err.message);
      return res.status(503).json({
        message: 'Database unavailable. Configure Firebase (FIREBASE_PROJECT_ID + service account / ADC).',
        error: err.message,
      });
    }
    return app(req, res);
  }
);

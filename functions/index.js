'use strict';

const path = require('path');
const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');

setGlobalOptions({ region: 'us-central1', maxInstances: 20 });

require('dotenv').config({ path: path.join(__dirname, '.env') });

const connectDB = require('./src/config/db');
const app = require('./src/app');

let readyPromise;

const ensureReady = () => {
  if (!readyPromise) {
    readyPromise = connectDB().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
};

// Env vars are loaded from functions/.env (copied at predeploy). On Blaze, optionally use
// ./scripts/set-firebase-secrets.sh instead of bundling .env.
exports.api = onRequest(
  {
    timeoutSeconds: 300,
    memory: '1GiB',
    cors: true,
  },
  async (req, res) => {
    try {
      await ensureReady();
    } catch (err) {
      console.error('[API] Database connection failed:', err.message);
      return res.status(503).json({
        message: 'Database unavailable. Configure Firebase (FIREBASE_PROJECT_ID + service account).',
        error: err.message,
      });
    }
    return app(req, res);
  }
);

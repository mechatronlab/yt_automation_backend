'use strict';

const { initFirebase } = require('./firebase');
const { isCloudRuntime } = require('../utils/runtime');

let cached = global.__firebaseCache;
if (!cached) {
  cached = global.__firebaseCache = { ready: null };
}

// TEMP TEST BYPASS — remove after comment-generation testing.
const isTestGenerateBypassEnabled = () =>
  !isCloudRuntime()
  && String(process.env.ALLOW_TEST_GENERATE_WITHOUT_ACCOUNTS || '').trim() === '1';

const connectDB = async () => {
  if (cached.ready) {
    return cached.ready;
  }

  // TEMP TEST BYPASS — skip Firebase so local comment-generation testing can run without credentials.
  if (isTestGenerateBypassEnabled()) {
    console.warn('[TEST BYPASS] Skipping Firebase connection (comment-generation test mode)');
    cached.ready = Promise.resolve(true);
    return cached.ready;
  }

  cached.ready = (async () => {
    initFirebase();
    const { getProjectId, getFirestore } = require('./firebase');
    // Verify credentials work before accepting traffic
    await getFirestore().collection('_health').doc('ping').get();
    console.log(`Firebase connected: project ${getProjectId()} (Firestore + Storage)`);
    return true;
  })().catch((error) => {
    cached.ready = null;
    console.error(`Firebase Error: ${error.message}`);
    throw error;
  });

  return cached.ready;
};

const connectDBLocal = async () => {
  try {
    await connectDB();
  } catch (error) {
    const { isCloudRuntime } = require('../utils/runtime');
    if (!isCloudRuntime()) {
      process.exit(1);
    }
    throw error;
  }
};

module.exports = isCloudRuntime() ? connectDB : connectDBLocal;

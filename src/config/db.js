'use strict';

const { initFirebase } = require('./firebase');

let cached = global.__firebaseCache;
if (!cached) {
  cached = global.__firebaseCache = { ready: null };
}

const connectDB = async () => {
  if (cached.ready) {
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

const { isCloudRuntime } = require('../utils/runtime');
module.exports = isCloudRuntime() ? connectDB : connectDBLocal;

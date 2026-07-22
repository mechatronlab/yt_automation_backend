'use strict';

/** True when running on Firebase Cloud Functions / Cloud Run. */
const isCloudRuntime = () =>
  !!(process.env.K_SERVICE || process.env.FUNCTION_TARGET || process.env.FIREBASE_CONFIG);

module.exports = { isCloudRuntime };

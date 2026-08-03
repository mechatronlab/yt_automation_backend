'use strict';

const { isCloudRuntime } = require('../utils/runtime');

const CLOUD_UNAVAILABLE =
  'This feature requires the local server (npm start). VPN, browser automation, and Create Account script do not run on Firebase hosting.';

const blockOnCloud = (featureName) => (req, res, next) => {
  if (!isCloudRuntime()) return next();
  res.status(503).json({
    message: featureName
      ? `${featureName} is not available on the cloud deployment. Run npm start locally for this feature.`
      : CLOUD_UNAVAILABLE,
    cloudDeployment: true,
  });
};

module.exports = { blockOnCloud, CLOUD_UNAVAILABLE };

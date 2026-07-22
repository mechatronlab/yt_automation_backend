const fs = require('fs');
const path = require('path');

const errorHandler = (err, req, res, next) => {
  const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  res.status(statusCode);

  const errorMsg = `\n--- [${new Date().toISOString()}] ERROR ---\n` +
                   `Status: ${statusCode}\n` +
                   `Message: ${err.message}\n` +
                   `Stack: ${err.stack}\n`;
  try {
    fs.appendFileSync(path.resolve(__dirname, '../../request_debug.log'), errorMsg);
  } catch (e) {
    console.error('Error logging to file:', e);
  }

  const isCredentialsError = /default credentials|Firebase credentials missing/i.test(err.message || '');

  res.json({
    message: isCredentialsError
      ? 'Firebase credentials missing. Save your service account JSON as firebase-service-account.json in the project folder, then restart npm start. See: https://console.firebase.google.com/project/ytautomation-2fae5/settings/serviceaccounts/adminsdk'
      : err.message,
    stack: process.env.NODE_ENV === 'production' ? null : err.stack,
  });
};

module.exports = { errorHandler };

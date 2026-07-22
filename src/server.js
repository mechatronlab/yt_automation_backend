const { getEnvPath } = require('./utils/appPaths');
require('dotenv').config({ path: getEnvPath(), override: true });

const app = require('./app');
const connectDB = require('./config/db');

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

const PORT = Number(process.env.PORT) || 5003;

async function startServer() {
  await connectDB();
  const { getOAuthRedirectUri } = require('./utils/oauthHelpers');
  const oauthRedirectUri = getOAuthRedirectUri(null);
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, '127.0.0.1', () => {
      console.log(`Server running on http://127.0.0.1:${PORT}`);
      console.log(`Google OAuth redirect URI: ${oauthRedirectUri}`);
      console.log('Add this exact URL under Authorized redirect URIs in Google Cloud Console.');
      resolve(PORT);
    });
    server.on('error', reject);
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { startServer, PORT };

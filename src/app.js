const express = require('express');
const cors = require('cors');
const { errorHandler } = require('./middlewares/errorMiddleware');
const authRoutes = require('./routes/authRoutes');
const googleAccountRoutes = require('./routes/googleAccountRoutes');
const youtubeRoutes = require('./routes/youtubeRoutes');
const commentRoutes = require('./routes/commentRoutes');
const vpnRoutes = require('./routes/vpnRoutes');
const puppeteerRoutes = require('./routes/puppeteerRoutes');
const pythonScriptRoutes = require('./routes/pythonScriptRoutes');

const app = express();

const fs = require('fs');
const { getPublicDir, getLogPath } = require('./utils/appPaths');
const { getGoogleOAuthSetup } = require('./utils/oauthHelpers');
const { isCloudRuntime } = require('./utils/runtime');

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Log requests: file locally, concise console on Cloud Functions
app.use((req, res, next) => {
  const reqTime = new Date().toISOString();
  const originalSend = res.send;
  let responseBody;

  res.send = function (body) {
    responseBody = body;
    return originalSend.apply(res, arguments);
  };

  res.on('finish', () => {
    if (isCloudRuntime()) {
      console.log(`[${reqTime}] ${req.method} ${req.originalUrl || req.url} -> ${res.statusCode}`);
      return;
    }
    const logMsg = `\n--- [${reqTime}] ${req.method} ${req.url} -> Status: ${res.statusCode}\n` +
                   `Request Headers: ${JSON.stringify(req.headers, null, 2)}\n` +
                   `Request Query: ${JSON.stringify(req.query, null, 2)}\n` +
                   `Request Body: ${JSON.stringify(req.body, null, 2)}\n` +
                   `Response Body: ${typeof responseBody === 'string' ? responseBody.slice(0, 2000) : JSON.stringify(responseBody, null, 2)}\n`;
    try {
      fs.appendFileSync(getLogPath('request_debug.log'), logMsg);
    } catch (err) {
      console.error('Logging error:', err);
    }
  });

  next();
});

// Hosting serves the SPA; skip static files inside the Cloud Function bundle
if (!isCloudRuntime()) {
  app.use(express.static(getPublicDir()));
}

app.get('/api/health', (req, res) => {
  res.status(200).json({
    message: 'API is running',
    runtime: isCloudRuntime() ? 'cloud' : 'local',
  });
});

app.get('/api/config/client', (req, res) => {
  const oauth = getGoogleOAuthSetup(req);
  const { getPublicProjects, getDefaultProjectId } = require('./config/projects');
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    oauthRedirectUri: oauth.redirectUri,
    googleOAuthSetup: oauth,
    projects: getPublicProjects(),
    defaultProjectId: getDefaultProjectId(),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/google-accounts', googleAccountRoutes);
app.use('/api/youtube', youtubeRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/vpn', vpnRoutes);
app.use('/api/browser', puppeteerRoutes);
app.use('/api/python-script', pythonScriptRoutes);

app.use(errorHandler);

module.exports = app;

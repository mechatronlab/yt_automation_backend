'use strict';

const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const CALLBACK_PATH = '/api/auth/google/oauth-callback';

const normalizeOAuthHost = (host) => {
  if (!host) return host;
  if (host.startsWith('127.0.0.1:')) {
    return `localhost:${host.split(':')[1]}`;
  }
  return host;
};

const getOAuthRedirectUri = (req) => {
  const explicit = (process.env.OAUTH_REDIRECT_URI || '').trim();
  if (explicit) {
    return explicit;
  }

  if (req) {
    const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
    const proto = forwardedProto || req.protocol || 'http';
    const host = normalizeOAuthHost(
      (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim()
    );
    if (host && !host.startsWith('0.0.0.0')) {
      return `${proto}://${host}${CALLBACK_PATH}`;
    }
  }

  const envBase = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (envBase) {
    return `${envBase}${CALLBACK_PATH}`;
  }

  const port = process.env.PORT || 5003;
  return `http://localhost:${port}${CALLBACK_PATH}`;
};

const getAllowedReturnOrigins = () => {
  const fromEnv = (process.env.OAUTH_ALLOWED_RETURN_ORIGINS || '')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const port = process.env.PORT || 5003;
  const defaults = [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    'https://ytauto.web.app',
    'https://login-7972e.web.app',
    'https://login-7972e.firebaseapp.com',
  ];

  const envBase = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (envBase) defaults.push(envBase);

  return [...new Set([...defaults, ...fromEnv])];
};

const isAllowedReturnUrl = (returnTo) => {
  try {
    const url = new URL(returnTo);
    const origin = url.origin;
    if (getAllowedReturnOrigins().includes(origin)) return true;
    if (origin.endsWith('.web.app') || origin.endsWith('.firebaseapp.com')) return true;
    if (origin.endsWith('.loca.lt') || origin.endsWith('.ngrok-free.app') || origin.endsWith('.ngrok.io')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
};

const sanitizeReturnTo = (returnTo, fallbackOrigin) => {
  if (returnTo && isAllowedReturnUrl(returnTo)) {
    return returnTo;
  }
  const fallback = (fallbackOrigin || process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 5003}`).replace(/\/$/, '');
  return `${fallback}/`;
};

const signOAuthState = (payload) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is required for OAuth state signing');
  }
  const data = Buffer.from(JSON.stringify({
    ...payload,
    exp: Date.now() + 15 * 60 * 1000,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
};

const verifyOAuthState = (state) => {
  const secret = process.env.JWT_SECRET;
  if (!secret || !state || !state.includes('.')) {
    throw new Error('Invalid OAuth state');
  }
  const [data, sig] = state.split('.');
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  if (sig !== expected) {
    throw new Error('Invalid OAuth state signature');
  }
  const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  if (!payload.exp || payload.exp < Date.now()) {
    throw new Error('OAuth state expired');
  }
  return payload;
};

const buildGoogleAuthUrl = ({
  redirectUri,
  state,
  scopes,
  loginHint,
  prompt,
  accessType = 'online',
}) => {
  const client = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );

  return client.generateAuthUrl({
    access_type: accessType,
    scope: scopes,
    state,
    redirect_uri: redirectUri,
    login_hint: loginHint || undefined,
    prompt: prompt || 'select_account',
    include_granted_scopes: true,
  });
};

const redirectWithOAuthError = (res, returnTo, message) => {
  const target = sanitizeReturnTo(returnTo);
  const params = new URLSearchParams({ oauth_error: message });
  return res.redirect(`${target}#${params.toString()}`);
};

const redirectWithOAuthPayload = (res, returnTo, payload) => {
  const target = sanitizeReturnTo(returnTo);
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return res.redirect(`${target}#auth=${encoded}`);
};

const getGoogleOAuthSetup = (req) => {
  const redirectUri = getOAuthRedirectUri(req);
  const port = process.env.PORT || 5003;
  const origins = [...new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    'https://ytauto.web.app',
    ...(process.env.PUBLIC_BASE_URL ? [process.env.PUBLIC_BASE_URL.trim().replace(/\/$/, '')] : []),
    redirectUri.replace(/\/api\/auth\/google\/oauth-callback$/, ''),
  ])];

  return {
    redirectUri,
    authorizedJavaScriptOrigins: origins,
    authorizedRedirectUris: [
      redirectUri,
      `http://localhost:${port}${CALLBACK_PATH}`,
      `http://127.0.0.1:${port}${CALLBACK_PATH}`,
      'https://ytauto.web.app/api/auth/google/oauth-callback',
    ],
  };
};

module.exports = {
  CALLBACK_PATH,
  getOAuthRedirectUri,
  sanitizeReturnTo,
  signOAuthState,
  verifyOAuthState,
  buildGoogleAuthUrl,
  redirectWithOAuthError,
  redirectWithOAuthPayload,
  getGoogleOAuthSetup,
};

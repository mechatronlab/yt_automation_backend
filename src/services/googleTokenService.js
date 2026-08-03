'use strict';

const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const { encrypt, decrypt } = require('../utils/encryption');

const createOAuth2Client = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required for YouTube API access.');
  }

  return new OAuth2Client(clientId, clientSecret);
};

const isInvalidStoredToken = (value) =>
  !value || value === 'PENDING_SCRIPT_OAUTH' || value === 'null' || value === 'undefined';

const isInvalidGrantError = (error) => {
  const message = String(error?.message || error?.response?.data?.error || '').toLowerCase();
  const description = String(error?.response?.data?.error_description || '').toLowerCase();
  return message.includes('invalid_grant') || description.includes('expired or revoked');
};

const markAccountTokenExpired = async (account, reason = 'invalid_grant') => {
  if (!account?.save) return;
  try {
    account.status = 'token_expired';
    account.tokenError = reason;
    account.tokenErrorAt = new Date().toISOString();
    await account.save();
  } catch (saveErr) {
    console.warn(`[GoogleToken] Could not mark ${account.email} as token_expired: ${saveErr.message}`);
  }
};

const reconnectMessage = (email) =>
  `Google login expired for ${email || 'this account'}. Go to Accounts → disconnect it → Connect Account again and approve all YouTube permissions.`;

/**
 * Refresh access token when possible and persist updates on the GoogleAccount document.
 */
const ensureFreshGoogleAccountTokens = async (account) => {
  if (!account?.accessToken || isInvalidStoredToken(account.accessToken)) {
    throw new Error('This account is not fully connected. Reconnect it from the Accounts tab.');
  }

  let accessToken;
  try {
    accessToken = decrypt(account.accessToken);
  } catch {
    throw new Error('Stored Google token is invalid. Reconnect this account from the Accounts tab.');
  }

  if (isInvalidStoredToken(accessToken)) {
    throw new Error('This account is not fully connected. Reconnect it from the Accounts tab.');
  }

  let refreshToken = null;
  if (account.refreshToken) {
    try {
      refreshToken = decrypt(account.refreshToken);
    } catch {
      refreshToken = null;
    }
  }

  if (!refreshToken || isInvalidStoredToken(refreshToken)) {
    return {
      accessToken,
      refreshToken: null,
      oAuth2Client: null,
      refreshed: false,
    };
  }

  const oAuth2Client = createOAuth2Client();
  oAuth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  try {
    // Force a real refresh — getAccessToken() may return a cached revoked token.
    const { credentials } = await oAuth2Client.refreshAccessToken();
    const freshAccessToken = credentials.access_token;

    if (!freshAccessToken) {
      throw new Error('Google did not return a new access token.');
    }

    if (freshAccessToken !== accessToken) {
      account.accessToken = encrypt(freshAccessToken);
      await account.save();
      accessToken = freshAccessToken;
    }

    if (credentials.refresh_token) {
      account.refreshToken = encrypt(credentials.refresh_token);
      await account.save();
      refreshToken = credentials.refresh_token;
    }

    oAuth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    return {
      accessToken,
      refreshToken,
      oAuth2Client,
      refreshed: true,
    };
  } catch (error) {
    console.warn(`[GoogleToken] Refresh failed for ${account.email}: ${error.message}`);
    if (isInvalidGrantError(error)) {
      await markAccountTokenExpired(account, 'invalid_grant');
      throw new Error(reconnectMessage(account.email));
    }
    throw new Error(reconnectMessage(account.email));
  }
};

const getYoutubeClientForAccount = async (account) => {
  const auth = await ensureFreshGoogleAccountTokens(account);

  if (auth.oAuth2Client) {
    return google.youtube({ version: 'v3', auth: auth.oAuth2Client });
  }

  const fallbackClient = createOAuth2Client();
  fallbackClient.setCredentials({
    access_token: auth.accessToken,
    refresh_token: auth.refreshToken || undefined,
  });

  return google.youtube({ version: 'v3', auth: fallbackClient });
};

module.exports = {
  ensureFreshGoogleAccountTokens,
  getYoutubeClientForAccount,
  isInvalidGrantError,
  markAccountTokenExpired,
  reconnectMessage,
};

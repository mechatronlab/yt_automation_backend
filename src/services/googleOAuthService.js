'use strict';

const path = require('path');
const fs = require('fs');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const GoogleAccount = require('../models/GoogleAccount');
const { encrypt } = require('../utils/encryption');
const { fetchChannelStats, lookupYoutubeChannel } = require('./youtubeService');

const { getPythonScriptDir } = require('../utils/appPaths');

const SCRIPT_DIR = getPythonScriptDir();

const lookupScriptPhoneForEmail = (email) => {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized) return '';

  const jsonPath = path.join(SCRIPT_DIR, 'last_created_account.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      if ((data.email || '').trim().toLowerCase() === normalized && data.phone) {
        return String(data.phone).trim();
      }
    } catch (e) {
      // ignore parse errors
    }
  }

  const txtPath = path.join(SCRIPT_DIR, 'account.txt');
  if (fs.existsSync(txtPath)) {
    const lines = fs.readFileSync(txtPath, 'utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const parts = lines[i].split('|').map((part) => part.trim()).filter(Boolean);
      if (parts.length >= 3 && parts[0].toLowerCase() === normalized) {
        return parts[1];
      }
    }
  }

  return '';
};

// Commenting + channel list. Do not include youtube.upload here — it is a
// restricted scope and Google blocks NEW accounts on unverified apps.
const YOUTUBE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/youtube.force-ssl',
].join(' ');

const getScriptOAuthRedirectUri = () => {
  const explicit = (process.env.OAUTH_REDIRECT_URI || '').trim();
  if (explicit) {
    return explicit;
  }
  const base = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (base) {
    return `${base}/api/auth/google/oauth-callback`;
  }
  const port = process.env.PORT || 5003;
  return `http://localhost:${port}/api/auth/google/oauth-callback`;
};

/**
 * Exchange a Google OAuth authorization code for tokens and save/update GoogleAccount.
 * Used by manual Connect Account (postmessage) and Python script (localhost redirect).
 */
const exchangeCodeAndSaveAccount = async (userId, code, options = {}) => {
  if (!process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET === 'your-google-client-secret') {
    throw new Error(
      'Invalid Google OAuth credentials: GOOGLE_CLIENT_SECRET is missing or set to default placeholder in .env. Please set GOOGLE_CLIENT_SECRET to your actual secret from Google Cloud Console.'
    );
  }

  const redirectUri = options.redirectUri || 'postmessage';
  const clientId = options.clientId || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = options.clientSecret || process.env.GOOGLE_CLIENT_SECRET;

  const oAuth2Client = new OAuth2Client(
    clientId,
    clientSecret,
    redirectUri
  );

  const tokenResponse = await oAuth2Client.getToken(
    redirectUri === 'postmessage' ? code : { code, redirect_uri: redirectUri }
  );
  const tokens = tokenResponse.tokens;
  oAuth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
  const { data: profile } = await oauth2.userinfo.get();

  const encryptedAccessToken = encrypt(tokens.access_token);
  const encryptedRefreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined;
  let phoneNumber = (options.phoneNumber || '').trim();
  if (!phoneNumber && profile.email) {
    phoneNumber = lookupScriptPhoneForEmail(profile.email);
  }

  let youtubeChannel = '';
  let youtubeChannelTitle = '';
  try {
    const youtube = google.youtube({ version: 'v3', auth: oAuth2Client });
    const channel = await lookupYoutubeChannel(youtube);
    youtubeChannel = channel?.id || '';
    youtubeChannelTitle = channel?.snippet?.title || '';
  } catch (channelErr) {
    console.warn(`[OAuth] No YouTube channel for ${profile.email}: ${channelErr.message}`);
  }

  let account = await GoogleAccount.findOne({ user: userId, googleId: profile.id });

  if (!account) {
    account = await GoogleAccount.findOne({
      user: userId,
      email: profile.email.toLowerCase(),
    });
    if (account) {
      account.googleId = profile.id;
    }
  }

  if (account) {
    account.accessToken = encryptedAccessToken;
    if (encryptedRefreshToken) account.refreshToken = encryptedRefreshToken;
    account.name = profile.name;
    account.email = profile.email;
    account.avatar = profile.picture;
    account.status = 'connected';
    account.signupStatus = 'success';
    account.tokenError = null;
    account.tokenErrorAt = null;
    if (phoneNumber) account.phoneNumber = phoneNumber;
    account.youtubeChannel = youtubeChannel;
    account.youtubeChannelTitle = youtubeChannelTitle;
    await account.save();

    return {
      accountId: account._id.toString(),
      email: profile.email,
      name: profile.name,
      googleId: profile.id,
      phoneNumber: account.phoneNumber || '',
      isActive: account.isActive,
      status: 'connected',
      youtubeChannel: account.youtubeChannel || '',
      youtubeChannelTitle: account.youtubeChannelTitle || '',
      hasYoutubeChannel: !!account.youtubeChannel,
      channelWarning: account.youtubeChannel
        ? null
        : 'No YouTube channel found. Open youtube.com with this account and create a channel before commenting.',
      updated: true,
    };
  }

  account = await GoogleAccount.create({
    user: userId,
    googleId: profile.id,
    email: profile.email,
    name: profile.name,
    avatar: profile.picture,
    accessToken: encryptedAccessToken,
    refreshToken: encryptedRefreshToken,
    phoneNumber,
    youtubeChannel,
    youtubeChannelTitle,
    isActive: true,
    status: 'connected',
  });

  return {
    accountId: account._id.toString(),
    email: profile.email,
    name: profile.name,
    googleId: profile.id,
    phoneNumber: account.phoneNumber || '',
    isActive: true,
    status: 'connected',
    youtubeChannel: youtubeChannel || '',
    youtubeChannelTitle: youtubeChannelTitle || '',
    hasYoutubeChannel: !!youtubeChannel,
    channelWarning: youtubeChannel
      ? null
      : 'No YouTube channel found. Open youtube.com with this account and create a channel before commenting.',
    updated: false,
  };
};

module.exports = {
  YOUTUBE_SCOPES,
  getScriptOAuthRedirectUri,
  exchangeCodeAndSaveAccount,
};

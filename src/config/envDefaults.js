'use strict';

/**
 * Non-secret fallbacks only. Real credentials come from process.env / .env /
 * Firebase functions config — never hardcode OAuth secrets or API keys here.
 */
const DEFAULTS = {
  PORT: '5003',
  JWT_SECRET: '',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',

  FIREBASE_PROJECT_ID: 'ytautomation-2fae5',
  FIREBASE_STORAGE_BUCKET: 'ytautomation-2fae5.firebasestorage.app',

  AUTH_PROJECTS: 'ytautomation-2fae5,ytautomation-a90e5,ytautomation-74082',
  AUTH_DEFAULT_PROJECT: 'ytautomation-2fae5',
  PROJECT_LABEL_YTAUTOMATION_2FAE5: 'Project 1 (main)',
  PROJECT_LABEL_YTAUTOMATION_A90E5: 'Project 2',
  OAUTH_CLIENT_ID_YTAUTOMATION_A90E5: '',
  OAUTH_CLIENT_SECRET_YTAUTOMATION_A90E5: '',
  PROJECT_LABEL_YTAUTOMATION_74082: 'Project 3',
  OAUTH_CLIENT_ID_YTAUTOMATION_74082: '',
  OAUTH_CLIENT_SECRET_YTAUTOMATION_74082: '',

  GEMINI_API_KEY: '',
  GEMINI_MODEL: 'gemini-flash-lite-latest',
  GEMINI_MODEL_FALLBACKS:
    'gemini-3.5-flash-lite,gemini-flash-latest,gemini-3.1-flash-lite,gemini-3.5-flash',
  YOUTUBE_API_KEY: '',

  FIVESIM_API_KEY: '',
  FIVESIM_COUNTRY: 'any',
  FIVESIM_OPERATOR: 'any',
  FIVESIM_PRODUCT: 'google',

  ENCRYPTION_KEY: '',
};

const LOCAL_URL_DEFAULTS = {
  OAUTH_REDIRECT_URI: 'http://localhost:5003/api/auth/google/oauth-callback',
};

const CLOUD_DEFAULTS = {
  PUBLIC_BASE_URL: 'https://ytautomation-2fae5.web.app',
  OAUTH_REDIRECT_URI: 'https://ytautomation-2fae5.web.app/api/auth/google/oauth-callback',
};

const isMissing = (key) => !(process.env[key] || '').trim();

const applyEnvDefaults = ({ cloud = false } = {}) => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (isMissing(key) && value !== undefined && value !== '') {
      process.env[key] = value;
    }
  }

  const urlDefaults = cloud ? CLOUD_DEFAULTS : LOCAL_URL_DEFAULTS;
  for (const [key, value] of Object.entries(urlDefaults)) {
    if (isMissing(key)) {
      process.env[key] = value;
    }
  }

  // On cloud, always pin production hosting URLs (ignore localhost / CF host / other sites)
  if (cloud) {
    const redirect = (process.env.OAUTH_REDIRECT_URI || '').trim();
    if (
      !redirect
      || /localhost|127\.0\.0\.1|cloudfunctions\.net|ytauto01\.web\.app/.test(redirect)
    ) {
      process.env.OAUTH_REDIRECT_URI = CLOUD_DEFAULTS.OAUTH_REDIRECT_URI;
    }
    const base = (process.env.PUBLIC_BASE_URL || '').trim();
    if (
      !base
      || /localhost|127\.0\.0\.1|cloudfunctions\.net|ytauto01\.web\.app/.test(base)
    ) {
      process.env.PUBLIC_BASE_URL = CLOUD_DEFAULTS.PUBLIC_BASE_URL;
    }
  }
};

module.exports = { applyEnvDefaults, DEFAULTS, CLOUD_DEFAULTS };

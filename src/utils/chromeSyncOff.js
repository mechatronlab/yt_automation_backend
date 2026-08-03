'use strict';

/**
 * Chrome preferences that keep website Google login usable
 * while turning OFF Chrome Sync (the source of "Verify it's you").
 *
 * YouTube API / OAuth automation does not need Sync.
 */
const fs = require('fs');
const path = require('path');

const SYNC_OFF_PREFERENCES = {
  signin: {
    allowed_on_next_startup: true,
  },
  sync: {
    requested: false,
  },
  // Suppress first-run Sync promo / intercept bubbles
  browser: {
    has_seen_welcome_page: true,
    should_reset_check_default_browser: false,
  },
  distribution: {
    skip_first_run_ui: true,
    import_bookmarks: false,
    import_history: false,
    make_chrome_default_for_user: false,
    suppress_first_run_bubble: true,
    suppress_first_run_default_browser_prompt: true,
  },
  profile: {
    default_content_setting_values: {
      notifications: 2,
    },
    password_manager_enabled: false,
  },
  credentials_enable_service: false,
  credentials_enable_autosignin: false,
};

/**
 * Merge SYNC_OFF_PREFERENCES into <userDataDir>/Default/Preferences
 * before launching Chrome/Chromium.
 */
const writeSyncOffPreferences = (userDataDir) => {
  const defaultDir = path.join(userDataDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });
  const prefsPath = path.join(defaultDir, 'Preferences');

  let existing = {};
  if (fs.existsSync(prefsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    } catch {
      existing = {};
    }
  }

  const merged = deepMerge(existing, SYNC_OFF_PREFERENCES);
  // Explicitly force sync off even if a previous session turned it on
  merged.sync = { ...(merged.sync || {}), requested: false };
  fs.writeFileSync(prefsPath, JSON.stringify(merged), 'utf8');
  return prefsPath;
};

const deepMerge = (target, source) => {
  const out = { ...target };
  Object.keys(source || {}).forEach((key) => {
    const sv = source[key];
    const tv = out[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      out[key] = deepMerge(tv, sv);
    } else {
      out[key] = sv;
    }
  });
  return out;
};

/** Chromium flags that reduce Sync / sign-in intercept noise */
const SYNC_OFF_CHROME_ARGS = [
  '--disable-sync',
  '--disable-features=ChromeSigninIntercept,ChromeWhatsNewUI,AccountConsistency,SyncPromo',
  '--no-default-browser-check',
  '--no-first-run',
];

module.exports = {
  SYNC_OFF_PREFERENCES,
  SYNC_OFF_CHROME_ARGS,
  writeSyncOffPreferences,
};

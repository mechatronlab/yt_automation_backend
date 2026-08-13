'use strict';

const path = require('path');
const fs = require('fs');
const { isCloudRuntime } = require('./runtime');

const getAppRoot = () => process.env.YT_APP_ROOT || path.resolve(__dirname, '../..');

const getUserDataDir = () => {
  // Cloud Functions / Cloud Run filesystem is read-only except /tmp.
  const dir =
    process.env.YT_USER_DATA
    || (isCloudRuntime() ? path.join('/tmp', 'yt_automation') : getAppRoot());
  for (const sub of ['uploads/ovpn', 'uploads', 'vpn_pids', 'browser_sessions']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
};

const getPublicDir = () => {
  if (process.env.YT_PUBLIC_DIR) return process.env.YT_PUBLIC_DIR;
  return path.join(getAppRoot(), 'public');
};

const getPythonScriptDir = () => {
  if (process.env.YT_PYTHON_SCRIPT_DIR) return process.env.YT_PYTHON_SCRIPT_DIR;
  const bundled = process.env.ELECTRON_RESOURCES_PATH
    ? path.join(process.env.ELECTRON_RESOURCES_PATH, 'python_script')
    : null;
  if (bundled && fs.existsSync(bundled)) return bundled;
  return path.join(getAppRoot(), 'python_script');
};

const getEnvPath = () => {
  const userEnv = path.join(getUserDataDir(), '.env');
  if (fs.existsSync(userEnv)) return userEnv;

  const rootEnv = path.join(getAppRoot(), '.env');
  if (fs.existsSync(rootEnv)) return rootEnv;

  const examples = [
    path.join(getUserDataDir(), '.env.example'),
    process.env.ELECTRON_RESOURCES_PATH
      ? path.join(process.env.ELECTRON_RESOURCES_PATH, '.env.example')
      : null,
    path.join(getAppRoot(), '.env.example'),
  ].filter(Boolean);

  for (const example of examples) {
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, userEnv);
      return userEnv;
    }
  }

  return userEnv;
};

const getUploadDir = (subdir = '') => {
  const base = process.env.OVPN_UPLOAD_DIR || path.join(getUserDataDir(), 'uploads', 'ovpn');
  return subdir ? path.join(base, subdir) : base;
};

const getVpnPidDir = () =>
  process.env.OVPN_PID_DIR || path.join(getUserDataDir(), 'vpn_pids');

const getLogPath = (name) => path.join(getUserDataDir(), name);

const getServerListDir = () => {
  if (process.env.ELECTRON_RESOURCES_PATH) {
    const bundled = path.join(process.env.ELECTRON_RESOURCES_PATH, 'serverListTCP');
    if (fs.existsSync(bundled)) return bundled;
  }
  return path.join(getAppRoot(), 'serverListTCP');
};

module.exports = {
  getAppRoot,
  getUserDataDir,
  getPublicDir,
  getPythonScriptDir,
  getEnvPath,
  getUploadDir,
  getVpnPidDir,
  getLogPath,
  getServerListDir,
};

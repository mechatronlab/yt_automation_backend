'use strict';

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let serverPort = null;

function configurePaths() {
  const userData = app.getPath('userData');
  process.env.YT_USER_DATA = userData;
  process.env.OVPN_PID_DIR = path.join(userData, 'vpn_pids');
  process.env.OVPN_UPLOAD_DIR = path.join(userData, 'uploads', 'ovpn');

  if (app.isPackaged) {
    process.env.ELECTRON_RESOURCES_PATH = process.resourcesPath;
    process.env.YT_APP_ROOT = app.getAppPath();
    process.env.YT_PUBLIC_DIR = path.join(app.getAppPath(), 'public');
    process.env.YT_PYTHON_SCRIPT_DIR = path.join(process.resourcesPath, 'python_script');
  } else {
    process.env.YT_APP_ROOT = path.join(__dirname, '..');
  }

  fs.mkdirSync(process.env.OVPN_UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(process.env.OVPN_PID_DIR, { recursive: true });
}

function loadEnv() {
  const { getEnvPath } = require('../src/utils/appPaths');
  const envPath = getEnvPath();
  require('dotenv').config({ path: envPath, override: true });
  if (!process.env.PORT) process.env.PORT = '5003';
  return envPath;
}

async function startBackend() {
  const { startServer } = require('../src/server');
  serverPort = await startServer();
  return serverPort;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'CommentPilot AI',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function bootstrap() {
  try {
    configurePaths();
    const envPath = loadEnv();
    console.log('[Electron] Env:', envPath);
    await startBackend();
    createWindow();
  } catch (err) {
    console.error('[Electron] Startup failed:', err);
    dialog.showErrorBox(
      'CommentPilot AI — startup failed',
      `${err.message}\n\nCheck .env in app data folder and MongoDB connection.`
    );
    app.quit();
  }
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null && serverPort) {
    createWindow();
  }
});

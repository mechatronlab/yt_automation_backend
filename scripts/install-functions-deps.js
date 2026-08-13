'use strict';

/** Install Cloud Function dependencies (avoids Firebase predeploy '=' command bug). */
const { spawnSync } = require('child_process');
const path = require('path');

const functionsDir = path.join(__dirname, '..', 'functions');

console.log('Installing functions dependencies in', functionsDir);
const result = spawnSync('npm', ['install', '--omit=dev'], {
  cwd: functionsDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}

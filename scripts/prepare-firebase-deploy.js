'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const functionsDir = path.join(root, 'functions');
const destSrc = path.join(functionsDir, 'src');
const destPy = path.join(functionsDir, 'python_script');

const copyDir = (src, dest, filter) => {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, filter);
    } else if (!filter || filter(srcPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
};

const rmDir = (dir) => {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
};

console.log('Preparing Firebase functions bundle...');
rmDir(destSrc);
rmDir(destPy);

copyDir(path.join(root, 'src'), destSrc);

fs.mkdirSync(destPy, { recursive: true });
const pySrc = path.join(root, 'python_script');
for (const name of fs.readdirSync(pySrc)) {
  if (name.endsWith('.txt') || name === 'requirements.txt') {
    fs.copyFileSync(path.join(pySrc, name), path.join(destPy, name));
  }
}

console.log('Copied src/ and python_script/*.txt into functions/');

const envSrc = path.join(root, '.env');
const envDest = path.join(functionsDir, '.env');
const productionBase = 'https://ytautomation-2fae5.web.app';

if (fs.existsSync(envSrc)) {
  let envContent = fs.readFileSync(envSrc, 'utf8');
  const upsert = (key, value) => {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    const line = `${key}=${value}`;
    envContent = pattern.test(envContent)
      ? envContent.replace(pattern, line)
      : `${envContent.trimEnd()}\n${line}\n`;
  };

  upsert('PUBLIC_BASE_URL', productionBase);
  upsert('OAUTH_REDIRECT_URI', `${productionBase}/api/auth/google/oauth-callback`);

  fs.writeFileSync(envDest, envContent);
  console.log('Wrote functions/.env for Cloud Functions (from project .env)');
} else {
  console.warn('No root .env found — create one before deploying functions.');
}

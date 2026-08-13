'use strict';

/**
 * Bundles the Express app into functions/ for a single Cloud Function deploy.
 * Copies src/, a slim python_script/, and a production-ready .env.
 *
 * Firebase auto-loads functions/.env and rejects reserved keys:
 * PORT, and anything starting with FIREBASE_ / X_GOOGLE_ / EXT_
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const functionsDir = path.join(root, 'functions');
const destSrc = path.join(functionsDir, 'src');
const destPy = path.join(functionsDir, 'python_script');

const PRODUCTION_BASE = 'https://ytautomation-2fae5.web.app';

const REQUIRED_ENV_KEYS = [
  'JWT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'ENCRYPTION_KEY',
  'GEMINI_API_KEY',
];

/** Keys Firebase Functions will not accept in functions/.env */
const isReservedEnvKey = (key) => {
  if (key === 'PORT') return true;
  return /^(FIREBASE_|X_GOOGLE_|EXT_)/.test(key);
};

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

const upsertEnv = (content, key, value) => {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  return pattern.test(content)
    ? content.replace(pattern, line)
    : `${content.trimEnd()}\n${line}\n`;
};

const getEnvValue = (content, key) => {
  const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : '';
};

const sanitizeEnvForFirebase = (content) => {
  const kept = [];
  const stripped = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.trimStart().startsWith('#')) {
      kept.push(line);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      kept.push(line);
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (isReservedEnvKey(key)) {
      stripped.push(key);
      continue;
    }
    kept.push(line);
  }
  return { content: `${kept.join('\n').trimEnd()}\n`, stripped };
};

console.log('Preparing single Cloud Function bundle (functions/)...');
rmDir(destSrc);
rmDir(destPy);

copyDir(path.join(root, 'src'), destSrc);

fs.mkdirSync(destPy, { recursive: true });
const pySrc = path.join(root, 'python_script');
if (fs.existsSync(pySrc)) {
  for (const name of fs.readdirSync(pySrc)) {
    if (name.endsWith('.txt') || name === 'requirements.txt') {
      fs.copyFileSync(path.join(pySrc, name), path.join(destPy, name));
    }
  }
}

console.log('Copied src/ into functions/');

const envSrc = path.join(root, '.env');
const envDest = path.join(functionsDir, '.env');

if (!fs.existsSync(envSrc)) {
  console.error('ERROR: No root .env found. Create one before deploying.');
  process.exit(1);
}

let envContent = fs.readFileSync(envSrc, 'utf8');

const missing = REQUIRED_ENV_KEYS.filter((key) => !getEnvValue(envContent, key));
if (missing.length) {
  console.error(`ERROR: Root .env is missing required keys: ${missing.join(', ')}`);
  process.exit(1);
}

envContent = upsertEnv(envContent, 'PUBLIC_BASE_URL', PRODUCTION_BASE);
envContent = upsertEnv(
  envContent,
  'OAUTH_REDIRECT_URI',
  `${PRODUCTION_BASE}/api/auth/google/oauth-callback`
);

if (!getEnvValue(envContent, 'GEMINI_MODEL')) {
  envContent = upsertEnv(envContent, 'GEMINI_MODEL', 'gemini-flash-lite-latest');
}

const sanitized = sanitizeEnvForFirebase(envContent);
fs.writeFileSync(envDest, sanitized.content);

if (sanitized.stripped.length) {
  console.log(
    `Stripped Firebase-reserved keys from functions/.env: ${[...new Set(sanitized.stripped)].join(', ')}`
  );
  console.log('(FIREBASE_* / PORT come from envDefaults + Cloud ADC at runtime)');
}

console.log('Wrote functions/.env (production OAuth URLs + allowed secrets)');
console.log('');
console.log('Deploy the single "api" function with:');
console.log('  npm run deploy:functions');
console.log('  # or full stack: npm run deploy');
console.log('');
console.log(`After deploy, add this Google OAuth redirect URI:`);
console.log(`  ${PRODUCTION_BASE}/api/auth/google/oauth-callback`);

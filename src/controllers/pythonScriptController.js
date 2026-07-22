'use strict';

/**
 * pythonScriptController.js
 *
 * REST handlers for running the Google Account creation Python script.
 * Spawns youtube_signin.py as a child process and streams output via
 * Server-Sent Events (SSE) so the frontend can show real-time progress.
 *
 * Routes mounted at /api/python-script:
 *   POST /run         — Run the account creation script (returns SSE stream)
 *   GET  /status      — Check if a script is currently running
 *   POST /stop        — Stop a running script
 *   GET  /config      — Get current config values (name, birthday, password)
 *   POST /config      — Update config values before running
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const GoogleAccount = require('../models/GoogleAccount');
const { encrypt } = require('../utils/encryption');
const {
  exchangeCodeAndSaveAccount,
  getScriptOAuthRedirectUri,
} = require('../services/googleOAuthService');

const { getPythonScriptDir, getEnvPath } = require('../utils/appPaths');

const SCRIPT_DIR = getPythonScriptDir();
const SCRIPT_PATH = path.join(SCRIPT_DIR, 'youtube_signin.py');
const ENV_PATH = getEnvPath();

const readConfigFile = (name) => {
  const filePath = path.join(SCRIPT_DIR, name);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8').trim();
  }
  return '';
};

const readConfigLines = (name) => {
  return readConfigFile(name)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
};

const appendUniqueLines = (name, values) => {
  const incoming = (Array.isArray(values) ? values : [values])
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  if (!incoming.length) return;

  const merged = [...readConfigLines(name)];
  for (const value of incoming) {
    if (!merged.includes(value)) merged.push(value);
  }
  fs.writeFileSync(path.join(SCRIPT_DIR, name), `${merged.join('\n')}\n`, 'utf-8');
};

const validateConfig = () => {
  const firstNames = readConfigLines('nameFirst.txt');
  const lastNames = readConfigLines('nameLast.txt');
  const birthdays = readConfigLines('birthday.txt');
  const passwords = readConfigLines('password.txt');

  const missing = [];
  if (!firstNames.length) missing.push('first name pool (nameFirst.txt)');
  if (!lastNames.length) missing.push('last name pool (nameLast.txt)');
  if (!birthdays.length) missing.push('birthday');
  if (!passwords.length) missing.push('password pool (password.txt)');

  if (missing.length) {
    throw new Error(`Missing required config: ${missing.join(', ')}`);
  }

  return {
    firstName: firstNames[0],
    lastName: lastNames[0],
    birthday: birthdays[0],
    password: passwords[0],
    poolSizes: {
      firstNames: firstNames.length,
      lastNames: lastNames.length,
      birthdays: birthdays.length,
      passwords: passwords.length,
    },
  };
};

const parsePhoneFromOutput = () => {
  for (let i = processOutput.length - 1; i >= 0; i--) {
    const line = (processOutput[i].text || '').trim();
    let match = line.match(/ACCOUNT_PHONE=(\+\d[\d\s-]*)/);
    if (match) return match[1].replace(/\s+/g, '').trim();
    match = line.match(/ACCOUNT_CREATED email=\S+\s+phone=(\+\d[\d\s-]*)/);
    if (match) return match[1].replace(/\s+/g, '').trim();
    match = line.match(/(?:Entered phone|Using phone|Reusing active number|Phone:)\s*:?\s*(\+\d[\d\s-]*)/);
    if (match) return match[1].replace(/\s+/g, '').trim();
    match = line.match(/WARNING: Gmail address not detected\. Phone:\s*(\+\d[\d\s-]*)/);
    if (match) return match[1].replace(/\s+/g, '').trim();
    if (/^\+\d/.test(line)) return line.replace(/\s+/g, '').trim();
    if (/Using phone:?$/i.test(line) && i + 1 < processOutput.length) {
      const next = (processOutput[i + 1].text || '').trim();
      if (/^\+\d/.test(next)) return next.replace(/\s+/g, '').trim();
    }
  }
  return '';
};

const parseCreatedAccount = () => {
  const jsonPath = path.join(SCRIPT_DIR, 'last_created_account.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      if (data && data.completed && (data.email || data.phone)) {
        if (!data.phone) {
          data.phone = parsePhoneFromOutput();
        }
        return data;
      }
    } catch (e) {
      console.error('[PythonScript] Failed to parse last_created_account.json:', e.message);
    }
  }

  for (let i = processOutput.length - 1; i >= 0; i--) {
    const line = processOutput[i].text || '';
    const match = line.match(/ACCOUNT_CREATED email=([^\s]+)(?:\s+phone=(.+))?/);
    if (match) {
      return {
        email: match[1],
        phone: (match[2] || parsePhoneFromOutput() || '').replace(/\s+/g, '').trim(),
      };
    }
  }

  return null;
};

const parseOAuthCodeFromOutput = () => {
  for (let i = processOutput.length - 1; i >= 0; i--) {
    const match = (processOutput[i].text || '').match(/OAUTH_CODE=([^\s]+)/);
    if (match) return match[1];
  }
  return null;
};

const parsePartialAccount = () => {
  for (let i = processOutput.length - 1; i >= 0; i--) {
    const line = (processOutput[i].text || '').trim();
    const match = line.match(
      /ACCOUNT_PARTIAL firstName=([^\s]+) lastName=([^\s]+) phone=(\+\d[\d\s-]*)(?:\s+email=([^\s]+))?(?:\s+password=(.*))?/
    );
    if (match) {
      return {
        firstName: match[1],
        lastName: match[2],
        phone: match[3].replace(/\s+/g, '').trim(),
        intendedEmail: (match[4] || '').trim(),
        password: (match[5] || '').trim(),
        pending: true,
      };
    }
  }

  const jsonPath = path.join(SCRIPT_DIR, 'last_created_account.json');
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      if (data && !data.completed && (data.phone || data.firstName)) {
        return {
          firstName: data.firstName || '',
          lastName: data.lastName || '',
          phone: data.phone || parsePhoneFromOutput() || '',
          password: data.password || '',
          pending: true,
        };
      }
    } catch (e) {
      console.error('[PythonScript] Failed to parse partial account json:', e.message);
    }
  }

  return null;
};

const buildPendingEmail = (firstName, lastName, phone) => {
  const digits = (phone || '').replace(/\D/g, '') || String(Date.now());
  const fn = (firstName || 'pending').toLowerCase().replace(/[^a-z0-9]/g, '') || 'user';
  const ln = (lastName || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'signup';
  return `${fn}.${ln}.${digits.slice(-10)}@pending.local`;
};

const isPendingScriptAccount = (acc) => {
  if (!acc) return false;
  const email = (acc.email || '').toLowerCase();
  return (
    email.endsWith('@pending.local') ||
    acc.googleId.startsWith('pending_') ||
    acc.googleId.startsWith('script_')
  );
};

const registerPendingScriptAccount = async (userId, data) => {
  const phoneNumber = (data.phone || data.phoneNumber || '').trim();
  const firstName = (data.firstName || '').trim();
  const lastName = (data.lastName || '').trim();
  const intendedEmail = (data.intendedEmail || data.email || '').trim().toLowerCase();
  const email = buildPendingEmail(firstName, lastName, phoneNumber);

  const name = `${firstName} ${lastName}`.trim() || email.split('@')[0];
  const idSeed = `${email}:${phoneNumber}`;
  const placeholderGoogleId = `pending_${crypto.createHash('sha256').update(`${userId}:${idSeed}`).digest('hex').slice(0, 24)}`;

  let account = await GoogleAccount.findOne({ user: userId, email });

  if (!account && phoneNumber) {
    const phoneMatches = await GoogleAccount.find({ user: userId, phoneNumber });
    account = phoneMatches.find(isPendingScriptAccount) || null;
  }

  if (account && !isPendingScriptAccount(account)) {
    console.warn(
      `[PythonScript] Phone ${phoneNumber} already on real account ${account.email} — creating separate pending entry`
    );
    account = null;
  }

  if (account) {
    account.name = name;
    account.phoneNumber = phoneNumber;
    account.status = 'disconnected';
    account.signupStatus = 'failed';
    account.googleId = placeholderGoogleId;
    await account.save();
    return { account, intendedEmail };
  }

  account = await GoogleAccount.create({
    user: userId,
    googleId: placeholderGoogleId,
    email,
    name,
    phoneNumber,
    accessToken: encrypt('PENDING_SCRIPT_OAUTH'),
    isActive: true,
    status: 'disconnected',
    signupStatus: 'failed',
  });

  return { account, intendedEmail };
};

const registerScriptAccount = async (userId, data) => {
  const email = (data.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new Error('Cannot save account without a valid Gmail address');
  }

  const name = (data.name || `${data.firstName || ''} ${data.lastName || ''}`).trim() || email.split('@')[0];
  const phoneNumber = (data.phone || data.phoneNumber || '').trim();
  const placeholderGoogleId = `script_${crypto.createHash('sha256').update(`${userId}:${email}`).digest('hex').slice(0, 24)}`;

  let account = await GoogleAccount.findOne({ user: userId, email });

  if (account) {
    account.name = name;
    if (phoneNumber) account.phoneNumber = phoneNumber;
    account.signupStatus = 'success';
    if (account.googleId.startsWith('script_')) {
      account.status = 'disconnected';
    }
    await account.save();
    return account;
  }

  account = await GoogleAccount.create({
    user: userId,
    googleId: placeholderGoogleId,
    email,
    name,
    phoneNumber,
    accessToken: encrypt('PENDING_SCRIPT_OAUTH'),
    isActive: true,
    status: 'disconnected',
    signupStatus: 'success',
  });

  return account;
};

// Track running process
let runningProcess = null;
let processOutput = [];
let processStatus = 'idle'; // idle | running | completed | error

/**
 * @desc    Run the youtube_signin.py script
 * @route   POST /api/python-script/run
 * @access  Private
 */
const runScript = async (req, res, next) => {
  try {
    if (runningProcess) {
      res.status(409);
      throw new Error('A script is already running. Stop it first or wait for it to complete.');
    }

    // Set SSE headers for real-time streaming
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    processOutput = [];
    processStatus = 'running';

    const sendEvent = (type, data) => {
      try {
        res.write(`data: ${JSON.stringify({ type, data, timestamp: new Date().toISOString() })}\n\n`);
      } catch (e) {
        // Client may have disconnected
      }
    };

    // Validate config files before spawning
    try {
      validateConfig();
    } catch (configErr) {
      processStatus = 'error';
      sendEvent('error', configErr.message);
      sendEvent('done', { exitCode: 1, status: 'error' });
      return res.end();
    }

    if (!fs.existsSync(SCRIPT_PATH)) {
      processStatus = 'error';
      sendEvent('error', `Script not found: ${SCRIPT_PATH}`);
      sendEvent('done', { exitCode: 1, status: 'error' });
      return res.end();
    }

    const { firstName, lastName, password, birthday } = req.body || {};
    const fivesimCountry = (req.body?.fivesimCountry || process.env.FIVESIM_COUNTRY || 'any').trim().toLowerCase();
    const fivesimOperator = (req.body?.fivesimOperator || process.env.FIVESIM_OPERATOR || 'any').trim().toLowerCase();
    const fivesimProduct = (req.body?.fivesimProduct || process.env.FIVESIM_PRODUCT || 'google').trim().toLowerCase();

    sendEvent('status', `Starting account creation script for ${firstName || 'random'} ${lastName || 'random'}...`);

    if (!process.env.FIVESIM_API_KEY) {
      processStatus = 'error';
      sendEvent('error', 'Phone verification API key is missing in .env.');
      sendEvent('done', { exitCode: 1, status: 'error' });
      return res.end();
    }

    // Clear previous run result so a failed run cannot trigger auto-connect
    const lastCreatedPath = path.join(SCRIPT_DIR, 'last_created_account.json');
    if (fs.existsSync(lastCreatedPath)) {
      try { fs.unlinkSync(lastCreatedPath); } catch (e) {}
    }

    const spawnEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      DOTENV_PATH: ENV_PATH,
    };
    if (firstName) spawnEnv.SCRIPT_FIRST_NAME = String(firstName).trim();
    if (lastName) spawnEnv.SCRIPT_LAST_NAME = String(lastName).trim();
    if (password) spawnEnv.SCRIPT_PASSWORD = String(password).trim();
    if (birthday) spawnEnv.SCRIPT_BIRTHDAY = String(birthday).trim();
    spawnEnv.FIVESIM_COUNTRY = fivesimCountry;
    spawnEnv.FIVESIM_OPERATOR = fivesimOperator;
    spawnEnv.FIVESIM_PRODUCT = fivesimProduct;

    // Spawn the Python process with project .env available
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    runningProcess = spawn(pythonCmd, [SCRIPT_PATH], {
      cwd: SCRIPT_DIR,
      env: spawnEnv,
    });

    runningProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => {
        processOutput.push({ type: 'stdout', text: line, time: new Date().toISOString() });
        sendEvent('log', line);
        console.log(`[PythonScript] ${line}`);
      });
    });

    runningProcess.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => {
        processOutput.push({ type: 'stderr', text: line, time: new Date().toISOString() });
        sendEvent('error', line);
        console.error(`[PythonScript] stderr: ${line}`);
      });
    });

    const userId = req.user._id;

    runningProcess.on('close', async (code) => {
      let createdAccount = parseCreatedAccount();
      const partialAccount = parsePartialAccount();
      const oauthCode = parseOAuthCodeFromOutput();
      const phoneNumber = (
        createdAccount?.phone ||
        createdAccount?.phoneNumber ||
        partialAccount?.phone ||
        parsePhoneFromOutput() ||
        ''
      ).trim();

      if (createdAccount && phoneNumber && !createdAccount.phone) {
        createdAccount.phone = phoneNumber;
      }

      const scriptSucceeded = code === 0;
      processStatus = scriptSucceeded ? 'completed' : 'error';

      if (!scriptSucceeded && !oauthCode) {
        createdAccount = null;
      }

      const savePendingOnFailure = async () => {
        const pendingData = {
          firstName: partialAccount?.firstName || firstName || '',
          lastName: partialAccount?.lastName || lastName || '',
          password: partialAccount?.password || password || '',
          phone: phoneNumber,
          intendedEmail: partialAccount?.intendedEmail || partialAccount?.email || '',
        };
        if (!pendingData.phone && !pendingData.firstName) return null;

        try {
          const { account: saved, intendedEmail } = await registerPendingScriptAccount(userId, pendingData);
          const result = {
            email: saved.email,
            intendedEmail: intendedEmail || '',
            name: saved.name,
            phone: saved.phoneNumber || phoneNumber,
            accountId: saved._id.toString(),
            dbStatus: saved.status,
            signupStatus: 'failed',
            pending: true,
            firstName: pendingData.firstName,
            lastName: pendingData.lastName,
          };
          sendEvent(
            'log',
            `Saved pending account: ${saved.name} (${saved.email})${saved.phoneNumber ? ` phone: ${saved.phoneNumber}` : ''}${intendedEmail ? ` gmail: ${intendedEmail}` : ''}`
          );
          console.log(`[PythonScript] Saved pending account: ${saved.email} (${saved._id})`);
          return result;
        } catch (err) {
          sendEvent('error', `Pending account save failed: ${err.message}`);
          console.error('[PythonScript] Pending save error:', err.message);
          return null;
        }
      };

      if (oauthCode) {
        try {
          const saved = await exchangeCodeAndSaveAccount(userId, oauthCode, {
            redirectUri: getScriptOAuthRedirectUri(),
            phoneNumber,
          });
          createdAccount = {
            ...(createdAccount || {}),
            email: saved.email,
            name: saved.name,
            accountId: saved.accountId,
            googleId: saved.googleId,
            phone: saved.phoneNumber || phoneNumber,
            dbStatus: 'connected',
            oauthConnected: true,
          };
          sendEvent('log', `Google OAuth tokens saved for ${saved.email}${saved.phoneNumber ? ` (phone: ${saved.phoneNumber})` : ''}`);
          console.log(`[PythonScript] OAuth tokens saved: ${saved.email} (googleId: ${saved.googleId}, phone: ${saved.phoneNumber || phoneNumber || 'none'})`);
        } catch (err) {
          sendEvent('error', `OAuth token save failed: ${err.message}`);
          console.error('[PythonScript] OAuth save error:', err.message);
          if (createdAccount?.email) {
            try {
              const saved = await registerScriptAccount(userId, { ...createdAccount, phone: phoneNumber });
              createdAccount.accountId = saved._id.toString();
              createdAccount.dbStatus = saved.status;
              createdAccount.phone = saved.phoneNumber || phoneNumber;
              sendEvent('log', `Saved account without tokens: ${saved.email}`);
            } catch (dbErr) {
              sendEvent('error', `Database save failed: ${dbErr.message}`);
            }
          }
        }
      } else if (createdAccount?.email) {
        try {
          const saved = await registerScriptAccount(userId, { ...createdAccount, phone: phoneNumber });
          createdAccount = {
            ...createdAccount,
            phone: saved.phoneNumber || phoneNumber,
            accountId: saved._id.toString(),
            dbStatus: saved.status,
            signupStatus: 'success',
          };
          sendEvent('log', `Saved to database: ${saved.email}${saved.phoneNumber ? ` (phone: ${saved.phoneNumber})` : ''}`);
          console.log(`[PythonScript] Saved account to DB: ${saved.email} (${saved._id}, phone: ${saved.phoneNumber || 'none'})`);
        } catch (err) {
          sendEvent('error', `Database save failed: ${err.message}`);
          console.error('[PythonScript] DB save error:', err.message);
        }
      } else if (phoneNumber && code !== 0) {
        sendEvent('error', `Signup failed (exit ${code}). Saving partial account for phone ${phoneNumber}.`);
        const pendingSaved = await savePendingOnFailure();
        if (pendingSaved) {
          createdAccount = pendingSaved;
        }
      } else if (code !== 0) {
        const pendingSaved = await savePendingOnFailure();
        if (pendingSaved) {
          createdAccount = pendingSaved;
        }
      }

      sendEvent('done', { exitCode: code, status: processStatus, account: createdAccount });
      console.log(`[PythonScript] Process exited with code ${code}`);
      if (createdAccount?.email) {
        console.log(`[PythonScript] Created account: ${createdAccount.email}`);
      }
      runningProcess = null;
      res.end();
    });

    runningProcess.on('error', (err) => {
      processStatus = 'error';
      sendEvent('error', `Failed to start script: ${err.message}`);
      console.error(`[PythonScript] Spawn error: ${err.message}`);
      runningProcess = null;
      res.end();
    });

    // Handle client disconnect
    req.on('close', () => {
      if (runningProcess) {
        console.log('[PythonScript] Client disconnected, but script continues running.');
      }
    });

  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get the status of the Python script
 * @route   GET /api/python-script/status
 * @access  Private
 */
const getScriptStatus = async (req, res, next) => {
  try {
    res.status(200).json({
      status: processStatus,
      isRunning: !!runningProcess,
      outputLines: processOutput.length,
      lastOutput: processOutput.length > 0 ? processOutput[processOutput.length - 1] : null,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Stop a running Python script
 * @route   POST /api/python-script/stop
 * @access  Private
 */
const stopScript = async (req, res, next) => {
  try {
    if (!runningProcess) {
      return res.status(200).json({ message: 'No script is currently running.' });
    }

    runningProcess.kill('SIGTERM');
    // Force kill after 5 seconds if still alive
    setTimeout(() => {
      if (runningProcess) {
        try { runningProcess.kill('SIGKILL'); } catch (e) {}
      }
    }, 5000);

    processStatus = 'idle';
    res.status(200).json({ message: 'Script stop signal sent.' });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get current script configuration
 * @route   GET /api/python-script/config
 * @access  Private
 */
const getConfig = async (req, res, next) => {
  try {
    res.status(200).json({
      firstName: readConfigLines('nameFirst.txt')[0] || '',
      lastName: readConfigLines('nameLast.txt')[0] || '',
      firstNames: readConfigLines('nameFirst.txt'),
      lastNames: readConfigLines('nameLast.txt'),
      birthday: readConfigLines('birthday.txt')[0] || '',
      birthdays: readConfigLines('birthday.txt'),
      password: readConfigLines('password.txt')[0] || '',
      passwords: readConfigLines('password.txt'),
      fivesim: {
        country: (process.env.FIVESIM_COUNTRY || 'any').trim().toLowerCase(),
        operator: (process.env.FIVESIM_OPERATOR || 'any').trim().toLowerCase(),
        product: (process.env.FIVESIM_PRODUCT || 'google').trim().toLowerCase(),
        hasApiKey: Boolean(process.env.FIVESIM_API_KEY),
      },
      poolSizes: {
        firstNames: readConfigLines('nameFirst.txt').length,
        lastNames: readConfigLines('nameLast.txt').length,
        birthdays: readConfigLines('birthday.txt').length,
        passwords: readConfigLines('password.txt').length,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update script configuration files before running
 * @route   POST /api/python-script/config
 * @access  Private
 */
const updateConfig = async (req, res, next) => {
  try {
    const { firstName, lastName, birthday, password } = req.body;

    if (firstName) appendUniqueLines('nameFirst.txt', firstName);
    if (lastName) appendUniqueLines('nameLast.txt', lastName);
    if (birthday) appendUniqueLines('birthday.txt', birthday);
    if (password) appendUniqueLines('password.txt', password);

    res.status(200).json({
      message: 'Configuration updated successfully.',
      poolSizes: {
        firstNames: readConfigLines('nameFirst.txt').length,
        lastNames: readConfigLines('nameLast.txt').length,
        birthdays: readConfigLines('birthday.txt').length,
        passwords: readConfigLines('password.txt').length,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Save a script-created account to the database
 * @route   POST /api/python-script/register-account
 * @access  Private
 */
const registerAccount = async (req, res, next) => {
  try {
    const account = await registerScriptAccount(req.user._id, req.body);
    res.status(201).json({
      message: 'Account saved to database',
      accountId: account._id,
      email: account.email,
      name: account.name,
      phoneNumber: account.phoneNumber || '',
      status: account.status,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get recent output/logs from the last script run
 * @route   GET /api/python-script/logs
 * @access  Private
 */
const getLogs = async (req, res, next) => {
  try {
    res.status(200).json({
      status: processStatus,
      logs: processOutput,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  runScript,
  getScriptStatus,
  stopScript,
  getConfig,
  updateConfig,
  getLogs,
  registerAccount,
};

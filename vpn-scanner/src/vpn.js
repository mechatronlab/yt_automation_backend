/**
 * vpn.js — VPN connect/disconnect module
 * Supports two providers:
 *   - "openvpn"  — community OpenVPN CLI (requires sudo on macOS)
 *   - "connect"  — OpenVPN Connect macOS app (uses app login/session)
 */

import { execFile, exec, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TMP_DIR = path.resolve(__dirname, '..', '.tmp');

/** Ensure the temp directory exists */
function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
}

/** Promise wrapper around exec */
function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        return reject(error);
      }
      resolve({ stdout, stderr });
    });
  });
}

/** Sleep for ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── State ──────────────────────────────────────────────────────────

let activePid = null;
let activeProfileId = null;
let activeProvider = null;

/**
 * Load variables from parent .env file if it exists.
 */
function loadParentEnv() {
  try {
    const envPath = path.resolve(__dirname, '..', '..', '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const idx = trimmed.indexOf('=');
          const key = trimmed.slice(0, idx).trim();
          const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
          if (key && !process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch { /* ignore */ }
}

// ─── Auth helpers ───────────────────────────────────────────────────

/**
 * Resolve the auth file path. If a static authFile is configured, use it.
 * Otherwise, create a temp auth file from env vars or config auth object.
 */
function resolveAuthFile(config) {
  // Load parent .env variables if necessary
  if (config.envAuth) {
    loadParentEnv();
  }

  // 1. Explicit authFile in config
  if (config.authFile && fs.existsSync(config.authFile)) {
    return config.authFile;
  }

  // 2. Environment variables
  let user = '';
  let pass = '';

  if (config.envAuth) {
    user = process.env.OPENVPN_USER || process.env.OVPN_AUTH_USER || '';
    pass = process.env.OPENVPN_PASS || process.env.OVPN_AUTH_PASS || '';
  }

  // 3. Inline config auth
  if (!user && config.auth?.user) {
    user = config.auth.user;
    pass = config.auth.pass || '';
  }

  if (!user) return null;

  ensureTmpDir();
  const authPath = path.join(TMP_DIR, 'auth.txt');
  fs.writeFileSync(authPath, `${user}\n${pass}\n`, { mode: 0o600 });
  return authPath;
}

// ─── OpenVPN Community CLI provider ─────────────────────────────────

async function openvpnConnect(configPath, config) {
  ensureTmpDir();

  const profileId = `scan_${Date.now()}`;
  const pidFile = path.join(TMP_DIR, `${profileId}.pid`);
  const logFile = path.join(TMP_DIR, `${profileId}.log`);

  // Pre-create log file
  try {
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  } catch { /* ignore */ }
  fs.writeFileSync(logFile, '', { mode: 0o644 });

  const openvpnBin = config.openvpnBin || '/usr/local/opt/openvpn/sbin/openvpn';

  // Build command args
  const args = [
    openvpnBin,
    '--config', configPath,
    '--daemon', profileId,
    '--writepid', pidFile,
    '--log', logFile,
  ];

  const authFile = resolveAuthFile(config);
  if (authFile) {
    args.push('--auth-user-pass', authFile);
  }

  const cmd = `sudo ${args.map((a) => `"${a}"`).join(' ')}`;
  console.log(`[vpn] Connecting: ${cmd}`);

  // Execute the daemon start command
  await execPromise(cmd);

  // Poll the log for success/failure
  const timeout = config.connectTimeout || 20000;
  const pollInterval = 500;
  const maxPolls = Math.ceil(timeout / pollInterval);

  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollInterval);

    let logContent = '';
    try {
      if (fs.existsSync(logFile)) {
        logContent = fs.readFileSync(logFile, 'utf8');
      }
    } catch { /* ignore */ }

    if (logContent.includes('Initialization Sequence Completed')) {
      // Success — read the PID
      let pid = null;
      try {
        if (fs.existsSync(pidFile)) {
          pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        }
      } catch { /* ignore */ }

      // Also try pgrep as backup
      if (!pid) {
        try {
          const { stdout } = await execPromise(`pgrep -f "${profileId}"`);
          const pids = stdout.trim().split('\n').map(Number).filter((n) => n > 0);
          if (pids.length) pid = pids[0];
        } catch { /* ignore */ }
      }

      activePid = pid;
      activeProfileId = profileId;
      activeProvider = 'openvpn';

      console.log(`[vpn] ✅ Connected (PID: ${pid})`);
      return { provider: 'openvpn', profileId, pid, connected: true };
    }

    if (logContent.includes('AUTH_FAILED') || logContent.includes('auth-failure')) {
      throw new Error('Authentication failed — check VPN credentials.');
    }

    if (logContent.includes('Connection refused') || logContent.includes('SIGTERM')) {
      throw new Error('Connection refused or process terminated.');
    }

    // Check if process exited prematurely
    if (i > 4) {
      try {
        const { stdout } = await execPromise(`pgrep -f "${profileId}"`);
        if (!stdout.trim()) {
          // Read last few lines of log for context
          const lastLines = logContent.split('\n').slice(-5).join('\n');
          throw new Error(`OpenVPN process exited unexpectedly.\n${lastLines}`);
        }
      } catch (e) {
        if (e.message.includes('OpenVPN process exited')) throw e;
        // pgrep itself failed, ignore
      }
    }
  }

  // Timeout — clean up
  try {
    await execPromise('sudo killall openvpn 2>/dev/null');
  } catch { /* ignore */ }

  throw new Error(`Connection timed out after ${timeout}ms.`);
}

async function openvpnDisconnect() {
  console.log('[vpn] Disconnecting (openvpn)...');
  try {
    await execPromise('sudo killall openvpn 2>/dev/null');
  } catch { /* ignore — may not be running */ }

  // Clean up temp files
  try {
    if (fs.existsSync(TMP_DIR)) {
      const files = fs.readdirSync(TMP_DIR);
      for (const f of files) {
        if (f.endsWith('.pid') || f.endsWith('.log')) {
          try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }

  activePid = null;
  activeProfileId = null;
  activeProvider = null;
  console.log('[vpn] Disconnected.');
}

// ─── OpenVPN Connect App provider ───────────────────────────────────

async function connectAppConnect(configPath, config) {
  ensureTmpDir();

  const profileId = `scan_${Date.now()}`;
  const absConfigPath = path.resolve(configPath);

  console.log(`[vpn] Connecting via OpenVPN Connect app: ${absConfigPath}`);

  // Step 1: Import the profile into OpenVPN Connect
  try {
    await execPromise(`open -a "OpenVPN Connect" "${absConfigPath}"`);
  } catch (e) {
    throw new Error(`Failed to open OpenVPN Connect: ${e.message}. Is the app installed?`);
  }

  // Step 2: Wait for connection — poll by checking for utun interfaces
  const timeout = config.connectTimeout || 20000;
  const pollInterval = 1000;
  const maxPolls = Math.ceil(timeout / pollInterval);

  // Give the app time to import and start connecting
  await sleep(3000);

  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollInterval);

    try {
      // Check for active utun interfaces (VPN tunnel)
      const { stdout } = await execPromise('ifconfig | grep -c "utun"');
      const utunCount = parseInt(stdout.trim(), 10);
      if (utunCount > 0) {
        // Verify connectivity
        try {
          const checkUrl = config.checkUrl || 'https://api.ipify.org?format=json';
          await execPromise(`curl -s --max-time 5 "${checkUrl}"`);
          
          activeProfileId = profileId;
          activeProvider = 'connect';
          activePid = null;

          console.log('[vpn] ✅ Connected via OpenVPN Connect');
          return { provider: 'connect', profileId, pid: null, connected: true };
        } catch { /* not yet ready */ }
      }
    } catch { /* ignore */ }
  }

  throw new Error(`OpenVPN Connect: connection timed out after ${timeout}ms.`);
}

async function connectAppDisconnect() {
  console.log('[vpn] Disconnecting (OpenVPN Connect app)...');
  try {
    // Use AppleScript to quit/disconnect
    await execPromise(`osascript -e 'tell application "OpenVPN Connect" to quit'`);
  } catch { /* ignore */ }

  await sleep(2000);

  activePid = null;
  activeProfileId = null;
  activeProvider = null;
  console.log('[vpn] Disconnected (OpenVPN Connect).');
}

// ─── Unified Interface ─────────────────────────────────────────────

/**
 * Connect to a VPN server using the configured provider.
 * @param {string} configPath - Absolute path to the .ovpn file
 * @param {object} config - Parsed config.json
 * @returns {Promise<{provider, profileId, pid, connected}>}
 */
export async function connect(configPath, config) {
  // Ensure any previous connection is cleaned up
  await disconnect(config);

  const provider = config.provider || 'openvpn';

  if (provider === 'connect') {
    return connectAppConnect(configPath, config);
  }
  return openvpnConnect(configPath, config);
}

/**
 * Disconnect the current VPN connection.
 * @param {object} config - Parsed config.json
 */
export async function disconnect(config) {
  const provider = activeProvider || config?.provider || 'openvpn';

  if (provider === 'connect') {
    return connectAppDisconnect();
  }
  return openvpnDisconnect();
}

/**
 * Get the current VPN connection status.
 */
export async function status() {
  // Check if openvpn is running
  let openvpnRunning = false;
  let pids = [];
  try {
    const { stdout } = await execPromise('pgrep -x openvpn');
    if (stdout.trim()) {
      openvpnRunning = true;
      pids = stdout.trim().split('\n').map(Number).filter((n) => n > 0);
    }
  } catch { /* not running */ }

  return {
    connected: openvpnRunning,
    provider: activeProvider,
    profileId: activeProfileId,
    pid: activePid,
    pids,
  };
}

/**
 * Force kill all openvpn processes. Used by clean script.
 */
export async function killAll() {
  try {
    await execPromise('sudo killall openvpn 2>/dev/null');
  } catch { /* ignore */ }

  activePid = null;
  activeProfileId = null;
  activeProvider = null;

  // Clean tmp dir
  try {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}

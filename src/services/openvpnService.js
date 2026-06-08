const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const VpnProfile = require('../models/VpnProfile');

const OVPN_AUTH_USER = process.env.OVPN_AUTH_USER || '';
const OVPN_AUTH_PASS = process.env.OVPN_AUTH_PASS || '';
const OVPN_PID_DIR = path.resolve(process.env.OVPN_PID_DIR || path.join(process.cwd(), 'vpn_pids'));
const OVPN_BIN = process.env.OVPN_BIN || '/usr/local/opt/openvpn/sbin/openvpn';
const OVPN_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'ovpn');

/**
 * Ensure the PID directory exists
 */
const ensurePidDir = () => {
  if (!fs.existsSync(OVPN_PID_DIR)) {
    fs.mkdirSync(OVPN_PID_DIR, { recursive: true });
  }
};

/**
 * Ensure the OVPN upload directory exists
 */
const ensureUploadDir = () => {
  if (!fs.existsSync(OVPN_UPLOAD_DIR)) {
    fs.mkdirSync(OVPN_UPLOAD_DIR, { recursive: true });
  }
};

/**
 * Save an uploaded .ovpn file to disk and create/update the VpnProfile in DB.
 * @param {Object} file - multer file object (has .buffer, .originalname, etc.)
 * @param {String} googleAccountId - the Google account ID to associate with
 * @param {String} userId - the authenticated user's ID
 * @returns {Object} the created/updated VpnProfile document
 */
const saveUploadedConfig = async (file, googleAccountId, userId) => {
  ensureUploadDir();

  const storedFileName = `${googleAccountId}.ovpn`;
  const storedPath = path.join(OVPN_UPLOAD_DIR, storedFileName);

  // Write the file to disk (overwrite if exists)
  fs.writeFileSync(storedPath, file.buffer);

  // Derive a server location hint from the original filename (best effort)
  const originalName = file.originalname || 'unknown.ovpn';
  const serverLocation = originalName.replace('.ovpn', '').replace(/[-_]/g, ' ');

  // Check if a profile already exists for this account
  let vpnProfile = await VpnProfile.findOne({ googleAccount: googleAccountId });

  if (vpnProfile) {
    // Update existing profile
    vpnProfile.configFileName = storedFileName;
    vpnProfile.originalFileName = originalName;
    vpnProfile.configPath = storedPath;
    vpnProfile.serverLocation = serverLocation;
    await vpnProfile.save();
    console.log(`[VPN] Updated config for account ${googleAccountId}: "${originalName}"`);
  } else {
    // Create new profile
    vpnProfile = await VpnProfile.create({
      googleAccount: googleAccountId,
      user: userId,
      configFileName: storedFileName,
      originalFileName: originalName,
      configPath: storedPath,
      serverLocation,
    });
    console.log(`[VPN] Saved config for account ${googleAccountId}: "${originalName}"`);
  }

  return vpnProfile;
};

/**
 * Create an auth file for OpenVPN if credentials are configured.
 * Returns the auth file path or null.
 */
const createAuthFile = () => {
  if (!OVPN_AUTH_USER || !OVPN_AUTH_PASS) {
    return null;
  }

  ensurePidDir();
  const authFilePath = path.join(OVPN_PID_DIR, 'vpn_auth.txt');
  fs.writeFileSync(authFilePath, `${OVPN_AUTH_USER}\n${OVPN_AUTH_PASS}\n`, { mode: 0o600 });
  return authFilePath;
};

/**
 * Helper to get the PID of a running openvpn process by its daemon name
 */
const getPidByName = (daemonName) => {
  return new Promise((resolve) => {
    exec(`pgrep -f "${daemonName}"`, (error, stdout) => {
      if (!error && stdout.trim()) {
        const pids = stdout.trim().split('\n').map(Number).filter(n => n > 0);
        if (pids.length > 0) {
          return resolve(pids[0]);
        }
      }
      resolve(null);
    });
  });
};

/**
 * Connect to VPN using the given VpnProfile.
 * Starts openvpn as a daemon and records the PID.
 */
const connect = (vpnProfile) => {
  return new Promise((resolve, reject) => {
    if (!vpnProfile || !vpnProfile.configPath) {
      return reject(new Error('Invalid VPN profile'));
    }

    if (!fs.existsSync(vpnProfile.configPath)) {
      return reject(new Error(`Config file not found: ${vpnProfile.configPath}`));
    }

    ensurePidDir();

    const pidFile = path.join(OVPN_PID_DIR, `vpn_${vpnProfile._id}.pid`);
    const logFile = path.join(OVPN_PID_DIR, `vpn_${vpnProfile._id}.log`);

    // Pre-create the log file with readable permissions so the node process can read it.
    // We try to delete the old log file first (which might be root-owned) to avoid permission issues.
    try {
      if (fs.existsSync(logFile)) {
        fs.unlinkSync(logFile);
      }
    } catch (unlinkError) {
      console.warn(`[VPN] Warning: could not delete existing log file: ${unlinkError.message}`);
    }

    try {
      fs.writeFileSync(logFile, '', { mode: 0o644 });
    } catch (e) {
      console.warn(`[VPN] Warning: could not pre-create log file: ${e.message}`);
    }

    // Build the openvpn command arguments
    const args = [
      OVPN_BIN,
      '--config', vpnProfile.configPath,
      '--daemon', `vpn_${vpnProfile._id}`,
      '--writepid', pidFile,
      '--log', logFile,
    ];

    // Add auth file if credentials are configured
    const authFile = createAuthFile();
    if (authFile) {
      args.push('--auth-user-pass', authFile);
    }

    console.log(`[VPN] Connecting: sudo ${args.join(' ')}`);

    exec(`sudo ${args.map(a => `"${a}"`).join(' ')}`, async (error, stdout, stderr) => {
      if (error) {
        console.error(`[VPN] Connection error: ${error.message}`);
        return reject(new Error(`Failed to connect VPN: ${error.message}`));
      }

      // Poll the log file to wait for success or failure
      const maxRetries = 30; // 30 * 500ms = 15 seconds max wait
      let retryCount = 0;
      let connected = false;
      let authFailed = false;
      let processExited = false;
      let pid = null;

      const pollInterval = setInterval(async () => {
        retryCount++;

        // 1. Try to find the PID
        if (!pid) {
          pid = await getPidByName(`vpn_${vpnProfile._id}`);
        }

        // 2. Check if the process is still running (if PID was found)
        if (pid) {
          let running = false;
          try {
            process.kill(pid, 0);
            running = true;
          } catch (e) {
            running = e.code === 'EPERM'; // EPERM means it is running as root (i.e. still active)
          }
          if (!running) {
            processExited = true;
          }
        }

        // 3. Read and inspect the logs
        let logContent = '';
        try {
          if (fs.existsSync(logFile)) {
            logContent = fs.readFileSync(logFile, 'utf8');
          }
        } catch (readError) {
          console.warn(`[VPN] Error reading log file during poll: ${readError.message}`);
        }

        if (logContent.includes('Initialization Sequence Completed')) {
          connected = true;
        } else if (logContent.includes('AUTH_FAILED') || logContent.includes('auth-failure')) {
          authFailed = true;
        }

        // 4. Determine outcome
        if (connected || authFailed || processExited || retryCount >= maxRetries) {
          clearInterval(pollInterval);

          if (connected && !processExited) {
            // Success! Save state in DB and resolve.
            vpnProfile.isConnected = true;
            vpnProfile.pid = pid;
            await vpnProfile.save();
            console.log(`[VPN] Connected successfully via "${vpnProfile.originalFileName || vpnProfile.configFileName}" (PID: ${pid})`);
            resolve(vpnProfile);
          } else {
            // Failure or timeout. Clean up and disconnect.
            console.error(`[VPN] Connection failed during startup. connected=${connected}, authFailed=${authFailed}, processExited=${processExited}`);
            
            // Clean up database and kill process
            await disconnect(vpnProfile);

            if (authFailed) {
              reject(new Error('Authentication failed. Please check your VPN credentials in the .env file.'));
            } else if (processExited) {
              reject(new Error('VPN process exited unexpectedly. See VPN logs for details.'));
            } else {
              reject(new Error('VPN connection timed out. Please check your network or server configuration.'));
            }
          }
        }
      }, 500);
    });
  });
};

/**
 * Disconnect a specific VPN profile by killing its openvpn process.
 */
const disconnect = async (vpnProfile) => {
  if (!vpnProfile) return;

  // Kill OpenVPN using NOPASSWD-enabled killall (sudo kill requires a password under user's sudoers)
  try {
    await new Promise((resolve) => {
      exec('sudo killall openvpn 2>/dev/null', () => {
        resolve();
      });
    });
  } catch (e) {
    console.warn(`[VPN] Killall error: ${e.message}`);
  }

  // Clean up PID file
  const pidFile = path.join(OVPN_PID_DIR, `vpn_${vpnProfile._id}.pid`);
  try {
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  } catch (e) {
    // Ignore
  }

  // Update DB
  vpnProfile.isConnected = false;
  vpnProfile.pid = null;
  await vpnProfile.save();

  console.log(`[VPN] Disconnected "${vpnProfile.originalFileName || vpnProfile.configFileName || 'unknown'}"`);
};

/**
 * Disconnect ALL active VPN connections managed by this app.
 */
const disconnectAll = async () => {
  // Kill all openvpn processes
  return new Promise((resolve) => {
    exec('sudo killall openvpn 2>/dev/null', async (error) => {
      // Mark all profiles as disconnected
      await VpnProfile.updateMany(
        { isConnected: true },
        { $set: { isConnected: false, pid: null } }
      );

      // Clean up all PID files
      try {
        if (fs.existsSync(OVPN_PID_DIR)) {
          const pidFiles = fs.readdirSync(OVPN_PID_DIR).filter((f) => f.endsWith('.pid'));
          pidFiles.forEach((f) => {
            try { fs.unlinkSync(path.join(OVPN_PID_DIR, f)); } catch (e) { /* ignore */ }
          });
        }
      } catch (e) {
        // Ignore
      }

      console.log('[VPN] All VPN connections disconnected');
      resolve();
    });
  });
};

const getStatus = () => {
  return new Promise((resolve) => {
    exec('pgrep -x openvpn', (error, stdout) => {
      const isRunning = !error && stdout.trim().length > 0;
      const pids = isRunning ? stdout.trim().split('\n').map(Number) : [];

      // Get current public IP and location info from ip-api
      exec('curl -s --max-time 5 http://ip-api.com/json/', (ipError, ipStdout) => {
        let publicIp = 'Unable to determine';
        let country = 'Unknown';
        let city = 'Unknown';
        let isp = 'Unknown';

        if (!ipError) {
          try {
            const data = JSON.parse(ipStdout.trim());
            if (data.status === 'success') {
              publicIp = data.query || publicIp;
              country = data.country || country;
              city = data.city || city;
              isp = data.isp || isp;
            } else {
              publicIp = data.query || publicIp;
            }
          } catch (e) {
            if (ipStdout.trim()) publicIp = ipStdout.trim();
          }
        }

        resolve({
          isVpnActive: isRunning,
          activePids: pids,
          publicIp,
          country,
          city,
          isp,
        });
      });
    });
  });
};

/**
 * Release (unassign) a VPN config from a Google account.
 * This deletes the VpnProfile AND the uploaded .ovpn file from disk.
 */
const releaseConfig = async (googleAccountId) => {
  const profile = await VpnProfile.findOne({ googleAccount: googleAccountId });
  if (!profile) return;

  // Disconnect first if connected
  if (profile.isConnected) {
    await disconnect(profile);
  }

  // Clean up PID and log files
  const pidFile = path.join(OVPN_PID_DIR, `vpn_${profile._id}.pid`);
  const logFile = path.join(OVPN_PID_DIR, `vpn_${profile._id}.log`);
  try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch (e) { /* ignore */ }
  try { if (fs.existsSync(logFile)) fs.unlinkSync(logFile); } catch (e) { /* ignore */ }

  // Delete the uploaded .ovpn file from disk
  try {
    if (profile.configPath && fs.existsSync(profile.configPath)) {
      fs.unlinkSync(profile.configPath);
      console.log(`[VPN] Deleted uploaded config file: ${profile.configPath}`);
    }
  } catch (e) {
    console.warn(`[VPN] Could not delete config file: ${e.message}`);
  }

  await profile.deleteOne();
  console.log(`[VPN] Released config "${profile.originalFileName || profile.configFileName || 'unknown'}" from account ${googleAccountId}`);
};

/**
 * Verify if a specific profile's process is actually running in the OS
 */
const isProfileConnected = async (vpnProfile) => {
  if (!vpnProfile || !vpnProfile.isConnected || !vpnProfile.pid) {
    return false;
  }

  // Check if PID exists
  let running = false;
  try {
    process.kill(vpnProfile.pid, 0);
    running = true;
  } catch (e) {
    running = e.code === 'EPERM'; // If EPERM, it is running as root
  }

  if (!running) {
    // Self-heal: Update database to reflect that the process crashed/stopped
    vpnProfile.isConnected = false;
    vpnProfile.pid = null;
    await vpnProfile.save();
    console.log(`[VPN] Automatically marked profile "${vpnProfile.originalFileName}" as disconnected (process not running)`);
  }

  return running;
};

module.exports = {
  saveUploadedConfig,
  connect,
  disconnect,
  disconnectAll,
  getStatus,
  releaseConfig,
  isProfileConnected,
};

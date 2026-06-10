/**
 * scanner.js — Main scan loop
 * Iterates through .ovpn configs, connects, checks IP, logs results.
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { connect, disconnect } from './vpn.js';
import { readLog, writeLog, createEmptyLog } from './logs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── State ──────────────────────────────────────────────────────────

let currentLog = null;
let scanning = false;
let abortRequested = false;

// ─── Helpers ────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extract a friendly server name from the OVPN filename.
 * "NCVPN-US-New York-TCP.ovpn" → "US-New York-TCP"
 */
function extractServerName(filename) {
  let name = filename.replace(/\.ovpn$/i, '');
  if (name.startsWith('NCVPN-')) {
    name = name.slice(6); // strip "NCVPN-"
  }
  return name;
}

/**
 * Make an HTTP(S) GET request using Node.js built-ins.
 * Returns { ok, status, body }
 */
function httpGet(url, timeout = 10000) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;

    const req = mod.get(url, { timeout }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let body = data;
        try {
          body = JSON.parse(data);
        } catch { /* not JSON, keep as string */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, body });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, body: 'Request timed out' });
    });

    req.on('error', (err) => {
      resolve({ ok: false, status: 0, body: err.message });
    });
  });
}

/**
 * Get all .ovpn files from the config directory, sorted alphabetically.
 */
function getOvpnFiles(configDir) {
  const absDir = path.resolve(__dirname, '..', configDir);
  if (!fs.existsSync(absDir)) {
    throw new Error(`Config directory not found: ${absDir}`);
  }

  const files = fs.readdirSync(absDir)
    .filter((f) => f.toLowerCase().endsWith('.ovpn'))
    .sort();

  return files.map((f) => ({
    filename: f,
    configPath: path.join(absDir, f),
    server: extractServerName(f),
  }));
}

// ─── Scan ───────────────────────────────────────────────────────────

/**
 * Start the scan loop.
 * @param {object} config - Parsed config.json
 * @param {object} [options] - { resumeFrom: number }
 */
export async function startScan(config, options = {}) {
  if (scanning) {
    throw new Error('Scan is already running.');
  }

  scanning = true;
  abortRequested = false;

  const files = getOvpnFiles(config.configDir || '../serverListTCP');
  const total = files.length;
  const resumeFrom = options.resumeFrom || 0;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  VPN Scanner — ${total} servers`);
  console.log(`  Provider: ${config.provider || 'openvpn'}`);
  console.log(`  Check URL: ${config.checkUrl}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Initialize or resume log
  if (resumeFrom > 0) {
    currentLog = readLog();
    currentLog.status = 'running';
  } else {
    currentLog = createEmptyLog();
    currentLog.startedAt = new Date().toISOString();
    currentLog.status = 'running';
    currentLog.total = total;
  }
  writeLog(currentLog);

  for (let i = resumeFrom; i < total; i++) {
    if (abortRequested) {
      console.log('\n[scanner] ⛔ Scan aborted by user.');
      break;
    }

    const file = files[i];
    const index = i + 1;

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  [${index}/${total}] ${file.server}`);
    console.log(`  File: ${file.filename}`);
    console.log(`${'─'.repeat(50)}`);

    // Create entry
    const entry = {
      index,
      total,
      server: file.server,
      filename: file.filename,
      configPath: file.configPath,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'pending',
      connect: { provider: config.provider || 'openvpn', profileId: null, pid: null, connected: false },
      ipCheck: { ok: false, status: 0, body: null },
      error: null,
    };

    // Update log with pending entry
    const existingIdx = currentLog.entries.findIndex((e) => e.index === index);
    if (existingIdx >= 0) {
      currentLog.entries[existingIdx] = entry;
    } else {
      currentLog.entries.push(entry);
    }
    writeLog(currentLog);

    try {
      // Step 1: Connect
      console.log('  → Connecting...');
      const connectResult = await connect(file.configPath, config);
      entry.connect = {
        provider: connectResult.provider,
        profileId: connectResult.profileId,
        pid: connectResult.pid,
        connected: connectResult.connected,
      };
      console.log(`  → Connected (PID: ${connectResult.pid})`);

      // Step 2: IP check
      console.log(`  → Checking IP via ${config.checkUrl}...`);
      const ipResult = await httpGet(config.checkUrl, config.ipCheckTimeout || 10000);
      entry.ipCheck = {
        ok: ipResult.ok,
        status: ipResult.status,
        body: ipResult.body,
      };

      if (ipResult.ok) {
        const ip = typeof ipResult.body === 'object' ? ipResult.body.ip : ipResult.body;
        console.log(`  → IP: ${ip}`);
      } else {
        console.log(`  → IP check failed: ${JSON.stringify(ipResult.body)}`);
      }

      // Step 3: Disconnect
      console.log('  → Disconnecting...');
      await disconnect(config);

      // Wait for tunnel teardown
      const disconnectWait = config.disconnectWait || 3000;
      await sleep(disconnectWait);

      entry.status = 'success';
      entry.finishedAt = new Date().toISOString();
      currentLog.success++;
      console.log(`  ✅ Success`);

    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      entry.status = 'error';
      entry.error = err.message;
      entry.finishedAt = new Date().toISOString();
      currentLog.failed++;

      // Make sure we disconnect on error
      try {
        await disconnect(config);
        await sleep(2000);
      } catch { /* ignore */ }
    }

    // Update counters and persist
    currentLog.completed = currentLog.success + currentLog.failed;
    const entryIdx = currentLog.entries.findIndex((e) => e.index === index);
    if (entryIdx >= 0) {
      currentLog.entries[entryIdx] = entry;
    }
    writeLog(currentLog);

    // Delay before next server
    if (i < total - 1 && !abortRequested) {
      const delay = config.delayBetweenServers || 2000;
      console.log(`  ⏳ Waiting ${delay}ms before next server...`);
      await sleep(delay);
    }
  }

  // Finalize
  currentLog.finishedAt = new Date().toISOString();
  currentLog.status = abortRequested ? 'aborted' : 'completed';
  writeLog(currentLog);

  scanning = false;
  abortRequested = false;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Scan ${currentLog.status}: ${currentLog.success} success, ${currentLog.failed} failed out of ${currentLog.total}`);
  console.log(`${'═'.repeat(60)}\n`);

  return currentLog;
}

/**
 * Get the current scan progress.
 */
export function getProgress() {
  if (currentLog) return currentLog;
  return readLog();
}

/**
 * Request the scan to stop after the current server completes.
 */
export function stopScan() {
  if (!scanning) return false;
  abortRequested = true;
  return true;
}

/**
 * Check if a scan is currently running.
 */
export function isScanning() {
  return scanning;
}

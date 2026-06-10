/**
 * server.js — HTTP server + REST API for the VPN scanner dashboard.
 * Pure Node.js, no external dependencies.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProgress, startScan, stopScan, isScanning } from './scanner.js';
import { readLog } from './logs.js';
import { status as vpnStatus } from './vpn.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

// ─── MIME types ─────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ─── Helpers ────────────────────────────────────────────────────────

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJSON(res, statusCode, { error: message });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  // Strip query strings
  filePath = filePath.split('?')[0];
  const absPath = path.join(PUBLIC_DIR, filePath);

  // Security: prevent path traversal
  if (!absPath.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, 'Forbidden');
    return;
  }

  if (!fs.existsSync(absPath)) {
    sendError(res, 404, 'Not found');
    return;
  }

  const ext = path.extname(absPath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = fs.readFileSync(absPath);

  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'max-age=3600',
  });
  res.end(content);
}

// ─── API Routes ─────────────────────────────────────────────────────

async function handleAPI(req, res, config) {
  const url = req.url.split('?')[0];
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // GET /api/status — current scan progress
  if (url === '/api/status' && method === 'GET') {
    const progress = getProgress();
    sendJSON(res, 200, {
      scanning: isScanning(),
      ...progress,
    });
    return;
  }

  // GET /api/results — full log
  if (url === '/api/results' && method === 'GET') {
    const log = readLog();
    sendJSON(res, 200, log);
    return;
  }

  // POST /api/scan/start — begin scan
  if (url === '/api/scan/start' && method === 'POST') {
    if (isScanning()) {
      sendError(res, 409, 'Scan is already running.');
      return;
    }

    // Start scan in background (don't await)
    startScan(config).catch((err) => {
      console.error('[server] Scan error:', err.message);
    });

    sendJSON(res, 200, { message: 'Scan started.', scanning: true });
    return;
  }

  // POST /api/scan/stop — abort scan
  if (url === '/api/scan/stop' && method === 'POST') {
    const stopped = stopScan();
    sendJSON(res, 200, { message: stopped ? 'Scan stop requested.' : 'No scan is running.', scanning: isScanning() });
    return;
  }

  // GET /api/vpn/status — VPN connection status
  if (url === '/api/vpn/status' && method === 'GET') {
    try {
      const st = await vpnStatus();
      sendJSON(res, 200, st);
    } catch (err) {
      sendError(res, 500, err.message);
    }
    return;
  }

  // GET /api/config — current config (without secrets)
  if (url === '/api/config' && method === 'GET') {
    const safeConfig = { ...config };
    delete safeConfig.auth;
    safeConfig.authFile = safeConfig.authFile ? '***' : null;
    sendJSON(res, 200, safeConfig);
    return;
  }

  sendError(res, 404, `Unknown API route: ${method} ${url}`);
}

// ─── Server ─────────────────────────────────────────────────────────

/**
 * Create and start the HTTP server.
 * @param {object} config - Parsed config.json
 * @returns {http.Server}
 */
export function createServer(config) {
  const port = config.dashboard?.port || 3000;

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/')) {
        await handleAPI(req, res, config);
      } else {
        serveStatic(req, res);
      }
    } catch (err) {
      console.error('[server] Unhandled error:', err);
      sendError(res, 500, 'Internal server error');
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${port} is already in use. Change the port in config.json.`);
    } else if (err.code === 'EPERM' || err.code === 'EACCES') {
      console.error(`\n❌ Permission denied for port ${port}. Try a port above 1024, or run with sudo.`);
    } else {
      console.error(`\n❌ Server error: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`\n🌐 Dashboard: http://localhost:${port}`);
    console.log(`📡 API:       http://localhost:${port}/api/status\n`);
  });

  return server;
}

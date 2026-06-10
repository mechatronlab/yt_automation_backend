#!/usr/bin/env node

/**
 * main.js — Entry point for the VPN Scanner
 *
 * Usage:
 *   node vpn-scanner/main.js                  # Start dashboard (scan via UI)
 *   node vpn-scanner/main.js --scan           # Start dashboard + begin scan immediately
 *   node vpn-scanner/main.js --no-dashboard   # Scan only, no HTTP server
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './src/server.js';
import { startScan } from './src/scanner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Load config ────────────────────────────────────────────────────

const configPath = path.resolve(__dirname, 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`Failed to load config.json: ${err.message}`);
  process.exit(1);
}

// ─── Parse flags ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const autoScan = args.includes('--scan');
const noDashboard = args.includes('--no-dashboard');

// ─── Banner ─────────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════╗
║         🔒  VPN Server Scanner  🔒          ║
║                                              ║
║  Provider:  ${(config.provider || 'openvpn').padEnd(32)}║
║  Configs:   ${(config.configDir || '../serverListTCP').padEnd(32)}║
╚══════════════════════════════════════════════╝
`);

// ─── Start services ─────────────────────────────────────────────────

if (!noDashboard) {
  createServer(config);
}

if (autoScan || noDashboard) {
  console.log('🚀 Starting scan...\n');
  startScan(config)
    .then((result) => {
      console.log(`\n✅ Scan finished: ${result.success} success, ${result.failed} failed.`);
      if (noDashboard) process.exit(0);
    })
    .catch((err) => {
      console.error(`\n❌ Scan error: ${err.message}`);
      if (noDashboard) process.exit(1);
    });
} else {
  console.log('💡 Dashboard is running. Start a scan from the web UI or use --scan flag.\n');
}

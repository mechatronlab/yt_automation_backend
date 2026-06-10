#!/usr/bin/env node

/**
 * cli.js — CLI for VPN scanner
 *
 * Usage:
 *   node vpn-scanner/src/cli.js scan                    # Run full scan (no dashboard)
 *   node vpn-scanner/src/cli.js connect <file.ovpn>     # Connect to a specific server
 *   node vpn-scanner/src/cli.js disconnect               # Disconnect active VPN
 *   node vpn-scanner/src/cli.js status                   # Show VPN + scan status
 *   node vpn-scanner/src/cli.js clean                    # Reset logs + disconnect
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, disconnect, status, killAll } from './vpn.js';
import { startScan, getProgress } from './scanner.js';
import { readLog, resetLog } from './logs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load config
const configPath = path.resolve(__dirname, '..', 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`Failed to load config.json: ${err.message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const command = args[0] || 'help';

async function main() {
  switch (command) {
    case 'scan': {
      console.log('Starting VPN server scan...\n');
      try {
        const result = await startScan(config);
        console.log(`\nScan complete: ${result.success} success, ${result.failed} failed.`);
      } catch (err) {
        console.error(`Scan failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case 'connect': {
      const file = args[1];
      if (!file) {
        console.error('Usage: cli.js connect <file.ovpn>');
        console.error('  Provide a filename from serverListTCP/ or a full path.');
        process.exit(1);
      }

      // Resolve the file path
      let configFilePath = file;
      if (!path.isAbsolute(file)) {
        const configDir = path.resolve(__dirname, '..', config.configDir || '../serverListTCP');
        configFilePath = path.join(configDir, file);
      }

      if (!fs.existsSync(configFilePath)) {
        console.error(`File not found: ${configFilePath}`);
        process.exit(1);
      }

      console.log(`Connecting to: ${configFilePath}`);
      try {
        const result = await connect(configFilePath, config);
        console.log(`\n✅ Connected!`);
        console.log(`   Provider: ${result.provider}`);
        console.log(`   Profile:  ${result.profileId}`);
        console.log(`   PID:      ${result.pid}`);
      } catch (err) {
        console.error(`\n❌ Connection failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case 'disconnect': {
      console.log('Disconnecting VPN...');
      try {
        await disconnect(config);
        console.log('✅ Disconnected.');
      } catch (err) {
        console.error(`❌ Disconnect error: ${err.message}`);
        // Try killall as fallback
        await killAll();
        console.log('Forced disconnect complete.');
      }
      break;
    }

    case 'status': {
      console.log('Checking status...\n');

      // VPN status
      const vpn = await status();
      console.log('── VPN ──────────────────────────────');
      console.log(`  Connected:  ${vpn.connected ? '✅ Yes' : '❌ No'}`);
      if (vpn.connected) {
        console.log(`  Provider:   ${vpn.provider || 'unknown'}`);
        console.log(`  PIDs:       ${vpn.pids.join(', ')}`);
      }

      // Scan status
      const log = readLog();
      console.log('\n── Scan ─────────────────────────────');
      console.log(`  Status:     ${log.status}`);
      console.log(`  Total:      ${log.total}`);
      console.log(`  Completed:  ${log.completed}`);
      console.log(`  Success:    ${log.success}`);
      console.log(`  Failed:     ${log.failed}`);
      if (log.startedAt) console.log(`  Started:    ${log.startedAt}`);
      if (log.finishedAt) console.log(`  Finished:   ${log.finishedAt}`);
      break;
    }

    case 'clean': {
      console.log('Cleaning up...');
      await killAll();
      resetLog();
      console.log('✅ VPN disconnected and logs reset.');
      break;
    }

    case 'help':
    default: {
      console.log(`
VPN Scanner CLI
═══════════════════════════════════════

Usage: node vpn-scanner/src/cli.js <command> [args]

Commands:
  scan                   Run full VPN server scan
  connect <file.ovpn>    Connect to a specific server
  disconnect             Disconnect active VPN
  status                 Show VPN + scan status
  clean                  Reset logs + disconnect VPN
  help                   Show this help message

Examples:
  node vpn-scanner/src/cli.js scan
  node vpn-scanner/src/cli.js connect "NCVPN-US-New York-TCP.ovpn"
  node vpn-scanner/src/cli.js status
`);
      break;
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

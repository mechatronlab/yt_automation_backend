#!/usr/bin/env node

/**
 * clean.js — Reset logs and disconnect any active VPN
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killAll } from '../src/vpn.js';
import { resetLog } from '../src/logs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TMP_DIR = path.resolve(__dirname, '..', '.tmp');

async function clean() {
  console.log('🧹 VPN Scanner — Clean\n');

  // 1. Kill all VPN processes
  console.log('  → Killing VPN processes...');
  await killAll();
  console.log('    ✅ Done');

  // 2. Reset log file
  console.log('  → Resetting scan-results.json...');
  resetLog();
  console.log('    ✅ Done');

  // 3. Clean temp files
  console.log('  → Cleaning temp files...');
  try {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
    console.log('    ✅ Done');
  } catch (err) {
    console.warn(`    ⚠️  Could not clean temp dir: ${err.message}`);
  }

  console.log('\n✅ All clean!');
}

clean().catch((err) => {
  console.error('Clean failed:', err);
  process.exit(1);
});

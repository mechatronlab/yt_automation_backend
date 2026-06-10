/**
 * logs.js — JSON log read/write helpers
 * Manages scan-results.json with atomic writes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOGS_DIR = path.resolve(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'scan-results.json');

/**
 * Ensure the logs directory exists.
 */
function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Create a fresh empty scan log structure.
 */
export function createEmptyLog() {
  return {
    startedAt: null,
    finishedAt: null,
    status: 'idle',
    total: 0,
    completed: 0,
    success: 0,
    failed: 0,
    entries: [],
  };
}

/**
 * Read the current scan log from disk.
 * Returns an empty log structure if the file doesn't exist or is invalid.
 */
export function readLog() {
  ensureLogsDir();
  try {
    if (fs.existsSync(LOG_FILE)) {
      const raw = fs.readFileSync(LOG_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn(`[logs] Warning: could not read log file: ${err.message}`);
  }
  return createEmptyLog();
}

/**
 * Write the scan log to disk (atomic: write to tmp, then rename).
 */
export function writeLog(data) {
  ensureLogsDir();
  const tmpFile = LOG_FILE + '.tmp';
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmpFile, json, 'utf8');
  fs.renameSync(tmpFile, LOG_FILE);
}

/**
 * Update the log data in-place and persist to disk.
 * @param {Function} updater - receives the log object, mutates it.
 */
export function updateLog(updater) {
  const log = readLog();
  updater(log);
  writeLog(log);
  return log;
}

/**
 * Append or update an entry in the log.
 * If an entry with the same index exists, it's replaced.
 */
export function upsertEntry(entry) {
  return updateLog((log) => {
    const idx = log.entries.findIndex((e) => e.index === entry.index);
    if (idx >= 0) {
      log.entries[idx] = entry;
    } else {
      log.entries.push(entry);
    }
  });
}

/**
 * Reset the log file to empty state.
 */
export function resetLog() {
  writeLog(createEmptyLog());
}

/**
 * Get the absolute path to the log file.
 */
export function getLogPath() {
  return LOG_FILE;
}

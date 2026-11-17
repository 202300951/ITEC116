/**
 * @fileoverview Resilient persistence layer supporting bounded retries,
 * atomic file writes, snapshot rollback, and fault-tolerant JSONL reading.
 */

const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const EMPTY_MART = {
  factSales: [],
  dimCustomer: [],
  dimProduct: [],
  dimTime: []
};

/**
 * Ensures required data directories and baseline storage files exist.
 */
function ensureStorage() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  if (!fs.existsSync(config.RAW_FILE)) {
    fs.writeFileSync(config.RAW_FILE, '', 'utf8');
  }
  if (!fs.existsSync(config.MART_FILE)) {
    fs.writeFileSync(config.MART_FILE, JSON.stringify(EMPTY_MART, null, 2), 'utf8');
  }
}

/**
 * Executes an operation with bounded retry attempts and linear backoff.
 *
 * @template T
 * @param {() => Promise<T> | T} operation
 * @param {{ maxAttempts?: number, delayMs?: number }} [options]
 * @returns {Promise<{ result: T, attempts: number }>}
 */
async function withRetry(operation, options = {}) {
  const maxAttempts = options.maxAttempts || config.RETRY_MAX_ATTEMPTS;
  const delayMs = options.delayMs ?? config.RETRY_DELAY_MS;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await operation(attempt);
      return { result, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
      }
    }
  }

  throw new Error(`Operation failed after ${maxAttempts} attempts: ${lastError.message}`);
}

/**
 * Writes content atomically via a temporary file rename to prevent partial writes.
 *
 * @param {string} targetPath
 * @param {string} content
 */
function writeFileAtomic(targetPath, content) {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, targetPath);
}

/**
 * Reads the append-only raw JSONL log without crashing on malformed lines.
 * Corrupted lines are counted so they can be reported in ingestion error metrics.
 *
 * @returns {{ validRecords: object[], malformedCount: number, totalLines: number }}
 */
function readRawLines() {
  ensureStorage();
  const lines = fs
    .readFileSync(config.RAW_FILE, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const validRecords = [];
  let malformedCount = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        validRecords.push(parsed);
      } else {
        malformedCount++;
      }
    } catch {
      malformedCount++;
    }
  }

  return { validRecords, malformedCount, totalLines: lines.length };
}

/**
 * Appends a validated transaction record to staging using the retry policy.
 * Supports simulated transient failures for Lab 7 fault-injection testing.
 *
 * @param {object} record
 * @param {{ failFirstNAttempts?: number }} [options]
 * @returns {Promise<{ attempts: number }>}
 */
async function appendRawTransaction(record, options = {}) {
  ensureStorage();
  let remainingSimulatedFailures = Number(options.failFirstNAttempts || 0);

  const { attempts } = await withRetry(() => {
    if (remainingSimulatedFailures > 0) {
      remainingSimulatedFailures--;
      throw new Error('Simulated transient staging write interruption');
    }
    fs.appendFileSync(config.RAW_FILE, `${JSON.stringify(record)}\n`, 'utf8');
  });

  return { attempts };
}

/**
 * Reads the current BI star-schema mart from disk.
 *
 * @returns {object}
 */
function readMart() {
  ensureStorage();
  return JSON.parse(fs.readFileSync(config.MART_FILE, 'utf8'));
}

/**
 * Writes the BI mart transactionally with snapshot backup and automatic rollback.
 * If an error occurs during persistence, the previous mart snapshot is restored.
 *
 * @param {object} nextMart
 * @param {{ simulateWriteFailure?: boolean }} [options]
 */
function writeMartWithRollback(nextMart, options = {}) {
  ensureStorage();
  const hasPrevious = fs.existsSync(config.MART_FILE);

  if (hasPrevious) {
    fs.copyFileSync(config.MART_FILE, config.MART_BACKUP_FILE);
  }

  try {
    if (options.simulateWriteFailure) {
      throw new Error('Simulated mid-transaction BI mart persistence failure');
    }
    writeFileAtomic(config.MART_FILE, JSON.stringify(nextMart, null, 2));
  } catch (err) {
    if (hasPrevious && fs.existsSync(config.MART_BACKUP_FILE)) {
      fs.copyFileSync(config.MART_BACKUP_FILE, config.MART_FILE);
    }
    const rollbackError = new Error(`ETL rolled back to last stable mart: ${err.message}`);
    rollbackError.rolledBack = true;
    throw rollbackError;
  }
}

module.exports = {
  EMPTY_MART,
  ensureStorage,
  withRetry,
  readRawLines,
  appendRawTransaction,
  readMart,
  writeMartWithRollback
};
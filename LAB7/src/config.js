/**
 * @fileoverview Centralized runtime configuration for the E-Commerce-to-BI pipeline.
 * All operational thresholds and secrets are driven by environment variables
 * to avoid hardcoded test values in production code.
 */

const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');

const parsedTaxRate = Number(process.env.TAX_RATE);

module.exports = {
  PORT: Number(process.env.PORT || 3000),
  API_TOKEN: process.env.BI_API_TOKEN || 'itec116-demo-token',
  // Defaults to 12% standard VAT; override with TAX_RATE (e.g., 0.12 or 0)
  TAX_RATE: Number.isFinite(parsedTaxRate) && parsedTaxRate >= 0 ? parsedTaxRate : 0.12,
  RETRY_MAX_ATTEMPTS: Number(process.env.RETRY_MAX_ATTEMPTS || 3),
  RETRY_DELAY_MS: Number(process.env.RETRY_DELAY_MS || 50),
  PUBLIC_DIR: path.join(ROOT_DIR, 'public'),
  DATA_DIR,
  RAW_FILE: path.join(DATA_DIR, 'raw-transactions.jsonl'),
  MART_FILE: path.join(DATA_DIR, 'bi-mart.json'),
  MART_BACKUP_FILE: path.join(DATA_DIR, 'bi-mart.json.bak')
};
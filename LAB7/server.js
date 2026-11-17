/**
 * @fileoverview HTTP entry point for the ITEC 116 E-Commerce-to-BI Integration System.
 * Provides authenticated transaction ingestion with automatic tax computation,
 * transactional star-schema ETL, dashboard telemetry, and reconciliation exports.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./src/config');
const storage = require('./src/storage');
const {
  roundMoney,
  calculateTaxBreakdown,
  validateTransaction
} = require('./src/validator');
const { runETL } = require('./src/etl');
const { getDashboardData } = require('./src/metrics');

storage.ensureStorage();

/**
 * Sends a JSON or HTML HTTP response with CORS headers.
 */
function send(res, status, data, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Simulate-Transient-Failures, X-Simulate-Write-Failure',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

/**
 * Reads and parses a JSON request body up to 1 MB.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Request body exceeds 1 MB limit'));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Main request handler.
 */
async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    return send(res, 204, '');
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    // Serve frontend dashboard
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(config.PUBLIC_DIR, 'index.html'), 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    // Service health and active tax rate metadata
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, {
        status: 'ok',
        service: 'ITEC 116 E-Commerce-to-BI Integration',
        taxRate: config.TAX_RATE,
        timestamp: new Date().toISOString()
      });
    }

    // Authenticated BI transaction ingestion with automatic tax calculation & retry policy
    if (req.method === 'POST' && url.pathname === '/api/transactions') {
      const authHeader = req.headers.authorization || '';
      if (authHeader !== `Bearer ${config.API_TOKEN}`) {
        return send(res, 401, { error: 'Unauthorized: provide a valid Bearer token' });
      }

      let payload;
      try {
        payload = await readBody(req);
      } catch (parseErr) {
        return send(res, 400, { error: parseErr.message });
      }

      const transaction = payload.transaction || payload;
      const errors = validateTransaction(transaction);
      if (errors.length > 0) {
        return send(res, 400, { error: 'Validation failed', details: errors });
      }

      const txId = String(transaction.transaction_id).trim();
      const { validRecords } = storage.readRawLines();
      if (validRecords.some(existing => String(existing.transaction_id).trim() === txId)) {
        return send(res, 409, { error: 'Duplicate transaction_id', transaction_id: txId });
      }

      const taxBreakdown = calculateTaxBreakdown(transaction.line_items, config.TAX_RATE);
      const finalMonetaryValue =
        transaction.monetary_value !== undefined && transaction.monetary_value !== ''
          ? roundMoney(transaction.monetary_value)
          : taxBreakdown.grand_total;

      const savedRecord = {
        ...transaction,
        transaction_id: txId,
        subtotal: taxBreakdown.subtotal,
        tax_rate: taxBreakdown.tax_rate,
        tax_amount: taxBreakdown.tax_amount,
        monetary_value: finalMonetaryValue,
        received_at: new Date().toISOString()
      };

      const failFirstNAttempts = Number(req.headers['x-simulate-transient-failures'] || 0);
      const { attempts } = await storage.appendRawTransaction(savedRecord, { failFirstNAttempts });

      return send(res, 201, {
        message: 'Transaction ingested with automatic tax calculation',
        transaction_id: savedRecord.transaction_id,
        subtotal: savedRecord.subtotal,
        tax_rate: savedRecord.tax_rate,
        tax_amount: savedRecord.tax_amount,
        monetary_value: savedRecord.monetary_value,
        write_attempts: attempts,
        received_at: savedRecord.received_at
      });
    }

    // Transactional ETL execution with rollback protection
    if (req.method === 'POST' && url.pathname === '/api/etl/run') {
      const simulateWriteFailure = req.headers['x-simulate-write-failure'] === 'true';
      try {
        const summary = runETL({ simulateWriteFailure });
        return send(res, 200, { message: 'ETL completed successfully', ...summary });
      } catch (etlErr) {
        return send(res, 500, {
          error: etlErr.message,
          rolled_back: Boolean(etlErr.rolledBack)
        });
      }
    }

    // Dashboard metrics and star-schema mart
    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      return send(res, 200, getDashboardData());
    }

    // Full staging, dimensional mart, and reconciliation export (Lab 8 Track B)
    if (req.method === 'GET' && url.pathname === '/api/export') {
      const raw = storage.readRawLines();
      const dashboard = getDashboardData();
      return send(res, 200, {
        exported_at: new Date().toISOString(),
        reconciliation: dashboard.metrics,
        raw: raw.validRecords,
        malformed_raw_lines: raw.malformedCount,
        mart: dashboard.mart
      });
    }

    return send(res, 404, { error: 'Route not found' });
  } catch (err) {
    return send(res, 500, { error: err.message || 'Internal server error' });
  }
}

const server = http.createServer(handleRequest);

if (require.main === module) {
  server.listen(config.PORT, () => {
    console.log(`ITEC 116 BI system running at http://localhost:${config.PORT}`);
    console.log(`Active Tax Rate: ${(config.TAX_RATE * 100).toFixed(2)}%`);
  });
}

module.exports = { server, handleRequest };
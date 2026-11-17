/**
 * ITEC 116 - E-Commerce-to-BI Integration Server
 * Lightweight Node.js HTTP server implementing data ingestion, validation,
 * star-schema ETL transformation, and BI dashboard metrics without external dependencies.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ============================================================================
// 1. CONFIGURATION & LOCAL STORAGE INITIALIZATION
// ============================================================================

const PORT = Number(process.env.PORT || 3000);
const API_TOKEN = process.env.BI_API_TOKEN || 'itec116-demo-token';

// Paths for raw staging logs (JSON Lines) and transformed BI data mart (JSON)
const DATA_DIR = path.join(__dirname, 'data');
const RAW_FILE = path.join(DATA_DIR, 'raw-transactions.jsonl');
const MART_FILE = path.join(DATA_DIR, 'bi-mart.json');

// Ensure the data directory and initial storage files exist on startup
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(RAW_FILE)) fs.writeFileSync(RAW_FILE, '');
if (!fs.existsSync(MART_FILE)) {
  fs.writeFileSync(
    MART_FILE,
    JSON.stringify({ factSales: [], dimCustomer: [], dimProduct: [], dimTime: [] }, null, 2)
  );
}

// ============================================================================
// 2. HTTP & FILE I/O HELPERS
// ============================================================================

// Supported MIME types for static/API responses
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

/**
 * Sends a standardized HTTP response with CORS headers enabled.
 */
function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

/**
 * Reads and parses an incoming JSON request body (enforces a 1 MB payload limit).
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Reads all newline-delimited JSON records from the raw staging file.
 */
function readRaw() {
  return fs
    .readFileSync(RAW_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

/**
 * Reads and parses the transformed star-schema BI data mart.
 */
function readMart() {
  return JSON.parse(fs.readFileSync(MART_FILE, 'utf8'));
}

/**
 * Persists the updated BI data mart object to disk.
 */
function writeMart(mart) {
  fs.writeFileSync(MART_FILE, JSON.stringify(mart, null, 2));
}

// ============================================================================
// 3. DATA VALIDATION & NORMALIZATION
// ============================================================================

/**
 * Validates an incoming transaction payload against required schema and business rules.
 * @returns {string[]} Array of validation error messages (empty if valid).
 */
function validateTransaction(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return ['Payload must be a JSON object'];

  // Check presence of mandatory top-level fields
  for (const k of ['transaction_id', 'timestamp', 'entity_id', 'monetary_value', 'status', 'line_items']) {
    if (t[k] === undefined || t[k] === null || t[k] === '') {
      errors.push(`Missing required field: ${k}`);
    }
  }

  // Validate data types and value constraints
  if (t.timestamp && Number.isNaN(Date.parse(t.timestamp))) {
    errors.push('timestamp must be a valid date');
  }
  if (t.monetary_value !== undefined && (!Number.isFinite(Number(t.monetary_value)) || Number(t.monetary_value) < 0)) {
    errors.push('monetary_value must be a non-negative number');
  }
  if (t.line_items !== undefined && !Array.isArray(t.line_items)) {
    errors.push('line_items must be an array');
  }

  // Validate each line item inside the order
  if (Array.isArray(t.line_items)) {
    t.line_items.forEach((item, i) => {
      if (!item.product_id || !item.name) {
        errors.push(`line_items[${i}] requires product_id and name`);
      }
      if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0) {
        errors.push(`line_items[${i}].quantity must be positive`);
      }
      if (!Number.isFinite(Number(item.unit_price)) || Number(item.unit_price) < 0) {
        errors.push(`line_items[${i}].unit_price must be non-negative`);
      }
    });
  }

  return errors;
}

/**
 * Maps raw status strings into standardized display labels for BI reporting.
 */
function statusLabel(s) {
  return (
    {
      completed: 'Completed',
      pending: 'Pending',
      cancelled: 'Cancelled',
      refunded: 'Refunded',
      checkout: 'Checkout'
    }[String(s || '').toLowerCase()] || 'Other'
  );
}

// ============================================================================
// 4. STAR-SCHEMA ETL PIPELINE & ANALYTICS AGGREGATION
// ============================================================================

/**
 * Extracts raw staged transactions, deduplicates and validates records,
 * and loads them into a Star Schema (factSales + Customer, Product, Time dimensions).
 */
function runETL() {
  const raw = readRaw();
  const mart = { factSales: [], dimCustomer: [], dimProduct: [], dimTime: [] };

  // Maps/Sets used to deduplicate dimension keys and prevent duplicate transactions
  const customers = new Map();
  const products = new Map();
  const times = new Map();
  const seen = new Set();
  let rejected = 0;

  for (const tx of raw) {
    // Skip invalid payloads or duplicate transaction IDs
    if (validateTransaction(tx).length || seen.has(tx.transaction_id)) {
      rejected++;
      continue;
    }
    seen.add(tx.transaction_id);

    // Populate Time Dimension (YYYY-MM-DD)
    const date = new Date(tx.timestamp).toISOString();
    const dateKey = date.slice(0, 10);
    times.set(dateKey, {
      date_key: dateKey,
      year: Number(date.slice(0, 4)),
      month: Number(date.slice(5, 7)),
      day: Number(date.slice(8, 10))
    });

    // Populate Customer Dimension
    const customerId = String(tx.entity_id).trim();
    customers.set(customerId, { customer_id: customerId });

    // Reconcile header monetary_value against sum of line items
    const items = tx.line_items || [];
    const computedTotal = items.reduce((sum, x) => sum + Number(x.quantity) * Number(x.unit_price), 0);
    const total = Number(tx.monetary_value);
    const safeStatus = statusLabel(tx.status);

    // Explode each line item into a granular Fact row and populate Product Dimension
    for (const item of items) {
      const productId = String(item.product_id).trim();
      products.set(productId, {
        product_id: productId,
        product_name: String(item.name).trim() || 'Unknown product'
      });

      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unit_price);
      const lineTotal = quantity * unitPrice;

      // Cost is optional; if not provided, margin is not asserted and is reported as null.
      const margin =
        Number.isFinite(Number(item.unit_cost)) && item.unit_cost !== ''
          ? lineTotal - quantity * Number(item.unit_cost)
          : null;

      mart.factSales.push({
        transaction_id: String(tx.transaction_id).trim(),
        customer_id: customerId,
        date_key: dateKey,
        product_id: productId,
        quantity,
        unit_price: unitPrice,
        line_total: Number(lineTotal.toFixed(2)),
        transaction_total: Number(total.toFixed(2)),
        status: safeStatus,
        net_margin: margin === null ? null : Number(margin.toFixed(2)),
        payload_total_matches_items: Math.abs(computedTotal - total) < 0.01
      });
    }
  }

  // Finalize dimension tables and sort Time chronologically
  mart.dimCustomer = [...customers.values()];
  mart.dimProduct = [...products.values()];
  mart.dimTime = [...times.values()].sort((a, b) => a.date_key.localeCompare(b.date_key));

  writeMart(mart);

  return {
    inputTransactions: raw.length,
    transformedTransactions: seen.size,
    factRows: mart.factSales.length,
    rejectedOrDuplicateTransactions: rejected,
    dimensions: {
      customers: mart.dimCustomer.length,
      products: mart.dimProduct.length,
      dates: mart.dimTime.length
    }
  };
}

/**
 * Computes KPIs, data quality metrics, recent transactions, and full mart state for the UI.
 */
function dashboardData() {
  const raw = readRaw();
  const mart = readMart();

  // Deduplicate transactions by transaction_id
  const txMap = new Map();
  for (const t of raw) {
    if (!txMap.has(t.transaction_id)) txMap.set(t.transaction_id, t);
  }
  const txs = [...txMap.values()];

  // Revenue and order completion metrics
  const completed = txs.filter(t => statusLabel(t.status) === 'Completed');
  const revenue = completed.reduce((s, t) => s + Number(t.monetary_value || 0), 0);

  // Data quality & reconciliation checks
  const ingestionErrors = raw.filter(t => validateTransaction(t).length).length;
  const facts = mart.factSales;
  const totalsMatch = txs.every(
    t =>
      Math.abs(
        (t.line_items || []).reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0) -
          Number(t.monetary_value)
      ) < 0.01
  );
  const expectedRows = txs.reduce((s, t) => s + (t.line_items || []).length, 0);
  const rowAccuracy = expectedRows
    ? Math.max(0, 100 * (1 - Math.abs(expectedRows - facts.length) / expectedRows))
    : facts.length === 0
      ? 100
      : 0;

  return {
    metrics: {
      transactions: txs.length,
      completedOrders: completed.length,
      revenue: Number(revenue.toFixed(2)),
      factRows: facts.length,
      ingestionErrorRate: raw.length ? Number(((100 * ingestionErrors) / raw.length).toFixed(2)) : 0,
      rowReconciliationAccuracy: Number(rowAccuracy.toFixed(2)),
      payloadTotalMatchRate: txs.length
        ? Number(
            (
              (100 *
                txs.filter(
                  t =>
                    Math.abs(
                      (t.line_items || []).reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0) -
                        Number(t.monetary_value)
                    ) < 0.01
                ).length) /
              txs.length
            ).toFixed(2)
          )
        : 100
    },
    recentTransactions: txs.slice(-10).reverse(),
    mart
  };
}

// ============================================================================
// 5. HTTP SERVER & REST API ROUTES
// ============================================================================

const server = http.createServer(async (req, res) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') return send(res, 204, '');

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    // Serve frontend dashboard HTML
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    // Service health check
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return send(res, 200, {
        status: 'ok',
        service: 'ITEC 116 E-Commerce-to-BI Integration',
        timestamp: new Date().toISOString()
      });
    }

    // Authenticated transaction ingestion endpoint (Bearer token required)
    if (req.method === 'POST' && url.pathname === '/api/transactions') {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${API_TOKEN}`) {
        return send(res, 401, { error: 'Unauthorized: provide a valid Bearer token' });
      }

      const payload = await readBody(req);
      const transaction = payload.transaction || payload;

      // Validate schema
      const errors = validateTransaction(transaction);
      if (errors.length) {
        return send(res, 400, { error: 'Validation failed', details: errors });
      }

      // Enforce idempotency / prevent duplicate transaction IDs
      const existing = readRaw().some(t => t.transaction_id === transaction.transaction_id);
      if (existing) {
        return send(res, 409, { error: 'Duplicate transaction_id', transaction_id: transaction.transaction_id });
      }

      // Append validated record to raw staging log
      const saved = { ...transaction, received_at: new Date().toISOString() };
      fs.appendFileSync(RAW_FILE, JSON.stringify(saved) + '\n');
      return send(res, 201, {
        message: 'Transaction ingested and logged',
        transaction_id: saved.transaction_id,
        received_at: saved.received_at
      });
    }

    // Demo endpoint to simulate an incoming storefront order without manual auth setup
    if (req.method === 'POST' && url.pathname === '/api/demo-order') {
      const body = await readBody(req);
      const products = [
        { product_id: 'P-100', name: 'Wireless Mouse', quantity: 1, unit_price: 499, unit_cost: 280 },
        { product_id: 'P-200', name: 'USB-C Hub', quantity: 2, unit_price: 799, unit_cost: 500 },
        { product_id: 'P-300', name: 'Notebook', quantity: 3, unit_price: 65, unit_cost: 30 }
      ];

      const chosen =
        Array.isArray(body.line_items) && body.line_items.length
          ? body.line_items
          : products.slice(0, 1 + Math.floor(Math.random() * 3));

      const total = Number(chosen.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0).toFixed(2));
      const transaction = {
        transaction_id: `ORD-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
        timestamp: new Date().toISOString(),
        entity_id: String(body.customer_id || `C-${1000 + Math.floor(Math.random() * 9000)}`),
        monetary_value: total,
        status: 'completed',
        line_items: chosen
      };

      const errors = validateTransaction(transaction);
      if (errors.length) return send(res, 400, { error: 'Invalid demo order', details: errors });

      fs.appendFileSync(RAW_FILE, JSON.stringify({ ...transaction, received_at: new Date().toISOString() }) + '\n');
      return send(res, 201, {
        message: 'Demo storefront order created and sent to BI staging',
        transaction
      });
    }

    // Trigger batch ETL transformation from raw staging to BI star schema
    if (req.method === 'POST' && url.pathname === '/api/etl/run') {
      return send(res, 200, { message: 'ETL completed', ...runETL() });
    }

    // Retrieve aggregated KPIs and BI mart data for the dashboard
    if (req.method === 'GET' && url.pathname === '/api/dashboard') {
      return send(res, 200, dashboardData());
    }

    // Export both raw staging records and transformed BI mart tables
    if (req.method === 'GET' && url.pathname === '/api/export') {
      return send(res, 200, { raw: readRaw(), mart: readMart() });
    }

    // Fallback for unmatched routes
    return send(res, 404, { error: 'Route not found' });
  } catch (e) {
    return send(res, 500, { error: e.message || 'Internal server error' });
  }
});

// Start listening for incoming HTTP connections
server.listen(PORT, () =>
  console.log(`ITEC 116 BI system running at http://localhost:${PORT}\nDemo token: ${API_TOKEN}`)
);
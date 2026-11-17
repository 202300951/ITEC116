/**
 * @fileoverview Automated Alpha Testing & Fault Injection Suite (ITEC 116 Lab 7).
 * Verifies Track A (unit & tax logic), Track B (E2E smoke pipeline),
 * and Track C (malformed JSON, idempotency, retry policy, and rollback).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate test storage in a temporary directory
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itec116-alpha-'));
process.env.DATA_DIR = tempDataDir;
process.env.BI_API_TOKEN = 'test-alpha-token';
process.env.TAX_RATE = '0.12';
process.env.RETRY_DELAY_MS = '5';

const { server } = require('../server');
const { calculateTaxBreakdown, validateTransaction } = require('../src/validator');

let baseUrl;

test.before(async () => {
  await new Promise(resolve => {
    server.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

test('Track A (Unit): calculateTaxBreakdown computes 12% VAT and grand total accurately', () => {
  const result = calculateTaxBreakdown([
    { product_id: 'P-1', name: 'Keyboard', quantity: 2, unit_price: 500 }
  ], 0.12);

  assert.equal(result.subtotal, 1000);
  assert.equal(result.tax_amount, 120);
  assert.equal(result.grand_total, 1120);
});

test('Track A (Unit): validateTransaction catches missing fields and invalid quantities', () => {
  const errors = validateTransaction({
    transaction_id: '',
    line_items: [{ product_id: 'P-1', name: 'Mouse', quantity: 0, unit_price: -10 }]
  });
  assert.ok(errors.length >= 4);
});

test('Track A & B (Smoke Test): End-to-end order ingestion with auto-tax -> ETL -> BI Mart', async () => {
  const ingestRes = await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-alpha-token'
    },
    body: JSON.stringify({
      transaction_id: 'ORD-ALPHA-001',
      timestamp: '2026-11-17T14:00:00.000Z',
      entity_id: 'C-501',
      status: 'completed',
      line_items: [
        { product_id: 'P-10', name: 'Mechanical Keyboard', quantity: 1, unit_price: 1000, unit_cost: 600 }
      ]
    })
  });

  assert.equal(ingestRes.status, 201);
  const ingested = await ingestRes.json();
  assert.equal(ingested.subtotal, 1000);
  assert.equal(ingested.tax_amount, 120);
  assert.equal(ingested.monetary_value, 1120);

  const etlRes = await fetch(`${baseUrl}/api/etl/run`, { method: 'POST', body: '{}' });
  assert.equal(etlRes.status, 200);
  const etlSummary = await etlRes.json();
  assert.equal(etlSummary.transformedTransactions, 1);
  assert.equal(etlSummary.factRows, 1);

  const dashRes = await fetch(`${baseUrl}/api/dashboard`);
  const dash = await dashRes.json();
  assert.equal(dash.metrics.completedTax, 120);
  assert.equal(dash.metrics.revenue, 1120);
  assert.equal(dash.metrics.rowReconciliationAccuracy, 100);
  assert.equal(dash.metrics.payloadTotalMatchRate, 100);
});

test('Track C (Fault Injection): Rejects malformed JSON and unauthorized tokens', async () => {
  const unauthRes = await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(unauthRes.status, 401);

  const badJsonRes = await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-alpha-token'
    },
    body: '{ malformed-json'
  });
  assert.equal(badJsonRes.status, 400);
});

test('Track C (Fault Injection): Enforces idempotency on duplicate transaction_id (HTTP 409)', async () => {
  const dupRes = await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-alpha-token'
    },
    body: JSON.stringify({
      transaction_id: 'ORD-ALPHA-001',
      timestamp: '2026-11-17T14:05:00.000Z',
      entity_id: 'C-501',
      status: 'completed',
      line_items: [{ product_id: 'P-10', name: 'Mechanical Keyboard', quantity: 1, unit_price: 1000 }]
    })
  });
  assert.equal(dupRes.status, 409);
});

test('Track C (Fault Injection): Recovers from transient write failure via retry policy', async () => {
  const retryRes = await fetch(`${baseUrl}/api/transactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-alpha-token',
      'X-Simulate-Transient-Failures': '2'
    },
    body: JSON.stringify({
      transaction_id: 'ORD-ALPHA-002',
      timestamp: '2026-11-17T14:10:00.000Z',
      entity_id: 'C-502',
      status: 'completed',
      line_items: [{ product_id: 'P-20', name: 'USB-C Hub', quantity: 1, unit_price: 500 }]
    })
  });

  assert.equal(retryRes.status, 201);
  const body = await retryRes.json();
  assert.equal(body.write_attempts, 3);
});

test('Track C (Fault Injection): Rolls back BI mart cleanly when mid-transaction write fails', async () => {
  const failEtlRes = await fetch(`${baseUrl}/api/etl/run`, {
    method: 'POST',
    headers: { 'X-Simulate-Write-Failure': 'true' },
    body: '{}'
  });

  assert.equal(failEtlRes.status, 500);
  const failBody = await failEtlRes.json();
  assert.equal(failBody.rolled_back, true);

  // Verify the previous committed mart state (1 fact row) remained intact
  const dashRes = await fetch(`${baseUrl}/api/dashboard`);
  const dash = await dashRes.json();
  assert.equal(dash.metrics.factRows, 1);
});
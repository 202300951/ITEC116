/**
 * @fileoverview Computes BI dashboard metrics, tax summaries, and data-quality
 * reconciliation KPIs for Track B & Track D governance audits.
 */

const config = require('./config');
const storage = require('./storage');
const {
  roundMoney,
  calculateTaxBreakdown,
  validateTransaction,
  normalizeStatus
} = require('./validator');

/**
 * Aggregates KPI metrics, tax totals, recent transactions, and mart tables.
 *
 * @returns {object}
 */
function getDashboardData() {
  const { validRecords, malformedCount, totalLines } = storage.readRawLines();
  const mart = storage.readMart();

  const txMap = new Map();
  let schemaInvalidCount = 0;

  for (const record of validRecords) {
    if (validateTransaction(record).length > 0) {
      schemaInvalidCount++;
      continue;
    }
    if (!txMap.has(record.transaction_id)) {
      txMap.set(record.transaction_id, record);
    }
  }

  const uniqueTransactions = [...txMap.values()].map(tx => {
    const rate = Number.isFinite(Number(tx.tax_rate)) ? Number(tx.tax_rate) : config.TAX_RATE;
    const breakdown = calculateTaxBreakdown(tx.line_items || [], rate);
    const total = tx.monetary_value !== undefined && tx.monetary_value !== ''
      ? roundMoney(tx.monetary_value)
      : breakdown.grand_total;

    return {
      ...tx,
      subtotal: tx.subtotal !== undefined ? roundMoney(tx.subtotal) : breakdown.subtotal,
      tax_rate: rate,
      tax_amount: tx.tax_amount !== undefined ? roundMoney(tx.tax_amount) : breakdown.tax_amount,
      monetary_value: total,
      expected_grand_total: breakdown.grand_total
    };
  });

  const completed = uniqueTransactions.filter(tx => normalizeStatus(tx.status) === 'Completed');
  const completedSubtotal = roundMoney(completed.reduce((sum, tx) => sum + tx.subtotal, 0));
  const completedTax = roundMoney(completed.reduce((sum, tx) => sum + tx.tax_amount, 0));
  const revenue = roundMoney(completed.reduce((sum, tx) => sum + tx.monetary_value, 0));

  const facts = mart.factSales || [];
  const totalInvalidLines = malformedCount + schemaInvalidCount;
  const ingestionErrorRate = totalLines > 0
    ? Number(((100 * totalInvalidLines) / totalLines).toFixed(2))
    : 0;

  const expectedFactRows = uniqueTransactions.reduce(
    (sum, tx) => sum + (tx.line_items || []).length,
    0
  );
  const rowReconciliationAccuracy = expectedFactRows > 0
    ? Number(Math.max(0, 100 * (1 - Math.abs(expectedFactRows - facts.length) / expectedFactRows)).toFixed(2))
    : (facts.length === 0 ? 100 : 0);

  const matchingPayloads = uniqueTransactions.filter(
    tx => Math.abs(tx.expected_grand_total - tx.monetary_value) < 0.01
  ).length;
  const payloadTotalMatchRate = uniqueTransactions.length > 0
    ? Number(((100 * matchingPayloads) / uniqueTransactions.length).toFixed(2))
    : 100;

  return {
    taxRate: config.TAX_RATE,
    metrics: {
      transactions: uniqueTransactions.length,
      completedOrders: completed.length,
      completedSubtotal,
      completedTax,
      revenue,
      factRows: facts.length,
      expectedFactRows,
      ingestionErrorRate,
      rowReconciliationAccuracy,
      payloadTotalMatchRate
    },
    recentTransactions: uniqueTransactions.slice(-10).reverse(),
    mart
  };
}

module.exports = { getDashboardData };
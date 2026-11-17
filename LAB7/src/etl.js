/**
 * @fileoverview Star-schema ETL pipeline transforming staged transactions
 * into Fact_Sales, Dim_Customer, Dim_Product, and Dim_Time with tax allocation
 * and transactional rollback protection.
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
 * Executes the full ETL batch from raw JSONL staging into the BI dimensional mart.
 *
 * @param {{ simulateWriteFailure?: boolean }} [options]
 * @returns {object} ETL execution summary and row counts
 */
function runETL(options = {}) {
  const { validRecords, malformedCount, totalLines } = storage.readRawLines();

  const mart = {
    factSales: [],
    dimCustomer: [],
    dimProduct: [],
    dimTime: []
  };

  const customers = new Map();
  const products = new Map();
  const times = new Map();
  const seenTransactionIds = new Set();

  let rejectedRecords = malformedCount;

  for (const tx of validRecords) {
    const txId = String(tx.transaction_id || '').trim();
    if (validateTransaction(tx).length > 0 || seenTransactionIds.has(txId)) {
      rejectedRecords++;
      continue;
    }

    seenTransactionIds.add(txId);

    const isoTimestamp = new Date(tx.timestamp).toISOString();
    const dateKey = isoTimestamp.slice(0, 10);
    const customerId = String(tx.entity_id).trim();
    const safeStatus = normalizeStatus(tx.status);

    customers.set(customerId, { customer_id: customerId });
    times.set(dateKey, {
      date_key: dateKey,
      year: Number(isoTimestamp.slice(0, 4)),
      month: Number(isoTimestamp.slice(5, 7)),
      day: Number(isoTimestamp.slice(8, 10))
    });

    const items = tx.line_items || [];
    const effectiveTaxRate = Number.isFinite(Number(tx.tax_rate))
      ? Number(tx.tax_rate)
      : config.TAX_RATE;

    const breakdown = calculateTaxBreakdown(items, effectiveTaxRate);
    const total = tx.monetary_value !== undefined && tx.monetary_value !== ''
      ? roundMoney(tx.monetary_value)
      : breakdown.grand_total;

    for (const item of items) {
      const productId = String(item.product_id).trim();
      products.set(productId, {
        product_id: productId,
        product_name: String(item.name).trim() || 'Unknown product'
      });

      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unit_price);
      const lineSubtotal = roundMoney(quantity * unitPrice);
      const lineTax = roundMoney(lineSubtotal * effectiveTaxRate);
      const lineTotalWithTax = roundMoney(lineSubtotal + lineTax);

      // Net margin is calculated on pre-tax revenue if unit_cost is supplied; otherwise null.
      const hasCost = item.unit_cost !== undefined && item.unit_cost !== '' && Number.isFinite(Number(item.unit_cost));
      const netMargin = hasCost
        ? roundMoney(lineSubtotal - quantity * Number(item.unit_cost))
        : null;

      mart.factSales.push({
        transaction_id: txId,
        customer_id: customerId,
        date_key: dateKey,
        product_id: productId,
        quantity,
        unit_price: unitPrice,
        line_subtotal: lineSubtotal,
        tax_rate: effectiveTaxRate,
        line_tax: lineTax,
        line_total: lineTotalWithTax,
        transaction_subtotal: breakdown.subtotal,
        transaction_tax: breakdown.tax_amount,
        transaction_total: total,
        status: safeStatus,
        net_margin: netMargin,
        payload_total_matches_items: Math.abs(breakdown.grand_total - total) < 0.01
      });
    }
  }

  mart.dimCustomer = [...customers.values()];
  mart.dimProduct = [...products.values()];
  mart.dimTime = [...times.values()].sort((a, b) => a.date_key.localeCompare(b.date_key));

  storage.writeMartWithRollback(mart, options);

  return {
    inputRecords: totalLines,
    transformedTransactions: seenTransactionIds.size,
    factRows: mart.factSales.length,
    rejectedOrDuplicateTransactions: rejectedRecords,
    dimensions: {
      customers: mart.dimCustomer.length,
      products: mart.dimProduct.length,
      dates: mart.dimTime.length
    }
  };
}

module.exports = { runETL };
/**
 * @fileoverview Payload schema validation, automatic tax calculation,
 * and status normalization for incoming storefront transactions.
 */

const config = require('./config');

const STATUS_MAP = {
  completed: 'Completed',
  pending: 'Pending',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  checkout: 'Checkout'
};

/**
 * Rounds currency values cleanly to 2 decimal places.
 *
 * @param {number} value
 * @returns {number}
 */
function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Automatically calculates subtotal, tax amount, and tax-inclusive grand total
 * from transaction line items.
 *
 * @param {Array<{ quantity: number, unit_price: number }>} lineItems
 * @param {number} [taxRate=config.TAX_RATE]
 * @returns {{ subtotal: number, tax_rate: number, tax_amount: number, grand_total: number }}
 */
function calculateTaxBreakdown(lineItems = [], taxRate = config.TAX_RATE) {
  const rate = Number.isFinite(Number(taxRate)) && Number(taxRate) >= 0
    ? Number(taxRate)
    : config.TAX_RATE;

  const subtotal = roundMoney(
    lineItems.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unit_price || 0), 0)
  );
  const tax_amount = roundMoney(subtotal * rate);
  const grand_total = roundMoney(subtotal + tax_amount);

  return {
    subtotal,
    tax_rate: rate,
    tax_amount,
    grand_total
  };
}

/**
 * Validates incoming transaction payloads against required schema rules.
 * `monetary_value` may be provided explicitly or omitted for automatic tax-inclusive calculation.
 *
 * @param {object} tx
 * @returns {string[]} List of validation error messages
 */
function validateTransaction(tx) {
  const errors = [];
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) {
    return ['Payload must be a JSON object'];
  }

  for (const field of ['transaction_id', 'timestamp', 'entity_id', 'status', 'line_items']) {
    if (tx[field] === undefined || tx[field] === null || tx[field] === '') {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (tx.timestamp && Number.isNaN(Date.parse(tx.timestamp))) {
    errors.push('timestamp must be a valid ISO-8601 date');
  }

  if (
    tx.monetary_value !== undefined &&
    tx.monetary_value !== null &&
    tx.monetary_value !== '' &&
    (!Number.isFinite(Number(tx.monetary_value)) || Number(tx.monetary_value) < 0)
  ) {
    errors.push('monetary_value must be a non-negative number');
  }

  if (tx.line_items !== undefined) {
    if (!Array.isArray(tx.line_items) || tx.line_items.length === 0) {
      errors.push('line_items must be a non-empty array');
    } else {
      tx.line_items.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
          errors.push(`line_items[${index}] must be an object`);
          return;
        }
        if (!item.product_id || !item.name) {
          errors.push(`line_items[${index}] requires product_id and name`);
        }
        if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0) {
          errors.push(`line_items[${index}].quantity must be positive`);
        }
        if (!Number.isFinite(Number(item.unit_price)) || Number(item.unit_price) < 0) {
          errors.push(`line_items[${index}].unit_price must be non-negative`);
        }
        if (
          item.unit_cost !== undefined &&
          item.unit_cost !== '' &&
          (!Number.isFinite(Number(item.unit_cost)) || Number(item.unit_cost) < 0)
        ) {
          errors.push(`line_items[${index}].unit_cost must be non-negative`);
        }
      });
    }
  }

  return errors;
}

/**
 * Normalizes raw status strings into standardized dimensional labels.
 *
 * @param {string} status
 * @returns {string}
 */
function normalizeStatus(status) {
  return STATUS_MAP[String(status || '').trim().toLowerCase()] || 'Other';
}

module.exports = {
  roundMoney,
  calculateTaxBreakdown,
  validateTransaction,
  normalizeStatus
};
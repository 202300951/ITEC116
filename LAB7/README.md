# ITEC 116 Capstone — E-Commerce to Business Intelligence Integration

Modular, zero-dependency Node.js integration pipeline built for **ITEC 116 Group Activities 7 & 8**.

## Features
- **Automatic Tax Calculation:** Computes subtotal, configurable tax (`TAX_RATE`, default `0.12` / 12% VAT), and tax-inclusive grand totals in real time on the storefront form and during API ingestion.
- **Resilient Ingestion & ETL:** Includes Bearer authentication, schema validation, duplicate `transaction_id` idempotency (`HTTP 409`), bounded retry policies, atomic file persistence, and automatic `.bak` snapshot rollback on mid-transaction ETL errors.
- **Star-Schema Dimensional Model:** Populates `Fact_Sales`, `Dim_Customer`, `Dim_Product`, and `Dim_Time` with line-level tax, net margin (when `unit_cost` is provided), and reconciliation metrics.

## Run & Test
1. Start the server:
   ```bash
   npm start
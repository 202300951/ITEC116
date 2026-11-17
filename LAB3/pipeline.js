const crypto = require("crypto");

// Inbound HR Request (Sub-Team A Payload + Sub-Team D Security Headers)
const inboundRequest = {
  headers: {
    Authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.mock_token",
    "Content-Type": "application/json",
    "Idempotency-Key": "GL-BATCH-202609-EMP-101-CC101",
    "X-Correlation-ID": "txn-payroll-202609-001"
  },
  securityContext: {
    mtlsVerified: true,
    tokenClaims: {
      issuer: "auth.corp.enterprise.local",
      clientId: "hr-core-payroll-worker",
      authorizedScope: "finance:ledger:write"
    }
  },
  body: {
    payroll: {
      payrollBatchId: "BATCH-202609-001",
      employeeId: "EMP-101",
      costCenterCode: "CC-IT-101",
      payPeriodEndDate: "2026-09-15",
      baseSalary: 25000.00,
      overtimePay: 5000.00,
      statutoryDeductions: 2000.00,
      withholdingTax: 3000.00,
      netDisbursement: 25000.00
    }
  }
};

// Track processed idempotency keys to prevent duplicate ledger postings
const processedIdempotencyKeys = new Set();

function executePayrollIntegration(request, simulateNetworkFailure = false) {
  const hr = request.body.payroll;
  const idempotencyKey = request.headers["Idempotency-Key"];
  const correlationId = request.headers["X-Correlation-ID"];

  // --- SECURITY GATE: OAuth 2.0 Scope & mTLS Check (Task 3) ---
  if (!request.securityContext.mtlsVerified) {
    return buildAuditResponse(hr, null, correlationId, idempotencyKey, "MTLS_HANDSHAKE_FAILED", 401);
  }
  if (request.securityContext.tokenClaims.authorizedScope !== "finance:ledger:write") {
    return buildAuditResponse(hr, null, correlationId, idempotencyKey, "FORBIDDEN_INSUFFICIENT_SCOPE", 403);
  }

  // --- IDEMPOTENCY CHECK (Task 2) ---
  if (processedIdempotencyKeys.has(idempotencyKey)) {
    console.log(`[IDEMPOTENCY] Duplicate request ignored for key: ${idempotencyKey}`);
    return { status: "DUPLICATE_IGNORED", idempotencyKey };
  }

  // --- STEP 1: DATA CASTING & INVARIANT VALIDATION (Task 2) ---
  console.log("=== STEP 1: DATA CASTING & INVARIANT VALIDATION ===");
  const baseSalary = Number(Number(hr.baseSalary).toFixed(2));
  const overtimePay = Number(Number(hr.overtimePay).toFixed(2));
  const statutoryDeductions = Number(Number(hr.statutoryDeductions).toFixed(2));
  const withholdingTax = Number(Number(hr.withholdingTax).toFixed(2));
  const netDisbursement = Number(Number(hr.netDisbursement).toFixed(2));

  const totalDebits = Number((baseSalary + overtimePay).toFixed(2));
  const totalCredits = Number((statutoryDeductions + withholdingTax + netDisbursement).toFixed(2));

  console.log(`Total Debits (Expenses): ${totalDebits.toFixed(2)}`);
  console.log(`Total Credits (Liabilities + Cash): ${totalCredits.toFixed(2)}`);

  if (totalDebits !== totalCredits) {
    return triggerRollback(
      hr,
      correlationId,
      idempotencyKey,
      "UNBALANCED_ENTRY",
      `Debits (${totalDebits}) do not equal Credits (${totalCredits}).`
    );
  }

  // --- STEP 2: TRANSFORMATION MATRIX (HR -> GENERAL LEDGER) ---
  console.log("\n=== STEP 2: TRANSFORMATION MATRIX (HR -> GENERAL LEDGER) ===");
  const financeLedgerPayload = {
    journalBatchNumber: `BATCH-GL-${hr.payrollBatchId.replace("BATCH-", "")}`,
    postingDate: hr.payPeriodEndDate,
    costCenterSegment: hr.costCenterCode,
    subledgerAccountId: hr.employeeId,
    totalDisbursement: totalDebits,
    journalLines: [
      {
        lineNumber: 1,
        accountCode: "5001-01",
        accountName: "Regular Salaries Expense",
        entryType: "DEBIT",
        amount: baseSalary
      },
      {
        lineNumber: 2,
        accountCode: "5001-02",
        accountName: "Overtime Expense",
        entryType: "DEBIT",
        amount: overtimePay
      },
      {
        lineNumber: 3,
        accountCode: "2020",
        accountName: "Mandatory Benefits Payable",
        entryType: "CREDIT",
        amount: statutoryDeductions
      },
      {
        lineNumber: 4,
        accountCode: "2010",
        accountName: "Withholding Tax Payable",
        entryType: "CREDIT",
        amount: withholdingTax
      },
      {
        lineNumber: 5,
        accountCode: "1010",
        accountName: "Payroll Clearing / Bank Account",
        entryType: "CREDIT",
        amount: netDisbursement
      }
    ]
  };

  console.log("Transformed Finance GL Payload:\n", JSON.stringify(financeLedgerPayload, null, 2));

  // --- STEP 3: TRANSACTIONAL RESILIENCY & 2-PHASE COMMIT (2PC) ---
  console.log("\n=== STEP 3: TRANSACTIONAL RESILIENCY & 2-PHASE COMMIT (2PC) ===");
  console.log(`[Phase 1: Prepare] HR record ${hr.employeeId} locked in PENDING_SYNC state.`);

  if (simulateNetworkFailure) {
    return triggerRollback(
      hr,
      correlationId,
      idempotencyKey,
      "NETWORK_TIMEOUT",
      "Network connection timed out after 5000ms before Finance acknowledged journal posting."
    );
  }

  processedIdempotencyKeys.add(idempotencyKey);
  console.log("[Phase 2: Commit] Finance successfully credited ledger accounts.");
  console.log(`[Phase 2: Commit] HR record ${hr.employeeId} transitioned to SYNCED_COMMITTED.`);

  const auditLog = buildAuditResponse(
    hr,
    financeLedgerPayload,
    correlationId,
    idempotencyKey,
    "COMMITTED_SUCCESS",
    201
  );

  console.log("\n=== STEP 4: TAMPER-EVIDENT AUDIT LOG (TASK 3) ===");
  console.log(JSON.stringify(auditLog, null, 2));

  return { status: "SUCCESS", payload: financeLedgerPayload, auditLog };
}

// Compensating Rollback Function (Task 2)
function triggerRollback(hr, correlationId, idempotencyKey, reasonCode, message) {
  console.error(`\n[ABORT TRIGGERED] Reason: ${reasonCode}`);
  console.error(`[ROLLBACK DETAIL] ${message}`);
  console.warn(`[COMPENSATING ACTION] HR record for ${hr.employeeId} unlocked and reverted to 'FAILED_PENDING_RETRY'.`);
  console.warn("[FINANCE GUARANTEE] 0 ledger lines committed to Accounts 5001-01, 5001-02, 2020, 2010, or 1010.");

  const auditLog = buildAuditResponse(hr, null, correlationId, idempotencyKey, `ROLLBACK_${reasonCode}`, 504);
  console.log("\n=== AUDIT LOG (ABORTED TRANSACTION) ===");
  console.log(JSON.stringify(auditLog, null, 2));

  return { status: "ROLLBACK_EXECUTED", reasonCode, message, auditLog };
}

// SHA-256 Checksum & Audit Event Generator (Task 3)
function buildAuditResponse(hr, financePayload, correlationId, idempotencyKey, executionStatus, httpResponseCode) {
  const rawData = JSON.stringify(financePayload || hr);
  const payloadChecksum = crypto.createHash("sha256").update(rawData).digest("hex");

  return {
    auditEventId: `AUD-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-001`,
    timestamp: new Date().toISOString(),
    eventType: "PAYROLL_GL_BATCH_POSTING",
    initiatingService: "HR_PAYROLL_SERVICE",
    targetService: "FINANCE_LEDGER_SERVICE",
    targetEndpoint: "/api/v1/ledger/journal-batches",
    httpMethod: "POST",
    securityProtocol: "OAuth 2.0 Client Credentials with mTLS",
    businessContext: {
      payrollBatchId: hr.payrollBatchId,
      journalBatchNumber: financePayload ? financePayload.journalBatchNumber : null,
      costCenterSegment: hr.costCenterCode,
      employeeId: hr.employeeId,
      totalDisbursement: Number((hr.baseSalary + hr.overtimePay).toFixed(2)),
      currency: "PHP"
    },
    executionTrace: {
      correlationId,
      idempotencyKey,
      executionStatus,
      httpResponseCode,
      payloadChecksum
    }
  };
}

// --- EXECUTION TESTS ---
console.log("---------------- RUN 1: SUCCESSFUL PIPELINE SYNC ----------------");
executePayrollIntegration(inboundRequest, false);

console.log("\n---------------- RUN 2: NETWORK DROP / 2PC ROLLBACK ----------------");
// Using a fresh correlation/idempotency key to test network drop path
const retryRequest = JSON.parse(JSON.stringify(inboundRequest));
retryRequest.headers["Idempotency-Key"] = "GL-BATCH-202609-EMP-101-CC101-RETRY";
executePayrollIntegration(retryRequest, true);
#!/usr/bin/env node

/**
 * QuickBooks Desktop MCP Server
 *
 * A Model Context Protocol (MCP) server that provides comprehensive tools
 * for managing client books in QuickBooks Desktop. Communicates with
 * QuickBooks via the QBXML SDK protocol over the session manager.
 *
 * Capabilities:
 * - Customer management (CRUD)
 * - Vendor management (CRUD)
 * - Chart of Accounts management
 * - Invoice management (create, query, update, delete)
 * - Bill / Accounts Payable management
 * - Item / Product & Service management
 * - Payment recording
 * - Estimate / Quote management
 * - Purchase Order management (vendor-side, non-posting)
 * - Journal Entry management (debit/credit balanced GL postings)
 * - Employee management
 * - Financial reporting (AR/AP aging, balance summaries, P&L, Balance Sheet)
 * - Raw QBXML query access for advanced operations
 * - Session lifecycle management
 *
 * Connection modes:
 * - Live: Communicates with QuickBooks Desktop via QBXMLRP2 (Windows only)
 * - Simulation: In-memory mock data for development/testing (any platform)
 *
 * Environment variables:
 *   QB_COMPANY_FILE  - Path to the .qbw company file (default: simulation)
 *   QB_APP_NAME      - Application name for QB registration (default: "MCP QuickBooks Manager")
 *   QB_APP_ID        - Application ID (optional)
 *   QB_SIMULATION    - Force simulation mode (default: true on non-Windows)
 *   QB_LIVE          - Set to "1" to attempt live connection on Windows
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { QBSessionManager } from "./session/manager.js";
import type { QBConnectionConfig } from "./types/qbxml.js";

import { registerCustomerTools } from "./tools/customers.js";
import { registerVendorTools } from "./tools/vendors.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerInvoiceTools } from "./tools/invoices.js";
import { registerBillTools } from "./tools/bills.js";
import { registerItemTools } from "./tools/items.js";
import { registerPaymentTools } from "./tools/payments.js";
import { registerEstimateTools } from "./tools/estimates.js";
import { registerSalesReceiptTools } from "./tools/sales-receipts.js";
import { registerCreditMemoTools } from "./tools/credit-memos.js";
import { registerPurchaseOrderTools } from "./tools/purchase-orders.js";
import { registerJournalEntryTools } from "./tools/journal-entries.js";
import { registerEmployeeTools } from "./tools/employees.js";
import { registerListTools } from "./tools/lists.js";
import { registerReportTools } from "./tools/reports.js";
import { registerTransactionTools } from "./tools/transactions.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const config: QBConnectionConfig = {
  // Empty string means "use whatever company file is currently open in QB
  // Desktop" (QBXMLRP2.BeginSession contract). Better default for an
  // interactive tool than a phantom Sample Company.qbw path that may not
  // exist on this machine.
  companyFile: process.env.QB_COMPANY_FILE ?? "",
  appName: process.env.QB_APP_NAME ?? "MCP QuickBooks Manager",
  appId: process.env.QB_APP_ID,
  qbxmlVersion: process.env.QB_QBXML_VERSION ?? "16.0",
  connectionMode: (process.env.QB_CONNECTION_MODE as "localOnly" | "remoteOnly" | "optimistic") ?? "optimistic",
};

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new McpServer(
  {
    name: "quickbooks-desktop",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      logging: {},
    },
    instructions: [
      "QuickBooks Desktop MCP Server — manages client books via the QBXML SDK.",
      "",
      "Available tool categories:",
      "  • qb_customer_*    — Customer CRUD (list, add, update, delete)",
      "  • qb_vendor_*      — Vendor CRUD (list, add, update, delete)",
      "  • qb_account_*     — Chart of Accounts (list, add, update, make_inactive, delete) — qb_account_make_inactive flips IsActive to false (preferred — preserves history; account hides from the default list view but stays referenceable). qb_account_delete is a hard delete that real QB rejects (statusCode 3260/3170) for accounts with transaction history; use only for empty accounts created in error.",
      "  • qb_invoice_*     — Invoice management (list, create, update, delete) — qb_invoice_update takes txnId + editSequence (from a prior list); passing `lines` REPLACES the invoice's line set wholesale (lines with a matching txnLineID are merged; lines you don't list are dropped). Subtotal / BalanceRemaining / IsPaid recompute automatically; AppliedAmount is preserved (so dropping a line below the applied amount produces a negative BalanceRemaining = over-application). Customer balance moves by the change in BalanceRemaining. A stale editSequence rejects with statusCode 3170.",
      "  • qb_bill_*        — Bill/AP management (list, create, update, delete, pay, payment_list) — qb_bill_create requires at least one of expenseLines or itemLines; AmountDue = sum of all line amounts. qb_bill_update takes txnId + editSequence (from a prior list); passing expenseLines / itemLines REPLACES the bill's line set wholesale (lines with a matching txnLineID are merged; lines you don't list are dropped). A stale editSequence rejects with statusCode 3170. qb_bill_pay records a BillPaymentCheck or BillPaymentCreditCard (paymentMethod: 'check' | 'creditcard') against one or more open bills via applyTo: [{txnId, amount, discountAmount?, discountAccountName?}]; each entry reduces the named bill's AmountDue, flips IsPaid when AmountDue hits zero, and decrements vendor Balance by the applied sum. applyTo is required and non-empty; unknown bill TxnID rejects atomically (no partial mutations). qb_bill_payment_list fans across both BillPaymentCheck and BillPaymentCreditCard stores by default — pass paymentType to scope.",
      "  • qb_item_*        — Product & Service items (list, add, update, delete) — itemType is one of Service / Inventory / NonInventory / OtherCharge / Group; required on add/update/delete, optional on list",
      "  • qb_payment_*     — Payment recording, application, queries — qb_payment_receive accepts optional appliedTo: [{txnId, amount, discountAmount?, discountAccountName?}] to close out invoices on creation (without appliedTo the payment is recorded as a customer credit). qb_payment_apply re-targets an EXISTING payment to a different invoice set via txnId + editSequence (from a prior qb_payment_list) plus a replacement applyTo array — the prior application is reversed and the new one applied atomically, customer balance moves by the delta. Pass applyTo: [] to fully unapply. TotalAmount is immutable on this path; stale editSequence rejects with 3170.",
      "  • qb_estimate_*    — Estimate/quote management (list, create, update, delete, convert_to_invoice). qb_estimate_create accepts a `lines` array (same shape as qb_invoice_create) and the simulation derives Subtotal from the line set. qb_estimate_update mirrors qb_invoice_update — pass txnId + editSequence (from a prior list) plus any header fields and/or replacement `lines`; passing `lines` REPLACES the line set wholesale and Subtotal recomputes (estimates have no AR balance side-effect). qb_estimate_convert_to_invoice reads the source estimate, submits an InvoiceAddRq with CustomerRef + carried lines, and (default) marks the estimate IsAccepted=true; pass markAccepted: false to leave it unmarked. The mark-accepted step runs after the invoice is created, so the new invoice is preserved even if the flip fails (rare — surfaced via markAcceptedError in the response).",
      "  • qb_sales_receipt_*— Sales receipt (cash sale) management (list, create, update, delete). Cash-sale equivalent of an invoice — sale settles instantly, no AR balance, no payment application. Funds post to depositToAccountName (typically 'Undeposited Funds' or a bank account); paymentMethodName documents how the customer paid. qb_sales_receipt_create accepts a `lines` array (same shape as qb_invoice_create); Subtotal derives from the line set and TotalAmount = Subtotal + SalesTaxTotal. qb_sales_receipt_update takes txnId + editSequence (from a prior list); passing `lines` REPLACES the line set wholesale and Subtotal/TotalAmount recompute. There is no BalanceRemaining or IsPaid (the receipt is closed on creation) and no customer-balance side effect (cash sales don't post to AR). Stale editSequence rejects with 3170.",
      "  • qb_credit_memo_* — Credit memo management (list, create, update, apply, delete). AR-negative analog of an invoice — same line shape, but TotalAmount credits the customer instead of billing them. On creation customer.Balance moves by -TotalAmount; RemainingValue = TotalAmount − AppliedAmount tracks the unapplied credit pool. qb_credit_memo_create accepts `lines` (Subtotal + TotalAmount derive from the set) and an optional `appliedTo: [{txnId, amount}]` to immediately close out part or all of one or more open invoices on creation; sum(amount) ≤ TotalAmount, unknown invoice TxnID rejects atomically. qb_credit_memo_update mirrors qb_invoice_update for header/line edits — passing `lines` REPLACES the line set wholesale, Subtotal/TotalAmount recompute, and customer balance moves by -(newTotal − oldTotal) (memo grew → customer balance drops further). qb_credit_memo_apply re-targets an EXISTING memo to a different invoice set via txnId + editSequence + replacement applyTo array; the prior application is reversed and the new one applied atomically without further customer-balance movement (the credit pool just shifts to invoice-level). Pass applyTo: [] to fully unapply. TotalAmount is immutable on this path; stale editSequence rejects with 3170.",
      "  • qb_purchase_order_* — Purchase order management (list, create, update, delete). Vendor-side analog of Estimate — a non-posting commitment to buy from a vendor. Does NOT touch Vendor.Balance / AP (that only moves when items are received against the PO via a bill). Lines use Cost (not Rate); each line's Amount = Quantity * Cost is computed at the tool layer. qb_purchase_order_create requires at least one line; TotalAmount = sum(line amounts) — POs have no separate Subtotal header. qb_purchase_order_update mirrors qb_invoice_update for header/line edits — passing `lines` REPLACES the line set wholesale and TotalAmount recomputes; no vendor-balance side effect on either header or line changes. isManuallyClosed: true on create or update marks the PO closed regardless of receipt activity (typical workflow: cancel a PO that won't be received). Stale editSequence rejects with 3170.",
      "  • qb_journal_entry_* — Journal entry management (list, create, update, delete). Two-sided GL posting — every entry carries a `debits` array AND a `credits` array, each line naming a GL account by full name. The hard invariant is sum(debits.amount) === sum(credits.amount) to the cent — unbalanced entries reject with statusCode 3030 (validated before persist on both create and update). qb_journal_entry_create requires at least one line on each side. qb_journal_entry_update takes txnId + editSequence; passing `debits` or `credits` REPLACES that side wholesale (lines with a matching txnLineID are merged, lines you don't list are dropped) and the post-mod sums must still balance. Each line accepts an optional entityName (Customer/Vendor/Employee/OtherName) — recorded faithfully but does NOT move that entity's open balance in this server's first cut (real QB moves AR/AP per-line; that bookkeeping is deferred). Stale editSequence rejects with 3170.",
      "  • qb_employee_*    — Employee management (list, add, update, make_inactive, delete) — qb_employee_make_inactive flips IsActive to false (preferred — preserves history; employee hides from the default list view but stays referenceable by historical paychecks/timesheets). qb_employee_delete is a hard delete that real QB rejects (statusCode 3260/3170) for employees with any transaction history; use only for empty employee records created in error.",
      "  • qb_class_list / qb_terms_list / qb_payment_method_list / qb_sales_rep_list / qb_customer_type_list / qb_vendor_type_list — Reference lists (read-only). Used to discover valid FullName values that transactions reference (Class on lines, Terms on invoice/bill headers, PaymentMethod on receive-payments, SalesRep/CustomerType/VendorType for segmentation). qb_terms_list fans across both StandardTerms and DateDrivenTerms by default — pass termsType to scope.",
      "  • qb_transaction_list_by_account — Cross-type posting list (TransactionQueryRq) — every line that hit a specific GL account, optionally bounded by date, sorted by TxnDate ascending with RunningBalance computed in the tool layer (current = opening + Σ period postings; opening = Account.Balance − periodSum, exact when toDate ≥ now). Sign convention: positive = increases the target account's natural balance. Sim emits LINE-LEVEL postings only (Bill/Check expense+item lines, Invoice/SR/CreditMemo income lines via item resolution, JE debit+credit lines); implicit AR/AP/Bank counter-postings are not surfaced — live QB returns full posting detail.",
      "  • qb_balance_summary / qb_ar_aging / qb_ap_aging / qb_pnl_report / qb_balance_sheet_report — Financial reports. qb_pnl_report walks Invoice/SalesReceipt/CreditMemo (income) and Bill/Check/CreditCardCharge plus JournalEntry (expense) lines filtered by TxnDate ∈ [fromDate, toDate], aggregates by GL account → AccountType, returns canonical-ordered sections (Income → Other Income → COGS → Expenses → Other Expenses) plus TotalIncome / TotalCOGS / TotalExpenses / GrossProfit / NetIncome. qb_balance_sheet_report returns Assets / Liabilities / Equity sections from Account.Balance (snapshot — asOfDate is advisory for those sections in simulation), with current-period NetIncome (lifetime → asOfDate) closed into Equity; the accounting identity Assets = Liabilities + Equity is reconciled by closing the simulation seed gap into a 'Balancing Adjustment' row when present. qb_balance_summary is a flattened view of both: AS/LI/EQ figures are sourced from BalanceSheetStandard (toDate=asOfDate), INC/EXP from ProfitAndLossStandard (lifetime through asOfDate), then bucketed back into the 16-way canonical AccountType order via a name→type lookup. NonPosting accounts (estimates/POs) fall back to Account.Balance (they don't post to GL). All three report tools accept basis: 'Accrual' | 'Cash' (currently identical in simulation).",
      "  • qb_company_info  — Connection & company info",
      "  • qb_company_open  — Switch the active QuickBooks company file mid-session. Closes the current session, swaps the configured `.qbw` path, and opens a new session against the new file. Live mode requires QB Desktop to have the target file open (QBXMLRP2 cannot open a file QB hasn't loaded). Simulation mode resets the in-memory store to fresh seed — real QB persists per-file, sim doesn't, so without the reseed the operator would see entities from the prior company on the 'new' one (deliberate sim-fidelity tradeoff per DECISIONS.md 2026-05-09). Use qb_company_list first to discover available `.qbw` paths.",
      "  • qb_company_list  — List `.qbw` company files under $QB_COMPANY_ROOT (fallback: dirname($QB_COMPANY_FILE), or pass `root` arg). Pure filesystem op — identical in live and simulation. Returns [{companyFile, displayName, sizeBytes, modifiedAt}] sorted by modifiedAt desc. Pair with qb_company_open: the returned `companyFile` paths are valid input.",
      "  • qb_raw_query     — Direct QBXML queries for advanced use",
      "  • qb_session_*     — Session connect/disconnect",
      "",
      "Workflow tips:",
      "  1. Start with qb_company_info to verify connection status.",
      "  2. Use qb_customer_list / qb_vendor_list to find existing records.",
      "  3. When updating records, always include ListID + EditSequence from a prior query.",
      "  4. Use qb_balance_summary for a quick financial overview.",
      "  5. For operations not covered by specific tools, use qb_raw_query.",
    ].join("\n"),
  }
);

// ---------------------------------------------------------------------------
// Session manager (lazy-initialized, shared across all tools)
// ---------------------------------------------------------------------------

let sessionManager: QBSessionManager | null = null;

function getSessionManager(): QBSessionManager {
  if (!sessionManager) {
    sessionManager = new QBSessionManager(config);
  }
  return sessionManager;
}

// ---------------------------------------------------------------------------
// Register all tool modules
// ---------------------------------------------------------------------------

registerCustomerTools(server, getSessionManager);
registerVendorTools(server, getSessionManager);
registerAccountTools(server, getSessionManager);
registerInvoiceTools(server, getSessionManager);
registerBillTools(server, getSessionManager);
registerItemTools(server, getSessionManager);
registerPaymentTools(server, getSessionManager);
registerEstimateTools(server, getSessionManager);
registerSalesReceiptTools(server, getSessionManager);
registerCreditMemoTools(server, getSessionManager);
registerPurchaseOrderTools(server, getSessionManager);
registerJournalEntryTools(server, getSessionManager);
registerEmployeeTools(server, getSessionManager);
registerListTools(server, getSessionManager);
registerReportTools(server, getSessionManager);
registerTransactionTools(server, getSessionManager);

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Graceful shutdown — close any open QuickBooks session before exiting so the
// QBXMLRP2 ticket isn't stranded. A stranded ticket means the next process
// connecting with the same appName has to wait for QB to time it out (~5
// minutes) or for the operator to restart QB.
// ---------------------------------------------------------------------------

let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`\n[QB Session] Received ${signal}, closing QuickBooks session...`);
  if (sessionManager) {
    try {
      await sessionManager.closeSession();
    } catch (err) {
      console.error(`[QB Session] Shutdown error (continuing exit): ${(err as Error).message}`);
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Eagerly construct the session manager so the Mode banner reports the
  // actual resolved mode (which honors QB_SIMULATION overrides) rather than
  // duplicating the env-resolution logic here. Construction is cheap — it
  // reads env, picks a mode, and creates an empty SimulationStore. No QB
  // session opens until the first tool call.
  const sm = getSessionManager();
  console.error("QuickBooks Desktop MCP Server running on stdio");
  console.error(`  Company file: ${config.companyFile || "(use currently open QB file)"}`);
  console.error(`  App name: ${config.appName}`);
  console.error(`  QBXML version: ${config.qbxmlVersion}`);
  console.error(`  Mode: ${sm.isSimulation() ? "simulation" : "live"}`);
}

main().catch((error) => {
  console.error("Fatal error starting QuickBooks MCP Server:", error);
  process.exit(1);
});

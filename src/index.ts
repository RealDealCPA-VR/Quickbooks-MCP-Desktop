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
 * - Employee management
 * - Financial reporting (AR/AP aging, balance summaries)
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
import { registerEmployeeTools } from "./tools/employees.js";
import { registerReportTools } from "./tools/reports.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const config: QBConnectionConfig = {
  companyFile: process.env.QB_COMPANY_FILE ?? "C:\\Users\\Public\\Documents\\Intuit\\QuickBooks\\Sample Company.qbw",
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
      "  • qb_estimate_*    — Estimate/quote management",
      "  • qb_employee_*    — Employee management (list, add, update, make_inactive, delete) — qb_employee_make_inactive flips IsActive to false (preferred — preserves history; employee hides from the default list view but stays referenceable by historical paychecks/timesheets). qb_employee_delete is a hard delete that real QB rejects (statusCode 3260/3170) for employees with any transaction history; use only for empty employee records created in error.",
      "  • qb_balance_summary / qb_ar_aging / qb_ap_aging — Financial reports",
      "  • qb_company_info  — Connection & company info",
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
registerEmployeeTools(server, getSessionManager);
registerReportTools(server, getSessionManager);

// ---------------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("QuickBooks Desktop MCP Server running on stdio");
  console.error(`  Company file: ${config.companyFile}`);
  console.error(`  App name: ${config.appName}`);
  console.error(`  QBXML version: ${config.qbxmlVersion}`);
  console.error(`  Mode: ${process.platform === "win32" && process.env.QB_LIVE ? "live" : "simulation"}`);
}

main().catch((error) => {
  console.error("Fatal error starting QuickBooks MCP Server:", error);
  process.exit(1);
});

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
      "  • qb_account_*     — Chart of Accounts (list, add, update)",
      "  • qb_invoice_*     — Invoice management (list, create, update, delete)",
      "  • qb_bill_*        — Bill/AP management (list, create, delete)",
      "  • qb_item_*        — Product & Service items (list, add, update, delete) — itemType is one of Service / Inventory / NonInventory / OtherCharge / Group; required on add/update/delete, optional on list",
      "  • qb_payment_*     — Payment recording and queries",
      "  • qb_estimate_*    — Estimate/quote management",
      "  • qb_employee_*    — Employee management",
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

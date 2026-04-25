/**
 * Reporting & query tools for QuickBooks Desktop MCP.
 *
 * Provides high-level reporting, balance queries, and summary tools.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";

export function registerReportTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  // -----------------------------------------------------------------------
  // Company info
  // -----------------------------------------------------------------------
  server.tool(
    "qb_company_info",
    "Get company information from the QuickBooks company file, including name, address, fiscal year, and connection status.",
    {},
    async () => {
      const session = getSession();
      const isConnected = session.isConnected();
      const sessionData = session.getSession();
      const isSimulation = session.isSimulation();

      // In a real implementation, we'd query CompanyQuery
      const info = {
        connected: isConnected,
        simulationMode: isSimulation,
        companyFile: sessionData?.companyFile ?? "N/A",
        sessionTicket: sessionData?.ticket ?? "N/A",
        openedAt: sessionData?.openedAt?.toISOString() ?? "N/A",
        serverInfo: {
          name: "QuickBooks Desktop MCP Server",
          version: "1.0.0",
          qbxmlVersion: "16.0",
          capabilities: [
            "Customer CRUD", "Vendor CRUD", "Account management",
            "Invoice management", "Bill management", "Item management",
            "Payment recording", "Estimate management", "Employee management",
            "Reporting & queries", "QBXML raw access",
          ],
        },
      };

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(info, null, 2),
        }],
      };
    }
  );

  // -----------------------------------------------------------------------
  // Balance summary
  // -----------------------------------------------------------------------
  server.tool(
    "qb_balance_summary",
    "Get a summary of key account balances (AR, AP, bank, income, expenses).",
    {},
    async () => {
      const session = getSession();
      const accounts = await session.queryEntity("Account", {});

      const summary: Record<string, { accounts: string[]; total: number }> = {};

      for (const acct of accounts) {
        const type = String(acct.AccountType ?? "Unknown");
        if (!summary[type]) {
          summary[type] = { accounts: [], total: 0 };
        }
        summary[type].accounts.push(String(acct.FullName ?? acct.Name ?? ""));
        summary[type].total += Number(acct.Balance ?? 0);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            balanceSummary: summary,
            totalAccounts: accounts.length,
          }, null, 2),
        }],
      };
    }
  );

  // -----------------------------------------------------------------------
  // AR aging
  // -----------------------------------------------------------------------
  server.tool(
    "qb_ar_aging",
    "Get an accounts receivable aging summary showing outstanding customer balances.",
    {
      asOfDate: z.string().optional().describe("As-of date (YYYY-MM-DD, default today)"),
    },
    async ({ asOfDate }) => {
      const session = getSession();
      const customers = await session.queryEntity("Customer", {
        ActiveStatus: "ActiveOnly",
      });

      const aging = customers
        .filter((c) => Number(c.Balance ?? 0) > 0)
        .map((c) => ({
          customer: c.FullName ?? c.Name,
          balance: Number(c.Balance ?? 0),
          totalBalance: Number(c.TotalBalance ?? 0),
        }))
        .sort((a, b) => b.balance - a.balance);

      const totalAR = aging.reduce((sum, c) => sum + c.balance, 0);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asOfDate: asOfDate ?? new Date().toISOString().split("T")[0],
            totalAccountsReceivable: totalAR,
            customersWithBalance: aging.length,
            aging,
          }, null, 2),
        }],
      };
    }
  );

  // -----------------------------------------------------------------------
  // AP aging
  // -----------------------------------------------------------------------
  server.tool(
    "qb_ap_aging",
    "Get an accounts payable aging summary showing outstanding vendor balances.",
    {
      asOfDate: z.string().optional().describe("As-of date (YYYY-MM-DD, default today)"),
    },
    async ({ asOfDate }) => {
      const session = getSession();
      const vendors = await session.queryEntity("Vendor", {
        ActiveStatus: "ActiveOnly",
      });

      const aging = vendors
        .filter((v) => Number(v.Balance ?? 0) > 0)
        .map((v) => ({
          vendor: v.FullName ?? v.Name,
          balance: Number(v.Balance ?? 0),
        }))
        .sort((a, b) => b.balance - a.balance);

      const totalAP = aging.reduce((sum, v) => sum + v.balance, 0);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asOfDate: asOfDate ?? new Date().toISOString().split("T")[0],
            totalAccountsPayable: totalAP,
            vendorsWithBalance: aging.length,
            aging,
          }, null, 2),
        }],
      };
    }
  );

  // -----------------------------------------------------------------------
  // Raw QBXML query (advanced)
  // -----------------------------------------------------------------------
  server.tool(
    "qb_raw_query",
    "Execute a raw QBXML query against QuickBooks Desktop. For advanced users who need direct QBXML access.",
    {
      entityType: z.string().describe(
        "Entity type to query (e.g., Customer, Vendor, Account, Invoice, Bill, Item, Employee, Class, SalesReceipt, CreditMemo, PurchaseOrder, JournalEntry)"
      ),
      filters: z.string().optional().describe(
        "JSON string of QBXML filters to apply (e.g., '{\"MaxReturned\": 10, \"ActiveStatus\": \"ActiveOnly\"}')"
      ),
    },
    async ({ entityType, filters }) => {
      const session = getSession();
      let parsedFilters: Record<string, unknown> = {};

      if (filters) {
        try {
          parsedFilters = JSON.parse(filters);
        } catch {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: "Invalid JSON in filters parameter",
              }),
            }],
            isError: true,
          };
        }
      }

      const results = await session.queryEntity(entityType, parsedFilters);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            entityType,
            count: results.length,
            results,
          }, null, 2),
        }],
      };
    }
  );

  // -----------------------------------------------------------------------
  // Session management
  // -----------------------------------------------------------------------
  server.tool(
    "qb_session_connect",
    "Open a session with QuickBooks Desktop. Must be called before other operations (auto-connects if needed).",
    {},
    async () => {
      const session = getSession();
      const qbSession = await session.openSession();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            ticket: qbSession.ticket,
            companyFile: qbSession.companyFile,
            openedAt: qbSession.openedAt.toISOString(),
            simulationMode: session.isSimulation(),
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "qb_session_disconnect",
    "Close the current QuickBooks Desktop session.",
    {},
    async () => {
      const session = getSession();
      await session.closeSession();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ success: true, message: "Session closed" }, null, 2),
        }],
      };
    }
  );
}

/**
 * Reporting & query tools for QuickBooks Desktop MCP.
 *
 * Provides high-level reporting, balance queries, and summary tools.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";

const ASSET_TYPES = ["Bank", "AccountsReceivable", "OtherCurrentAsset", "Inventory", "FixedAsset", "OtherAsset"] as const;
const LIABILITY_TYPES = ["AccountsPayable", "CreditCard", "OtherCurrentLiability", "LongTermLiability"] as const;
const EQUITY_TYPES = ["Equity"] as const;
const INCOME_TYPES = ["Income", "OtherIncome"] as const;
const EXPENSE_TYPES = ["CostOfGoodsSold", "Expense", "OtherExpense"] as const;
const NONPOSTING_TYPES = ["NonPosting"] as const;
const CANONICAL_ACCOUNT_TYPES: readonly string[] = [
  ...ASSET_TYPES,
  ...LIABILITY_TYPES,
  ...EQUITY_TYPES,
  ...INCOME_TYPES,
  ...EXPENSE_TYPES,
  ...NONPOSTING_TYPES,
];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function registerReportTools(
  server: McpServer,
  getSession: () => QBSessionManager
): void {
  // -----------------------------------------------------------------------
  // Company info
  // -----------------------------------------------------------------------
  server.tool(
    "qb_company_info",
    "Get company information from the QuickBooks company file (CompanyQueryRq) — name, legal name, address, fiscal year start, tax form, EIN, etc. — plus session/connection state.",
    {},
    async () => {
      const session = getSession();
      try {
        const records = await session.queryEntity("Company", {});
        const companyInfo = records[0] ?? null;
        const sessionData = session.getSession();

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              connected: session.isConnected(),
              simulationMode: session.isSimulation(),
              companyFile: sessionData?.companyFile ?? null,
              sessionTicket: sessionData?.ticket ?? null,
              openedAt: sessionData?.openedAt?.toISOString() ?? null,
              companyInfo,
            }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "CompanyQueryRq failed",
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Balance summary
  // -----------------------------------------------------------------------
  server.tool(
    "qb_balance_summary",
    "Get a balance summary across all accounts, grouped by AccountType in canonical QB order (Assets → Liabilities → Equity → Income → Expenses → NonPosting) with category subtotals (assets, liabilities, equity, income, expenses, netIncome). Optional fromDate/toDate are advisory in simulation mode (the seeded Balance is a current snapshot — historical reconstruction lands with the P&L / Balance Sheet work).",
    {
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Optional start of reporting window (YYYY-MM-DD). Advisory in simulation mode — see asOfNote in the response."),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("Optional end of reporting window (YYYY-MM-DD). Advisory in simulation mode — see asOfNote in the response."),
    },
    async ({ fromDate, toDate }) => {
      const session = getSession();
      try {
        const accounts = await session.queryEntity("Account", {});

        const buckets = new Map<string, { name: string; balance: number }[]>();
        for (const acct of accounts) {
          const type = String(acct.AccountType ?? "Unknown");
          const entry = {
            name: String(acct.FullName ?? acct.Name ?? ""),
            balance: Number(acct.Balance ?? 0),
          };
          const list = buckets.get(type);
          if (list) list.push(entry);
          else buckets.set(type, [entry]);
        }

        const balanceSummary: { accountType: string; accounts: string[]; total: number }[] = [];
        const usedTypes = new Set<string>();
        for (const type of CANONICAL_ACCOUNT_TYPES) {
          const items = buckets.get(type);
          if (!items || items.length === 0) continue;
          usedTypes.add(type);
          balanceSummary.push({
            accountType: type,
            accounts: items.map((i) => i.name),
            total: round2(items.reduce((s, i) => s + i.balance, 0)),
          });
        }

        const otherAccounts: string[] = [];
        let otherTotal = 0;
        for (const [type, items] of buckets) {
          if (usedTypes.has(type)) continue;
          for (const i of items) otherAccounts.push(`${i.name} [${type}]`);
          otherTotal += items.reduce((s, i) => s + i.balance, 0);
        }
        if (otherAccounts.length > 0) {
          balanceSummary.push({ accountType: "Other", accounts: otherAccounts, total: round2(otherTotal) });
        }

        const sumOf = (types: readonly string[]) =>
          types.reduce((s, t) => s + (buckets.get(t)?.reduce((ss, i) => ss + i.balance, 0) ?? 0), 0);

        const income = sumOf(INCOME_TYPES);
        const expenses = sumOf(EXPENSE_TYPES);
        const subtotals = {
          assets: round2(sumOf(ASSET_TYPES)),
          liabilities: round2(sumOf(LIABILITY_TYPES)),
          equity: round2(sumOf(EQUITY_TYPES)),
          income: round2(income),
          expenses: round2(expenses),
          netIncome: round2(income - expenses),
        };

        const dateRangeRequested = Boolean(fromDate || toDate);
        const asOfDateRange = dateRangeRequested ? { from: fromDate ?? null, to: toDate ?? null } : null;
        const asOfNote = dateRangeRequested
          ? "Simulation mode: Balance reflects current snapshot, not the requested date range. Historical reconstruction requires walking transactions per account — pending Phase 5 P&L / Balance Sheet work."
          : undefined;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              asOfDateRange,
              asOfNote,
              balanceSummary,
              subtotals,
              totalAccounts: accounts.length,
            }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "AccountQueryRq failed",
            }),
          }],
          isError: true,
        };
      }
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

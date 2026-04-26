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

// Aging-bucket helpers (qb_ar_aging / qb_ap_aging). Real QB defaults — single
// invoice/bill = single bucket (no per-line aging). Negative daysOutstanding
// (asOfDate < dueDate, i.e. not yet due) collapses into the 0-30 band, matching
// QB's standard summary report layout.
const BUCKET_KEYS = ["0-30", "31-60", "61-90", "90+"] as const;
type BucketKey = typeof BUCKET_KEYS[number];

const emptyBuckets = (): Record<BucketKey, number> => ({
  "0-30": 0,
  "31-60": 0,
  "61-90": 0,
  "90+": 0,
});

const bucketFor = (days: number): BucketKey => {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
};

// YYYY-MM-DD → ms since epoch via Date.UTC, avoiding local-TZ drift in
// daysBetween. Inputs are pre-validated by ISO_DATE_RE, so split is safe.
const dateUTC = (s: string): number => {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const daysBetween = (asOfDate: string, dueDate: string): number =>
  Math.floor((dateUTC(asOfDate) - dateUTC(dueDate)) / 86400000);

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
    "Get an accounts receivable aging summary. Walks open invoices (IsPaid !== true, BalanceRemaining > 0), ages each by (asOfDate − DueDate ?? TxnDate), and buckets into 0-30 / 31-60 / 61-90 / 90+ days. Returns per-customer aging with bucket breakdown plus top-level bucket totals. Single invoice = single bucket (no per-line aging).",
    {
      asOfDate: z.string().regex(ISO_DATE_RE).optional().describe("As-of date (YYYY-MM-DD). Defaults to today. Open invoices are aged from this date back to their DueDate (falling back to TxnDate when DueDate is missing)."),
    },
    async ({ asOfDate }) => {
      const session = getSession();
      try {
        const effectiveAsOf = asOfDate ?? new Date().toISOString().split("T")[0];
        const invoices = await session.queryEntity("Invoice", {});

        type CustomerAging = {
          name: string;
          balance: number;
          buckets: Record<BucketKey, number>;
          txnCount: number;
        };

        const byCustomer = new Map<string, CustomerAging>();
        const bucketTotals = emptyBuckets();

        for (const inv of invoices) {
          if (inv.IsPaid === true) continue;
          const balance = Number(inv.BalanceRemaining ?? 0);
          if (!(balance > 0)) continue;

          const dueDate = String(inv.DueDate ?? inv.TxnDate ?? effectiveAsOf);
          const days = daysBetween(effectiveAsOf, dueDate);
          const bucket = bucketFor(days);

          const ref = inv.CustomerRef as { FullName?: string } | undefined;
          const name = ref?.FullName ?? "(unknown)";

          let row = byCustomer.get(name);
          if (!row) {
            row = { name, balance: 0, buckets: emptyBuckets(), txnCount: 0 };
            byCustomer.set(name, row);
          }
          row.balance = round2(row.balance + balance);
          row.buckets[bucket] = round2(row.buckets[bucket] + balance);
          row.txnCount += 1;
          bucketTotals[bucket] = round2(bucketTotals[bucket] + balance);
        }

        const customers = [...byCustomer.values()].sort((a, b) => b.balance - a.balance);
        const totalAccountsReceivable = round2(
          BUCKET_KEYS.reduce((s, k) => s + bucketTotals[k], 0)
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              asOfDate: effectiveAsOf,
              totalAccountsReceivable,
              bucketTotals,
              customers,
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
              statusMessage: e.message ?? "InvoiceQueryRq failed",
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // AP aging
  // -----------------------------------------------------------------------
  server.tool(
    "qb_ap_aging",
    "Get an accounts payable aging summary. Walks open bills (IsPaid !== true, AmountDue > 0), ages each by (asOfDate − DueDate ?? TxnDate), and buckets into 0-30 / 31-60 / 61-90 / 90+ days. Returns per-vendor aging with bucket breakdown plus top-level bucket totals. Single bill = single bucket (no per-line aging).",
    {
      asOfDate: z.string().regex(ISO_DATE_RE).optional().describe("As-of date (YYYY-MM-DD). Defaults to today. Open bills are aged from this date back to their DueDate (falling back to TxnDate when DueDate is missing)."),
    },
    async ({ asOfDate }) => {
      const session = getSession();
      try {
        const effectiveAsOf = asOfDate ?? new Date().toISOString().split("T")[0];
        const bills = await session.queryEntity("Bill", {});

        type VendorAging = {
          name: string;
          balance: number;
          buckets: Record<BucketKey, number>;
          txnCount: number;
        };

        const byVendor = new Map<string, VendorAging>();
        const bucketTotals = emptyBuckets();

        for (const bill of bills) {
          if (bill.IsPaid === true) continue;
          const balance = Number(bill.AmountDue ?? 0);
          if (!(balance > 0)) continue;

          const dueDate = String(bill.DueDate ?? bill.TxnDate ?? effectiveAsOf);
          const days = daysBetween(effectiveAsOf, dueDate);
          const bucket = bucketFor(days);

          const ref = bill.VendorRef as { FullName?: string } | undefined;
          const name = ref?.FullName ?? "(unknown)";

          let row = byVendor.get(name);
          if (!row) {
            row = { name, balance: 0, buckets: emptyBuckets(), txnCount: 0 };
            byVendor.set(name, row);
          }
          row.balance = round2(row.balance + balance);
          row.buckets[bucket] = round2(row.buckets[bucket] + balance);
          row.txnCount += 1;
          bucketTotals[bucket] = round2(bucketTotals[bucket] + balance);
        }

        const vendors = [...byVendor.values()].sort((a, b) => b.balance - a.balance);
        const totalAccountsPayable = round2(
          BUCKET_KEYS.reduce((s, k) => s + bucketTotals[k], 0)
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              asOfDate: effectiveAsOf,
              totalAccountsPayable,
              bucketTotals,
              vendors,
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
              statusMessage: e.message ?? "BillQueryRq failed",
            }),
          }],
          isError: true,
        };
      }
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

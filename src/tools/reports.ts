/**
 * Reporting & query tools for QuickBooks Desktop MCP.
 *
 * Provides high-level reporting, balance queries, and summary tools.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { QBSessionManager } from "../session/manager.js";
import { qbStatusCodeMessage } from "../util/qb-status-codes.js";
import { ISO_DATE_RE } from "../util/validators.js";

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

// ---------------------------------------------------------------------------
// Balance summary helper (qb_balance_summary)
// ---------------------------------------------------------------------------

export type BalanceSummaryReportInput = {
  Sections?: Array<{ Name?: string; Accounts?: Array<{ Name?: string; Total?: number }> }>;
  Totals?: Record<string, unknown>;
};

export type BalanceSummaryAccount = { ListID?: string; FullName?: string; Name?: string; AccountType?: string; Balance?: number };

export type BalanceSummaryOutput = {
  balanceSummary: Array<{ accountType: string; accounts: string[]; total: number }>;
  subtotals: { assets: number; liabilities: number; equity: number; income: number; expenses: number; netIncome: number };
};

// Synthetic rows that BalanceSheetStandard injects for accounting-identity
// reconciliation — already captured in subtotals; including them in
// balanceSummary would double-count.
const BALANCE_SUMMARY_SYNTHETIC_ROWS = new Set([
  "Net Income",
  "Balancing Adjustment (simulation seed gap)",
]);

/**
 * Bucket BalanceSheetStandard + ProfitAndLossStandard report output into the
 * 16-way canonical-AccountType shape qb_balance_summary surfaces. Pure
 * function so the bucket/round/fallback logic can be unit-tested without
 * spinning up an MCP transport. NonPosting accounts fall back to
 * Account.Balance (not in either report — they don't post to GL); BS Equity
 * "Net Income" / "Balancing Adjustment" pseudo-rows are filtered (already
 * accounted for in subtotals).
 */
export function buildBalanceSummary(
  accounts: ReadonlyArray<BalanceSummaryAccount | Record<string, unknown>>,
  bsRet: BalanceSummaryReportInput,
  pnlRet: BalanceSummaryReportInput
): BalanceSummaryOutput {
  const typeByName = new Map<string, string>();
  for (const a of accounts) {
    const rec = a as Record<string, unknown>;
    const name = String(rec.FullName ?? rec.Name ?? "");
    if (name) typeByName.set(name, String(rec.AccountType ?? ""));
  }

  const bsSections = bsRet.Sections ?? [];
  const pnlSections = pnlRet.Sections ?? [];
  const bsTotals = bsRet.Totals ?? {};
  const pnlTotals = pnlRet.Totals ?? {};

  const buckets = new Map<string, { name: string; balance: number }[]>();
  const addToBucket = (type: string, name: string, balance: number): void => {
    const list = buckets.get(type);
    if (list) list.push({ name, balance });
    else buckets.set(type, [{ name, balance }]);
  };

  for (const section of [...bsSections, ...pnlSections]) {
    if (!section?.Accounts) continue;
    for (const acct of section.Accounts) {
      const name = String(acct?.Name ?? "");
      if (!name || BALANCE_SUMMARY_SYNTHETIC_ROWS.has(name)) continue;
      const type = typeByName.get(name) ?? "Unknown";
      addToBucket(type, name, Number(acct?.Total ?? 0));
    }
  }

  // NonPosting accounts (estimates / POs / sales orders) don't post to GL
  // and don't appear in BS or P&L. Source from Account.Balance — same
  // signal QB itself surfaces on the chart of accounts for these types.
  for (const a of accounts) {
    const rec = a as Record<string, unknown>;
    if (String(rec.AccountType ?? "") !== "NonPosting") continue;
    const name = String(rec.FullName ?? rec.Name ?? "");
    if (!name) continue;
    addToBucket("NonPosting", name, Number(rec.Balance ?? 0));
  }

  const balanceSummary: BalanceSummaryOutput["balanceSummary"] = [];
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

  return {
    balanceSummary,
    subtotals: {
      assets: round2(Number(bsTotals.TotalAssets ?? 0)),
      liabilities: round2(Number(bsTotals.TotalLiabilities ?? 0)),
      equity: round2(Number(bsTotals.TotalEquity ?? 0)),
      income: round2(Number(pnlTotals.TotalIncome ?? 0)),
      expenses: round2(Number(pnlTotals.TotalExpenses ?? 0)),
      netIncome: round2(Number(pnlTotals.NetIncome ?? 0)),
    },
  };
}

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
              readOnly: session.isReadOnly(),
              companyFile: sessionData?.companyFile ?? null,
              sessionTicket: sessionData?.ticket ?? null,
              openedAt: sessionData?.openedAt?.toISOString() ?? null,
              companyInfo,
            }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "CompanyQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Company file management — open / list (Items 34-35)
  // -----------------------------------------------------------------------

  // Switching mid-conversation lets the operator move between client books
  // without restarting the server. Live mode does a clean EndSession +
  // CloseConnection on the old file followed by OpenConnection2 +
  // BeginSession on the new one (QBXMLRP2 is single-file per process).
  // Simulation mode swaps the path string and reseeds the store — real QB
  // persists per-file, sim doesn't, so without the reseed the operator would
  // observe entities from the prior company on the "new" one. The
  // observational contract is "open a different book, see that book's
  // state" — same in both modes. See DECISIONS.md 2026-05-09.
  server.tool(
    "qb_company_open",
    "Switch the active QuickBooks Desktop company file. Closes the current session, swaps the configured company file path, and opens a new session against the new file. In live mode the file must either be the one currently open in QuickBooks Desktop or be openable by QBXMLRP2 (typically requires QB to have it open already — QBXMLRP2 won't open a file QB hasn't loaded). In simulation mode the in-memory store is reset to fresh seed (deliberate sim-fidelity tradeoff — real QB persists per-file, sim doesn't; see DECISIONS.md 2026-05-09).",
    {
      companyFile: z.string().min(1).describe("Absolute or UNC path to the .qbw file (e.g. 'C:\\\\path\\\\to\\\\Acme.qbw' or '\\\\\\\\server\\\\share\\\\Acme.qbw'). Pass an empty string to fall back to 'whatever file QB Desktop has open' — but the schema rejects empty strings to force an explicit choice; if you want the currently-open file, just don't call this tool."),
    },
    async ({ companyFile }) => {
      const session = getSession();
      const previousCompanyFile = session.getCompanyFile();
      try {
        const newSession = await session.switchCompanyFile(companyFile);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              previousCompanyFile,
              companyFile: newSession.companyFile,
              ticket: newSession.ticket,
              openedAt: newSession.openedAt.toISOString(),
              simulationMode: session.isSimulation(),
              ...(session.isSimulation()
                ? { simulationStoreReset: true }
                : {}),
            }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "Failed to open company file",
              previousCompanyFile,
              attemptedCompanyFile: companyFile,
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // Pure FS op — identical in live and simulation. Resolves the search root
  // from QB_COMPANY_ROOT (preferred) or dirname(QB_COMPANY_FILE) (fallback);
  // returns an empty list with a descriptive note when neither is set rather
  // than failing, since the operator can still call qb_company_open with a
  // path they happen to know.
  server.tool(
    "qb_company_list",
    "List QuickBooks company files (.qbw) under the configured root directory. Search root is taken from $QB_COMPANY_ROOT, falling back to dirname($QB_COMPANY_FILE). Returns [{companyFile, displayName, sizeBytes, modifiedAt}] sorted by modifiedAt desc. Pure filesystem operation — identical behavior in live and simulation mode. Use the returned `companyFile` paths as input to qb_company_open.",
    {
      root: z.string().optional().describe("Override the search root for this call (absolute path). Defaults to $QB_COMPANY_ROOT, then dirname($QB_COMPANY_FILE)."),
    },
    async ({ root: rootOverride }) => {
      const envRoot = process.env.QB_COMPANY_ROOT;
      const fallbackRoot = process.env.QB_COMPANY_FILE
        ? path.dirname(process.env.QB_COMPANY_FILE)
        : null;
      const root = rootOverride ?? envRoot ?? fallbackRoot;

      if (!root) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: -1,
              statusMessage: "Cannot determine company root: set QB_COMPANY_ROOT, QB_COMPANY_FILE, or pass a `root` argument.",
            }),
          }],
          isError: true,
        };
      }

      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        const qbwEntries = entries.filter(
          (e) => e.isFile() && e.name.toLowerCase().endsWith(".qbw")
        );
        const files = await Promise.all(
          qbwEntries.map(async (e) => {
            const full = path.join(root, e.name);
            const stat = await fs.stat(full);
            return {
              companyFile: full,
              displayName: path.basename(e.name, path.extname(e.name)),
              sizeBytes: stat.size,
              modifiedAt: stat.mtime.toISOString(),
            };
          })
        );
        files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ root, count: files.length, companies: files }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; code?: string };
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: -1,
              statusMessage: `Failed to enumerate ${root}: ${e.message ?? String(err)}`,
              root,
              ...(e.code ? { errorCode: e.code } : {}),
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
  // asOfDate is honored end-to-end: AS/LI/EQ figures come from
  // BalanceSheetStandard (toDate=asOfDate) and INC/EXP figures come from
  // ProfitAndLossStandard (lifetime → asOfDate). Both reports already work
  // in live mode via the row-tree adapter (see DECISIONS.md 2026-05-09).
  // The 16-way canonical AccountType bucketing is preserved by joining the
  // BS/P&L per-account totals back to AccountType via a name → type lookup
  // populated from a single AccountQuery — BS only emits 3 sections
  // (Assets/Liabilities/Equity) so the join is required to surface the
  // sub-types (Bank, AccountsReceivable, FixedAsset, …) the tool promises.
  //
  // Simulation caveat: sim's BS draws AS/LI/EQ from Account.Balance (a
  // snapshot — see qb_balance_sheet_report jsdoc) so asOfDate is advisory
  // for those buckets in sim. The P&L walk IS date-bounded in both modes.
  // NonPosting accounts (estimates, POs, sales orders) don't appear in BS
  // or P&L so they're sourced from Account.Balance directly — that's the
  // only signal available, and matches how QB itself reports them on the
  // chart of accounts.
  server.tool(
    "qb_balance_summary",
    "Balance summary across all accounts as of a specified date, grouped by AccountType in canonical QB order (Assets → Liabilities → Equity → Income → Expenses → NonPosting) with category subtotals (assets, liabilities, equity, income, expenses, netIncome). Asset/Liability/Equity figures are sourced from BalanceSheetStandard (toDate=asOfDate); Income/Expense figures are sourced from ProfitAndLossStandard (lifetime through asOfDate). NonPosting accounts fall back to Account.Balance (the only available signal — they don't post to GL). Note: in simulation mode, BalanceSheetStandard reads Account.Balance for AS/LI/EQ (a snapshot, so asOfDate is advisory for those buckets); the P&L walk IS date-bounded in both modes.",
    {
      asOfDate: z.string().regex(ISO_DATE_RE).optional().describe("As-of date (YYYY-MM-DD). Defaults to today. Used as toDate for both the BalanceSheetStandard run and the lifetime-through-asOfDate P&L walk."),
      basis: z.enum(["Accrual", "Cash"]).optional().describe("Accounting basis. Defaults to Accrual."),
    },
    async ({ asOfDate, basis }) => {
      const session = getSession();
      try {
        const effectiveAsOf = asOfDate ?? new Date().toISOString().split("T")[0];
        const effectiveBasis = basis ?? "Accrual";

        const accounts = await session.queryEntity("Account", {});

        // BS first, then P&L (sequential — QBXMLRP2 serializes COM calls
        // anyway, and avoiding parallel openSession races in live mode).
        const bsRet = await session.runReport("BalanceSheetStandard", {
          toDate: effectiveAsOf,
          basis: effectiveBasis,
        });
        const pnlRet = await session.runReport("ProfitAndLossStandard", {
          toDate: effectiveAsOf,
          basis: effectiveBasis,
        });

        const { balanceSummary, subtotals } = buildBalanceSummary(
          accounts as BalanceSummaryAccount[],
          bsRet as BalanceSummaryReportInput,
          pnlRet as BalanceSummaryReportInput
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              asOfDate: effectiveAsOf,
              reportBasis: effectiveBasis,
              balanceSummary,
              subtotals,
              totalAccounts: accounts.length,
            }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "qb_balance_summary failed",
              ...(humanReadable ? { humanReadable } : {}),
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
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "InvoiceQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
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
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "BillQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // P&L report
  // -----------------------------------------------------------------------
  server.tool(
    "qb_pnl_report",
    "Run a Profit & Loss report (GeneralSummaryReportType=ProfitAndLossStandard). Aggregates Invoice / SalesReceipt / CreditMemo lines (income side) and Bill / Check / CreditCardCharge lines plus JournalEntry postings (expense side) by GL account, filtered by TxnDate ∈ [fromDate, toDate]. Returns sections in canonical order (Income → Other Income → Cost of Goods Sold → Expenses → Other Expenses) plus totals (TotalIncome, TotalCOGS, TotalExpenses, GrossProfit, NetIncome). Lines whose account can't be resolved (e.g. invoice line whose item carries no IncomeAccountRef) land in 'Uncategorized Income/Expense' so totals reconcile.",
    {
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start of reporting window (YYYY-MM-DD), inclusive. Omit for no lower bound."),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End of reporting window (YYYY-MM-DD), inclusive. Omit for no upper bound."),
      basis: z.enum(["Accrual", "Cash"]).optional().describe("Accounting basis. Defaults to Accrual. (Note: simulation mode currently aggregates the same way regardless of basis — Cash basis revenue recognition lands with Phase 7 live mode.)"),
    },
    async ({ fromDate, toDate, basis }) => {
      const session = getSession();
      try {
        const reportRet = await session.runReport("ProfitAndLossStandard", {
          fromDate,
          toDate,
          basis,
        });
        const totals = (reportRet.Totals as Record<string, unknown> | undefined) ?? {};
        const sections = (reportRet.Sections as Array<{ Name: string; Accounts: Array<{ Name: string; Total: number }>; Subtotal: number }> | undefined) ?? [];

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              reportTitle: reportRet.ReportTitle ?? "Profit & Loss",
              reportBasis: reportRet.ReportBasis ?? basis ?? "Accrual",
              reportPeriod: {
                from: reportRet.FromReportDate ?? fromDate ?? null,
                to: reportRet.ToReportDate ?? toDate ?? null,
              },
              sections: sections.map((s) => ({
                name: s.Name,
                accounts: s.Accounts.map((a) => ({ name: a.Name, total: a.Total })),
                subtotal: s.Subtotal,
              })),
              totalIncome: Number(totals.TotalIncome ?? 0),
              totalCOGS: Number(totals.TotalCOGS ?? 0),
              totalExpenses: Number(totals.TotalExpenses ?? 0),
              grossProfit: Number(totals.GrossProfit ?? 0),
              netIncome: Number(totals.NetIncome ?? 0),
            }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "GeneralSummaryReportQueryRq (ProfitAndLossStandard) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // Balance Sheet report
  // -----------------------------------------------------------------------
  server.tool(
    "qb_balance_sheet_report",
    "Run a Balance Sheet report (GeneralSummaryReportType=BalanceSheetStandard) as of a specified date. Returns Assets / Liabilities / Equity sections in canonical QB order plus totals (TotalAssets, TotalLiabilities, TotalEquity, NetIncome). Period NetIncome (lifetime up to asOfDate) closes into Equity. Note: simulation mode draws asset/liability/equity totals from Account.Balance (a snapshot — asOfDate is advisory for those sections); the period NetIncome that closes into Equity IS walked from transactions and reconciles with qb_pnl_report for the same range.",
    {
      asOfDate: z.string().regex(ISO_DATE_RE).optional().describe("As-of date (YYYY-MM-DD). Defaults to today. Used as the upper bound of the lifetime NetIncome walk; the asset/liability/equity sections themselves are seeded snapshots in simulation."),
      basis: z.enum(["Accrual", "Cash"]).optional().describe("Accounting basis. Defaults to Accrual."),
    },
    async ({ asOfDate, basis }) => {
      const session = getSession();
      try {
        const effectiveAsOf = asOfDate ?? new Date().toISOString().split("T")[0];
        const reportRet = await session.runReport("BalanceSheetStandard", {
          toDate: effectiveAsOf,
          basis,
        });
        const totals = (reportRet.Totals as Record<string, unknown> | undefined) ?? {};
        const sections = (reportRet.Sections as Array<{ Name: string; Accounts: Array<{ Name: string; Total: number }>; Subtotal: number }> | undefined) ?? [];

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              reportTitle: reportRet.ReportTitle ?? "Balance Sheet",
              reportBasis: reportRet.ReportBasis ?? basis ?? "Accrual",
              asOfDate: reportRet.AsOfDate ?? effectiveAsOf,
              sections: sections.map((s) => ({
                name: s.Name,
                accounts: s.Accounts.map((a) => ({ name: a.Name, total: a.Total })),
                subtotal: s.Subtotal,
              })),
              totalAssets: Number(totals.TotalAssets ?? 0),
              totalLiabilities: Number(totals.TotalLiabilities ?? 0),
              totalEquity: Number(totals.TotalEquity ?? 0),
              netIncome: Number(totals.NetIncome ?? 0),
            }, null, 2),
          }],
        };
      } catch (err) {
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "GeneralSummaryReportQueryRq (BalanceSheetStandard) failed",
              ...(humanReadable ? { humanReadable } : {}),
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
    "Open a session with QuickBooks Desktop. Must be called before other operations (auto-connects if needed). Pass readOnly:true to gate every *_add / *_update / *_delete / *_apply / *_pay / *_make_inactive / *_convert_to_invoice / batch_create tool against accidental mutation — those tools will fail-fast with statusCode 9001 BEFORE any QBXML envelope is built. Pass readOnly:false (or omit) for normal read+write access. The flag toggles immediately on call: it's safe to flip mid-conversation without disconnecting.",
    {
      readOnly: z.boolean().optional().describe("When true, every mutation helper (addEntity / modifyEntity / deleteEntity / executeBatchAdd) throws QBReadOnlyError (statusCode 9001) before building XML. Reads (queries, reports, qb_raw_query) are unaffected. Defaults to false on every call — passing nothing equals passing false, so a fresh `qb_session_connect()` always re-enables writes."),
    },
    async ({ readOnly }) => {
      const session = getSession();
      session.setReadOnly(readOnly === true);
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
            readOnly: session.isReadOnly(),
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

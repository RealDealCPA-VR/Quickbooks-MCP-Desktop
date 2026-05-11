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

const GL_ELIGIBLE_ACCOUNT_TYPES = new Set<string>([
  ...ASSET_TYPES,
  ...LIABILITY_TYPES,
  ...EQUITY_TYPES,
  ...INCOME_TYPES,
  ...EXPENSE_TYPES,
]);

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

// ---------------------------------------------------------------------------
// General Ledger helper (qb_general_ledger) — Phase 11 #53
// ---------------------------------------------------------------------------

export type GeneralLedgerAccountInput = {
  ListID?: string;
  FullName?: string;
  Name?: string;
  AccountType?: string;
  Balance?: number;
};

export type GeneralLedgerTransactionInput = Record<string, unknown>;

export type GeneralLedgerSection = {
  accountName: string;
  accountListId?: string;
  accountType: string;
  openingBalance: number;
  closingBalance: number;
  periodChange: number;
  count: number;
  transactions: Record<string, unknown>[];
};

/**
 * Build one GL section: opening balance → period rows (each annotated with
 * RunningBalance) → closing balance. Pure function so the math can be unit-
 * tested without spinning up an MCP transport.
 *
 * Algorithm (same shape as qb_transaction_list_by_account's running-balance
 * walk in src/tools/transactions.ts:106-140):
 *   1. currentBalance = Account.Balance (snapshot through "now").
 *   2. periodSum     = Σ row.Amount over the queried window.
 *   3. openingBalance = currentBalance − periodSum.
 *   4. Walk rows forward; RunningBalance += row.Amount per row.
 *
 * This is exact when toDate ≥ now (the typical case). For historical windows
 * (toDate < now AND postings exist after toDate) openingBalance is overstated
 * by those after-period postings — same documented limitation. Closing balance
 * is the running balance after the last row in the window (= currentBalance
 * when toDate ≥ now and no rows are dropped by maxRowsPerAccount).
 *
 * Rows are NOT re-sorted here — the caller guarantees chronological order via
 * the underlying TransactionQueryRq (sim sorts in handleTransactionQuery,
 * live's order is QB-driven; the wrapping tool re-sorts defensively before
 * passing rows in).
 */
export function buildGeneralLedgerSection(
  account: GeneralLedgerAccountInput,
  rows: GeneralLedgerTransactionInput[],
): GeneralLedgerSection {
  const accountName = String(account.FullName ?? account.Name ?? "");
  const accountType = String(account.AccountType ?? "");
  const currentBalance = Number(account.Balance ?? 0);
  const periodSum = rows.reduce((s, r) => s + Number(r.Amount ?? 0), 0);
  const openingBalance = round2((Number.isFinite(currentBalance) ? currentBalance : 0) - periodSum);

  let running = openingBalance;
  const transactions: Record<string, unknown>[] = rows.map((r) => {
    running += Number(r.Amount ?? 0);
    return { ...r, RunningBalance: round2(running) };
  });
  const closingBalance = round2(running);

  return {
    accountName,
    ...(account.ListID ? { accountListId: String(account.ListID) } : {}),
    accountType,
    openingBalance,
    closingBalance,
    periodChange: round2(periodSum),
    count: transactions.length,
    transactions,
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
  // qb_general_ledger (Phase 11 #53)
  //
  // Composite tool — multi-account version of qb_transaction_list_by_account.
  // Fetches the chart of accounts, filters by accountName / accountListId /
  // accountType, then fans out one TransactionQueryRq per matching account
  // and aggregates into sectioned per-account ledger output with running
  // balance.
  //
  // Why composite (vs. a single GeneralDetailReportQueryRq wire request):
  //   - Reuses verified primitives (TransactionQueryRq + AccountQueryRq) that
  //     already run cleanly in live mode — zero schema-order risk.
  //   - No new builder / parser-adapter / sim-handler surface area, no new
  //     pin in tests/builder-emit-order.test.ts.
  //   - Tradeoff: N round trips for N accounts in live mode. For a 200-account
  //     chart that's ~100 s at typical QBXMLRP2 latency. Acceptable for
  //     month-end use; mitigated by accountType / accountName filtering.
  // -----------------------------------------------------------------------
  server.tool(
    "qb_general_ledger",
    "General Ledger — for every GL-affecting account (or the subset selected by accountName / accountListId / accountType), list every line-level posting that hit it in the date window, sorted by TxnDate ascending, with per-row RunningBalance and per-account OpeningBalance / ClosingBalance / periodChange. Composite of qb_transaction_list_by_account: this is N round trips (one per matching account) — pass accountType ('Expense', 'Income', 'Bank', etc.) or accountName to scope. NonPosting accounts (Estimate / PurchaseOrder / SalesOrder sinks) are always excluded — they don't post to GL. Sign convention: positive Amount = increases the account's natural balance. Sim emits LINE-LEVEL postings only — implicit AR/AP/Bank counter-postings are NOT surfaced (same limitation as qb_transaction_list_by_account); live QB returns the full posting tree. RunningBalance math: openingBalance = currentBalance − periodSum, then walks forward; exact when toDate ≥ now, approximate (overstated by post-period postings) for historical windows.",
    {
      fromDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Start of the GL window (YYYY-MM-DD, inclusive). Omit for all-time (each account section walks every posting that hit it ever)."),
      toDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("End of the GL window (YYYY-MM-DD, inclusive). Omit for through-current. RunningBalance math is exact only when toDate ≥ now."),
      accountName: z.string().optional()
        .describe("Single-account scope by FullName (e.g. 'Rent Expense'). Equivalent to calling qb_transaction_list_by_account directly. Takes precedence over accountType."),
      accountListId: z.string().optional()
        .describe("Single-account scope by ListID. Alternative to accountName."),
      accountType: z.enum([...CANONICAL_ACCOUNT_TYPES] as [string, ...string[]]).optional()
        .describe("Scope to accounts of one AccountType (Bank / AccountsReceivable / Income / Expense / etc.). Useful for 'GL for all expenses' — typical month-end ask. Ignored when accountName or accountListId is supplied."),
      basis: z.enum(["Accrual", "Cash"]).optional()
        .describe("Accounting basis. Defaults to Accrual. Currently advisory in simulation (queryTransactions does not branch on basis); threaded through for parity with other report tools."),
      maxAccounts: z.number().int().positive().optional()
        .describe("Cap on the number of accounts to fan out across (safety brake against accidental runaway in live mode). Default 200, max effectively bounded by the chart of accounts size."),
      maxRowsPerAccount: z.number().int().positive().optional()
        .describe("Per-account row cap, passed through to TransactionQueryRq as MaxReturned. Default 500 (matches QB's per-batch cap). Hitting this cap on any account triggers a `truncated` flag on that section."),
      includeEmpty: z.boolean().optional()
        .describe("When true, include accounts with zero postings in the window (each with empty transactions array, openingBalance = closingBalance = currentBalance, periodChange = 0). Default false — empty sections are pruned so the response stays focused on accounts with activity."),
    },
    async (args) => {
      const session = getSession();
      const effectiveMaxAccounts = args.maxAccounts ?? 200;
      const effectiveMaxRows = args.maxRowsPerAccount ?? 500;
      const includeEmpty = args.includeEmpty === true;
      const warnings: string[] = [];

      try {
        // 1) Fetch the chart of accounts. AccountQueryRq has no AccountType
        //    filter in the sim's handleQuery (and live's surface is also
        //    limited) — pull all and filter in-process. Cheap: typically 50-300
        //    rows.
        const allAccounts = await session.queryEntity("Account", {});

        // 2) Resolve targets — single-account scope (name or ListID) wins over
        //    accountType; if neither is set, fan out across every GL-eligible
        //    account.
        let targets: GeneralLedgerAccountInput[] = allAccounts as GeneralLedgerAccountInput[];

        if (args.accountListId) {
          targets = targets.filter((a) => String(a.ListID ?? "") === args.accountListId);
          if (targets.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  statusCode: 500,
                  statusMessage: `Account with ListID '${args.accountListId}' not found`,
                  humanReadable: qbStatusCodeMessage(500),
                }),
              }],
              isError: true,
            };
          }
        } else if (args.accountName) {
          targets = targets.filter((a) => String(a.FullName ?? a.Name ?? "") === args.accountName);
          if (targets.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  statusCode: 500,
                  statusMessage: `Account with FullName '${args.accountName}' not found`,
                  humanReadable: qbStatusCodeMessage(500),
                }),
              }],
              isError: true,
            };
          }
        } else if (args.accountType) {
          targets = targets.filter((a) => String(a.AccountType ?? "") === args.accountType);
        }

        // 3) Drop NonPosting accounts — they don't post to GL (Estimate, PO,
        //    SalesOrder sinks). When the operator explicitly scoped to a
        //    NonPosting account by name/ListID we keep them and let the
        //    underlying TransactionQueryRq return empty; surface a warning.
        const droppedNonPosting: string[] = [];
        targets = targets.filter((a) => {
          const type = String(a.AccountType ?? "");
          if (type === "NonPosting" && !args.accountName && !args.accountListId) {
            droppedNonPosting.push(String(a.FullName ?? a.Name ?? ""));
            return false;
          }
          return true;
        });
        if (droppedNonPosting.length > 0) {
          warnings.push(
            `Excluded ${droppedNonPosting.length} NonPosting account(s) (they don't post to GL): ${droppedNonPosting.slice(0, 5).join(", ")}${droppedNonPosting.length > 5 ? "…" : ""}`,
          );
        }

        if (targets.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                fromDate: args.fromDate ?? null,
                toDate: args.toDate ?? null,
                basis: args.basis ?? "Accrual",
                accountCount: 0,
                totalRowCount: 0,
                sections: [],
                ...(warnings.length > 0 ? { warnings } : {}),
                note: "No matching GL-affecting accounts. Check accountName / accountListId / accountType filter — or qb_account_list to discover available accounts.",
              }, null, 2),
            }],
          };
        }

        if (targets.length > effectiveMaxAccounts) {
          warnings.push(
            `Account fanout (${targets.length}) exceeds maxAccounts (${effectiveMaxAccounts}). Truncating — re-run with maxAccounts: ${targets.length} to see all, or scope by accountType.`,
          );
          targets = targets.slice(0, effectiveMaxAccounts);
        }

        // 4) Fan out — one TransactionQueryRq per account. Each section is
        //    independent so a failure on one account doesn't poison the
        //    others (surfaced as a section-level error instead).
        const sections: (GeneralLedgerSection & { truncated?: boolean; error?: string })[] = [];
        let totalRowCount = 0;

        for (const acct of targets) {
          const fullName = String(acct.FullName ?? acct.Name ?? "");
          const listId = acct.ListID ? String(acct.ListID) : undefined;

          // Match the queryTransactions schema-required filter order (per
          // src/session/manager.ts:584-591): MaxReturned →
          // TxnDateRangeFilter → AccountFilter.
          const filters: Record<string, unknown> = {
            MaxReturned: effectiveMaxRows,
          };
          if (args.fromDate || args.toDate) {
            filters.TxnDateRangeFilter = {
              FromTxnDate: args.fromDate,
              ToTxnDate: args.toDate,
            };
          }
          filters.AccountFilter = listId ? { ListID: listId } : { FullName: fullName };

          let rows: Record<string, unknown>[] = [];
          let sectionError: string | undefined;
          try {
            rows = await session.queryTransactions(filters);
          } catch (err) {
            sectionError = (err as Error).message;
          }

          if (sectionError) {
            sections.push({
              accountName: fullName,
              ...(listId ? { accountListId: listId } : {}),
              accountType: String(acct.AccountType ?? ""),
              openingBalance: 0,
              closingBalance: 0,
              periodChange: 0,
              count: 0,
              transactions: [],
              error: sectionError,
            });
            continue;
          }

          // Defensive re-sort — sim already sorts chronologically in
          // handleTransactionQuery, but live's response order is QB-driven and
          // not guaranteed. Same comparator as qb_transaction_list_by_account.
          const sorted = [...rows].sort((a, b) => {
            const ad = String(a.TxnDate ?? "");
            const bd = String(b.TxnDate ?? "");
            if (ad !== bd) return ad < bd ? -1 : 1;
            const at = String(a.TimeCreated ?? "");
            const bt = String(b.TimeCreated ?? "");
            return at < bt ? -1 : at > bt ? 1 : 0;
          });

          const section = buildGeneralLedgerSection(acct, sorted);
          totalRowCount += section.count;

          if (!includeEmpty && section.count === 0) continue;

          const truncated = sorted.length >= effectiveMaxRows;
          sections.push({ ...section, ...(truncated ? { truncated: true } : {}) });
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              fromDate: args.fromDate ?? null,
              toDate: args.toDate ?? null,
              basis: args.basis ?? "Accrual",
              accountCount: sections.length,
              totalRowCount,
              sections,
              ...(warnings.length > 0 ? { warnings } : {}),
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
              statusMessage: e.message ?? "qb_general_ledger failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // qb_sales_by_customer_summary (Phase 11 #49)
  //
  // Wraps GeneralSummaryReportQueryRq with ReportType=SalesByCustomerSummary.
  // Per-customer revenue rollup over the date window: walks Invoice +
  // SalesReceipt lines (positive) and CreditMemo lines (negative), groups by
  // CustomerRef.FullName on the parent txn, returns sorted-desc by total.
  // Real QB's SalesByCustomerSummary uses the same income-side aggregation.
  // -----------------------------------------------------------------------
  server.tool(
    "qb_sales_by_customer_summary",
    "Sales by Customer Summary — per-customer revenue rollup (Invoice + SalesReceipt − CreditMemo line totals, grouped by CustomerRef.FullName) over a date window. Returns customers sorted by total descending plus the grand TotalSales. Scope to a single customer with customerName / customerListId (server-side ReportEntityFilter). Sums are line.Amount sums — sales-tax lines and zero-amount lines drop naturally without inflating the customer's total (matches QB's actual SalesByCustomerSummary report). CreditMemo lines reduce sales — a negative customer total in the response means the customer has more credits than billing in the window. Basis defaults to Accrual.",
    {
      fromDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Start of the reporting window (YYYY-MM-DD, inclusive). Omit for no lower bound (all-time)."),
      toDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("End of the reporting window (YYYY-MM-DD, inclusive). Omit for through-current (no upper bound)."),
      customerName: z.string().optional()
        .describe("Single-customer scope by FullName (e.g. 'Acme Corp'). Passes through as ReportEntityFilter.FullName. Takes precedence over customerListId."),
      customerListId: z.string().optional()
        .describe("Single-customer scope by ListID. Alternative to customerName."),
      basis: z.enum(["Accrual", "Cash"]).optional()
        .describe("Accounting basis. Defaults to Accrual. (Note: in simulation mode the income walk is identical regardless of basis — Cash-basis revenue recognition will land with the live-mode adapter validation.)"),
    },
    async ({ fromDate, toDate, customerName, customerListId, basis }) => {
      const session = getSession();
      try {
        const entityFilter = customerListId
          ? { ListID: customerListId }
          : customerName
            ? { FullName: customerName }
            : undefined;

        const reportRet = await session.runReport("SalesByCustomerSummary", {
          fromDate,
          toDate,
          basis,
          ...(entityFilter ? { entityFilter } : {}),
        });

        const totals = (reportRet.Totals as Record<string, unknown> | undefined) ?? {};
        const sections = (reportRet.Sections as Array<{
          Name: string;
          Accounts: Array<{ Name: string; Total: number }>;
          Subtotal: number;
        }> | undefined) ?? [];
        // One synthesized section "Sales" in both sim and live (live's flat-
        // summary adapter emits the same single section). Flatten to a plain
        // customers list for the tool surface — callers don't need the
        // section wrapper that P&L / BS rely on for canonical-type grouping.
        const customers = sections[0]?.Accounts?.map((a) => ({
          customerName: a.Name,
          total: a.Total,
        })) ?? [];

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              reportTitle: reportRet.ReportTitle ?? "Sales by Customer Summary",
              reportBasis: reportRet.ReportBasis ?? basis ?? "Accrual",
              reportPeriod: {
                from: reportRet.FromReportDate ?? fromDate ?? null,
                to: reportRet.ToReportDate ?? toDate ?? null,
              },
              customerCount: customers.length,
              totalSales: Number(totals.TotalSales ?? 0),
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
              statusMessage: e.message ?? "GeneralSummaryReportQueryRq (SalesByCustomerSummary) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // qb_sales_by_customer_detail (Phase 11 #49)
  //
  // Wraps GeneralDetailReportQueryRq with ReportType=SalesByCustomerDetail.
  // Per-line transaction detail (one row per Invoice / SalesReceipt /
  // CreditMemo line that touches a customer), with TxnType / Date / Num /
  // Name / Memo / Item / Quantity / Rate / Account / Amount / TxnID columns.
  // Rows are sorted by Customer (alpha) → Date (asc) → TxnID (stable). Use
  // customerName / customerListId for single-customer drilldown.
  // -----------------------------------------------------------------------
  server.tool(
    "qb_sales_by_customer_detail",
    "Sales by Customer Detail — per-line sales detail (Invoice / SalesReceipt / CreditMemo line rows) for the date window, sorted by Customer → TxnDate → TxnID. Returns rows with TxnType / Date / Num (refNumber) / Name (customer) / Memo / Item / Quantity / Rate / Account (income account) / Amount / TxnID. CreditMemo rows emit with Amount sign-flipped (negative) so the running sum matches QB's actual SalesByCustomerDetail. Scope by customer (customerName | customerListId) for single-customer drilldown — without scope every customer-bearing sale line in the window is emitted. Composite of GeneralDetailReportQueryRq + per-line walking — this is the line-level companion to qb_sales_by_customer_summary. NOTE: live mode adapter for this report uses the same row-tree translator as CustomDetailReport — verified-by-construction structurally but live-validation against a real QB Desktop hasn't run yet; if QBXMLRP2 surfaces statusCode -1 the fix is a child-order tweak in buildGeneralDetailReportRequest.",
    {
      fromDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Start of the reporting window (YYYY-MM-DD, inclusive). Omit for no lower bound."),
      toDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("End of the reporting window (YYYY-MM-DD, inclusive). Omit for through-current."),
      customerName: z.string().optional()
        .describe("Single-customer scope by FullName. Passes through as ReportEntityFilter.FullName. Takes precedence over customerListId."),
      customerListId: z.string().optional()
        .describe("Single-customer scope by ListID. Alternative to customerName."),
      basis: z.enum(["Accrual", "Cash"]).optional()
        .describe("Accounting basis. Defaults to Accrual. (Note: in simulation mode the line walk is identical regardless of basis.)"),
    },
    async ({ fromDate, toDate, customerName, customerListId, basis }) => {
      const session = getSession();
      try {
        const entityFilter = customerListId
          ? { ListID: customerListId }
          : customerName
            ? { FullName: customerName }
            : undefined;

        const reportRet = await session.runGeneralDetailReport({
          reportType: "SalesByCustomerDetail",
          fromDate,
          toDate,
          basis,
          ...(entityFilter ? { entityFilter } : {}),
        });

        const rows = (reportRet.Rows as Record<string, unknown>[] | undefined) ?? [];
        const columns = (reportRet.Columns as Array<{ Title: string; Type: string }> | undefined) ?? [];

        // Aggregate totals client-side from rows — useful summary stat for
        // operators consuming the detail variant (matches what QB's GUI
        // surfaces as the report's TOTAL row).
        const totalAmount = round2(
          rows.reduce((s, r) => s + Number(r.Amount ?? 0), 0),
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              reportTitle: reportRet.ReportTitle ?? "Sales by Customer Detail",
              reportBasis: reportRet.ReportBasis ?? basis ?? "Accrual",
              reportPeriod: {
                from: reportRet.FromReportDate ?? fromDate ?? null,
                to: reportRet.ToReportDate ?? toDate ?? null,
              },
              rowCount: rows.length,
              totalAmount,
              columns,
              rows,
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
              statusMessage: e.message ?? "GeneralDetailReportQueryRq (SalesByCustomerDetail) failed",
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

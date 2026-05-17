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
import { formatToolError } from "../util/format-tool-error.js";
import { ISO_DATE_RE } from "../util/validators.js";
import { normalizeClosingDate } from "./preferences.js";

/**
 * MCP server semver. Surfaced by `qb_session_status` so orchestration callers
 * can pin against a known wire surface. Kept in lockstep with the
 * `McpServer({ version })` literal in src/index.ts — if either moves, both
 * must move. Centralizing as a const is a deliberate non-DRY: importing from
 * index.ts would create a cycle (index → reports → index), and a
 * package.json read at module load would add filesystem I/O at boot for one
 * string.
 */
const SERVER_VERSION = "1.0.0";

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
// Trial Balance helper (qb_trial_balance_export) — Phase 15 #68
//
// Composes the chart of accounts + BalanceSheetStandard + ProfitAndLossStandard
// + AR/AP aging totals into a single workpaper-shaped TB: one row per
// non-zero-balance posting account, debits and credits split by natural-balance
// side, sorted by canonical AccountType then AccountNumber. Plus a crossChecks
// block that pins the four reconciliations every TB reviewer runs:
//   - Assets ≡ Liabilities + Equity
//   - P&L NetIncome ≡ BS NetIncome
//   - AR account balance ≡ AR aging total
//   - AP account balance ≡ AP aging total
//
// All math is in one pure function (`buildTrialBalance`) so the natural-balance
// logic and the cross-check arithmetic can be unit-tested without an MCP
// transport. The tool wrapper handles I/O orchestration (5 wire calls — Account,
// BS, P&L, Invoice for AR aging, Bill for AP aging) and the optional opt-in
// LastActivityDate fanout (N+1 calls when enabled).
// ---------------------------------------------------------------------------

export type TrialBalanceAccount = {
  ListID?: string;
  FullName?: string;
  Name?: string;
  AccountNumber?: string;
  AccountType?: string;
  Balance?: number;
  IsActive?: boolean;
  TaxLineInfoRet?: { TaxLineName?: string; TaxLineID?: number | string };
};

export type TrialBalanceReportInput = BalanceSummaryReportInput;

export type TrialBalanceRow = {
  accountListId: string | null;
  accountName: string;
  accountNumber: string | null;
  accountType: string;
  taxLine: string | null;
  debitBalance: number;
  creditBalance: number;
  isActive: boolean;
  lastActivityDate: string | null;
};

export type TrialBalanceCrossChecks = {
  balanceSheet: {
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
    sumLiabilitiesAndEquity: number;
    reconciles: boolean;
    delta: number;
  };
  netIncome: {
    fromPnL: number;
    fromBalanceSheet: number;
    matches: boolean;
    delta: number;
  };
  arReconciliation: {
    fromTrialBalance: number;
    fromARAging: number;
    matches: boolean;
    delta: number;
  };
  apReconciliation: {
    fromTrialBalance: number;
    fromAPAging: number;
    matches: boolean;
    delta: number;
  };
};

export type TrialBalanceResult = {
  rows: TrialBalanceRow[];
  rowCount: number;
  totals: {
    totalDebits: number;
    totalCredits: number;
    isBalanced: boolean;
    delta: number;
  };
  crossChecks: TrialBalanceCrossChecks;
};

// Natural-balance side per AccountType. Determines which column a non-zero
// balance lands in: a positive Asset balance is a Debit; a positive Liability
// balance is a Credit. Contra-balance accounts (a negative Accounts Receivable
// = customer credit on file) flip to the OTHER column rather than appearing as
// a negative number — matches the workpaper convention bookkeepers expect.
const NATURAL_DEBIT_TYPES = new Set<string>([
  "Bank", "AccountsReceivable", "OtherCurrentAsset", "Inventory",
  "FixedAsset", "OtherAsset",
  "CostOfGoodsSold", "Expense", "OtherExpense",
]);
const NATURAL_CREDIT_TYPES = new Set<string>([
  "AccountsPayable", "CreditCard", "OtherCurrentLiability", "LongTermLiability",
  "Equity",
  "Income", "OtherIncome",
]);

// NonPosting is intentionally excluded from the TB — estimates, POs, sales
// orders don't post to GL and have no business on a trial balance. Operators
// who want NonPosting balances can use qb_balance_summary.
const TB_ACCOUNT_TYPES: readonly string[] = [
  ...ASSET_TYPES,
  ...LIABILITY_TYPES,
  ...EQUITY_TYPES,
  ...INCOME_TYPES,
  ...EXPENSE_TYPES,
];

// Cent-tolerance for cross-check matches. Reconciliations off by less than one
// cent (floating-point rounding across separate report walks) match; anything
// above is a real signal.
const RECON_TOLERANCE = 0.01;

/**
 * Bucket BalanceSheetStandard + ProfitAndLossStandard report output into a
 * workpaper-shaped TB plus four reconciliation cross-checks. Pure function so
 * the sign convention, sort, debit/credit split, and cross-check math can be
 * unit-tested without spinning up an MCP transport.
 *
 * Sources:
 *   AS/LI/EQ row balances ← bsRet.Sections[*].Accounts[*].Total (BalanceSheetStandard)
 *   INC/EXP row balances  ← pnlRet.Sections[*].Accounts[*].Total (ProfitAndLossStandard)
 *   AccountType / AccountNumber / TaxLine / IsActive ← chart of accounts
 *   AR cross-check ← caller passes arAgingTotal (Σ Invoice.BalanceRemaining where !IsPaid)
 *   AP cross-check ← caller passes apAgingTotal (Σ Bill.AmountDue where !IsPaid)
 *
 * Synthetic BS rows (`Net Income`, `Balancing Adjustment (simulation seed gap)`)
 * are filtered — they're already captured in bsRet.Totals.NetIncome and would
 * pollute the per-account rows otherwise.
 *
 * Sort: canonical TB_ACCOUNT_TYPES order, then AccountNumber asc (numbered
 * accounts first within type), then alphabetical by FullName. Matches the
 * standard workpaper ordering CPAs expect.
 */
export function buildTrialBalance(
  accounts: ReadonlyArray<TrialBalanceAccount | Record<string, unknown>>,
  bsRet: TrialBalanceReportInput,
  pnlRet: TrialBalanceReportInput,
  arAgingTotal: number,
  apAgingTotal: number,
  options: {
    includeInactive?: boolean;
    includeZeroBalances?: boolean;
    lastActivityByAccount?: Map<string, string>;
  } = {},
): TrialBalanceResult {
  const accountByName = new Map<string, TrialBalanceAccount>();
  for (const a of accounts) {
    const rec = a as TrialBalanceAccount;
    const name = String(rec.FullName ?? rec.Name ?? "");
    if (name) accountByName.set(name, rec);
  }

  // Per-account balances come from the BS sections (AS/LI/EQ) and P&L sections
  // (INC/EXP). The two reports cover disjoint AccountTypes so there's no
  // overlap; if a name shows up twice (shouldn't, but defensive) the later
  // entry wins — the P&L value would take precedence for INC/EXP accounts.
  const balanceByName = new Map<string, number>();
  for (const section of [...(bsRet.Sections ?? []), ...(pnlRet.Sections ?? [])]) {
    if (!section?.Accounts) continue;
    for (const acct of section.Accounts) {
      const name = String(acct?.Name ?? "");
      if (!name || BALANCE_SUMMARY_SYNTHETIC_ROWS.has(name)) continue;
      const total = Number(acct?.Total ?? 0);
      if (Number.isFinite(total)) balanceByName.set(name, total);
    }
  }

  const allowedTypes = new Set<string>(TB_ACCOUNT_TYPES);
  const rows: TrialBalanceRow[] = [];
  let arTbSum = 0;
  let apTbSum = 0;

  for (const [name, account] of accountByName) {
    const type = String(account.AccountType ?? "");
    if (!allowedTypes.has(type)) continue; // skip NonPosting / unknown
    if (options.includeInactive !== true && account.IsActive === false) continue;

    const rawBalance = balanceByName.get(name) ?? 0;
    if (options.includeZeroBalances !== true && Math.abs(rawBalance) < 0.005) continue;

    let debitBalance = 0;
    let creditBalance = 0;
    if (NATURAL_DEBIT_TYPES.has(type)) {
      if (rawBalance >= 0) debitBalance = round2(rawBalance);
      else creditBalance = round2(-rawBalance);
    } else if (NATURAL_CREDIT_TYPES.has(type)) {
      if (rawBalance >= 0) creditBalance = round2(rawBalance);
      else debitBalance = round2(-rawBalance);
    }

    if (type === "AccountsReceivable") arTbSum += rawBalance;
    if (type === "AccountsPayable") apTbSum += rawBalance;

    const taxLine = account.TaxLineInfoRet?.TaxLineName;
    rows.push({
      accountListId: account.ListID ? String(account.ListID) : null,
      accountName: name,
      accountNumber: account.AccountNumber ? String(account.AccountNumber) : null,
      accountType: type,
      taxLine: taxLine ? String(taxLine) : null,
      debitBalance,
      creditBalance,
      isActive: account.IsActive !== false,
      lastActivityDate: options.lastActivityByAccount?.get(name) ?? null,
    });
  }

  const typeOrder = new Map(TB_ACCOUNT_TYPES.map((t, i) => [t, i]));
  rows.sort((a, b) => {
    const oa = typeOrder.get(a.accountType) ?? 999;
    const ob = typeOrder.get(b.accountType) ?? 999;
    if (oa !== ob) return oa - ob;
    // Numbered accounts sort before unnumbered within type; numbers compared
    // lexicographically because AccountNumber is a string in QB (allows
    // 1000-1, 1000.A, etc. — strict numeric compare would mis-sort).
    if (a.accountNumber && b.accountNumber) {
      const cmp = a.accountNumber.localeCompare(b.accountNumber);
      if (cmp !== 0) return cmp;
    } else if (a.accountNumber) {
      return -1;
    } else if (b.accountNumber) {
      return 1;
    }
    return a.accountName.localeCompare(b.accountName);
  });

  const totalDebits = round2(rows.reduce((s, r) => s + r.debitBalance, 0));
  const totalCredits = round2(rows.reduce((s, r) => s + r.creditBalance, 0));
  const debitCreditDelta = round2(totalDebits - totalCredits);

  const bsTotals = bsRet.Totals ?? {};
  const pnlTotals = pnlRet.Totals ?? {};
  const totalAssets = round2(Number(bsTotals.TotalAssets ?? 0));
  const totalLiabilities = round2(Number(bsTotals.TotalLiabilities ?? 0));
  const totalEquity = round2(Number(bsTotals.TotalEquity ?? 0));
  const sumLiabAndEquity = round2(totalLiabilities + totalEquity);
  const bsDelta = round2(totalAssets - sumLiabAndEquity);

  const pnlNetIncome = round2(Number(pnlTotals.NetIncome ?? 0));
  const bsNetIncome = round2(Number(bsTotals.NetIncome ?? 0));
  const niDelta = round2(pnlNetIncome - bsNetIncome);

  const arTb = round2(arTbSum);
  const apTb = round2(apTbSum);
  const arAging = round2(arAgingTotal);
  const apAging = round2(apAgingTotal);
  const arDelta = round2(arTb - arAging);
  const apDelta = round2(apTb - apAging);

  return {
    rows,
    rowCount: rows.length,
    totals: {
      totalDebits,
      totalCredits,
      isBalanced: Math.abs(debitCreditDelta) <= RECON_TOLERANCE,
      delta: debitCreditDelta,
    },
    crossChecks: {
      balanceSheet: {
        totalAssets,
        totalLiabilities,
        totalEquity,
        sumLiabilitiesAndEquity: sumLiabAndEquity,
        reconciles: Math.abs(bsDelta) <= RECON_TOLERANCE,
        delta: bsDelta,
      },
      netIncome: {
        fromPnL: pnlNetIncome,
        fromBalanceSheet: bsNetIncome,
        matches: Math.abs(niDelta) <= RECON_TOLERANCE,
        delta: niDelta,
      },
      arReconciliation: {
        fromTrialBalance: arTb,
        fromARAging: arAging,
        matches: Math.abs(arDelta) <= RECON_TOLERANCE,
        delta: arDelta,
      },
      apReconciliation: {
        fromTrialBalance: apTb,
        fromAPAging: apAging,
        matches: Math.abs(apDelta) <= RECON_TOLERANCE,
        delta: apDelta,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tax line mapping helper (qb_tax_line_mapping) — Phase 15 #69
// ---------------------------------------------------------------------------

export type TaxLineMappingAccountInput = {
  ListID?: string;
  FullName?: string;
  Name?: string;
  AccountNumber?: string;
  AccountType?: string;
  IsActive?: boolean;
  TaxLineInfoRet?: { TaxLineID?: number | string; TaxLineName?: string };
};

export type TaxLineMappingRow = {
  accountListId: string | null;
  accountName: string;
  accountNumber: string | null;
  accountType: string;
  isActive: boolean;
  taxLineId: number | string | null;
  taxLineName: string | null;
  isUnmapped: boolean;
};

export type TaxLineMappingResult = {
  count: number;
  mappedCount: number;
  unmappedCount: number;
  accounts: TaxLineMappingRow[];
};

/**
 * Project a chart-of-accounts query response onto the tax-line-mapping shape.
 * Pure function so the projection + sort + mapped/unmapped split are unit-
 * testable without spinning up an MCP transport.
 *
 * An account is "mapped" when `TaxLineInfoRet.TaxLineName` is a non-empty
 * string. TaxLineID alone (without a name) does not qualify — the name is
 * the workpaper-readable label every downstream consumer (qb_trial_balance_
 * export's taxLine column, the tax preparer reading the workpaper) keys on.
 *
 * Sort: canonical workpaper order — AccountType (using TB_ACCOUNT_TYPES
 * order; types outside that set sort last alphabetically), then AccountNumber
 * (lex compare since AccountNumber is a string in QB — `1000-1` / `1000.A`
 * patterns), then alphabetical FullName.
 */
export function buildTaxLineMapping(
  accounts: ReadonlyArray<TaxLineMappingAccountInput | Record<string, unknown>>,
  options: { includeUnmapped?: boolean } = {},
): TaxLineMappingResult {
  const rows: TaxLineMappingRow[] = [];

  for (const a of accounts) {
    const rec = a as TaxLineMappingAccountInput;
    const name = String(rec.FullName ?? rec.Name ?? "");
    if (!name) continue;
    const taxInfo = rec.TaxLineInfoRet;
    const taxLineName = taxInfo?.TaxLineName ? String(taxInfo.TaxLineName) : null;
    const taxLineId = taxInfo?.TaxLineID !== undefined && taxInfo.TaxLineID !== null
      ? taxInfo.TaxLineID
      : null;
    const isUnmapped = !taxLineName;
    if (isUnmapped && options.includeUnmapped !== true) continue;

    rows.push({
      accountListId: rec.ListID ? String(rec.ListID) : null,
      accountName: name,
      accountNumber: rec.AccountNumber ? String(rec.AccountNumber) : null,
      accountType: String(rec.AccountType ?? ""),
      isActive: rec.IsActive !== false,
      taxLineId,
      taxLineName,
      isUnmapped,
    });
  }

  const typeOrder = new Map(TB_ACCOUNT_TYPES.map((t, i) => [t, i]));
  rows.sort((a, b) => {
    const oa = typeOrder.get(a.accountType) ?? 999;
    const ob = typeOrder.get(b.accountType) ?? 999;
    if (oa !== ob) return oa - ob;
    if (oa === 999 && a.accountType !== b.accountType) {
      return a.accountType.localeCompare(b.accountType);
    }
    if (a.accountNumber && b.accountNumber) {
      const cmp = a.accountNumber.localeCompare(b.accountNumber);
      if (cmp !== 0) return cmp;
    } else if (a.accountNumber && !b.accountNumber) {
      return -1;
    } else if (!a.accountNumber && b.accountNumber) {
      return 1;
    }
    return a.accountName.localeCompare(b.accountName);
  });

  let mappedCount = 0;
  let unmappedCount = 0;
  for (const r of rows) {
    if (r.isUnmapped) unmappedCount += 1;
    else mappedCount += 1;
  }

  return {
    count: rows.length,
    mappedCount,
    unmappedCount,
    accounts: rows,
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

// ---------------------------------------------------------------------------
// Customer / Vendor balance detail helpers — Phase 11 #48 + #51
// ---------------------------------------------------------------------------
//
// qb_customer_balance_detail and qb_vendor_balance_detail share the same
// per-entity running-balance shape: walk this entity's AR-/AP-affecting
// transactions in the window, opening balance = current snapshot − period
// postings, then walk forward. Identical math to buildGeneralLedgerSection
// except the snapshot field is Customer.Balance / Vendor.Balance (the entity's
// open AR/AP balance) instead of Account.Balance.

export type EntityBalanceEntity = {
  ListID?: string;
  FullName?: string;
  Name?: string;
  Balance?: number;
};

export type EntityBalanceRow = Record<string, unknown> & {
  Amount: number;
};

export type EntityBalanceSection = {
  entityName: string;
  entityListId?: string;
  openingBalance: number;
  closingBalance: number;
  periodChange: number;
  count: number;
  transactions: Array<Record<string, unknown> & { RunningBalance: number }>;
};

/**
 * Build one entity-balance section: openingBalance → period rows (each
 * annotated with RunningBalance) → closingBalance. Pure function so the math
 * can be unit-tested without spinning up an MCP transport.
 *
 * Algorithm (same shape as buildGeneralLedgerSection — see comments there):
 *   1. currentBalance = entity.Balance (snapshot through "now").
 *   2. periodSum     = Σ row.Amount over the queried window (signed).
 *   3. openingBalance = currentBalance − periodSum.
 *   4. Walk rows forward; RunningBalance += row.Amount per row.
 *
 * Exact when toDate ≥ now. For historical windows (toDate < now AND postings
 * exist after toDate) openingBalance is overstated by those after-period
 * postings — same documented limitation as qb_general_ledger.
 *
 * Sign convention (caller's responsibility — the helper only sums and walks):
 *   Customer balance: Invoice +, ReceivePayment −, CreditMemo −
 *   Vendor balance:   Bill +, BillPaymentCheck −, BillPaymentCreditCard −
 * Positive Amount increases the entity's open AR/AP balance.
 *
 * Rows are NOT re-sorted here — the caller guarantees chronological order
 * (by TxnDate ascending, then TimeCreated as tiebreaker).
 */
export function buildEntityBalanceSection(
  entity: EntityBalanceEntity,
  rows: EntityBalanceRow[],
): EntityBalanceSection {
  const entityName = String(entity.FullName ?? entity.Name ?? "");
  const currentBalance = Number(entity.Balance ?? 0);
  const periodSum = rows.reduce((s, r) => s + Number(r.Amount ?? 0), 0);
  const openingBalance = round2((Number.isFinite(currentBalance) ? currentBalance : 0) - periodSum);

  let running = openingBalance;
  const transactions: Array<Record<string, unknown> & { RunningBalance: number }> = rows.map((r) => {
    running += Number(r.Amount ?? 0);
    return { ...r, RunningBalance: round2(running) };
  });
  const closingBalance = round2(running);

  return {
    entityName,
    ...(entity.ListID ? { entityListId: String(entity.ListID) } : {}),
    openingBalance,
    closingBalance,
    periodChange: round2(periodSum),
    count: transactions.length,
    transactions,
  };
}

// Extract the original transaction amount that hit AR/AP at create time.
// Invoice carries Subtotal + SalesTaxTotal directly; CreditMemo carries the
// pre-computed TotalAmount; ReceivePayment carries TotalAmount; BillPayment*
// carries TotalAmount (Amount fallback for older sim records — see the
// HANDOFF gotcha on BillPaymentCheck). Bill is the outlier — its AmountDue
// header field is DECREMENTED on every bill payment, so a fully-paid bill
// has AmountDue=0 and can't be sourced from there; walk ExpenseLineRet +
// ItemLineRet sums for the original face value.
export function extractOriginalTxnAmount(
  txn: Record<string, unknown>,
  txnType: string,
): number {
  if (txnType === "Invoice") {
    return round2(Number(txn.Subtotal ?? 0) + Number(txn.SalesTaxTotal ?? 0));
  }
  if (txnType === "CreditMemo") {
    const total = Number(txn.TotalAmount ?? 0);
    if (total) return round2(total);
    return round2(Number(txn.Subtotal ?? 0) + Number(txn.SalesTaxTotal ?? 0));
  }
  if (txnType === "ReceivePayment") {
    return round2(Number(txn.TotalAmount ?? 0));
  }
  if (txnType === "BillPaymentCheck" || txnType === "BillPaymentCreditCard") {
    return round2(Number(txn.TotalAmount ?? txn.Amount ?? 0));
  }
  if (txnType === "Bill") {
    let sum = 0;
    for (const key of ["ExpenseLineRet", "ItemLineRet"]) {
      const lines = txn[key];
      if (!Array.isArray(lines)) continue;
      for (const line of lines as Record<string, unknown>[]) {
        const amt = Number(line.Amount ?? 0);
        if (Number.isFinite(amt)) sum += amt;
      }
    }
    return round2(sum);
  }
  return 0;
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
        return formatToolError(err, { fallbackMessage: "CompanyQueryRq failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // Host info — QB edition / version detection (Phase 18 #82)
  // -----------------------------------------------------------------------

  // Wraps HostQueryRq. The response describes the QB Desktop INSTALLATION
  // (ProductName, MajorVersion, SupportedQBXMLVersionList, IsAutomaticLogin,
  // QBFileMode) — distinct from CompanyQueryRq's file-scoped properties.
  // Cached at the session manager (first call hits the wire, subsequent calls
  // return the cache) — invalidated on qb_company_open. Pass refresh:true to
  // force a fresh round trip (e.g. after a QB Desktop upgrade mid-process).
  //
  // The derived `edition` field is the gating signal downstream tools should
  // use — never parse `productName` directly. `isEnterprise` gates Enterprise-
  // only features (item 66 audit log); `isAccountant` flags Accountant-edition
  // builds (which have a different report set). Payroll-gated tools (item 55
  // qb_w2_summary) need a separate subscription probe — Payroll subscription
  // is not derivable from HostRet alone.
  server.tool(
    "qb_host_query",
    "Run HostQueryRq for QB Desktop installation metadata — productName / majorVersion / minorVersion / country / supportedQbxmlVersions / isAutomaticLogin / qbFileMode (SingleUser | MultiUser) — plus derived `edition` (Pro | Premier | PremierAccountant | Enterprise | EnterpriseAccountant | Unknown), `isEnterprise`, `isAccountant`, and `maxQbxmlVersion`. Cached at the session manager after the first call; pass refresh:true to force a re-query. Use `edition` to gate edition-specific features (Enterprise-only audit log, Premier-only payroll variants, etc.) — do NOT parse `productName` directly. Payroll subscription is NOT derivable from this response (it requires a separate subscription probe).",
    {
      refresh: z.boolean().optional().describe("Force a fresh HostQueryRq round trip, bypassing the cache. Default false — first call populates the cache, subsequent calls return it until qb_company_open clears it."),
    },
    async ({ refresh }) => {
      const session = getSession();
      try {
        // Snapshot cache state BEFORE the call — `cached: true` means the
        // response came from cache, not that the cache is populated now (it
        // always is after the call returns).
        const wasCached = session.peekHostInfoCache() !== null;
        const hostInfo = await session.getHostInfo({ refresh: refresh ?? false });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ...hostInfo,
              cached: !refresh && wasCached,
              simulationMode: session.isSimulation(),
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "HostQueryRq failed" });
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
        return formatToolError(err, { fallbackMessage: "qb_balance_summary failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // Trial balance export (qb_trial_balance_export) — Phase 15 #68
  //
  // Composite over AccountQueryRq + BalanceSheetStandard + ProfitAndLossStandard
  // + InvoiceQueryRq (for AR aging total) + BillQueryRq (for AP aging total).
  // Five wire calls in the default path; the chart-of-accounts query feeds
  // both the per-row metadata (AccountType / AccountNumber / IsActive / TaxLine)
  // and the cross-check name→type lookups.
  //
  // includeLastActivityDate: true triggers an additional per-account
  // TransactionQueryRq fanout. That's N+5 round trips for an N-account chart —
  // ~10s for a 200-account chart at typical QBXMLRP2 latency. Default is off
  // so the bare tool call stays cheap (workpaper use opts in deliberately).
  //
  // Sim caveat: the same caveat as qb_balance_summary applies — sim's
  // BalanceSheetStandard draws AS/LI/EQ from Account.Balance snapshot (asOfDate
  // is advisory for those buckets), but the P&L walk IS date-bounded. The
  // cross-check arithmetic is correct in both modes.
  // -----------------------------------------------------------------------
  server.tool(
    "qb_trial_balance_export",
    "Trial Balance export shaped for tax-season workpapers. Returns one row per posting account with non-zero balance (debits and credits split by natural-balance side — Asset/Expense balances → debit column, Liability/Equity/Income → credit column; contra-balances flip to the OTHER column rather than appearing as a negative number), sorted by canonical AccountType then AccountNumber. Each row carries accountListId / accountName / accountNumber / accountType / taxLine (from Account.TaxLineInfoRet.TaxLineName — populated by live QB and by sim seed for the mapped accounts; null for unmapped accounts) / debitBalance / creditBalance / isActive / lastActivityDate. Plus four cross-checks: balanceSheet (Assets ≡ Liabilities + Equity), netIncome (P&L NetIncome ≡ BS NetIncome), arReconciliation (AR account balance ≡ AR aging total), apReconciliation (AP account balance ≡ AP aging total) — each with delta and a `matches`/`reconciles` boolean (cent-tolerance). Any mismatch is an audit signal. NonPosting accounts (estimates, POs, sales orders) are excluded from the TB (matches the workpaper convention; for NonPosting balances use qb_balance_summary). Defaults: includeInactive=false (inactive accounts dropped), includeZeroBalances=false (zero-balance rows dropped — TB convention), includeLastActivityDate=false (the opt-in costs N additional TransactionQueryRq round trips, one per account — useful for tax-season workpapers, skip for quick reconciliation). Composite of 5 wire calls (AccountQueryRq + BalanceSheetStandard + ProfitAndLossStandard + InvoiceQueryRq + BillQueryRq) in the default path. Sim caveat: BalanceSheetStandard reads Account.Balance for AS/LI/EQ (snapshot — asOfDate advisory for those buckets); P&L walk IS date-bounded in both modes; cross-check arithmetic is correct in both.",
    {
      asOfDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("As-of date (YYYY-MM-DD). Defaults to today. Used as toDate for both the BalanceSheetStandard run and the lifetime-through-asOfDate P&L walk."),
      basis: z.enum(["Accrual", "Cash"]).optional()
        .describe("Accounting basis. Defaults to Accrual."),
      includeInactive: z.boolean().optional()
        .describe("When true, include inactive accounts (IsActive === false). Default false — workpapers normally exclude them."),
      includeZeroBalances: z.boolean().optional()
        .describe("When true, include accounts whose computed balance rounds to $0.00. Default false — TB convention drops zero rows. Set true to verify chart coverage."),
      includeLastActivityDate: z.boolean().optional()
        .describe("When true, fans out one TransactionQueryRq per row to surface the most-recent posting date per account. Costs N additional round trips (~10s for a 200-account chart in live mode); per-account errors land in `warnings` and the row's `lastActivityDate` stays null. Default false — opt in for tax-season workpapers."),
    },
    async (args) => {
      const session = getSession();
      try {
        const effectiveAsOf = args.asOfDate ?? new Date().toISOString().split("T")[0];
        const effectiveBasis = args.basis ?? "Accrual";

        const accounts = await session.queryEntity("Account", {});

        // BS first, then P&L (sequential — QBXMLRP2 serializes COM calls
        // anyway, and avoiding parallel-session races in live mode).
        const bsRet = await session.runReport("BalanceSheetStandard", {
          toDate: effectiveAsOf,
          basis: effectiveBasis,
        });
        const pnlRet = await session.runReport("ProfitAndLossStandard", {
          toDate: effectiveAsOf,
          basis: effectiveBasis,
        });

        // AR / AP aging totals — same walk qb_ar_aging / qb_ap_aging perform
        // for the bucketed view, summed without the per-bucket math. Walking
        // typed entities (rather than reading the reports' AR/AP rows) gives
        // the canonical aging-total signal the cross-check is meant to match.
        const invoices = await session.queryEntity("Invoice", {});
        let arAgingTotal = 0;
        for (const inv of invoices) {
          if (inv.IsPaid === true) continue;
          const bal = Number(inv.BalanceRemaining ?? 0);
          if (bal > 0) arAgingTotal += bal;
        }

        const bills = await session.queryEntity("Bill", {});
        let apAgingTotal = 0;
        for (const bill of bills) {
          if (bill.IsPaid === true) continue;
          const amt = Number(bill.AmountDue ?? 0);
          if (amt > 0) apAgingTotal += amt;
        }

        // Optional per-account LastActivityDate. Walks each posting account
        // via TransactionQueryRq, picks max(TxnDate) from the returned rows.
        // Per-account failures are isolated — they surface in warnings but
        // don't fail the whole tool (the rest of the TB is still useful).
        let lastActivityByAccount: Map<string, string> | undefined;
        const warnings: string[] = [];
        if (args.includeLastActivityDate === true) {
          lastActivityByAccount = new Map();
          const allowedTypes = new Set<string>(TB_ACCOUNT_TYPES);
          for (const acct of accounts as TrialBalanceAccount[]) {
            const type = String(acct.AccountType ?? "");
            const name = String(acct.FullName ?? acct.Name ?? "");
            if (!name || !allowedTypes.has(type)) continue;
            if (!acct.ListID) continue;
            try {
              const rows = await session.queryTransactions({
                AccountFilter: { ListID: String(acct.ListID) },
                MaxReturned: 1000,
              });
              let maxDate = "";
              for (const r of rows) {
                const d = String((r as Record<string, unknown>).TxnDate ?? "");
                if (d && d > maxDate) maxDate = d;
              }
              if (maxDate) lastActivityByAccount.set(name, maxDate);
            } catch (err) {
              const e = err as { message?: string };
              warnings.push(`lastActivityDate lookup failed for ${name}: ${e.message ?? "unknown"}`);
            }
          }
        }

        const result = buildTrialBalance(
          accounts as TrialBalanceAccount[],
          bsRet as TrialBalanceReportInput,
          pnlRet as TrialBalanceReportInput,
          arAgingTotal,
          apAgingTotal,
          {
            includeInactive: args.includeInactive === true,
            includeZeroBalances: args.includeZeroBalances === true,
            lastActivityByAccount,
          },
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              asOfDate: effectiveAsOf,
              basis: effectiveBasis,
              rowCount: result.rowCount,
              rows: result.rows,
              totals: result.totals,
              crossChecks: result.crossChecks,
              ...(warnings.length > 0 ? { warnings } : {}),
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "qb_trial_balance_export failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // Tax line mapping (Phase 15 #69)
  // -----------------------------------------------------------------------
  // Direct bridge from QB's chart of accounts to a tax-prep workpaper. Every
  // QB account can carry a tax-line assignment (Sch C / Sch L / 1120-S /
  // 1065 / Sch E / etc.) — `AccountQueryRq` already returns that mapping
  // under `TaxLineInfoRet.{TaxLineID, TaxLineName}` but no dedicated tool
  // exposes it. Without this, every workpaper rebuilds the same mapping by
  // hand: chart of accounts → which 1120-S line each account rolls up to.
  //
  // Pure read-side composite over `session.queryEntity("Account", filters)`.
  // No new wire types, no schema-order risk, no manager method needed.
  // Filters mirror `qb_account_list` so the same scope args work in both
  // tools (accountListId / accountName / accountType). The two tools differ
  // only in PROJECTION — qb_account_list returns full Account records;
  // qb_tax_line_mapping returns just the tax-line bridge fields plus the
  // mapped/unmapped split count.
  server.tool(
    "qb_tax_line_mapping",
    "Tax-line mapping for the chart of accounts — bridge from books to tax software. Returns each posting account with its assigned tax-line (Sch C / Sch L / 1120-S / 1065 / etc.) from Account.TaxLineInfoRet, so the tax preparer can group accounts by tax-line code without rebuilding the mapping by hand. Pure projection over AccountQueryRq — same shape qb_trial_balance_export's `taxLine` column reads from. Defaults: returns all active mapped accounts (accounts whose TaxLineInfoRet is populated). Pass includeUnmapped:true to include accounts that have no tax-line assignment (one of the workpaper-prep checks — every income/expense account should be mapped before filing). Scope optionally to a single account (accountListId or accountName) or a single AccountType (accountType). NonPosting accounts are NOT excluded by default — pass an explicit accountType filter to scope. Output: { count, mappedCount, unmappedCount, accounts: [{accountListId, accountName, accountNumber, accountType, isActive, taxLineId, taxLineName, isUnmapped}] } sorted by accountType then accountNumber then name (workpaper convention).",
    {
      accountListId: z.string().optional()
        .describe("Scope to a single account by ListID. Mutually exclusive with accountName in practice (both work; ListID wins on the wire)."),
      accountName: z.string().optional()
        .describe("Scope to a single account by FullName (exact match)."),
      accountType: z.string().optional()
        .describe("Filter to one AccountType (e.g. 'Income', 'Expense', 'Bank'). See the AccountType enum on qb_account_add for the full set."),
      includeInactive: z.boolean().optional()
        .describe("When true, include inactive accounts (IsActive === false). Default false — workpapers normally exclude them."),
      includeUnmapped: z.boolean().optional()
        .describe("When true, include accounts with no TaxLineInfoRet. Default false — only mapped accounts surface. Set true to audit the chart for missing tax-line assignments before filing."),
    },
    async (args) => {
      const session = getSession();
      try {
        const filters: Record<string, unknown> = {};
        if (args.accountListId) filters.ListID = args.accountListId;
        if (args.accountName) filters.FullName = args.accountName;
        if (args.accountType) filters.AccountType = args.accountType;
        if (args.includeInactive !== true) filters.ActiveStatus = "ActiveOnly";

        const raw = await session.queryEntity("Account", filters);
        const mapping = buildTaxLineMapping(raw, {
          includeUnmapped: args.includeUnmapped === true,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(mapping, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "qb_tax_line_mapping failed" });
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
        return formatToolError(err, { fallbackMessage: "InvoiceQueryRq failed" });
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
        return formatToolError(err, { fallbackMessage: "BillQueryRq failed" });
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
        return formatToolError(err, { fallbackMessage: "GeneralSummaryReportQueryRq (ProfitAndLossStandard) failed" });
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
        return formatToolError(err, { fallbackMessage: "GeneralSummaryReportQueryRq (BalanceSheetStandard) failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // Statement of Cash Flows (Phase 11 #54)
  // -----------------------------------------------------------------------
  server.tool(
    "qb_statement_of_cash_flows",
    "Run a Statement of Cash Flows (GeneralSummaryReportType=StatementOfCashFlows, indirect method). Returns Operating Activities / Investing Activities / Financing Activities sections plus totals (NetCashIncrease, CashAtBeginningOfPeriod, CashAtEndOfPeriod). Simulation mode uses a narrower indirect-method model than real QB: Operating section walks NetIncome + ΔAR + ΔAP only (no inventory / prepaid / accrued / depreciation add-back); Investing walks period postings to FixedAsset + OtherAsset accounts; Financing walks period postings to LongTermLiability + Equity accounts. CashAtBeginningOfPeriod in sim mode is derived as CashAtEnd − NetCashIncrease (no historical Bank.Balance series). For accurate cash-flow numbers run against live QuickBooks Desktop, which uses QB's own indirect-method engine.",
    {
      fromDate: z.string().regex(ISO_DATE_RE).optional().describe("Start of reporting window (YYYY-MM-DD), inclusive. Omit for no lower bound."),
      toDate: z.string().regex(ISO_DATE_RE).optional().describe("End of reporting window (YYYY-MM-DD), inclusive. Omit for no upper bound."),
      basis: z.enum(["Accrual", "Cash"]).optional().describe("Accounting basis. Defaults to Accrual."),
    },
    async ({ fromDate, toDate, basis }) => {
      const session = getSession();
      try {
        const reportRet = await session.runReport("StatementOfCashFlows", {
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
              reportTitle: reportRet.ReportTitle ?? "Statement of Cash Flows",
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
              netCashIncrease: Number(totals.NetCashIncrease ?? 0),
              cashAtBeginningOfPeriod: Number(totals.CashAtBeginningOfPeriod ?? 0),
              cashAtEndOfPeriod: Number(totals.CashAtEndOfPeriod ?? 0),
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "GeneralSummaryReportQueryRq (StatementOfCashFlows) failed" });
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
        return formatToolError(err, { fallbackMessage: "qb_general_ledger failed" });
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
        return formatToolError(err, { fallbackMessage: "GeneralSummaryReportQueryRq (SalesByCustomerSummary) failed" });
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
        return formatToolError(err, { fallbackMessage: "GeneralDetailReportQueryRq (SalesByCustomerDetail) failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // qb_sales_by_item_summary (Phase 11 #50)
  //
  // Wraps GeneralSummaryReportQueryRq with ReportType=SalesByItemSummary.
  // Per-item revenue rollup over the date window: walks Invoice + SalesReceipt
  // lines (positive) and CreditMemo lines (negative), groups by line.ItemRef
  // .FullName. Lines without an ItemRef (sales-tax / discount lines without
  // an item bound) drop naturally — there's no item to key them under, which
  // matches QB's actual SalesByItemSummary report.
  // -----------------------------------------------------------------------
  server.tool(
    "qb_sales_by_item_summary",
    "Sales by Item Summary — per-item revenue rollup (Invoice + SalesReceipt − CreditMemo line totals, grouped by line.ItemRef.FullName) over a date window. Returns items sorted by total descending plus the grand TotalSales. Scope to a single item with itemName / itemListId (server-side ReportItemFilter). Sums are line.Amount sums; lines without an ItemRef drop (no item to key under — matches QB's report). CreditMemo lines reduce sales — a negative item total in the response means more credits than billing in the window. Basis defaults to Accrual.",
    {
      fromDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Start of the reporting window (YYYY-MM-DD, inclusive). Omit for no lower bound (all-time)."),
      toDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("End of the reporting window (YYYY-MM-DD, inclusive). Omit for through-current (no upper bound)."),
      itemName: z.string().optional()
        .describe("Single-item scope by FullName (e.g. 'Consulting Services'). Passes through as ReportItemFilter.FullName. Takes precedence over itemListId."),
      itemListId: z.string().optional()
        .describe("Single-item scope by ListID. Resolved across all five Item subtype stores (ItemService / ItemInventory / ItemNonInventory / ItemOtherCharge / ItemGroup). Alternative to itemName."),
      basis: z.enum(["Accrual", "Cash"]).optional()
        .describe("Accounting basis. Defaults to Accrual. (Note: in simulation mode the income walk is identical regardless of basis — Cash-basis revenue recognition will land with the live-mode adapter validation.)"),
    },
    async ({ fromDate, toDate, itemName, itemListId, basis }) => {
      const session = getSession();
      try {
        const itemFilter = itemListId
          ? { ListID: itemListId }
          : itemName
            ? { FullName: itemName }
            : undefined;

        const reportRet = await session.runReport("SalesByItemSummary", {
          fromDate,
          toDate,
          basis,
          ...(itemFilter ? { itemFilter } : {}),
        });

        const totals = (reportRet.Totals as Record<string, unknown> | undefined) ?? {};
        const sections = (reportRet.Sections as Array<{
          Name: string;
          Accounts: Array<{ Name: string; Total: number }>;
          Subtotal: number;
        }> | undefined) ?? [];
        const items = sections[0]?.Accounts?.map((a) => ({
          itemName: a.Name,
          total: a.Total,
        })) ?? [];

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              reportTitle: reportRet.ReportTitle ?? "Sales by Item Summary",
              reportBasis: reportRet.ReportBasis ?? basis ?? "Accrual",
              reportPeriod: {
                from: reportRet.FromReportDate ?? fromDate ?? null,
                to: reportRet.ToReportDate ?? toDate ?? null,
              },
              itemCount: items.length,
              totalSales: Number(totals.TotalSales ?? 0),
              items,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "GeneralSummaryReportQueryRq (SalesByItemSummary) failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // qb_sales_by_item_detail (Phase 11 #50)
  // -----------------------------------------------------------------------
  server.tool(
    "qb_sales_by_item_detail",
    "Sales by Item Detail — per-line sales detail (Invoice / SalesReceipt / CreditMemo line rows) for the date window, sorted by Item → TxnDate → TxnID. Returns rows with TxnType / Date / Num (refNumber) / Name (customer) / Memo / Item / Quantity / Rate / Account (income account) / Amount / TxnID. CreditMemo rows emit with Amount sign-flipped (negative). Lines without an ItemRef drop (no item to attribute). Scope by item (itemName | itemListId) for single-item drilldown. NOTE: live mode adapter for this report uses the same row-tree translator as CustomDetailReport — verified-by-construction structurally but live-validation against a real QB Desktop hasn't been run yet.",
    {
      fromDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Start of the reporting window (YYYY-MM-DD, inclusive). Omit for no lower bound."),
      toDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("End of the reporting window (YYYY-MM-DD, inclusive). Omit for through-current."),
      itemName: z.string().optional()
        .describe("Single-item scope by FullName. Passes through as ReportItemFilter.FullName. Takes precedence over itemListId."),
      itemListId: z.string().optional()
        .describe("Single-item scope by ListID. Resolved across all five Item subtype stores. Alternative to itemName."),
      basis: z.enum(["Accrual", "Cash"]).optional()
        .describe("Accounting basis. Defaults to Accrual."),
    },
    async ({ fromDate, toDate, itemName, itemListId, basis }) => {
      const session = getSession();
      try {
        const itemFilter = itemListId
          ? { ListID: itemListId }
          : itemName
            ? { FullName: itemName }
            : undefined;

        const reportRet = await session.runGeneralDetailReport({
          reportType: "SalesByItemDetail",
          fromDate,
          toDate,
          basis,
          ...(itemFilter ? { itemFilter } : {}),
        });

        const rows = (reportRet.Rows as Record<string, unknown>[] | undefined) ?? [];
        const columns = (reportRet.Columns as Array<{ Title: string; Type: string }> | undefined) ?? [];
        const totalAmount = round2(
          rows.reduce((s, r) => s + Number(r.Amount ?? 0), 0),
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              reportTitle: reportRet.ReportTitle ?? "Sales by Item Detail",
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
        return formatToolError(err, { fallbackMessage: "GeneralDetailReportQueryRq (SalesByItemDetail) failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // qb_expense_by_vendor_summary (Phase 11 #52)
  //
  // Wraps GeneralSummaryReportQueryRq with ReportType=ExpensesByVendorSummary.
  // Per-vendor expense rollup: walks Bill (VendorRef) + Check (PayeeEntityRef)
  // + CreditCardCharge (PayeeEntityRef) ExpenseLineRet + ItemLineRet, sums
  // line.Amount by vendor name. Mirrors qb_sales_by_customer_summary's
  // simpler approach — every line.Amount counts (no AccountType filter), which
  // means the rare asset-purchase via Check is included too. Documented.
  // -----------------------------------------------------------------------
  server.tool(
    "qb_expense_by_vendor_summary",
    "Expenses by Vendor Summary — per-vendor expense rollup (Bill + Check + CreditCardCharge ExpenseLineRet + ItemLineRet totals, grouped by the txn's VendorRef / PayeeEntityRef) over a date window. Returns vendors sorted by total descending plus the grand TotalExpenses. Scope to a single vendor with vendorName / vendorListId (server-side ReportEntityFilter). Sums are line.Amount sums — caveat: the simpler walk does NOT filter by underlying account's AccountType (matches the Phase 11 #49 simplification), so a Check posting to a Fixed Asset account still counts here as an 'expense to vendor X'. Real QB's ExpensesByVendor scopes to Expense/COGS/OtherExpense postings; in live mode this report goes through QB which applies that filter. Basis defaults to Accrual.",
    {
      fromDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Start of the reporting window (YYYY-MM-DD, inclusive). Omit for no lower bound (all-time)."),
      toDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("End of the reporting window (YYYY-MM-DD, inclusive). Omit for through-current (no upper bound)."),
      vendorName: z.string().optional()
        .describe("Single-vendor scope by FullName (e.g. 'ACME Property Mgmt'). Passes through as ReportEntityFilter.FullName. Takes precedence over vendorListId."),
      vendorListId: z.string().optional()
        .describe("Single-vendor scope by ListID. Resolved against the Vendor store. Alternative to vendorName."),
      basis: z.enum(["Accrual", "Cash"]).optional()
        .describe("Accounting basis. Defaults to Accrual. (Note: in simulation mode the expense walk is identical regardless of basis.)"),
    },
    async ({ fromDate, toDate, vendorName, vendorListId, basis }) => {
      const session = getSession();
      try {
        const entityFilter = vendorListId
          ? { ListID: vendorListId }
          : vendorName
            ? { FullName: vendorName }
            : undefined;

        const reportRet = await session.runReport("ExpensesByVendorSummary", {
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
        const vendors = sections[0]?.Accounts?.map((a) => ({
          vendorName: a.Name,
          total: a.Total,
        })) ?? [];

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              reportTitle: reportRet.ReportTitle ?? "Expenses by Vendor Summary",
              reportBasis: reportRet.ReportBasis ?? basis ?? "Accrual",
              reportPeriod: {
                from: reportRet.FromReportDate ?? fromDate ?? null,
                to: reportRet.ToReportDate ?? toDate ?? null,
              },
              vendorCount: vendors.length,
              totalExpenses: Number(totals.TotalExpenses ?? 0),
              vendors,
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "GeneralSummaryReportQueryRq (ExpensesByVendorSummary) failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // qb_expense_by_vendor_detail (Phase 11 #52)
  // -----------------------------------------------------------------------
  server.tool(
    "qb_expense_by_vendor_detail",
    "Expenses by Vendor Detail — per-line expense detail (Bill / Check / CreditCardCharge ExpenseLineRet + ItemLineRet rows) for the date window, sorted by Vendor → TxnDate → TxnID. Returns rows with TxnType / Date / Num (refNumber) / Name (vendor) / Memo / Item (item line only) / Quantity / Rate (or Cost for item lines) / Account (expense account, or 'Uncategorized Expense' fallback when an item carries no ExpenseAccountRef) / Amount / TxnID. Scope by vendor (vendorName | vendorListId) for single-vendor drilldown. Same caveat as the summary variant: sim doesn't filter by underlying account's AccountType. NOTE: live mode adapter reuses the CustomDetailReport row-tree translator — verified-by-construction structurally but live-validation against a real QB Desktop hasn't been run yet.",
    {
      fromDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Start of the reporting window (YYYY-MM-DD, inclusive). Omit for no lower bound."),
      toDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("End of the reporting window (YYYY-MM-DD, inclusive). Omit for through-current."),
      vendorName: z.string().optional()
        .describe("Single-vendor scope by FullName. Passes through as ReportEntityFilter.FullName. Takes precedence over vendorListId."),
      vendorListId: z.string().optional()
        .describe("Single-vendor scope by ListID. Resolved against the Vendor store. Alternative to vendorName."),
      basis: z.enum(["Accrual", "Cash"]).optional()
        .describe("Accounting basis. Defaults to Accrual."),
    },
    async ({ fromDate, toDate, vendorName, vendorListId, basis }) => {
      const session = getSession();
      try {
        const entityFilter = vendorListId
          ? { ListID: vendorListId }
          : vendorName
            ? { FullName: vendorName }
            : undefined;

        const reportRet = await session.runGeneralDetailReport({
          reportType: "ExpensesByVendorDetail",
          fromDate,
          toDate,
          basis,
          ...(entityFilter ? { entityFilter } : {}),
        });

        const rows = (reportRet.Rows as Record<string, unknown>[] | undefined) ?? [];
        const columns = (reportRet.Columns as Array<{ Title: string; Type: string }> | undefined) ?? [];
        const totalAmount = round2(
          rows.reduce((s, r) => s + Number(r.Amount ?? 0), 0),
        );

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              reportTitle: reportRet.ReportTitle ?? "Expenses by Vendor Detail",
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
        return formatToolError(err, { fallbackMessage: "GeneralDetailReportQueryRq (ExpensesByVendorDetail) failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // qb_customer_balance_detail (Phase 11 #48)
  //
  // Composite over typed entity queries — fetches Customer + Invoice +
  // ReceivePayment + CreditMemo (optionally scoped by EntityFilter +
  // TxnDateRangeFilter), groups postings by customer, walks each group
  // chronologically with buildEntityBalanceSection. Same composite pattern
  // as qb_ar_aging (one query per entity type), NOT qb_general_ledger's
  // per-customer TransactionQueryRq fanout — TransactionQueryRq requires
  // AccountFilter and emits line-level postings only, which means the sim
  // doesn't surface AR counter-postings (a known limitation documented on
  // handleTransactionQuery). Walking typed entities directly hits the AR
  // posting on Invoice/ReceivePayment/CreditMemo without that gap and
  // collapses to ≤3 round trips regardless of customer count.
  //
  // Sign convention (handled by extractOriginalTxnAmount):
  //   Invoice         → +Subtotal + SalesTaxTotal (increases AR)
  //   ReceivePayment  → -TotalAmount             (decreases AR)
  //   CreditMemo      → -TotalAmount             (decreases AR)
  //
  // JournalEntry postings to the AR account are NOT walked — JE lines don't
  // reliably carry a customer reference in the sim, and a JE that debits AR
  // shows on qb_transaction_list_by_account / qb_general_ledger for the AR
  // account directly. Documented limitation; real QB CustomerBalanceDetail
  // would include them via the per-line customer ref the live wire returns.
  // -----------------------------------------------------------------------
  server.tool(
    "qb_customer_balance_detail",
    "Customer Balance Detail — for every customer with AR activity in the date window (or the single customer selected by customerName / customerListId), list every Invoice / ReceivePayment / CreditMemo that hit their AR balance, sorted by TxnDate ascending, with per-row RunningBalance plus per-customer OpeningBalance / ClosingBalance / periodChange. Composite of InvoiceQueryRq + ReceivePaymentQueryRq + CreditMemoQueryRq with optional EntityFilter — three round trips regardless of customer count (not a per-customer fanout). Sign convention: positive Amount = increases AR (Invoice posts the full Subtotal + SalesTaxTotal); negative = decreases AR (ReceivePayment.TotalAmount, CreditMemo.TotalAmount). RunningBalance math: openingBalance = Customer.Balance − periodSum, then walks forward; exact when toDate ≥ now. JournalEntry postings to the AR account are NOT walked (JE lines don't carry customer ref reliably in sim — visible via qb_transaction_list_by_account on the AR account directly). Empty sections (customers with no activity in window AND zero closing balance) are pruned by default — set includeZeroBalance:true to keep them.",
    {
      fromDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Start of the reporting window (YYYY-MM-DD, inclusive). Omit for all-time (each customer section walks every AR-affecting txn ever)."),
      toDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("End of the reporting window (YYYY-MM-DD, inclusive). Omit for through-current. RunningBalance math is exact only when toDate ≥ now."),
      customerName: z.string().optional()
        .describe("Single-customer scope by FullName. Passes through as EntityFilter.FullName on each underlying query. Takes precedence over customerListId."),
      customerListId: z.string().optional()
        .describe("Single-customer scope by ListID. Alternative to customerName."),
      basis: z.enum(["Accrual", "Cash"]).optional()
        .describe("Accounting basis. Defaults to Accrual. Currently advisory in simulation (the entity walks don't branch on basis); threaded through for parity with other report tools."),
      maxCustomers: z.number().int().positive().optional()
        .describe("Cap on the number of customers to emit sections for (safety brake). Default 200. Sections are sorted alphabetically by customer name before truncation, so the first N alphabetically win."),
      maxRowsPerCustomer: z.number().int().positive().optional()
        .describe("Per-customer row cap. Default 500. Hitting this cap on any customer triggers a `truncated` flag on that section."),
      includeZeroBalance: z.boolean().optional()
        .describe("When true, include customers with no activity in the window AND zero closing balance. Default false — empty sections are pruned so the response focuses on customers with AR activity or open balance."),
    },
    async (args) => {
      const session = getSession();
      const effectiveMaxCustomers = args.maxCustomers ?? 200;
      const effectiveMaxRows = args.maxRowsPerCustomer ?? 500;
      const includeZero = args.includeZeroBalance === true;
      const warnings: string[] = [];

      try {
        const allCustomers = await session.queryEntity("Customer", {});

        let targetCustomers = allCustomers as EntityBalanceEntity[];
        if (args.customerListId) {
          targetCustomers = targetCustomers.filter(
            (c) => String(c.ListID ?? "") === args.customerListId,
          );
          if (targetCustomers.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  statusCode: 500,
                  statusMessage: `Customer with ListID '${args.customerListId}' not found`,
                  humanReadable: qbStatusCodeMessage(500),
                }),
              }],
              isError: true,
            };
          }
        } else if (args.customerName) {
          targetCustomers = targetCustomers.filter(
            (c) => String(c.FullName ?? c.Name ?? "") === args.customerName,
          );
          if (targetCustomers.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  statusCode: 500,
                  statusMessage: `Customer with FullName '${args.customerName}' not found`,
                  humanReadable: qbStatusCodeMessage(500),
                }),
              }],
              isError: true,
            };
          }
        }

        // Build shared filter dict in canonical schema order: MaxReturned →
        // TxnDateRangeFilter → EntityFilter (per qbxmlops <xs:sequence> for
        // InvoiceQueryRq / ReceivePaymentQueryRq / CreditMemoQueryRq; pinned
        // in tests/builder-emit-order.test.ts for InvoiceQueryRq, the others
        // share the same prefix).
        //
        // Resolve listId → fullName for the EntityFilter: real QB matches
        // either form, but the sim's handleQuery only checks ref.ListID
        // directly and stored CustomerRefs added via addEntity with only
        // FullName don't carry a hydrated ListID. Canonicalizing to FullName
        // (taken from the already-fetched customer record) keeps the match
        // robust across both modes.
        const resolvedCustomer = targetCustomers.length === 1 ? targetCustomers[0] : null;
        const entityFilter = resolvedCustomer
          ? { FullName: String(resolvedCustomer.FullName ?? resolvedCustomer.Name ?? "") }
          : args.customerName
            ? { FullName: args.customerName }
            : undefined;

        const sharedFilters: Record<string, unknown> = {};
        if (args.fromDate || args.toDate) {
          sharedFilters.TxnDateRangeFilter = {
            FromTxnDate: args.fromDate,
            ToTxnDate: args.toDate,
          };
        }
        if (entityFilter) sharedFilters.EntityFilter = entityFilter;

        const [invoices, payments, creditMemos] = await Promise.all([
          session.queryEntity("Invoice", sharedFilters),
          session.queryEntity("ReceivePayment", sharedFilters),
          session.queryEntity("CreditMemo", sharedFilters),
        ]);

        // Group postings by customer FullName. Build rows tagged with TxnType
        // so the response carries enough context for the operator to drill
        // down via qb_invoice_list / qb_payment_list / qb_credit_memo_list.
        const rowsByCustomer = new Map<string, EntityBalanceRow[]>();
        const pushRow = (
          customerName: string,
          row: EntityBalanceRow,
        ): void => {
          let list = rowsByCustomer.get(customerName);
          if (!list) {
            list = [];
            rowsByCustomer.set(customerName, list);
          }
          list.push(row);
        };

        const toRow = (
          txn: Record<string, unknown>,
          txnType: string,
          sign: 1 | -1,
        ): EntityBalanceRow | null => {
          const original = extractOriginalTxnAmount(txn, txnType);
          if (!Number.isFinite(original) || original === 0) return null;
          const ref = txn.CustomerRef as { FullName?: string } | undefined;
          const customerName = ref?.FullName ? String(ref.FullName) : null;
          if (!customerName) return null;
          const row: EntityBalanceRow = {
            TxnType: txnType,
            TxnID: String(txn.TxnID ?? ""),
            TxnDate: String(txn.TxnDate ?? ""),
            ...(txn.RefNumber !== undefined ? { RefNumber: String(txn.RefNumber) } : {}),
            ...(txn.Memo !== undefined ? { Memo: String(txn.Memo) } : {}),
            Amount: round2(sign * original),
            ...(txn.TimeCreated !== undefined ? { TimeCreated: String(txn.TimeCreated) } : {}),
          };
          pushRow(customerName, row);
          return row;
        };

        for (const inv of invoices) toRow(inv, "Invoice", 1);
        for (const pmt of payments) toRow(pmt, "ReceivePayment", -1);
        for (const cm of creditMemos) toRow(cm, "CreditMemo", -1);

        // Sort each customer's rows chronologically (TxnDate ascending,
        // TimeCreated tiebreaker for same-date postings).
        for (const list of rowsByCustomer.values()) {
          list.sort((a, b) => {
            const ad = String(a.TxnDate ?? "");
            const bd = String(b.TxnDate ?? "");
            if (ad !== bd) return ad < bd ? -1 : 1;
            const at = String(a.TimeCreated ?? "");
            const bt = String(b.TimeCreated ?? "");
            return at < bt ? -1 : at > bt ? 1 : 0;
          });
        }

        // Build sections — one per customer in the target set. Customers
        // without activity in the window AND zero closing balance are pruned
        // unless includeZeroBalance is set.
        const sections: Array<Omit<EntityBalanceSection, "entityName" | "entityListId"> & {
          customerName: string;
          customerListId?: string;
          truncated?: boolean;
        }> = [];

        // Sort customers alphabetically (matches QB's CustomerBalanceDetail
        // sort order) before applying the maxCustomers cap.
        const sortedCustomers = [...targetCustomers].sort((a, b) => {
          const an = String(a.FullName ?? a.Name ?? "");
          const bn = String(b.FullName ?? b.Name ?? "");
          return an < bn ? -1 : an > bn ? 1 : 0;
        });

        if (sortedCustomers.length > effectiveMaxCustomers) {
          warnings.push(
            `Customer fanout (${sortedCustomers.length}) exceeds maxCustomers (${effectiveMaxCustomers}). Truncating alphabetically — re-run with maxCustomers: ${sortedCustomers.length} or scope by customerName / customerListId.`,
          );
        }
        const capped = sortedCustomers.slice(0, effectiveMaxCustomers);

        let totalRowCount = 0;
        for (const customer of capped) {
          const cName = String(customer.FullName ?? customer.Name ?? "");
          const allRows = rowsByCustomer.get(cName) ?? [];
          const truncated = allRows.length > effectiveMaxRows;
          const rows = truncated ? allRows.slice(0, effectiveMaxRows) : allRows;
          const section = buildEntityBalanceSection(customer, rows);
          totalRowCount += section.count;

          // Prune sections with no activity AND zero closing balance — these
          // are customers in the master list who happen not to have any
          // open AR or activity in the window.
          if (
            !includeZero
            && section.count === 0
            && section.closingBalance === 0
            && section.openingBalance === 0
          ) {
            continue;
          }

          // Rename the helper's generic entityName/entityListId to the
          // customer-specific keys the tool surface promises.
          const { entityName, entityListId, ...rest } = section;
          sections.push({
            customerName: entityName,
            ...(entityListId ? { customerListId: entityListId } : {}),
            ...rest,
            ...(truncated ? { truncated: true } : {}),
          });
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              fromDate: args.fromDate ?? null,
              toDate: args.toDate ?? null,
              basis: args.basis ?? "Accrual",
              customerCount: sections.length,
              totalRowCount,
              sections,
              ...(warnings.length > 0 ? { warnings } : {}),
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "qb_customer_balance_detail failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // qb_vendor_balance_detail (Phase 11 #51)
  //
  // Mirror of qb_customer_balance_detail on the AP side — walks Bill +
  // BillPaymentCheck + BillPaymentCreditCard per vendor with the same
  // running-balance math. Bill is the outlier on amount extraction because
  // its AmountDue header field is decremented on every bill payment, so a
  // fully-paid bill reports AmountDue=0; extractOriginalTxnAmount walks the
  // line set (ExpenseLineRet + ItemLineRet) for the original face value.
  // -----------------------------------------------------------------------
  server.tool(
    "qb_vendor_balance_detail",
    "Vendor Balance Detail — for every vendor with AP activity in the date window (or the single vendor selected by vendorName / vendorListId), list every Bill / BillPaymentCheck / BillPaymentCreditCard that hit their AP balance, sorted by TxnDate ascending, with per-row RunningBalance plus per-vendor OpeningBalance / ClosingBalance / periodChange. Composite of BillQueryRq + BillPaymentCheckQueryRq + BillPaymentCreditCardQueryRq with optional EntityFilter — three round trips regardless of vendor count. Sign convention: positive Amount = increases AP (Bill posts the original ExpenseLineRet + ItemLineRet sum, because Bill.AmountDue is decremented on every payment and can't be sourced from there); negative = decreases AP (BillPaymentCheck.TotalAmount, BillPaymentCreditCard.TotalAmount). RunningBalance math: openingBalance = Vendor.Balance − periodSum, then walks forward; exact when toDate ≥ now. JournalEntry postings to the AP account are NOT walked (JE lines don't carry vendor ref reliably in sim — visible via qb_transaction_list_by_account on the AP account directly). VendorCredit is also not walked (no VendorCredit tool exists in this server's first cut — credits applied through bill payments still surface via BillPaymentCheck.DiscountAmount on the underlying bill). Empty sections (vendors with no activity in window AND zero closing balance) are pruned by default — set includeZeroBalance:true to keep them.",
    {
      fromDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("Start of the reporting window (YYYY-MM-DD, inclusive). Omit for all-time."),
      toDate: z.string().regex(ISO_DATE_RE).optional()
        .describe("End of the reporting window (YYYY-MM-DD, inclusive). Omit for through-current. RunningBalance math is exact only when toDate ≥ now."),
      vendorName: z.string().optional()
        .describe("Single-vendor scope by FullName. Passes through as EntityFilter.FullName on each underlying query. Takes precedence over vendorListId."),
      vendorListId: z.string().optional()
        .describe("Single-vendor scope by ListID. Alternative to vendorName."),
      basis: z.enum(["Accrual", "Cash"]).optional()
        .describe("Accounting basis. Defaults to Accrual. Currently advisory in simulation; threaded through for parity with other report tools."),
      maxVendors: z.number().int().positive().optional()
        .describe("Cap on the number of vendors to emit sections for. Default 200. Sections are sorted alphabetically before truncation."),
      maxRowsPerVendor: z.number().int().positive().optional()
        .describe("Per-vendor row cap. Default 500. Hitting this cap on any vendor triggers a `truncated` flag on that section."),
      includeZeroBalance: z.boolean().optional()
        .describe("When true, include vendors with no activity in the window AND zero closing balance. Default false."),
    },
    async (args) => {
      const session = getSession();
      const effectiveMaxVendors = args.maxVendors ?? 200;
      const effectiveMaxRows = args.maxRowsPerVendor ?? 500;
      const includeZero = args.includeZeroBalance === true;
      const warnings: string[] = [];

      try {
        const allVendors = await session.queryEntity("Vendor", {});

        let targetVendors = allVendors as EntityBalanceEntity[];
        if (args.vendorListId) {
          targetVendors = targetVendors.filter(
            (v) => String(v.ListID ?? "") === args.vendorListId,
          );
          if (targetVendors.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  statusCode: 500,
                  statusMessage: `Vendor with ListID '${args.vendorListId}' not found`,
                  humanReadable: qbStatusCodeMessage(500),
                }),
              }],
              isError: true,
            };
          }
        } else if (args.vendorName) {
          targetVendors = targetVendors.filter(
            (v) => String(v.FullName ?? v.Name ?? "") === args.vendorName,
          );
          if (targetVendors.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  statusCode: 500,
                  statusMessage: `Vendor with FullName '${args.vendorName}' not found`,
                  humanReadable: qbStatusCodeMessage(500),
                }),
              }],
              isError: true,
            };
          }
        }

        // Same listId → fullName canonicalization as the customer tool: the
        // sim's EntityFilter.ListID path doesn't match against stored
        // VendorRefs whose ListID hasn't been hydrated (CustomerRef and
        // VendorRef are handled by the same handleQuery branch — see the
        // EntityFilter section in simulation-store.ts:236-263).
        const resolvedVendor = targetVendors.length === 1 ? targetVendors[0] : null;
        const entityFilter = resolvedVendor
          ? { FullName: String(resolvedVendor.FullName ?? resolvedVendor.Name ?? "") }
          : args.vendorName
            ? { FullName: args.vendorName }
            : undefined;

        const sharedFilters: Record<string, unknown> = {};
        if (args.fromDate || args.toDate) {
          sharedFilters.TxnDateRangeFilter = {
            FromTxnDate: args.fromDate,
            ToTxnDate: args.toDate,
          };
        }
        if (entityFilter) sharedFilters.EntityFilter = entityFilter;

        // Bill needs IncludeLineItems on the query because
        // extractOriginalTxnAmount walks ExpenseLineRet + ItemLineRet for the
        // original face value (AmountDue is decremented on payment). Lines
        // are stripped from list responses by default since Phase 10 #41.
        const billFilters: Record<string, unknown> = { ...sharedFilters, IncludeLineItems: true };

        const [bills, paymentChecks, paymentCards] = await Promise.all([
          session.queryEntity("Bill", billFilters),
          session.queryEntity("BillPaymentCheck", sharedFilters),
          session.queryEntity("BillPaymentCreditCard", sharedFilters),
        ]);

        const rowsByVendor = new Map<string, EntityBalanceRow[]>();
        const pushRow = (
          vendorName: string,
          row: EntityBalanceRow,
        ): void => {
          let list = rowsByVendor.get(vendorName);
          if (!list) {
            list = [];
            rowsByVendor.set(vendorName, list);
          }
          list.push(row);
        };

        const toRow = (
          txn: Record<string, unknown>,
          txnType: string,
          sign: 1 | -1,
        ): void => {
          const original = extractOriginalTxnAmount(txn, txnType);
          if (!Number.isFinite(original) || original === 0) return;
          const ref = txn.VendorRef as { FullName?: string } | undefined;
          const vendorName = ref?.FullName ? String(ref.FullName) : null;
          if (!vendorName) return;
          const row: EntityBalanceRow = {
            TxnType: txnType,
            TxnID: String(txn.TxnID ?? ""),
            TxnDate: String(txn.TxnDate ?? ""),
            ...(txn.RefNumber !== undefined ? { RefNumber: String(txn.RefNumber) } : {}),
            ...(txn.Memo !== undefined ? { Memo: String(txn.Memo) } : {}),
            Amount: round2(sign * original),
            ...(txn.TimeCreated !== undefined ? { TimeCreated: String(txn.TimeCreated) } : {}),
          };
          pushRow(vendorName, row);
        };

        for (const bill of bills) toRow(bill, "Bill", 1);
        for (const pmt of paymentChecks) toRow(pmt, "BillPaymentCheck", -1);
        for (const pmt of paymentCards) toRow(pmt, "BillPaymentCreditCard", -1);

        for (const list of rowsByVendor.values()) {
          list.sort((a, b) => {
            const ad = String(a.TxnDate ?? "");
            const bd = String(b.TxnDate ?? "");
            if (ad !== bd) return ad < bd ? -1 : 1;
            const at = String(a.TimeCreated ?? "");
            const bt = String(b.TimeCreated ?? "");
            return at < bt ? -1 : at > bt ? 1 : 0;
          });
        }

        const sections: Array<Omit<EntityBalanceSection, "entityName" | "entityListId"> & {
          vendorName: string;
          vendorListId?: string;
          truncated?: boolean;
        }> = [];

        const sortedVendors = [...targetVendors].sort((a, b) => {
          const an = String(a.FullName ?? a.Name ?? "");
          const bn = String(b.FullName ?? b.Name ?? "");
          return an < bn ? -1 : an > bn ? 1 : 0;
        });

        if (sortedVendors.length > effectiveMaxVendors) {
          warnings.push(
            `Vendor fanout (${sortedVendors.length}) exceeds maxVendors (${effectiveMaxVendors}). Truncating alphabetically — re-run with maxVendors: ${sortedVendors.length} or scope by vendorName / vendorListId.`,
          );
        }
        const capped = sortedVendors.slice(0, effectiveMaxVendors);

        let totalRowCount = 0;
        for (const vendor of capped) {
          const vName = String(vendor.FullName ?? vendor.Name ?? "");
          const allRows = rowsByVendor.get(vName) ?? [];
          const truncated = allRows.length > effectiveMaxRows;
          const rows = truncated ? allRows.slice(0, effectiveMaxRows) : allRows;
          const section = buildEntityBalanceSection(vendor, rows);
          totalRowCount += section.count;

          if (
            !includeZero
            && section.count === 0
            && section.closingBalance === 0
            && section.openingBalance === 0
          ) {
            continue;
          }

          const { entityName, entityListId, ...rest } = section;
          sections.push({
            vendorName: entityName,
            ...(entityListId ? { vendorListId: entityListId } : {}),
            ...rest,
            ...(truncated ? { truncated: true } : {}),
          });
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              fromDate: args.fromDate ?? null,
              toDate: args.toDate ?? null,
              basis: args.basis ?? "Accrual",
              vendorCount: sections.length,
              totalRowCount,
              sections,
              ...(warnings.length > 0 ? { warnings } : {}),
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "qb_vendor_balance_detail failed" });
      }
    }
  );

  // -----------------------------------------------------------------------
  // W-2 summary — payroll-subscription-gated (Phase 11 #55)
  // -----------------------------------------------------------------------

  // Wraps PayrollSummaryReportQueryRq with ReportType=EmployeeWagesTaxesAdjustments
  // — the SDK surface that aggregates per-employee YTD payroll totals
  // (gross wages, federal/state withholding, FICA SS + Medicare). Maps the
  // report's per-employee rows onto the W-2 box numbers the operator's
  // tax-prep workflow needs (box 1 = wages tips other comp, box 2 = federal
  // income tax withheld, box 3-6 = SS/Medicare, box 16-17 = state when
  // available).
  //
  // Two pre-flight gates BEFORE the wire call:
  //   1. Edition probe via session.getHostInfo() — Pro builds (without Plus)
  //      don't surface payroll data through the SDK in current QB. Returns
  //      statusCode 9003 with a clear "upgrade to Pro Plus / Premier Plus /
  //      Enterprise" message. Cheaper than a wire round trip that would
  //      either return empty data or a confusing QB-side subscription error.
  //   2. After the wire call: if the response is empty (sim's statusCode 1
  //      "no matching object" path → extractReportData returns {}), the
  //      tool surfaces statusCode 9004 (subscription required or not active).
  //      Distinguishes "no payroll data" from "no employees matched" — when
  //      employeeFullName / employeeListId is supplied and matches no
  //      employee with payroll data, the result still falls into 9004 (the
  //      caller's intent was to get payroll for that person; surfacing
  //      "subscription required" is the right escalation when there's no
  //      data to return).
  //
  // SSN masking: rows surface SSN as "XXX-XX-NNNN" (last 4 only) — matches
  // real QB's printed payroll summary behavior. Sim seeds full SSN; the
  // handler masks before emitting. Live mode trusts QB's emitted format.
  //
  // Tax-year resolution: defaults to the last completed calendar year (e.g.
  // 2026-05-12 today → 2025). Pass explicit `taxYear` to override. The
  // wire-side period is always Jan 1 → Dec 31 of the resolved year (W-2
  // boxes are inherently annual; QB's payroll report supports arbitrary
  // periods but the W-2 use case is always full-year).
  server.tool(
    "qb_w2_summary",
    "Per-employee W-2 summary — wraps PayrollSummaryReportQueryRq (ReportType=EmployeeWagesTaxesAdjustments) and maps the YTD totals onto W-2 box numbers (box 1 wages tips other comp, box 2 federal income tax withheld, box 3 social security wages, box 4 social security tax withheld, box 5 medicare wages, box 6 medicare tax withheld, box 16 state wages, box 17 state income tax — when state data is present). Defaults `taxYear` to the last completed calendar year. Pre-flight edition probe: Pro builds (without Plus) reject with statusCode 9003 (no payroll-subscription-eligible features in stock Pro). Empty-result path returns statusCode 9004 (payroll subscription required or not active) — distinguishes 'subscription off' from 'no employees matched'. SSNs are masked to last 4 digits ('XXX-XX-1234') matching real QB's payroll-summary printout. Scope to one employee via employeeFullName / employeeListId; both unset returns all eligible employees. The wire-side period is always Jan 1 → Dec 31 of the resolved year — the W-2 box model is inherently annual.",
    {
      taxYear: z.number().int().min(2000).max(2100).optional().describe("Calendar year for the W-2 totals. Defaults to the last completed year (current year minus one). The tool always queries the full Jan 1 → Dec 31 period — partial-year W-2 prep is not supported (the W-2 box model is annual)."),
      employeeFullName: z.string().optional().describe("Scope to a single employee by FullName. Takes precedence over employeeListId when both are supplied."),
      employeeListId: z.string().optional().describe("Scope to a single employee by ListID. Alternative to employeeFullName."),
    },
    async (args) => {
      const session = getSession();

      // Pre-flight edition gate. Pro is the only edition that's structurally
      // unable to support payroll in current QB (Pro Plus has it; Premier and
      // Enterprise both do). For Premier / Enterprise / Accountant builds we
      // proceed and let the wire return tell us about subscription state.
      try {
        const hostInfo = await session.getHostInfo();
        if (hostInfo.edition === "Pro") {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                statusCode: 9003,
                statusMessage: `qb_w2_summary requires a payroll-subscription-eligible edition; detected edition: ${hostInfo.edition} (productName: '${hostInfo.productName}')`,
                humanReadable: qbStatusCodeMessage(9003),
                edition: hostInfo.edition,
                productName: hostInfo.productName,
              }),
            }],
            isError: true,
          };
        }
      } catch (err) {
        // HostQueryRq itself failed — surface as a generic error rather than
        // letting the W-2 path proceed against an unknown edition. Could
        // happen on a sim env that hasn't seeded Host (defensive — current
        // sim DOES seed it).
        const e = err as { message?: string; statusCode?: number };
        const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "qb_host_query (edition probe) failed",
              ...(humanReadable ? { humanReadable } : {}),
            }),
          }],
          isError: true,
        };
      }

      // Resolve tax year — explicit arg wins, default to last completed.
      const today = new Date();
      const resolvedYear = args.taxYear ?? today.getUTCFullYear() - 1;
      const fromDate = `${resolvedYear}-01-01`;
      const toDate = `${resolvedYear}-12-31`;

      const entityFilter = args.employeeFullName
        ? { FullName: args.employeeFullName }
        : args.employeeListId
          ? { ListID: args.employeeListId }
          : undefined;

      try {
        const ret = await session.runPayrollSummaryReport({
          reportType: "EmployeeWagesTaxesAdjustments",
          fromDate,
          toDate,
          ...(entityFilter ? { entityFilter } : {}),
        });

        const rows = (ret.EmployeeWagesTaxesRet as Array<Record<string, unknown>> | undefined) ?? [];
        if (rows.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                statusCode: 9004,
                statusMessage: `PayrollSummaryReportQueryRq returned no data for ${resolvedYear}${entityFilter ? ` (employee scope: ${args.employeeFullName ?? args.employeeListId})` : ""}`,
                humanReadable: qbStatusCodeMessage(9004),
                taxYear: resolvedYear,
                fromDate,
                toDate,
              }),
            }],
            isError: true,
          };
        }

        // Map per-employee rows onto W-2 boxes. Box numbers per IRS Form W-2:
        //   1: Wages, tips, other compensation (= GrossWages, simplified)
        //   2: Federal income tax withheld
        //   3: Social Security wages
        //   4: Social Security tax withheld
        //   5: Medicare wages and tips
        //   6: Medicare tax withheld
        //   16: State wages, tips, etc.
        //   17: State income tax
        // Boxes 7 (SS tips), 8 (allocated tips), 10 (dependent care), 11
        // (nonqualified plans), 12 (codes A-W), 14 (other), 18-20 (local) are
        // not surfaced in this first cut — operators with those needs should
        // run real QB's W-2 wizard (which reads the same paycheck history but
        // honors per-payroll-item box mapping that the SDK doesn't expose).
        const employees = rows.map((r) => {
          const ref = (r.EmployeeRef as Record<string, unknown> | undefined) ?? {};
          const out: Record<string, unknown> = {
            employeeListId: String(ref.ListID ?? ""),
            employeeFullName: String(ref.FullName ?? ""),
            ssn: String(r.SSN ?? ""),
            box1_wagesTipsOtherComp: Number(r.GrossWages ?? 0),
            box2_federalIncomeTaxWithheld: Number(r.FederalIncomeTaxWithheld ?? 0),
            box3_socialSecurityWages: Number(r.SocialSecurityWages ?? 0),
            box4_socialSecurityTaxWithheld: Number(r.SocialSecurityTaxWithheld ?? 0),
            box5_medicareWages: Number(r.MedicareWages ?? 0),
            box6_medicareTaxWithheld: Number(r.MedicareTaxWithheld ?? 0),
          };
          if (r.StateAbbreviation !== undefined) out.stateAbbreviation = String(r.StateAbbreviation);
          if (r.StateWages !== undefined) out.box16_stateWages = Number(r.StateWages);
          if (r.StateIncomeTaxWithheld !== undefined) out.box17_stateIncomeTax = Number(r.StateIncomeTaxWithheld);
          return out;
        });

        const totals = ret.Totals as Record<string, unknown> | undefined;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              taxYear: resolvedYear,
              fromDate,
              toDate,
              count: employees.length,
              employees,
              totals: totals ?? null,
              note: "Boxes 7-15 / 18-20 are not surfaced in this first cut. For per-payroll-item box mapping (box 12 codes, box 14 other, local taxes), run QB Desktop's W-2 wizard.",
            }, null, 2),
          }],
        };
      } catch (err) {
        return formatToolError(err, { fallbackMessage: "PayrollSummaryReportQueryRq failed" });
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

  // -----------------------------------------------------------------------
  // qb_session_status — health/probe snapshot (Phase 14 #67)
  // -----------------------------------------------------------------------
  //
  // Composite "tell me everything about the current session" tool. Designed
  // for orchestration callers (e.g. an agent retrying a brittle workflow)
  // that need a cheap, structured view of session state without performing
  // a real entity query.
  //
  // Default behavior: ZERO wire I/O. Returns the connection state, config
  // identity, read-only gate, cached HostInfo (null if uncached), and the
  // rolling transient-retry observability counters. The whole call costs a
  // few field reads and one Date.now() in the prune.
  //
  // Opt-in `probe: true`: runs a fresh HostQueryRq via getHostInfo({ refresh:
  // true }). HostQueryRq is the lightest available real-wire call (no entity
  // body, no filters, returns installation metadata). On success the snapshot
  // carries `probe: { ok: true }`; on failure `probe: { ok: false,
  // statusCode, statusMessage, humanReadable? }`. The snapshot itself does
  // NOT fail when the probe fails — that's the whole point of having a
  // probe: an orchestrator wants to know "is the wire usable" without
  // failing the diagnostic call.
  //
  // Opt-in `includeClosingDate: true`: runs PreferencesQueryRq (one round
  // trip — heavier than HostQueryRq but still trivial) and folds the closing
  // date + adjacent accounting flags into the snapshot under `closingDate`.
  // Useful for one-shot "tell me whether the prior period is locked" probes
  // that would otherwise require a separate qb_closing_date_get call.
  // Same fail-soft contract as `probe`: a Preferences-query failure surfaces
  // as `closingDate: { error: {...} }` without making the overall response
  // isError.
  //
  // Read-only safe; no read-only gate. The snapshot is always allowed.
  server.tool(
    "qb_session_status",
    "Diagnostic snapshot of the current QuickBooks session — connection state, configured app identity, read-only gate, cached HostInfo (without triggering a fetch), and rolling transient-retry observability (lastTransientRetryAt / transientRetryCountLastHour / totalTransientRetries). No wire I/O by default. Pass `probe: true` to verify the live wire is responsive via a fresh HostQueryRq round trip; the probe result lands under `probe: { ok: true }` or `probe: { ok: false, statusCode, statusMessage }` — the snapshot itself does NOT fail when the probe fails, so orchestration callers can rely on this tool to ALWAYS return a structured shape. Pass `includeClosingDate: true` to fold in PreferencesQueryRq (closing date + audit-trail flags) under `closingDate` — heavier than the probe but still one round trip; same fail-soft contract.",
    {
      probe: z.boolean().optional().describe("When true, fire one HostQueryRq with refresh: true to actively verify the live wire is responsive. The probe result lands under `probe`; success returns `{ ok: true }`, failure returns `{ ok: false, statusCode, statusMessage, humanReadable? }`. The probe is fail-soft — a probe error never makes the overall tool response isError. In simulation mode the probe always succeeds (the sim handler returns the seeded Host singleton). Default false — most status calls don't need the wire probe."),
      includeClosingDate: z.boolean().optional().describe("When true, also fetch the company file's closing date and adjacent accounting preferences via PreferencesQueryRq, folded into the response as `closingDate`. Equivalent to making a separate qb_closing_date_get call in the same conversation. Fail-soft like `probe` — a Preferences-query failure surfaces as `closingDate: { error: {...} }`. Default false — call qb_closing_date_get directly when you specifically want the closing date and nothing else."),
    },
    async ({ probe, includeClosingDate }) => {
      const session = getSession();
      const sessionData = session.getSession();

      let probeResult:
        | { ok: true }
        | { ok: false; statusCode: number; statusMessage: string; humanReadable?: string }
        | undefined;
      if (probe === true) {
        try {
          // refresh: true forces a real wire call even when the cache is
          // populated — which is the whole point of an explicit probe. Sim
          // mode returns instantly from the seeded Host singleton.
          await session.getHostInfo({ refresh: true });
          probeResult = { ok: true };
        } catch (err) {
          const e = err as { message?: string; statusCode?: number };
          const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
          probeResult = {
            ok: false,
            statusCode: e.statusCode ?? -1,
            statusMessage: e.message ?? "HostQueryRq probe failed",
            ...(humanReadable ? { humanReadable } : {}),
          };
        }
      }

      let closingDateBlock:
        | {
            closingDate: string | null;
            isUsingAuditTrail: boolean;
            isUsingClassTracking: boolean;
            isUsingAccountNumbers: boolean;
            isRequiringAccounts: boolean;
          }
        | { error: { statusCode: number; statusMessage: string; humanReadable?: string } }
        | undefined;
      if (includeClosingDate === true) {
        try {
          const records = await session.queryEntity("Preferences", {});
          const prefs = (records[0] ?? {}) as Record<string, unknown>;
          const acctRaw = (prefs.AccountingPreferences ?? {}) as Record<string, unknown>;
          const flag = (v: unknown): boolean =>
            v === true || String(v ?? "").toLowerCase() === "true";
          closingDateBlock = {
            closingDate: normalizeClosingDate(acctRaw.ClosingDate),
            isUsingAuditTrail: flag(acctRaw.IsUsingAuditTrail),
            isUsingClassTracking: flag(acctRaw.IsUsingClassTracking),
            isUsingAccountNumbers: flag(acctRaw.IsUsingAccountNumbers),
            isRequiringAccounts: flag(acctRaw.IsRequiringAccounts),
          };
        } catch (err) {
          const e = err as { message?: string; statusCode?: number };
          const humanReadable = qbStatusCodeMessage(e.statusCode ?? -1);
          closingDateBlock = {
            error: {
              statusCode: e.statusCode ?? -1,
              statusMessage: e.message ?? "PreferencesQueryRq failed",
              ...(humanReadable ? { humanReadable } : {}),
            },
          };
        }
      }

      // Peek the host-info cache AFTER the opt-in calls so the snapshot
      // reflects any populating side effect a `probe: true` had. Without
      // probe this is the same value peekHostInfoCache would have returned
      // at function entry. peekHostInfoCache never triggers a fetch, so the
      // "no wire I/O on the default path" contract still holds.
      const hostInfo = session.peekHostInfoCache();
      // Retry stats are read last so they include any retry that fired
      // during the opt-in calls. (Sim mode never retries; live mode may, in
      // which case the snapshot reflects the most-current state.)
      const retryStats = session.getTransientRetryStats();

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            connected: session.isConnected(),
            mode: session.isSimulation() ? "simulation" : "live",
            companyFile: sessionData?.companyFile ?? session.getCompanyFile() ?? null,
            appName: session.getAppName(),
            appId: session.getAppId() ?? null,
            qbxmlVersion: session.getQbxmlVersion() ?? null,
            readOnly: session.isReadOnly(),
            ticket: sessionData?.ticket ?? null,
            openedAt: sessionData?.openedAt?.toISOString() ?? null,
            serverVersion: SERVER_VERSION,
            hostInfo,
            retryStats,
            ...(probeResult !== undefined ? { probe: probeResult } : {}),
            ...(closingDateBlock !== undefined ? { closingDate: closingDateBlock } : {}),
          }, null, 2),
        }],
      };
    }
  );
}

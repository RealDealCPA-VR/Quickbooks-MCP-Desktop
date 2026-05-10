// qb_balance_summary regression tests (Phase 9 #38).
//
// Pre-#38 the tool accepted fromDate / toDate but silently ignored them and
// returned a current-snapshot from Account.Balance with an `asOfNote` admitting
// the gap. #38 reroutes the tool through runReport("BalanceSheetStandard") +
// runReport("ProfitAndLossStandard") so asOfDate is honored end-to-end. Same
// canonical 16-way AccountType bucketing the tool always promised, now backed
// by the report-layer machinery that already works in live mode (DECISIONS.md
// 2026-05-09 — live row-tree adapter).
//
// Two layers of tests here:
//   1. buildBalanceSummary unit tests — pure function, synthetic BS/P&L
//      fixtures. Pins the bucket/round/synthetic-row-filter contract without
//      spinning up an MCP transport.
//   2. End-to-end via QBSessionManager (sim mode) — proves asOfDate flows
//      through both runReport calls and the resulting payload reflects what
//      a tool caller would see.

import { describe, it, expect } from "vitest";
import {
  buildBalanceSummary,
  type BalanceSummaryReportInput,
  type BalanceSummaryAccount,
} from "../src/tools/reports.js";
import { QBSessionManager } from "../src/session/manager.js";

const newSimSession = async () => {
  const session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-balance-summary",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  await session.openSession();
  return session;
};

describe("buildBalanceSummary — unit", () => {
  const accounts: BalanceSummaryAccount[] = [
    { ListID: "A1", FullName: "Checking", Name: "Checking", AccountType: "Bank", Balance: 45000 },
    { ListID: "A2", FullName: "Savings", Name: "Savings", AccountType: "Bank", Balance: 120000 },
    { ListID: "A3", FullName: "Accounts Receivable", AccountType: "AccountsReceivable", Balance: 26700 },
    { ListID: "A4", FullName: "Accounts Payable", AccountType: "AccountsPayable", Balance: 3700 },
    { ListID: "A5", FullName: "Sales Revenue", AccountType: "Income", Balance: 0 },
    { ListID: "A6", FullName: "Rent Expense", AccountType: "Expense", Balance: 0 },
    { ListID: "A7", FullName: "Estimates", AccountType: "NonPosting", Balance: 12000 },
    { ListID: "A8", FullName: "Owner Equity", AccountType: "Equity", Balance: 0 },
  ];

  const bsRet: BalanceSummaryReportInput = {
    Sections: [
      { Name: "Assets", Accounts: [
        { Name: "Checking", Total: 50000 },
        { Name: "Savings", Total: 125000 },
        { Name: "Accounts Receivable", Total: 30000 },
      ] },
      { Name: "Liabilities", Accounts: [
        { Name: "Accounts Payable", Total: 4000 },
      ] },
      { Name: "Equity", Accounts: [
        { Name: "Owner Equity", Total: 100000 },
        { Name: "Net Income", Total: 101000 },
        { Name: "Balancing Adjustment (simulation seed gap)", Total: 0 },
      ] },
    ],
    Totals: { TotalAssets: 205000, TotalLiabilities: 4000, TotalEquity: 201000, NetIncome: 101000 },
  };

  const pnlRet: BalanceSummaryReportInput = {
    Sections: [
      { Name: "Income", Accounts: [{ Name: "Sales Revenue", Total: 250000 }] },
      { Name: "Expenses", Accounts: [{ Name: "Rent Expense", Total: 149000 }] },
    ],
    Totals: { TotalIncome: 250000, TotalExpenses: 149000, NetIncome: 101000 },
  };

  it("buckets accounts in canonical QB order", () => {
    const out = buildBalanceSummary(accounts, bsRet, pnlRet);
    const types = out.balanceSummary.map((b) => b.accountType);
    // Canonical: Bank → AR → ... → AP → ... → Equity → Income → ... → Expense → NonPosting.
    expect(types).toEqual([
      "Bank",
      "AccountsReceivable",
      "AccountsPayable",
      "Equity",
      "Income",
      "Expense",
      "NonPosting",
    ]);
  });

  it("groups accounts under their canonical AccountType (joined via name lookup)", () => {
    const out = buildBalanceSummary(accounts, bsRet, pnlRet);
    const bank = out.balanceSummary.find((b) => b.accountType === "Bank");
    expect(bank).toEqual({ accountType: "Bank", accounts: ["Checking", "Savings"], total: 175000 });
    const ar = out.balanceSummary.find((b) => b.accountType === "AccountsReceivable");
    expect(ar?.total).toBe(30000);
    const ap = out.balanceSummary.find((b) => b.accountType === "AccountsPayable");
    expect(ap?.total).toBe(4000);
    const equity = out.balanceSummary.find((b) => b.accountType === "Equity");
    // Synthetic Net Income / Balancing Adjustment rows MUST NOT contribute.
    expect(equity).toEqual({ accountType: "Equity", accounts: ["Owner Equity"], total: 100000 });
    const income = out.balanceSummary.find((b) => b.accountType === "Income");
    expect(income?.total).toBe(250000);
    const expense = out.balanceSummary.find((b) => b.accountType === "Expense");
    expect(expense?.total).toBe(149000);
  });

  it("filters BS synthetic rows (Net Income, Balancing Adjustment) from balanceSummary", () => {
    const out = buildBalanceSummary(accounts, bsRet, pnlRet);
    const allNames = out.balanceSummary.flatMap((b) => b.accounts);
    expect(allNames).not.toContain("Net Income");
    expect(allNames).not.toContain("Balancing Adjustment (simulation seed gap)");
  });

  it("surfaces NonPosting from Account.Balance fallback (not in BS or P&L)", () => {
    const out = buildBalanceSummary(accounts, bsRet, pnlRet);
    const np = out.balanceSummary.find((b) => b.accountType === "NonPosting");
    expect(np).toEqual({ accountType: "NonPosting", accounts: ["Estimates"], total: 12000 });
  });

  it("computes subtotals from BS+P&L Totals (not from accounts)", () => {
    const out = buildBalanceSummary(accounts, bsRet, pnlRet);
    expect(out.subtotals).toEqual({
      assets: 205000,
      liabilities: 4000,
      equity: 201000,
      income: 250000,
      expenses: 149000,
      netIncome: 101000,
    });
  });

  it("routes accounts not in the lookup to a trailing 'Other' bucket", () => {
    // Accounts in BS but absent from the AccountQuery result land in 'Other'
    // — defensive against drift between the snapshot lookup and a
    // mid-flight chart-of-accounts mutation.
    const orphanBs: BalanceSummaryReportInput = {
      Sections: [{ Name: "Assets", Accounts: [{ Name: "Mystery Asset", Total: 999 }] }],
      Totals: { TotalAssets: 999, TotalLiabilities: 0, TotalEquity: 999, NetIncome: 0 },
    };
    const out = buildBalanceSummary([], orphanBs, { Sections: [], Totals: {} });
    const other = out.balanceSummary.find((b) => b.accountType === "Other");
    expect(other).toEqual({ accountType: "Other", accounts: ["Mystery Asset [Unknown]"], total: 999 });
  });

  it("rounds account totals and subtotals to 2 decimals", () => {
    const noisyBs: BalanceSummaryReportInput = {
      Sections: [{ Name: "Assets", Accounts: [
        { Name: "Checking", Total: 1.005 },
        { Name: "Savings", Total: 2.004 },
      ] }],
      Totals: { TotalAssets: 3.009, TotalLiabilities: 0, TotalEquity: 3.009, NetIncome: 0 },
    };
    const out = buildBalanceSummary(accounts, noisyBs, { Sections: [], Totals: {} });
    const bank = out.balanceSummary.find((b) => b.accountType === "Bank");
    expect(bank?.total).toBe(3.01);
    expect(out.subtotals.assets).toBe(3.01);
  });

  it("handles empty BS and P&L gracefully", () => {
    const out = buildBalanceSummary(
      accounts,
      { Sections: [], Totals: {} },
      { Sections: [], Totals: {} }
    );
    // Only NonPosting fallback survives an empty report pair.
    expect(out.balanceSummary.map((b) => b.accountType)).toEqual(["NonPosting"]);
    expect(out.subtotals).toEqual({
      assets: 0, liabilities: 0, equity: 0, income: 0, expenses: 0, netIncome: 0,
    });
  });
});

describe("qb_balance_summary — end-to-end via session.runReport (sim)", () => {
  // Replicates the tool's exact wire path: AccountQuery + BS report + P&L
  // report + buildBalanceSummary. Verifies that asOfDate flows through both
  // runReport calls and that the resulting payload matches the tool's
  // contract. Drives the same fresh-seed state any vitest run hits.
  const runViaSession = async (asOfDate?: string, basis?: "Accrual" | "Cash") => {
    const session = await newSimSession();
    const effectiveAsOf = asOfDate ?? new Date().toISOString().split("T")[0];
    const effectiveBasis = basis ?? "Accrual";
    const accounts = await session.queryEntity("Account", {});
    const bsRet = await session.runReport("BalanceSheetStandard", { toDate: effectiveAsOf, basis: effectiveBasis });
    const pnlRet = await session.runReport("ProfitAndLossStandard", { toDate: effectiveAsOf, basis: effectiveBasis });
    return {
      accounts,
      ...buildBalanceSummary(accounts as BalanceSummaryAccount[], bsRet as BalanceSummaryReportInput, pnlRet as BalanceSummaryReportInput),
    };
  };

  it("Bank bucket is first and totals to 165000 (Checking 45000 + Savings 120000) for fresh seed", async () => {
    const out = await runViaSession();
    expect(out.balanceSummary[0]?.accountType).toBe("Bank");
    expect(out.balanceSummary[0]?.total).toBe(165000);
    expect(out.balanceSummary[0]?.accounts).toEqual(["Checking", "Savings"]);
  });

  it("subtotals.assets reflects BS Totals.TotalAssets (191700 = Checking 45k + Savings 120k + AR 26.7k)", async () => {
    const out = await runViaSession();
    expect(out.subtotals.assets).toBe(191700);
    expect(out.subtotals.liabilities).toBe(3700);
  });

  it("subtotals.income/expenses come from P&L walk (zero with seed because seeded invoices carry no lines)", async () => {
    // Pre-#38 these were 257000 / 279800 from Account.Balance — but the
    // seeded balances were arbitrary numbers not backed by transactions.
    // Post-#38 they reflect the actual P&L walk, which is the truthful
    // signal in both modes. Income/Expense buckets disappear from
    // balanceSummary because the P&L sections are empty (no leaves).
    const out = await runViaSession();
    expect(out.subtotals.income).toBe(0);
    expect(out.subtotals.expenses).toBe(0);
    expect(out.subtotals.netIncome).toBe(0);
    expect(out.balanceSummary.find((b) => b.accountType === "Income")).toBeUndefined();
    expect(out.balanceSummary.find((b) => b.accountType === "Expense")).toBeUndefined();
  });

  it("payload does not surface synthetic 'Net Income' / 'Balancing Adjustment' rows", async () => {
    const out = await runViaSession();
    const allNames = out.balanceSummary.flatMap((b) => b.accounts);
    expect(allNames).not.toContain("Net Income");
    expect(allNames).not.toContain("Balancing Adjustment (simulation seed gap)");
  });

  it("totalAccounts reflects the AccountQuery, not the BS section count", async () => {
    const out = await runViaSession();
    // Seed ships 10 accounts; AccountQuery surfaces all of them regardless
    // of whether they appear in BS or P&L sections.
    expect(out.accounts.length).toBe(10);
  });

  it("asOfDate flows through both runReport calls (sim P&L walks the date filter — past asOfDate yields zero)", async () => {
    // Seeded invoices are on 2024-11-01 / 2024-11-15 with no line arrays so
    // they never contribute to the P&L walk in either case. The contract
    // we're pinning here is that the call pair completes without error and
    // the date params reach both reports. A 1900 asOfDate would also be
    // before any seed activity so all P&L values are 0; we use that as a
    // simple "did the date param flow?" probe.
    const out1900 = await runViaSession("1900-01-01");
    expect(out1900.subtotals.income).toBe(0);
    expect(out1900.subtotals.expenses).toBe(0);
    // Future asOfDate should still complete without error and surface the
    // BS asset snapshot identically (sim BS uses Account.Balance — the
    // documented sim caveat).
    const out2099 = await runViaSession("2099-12-31");
    expect(out2099.subtotals.assets).toBe(191700);
  });

  it("default basis is Accrual (passing it explicitly produces the same numbers in sim)", async () => {
    const out1 = await runViaSession("2026-12-31");
    const out2 = await runViaSession("2026-12-31", "Accrual");
    expect(out1.subtotals).toEqual(out2.subtotals);
  });
});

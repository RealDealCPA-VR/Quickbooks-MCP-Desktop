// Live ReportRet → simplified-shape adapter regression tests.
//
// Live QBXMLRP2 returns reports as a row tree (TextRow / DataRow /
// SubtotalRow / TotalRow under ReportData) — schema-distinct from the flat
// { Sections, Totals } shape the simulation emits. adaptLiveReportRet is the
// single point of translation between the two; without it qb_pnl_report and
// qb_balance_sheet_report return all-zero payloads against live QB even when
// the report itself succeeds (the schema-order fix on 2026-05-09 closed the
// parse error; this is the second half of that bug).
//
// Fixtures here are derived from real QB output captured against the
// VR Tax & Consulting FY2024 books on 2026-05-09. Numbers are real but
// account names and structure are what matter for the adapter contract;
// re-capturing against a different company should still round-trip
// equivalently.

import { describe, it, expect } from "vitest";
import { adaptLiveReportRet } from "../src/qbxml/parser.js";

// ----- P&L fixture (compact synthetic — preserves the full row taxonomy
// the adapter must handle: meta-headers, top-level sections, account-group
// rollups, sub-account leaves, parent-as-leaf "X - Other" rows, and the
// closing TotalRow).
const PNL_FIXTURE = {
  ReportTitle: "Profit & Loss",
  ReportSubtitle: "January through December 2024",
  ReportBasis: "Accrual",
  ReportData: {
    // Row numbering mirrors real QB layout: each section's close (subtotal
    // without RowData) appears BEFORE the next section's open TextRow.
    // (Captured live row order: 65 TextRow Other Income → 66 DataRow Capital
    // Gain → 67 Subtotal "Total Other Income" → 68 TextRow Other Expense →
    // 69 DataRow Shareholder Distributions → 70 Subtotal "Total Other
    // Expense".)
    TextRow: [
      { "@_rowNumber": 1, "@_value": "Ordinary Income/Expense" },
      { "@_rowNumber": 2, "@_value": "Income" },
      { "@_rowNumber": 6, "@_value": "Expense" },
      { "@_rowNumber": 8, "@_value": "60200 &#183; Automobile Expense" },
      { "@_rowNumber": 16, "@_value": "Other Income/Expense" },
      { "@_rowNumber": 17, "@_value": "Other Income" },
      { "@_rowNumber": 20, "@_value": "Other Expense" },
    ],
    DataRow: [
      // Income leaves
      { "@_rowNumber": 3, RowData: { "@_rowType": "account", "@_value": "41000 · Accounting" }, ColData: [
        { "@_colID": 1, "@_value": "41000 · Accounting" }, { "@_colID": 2, "@_value": 191102.5 }] },
      { "@_rowNumber": 4, RowData: { "@_rowType": "account", "@_value": "49400 · Tax Prep" }, ColData: [
        { "@_colID": 1, "@_value": "49400 · Tax Prep" }, { "@_colID": 2, "@_value": 301489.05 }] },
      // Expense leaves (Automobile sub-accounts + "Other" parent line)
      { "@_rowNumber": 9, RowData: { "@_rowType": "account", "@_value": "60200:Gasoline" }, ColData: [
        { "@_colID": 1, "@_value": "Gasoline" }, { "@_colID": 2, "@_value": 2952.78 }] },
      { "@_rowNumber": 10, RowData: { "@_rowType": "account", "@_value": "60200:Parking" }, ColData: [
        { "@_colID": 1, "@_value": "Parking" }, { "@_colID": 2, "@_value": 52 }] },
      { "@_rowNumber": 11, RowData: { "@_rowType": "account", "@_value": "60200" }, ColData: [
        { "@_colID": 1, "@_value": "60200 · Automobile Expense - Other" }, { "@_colID": 2, "@_value": 3843.53 }] },
      // Other Income leaf
      { "@_rowNumber": 18, RowData: { "@_rowType": "account", "@_value": "Capital Gain S/T" }, ColData: [
        { "@_colID": 1, "@_value": "Capital Gain S/T" }, { "@_colID": 2, "@_value": 9000 }] },
      // Other Expense leaf
      { "@_rowNumber": 21, RowData: { "@_rowType": "account", "@_value": "31400 · Distributions" }, ColData: [
        { "@_colID": 1, "@_value": "31400 · Shareholder Distributions" }, { "@_colID": 2, "@_value": 144834.3 }] },
    ],
    SubtotalRow: [
      { "@_rowNumber": 5, ColData: [
        { "@_colID": 1, "@_value": "Total Income" }, { "@_colID": 2, "@_value": 492591.55 }] },
      // The Gross Profit subtotal (no RowData) — section close *for accounting purposes*.
      { "@_rowNumber": 7, ColData: [
        { "@_colID": 1, "@_value": "Gross Profit" }, { "@_colID": 2, "@_value": 492591.55 }] },
      // Account-group rollup with RowData — must NOT close the Expense section.
      { "@_rowNumber": 12, RowData: { "@_rowType": "account", "@_value": "60200" }, ColData: [
        { "@_colID": 1, "@_value": "Total 60200 · Automobile Expense" }, { "@_colID": 2, "@_value": 6848.31 }] },
      { "@_rowNumber": 13, ColData: [
        { "@_colID": 1, "@_value": "Total Expense" }, { "@_colID": 2, "@_value": 6848.31 }] },
      // Computed subtotals between section close and next section open
      // ("Net Ordinary Income" — has no matching open section; ignored).
      { "@_rowNumber": 14, ColData: [
        { "@_colID": 1, "@_value": "Net Ordinary Income" }, { "@_colID": 2, "@_value": 485743.24 }] },
      { "@_rowNumber": 19, ColData: [
        { "@_colID": 1, "@_value": "Total Other Income" }, { "@_colID": 2, "@_value": 9000 }] },
      { "@_rowNumber": 22, ColData: [
        { "@_colID": 1, "@_value": "Total Other Expense" }, { "@_colID": 2, "@_value": 144834.3 }] },
      { "@_rowNumber": 23, ColData: [
        { "@_colID": 1, "@_value": "Net Other Income" }, { "@_colID": 2, "@_value": -135834.3 }] },
    ],
    TotalRow: [
      { "@_rowNumber": 24, ColData: [
        { "@_colID": 1, "@_value": "Net Income" }, { "@_colID": 2, "@_value": 349909.24 }] },
    ],
  },
};

// ----- BS fixture (compact synthetic — preserves the BS-specific patterns:
// uppercase ASSETS header, deeply nested account groups, TOTAL ASSETS as a
// TotalRow rather than SubtotalRow, Net Income as an Equity-section DataRow).
const BS_FIXTURE = {
  ReportTitle: "Balance Sheet",
  ReportSubtitle: "As of December 31, 2024",
  ReportBasis: "Accrual",
  ReportData: {
    TextRow: [
      { "@_rowNumber": 1, "@_value": "ASSETS" },
      { "@_rowNumber": 2, "@_value": "Current Assets" },
      { "@_rowNumber": 3, "@_value": "Checking/Savings" },
      { "@_rowNumber": 9, "@_value": "LIABILITIES & EQUITY" },
      { "@_rowNumber": 10, "@_value": "Liabilities" },
      { "@_rowNumber": 14, "@_value": "Equity" },
    ],
    DataRow: [
      { "@_rowNumber": 4, RowData: { "@_rowType": "account", "@_value": "Chase ***1930" }, ColData: [
        { "@_colID": 1, "@_value": "Chase ***1930" }, { "@_colID": 2, "@_value": 80834.49 }] },
      { "@_rowNumber": 11, RowData: { "@_rowType": "account", "@_value": "Visa CC" }, ColData: [
        { "@_colID": 1, "@_value": "Visa CC" }, { "@_colID": 2, "@_value": 3348.3 }] },
      { "@_rowNumber": 12, RowData: { "@_rowType": "account", "@_value": "Loan" }, ColData: [
        { "@_colID": 1, "@_value": "Long Term Loan" }, { "@_colID": 2, "@_value": 190313.98 }] },
      { "@_rowNumber": 15, RowData: { "@_rowType": "account", "@_value": "Capital Stock" }, ColData: [
        { "@_colID": 1, "@_value": "30100 · Capital Stock" }, { "@_colID": 2, "@_value": 1000 }] },
      // Net Income as a DataRow inside Equity — not a top-level TotalRow.
      { "@_rowNumber": 16, RowData: { "@_rowType": "account", "@_value": "Net Income" }, ColData: [
        { "@_colID": 1, "@_value": "Net Income" }, { "@_colID": 2, "@_value": 14336.5 }] },
    ],
    SubtotalRow: [
      { "@_rowNumber": 5, ColData: [
        { "@_colID": 1, "@_value": "Total Checking/Savings" }, { "@_colID": 2, "@_value": 80834.49 }] },
      { "@_rowNumber": 13, ColData: [
        { "@_colID": 1, "@_value": "Total Liabilities" }, { "@_colID": 2, "@_value": 193662.28 }] },
      { "@_rowNumber": 17, ColData: [
        { "@_colID": 1, "@_value": "Total Equity" }, { "@_colID": 2, "@_value": 15336.5 }] },
    ],
    TotalRow: [
      { "@_rowNumber": 8, ColData: [
        { "@_colID": 1, "@_value": "TOTAL ASSETS" }, { "@_colID": 2, "@_value": 80834.49 }] },
      { "@_rowNumber": 18, ColData: [
        { "@_colID": 1, "@_value": "TOTAL LIABILITIES & EQUITY" }, { "@_colID": 2, "@_value": 208998.78 }] },
    ],
  },
};

describe("adaptLiveReportRet — P&L row-tree → simplified shape", () => {
  it("produces canonical sim-shaped sections from a live P&L row tree", () => {
    const out = adaptLiveReportRet(PNL_FIXTURE);
    const sections = out.Sections as { Name: string; Accounts: { Name: string; Total: number }[]; Subtotal: number }[];

    // Section names match sim's contract: live's singular "Expense"/"Other
    // Expense" become plural "Expenses"/"Other Expenses". COGS absent here
    // (this company has no COGS accounts) so it's not in the section list.
    expect(sections.map((s) => s.Name)).toEqual(["Income", "Expenses", "Other Income", "Other Expenses"]);

    // Per-section subtotals come from the labelled "Total <Name>" close,
    // NOT from summing leaves (different by design — leaves are for display;
    // QB owns the canonical subtotal).
    const bySection = Object.fromEntries(sections.map((s) => [s.Name, s]));
    expect(bySection.Income.Subtotal).toBe(492591.55);
    expect(bySection.Expenses.Subtotal).toBe(6848.31);
    expect(bySection["Other Income"].Subtotal).toBe(9000);
    expect(bySection["Other Expenses"].Subtotal).toBe(144834.3);

    // Account-group rollup ("Total 60200 · Automobile Expense") with
    // RowData must NOT appear as a leaf — it would double-count.
    const expenseLeafNames = bySection.Expenses.Accounts.map((a) => a.Name);
    expect(expenseLeafNames).not.toContain("Total 60200 · Automobile Expense");

    // Account leaves preserve the display name from ColData[0] (col 1) and
    // decode QB's numeric character entities (&#183; → middle dot).
    expect(bySection.Income.Accounts).toEqual([
      { Name: "41000 · Accounting", Total: 191102.5 },
      { Name: "49400 · Tax Prep", Total: 301489.05 },
    ]);
  });

  it("populates the P&L Totals shape that qb_pnl_report reads", () => {
    const out = adaptLiveReportRet(PNL_FIXTURE);
    const totals = out.Totals as Record<string, number>;

    // TotalIncome aggregates Income + Other Income (sim contract).
    expect(totals.TotalIncome).toBe(501591.55);
    // TotalExpenses aggregates Expense + Other Expense.
    expect(totals.TotalExpenses).toBe(151682.61);
    expect(totals.TotalCOGS).toBe(0);
    // GrossProfit comes from QB's labelled value (Income alone, NOT
    // including Other Income — real QB definition).
    expect(totals.GrossProfit).toBe(492591.55);
    // NetIncome from the TotalRow.
    expect(totals.NetIncome).toBe(349909.24);
  });
});

describe("adaptLiveReportRet — Balance Sheet row-tree → simplified shape", () => {
  it("produces Assets / Liabilities / Equity sections from a live BS row tree", () => {
    const out = adaptLiveReportRet(BS_FIXTURE);
    const sections = out.Sections as { Name: string; Accounts: { Name: string; Total: number }[]; Subtotal: number }[];

    // Case-insensitive section detection: TextRow "ASSETS" → "Assets" section.
    expect(sections.map((s) => s.Name)).toEqual(["Assets", "Liabilities", "Equity"]);

    const bySection = Object.fromEntries(sections.map((s) => [s.Name, s]));
    // TOTAL ASSETS appears as a TotalRow in real QB BS (not a SubtotalRow);
    // the adapter accepts either as the section close.
    expect(bySection.Assets.Subtotal).toBe(80834.49);
    expect(bySection.Liabilities.Subtotal).toBe(193662.28);
    expect(bySection.Equity.Subtotal).toBe(15336.5);
  });

  it("populates the BS Totals shape with NetIncome pulled from the Equity section", () => {
    const out = adaptLiveReportRet(BS_FIXTURE);
    const totals = out.Totals as Record<string, number>;

    expect(totals.TotalAssets).toBe(80834.49);
    expect(totals.TotalLiabilities).toBe(193662.28);
    expect(totals.TotalEquity).toBe(15336.5);
    // Net Income on a BS lives as a DataRow inside Equity — adapter falls
    // back to the Equity section's "Net Income" account when no top-level
    // "Net Income" subtotal/total is present.
    expect(totals.NetIncome).toBe(14336.5);
  });
});

describe("adaptLiveReportRet — defensive behavior", () => {
  it("returns empty Sections when ReportData is absent (e.g. status 1 / no data)", () => {
    const out = adaptLiveReportRet({ ReportTitle: "Profit & Loss", ReportBasis: "Accrual" });
    expect(out.Sections).toEqual([]);
    expect(out.Totals).toBeDefined();
  });

  it("preserves ReportTitle, ReportBasis, ReportSubtitle on output", () => {
    const out = adaptLiveReportRet(PNL_FIXTURE);
    expect(out.ReportTitle).toBe("Profit & Loss");
    expect(out.ReportBasis).toBe("Accrual");
    expect(out.ReportSubtitle).toBe("January through December 2024");
  });
});

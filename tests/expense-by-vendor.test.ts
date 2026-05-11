// Phase 11 #52 — qb_expense_by_vendor_summary + qb_expense_by_vendor_detail.
//
// Mirrors tests/sales-by-customer.test.ts in shape; the per-vendor rollup is
// the expense-side analog — walks Bill (VendorRef) + Check (PayeeEntityRef) +
// CreditCardCharge (PayeeEntityRef) ExpenseLineRet + ItemLineRet, sums
// line.Amount grouped by the txn's vendor / payee name. Caveat documented on
// the tool surface: sim doesn't filter by underlying account's AccountType so
// a Check posting to a Fixed Asset would still count here (mirrors the
// simplification #49 used on the income side).
//
// Coverage layers:
//   1. Sim handler — buildExpensesByVendorSummary via session.runReport
//      (per-vendor rollup, sort desc, date filter, vendorName / vendorListId
//      scope, multi-txn-type fan-in).
//   2. Sim handler — handleGeneralDetailReportQuery branch for
//      ExpensesByVendorDetail via session.runGeneralDetailReport (per-line
//      emit, sort by Vendor → Date → TxnID, scope, item-line attribution).
//   3. Tool surface — qb_expense_by_vendor_summary happy paths, scope, empty,
//      schema rejection.
//   4. Tool surface — qb_expense_by_vendor_detail happy paths, scope.

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerReportTools } from "../src/tools/reports.js";

type Handler = (args: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;
const handlers = new Map<string, Handler>();
const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
const fakeServer = {
  tool: (
    name: string,
    _description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: Handler,
  ) => {
    handlers.set(name, handler);
    schemas.set(name, schema);
  },
};

let session: QBSessionManager;

beforeAll(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-expense-by-vendor",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerReportTools(fakeServer as never, () => session);
  await session.openSession();

  // Seed expense activity across three vendors spanning Bill / Check /
  // CreditCardCharge so the rollup math is checkable end-to-end.
  //
  // ACME Property Mgmt (Bills, rent expense):
  //   Bill 2026-03-01: 2000 rent
  //   Bill 2026-04-01: 2100 rent
  //   Bill 2026-02-15: 1900 rent  ← pre-window noise (drops with fromDate=2026-03-01)
  //   Total in window: 2000 + 2100 = 4100
  //
  // Joe Contractor (Checks, payroll expense):
  //   Check 2026-03-15: 1500
  //   Check 2026-04-10: 800
  //   Total: 2300
  //
  // Office Supply Co (CreditCardCharge, office supplies):
  //   CreditCardCharge 2026-04-05: 250
  //   Total: 250

  await session.addEntity("Bill", {
    VendorRef: { FullName: "ACME Property Mgmt" },
    TxnDate: "2026-02-15",
    DueDate: "2026-03-15",
    RefNumber: "RNT-OLD",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Rent Expense" }, Amount: 1900, Memo: "Feb rent" },
    ],
  });
  await session.addEntity("Bill", {
    VendorRef: { FullName: "ACME Property Mgmt" },
    TxnDate: "2026-03-01",
    DueDate: "2026-03-31",
    RefNumber: "RNT-MAR",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Rent Expense" }, Amount: 2000, Memo: "March rent" },
    ],
  });
  await session.addEntity("Bill", {
    VendorRef: { FullName: "ACME Property Mgmt" },
    TxnDate: "2026-04-01",
    DueDate: "2026-04-30",
    RefNumber: "RNT-APR",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Rent Expense" }, Amount: 2100, Memo: "April rent" },
    ],
  });

  await session.addEntity("Check", {
    PayeeEntityRef: { FullName: "Joe Contractor" },
    AccountRef: { FullName: "Checking" },
    TxnDate: "2026-03-15",
    RefNumber: "CHK-1001",
    Amount: 1500,
    Memo: "March labor",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Payroll Expense" }, Amount: 1500, Memo: "March labor" },
    ],
  });
  await session.addEntity("Check", {
    PayeeEntityRef: { FullName: "Joe Contractor" },
    AccountRef: { FullName: "Checking" },
    TxnDate: "2026-04-10",
    RefNumber: "CHK-1002",
    Amount: 800,
    Memo: "April labor",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Payroll Expense" }, Amount: 800, Memo: "April labor" },
    ],
  });

  await session.addEntity("CreditCardCharge", {
    PayeeEntityRef: { FullName: "Office Supply Co" },
    AccountRef: { FullName: "Business Credit Card" },
    TxnDate: "2026-04-05",
    RefNumber: "CC-101",
    Amount: 250,
    Memo: "Office supplies",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Office Supplies" }, Amount: 250, Memo: "Printer paper + toner" },
    ],
  });
});

const callTool = async (toolName: string, args: Record<string, unknown>) => {
  const schema = schemas.get(toolName);
  const handler = handlers.get(toolName);
  if (!schema || !handler) throw new Error(`Tool not registered: ${toolName}`);
  const parsed = z.object(schema).safeParse(args);
  if (!parsed.success) return { schemaError: parsed.error };
  const result = await handler(parsed.data);
  const payload = JSON.parse(result.content[0].text);
  return { result, payload };
};

// ---------------------------------------------------------------------------
// Layer 1 — ExpensesByVendorSummary via session.runReport
// ---------------------------------------------------------------------------

describe("session.runReport('ExpensesByVendorSummary')", () => {
  it("aggregates per-vendor expenses across Bill + Check + CreditCardCharge and sorts descending", async () => {
    const ret = await session.runReport("ExpensesByVendorSummary", {
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
    });
    const sections = ret.Sections as Array<{
      Name: string;
      Accounts: Array<{ Name: string; Total: number }>;
      Subtotal: number;
    }>;
    expect(sections).toHaveLength(1);
    expect(sections[0].Name).toBe("Expenses");

    // ACME (Bills): 2000 + 2100 = 4100
    // Joe (Checks): 1500 + 800 = 2300
    // Office Supply Co (CC): 250
    // Sort desc: ACME → Joe → Office Supply Co.
    expect(sections[0].Accounts).toEqual([
      { Name: "ACME Property Mgmt", Total: 4100 },
      { Name: "Joe Contractor", Total: 2300 },
      { Name: "Office Supply Co", Total: 250 },
    ]);
    expect(sections[0].Subtotal).toBe(6650);

    const totals = ret.Totals as Record<string, number>;
    expect(totals.TotalExpenses).toBe(6650);
  });

  it("includes the pre-window bill when fromDate is omitted", async () => {
    const ret = await session.runReport("ExpensesByVendorSummary", {
      toDate: "2026-05-31",
    });
    const sections = ret.Sections as Array<{ Accounts: Array<{ Name: string; Total: number }> }>;
    const acme = sections[0].Accounts.find((a) => a.Name === "ACME Property Mgmt")!;
    // Now includes the OLD Feb rent: 1900 + 2000 + 2100 = 6000.
    expect(acme.Total).toBe(6000);
  });

  it("scopes to a single vendor via entityFilter.FullName", async () => {
    const ret = await session.runReport("ExpensesByVendorSummary", {
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
      entityFilter: { FullName: "Joe Contractor" },
    });
    const sections = ret.Sections as Array<{ Accounts: Array<{ Name: string; Total: number }> }>;
    expect(sections[0].Accounts).toEqual([
      { Name: "Joe Contractor", Total: 2300 },
    ]);
    expect((ret.Totals as Record<string, number>).TotalExpenses).toBe(2300);
  });

  it("returns empty section accounts when the window has no expenses", async () => {
    const ret = await session.runReport("ExpensesByVendorSummary", {
      fromDate: "2030-01-01",
      toDate: "2030-12-31",
    });
    const sections = ret.Sections as Array<{ Accounts: unknown[]; Subtotal: number }>;
    expect(sections[0].Accounts).toEqual([]);
    expect(sections[0].Subtotal).toBe(0);
    expect((ret.Totals as Record<string, number>).TotalExpenses).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — ExpensesByVendorDetail via session.runGeneralDetailReport
// ---------------------------------------------------------------------------

describe("session.runGeneralDetailReport('ExpensesByVendorDetail')", () => {
  it("emits one row per expense-line, sorted by Vendor → TxnDate → TxnID", async () => {
    const ret = await session.runGeneralDetailReport({
      reportType: "ExpensesByVendorDetail",
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
    });
    const rows = ret.Rows as Array<Record<string, unknown>>;

    // 5 expense lines in window:
    //   ACME × 2 (RNT-MAR, RNT-APR)
    //   Joe × 2 (CHK-1001, CHK-1002)
    //   Office Supply Co × 1 (CC-101)
    expect(rows).toHaveLength(5);

    // Sort: ACME first (alpha), then Joe, then Office Supply Co.
    expect(rows.map((r) => r.Name)).toEqual([
      "ACME Property Mgmt",
      "ACME Property Mgmt",
      "Joe Contractor",
      "Joe Contractor",
      "Office Supply Co",
    ]);

    // First ACME row is RNT-MAR (TxnDate 2026-03-01).
    expect(rows[0].TxnType).toBe("Bill");
    expect(rows[0].Date).toBe("2026-03-01");
    expect(rows[0].Num).toBe("RNT-MAR");
    expect(rows[0].Account).toBe("Rent Expense");
    expect(rows[0].Amount).toBe(2000);

    // Joe Contractor's checks land between ACME and Office Supply Co.
    const joeRows = rows.filter((r) => r.Name === "Joe Contractor");
    expect(joeRows.map((r) => r.Date)).toEqual(["2026-03-15", "2026-04-10"]);
    expect(joeRows[0].TxnType).toBe("Check");
    expect(joeRows[0].Account).toBe("Payroll Expense");

    // CreditCardCharge row surfaces with TxnType=CreditCardCharge.
    const ccRow = rows.find((r) => r.TxnType === "CreditCardCharge")!;
    expect(ccRow.Name).toBe("Office Supply Co");
    expect(ccRow.Account).toBe("Office Supplies");
    expect(ccRow.Amount).toBe(250);
  });

  it("scopes by entityFilter.FullName", async () => {
    const ret = await session.runGeneralDetailReport({
      reportType: "ExpensesByVendorDetail",
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
      entityFilter: { FullName: "ACME Property Mgmt" },
    });
    const rows = ret.Rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.Name === "ACME Property Mgmt")).toBe(true);
    expect(rows.reduce((s, r) => s + Number(r.Amount), 0)).toBe(4100);
  });

  it("date filter narrows to the requested window", async () => {
    // March only — RNT-MAR + CHK-1001.
    const ret = await session.runGeneralDetailReport({
      reportType: "ExpensesByVendorDetail",
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
    });
    const rows = ret.Rows as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.Num).sort()).toEqual(["CHK-1001", "RNT-MAR"]);
  });

  it("emits Columns metadata describing each cell type", async () => {
    const ret = await session.runGeneralDetailReport({
      reportType: "ExpensesByVendorDetail",
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
    });
    const columns = ret.Columns as Array<{ Title: string; Type: string }>;
    const titles = columns.map((c) => c.Title);
    expect(titles).toContain("TxnType");
    expect(titles).toContain("Account");
    expect(titles).toContain("Amount");
    expect(columns.find((c) => c.Title === "Amount")?.Type).toBe("Amount");
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — Tool surface: qb_expense_by_vendor_summary
// ---------------------------------------------------------------------------

describe("qb_expense_by_vendor_summary", () => {
  it("returns a flat vendors list with totalExpenses and reportPeriod", async () => {
    const { payload } = await callTool("qb_expense_by_vendor_summary", {
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
    });
    expect(payload.vendorCount).toBe(3);
    expect(payload.totalExpenses).toBe(6650);
    expect(payload.reportPeriod).toEqual({ from: "2026-03-01", to: "2026-05-31" });
    expect(payload.vendors).toEqual([
      { vendorName: "ACME Property Mgmt", total: 4100 },
      { vendorName: "Joe Contractor", total: 2300 },
      { vendorName: "Office Supply Co", total: 250 },
    ]);
  });

  it("scopes by vendorName", async () => {
    const { payload } = await callTool("qb_expense_by_vendor_summary", {
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
      vendorName: "ACME Property Mgmt",
    });
    expect(payload.vendorCount).toBe(1);
    expect(payload.vendors[0].vendorName).toBe("ACME Property Mgmt");
    expect(payload.totalExpenses).toBe(4100);
  });

  it("rejects invalid date string at schema level", async () => {
    const result = await callTool("qb_expense_by_vendor_summary", {
      fromDate: "2026/03/01",
    });
    expect("schemaError" in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — Tool surface: qb_expense_by_vendor_detail
// ---------------------------------------------------------------------------

describe("qb_expense_by_vendor_detail", () => {
  it("returns per-line rows with Columns metadata and aggregate totalAmount", async () => {
    const { payload } = await callTool("qb_expense_by_vendor_detail", {
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
    });
    expect(payload.rowCount).toBe(5);
    // 2000 + 2100 + 1500 + 800 + 250 = 6650
    expect(payload.totalAmount).toBe(6650);
    expect(payload.reportTitle).toBe("Expenses by Vendor Detail");
    expect(payload.columns).toEqual(
      expect.arrayContaining([
        { Title: "TxnType", Type: "Text" },
        { Title: "Account", Type: "Text" },
        { Title: "Amount", Type: "Amount" },
      ]),
    );
  });

  it("scopes by vendorName and includes only that vendor's rows", async () => {
    const { payload } = await callTool("qb_expense_by_vendor_detail", {
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
      vendorName: "Joe Contractor",
    });
    expect(payload.rowCount).toBe(2);
    expect(payload.rows.every((r: { Name: string }) => r.Name === "Joe Contractor")).toBe(true);
    expect(payload.totalAmount).toBe(2300);
  });

  it("returns empty rows when no expenses match the window", async () => {
    const { payload } = await callTool("qb_expense_by_vendor_detail", {
      fromDate: "2030-01-01",
      toDate: "2030-12-31",
    });
    expect(payload.rowCount).toBe(0);
    expect(payload.rows).toEqual([]);
    expect(payload.totalAmount).toBe(0);
  });

  it("surfaces CreditCardCharge rows alongside Bill and Check", async () => {
    const { payload } = await callTool("qb_expense_by_vendor_detail", {
      fromDate: "2026-04-05",
      toDate: "2026-04-05",
      vendorName: "Office Supply Co",
    });
    expect(payload.rowCount).toBe(1);
    expect(payload.rows[0].TxnType).toBe("CreditCardCharge");
    expect(payload.rows[0].Account).toBe("Office Supplies");
    expect(payload.rows[0].Amount).toBe(250);
  });

  it("rejects invalid date string at schema level", async () => {
    const result = await callTool("qb_expense_by_vendor_detail", {
      fromDate: "March 1, 2026",
    });
    expect("schemaError" in result).toBe(true);
  });
});

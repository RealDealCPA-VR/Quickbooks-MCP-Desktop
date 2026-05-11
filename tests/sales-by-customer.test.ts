// Phase 11 #49 — qb_sales_by_customer_summary + qb_sales_by_customer_detail.
//
// Coverage layers:
//   1. Sim handler — buildSalesByCustomerSummary via session.runReport
//      (per-customer rollup, CreditMemo subtraction, sort desc, date filter,
//      customerName / customerListId scope).
//   2. Sim handler — handleGeneralDetailReportQuery via
//      session.runGeneralDetailReport (per-line emit, sort by Customer →
//      Date → TxnID, CreditMemo negative-Amount, scope filters, unsupported-
//      reportType rejection, dispatch precedence).
//   3. Parser flat-summary adapter — adaptLiveReportRet handling of the
//      SalesByCustomerSummary live shape (no PnL/BS labels → single section
//      "Sales", TOTAL row → Totals.TotalSales, empty-data short-circuit).
//   4. Tool surface — qb_sales_by_customer_summary happy paths, scope,
//      empty result, error wrapping.
//   5. Tool surface — qb_sales_by_customer_detail happy paths, scope,
//      column metadata, error wrapping.

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerReportTools } from "../src/tools/reports.js";
import { adaptLiveReportRet } from "../src/qbxml/parser.js";

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
    appName: "vitest-sales-by-customer",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerReportTools(fakeServer as never, () => session);
  await session.openSession();

  // Seed sales activity across three customers. The sim's standard seed
  // doesn't include shipped sales data — we build it here so each test can
  // reason about exact totals.
  //
  // Customer A: Acme Corporation
  //   Invoice 2026-03-01: 1500 (Consulting Services × 10 hrs @ $150)
  //   Invoice 2026-04-15: 800  (Software License × 1 @ $800)
  //   CreditMemo 2026-04-20: 200 → reduces Acme's net to 2100
  //   Total: 1500 + 800 − 200 = 2100
  //
  // Customer B: Global Industries
  //   Invoice 2026-03-15: 3000 (Consulting Services × 20 hrs @ $150)
  //   SalesReceipt 2026-04-01: 500 (Widget A × 20 @ $25)
  //   Total: 3000 + 500 = 3500
  //
  // Customer C: TechStart Solutions
  //   Invoice 2026-05-01: 750 (Consulting Services × 5 hrs @ $150)
  //   Total: 750
  //
  // Out-of-window noise (drops with fromDate=2026-03-01 filter):
  //   Invoice 2026-02-15 to Acme: 999 (Consulting Services × 6.66 hrs @ $150)
  //     — within window in any test that omits fromDate; excluded when set.

  await session.addEntity("Invoice", {
    CustomerRef: { FullName: "Acme Corporation" },
    TxnDate: "2026-02-15",
    RefNumber: "OLD-1",
    InvoiceLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 6.66, Rate: 150 },
    ],
  });
  await session.addEntity("Invoice", {
    CustomerRef: { FullName: "Acme Corporation" },
    TxnDate: "2026-03-01",
    RefNumber: "ACM-1",
    InvoiceLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 10, Rate: 150 },
    ],
  });
  await session.addEntity("Invoice", {
    CustomerRef: { FullName: "Acme Corporation" },
    TxnDate: "2026-04-15",
    RefNumber: "ACM-2",
    Memo: "Software annual",
    InvoiceLineAdd: [
      { ItemRef: { FullName: "Software License" }, Quantity: 1, Rate: 800 },
    ],
  });
  await session.addEntity("CreditMemo", {
    CustomerRef: { FullName: "Acme Corporation" },
    TxnDate: "2026-04-20",
    RefNumber: "ACM-CM-1",
    CreditMemoLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 200 },
    ],
  });

  await session.addEntity("Invoice", {
    CustomerRef: { FullName: "Global Industries" },
    TxnDate: "2026-03-15",
    RefNumber: "GBL-1",
    InvoiceLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 20, Rate: 150 },
    ],
  });
  await session.addEntity("SalesReceipt", {
    CustomerRef: { FullName: "Global Industries" },
    TxnDate: "2026-04-01",
    RefNumber: "GBL-SR-1",
    DepositToAccountRef: { FullName: "Checking" },
    SalesReceiptLineAdd: [
      { ItemRef: { FullName: "Widget A" }, Quantity: 20, Rate: 25 },
    ],
  });

  await session.addEntity("Invoice", {
    CustomerRef: { FullName: "TechStart Solutions" },
    TxnDate: "2026-05-01",
    RefNumber: "TST-1",
    InvoiceLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 5, Rate: 150 },
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
// Layer 1 — SalesByCustomerSummary via session.runReport
// ---------------------------------------------------------------------------

describe("session.runReport('SalesByCustomerSummary')", () => {
  it("aggregates per-customer totals and sorts descending", async () => {
    const ret = await session.runReport("SalesByCustomerSummary", {
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
    });
    const sections = ret.Sections as Array<{
      Name: string;
      Accounts: Array<{ Name: string; Total: number }>;
      Subtotal: number;
    }>;
    expect(sections).toHaveLength(1);
    expect(sections[0].Name).toBe("Sales");

    // 2100 (Acme: 1500 + 800 − 200) + 3500 (Global) + 750 (TST) = 6350.
    // Sort desc: Global (3500) → Acme (2100) → TechStart (750).
    expect(sections[0].Accounts).toEqual([
      { Name: "Global Industries", Total: 3500 },
      { Name: "Acme Corporation", Total: 2100 },
      { Name: "TechStart Solutions", Total: 750 },
    ]);
    expect(sections[0].Subtotal).toBe(6350);

    const totals = ret.Totals as Record<string, number>;
    expect(totals.TotalSales).toBe(6350);
  });

  it("includes the pre-window sale when fromDate is omitted", async () => {
    const ret = await session.runReport("SalesByCustomerSummary", {
      toDate: "2026-05-31",
    });
    const sections = ret.Sections as Array<{ Accounts: Array<{ Name: string; Total: number }> }>;
    const acme = sections[0].Accounts.find((a) => a.Name === "Acme Corporation")!;
    // Now includes the 2026-02-15 OLD-1 invoice: 6.66 × 150 = 999.
    expect(acme.Total).toBe(2100 + 999);
  });

  it("scopes to a single customer via entityFilter.FullName", async () => {
    const ret = await session.runReport("SalesByCustomerSummary", {
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
      entityFilter: { FullName: "Acme Corporation" },
    });
    const sections = ret.Sections as Array<{ Accounts: Array<{ Name: string }> }>;
    expect(sections[0].Accounts).toHaveLength(1);
    expect(sections[0].Accounts[0].Name).toBe("Acme Corporation");
  });

  it("resolves entityFilter.ListID against the Customer store", async () => {
    // The seed gives Acme a deterministic ListID — pull it out and use it.
    const customers = await session.queryEntity("Customer", {});
    const acme = customers.find((c) => c.FullName === "Acme Corporation");
    expect(acme).toBeDefined();
    const acmeListId = String(acme!.ListID);

    const ret = await session.runReport("SalesByCustomerSummary", {
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
      entityFilter: { ListID: acmeListId },
    });
    const sections = ret.Sections as Array<{ Accounts: Array<{ Name: string; Total: number }> }>;
    expect(sections[0].Accounts).toEqual([
      { Name: "Acme Corporation", Total: 2100 },
    ]);
  });

  it("returns empty section accounts when the window has no sales", async () => {
    const ret = await session.runReport("SalesByCustomerSummary", {
      fromDate: "2030-01-01",
      toDate: "2030-12-31",
    });
    const sections = ret.Sections as Array<{ Accounts: unknown[]; Subtotal: number }>;
    expect(sections[0].Accounts).toEqual([]);
    expect(sections[0].Subtotal).toBe(0);
    expect((ret.Totals as Record<string, number>).TotalSales).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — SalesByCustomerDetail via session.runGeneralDetailReport
// ---------------------------------------------------------------------------

describe("session.runGeneralDetailReport('SalesByCustomerDetail')", () => {
  it("emits one row per Invoice/SR/CM line with TxnType/Date/Name/Item/Amount", async () => {
    const ret = await session.runGeneralDetailReport({
      reportType: "SalesByCustomerDetail",
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
    });
    const rows = ret.Rows as Array<Record<string, unknown>>;

    // 7 sale-side lines in window:
    //   Acme: ACM-1 (1 line), ACM-2 (1 line), ACM-CM-1 (1 line, negative)
    //   Global: GBL-1 (1 line), GBL-SR-1 (1 line)
    //   TechStart: TST-1 (1 line)
    // Total: 3+2+1 = 6 lines.
    expect(rows).toHaveLength(6);

    // Acme rows first (alphabetical), then Global, then TechStart.
    expect(rows.map((r) => r.Name)).toEqual([
      "Acme Corporation",
      "Acme Corporation",
      "Acme Corporation",
      "Global Industries",
      "Global Industries",
      "TechStart Solutions",
    ]);

    // First Acme row is ACM-1 (TxnDate 2026-03-01).
    expect(rows[0].TxnType).toBe("Invoice");
    expect(rows[0].Date).toBe("2026-03-01");
    expect(rows[0].Num).toBe("ACM-1");
    expect(rows[0].Item).toBe("Consulting Services");
    expect(rows[0].Quantity).toBe(10);
    expect(rows[0].Rate).toBe(150);
    expect(rows[0].Amount).toBe(1500);
    // Seed Items don't carry IncomeAccountRef, so line resolution falls
    // through to the documented "Uncategorized Income" bucket — same
    // fallback as qb_pnl_report uses for unresolvable lines. In live mode
    // (where Items DO carry IncomeAccountRef) this would surface the real
    // GL account.
    expect(rows[0].Account).toBe("Uncategorized Income");

    // ACM-CM-1 emits as negative.
    const cmRow = rows.find((r) => r.Num === "ACM-CM-1")!;
    expect(cmRow.TxnType).toBe("CreditMemo");
    expect(cmRow.Amount).toBe(-200);
  });

  it("sorts rows by Customer → TxnDate ascending → TxnID", async () => {
    const ret = await session.runGeneralDetailReport({
      reportType: "SalesByCustomerDetail",
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
    });
    const rows = ret.Rows as Array<Record<string, unknown>>;
    // Acme's three rows in date order: 2026-03-01, 2026-04-15, 2026-04-20.
    const acmeRows = rows.filter((r) => r.Name === "Acme Corporation");
    expect(acmeRows.map((r) => r.Date)).toEqual([
      "2026-03-01",
      "2026-04-15",
      "2026-04-20",
    ]);
    expect(acmeRows.map((r) => r.Num)).toEqual(["ACM-1", "ACM-2", "ACM-CM-1"]);
  });

  it("scopes by entityFilter.FullName", async () => {
    const ret = await session.runGeneralDetailReport({
      reportType: "SalesByCustomerDetail",
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
      entityFilter: { FullName: "Global Industries" },
    });
    const rows = ret.Rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.Name === "Global Industries")).toBe(true);
  });

  it("scopes by entityFilter.ListID (resolved via Customer store)", async () => {
    const customers = await session.queryEntity("Customer", {});
    const tst = customers.find((c) => c.FullName === "TechStart Solutions")!;
    const ret = await session.runGeneralDetailReport({
      reportType: "SalesByCustomerDetail",
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
      entityFilter: { ListID: String(tst.ListID) },
    });
    const rows = ret.Rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].Name).toBe("TechStart Solutions");
    expect(rows[0].Amount).toBe(750);
  });

  it("rejects unsupported GeneralDetailReportType with statusCode 3120", async () => {
    // VendorBalanceDetail is a real QBXML GeneralDetailReportType but isn't
    // implemented in the simulation yet (Phase 11 #51). Use it as the
    // "unsupported" probe so the assertion stays meaningful as more variants
    // land. (SalesByItemDetail was the original probe but it's now supported
    // — Phase 11 #50.)
    await expect(
      session.runGeneralDetailReport({ reportType: "VendorBalanceDetail" }),
    ).rejects.toThrow(/Unsupported GeneralDetailReportType/);
  });

  it("date filter narrows to the requested window", async () => {
    // April only — Acme's ACM-2 + ACM-CM-1 + Global's GBL-SR-1.
    const ret = await session.runGeneralDetailReport({
      reportType: "SalesByCustomerDetail",
      fromDate: "2026-04-01",
      toDate: "2026-04-30",
    });
    const rows = ret.Rows as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.Num).sort()).toEqual(["ACM-2", "ACM-CM-1", "GBL-SR-1"]);
  });

  it("emits Columns metadata describing each cell type", async () => {
    const ret = await session.runGeneralDetailReport({
      reportType: "SalesByCustomerDetail",
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
    });
    const columns = ret.Columns as Array<{ Title: string; Type: string }>;
    const titles = columns.map((c) => c.Title);
    expect(titles).toContain("TxnType");
    expect(titles).toContain("Amount");
    expect(titles).toContain("Quantity");
    expect(columns.find((c) => c.Title === "Amount")?.Type).toBe("Amount");
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — Parser flat-summary adapter (live wire shape)
// ---------------------------------------------------------------------------

describe("adaptLiveReportRet — flat-summary fork (SalesByCustomerSummary)", () => {
  // Build a synthetic live ReportRet matching what QBXMLRP2 would emit for
  // GeneralSummaryReportQueryRq with GeneralSummaryReportType=SalesByCustomerSummary.
  // Key shape: no canonical PnL/BS section TextRows; flat DataRows with
  // (name, amount) columns; closing TotalRow with the grand total.
  const buildLiveShape = () => ({
    ReportTitle: "Sales by Customer Summary",
    ReportBasis: "Accrual",
    ReportData: {
      DataRow: [
        {
          "@_rowNumber": 1,
          ColData: [
            { "@_colID": 1, "@_value": "Global Industries" },
            { "@_colID": 2, "@_value": 3500 },
          ],
        },
        {
          "@_rowNumber": 2,
          ColData: [
            { "@_colID": 1, "@_value": "Acme Corporation" },
            { "@_colID": 2, "@_value": 2100 },
          ],
        },
        {
          "@_rowNumber": 3,
          ColData: [
            { "@_colID": 1, "@_value": "TechStart Solutions" },
            { "@_colID": 2, "@_value": 750 },
          ],
        },
      ],
      TotalRow: {
        "@_rowNumber": 4,
        ColData: [
          { "@_colID": 1, "@_value": "TOTAL" },
          { "@_colID": 2, "@_value": 6350 },
        ],
      },
    },
  });

  it("synthesizes one 'Sales' section with all customer DataRows as accounts", () => {
    const out = adaptLiveReportRet(buildLiveShape());
    const sections = out.Sections as Array<{
      Name: string;
      Accounts: Array<{ Name: string; Total: number }>;
      Subtotal: number;
    }>;
    expect(sections).toHaveLength(1);
    expect(sections[0].Name).toBe("Sales");
    expect(sections[0].Accounts).toEqual([
      { Name: "Global Industries", Total: 3500 },
      { Name: "Acme Corporation", Total: 2100 },
      { Name: "TechStart Solutions", Total: 750 },
    ]);
    expect(sections[0].Subtotal).toBe(6350);
  });

  it("surfaces the closing TOTAL row as Totals.TotalSales", () => {
    const out = adaptLiveReportRet(buildLiveShape());
    expect((out.Totals as Record<string, number>).TotalSales).toBe(6350);
  });

  it("falls back to summing DataRows when no TOTAL row is present", () => {
    const shape = buildLiveShape();
    delete (shape.ReportData as Record<string, unknown>).TotalRow;
    const out = adaptLiveReportRet(shape);
    expect((out.Totals as Record<string, number>).TotalSales).toBe(6350);
  });

  it("returns empty Sections when ReportData is absent (status 1 / no data)", () => {
    // Regression pin: this is the case that initially broke the existing
    // adapter test — the flat-summary fork must NOT synthesize a phantom
    // section when there are zero data rows. Preserves the
    // distinguishable-empty contract.
    const out = adaptLiveReportRet({
      ReportTitle: "Sales by Customer Summary",
      ReportBasis: "Accrual",
    });
    expect(out.Sections).toEqual([]);
    expect(out.Totals).toEqual({});
  });

  it("does NOT trigger the flat fork for reports with canonical PnL labels (P&L still works)", () => {
    // Defensive: if a P&L "Income" TextRow is present, the adapter must
    // route to the P&L branch, not the flat-summary fork. Otherwise the
    // existing #37/#38 P&L tests would regress.
    const out = adaptLiveReportRet({
      ReportTitle: "Profit & Loss",
      ReportBasis: "Accrual",
      ReportData: {
        TextRow: [
          { "@_rowNumber": 1, "@_value": "Income" },
        ],
        DataRow: [
          {
            "@_rowNumber": 2,
            ColData: [
              { "@_colID": 1, "@_value": "Sales Revenue" },
              { "@_colID": 2, "@_value": 50000 },
            ],
          },
        ],
        SubtotalRow: [
          {
            "@_rowNumber": 3,
            ColData: [
              { "@_colID": 1, "@_value": "Total Income" },
              { "@_colID": 2, "@_value": 50000 },
            ],
          },
        ],
      },
    });
    const sections = out.Sections as Array<{ Name: string }>;
    expect(sections.map((s) => s.Name)).toEqual(["Income"]);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — Tool surface: qb_sales_by_customer_summary
// ---------------------------------------------------------------------------

describe("qb_sales_by_customer_summary", () => {
  it("returns a flat customers list with totalSales and reportPeriod", async () => {
    const { payload } = await callTool("qb_sales_by_customer_summary", {
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
    });
    expect(payload.customerCount).toBe(3);
    expect(payload.totalSales).toBe(6350);
    expect(payload.reportPeriod).toEqual({ from: "2026-03-01", to: "2026-05-31" });
    expect(payload.customers).toEqual([
      { customerName: "Global Industries", total: 3500 },
      { customerName: "Acme Corporation", total: 2100 },
      { customerName: "TechStart Solutions", total: 750 },
    ]);
  });

  it("scopes by customerName", async () => {
    const { payload } = await callTool("qb_sales_by_customer_summary", {
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
      customerName: "Global Industries",
    });
    expect(payload.customerCount).toBe(1);
    expect(payload.customers[0].customerName).toBe("Global Industries");
    expect(payload.totalSales).toBe(3500);
  });

  it("scopes by customerListId (resolved via Customer store)", async () => {
    const customers = await session.queryEntity("Customer", {});
    const acme = customers.find((c) => c.FullName === "Acme Corporation")!;
    const { payload } = await callTool("qb_sales_by_customer_summary", {
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
      customerListId: String(acme.ListID),
    });
    expect(payload.customerCount).toBe(1);
    expect(payload.customers[0].customerName).toBe("Acme Corporation");
    expect(payload.totalSales).toBe(2100);
  });

  it("rejects invalid date string at schema level", async () => {
    const result = await callTool("qb_sales_by_customer_summary", {
      fromDate: "2026/03/01",
    });
    expect("schemaError" in result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — Tool surface: qb_sales_by_customer_detail
// ---------------------------------------------------------------------------

describe("qb_sales_by_customer_detail", () => {
  it("returns per-line rows with Columns metadata and aggregate totalAmount", async () => {
    const { payload } = await callTool("qb_sales_by_customer_detail", {
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
    });
    expect(payload.rowCount).toBe(6);
    // 1500 + 800 − 200 + 3000 + 500 + 750 = 6350.
    expect(payload.totalAmount).toBe(6350);
    expect(payload.reportTitle).toBe("Sales by Customer Detail");

    // Columns metadata is present and shaped like {Title, Type}.
    expect(payload.columns).toEqual(
      expect.arrayContaining([
        { Title: "TxnType", Type: "Text" },
        { Title: "Amount", Type: "Amount" },
      ]),
    );
  });

  it("scopes by customerName and includes only that customer's rows", async () => {
    const { payload } = await callTool("qb_sales_by_customer_detail", {
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
      customerName: "Acme Corporation",
    });
    expect(payload.rowCount).toBe(3);
    expect(payload.rows.every((r: { Name: string }) => r.Name === "Acme Corporation")).toBe(true);
    expect(payload.totalAmount).toBe(2100);
  });

  it("scopes by customerListId", async () => {
    const customers = await session.queryEntity("Customer", {});
    const tst = customers.find((c) => c.FullName === "TechStart Solutions")!;
    const { payload } = await callTool("qb_sales_by_customer_detail", {
      fromDate: "2026-03-01",
      toDate: "2026-05-31",
      customerListId: String(tst.ListID),
    });
    expect(payload.rowCount).toBe(1);
    expect(payload.rows[0].Name).toBe("TechStart Solutions");
    expect(payload.rows[0].Amount).toBe(750);
  });

  it("returns empty rows when no sales match the window", async () => {
    const { payload } = await callTool("qb_sales_by_customer_detail", {
      fromDate: "2030-01-01",
      toDate: "2030-12-31",
    });
    expect(payload.rowCount).toBe(0);
    expect(payload.rows).toEqual([]);
    expect(payload.totalAmount).toBe(0);
  });

  it("surfaces CreditMemo rows with negative Amount", async () => {
    const { payload } = await callTool("qb_sales_by_customer_detail", {
      fromDate: "2026-04-20",
      toDate: "2026-04-20",
      customerName: "Acme Corporation",
    });
    expect(payload.rowCount).toBe(1);
    expect(payload.rows[0].TxnType).toBe("CreditMemo");
    expect(payload.rows[0].Amount).toBe(-200);
  });

  it("rejects invalid date string at schema level", async () => {
    const result = await callTool("qb_sales_by_customer_detail", {
      fromDate: "March 1, 2026",
    });
    expect("schemaError" in result).toBe(true);
  });
});

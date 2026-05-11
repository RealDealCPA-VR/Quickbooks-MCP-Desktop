// Phase 11 #48 — qb_customer_balance_detail.
//
// Coverage layers:
//   1. Pure helper math (buildEntityBalanceSection) — opening/closing/running
//      balance, empty rows, missing entity Balance, entityListId surfacing.
//   2. extractOriginalTxnAmount — per-txn-type amount extraction (Invoice,
//      CreditMemo, ReceivePayment, BillPaymentCheck/CreditCard, Bill line
//      walk).
//   3. Tool surface — single-customer scope by name + ListID, unknown-
//      customer 500, date filter, basis pass-through, running-balance math.
//   4. Multi-customer aggregation — alpha sort, empty-section pruning,
//      includeZeroBalance, maxCustomers cap + warning, totalRowCount.

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import {
  buildEntityBalanceSection,
  extractOriginalTxnAmount,
  registerReportTools,
} from "../src/tools/reports.js";

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
    appName: "vitest-customer-balance-detail",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerReportTools(fakeServer as never, () => session);
  await session.openSession();

  // Three customers from the standard seed already exist:
  //   Acme Corporation     — starting Balance 15000
  //   Global Industries    — starting Balance  8500
  //   TechStart Solutions  — starting Balance  3200
  //
  // Add an additional customer with zero balance + no activity to exercise
  // the empty-section pruning + includeZeroBalance toggle.
  await session.addEntity("Customer", {
    Name: "Quiet Customer LLC",
    FullName: "Quiet Customer LLC",
    IsActive: true,
    Balance: 0,
  });

  // Acme Corporation activity (the rich test customer):
  //   2026-01-15 Invoice    INV-A1  $2000     → Balance: 15000 → 17000
  //   2026-02-01 Payment    PMT-A1  $1000 applied to INV-A1 → 17000 → 16000
  //   2026-03-01 CreditMemo CM-A1   $500      → 16000 → 15500
  //   Net final Customer.Balance = 15500
  const invoiceA1 = await session.addEntity("Invoice", {
    CustomerRef: { FullName: "Acme Corporation" },
    TxnDate: "2026-01-15",
    RefNumber: "INV-A1",
    Memo: "January retainer",
    InvoiceLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 2000 },
    ],
  });
  await session.addEntity("ReceivePayment", {
    CustomerRef: { FullName: "Acme Corporation" },
    TxnDate: "2026-02-01",
    RefNumber: "PMT-A1",
    Memo: "Partial pmt on INV-A1",
    TotalAmount: 1000,
    AppliedToTxnAdd: [
      { TxnID: String(invoiceA1.TxnID), PaymentAmount: 1000 },
    ],
  });
  await session.addEntity("CreditMemo", {
    CustomerRef: { FullName: "Acme Corporation" },
    TxnDate: "2026-03-01",
    RefNumber: "CM-A1",
    Memo: "Service credit",
    CreditMemoLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 500 },
    ],
  });

  // Global Industries activity:
  //   2026-04-15 Invoice INV-G1 $3000 → Balance: 8500 → 11500
  await session.addEntity("Invoice", {
    CustomerRef: { FullName: "Global Industries" },
    TxnDate: "2026-04-15",
    RefNumber: "INV-G1",
    InvoiceLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 3000 },
    ],
  });

  // Out-of-window noise to verify date filter: Invoice predating the test
  // window dropped by fromDate=2026-01-01.
  await session.addEntity("Invoice", {
    CustomerRef: { FullName: "Acme Corporation" },
    TxnDate: "2025-12-31",
    RefNumber: "INV-A0",
    InvoiceLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 100 },
    ],
  });
  // Acme final Balance after both invoices: 15500 + 100 = 15600
  // With 2026 filter: openingBalance = 15600 - 500 = 15100 (the pre-2026 100
  // is rolled into opening); the in-window postings still sum to +500.
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
// Layer 1 — pure helper math (buildEntityBalanceSection)
// ---------------------------------------------------------------------------

describe("buildEntityBalanceSection — pure math", () => {
  it("empty rows: opening = closing = current Balance, periodChange = 0", () => {
    const section = buildEntityBalanceSection(
      { FullName: "Acme", Balance: 5000 },
      [],
    );
    expect(section.entityName).toBe("Acme");
    expect(section.openingBalance).toBe(5000);
    expect(section.closingBalance).toBe(5000);
    expect(section.periodChange).toBe(0);
    expect(section.count).toBe(0);
    expect(section.transactions).toEqual([]);
  });

  it("positive net postings: opening + period = closing, running walks forward", () => {
    const section = buildEntityBalanceSection(
      { FullName: "Acme", Balance: 10000 },
      [
        { TxnDate: "2026-01-15", TxnType: "Invoice", Amount: 2000 },
        { TxnDate: "2026-02-01", TxnType: "Invoice", Amount: 1500 },
      ],
    );
    expect(section.periodChange).toBe(3500);
    expect(section.openingBalance).toBe(6500); // 10000 − 3500
    expect(section.closingBalance).toBe(10000);
    expect(section.transactions[0].RunningBalance).toBe(8500); // 6500 + 2000
    expect(section.transactions[1].RunningBalance).toBe(10000); // 8500 + 1500
  });

  it("negative net postings: closing < opening, running walks down", () => {
    const section = buildEntityBalanceSection(
      { FullName: "Acme", Balance: 2000 },
      [
        { TxnDate: "2026-01-15", TxnType: "Invoice", Amount: 1000 },
        { TxnDate: "2026-02-01", TxnType: "ReceivePayment", Amount: -3000 },
      ],
    );
    expect(section.periodChange).toBe(-2000);
    expect(section.openingBalance).toBe(4000); // 2000 − (−2000) = 4000
    expect(section.closingBalance).toBe(2000);
    expect(section.transactions[0].RunningBalance).toBe(5000); // 4000 + 1000
    expect(section.transactions[1].RunningBalance).toBe(2000); // 5000 − 3000
  });

  it("treats missing Balance as 0 (sim customer with no balance set)", () => {
    const section = buildEntityBalanceSection(
      { FullName: "Brand New Co" },
      [{ TxnDate: "2026-01-15", TxnType: "Invoice", Amount: 100 }],
    );
    expect(section.openingBalance).toBe(-100); // 0 − 100
    expect(section.closingBalance).toBe(0); // walks back to 0
    expect(section.transactions[0].RunningBalance).toBe(0);
  });

  it("surfaces entityListId only when present", () => {
    const withId = buildEntityBalanceSection(
      { FullName: "X", ListID: "ABC", Balance: 0 },
      [],
    );
    expect(withId.entityListId).toBe("ABC");
    const withoutId = buildEntityBalanceSection({ FullName: "X", Balance: 0 }, []);
    expect("entityListId" in withoutId).toBe(false);
  });

  it("falls back to Name when FullName is missing", () => {
    const section = buildEntityBalanceSection({ Name: "Plain Name", Balance: 0 }, []);
    expect(section.entityName).toBe("Plain Name");
  });

  it("rounds to cents to absorb float drift on running totals", () => {
    // periodSum walks 0.1 + 0.2 = 0.30000…04 → round2 → 0.3.
    // openingBalance = currentBalance − periodSum, so for currentBalance=0:
    //   opening = round2(-0.30000…) = -0.3
    //   running walks back to 0 (currentBalance) — running totals are NOT
    //   re-rounded per step (avoiding double-rounding drift), only the
    //   stored RunningBalance / closingBalance are round2-snapped.
    const section = buildEntityBalanceSection(
      { FullName: "X", Balance: 0 },
      [
        { TxnDate: "2026-01-15", TxnType: "Invoice", Amount: 0.1 },
        { TxnDate: "2026-01-16", TxnType: "Invoice", Amount: 0.2 },
      ],
    );
    expect(section.openingBalance).toBe(-0.3);
    expect(section.periodChange).toBe(0.3);
    expect(section.closingBalance).toBe(0); // walks from -0.3 back to 0
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — extractOriginalTxnAmount
// ---------------------------------------------------------------------------

describe("extractOriginalTxnAmount", () => {
  it("Invoice = Subtotal + SalesTaxTotal", () => {
    expect(
      extractOriginalTxnAmount({ Subtotal: 1000, SalesTaxTotal: 80 }, "Invoice"),
    ).toBe(1080);
    expect(extractOriginalTxnAmount({ Subtotal: 500 }, "Invoice")).toBe(500);
  });

  it("CreditMemo prefers TotalAmount, falls back to Subtotal + SalesTaxTotal", () => {
    expect(
      extractOriginalTxnAmount({ TotalAmount: 540, Subtotal: 500, SalesTaxTotal: 40 }, "CreditMemo"),
    ).toBe(540);
    expect(
      extractOriginalTxnAmount({ Subtotal: 500, SalesTaxTotal: 40 }, "CreditMemo"),
    ).toBe(540);
  });

  it("ReceivePayment = TotalAmount", () => {
    expect(extractOriginalTxnAmount({ TotalAmount: 1000 }, "ReceivePayment")).toBe(1000);
  });

  it("BillPaymentCheck prefers TotalAmount, falls back to Amount (HANDOFF gotcha)", () => {
    expect(extractOriginalTxnAmount({ TotalAmount: 500 }, "BillPaymentCheck")).toBe(500);
    expect(extractOriginalTxnAmount({ Amount: 500 }, "BillPaymentCheck")).toBe(500);
    expect(
      extractOriginalTxnAmount({ TotalAmount: 500, Amount: 999 }, "BillPaymentCheck"),
    ).toBe(500);
  });

  it("BillPaymentCreditCard same fallback shape", () => {
    expect(extractOriginalTxnAmount({ Amount: 200 }, "BillPaymentCreditCard")).toBe(200);
  });

  it("Bill walks ExpenseLineRet + ItemLineRet sums (NOT AmountDue — that decrements on payment)", () => {
    const fullyPaidBill = {
      AmountDue: 0, // intentional — paid bills have AmountDue=0
      ExpenseLineRet: [
        { Amount: 600 },
        { Amount: 400 },
      ],
      ItemLineRet: [
        { Amount: 200 },
      ],
    };
    expect(extractOriginalTxnAmount(fullyPaidBill, "Bill")).toBe(1200);
  });

  it("Bill with no lines returns 0", () => {
    expect(extractOriginalTxnAmount({ AmountDue: 500 }, "Bill")).toBe(0);
  });

  it("unknown txnType returns 0", () => {
    expect(extractOriginalTxnAmount({ Amount: 999 }, "Mystery")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — tool surface: single-customer scope
// ---------------------------------------------------------------------------

describe("qb_customer_balance_detail — single customer scope", () => {
  it("returns one section for customerName, with the seeded 3-posting walk", async () => {
    const { payload } = await callTool("qb_customer_balance_detail", {
      customerName: "Acme Corporation",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    expect(payload.customerCount).toBe(1);
    expect(payload.sections).toHaveLength(1);
    const s = payload.sections[0];
    expect(s.customerName).toBe("Acme Corporation");
    expect(s.count).toBe(3);
    expect(s.transactions.map((r: { TxnType: string }) => r.TxnType)).toEqual([
      "Invoice", "ReceivePayment", "CreditMemo",
    ]);
    expect(s.transactions.map((r: { TxnDate: string }) => r.TxnDate)).toEqual([
      "2026-01-15", "2026-02-01", "2026-03-01",
    ]);
    // periodChange = +2000 − 1000 − 500 = +500
    expect(s.periodChange).toBe(500);
    // Final Acme balance after BOTH 2025 and 2026 invoices = 15600.
    // With fromDate=2026 the 2025 invoice rolls into opening, so:
    //   opening = 15600 − 500 = 15100
    expect(s.openingBalance).toBe(15100);
    expect(s.closingBalance).toBe(15600);
    expect(s.transactions[0].RunningBalance).toBe(17100); // 15100 + 2000
    expect(s.transactions[1].RunningBalance).toBe(16100); // 17100 − 1000
    expect(s.transactions[2].RunningBalance).toBe(15600); // 16100 − 500
  });

  it("returns identical section when scoped by customerListId", async () => {
    const { payload } = await callTool("qb_customer_balance_detail", {
      customerListId: "80000001-1234567890",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    expect(payload.sections).toHaveLength(1);
    expect(payload.sections[0].customerName).toBe("Acme Corporation");
    expect(payload.sections[0].customerListId).toBe("80000001-1234567890");
    expect(payload.sections[0].count).toBe(3);
  });

  it("rejects with 500 when customerName is unknown", async () => {
    const { result, payload } = await callTool("qb_customer_balance_detail", {
      customerName: "Nonexistent Co",
    });
    expect(result?.isError).toBe(true);
    expect(payload.statusCode).toBe(500);
    expect(payload.statusMessage).toMatch(/Nonexistent Co/);
  });

  it("rejects with 500 when customerListId is unknown", async () => {
    const { result, payload } = await callTool("qb_customer_balance_detail", {
      customerListId: "99999999-9999999999",
    });
    expect(result?.isError).toBe(true);
    expect(payload.statusCode).toBe(500);
  });

  it("date filter excludes out-of-window postings from periodChange (Acme 2025-12-31 invoice drops)", async () => {
    const { payload } = await callTool("qb_customer_balance_detail", {
      customerName: "Acme Corporation",
      fromDate: "2025-12-01",
      toDate: "2025-12-31",
    });
    const s = payload.sections[0];
    // Only the 2025-12-31 Invoice ($100) falls in this window.
    expect(s.count).toBe(1);
    expect(s.transactions[0].RefNumber).toBe("INV-A0");
    expect(s.periodChange).toBe(100);
  });

  it("RefNumber and Memo are surfaced on row rows", async () => {
    const { payload } = await callTool("qb_customer_balance_detail", {
      customerName: "Acme Corporation",
      fromDate: "2026-01-01",
      toDate: "2026-03-31",
    });
    const inv = payload.sections[0].transactions[0];
    expect(inv.RefNumber).toBe("INV-A1");
    expect(inv.Memo).toBe("January retainer");
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — multi-customer aggregation + pruning
// ---------------------------------------------------------------------------

describe("qb_customer_balance_detail — multi-customer", () => {
  it("returns sections for every customer with activity or non-zero balance, sorted alphabetically", async () => {
    const { payload } = await callTool("qb_customer_balance_detail", {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    const names = payload.sections.map((s: { customerName: string }) => s.customerName);
    // Acme + Global have activity. TechStart has Balance 3200 + no activity →
    // closingBalance != 0 so it stays (NOT pruned). Quiet Customer LLC has
    // Balance 0 + no activity → pruned by default.
    expect(names).toEqual([
      "Acme Corporation",
      "Global Industries",
      "TechStart Solutions",
    ]);
  });

  it("prunes customers with zero balance and zero activity by default", async () => {
    const { payload } = await callTool("qb_customer_balance_detail", {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    const names = payload.sections.map((s: { customerName: string }) => s.customerName);
    expect(names).not.toContain("Quiet Customer LLC");
  });

  it("includeZeroBalance:true surfaces zero-activity-zero-balance customers", async () => {
    const { payload } = await callTool("qb_customer_balance_detail", {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      includeZeroBalance: true,
    });
    const names = payload.sections.map((s: { customerName: string }) => s.customerName);
    expect(names).toContain("Quiet Customer LLC");
    const quiet = payload.sections.find(
      (s: { customerName: string }) => s.customerName === "Quiet Customer LLC",
    );
    expect(quiet.count).toBe(0);
    expect(quiet.openingBalance).toBe(0);
    expect(quiet.closingBalance).toBe(0);
  });

  it("totalRowCount sums across all emitted sections", async () => {
    const { payload } = await callTool("qb_customer_balance_detail", {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    // Acme=3, Global=1, TechStart=0  → 4
    expect(payload.totalRowCount).toBe(4);
  });

  it("maxCustomers cap surfaces a warning and truncates alphabetically", async () => {
    const { payload } = await callTool("qb_customer_balance_detail", {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      maxCustomers: 1,
      includeZeroBalance: true,
    });
    expect(payload.sections).toHaveLength(1);
    expect(payload.sections[0].customerName).toBe("Acme Corporation");
    expect(payload.warnings).toBeDefined();
    expect(payload.warnings[0]).toMatch(/exceeds maxCustomers/);
  });

  it("response carries basis (default Accrual) and fromDate/toDate echo", async () => {
    const { payload } = await callTool("qb_customer_balance_detail", {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      basis: "Cash",
    });
    expect(payload.basis).toBe("Cash");
    expect(payload.fromDate).toBe("2026-01-01");
    expect(payload.toDate).toBe("2026-12-31");
  });
});

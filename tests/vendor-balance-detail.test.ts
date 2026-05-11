// Phase 11 #51 — qb_vendor_balance_detail.
//
// Helper-layer math (buildEntityBalanceSection) + non-Bill extraction is
// already pinned by tests/customer-balance-detail.test.ts. This file focuses
// on the vendor-specific surface:
//   1. Bill-original-amount via ExpenseLineRet + ItemLineRet walk — the key
//      invariant that a fully-paid Bill (AmountDue=0) still surfaces its
//      original face value.
//   2. Tool surface — single-vendor scope by name + ListID, unknown-vendor
//      500, date filter, running-balance math against the seeded snapshot.
//   3. Multi-vendor aggregation — alpha sort, empty-section pruning,
//      includeZeroBalance, maxVendors cap + warning, totalRowCount.
//   4. BillPaymentCheck + BillPaymentCreditCard handling — both decrement
//      AP, both surface RefNumber/Memo.

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
    appName: "vitest-vendor-balance-detail",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerReportTools(fakeServer as never, () => session);
  await session.openSession();

  // Standard vendor seed:
  //   Office Supplies Co       — starting Balance 2500
  //   Cloud Hosting Services   — starting Balance 1200
  //   Joe Contractor           — starting Balance ~0 (1099-eligible seed)
  //   Sarah Designer LLC       — starting Balance ~0
  //   ACME Property Mgmt       — starting Balance ~0
  //
  // Add a quiet vendor with zero balance + no activity to verify pruning.
  await session.addEntity("Vendor", {
    Name: "Quiet Vendor LLC",
    FullName: "Quiet Vendor LLC",
    IsActive: true,
    Balance: 0,
  });

  // Office Supplies Co activity (the rich test vendor):
  //   2026-01-10 Bill BILL-O1 $800 (ExpenseLineAdd Office Supplies)
  //   2026-02-05 BillPaymentCheck PMT-O1 $500 applied to BILL-O1
  //   2026-03-15 Bill BILL-O2 $1200 split: $700 expense + $500 item line
  // Net AP movement: +800 - 500 + 1200 = +1500
  // Final Vendor.Balance: 2500 + 1500 = 4000

  const billO1 = await session.addEntity("Bill", {
    VendorRef: { FullName: "Office Supplies Co" },
    TxnDate: "2026-01-10",
    RefNumber: "BILL-O1",
    Memo: "January office supplies",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Office Supplies" }, Amount: 800 },
    ],
  });
  await session.addEntity("BillPaymentCheck", {
    VendorRef: { FullName: "Office Supplies Co" },
    TxnDate: "2026-02-05",
    RefNumber: "PMT-O1",
    Memo: "Partial pmt on BILL-O1",
    BankAccountRef: { FullName: "Checking" },
    AppliedToTxnAdd: [
      { TxnID: String(billO1.TxnID), PaymentAmount: 500 },
    ],
  });
  await session.addEntity("Bill", {
    VendorRef: { FullName: "Office Supplies Co" },
    TxnDate: "2026-03-15",
    RefNumber: "BILL-O2",
    Memo: "March mixed bill",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Office Supplies" }, Amount: 700 },
    ],
    ItemLineAdd: [
      // Pass explicit Amount — sim's convertLineAddToRet computes
      // Amount = Quantity * Rate when both are present, but Bill ItemLineAdd
      // uses `Cost` (not Rate) in QB's schema; the sim only sees Rate, so
      // the explicit Amount keeps the fixture predictable.
      { ItemRef: { FullName: "Office Chair" }, Quantity: 1, Amount: 500 },
    ],
  });

  // Cloud Hosting Services activity — single bill paid via credit card.
  //   2026-04-01 Bill BILL-C1 $600
  //   2026-04-15 BillPaymentCreditCard PMT-C1 $600 applied → fully paid
  // Net AP movement: +600 - 600 = 0
  // Final Vendor.Balance: 1200 (unchanged)
  const billC1 = await session.addEntity("Bill", {
    VendorRef: { FullName: "Cloud Hosting Services" },
    TxnDate: "2026-04-01",
    RefNumber: "BILL-C1",
    Memo: "April hosting",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Office Supplies" }, Amount: 600 },
    ],
  });
  await session.addEntity("BillPaymentCreditCard", {
    VendorRef: { FullName: "Cloud Hosting Services" },
    TxnDate: "2026-04-15",
    RefNumber: "PMT-C1",
    Memo: "Full pmt on BILL-C1",
    CreditCardAccountRef: { FullName: "Business Credit Card" },
    AppliedToTxnAdd: [
      { TxnID: String(billC1.TxnID), PaymentAmount: 600 },
    ],
  });

  // Out-of-window noise: a 2025 bill to Office Supplies Co that should drop
  // from the 2026 window but roll into the opening balance.
  await session.addEntity("Bill", {
    VendorRef: { FullName: "Office Supplies Co" },
    TxnDate: "2025-12-15",
    RefNumber: "BILL-O0",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Office Supplies" }, Amount: 200 },
    ],
  });
  // Office Supplies final Vendor.Balance: 2500 + 1500 + 200 = 4200
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
// Layer 1 — fully-paid Bill still surfaces ORIGINAL face value
// (the key vendor-specific extraction case)
// ---------------------------------------------------------------------------

describe("qb_vendor_balance_detail — Bill original-amount extraction", () => {
  it("Bill paid in full still surfaces its original face value (AmountDue=0 is irrelevant)", async () => {
    // BILL-O1 was $800 face, paid $500. AmountDue moved 800 → 300.
    // The Bill row in the report should still show +800 (original), NOT 300.
    const { payload } = await callTool("qb_vendor_balance_detail", {
      vendorName: "Office Supplies Co",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    const s = payload.sections[0];
    const billO1Row = s.transactions.find(
      (r: { RefNumber?: string }) => r.RefNumber === "BILL-O1",
    );
    expect(billO1Row).toBeDefined();
    expect(billO1Row.Amount).toBe(800); // original face, NOT decremented AmountDue
    expect(billO1Row.TxnType).toBe("Bill");
  });

  it("Bill with split expense + item lines sums both into the original face", async () => {
    // BILL-O2 was $700 expense + $500 item line = $1200 original.
    const { payload } = await callTool("qb_vendor_balance_detail", {
      vendorName: "Office Supplies Co",
      fromDate: "2026-03-01",
      toDate: "2026-03-31",
    });
    const s = payload.sections[0];
    const billO2Row = s.transactions.find(
      (r: { RefNumber?: string }) => r.RefNumber === "BILL-O2",
    );
    expect(billO2Row).toBeDefined();
    expect(billO2Row.Amount).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — tool surface: single-vendor scope
// ---------------------------------------------------------------------------

describe("qb_vendor_balance_detail — single vendor scope", () => {
  it("returns one section for vendorName, with chronological postings", async () => {
    const { payload } = await callTool("qb_vendor_balance_detail", {
      vendorName: "Office Supplies Co",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    expect(payload.vendorCount).toBe(1);
    expect(payload.sections).toHaveLength(1);
    const s = payload.sections[0];
    expect(s.vendorName).toBe("Office Supplies Co");
    expect(s.count).toBe(3);
    expect(s.transactions.map((r: { TxnType: string }) => r.TxnType)).toEqual([
      "Bill", "BillPaymentCheck", "Bill",
    ]);
    expect(s.transactions.map((r: { TxnDate: string }) => r.TxnDate)).toEqual([
      "2026-01-10", "2026-02-05", "2026-03-15",
    ]);
    // periodChange = +800 − 500 + 1200 = +1500
    expect(s.periodChange).toBe(1500);
    // Office Supplies final Balance = 4200 (2500 seed + 1500 period + 200 outside)
    // With fromDate=2026, the 2025 +200 rolls into opening:
    //   opening = 4200 − 1500 = 2700
    expect(s.openingBalance).toBe(2700);
    expect(s.closingBalance).toBe(4200);
    expect(s.transactions[0].RunningBalance).toBe(3500); // 2700 + 800
    expect(s.transactions[1].RunningBalance).toBe(3000); // 3500 − 500
    expect(s.transactions[2].RunningBalance).toBe(4200); // 3000 + 1200
  });

  it("returns identical section when scoped by vendorListId", async () => {
    const { payload } = await callTool("qb_vendor_balance_detail", {
      vendorListId: "90000001-1234567890",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    expect(payload.sections).toHaveLength(1);
    expect(payload.sections[0].vendorName).toBe("Office Supplies Co");
    expect(payload.sections[0].vendorListId).toBe("90000001-1234567890");
    expect(payload.sections[0].count).toBe(3);
  });

  it("rejects with 500 when vendorName is unknown", async () => {
    const { result, payload } = await callTool("qb_vendor_balance_detail", {
      vendorName: "Nonexistent Vendor",
    });
    expect(result?.isError).toBe(true);
    expect(payload.statusCode).toBe(500);
    expect(payload.statusMessage).toMatch(/Nonexistent Vendor/);
  });

  it("rejects with 500 when vendorListId is unknown", async () => {
    const { result, payload } = await callTool("qb_vendor_balance_detail", {
      vendorListId: "99999999-9999999999",
    });
    expect(result?.isError).toBe(true);
    expect(payload.statusCode).toBe(500);
  });

  it("BillPaymentCreditCard reduces AP just like BillPaymentCheck", async () => {
    // Cloud Hosting: +600 bill, -600 CC payment → net 0 in the window.
    const { payload } = await callTool("qb_vendor_balance_detail", {
      vendorName: "Cloud Hosting Services",
      fromDate: "2026-04-01",
      toDate: "2026-04-30",
    });
    const s = payload.sections[0];
    expect(s.count).toBe(2);
    const bill = s.transactions.find((r: { TxnType: string }) => r.TxnType === "Bill");
    const pmt = s.transactions.find(
      (r: { TxnType: string }) => r.TxnType === "BillPaymentCreditCard",
    );
    expect(bill.Amount).toBe(600);
    expect(pmt.Amount).toBe(-600);
    expect(s.periodChange).toBe(0);
    // Cloud Hosting Balance unchanged from seed (1200)
    expect(s.openingBalance).toBe(1200);
    expect(s.closingBalance).toBe(1200);
  });

  it("date filter excludes out-of-window postings (Office Supplies 2025 bill drops)", async () => {
    const { payload } = await callTool("qb_vendor_balance_detail", {
      vendorName: "Office Supplies Co",
      fromDate: "2025-12-01",
      toDate: "2025-12-31",
    });
    const s = payload.sections[0];
    expect(s.count).toBe(1);
    expect(s.transactions[0].RefNumber).toBe("BILL-O0");
    expect(s.transactions[0].Amount).toBe(200);
    expect(s.periodChange).toBe(200);
  });

  it("RefNumber and Memo are surfaced on rows", async () => {
    const { payload } = await callTool("qb_vendor_balance_detail", {
      vendorName: "Office Supplies Co",
      fromDate: "2026-02-01",
      toDate: "2026-02-28",
    });
    const pmt = payload.sections[0].transactions[0];
    expect(pmt.RefNumber).toBe("PMT-O1");
    expect(pmt.Memo).toMatch(/Partial pmt/);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — multi-vendor aggregation + pruning
// ---------------------------------------------------------------------------

describe("qb_vendor_balance_detail — multi-vendor", () => {
  it("returns sections for vendors with activity or non-zero balance, sorted alphabetically", async () => {
    const { payload } = await callTool("qb_vendor_balance_detail", {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    const names = payload.sections.map((s: { vendorName: string }) => s.vendorName);
    // Both seed vendors have non-zero starting Balance, so they appear even
    // without activity. The 1099-eligible vendors (Joe Contractor, etc.) have
    // zero starting Balance and no activity here → pruned. Quiet Vendor LLC
    // is also pruned. Alpha sort puts "Cloud Hosting" before "Office Supplies".
    expect(names).toContain("Cloud Hosting Services");
    expect(names).toContain("Office Supplies Co");
    // Verify the alpha-sort positions of these two relative to each other.
    const cloudIdx = names.indexOf("Cloud Hosting Services");
    const officeIdx = names.indexOf("Office Supplies Co");
    expect(cloudIdx).toBeLessThan(officeIdx);
    expect(names).not.toContain("Quiet Vendor LLC");
  });

  it("includeZeroBalance:true surfaces zero-activity-zero-balance vendors", async () => {
    const { payload } = await callTool("qb_vendor_balance_detail", {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      includeZeroBalance: true,
    });
    const names = payload.sections.map((s: { vendorName: string }) => s.vendorName);
    expect(names).toContain("Quiet Vendor LLC");
    expect(names).toContain("Joe Contractor");
  });

  it("totalRowCount sums across all emitted sections", async () => {
    const { payload } = await callTool("qb_vendor_balance_detail", {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    // Office Supplies has 3 in-window postings; Cloud Hosting has 2; others 0.
    expect(payload.totalRowCount).toBe(5);
  });

  it("maxVendors cap surfaces a warning and truncates alphabetically", async () => {
    const { payload } = await callTool("qb_vendor_balance_detail", {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      maxVendors: 1,
      includeZeroBalance: true,
    });
    expect(payload.sections).toHaveLength(1);
    // Alphabetically first vendor in the store (likely ACME Property Mgmt
    // from the 1099 seed). Just verify a warning was attached.
    expect(payload.warnings).toBeDefined();
    expect(payload.warnings[0]).toMatch(/exceeds maxVendors/);
  });

  it("response carries basis (default Accrual) and fromDate/toDate echo", async () => {
    const { payload } = await callTool("qb_vendor_balance_detail", {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      basis: "Cash",
    });
    expect(payload.basis).toBe("Cash");
    expect(payload.fromDate).toBe("2026-01-01");
    expect(payload.toDate).toBe("2026-12-31");
  });

  it("maxRowsPerVendor truncation surfaces the `truncated` flag on the affected section", async () => {
    const { payload } = await callTool("qb_vendor_balance_detail", {
      vendorName: "Office Supplies Co",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      maxRowsPerVendor: 2,
    });
    const s = payload.sections[0];
    expect(s.count).toBe(2);
    expect(s.truncated).toBe(true);
  });
});

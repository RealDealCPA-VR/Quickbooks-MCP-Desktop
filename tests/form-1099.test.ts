// Phase 10 #44 — qb_1099_summary + qb_1099_detail.
//
// Coverage layers:
//   1. Pure helpers — date-window resolution (taxYear default, explicit override),
//      vendor classification (NEC/MISC), bill-line totaling.
//   2. Aggregation — aggregate1099Totals walks Bill + Check stores, sums per
//      vendor, ignores ineligible vendors, ignores out-of-window transactions.
//   3. Tool surface — qb_1099_summary returns sorted-desc rows + totals,
//      threshold filter, includeBelowThreshold, formType filter, defaults.
//      qb_1099_detail returns per-transaction breakdown, single-vendor scope,
//      empty-result-not-error semantics.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import {
  registerForm1099Tools,
  aggregate1099Totals,
  classifyVendorForm,
  resolveDateWindow,
  defaultLastCompletedTaxYear,
  billOriginalTotal,
} from "../src/tools/form-1099.js";

type Handler = (args: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

const handlers = new Map<string, Handler>();
const fakeServer = {
  tool: (
    name: string,
    _description: string,
    _schema: Record<string, z.ZodTypeAny>,
    handler: Handler,
  ) => {
    handlers.set(name, handler);
  },
};

function freshSession(): QBSessionManager {
  return new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-1099",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

// Seed a fresh session with the standard 1099-eligible vendors PLUS the
// transaction fixtures the tests need. Bills go through addEntity so the
// handleAdd path runs (computes AmountDue from lines, populates *LineRet).
async function seedFixtures(
  session: QBSessionManager,
  opts: { joeBillAmount?: number; sarahBillAmount?: number; rentBillAmount?: number; joeCheckAmount?: number; outOfWindowBillAmount?: number; ineligibleVendorBillAmount?: number } = {}
): Promise<void> {
  await session.openSession();

  const joeBillAmount = opts.joeBillAmount ?? 2500;
  const sarahBillAmount = opts.sarahBillAmount ?? 450;
  const rentBillAmount = opts.rentBillAmount ?? 12000;
  const joeCheckAmount = opts.joeCheckAmount ?? 3500;

  // Joe Contractor — TY2024, NEC, above threshold (2500 bill + 3500 check = 6000)
  await session.addEntity("Bill", {
    VendorRef: { FullName: "Joe Contractor" },
    TxnDate: "2024-03-15",
    DueDate: "2024-04-14",
    RefNumber: "B-JC-001",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Payroll Expense" }, Amount: joeBillAmount, Memo: "Q1 contracting" },
    ],
    Memo: "Q1 contracting services",
  });

  await session.addEntity("Check", {
    PayeeEntityRef: { FullName: "Joe Contractor" },
    AccountRef: { FullName: "Checking" },
    TxnDate: "2024-06-30",
    RefNumber: "1042",
    Amount: joeCheckAmount,
    Memo: "Q2 contracting services",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Payroll Expense" }, Amount: joeCheckAmount, Memo: "Q2 contracting" },
    ],
  });

  // Sarah Designer LLC — TY2024, NEC, below threshold (450)
  await session.addEntity("Bill", {
    VendorRef: { FullName: "Sarah Designer LLC" },
    TxnDate: "2024-09-15",
    DueDate: "2024-10-15",
    RefNumber: "B-SD-001",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Payroll Expense" }, Amount: sarahBillAmount, Memo: "Logo" },
    ],
    Memo: "Logo design",
  });

  // ACME Property Mgmt — TY2024, MISC, well above threshold (12000)
  await session.addEntity("Bill", {
    VendorRef: { FullName: "ACME Property Mgmt" },
    TxnDate: "2024-04-01",
    DueDate: "2024-04-15",
    RefNumber: "B-AP-001",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Rent Expense" }, Amount: rentBillAmount, Memo: "FY2024 rent" },
    ],
    Memo: "FY2024 office rent",
  });

  // Out-of-window control: TY2025 bill to Joe — must NOT appear in TY2024 results.
  if (opts.outOfWindowBillAmount !== undefined) {
    await session.addEntity("Bill", {
      VendorRef: { FullName: "Joe Contractor" },
      TxnDate: "2025-01-15",
      DueDate: "2025-02-15",
      RefNumber: "B-JC-002",
      ExpenseLineAdd: [
        { AccountRef: { FullName: "Payroll Expense" }, Amount: opts.outOfWindowBillAmount },
      ],
    });
  }

  // Ineligible-vendor control: bill to Office Supplies Co (not 1099-flagged).
  if (opts.ineligibleVendorBillAmount !== undefined) {
    await session.addEntity("Bill", {
      VendorRef: { FullName: "Office Supplies Co" },
      TxnDate: "2024-05-01",
      DueDate: "2024-06-01",
      RefNumber: "B-OS-001",
      ExpenseLineAdd: [
        { AccountRef: { FullName: "Utilities" }, Amount: opts.ineligibleVendorBillAmount },
      ],
    });
  }
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — pure helpers
// ---------------------------------------------------------------------------

describe("Layer 1 — pure helpers", () => {
  it("classifyVendorForm — defaults to NEC", () => {
    expect(classifyVendorForm({})).toBe("NEC");
    expect(classifyVendorForm({ Vendor1099Type: "NEC" })).toBe("NEC");
  });

  it("classifyVendorForm — MISC and 1099-MISC both map to MISC", () => {
    expect(classifyVendorForm({ Vendor1099Type: "MISC" })).toBe("MISC");
    expect(classifyVendorForm({ Vendor1099Type: "1099-MISC" })).toBe("MISC");
    expect(classifyVendorForm({ Vendor1099Type: "misc" })).toBe("MISC");
  });

  it("resolveDateWindow — taxYear sets fromDate/toDate to year span", () => {
    expect(resolveDateWindow({ taxYear: 2024 })).toEqual({
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
      taxYear: 2024,
    });
  });

  it("resolveDateWindow — explicit fromDate/toDate override taxYear", () => {
    const r = resolveDateWindow({ taxYear: 2024, fromDate: "2024-06-01", toDate: "2024-12-31" });
    expect(r.fromDate).toBe("2024-06-01");
    expect(r.toDate).toBe("2024-12-31");
    expect(r.taxYear).toBe(2024); // surfaced as informational only
  });

  it("resolveDateWindow — no args defaults to last completed year", () => {
    const r = resolveDateWindow({});
    const expected = defaultLastCompletedTaxYear();
    expect(r.taxYear).toBe(expected);
    expect(r.fromDate).toBe(`${expected}-01-01`);
    expect(r.toDate).toBe(`${expected}-12-31`);
  });

  it("billOriginalTotal — sums ExpenseLineRet + ItemLineRet", () => {
    expect(
      billOriginalTotal({
        ExpenseLineRet: [{ Amount: 100 }, { Amount: 250 }],
        ItemLineRet: [{ Amount: 75 }],
      })
    ).toBe(425);
  });

  it("billOriginalTotal — falls back to AmountDue when lines are stripped", () => {
    expect(billOriginalTotal({ AmountDue: 999 })).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — aggregation
// ---------------------------------------------------------------------------

describe("Layer 2 — aggregate1099Totals", () => {
  it("sums Bill + Check per vendor for the date window", async () => {
    const session = freshSession();
    await seedFixtures(session);

    const aggs = await aggregate1099Totals(session, {
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });

    expect(aggs.size).toBe(3);

    const joe = [...aggs.values()].find((a) => a.fullName === "Joe Contractor");
    expect(joe).toBeDefined();
    expect(joe!.formType).toBe("NEC");
    expect(joe!.billCount).toBe(1);
    expect(joe!.billTotal).toBe(2500);
    expect(joe!.checkCount).toBe(1);
    expect(joe!.checkTotal).toBe(3500);

    const sarah = [...aggs.values()].find((a) => a.fullName === "Sarah Designer LLC");
    expect(sarah!.billCount).toBe(1);
    expect(sarah!.billTotal).toBe(450);
    expect(sarah!.checkCount).toBe(0);

    const rent = [...aggs.values()].find((a) => a.fullName === "ACME Property Mgmt");
    expect(rent!.formType).toBe("MISC");
    expect(rent!.billTotal).toBe(12000);
  });

  it("excludes ineligible vendors (IsVendorEligibleFor1099 !== true)", async () => {
    const session = freshSession();
    await seedFixtures(session, { ineligibleVendorBillAmount: 5000 });

    const aggs = await aggregate1099Totals(session, {
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });

    // Office Supplies Co is non-1099 — even though it has a 5000 bill,
    // it shouldn't appear in the aggregates.
    const officeSupplies = [...aggs.values()].find((a) => a.fullName === "Office Supplies Co");
    expect(officeSupplies).toBeUndefined();
    expect(aggs.size).toBe(3);
  });

  it("excludes out-of-window transactions", async () => {
    const session = freshSession();
    await seedFixtures(session, { outOfWindowBillAmount: 9999 });

    const aggs = await aggregate1099Totals(session, {
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });

    const joe = [...aggs.values()].find((a) => a.fullName === "Joe Contractor");
    // Joe's TY2025 bill (9999) should NOT count toward TY2024 aggregate.
    expect(joe!.billTotal).toBe(2500);
    expect(joe!.checkTotal).toBe(3500);
  });

  it("returns empty when no transactions match", async () => {
    const session = freshSession();
    await session.openSession();

    const aggs = await aggregate1099Totals(session, {
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });
    expect(aggs.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — qb_1099_summary tool
// ---------------------------------------------------------------------------

async function callTool(name: string, args: Record<string, unknown>): Promise<{
  payload: Record<string, unknown>;
  result: { isError?: boolean };
}> {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`Tool not registered: ${name}`);
  const result = await handler(args);
  const payload = JSON.parse(result.content[0].text);
  return { payload, result };
}

describe("Layer 3 — qb_1099_summary", () => {
  it("returns sorted-desc vendor rows above threshold by default", async () => {
    const session = freshSession();
    await seedFixtures(session);
    registerForm1099Tools(fakeServer as never, () => session);

    const { payload } = await callTool("qb_1099_summary", { taxYear: 2024 });

    expect(payload.taxYear).toBe(2024);
    expect(payload.fromDate).toBe("2024-01-01");
    expect(payload.toDate).toBe("2024-12-31");
    expect(payload.threshold).toBe(600);
    expect(payload.formType).toBe("all");
    expect(payload.totalEligibleVendors).toBe(3);
    expect(payload.vendorsAboveThreshold).toBe(2);
    expect(payload.vendorsBelowThreshold).toBe(1);

    const totalsByForm = payload.totalsByForm as Record<string, number>;
    expect(totalsByForm.NEC).toBe(6450); // Joe 6000 + Sarah 450
    expect(totalsByForm.MISC).toBe(12000); // ACME

    // Default: includes ABOVE-threshold vendors only — Sarah (450) is excluded.
    const vendors = payload.vendors as Array<Record<string, unknown>>;
    expect(vendors).toHaveLength(2);
    expect(vendors[0].vendorName).toBe("ACME Property Mgmt"); // 12000 highest
    expect(vendors[0].formType).toBe("MISC");
    expect(vendors[0].totalPaid).toBe(12000);
    expect(vendors[0].taxId).toBe("11-2233445");
    expect(vendors[1].vendorName).toBe("Joe Contractor"); // 6000
    expect(vendors[1].billCount).toBe(1);
    expect(vendors[1].checkCount).toBe(1);
  });

  it("includeBelowThreshold:true surfaces sub-threshold vendors", async () => {
    const session = freshSession();
    await seedFixtures(session);
    registerForm1099Tools(fakeServer as never, () => session);

    const { payload } = await callTool("qb_1099_summary", {
      taxYear: 2024,
      includeBelowThreshold: true,
    });

    const vendors = payload.vendors as Array<Record<string, unknown>>;
    expect(vendors).toHaveLength(3); // Sarah (450) now appears
    const sarah = vendors.find((v) => v.vendorName === "Sarah Designer LLC");
    expect(sarah).toBeDefined();
    expect(sarah!.totalPaid).toBe(450);
    expect(sarah!.meetsThreshold).toBe(false);
  });

  it("threshold override changes which vendors appear", async () => {
    const session = freshSession();
    await seedFixtures(session);
    registerForm1099Tools(fakeServer as never, () => session);

    const { payload } = await callTool("qb_1099_summary", {
      taxYear: 2024,
      threshold: 7000,
    });

    // Only ACME (12000) clears 7000.
    const vendors = payload.vendors as Array<Record<string, unknown>>;
    expect(vendors).toHaveLength(1);
    expect(vendors[0].vendorName).toBe("ACME Property Mgmt");
    expect(payload.threshold).toBe(7000);
  });

  it("formType:NEC excludes MISC vendors", async () => {
    const session = freshSession();
    await seedFixtures(session);
    registerForm1099Tools(fakeServer as never, () => session);

    const { payload } = await callTool("qb_1099_summary", {
      taxYear: 2024,
      formType: "NEC",
    });

    const vendors = payload.vendors as Array<Record<string, unknown>>;
    // ACME (MISC) excluded; only Joe surfaces above-threshold.
    expect(vendors).toHaveLength(1);
    expect(vendors[0].vendorName).toBe("Joe Contractor");
    expect(payload.formType).toBe("NEC");
  });

  it("formType:MISC excludes NEC vendors", async () => {
    const session = freshSession();
    await seedFixtures(session);
    registerForm1099Tools(fakeServer as never, () => session);

    const { payload } = await callTool("qb_1099_summary", {
      taxYear: 2024,
      formType: "MISC",
    });

    const vendors = payload.vendors as Array<Record<string, unknown>>;
    expect(vendors).toHaveLength(1);
    expect(vendors[0].vendorName).toBe("ACME Property Mgmt");
  });

  it("explicit fromDate/toDate overrides taxYear", async () => {
    const session = freshSession();
    await seedFixtures(session);
    registerForm1099Tools(fakeServer as never, () => session);

    // Q3-only window (Jul-Sep 2024). Sarah's bill (Sep) lands in window;
    // Joe's bill (Mar) and check (Jun) are out, ACME's bill (Apr) is out.
    const { payload } = await callTool("qb_1099_summary", {
      fromDate: "2024-07-01",
      toDate: "2024-09-30",
      includeBelowThreshold: true,
    });

    expect(payload.fromDate).toBe("2024-07-01");
    expect(payload.toDate).toBe("2024-09-30");
    const vendors = payload.vendors as Array<Record<string, unknown>>;
    expect(vendors).toHaveLength(1);
    expect(vendors[0].vendorName).toBe("Sarah Designer LLC");
    expect(vendors[0].totalPaid).toBe(450);
  });

  it("vendor row carries taxId + address from vendor record", async () => {
    const session = freshSession();
    await seedFixtures(session);
    registerForm1099Tools(fakeServer as never, () => session);

    const { payload } = await callTool("qb_1099_summary", { taxYear: 2024 });
    const acme = (payload.vendors as Array<Record<string, unknown>>)[0];
    expect(acme.taxId).toBe("11-2233445");
    const address = acme.address as Record<string, string>;
    expect(address.city).toBe("Chicago");
    expect(address.state).toBe("IL");
    expect(address.postalCode).toBe("60601");
  });

  it("default taxYear (no arg) maps to last completed year", async () => {
    const session = freshSession();
    await session.openSession();
    registerForm1099Tools(fakeServer as never, () => session);

    const { payload } = await callTool("qb_1099_summary", {});
    const expected = defaultLastCompletedTaxYear();
    expect(payload.taxYear).toBe(expected);
    expect(payload.fromDate).toBe(`${expected}-01-01`);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — qb_1099_detail tool
// ---------------------------------------------------------------------------

describe("Layer 4 — qb_1099_detail", () => {
  it("returns per-transaction breakdown across vendors", async () => {
    const session = freshSession();
    await seedFixtures(session);
    registerForm1099Tools(fakeServer as never, () => session);

    const { payload } = await callTool("qb_1099_detail", { taxYear: 2024 });

    const vendors = payload.vendors as Array<Record<string, unknown>>;
    expect(vendors).toHaveLength(3);

    const joe = vendors.find((v) => v.vendorName === "Joe Contractor")!;
    const txns = joe.transactions as Array<Record<string, unknown>>;
    expect(txns).toHaveLength(2);
    // Sorted by txnDate ascending — Bill 2024-03-15 before Check 2024-06-30.
    expect(txns[0].type).toBe("Bill");
    expect(txns[0].txnDate).toBe("2024-03-15");
    expect(txns[0].total).toBe(2500);
    expect(txns[1].type).toBe("Check");
    expect(txns[1].txnDate).toBe("2024-06-30");
    expect(txns[1].total).toBe(3500);
    // Each transaction surfaces its line breakdown.
    const billLines = txns[0].lines as Array<Record<string, unknown>>;
    expect(billLines).toHaveLength(1);
    expect(billLines[0].accountName).toBe("Payroll Expense");
    expect(billLines[0].amount).toBe(2500);
  });

  it("vendorFullName scopes to a single vendor", async () => {
    const session = freshSession();
    await seedFixtures(session);
    registerForm1099Tools(fakeServer as never, () => session);

    const { payload } = await callTool("qb_1099_detail", {
      taxYear: 2024,
      vendorFullName: "Joe Contractor",
    });
    const vendors = payload.vendors as Array<Record<string, unknown>>;
    expect(vendors).toHaveLength(1);
    expect(vendors[0].vendorName).toBe("Joe Contractor");
    expect(vendors[0].totalPaid).toBe(6000);
  });

  it("vendorListId scopes to a single vendor by ListID", async () => {
    const session = freshSession();
    await seedFixtures(session);
    registerForm1099Tools(fakeServer as never, () => session);

    const { payload } = await callTool("qb_1099_detail", {
      taxYear: 2024,
      vendorListId: "90000005-1234567890",
    });
    const vendors = payload.vendors as Array<Record<string, unknown>>;
    expect(vendors).toHaveLength(1);
    expect(vendors[0].vendorName).toBe("ACME Property Mgmt");
  });

  it("vendor with no activity returns empty list (success, not error)", async () => {
    const session = freshSession();
    await seedFixtures(session);
    registerForm1099Tools(fakeServer as never, () => session);

    const { payload, result } = await callTool("qb_1099_detail", {
      taxYear: 2024,
      vendorFullName: "Nonexistent Vendor",
    });
    expect(result.isError).toBeFalsy();
    expect(payload.vendors).toEqual([]);
  });

  it("formType filter applies to detail output", async () => {
    const session = freshSession();
    await seedFixtures(session);
    registerForm1099Tools(fakeServer as never, () => session);

    const { payload } = await callTool("qb_1099_detail", {
      taxYear: 2024,
      formType: "MISC",
    });
    const vendors = payload.vendors as Array<Record<string, unknown>>;
    expect(vendors).toHaveLength(1);
    expect(vendors[0].vendorName).toBe("ACME Property Mgmt");
  });
});

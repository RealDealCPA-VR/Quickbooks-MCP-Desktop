// Phase 17 #77 — Sales tax tool surface tests.
//
// Coverage layers:
//   1. Sim handler — seed loads (codes / items / groups / agencies / taxed
//      receipt), SalesTaxLiability report walks the right entities,
//      SalesTaxPaymentCheck handleAdd derives TotalAmount + reduces TaxPaid
//      on next liability run, generic *QueryRq filters work for all new
//      list types.
//   2. qb_sales_tax_code_list — happy path, filters, error surface.
//   3. qb_sales_tax_item_list — fan-out across Item + Group, taxItemType
//      scope, ItemType discriminator stamped per row, filters.
//   4. qb_sales_tax_agency_list — derive distinct agencies, vendor
//      enrichment opt-out, taxItems-per-agency rollup, fail-soft on
//      missing vendor.
//   5. qb_sales_tax_liability_report — happy path with seed (TechStart
//      receipt → IL liability), date filter, per-agency rollup, totals,
//      empty period, mid-period payment reduces TaxPaid + TaxPayable.
//   6. qb_sales_tax_payment_create — happy path (single + multi-line), bank/
//      payee validation, idempotency replay + 9002 conflict, read-only 9001,
//      TotalAmount derives from line sum.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerSalesTaxTools } from "../src/tools/sales-tax.js";

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
    appName: "vitest-sales-tax",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — sim handler / seed
// ---------------------------------------------------------------------------

describe("SimulationStore — sales-tax seed", () => {
  it("seeds three SalesTaxCode rows (TAX, NON, OUT)", async () => {
    const session = freshSession();
    const codes = await session.queryEntity("SalesTaxCode", {});
    const names = codes.map((c) => String(c.Name)).sort();
    expect(names).toEqual(["NON", "OUT", "TAX"]);
    const tax = codes.find((c) => c.Name === "TAX");
    expect(tax?.IsTaxable).toBe(true);
    const non = codes.find((c) => c.Name === "NON");
    expect(non?.IsTaxable).toBe(false);
  });

  it("seeds three ItemSalesTax rows with TaxRate + TaxVendorRef", async () => {
    const session = freshSession();
    const items = await session.queryEntity("ItemSalesTax", {});
    expect(items.length).toBe(3);
    const il = items.find((i) => i.Name === "IL State Tax");
    expect(il?.TaxRate).toBe(7.5);
    expect((il?.TaxVendorRef as { FullName: string }).FullName).toBe(
      "IL Department of Revenue",
    );
  });

  it("seeds one ItemSalesTaxGroup bundling two CA items", async () => {
    const session = freshSession();
    const groups = await session.queryEntity("ItemSalesTaxGroup", {});
    expect(groups.length).toBe(1);
    const grp = groups[0];
    expect(grp.Name).toBe("CA-LA Combined");
    const refs = grp.ItemSalesTaxRef as Array<{ FullName: string }>;
    expect(refs.length).toBe(2);
    expect(refs.map((r) => r.FullName).sort()).toEqual([
      "CA County Tax",
      "CA State Tax",
    ]);
  });

  it("seeds two sales-tax agency vendors (IL DoR + CA SBoE)", async () => {
    const session = freshSession();
    const vendors = await session.queryEntity("Vendor", {});
    const agencies = vendors.filter((v) => v.IsSalesTaxAgency === true);
    expect(agencies.length).toBe(2);
    const names = agencies.map((a) => String(a.FullName)).sort();
    expect(names).toEqual([
      "CA State Board of Equalization",
      "IL Department of Revenue",
    ]);
  });

  it("seeds one taxed SalesReceipt against TechStart (T0000001-SR, IL tax, $75)", async () => {
    const session = freshSession();
    const receipts = await session.queryEntity("SalesReceipt", {
      TxnID: "T0000001-SR",
    });
    expect(receipts.length).toBe(1);
    const sr = receipts[0];
    expect(sr.SalesTaxTotal).toBe(75);
    expect(sr.TotalAmount).toBe(1075);
    expect((sr.ItemSalesTaxRef as { FullName: string }).FullName).toBe(
      "IL State Tax",
    );
  });

  it("taxed SalesReceipt does NOT shift TechStart customer Balance (cash sale)", async () => {
    const session = freshSession();
    const customers = await session.queryEntity("Customer", {
      ListID: "80000003-1234567890",
    });
    expect(customers[0].Balance).toBe(3200);
  });
});

describe("SimulationStore — SalesTaxLiability report walk", () => {
  it("returns IL row with $75 TaxCollected against fresh seed", async () => {
    const session = freshSession();
    const reportRet = await session.runReport("SalesTaxLiability", {});
    const rows = reportRet.Rows as Array<Record<string, unknown>>;
    const il = rows.find((r) => r.TaxItemName === "IL State Tax");
    expect(il).toBeDefined();
    expect(il?.TaxCollected).toBe(75);
    expect(il?.TaxPaid).toBe(0);
    expect(il?.TaxPayable).toBe(75);
    expect(il?.AgencyName).toBe("IL Department of Revenue");
    expect(il?.TaxRate).toBe(7.5);
  });

  it("CA items show zero TaxCollected against fresh seed (no CA-taxed txns)", async () => {
    const session = freshSession();
    const reportRet = await session.runReport("SalesTaxLiability", {});
    const rows = reportRet.Rows as Array<Record<string, unknown>>;
    const ca = rows.filter(
      (r) => r.AgencyName === "CA State Board of Equalization",
    );
    expect(ca.length).toBe(2);
    for (const r of ca) {
      expect(r.TaxCollected).toBe(0);
      expect(r.TaxPaid).toBe(0);
      expect(r.TaxPayable).toBe(0);
    }
  });

  it("date filter excludes the seeded SR (dated 2025-01-15)", async () => {
    const session = freshSession();
    const reportRet = await session.runReport("SalesTaxLiability", {
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });
    const rows = reportRet.Rows as Array<Record<string, unknown>>;
    const il = rows.find((r) => r.TaxItemName === "IL State Tax");
    expect(il?.TaxCollected).toBe(0);
    expect(il?.TaxPayable).toBe(0);
  });

  it("per-agency rollup sums tax items belonging to the same agency", async () => {
    const session = freshSession();
    const reportRet = await session.runReport("SalesTaxLiability", {});
    const byAgency = reportRet.ByAgency as Array<Record<string, unknown>>;
    expect(byAgency.length).toBe(2);
    const il = byAgency.find((a) => a.AgencyName === "IL Department of Revenue");
    expect(il?.TaxCollected).toBe(75);
    expect(il?.TaxPayable).toBe(75);
  });

  it("grand totals match the per-row sums", async () => {
    const session = freshSession();
    const reportRet = await session.runReport("SalesTaxLiability", {});
    const totals = reportRet.Totals as Record<string, number>;
    expect(totals.TaxCollected).toBe(75);
    expect(totals.TaxPaid).toBe(0);
    expect(totals.TaxPayable).toBe(75);
  });

  it("CreditMemo with ItemSalesTaxRef SUBTRACTS from TaxCollected", async () => {
    const session = freshSession();
    // Seed: $75 collected. Add a CM that returns $25 of that tax.
    await session.addEntity("CreditMemo", {
      CustomerRef: { ListID: "80000003-1234567890" },
      TxnDate: "2025-02-01",
      ItemSalesTaxRef: { ListID: "I0000010", FullName: "IL State Tax" },
      SalesTaxTotal: 25,
      CreditMemoLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Amount: 333 },
      ],
    });
    const reportRet = await session.runReport("SalesTaxLiability", {});
    const rows = reportRet.Rows as Array<Record<string, unknown>>;
    const il = rows.find((r) => r.TaxItemName === "IL State Tax");
    expect(il?.TaxCollected).toBe(50); // 75 - 25
  });

  it("SalesTaxPaymentCheck reduces TaxPaid + TaxPayable on next run", async () => {
    const session = freshSession();
    // Pay $40 against IL liability.
    await session.addEntity("SalesTaxPaymentCheck", {
      BankAccountRef: { ListID: "A0000001", FullName: "Checking" },
      TxnDate: "2025-02-15",
      RefNumber: "STP-001",
      PayeeEntityRef: { FullName: "IL Department of Revenue" },
      Memo: "Partial Q1",
      SalesTaxPaymentCheckLineAdd: [
        {
          ItemSalesTaxRef: { ListID: "I0000010", FullName: "IL State Tax" },
          Amount: 40,
        },
      ],
    });
    const reportRet = await session.runReport("SalesTaxLiability", {});
    const rows = reportRet.Rows as Array<Record<string, unknown>>;
    const il = rows.find((r) => r.TaxItemName === "IL State Tax");
    expect(il?.TaxCollected).toBe(75);
    expect(il?.TaxPaid).toBe(40);
    expect(il?.TaxPayable).toBe(35);
  });
});

describe("SimulationStore — SalesTaxPaymentCheck handleAdd", () => {
  it("derives TotalAmount = sum(SalesTaxPaymentCheckLineRet.Amount) when undefined", async () => {
    const session = freshSession();
    const stp = await session.addEntity("SalesTaxPaymentCheck", {
      BankAccountRef: { FullName: "Checking" },
      PayeeEntityRef: { FullName: "IL Department of Revenue" },
      TxnDate: "2025-02-15",
      SalesTaxPaymentCheckLineAdd: [
        { ItemSalesTaxRef: { FullName: "IL State Tax" }, Amount: 100 },
        { ItemSalesTaxRef: { FullName: "CA State Tax" }, Amount: 200 },
      ],
    });
    expect(stp.TotalAmount).toBe(300);
    expect(Array.isArray(stp.SalesTaxPaymentCheckLineRet)).toBe(true);
    expect((stp.SalesTaxPaymentCheckLineRet as unknown[]).length).toBe(2);
  });

  it("explicit TotalAmount on create wins over derived sum", async () => {
    const session = freshSession();
    const stp = await session.addEntity("SalesTaxPaymentCheck", {
      BankAccountRef: { FullName: "Checking" },
      PayeeEntityRef: { FullName: "IL Department of Revenue" },
      TxnDate: "2025-02-15",
      TotalAmount: 999,
      SalesTaxPaymentCheckLineAdd: [
        { ItemSalesTaxRef: { FullName: "IL State Tax" }, Amount: 50 },
      ],
    });
    expect(stp.TotalAmount).toBe(999);
  });

  it("defaults to ClearedStatus: NotCleared (bank-affecting)", async () => {
    const session = freshSession();
    const stp = await session.addEntity("SalesTaxPaymentCheck", {
      BankAccountRef: { FullName: "Checking" },
      PayeeEntityRef: { FullName: "IL Department of Revenue" },
      TxnDate: "2025-02-15",
      SalesTaxPaymentCheckLineAdd: [
        { ItemSalesTaxRef: { FullName: "IL State Tax" }, Amount: 50 },
      ],
    });
    expect(stp.ClearedStatus).toBe("NotCleared");
    expect(stp.TxnID).toBeDefined();
    expect(stp.EditSequence).toBeDefined();
  });

  it("delete via TxnDelRq (not ListDelRq) — three transaction-type lists in sync", async () => {
    const session = freshSession();
    const stp = await session.addEntity("SalesTaxPaymentCheck", {
      BankAccountRef: { FullName: "Checking" },
      PayeeEntityRef: { FullName: "IL Department of Revenue" },
      TxnDate: "2025-02-15",
      SalesTaxPaymentCheckLineAdd: [
        { ItemSalesTaxRef: { FullName: "IL State Tax" }, Amount: 50 },
      ],
    });
    const deleted = await session.deleteEntity(
      "SalesTaxPaymentCheck",
      String(stp.TxnID),
    );
    expect(deleted.TxnDelType).toBe("SalesTaxPaymentCheck");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — qb_sales_tax_code_list
// ---------------------------------------------------------------------------

describe("qb_sales_tax_code_list tool", () => {
  it("happy path returns the three seeded codes", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_code_list")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(3);
    const names = payload.salesTaxCodes
      .map((c: { Name: string }) => c.Name)
      .sort();
    expect(names).toEqual(["NON", "OUT", "TAX"]);
  });

  it("nameFilter narrows by Contains match", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_code_list")!;

    const result = await handler({ nameFilter: "TAX" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.salesTaxCodes[0].Name).toBe("TAX");
  });

  it("listId fetches a specific code", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_code_list")!;

    const result = await handler({ listId: "STC0000002" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.salesTaxCodes[0].Name).toBe("NON");
    expect(payload.salesTaxCodes[0].IsTaxable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — qb_sales_tax_item_list
// ---------------------------------------------------------------------------

describe("qb_sales_tax_item_list tool", () => {
  it("default fans across Item + Group, returns all four", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_item_list")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(4); // 3 items + 1 group
    const items = payload.salesTaxItems.filter(
      (i: { ItemType: string }) => i.ItemType === "SalesTaxItem",
    );
    const groups = payload.salesTaxItems.filter(
      (i: { ItemType: string }) => i.ItemType === "SalesTaxGroup",
    );
    expect(items.length).toBe(3);
    expect(groups.length).toBe(1);
  });

  it("taxItemType:Item scopes to ItemSalesTax only", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_item_list")!;

    const result = await handler({ taxItemType: "Item" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(3);
    expect(
      payload.salesTaxItems.every(
        (i: { ItemType: string }) => i.ItemType === "SalesTaxItem",
      ),
    ).toBe(true);
  });

  it("taxItemType:Group scopes to ItemSalesTaxGroup only", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_item_list")!;

    const result = await handler({ taxItemType: "Group" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.salesTaxItems[0].Name).toBe("CA-LA Combined");
    expect(payload.salesTaxItems[0].ItemType).toBe("SalesTaxGroup");
  });

  it("each item carries TaxRate + TaxVendorRef", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_item_list")!;

    const result = await handler({ taxItemType: "Item", nameFilter: "IL" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.salesTaxItems[0].TaxRate).toBe(7.5);
    expect(payload.salesTaxItems[0].TaxVendorRef.FullName).toBe(
      "IL Department of Revenue",
    );
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — qb_sales_tax_agency_list
// ---------------------------------------------------------------------------

describe("qb_sales_tax_agency_list tool", () => {
  it("derives two agencies from the seeded ItemSalesTax records", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_agency_list")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(2);
    const names = payload.agencies.map((a: { agencyName: string }) => a.agencyName);
    expect(names).toEqual([
      "CA State Board of Equalization",
      "IL Department of Revenue",
    ]);
  });

  it("each agency carries its sorted taxItems list", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_agency_list")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    const ca = payload.agencies.find(
      (a: { agencyName: string }) => a.agencyName === "CA State Board of Equalization",
    );
    expect(ca.taxItems.length).toBe(2);
    expect(ca.taxItems.map((i: { name: string }) => i.name)).toEqual([
      "CA County Tax",
      "CA State Tax",
    ]);
  });

  it("includeVendorDetails:true (default) enriches with full Vendor record", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_agency_list")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    const il = payload.agencies.find(
      (a: { agencyName: string }) => a.agencyName === "IL Department of Revenue",
    );
    expect(il.vendorDetails).not.toBeNull();
    expect(il.vendorDetails.Phone).toBe("217-782-3336");
    expect(il.vendorDetails.IsSalesTaxAgency).toBe(true);
  });

  it("includeVendorDetails:false omits the vendorDetails block entirely", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_agency_list")!;

    const result = await handler({ includeVendorDetails: false });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.agencies[0].vendorDetails).toBeUndefined();
  });

  it("each row carries taxRate per item (positional convenience)", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_agency_list")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    const il = payload.agencies.find(
      (a: { agencyName: string }) => a.agencyName === "IL Department of Revenue",
    );
    expect(il.taxItems[0].taxRate).toBe(7.5);
    expect(il.taxItems[0].name).toBe("IL State Tax");
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — qb_sales_tax_liability_report
// ---------------------------------------------------------------------------

describe("qb_sales_tax_liability_report tool", () => {
  it("happy path: surfaces $75 IL liability against fresh seed", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_liability_report")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.reportTitle).toBe("Sales Tax Liability");
    const il = payload.rows.find(
      (r: { taxItemName: string }) => r.taxItemName === "IL State Tax",
    );
    expect(il.taxCollected).toBe(75);
    expect(il.taxPaid).toBe(0);
    expect(il.taxPayable).toBe(75);
    expect(il.agencyName).toBe("IL Department of Revenue");
    expect(il.taxRate).toBe(7.5);
  });

  it("reportPeriod echoes operator-supplied dates", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_liability_report")!;

    const result = await handler({
      fromDate: "2025-01-01",
      toDate: "2025-12-31",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.reportPeriod.from).toBe("2025-01-01");
    expect(payload.reportPeriod.to).toBe("2025-12-31");
  });

  it("date filter excludes the seeded receipt (2024 window has no IL collection)", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_liability_report")!;

    const result = await handler({
      fromDate: "2024-01-01",
      toDate: "2024-12-31",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.totals.taxCollected).toBe(0);
    expect(payload.totals.taxPayable).toBe(0);
  });

  it("byAgency rollup totals the IL row to $75", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_liability_report")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.byAgency.length).toBe(2);
    const il = payload.byAgency.find(
      (a: { agencyName: string }) => a.agencyName === "IL Department of Revenue",
    );
    expect(il.taxCollected).toBe(75);
    expect(il.taxPayable).toBe(75);
  });

  it("grand totals reconcile to per-row sums", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_liability_report")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    const rowSum = payload.rows.reduce(
      (acc: number, r: { taxCollected: number }) => acc + r.taxCollected,
      0,
    );
    expect(payload.totals.taxCollected).toBe(rowSum);
  });

  it("after a payment, TaxPaid increases and TaxPayable decreases", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_liability_report")!;
    const payHandler = handlers.get("qb_sales_tax_payment_create")!;

    await payHandler({
      bankAccountName: "Checking",
      payeeName: "IL Department of Revenue",
      txnDate: "2025-02-15",
      lines: [{ salesTaxItemName: "IL State Tax", amount: 30 }],
    });

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    const il = payload.rows.find(
      (r: { taxItemName: string }) => r.taxItemName === "IL State Tax",
    );
    expect(il.taxCollected).toBe(75);
    expect(il.taxPaid).toBe(30);
    expect(il.taxPayable).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// Layer 6 — qb_sales_tax_payment_create
// ---------------------------------------------------------------------------

describe("qb_sales_tax_payment_create tool", () => {
  it("happy path single-line: returns success with derived TotalAmount", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_payment_create")!;

    const result = await handler({
      bankAccountName: "Checking",
      payeeName: "IL Department of Revenue",
      txnDate: "2025-02-15",
      refNumber: "STP-001",
      memo: "Q1 IL sales tax",
      lines: [{ salesTaxItemName: "IL State Tax", amount: 75 }],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.salesTaxPayment.TotalAmount).toBe(75);
    expect(payload.salesTaxPayment.RefNumber).toBe("STP-001");
    expect(payload.salesTaxPayment.TxnID).toBeDefined();
  });

  it("happy path multi-line: TotalAmount sums all lines", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_payment_create")!;

    const result = await handler({
      bankAccountName: "Checking",
      payeeName: "CA State Board of Equalization",
      lines: [
        { salesTaxItemName: "CA State Tax", amount: 100 },
        { salesTaxItemName: "CA County Tax", amount: 50 },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.salesTaxPayment.TotalAmount).toBe(150);
    expect(payload.salesTaxPayment.SalesTaxPaymentCheckLineRet.length).toBe(2);
  });

  it("rejects when bankAccountName + bankAccountListId both missing", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_payment_create")!;

    const result = await handler({
      payeeName: "IL Department of Revenue",
      lines: [{ salesTaxItemName: "IL State Tax", amount: 75 }],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("bankAccount");
  });

  it("rejects when payeeName + payeeListId both missing", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_payment_create")!;

    const result = await handler({
      bankAccountName: "Checking",
      lines: [{ salesTaxItemName: "IL State Tax", amount: 75 }],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("payee");
  });

  it("idempotency replay returns the same payment with idempotentReplay:true", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_payment_create")!;

    const args = {
      bankAccountName: "Checking",
      payeeName: "IL Department of Revenue",
      lines: [{ salesTaxItemName: "IL State Tax", amount: 50 }],
      idempotencyKey: "stp-test-key-1",
    };
    const first = JSON.parse((await handler(args)).content[0].text);
    const second = JSON.parse((await handler(args)).content[0].text);
    expect(first.success).toBe(true);
    expect(first.idempotentReplay).toBeUndefined();
    expect(second.success).toBe(true);
    expect(second.idempotentReplay).toBe(true);
    expect(second.salesTaxPayment.TxnID).toBe(first.salesTaxPayment.TxnID);
  });

  it("idempotency conflict (same key, different payload) returns 9002", async () => {
    const session = freshSession();
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_payment_create")!;

    const baseArgs = {
      bankAccountName: "Checking",
      payeeName: "IL Department of Revenue",
      lines: [{ salesTaxItemName: "IL State Tax", amount: 50 }],
      idempotencyKey: "stp-conflict-key",
    };
    await handler(baseArgs);
    const conflict = JSON.parse(
      (
        await handler({
          ...baseArgs,
          lines: [{ salesTaxItemName: "IL State Tax", amount: 999 }],
        })
      ).content[0].text,
    );
    expect(conflict.success).toBe(false);
    expect(conflict.statusCode).toBe(9002);
  });

  it("read-only session rejects with statusCode 9001", async () => {
    const session = freshSession();
    session.setReadOnly(true);
    registerSalesTaxTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_tax_payment_create")!;

    const result = await handler({
      bankAccountName: "Checking",
      payeeName: "IL Department of Revenue",
      lines: [{ salesTaxItemName: "IL State Tax", amount: 75 }],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(9001);
  });
});

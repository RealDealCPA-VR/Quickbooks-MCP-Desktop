// Phase 16 #72 — qb_transaction_list (cross-type unified transaction list).
//
// Composite over typed *QueryRq calls — fans out across customer-side or
// vendor-side txn types with a shared EntityFilter + TxnDateRangeFilter.
//
// Coverage layers:
//   1. Tool surface happy paths — customer scope, vendor scope, no-scope mode,
//      explicit types narrowing, sort order, typeCounts, TxnType tag.
//   2. Validation — mutex scope direction, mutex within direction, no-bound
//      rejection, type/scope mismatch rejection, unknown entity 500.
//   3. Edge — maxPerType cap warning, includeLineItems pass-through.

import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerTransactionTools } from "../src/tools/transactions.js";

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

// Test fixtures use uniquely-named customer / vendor so we don't conflict
// with the sim seed's Acme / Office Supplies Co fixtures (which other tests
// rely on for their own count expectations).
const TEST_CUSTOMER = "TxList Customer Inc.";
const TEST_VENDOR = "TxList Vendor LLC";

beforeAll(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-txn-list-unified",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerTransactionTools(fakeServer as never, () => session);
  await session.openSession();

  await session.addEntity("Customer", {
    Name: TEST_CUSTOMER,
    FullName: TEST_CUSTOMER,
    CompanyName: TEST_CUSTOMER,
    IsActive: true,
  });
  await session.addEntity("Vendor", {
    Name: TEST_VENDOR,
    FullName: TEST_VENDOR,
    CompanyName: TEST_VENDOR,
    IsActive: true,
  });

  // ----- Customer-side fixtures (5 distinct types, 3 in March 2025 window) -----
  await session.addEntity("Invoice", {
    CustomerRef: { FullName: TEST_CUSTOMER },
    TxnDate: "2025-03-05",
    RefNumber: "TX-INV-1",
    InvoiceLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 5, Rate: 200 },
    ],
  });
  await session.addEntity("SalesReceipt", {
    CustomerRef: { FullName: TEST_CUSTOMER },
    TxnDate: "2025-03-10",
    RefNumber: "TX-SR-1",
    SalesReceiptLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 2, Rate: 250 },
    ],
  });
  await session.addEntity("ReceivePayment", {
    CustomerRef: { FullName: TEST_CUSTOMER },
    TxnDate: "2025-03-20",
    RefNumber: "TX-RP-1",
    TotalAmount: 500,
  });
  // CreditMemo / StatementCharge fall OUTSIDE the March window — tested by date filter.
  await session.addEntity("CreditMemo", {
    CustomerRef: { FullName: TEST_CUSTOMER },
    TxnDate: "2025-04-15",
    RefNumber: "TX-CM-1",
    CreditMemoLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 100 },
    ],
  });
  await session.addEntity("StatementCharge", {
    CustomerRef: { FullName: TEST_CUSTOMER },
    TxnDate: "2025-04-20",
    RefNumber: "TX-SC-1",
    ItemRef: { FullName: "Consulting Services" },
    Quantity: 1,
    Rate: 150,
  });

  // ----- Vendor-side fixtures -----
  const billResult = await session.addEntity("Bill", {
    VendorRef: { FullName: TEST_VENDOR },
    TxnDate: "2025-03-08",
    RefNumber: "TX-BILL-1",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Rent Expense" }, Amount: 1200 },
    ],
  });
  const billTxnId = String((billResult as Record<string, unknown>).TxnID);
  await session.addEntity("Check", {
    PayeeEntityRef: { FullName: TEST_VENDOR },
    AccountRef: { FullName: "Checking" },
    TxnDate: "2025-03-12",
    RefNumber: "TX-CHK-1",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Office Supplies" }, Amount: 75 },
    ],
  });
  await session.addEntity("BillPaymentCheck", {
    PayeeEntityRef: { FullName: TEST_VENDOR },
    BankAccountRef: { FullName: "Checking" },
    TxnDate: "2025-03-25",
    RefNumber: "TX-BPC-1",
    AppliedToTxnAdd: [
      { TxnID: billTxnId, PaymentAmount: 1200 },
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

// ===========================================================================
// Layer 1 — Happy paths
// ===========================================================================

describe("Layer 1 — happy paths", () => {
  it("customer scope with default types returns the 5 AR-side fixtures sorted chronologically", async () => {
    const { payload } = await callTool("qb_transaction_list", {
      customerName: TEST_CUSTOMER,
    });
    expect(payload.scope.direction).toBe("customer");
    expect(payload.scope.customerName).toBe(TEST_CUSTOMER);
    expect(payload.count).toBe(5);
    expect(payload.types).toEqual([
      "Invoice",
      "SalesReceipt",
      "ReceivePayment",
      "CreditMemo",
      "StatementCharge",
    ]);
    expect(payload.typeCounts).toEqual({
      Invoice: 1,
      SalesReceipt: 1,
      ReceivePayment: 1,
      CreditMemo: 1,
      StatementCharge: 1,
    });
    const dates = payload.transactions.map(
      (t: { TxnDate: string }) => t.TxnDate,
    );
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });

  it("every row carries an injected TxnType tag", async () => {
    const { payload } = await callTool("qb_transaction_list", {
      customerName: TEST_CUSTOMER,
    });
    const types = new Set(
      payload.transactions.map((t: { TxnType: string }) => t.TxnType),
    );
    expect(types).toEqual(
      new Set([
        "Invoice",
        "SalesReceipt",
        "ReceivePayment",
        "CreditMemo",
        "StatementCharge",
      ]),
    );
  });

  it("date window narrows customer scope to the March 2025 fixtures", async () => {
    const { payload } = await callTool("qb_transaction_list", {
      customerName: TEST_CUSTOMER,
      fromDate: "2025-03-01",
      toDate: "2025-03-31",
    });
    // March has Invoice + SalesReceipt + ReceivePayment (3). CM + StatementCharge are April.
    expect(payload.count).toBe(3);
    expect(payload.typeCounts.Invoice).toBe(1);
    expect(payload.typeCounts.SalesReceipt).toBe(1);
    expect(payload.typeCounts.ReceivePayment).toBe(1);
    expect(payload.typeCounts.CreditMemo).toBe(0);
    expect(payload.typeCounts.StatementCharge).toBe(0);
  });

  it("explicit types arg narrows the fanout (Invoice + ReceivePayment only)", async () => {
    const { payload } = await callTool("qb_transaction_list", {
      customerName: TEST_CUSTOMER,
      types: ["Invoice", "ReceivePayment"],
    });
    expect(payload.types).toEqual(["Invoice", "ReceivePayment"]);
    expect(payload.count).toBe(2);
    expect(Object.keys(payload.typeCounts).sort()).toEqual([
      "Invoice",
      "ReceivePayment",
    ]);
  });

  it("vendor scope with default types returns AP-side fixtures", async () => {
    const { payload } = await callTool("qb_transaction_list", {
      vendorName: TEST_VENDOR,
    });
    expect(payload.scope.direction).toBe("vendor");
    expect(payload.scope.vendorName).toBe(TEST_VENDOR);
    expect(payload.types).toContain("Bill");
    expect(payload.types).toContain("BillPaymentCheck");
    expect(payload.types).toContain("Check");
    // We seeded Bill + Check + BillPaymentCheck against this vendor (3 rows).
    expect(payload.count).toBe(3);
    expect(payload.typeCounts.Bill).toBe(1);
    expect(payload.typeCounts.Check).toBe(1);
    expect(payload.typeCounts.BillPaymentCheck).toBe(1);
  });

  it("no-scope mode with date range fans over customer-side defaults", async () => {
    const { payload } = await callTool("qb_transaction_list", {
      fromDate: "2025-03-01",
      toDate: "2025-03-31",
    });
    expect(payload.scope.direction).toBe("all");
    // No EntityFilter, so this also picks up any seed-side fixtures in March
    // — count is at-least our 3 fixtures.
    expect(payload.count).toBeGreaterThanOrEqual(3);
    const ourRows = payload.transactions.filter(
      (t: { RefNumber?: string }) => t.RefNumber?.startsWith("TX-"),
    );
    expect(ourRows.length).toBe(3);
  });

  it("customerListId scope produces the same result as customerName", async () => {
    const customers = await session.queryEntity("Customer", {
      FullName: TEST_CUSTOMER,
    });
    expect(customers.length).toBe(1);
    const listId = String((customers[0] as Record<string, unknown>).ListID);
    const { payload } = await callTool("qb_transaction_list", {
      customerListId: listId,
    });
    expect(payload.scope.direction).toBe("customer");
    expect(payload.scope.customerName).toBe(TEST_CUSTOMER);
    expect(payload.scope.customerListId).toBe(listId);
    expect(payload.count).toBe(5);
  });
});

// ===========================================================================
// Layer 2 — Validation
// ===========================================================================

describe("Layer 2 — validation", () => {
  it("rejects both customer and vendor scope with 3120", async () => {
    const { result, payload } = (await callTool("qb_transaction_list", {
      customerName: TEST_CUSTOMER,
      vendorName: TEST_VENDOR,
    })) as { result: { isError: boolean }; payload: { statusCode: number; statusMessage: string } };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(3120);
    expect(payload.statusMessage).toMatch(/mutually exclusive/i);
  });

  it("rejects both customerName + customerListId", async () => {
    const { result, payload } = (await callTool("qb_transaction_list", {
      customerName: TEST_CUSTOMER,
      customerListId: "fake-id",
    })) as { result: { isError: boolean }; payload: { statusCode: number; statusMessage: string } };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(3120);
    expect(payload.statusMessage).toMatch(/customerName or customerListId/i);
  });

  it("rejects both vendorName + vendorListId", async () => {
    const { result, payload } = (await callTool("qb_transaction_list", {
      vendorName: TEST_VENDOR,
      vendorListId: "fake-id",
    })) as { result: { isError: boolean }; payload: { statusCode: number; statusMessage: string } };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(3120);
    expect(payload.statusMessage).toMatch(/vendorName or vendorListId/i);
  });

  it("rejects no scope and no date range (unbounded fanout)", async () => {
    const { result, payload } = (await callTool(
      "qb_transaction_list",
      {},
    )) as { result: { isError: boolean }; payload: { statusCode: number; statusMessage: string } };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(3120);
    expect(payload.statusMessage).toMatch(/required to bound/i);
  });

  it("rejects vendor-side types under customer scope, naming the bad type", async () => {
    const { result, payload } = (await callTool("qb_transaction_list", {
      customerName: TEST_CUSTOMER,
      types: ["Invoice", "Bill"],
    })) as { result: { isError: boolean }; payload: { statusCode: number; statusMessage: string } };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(3120);
    expect(payload.statusMessage).toMatch(/Bill/);
    expect(payload.statusMessage).toMatch(/vendor-side/);
  });

  it("rejects customer-side types under vendor scope, naming the bad type", async () => {
    const { result, payload } = (await callTool("qb_transaction_list", {
      vendorName: TEST_VENDOR,
      types: ["Bill", "Invoice"],
    })) as { result: { isError: boolean }; payload: { statusCode: number; statusMessage: string } };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(3120);
    expect(payload.statusMessage).toMatch(/Invoice/);
    expect(payload.statusMessage).toMatch(/customer-side/);
  });

  it("allows mixed customer-side + vendor-side types when no scope is supplied", async () => {
    const { payload } = await callTool("qb_transaction_list", {
      fromDate: "2025-03-01",
      toDate: "2025-03-31",
      types: ["Invoice", "Bill"],
    });
    expect(payload.types).toEqual(["Invoice", "Bill"]);
    expect(payload.scope.direction).toBe("all");
    // Pulls our TX-INV-1 (March) and TX-BILL-1 (March), plus whatever else the
    // sim seed has in March 2025.
    expect(payload.count).toBeGreaterThanOrEqual(2);
  });

  it("rejects unknown customer with 500", async () => {
    const { result, payload } = (await callTool("qb_transaction_list", {
      customerName: "Definitely Does Not Exist Inc.",
    })) as { result: { isError: boolean }; payload: { statusCode: number; statusMessage: string } };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(500);
    expect(payload.statusMessage).toMatch(/not found/i);
  });

  it("rejects unknown vendor with 500", async () => {
    const { result, payload } = (await callTool("qb_transaction_list", {
      vendorListId: "00000000-NOPE-NOPE",
    })) as { result: { isError: boolean }; payload: { statusCode: number; statusMessage: string } };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(500);
    expect(payload.statusMessage).toMatch(/not found/i);
  });

  it("zod rejects an empty types array", async () => {
    const res = await callTool("qb_transaction_list", {
      customerName: TEST_CUSTOMER,
      types: [],
    });
    expect("schemaError" in res).toBe(true);
  });

  it("zod rejects an invalid txnType value", async () => {
    const res = await callTool("qb_transaction_list", {
      customerName: TEST_CUSTOMER,
      types: ["JournalEntry"],
    });
    expect("schemaError" in res).toBe(true);
  });
});

// ===========================================================================
// Layer 3 — Edges
// ===========================================================================

describe("Layer 3 — edges", () => {
  it("maxPerType cap surfaces a warning when hit on any type", async () => {
    const { payload } = await callTool("qb_transaction_list", {
      customerName: TEST_CUSTOMER,
      maxPerType: 1, // Force the cap to be hit on every customer-side type.
    });
    expect(payload.warnings).toBeDefined();
    expect(payload.warnings.length).toBeGreaterThan(0);
    expect(payload.warnings[0]).toMatch(/maxPerType cap/);
  });

  it("includeLineItems:true threads through to typed queries (Invoice row carries lines)", async () => {
    const { payload } = await callTool("qb_transaction_list", {
      customerName: TEST_CUSTOMER,
      types: ["Invoice"],
      includeLineItems: true,
    });
    expect(payload.count).toBe(1);
    const inv = payload.transactions[0] as Record<string, unknown>;
    // Phase 10 #41 strips line keys by default; with includeLineItems:true the
    // InvoiceLineRet array must survive.
    expect(inv.InvoiceLineRet).toBeDefined();
  });

  it("includeLineItems unset (default) strips line keys", async () => {
    const { payload } = await callTool("qb_transaction_list", {
      customerName: TEST_CUSTOMER,
      types: ["Invoice"],
    });
    const inv = payload.transactions[0] as Record<string, unknown>;
    expect(inv.InvoiceLineRet).toBeUndefined();
  });
});

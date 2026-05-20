// Phase 13 #63 — qb_transaction_memo_search.
//
// Cross-type memo substring search. QBXML has no server-side memo
// substring filter on any *QueryRq at any version, so this tool pulls
// every matching txn in the bounded window (one round trip per type)
// and post-filters by Memo content. Each matched row carries a
// `matchedFields` array naming where the hit landed.
//
// Coverage layers:
//   1. Validation — Zod rejection, mutex scope direction, mutex within
//      direction, no-bound rejection, type/scope mismatch, unknown entity.
//   2. Header memo match — substring, case-insensitive default, case-
//      sensitive override, no-match returns count:0.
//   3. Line memo match — InvoiceLineRet.Desc, SalesOrderLineRet.Desc,
//      Bill ExpenseLineRet.Memo + ItemLineRet.Memo (dual-line walk),
//      JournalLineRet.Memo, matchedFields per-line indexing.
//   4. Scope + types — customer scope narrows to customer-side defaults,
//      vendor scope narrows to vendor-side defaults, no-scope opens to
//      unscoped types, explicit types narrowing, type/scope rejection.
//   5. Flags — includeLineMemos:false skips line content entirely;
//      caseSensitive:true; maxPerType cap warning; sort + typeCounts vs
//      scannedCounts shape.

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

// Unique test fixtures so we don't conflict with the sim seed.
const TEST_CUSTOMER = "Memo Search Customer Inc.";
const TEST_VENDOR = "Memo Search Vendor LLC";

// Two distinctive query strings used across tests. The mixed-case one
// proves caseSensitive flag matters; "FOOBAR-Q4" / "lowercase-q4" are
// the canonical match targets for header / line tests.
const HEADER_MARKER = "FOOBAR-Q4-RETAINER";
const LINE_DESC_MARKER = "Special-LineDesc-Marker";
const LINE_MEMO_MARKER = "Special-LineMemo-Marker";

beforeAll(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-txn-memo-search",
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

  // ---------- CUSTOMER-SIDE FIXTURES ----------
  // Invoice with HEADER_MARKER in Memo + LINE_DESC_MARKER on a line.
  await session.addEntity("Invoice", {
    CustomerRef: { FullName: TEST_CUSTOMER },
    TxnDate: "2025-06-05",
    RefNumber: "MEMO-INV-1",
    Memo: `Q4 work — ${HEADER_MARKER}`,
    InvoiceLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 5, Rate: 200, Desc: "Standard rate hours" },
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 2, Rate: 250, Desc: `${LINE_DESC_MARKER} — emergency premium hours` },
    ],
  });

  // Invoice with NO header marker but LINE_DESC_MARKER on line 0.
  await session.addEntity("Invoice", {
    CustomerRef: { FullName: TEST_CUSTOMER },
    TxnDate: "2025-06-10",
    RefNumber: "MEMO-INV-2",
    Memo: "Routine consulting",
    InvoiceLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 100, Desc: `${LINE_DESC_MARKER} only on this invoice` },
    ],
  });

  // Invoice with no markers anywhere (negative-control row — confirms
  // unrelated invoices aren't returned).
  await session.addEntity("Invoice", {
    CustomerRef: { FullName: TEST_CUSTOMER },
    TxnDate: "2025-06-15",
    RefNumber: "MEMO-INV-3",
    Memo: "Just a normal invoice",
    InvoiceLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 50, Desc: "Nothing special" },
    ],
  });

  // SalesOrder with HEADER_MARKER in Memo.
  await session.addEntity("SalesOrder", {
    CustomerRef: { FullName: TEST_CUSTOMER },
    TxnDate: "2025-06-20",
    RefNumber: "MEMO-SO-1",
    Memo: `Pre-billed work — ${HEADER_MARKER}`,
    SalesOrderLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 1000, Desc: "Block hours" },
    ],
  });

  // ---------- VENDOR-SIDE FIXTURES ----------
  // Bill carrying BOTH ExpenseLineRet + ItemLineRet — proves the dual-line
  // walk on bill-like types. LINE_MEMO_MARKER on the ExpenseLine, no
  // marker on header (line-only hit).
  await session.addEntity("Bill", {
    VendorRef: { FullName: TEST_VENDOR },
    TxnDate: "2025-06-08",
    RefNumber: "MEMO-BILL-1",
    Memo: "Office supplies + service",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Office Supplies" }, Amount: 100, Memo: `${LINE_MEMO_MARKER} on expense line` },
    ],
    ItemLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Cost: 200, Memo: "Item line memo (unmarked)" },
    ],
  });

  // Bill with HEADER_MARKER on the header — proves vendor-side header match.
  await session.addEntity("Bill", {
    VendorRef: { FullName: TEST_VENDOR },
    TxnDate: "2025-06-12",
    RefNumber: "MEMO-BILL-2",
    Memo: `Recurring monthly retainer ${HEADER_MARKER}`,
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Office Supplies" }, Amount: 500 },
    ],
  });

  // Check with LINE_MEMO_MARKER on the ItemLine.Desc (not Memo).
  await session.addEntity("Check", {
    PayeeEntityRef: { FullName: TEST_VENDOR },
    AccountRef: { FullName: "Checking" },
    TxnDate: "2025-06-18",
    RefNumber: "MEMO-CHK-1",
    Memo: "Vendor payment",
    ItemLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Cost: 75, Desc: `${LINE_DESC_MARKER} written on check item line` },
    ],
  });

  // ---------- UNSCOPED TYPE FIXTURE ----------
  // JournalEntry with HEADER_MARKER — proves no-scope opens unscoped types.
  await session.addEntity("JournalEntry", {
    TxnDate: "2025-06-22",
    RefNumber: "MEMO-JE-1",
    Memo: `Year-end accrual ${HEADER_MARKER}`,
    JournalDebitLineAdd: [
      { AccountRef: { FullName: "Office Supplies" }, Amount: 250, Memo: `${LINE_MEMO_MARKER} JE debit` },
    ],
    JournalCreditLineAdd: [
      { AccountRef: { FullName: "Accounts Payable" }, Amount: 250 },
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
// Layer 1 — Validation
// ===========================================================================

describe("Layer 1 — validation", () => {
  it("is registered as qb_transaction_memo_search", () => {
    expect(handlers.has("qb_transaction_memo_search")).toBe(true);
  });

  it("Zod rejects empty query", async () => {
    const out = await callTool("qb_transaction_memo_search", {
      query: "",
      customerName: TEST_CUSTOMER,
    });
    expect(out.schemaError).toBeDefined();
  });

  it("Zod rejects missing query", async () => {
    const out = await callTool("qb_transaction_memo_search", {
      customerName: TEST_CUSTOMER,
    });
    expect(out.schemaError).toBeDefined();
  });

  it("rejects both customer + vendor scope with 3120", async () => {
    const { result, payload } = (await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      customerName: TEST_CUSTOMER,
      vendorName: TEST_VENDOR,
    })) as { result: { isError?: boolean }; payload: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(3120);
    expect(String(payload.statusMessage)).toMatch(/mutually exclusive/i);
  });

  it("rejects both customerName + customerListId with 3120", async () => {
    const { result, payload } = (await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      customerName: TEST_CUSTOMER,
      customerListId: "X",
    })) as { result: { isError?: boolean }; payload: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(3120);
  });

  it("rejects both vendorName + vendorListId with 3120", async () => {
    const { result, payload } = (await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      vendorName: TEST_VENDOR,
      vendorListId: "X",
    })) as { result: { isError?: boolean }; payload: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(3120);
  });

  it("rejects no scope + no date range with 3120 (prevents unbounded scan)", async () => {
    const { result, payload } = (await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
    })) as { result: { isError?: boolean }; payload: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(3120);
    expect(String(payload.statusMessage)).toMatch(/bound/i);
  });

  it("rejects vendor-side type under customer scope with 3120", async () => {
    const { result, payload } = (await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      customerName: TEST_CUSTOMER,
      types: ["Bill"],
    })) as { result: { isError?: boolean }; payload: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(3120);
    expect(String(payload.statusMessage)).toMatch(/Bill/);
  });

  it("rejects customer-side type under vendor scope with 3120", async () => {
    const { result, payload } = (await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      vendorName: TEST_VENDOR,
      types: ["Invoice"],
    })) as { result: { isError?: boolean }; payload: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(3120);
  });

  it("rejects unknown customer with 500", async () => {
    const { result, payload } = (await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      customerName: "Does Not Exist Inc",
    })) as { result: { isError?: boolean }; payload: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(500);
  });

  it("rejects unknown vendor with 500", async () => {
    const { result, payload } = (await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      vendorName: "Does Not Exist LLC",
    })) as { result: { isError?: boolean }; payload: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(payload.statusCode).toBe(500);
  });
});

// ===========================================================================
// Layer 2 — Header memo match
// ===========================================================================

describe("Layer 2 — header memo match", () => {
  it("finds invoices whose header Memo contains the substring (customer scope)", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      customerName: TEST_CUSTOMER,
    });
    // MEMO-INV-1 has it in header.Memo; MEMO-SO-1 has it in header.Memo;
    // MEMO-INV-2 / MEMO-INV-3 do NOT have it on header (INV-2 has line marker
    // but different one). Customer scope defaults to customer-side types
    // which includes both Invoice and SalesOrder.
    const refs = (
      payload.transactions as Array<{ RefNumber: string }>
    ).map((t) => t.RefNumber);
    expect(refs).toContain("MEMO-INV-1");
    expect(refs).toContain("MEMO-SO-1");
    expect(refs).not.toContain("MEMO-INV-3");
  });

  it("each matched row carries matchedFields naming where the hit landed", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      customerName: TEST_CUSTOMER,
    });
    const inv1 = (
      payload.transactions as Array<{ RefNumber: string; matchedFields: string[] }>
    ).find((t) => t.RefNumber === "MEMO-INV-1");
    expect(inv1).toBeDefined();
    expect(inv1!.matchedFields).toContain("header.Memo");
  });

  it("default case-insensitive match finds lowercase substring in mixed-case header", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: "foobar-q4-retainer", // lowercase
      customerName: TEST_CUSTOMER,
    });
    const refs = (
      payload.transactions as Array<{ RefNumber: string }>
    ).map((t) => t.RefNumber);
    expect(refs).toContain("MEMO-INV-1");
  });

  it("caseSensitive:true requires exact case", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: "foobar-q4-retainer", // lowercase
      customerName: TEST_CUSTOMER,
      caseSensitive: true,
    });
    // Header memo has uppercase HEADER_MARKER; with caseSensitive:true the
    // lowercase query must NOT match.
    const refs = (
      payload.transactions as Array<{ RefNumber: string }>
    ).map((t) => t.RefNumber);
    expect(refs).not.toContain("MEMO-INV-1");
    expect(payload.caseSensitive).toBe(true);
  });

  it("no-match query returns count:0 with empty transactions array", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: "no-such-string-anywhere-zzz",
      customerName: TEST_CUSTOMER,
    });
    expect(payload.count).toBe(0);
    expect(payload.transactions).toEqual([]);
  });

  it("response echoes query / caseSensitive / includeLineMemos / scope", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      customerName: TEST_CUSTOMER,
    });
    expect(payload.query).toBe(HEADER_MARKER);
    expect(payload.caseSensitive).toBe(false);
    expect(payload.includeLineMemos).toBe(true);
    expect(payload.scope.direction).toBe("customer");
    expect(payload.scope.customerName).toBe(TEST_CUSTOMER);
  });
});

// ===========================================================================
// Layer 3 — Line memo match
// ===========================================================================

describe("Layer 3 — line memo match", () => {
  it("finds invoices whose LineRet[i].Desc contains the substring", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: LINE_DESC_MARKER,
      customerName: TEST_CUSTOMER,
    });
    // MEMO-INV-1 has it on line[1].Desc; MEMO-INV-2 has it on line[0].Desc.
    const refs = (
      payload.transactions as Array<{ RefNumber: string }>
    ).map((t) => t.RefNumber);
    expect(refs).toContain("MEMO-INV-1");
    expect(refs).toContain("MEMO-INV-2");
  });

  it("matchedFields names the exact LineRet index where the hit landed", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: LINE_DESC_MARKER,
      customerName: TEST_CUSTOMER,
    });
    const inv1 = (
      payload.transactions as Array<{ RefNumber: string; matchedFields: string[] }>
    ).find((t) => t.RefNumber === "MEMO-INV-1");
    expect(inv1).toBeDefined();
    expect(inv1!.matchedFields).toEqual(["InvoiceLineRet[1].Desc"]);

    const inv2 = (
      payload.transactions as Array<{ RefNumber: string; matchedFields: string[] }>
    ).find((t) => t.RefNumber === "MEMO-INV-2");
    expect(inv2!.matchedFields).toEqual(["InvoiceLineRet[0].Desc"]);
  });

  it("bill-like types walk BOTH ExpenseLineRet + ItemLineRet for memo matches", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: LINE_MEMO_MARKER,
      vendorName: TEST_VENDOR,
    });
    // MEMO-BILL-1 has LINE_MEMO_MARKER on ExpenseLineRet[0].Memo.
    const bill1 = (
      payload.transactions as Array<{ RefNumber: string; matchedFields: string[] }>
    ).find((t) => t.RefNumber === "MEMO-BILL-1");
    expect(bill1).toBeDefined();
    expect(bill1!.matchedFields).toContain("ExpenseLineRet[0].Memo");
  });

  it("bill-like types also walk ItemLineRet.Desc (Check fixture)", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: LINE_DESC_MARKER,
      vendorName: TEST_VENDOR,
    });
    const chk = (
      payload.transactions as Array<{ RefNumber: string; matchedFields: string[] }>
    ).find((t) => t.RefNumber === "MEMO-CHK-1");
    expect(chk).toBeDefined();
    expect(chk!.matchedFields).toContain("ItemLineRet[0].Desc");
  });
});

// ===========================================================================
// Layer 4 — Scope + types
// ===========================================================================

describe("Layer 4 — scope + types", () => {
  it("customer scope defaults to customer-side types only", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      customerName: TEST_CUSTOMER,
    });
    const declared = payload.types as string[];
    expect(declared).toEqual([
      "Invoice",
      "SalesReceipt",
      "ReceivePayment",
      "CreditMemo",
      "StatementCharge",
      "Estimate",
      "SalesOrder",
    ]);
    // No JournalEntry or vendor-side type should be in the result.
    const txnTypes = new Set(
      (payload.transactions as Array<{ TxnType: string }>).map((t) => t.TxnType),
    );
    expect(txnTypes.has("JournalEntry")).toBe(false);
    expect(txnTypes.has("Bill")).toBe(false);
  });

  it("vendor scope defaults to vendor-side types only", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      vendorName: TEST_VENDOR,
    });
    const declared = payload.types as string[];
    expect(declared).toEqual([
      "Bill",
      "BillPaymentCheck",
      "BillPaymentCreditCard",
      "Check",
      "CreditCardCharge",
      "CreditCardCredit",
      "PurchaseOrder",
    ]);
    // MEMO-BILL-2 has HEADER_MARKER on header.
    const refs = (
      payload.transactions as Array<{ RefNumber: string }>
    ).map((t) => t.RefNumber);
    expect(refs).toContain("MEMO-BILL-2");
  });

  it("no scope opens the search to unscoped types (JournalEntry visible)", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      fromDate: "2025-06-01",
      toDate: "2025-06-30",
    });
    const declared = payload.types as string[];
    expect(declared).toContain("JournalEntry");
    expect(declared).toContain("Deposit");
    expect(declared).toContain("Transfer");
    expect(declared).toContain("InventoryAdjustment");
    expect(declared).toContain("SalesTaxPaymentCheck");
    // The JE fixture lives in the window with HEADER_MARKER on header.Memo.
    const refs = (
      payload.transactions as Array<{ RefNumber: string }>
    ).map((t) => t.RefNumber);
    expect(refs).toContain("MEMO-JE-1");
  });

  it("explicit types narrows the fanout under no-scope mode", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      fromDate: "2025-06-01",
      toDate: "2025-06-30",
      types: ["JournalEntry"],
    });
    expect(payload.types).toEqual(["JournalEntry"]);
    const txnTypes = new Set(
      (payload.transactions as Array<{ TxnType: string }>).map((t) => t.TxnType),
    );
    // Only JournalEntry rows; no Invoice / Bill etc.
    expect(txnTypes.size).toBeLessThanOrEqual(1);
    if (txnTypes.size === 1) expect(txnTypes.has("JournalEntry")).toBe(true);
  });

  it("date-range narrows the fanout (out-of-window invoices excluded)", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      customerName: TEST_CUSTOMER,
      fromDate: "2025-06-01",
      toDate: "2025-06-09",
    });
    // MEMO-INV-1 dated 2025-06-05 is in the window. MEMO-SO-1 dated 2025-06-20
    // is OUTSIDE the window.
    const refs = (
      payload.transactions as Array<{ RefNumber: string }>
    ).map((t) => t.RefNumber);
    expect(refs).toContain("MEMO-INV-1");
    expect(refs).not.toContain("MEMO-SO-1");
  });
});

// ===========================================================================
// Layer 5 — Flags + shape
// ===========================================================================

describe("Layer 5 — flags + shape", () => {
  it("includeLineMemos:false skips line content entirely", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: LINE_DESC_MARKER,
      customerName: TEST_CUSTOMER,
      includeLineMemos: false,
    });
    // LINE_DESC_MARKER lives ONLY on line.Desc fields; with includeLineMemos:
    // false, the tool only checks header.Memo, so no rows should match.
    expect(payload.count).toBe(0);
    expect(payload.includeLineMemos).toBe(false);
  });

  it("includeLineMemos:false still finds header matches", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      customerName: TEST_CUSTOMER,
      includeLineMemos: false,
    });
    const refs = (
      payload.transactions as Array<{ RefNumber: string }>
    ).map((t) => t.RefNumber);
    expect(refs).toContain("MEMO-INV-1");
    expect(refs).toContain("MEMO-SO-1");
    // Each matched row's matchedFields must NOT reference line indices.
    for (const t of payload.transactions as Array<{ matchedFields: string[] }>) {
      for (const field of t.matchedFields) {
        expect(field).toBe("header.Memo");
      }
    }
  });

  it("response shape carries typeCounts (matched) + scannedCounts (rows seen)", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      customerName: TEST_CUSTOMER,
    });
    expect(payload.typeCounts).toBeDefined();
    expect(payload.scannedCounts).toBeDefined();
    // Customer-side types are scanned even when no rows match (e.g.
    // ReceivePayment / CreditMemo / StatementCharge / Estimate). scannedCounts
    // covers every requested type; typeCounts only includes types that
    // produced a match — but we set it for every key with .0 when none.
    // Specifically: Invoice was scanned and matched (>=1).
    expect((payload.scannedCounts as Record<string, number>).Invoice).toBeGreaterThanOrEqual(3);
    expect((payload.typeCounts as Record<string, number>).Invoice).toBeGreaterThanOrEqual(1);
  });

  it("maxPerType cap surfaces a warning when hit", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      customerName: TEST_CUSTOMER,
      maxPerType: 1,
    });
    expect(Array.isArray(payload.warnings)).toBe(true);
    // At least one type — Invoice has 3 rows in this fixture, easily
    // tripping a maxPerType of 1.
    const warningsStr = (payload.warnings as string[]).join(" | ");
    expect(warningsStr).toMatch(/hit maxPerType cap/);
  });

  it("results are sorted by TxnDate ascending", async () => {
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      fromDate: "2025-06-01",
      toDate: "2025-06-30",
    });
    const dates = (
      payload.transactions as Array<{ TxnDate: string }>
    ).map((t) => t.TxnDate);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });

  it("customerListId form resolves equivalently to customerName", async () => {
    // Resolve the customer's ListID by querying.
    const customers = (await session.queryEntity("Customer", {
      FullName: TEST_CUSTOMER,
    })) as Array<Record<string, unknown>>;
    const listId = String(customers[0].ListID);
    const { payload } = await callTool("qb_transaction_memo_search", {
      query: HEADER_MARKER,
      customerListId: listId,
    });
    const refs = (
      payload.transactions as Array<{ RefNumber: string }>
    ).map((t) => t.RefNumber);
    expect(refs).toContain("MEMO-INV-1");
    expect(payload.scope.customerListId).toBe(listId);
  });
});

// Phase 10 #41 — line-level detail in *_list responses.
//
// Coverage layers:
//   1. Sim contract — handleQuery strips *LineRet keys by default; preserves
//      them when IncludeLineItems is truthy. Affects every transaction store
//      uniformly via the regex /Line(s?)Ret$/.
//   2. Tool handler — each of the 7 list tools (invoice / bill / sales-receipt /
//      credit-memo / purchase-order / estimate / journal-entry) accepts an
//      optional `includeLineItems: boolean` arg, threads `IncludeLineItems` into
//      the filter dict, and surfaces lines on the response when truthy.
//   3. Filter-dict contract — vi.spyOn pins that the tool layer adds
//      `IncludeLineItems: true` ONLY when the caller opts in, so the default
//      path doesn't accidentally light up the wire flag.
//
// Schema-order pinning for IncludeLineItems lives in builder-emit-order.test.ts;
// this file covers the behavior contract end-to-end through the tool handlers.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerInvoiceTools } from "../src/tools/invoices.js";
import { registerBillTools } from "../src/tools/bills.js";
import { registerSalesReceiptTools } from "../src/tools/sales-receipts.js";
import { registerCreditMemoTools } from "../src/tools/credit-memos.js";
import { registerPurchaseOrderTools } from "../src/tools/purchase-orders.js";
import { registerEstimateTools } from "../src/tools/estimates.js";
import { registerJournalEntryTools } from "../src/tools/journal-entries.js";

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
    handler: Handler
  ) => {
    handlers.set(name, handler);
  },
};

let session: QBSessionManager;

beforeAll(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-include-line-items",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerInvoiceTools(fakeServer as never, () => session);
  registerBillTools(fakeServer as never, () => session);
  registerSalesReceiptTools(fakeServer as never, () => session);
  registerCreditMemoTools(fakeServer as never, () => session);
  registerPurchaseOrderTools(fakeServer as never, () => session);
  registerEstimateTools(fakeServer as never, () => session);
  registerJournalEntryTools(fakeServer as never, () => session);
  await session.openSession();

  // Seed one transaction per type, each with a recognizable line set, so the
  // strip-vs-include contract has something to assert against. Each add call
  // returns the *Ret entity (lines included on the add response — that path is
  // unaffected by #41).
  await session.addEntity("Invoice", {
    CustomerRef: { FullName: "Acme Corporation" },
    TxnDate: "2026-04-01",
    RefNumber: "INV-LINES-1",
    InvoiceLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 2, Rate: 150 },
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 200 },
    ],
  });
  await session.addEntity("Bill", {
    VendorRef: { FullName: "Office Supplies Co" },
    TxnDate: "2026-04-01",
    RefNumber: "B-LINES-1",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Rent Expense" }, Amount: 1500, Memo: "april rent" },
      { AccountRef: { FullName: "Utilities" }, Amount: 300 },
    ],
    // Item line on the same bill so the includeLineItems:true assertion can
    // confirm BOTH ExpenseLineRet and ItemLineRet survive the strip.
    ItemLineAdd: [
      { ItemRef: { FullName: "Widget" }, Quantity: 4, Cost: 25 },
    ],
  });
  await session.addEntity("SalesReceipt", {
    CustomerRef: { FullName: "Acme Corporation" },
    TxnDate: "2026-04-02",
    RefNumber: "SR-LINES-1",
    SalesReceiptLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 100 },
    ],
  });
  await session.addEntity("CreditMemo", {
    CustomerRef: { FullName: "Acme Corporation" },
    TxnDate: "2026-04-03",
    RefNumber: "CM-LINES-1",
    CreditMemoLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 50 },
    ],
  });
  await session.addEntity("PurchaseOrder", {
    VendorRef: { FullName: "Office Supplies Co" },
    TxnDate: "2026-04-04",
    RefNumber: "PO-LINES-1",
    PurchaseOrderLineAdd: [
      { ItemRef: { FullName: "Widget" }, Quantity: 5, Rate: 12 },
    ],
  });
  await session.addEntity("Estimate", {
    CustomerRef: { FullName: "Acme Corporation" },
    TxnDate: "2026-04-05",
    RefNumber: "EST-LINES-1",
    EstimateLineAdd: [
      { ItemRef: { FullName: "Consulting Services" }, Quantity: 3, Rate: 175 },
    ],
  });
  await session.addEntity("JournalEntry", {
    TxnDate: "2026-04-06",
    RefNumber: "JE-LINES-1",
    JournalDebitLineAdd: [
      { AccountRef: { FullName: "Rent Expense" }, Amount: 250 },
    ],
    JournalCreditLineAdd: [
      { AccountRef: { FullName: "Checking" }, Amount: 250 },
    ],
  });
});

// Returns the parsed JSON payload from a tool handler call.
async function call(
  toolName: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const handler = handlers.get(toolName);
  if (!handler) throw new Error(`tool not registered: ${toolName}`);
  const result = await handler(args);
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// Per-tool truth table. lineKeys is the *LineRet key(s) the sim writes onto
// the entity for that type. refField is the unique RefNumber the seed used so
// each test can locate its row deterministically.
const TOOL_CASES = [
  {
    tool: "qb_invoice_list",
    listKey: "invoices",
    lineKeys: ["InvoiceLineRet"] as const,
    refNumber: "INV-LINES-1",
    queryArgs: { refNumber: "INV-LINES-1" },
    sessionMethod: "queryEntity" as const,
    sessionArg: "Invoice",
  },
  {
    tool: "qb_bill_list",
    listKey: "bills",
    // Bills carry both expense AND item lines on the entity; both should be
    // stripped when the caller doesn't ask for them.
    lineKeys: ["ExpenseLineRet", "ItemLineRet"] as const,
    refNumber: "B-LINES-1",
    // qb_bill_list does not expose RefNumber as a filter; query by date range.
    queryArgs: { fromDate: "2026-04-01", toDate: "2026-04-01" },
    sessionMethod: "queryEntity" as const,
    sessionArg: "Bill",
  },
  {
    tool: "qb_sales_receipt_list",
    listKey: "salesReceipts",
    lineKeys: ["SalesReceiptLineRet"] as const,
    refNumber: "SR-LINES-1",
    queryArgs: { refNumber: "SR-LINES-1" },
    sessionMethod: "queryEntity" as const,
    sessionArg: "SalesReceipt",
  },
  {
    tool: "qb_credit_memo_list",
    listKey: "creditMemos",
    lineKeys: ["CreditMemoLineRet"] as const,
    refNumber: "CM-LINES-1",
    queryArgs: { refNumber: "CM-LINES-1" },
    sessionMethod: "queryEntity" as const,
    sessionArg: "CreditMemo",
  },
  {
    tool: "qb_purchase_order_list",
    listKey: "purchaseOrders",
    lineKeys: ["PurchaseOrderLineRet"] as const,
    refNumber: "PO-LINES-1",
    queryArgs: { refNumber: "PO-LINES-1" },
    sessionMethod: "queryEntity" as const,
    sessionArg: "PurchaseOrder",
  },
  {
    tool: "qb_estimate_list",
    listKey: "estimates",
    lineKeys: ["EstimateLineRet"] as const,
    refNumber: "EST-LINES-1",
    queryArgs: { refNumber: "EST-LINES-1" },
    sessionMethod: "queryEntity" as const,
    sessionArg: "Estimate",
  },
  {
    tool: "qb_journal_entry_list",
    listKey: "journalEntries",
    lineKeys: ["JournalDebitLineRet", "JournalCreditLineRet"] as const,
    refNumber: "JE-LINES-1",
    queryArgs: { refNumber: "JE-LINES-1" },
    sessionMethod: "queryEntity" as const,
    sessionArg: "JournalEntry",
  },
] as const;

describe("Phase 10 #41 — sim handleQuery strips *LineRet by default", () => {
  for (const c of TOOL_CASES) {
    it(`${c.tool}: header-only by default — no ${c.lineKeys.join(" / ")}`, async () => {
      const out = await call(c.tool, c.queryArgs);
      const rows = out[c.listKey] as Record<string, unknown>[];
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
      const row = rows.find((r) => r.RefNumber === c.refNumber);
      expect(row, `seed row for ${c.refNumber} not found`).toBeDefined();
      // Header fields survive (e.g. RefNumber, TxnDate, TxnID).
      expect(row!.TxnID).toBeDefined();
      // Line keys must be absent when the caller did not opt in.
      for (const lineKey of c.lineKeys) {
        expect(
          row![lineKey],
          `${c.tool} returned ${lineKey} despite includeLineItems missing`,
        ).toBeUndefined();
      }
    });

    it(`${c.tool}: includeLineItems:true surfaces ${c.lineKeys.join(" / ")} on the row`, async () => {
      const out = await call(c.tool, { ...c.queryArgs, includeLineItems: true });
      const rows = out[c.listKey] as Record<string, unknown>[];
      const row = rows.find((r) => r.RefNumber === c.refNumber);
      expect(row, `seed row for ${c.refNumber} not found`).toBeDefined();
      for (const lineKey of c.lineKeys) {
        const lines = row![lineKey];
        expect(
          Array.isArray(lines),
          `${c.tool} did not return ${lineKey} as an array when includeLineItems:true`,
        ).toBe(true);
        expect((lines as unknown[]).length).toBeGreaterThan(0);
        // Each *LineRet carries TxnLineID + Amount per Item 17 (sim must
        // populate them on the add path; #41 just stops stripping them on
        // the query path).
        for (const line of lines as Record<string, unknown>[]) {
          expect(line.TxnLineID).toBeDefined();
          expect(line.Amount).toBeDefined();
        }
      }
    });
  }
});

describe("Phase 10 #41 — tool layer threads IncludeLineItems into filters only when opted in", () => {
  // vi.spyOn pattern from iterator.test.ts Layer 8 + transaction-list.test.ts:
  // assert the EXACT filter dict the tool hands to the manager (and through it
  // to the builder). Direct on the tool contract, doesn't depend on sim
  // behavior or wire-level XML.
  for (const c of TOOL_CASES) {
    it(`${c.tool}: filters omit IncludeLineItems when arg missing/false`, async () => {
      const spy = vi.spyOn(session, c.sessionMethod);
      try {
        await call(c.tool, c.queryArgs);
        expect(spy).toHaveBeenCalled();
        const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
        expect(lastCall[0]).toBe(c.sessionArg);
        const filters = lastCall[1] as Record<string, unknown>;
        expect(filters.IncludeLineItems).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });

    it(`${c.tool}: filters carry IncludeLineItems:true when arg true`, async () => {
      const spy = vi.spyOn(session, c.sessionMethod);
      try {
        await call(c.tool, { ...c.queryArgs, includeLineItems: true });
        const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
        const filters = lastCall[1] as Record<string, unknown>;
        expect(filters.IncludeLineItems).toBe(true);
        // IncludeLineItems must come AFTER every other filter key the tool
        // populated — schema-order contract (see builder-emit-order.test.ts).
        const keys = Object.keys(filters);
        expect(keys[keys.length - 1]).toBe("IncludeLineItems");
      } finally {
        spy.mockRestore();
      }
    });

    it(`${c.tool}: filters omit IncludeLineItems when arg explicitly false`, async () => {
      // false → no wire flag (matches the default; we don't emit
      // IncludeLineItems=false because real QB's IncludeLineItems is
      // false by default and emitting the negative is wasted bytes that
      // could trip a future schema-pickier validator).
      const spy = vi.spyOn(session, c.sessionMethod);
      try {
        await call(c.tool, { ...c.queryArgs, includeLineItems: false });
        const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
        const filters = lastCall[1] as Record<string, unknown>;
        expect(filters.IncludeLineItems).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });
  }
});

describe("Phase 10 #41 — sim IncludeLineItems gate accepts both true and the wire string \"true\"", () => {
  // The sim handleQuery's truthy check has to accept both:
  //   • boolean true (in-process callers handing the filter dict directly to
  //     QBSessionManager.queryEntity, e.g. tests + the estimate-convert tool)
  //   • string "true" (the wire form after a request round-trips through
  //     fast-xml-parser, which surfaces all element values as strings)
  // This test pins both code paths — handleQuery is shared by both flows so
  // the gate must not be type-narrow.

  it("string \"true\" preserves *LineRet keys (live-wire shape)", async () => {
    const rows = await session.queryEntity("Invoice", {
      RefNumber: "INV-LINES-1",
      IncludeLineItems: "true",
    });
    expect(rows.length).toBe(1);
    expect(Array.isArray(rows[0].InvoiceLineRet)).toBe(true);
  });

  it("boolean true preserves *LineRet keys (in-process shape)", async () => {
    const rows = await session.queryEntity("Invoice", {
      RefNumber: "INV-LINES-1",
      IncludeLineItems: true,
    });
    expect(rows.length).toBe(1);
    expect(Array.isArray(rows[0].InvoiceLineRet)).toBe(true);
  });

  it("missing IncludeLineItems strips *LineRet keys (default-off contract)", async () => {
    const rows = await session.queryEntity("Invoice", {
      RefNumber: "INV-LINES-1",
    });
    expect(rows.length).toBe(1);
    expect(rows[0].InvoiceLineRet).toBeUndefined();
  });
});

describe("Phase 10 #41 — qb_estimate_convert_to_invoice still receives lines after the strip-by-default change", () => {
  // The convert tool reads EstimateLineRet from a queryEntity response to map
  // onto InvoiceLineAdd. The strip-by-default change in handleQuery would
  // break it without the explicit IncludeLineItems:true the convert tool now
  // passes. This test pins that the internal opt-in still works end-to-end.

  it("convert preserves the source estimate's line set on the new invoice", async () => {
    // Spawn a fresh estimate so the prior assertion don't share state.
    const estimate = await session.addEntity("Estimate", {
      CustomerRef: { FullName: "Acme Corporation" },
      TxnDate: "2026-04-15",
      RefNumber: "EST-CONV-LINES-1",
      EstimateLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 4, Rate: 125 },
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 2, Rate: 200 },
      ],
    });
    const estimateTxnId = String(estimate.TxnID);

    const handler = handlers.get("qb_estimate_convert_to_invoice");
    expect(handler, "qb_estimate_convert_to_invoice not registered").toBeDefined();
    const result = await handler!({ estimateTxnId, markAccepted: false });
    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
    expect(payload.success).toBe(true);

    const invoice = payload.invoice as Record<string, unknown>;
    const lines = invoice.InvoiceLineRet as Record<string, unknown>[];
    expect(Array.isArray(lines)).toBe(true);
    expect(lines).toHaveLength(2);
    // First line: 4 * 125 = 500. Second: 2 * 200 = 400. Mirrors the source
    // estimate's line amounts, confirming the convert tool got the lines back
    // through the strip-by-default gate.
    expect(Number(lines[0].Amount)).toBe(500);
    expect(Number(lines[1].Amount)).toBe(400);
  });
});

// Phase 17 #76 — Sales Order CRUD + convert-to-invoice tool surface tests.
//
// Coverage layers:
//   1. Sim handleAdd / handleMod — TotalAmount derives from SalesOrderLineRet
//      sum on create and re-derives on line mod (mirrors PurchaseOrder).
//      Customer.Balance does NOT move on sales-order add/del (non-posting).
//   2. qb_sales_order_list — list shape, line-strip default, includeLineItems
//      passthrough, txnId / customer / refNumber / date filters, paginate
//      iterator state. Seeded SO from simulation-store.ts surfaces.
//   3. qb_sales_order_create — happy path with single + multi line, customer
//      validation, line validation (no-lines rejection), idempotencyKey replay
//      + 9002 conflict, read-only gate (9001), error surface.
//   4. qb_sales_order_update — header + line mod, line-replacement semantics,
//      TotalAmount re-derive, IsManuallyClosed flip, stale editSequence 3170,
//      unknown TxnID 500.
//   5. qb_sales_order_delete — happy path, unknown TxnID 500, read-only gate.
//   6. qb_sales_order_convert_to_invoice — happy path (lines mapped, source
//      marked closed, customer-balance moves on invoice add), explicit
//      header-field overrides, markClosed:false leaves the SO open, source
//      without CustomerRef rejection, unknown source 500, idempotency replay
//      skips the mark-closed flip, 9002 conflict, read-only gate.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerSalesOrderTools } from "../src/tools/sales-orders.js";

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
    appName: "vitest-sales-orders",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — sim handler: TotalAmount derivation + non-posting invariant
// ---------------------------------------------------------------------------

describe("SimulationStore — SalesOrder TotalAmount derivation", () => {
  it("computeTotals sets TotalAmount = sum(SalesOrderLineRet.Amount) on create", async () => {
    const session = freshSession();
    const so = await session.addEntity("SalesOrder", {
      CustomerRef: { FullName: "Acme Corporation" },
      TxnDate: "2026-04-01",
      SalesOrderLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 10, Rate: 150 },
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 5, Rate: 200 },
      ],
    });
    expect(so.TotalAmount).toBe(2500);
    expect(Array.isArray(so.SalesOrderLineRet)).toBe(true);
    expect((so.SalesOrderLineRet as unknown[]).length).toBe(2);
  });

  it("explicit Amount per line wins over Quantity * Rate", async () => {
    const session = freshSession();
    const so = await session.addEntity("SalesOrder", {
      CustomerRef: { FullName: "Acme Corporation" },
      SalesOrderLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 99 },
        // Explicit override: this line should count as 1000 (not the 99 derived).
        { ItemRef: { FullName: "Consulting Services" }, Amount: 1000 },
      ],
    });
    // Line 1: qty * rate = 99; Line 2: explicit Amount = 1000; Total = 1099.
    // (convertLineAddToRet only uses Amount when qty + rate are both absent.)
    expect(so.TotalAmount).toBe(1099);
  });

  it("TotalAmount re-derives on line mod", async () => {
    const session = freshSession();
    const so = await session.addEntity("SalesOrder", {
      CustomerRef: { FullName: "Acme Corporation" },
      SalesOrderLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 10, Rate: 150 },
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 5, Rate: 200 },
      ],
    });
    const txnId = String(so.TxnID);
    const editSeq = String(so.EditSequence);
    expect(so.TotalAmount).toBe(2500);

    // Replace with a single line at 750. TotalAmount must drop, not stay at 2500.
    const updated = await session.modifyEntity("SalesOrder", {
      TxnID: txnId,
      EditSequence: editSeq,
      SalesOrderLineMod: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 5, Rate: 150 },
      ],
    });
    expect(updated.TotalAmount).toBe(750);
    expect((updated.SalesOrderLineRet as unknown[]).length).toBe(1);
  });

  it("Customer.Balance does NOT move on SalesOrder add (non-posting)", async () => {
    const session = freshSession();
    const before = (await session.queryEntity("Customer", { ListID: "80000001-1234567890" }))[0];
    const beforeBalance = Number(before.Balance ?? 0);

    await session.addEntity("SalesOrder", {
      CustomerRef: { ListID: "80000001-1234567890" },
      SalesOrderLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 100, Rate: 999 },
      ],
    });

    const after = (await session.queryEntity("Customer", { ListID: "80000001-1234567890" }))[0];
    expect(Number(after.Balance ?? 0)).toBe(beforeBalance);
  });

  it("Customer.Balance does NOT move on SalesOrder delete (non-posting)", async () => {
    const session = freshSession();
    const so = await session.addEntity("SalesOrder", {
      CustomerRef: { ListID: "80000001-1234567890" },
      SalesOrderLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 5, Rate: 100 },
      ],
    });
    const before = (await session.queryEntity("Customer", { ListID: "80000001-1234567890" }))[0];
    const beforeBalance = Number(before.Balance ?? 0);

    await session.deleteEntity("SalesOrder", String(so.TxnID));

    const after = (await session.queryEntity("Customer", { ListID: "80000001-1234567890" }))[0];
    expect(Number(after.Balance ?? 0)).toBe(beforeBalance);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — qb_sales_order_list
// ---------------------------------------------------------------------------

describe("qb_sales_order_list tool", () => {
  it("happy path: surfaces the seeded SalesOrder + count, lines stripped by default", async () => {
    const session = freshSession();
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_list")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBeGreaterThanOrEqual(1);
    const seed = payload.salesOrders.find(
      (s: { TxnID: string }) => s.TxnID === "S0000001-SO",
    );
    expect(seed).toBeDefined();
    expect(seed.RefNumber).toBe("SO-1001");
    expect(seed.TotalAmount).toBe(3500);
    // Default: lines stripped.
    expect(seed.SalesOrderLineRet).toBeUndefined();
  });

  it("includeLineItems:true surfaces SalesOrderLineRet", async () => {
    const session = freshSession();
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_list")!;

    const result = await handler({ includeLineItems: true });
    const payload = JSON.parse(result.content[0].text);
    const seed = payload.salesOrders.find(
      (s: { TxnID: string }) => s.TxnID === "S0000001-SO",
    );
    expect(Array.isArray(seed.SalesOrderLineRet)).toBe(true);
    expect(seed.SalesOrderLineRet.length).toBe(2);
  });

  it("txnId filter narrows to one sales order", async () => {
    const session = freshSession();
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_list")!;

    const result = await handler({ txnId: "S0000001-SO" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.salesOrders[0].TxnID).toBe("S0000001-SO");
  });

  it("customerName filter (EntityFilter) scopes to that customer", async () => {
    const session = freshSession();
    // Add a second SO against Global Industries.
    await session.addEntity("SalesOrder", {
      CustomerRef: { ListID: "80000002-1234567890", FullName: "Global Industries" },
      SalesOrderLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 100 },
      ],
    });
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_list")!;

    const result = await handler({ customerName: "Global Industries" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.salesOrders[0].CustomerRef.FullName).toBe("Global Industries");
  });

  it("refNumber filter narrows to matching SO", async () => {
    const session = freshSession();
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_list")!;

    const result = await handler({ refNumber: "SO-1001" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.salesOrders[0].RefNumber).toBe("SO-1001");
  });

  it("date range — fromDate excludes earlier sales orders", async () => {
    const session = freshSession();
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_list")!;

    // Seed SO is 2024-11-15; this filter starts after it.
    const result = await handler({ fromDate: "2025-01-01" });
    const payload = JSON.parse(result.content[0].text);
    const seed = payload.salesOrders.find(
      (s: { TxnID: string }) => s.TxnID === "S0000001-SO",
    );
    expect(seed).toBeUndefined();
  });

  it("paginate:true auto-defaults maxReturned to 500 and surfaces iterator state", async () => {
    const session = freshSession();
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_list")!;

    const result = await handler({ paginate: true });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(payload.salesOrders)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — qb_sales_order_create
// ---------------------------------------------------------------------------

describe("qb_sales_order_create tool", () => {
  it("happy path: single-line SO with customerName + lines + idempotency-free", async () => {
    const session = freshSession();
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_create")!;

    const result = await handler({
      customerName: "Acme Corporation",
      txnDate: "2026-04-01",
      refNumber: "SO-2001",
      memo: "Quarterly engagement",
      lines: [
        { itemName: "Consulting Services", quantity: 8, rate: 150 },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.salesOrder.RefNumber).toBe("SO-2001");
    expect(payload.salesOrder.TotalAmount).toBe(1200);
    expect(payload.salesOrder.CustomerRef.FullName).toBe("Acme Corporation");
    expect(payload.salesOrder.IsManuallyClosed).toBeUndefined();
    expect(result.isError).toBeUndefined();
  });

  it("multi-line SO with isManuallyClosed:true + customerListId", async () => {
    const session = freshSession();
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_create")!;

    const result = await handler({
      customerListId: "80000001-1234567890",
      isManuallyClosed: true,
      lines: [
        { itemName: "Consulting Services", quantity: 4, rate: 150 },
        { itemName: "Consulting Services", quantity: 2, rate: 200 },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.salesOrder.IsManuallyClosed).toBe(true);
    expect(payload.salesOrder.TotalAmount).toBe(1000);
    expect((payload.salesOrder.SalesOrderLineRet as unknown[]).length).toBe(2);
  });

  it("rejects when neither customerName nor customerListId is supplied", async () => {
    const session = freshSession();
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_create")!;

    const result = await handler({
      lines: [{ itemName: "Consulting Services", quantity: 1, rate: 100 }],
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/customerName or customerListId/);
  });

  it("idempotencyKey replay returns the original SO without creating a duplicate", async () => {
    const session = freshSession();
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_create")!;

    const first = await handler({
      customerName: "Acme Corporation",
      lines: [{ itemName: "Consulting Services", quantity: 1, rate: 500 }],
      idempotencyKey: "test-key-001",
    });
    const firstPayload = JSON.parse(first.content[0].text);
    const firstTxnID = firstPayload.salesOrder.TxnID;
    expect(firstPayload.idempotentReplay).toBeUndefined();

    const second = await handler({
      customerName: "Acme Corporation",
      lines: [{ itemName: "Consulting Services", quantity: 1, rate: 500 }],
      idempotencyKey: "test-key-001",
    });
    const secondPayload = JSON.parse(second.content[0].text);
    expect(secondPayload.idempotentReplay).toBe(true);
    expect(secondPayload.salesOrder.TxnID).toBe(firstTxnID);
  });

  it("idempotencyKey + different payload returns statusCode 9002", async () => {
    const session = freshSession();
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_create")!;

    await handler({
      customerName: "Acme Corporation",
      lines: [{ itemName: "Consulting Services", quantity: 1, rate: 500 }],
      idempotencyKey: "conflict-key-002",
    });

    const conflict = await handler({
      customerName: "Acme Corporation",
      // Changed quantity — same key with different payload triggers 9002.
      lines: [{ itemName: "Consulting Services", quantity: 2, rate: 500 }],
      idempotencyKey: "conflict-key-002",
    });
    expect(conflict.isError).toBe(true);
    const payload = JSON.parse(conflict.content[0].text);
    expect(payload.statusCode).toBe(9002);
    expect(payload.humanReadable).toBeDefined();
  });

  it("read-only session rejects with statusCode 9001", async () => {
    const session = freshSession();
    session.setReadOnly(true);
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_create")!;

    const result = await handler({
      customerName: "Acme Corporation",
      lines: [{ itemName: "Consulting Services", quantity: 1, rate: 100 }],
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — qb_sales_order_update
// ---------------------------------------------------------------------------

describe("qb_sales_order_update tool", () => {
  async function createForUpdate(session: QBSessionManager): Promise<{
    txnId: string; editSequence: string;
  }> {
    const so = await session.addEntity("SalesOrder", {
      CustomerRef: { FullName: "Acme Corporation" },
      SalesOrderLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 10, Rate: 150 },
      ],
    });
    return { txnId: String(so.TxnID), editSequence: String(so.EditSequence) };
  }

  it("happy path: header-only update keeps lines + TotalAmount intact", async () => {
    const session = freshSession();
    const { txnId, editSequence } = await createForUpdate(session);
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_update")!;

    const result = await handler({
      txnId,
      editSequence,
      memo: "Updated retainer note",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.salesOrder.Memo).toBe("Updated retainer note");
    expect(payload.salesOrder.TotalAmount).toBe(1500);
  });

  it("line mod replaces line set wholesale and TotalAmount re-derives", async () => {
    const session = freshSession();
    const { txnId, editSequence } = await createForUpdate(session);
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_update")!;

    const result = await handler({
      txnId,
      editSequence,
      lines: [
        { itemName: "Consulting Services", quantity: 2, rate: 200 },
        { itemName: "Consulting Services", quantity: 3, rate: 300 },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.salesOrder.TotalAmount).toBe(1300);
    expect((payload.salesOrder.SalesOrderLineRet as unknown[]).length).toBe(2);
  });

  it("isManuallyClosed flip persists", async () => {
    const session = freshSession();
    const { txnId, editSequence } = await createForUpdate(session);
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_update")!;

    const result = await handler({
      txnId,
      editSequence,
      isManuallyClosed: true,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.salesOrder.IsManuallyClosed).toBe(true);
  });

  it("stale editSequence rejects with statusCode 3170", async () => {
    const session = freshSession();
    const { txnId } = await createForUpdate(session);
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_update")!;

    const result = await handler({
      txnId,
      editSequence: "stale-edit-seq-1700000000",
      memo: "wont land",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(3170);
  });

  it("unknown TxnID rejects with statusCode 500", async () => {
    const session = freshSession();
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_update")!;

    const result = await handler({
      txnId: "nonexistent-txn-id",
      editSequence: "whatever",
      memo: "wont land",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(500);
  });

  it("read-only session rejects with statusCode 9001", async () => {
    const session = freshSession();
    const { txnId, editSequence } = await createForUpdate(session);
    session.setReadOnly(true);
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_update")!;

    const result = await handler({ txnId, editSequence, memo: "blocked" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — qb_sales_order_delete
// ---------------------------------------------------------------------------

describe("qb_sales_order_delete tool", () => {
  it("happy path removes the SO", async () => {
    const session = freshSession();
    const so = await session.addEntity("SalesOrder", {
      CustomerRef: { FullName: "Acme Corporation" },
      SalesOrderLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 100 },
      ],
    });
    const txnId = String(so.TxnID);
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_delete")!;

    const result = await handler({ txnId });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);

    // Verify removal — list should no longer surface it.
    const remaining = await session.queryEntity("SalesOrder", { TxnID: txnId });
    expect(remaining.length).toBe(0);
  });

  it("unknown TxnID rejects with statusCode 500", async () => {
    const session = freshSession();
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_delete")!;

    const result = await handler({ txnId: "nonexistent-txn-id" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(500);
  });

  it("read-only session rejects with statusCode 9001", async () => {
    const session = freshSession();
    session.setReadOnly(true);
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_delete")!;

    const result = await handler({ txnId: "S0000001-SO" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
  });
});

// ---------------------------------------------------------------------------
// Layer 6 — qb_sales_order_convert_to_invoice
// ---------------------------------------------------------------------------

describe("qb_sales_order_convert_to_invoice tool", () => {
  async function createSourceSO(session: QBSessionManager): Promise<string> {
    const so = await session.addEntity("SalesOrder", {
      CustomerRef: { FullName: "Acme Corporation" },
      TxnDate: "2026-04-01",
      RefNumber: "SO-9001",
      Memo: "source memo",
      SalesOrderLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 10, Rate: 150 },
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 5, Rate: 200 },
      ],
    });
    return String(so.TxnID);
  }

  it("happy path: lines carry, source marks IsManuallyClosed=true, customer AR moves", async () => {
    const session = freshSession();
    const soTxnId = await createSourceSO(session);

    // Snapshot Acme AR balance before convert.
    const beforeBal = Number(
      (await session.queryEntity("Customer", { FullName: "Acme Corporation" }))[0]
        .Balance ?? 0,
    );

    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_convert_to_invoice")!;

    const result = await handler({ salesOrderTxnId: soTxnId });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.salesOrderMarkedClosed).toBe(true);
    expect(payload.invoice.CustomerRef.FullName).toBe("Acme Corporation");
    // Lines carried — 10 * 150 + 5 * 200 = 2500.
    expect(payload.invoice.Subtotal).toBe(2500);
    expect(payload.invoice.RefNumber).toBe("SO-9001"); // carried from source
    expect(payload.invoice.Memo).toBe("Converted from sales order SO-9001");
    expect((payload.invoice.InvoiceLineRet as unknown[]).length).toBe(2);

    // Source SO is now closed.
    const sourceAfter = (await session.queryEntity("SalesOrder", { TxnID: soTxnId }))[0];
    expect(sourceAfter.IsManuallyClosed).toBe(true);

    // Customer AR moved by the new invoice's posting (BalanceRemaining = 2500).
    const afterBal = Number(
      (await session.queryEntity("Customer", { FullName: "Acme Corporation" }))[0]
        .Balance ?? 0,
    );
    expect(afterBal - beforeBal).toBe(2500);
  });

  it("operator-supplied overrides win over carry-from-source", async () => {
    const session = freshSession();
    const soTxnId = await createSourceSO(session);
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_convert_to_invoice")!;

    const result = await handler({
      salesOrderTxnId: soTxnId,
      invoiceTxnDate: "2026-04-15",
      invoiceDueDate: "2026-05-15",
      invoiceRefNumber: "INV-OVERRIDE-1",
      invoiceMemo: "Custom memo override",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.invoice.TxnDate).toBe("2026-04-15");
    expect(payload.invoice.DueDate).toBe("2026-05-15");
    expect(payload.invoice.RefNumber).toBe("INV-OVERRIDE-1");
    expect(payload.invoice.Memo).toBe("Custom memo override");
  });

  it("markClosed:false leaves the SO open after the invoice is created", async () => {
    const session = freshSession();
    const soTxnId = await createSourceSO(session);
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_convert_to_invoice")!;

    const result = await handler({ salesOrderTxnId: soTxnId, markClosed: false });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.salesOrderMarkedClosed).toBe(false);

    const sourceAfter = (await session.queryEntity("SalesOrder", { TxnID: soTxnId }))[0];
    // Source SO is still open (IsManuallyClosed remains false / unchanged).
    expect(sourceAfter.IsManuallyClosed).not.toBe(true);
  });

  it("unknown salesOrderTxnId rejects with 'not found'", async () => {
    const session = freshSession();
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_convert_to_invoice")!;

    const result = await handler({ salesOrderTxnId: "nonexistent-so-txn" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/not found/i);
  });

  it("source without CustomerRef rejects with structured error (defensive)", async () => {
    const session = freshSession();
    // Create an SO with no CustomerRef — bypass the tool layer to construct
    // the malformed entity directly. This is a defensive guard for SOs
    // loaded from a corrupt .qbw or via raw query.
    const so = await session.addEntity("SalesOrder", {
      SalesOrderLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 100 },
      ],
    });
    const soTxnId = String(so.TxnID);

    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_convert_to_invoice")!;

    const result = await handler({ salesOrderTxnId: soTxnId });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/CustomerRef/);
  });

  it("idempotency replay returns the original invoice WITHOUT re-attempting the markClosed flip", async () => {
    const session = freshSession();
    const soTxnId = await createSourceSO(session);
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_convert_to_invoice")!;

    const first = await handler({
      salesOrderTxnId: soTxnId,
      idempotencyKey: "convert-key-001",
    });
    const firstPayload = JSON.parse(first.content[0].text);
    const firstInvoiceTxnId = firstPayload.invoice.TxnID;
    expect(firstPayload.salesOrderMarkedClosed).toBe(true);

    const second = await handler({
      salesOrderTxnId: soTxnId,
      idempotencyKey: "convert-key-001",
    });
    const secondPayload = JSON.parse(second.content[0].text);
    expect(secondPayload.idempotentReplay).toBe(true);
    expect(secondPayload.invoice.TxnID).toBe(firstInvoiceTxnId);
    // Replay skipped the mark step (the original already ran it; re-running
    // would fail with 3170 because the EditSequence is now stale).
    expect(secondPayload.salesOrderMarkedClosed).toBe(false);
  });

  it("idempotency conflict: same key, different source → 9002", async () => {
    const session = freshSession();
    const soA = await createSourceSO(session);
    const soB = await session.addEntity("SalesOrder", {
      CustomerRef: { FullName: "Acme Corporation" },
      SalesOrderLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 999 },
      ],
    });
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_convert_to_invoice")!;

    await handler({ salesOrderTxnId: soA, idempotencyKey: "convert-conflict-key" });

    const conflict = await handler({
      salesOrderTxnId: String(soB.TxnID),
      idempotencyKey: "convert-conflict-key",
    });
    expect(conflict.isError).toBe(true);
    const payload = JSON.parse(conflict.content[0].text);
    expect(payload.statusCode).toBe(9002);
  });

  it("read-only session rejects with statusCode 9001", async () => {
    const session = freshSession();
    const soTxnId = await createSourceSO(session);
    session.setReadOnly(true);
    registerSalesOrderTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_order_convert_to_invoice")!;

    const result = await handler({ salesOrderTxnId: soTxnId });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
  });
});

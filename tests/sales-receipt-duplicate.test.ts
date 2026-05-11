// Phase 12 #57a mirror — qb_sales_receipt_duplicate
//
// Cash-sale analog of qb_invoice_duplicate. Composite tool: reads source SR's
// CustomerRef + PaymentMethodRef + DepositToAccountRef + SalesReceiptLineRet
// via the existing query path, submits a fresh SalesReceiptAddRq via the
// existing add path. No new wire types.
//
// Carry policy under test:
//   carry by default — CustomerRef, PaymentMethodRef, DepositToAccountRef, lines
//   NOT carried     — TxnDate (→ today), RefNumber (→ unset), Memo (→ default)
//   override-wins   — txnDate, refNumber, memo, paymentMethodName,
//                     depositToAccountName, customerName/customerListId

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerSalesReceiptTools } from "../src/tools/sales-receipts.js";

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
    appName: "vitest-sr-duplicate",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

async function seedSalesReceipt(
  session: QBSessionManager,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return session.addEntity("SalesReceipt", {
    CustomerRef: { FullName: "Walk-In Customer" },
    TxnDate: "2026-04-15",
    RefNumber: "SR-APR-001",
    Memo: "April cash sale",
    PaymentMethodRef: { FullName: "Cash" },
    DepositToAccountRef: { FullName: "Undeposited Funds" },
    SalesReceiptLineAdd: [
      {
        ItemRef: { FullName: "Consulting Services" },
        Desc: "1-hour session",
        Quantity: 1,
        Rate: 200,
      },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — happy path: carry CustomerRef + refs + lines
// ---------------------------------------------------------------------------

describe("qb_sales_receipt_duplicate — happy path", () => {
  it("creates a new sales receipt with the same CustomerRef and lines", async () => {
    const session = freshSession();
    const source = await seedSalesReceipt(session);
    const sourceTxnId = String(source.TxnID);

    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_duplicate")!;

    const result = await handler({ sourceTxnId });
    expect(result.isError).toBeFalsy();

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.sourceTxnId).toBe(sourceTxnId);
    const dup = payload.salesReceipt;

    expect(dup.TxnID).toBeDefined();
    expect(dup.TxnID).not.toBe(sourceTxnId);

    expect(dup.CustomerRef.FullName).toBe("Walk-In Customer");

    const lines = Array.isArray(dup.SalesReceiptLineRet)
      ? dup.SalesReceiptLineRet
      : [dup.SalesReceiptLineRet];
    expect(lines).toHaveLength(1);
    expect(lines[0].ItemRef.FullName).toBe("Consulting Services");
    expect(lines[0].Desc).toBe("1-hour session");
    expect(Number(lines[0].Quantity)).toBe(1);
    expect(Number(lines[0].Rate)).toBe(200);
    expect(lines[0].TxnLineID).toBeDefined();

    expect(Number(dup.Subtotal)).toBe(200);
  });

  it("carries PaymentMethodRef and DepositToAccountRef from source", async () => {
    const session = freshSession();
    const source = await seedSalesReceipt(session);
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).salesReceipt;
    expect(dup.PaymentMethodRef.FullName).toBe("Cash");
    expect(dup.DepositToAccountRef.FullName).toBe("Undeposited Funds");
  });

  it("default Memo is 'Duplicate of <source RefNumber>'", async () => {
    const session = freshSession();
    const source = await seedSalesReceipt(session);
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).salesReceipt;
    expect(dup.Memo).toBe("Duplicate of SR-APR-001");
  });

  it("default Memo falls back to TxnID when source has no RefNumber", async () => {
    const session = freshSession();
    const source = await seedSalesReceipt(session, { RefNumber: undefined });
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).salesReceipt;
    expect(dup.Memo).toBe(`Duplicate of ${source.TxnID}`);
  });

  it("does NOT carry source's TxnDate or RefNumber", async () => {
    const session = freshSession();
    const source = await seedSalesReceipt(session);
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).salesReceipt;

    expect(dup.TxnDate).not.toBe("2026-04-15");
    expect(dup.RefNumber).toBeUndefined();
  });

  it("operator overrides win for txnDate / refNumber / memo / paymentMethodName / depositToAccountName", async () => {
    const session = freshSession();
    const source = await seedSalesReceipt(session);
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_duplicate")!;

    const result = await handler({
      sourceTxnId: String(source.TxnID),
      txnDate: "2026-05-15",
      refNumber: "SR-MAY-001",
      memo: "May cash sale",
      paymentMethodName: "Visa",
      depositToAccountName: "Operating Checking",
    });
    const dup = JSON.parse(result.content[0].text).salesReceipt;
    expect(dup.TxnDate).toBe("2026-05-15");
    expect(dup.RefNumber).toBe("SR-MAY-001");
    expect(dup.Memo).toBe("May cash sale");
    expect(dup.PaymentMethodRef.FullName).toBe("Visa");
    expect(dup.DepositToAccountRef.FullName).toBe("Operating Checking");
  });

  it("retargets to a different customer via customerName", async () => {
    const session = freshSession();
    const source = await seedSalesReceipt(session);
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_duplicate")!;

    const result = await handler({
      sourceTxnId: String(source.TxnID),
      customerName: "Repeat Customer",
    });
    const dup = JSON.parse(result.content[0].text).salesReceipt;
    expect(dup.CustomerRef.FullName).toBe("Repeat Customer");
  });

  it("retargets to a different customer via customerListId", async () => {
    const session = freshSession();
    const source = await seedSalesReceipt(session);
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_duplicate")!;

    const result = await handler({
      sourceTxnId: String(source.TxnID),
      customerListId: "CUST-77",
    });
    const dup = JSON.parse(result.content[0].text).salesReceipt;
    expect(dup.CustomerRef.ListID).toBe("CUST-77");
    expect(dup.CustomerRef.FullName).toBeUndefined();
  });

  it("source without PaymentMethodRef / DepositToAccountRef still produces a valid duplicate", async () => {
    const session = freshSession();
    const source = await session.addEntity("SalesReceipt", {
      CustomerRef: { FullName: "Walk-In Customer" },
      TxnDate: "2026-04-15",
      SalesReceiptLineAdd: [
        {
          ItemRef: { FullName: "Consulting Services" },
          Quantity: 1,
          Rate: 100,
        },
      ],
    });
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    expect(result.isError).toBeFalsy();
    const dup = JSON.parse(result.content[0].text).salesReceipt;
    expect(dup.PaymentMethodRef).toBeUndefined();
    expect(dup.DepositToAccountRef).toBeUndefined();
    expect(Number(dup.Subtotal)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — error paths
// ---------------------------------------------------------------------------

describe("qb_sales_receipt_duplicate — error paths", () => {
  it("unknown sourceTxnId returns statusCode 500 with humanReadable", async () => {
    const session = freshSession();
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_duplicate")!;

    const result = await handler({ sourceTxnId: "DOES-NOT-EXIST" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(500);
    expect(payload.humanReadable).toBeDefined();
  });

  it("read-only session rejects with statusCode 9001", async () => {
    const session = freshSession();
    const source = await seedSalesReceipt(session);
    session.setReadOnly(true);

    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
    expect(payload.humanReadable).toMatch(/read-only/i);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — idempotency
// ---------------------------------------------------------------------------

describe("qb_sales_receipt_duplicate — idempotency", () => {
  it("same key + same source returns the original duplicate with idempotentReplay: true", async () => {
    const session = freshSession();
    const source = await seedSalesReceipt(session);
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_duplicate")!;

    const r1 = await handler({
      sourceTxnId: String(source.TxnID),
      idempotencyKey: "dup-sr-1",
    });
    const p1 = JSON.parse(r1.content[0].text);
    expect(p1.success).toBe(true);
    const firstTxnId = p1.salesReceipt.TxnID;

    const r2 = await handler({
      sourceTxnId: String(source.TxnID),
      idempotencyKey: "dup-sr-1",
    });
    const p2 = JSON.parse(r2.content[0].text);
    expect(p2.idempotentReplay).toBe(true);
    expect(p2.salesReceipt.TxnID).toBe(firstTxnId);
  });

  it("same key + different source returns statusCode 9002", async () => {
    const session = freshSession();
    const sourceA = await seedSalesReceipt(session);
    const sourceB = await seedSalesReceipt(session, { RefNumber: "SR-APR-002" });
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_duplicate")!;

    await handler({
      sourceTxnId: String(sourceA.TxnID),
      idempotencyKey: "dup-sr-2",
    });

    const r2 = await handler({
      sourceTxnId: String(sourceB.TxnID),
      idempotencyKey: "dup-sr-2",
    });
    expect(r2.isError).toBe(true);
    const p2 = JSON.parse(r2.content[0].text);
    expect(p2.statusCode).toBe(9002);
  });
});

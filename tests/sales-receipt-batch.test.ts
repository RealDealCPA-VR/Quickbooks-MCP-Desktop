// Phase 12 #58 — qb_sales_receipt_batch_create.
//
// SR batch mirror of invoice-batch.test.ts. SR is cash-side — no AR balance
// reversal on rollback (handleTxnDel for SalesReceipt is a pure record
// removal). The compensating-delete envelope shape is otherwise identical
// to the invoice batch tool.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerSalesReceiptTools } from "../src/tools/sales-receipts.js";

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

function freshSession(): QBSessionManager {
  return new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-batch-sr",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

beforeEach(() => {
  handlers.clear();
  schemas.clear();
});

describe("qb_sales_receipt_batch_create — full-success path", () => {
  it("posts all entries and returns positionally-aligned TxnIDs", async () => {
    const session = freshSession();
    await session.openSession();
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_batch_create")!;

    const result = await handler({
      receipts: [
        {
          customerName: "Acme Corporation",
          refNumber: "BATCH-SR-1",
          paymentMethodName: "Visa",
          depositToAccountName: "Undeposited Funds",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 100 }],
        },
        {
          customerName: "Global Industries",
          refNumber: "BATCH-SR-2",
          paymentMethodName: "Cash",
          depositToAccountName: "Checking",
          lines: [{ itemName: "Consulting", quantity: 2, rate: 50 }],
        },
        {
          customerName: "Acme Corporation",
          refNumber: "BATCH-SR-3",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 200 }],
        },
      ],
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.count).toBe(3);
    expect(payload.salesReceipts).toHaveLength(3);
    expect(payload.salesReceipts[0].status).toBe("posted");
    expect(payload.salesReceipts[0].refNumber).toBe("BATCH-SR-1");
    expect(payload.salesReceipts[0].txnId).toBeTruthy();
    expect(payload.salesReceipts[1].refNumber).toBe("BATCH-SR-2");
    expect(payload.salesReceipts[2].refNumber).toBe("BATCH-SR-3");

    const txnIds = payload.salesReceipts.map((e: { txnId: string }) => e.txnId);
    expect(new Set(txnIds).size).toBe(3);

    const all = await session.queryEntity("SalesReceipt", {});
    const batchRefs = all
      .map((sr) => (sr as { RefNumber?: string }).RefNumber)
      .filter((r) => r?.startsWith("BATCH-SR-"));
    expect(batchRefs).toHaveLength(3);
  });

  it("a single-entry batch still posts", async () => {
    const session = freshSession();
    await session.openSession();
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_batch_create")!;

    const result = await handler({
      receipts: [
        {
          customerName: "Acme Corporation",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 100 }],
        },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.salesReceipts[0].txnId).toBeTruthy();
  });

  it("PaymentMethodRef and DepositToAccountRef from the entry carry onto the posted receipt", async () => {
    const session = freshSession();
    await session.openSession();
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_batch_create")!;

    const result = await handler({
      receipts: [
        {
          customerName: "Acme Corporation",
          refNumber: "SR-REFS",
          paymentMethodName: "Visa",
          depositToAccountName: "Undeposited Funds",
          lines: [{ itemName: "Consulting", amount: 100 }],
        },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);

    const [stored] = await session.queryEntity("SalesReceipt", {
      RefNumber: "SR-REFS",
    });
    expect(
      (stored.PaymentMethodRef as { FullName?: string }).FullName,
    ).toBe("Visa");
    expect(
      (stored.DepositToAccountRef as { FullName?: string }).FullName,
    ).toBe("Undeposited Funds");
  });
});

describe("qb_sales_receipt_batch_create — Customer.Balance composition", () => {
  it("posted receipts do NOT move Customer.Balance (cash sale — no AR posting)", async () => {
    const session = freshSession();
    await session.openSession();
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_batch_create")!;

    const [before] = await session.queryEntity("Customer", {
      FullName: "Acme Corporation",
    });
    const beforeBalance = Number(before.Balance ?? 0);

    await handler({
      receipts: [
        {
          customerName: "Acme Corporation",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 500 }],
        },
        {
          customerName: "Acme Corporation",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 750 }],
        },
      ],
    });

    const [after] = await session.queryEntity("Customer", {
      FullName: "Acme Corporation",
    });
    const afterBalance = Number(after.Balance ?? 0);
    // No AR move — cash sales settle to the deposit account, not AR.
    expect(afterBalance).toBeCloseTo(beforeBalance, 2);
  });
});

describe("qb_sales_receipt_batch_create — upfront validation rejects before wire", () => {
  it("rejects when any entry lacks both customerName and customerListId, with no wire I/O", async () => {
    const session = freshSession();
    await session.openSession();
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_batch_create")!;
    const sendSpy = vi.spyOn(session, "sendRequest");

    const result = await handler({
      receipts: [
        {
          customerName: "Acme Corporation",
          lines: [{ itemName: "Consulting", amount: 100 }],
        },
        {
          // No customer ref.
          lines: [{ itemName: "Consulting", amount: 200 }],
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(3120);
    expect(payload.validationErrors).toHaveLength(1);
    expect(payload.validationErrors[0].index).toBe(1);
  });
});

describe("qb_sales_receipt_batch_create — schema bounds", () => {
  it("rejects empty receipts array (zod .min(1))", () => {
    const session = freshSession();
    registerSalesReceiptTools(fakeServer as never, () => session);
    const schema = z.object(schemas.get("qb_sales_receipt_batch_create")!);
    expect(() => schema.parse({ receipts: [] })).toThrow();
  });

  it("rejects > 100 entries (zod .max(100))", () => {
    const session = freshSession();
    registerSalesReceiptTools(fakeServer as never, () => session);
    const schema = z.object(schemas.get("qb_sales_receipt_batch_create")!);
    const tooMany = Array.from({ length: 101 }, () => ({
      customerName: "Acme Corporation",
    }));
    expect(() => schema.parse({ receipts: tooMany })).toThrow();
  });

  it("accepts exactly 100 entries (boundary)", () => {
    const session = freshSession();
    registerSalesReceiptTools(fakeServer as never, () => session);
    const schema = z.object(schemas.get("qb_sales_receipt_batch_create")!);
    const exactly100 = Array.from({ length: 100 }, () => ({
      customerName: "Acme Corporation",
    }));
    expect(() => schema.parse({ receipts: exactly100 })).not.toThrow();
  });
});

describe("qb_sales_receipt_batch_create — compensating rollback on mid-batch wire failure", () => {
  it("auto-deletes prior-posted receipts in REVERSE order and reports them as 'rolled-back'", async () => {
    const session = freshSession();
    await session.openSession();
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_batch_create")!;

    const executeSpy = vi
      .spyOn(session, "executeBatchAdd")
      .mockResolvedValueOnce([
        {
          requestID: "1",
          status: "posted",
          entity: { TxnID: "SR-FAKE-1", RefNumber: "BATCH-SR-ROLL-1" },
        },
        {
          requestID: "2",
          status: "posted",
          entity: { TxnID: "SR-FAKE-2", RefNumber: "BATCH-SR-ROLL-2" },
        },
        {
          requestID: "3",
          status: "failed",
          statusCode: 3120,
          statusMessage: "missing required element: ItemRef",
        },
        { requestID: "4", status: "skipped" },
      ]);
    const deleteSpy = vi
      .spyOn(session, "deleteEntity")
      .mockResolvedValue({ TxnID: "deleted" });

    const result = await handler({
      receipts: [
        {
          customerName: "Acme Corporation",
          refNumber: "BATCH-SR-ROLL-1",
          lines: [{ itemName: "Consulting", amount: 100 }],
        },
        {
          customerName: "Acme Corporation",
          refNumber: "BATCH-SR-ROLL-2",
          lines: [{ itemName: "Consulting", amount: 200 }],
        },
        {
          customerName: "Acme Corporation",
          refNumber: "BATCH-SR-ROLL-3",
          lines: [{ itemName: "Consulting", amount: 300 }],
        },
        {
          customerName: "Acme Corporation",
          refNumber: "BATCH-SR-ROLL-4",
          lines: [{ itemName: "Consulting", amount: 400 }],
        },
      ],
    });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.atomic).toBe(true);
    expect(payload.rolledBack).toBe(true);
    expect(payload.failedAt).toBe(2);

    expect(payload.summary.failed).toBe(1);
    expect(payload.summary.skipped).toBe(1);
    expect(payload.summary.rolledBack).toBe(2);
    expect(payload.summary.rolledBackTxnIds).toEqual(["SR-FAKE-1", "SR-FAKE-2"]);

    expect(payload.salesReceipts[0].status).toBe("rolled-back");
    expect(payload.salesReceipts[0].originalTxnId).toBe("SR-FAKE-1");
    expect(payload.salesReceipts[1].status).toBe("rolled-back");
    expect(payload.salesReceipts[1].originalTxnId).toBe("SR-FAKE-2");
    expect(payload.salesReceipts[2].status).toBe("failed");
    expect(payload.salesReceipts[3].status).toBe("skipped");

    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy.mock.calls[0]).toEqual(["SalesReceipt", "SR-FAKE-2"]);
    expect(deleteSpy.mock.calls[1]).toEqual(["SalesReceipt", "SR-FAKE-1"]);
  });

  it("surfaces 'orphaned' status when rollback delete itself fails", async () => {
    const session = freshSession();
    await session.openSession();
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_batch_create")!;

    vi.spyOn(session, "executeBatchAdd").mockResolvedValueOnce([
      {
        requestID: "1",
        status: "posted",
        entity: { TxnID: "SR-ORPH-1", RefNumber: "SR-ORPH-1" },
      },
      {
        requestID: "2",
        status: "failed",
        statusCode: 3120,
        statusMessage: "wire-side rejection",
      },
    ]);
    vi.spyOn(session, "deleteEntity").mockRejectedValue(
      new Error("TxnDelRq rejected: deposit batch already cleared"),
    );

    const result = await handler({
      receipts: [
        {
          customerName: "Acme Corporation",
          refNumber: "SR-ORPH-1",
          lines: [{ itemName: "Consulting", amount: 100 }],
        },
        {
          customerName: "Acme Corporation",
          refNumber: "SR-ORPH-2",
          lines: [{ itemName: "Consulting", amount: 200 }],
        },
      ],
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.rolledBack).toBe(false);
    expect(payload.summary.orphaned).toHaveLength(1);
    expect(payload.summary.orphaned[0].txnId).toBe("SR-ORPH-1");
    expect(payload.summary.orphaned[0].reason).toMatch(/already cleared/);

    expect(payload.salesReceipts[0].status).toBe("orphaned");
    expect(payload.salesReceipts[0].rollbackError).toMatch(/already cleared/);
  });
});

describe("qb_sales_receipt_batch_create — idempotency", () => {
  it("full-success batch + idempotencyKey: replay returns idempotentReplay: true with same TxnIDs", async () => {
    const session = freshSession();
    await session.openSession();
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_batch_create")!;

    const args = {
      receipts: [
        {
          customerName: "Acme Corporation",
          refNumber: "IDEMP-SR-1",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 100 }],
        },
        {
          customerName: "Global Industries",
          refNumber: "IDEMP-SR-2",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 200 }],
        },
      ],
      idempotencyKey: "sr-batch-key-1",
    };

    const first = JSON.parse((await handler(args)).content[0].text);
    expect(first.success).toBe(true);
    expect(first.idempotentReplay).toBeUndefined();
    const firstTxnIds = first.salesReceipts.map(
      (e: { txnId: string }) => e.txnId,
    );

    const second = JSON.parse((await handler(args)).content[0].text);
    expect(second.success).toBe(true);
    expect(second.idempotentReplay).toBe(true);
    const secondTxnIds = second.salesReceipts.map(
      (e: { txnId: string }) => e.txnId,
    );
    expect(secondTxnIds).toEqual(firstTxnIds);

    const all = await session.queryEntity("SalesReceipt", {});
    const matches = all.filter((sr) => {
      const ref = (sr as { RefNumber?: string }).RefNumber;
      return ref === "IDEMP-SR-1" || ref === "IDEMP-SR-2";
    });
    expect(matches.length).toBe(2);
  });

  it("different entries with same key returns 9002 conflict", async () => {
    const session = freshSession();
    await session.openSession();
    registerSalesReceiptTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_sales_receipt_batch_create")!;

    const first = await handler({
      receipts: [
        {
          customerName: "Acme Corporation",
          refNumber: "SR-CONF-A",
          lines: [{ itemName: "Consulting", amount: 100 }],
        },
      ],
      idempotencyKey: "sr-batch-conflict",
    });
    expect(JSON.parse(first.content[0].text).success).toBe(true);

    const second = await handler({
      receipts: [
        {
          customerName: "Acme Corporation",
          refNumber: "SR-CONF-B",
          lines: [{ itemName: "Consulting", amount: 100 }],
        },
      ],
      idempotencyKey: "sr-batch-conflict",
    });
    const payload = JSON.parse(second.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(9002);
  });
});

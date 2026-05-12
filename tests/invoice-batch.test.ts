// Phase 12 #58 — qb_invoice_batch_create.
//
// Tests are scoped to the entity-specific behavior of the invoice batch tool;
// the generic multi-request envelope plumbing (sequential requestID, parser
// requestID capture, stopOnError dispatch) is already pinned by the JE batch
// suite (tests/journal-entry-batch.test.ts) and shares the same code path.
//
// Coverage layers:
//   1. Full-success path — multi-entry, single-entry sanity.
//   2. Upfront customer-ref validation rejects before any wire I/O.
//   3. Schema bounds (1..100).
//   4. Partial-failure rollback — mocks executeBatchAdd to inject a wire-side
//      posted+failed+skipped mix, verifies the tool deletes in REVERSE order
//      and surfaces 'rolled-back' status alignment.
//   5. Orphaned status when the compensating delete itself fails.
//   6. Idempotency — full-success replay, validation-rejection not cached.
//   7. Customer.Balance composition — handleAdd moves AR for each posted
//      invoice; verified by checking the customer balance after a batch.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerInvoiceTools } from "../src/tools/invoices.js";

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
    appName: "vitest-batch-invoice",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

beforeEach(() => {
  handlers.clear();
  schemas.clear();
});

describe("qb_invoice_batch_create — full-success path", () => {
  it("posts all entries through the real sim and returns positionally-aligned TxnIDs", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_batch_create")!;

    const result = await handler({
      invoices: [
        {
          customerName: "Acme Corporation",
          refNumber: "BATCH-INV-1",
          memo: "Retainer Jan",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 1000 }],
        },
        {
          customerName: "Global Industries",
          refNumber: "BATCH-INV-2",
          memo: "Retainer Jan",
          lines: [{ itemName: "Consulting", quantity: 2, rate: 1000 }],
        },
        {
          customerListId: "80000001-1234567890",
          refNumber: "BATCH-INV-3",
          memo: "By ListID",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 500 }],
        },
      ],
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.count).toBe(3);
    expect(payload.invoices).toHaveLength(3);
    expect(payload.invoices[0].status).toBe("posted");
    expect(payload.invoices[0].refNumber).toBe("BATCH-INV-1");
    expect(payload.invoices[0].txnId).toBeTruthy();
    expect(payload.invoices[1].refNumber).toBe("BATCH-INV-2");
    expect(payload.invoices[2].refNumber).toBe("BATCH-INV-3");

    const txnIds = payload.invoices.map((e: { txnId: string }) => e.txnId);
    expect(new Set(txnIds).size).toBe(3);

    // Verify all three are actually in the sim store.
    const all = await session.queryEntity("Invoice", {});
    const batchRefs = all
      .map((inv) => (inv as { RefNumber?: string }).RefNumber)
      .filter((r) => r?.startsWith("BATCH-INV-"));
    expect(batchRefs).toHaveLength(3);
  });

  it("a single-entry batch still posts (no special-cased path)", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_batch_create")!;

    const result = await handler({
      invoices: [
        {
          customerName: "Acme Corporation",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 100 }],
        },
      ],
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.invoices[0].txnId).toBeTruthy();
  });

  it("header-only invoices (no lines) post — matches qb_invoice_create's optional-lines schema", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_batch_create")!;

    const result = await handler({
      invoices: [
        { customerName: "Acme Corporation", refNumber: "HEADER-ONLY-1" },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.invoices[0].refNumber).toBe("HEADER-ONLY-1");
  });
});

describe("qb_invoice_batch_create — Customer.Balance composition", () => {
  it("each posted invoice moves Customer.Balance via handleAdd (sum across batch)", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_batch_create")!;

    const [before] = await session.queryEntity("Customer", {
      FullName: "Acme Corporation",
    });
    const beforeBalance = Number(before.Balance ?? 0);

    await handler({
      invoices: [
        {
          customerName: "Acme Corporation",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 500 }],
        },
        {
          customerName: "Acme Corporation",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 750 }],
        },
        {
          customerName: "Acme Corporation",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 250 }],
        },
      ],
    });

    const [after] = await session.queryEntity("Customer", {
      FullName: "Acme Corporation",
    });
    const afterBalance = Number(after.Balance ?? 0);
    // Three invoices for 500 + 750 + 250 = 1500 added to the open balance.
    expect(afterBalance - beforeBalance).toBeCloseTo(1500, 2);
  });
});

describe("qb_invoice_batch_create — upfront validation rejects before wire", () => {
  it("rejects when any entry lacks both customerName and customerListId, with no wire I/O", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_batch_create")!;
    const sendSpy = vi.spyOn(session, "sendRequest");

    const result = await handler({
      invoices: [
        {
          customerName: "Acme Corporation",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 100 }],
        },
        {
          // No customer ref — should reject the WHOLE batch.
          lines: [{ itemName: "Consulting", quantity: 1, rate: 200 }],
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
    expect(payload.validationErrors[0].error).toMatch(/Entry 2/);
  });

  it("surfaces all failing entries (not just the first) in a single rejection", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_batch_create")!;

    const result = await handler({
      invoices: [
        { customerName: "Acme Corporation" },
        { lines: [{ itemName: "Consulting", amount: 100 }] }, // no ref
        { customerName: "Global Industries" },
        { lines: [{ itemName: "Consulting", amount: 200 }] }, // no ref
      ],
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.validationErrors).toHaveLength(2);
    expect(payload.validationErrors[0].index).toBe(1);
    expect(payload.validationErrors[1].index).toBe(3);
  });
});

describe("qb_invoice_batch_create — schema bounds", () => {
  it("rejects empty invoices array (zod .min(1))", () => {
    const session = freshSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const schema = z.object(schemas.get("qb_invoice_batch_create")!);
    expect(() => schema.parse({ invoices: [] })).toThrow();
  });

  it("rejects > 100 entries (zod .max(100))", () => {
    const session = freshSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const schema = z.object(schemas.get("qb_invoice_batch_create")!);
    const tooMany = Array.from({ length: 101 }, () => ({
      customerName: "Acme Corporation",
    }));
    expect(() => schema.parse({ invoices: tooMany })).toThrow();
  });

  it("accepts exactly 100 entries (boundary)", () => {
    const session = freshSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const schema = z.object(schemas.get("qb_invoice_batch_create")!);
    const exactly100 = Array.from({ length: 100 }, () => ({
      customerName: "Acme Corporation",
    }));
    expect(() => schema.parse({ invoices: exactly100 })).not.toThrow();
  });
});

describe("qb_invoice_batch_create — compensating rollback on mid-batch wire failure", () => {
  it("auto-deletes prior-posted invoices in REVERSE order and reports them as 'rolled-back'", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_batch_create")!;

    // Mock executeBatchAdd to inject a wire-side mix: 2 posted, 1 failed, 1
    // skipped. The tool's rollback path then runs against the real session's
    // deleteEntity (also mocked here to track call order).
    const executeSpy = vi
      .spyOn(session, "executeBatchAdd")
      .mockResolvedValueOnce([
        {
          requestID: "1",
          status: "posted",
          entity: {
            TxnID: "INV-FAKE-1",
            RefNumber: "BATCH-ROLL-1",
            CustomerRef: { FullName: "Acme Corporation" },
          },
        },
        {
          requestID: "2",
          status: "posted",
          entity: {
            TxnID: "INV-FAKE-2",
            RefNumber: "BATCH-ROLL-2",
            CustomerRef: { FullName: "Acme Corporation" },
          },
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
      invoices: [
        {
          customerName: "Acme Corporation",
          refNumber: "BATCH-ROLL-1",
          lines: [{ itemName: "Consulting", amount: 100 }],
        },
        {
          customerName: "Acme Corporation",
          refNumber: "BATCH-ROLL-2",
          lines: [{ itemName: "Consulting", amount: 200 }],
        },
        {
          customerName: "Acme Corporation",
          refNumber: "BATCH-ROLL-3",
          lines: [{ itemName: "Consulting", amount: 300 }],
        },
        {
          customerName: "Acme Corporation",
          refNumber: "BATCH-ROLL-4",
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
    expect(payload.failedReason.statusCode).toBe(3120);

    expect(payload.summary.failed).toBe(1);
    expect(payload.summary.skipped).toBe(1);
    expect(payload.summary.rolledBack).toBe(2);
    expect(payload.summary.rolledBackTxnIds).toEqual(["INV-FAKE-1", "INV-FAKE-2"]);
    expect(payload.summary.orphaned).toBeUndefined();

    expect(payload.invoices[0].status).toBe("rolled-back");
    expect(payload.invoices[0].originalTxnId).toBe("INV-FAKE-1");
    expect(payload.invoices[1].status).toBe("rolled-back");
    expect(payload.invoices[1].originalTxnId).toBe("INV-FAKE-2");
    expect(payload.invoices[2].status).toBe("failed");
    expect(payload.invoices[2].statusCode).toBe(3120);
    expect(payload.invoices[3].status).toBe("skipped");

    // Two rollback deletes, in REVERSE post order so the most-recent invoice
    // is deleted first.
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy.mock.calls[0]).toEqual(["Invoice", "INV-FAKE-2"]);
    expect(deleteSpy.mock.calls[1]).toEqual(["Invoice", "INV-FAKE-1"]);
  });

  it("surfaces 'orphaned' status when rollback delete itself fails", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_batch_create")!;

    vi.spyOn(session, "executeBatchAdd").mockResolvedValueOnce([
      {
        requestID: "1",
        status: "posted",
        entity: { TxnID: "INV-ORPH-1", RefNumber: "ORPH-1" },
      },
      {
        requestID: "2",
        status: "failed",
        statusCode: 3120,
        statusMessage: "wire-side rejection",
      },
    ]);
    vi.spyOn(session, "deleteEntity").mockRejectedValue(
      new Error("TxnDelRq rejected: invoice has applied payments"),
    );

    const result = await handler({
      invoices: [
        {
          customerName: "Acme Corporation",
          refNumber: "ORPH-1",
          lines: [{ itemName: "Consulting", amount: 100 }],
        },
        {
          customerName: "Acme Corporation",
          refNumber: "ORPH-2",
          lines: [{ itemName: "Consulting", amount: 200 }],
        },
      ],
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.rolledBack).toBe(false);
    expect(payload.summary.rolledBack).toBe(0);
    expect(payload.summary.orphaned).toHaveLength(1);
    expect(payload.summary.orphaned[0].txnId).toBe("INV-ORPH-1");
    expect(payload.summary.orphaned[0].reason).toMatch(/applied payments/);

    expect(payload.invoices[0].status).toBe("orphaned");
    expect(payload.invoices[0].txnId).toBe("INV-ORPH-1");
    expect(payload.invoices[0].rollbackError).toMatch(/applied payments/);
    expect(payload.invoices[1].status).toBe("failed");
  });
});

describe("qb_invoice_batch_create — idempotency", () => {
  it("full-success batch + idempotencyKey: replay returns idempotentReplay: true with same TxnIDs", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_batch_create")!;

    const args = {
      invoices: [
        {
          customerName: "Acme Corporation",
          refNumber: "IDEMP-INV-1",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 100 }],
        },
        {
          customerName: "Global Industries",
          refNumber: "IDEMP-INV-2",
          lines: [{ itemName: "Consulting", quantity: 1, rate: 200 }],
        },
      ],
      idempotencyKey: "invoice-batch-key-1",
    };

    const first = JSON.parse((await handler(args)).content[0].text);
    expect(first.success).toBe(true);
    expect(first.idempotentReplay).toBeUndefined();
    const firstTxnIds = first.invoices.map((e: { txnId: string }) => e.txnId);
    expect(firstTxnIds.every((id: string) => id.length > 0)).toBe(true);

    const second = JSON.parse((await handler(args)).content[0].text);
    expect(second.success).toBe(true);
    expect(second.idempotentReplay).toBe(true);
    const secondTxnIds = second.invoices.map((e: { txnId: string }) => e.txnId);
    expect(secondTxnIds).toEqual(firstTxnIds);

    // Wire-side: only 2 invoices in the store (replay didn't duplicate)
    const all = await session.queryEntity("Invoice", {});
    const matches = all.filter((inv) => {
      const ref = (inv as { RefNumber?: string }).RefNumber;
      return ref === "IDEMP-INV-1" || ref === "IDEMP-INV-2";
    });
    expect(matches.length).toBe(2);
  });

  it("upfront customer-ref-validation rejection is NOT cached — fresh retry runs validation again", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_batch_create")!;

    const bad = {
      invoices: [{ lines: [{ itemName: "Consulting", amount: 100 }] }],
      idempotencyKey: "invoice-batch-validation",
    };
    const reject1 = JSON.parse((await handler(bad)).content[0].text);
    expect(reject1.success).toBe(false);
    expect(reject1.statusCode).toBe(3120);

    // Same key with corrected payload should NOT be a 9002 conflict — the
    // bad payload was never cached.
    const corrected = {
      invoices: [{ customerName: "Acme Corporation" }],
      idempotencyKey: "invoice-batch-validation",
    };
    const out = JSON.parse((await handler(corrected)).content[0].text);
    expect(out.success).toBe(true);
    expect(out.idempotentReplay).toBeUndefined();
  });

  it("different entries with same key returns 9002 conflict", async () => {
    const session = freshSession();
    await session.openSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_batch_create")!;

    const first = await handler({
      invoices: [
        {
          customerName: "Acme Corporation",
          refNumber: "CONFLICT-A",
          lines: [{ itemName: "Consulting", amount: 100 }],
        },
      ],
      idempotencyKey: "invoice-batch-conflict",
    });
    expect(JSON.parse(first.content[0].text).success).toBe(true);

    const second = await handler({
      invoices: [
        {
          customerName: "Acme Corporation",
          refNumber: "CONFLICT-B", // different
          lines: [{ itemName: "Consulting", amount: 100 }],
        },
      ],
      idempotencyKey: "invoice-batch-conflict",
    });
    const payload = JSON.parse(second.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(9002);
  });
});

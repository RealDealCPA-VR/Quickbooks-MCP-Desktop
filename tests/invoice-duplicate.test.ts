// Phase 12 #57a — qb_invoice_duplicate
//
// Workflow stand-in for the #45 SDK gap (memorized transactions aren't
// exposed by QBXML at any version). Composite tool: reads source invoice's
// CustomerRef + InvoiceLineRet via the existing query path, submits a fresh
// InvoiceAddRq via the existing add path. No new wire types — coverage
// focuses on the carry/non-carry policy and the error surfaces.
//
// Carry policy under test:
//   carry by default — CustomerRef, lines, ClassRef/TermsRef/SalesRepRef/PORefNumber
//   NOT carried     — TxnDate (→ today), DueDate, RefNumber (→ unset), Memo (→ default)
//   override-wins   — txnDate, dueDate, refNumber, memo, customerName/customerListId

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerInvoiceTools } from "../src/tools/invoices.js";

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
    appName: "vitest-invoice-duplicate",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

async function seedInvoice(
  session: QBSessionManager,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return session.addEntity("Invoice", {
    CustomerRef: { FullName: "Acme Corporation" },
    TxnDate: "2026-04-15",
    RefNumber: "INV-APR-001",
    DueDate: "2026-05-15",
    Memo: "April retainer",
    InvoiceLineAdd: [
      {
        ItemRef: { FullName: "Consulting Services" },
        Desc: "Monthly retainer",
        Quantity: 10,
        Rate: 150,
      },
      {
        ItemRef: { FullName: "Consulting Services" },
        Desc: "Project review",
        Quantity: 2,
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
// Layer 1 — happy path: carry CustomerRef + lines onto a fresh invoice
// ---------------------------------------------------------------------------

describe("qb_invoice_duplicate — happy path", () => {
  it("creates a new invoice with the same CustomerRef and lines", async () => {
    const session = freshSession();
    const source = await seedInvoice(session);
    const sourceTxnId = String(source.TxnID);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_duplicate")!;

    const result = await handler({ sourceTxnId });
    expect(result.isError).toBeFalsy();

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.sourceTxnId).toBe(sourceTxnId);
    const dup = payload.invoice;

    // New TxnID, distinct from source.
    expect(dup.TxnID).toBeDefined();
    expect(dup.TxnID).not.toBe(sourceTxnId);

    // CustomerRef carries.
    expect(dup.CustomerRef.FullName).toBe("Acme Corporation");

    // Lines carry — same count, same items, same qty/rate. TxnLineIDs are
    // freshly generated on the new invoice (NOT carried from source).
    const lines = Array.isArray(dup.InvoiceLineRet)
      ? dup.InvoiceLineRet
      : [dup.InvoiceLineRet];
    expect(lines).toHaveLength(2);
    expect(lines[0].ItemRef.FullName).toBe("Consulting Services");
    expect(lines[0].Desc).toBe("Monthly retainer");
    expect(Number(lines[0].Quantity)).toBe(10);
    expect(Number(lines[0].Rate)).toBe(150);
    expect(lines[0].TxnLineID).toBeDefined();
    const sourceLines = Array.isArray(source.InvoiceLineRet)
      ? source.InvoiceLineRet as Array<{ TxnLineID: string }>
      : [source.InvoiceLineRet as { TxnLineID: string }];
    expect(lines[0].TxnLineID).not.toBe(sourceLines[0].TxnLineID);

    // Subtotal recomputed from the carried lines: 10*150 + 2*200 = 1900.
    expect(Number(dup.Subtotal)).toBe(1900);
  });

  it("default Memo is 'Duplicate of <source RefNumber>'", async () => {
    const session = freshSession();
    const source = await seedInvoice(session);
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).invoice;
    expect(dup.Memo).toBe("Duplicate of INV-APR-001");
  });

  it("default Memo falls back to TxnID when source has no RefNumber", async () => {
    const session = freshSession();
    const source = await seedInvoice(session, { RefNumber: undefined });
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).invoice;
    expect(dup.Memo).toBe(`Duplicate of ${source.TxnID}`);
  });

  it("does NOT carry source's TxnDate / DueDate / RefNumber", async () => {
    const session = freshSession();
    const source = await seedInvoice(session);
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).invoice;

    // Source had TxnDate "2026-04-15"; duplicate must NOT carry it.
    expect(dup.TxnDate).not.toBe("2026-04-15");
    // Duplicate's RefNumber should be unset (operator didn't override and we
    // don't carry — avoids the collision real QB would reject).
    expect(dup.RefNumber).toBeUndefined();
    // DueDate likewise unset by default.
    expect(dup.DueDate).toBeUndefined();
  });

  it("operator overrides win for txnDate / dueDate / refNumber / memo", async () => {
    const session = freshSession();
    const source = await seedInvoice(session);
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_duplicate")!;

    const result = await handler({
      sourceTxnId: String(source.TxnID),
      txnDate: "2026-05-15",
      dueDate: "2026-06-15",
      refNumber: "INV-MAY-001",
      memo: "May retainer",
    });
    const dup = JSON.parse(result.content[0].text).invoice;
    expect(dup.TxnDate).toBe("2026-05-15");
    expect(dup.DueDate).toBe("2026-06-15");
    expect(dup.RefNumber).toBe("INV-MAY-001");
    expect(dup.Memo).toBe("May retainer");
  });

  it("retargets to a different customer via customerName", async () => {
    const session = freshSession();
    const source = await seedInvoice(session);
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_duplicate")!;

    const result = await handler({
      sourceTxnId: String(source.TxnID),
      customerName: "Global Industries",
    });
    const dup = JSON.parse(result.content[0].text).invoice;
    expect(dup.CustomerRef.FullName).toBe("Global Industries");
  });

  it("retargets to a different customer via customerListId", async () => {
    const session = freshSession();
    const source = await seedInvoice(session);
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_duplicate")!;

    const result = await handler({
      sourceTxnId: String(source.TxnID),
      customerListId: "CUST-99",
    });
    const dup = JSON.parse(result.content[0].text).invoice;
    expect(dup.CustomerRef.ListID).toBe("CUST-99");
    expect(dup.CustomerRef.FullName).toBeUndefined();
  });

  it("carries ClassRef / TermsRef / SalesRepRef / PORefNumber when present on source", async () => {
    const session = freshSession();
    const source = await seedInvoice(session, {
      ClassRef: { FullName: "Consulting" },
      TermsRef: { FullName: "Net 30" },
      SalesRepRef: { FullName: "VR" },
      PORefNumber: "PO-2026-001",
    });
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).invoice;
    expect(dup.ClassRef.FullName).toBe("Consulting");
    expect(dup.TermsRef.FullName).toBe("Net 30");
    expect(dup.SalesRepRef.FullName).toBe("VR");
    expect(dup.PORefNumber).toBe("PO-2026-001");
  });

  it("header-only source (no lines) produces a header-only duplicate", async () => {
    const session = freshSession();
    const source = await session.addEntity("Invoice", {
      CustomerRef: { FullName: "Acme Corporation" },
      TxnDate: "2026-04-15",
      Memo: "Header only",
    });
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    expect(result.isError).toBeFalsy();
    const dup = JSON.parse(result.content[0].text).invoice;
    // No line array on the duplicate (matches source).
    expect(dup.InvoiceLineRet).toBeUndefined();
    expect(Number(dup.Subtotal ?? 0)).toBe(0);
  });

  it("duplicating increases customer's open balance by the new invoice's Subtotal", async () => {
    // Real-QB behavior: each new invoice posts its own AR — duplicating
    // doubles the open balance against that customer. This pins the
    // composition with handleAdd's balance bookkeeping.
    const session = freshSession();
    const source = await seedInvoice(session);
    const customersBefore = await session.queryEntity("Customer", { FullName: "Acme Corporation" });
    const balanceBefore = Number((customersBefore[0] as { Balance?: number }).Balance ?? 0);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_duplicate")!;
    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).invoice;

    const customersAfter = await session.queryEntity("Customer", { FullName: "Acme Corporation" });
    const balanceAfter = Number((customersAfter[0] as { Balance?: number }).Balance ?? 0);
    expect(balanceAfter - balanceBefore).toBeCloseTo(Number(dup.BalanceRemaining), 2);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — error paths
// ---------------------------------------------------------------------------

describe("qb_invoice_duplicate — error paths", () => {
  it("unknown sourceTxnId returns statusCode 500 with humanReadable", async () => {
    const session = freshSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_duplicate")!;

    const result = await handler({ sourceTxnId: "DOES-NOT-EXIST" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(500);
    expect(payload.humanReadable).toBeDefined();
  });

  it("read-only session rejects with statusCode 9001 (add half is gated)", async () => {
    const session = freshSession();
    const source = await seedInvoice(session);
    session.setReadOnly(true);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_duplicate")!;

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

describe("qb_invoice_duplicate — idempotency", () => {
  it("same key + same source returns the original duplicate with idempotentReplay: true", async () => {
    const session = freshSession();
    const source = await seedInvoice(session);
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_duplicate")!;

    const r1 = await handler({
      sourceTxnId: String(source.TxnID),
      idempotencyKey: "dup-key-1",
    });
    const p1 = JSON.parse(r1.content[0].text);
    expect(p1.success).toBe(true);
    expect(p1.idempotentReplay).toBeUndefined();
    const firstTxnId = p1.invoice.TxnID;

    const r2 = await handler({
      sourceTxnId: String(source.TxnID),
      idempotencyKey: "dup-key-1",
    });
    const p2 = JSON.parse(r2.content[0].text);
    expect(p2.success).toBe(true);
    expect(p2.idempotentReplay).toBe(true);
    expect(p2.invoice.TxnID).toBe(firstTxnId);
  });

  it("same key + different source returns statusCode 9002", async () => {
    const session = freshSession();
    const sourceA = await seedInvoice(session);
    const sourceB = await seedInvoice(session, { RefNumber: "INV-APR-002" });
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_duplicate")!;

    await handler({
      sourceTxnId: String(sourceA.TxnID),
      idempotencyKey: "dup-key-2",
    });

    // Same key, different source — the payload fingerprint diverges (the
    // carried lines map onto a different InvoiceAddRq), so the cache must
    // surface the 9002 conflict.
    const r2 = await handler({
      sourceTxnId: String(sourceB.TxnID),
      idempotencyKey: "dup-key-2",
    });
    expect(r2.isError).toBe(true);
    const p2 = JSON.parse(r2.content[0].text);
    expect(p2.statusCode).toBe(9002);
  });
});

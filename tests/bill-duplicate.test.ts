// Phase 12 #57a mirror — qb_bill_duplicate
//
// AP-side analog of qb_invoice_duplicate. Composite tool: reads source bill's
// VendorRef + ExpenseLineRet + ItemLineRet via the existing query path,
// submits a fresh BillAddRq via the existing add path. No new wire types.
//
// Carry policy under test:
//   carry by default — VendorRef, expense lines, item lines
//   NOT carried     — TxnDate (→ today), DueDate, RefNumber (→ unset), Memo (→ default)
//   override-wins   — txnDate, dueDate, refNumber, memo, vendorName/vendorListId

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerBillTools } from "../src/tools/bills.js";

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
    appName: "vitest-bill-duplicate",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

async function seedBill(
  session: QBSessionManager,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return session.addEntity("Bill", {
    VendorRef: { FullName: "Office Supplies Co" },
    TxnDate: "2026-04-01",
    DueDate: "2026-04-15",
    RefNumber: "BILL-APR-001",
    Memo: "April rent",
    ExpenseLineAdd: [
      {
        AccountRef: { FullName: "Rent Expense" },
        Amount: 2500,
        Memo: "Office",
      },
      {
        AccountRef: { FullName: "Utilities Expense" },
        Amount: 180,
        Memo: "April electric",
      },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — happy path: carry VendorRef + lines onto a fresh bill
// ---------------------------------------------------------------------------

describe("qb_bill_duplicate — happy path", () => {
  it("creates a new bill with the same VendorRef and expense lines", async () => {
    const session = freshSession();
    const source = await seedBill(session);
    const sourceTxnId = String(source.TxnID);

    registerBillTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_bill_duplicate")!;

    const result = await handler({ sourceTxnId });
    expect(result.isError).toBeFalsy();

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.sourceTxnId).toBe(sourceTxnId);
    const dup = payload.bill;

    expect(dup.TxnID).toBeDefined();
    expect(dup.TxnID).not.toBe(sourceTxnId);

    expect(dup.VendorRef.FullName).toBe("Office Supplies Co");

    const lines = Array.isArray(dup.ExpenseLineRet)
      ? dup.ExpenseLineRet
      : [dup.ExpenseLineRet];
    expect(lines).toHaveLength(2);
    expect(lines[0].AccountRef.FullName).toBe("Rent Expense");
    expect(Number(lines[0].Amount)).toBe(2500);
    expect(lines[1].AccountRef.FullName).toBe("Utilities Expense");
    expect(Number(lines[1].Amount)).toBe(180);
    expect(lines[0].TxnLineID).toBeDefined();

    // AmountDue recomputes from the carried lines: 2500 + 180 = 2680.
    expect(Number(dup.AmountDue)).toBe(2680);
  });

  it("carries item lines through ItemLineRet → ItemLineAdd", async () => {
    const session = freshSession();
    const source = await session.addEntity("Bill", {
      VendorRef: { FullName: "Office Supplies Co" },
      TxnDate: "2026-04-10",
      RefNumber: "BILL-APR-002",
      ItemLineAdd: [
        {
          ItemRef: { FullName: "Printer Paper" },
          Quantity: 5,
          Cost: 30,
          Amount: 150,
        },
      ],
    });
    registerBillTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_bill_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).bill;

    const itemLines = Array.isArray(dup.ItemLineRet)
      ? dup.ItemLineRet
      : [dup.ItemLineRet];
    expect(itemLines).toHaveLength(1);
    expect(itemLines[0].ItemRef.FullName).toBe("Printer Paper");
    expect(Number(itemLines[0].Quantity)).toBe(5);
    expect(Number(itemLines[0].Cost)).toBe(30);
    expect(Number(itemLines[0].Amount)).toBe(150);
  });

  it("default Memo is 'Duplicate of <source RefNumber>'", async () => {
    const session = freshSession();
    const source = await seedBill(session);
    registerBillTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_bill_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).bill;
    expect(dup.Memo).toBe("Duplicate of BILL-APR-001");
  });

  it("default Memo falls back to TxnID when source has no RefNumber", async () => {
    const session = freshSession();
    const source = await seedBill(session, { RefNumber: undefined });
    registerBillTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_bill_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).bill;
    expect(dup.Memo).toBe(`Duplicate of ${source.TxnID}`);
  });

  it("does NOT carry source's TxnDate / DueDate / RefNumber", async () => {
    const session = freshSession();
    const source = await seedBill(session);
    registerBillTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_bill_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).bill;

    expect(dup.TxnDate).not.toBe("2026-04-01");
    expect(dup.RefNumber).toBeUndefined();
    expect(dup.DueDate).toBeUndefined();
  });

  it("operator overrides win for txnDate / dueDate / refNumber / memo", async () => {
    const session = freshSession();
    const source = await seedBill(session);
    registerBillTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_bill_duplicate")!;

    const result = await handler({
      sourceTxnId: String(source.TxnID),
      txnDate: "2026-05-01",
      dueDate: "2026-05-15",
      refNumber: "BILL-MAY-001",
      memo: "May rent",
    });
    const dup = JSON.parse(result.content[0].text).bill;
    expect(dup.TxnDate).toBe("2026-05-01");
    expect(dup.DueDate).toBe("2026-05-15");
    expect(dup.RefNumber).toBe("BILL-MAY-001");
    expect(dup.Memo).toBe("May rent");
  });

  it("retargets to a different vendor via vendorName", async () => {
    const session = freshSession();
    const source = await seedBill(session);
    registerBillTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_bill_duplicate")!;

    const result = await handler({
      sourceTxnId: String(source.TxnID),
      vendorName: "New Landlord Inc",
    });
    const dup = JSON.parse(result.content[0].text).bill;
    expect(dup.VendorRef.FullName).toBe("New Landlord Inc");
  });

  it("retargets to a different vendor via vendorListId", async () => {
    const session = freshSession();
    const source = await seedBill(session);
    registerBillTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_bill_duplicate")!;

    const result = await handler({
      sourceTxnId: String(source.TxnID),
      vendorListId: "VEND-99",
    });
    const dup = JSON.parse(result.content[0].text).bill;
    expect(dup.VendorRef.ListID).toBe("VEND-99");
    expect(dup.VendorRef.FullName).toBeUndefined();
  });

  it("duplicating increases vendor's open balance by the new bill's AmountDue", async () => {
    const session = freshSession();
    const source = await seedBill(session);
    const vendorsBefore = await session.queryEntity("Vendor", { FullName: "Office Supplies Co" });
    const balanceBefore = Number((vendorsBefore[0] as { Balance?: number }).Balance ?? 0);

    registerBillTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_bill_duplicate")!;
    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).bill;

    const vendorsAfter = await session.queryEntity("Vendor", { FullName: "Office Supplies Co" });
    const balanceAfter = Number((vendorsAfter[0] as { Balance?: number }).Balance ?? 0);
    expect(balanceAfter - balanceBefore).toBeCloseTo(Number(dup.AmountDue), 2);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — error paths
// ---------------------------------------------------------------------------

describe("qb_bill_duplicate — error paths", () => {
  it("unknown sourceTxnId returns statusCode 500 with humanReadable", async () => {
    const session = freshSession();
    registerBillTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_bill_duplicate")!;

    const result = await handler({ sourceTxnId: "DOES-NOT-EXIST" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(500);
    expect(payload.humanReadable).toBeDefined();
  });

  it("read-only session rejects with statusCode 9001 (add half is gated)", async () => {
    const session = freshSession();
    const source = await seedBill(session);
    session.setReadOnly(true);

    registerBillTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_bill_duplicate")!;

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

describe("qb_bill_duplicate — idempotency", () => {
  it("same key + same source returns the original duplicate with idempotentReplay: true", async () => {
    const session = freshSession();
    const source = await seedBill(session);
    registerBillTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_bill_duplicate")!;

    const r1 = await handler({
      sourceTxnId: String(source.TxnID),
      idempotencyKey: "dup-bill-1",
    });
    const p1 = JSON.parse(r1.content[0].text);
    expect(p1.success).toBe(true);
    expect(p1.idempotentReplay).toBeUndefined();
    const firstTxnId = p1.bill.TxnID;

    const r2 = await handler({
      sourceTxnId: String(source.TxnID),
      idempotencyKey: "dup-bill-1",
    });
    const p2 = JSON.parse(r2.content[0].text);
    expect(p2.success).toBe(true);
    expect(p2.idempotentReplay).toBe(true);
    expect(p2.bill.TxnID).toBe(firstTxnId);
  });

  it("same key + different source returns statusCode 9002", async () => {
    const session = freshSession();
    const sourceA = await seedBill(session);
    const sourceB = await seedBill(session, { RefNumber: "BILL-APR-002" });
    registerBillTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_bill_duplicate")!;

    await handler({
      sourceTxnId: String(sourceA.TxnID),
      idempotencyKey: "dup-bill-2",
    });

    const r2 = await handler({
      sourceTxnId: String(sourceB.TxnID),
      idempotencyKey: "dup-bill-2",
    });
    expect(r2.isError).toBe(true);
    const p2 = JSON.parse(r2.content[0].text);
    expect(p2.statusCode).toBe(9002);
  });
});

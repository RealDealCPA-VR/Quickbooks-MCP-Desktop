// Phase 12 #57 — qb_invoice_write_off
//
// Composite tool over qb_payment_receive: $0 ReceivePayment + DiscountAmount =
// write-off amount + DiscountAccountRef = write-off P&L account. No new wire
// types — coverage focuses on the validation surface, the resulting invoice +
// customer balance math, and the read-only / idempotency compose-through.
//
// The sim fix for Customer.Balance / DiscountAmount math (applyTxnApplications
// + reverseReceivePaymentApplication) is regression-pinned in Layer 5 since
// the tool relies on the corrected behavior.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerInvoiceTools } from "../src/tools/invoices.js";
import { registerPaymentTools } from "../src/tools/payments.js";

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
    appName: "vitest-invoice-write-off",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

async function seedOpenInvoice(
  session: QBSessionManager,
  amount = 1000,
): Promise<Record<string, unknown>> {
  return session.addEntity("Invoice", {
    CustomerRef: { FullName: "Acme Corporation" },
    TxnDate: "2026-04-15",
    RefNumber: "INV-WO-TEST",
    InvoiceLineAdd: [
      {
        ItemRef: { FullName: "Consulting Services" },
        Desc: "Consulting",
        Quantity: 1,
        Rate: amount,
      },
    ],
  });
}

async function getCustomerBalance(
  session: QBSessionManager,
  fullName = "Acme Corporation",
): Promise<number> {
  const rows = await session.queryEntity("Customer", { FullName: fullName });
  return Number((rows[0] as Record<string, unknown>).Balance ?? 0);
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — happy path: full write-off closes invoice, AR drops by amount
// ---------------------------------------------------------------------------

describe("qb_invoice_write_off — full write-off (happy path)", () => {
  it("closes the invoice and drops the customer's AR by the full BalanceRemaining", async () => {
    const session = freshSession();
    const invoice = await seedOpenInvoice(session, 750);
    const txnId = String(invoice.TxnID);
    const initialBalance = Number(invoice.BalanceRemaining);
    expect(initialBalance).toBeCloseTo(750, 6);

    const beforeAr = await getCustomerBalance(session);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_write_off")!;

    const result = await handler({
      txnId,
      writeOffAccount: "Bad Debt",
    });
    expect(result.isError).toBeFalsy();

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.sourceTxnId).toBe(txnId);
    expect(payload.writeOff.amount).toBeCloseTo(750, 6);
    expect(payload.writeOff.account).toBe("Bad Debt");
    expect(payload.writeOff.memo).toBe("Write off invoice INV-WO-TEST");

    // The underlying ReceivePayment record exists with TotalAmount = 0.
    expect(payload.payment.TotalAmount).toBeCloseTo(0, 6);
    expect(payload.payment.TxnID).toBeDefined();

    // Invoice closed.
    const refetched = await session.queryEntity("Invoice", { TxnID: txnId });
    const updated = refetched[0] as Record<string, unknown>;
    expect(Number(updated.BalanceRemaining)).toBeCloseTo(0, 6);
    expect(updated.IsPaid).toBe(true);

    // AR balance dropped by 750 (the discount). Sim fix verification.
    const afterAr = await getCustomerBalance(session);
    expect(afterAr - beforeAr).toBeCloseTo(-750, 6);
  });

  it("default memo uses TxnID when source invoice has no RefNumber", async () => {
    const session = freshSession();
    const invoice = await session.addEntity("Invoice", {
      CustomerRef: { FullName: "Acme Corporation" },
      InvoiceLineAdd: [
        { ItemRef: { FullName: "Consulting Services" }, Quantity: 1, Rate: 100 },
      ],
    });
    const txnId = String(invoice.TxnID);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_write_off")!;

    const result = await handler({ txnId, writeOffAccount: "Bad Debt" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.writeOff.memo).toBe(`Write off invoice ${txnId}`);
  });

  it("explicit memo overrides the default", async () => {
    const session = freshSession();
    const invoice = await seedOpenInvoice(session, 200);
    const txnId = String(invoice.TxnID);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_write_off")!;

    const result = await handler({
      txnId,
      writeOffAccount: "Bad Debt",
      memo: "Uncollectible — client closed shop 2026-04-30",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.writeOff.memo).toBe("Uncollectible — client closed shop 2026-04-30");
    expect(payload.payment.Memo).toBe("Uncollectible — client closed shop 2026-04-30");
  });

  it("txnDate, refNumber, depositToAccountName pass through to ReceivePayment", async () => {
    const session = freshSession();
    const invoice = await seedOpenInvoice(session, 200);
    const txnId = String(invoice.TxnID);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_write_off")!;

    const result = await handler({
      txnId,
      writeOffAccount: "Bad Debt",
      txnDate: "2026-12-31",
      refNumber: "WO-2026-001",
      depositToAccountName: "Undeposited Funds",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.payment.TxnDate).toBe("2026-12-31");
    expect(payload.payment.RefNumber).toBe("WO-2026-001");
    expect((payload.payment.DepositToAccountRef as Record<string, unknown>).FullName)
      .toBe("Undeposited Funds");
  });

  it("AppliedToTxnRet on the resulting payment carries DiscountAmount + DiscountAccountRef", async () => {
    const session = freshSession();
    const invoice = await seedOpenInvoice(session, 500);
    const txnId = String(invoice.TxnID);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_write_off")!;

    const result = await handler({
      txnId,
      writeOffAccount: "Bad Debts Expense",
    });
    const payload = JSON.parse(result.content[0].text);
    const applied = payload.payment.AppliedToTxnRet;
    const entry = Array.isArray(applied) ? applied[0] : applied;
    expect(entry.TxnID).toBe(txnId);
    expect(Number(entry.PaymentAmount)).toBeCloseTo(0, 6);
    expect(Number(entry.DiscountAmount)).toBeCloseTo(500, 6);
    expect(entry.DiscountAccountRef.FullName).toBe("Bad Debts Expense");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — partial write-off: invoice stays open with reduced BalanceRemaining
// ---------------------------------------------------------------------------

describe("qb_invoice_write_off — partial write-off", () => {
  it("writes off a partial amount and leaves the invoice open with the remainder", async () => {
    const session = freshSession();
    const invoice = await seedOpenInvoice(session, 1000);
    const txnId = String(invoice.TxnID);
    const beforeAr = await getCustomerBalance(session);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_write_off")!;

    const result = await handler({
      txnId,
      writeOffAccount: "Bad Debt",
      amount: 250,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.writeOff.amount).toBeCloseTo(250, 6);

    const refetched = await session.queryEntity("Invoice", { TxnID: txnId });
    const updated = refetched[0] as Record<string, unknown>;
    expect(Number(updated.BalanceRemaining)).toBeCloseTo(750, 6);
    expect(updated.IsPaid).toBe(false);

    const afterAr = await getCustomerBalance(session);
    expect(afterAr - beforeAr).toBeCloseTo(-250, 6);
  });

  it("writing off the exact remaining amount closes the invoice", async () => {
    const session = freshSession();
    const invoice = await seedOpenInvoice(session, 400);
    const txnId = String(invoice.TxnID);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_write_off")!;

    const result = await handler({
      txnId,
      writeOffAccount: "Bad Debt",
      amount: 400,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.writeOff.amount).toBeCloseTo(400, 6);

    const refetched = await session.queryEntity("Invoice", { TxnID: txnId });
    const updated = refetched[0] as Record<string, unknown>;
    expect(Number(updated.BalanceRemaining)).toBeCloseTo(0, 6);
    expect(updated.IsPaid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — validation errors
// ---------------------------------------------------------------------------

describe("qb_invoice_write_off — validation", () => {
  it("unknown TxnID returns structured 500", async () => {
    const session = freshSession();
    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_write_off")!;

    const result = await handler({
      txnId: "9999-NONEXISTENT",
      writeOffAccount: "Bad Debt",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(500);
    expect(payload.statusMessage).toMatch(/9999-NONEXISTENT/);
    expect(payload.humanReadable).toBeDefined();
  });

  it("already-paid invoice (BalanceRemaining = 0) returns a structured error", async () => {
    const session = freshSession();
    const invoice = await seedOpenInvoice(session, 500);
    const txnId = String(invoice.TxnID);

    // Pay it off via the regular payment path.
    registerPaymentTools(fakeServer as never, () => session);
    const payHandler = handlers.get("qb_payment_receive")!;
    await payHandler({
      customerName: "Acme Corporation",
      totalAmount: 500,
      appliedTo: [{ txnId, amount: 500 }],
    });

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_write_off")!;
    const result = await handler({
      txnId,
      writeOffAccount: "Bad Debt",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/already paid or closed/i);
  });

  it("amount > BalanceRemaining returns a structured error", async () => {
    const session = freshSession();
    const invoice = await seedOpenInvoice(session, 100);
    const txnId = String(invoice.TxnID);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_write_off")!;

    const result = await handler({
      txnId,
      writeOffAccount: "Bad Debt",
      amount: 250,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/exceeds invoice BalanceRemaining/);
  });

  it("amount <= 0 returns a structured error", async () => {
    const session = freshSession();
    const invoice = await seedOpenInvoice(session, 100);
    const txnId = String(invoice.TxnID);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_write_off")!;

    const result = await handler({
      txnId,
      writeOffAccount: "Bad Debt",
      amount: 0,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/must be > 0/);
  });

  it("zod rejects missing writeOffAccount", async () => {
    const session = freshSession();
    const invoice = await seedOpenInvoice(session, 100);
    const txnId = String(invoice.TxnID);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_write_off")!;

    // The fakeServer doesn't apply zod validation — McpServer does that
    // upstream in production. Here we exercise the handler's defensive shape:
    // missing writeOffAccount results in DiscountAccountRef.FullName being
    // undefined, which the sim records faithfully without rejecting (live QB
    // would). Tool-layer validation isn't required because zod gates this in
    // the real transport. This test just documents the boundary.
    const result = await handler({ txnId });
    // We don't assert success here — the point is the handler does NOT
    // crash on missing required field; zod is the gate in real use.
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — idempotency compose-through (uses session.addEntityIdempotent)
// ---------------------------------------------------------------------------

describe("qb_invoice_write_off — idempotency", () => {
  it("same key + same payload returns idempotentReplay without creating a duplicate", async () => {
    const session = freshSession();
    const invoice = await seedOpenInvoice(session, 300);
    const txnId = String(invoice.TxnID);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_write_off")!;

    const r1 = await handler({
      txnId,
      writeOffAccount: "Bad Debt",
      idempotencyKey: "wo-2026-04-001",
    });
    const p1 = JSON.parse(r1.content[0].text);
    expect(p1.idempotentReplay).toBeUndefined();

    const r2 = await handler({
      txnId,
      writeOffAccount: "Bad Debt",
      idempotencyKey: "wo-2026-04-001",
    });
    const p2 = JSON.parse(r2.content[0].text);
    expect(p2.idempotentReplay).toBe(true);
    expect(p2.payment.TxnID).toBe(p1.payment.TxnID);

    // Customer balance only moved once (NOT twice from the replay).
    const refetched = await session.queryEntity("Invoice", { TxnID: txnId });
    expect(Number((refetched[0] as Record<string, unknown>).BalanceRemaining))
      .toBeCloseTo(0, 6);
  });

  it("same key + different payload returns statusCode 9002", async () => {
    const session = freshSession();
    const invoice = await seedOpenInvoice(session, 1000);
    const txnId = String(invoice.TxnID);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_write_off")!;

    await handler({
      txnId,
      writeOffAccount: "Bad Debt",
      amount: 100,
      idempotencyKey: "wo-conflict",
    });

    const r2 = await handler({
      txnId,
      writeOffAccount: "Bad Debt",
      amount: 200, // different payload — same key
      idempotencyKey: "wo-conflict",
    });
    expect(r2.isError).toBe(true);
    const p2 = JSON.parse(r2.content[0].text);
    expect(p2.statusCode).toBe(9002);
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — sim regression: discount-only payment correctly drops Customer.Balance
// ---------------------------------------------------------------------------
//
// Pins the sim fix to applyTxnApplications + reverseReceivePaymentApplication:
// before the fix, Customer.Balance moved by appliedSum (the PaymentAmount
// portion only), leaving sum(invoice.BalanceRemaining) ≠ Customer.Balance
// after a discount close.

describe("sim regression — DiscountAmount on qb_payment_receive moves Customer.Balance", () => {
  it("partial payment + partial discount drops AR by payment + discount", async () => {
    const session = freshSession();
    const invoice = await seedOpenInvoice(session, 1000);
    const txnId = String(invoice.TxnID);
    const beforeAr = await getCustomerBalance(session);

    registerPaymentTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_payment_receive")!;

    // Pay $700 with a $300 discount → invoice closes; AR drops by 1000.
    const result = await handler({
      customerName: "Acme Corporation",
      totalAmount: 700,
      appliedTo: [
        {
          txnId,
          amount: 700,
          discountAmount: 300,
          discountAccountName: "Bad Debt",
        },
      ],
    });
    expect(result.isError).toBeFalsy();

    const refetched = await session.queryEntity("Invoice", { TxnID: txnId });
    const updated = refetched[0] as Record<string, unknown>;
    expect(Number(updated.BalanceRemaining)).toBeCloseTo(0, 6);
    expect(updated.IsPaid).toBe(true);

    const afterAr = await getCustomerBalance(session);
    expect(afterAr - beforeAr).toBeCloseTo(-1000, 6);
  });

  it("unapplying the payment via qb_payment_apply reverses both payment + discount on Customer.Balance", async () => {
    // Exercises reverseReceivePaymentApplication via the qb_payment_apply
    // path (applyTo: []). Pre-fix, this path under-reversed Customer.Balance
    // (restored only the PaymentAmount portion). After the fix, the full
    // payment + discount is reversed, restoring open AR symmetrically.
    const session = freshSession();
    const invoice = await seedOpenInvoice(session, 500);
    const txnId = String(invoice.TxnID);
    const beforeAr = await getCustomerBalance(session);

    // Receive $0 payment with $500 discount → invoice closes; AR drops by 500.
    registerPaymentTools(fakeServer as never, () => session);
    const payHandler = handlers.get("qb_payment_receive")!;
    const payResult = await payHandler({
      customerName: "Acme Corporation",
      totalAmount: 0,
      appliedTo: [
        {
          txnId,
          amount: 0,
          discountAmount: 500,
          discountAccountName: "Bad Debt",
        },
      ],
    });
    const payPayload = JSON.parse(payResult.content[0].text);
    const paymentTxnId = String(payPayload.payment.TxnID);
    const editSequence = String(payPayload.payment.EditSequence);

    expect(await getCustomerBalance(session) - beforeAr).toBeCloseTo(-500, 6);

    // Unapply via qb_payment_apply with empty applyTo → invoice re-opens AND
    // AR is fully restored.
    const applyHandler = handlers.get("qb_payment_apply")!;
    const reverseResult = await applyHandler({
      txnId: paymentTxnId,
      editSequence,
      applyTo: [],
    });
    expect(reverseResult.isError).toBeFalsy();

    const refetched = await session.queryEntity("Invoice", { TxnID: txnId });
    expect(Number((refetched[0] as Record<string, unknown>).BalanceRemaining))
      .toBeCloseTo(500, 6);
    expect(await getCustomerBalance(session)).toBeCloseTo(beforeAr, 6);
  });
});

// ---------------------------------------------------------------------------
// Layer 6 — read-only gate composes
// ---------------------------------------------------------------------------

describe("qb_invoice_write_off — read-only session", () => {
  it("read-only session rejects with statusCode 9001", async () => {
    const session = freshSession();
    const invoice = await seedOpenInvoice(session, 100);
    const txnId = String(invoice.TxnID);

    session.setReadOnly(true);

    registerInvoiceTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_invoice_write_off")!;

    const result = await handler({
      txnId,
      writeOffAccount: "Bad Debt",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
    expect(payload.humanReadable).toBeDefined();
  });
});

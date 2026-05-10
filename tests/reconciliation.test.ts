// Phase 10 #46 — bank reconciliation primitives (write side).
//
// The QBXML SDK's ONLY exposed reconciliation primitive is ClearedStatusModRq
// (verified against qbxmlops130/140 schemas — no ReconcileQueryRq, no
// ReconcileDetail report type, no LastReconciledDate on AccountRet). Read-
// side (which txns are uncleared) needs CustomDetailReportQueryRq with
// IncludeColumn=ClearedStatus and lands in Phase 11 alongside #56.
//
// Coverage layers:
//   1. Builder — buildClearedStatusModRequest emits the right shape with
//      schema-required child order (TxnID → TxnLineID? → ClearedStatus).
//   2. Sim handler — handleClearedStatusMod walks the seven bank-affecting
//      stores, distinguishes 500 (unknown TxnID) from 3120 (TxnID exists but
//      txn type doesn't support cleared status), enforces enum, and supports
//      both header- and line-level updates.
//   3. Manager — updateClearedStatus method round-trips through the wire and
//      returns the parsed result; assertWritable gate fires before any
//      envelope is built (read-only sessions reject with 9001).
//   4. Tool surface — qb_cleared_status_update propagates txnId / txnLineId /
//      clearedStatus through; error path surfaces statusCode + humanReadable;
//      writeable→cleared flip is visible on subsequent reads.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import {
  QBSessionManager,
  QBReadOnlyError,
} from "../src/session/manager.js";
import { buildClearedStatusModRequest } from "../src/qbxml/builder.js";
import { registerReconciliationTools } from "../src/tools/reconciliation.js";

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
    appName: "vitest-reconciliation",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

async function seedCheck(
  session: QBSessionManager,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  // BANK_AFFECTING_TXN_TYPES default ClearedStatus to "NotCleared" on add —
  // mirrors real QB behavior, so the fixture starts in the reconcile-ready
  // state every test wants.
  return session.addEntity("Check", {
    PayeeEntityRef: { FullName: "Office Supplies Co" },
    AccountRef: { FullName: "Checking" },
    TxnDate: "2026-05-01",
    RefNumber: "CHK-1001",
    Amount: 250.0,
    Memo: "Monthly supplies",
    ExpenseLineAdd: [
      {
        AccountRef: { FullName: "Utilities" },
        Amount: 250.0,
      },
    ],
    ...overrides,
  });
}

async function seedDeposit(
  session: QBSessionManager,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  // Deposit takes a split-line shape; seed two lines so TxnLineID-targeted
  // updates have something distinct to flip.
  return session.addEntity("Deposit", {
    DepositToAccountRef: { FullName: "Checking" },
    TxnDate: "2026-05-02",
    Memo: "May 2 batch",
    DepositLineAdd: [
      {
        EntityRef: { FullName: "Acme Corporation" },
        AccountRef: { FullName: "Sales Revenue" },
        Amount: 500.0,
        Memo: "Acme payment",
      },
      {
        EntityRef: { FullName: "Global Industries" },
        AccountRef: { FullName: "Sales Revenue" },
        Amount: 300.0,
        Memo: "Global payment",
      },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — builder emits the right shape in schema-required order
// ---------------------------------------------------------------------------

describe("buildClearedStatusModRequest — emits ClearedStatusModRq in schema order", () => {
  it("header-level: TxnID → ClearedStatus (no TxnLineID)", () => {
    const xml = buildClearedStatusModRequest({
      txnId: "ABC-123",
      clearedStatus: "Cleared",
    });

    // Wrapped under <ClearedStatusMod> per the QBXML schema spec.
    expect(xml).toContain("<ClearedStatusModRq");
    expect(xml).toContain("<ClearedStatusMod>");
    expect(xml).toContain("<TxnID>ABC-123</TxnID>");
    expect(xml).toContain("<ClearedStatus>Cleared</ClearedStatus>");
    expect(xml).not.toContain("<TxnLineID>");

    // TxnID must precede ClearedStatus.
    const txnIdPos = xml.indexOf("<TxnID>");
    const statusPos = xml.indexOf("<ClearedStatus>");
    expect(txnIdPos).toBeLessThan(statusPos);
  });

  it("line-level: TxnID → TxnLineID → ClearedStatus", () => {
    const xml = buildClearedStatusModRequest({
      txnId: "DEP-001",
      txnLineId: "L-42",
      clearedStatus: "Pending",
    });

    expect(xml).toContain("<TxnID>DEP-001</TxnID>");
    expect(xml).toContain("<TxnLineID>L-42</TxnLineID>");
    expect(xml).toContain("<ClearedStatus>Pending</ClearedStatus>");

    // Schema-required order: TxnID < TxnLineID < ClearedStatus.
    const txnIdPos = xml.indexOf("<TxnID>");
    const lineIdPos = xml.indexOf("<TxnLineID>");
    const statusPos = xml.indexOf("<ClearedStatus>");
    expect(txnIdPos).toBeLessThan(lineIdPos);
    expect(lineIdPos).toBeLessThan(statusPos);
  });

  it("accepts all three enum values", () => {
    for (const status of ["Cleared", "NotCleared", "Pending"] as const) {
      const xml = buildClearedStatusModRequest({
        txnId: "X",
        clearedStatus: status,
      });
      expect(xml).toContain(`<ClearedStatus>${status}</ClearedStatus>`);
    }
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — simulation handler
// ---------------------------------------------------------------------------

describe("SimulationStore — handleClearedStatusMod", () => {
  it("flips Check.ClearedStatus from NotCleared default to Cleared", async () => {
    const session = freshSession();
    const check = await seedCheck(session);
    const txnId = String(check.TxnID);
    expect(check.ClearedStatus).toBe("NotCleared");

    const result = await session.updateClearedStatus({
      txnId,
      clearedStatus: "Cleared",
    });
    expect((result as { ClearedStatus?: string }).ClearedStatus).toBe("Cleared");

    // Confirm the store-side flip is visible on subsequent reads. The
    // ClearedStatus field survives the IncludeLineItems strip — it's a
    // header field, not a line field.
    const refetched = await session.queryEntity("Check", { TxnID: txnId });
    expect((refetched[0] as { ClearedStatus?: string }).ClearedStatus).toBe("Cleared");
  });

  it("flips Deposit.ClearedStatus header (whole-deposit reconcile)", async () => {
    const session = freshSession();
    const deposit = await seedDeposit(session);
    const txnId = String(deposit.TxnID);
    expect(deposit.ClearedStatus).toBe("NotCleared");

    await session.updateClearedStatus({
      txnId,
      clearedStatus: "Cleared",
    });

    const refetched = await session.queryEntity("Deposit", { TxnID: txnId });
    expect((refetched[0] as { ClearedStatus?: string }).ClearedStatus).toBe("Cleared");
  });

  it("flips a single line via TxnLineID — multi-line Deposit", async () => {
    const session = freshSession();
    const deposit = await seedDeposit(session);
    const txnId = String(deposit.TxnID);
    const lines = (deposit as { DepositLineRet?: Array<{ TxnLineID: string }> }).DepositLineRet;
    expect(Array.isArray(lines)).toBe(true);
    expect(lines!.length).toBe(2);
    const firstLineId = String(lines![0].TxnLineID);

    await session.updateClearedStatus({
      txnId,
      txnLineId: firstLineId,
      clearedStatus: "Cleared",
    });

    // Refetch WITH IncludeLineItems so the per-line ClearedStatus survives
    // the strip applied by handleQuery.
    const refetched = await session.queryEntity("Deposit", {
      TxnID: txnId,
      IncludeLineItems: true,
    });
    const refetchedLines = (refetched[0] as { DepositLineRet: Array<{
      TxnLineID: string;
      ClearedStatus?: string;
    }> }).DepositLineRet;
    expect(refetchedLines[0].ClearedStatus).toBe("Cleared");
    expect(refetchedLines[1].ClearedStatus).toBeUndefined();
  });

  it("supports Pending and NotCleared values", async () => {
    const session = freshSession();
    const check = await seedCheck(session);
    const txnId = String(check.TxnID);

    await session.updateClearedStatus({ txnId, clearedStatus: "Pending" });
    let r = await session.queryEntity("Check", { TxnID: txnId });
    expect((r[0] as { ClearedStatus?: string }).ClearedStatus).toBe("Pending");

    await session.updateClearedStatus({ txnId, clearedStatus: "NotCleared" });
    r = await session.queryEntity("Check", { TxnID: txnId });
    expect((r[0] as { ClearedStatus?: string }).ClearedStatus).toBe("NotCleared");
  });

  it("naturally idempotent — Cleared on already-Cleared txn is a no-op", async () => {
    const session = freshSession();
    const check = await seedCheck(session);
    const txnId = String(check.TxnID);

    await session.updateClearedStatus({ txnId, clearedStatus: "Cleared" });
    // Second call with the same status — no error.
    await expect(
      session.updateClearedStatus({ txnId, clearedStatus: "Cleared" }),
    ).resolves.toBeDefined();
    const r = await session.queryEntity("Check", { TxnID: txnId });
    expect((r[0] as { ClearedStatus?: string }).ClearedStatus).toBe("Cleared");
  });

  it("unknown TxnID returns statusCode 500", async () => {
    const session = freshSession();
    await expect(
      session.updateClearedStatus({
        txnId: "DOES-NOT-EXIST",
        clearedStatus: "Cleared",
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  it("TxnID against non-bank-affecting type returns 3120 (not 500)", async () => {
    // Seed an Invoice — bank-rec invalid target. The handler distinguishes
    // 3120 ("txn exists but type doesn't support cleared status") from 500
    // ("txn doesn't exist at all") so the operator sees a useful error.
    const session = freshSession();
    const invoice = await session.addEntity("Invoice", {
      CustomerRef: { FullName: "Acme Corporation" },
      TxnDate: "2026-05-01",
      InvoiceLineAdd: [
        {
          ItemRef: { FullName: "Consulting Services" },
          Quantity: 1,
          Rate: 100,
        },
      ],
    });
    const txnId = String(invoice.TxnID);

    await expect(
      session.updateClearedStatus({ txnId, clearedStatus: "Cleared" }),
    ).rejects.toMatchObject({ statusCode: 3120 });
  });

  it("invalid ClearedStatus value returns 3120", async () => {
    // Bypass the manager (which would build a wire request from a typed
    // value) and call sendRequest directly so we can test the sim's enum
    // validation path. The tool-side zod schema also enforces this at the
    // outer layer — both gates exist for defense-in-depth.
    const session = freshSession();
    const check = await seedCheck(session);
    const txnId = String(check.TxnID);

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="16.0"?>
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <ClearedStatusModRq requestID="1">
      <ClearedStatusMod>
        <TxnID>${txnId}</TxnID>
        <ClearedStatus>BogusValue</ClearedStatus>
      </ClearedStatusMod>
    </ClearedStatusModRq>
  </QBXMLMsgsRq>
</QBXML>`;
    const response = await session.sendRequest(xml);
    expect(response.responses[0].statusCode).toBe(3120);
  });

  it("missing TxnID returns 3120", async () => {
    const session = freshSession();
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="16.0"?>
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <ClearedStatusModRq requestID="1">
      <ClearedStatusMod>
        <ClearedStatus>Cleared</ClearedStatus>
      </ClearedStatusMod>
    </ClearedStatusModRq>
  </QBXMLMsgsRq>
</QBXML>`;
    const response = await session.sendRequest(xml);
    expect(response.responses[0].statusCode).toBe(3120);
  });

  it("TxnLineID against non-existent line returns 3120", async () => {
    const session = freshSession();
    const deposit = await seedDeposit(session);
    const txnId = String(deposit.TxnID);

    await expect(
      session.updateClearedStatus({
        txnId,
        txnLineId: "L-NOT-A-REAL-LINE",
        clearedStatus: "Cleared",
      }),
    ).rejects.toMatchObject({ statusCode: 3120 });
  });

  it("BillPaymentCheck is bank-affecting and supports the flip", async () => {
    // Seed a Bill first so BillPaymentCheck's applyTo can target it.
    const session = freshSession();
    const bill = await session.addEntity("Bill", {
      VendorRef: { FullName: "Office Supplies Co" },
      TxnDate: "2026-05-01",
      ExpenseLineAdd: [
        {
          AccountRef: { FullName: "Utilities" },
          Amount: 100.0,
        },
      ],
    });

    const pay = await session.addEntity("BillPaymentCheck", {
      PayeeEntityRef: { FullName: "Office Supplies Co" },
      BankAccountRef: { FullName: "Checking" },
      TxnDate: "2026-05-02",
      AppliedToTxnAdd: [
        {
          TxnID: String(bill.TxnID),
          PaymentAmount: 100.0,
        },
      ],
    });
    const txnId = String(pay.TxnID);
    expect(pay.ClearedStatus).toBe("NotCleared");

    await session.updateClearedStatus({ txnId, clearedStatus: "Cleared" });
    const r = await session.queryEntity("BillPaymentCheck", { TxnID: txnId });
    expect((r[0] as { ClearedStatus?: string }).ClearedStatus).toBe("Cleared");
  });

  it("Transfer is bank-affecting and supports the flip", async () => {
    const session = freshSession();
    const xfer = await session.addEntity("Transfer", {
      TransferFromAccountRef: { FullName: "Checking" },
      TransferToAccountRef: { FullName: "Savings" },
      Amount: 1000.0,
      TxnDate: "2026-05-03",
    });
    const txnId = String(xfer.TxnID);
    expect(xfer.ClearedStatus).toBe("NotCleared");

    await session.updateClearedStatus({ txnId, clearedStatus: "Cleared" });
    const r = await session.queryEntity("Transfer", { TxnID: txnId });
    expect((r[0] as { ClearedStatus?: string }).ClearedStatus).toBe("Cleared");
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — manager method gates correctly
// ---------------------------------------------------------------------------

describe("QBSessionManager.updateClearedStatus", () => {
  it("read-only session rejects with QBReadOnlyError BEFORE any wire I/O", async () => {
    const session = freshSession();
    const check = await seedCheck(session);
    const txnId = String(check.TxnID);

    session.setReadOnly(true);
    await expect(
      session.updateClearedStatus({ txnId, clearedStatus: "Cleared" }),
    ).rejects.toThrow(QBReadOnlyError);
  });

  it("read-only error carries statusCode 9001 (same sentinel as other mutations)", async () => {
    const session = freshSession();
    const check = await seedCheck(session);
    const txnId = String(check.TxnID);

    session.setReadOnly(true);
    await expect(
      session.updateClearedStatus({ txnId, clearedStatus: "Cleared" }),
    ).rejects.toMatchObject({ statusCode: 9001 });
  });

  it("does NOT touch the idempotency cache (cleared-status is naturally idempotent)", async () => {
    const session = freshSession();
    const check = await seedCheck(session);
    const txnId = String(check.TxnID);

    expect(session.idempotencyCacheSize()).toBe(0);
    await session.updateClearedStatus({ txnId, clearedStatus: "Cleared" });
    await session.updateClearedStatus({ txnId, clearedStatus: "Cleared" });
    expect(session.idempotencyCacheSize()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — tool surface
// ---------------------------------------------------------------------------

describe("qb_cleared_status_update tool", () => {
  it("happy path: flips Check ClearedStatus and returns success payload", async () => {
    const session = freshSession();
    const check = await seedCheck(session);
    const txnId = String(check.TxnID);

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_cleared_status_update")!;

    const result = await handler({
      txnId,
      clearedStatus: "Cleared",
    });
    expect(result.isError).toBeFalsy();

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.clearedStatus).toBe("Cleared");
    expect(payload.txnId).toBe(txnId);
    expect(payload.txnLineId).toBeUndefined();
  });

  it("line-level: propagates txnLineId to the mutation", async () => {
    const session = freshSession();
    const deposit = await seedDeposit(session);
    const txnId = String(deposit.TxnID);
    const lineId = String(
      (deposit as { DepositLineRet: Array<{ TxnLineID: string }> })
        .DepositLineRet[1].TxnLineID,
    );

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_cleared_status_update")!;

    const result = await handler({
      txnId,
      txnLineId: lineId,
      clearedStatus: "Cleared",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.txnLineId).toBe(lineId);
  });

  it("error path: unknown TxnID surfaces statusCode 500 + humanReadable", async () => {
    const session = freshSession();
    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_cleared_status_update")!;

    const result = await handler({
      txnId: "DOES-NOT-EXIST",
      clearedStatus: "Cleared",
    });
    expect(result.isError).toBe(true);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(500);
    expect(payload.humanReadable).toBeDefined();
  });

  it("error path: wrong txn type surfaces statusCode 3120 + humanReadable", async () => {
    const session = freshSession();
    const invoice = await session.addEntity("Invoice", {
      CustomerRef: { FullName: "Acme Corporation" },
      TxnDate: "2026-05-01",
      InvoiceLineAdd: [
        {
          ItemRef: { FullName: "Consulting Services" },
          Quantity: 1,
          Rate: 100,
        },
      ],
    });

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_cleared_status_update")!;

    const result = await handler({
      txnId: String(invoice.TxnID),
      clearedStatus: "Cleared",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(3120);
    expect(payload.humanReadable).toBeDefined();
  });

  it("read-only gate composes: statusCode 9001 + humanReadable", async () => {
    const session = freshSession();
    const check = await seedCheck(session);
    const txnId = String(check.TxnID);
    session.setReadOnly(true);

    registerReconciliationTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_cleared_status_update")!;

    const result = await handler({
      txnId,
      clearedStatus: "Cleared",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
    expect(payload.humanReadable).toMatch(/read-only/i);
  });
});

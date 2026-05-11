// Phase 12 #57a mirror — qb_journal_entry_duplicate
//
// JE-side analog of qb_invoice_duplicate. Composite tool: reads source JE's
// JournalDebitLineRet + JournalCreditLineRet via the existing query path,
// submits a fresh JournalEntryAddRq via the existing add path. No new wire
// types. The sum(debits) === sum(credits) invariant is preserved by
// construction since both sides are carried verbatim from the source.
//
// Carry policy under test:
//   carry by default — debits, credits, IsAdjustment
//   NOT carried     — TxnDate (→ today), RefNumber (→ unset), Memo (→ default)
//   override-wins   — txnDate, refNumber, memo, isAdjustment

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
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
    handler: Handler,
  ) => {
    handlers.set(name, handler);
  },
};

function freshSession(): QBSessionManager {
  return new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-je-duplicate",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

async function seedJournalEntry(
  session: QBSessionManager,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return session.addEntity("JournalEntry", {
    TxnDate: "2026-04-30",
    RefNumber: "JE-APR-001",
    Memo: "April prepaid amortization",
    IsAdjustment: true,
    JournalDebitLineAdd: [
      {
        AccountRef: { FullName: "Rent Expense" },
        Amount: 500,
        Memo: "Amortize Apr prepaid",
      },
    ],
    JournalCreditLineAdd: [
      {
        AccountRef: { FullName: "Prepaid Rent" },
        Amount: 500,
        Memo: "Amortize Apr prepaid",
      },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — happy path: carry both line sides verbatim
// ---------------------------------------------------------------------------

describe("qb_journal_entry_duplicate — happy path", () => {
  it("creates a new JE with the same debit + credit lines, preserving balance", async () => {
    const session = freshSession();
    const source = await seedJournalEntry(session);
    const sourceTxnId = String(source.TxnID);

    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_duplicate")!;

    const result = await handler({ sourceTxnId });
    expect(result.isError).toBeFalsy();

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.sourceTxnId).toBe(sourceTxnId);
    const dup = payload.journalEntry;

    expect(dup.TxnID).toBeDefined();
    expect(dup.TxnID).not.toBe(sourceTxnId);

    const debits = Array.isArray(dup.JournalDebitLineRet)
      ? dup.JournalDebitLineRet
      : [dup.JournalDebitLineRet];
    const credits = Array.isArray(dup.JournalCreditLineRet)
      ? dup.JournalCreditLineRet
      : [dup.JournalCreditLineRet];
    expect(debits).toHaveLength(1);
    expect(credits).toHaveLength(1);
    expect(debits[0].AccountRef.FullName).toBe("Rent Expense");
    expect(Number(debits[0].Amount)).toBe(500);
    expect(credits[0].AccountRef.FullName).toBe("Prepaid Rent");
    expect(Number(credits[0].Amount)).toBe(500);

    // Sim re-derives TotalDebit / TotalCredit from the carried lines.
    expect(Number(dup.TotalDebit)).toBe(500);
    expect(Number(dup.TotalCredit)).toBe(500);
  });

  it("carries multi-line debits and credits without rebalance error", async () => {
    const session = freshSession();
    const source = await session.addEntity("JournalEntry", {
      TxnDate: "2026-04-30",
      RefNumber: "JE-APR-MULTI",
      Memo: "Payroll split",
      JournalDebitLineAdd: [
        { AccountRef: { FullName: "Salaries Expense" }, Amount: 1000 },
        { AccountRef: { FullName: "Payroll Tax Expense" }, Amount: 200 },
      ],
      JournalCreditLineAdd: [
        { AccountRef: { FullName: "Operating Checking" }, Amount: 900 },
        { AccountRef: { FullName: "Payroll Liabilities" }, Amount: 300 },
      ],
    });
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    expect(result.isError).toBeFalsy();
    const dup = JSON.parse(result.content[0].text).journalEntry;
    expect(dup.JournalDebitLineRet).toHaveLength(2);
    expect(dup.JournalCreditLineRet).toHaveLength(2);
    expect(Number(dup.TotalDebit)).toBe(1200);
    expect(Number(dup.TotalCredit)).toBe(1200);
  });

  it("carries per-line Memo, EntityRef, and ClassRef", async () => {
    const session = freshSession();
    const source = await session.addEntity("JournalEntry", {
      TxnDate: "2026-04-30",
      RefNumber: "JE-APR-ENT",
      JournalDebitLineAdd: [
        {
          AccountRef: { FullName: "Accounts Receivable" },
          Amount: 250,
          Memo: "Bill back",
          EntityRef: { FullName: "Acme Corporation" },
          ClassRef: { FullName: "Consulting" },
        },
      ],
      JournalCreditLineAdd: [
        {
          AccountRef: { FullName: "Sales Revenue" },
          Amount: 250,
          Memo: "Bill back",
          ClassRef: { FullName: "Consulting" },
        },
      ],
    });
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).journalEntry;
    const debit = Array.isArray(dup.JournalDebitLineRet)
      ? dup.JournalDebitLineRet[0]
      : dup.JournalDebitLineRet;
    expect(debit.Memo).toBe("Bill back");
    expect(debit.EntityRef.FullName).toBe("Acme Corporation");
    expect(debit.ClassRef.FullName).toBe("Consulting");
  });

  it("default Memo is 'Duplicate of <source RefNumber>'", async () => {
    const session = freshSession();
    const source = await seedJournalEntry(session);
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).journalEntry;
    expect(dup.Memo).toBe("Duplicate of JE-APR-001");
  });

  it("default Memo falls back to TxnID when source has no RefNumber", async () => {
    const session = freshSession();
    const source = await seedJournalEntry(session, { RefNumber: undefined });
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).journalEntry;
    expect(dup.Memo).toBe(`Duplicate of ${source.TxnID}`);
  });

  it("does NOT carry source's TxnDate or RefNumber", async () => {
    const session = freshSession();
    const source = await seedJournalEntry(session);
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).journalEntry;
    expect(dup.TxnDate).not.toBe("2026-04-30");
    expect(dup.RefNumber).toBeUndefined();
  });

  it("carries source's IsAdjustment flag by default", async () => {
    const session = freshSession();
    const source = await seedJournalEntry(session);
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_duplicate")!;

    const result = await handler({ sourceTxnId: String(source.TxnID) });
    const dup = JSON.parse(result.content[0].text).journalEntry;
    expect(dup.IsAdjustment).toBe(true);
  });

  it("operator overrides win for txnDate / refNumber / memo / isAdjustment", async () => {
    const session = freshSession();
    const source = await seedJournalEntry(session);
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_duplicate")!;

    const result = await handler({
      sourceTxnId: String(source.TxnID),
      txnDate: "2026-05-31",
      refNumber: "JE-MAY-001",
      memo: "May prepaid amortization",
      isAdjustment: false,
    });
    const dup = JSON.parse(result.content[0].text).journalEntry;
    expect(dup.TxnDate).toBe("2026-05-31");
    expect(dup.RefNumber).toBe("JE-MAY-001");
    expect(dup.Memo).toBe("May prepaid amortization");
    expect(dup.IsAdjustment).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — error paths
// ---------------------------------------------------------------------------

describe("qb_journal_entry_duplicate — error paths", () => {
  it("unknown sourceTxnId returns statusCode 500 with humanReadable", async () => {
    const session = freshSession();
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_duplicate")!;

    const result = await handler({ sourceTxnId: "DOES-NOT-EXIST" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(500);
    expect(payload.humanReadable).toBeDefined();
  });

  it("read-only session rejects with statusCode 9001", async () => {
    const session = freshSession();
    const source = await seedJournalEntry(session);
    session.setReadOnly(true);

    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_duplicate")!;

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

describe("qb_journal_entry_duplicate — idempotency", () => {
  it("same key + same source returns the original duplicate with idempotentReplay: true", async () => {
    const session = freshSession();
    const source = await seedJournalEntry(session);
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_duplicate")!;

    const r1 = await handler({
      sourceTxnId: String(source.TxnID),
      idempotencyKey: "dup-je-1",
    });
    const p1 = JSON.parse(r1.content[0].text);
    expect(p1.success).toBe(true);
    const firstTxnId = p1.journalEntry.TxnID;

    const r2 = await handler({
      sourceTxnId: String(source.TxnID),
      idempotencyKey: "dup-je-1",
    });
    const p2 = JSON.parse(r2.content[0].text);
    expect(p2.idempotentReplay).toBe(true);
    expect(p2.journalEntry.TxnID).toBe(firstTxnId);
  });

  it("same key + different source returns statusCode 9002", async () => {
    const session = freshSession();
    const sourceA = await seedJournalEntry(session);
    const sourceB = await seedJournalEntry(session, { RefNumber: "JE-APR-002" });
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_duplicate")!;

    await handler({
      sourceTxnId: String(sourceA.TxnID),
      idempotencyKey: "dup-je-2",
    });

    const r2 = await handler({
      sourceTxnId: String(sourceB.TxnID),
      idempotencyKey: "dup-je-2",
    });
    expect(r2.isError).toBe(true);
    const p2 = JSON.parse(r2.content[0].text);
    expect(p2.statusCode).toBe(9002);
  });
});

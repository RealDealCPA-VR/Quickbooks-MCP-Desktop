// Phase 10 #43 — qb_journal_entry_batch_create.
//
// Coverage layers:
//   1. Manager — session.executeBatchAdd packs N AddRq blocks into one envelope
//      with sequential requestIDs, parses N responses, returns positionally-
//      aligned results (posted/failed/skipped).
//   2. Sim store — multi-request envelopes route each AddRq through handleAdd;
//      stopOnError halts on the first failure and skipped entries get no
//      response (the wire-equivalent contract).
//   3. Tool — upfront per-entry balance validation, response shape on full
//      success, compensating-rollback path on mid-batch wire failure (with
//      both successful and failed rollback delete), schema bounds (1..100).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerJournalEntryTools } from "../src/tools/journal-entries.js";
import { buildQBXMLRequest } from "../src/qbxml/builder.js";
import { parseQBXMLResponse } from "../src/qbxml/parser.js";

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
    appName: "vitest-batch-je",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

beforeEach(() => {
  handlers.clear();
  schemas.clear();
});

describe("manager.executeBatchAdd — multi-request envelope plumbing", () => {
  it("packs N AddRq into one envelope with sequential requestIDs", async () => {
    const session = freshSession();
    await session.openSession();
    registerJournalEntryTools(fakeServer as never, () => session);

    const sendSpy = vi.spyOn(session, "sendRequest");

    const results = await session.executeBatchAdd("JournalEntry", [
      {
        TxnDate: "2026-05-01",
        RefNumber: "BATCH-1",
        JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 100 }],
        JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 100 }],
      },
      {
        TxnDate: "2026-05-01",
        RefNumber: "BATCH-2",
        JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 200 }],
        JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 200 }],
      },
    ]);

    // Single envelope on the wire, NOT N separate sendRequest calls.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const xml = sendSpy.mock.calls[0][0];

    // Both AddRq blocks present, each with its own requestID.
    expect(xml).toContain('<JournalEntryAddRq requestID="1">');
    expect(xml).toContain('<JournalEntryAddRq requestID="2">');
    // stopOnError envelope (the only mode the builder emits).
    expect(xml).toContain('<QBXMLMsgsRq onError="stopOnError">');

    // Both posted with TxnIDs.
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("posted");
    expect(results[1].status).toBe("posted");
    if (results[0].status === "posted") {
      expect(results[0].entity.TxnID).toBeTruthy();
      expect(results[0].entity.RefNumber).toBe("BATCH-1");
    }
    if (results[1].status === "posted") {
      expect(results[1].entity.TxnID).toBeTruthy();
      expect(results[1].entity.RefNumber).toBe("BATCH-2");
    }
    expect(results[0].requestID).toBe("1");
    expect(results[1].requestID).toBe("2");
  });

  it("returns empty array for empty input without touching the wire", async () => {
    const session = freshSession();
    await session.openSession();
    const sendSpy = vi.spyOn(session, "sendRequest");
    const results = await session.executeBatchAdd("JournalEntry", []);
    expect(results).toEqual([]);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("aligns response slots positionally when stopOnError halts mid-batch", async () => {
    const session = freshSession();
    await session.openSession();

    // Entry 2 is degenerate (zero amount on both sides) — passes the upfront
    // balance check (0 === 0) but sim's validateJournalEntryBalance rejects it.
    // Subsequent entries (3 and 4) must come back as "skipped", not absent.
    const results = await session.executeBatchAdd("JournalEntry", [
      {
        JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 100 }],
        JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 100 }],
      },
      {
        JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 0 }],
        JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 0 }],
      },
      {
        JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 50 }],
        JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 50 }],
      },
      {
        JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 25 }],
        JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 25 }],
      },
    ]);

    expect(results).toHaveLength(4);
    expect(results[0].status).toBe("posted");
    expect(results[1].status).toBe("failed");
    expect(results[2].status).toBe("skipped");
    expect(results[3].status).toBe("skipped");
    if (results[1].status === "failed") {
      expect(results[1].statusCode).toBe(3030);
      expect(results[1].statusMessage).toMatch(/at least one debit and one credit/);
    }
  });
});

describe("parser — captures requestID on multi-response envelopes", () => {
  it("preserves requestID on each *Rs entry", () => {
    const xml =
      '<?xml version="1.0"?><QBXML><QBXMLMsgsRs>' +
      '<JournalEntryAddRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK">' +
      '<JournalEntryRet><TxnID>1001</TxnID></JournalEntryRet></JournalEntryAddRs>' +
      '<JournalEntryAddRs requestID="2" statusCode="3030" statusSeverity="Error" statusMessage="bad">' +
      '</JournalEntryAddRs>' +
      "</QBXMLMsgsRs></QBXML>";

    const parsed = parseQBXMLResponse(xml);
    expect(parsed.responses).toHaveLength(2);
    expect(parsed.responses[0].requestID).toBe("1");
    expect(parsed.responses[0].statusCode).toBe(0);
    expect(parsed.responses[1].requestID).toBe("2");
    expect(parsed.responses[1].statusCode).toBe(3030);
  });
});

describe("sim store — multi-request envelopes via processRequest", () => {
  it("routes each AddRq through handleAdd and propagates requestID", async () => {
    const session = freshSession();
    await session.openSession();

    const xml = buildQBXMLRequest({
      version: "16.0",
      requests: [
        {
          type: "JournalEntryAddRq",
          requestID: "1",
          body: {
            JournalEntryAdd: {
              TxnDate: "2026-05-01",
              RefNumber: "MULTI-1",
              JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 50 }],
              JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 50 }],
            },
          },
        },
        {
          type: "JournalEntryAddRq",
          requestID: "2",
          body: {
            JournalEntryAdd: {
              TxnDate: "2026-05-01",
              RefNumber: "MULTI-2",
              JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 75 }],
              JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 75 }],
            },
          },
        },
      ],
    });
    const response = await session.sendRequest(xml);

    expect(response.responses).toHaveLength(2);
    expect(response.responses[0].requestID).toBe("1");
    expect(response.responses[0].statusCode).toBe(0);
    expect(response.responses[1].requestID).toBe("2");
    expect(response.responses[1].statusCode).toBe(0);
  });

  it("stopOnError halts the envelope on the first failure", async () => {
    const session = freshSession();
    await session.openSession();

    const xml = buildQBXMLRequest({
      version: "16.0",
      requests: [
        {
          type: "JournalEntryAddRq",
          requestID: "1",
          body: {
            JournalEntryAdd: {
              JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 50 }],
              JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 50 }],
            },
          },
        },
        {
          type: "JournalEntryAddRq",
          requestID: "2",
          body: {
            JournalEntryAdd: {
              JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 0 }],
              JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 0 }],
            },
          },
        },
        {
          type: "JournalEntryAddRq",
          requestID: "3",
          body: {
            JournalEntryAdd: {
              JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 25 }],
              JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 25 }],
            },
          },
        },
      ],
    });
    const response = await session.sendRequest(xml);

    // Two responses (1=posted, 2=failed), no third — entry 3 was skipped per
    // stopOnError, mirroring the live wire contract.
    expect(response.responses).toHaveLength(2);
    expect(response.responses[0].statusCode).toBe(0);
    expect(response.responses[1].statusCode).toBe(3030);
  });
});

describe("qb_journal_entry_batch_create — full-success path", () => {
  it("posts all entries and returns positionally-aligned TxnIDs", async () => {
    const session = freshSession();
    await session.openSession();
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_batch_create")!;

    const result = await handler({
      entries: [
        {
          txnDate: "2026-05-01",
          refNumber: "CC-001",
          memo: "Card Jan",
          debits: [{ accountName: "Office Supplies Expense", amount: 50 }],
          credits: [{ accountName: "AmEx Credit Card", amount: 50 }],
        },
        {
          txnDate: "2026-05-01",
          refNumber: "CC-002",
          memo: "Card Feb",
          debits: [{ accountName: "Travel Expense", amount: 200 }],
          credits: [{ accountName: "AmEx Credit Card", amount: 200 }],
        },
        {
          txnDate: "2026-05-01",
          refNumber: "CC-003",
          memo: "Card Mar",
          debits: [{ accountName: "Software Expense", amount: 99 }],
          credits: [{ accountName: "AmEx Credit Card", amount: 99 }],
        },
      ],
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.count).toBe(3);
    expect(payload.entries).toHaveLength(3);
    expect(payload.entries[0].status).toBe("posted");
    expect(payload.entries[0].refNumber).toBe("CC-001");
    expect(payload.entries[0].txnId).toBeTruthy();
    expect(payload.entries[1].refNumber).toBe("CC-002");
    expect(payload.entries[2].refNumber).toBe("CC-003");

    // All three TxnIDs distinct.
    const txnIds = payload.entries.map((e: { txnId: string }) => e.txnId);
    expect(new Set(txnIds).size).toBe(3);
  });

  it("a single-entry batch still posts (no special-cased path)", async () => {
    const session = freshSession();
    await session.openSession();
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_batch_create")!;

    const result = await handler({
      entries: [
        {
          debits: [{ accountName: "Rent Expense", amount: 1000 }],
          credits: [{ accountName: "Checking", amount: 1000 }],
        },
      ],
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.entries[0].txnId).toBeTruthy();
  });
});

describe("qb_journal_entry_batch_create — upfront validation rejects before wire", () => {
  it("rejects when any entry's debits ≠ credits, with no wire I/O", async () => {
    const session = freshSession();
    await session.openSession();
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_batch_create")!;
    const sendSpy = vi.spyOn(session, "sendRequest");

    const result = await handler({
      entries: [
        {
          debits: [{ accountName: "Rent Expense", amount: 100 }],
          credits: [{ accountName: "Checking", amount: 100 }],
        },
        {
          debits: [{ accountName: "Rent Expense", amount: 100 }],
          credits: [{ accountName: "Checking", amount: 95 }], // unbalanced
        },
      ],
    });

    expect(result.isError).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.statusCode).toBe(3030);
    expect(payload.balanceErrors).toHaveLength(1);
    expect(payload.balanceErrors[0].index).toBe(1);
    expect(payload.balanceErrors[0].error).toMatch(/Entry 2/);
  });

  it("absorbs floating-point drift within $0.005", async () => {
    const session = freshSession();
    await session.openSession();
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_batch_create")!;

    // 0.1 + 0.2 !== 0.3 in IEEE 754 — but the absolute drift is ~5.5e-17,
    // well under the $0.005 tolerance, so the batch must accept this.
    const result = await handler({
      entries: [
        {
          debits: [
            { accountName: "Rent Expense", amount: 0.1 },
            { accountName: "Rent Expense", amount: 0.2 },
          ],
          credits: [{ accountName: "Checking", amount: 0.3 }],
        },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).success).toBe(true);
  });
});

describe("qb_journal_entry_batch_create — schema bounds", () => {
  it("rejects empty entries array (zod .min(1))", () => {
    const session = freshSession();
    registerJournalEntryTools(fakeServer as never, () => session);
    const schema = z.object(schemas.get("qb_journal_entry_batch_create")!);
    expect(() => schema.parse({ entries: [] })).toThrow();
  });

  it("rejects > 100 entries (zod .max(100))", () => {
    const session = freshSession();
    registerJournalEntryTools(fakeServer as never, () => session);
    const schema = z.object(schemas.get("qb_journal_entry_batch_create")!);
    const tooMany = Array.from({ length: 101 }, () => ({
      debits: [{ accountName: "X", amount: 1 }],
      credits: [{ accountName: "Y", amount: 1 }],
    }));
    expect(() => schema.parse({ entries: tooMany })).toThrow();
  });

  it("accepts exactly 100 entries (boundary)", () => {
    const session = freshSession();
    registerJournalEntryTools(fakeServer as never, () => session);
    const schema = z.object(schemas.get("qb_journal_entry_batch_create")!);
    const exactly100 = Array.from({ length: 100 }, () => ({
      debits: [{ accountName: "X", amount: 1 }],
      credits: [{ accountName: "Y", amount: 1 }],
    }));
    expect(() => schema.parse({ entries: exactly100 })).not.toThrow();
  });
});

describe("qb_journal_entry_batch_create — compensating rollback on mid-batch failure", () => {
  it("auto-deletes prior-posted JEs and reports them as 'rolled-back'", async () => {
    const session = freshSession();
    await session.openSession();
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_batch_create")!;
    const deleteSpy = vi.spyOn(session, "deleteEntity");

    // Entries 1+2 valid; entry 3 zero-amount (fails sim's wire-side balance
    // check, since 0 === 0 passes the upfront check). 4+5 skipped per
    // stopOnError. Tool should auto-rollback 1 and 2.
    const result = await handler({
      entries: [
        {
          refNumber: "BATCH-1",
          debits: [{ accountName: "Rent Expense", amount: 100 }],
          credits: [{ accountName: "Checking", amount: 100 }],
        },
        {
          refNumber: "BATCH-2",
          debits: [{ accountName: "Rent Expense", amount: 200 }],
          credits: [{ accountName: "Checking", amount: 200 }],
        },
        {
          refNumber: "BATCH-3",
          debits: [{ accountName: "Rent Expense", amount: 0 }],
          credits: [{ accountName: "Checking", amount: 0 }],
        },
        {
          refNumber: "BATCH-4",
          debits: [{ accountName: "Rent Expense", amount: 50 }],
          credits: [{ accountName: "Checking", amount: 50 }],
        },
        {
          refNumber: "BATCH-5",
          debits: [{ accountName: "Rent Expense", amount: 25 }],
          credits: [{ accountName: "Checking", amount: 25 }],
        },
      ],
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.atomic).toBe(true);
    expect(payload.rolledBack).toBe(true);
    expect(payload.failedAt).toBe(2);
    expect(payload.failedReason.statusCode).toBe(3030);

    expect(payload.summary.failed).toBe(1);
    expect(payload.summary.skipped).toBe(2);
    expect(payload.summary.rolledBack).toBe(2);
    expect(payload.summary.rolledBackTxnIds).toHaveLength(2);
    expect(payload.summary.orphaned).toBeUndefined();

    // Per-entry status alignment.
    expect(payload.entries[0].status).toBe("rolled-back");
    expect(payload.entries[0].refNumber).toBe("BATCH-1");
    expect(payload.entries[0].originalTxnId).toBeTruthy();
    expect(payload.entries[1].status).toBe("rolled-back");
    expect(payload.entries[1].refNumber).toBe("BATCH-2");
    expect(payload.entries[2].status).toBe("failed");
    expect(payload.entries[2].statusCode).toBe(3030);
    expect(payload.entries[3].status).toBe("skipped");
    expect(payload.entries[4].status).toBe("skipped");

    // Two rollback deletes (one per posted entry), in REVERSE post order so
    // the most-recent JE is deleted first.
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy.mock.calls[0]).toEqual([
      "JournalEntry",
      payload.entries[1].originalTxnId,
    ]);
    expect(deleteSpy.mock.calls[1]).toEqual([
      "JournalEntry",
      payload.entries[0].originalTxnId,
    ]);
  });

  it("surfaces 'orphaned' status when rollback delete itself fails", async () => {
    const session = freshSession();
    await session.openSession();
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_batch_create")!;

    // Force every rollback delete to throw, simulating the worst-case live
    // path (e.g., QB rejected the TxnDelRq because something downstream
    // referenced the JE). The tool must NOT swallow the failure — it has to
    // surface the orphaned TxnID so the operator can clean up manually.
    vi.spyOn(session, "deleteEntity").mockRejectedValue(
      new Error("TxnDelRq rejected: posted JE has dependent links"),
    );

    const result = await handler({
      entries: [
        {
          refNumber: "ORPH-1",
          debits: [{ accountName: "Rent Expense", amount: 100 }],
          credits: [{ accountName: "Checking", amount: 100 }],
        },
        {
          refNumber: "ORPH-2",
          debits: [{ accountName: "Rent Expense", amount: 0 }],
          credits: [{ accountName: "Checking", amount: 0 }],
        },
      ],
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.rolledBack).toBe(false);
    expect(payload.summary.rolledBack).toBe(0);
    expect(payload.summary.orphaned).toHaveLength(1);
    expect(payload.summary.orphaned[0].txnId).toBeTruthy();
    expect(payload.summary.orphaned[0].reason).toMatch(/dependent links/);

    expect(payload.entries[0].status).toBe("orphaned");
    expect(payload.entries[0].txnId).toBeTruthy();
    expect(payload.entries[0].rollbackError).toMatch(/dependent links/);
    expect(payload.entries[1].status).toBe("failed");
  });
});

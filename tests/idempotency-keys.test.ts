// Phase 10 #47 — idempotency keys on creates.
//
// Coverage layers:
//   1. Manager — addEntityIdempotent / executeBatchAddIdempotent state
//      machine: cache miss / hit-with-same-fingerprint (replay) /
//      hit-with-different-fingerprint (conflict error 9002). Failed creates
//      do NOT poison the cache. Cache scoped per-companyFile (cleared on
//      switchCompanyFile). FIFO eviction at MAX_IDEMPOTENCY_CACHE_SIZE.
//      Read-only gate composes correctly (fires before idempotency check).
//      Fingerprint canonicalization — key-order insensitive, array-order
//      sensitive.
//   2. Batch idempotency — full-success batches cache and replay; partial-
//      failure batches do NOT cache (the rollback path runs at the tool
//      layer after this method returns; replaying the cached pre-rollback
//      result would re-attempt deletes of already-removed TxnIDs).
//   3. Tool surface — qb_customer_add propagates idempotencyKey, surfaces
//      idempotentReplay: true on replay, surfaces statusCode 9002 +
//      humanReadable on conflict via the existing Item 25 error wrapper.
//      qb_journal_entry_batch_create exercises the batch idempotent path
//      end-to-end through the tool handler.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import {
  QBSessionManager,
  QBIdempotencyKeyConflictError,
  QBReadOnlyError,
} from "../src/session/manager.js";
import { qbStatusCodeMessage } from "../src/util/qb-status-codes.js";
import { registerCustomerTools } from "../src/tools/customers.js";
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
    appName: "vitest-idempotency",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — manager: addEntityIdempotent state machine
// ---------------------------------------------------------------------------

describe("addEntityIdempotent — cache miss/hit/conflict", () => {
  it("miss: first call returns replayed: false and creates the record", async () => {
    const session = freshSession();
    await session.openSession();
    const { entity, replayed } = await session.addEntityIdempotent(
      "Customer",
      { Name: "Acme Idempotent A" },
      "key-A",
    );
    expect(replayed).toBe(false);
    expect(entity.ListID).toBeDefined();
    expect(entity.Name).toBe("Acme Idempotent A");
  });

  it("hit + same payload: second call returns the cached entity with replayed: true", async () => {
    const session = freshSession();
    await session.openSession();
    const first = await session.addEntityIdempotent(
      "Customer",
      { Name: "Acme Idempotent B", Phone: "555-0001" },
      "key-B",
    );
    const second = await session.addEntityIdempotent(
      "Customer",
      { Name: "Acme Idempotent B", Phone: "555-0001" },
      "key-B",
    );
    expect(second.replayed).toBe(true);
    expect(second.entity.ListID).toBe(first.entity.ListID);
    // Confirm only ONE Customer was actually created (replay didn't hit the wire)
    const all = await session.queryEntity("Customer", {});
    const matches = all.filter((c) => (c as { Name: string }).Name === "Acme Idempotent B");
    expect(matches.length).toBe(1);
  });

  it("hit + key-order-permuted same payload: still a replay (canonicalization)", async () => {
    const session = freshSession();
    await session.openSession();
    const first = await session.addEntityIdempotent(
      "Customer",
      { Name: "Acme Idempotent C", Phone: "555-0002", Email: "c@example.com" },
      "key-C",
    );
    const second = await session.addEntityIdempotent(
      "Customer",
      { Email: "c@example.com", Name: "Acme Idempotent C", Phone: "555-0002" },
      "key-C",
    );
    expect(second.replayed).toBe(true);
    expect(second.entity.ListID).toBe(first.entity.ListID);
  });

  it("hit + different payload: throws QBIdempotencyKeyConflictError with statusCode 9002", async () => {
    const session = freshSession();
    await session.openSession();
    await session.addEntityIdempotent(
      "Customer",
      { Name: "Acme Idempotent D" },
      "key-D",
    );
    try {
      await session.addEntityIdempotent(
        "Customer",
        { Name: "Different Customer Same Key" },
        "key-D",
      );
      throw new Error("expected QBIdempotencyKeyConflictError");
    } catch (err) {
      expect(err).toBeInstanceOf(QBIdempotencyKeyConflictError);
      const e = err as QBIdempotencyKeyConflictError;
      expect(e.statusCode).toBe(9002);
      expect(e.idempotencyKey).toBe("key-D");
      expect(e.entityType).toBe("Customer");
      expect(e.message).toContain("Customer");
    }
  });

  it("hit + different entityType (same key, different table): throws conflict error", async () => {
    const session = freshSession();
    await session.openSession();
    await session.addEntityIdempotent(
      "Customer",
      { Name: "Cross-Type Acme" },
      "key-cross",
    );
    await expect(
      session.addEntityIdempotent(
        "Vendor",
        { Name: "Cross-Type Acme" },
        "key-cross",
      ),
    ).rejects.toBeInstanceOf(QBIdempotencyKeyConflictError);
  });

  it("different keys are independent — both create distinct records", async () => {
    const session = freshSession();
    await session.openSession();
    const a = await session.addEntityIdempotent(
      "Customer",
      { Name: "Distinct A" },
      "key-distinct-a",
    );
    const b = await session.addEntityIdempotent(
      "Customer",
      { Name: "Distinct B" },
      "key-distinct-b",
    );
    expect(a.entity.ListID).not.toBe(b.entity.ListID);
  });

  it("array-order changes the fingerprint (line ordering is semantically meaningful)", async () => {
    const session = freshSession();
    await session.openSession();
    const linesA = [
      { ItemRef: { FullName: "Consulting" }, Quantity: 1, Rate: 100 },
      { ItemRef: { FullName: "Consulting" }, Quantity: 2, Rate: 50 },
    ];
    const linesB = [linesA[1], linesA[0]];
    await session.addEntityIdempotent(
      "Invoice",
      { CustomerRef: { FullName: "Acme Co" }, InvoiceLineAdd: linesA },
      "key-lines",
    );
    await expect(
      session.addEntityIdempotent(
        "Invoice",
        { CustomerRef: { FullName: "Acme Co" }, InvoiceLineAdd: linesB },
        "key-lines",
      ),
    ).rejects.toBeInstanceOf(QBIdempotencyKeyConflictError);
  });
});

// ---------------------------------------------------------------------------
// Layer 1 — manager: cache lifecycle and read-only composition
// ---------------------------------------------------------------------------

describe("addEntityIdempotent — cache lifecycle", () => {
  it("a failed create does not poison the cache — retry can succeed", async () => {
    const session = freshSession();
    await session.openSession();
    // Trigger a failure by passing data that the simulation will reject. The
    // sim's handleAdd validates JE balance — submitting an unbalanced JE
    // throws statusCode 3030. We only need the addEntity call to throw; the
    // exact error path isn't load-bearing here.
    await expect(
      session.addEntityIdempotent(
        "JournalEntry",
        {
          JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 100 }],
          JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 50 }],
        },
        "key-failed",
      ),
    ).rejects.toThrow();
    expect(session.idempotencyCacheSize()).toBe(0);

    // Retry with corrected payload should succeed (key was not cached on
    // the failure)
    const retry = await session.addEntityIdempotent(
      "JournalEntry",
      {
        JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 100 }],
        JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 100 }],
      },
      "key-failed",
    );
    expect(retry.replayed).toBe(false);
    expect(retry.entity.TxnID).toBeDefined();
  });

  it("cache survives openSession / closeSession (it's per session-manager state)", async () => {
    const session = freshSession();
    await session.openSession();
    const first = await session.addEntityIdempotent(
      "Customer",
      { Name: "Lifecycle A" },
      "key-lifecycle",
    );
    await session.closeSession();
    await session.openSession();
    const second = await session.addEntityIdempotent(
      "Customer",
      { Name: "Lifecycle A" },
      "key-lifecycle",
    );
    expect(second.replayed).toBe(true);
    expect(second.entity.ListID).toBe(first.entity.ListID);
  });

  it("switchCompanyFile clears the idempotency cache", async () => {
    const session = freshSession();
    await session.openSession();
    await session.addEntityIdempotent(
      "Customer",
      { Name: "Pre-Switch" },
      "key-switch",
    );
    expect(session.idempotencyCacheSize()).toBe(1);

    await session.switchCompanyFile("simulation");
    expect(session.idempotencyCacheSize()).toBe(0);

    // Same key against the new (reseeded) store must NOT replay — the cache
    // was cleared so this is a fresh create
    const after = await session.addEntityIdempotent(
      "Customer",
      { Name: "Pre-Switch" },
      "key-switch",
    );
    expect(after.replayed).toBe(false);
  });

  it("read-only gate fires BEFORE idempotency cache lookup or cache write", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    await expect(
      session.addEntityIdempotent(
        "Customer",
        { Name: "Should Reject" },
        "key-readonly",
      ),
    ).rejects.toBeInstanceOf(QBReadOnlyError);
    expect(session.idempotencyCacheSize()).toBe(0);
  });

  it("FIFO eviction kicks in at MAX_IDEMPOTENCY_CACHE_SIZE (1000); oldest key drops first", async () => {
    const session = freshSession();
    await session.openSession();

    // Insert MAX + 1 distinct keys. Fingerprints all differ (distinct names),
    // so each insert is a fresh cache entry. Stops short at MAX entries
    // because the very first key was evicted by the 1001st insert.
    const MAX = 1000;
    for (let i = 0; i < MAX; i++) {
      await session.addEntityIdempotent(
        "Customer",
        { Name: `EvictTest-${i}` },
        `evict-key-${i}`,
      );
    }
    expect(session.idempotencyCacheSize()).toBe(MAX);

    // Insert one more — pushes the oldest (evict-key-0) out
    await session.addEntityIdempotent(
      "Customer",
      { Name: `EvictTest-${MAX}` },
      `evict-key-${MAX}`,
    );
    expect(session.idempotencyCacheSize()).toBe(MAX);

    // The first key is gone — re-inserting against the same key + same data
    // should NOT replay (because eviction means the cache no longer has it).
    // It will create a fresh record (different ListID from the original).
    const original = await session.queryEntity("Customer", {
      NameFilter: { MatchCriterion: "StartsWith", Name: "EvictTest-0" },
    });
    expect(original.length).toBe(1);
    const originalListId = (original[0] as { ListID: string }).ListID;

    const replayAttempt = await session.addEntityIdempotent(
      "Customer",
      { Name: "EvictTest-0" },
      "evict-key-0",
    );
    expect(replayAttempt.replayed).toBe(false);
    expect(replayAttempt.entity.ListID).not.toBe(originalListId);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — manager: executeBatchAddIdempotent
// ---------------------------------------------------------------------------

describe("executeBatchAddIdempotent — batch state machine", () => {
  it("full-success batch: replays on second call with idempotentReplay-equivalent flag", async () => {
    const session = freshSession();
    await session.openSession();
    const entries = [
      {
        TxnDate: "2026-05-01",
        RefNumber: "BATCH-IDEM-1",
        JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 100 }],
        JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 100 }],
      },
      {
        TxnDate: "2026-05-01",
        RefNumber: "BATCH-IDEM-2",
        JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 200 }],
        JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 200 }],
      },
    ];
    const first = await session.executeBatchAddIdempotent(
      "JournalEntry",
      entries,
      "batch-key-success",
    );
    expect(first.replayed).toBe(false);
    expect(first.results.every((r) => r.status === "posted")).toBe(true);
    const firstTxnIds = first.results.map((r) => {
      if (r.status !== "posted") throw new Error("unexpected non-posted slot");
      return r.entity.TxnID;
    });

    const second = await session.executeBatchAddIdempotent(
      "JournalEntry",
      entries,
      "batch-key-success",
    );
    expect(second.replayed).toBe(true);
    const secondTxnIds = second.results.map((r) => {
      if (r.status !== "posted") throw new Error("unexpected non-posted slot");
      return r.entity.TxnID;
    });
    expect(secondTxnIds).toEqual(firstTxnIds);

    // Confirm only the original 2 JEs exist (no duplicates from replay)
    const all = await session.queryEntity("JournalEntry", {});
    const matches = all.filter((j) => {
      const ref = (j as { RefNumber?: string }).RefNumber;
      return ref === "BATCH-IDEM-1" || ref === "BATCH-IDEM-2";
    });
    expect(matches.length).toBe(2);
  });

  it("partial-failure batch is NOT cached — fresh retry runs the wire again", async () => {
    const session = freshSession();
    await session.openSession();

    // Entry 1 balances and posts. Entry 2 has all-zero amounts which the
    // sim's validateJournalEntryBalance rejects with statusCode 3030 (the
    // sim treats balanced-at-zero as malformed input — pinned by an existing
    // test in journal-entry-batch.test.ts). With stopOnError this is a
    // partial failure, which by design we do NOT cache.
    const entries = [
      {
        TxnDate: "2026-05-01",
        RefNumber: "PARTIAL-1",
        JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 100 }],
        JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 100 }],
      },
      {
        TxnDate: "2026-05-01",
        RefNumber: "PARTIAL-2",
        JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 0 }],
        JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 0 }],
      },
    ];
    const sizeBefore = session.idempotencyCacheSize();
    const result = await session.executeBatchAddIdempotent(
      "JournalEntry",
      entries,
      "batch-key-partial",
    );
    expect(result.replayed).toBe(false);
    expect(result.results.some((r) => r.status === "failed")).toBe(true);
    // Cache size unchanged — partial failures are not stored
    expect(session.idempotencyCacheSize()).toBe(sizeBefore);
  });

  it("hit + reordered entries: throws conflict error (different fingerprint)", async () => {
    const session = freshSession();
    await session.openSession();
    const entryA = {
      TxnDate: "2026-05-01",
      RefNumber: "REORDER-A",
      JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 100 }],
      JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 100 }],
    };
    const entryB = {
      TxnDate: "2026-05-01",
      RefNumber: "REORDER-B",
      JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 200 }],
      JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 200 }],
    };
    await session.executeBatchAddIdempotent(
      "JournalEntry",
      [entryA, entryB],
      "batch-key-reorder",
    );
    await expect(
      session.executeBatchAddIdempotent(
        "JournalEntry",
        [entryB, entryA],
        "batch-key-reorder",
      ),
    ).rejects.toBeInstanceOf(QBIdempotencyKeyConflictError);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — tool surface (qb_customer_add, qb_journal_entry_batch_create)
// ---------------------------------------------------------------------------

describe("qb_customer_add — tool surface idempotency", () => {
  it("idempotencyKey on first call: success without idempotentReplay flag", async () => {
    const session = freshSession();
    await session.openSession();
    registerCustomerTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_customer_add")!;
    const out = await handler({
      name: "Tool Surface A",
      idempotencyKey: "tool-key-A",
    });
    const body = JSON.parse(out.content[0].text);
    expect(body.success).toBe(true);
    expect(body.idempotentReplay).toBeUndefined();
    expect(body.customer.ListID).toBeDefined();
  });

  it("idempotencyKey on retry: surfaces idempotentReplay: true and the original ListID", async () => {
    const session = freshSession();
    await session.openSession();
    registerCustomerTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_customer_add")!;
    const first = JSON.parse(
      (await handler({ name: "Tool Surface B", idempotencyKey: "tool-key-B" }))
        .content[0].text,
    );
    const second = JSON.parse(
      (await handler({ name: "Tool Surface B", idempotencyKey: "tool-key-B" }))
        .content[0].text,
    );
    expect(second.success).toBe(true);
    expect(second.idempotentReplay).toBe(true);
    expect(second.customer.ListID).toBe(first.customer.ListID);
  });

  it("conflict (same key, different payload) surfaces as isError + statusCode 9002 + humanReadable", async () => {
    const session = freshSession();
    await session.openSession();
    registerCustomerTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_customer_add")!;
    await handler({ name: "Conflict Original", idempotencyKey: "tool-key-conflict" });
    const out = await handler({
      name: "Conflict Different",
      idempotencyKey: "tool-key-conflict",
    });
    expect(out.isError).toBe(true);
    const body = JSON.parse(out.content[0].text);
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(9002);
    expect(body.humanReadable).toBe(qbStatusCodeMessage(9002));
  });

  it("no idempotencyKey: every call creates a fresh record (existing behavior preserved)", async () => {
    const session = freshSession();
    await session.openSession();
    registerCustomerTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_customer_add")!;
    const first = JSON.parse(
      (await handler({ name: "Vanilla Acme #1" })).content[0].text,
    );
    const second = JSON.parse(
      (await handler({ name: "Vanilla Acme #2" })).content[0].text,
    );
    expect(first.customer.ListID).not.toBe(second.customer.ListID);
    expect(first.idempotentReplay).toBeUndefined();
    expect(second.idempotentReplay).toBeUndefined();
  });
});

describe("qb_journal_entry_batch_create — tool surface idempotency", () => {
  it("full-success batch + idempotencyKey: replay returns idempotentReplay: true with same TxnIDs", async () => {
    const session = freshSession();
    await session.openSession();
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_batch_create")!;

    const args = {
      entries: [
        {
          txnDate: "2026-05-01",
          refNumber: "TOOL-BATCH-1",
          debits: [{ accountName: "Rent Expense", amount: 100 }],
          credits: [{ accountName: "Checking", amount: 100 }],
        },
        {
          txnDate: "2026-05-01",
          refNumber: "TOOL-BATCH-2",
          debits: [{ accountName: "Rent Expense", amount: 250 }],
          credits: [{ accountName: "Checking", amount: 250 }],
        },
      ],
      idempotencyKey: "tool-batch-key",
    };

    const first = JSON.parse((await handler(args)).content[0].text);
    expect(first.success).toBe(true);
    expect(first.idempotentReplay).toBeUndefined();
    const firstTxnIds = first.entries.map((e: { txnId: string }) => e.txnId);
    expect(firstTxnIds.every((id: string) => id.length > 0)).toBe(true);

    const second = JSON.parse((await handler(args)).content[0].text);
    expect(second.success).toBe(true);
    expect(second.idempotentReplay).toBe(true);
    const secondTxnIds = second.entries.map((e: { txnId: string }) => e.txnId);
    expect(secondTxnIds).toEqual(firstTxnIds);

    // Wire-side: only 2 JEs in the store (replay didn't duplicate)
    const all = await session.queryEntity("JournalEntry", {});
    const matches = all.filter((j) => {
      const ref = (j as { RefNumber?: string }).RefNumber;
      return ref === "TOOL-BATCH-1" || ref === "TOOL-BATCH-2";
    });
    expect(matches.length).toBe(2);
  });

  it("upfront balance-validation rejection is NOT cached — fresh retry runs validation again", async () => {
    const session = freshSession();
    await session.openSession();
    registerJournalEntryTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_journal_entry_batch_create")!;

    const unbalanced = {
      entries: [
        {
          debits: [{ accountName: "Rent Expense", amount: 100 }],
          credits: [{ accountName: "Checking", amount: 50 }],
        },
      ],
      idempotencyKey: "tool-batch-validation",
    };
    const reject1 = JSON.parse((await handler(unbalanced)).content[0].text);
    expect(reject1.success).toBe(false);
    expect(reject1.statusCode).toBe(3030);
    expect(session.idempotencyCacheSize()).toBe(0);

    // Same key with corrected balanced batch should NOT be a conflict — the
    // bad payload was never cached.
    const corrected = {
      entries: [
        {
          debits: [{ accountName: "Rent Expense", amount: 100 }],
          credits: [{ accountName: "Checking", amount: 100 }],
        },
      ],
      idempotencyKey: "tool-batch-validation",
    };
    const out = JSON.parse((await handler(corrected)).content[0].text);
    expect(out.success).toBe(true);
    expect(out.idempotentReplay).toBeUndefined();
  });
});

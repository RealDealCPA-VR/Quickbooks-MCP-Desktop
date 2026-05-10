// Phase 10 #42 — read-only session flag.
//
// Coverage layers:
//   1. Manager — setReadOnly / isReadOnly toggle; assertWritable gate fires on
//      addEntity / modifyEntity / deleteEntity / executeBatchAdd; reads
//      (queryEntity, queryEntityPaginated, queryTransactions, runReport,
//      sendRequest, switchCompanyFile) are unaffected.
//   2. Tool surface — qb_session_connect propagates the flag; readOnly
//      surfaces in qb_session_connect AND qb_company_info responses; mutation
//      tools surface the gate's statusCode 9001 + humanReadable via the
//      existing Item 25 error wrapper.
//   3. Lifecycle — flag persists across openSession/closeSession (it's a
//      session-manager state, not a per-connection state); reconnecting via
//      qb_session_connect() with no arg resets to writable (default false).

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager, QBReadOnlyError } from "../src/session/manager.js";
import { registerReportTools } from "../src/tools/reports.js";
import { registerCustomerTools } from "../src/tools/customers.js";
import { registerJournalEntryTools } from "../src/tools/journal-entries.js";

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
    appName: "vitest-read-only",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

beforeEach(() => {
  handlers.clear();
  schemas.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — manager-level gate
// ---------------------------------------------------------------------------

describe("QBSessionManager — read-only state", () => {
  it("defaults to writable", () => {
    const session = freshSession();
    expect(session.isReadOnly()).toBe(false);
  });

  it("setReadOnly(true) flips the flag, setReadOnly(false) clears it", () => {
    const session = freshSession();
    session.setReadOnly(true);
    expect(session.isReadOnly()).toBe(true);
    session.setReadOnly(false);
    expect(session.isReadOnly()).toBe(false);
  });

  it("setReadOnly is idempotent", () => {
    const session = freshSession();
    session.setReadOnly(true);
    session.setReadOnly(true);
    expect(session.isReadOnly()).toBe(true);
  });

  it("flag persists across openSession / closeSession", async () => {
    const session = freshSession();
    session.setReadOnly(true);
    await session.openSession();
    expect(session.isReadOnly()).toBe(true);
    await session.closeSession();
    expect(session.isReadOnly()).toBe(true);
    await session.openSession();
    expect(session.isReadOnly()).toBe(true);
  });
});

describe("QBSessionManager — assertWritable gate (mutations blocked)", () => {
  it("addEntity throws QBReadOnlyError when readOnly", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    await expect(
      session.addEntity("Customer", { Name: "Acme" }),
    ).rejects.toThrow(QBReadOnlyError);
  });

  it("modifyEntity throws QBReadOnlyError when readOnly", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    await expect(
      session.modifyEntity("Customer", { ListID: "X", EditSequence: "1" }),
    ).rejects.toThrow(QBReadOnlyError);
  });

  it("deleteEntity throws QBReadOnlyError when readOnly", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    await expect(
      session.deleteEntity("Customer", "FAKE-ID"),
    ).rejects.toThrow(QBReadOnlyError);
  });

  it("executeBatchAdd throws QBReadOnlyError when readOnly (and skips empty-array fast-path)", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    await expect(
      session.executeBatchAdd("JournalEntry", [
        {
          TxnDate: "2026-05-01",
          JournalDebitLineAdd: [{ AccountRef: { FullName: "Rent Expense" }, Amount: 100 }],
          JournalCreditLineAdd: [{ AccountRef: { FullName: "Checking" }, Amount: 100 }],
        },
      ]),
    ).rejects.toThrow(QBReadOnlyError);

    // Empty array still short-circuits before the gate (no work, no error).
    // Rationale: the empty case is a documented no-op in the manager method;
    // gating it would be noise.
    const empty = await session.executeBatchAdd("JournalEntry", []);
    expect(empty).toEqual([]);
  });

  it("QBReadOnlyError carries statusCode 9001 and the operation name in the message", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    try {
      await session.addEntity("Invoice", { CustomerRef: { FullName: "Acme" } });
      throw new Error("expected QBReadOnlyError");
    } catch (err) {
      const e = err as QBReadOnlyError;
      expect(e).toBeInstanceOf(QBReadOnlyError);
      expect(e.statusCode).toBe(9001);
      expect(e.message).toContain("addEntity(Invoice)");
      expect(e.message).toMatch(/readOnly: true/);
    }
  });

  it("toggling back to writable re-enables mutations on the SAME session", async () => {
    const session = freshSession();
    await session.openSession();

    session.setReadOnly(true);
    await expect(session.addEntity("Customer", { Name: "A" })).rejects.toThrow(QBReadOnlyError);

    session.setReadOnly(false);
    const created = await session.addEntity("Customer", { Name: "B" });
    expect(created.ListID).toBeDefined();
  });
});

describe("QBSessionManager — reads stay open under readOnly", () => {
  it("queryEntity succeeds when readOnly", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    const accounts = await session.queryEntity("Account", {});
    // Sim seed always emits at least one account; we just need the call to
    // not throw. Asserting on count > 0 keeps this from silently passing
    // if a future seed change empties the chart.
    expect(accounts.length).toBeGreaterThan(0);
  });

  it("queryEntityPaginated succeeds when readOnly", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    const result = await session.queryEntityPaginated("Customer", {
      MaxReturned: 500,
    }, { iterator: "Start" });
    expect(Array.isArray(result.entities)).toBe(true);
  });

  it("queryTransactions succeeds when readOnly", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    // queryTransactions wraps queryEntity("Transaction", ...) which requires
    // an AccountFilter — pull a real account from the seed first.
    const accounts = await session.queryEntity("Account", {});
    const first = accounts[0] as { FullName: string };
    const rows = await session.queryTransactions({
      MaxReturned: 50,
      AccountFilter: { FullName: first.FullName },
    });
    expect(Array.isArray(rows)).toBe(true);
  });

  it("runReport succeeds when readOnly", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    const report = await session.runReport("ProfitAndLossStandard", {
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
    });
    expect(report.Sections).toBeDefined();
  });

  it("switchCompanyFile is allowed when readOnly (book-level switch is not a data mutation)", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    const switched = await session.switchCompanyFile("simulation-other");
    expect(switched.companyFile).toBe("simulation-other");
    // Flag survives the switch — the gate is a session-manager-level
    // invariant, not bound to a specific company file.
    expect(session.isReadOnly()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — tool surface
// ---------------------------------------------------------------------------

describe("qb_session_connect — readOnly arg propagates", () => {
  it("readOnly:true flips the session flag and surfaces it in the response", async () => {
    const session = freshSession();
    registerReportTools(fakeServer as never, () => session);

    const handler = handlers.get("qb_session_connect")!;
    const result = await handler({ readOnly: true });

    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.readOnly).toBe(true);
    expect(session.isReadOnly()).toBe(true);
  });

  it("omitting readOnly defaults to false (writable)", async () => {
    const session = freshSession();
    registerReportTools(fakeServer as never, () => session);

    // Pre-flip so we can prove the default RESETS to writable.
    session.setReadOnly(true);
    expect(session.isReadOnly()).toBe(true);

    const handler = handlers.get("qb_session_connect")!;
    const result = await handler({});

    const body = JSON.parse(result.content[0].text);
    expect(body.readOnly).toBe(false);
    expect(session.isReadOnly()).toBe(false);
  });

  it("readOnly:false explicitly clears a previously-set flag", async () => {
    const session = freshSession();
    registerReportTools(fakeServer as never, () => session);

    session.setReadOnly(true);
    const handler = handlers.get("qb_session_connect")!;
    await handler({ readOnly: false });
    expect(session.isReadOnly()).toBe(false);
  });

  it("schema accepts boolean readOnly and rejects non-boolean", () => {
    const session = freshSession();
    registerReportTools(fakeServer as never, () => session);
    const schema = z.object(schemas.get("qb_session_connect")!);

    expect(schema.safeParse({ readOnly: true }).success).toBe(true);
    expect(schema.safeParse({ readOnly: false }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ readOnly: "true" }).success).toBe(false);
    expect(schema.safeParse({ readOnly: 1 }).success).toBe(false);
  });
});

describe("qb_company_info — surfaces readOnly state", () => {
  it("reflects current readOnly flag without requiring reconnect", async () => {
    const session = freshSession();
    await session.openSession();
    registerReportTools(fakeServer as never, () => session);

    const handler = handlers.get("qb_company_info")!;

    const beforeBody = JSON.parse((await handler({})).content[0].text);
    expect(beforeBody.readOnly).toBe(false);

    session.setReadOnly(true);
    const afterBody = JSON.parse((await handler({})).content[0].text);
    expect(afterBody.readOnly).toBe(true);
  });
});

describe("mutation tools surface QBReadOnlyError as structured isError", () => {
  it("qb_customer_add returns isError:true with statusCode 9001 + humanReadable", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    registerCustomerTools(fakeServer as never, () => session);

    const handler = handlers.get("qb_customer_add")!;
    const result = await handler({ name: "Acme Inc" });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(false);
    expect(body.statusCode).toBe(9001);
    expect(body.statusMessage).toMatch(/Read-only session/);
    expect(body.humanReadable).toMatch(/Read-only session/);
  });

  it("qb_customer_update returns isError:true with statusCode 9001", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    registerCustomerTools(fakeServer as never, () => session);

    const handler = handlers.get("qb_customer_update")!;
    const result = await handler({
      listId: "FAKE-ID",
      editSequence: "1",
      name: "Renamed",
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.statusCode).toBe(9001);
  });

  it("qb_customer_delete returns isError:true with statusCode 9001", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    registerCustomerTools(fakeServer as never, () => session);

    const handler = handlers.get("qb_customer_delete")!;
    const result = await handler({ listId: "FAKE-ID" });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.statusCode).toBe(9001);
  });

  it("qb_journal_entry_batch_create returns isError:true with statusCode 9001 BEFORE any wire I/O", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    registerJournalEntryTools(fakeServer as never, () => session);

    const handler = handlers.get("qb_journal_entry_batch_create")!;
    const result = await handler({
      entries: [
        {
          txnDate: "2026-05-01",
          debits: [{ accountName: "Rent Expense", amount: 100 }],
          credits: [{ accountName: "Checking", amount: 100 }],
        },
        {
          txnDate: "2026-05-01",
          debits: [{ accountName: "Rent Expense", amount: 200 }],
          credits: [{ accountName: "Checking", amount: 200 }],
        },
      ],
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.statusCode).toBe(9001);
    expect(body.statusMessage).toMatch(/Read-only session/);
  });

  it("qb_customer_list (read) succeeds while readOnly is set", async () => {
    const session = freshSession();
    await session.openSession();
    session.setReadOnly(true);
    registerCustomerTools(fakeServer as never, () => session);

    const handler = handlers.get("qb_customer_list")!;
    const result = await handler({});

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(Array.isArray(body.customers)).toBe(true);
  });
});

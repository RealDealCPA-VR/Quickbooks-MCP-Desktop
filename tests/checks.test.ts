// Phase 17 #75 — banking primitives. Check CRUD tool surface tests.
//
// Coverage layers:
//   1. Sim — Check.Amount derives from line sum on create and re-derives on mod.
//   2. qb_check_list — list shape, line-strip default, includeLineItems,
//      txnId / refNumber / payeeName / date filters, paginate.
//   3. qb_check_create — single + multi expense line, item line, both,
//      validation (account required, at least one line), idempotencyKey
//      replay + 9002 conflict, read-only gate.
//   4. qb_check_update — header + line mod, line replacement, Amount re-derive,
//      stale editSequence 3170, unknown TxnID 500.
//   5. qb_check_delete — happy path, unknown TxnID 500, read-only gate.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import {
  QBSessionManager,
  QBReadOnlyError,
} from "../src/session/manager.js";
import { registerCheckTools } from "../src/tools/checks.js";

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
    appName: "vitest-checks",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — sim handler
// ---------------------------------------------------------------------------

describe("SimulationStore — Check.Amount derivation", () => {
  it("computeTotals sets Check.Amount = sum(ExpenseLineRet.Amount) when Amount undefined", async () => {
    const session = freshSession();
    const chk = await session.addEntity("Check", {
      AccountRef: { FullName: "Checking" },
      TxnDate: "2026-05-10",
      ExpenseLineAdd: [
        { AccountRef: { FullName: "Utilities" }, Amount: 150 },
        { AccountRef: { FullName: "Rent Expense" }, Amount: 850 },
      ],
    });
    expect(chk.Amount).toBe(1000);
  });

  it("explicit Check.Amount on create wins (computeTotals only sets when undefined)", async () => {
    const session = freshSession();
    const chk = await session.addEntity("Check", {
      AccountRef: { FullName: "Checking" },
      Amount: 250,
      ExpenseLineAdd: [
        { AccountRef: { FullName: "Utilities" }, Amount: 999 },
      ],
    });
    expect(chk.Amount).toBe(250);
  });

  it("Check.Amount re-derives from new line set on line mod", async () => {
    const session = freshSession();
    const chk = await session.addEntity("Check", {
      AccountRef: { FullName: "Checking" },
      ExpenseLineAdd: [
        { AccountRef: { FullName: "Utilities" }, Amount: 150 },
        { AccountRef: { FullName: "Rent Expense" }, Amount: 850 },
      ],
    });
    const txnId = String(chk.TxnID);
    const editSequence = String(chk.EditSequence);

    const updated = await session.modifyEntity("Check", {
      TxnID: txnId,
      EditSequence: editSequence,
      ExpenseLineMod: [
        { AccountRef: { FullName: "Utilities" }, Amount: 50 },
      ],
    });
    expect(updated.Amount).toBe(50);
    expect((updated.ExpenseLineRet as unknown[]).length).toBe(1);
  });

  it("Check ClearedStatus defaults to NotCleared (bank-affecting txn)", async () => {
    const session = freshSession();
    const chk = await session.addEntity("Check", {
      AccountRef: { FullName: "Checking" },
      ExpenseLineAdd: [{ AccountRef: { FullName: "Utilities" }, Amount: 100 }],
    });
    expect(chk.ClearedStatus).toBe("NotCleared");
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — qb_check_list
// ---------------------------------------------------------------------------

describe("qb_check_list tool", () => {
  async function seedTwoChecks(session: QBSessionManager) {
    const a = await session.addEntity("Check", {
      AccountRef: { FullName: "Checking" },
      PayeeEntityRef: { FullName: "Office Supplies Co" },
      TxnDate: "2026-03-05",
      RefNumber: "CHK-3001",
      ExpenseLineAdd: [{ AccountRef: { FullName: "Utilities" }, Amount: 100 }],
    });
    const b = await session.addEntity("Check", {
      AccountRef: { FullName: "Checking" },
      PayeeEntityRef: { FullName: "Power Co" },
      TxnDate: "2026-04-15",
      RefNumber: "CHK-3002",
      ExpenseLineAdd: [{ AccountRef: { FullName: "Utilities" }, Amount: 200 }],
    });
    return { a, b };
  }

  it("default: lines stripped, count + checks shape", async () => {
    const session = freshSession();
    await seedTwoChecks(session);
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_list")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(2);
    expect(payload.checks[0].ExpenseLineRet).toBeUndefined();
  });

  it("includeLineItems:true surfaces ExpenseLineRet", async () => {
    const session = freshSession();
    await seedTwoChecks(session);
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_list")!;

    const result = await handler({ includeLineItems: true });
    const payload = JSON.parse(result.content[0].text);
    expect(Array.isArray(payload.checks[0].ExpenseLineRet)).toBe(true);
  });

  it("payeeName scopes via EntityFilter", async () => {
    const session = freshSession();
    await seedTwoChecks(session);
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_list")!;

    const result = await handler({ payeeName: "Power Co" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.checks[0].PayeeEntityRef.FullName).toBe("Power Co");
  });

  it("refNumber exact match", async () => {
    const session = freshSession();
    await seedTwoChecks(session);
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_list")!;

    const result = await handler({ refNumber: "CHK-3002" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.checks[0].RefNumber).toBe("CHK-3002");
  });

  it("date range filter — fromDate excludes earlier checks", async () => {
    const session = freshSession();
    await seedTwoChecks(session);
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_list")!;

    const result = await handler({ fromDate: "2026-04-01" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.checks[0].TxnDate).toBe("2026-04-15");
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — qb_check_create
// ---------------------------------------------------------------------------

describe("qb_check_create tool", () => {
  it("happy path: single expense line, header Amount derives, ClearedStatus NotCleared", async () => {
    const session = freshSession();
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_create")!;

    const result = await handler({
      accountName: "Checking",
      payeeName: "Office Supplies Co",
      txnDate: "2026-05-10",
      refNumber: "CHK-100",
      memo: "Monthly supplies",
      expenseLines: [
        { accountName: "Utilities", amount: 250, memo: "Internet bill" },
      ],
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.check.Amount).toBe(250);
    expect(payload.check.ClearedStatus).toBe("NotCleared");
    expect(payload.check.PayeeEntityRef.FullName).toBe("Office Supplies Co");
  });

  it("happy path: item line, Amount = quantity * cost", async () => {
    const session = freshSession();
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_create")!;

    const result = await handler({
      accountName: "Checking",
      itemLines: [
        { itemName: "Widget", quantity: 4, cost: 25 },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.check.Amount).toBe(100);
    expect(payload.check.ItemLineRet[0].Amount).toBe(100);
  });

  it("happy path: both expense + item lines, Amount = total", async () => {
    const session = freshSession();
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_create")!;

    const result = await handler({
      accountName: "Checking",
      expenseLines: [{ accountName: "Utilities", amount: 200 }],
      itemLines: [{ itemName: "Widget", quantity: 4, cost: 25 }],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.check.Amount).toBe(300); // 200 + 100
  });

  it("rejects when bank account missing", async () => {
    const session = freshSession();
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_create")!;

    const result = await handler({
      expenseLines: [{ accountName: "Utilities", amount: 100 }],
    } as unknown);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/accountName/);
  });

  it("rejects when no lines provided (header-only check disallowed)", async () => {
    const session = freshSession();
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_create")!;

    const result = await handler({
      accountName: "Checking",
      payeeName: "X",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/expenseLines or itemLines/);
  });

  it("idempotencyKey replay: same key + same payload returns idempotentReplay:true", async () => {
    const session = freshSession();
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_create")!;

    const args = {
      accountName: "Checking",
      expenseLines: [{ accountName: "Utilities", amount: 100 }],
      idempotencyKey: "chk-key-001",
    };
    const first = await handler(args);
    const firstPayload = JSON.parse(first.content[0].text);
    const second = await handler(args);
    const secondPayload = JSON.parse(second.content[0].text);
    expect(secondPayload.idempotentReplay).toBe(true);
    expect(secondPayload.check.TxnID).toBe(firstPayload.check.TxnID);
    const all = await session.queryEntity("Check", {});
    expect(all.length).toBe(1);
  });

  it("idempotencyKey conflict surfaces 9002", async () => {
    const session = freshSession();
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_create")!;

    await handler({
      accountName: "Checking",
      expenseLines: [{ accountName: "Utilities", amount: 50 }],
      idempotencyKey: "chk-conflict",
    });
    const second = await handler({
      accountName: "Checking",
      expenseLines: [{ accountName: "Utilities", amount: 999 }],
      idempotencyKey: "chk-conflict",
    });
    expect(second.isError).toBe(true);
    const payload = JSON.parse(second.content[0].text);
    expect(payload.statusCode).toBe(9002);
  });

  it("read-only session rejects with 9001", async () => {
    const session = freshSession();
    session.setReadOnly(true);
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_create")!;

    const result = await handler({
      accountName: "Checking",
      expenseLines: [{ accountName: "Utilities", amount: 100 }],
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — qb_check_update
// ---------------------------------------------------------------------------

describe("qb_check_update tool", () => {
  async function seedAndGetIds(session: QBSessionManager) {
    const chk = await session.addEntity("Check", {
      AccountRef: { FullName: "Checking" },
      TxnDate: "2026-05-01",
      Memo: "Original",
      ExpenseLineAdd: [
        { AccountRef: { FullName: "Utilities" }, Amount: 100 },
        { AccountRef: { FullName: "Rent Expense" }, Amount: 500 },
      ],
    });
    return { txnId: String(chk.TxnID), editSequence: String(chk.EditSequence) };
  }

  it("header-only mod: memo changes, lines + Amount preserved", async () => {
    const session = freshSession();
    const { txnId, editSequence } = await seedAndGetIds(session);
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_update")!;

    const result = await handler({
      txnId,
      editSequence,
      memo: "Updated memo",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.check.Memo).toBe("Updated memo");
    expect(payload.check.Amount).toBe(600);
  });

  it("line mod REPLACES the expense set wholesale — Amount recomputes", async () => {
    const session = freshSession();
    const { txnId, editSequence } = await seedAndGetIds(session);
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_update")!;

    const result = await handler({
      txnId,
      editSequence,
      expenseLines: [{ accountName: "Utilities", amount: 999 }],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.check.Amount).toBe(999);
    expect(payload.check.ExpenseLineRet.length).toBe(1);
  });

  it("stale editSequence rejects with 3170", async () => {
    const session = freshSession();
    const { txnId } = await seedAndGetIds(session);
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_update")!;

    const result = await handler({
      txnId,
      editSequence: "stale",
      memo: "X",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(3170);
  });

  it("unknown TxnID rejects with 500", async () => {
    const session = freshSession();
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_update")!;

    const result = await handler({
      txnId: "GHOST",
      editSequence: "1",
      memo: "X",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — qb_check_delete
// ---------------------------------------------------------------------------

describe("qb_check_delete tool", () => {
  it("happy path: removes check from sim store", async () => {
    const session = freshSession();
    const chk = await session.addEntity("Check", {
      AccountRef: { FullName: "Checking" },
      ExpenseLineAdd: [{ AccountRef: { FullName: "Utilities" }, Amount: 100 }],
    });
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_delete")!;

    const result = await handler({ txnId: chk.TxnID });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    const remaining = await session.queryEntity("Check", { TxnID: chk.TxnID });
    expect(remaining.length).toBe(0);
  });

  it("unknown TxnID rejects with 500", async () => {
    const session = freshSession();
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_delete")!;

    const result = await handler({ txnId: "GHOST" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(500);
  });

  it("read-only session rejects with 9001", async () => {
    const session = freshSession();
    const chk = await session.addEntity("Check", {
      AccountRef: { FullName: "Checking" },
      ExpenseLineAdd: [{ AccountRef: { FullName: "Utilities" }, Amount: 100 }],
    });
    session.setReadOnly(true);
    registerCheckTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_check_delete")!;

    const result = await handler({ txnId: chk.TxnID });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
  });
});

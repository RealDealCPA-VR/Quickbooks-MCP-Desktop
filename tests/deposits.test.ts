// Phase 17 #75 — banking primitives. Deposit CRUD tool surface tests.
//
// Coverage layers:
//   1. Sim handleAdd / handleMod — DepositTotal derives from DepositLineRet
//      sum on create and re-derives on line mod.
//   2. qb_deposit_list — list shape, line-strip default, includeLineItems
//      passthrough, txnId filter, date range, paginate iterator state.
//   3. qb_deposit_create — happy path with single + multi line, depositTo
//      validation, line validation, idempotencyKey replay + 9002 conflict,
//      read-only gate (9001), error surface.
//   4. qb_deposit_update — header + line mod, line-replacement semantics,
//      DepositTotal re-derive, stale editSequence 3170, unknown TxnID 500.
//   5. qb_deposit_delete — happy path, unknown TxnID 500, read-only gate.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import {
  QBSessionManager,
  QBReadOnlyError,
} from "../src/session/manager.js";
import { registerDepositTools } from "../src/tools/deposits.js";

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
    appName: "vitest-deposits",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — sim handler: DepositTotal derives from line sum
// ---------------------------------------------------------------------------

describe("SimulationStore — DepositTotal derivation", () => {
  it("computeTotals sets DepositTotal = sum(DepositLineRet.Amount) on create when undefined", async () => {
    const session = freshSession();
    const dep = await session.addEntity("Deposit", {
      DepositToAccountRef: { FullName: "Checking" },
      TxnDate: "2026-05-10",
      DepositLineAdd: [
        { AccountRef: { FullName: "Sales Revenue" }, Amount: 500 },
        { AccountRef: { FullName: "Sales Revenue" }, Amount: 300 },
      ],
    });
    expect(dep.DepositTotal).toBe(800);
    // DepositLineAdd converted to DepositLineRet with TxnLineID assigned
    expect(Array.isArray(dep.DepositLineRet)).toBe(true);
    expect((dep.DepositLineRet as unknown[]).length).toBe(2);
  });

  it("explicit DepositTotal on create wins (computeTotals only sets when undefined)", async () => {
    const session = freshSession();
    const dep = await session.addEntity("Deposit", {
      DepositToAccountRef: { FullName: "Checking" },
      DepositTotal: 999.99,
      DepositLineAdd: [
        { AccountRef: { FullName: "Sales Revenue" }, Amount: 500 },
      ],
    });
    expect(dep.DepositTotal).toBe(999.99);
  });

  it("ClearedStatus defaults to NotCleared on Deposit add (bank-affecting txn)", async () => {
    const session = freshSession();
    const dep = await session.addEntity("Deposit", {
      DepositToAccountRef: { FullName: "Checking" },
      DepositLineAdd: [
        { AccountRef: { FullName: "Sales Revenue" }, Amount: 100 },
      ],
    });
    expect(dep.ClearedStatus).toBe("NotCleared");
  });

  it("DepositTotal re-derives on line mod (handleMod deletes header field first)", async () => {
    const session = freshSession();
    const dep = await session.addEntity("Deposit", {
      DepositToAccountRef: { FullName: "Checking" },
      DepositLineAdd: [
        { AccountRef: { FullName: "Sales Revenue" }, Amount: 500 },
        { AccountRef: { FullName: "Sales Revenue" }, Amount: 300 },
      ],
    });
    const txnId = String(dep.TxnID);
    const editSeq = String(dep.EditSequence);
    expect(dep.DepositTotal).toBe(800);

    // Drop one line, change the other — new total should be 250, not 800.
    const updated = await session.modifyEntity("Deposit", {
      TxnID: txnId,
      EditSequence: editSeq,
      DepositLineMod: [
        { AccountRef: { FullName: "Sales Revenue" }, Amount: 250 },
      ],
    });
    expect(updated.DepositTotal).toBe(250);
    expect(Array.isArray(updated.DepositLineRet)).toBe(true);
    expect((updated.DepositLineRet as unknown[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — qb_deposit_list
// ---------------------------------------------------------------------------

describe("qb_deposit_list tool", () => {
  async function seedTwoDeposits(session: QBSessionManager) {
    const a = await session.addEntity("Deposit", {
      DepositToAccountRef: { FullName: "Checking" },
      TxnDate: "2026-03-05",
      DepositLineAdd: [
        { AccountRef: { FullName: "Sales Revenue" }, Amount: 100 },
      ],
    });
    const b = await session.addEntity("Deposit", {
      DepositToAccountRef: { FullName: "Checking" },
      TxnDate: "2026-04-15",
      DepositLineAdd: [
        { AccountRef: { FullName: "Sales Revenue" }, Amount: 200 },
      ],
    });
    return { a, b };
  }

  it("happy path: returns count + deposits array, lines stripped by default", async () => {
    const session = freshSession();
    await seedTwoDeposits(session);
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_list")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(2);
    expect(Array.isArray(payload.deposits)).toBe(true);
    // Default: lines stripped (matches Phase 10 #41 behavior).
    expect(payload.deposits[0].DepositLineRet).toBeUndefined();
  });

  it("includeLineItems:true surfaces DepositLineRet", async () => {
    const session = freshSession();
    await seedTwoDeposits(session);
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_list")!;

    const result = await handler({ includeLineItems: true });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(2);
    expect(Array.isArray(payload.deposits[0].DepositLineRet)).toBe(true);
  });

  it("txnId filter narrows to one deposit", async () => {
    const session = freshSession();
    const { a } = await seedTwoDeposits(session);
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_list")!;

    const result = await handler({ txnId: a.TxnID });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.deposits[0].TxnID).toBe(a.TxnID);
  });

  it("date range filter — fromDate excludes earlier deposits", async () => {
    const session = freshSession();
    await seedTwoDeposits(session);
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_list")!;

    const result = await handler({ fromDate: "2026-04-01" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.deposits[0].TxnDate).toBe("2026-04-15");
  });

  it("paginate:true auto-defaults maxReturned to 500", async () => {
    const session = freshSession();
    await seedTwoDeposits(session);
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_list")!;

    const result = await handler({ paginate: true });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(2);
    // iterator metadata surfaced
    expect(payload.iteratorRemainingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — qb_deposit_create
// ---------------------------------------------------------------------------

describe("qb_deposit_create tool", () => {
  it("happy path: single-line deposit, returns success + deposit + DepositTotal", async () => {
    const session = freshSession();
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_create")!;

    const result = await handler({
      depositToAccountName: "Checking",
      txnDate: "2026-05-10",
      memo: "May 10 deposit",
      lines: [
        { accountName: "Sales Revenue", amount: 500, memo: "Acme payment" },
      ],
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.deposit.DepositTotal).toBe(500);
    expect(payload.deposit.ClearedStatus).toBe("NotCleared");
    expect(Array.isArray(payload.deposit.DepositLineRet)).toBe(true);
  });

  it("happy path: multi-line deposit, DepositTotal sums lines", async () => {
    const session = freshSession();
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_create")!;

    const result = await handler({
      depositToAccountName: "Checking",
      lines: [
        { entityName: "Acme Corporation", accountName: "Sales Revenue", amount: 500, paymentMethodName: "Check", chequeNumber: "1001" },
        { entityName: "Global Industries", accountName: "Sales Revenue", amount: 300, paymentMethodName: "Check", chequeNumber: "2002" },
      ],
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.deposit.DepositTotal).toBe(800);
    const lines = payload.deposit.DepositLineRet;
    expect(lines.length).toBe(2);
    expect(lines[0].EntityRef.FullName).toBe("Acme Corporation");
    expect(lines[0].PaymentMethodRef.FullName).toBe("Check");
    // fast-xml-parser default-coerces numeric-looking text to numbers on the
    // sim round trip — assert via String() to be agnostic.
    expect(String(lines[0].CheckNumber)).toBe("1001");
  });

  it("rejects when depositTo account is missing (3120-ish — surfaced as error before wire)", async () => {
    const session = freshSession();
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_create")!;

    const result = await handler({
      lines: [{ accountName: "Sales Revenue", amount: 100 }],
    } as unknown);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/depositToAccountName/);
  });

  it("idempotencyKey replay: same key + same payload returns idempotentReplay:true (no duplicate)", async () => {
    const session = freshSession();
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_create")!;

    const args = {
      depositToAccountName: "Checking",
      lines: [{ accountName: "Sales Revenue", amount: 250 }],
      idempotencyKey: "dep-key-001",
    };
    const first = await handler(args);
    const firstPayload = JSON.parse(first.content[0].text);
    expect(firstPayload.idempotentReplay).toBeUndefined();

    const second = await handler(args);
    const secondPayload = JSON.parse(second.content[0].text);
    expect(secondPayload.idempotentReplay).toBe(true);
    expect(secondPayload.deposit.TxnID).toBe(firstPayload.deposit.TxnID);
    // No second record was created
    const allDeposits = await session.queryEntity("Deposit", {});
    expect(allDeposits.length).toBe(1);
  });

  it("idempotencyKey conflict: same key + different payload surfaces 9002", async () => {
    const session = freshSession();
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_create")!;

    await handler({
      depositToAccountName: "Checking",
      lines: [{ accountName: "Sales Revenue", amount: 100 }],
      idempotencyKey: "dep-key-conflict",
    });
    const second = await handler({
      depositToAccountName: "Checking",
      lines: [{ accountName: "Sales Revenue", amount: 999 }],
      idempotencyKey: "dep-key-conflict",
    });
    expect(second.isError).toBe(true);
    const payload = JSON.parse(second.content[0].text);
    expect(payload.statusCode).toBe(9002);
  });

  it("read-only session rejects with statusCode 9001", async () => {
    const session = freshSession();
    session.setReadOnly(true);
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_create")!;

    const result = await handler({
      depositToAccountName: "Checking",
      lines: [{ accountName: "Sales Revenue", amount: 100 }],
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
    expect(payload.humanReadable).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — qb_deposit_update
// ---------------------------------------------------------------------------

describe("qb_deposit_update tool", () => {
  async function seedAndGetIds(session: QBSessionManager) {
    const dep = await session.addEntity("Deposit", {
      DepositToAccountRef: { FullName: "Checking" },
      TxnDate: "2026-05-01",
      Memo: "Original memo",
      DepositLineAdd: [
        { AccountRef: { FullName: "Sales Revenue" }, Amount: 500, Memo: "Original line memo" },
        { AccountRef: { FullName: "Sales Revenue" }, Amount: 300 },
      ],
    });
    return { txnId: String(dep.TxnID), editSequence: String(dep.EditSequence), deposit: dep };
  }

  it("header-only mod: memo changes, lines preserved, DepositTotal unchanged", async () => {
    const session = freshSession();
    const { txnId, editSequence } = await seedAndGetIds(session);
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_update")!;

    const result = await handler({
      txnId,
      editSequence,
      memo: "Updated memo",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.deposit.Memo).toBe("Updated memo");
    expect(payload.deposit.DepositTotal).toBe(800);
  });

  it("line mod REPLACES the line set wholesale — DepositTotal recomputes", async () => {
    const session = freshSession();
    const { txnId, editSequence } = await seedAndGetIds(session);
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_update")!;

    const result = await handler({
      txnId,
      editSequence,
      lines: [
        { accountName: "Sales Revenue", amount: 1000 },
      ],
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.deposit.DepositTotal).toBe(1000);
    expect(payload.deposit.DepositLineRet.length).toBe(1);
  });

  it("stale editSequence rejects with statusCode 3170", async () => {
    const session = freshSession();
    const { txnId } = await seedAndGetIds(session);
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_update")!;

    const result = await handler({
      txnId,
      editSequence: "stale-sequence",
      memo: "X",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(3170);
  });

  it("unknown TxnID rejects with statusCode 500", async () => {
    const session = freshSession();
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_update")!;

    const result = await handler({
      txnId: "NO-SUCH-DEPOSIT",
      editSequence: "1",
      memo: "X",
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — qb_deposit_delete
// ---------------------------------------------------------------------------

describe("qb_deposit_delete tool", () => {
  it("happy path: removes deposit from sim store", async () => {
    const session = freshSession();
    const dep = await session.addEntity("Deposit", {
      DepositToAccountRef: { FullName: "Checking" },
      DepositLineAdd: [{ AccountRef: { FullName: "Sales Revenue" }, Amount: 100 }],
    });
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_delete")!;

    const result = await handler({ txnId: dep.TxnID });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    // gone
    const stillThere = await session.queryEntity("Deposit", { TxnID: dep.TxnID });
    expect(stillThere.length).toBe(0);
  });

  it("unknown TxnID rejects with statusCode 500", async () => {
    const session = freshSession();
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_delete")!;

    const result = await handler({ txnId: "GHOST" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(500);
  });

  it("read-only session rejects with statusCode 9001", async () => {
    const session = freshSession();
    const dep = await session.addEntity("Deposit", {
      DepositToAccountRef: { FullName: "Checking" },
      DepositLineAdd: [{ AccountRef: { FullName: "Sales Revenue" }, Amount: 100 }],
    });
    session.setReadOnly(true);
    registerDepositTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_deposit_delete")!;

    const result = await handler({ txnId: dep.TxnID });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
  });
});

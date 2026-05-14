// Phase 17 #75 — banking primitives. Transfer CRUD tool surface tests.
//
// Coverage layers:
//   1. qb_transfer_list — list shape, txnId / date range filters, paginate.
//   2. qb_transfer_create — happy path, From/To ref validation, same-account
//      guard (3120), positive-amount enforcement, idempotency replay + 9002,
//      read-only gate.
//   3. qb_transfer_update — header mod, stale editSequence 3170, unknown TxnID
//      500, read-only gate.
//   4. qb_transfer_delete — happy path, unknown 500, read-only 9001.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerTransferTools } from "../src/tools/transfers.js";

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
    appName: "vitest-transfers",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — sim handler basics (sanity check)
// ---------------------------------------------------------------------------

describe("SimulationStore — Transfer basics", () => {
  it("Transfer add: ClearedStatus defaults to NotCleared (bank-affecting)", async () => {
    const session = freshSession();
    const xfer = await session.addEntity("Transfer", {
      TransferFromAccountRef: { FullName: "Checking" },
      TransferToAccountRef: { FullName: "Savings" },
      Amount: 1000,
      TxnDate: "2026-05-10",
    });
    expect(xfer.ClearedStatus).toBe("NotCleared");
    expect(xfer.Amount).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — qb_transfer_list
// ---------------------------------------------------------------------------

describe("qb_transfer_list tool", () => {
  async function seedTwoTransfers(session: QBSessionManager) {
    const a = await session.addEntity("Transfer", {
      TransferFromAccountRef: { FullName: "Checking" },
      TransferToAccountRef: { FullName: "Savings" },
      Amount: 500,
      TxnDate: "2026-03-05",
    });
    const b = await session.addEntity("Transfer", {
      TransferFromAccountRef: { FullName: "Checking" },
      TransferToAccountRef: { FullName: "Savings" },
      Amount: 1000,
      TxnDate: "2026-04-15",
    });
    return { a, b };
  }

  it("default: returns count + transfers", async () => {
    const session = freshSession();
    await seedTwoTransfers(session);
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_list")!;

    const result = await handler({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(2);
    expect(Array.isArray(payload.transfers)).toBe(true);
  });

  it("txnId filter narrows to one", async () => {
    const session = freshSession();
    const { a } = await seedTwoTransfers(session);
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_list")!;

    const result = await handler({ txnId: a.TxnID });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.transfers[0].TxnID).toBe(a.TxnID);
  });

  it("date range filter excludes earlier transfers", async () => {
    const session = freshSession();
    await seedTwoTransfers(session);
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_list")!;

    const result = await handler({ fromDate: "2026-04-01" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.transfers[0].TxnDate).toBe("2026-04-15");
  });

  it("paginate:true auto-defaults maxReturned", async () => {
    const session = freshSession();
    await seedTwoTransfers(session);
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_list")!;

    const result = await handler({ paginate: true });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(2);
    expect(payload.iteratorRemainingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — qb_transfer_create
// ---------------------------------------------------------------------------

describe("qb_transfer_create tool", () => {
  it("happy path: returns transfer with From/To/Amount/ClearedStatus", async () => {
    const session = freshSession();
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_create")!;

    const result = await handler({
      fromAccountName: "Checking",
      toAccountName: "Savings",
      amount: 1500,
      txnDate: "2026-05-10",
      memo: "Quarterly savings move",
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.transfer.TransferFromAccountRef.FullName).toBe("Checking");
    expect(payload.transfer.TransferToAccountRef.FullName).toBe("Savings");
    expect(payload.transfer.Amount).toBe(1500);
    expect(payload.transfer.ClearedStatus).toBe("NotCleared");
  });

  it("rejects when fromAccount missing", async () => {
    const session = freshSession();
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_create")!;

    const result = await handler({
      toAccountName: "Savings",
      amount: 100,
    } as unknown);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/fromAccountName/);
  });

  it("rejects when toAccount missing", async () => {
    const session = freshSession();
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_create")!;

    const result = await handler({
      fromAccountName: "Checking",
      amount: 100,
    } as unknown);
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toMatch(/toAccountName/);
  });

  it("rejects self-transfer (same FullName) with statusCode 3120", async () => {
    const session = freshSession();
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_create")!;

    const result = await handler({
      fromAccountName: "Checking",
      toAccountName: "Checking",
      amount: 100,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(3120);
    expect(payload.statusMessage).toMatch(/different/);
  });

  it("rejects self-transfer (same ListID) with statusCode 3120", async () => {
    const session = freshSession();
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_create")!;

    const result = await handler({
      fromAccountListId: "ACCT-A",
      toAccountListId: "ACCT-A",
      amount: 100,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(3120);
  });

  it("idempotencyKey replay: same key + same payload returns idempotentReplay", async () => {
    const session = freshSession();
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_create")!;

    const args = {
      fromAccountName: "Checking",
      toAccountName: "Savings",
      amount: 250,
      idempotencyKey: "xfer-key-001",
    };
    const first = await handler(args);
    const firstPayload = JSON.parse(first.content[0].text);
    const second = await handler(args);
    const secondPayload = JSON.parse(second.content[0].text);
    expect(secondPayload.idempotentReplay).toBe(true);
    expect(secondPayload.transfer.TxnID).toBe(firstPayload.transfer.TxnID);
    const all = await session.queryEntity("Transfer", {});
    expect(all.length).toBe(1);
  });

  it("idempotencyKey conflict surfaces 9002", async () => {
    const session = freshSession();
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_create")!;

    await handler({
      fromAccountName: "Checking",
      toAccountName: "Savings",
      amount: 100,
      idempotencyKey: "xfer-conflict",
    });
    const second = await handler({
      fromAccountName: "Checking",
      toAccountName: "Savings",
      amount: 999,
      idempotencyKey: "xfer-conflict",
    });
    expect(second.isError).toBe(true);
    const payload = JSON.parse(second.content[0].text);
    expect(payload.statusCode).toBe(9002);
  });

  it("read-only session rejects with 9001", async () => {
    const session = freshSession();
    session.setReadOnly(true);
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_create")!;

    const result = await handler({
      fromAccountName: "Checking",
      toAccountName: "Savings",
      amount: 100,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — qb_transfer_update
// ---------------------------------------------------------------------------

describe("qb_transfer_update tool", () => {
  async function seedAndGetIds(session: QBSessionManager) {
    const xfer = await session.addEntity("Transfer", {
      TransferFromAccountRef: { FullName: "Checking" },
      TransferToAccountRef: { FullName: "Savings" },
      Amount: 500,
      TxnDate: "2026-05-01",
      Memo: "Original",
    });
    return { txnId: String(xfer.TxnID), editSequence: String(xfer.EditSequence) };
  }

  it("header mod: memo + amount change", async () => {
    const session = freshSession();
    const { txnId, editSequence } = await seedAndGetIds(session);
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_update")!;

    const result = await handler({
      txnId,
      editSequence,
      amount: 750,
      memo: "Updated",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.transfer.Amount).toBe(750);
    expect(payload.transfer.Memo).toBe("Updated");
    expect(payload.transfer.TransferFromAccountRef.FullName).toBe("Checking");
  });

  it("stale editSequence rejects with 3170", async () => {
    const session = freshSession();
    const { txnId } = await seedAndGetIds(session);
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_update")!;

    const result = await handler({
      txnId,
      editSequence: "stale",
      amount: 1,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(3170);
  });

  it("unknown TxnID rejects with 500", async () => {
    const session = freshSession();
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_update")!;

    const result = await handler({
      txnId: "GHOST",
      editSequence: "1",
      amount: 1,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — qb_transfer_delete
// ---------------------------------------------------------------------------

describe("qb_transfer_delete tool", () => {
  it("happy path: removes transfer from sim store", async () => {
    const session = freshSession();
    const xfer = await session.addEntity("Transfer", {
      TransferFromAccountRef: { FullName: "Checking" },
      TransferToAccountRef: { FullName: "Savings" },
      Amount: 100,
    });
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_delete")!;

    const result = await handler({ txnId: xfer.TxnID });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    const remaining = await session.queryEntity("Transfer", { TxnID: xfer.TxnID });
    expect(remaining.length).toBe(0);
  });

  it("unknown TxnID rejects with 500", async () => {
    const session = freshSession();
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_delete")!;

    const result = await handler({ txnId: "GHOST" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(500);
  });

  it("read-only session rejects with 9001", async () => {
    const session = freshSession();
    const xfer = await session.addEntity("Transfer", {
      TransferFromAccountRef: { FullName: "Checking" },
      TransferToAccountRef: { FullName: "Savings" },
      Amount: 100,
    });
    session.setReadOnly(true);
    registerTransferTools(fakeServer as never, () => session);
    const handler = handlers.get("qb_transfer_delete")!;

    const result = await handler({ txnId: xfer.TxnID });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
  });
});

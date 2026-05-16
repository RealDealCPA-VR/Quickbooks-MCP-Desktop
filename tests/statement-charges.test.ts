// Phase 17 #81 — StatementCharge CRUD + AR-balance posting tests.
//
// StatementCharge is unique among this server's transaction types: structurally
// single-line at the txn header (ItemRef / Quantity / Rate / Amount — no
// *LineAdd array, unlike Invoice/Bill). This test file pins that shape end-to-end:
//
//   Layer 1: Sim handleAdd — computeTotals derives Amount = Quantity * Rate
//            at the header level (vs the line-walk path other txn types use);
//            explicit Amount override wins; Customer.Balance moves by +Amount
//            on add.
//   Layer 2: Sim handleTxnDel — AR-positive reversal restores Customer.Balance.
//   Layer 3: Sim handleMod — Quantity- or Rate-only mod re-derives Amount;
//            explicit Amount in modData wins; Customer.Balance moves by the
//            delta; re-targeting the customer reverses old, applies new.
//   Layer 4: qb_statement_charge_list — list shape, txnId / refNumber /
//            customer / date filters, paginate auto-defaults to MaxReturned=500.
//   Layer 5: qb_statement_charge_create — happy path (qty*rate derive),
//            explicit amount override, both-refs validation (3120), idempotency
//            replay + 9002 conflict, read-only 9001.
//   Layer 6: qb_statement_charge_update — header mod, qty mod re-derives Amount,
//            explicit amount mod wins over qty change, stale editSequence 3170,
//            unknown TxnID 500, customer re-target moves balance correctly.
//   Layer 7: qb_statement_charge_delete — happy path with balance reversal,
//            unknown TxnID 500, read-only 9001.

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerStatementChargeTools } from "../src/tools/statement-charges.js";

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
    appName: "vitest-statement-charges",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
}

async function getCustomer(
  session: QBSessionManager,
  fullName: string,
): Promise<Record<string, unknown>> {
  const customers = await session.queryEntity("Customer", { FullName: fullName });
  return customers[0];
}

beforeEach(() => {
  handlers.clear();
});

// ---------------------------------------------------------------------------
// Layer 1 — sim handleAdd: header-level Amount derive + AR posting
// ---------------------------------------------------------------------------

describe("SimulationStore — StatementCharge handleAdd", () => {
  it("derives Amount = Quantity * Rate at the txn header (no line array)", async () => {
    const session = freshSession();
    const charge = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      TxnDate: "2026-05-16",
      RefNumber: "SC-001",
      Quantity: 4,
      Rate: 150,
      Desc: "Q1 advisory",
    });

    expect(charge.TxnID).toBeDefined();
    expect(charge.Amount).toBe(600);
    expect(charge.EditSequence).toBeDefined();
    // Single-line at header: no *LineRet array attached.
    expect(charge.StatementChargeLineRet).toBeUndefined();
  });

  it("explicit Amount on create overrides Quantity * Rate", async () => {
    const session = freshSession();
    const charge = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Quantity: 4,
      Rate: 150,
      Amount: 500, // ← would be 600 derived; explicit wins
    });
    expect(charge.Amount).toBe(500);
  });

  it("Amount with no Quantity/Rate persists as-is (fixed-fee billing)", async () => {
    const session = freshSession();
    const charge = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Amount: 250,
    });
    expect(charge.Amount).toBe(250);
    expect(charge.Quantity).toBeUndefined();
    expect(charge.Rate).toBeUndefined();
  });

  it("Customer.Balance moves by +Amount on create (AR-positive)", async () => {
    const session = freshSession();
    const before = await getCustomer(session, "Acme Corporation");
    expect(before.Balance).toBe(15000);

    await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Quantity: 2,
      Rate: 100,
    });

    const after = await getCustomer(session, "Acme Corporation");
    expect(after.Balance).toBe(15200);
    expect(after.TotalBalance).toBe(15200);
  });

  it("CustomerRef by ListID resolves the customer for balance posting", async () => {
    const session = freshSession();
    const acme = await getCustomer(session, "Acme Corporation");
    await session.addEntity("StatementCharge", {
      CustomerRef: { ListID: acme.ListID as string },
      ItemRef: { FullName: "Consulting Services" },
      Amount: 75,
    });
    const after = await getCustomer(session, "Acme Corporation");
    expect(after.Balance).toBe(15075);
  });

  it("orphan CustomerRef silently no-ops the balance posting (matches Invoice policy)", async () => {
    const session = freshSession();
    // No throw — the charge still persists; just no customer to move.
    const charge = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Ghost Customer That Does Not Exist" },
      ItemRef: { FullName: "Consulting Services" },
      Amount: 99,
    });
    expect(charge.TxnID).toBeDefined();
    expect(charge.Amount).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — sim handleTxnDel: reverse AR posting
// ---------------------------------------------------------------------------

describe("SimulationStore — StatementCharge handleTxnDel", () => {
  it("delete reverses +Amount against Customer.Balance", async () => {
    const session = freshSession();
    const charge = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Quantity: 3,
      Rate: 200, // Amount = 600
    });
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15600);

    await session.deleteEntity("StatementCharge", charge.TxnID as string);

    const after = await getCustomer(session, "Acme Corporation");
    expect(after.Balance).toBe(15000);
  });

  it("unknown TxnID returns 500 without mutating any state", async () => {
    const session = freshSession();
    let caught: { statusCode?: number } | undefined;
    try {
      await session.deleteEntity("StatementCharge", "NONEXISTENT-TXN");
    } catch (err) {
      caught = err as { statusCode?: number };
    }
    expect(caught?.statusCode).toBe(500);
    const after = await getCustomer(session, "Acme Corporation");
    expect(after.Balance).toBe(15000);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — sim handleMod: Amount re-derive + balance delta
// ---------------------------------------------------------------------------

describe("SimulationStore — StatementCharge handleMod", () => {
  it("Quantity-only mod re-derives Amount and moves balance by delta", async () => {
    const session = freshSession();
    const original = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Quantity: 2,
      Rate: 100, // Amount = 200
    });
    expect(original.Amount).toBe(200);
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15200);

    const modded = await session.modifyEntity("StatementCharge", {
      TxnID: original.TxnID,
      EditSequence: original.EditSequence,
      Quantity: 5, // Rate stays 100 → Amount should re-derive to 500
    });
    expect(modded.Amount).toBe(500);
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15500);
  });

  it("Rate-only mod re-derives Amount and moves balance by delta", async () => {
    const session = freshSession();
    const original = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Quantity: 4,
      Rate: 50, // Amount = 200
    });
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15200);

    const modded = await session.modifyEntity("StatementCharge", {
      TxnID: original.TxnID,
      EditSequence: original.EditSequence,
      Rate: 75, // Quantity stays 4 → Amount = 300
    });
    expect(modded.Amount).toBe(300);
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15300);
  });

  it("explicit Amount in mod wins over qty re-derive", async () => {
    const session = freshSession();
    const original = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Quantity: 2,
      Rate: 100, // Amount = 200
    });

    const modded = await session.modifyEntity("StatementCharge", {
      TxnID: original.TxnID,
      EditSequence: original.EditSequence,
      Quantity: 10, // would derive to 1000 but...
      Amount: 999, // explicit wins
    });
    expect(modded.Amount).toBe(999);
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15000 + 999);
  });

  it("header-only mod (no qty/rate/amount change) leaves Amount intact", async () => {
    const session = freshSession();
    const original = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Quantity: 2,
      Rate: 100, // Amount = 200
    });

    const modded = await session.modifyEntity("StatementCharge", {
      TxnID: original.TxnID,
      EditSequence: original.EditSequence,
      RefNumber: "SC-RENAMED",
      Desc: "Updated description",
    });
    expect(modded.Amount).toBe(200);
    expect(modded.RefNumber).toBe("SC-RENAMED");
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15200);
  });

  it("re-targeting CustomerRef reverses old customer's balance and posts to new", async () => {
    const session = freshSession();
    const original = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Amount: 300,
    });
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15300);
    expect((await getCustomer(session, "Global Industries")).Balance).toBe(8500);

    await session.modifyEntity("StatementCharge", {
      TxnID: original.TxnID,
      EditSequence: original.EditSequence,
      CustomerRef: { FullName: "Global Industries" },
    });

    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15000);
    expect((await getCustomer(session, "Global Industries")).Balance).toBe(8800);
  });

  it("stale EditSequence rejects with 3170", async () => {
    const session = freshSession();
    const original = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Amount: 100,
    });
    let caught: { statusCode?: number } | undefined;
    try {
      await session.modifyEntity("StatementCharge", {
        TxnID: original.TxnID,
        EditSequence: "stale-sequence",
        Amount: 200,
      });
    } catch (err) {
      caught = err as { statusCode?: number };
    }
    expect(caught?.statusCode).toBe(3170);
    // Original Amount preserved; balance unchanged from create.
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15100);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — qb_statement_charge_list
// ---------------------------------------------------------------------------

describe("qb_statement_charge_list", () => {
  it("returns empty count=0 against fresh sim (no seeded statement charges)", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const list = handlers.get("qb_statement_charge_list")!;
    const result = await list({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(0);
    expect(payload.statementCharges).toEqual([]);
  });

  it("surfaces statement charges created against the session", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      RefNumber: "SC-100",
      Quantity: 2,
      Rate: 75,
    });

    const list = handlers.get("qb_statement_charge_list")!;
    const result = await list({});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.statementCharges[0].Amount).toBe(150);
    expect(payload.statementCharges[0].RefNumber).toBe("SC-100");
  });

  it("txnId filter fetches a specific charge", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const created = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Amount: 75,
    });
    await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Amount: 200,
    });

    const list = handlers.get("qb_statement_charge_list")!;
    const result = await list({ txnId: created.TxnID });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.statementCharges[0].TxnID).toBe(created.TxnID);
  });

  it("customerName filter scopes to one customer", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Amount: 100,
    });
    await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Global Industries" },
      ItemRef: { FullName: "Consulting Services" },
      Amount: 200,
    });

    const list = handlers.get("qb_statement_charge_list")!;
    const result = await list({ customerName: "Acme Corporation" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.statementCharges[0].Amount).toBe(100);
  });

  it("refNumber filter scopes to that ref", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      RefNumber: "SC-A",
      Amount: 50,
    });
    await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      RefNumber: "SC-B",
      Amount: 60,
    });

    const list = handlers.get("qb_statement_charge_list")!;
    const result = await list({ refNumber: "SC-A" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.statementCharges[0].RefNumber).toBe("SC-A");
  });

  it("date range filter excludes out-of-window charges", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      TxnDate: "2025-03-15",
      Amount: 100,
    });
    await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      TxnDate: "2026-05-15",
      Amount: 200,
    });

    const list = handlers.get("qb_statement_charge_list")!;
    const result = await list({ fromDate: "2026-01-01", toDate: "2026-12-31" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.statementCharges[0].Amount).toBe(200);
  });

  it("paginate:true auto-defaults MaxReturned to 500", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    // Spy on the underlying paginated call to assert MaxReturned default.
    let capturedFilters: Record<string, unknown> | undefined;
    const orig = session.queryEntityPaginated.bind(session);
    session.queryEntityPaginated = async (entityType, filters, opts) => {
      capturedFilters = filters;
      return orig(entityType, filters, opts);
    };

    const list = handlers.get("qb_statement_charge_list")!;
    await list({ paginate: true });
    expect((capturedFilters as Record<string, unknown>).MaxReturned).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — qb_statement_charge_create
// ---------------------------------------------------------------------------

describe("qb_statement_charge_create", () => {
  it("happy path: qty * rate → Amount, posts to customer balance", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const create = handlers.get("qb_statement_charge_create")!;
    const result = await create({
      customerName: "Acme Corporation",
      itemName: "Consulting Services",
      quantity: 4,
      rate: 150,
      description: "Q2 advisory",
      txnDate: "2026-05-16",
      refNumber: "SC-201",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.statementCharge.Amount).toBe(600);
    expect(payload.statementCharge.TxnID).toBeDefined();
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15600);
  });

  it("explicit amount override wins over qty * rate", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const create = handlers.get("qb_statement_charge_create")!;
    const result = await create({
      customerName: "Acme Corporation",
      itemName: "Consulting Services",
      quantity: 4,
      rate: 150,
      amount: 500,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statementCharge.Amount).toBe(500);
  });

  it("missing customerRef rejects with 3120", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const create = handlers.get("qb_statement_charge_create")!;
    const result = await create({
      itemName: "Consulting Services",
      amount: 100,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(3120);
    expect(payload.statusMessage).toMatch(/customer/i);
  });

  it("missing itemRef rejects with 3120 (StatementCharge requires ItemRef)", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const create = handlers.get("qb_statement_charge_create")!;
    const result = await create({
      customerName: "Acme Corporation",
      amount: 100,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(3120);
    expect(payload.statusMessage).toMatch(/item/i);
  });

  it("missing amount source (no amount AND no qty+rate) rejects with 3120", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const create = handlers.get("qb_statement_charge_create")!;
    const result = await create({
      customerName: "Acme Corporation",
      itemName: "Consulting Services",
      // qty alone (no rate) — neither path satisfied
      quantity: 5,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(3120);
    expect(payload.statusMessage).toMatch(/amount|quantity/i);
  });

  it("idempotencyKey replay returns the same charge and does not double-post AR", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const create = handlers.get("qb_statement_charge_create")!;

    const first = await create({
      customerName: "Acme Corporation",
      itemName: "Consulting Services",
      quantity: 2,
      rate: 100,
      idempotencyKey: "key-sc-1",
    });
    const firstPayload = JSON.parse(first.content[0].text);
    expect(firstPayload.success).toBe(true);
    expect(firstPayload.statementCharge.Amount).toBe(200);
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15200);

    const replay = await create({
      customerName: "Acme Corporation",
      itemName: "Consulting Services",
      quantity: 2,
      rate: 100,
      idempotencyKey: "key-sc-1",
    });
    const replayPayload = JSON.parse(replay.content[0].text);
    expect(replayPayload.success).toBe(true);
    expect(replayPayload.idempotentReplay).toBe(true);
    expect(replayPayload.statementCharge.TxnID).toBe(firstPayload.statementCharge.TxnID);
    // Balance must NOT have moved a second time.
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15200);
  });

  it("idempotencyKey + different payload returns 9002 conflict", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const create = handlers.get("qb_statement_charge_create")!;

    await create({
      customerName: "Acme Corporation",
      itemName: "Consulting Services",
      quantity: 2,
      rate: 100,
      idempotencyKey: "key-conflict",
    });
    const conflict = await create({
      customerName: "Acme Corporation",
      itemName: "Consulting Services",
      quantity: 5, // different
      rate: 100,
      idempotencyKey: "key-conflict",
    });
    expect(conflict.isError).toBe(true);
    const payload = JSON.parse(conflict.content[0].text);
    expect(payload.statusCode).toBe(9002);
  });

  it("read-only session rejects create with 9001", async () => {
    const session = freshSession();
    session.setReadOnly(true);
    registerStatementChargeTools(fakeServer as never, () => session);
    const create = handlers.get("qb_statement_charge_create")!;
    const result = await create({
      customerName: "Acme Corporation",
      itemName: "Consulting Services",
      amount: 100,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
  });
});

// ---------------------------------------------------------------------------
// Layer 6 — qb_statement_charge_update
// ---------------------------------------------------------------------------

describe("qb_statement_charge_update", () => {
  it("header-only mod (description) leaves Amount + balance intact", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const sc = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Quantity: 2,
      Rate: 100, // Amount = 200
    });

    const update = handlers.get("qb_statement_charge_update")!;
    const result = await update({
      txnId: sc.TxnID,
      editSequence: sc.EditSequence,
      description: "Updated desc",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect(payload.statementCharge.Amount).toBe(200);
    expect(payload.statementCharge.Desc).toBe("Updated desc");
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15200);
  });

  it("quantity mod re-derives Amount and moves balance by delta", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const sc = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Quantity: 2,
      Rate: 100, // Amount = 200
    });

    const update = handlers.get("qb_statement_charge_update")!;
    const result = await update({
      txnId: sc.TxnID,
      editSequence: sc.EditSequence,
      quantity: 5,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statementCharge.Amount).toBe(500);
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15500);
  });

  it("explicit amount mod wins over qty change re-derive", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const sc = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Quantity: 2,
      Rate: 100, // Amount = 200
    });
    const update = handlers.get("qb_statement_charge_update")!;
    const result = await update({
      txnId: sc.TxnID,
      editSequence: sc.EditSequence,
      quantity: 99,
      amount: 777,
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statementCharge.Amount).toBe(777);
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15000 + 777);
  });

  it("customer re-target moves balance from old to new customer", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const sc = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Amount: 250,
    });
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15250);
    expect((await getCustomer(session, "Global Industries")).Balance).toBe(8500);

    const update = handlers.get("qb_statement_charge_update")!;
    await update({
      txnId: sc.TxnID,
      editSequence: sc.EditSequence,
      customerName: "Global Industries",
    });

    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15000);
    expect((await getCustomer(session, "Global Industries")).Balance).toBe(8750);
  });

  it("stale editSequence rejects with 3170", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const sc = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Amount: 100,
    });
    const update = handlers.get("qb_statement_charge_update")!;
    const result = await update({
      txnId: sc.TxnID,
      editSequence: "stale",
      amount: 200,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(3170);
  });

  it("unknown TxnID returns 500", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const update = handlers.get("qb_statement_charge_update")!;
    const result = await update({
      txnId: "NONEXISTENT",
      editSequence: "anything",
      amount: 100,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(500);
  });

  it("read-only session rejects update with 9001", async () => {
    const session = freshSession();
    const sc = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Amount: 100,
    });
    session.setReadOnly(true);
    registerStatementChargeTools(fakeServer as never, () => session);
    const update = handlers.get("qb_statement_charge_update")!;
    const result = await update({
      txnId: sc.TxnID,
      editSequence: sc.EditSequence,
      amount: 200,
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
  });
});

// ---------------------------------------------------------------------------
// Layer 7 — qb_statement_charge_delete
// ---------------------------------------------------------------------------

describe("qb_statement_charge_delete", () => {
  it("happy path: removes charge and reverses Customer.Balance", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const sc = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Quantity: 3,
      Rate: 200, // Amount = 600
    });
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15600);

    const del = handlers.get("qb_statement_charge_delete")!;
    const result = await del({ txnId: sc.TxnID });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.success).toBe(true);
    expect((await getCustomer(session, "Acme Corporation")).Balance).toBe(15000);

    // Confirm charge is gone via list.
    const list = await session.queryEntity("StatementCharge", { TxnID: sc.TxnID });
    expect(list.length).toBe(0);
  });

  it("unknown TxnID returns 500", async () => {
    const session = freshSession();
    registerStatementChargeTools(fakeServer as never, () => session);
    const del = handlers.get("qb_statement_charge_delete")!;
    const result = await del({ txnId: "NONEXISTENT" });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(500);
  });

  it("read-only session rejects delete with 9001", async () => {
    const session = freshSession();
    const sc = await session.addEntity("StatementCharge", {
      CustomerRef: { FullName: "Acme Corporation" },
      ItemRef: { FullName: "Consulting Services" },
      Amount: 50,
    });
    session.setReadOnly(true);
    registerStatementChargeTools(fakeServer as never, () => session);
    const del = handlers.get("qb_statement_charge_delete")!;
    const result = await del({ txnId: sc.TxnID });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.statusCode).toBe(9001);
  });
});

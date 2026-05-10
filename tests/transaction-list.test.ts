// Phase 10 #40 — qb_transaction_list_by_account.
//
// Coverage layers:
//   1. Sim handler — TransactionQueryRq fans out across txn stores; emits
//      LINE-LEVEL TransactionRet rows; sign convention; required AccountFilter.
//   2. Manager wrapper — session.queryTransactions returns a TransactionRet[].
//   3. Tool handler — schema-required filter order; running-balance math
//      (opening = currentBalance − periodSum, walks forward); error shapes.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { z } from "zod";
import { QBSessionManager } from "../src/session/manager.js";
import { registerTransactionTools } from "../src/tools/transactions.js";

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
    handler: Handler
  ) => {
    handlers.set(name, handler);
    schemas.set(name, schema);
  },
};

let session: QBSessionManager;

beforeAll(async () => {
  session = new QBSessionManager({
    companyFile: "simulation",
    appName: "vitest-transactions",
    qbxmlVersion: "16.0",
    connectionMode: "optimistic",
  });
  registerTransactionTools(fakeServer as never, () => session);
  await session.openSession();

  // Populate the sim with a known posting set on two accounts. The sim's seed
  // accounts have static Balance snapshots — these handleAdd calls do NOT
  // mutate Account.Balance, which is the realistic behavior (Account.Balance
  // is a pre-period reference for the running-balance math).
  await session.addEntity("Bill", {
    VendorRef: { FullName: "Office Supplies Co" },
    TxnDate: "2026-02-15",
    RefNumber: "B-1",
    Memo: "Feb rent",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Rent Expense" }, Amount: 2000, Memo: "office rent" },
    ],
  });
  await session.addEntity("Bill", {
    VendorRef: { FullName: "Office Supplies Co" },
    TxnDate: "2026-03-15",
    RefNumber: "B-2",
    ExpenseLineAdd: [
      { AccountRef: { FullName: "Rent Expense" }, Amount: 2100 },
    ],
  });
  // JE debit-on-Rent-Expense (natural-debit account) → +500. Credit side
  // posts to a Bank account so the entry balances.
  await session.addEntity("JournalEntry", {
    TxnDate: "2026-04-01",
    RefNumber: "JE-100",
    JournalDebitLineAdd: [
      { AccountRef: { FullName: "Rent Expense" }, Amount: 500, Memo: "rent reclass" },
    ],
    JournalCreditLineAdd: [
      { AccountRef: { FullName: "Checking" }, Amount: 500 },
    ],
  });
  // JE credit-on-Sales-Revenue (natural-credit account) → +700.
  await session.addEntity("JournalEntry", {
    TxnDate: "2026-05-01",
    RefNumber: "JE-200",
    JournalDebitLineAdd: [
      { AccountRef: { FullName: "Checking" }, Amount: 700 },
    ],
    JournalCreditLineAdd: [
      { AccountRef: { FullName: "Sales Revenue" }, Amount: 700, Memo: "manual sales adj" },
    ],
  });
  // JE debit-on-Sales-Revenue (against natural) → -150.
  await session.addEntity("JournalEntry", {
    TxnDate: "2026-05-15",
    RefNumber: "JE-201",
    JournalDebitLineAdd: [
      { AccountRef: { FullName: "Sales Revenue" }, Amount: 150 },
    ],
    JournalCreditLineAdd: [
      { AccountRef: { FullName: "Checking" }, Amount: 150 },
    ],
  });
});

const callTool = async (toolName: string, args: Record<string, unknown>) => {
  const schema = schemas.get(toolName);
  const handler = handlers.get(toolName);
  if (!schema || !handler) throw new Error(`Tool not registered: ${toolName}`);
  const parsed = z.object(schema).safeParse(args);
  if (!parsed.success) return { schemaError: parsed.error };
  const result = await handler(parsed.data);
  const payload = JSON.parse(result.content[0].text);
  return { result, payload };
};

describe("Layer 1 — sim handler emits line-level TransactionRet rows", () => {
  it("returns Bill expense lines + JE debit lines for a natural-debit account", async () => {
    const rows = await session.queryTransactions({
      AccountFilter: { FullName: "Rent Expense" },
    });

    expect(rows.length).toBe(3); // 2 bills + 1 JE debit
    const txnTypes = rows.map((r) => r.TxnType).sort();
    expect(txnTypes).toEqual(["Bill", "Bill", "JournalEntry"]);

    // All amounts positive for a natural-debit account that's being debited.
    for (const r of rows) {
      expect(Number(r.Amount)).toBeGreaterThan(0);
    }

    // Account FullName is canonicalized on every row.
    for (const r of rows) {
      expect((r.Account as Record<string, unknown>).FullName).toBe("Rent Expense");
    }
  });

  it("JE debit-against-natural posts negatively for Sales Revenue (natural-credit)", async () => {
    const rows = await session.queryTransactions({
      AccountFilter: { FullName: "Sales Revenue" },
    });
    expect(rows.length).toBe(2);

    // Find the credit-side JE (positive on natural-credit) and the debit-side
    // JE (negative on natural-credit). Match by RefNumber.
    const credit = rows.find((r) => r.RefNumber === "JE-200");
    const debit = rows.find((r) => r.RefNumber === "JE-201");
    expect(credit).toBeDefined();
    expect(debit).toBeDefined();
    expect(Number(credit!.Amount)).toBe(700);
    expect(Number(debit!.Amount)).toBe(-150);
  });

  it("rows are sorted by TxnDate ascending", async () => {
    const rows = await session.queryTransactions({
      AccountFilter: { FullName: "Rent Expense" },
    });
    const dates = rows.map((r) => String(r.TxnDate));
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });

  it("ListID-form AccountFilter resolves to the same FullName", async () => {
    // Seed account ListID for Rent Expense per simulation-store.ts.
    const rows = await session.queryTransactions({
      AccountFilter: { ListID: "A0000008" },
    });
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect((r.Account as Record<string, unknown>).FullName).toBe("Rent Expense");
    }
  });

  it("missing AccountFilter rejects with statusCode 3120", async () => {
    await expect(session.queryTransactions({})).rejects.toMatchObject({
      statusCode: 3120,
    });
  });

  it("unknown account returns empty (statusCode 1, no rows)", async () => {
    const rows = await session.queryTransactions({
      AccountFilter: { FullName: "Nonexistent Account" },
    });
    expect(rows).toEqual([]);
  });
});

describe("Layer 2 — sim handler honors filters", () => {
  it("TxnDateRangeFilter excludes rows outside [from, to]", async () => {
    const rows = await session.queryTransactions({
      TxnDateRangeFilter: { FromTxnDate: "2026-03-01", ToTxnDate: "2026-04-30" },
      AccountFilter: { FullName: "Rent Expense" },
    });
    // Only the Mar bill (2026-03-15) and Apr JE (2026-04-01) — Feb bill out.
    expect(rows.length).toBe(2);
    const refs = rows.map((r) => r.RefNumber).sort();
    expect(refs).toEqual(["B-2", "JE-100"]);
  });

  it("MaxReturned caps the result set", async () => {
    const rows = await session.queryTransactions({
      MaxReturned: 1,
      AccountFilter: { FullName: "Rent Expense" },
    });
    expect(rows.length).toBe(1);
    // Earliest by date — the Feb bill.
    expect(rows[0].RefNumber).toBe("B-1");
  });
});

describe("Layer 3 — qb_transaction_list_by_account tool layer", () => {
  it("requires accountName or accountListId", async () => {
    const { result, payload } = (await callTool(
      "qb_transaction_list_by_account",
      {}
    )) as { result: { isError?: boolean }; payload: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(String(payload.error)).toMatch(/accountName.+accountListId/);
  });

  it("computes openingBalance + per-row RunningBalance", async () => {
    // Sim's seed Account.Balance for "Rent Expense" is 24000 — this is the
    // pre-period snapshot the running-balance math uses as currentBalance.
    // Three rows hit Rent Expense: Bill 2000 (Feb), Bill 2100 (Mar),
    // JE 500 (Apr). periodSum = 4600.
    // openingBalance = 24000 − 4600 = 19400.
    // After row 1 (2000): 21400.
    // After row 2 (2100): 23500.
    // After row 3 (500):  24000  (closes back to seed balance).
    const { payload } = (await callTool("qb_transaction_list_by_account", {
      accountName: "Rent Expense",
    })) as { payload: Record<string, unknown> };

    expect(payload.count).toBe(3);
    expect(payload.currentBalance).toBe(24000);
    expect(payload.openingBalance).toBe(19400);

    const txns = payload.transactions as Record<string, unknown>[];
    expect(Number(txns[0].RunningBalance)).toBe(21400);
    expect(Number(txns[1].RunningBalance)).toBe(23500);
    expect(Number(txns[2].RunningBalance)).toBe(24000);
  });

  it("includeRunningBalance:false skips the AccountQueryRq round trip", async () => {
    // queryEntity gets called with "Transaction" by session.queryTransactions
    // internally — that's expected. The opt-out we're verifying is the SECOND
    // queryEntity call with entityType "Account" (used to fetch currentBalance).
    const accountSpy = vi.spyOn(session, "queryEntity");
    accountSpy.mockClear();

    const { payload } = (await callTool("qb_transaction_list_by_account", {
      accountName: "Rent Expense",
      includeRunningBalance: false,
    })) as { payload: Record<string, unknown> };

    expect(payload.count).toBe(3);
    expect(payload).not.toHaveProperty("openingBalance");
    expect(payload).not.toHaveProperty("currentBalance");
    const accountCalls = accountSpy.mock.calls.filter(
      (c) => c[0] === "Account"
    );
    expect(accountCalls.length).toBe(0);

    const txns = payload.transactions as Record<string, unknown>[];
    for (const t of txns) {
      expect(t).not.toHaveProperty("RunningBalance");
    }
    accountSpy.mockRestore();
  });

  it("emits filters in TransactionQueryRq schema order via session.queryTransactions", async () => {
    // Spy on session.queryTransactions to inspect the filter object the tool
    // built. Schema-required order: MaxReturned → TxnDateRangeFilter →
    // AccountFilter (the subset this tool exposes). Pinned at the wire level
    // by tests/builder-emit-order.test.ts; this asserts the tool layer
    // populates the dict in that exact order so the builder's insertion-order
    // emit produces compliant XML.
    const spy = vi.spyOn(session, "queryTransactions");
    spy.mockClear();

    await callTool("qb_transaction_list_by_account", {
      accountName: "Rent Expense",
      fromDate: "2026-01-01",
      toDate: "2026-12-31",
      maxReturned: 250,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const filters = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(filters)).toEqual([
      "MaxReturned",
      "TxnDateRangeFilter",
      "AccountFilter",
    ]);
    expect(filters.AccountFilter).toEqual({ FullName: "Rent Expense" });
    expect(filters.TxnDateRangeFilter).toEqual({
      FromTxnDate: "2026-01-01",
      ToTxnDate: "2026-12-31",
    });
    expect(filters.MaxReturned).toBe(250);
    spy.mockRestore();
  });

  it("date range narrows the row set — opening balance reflects only included rows", async () => {
    // Same Rent Expense account but limit to Mar–Apr: 2 rows totaling 2600.
    // openingBalance = 24000 − 2600 = 21400.
    const { payload } = (await callTool("qb_transaction_list_by_account", {
      accountName: "Rent Expense",
      fromDate: "2026-03-01",
      toDate: "2026-04-30",
    })) as { payload: Record<string, unknown> };

    expect(payload.count).toBe(2);
    expect(payload.openingBalance).toBe(21400);

    const txns = payload.transactions as Record<string, unknown>[];
    // After B-2 (2100): 23500. After JE-100 (500): 24000.
    expect(Number(txns[0].RunningBalance)).toBe(23500);
    expect(Number(txns[1].RunningBalance)).toBe(24000);
  });

  it("unknown account returns count:0 with empty transactions array", async () => {
    const { payload } = (await callTool("qb_transaction_list_by_account", {
      accountName: "Definitely Not An Account",
    })) as { payload: Record<string, unknown> };
    expect(payload.count).toBe(0);
    expect(payload.transactions).toEqual([]);
  });

  it("Sales Revenue (natural-credit) preserves sign — credit JE positive, debit JE negative", async () => {
    const { payload } = (await callTool("qb_transaction_list_by_account", {
      accountName: "Sales Revenue",
    })) as { payload: Record<string, unknown> };

    expect(payload.count).toBe(2);
    const txns = payload.transactions as Record<string, unknown>[];
    // Sorted by date: JE-200 (May 1, +700) then JE-201 (May 15, -150).
    expect(txns[0].RefNumber).toBe("JE-200");
    expect(Number(txns[0].Amount)).toBe(700);
    expect(txns[1].RefNumber).toBe("JE-201");
    expect(Number(txns[1].Amount)).toBe(-150);

    // currentBalance = 185000 (seed). periodSum = 700 - 150 = 550.
    // opening = 185000 - 550 = 184450.
    expect(payload.openingBalance).toBe(184450);
    expect(Number(txns[0].RunningBalance)).toBe(185150); // 184450 + 700
    expect(Number(txns[1].RunningBalance)).toBe(185000); // 185150 − 150 → seed
  });
});
